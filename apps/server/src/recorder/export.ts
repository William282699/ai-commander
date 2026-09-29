// ============================================================
// 试玩记录仪 · 单局导出包（ZIP）与离线报告
//
// 包里的每个文件都是**同一份原始事件**的分类导出（固定截止水位），不另算一套回执：
//   manifest.json   身份/局号/场景/模型白名单/起止/计数/完整性/截止/各文件校验和
//   report.html     离线中文时间线（全部转义、无脚本、无外链）
//   events.jsonl    生命周期、操作、屏幕消息、交给 TTS 的文字、问题标记、标记行
//   traces.jsonl    请求/模型/解析/执行的对账证据（客户端 trace ＋ 服务端事实）
//   snapshots.jsonl 战场轻量快照
//   feedback.json   问题标记与结束反馈（没有就是空数组）
//   README.txt      这包能证明什么、不能证明什么
// 行序＝服务端接收顺序（不是网络真实发生顺序）；报告按回合与序号整理，并写明这一点。
// ============================================================

import crypto from "crypto";
import type { RecStoredLine } from "@ai-commander/shared/src/recorderProtocol";
import { REC_PROTOCOL_VERSION } from "@ai-commander/shared/src/recorderProtocol";
import type { RecorderStore } from "./store.js";
import { RunSummary, COMPLETENESS_LABEL, type Completeness } from "./summary.js";
import { buildZip } from "./zip.js";

const TRACE_TYPES = new Set(["trace", "srv_request", "srv_model_raw", "srv_result", "srv_parse_failed", "srv_model_error", "srv_attempt_end"]);
export const EXPORT_FORMAT = 1;

const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const jsonl = (xs: unknown[]) => Buffer.from(xs.map((x) => JSON.stringify(x)).join("\n") + (xs.length ? "\n" : ""), "utf8");

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fmtGame(sec: number | undefined): string {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtWall(ms: number | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

export const SCENARIO_LABEL: Record<string, string> = { el_alamein: "阿拉曼", tutorial: "教学关", dual_island: "双岛" };

export function endLabel(s: RunSummary, now: number, activeMs: number): string {
  if (s.end?.kind === "game_end") {
    const win = s.end.winner === "player";
    return `游戏结束：${win ? "胜利" : "败北"}${s.end.reason ? `（${String(s.end.reason)}）` : ""}`;
  }
  if (s.end?.kind === "run_end") return s.end.reason === "replaced" ? "重开了一局（这一局未分胜负）" : `结束：${String(s.end.reason ?? "")}`;
  if (now - s.lastRt > activeMs) return "没有结束信号（多为直接关页/刷新；不能断言玩家主动退出）";
  return `没有结束信号（最后活动 ${Math.max(0, Math.round((now - s.lastRt) / 60000))} 分钟前，可能仍在进行）`;
}

export interface RunListing {
  runId: string; tid: string; index: number; scenario: string; firstAt: number; lastAt: number;
  gameSec: number; wallSec: number; end: string; flags: number; feedback: number; events: number; bytes: number;
  completeness: { status: string; label: string; reasons: string[] };
}

/** 管理员列表：按测试者、按开局时间排“第几局”。 */
export function listRuns(store: RecorderStore): RunListing[] {
  const now = Date.now();
  const all = store.runSummaries().filter((s) => s.count > 0);
  const byTester = new Map<string, RunSummary[]>();
  for (const s of all) { const a = byTester.get(s.tid) ?? []; a.push(s); byTester.set(s.tid, a); }
  const out: RunListing[] = [];
  for (const [tid, runs] of byTester) {
    runs.sort((a, b) => (a.firstCt || a.firstRt) - (b.firstCt || b.firstRt));
    runs.forEach((s, i) => {
      const c = s.completeness(store.serverSeqOf(s.runId));
      out.push({
        runId: s.runId, tid, index: i + 1, scenario: s.scenario ?? "unknown",
        firstAt: s.firstCt || s.firstRt, lastAt: s.lastRt, gameSec: s.lastGt,
        wallSec: s.firstCt && s.lastCt ? (s.lastCt - s.firstCt) / 1000 : 0,
        end: endLabel(s, now, store.limits.activeMs), flags: s.flags, feedback: s.feedback, events: s.count, bytes: s.bytes,
        completeness: { status: c.status, label: COMPLETENESS_LABEL[c.status], reasons: c.reasons },
      });
    });
  }
  out.sort((a, b) => (a.tid === b.tid ? a.index - b.index : a.tid.localeCompare(b.tid)));
  return out;
}

export interface ExportResult {
  zip: Buffer;
  filename: string;
  manifest: Record<string, unknown>;
  reportHtml: string;
}

export async function exportRun(store: RecorderStore, runId: string): Promise<ExportResult | null> {
  const read = await store.readRun(runId);
  if (!read) return null;
  // 截止水位内重新累加一遍摘要（不借活摘要：它可能已包含截止之后才到的行）。
  const s = new RunSummary(runId);
  for (const l of read.lines) s.absorb(l, Buffer.byteLength(JSON.stringify(l)) + 1);
  // 本次启动的服务端生产者：截止时它发出的最后序号（readRun 前已 flush，按落盘内容核）。
  const live = new Map<string, number>();
  for (const l of read.lines) if (l.pid === store.serverPid && l.seq > (live.get(l.pid) ?? 0)) live.set(l.pid, l.seq);
  const completeness = s.completeness(live);
  const traces = read.lines.filter((l) => TRACE_TYPES.has(l.type));
  const snapshots = read.lines.filter((l) => l.type === "snapshot");
  const events = read.lines.filter((l) => !TRACE_TYPES.has(l.type) && l.type !== "snapshot");
  const flags = read.lines.filter((l) => l.type === "flag").map((l) => ({
    eid: l.eid, at: l.ct, gameTime: l.gt ?? null, turn: l.turn ?? null, turnFrom: l.turnFrom ?? null,
    text: (l.d as Record<string, unknown>).text ?? "",
  }));
  const endFeedback = read.lines.filter((l) => l.type === "feedback").map((l) => ({
    eid: l.eid, at: l.ct, gameTime: l.gt ?? null, text: (l.d as Record<string, unknown>).text ?? "",
  }));
  const meta = read.lines.find((l) => l.type === "srv_run_meta")?.d as Record<string, unknown> | undefined;
  const start = read.lines.find((l) => l.type === "run_start")?.d as Record<string, unknown> | undefined;
  const generatedAt = Date.now();
  const files: { name: string; data: Buffer }[] = [
    { name: "events.jsonl", data: jsonl(events) },
    { name: "traces.jsonl", data: jsonl(traces) },
    { name: "snapshots.jsonl", data: jsonl(snapshots) },
    { name: "feedback.json", data: Buffer.from(JSON.stringify({ flags, endFeedback, note: flags.length + endFeedback.length === 0 ? "本局没有问题标记与结束反馈" : undefined }, null, 2) + "\n", "utf8") },
  ];
  const counts: Record<string, number> = {};
  for (const l of read.lines) counts[l.type] = (counts[l.type] ?? 0) + 1;
  const status = completeness.status;
  const manifestBase = {
    schemaVersion: REC_PROTOCOL_VERSION,
    exportFormat: EXPORT_FORMAT,
    build: meta?.build ?? "unknown",
    tester: s.tid,
    runId,
    scenario: s.scenario ?? "unknown",
    mode: start ? { scenario: start.scenario ?? "unknown", params: start.params ?? {} } : "unknown",
    models: meta?.models ?? "unknown",
    firstClientAt: s.firstCt || null,
    lastClientAt: s.lastCt || null,
    firstServerAt: s.firstRt || null,
    lastServerAt: s.lastRt || null,
    lastGameTimeSec: s.lastGt,
    counts,
    completeness: { ...completeness, label: COMPLETENESS_LABEL[status] },
    cutoff: {
      note: "导出截止水位：只含这一刻之前已落盘的记录。之后到达的记录不在本包里；本包不冒充最终完整包，除非 completeness.status 为 complete。",
      at: read.cutoffAt, bytes: read.cutoffBytes, lines: read.lines.length, rawSha256: read.rawSha256,
    },
    orderNote: "各 jsonl 的行序＝服务端接收顺序，不是事情发生的真实顺序；各设备时钟不严格一致，请按 pid+seq 与 turn 关联整理。",
    generatedAt,
  };
  const reportHtml = renderReport(read.lines, s, completeness, manifestBase);
  files.unshift({ name: "report.html", data: Buffer.from(reportHtml, "utf8") });
  files.push({ name: "README.txt", data: Buffer.from(renderReadme(s, completeness, manifestBase), "utf8") });
  const manifest = { ...manifestBase, files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })) };
  files.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") });
  const filename = `playtest-${s.tid}-${runId.slice(0, 12)}-${new Date(generatedAt).toISOString().replace(/[:.]/g, "-")}.zip`;
  return { zip: buildZip(files, new Date(generatedAt)), filename, manifest, reportHtml };
}

function renderReadme(s: RunSummary, c: Completeness, m: Record<string, unknown>): string {
  return [
    "AI Commander 试玩记录包（一局）",
    "================================",
    "",
    `测试者：${s.tid}    局号：${s.runId}    场景：${SCENARIO_LABEL[s.scenario ?? ""] ?? s.scenario ?? "unknown"}`,
    `记录状态：${COMPLETENESS_LABEL[c.status]}`,
    ...c.reasons.map((r) => `  - ${r}`),
    "",
    "这包能证明什么",
    "  - 玩家在游戏里发出的文字、语音被系统听成的文字（不是原始录音）。",
    "  - 参谋模型的原文、解析后的单子、客户端的判断（批准/选人/拒绝）与实际下令结果（哪些单位、去哪）。",
    "  - 屏幕上出现过的消息、交给语音合成的文字（不代表玩家确实听见）、少量操作、问题标记。",
    "  - 每 10 秒一份我方单位的轻量快照，外加下令/问题标记/结束时的关键快照。",
    "",
    "不能证明什么",
    "  - 这不是录像：没有鼠标轨迹、没有画面、不能还原每一帧；沉默不代表无聊。",
    "  - 快照是引擎数据，不等于玩家当时在屏幕上看到了；敌军不在快照里。",
    "  - 各设备时钟不严格一致；行序是服务端收到的顺序。",
    "  - 没有结束信号不代表玩家主动退出；缺序号只说明“这些没到”，不说明内容。",
    "",
    "怎么读",
    "  - 双击 report.html（离线可开，无脚本、不联网）。",
    "  - 机器分析请用 events.jsonl / traces.jsonl / snapshots.jsonl；每行一条事件，",
    "    turn＝回合编号；turnFrom=\"current\" 表示回合取自当时的当前轮；runFrom=\"current\" 表示局取自当时的主窗当前局。",
    "  - 批准/选择链：trace 的 pending / selection / quantity_chosen 事件带着答复的 turn、pendingId/selectionId 与 planTraceId（原方案的回合）；",
    "    exec 事件带 turn（执行发生的那一轮）与 planTraceId（执行的是哪一轮的方案）。",
    "  - manifest.json 里有截止水位与各文件 sha256。",
    "",
    `导出时间：${fmtWall(m.generatedAt as number)}`,
    "",
  ].join("\n");
}

// ── 报告 ───────────────────────────────────────────────────

type L = RecStoredLine;
const dOf = (l: L) => (l.d ?? {}) as Record<string, unknown>;
const stageOf = (l: L) => (l.type === "trace" ? String(dOf(l).stage ?? "") : l.type);
const dataOf = (l: L) => (l.type === "trace" ? (dOf(l).data ?? {}) as Record<string, unknown> : dOf(l));

function short(v: unknown, n = 400): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function describeTrace(l: L): string {
  const st = stageOf(l);
  const d = dataOf(l);
  const idsOf = (x: unknown) => (Array.isArray(x) ? x.join(",") : "");
  switch (st) {
    case "turn": return `玩家发出（${esc(d.channel)}${d.voice ? "，语音" : "，打字"}${d.group ? "，群聊" : ""}）：${d.voice ? "（语音，文字见服务端 heard／消息更新）" : `「${esc(d.text)}」`}`;
    case "srv_request": return `服务端收到请求 [${esc(d.route)}] 尝试 ${esc(d.attempt)}：「${esc(short(d.message, 300))}」${d.voice ? "（语音）" : ""}`;
    case "srv_model_raw": return `模型原文（${esc(d.mode)}，${String(d.text ?? "").length} 字）：<pre>${esc(short(d.text, 1200))}</pre>`;
    case "srv_result": return `服务端解析结果：类型 ${esc(d.responseType)}${d.warning ? `，警告「${esc(d.warning)}」` : ""}${d.heard ? `，听成「${esc(d.heard)}」` : ""}${d.pendingDecision ? `，判词 ${esc(d.pendingDecision)}` : ""}；单子 ${esc(short(d.options, 500))}`;
    case "srv_parse_failed": return `服务端解析失败（${esc(d.mode)}），已用兜底（不执行）`;
    case "srv_model_error": return `模型调用失败（${esc(d.mode)}）：${esc(short(d.message, 200))}`;
    case "srv_attempt_end": return `请求收尾：HTTP ${esc(d.status)}${d.aborted ? "（连接中断）" : ""}，${esc(d.ms)} ms`;
    case "route": return `客户端路由：类型 ${esc(d.responseType)}，${esc(d.options)} 个方案，自动=${esc(d.gateAuto)}${d.gateReason ? `（${esc(d.gateReason)}）` : ""}${d.bucket ? `，桶 ${esc(d.bucket)}` : ""}，会执行=${esc(d.willExecute)}`;
    case "pending": return `批准合同判定：${esc(d.verdict)}（模型判 ${esc(d.judged)}）pendingId=${esc(d.pendingId)} 原方案回合=${d.planTraceId ? `<a href="#turn-${esc(d.planTraceId)}">${esc(d.planTraceId)}</a>` : "—"}${d.conflict ? `，冲突 ${esc(short(d.conflict, 200))}` : ""}`;
    case "pending_shortcut": return `确认词捷径：${esc(d.reply)} pendingId=${esc(d.pendingId)} 原方案回合=${d.planTraceId ? `<a href="#turn-${esc(d.planTraceId)}">${esc(d.planTraceId)}</a>` : "—"}`;
    case "plan_registered": return `登记待批方案 pendingId=${esc(d.pendingId)}（${esc(d.phase)}）：${esc(d.plan)}；方案回合=${esc(d.planTraceId)}`;
    case "confirm_captured": return `参谋请长官点头：${d.captured ? "登记了完整方案" : "开放问题（不登记）"} ${esc(short(d.intents, 300))}`;
    case "selection": return `选择合同判定：${esc(d.verdict)} → ${esc(d.plan)} selectionId=${esc(d.selectionId)} 原方案回合=${d.planTraceId ? `<a href="#turn-${esc(d.planTraceId)}">${esc(d.planTraceId)}</a>` : "—"}`;
    case "ask_selection": return `问是哪一批：「${esc(d.question)}」selectionId=${esc(d.selectionId)} 候选 ${esc(idsOf(d.keys))}`;
    case "ask_quantity": return `问数量读法：「${esc(d.question)}」selectionId=${esc(d.selectionId)}`;
    case "quantity_split": return `数量读法有歧义（先问，零执行）`;
    case "quantity_chosen": return `数量读法已选：${esc(d.key)} selectionId=${esc(d.selectionId)} 原方案回合=${d.planTraceId ? `<a href="#turn-${esc(d.planTraceId)}">${esc(d.planTraceId)}</a>` : "—"}`;
    case "same_task_in_progress": return `同一件事还在办：${esc(idsOf(d.dispatchIds))}（问要不要再派）`;
    case "destination_quote": return `去处原话核对：${esc(short(d.verdicts, 300))}`;
    case "refuse": return `引擎拒绝/追问：「${esc(d.line)}」`;
    case "model_failure": return `这一轮模型失败（${esc(short(d.failure, 120))}），零执行`;
    case "exec": {
      const orders = Array.isArray(d.intents) ? (d.intents as Record<string, unknown>[]).flatMap((i) => (Array.isArray(i.orders) ? i.orders as Record<string, unknown>[] : []))
        .map((o) => `${esc(o.action)} [${esc(idsOf(o.units))}] → ${o.target ? `(${esc((o.target as Record<string, unknown>).x)},${esc((o.target as Record<string, unknown>).y)})` : "—"}`).join("；") : "";
      return `<b>执行</b>：实际接令 [${esc(idsOf(d.applied))}]${Array.isArray(d.already) && d.already.length ? `，已在办 [${esc(idsOf(d.already))}]` : ""}${Array.isArray(d.rejected) && d.rejected.length ? `，被拒 [${esc(idsOf(d.rejected))}]` : ""}；执行的是回合 ${d.planTraceId ? `<a href="#turn-${esc(d.planTraceId)}">${esc(d.planTraceId)}</a>` : "—"} 的方案；下令：${orders || "（无）"}；回执：${esc(short(d.receipt, 400))}`;
    }
    default: return `${esc(st)}：${esc(short(d, 300))}`;
  }
}

function renderReport(lines: L[], s: RunSummary, c: Completeness, m: Record<string, unknown>): string {
  const now = Date.now();
  const turns = new Map<string, L[]>();
  const turnOrder: string[] = [];
  for (const l of lines) {
    if (!TRACE_TYPES.has(l.type) || !l.turn) continue;
    if (!turns.has(l.turn)) { turns.set(l.turn, []); turnOrder.push(l.turn); }
    turns.get(l.turn)!.push(l);
  }
  // 回合内：客户端按序号、服务端按序号，各自保持生产者顺序；两边按墙上时间合并（标明是整理后的顺序）。
  for (const arr of turns.values()) arr.sort((a, b) => a.ct - b.ct || (a.pid === b.pid ? a.seq - b.seq : 0));
  const flags = lines.filter((l) => l.type === "flag");
  const messages = lines.filter((l) => l.type === "message");
  const ops = lines.filter((l) => ["op", "manual_order", "tts", "consent", "run_start", "run_end", "game_end", "drop_report", "srv_marker", "producer_close", "srv_producer_close"].includes(l.type));
  const snaps = lines.filter((l) => l.type === "snapshot").sort((a, b) => (a.gt ?? 0) - (b.gt ?? 0));
  // 下过令的单位（对话执行＋手动）
  const ordered = new Set<number>();
  for (const l of lines) {
    const d = dataOf(l);
    if (stageOf(l) === "exec" && Array.isArray(d.applied)) for (const id of d.applied) if (typeof id === "number") ordered.add(id);
    if (l.type === "manual_order" && Array.isArray(d.unitIds)) for (const id of d.unitIds) if (typeof id === "number") ordered.add(id);
  }
  const unitRows = [...ordered].slice(0, 40).map((id) => {
    const cells = snaps.slice(0, 200).flatMap((sn) => {
      const units = (dOf(sn).units ?? []) as unknown[][];
      const u = units.find((x) => Array.isArray(x) && x[0] === id);
      if (!u) return [];
      return [`<tr><td>${esc(id)}</td><td>${fmtGame(sn.gt)}</td><td>${esc(dOf(sn).reason)}</td><td>${esc(u[2])},${esc(u[3])}</td><td>${esc(u[5])}</td><td>${esc(u[6] ?? "")}${u[7] !== undefined && u[7] !== null ? ` → ${esc(u[7])},${esc(u[8])}` : ""}</td></tr>`];
    });
    return cells.join("");
  }).join("");
  const scen = SCENARIO_LABEL[s.scenario ?? ""] ?? s.scenario ?? "unknown";
  const statusClass = c.status === "complete" ? "ok" : c.status === "known_gaps" ? "gap" : "unk";
  const flagItems = flags.map((f, i) => {
    const d = dOf(f);
    return `<li id="flag-${i + 1}"><b>问题标记 ${i + 1}</b>（游戏 ${fmtGame(f.gt)}，${esc(fmtWall(f.ct))}）：${esc(d.text || "（没写描述）")}${f.turn ? ` — 最近的回合 <a href="#turn-${esc(f.turn)}">${esc(f.turn)}</a>${f.turnFrom ? "（取自当时的当前轮）" : ""}` : ""}</li>`;
  }).join("");
  const turnBlocks = turnOrder.map((t) => {
    const items = turns.get(t)!.map((l) => `<li class="${l.src}"><span class="src">${l.src === "server" ? "服务端" : "浏览器"}</span> <span class="t">${fmtGame(l.gt)}</span> ${describeTrace(l)}${l.turnFrom ? ` <span class="note">[回合取自当前轮]</span>` : ""}${l.trunc ? ` <span class="note">[截断：${esc(l.trunc.join(","))}]</span>` : ""}</li>`).join("");
    return `<section class="turn" id="turn-${esc(t)}"><h3>回合 ${esc(t)}</h3><ol>${items}</ol></section>`;
  }).join("");
  const msgRows = messages.map((l) => {
    const d = dOf(l);
    const kind = d.op === "clear" ? "清空" : d.op === "update" ? "改写" : "新增";
    return `<tr><td>${fmtGame(l.gt ?? (d.time as number))}</td><td>${kind}</td><td>${esc(d.id ?? "")}</td><td>${esc(d.channel ?? "")}</td><td>${esc(d.from ?? "")}</td><td>${esc(d.source ?? "")}${d.groupChat ? "·群聊" : ""}</td><td>${esc(d.text ?? "")}</td></tr>`;
  }).join("");
  const opRows = ops.map((l) => `<tr><td>${fmtGame(l.gt)}</td><td>${esc(l.type)}</td><td>${esc(short(l.d, 500))}</td></tr>`).join("");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>试玩记录 ${esc(s.tid)} · ${esc(scen)}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#f7f7f5;color:#1d1d1f;line-height:1.5}
h1{font-size:20px;margin:0 0 8px}h2{font-size:17px;margin:24px 0 8px;border-bottom:1px solid #ccc}h3{font-size:14px;margin:12px 0 4px;font-family:monospace}
.box{background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px 14px}
.ok{color:#1a7f37}.gap{color:#b35900}.unk{color:#6e6e73}
table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}td,th{border:1px solid #ddd;padding:3px 6px;vertical-align:top;text-align:left}
ol{margin:4px 0 8px 18px;padding:0}li{margin:2px 0;font-size:13px}li.server{color:#333}
.src{display:inline-block;min-width:3em;font-size:11px;color:#555;border:1px solid #bbb;border-radius:3px;padding:0 3px}
.t{font-family:monospace;color:#555}.note{color:#8a6d00;font-size:11px}
pre{white-space:pre-wrap;word-break:break-all;background:#f0f0f0;padding:6px;margin:4px 0;max-height:320px;overflow:auto}
section.turn{background:#fff;border:1px solid #e3e3e3;border-radius:6px;padding:6px 10px;margin:8px 0}
</style></head><body>
<h1>试玩记录 · 测试者 ${esc(s.tid)} · ${esc(scen)}</h1>
<div class="box">
<div>局号 <code>${esc(s.runId)}</code>　开局 ${esc(fmtWall(s.firstCt || s.firstRt))}　游戏时长 ${fmtGame(s.lastGt)}（${fmtDur(s.lastGt)}）</div>
<div>结束：${esc(endLabel(s, now, 24 * 3600 * 1000))}</div>
<div>记录状态：<b class="${statusClass}">${esc(COMPLETENESS_LABEL[c.status])}</b>　导出截止 ${esc(fmtWall((m.cutoff as Record<string, unknown>)?.at as number))}（截至此刻；之后到达的记录不在本包）</div>
<ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
<div class="note">本报告按回合与序号整理；各设备时钟不严格一致，“时间”只作参考。这不是录像。</div>
</div>
<h2>问题标记（${flags.length}）</h2>
${flags.length ? `<ol>${flagItems}</ol>` : "<p>本局没有问题标记。</p>"}
<h2>回合时间线（${turnOrder.length} 个回合）</h2>
${turnBlocks || "<p>没有回合记录。</p>"}
<h2>下令单位的后续位置（${ordered.size} 个单位${ordered.size > 40 ? "，只列前 40 个" : ""}）</h2>
<table><tr><th>单位</th><th>游戏时间</th><th>快照</th><th>位置</th><th>状态</th><th>当前命令 → 目标</th></tr>${unitRows}</table>
<h2>屏幕消息（${messages.length}）</h2>
<table><tr><th>游戏时间</th><th>变更</th><th>消息号</th><th>频道</th><th>谁</th><th>来源</th><th>文字</th></tr>${msgRows}</table>
<h2>生命周期、操作、语音合成与标记（${ops.length}）</h2>
<table><tr><th>游戏时间</th><th>类型</th><th>内容</th></tr>${opRows}</table>
<h2>快照（${snaps.length}）</h2>
<p>每份快照含我方全部单位的编号、类型、位置、血量百分比、状态、当前命令与目标；资源与据点状态。详见 snapshots.jsonl。</p>
</body></html>
`;
}
