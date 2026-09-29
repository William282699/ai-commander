// ============================================================
// AI Commander — 一条命令从头到尾的本地对账日志（advisor trace）
//
// 起因：玩家说「派其中两个去北线前哨」，兵最后去了「1. 北部战线」。事后能看到的
// 只有屏上的回执，分不清是模型写错了、服务端换了、还是引擎自己补的——而服务端
// 的控制台输出在一根谁也读不到的管道里。要长官自己开开发者工具找回包，本身就是
// 设计缺陷（语音刀那一笔账的同一形状）。
//
// 这里只做一件事：同一条命令的每一层都用**同一个请求编号**记一行到本地文件——
//   request（玩家原话 + 与指代/目的地有关的那几节信封）
//   → model_raw（模型原文）→ result（schema/归一化之后的单子）
//   → client:*（浏览器那边：走了哪条路、改写后的意图、引擎解析出的落点、真下令结果、回执）
//
// 纪律：
//   · 纯观测：写失败就算了，绝不影响请求；
//   · 有界：单文件超过 4MB 滚动一次，只留一份旧的；单个字段截断；
//   · 不记密钥、不记请求头、不记音频、不记整份 digest（只抽几节）；
//   · 生产环境默认关（ADVISOR_TRACE=on 才开），本地开发默认开。
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { recordServerTrace } from "./recorder/context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 本地文件位置（`*.log` 已在 .gitignore 里）。 */
export const TRACE_PATH = process.env.ADVISOR_TRACE_PATH
  || path.resolve(__dirname, "..", "logs", "advisor-trace.log");
const ROTATED_PATH = TRACE_PATH.replace(/\.log$/, "") + ".1.log";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_STR = 6000;
const MAX_ARR = 80;
const MAX_DEPTH = 6;

const ENABLED = process.env.ADVISOR_TRACE
  ? process.env.ADVISOR_TRACE !== "off"
  : process.env.NODE_ENV !== "production";

/** 请求编号只收短的字母数字串——日志里不许混进别的东西。 */
export function traceIdOf(raw: unknown): string {
  return typeof raw === "string" && /^[A-Za-z0-9-]{4,64}$/.test(raw) ? raw : "-";
}

function clip(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…(+${v.length - MAX_STR})` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth >= MAX_DEPTH) return "(…)";
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARR).map((x) => clip(x, depth + 1));
    if (v.length > MAX_ARR) out.push(`(+${v.length - MAX_ARR} more)`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clip(x, depth + 1);
  return out;
}

let dirReady = false;

export function traceWrite(traceId: unknown, stage: string, data: Record<string, unknown>): void {
  // 试玩记录仪：同一个取数点顺手交给逐局记录（只有带着有效记录头的命令请求才有上下文；否则当场返回）。
  recordServerTrace(traceId, stage, data);
  // 没有请求编号就串不起来——台架/脚本直接调模型函数时不带编号，也就不往长官的日志里掺。
  if (!ENABLED || traceIdOf(traceId) === "-") return;
  try {
    if (!dirReady) { fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true }); dirReady = true; }
    const line = JSON.stringify({ t: new Date().toISOString(), traceId: traceIdOf(traceId), stage, ...(clip(data) as object) }) + "\n";
    try {
      if (fs.statSync(TRACE_PATH).size + line.length > MAX_BYTES) fs.renameSync(TRACE_PATH, ROTATED_PATH);
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(TRACE_PATH, line);
  } catch { /* 纯观测：写不进去就算了 */ }
}

/**
 * 从信封里只抽与「指代谁 / 去哪 / 在等什么答复」有关的那几节，外加带临时编队号的行。
 * 整份 digest 太大，也没必要——对账要的是模型当时看见了哪些把手。
 */
export function envelopeOf(digest: unknown): Record<string, unknown> {
  if (typeof digest !== "string") return {};
  const section = (marker: string, max = 1500): string | undefined => {
    const i = digest.indexOf(marker);
    if (i < 0) return undefined;
    const rest = digest.slice(i + marker.length);
    const next = rest.search(/\n---[A-Z_]+---/);
    return (next >= 0 ? rest.slice(0, next) : rest).slice(0, max).trim();
  };
  const contextTail = (() => {
    const s = section("---CONTEXT---", 100000);
    return s ? s.slice(-2000) : undefined;
  })();
  const handles = digest.split("\n").filter((l) => /临时编队G\d+|handle=G\d+|\bG\d+=/.test(l)).slice(0, 24);
  return {
    digestChars: digest.length,
    dispatches: section("---DISPATCHES---"),
    selection: section("---DISPATCH_SELECTION---"),
    quantitySelection: section("---QUANTITY_SELECTION---"),
    pending: section("---PENDING_CONTRACT---"),
    escalation: section("---ACTIVE_ESCALATION---"),
    context: contextTail,
    handles,
  };
}

/** 单子里与「谁、做什么、去哪」有关的字段（其余省略）。 */
export function intentsOf(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const options = (data as Record<string, unknown>).options;
  if (!Array.isArray(options)) return [];
  return options.map((o) => {
    const intents = o && typeof o === "object" && Array.isArray((o as Record<string, unknown>).intents)
      ? (o as Record<string, unknown>).intents as Record<string, unknown>[] : [];
    return intents.map((i) => {
      const out: Record<string, unknown> = {};
      for (const k of ["type", "fromFront", "fromSquad", "fromDispatch", "toFront", "targetFacility",
        "targetRegion", "returnTo", "destinationQuote", "quantityQuote", "quantity", "unitType"]) {
        if (i[k] !== undefined) out[k] = i[k];
      }
      return out;
    });
  });
}
