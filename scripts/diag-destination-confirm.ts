/**
 * 诊断：「派其中两个去北线前哨」→ 陈反问 →「是的」→ 兵去了「1. 北部战线」。
 * 运行：npx tsx scripts/diag-destination-confirm.ts [--runs=6] [--label=x] [--out=dir]
 *
 * ★ 真模型（读 apps/server/.env，走生产 callAdvisorStream），会花 API 调用。
 * ★ 局面：真实初始局（开局几秒，没有夹具派兵）。浏览器那一侧的路由用生产闸
 *   （canAutoExecute / decideBucket）判，会动兵的回合交给**从 ChatPanel 抽出的生产
 *   handleApprove**（经 schema＋JSON 往返），每一层都记：
 *   玩家原话 → 模型原文 → schema 之后的单子 → 路由 → 引擎解析出的落点 → 真下令（单位＋坐标）。
 */
import { config as dotenv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import * as core from "@ai-commander/core";
import type { GameState, AdvisorOption } from "@ai-commander/shared";
import { tick } from "../packages/core/src/sim";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { _ticketsForTest } from "../packages/core/src/escalationTicket";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { canAutoExecute, decideBucket } from "../apps/web/src/autoExecuteGate";
import { harness } from "./chainHarness";

dotenv({ path: "apps/server/.env" });
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const RUNS = Number(arg("runs", "6"));
/** 每句之间真跑几秒模拟（含敌方 AI 与 processAutoBehavior），让派出去的人真走起来。 */
const PUMP_BETWEEN = Number(arg("pump-between", "0"));
const LABEL = arg("label", "baseline");
/** 每次调模型前等多少毫秒（与正在玩的那一局共用同一把 key，别把每分钟配额吃光）。 */
const GAP_MS = Number(arg("gap-ms", "0"));
const OUT = arg("out", "");
const TURNS = (arg("turns", "中央前哨附近有没有能调的部队？|派其中两个去北线前哨|是的")).split("|");
/** 可选：把第 N 轮陈的答复钉成玩家那局里的原话（格式 "2=文本"），用来复现同一段对话。 */
const FORCE = new Map((process.argv.filter((a) => a.startsWith("--force=")).map((a) => a.slice(8))).map((x) => {
  const i = x.indexOf("="); return [Number(x.slice(0, i)), x.slice(i + 1)] as [number, string];
}));

function pump(s: GameState, sec: number) {
  for (let t = 0; t < sec; t += 0.5) { core.updateFog(s); tick(s, 0.5); processEnemyAI(s, 0.5); core.processAutoBehavior(s, 0.5); }
}
/** 真下令给了谁：出发时最近的设施、被派往的落点最近的设施（名字＋格数），不看回执字符串。 */
function movedFacts(st: GameState, ids: number[]) {
  const nearestName = (p: { x: number; y: number } | null | undefined) => {
    if (!p) return null;
    let best: { name: string; d: number } | null = null;
    for (const f of st.facilities.values()) {
      if (f.hp <= 0 || !f.name) continue;
      const d = Math.hypot(f.position.x - p.x, f.position.y - p.y);
      if (!best || d < best.d) best = { name: f.name, d: Math.round(d) };
    }
    return best;
  };
  return ids.map((id) => {
    const u = st.units.get(id);
    return { id, type: u?.type, from: nearestName(u?.position), to: nearestName(u?.orders.at(-1)?.target ?? null) };
  });
}
const REFS = [{ key: "chen", label: "陈军士" }, { key: "marcus", label: "马克斯上尉" }, { key: "emily", label: "艾米莉中尉" }];

async function main() {
  const realFetch = globalThis.fetch;
  const captured: string[] = [];
  // 对照实验用：--strip-new-persona 把本轮在陈人格里新加的三段（确认案 / 号+数量 / 撤退三种意思）从请求里拿掉
  const STRIP = process.argv.includes("--strip-new-persona");
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (STRIP && init?.body && typeof init.body === "string") {
      const b = JSON.parse(init.body);
      for (const m of b.messages ?? []) if (typeof m.content === "string") {
        const i = m.content.indexOf("要长官点头的，只能是");
        const j = m.content.indexOf("拿不准就按第一种。");
        if (i >= 0 && j > i) m.content = m.content.slice(0, i) + m.content.slice(j + "拿不准就按第一种。".length);
      }
      init = { ...init, body: JSON.stringify(b) };
    }
    const res = await realFetch(input, init);
    res.clone().text().then((t) => captured.push(t)).catch(() => {});
    return res;
  }) as typeof fetch;
  const ai = await import("../apps/server/src/ai");
  const runs: unknown[] = [];
  for (let k = 0; k < RUNS; k++) {
    core.resetEscalationTickets();
    const st = core.createInitialGameState("el_alamein");
    pump(st, 3);
    const mem = { playerIntent: "", openCommitments: [] };
    const h = harness(st);
    const ctx: string[] = [];
    const turns: unknown[] = [];
    console.log(`\n── run ${k + 1} ──`);
    for (let ti = 0; ti < TURNS.length; ti++) {
      const player = TURNS[ti];
      if (ti > 0 && PUMP_BETWEEN > 0) pump(st, PUMP_BETWEEN);
      if (FORCE.has(ti + 1)) {
        // 这一轮不问模型：陈的原话照玩家那局钉死（夹具），只推进上下文。
        ctx.push(`[指挥官] ${player}`, `[参谋] ${FORCE.get(ti + 1)}`);
        turns.push({ player, forcedReply: FORCE.get(ti + 1) });
        console.log(` 「${player}」 → (钉死) ${FORCE.get(ti + 1)}`);
        continue;
      }
      // 生产 send 开头的确认词捷径（不问模型）
      {
        const traceMark0 = h.traces.length; const appMark0 = h.applications.length;
        if (h.confirmShortcut(player)) {
          ctx.push(`[指挥官] ${player}`);
          const exec = h.traces.slice(traceMark0).filter((t) => ["exec", "refuse", "destination_quote"].includes(t.stage));
          const ids0 = exec.filter((e) => e.stage === "exec").flatMap((e) => (e.data.applied as number[] | undefined) ?? []);
          turns.push({ player, shortcut: true, executedNow: h.applications.length > appMark0, exec, intents: [],
            unitsMoved: movedFacts(st, ids0) });
          console.log(` 「${player}」 → (确认词捷径，执行存下的方案) ${JSON.stringify(exec.map((e) => e.data.intents ? (e.data.intents as Record<string, unknown>[]).map((i) => i.destination) : e.data.line))}`);
          continue;
        }
      }
      // 与生产 send 同一个判据：同频道、awaiting_reply、未过期 ⇒ 带合同标签，信封里加 PENDING_CONTRACT 一节
      //（这段字符串照抄 ChatPanel.sendCommand 的 pendingContext；send 那一段台架没抽出来）。
      const pendingTag = h.pendingTagNow();
      const pc = h.pendingContractRef.current;
      const pendingContext = pendingTag && pc
        ? `\n---PENDING_CONTRACT---\n待确认命令(id=${pc.id}): ${pc.summary}\n指挥官下面这句话可能是对这份待确认命令的答复。` : "";
      const digest = buildDigestForChannel(st, "combat", mem, [], undefined, undefined, true)
        + (ctx.length ? "\n---CONTEXT---\n" + ctx.join("\n") : "") + pendingContext;
      captured.length = 0;
      if (GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS));
      let delivered: Record<string, unknown> | null = null;
      for await (const ev of ai.callAdvisorStream(digest, player, "risk=0.50 focus=0.50 obj=0.50 cas=0.50", "combat")) {
        if (ev.type === "options") delivered = JSON.parse(JSON.stringify(ev.content));
      }
      await new Promise((r) => setTimeout(r, 50));
      const raw = captured.join("").split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
      // 通讯失败（配额/超时）⇒ 这一局作废，不当样本（也不去执行兜底里那张默认单子）
      if (typeof delivered?.warning === "string" && /通讯中断|格式异常/.test(delivered.warning)) {
        turns.push({ player, commsFailed: String(delivered.warning).slice(0, 120) });
        console.log(` 「${player}」 → 通讯失败，本局作废`);
        break;
      }
      const opts = (delivered?.options as AdvisorOption[] | undefined) ?? [];
      const rt = String(delivered?.responseType ?? "");
      const tickets = _ticketsForTest().map((t) => ({ g: t.gNumber, name: core.spokenNameOf(t), front: t.targetFrontId, origin: t.origin, burned: t.burned, n: t.unitCount }));
      ctx.push(`[指挥官] ${player}`);
      const ctxMark = h.context.length; const traceMark = h.traces.length; const appMark = h.applications.length;
      // 生产回复入口（批准合同判官 → 候选选择 → 确认案登记）。delivered 已是服务端交出的形状，
      // 只做 JSON 往返，不再过第二遍 schema（二次解析那笔账的教训）。
      const ingress = delivered ? h.deliverTurn(delivered as Record<string, unknown>, { pendingTag, userMsg: player }) : "passthrough";
      let gate: unknown = null; let bucket: unknown = null; let willExecute = false;
      if (ingress === "passthrough") {
        const actionable = rt.toUpperCase() !== "NOOP" && opts.length > 0;
        const g = actionable ? canAutoExecute(opts[0], player, st, [], false, REFS) : { auto: false };
        bucket = actionable ? decideBucket({ gate: g, hasOption: true, staleRefCount: 0, voiceTurn: false, heardPresent: false }) : "B";
        gate = g;
        willExecute = actionable && ((g as { auto: boolean }).auto || bucket === "A");
        if (willExecute) h.approve(opts[0], player);
        else if (delivered?.brief) ctx.push(`[参谋] ${String(delivered.brief)}`);
      }
      for (const m of h.context.slice(ctxMark)) ctx.push(`[参谋] ${m}`);
      const exec = h.traces.slice(traceMark).filter((t) => ["exec", "refuse", "confirm_captured", "destination_quote"].includes(t.stage));
      const executedNow = h.applications.length > appMark;
      const intents = opts[0]?.intents ?? [];
      // 真下令给了谁、他们从哪儿出发、被派往哪儿（按最近的设施名＋距离记，不看回执字符串）
      const appliedIds = exec.filter((e) => e.stage === "exec").flatMap((e) => (e.data.applied as number[] | undefined) ?? []);
      const unitsMoved = movedFacts(st, appliedIds);
      turns.push({ player, rawModelText: raw, responseType: rt, brief: delivered?.brief, intents, pendingDecision: delivered?.pendingDecision,
        ingress, gate, bucket, executedNow, exec, unitsMoved,
        ticketsAtTurn: tickets.filter((t) => /中央前哨|北线前哨/.test(t.name)) });
      const execSummary = JSON.stringify(exec.map((e) =>
        e.stage === "refuse" ? { refuse: e.data.line }
        : e.stage === "confirm_captured" ? { captured: e.data.captured, plan: e.data.intents }
        : { dest: (e.data.intents as Record<string, unknown>[])?.map((i) => i.destination), applied: e.data.applied, receipt: e.data.receipt }));
      console.log(` 「${player}」 → ${rt}${delivered?.pendingDecision !== undefined ? `/pd=${delivered?.pendingDecision}` : ""} ${JSON.stringify(intents)} ${executedNow ? "执行" : "不执行"} ${execSummary} | ${String(delivered?.brief ?? "").slice(0, 60)}`);
    }
    runs.push({ run: k + 1, turns });
  }
  globalThis.fetch = realFetch;
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/destination-confirm-${LABEL}.json`, JSON.stringify({ label: LABEL, when: new Date().toISOString(),
      fixture: "真实初始局＋3 秒真模拟；无夹具派兵；路由用生产闸；执行用从 ChatPanel 抽出的生产 handleApprove", runs }, null, 2));
    console.log(`\n证据已存：${OUT}/destination-confirm-${LABEL}.json`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
