/**
 * 真模型小批复验（第六轮）：同一组自然对话，走**整条生产回复链**。
 * 运行：node --import tsx scripts/diag-send-chain.ts [--runs=5] [--gap-ms=6000] [--only=a,b] [--out=dir]
 *
 * ★ 真模型（读 apps/server/.env；陈＝LLM_PROFILE），会花 API 调用；串行＋间隔，别与正在玩的那一局抢配额。
 * ★ 链路：真信封（buildDigestForChannel，会铸 G 号）＋ 真对话上下文（ChatPanel 的 pushContext/formatContext）
 *   → 生产 index.ts 路由 → 生产 callAdvisorStream（真模型）→ 生产 sendCommand/processAdvisorData
 *   → handleApprove → applyOrders。句与句之间真跑模拟（tick＋敌方 AI＋autoBehavior＋战争迷雾）。
 * ★ 判定只看**真接到命令的单位 ID、人数、落点**（applyOrders 的结果＋单位身上的命令），不看 brief。
 * 每一格都存：长官原话、模型原始回包（SSE 原文拼回的全文）、浏览器收到的单子、屏上的话、真下令。
 */
import { config as dotenv } from "dotenv";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as core from "@ai-commander/core";
import type { GameState } from "@ai-commander/shared";
import { tick } from "../packages/core/src/sim";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { _ticketsForTest } from "../packages/core/src/escalationTicket";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { harness, serverRoutes, source, oldFunctions, overTheWire } from "./chainHarness";

dotenv({ path: "apps/server/.env" });
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const RUNS = Number(arg("runs", "5"));
const GAP_MS = Number(arg("gap-ms", "6000"));
const ONLY = arg("only", "").split(",").filter(Boolean);
const OUT = arg("out", "");
/** 语音回合用的真录音目录（macOS say 合成的普通话，16k 单声道 WAV）。 */
const VOICE_DIR = arg("voice-dir", "");

/**
 * say：长官这一句（打字）；voice：这一句改用真录音（文件名，在 --voice-dir 里）；
 * inject："confirm-two" ＝ 陈上一句把「从那群派 2 个去北线前哨」当方案请长官点头
 *   （走生产的 CONFIRM 登记；不花模型调用，只为稳定造出「有待批准方案」这一局面）。
 */
type Turn = { say: string; pumpBefore?: number; voice?: string; inject?: "confirm-two" };
type Scenario = { name: string; turns: Turn[]; score: (r: RunRecord) => Score };
type Score = { premise: boolean; outcome: "first_right" | "right_after_clarify" | "still_asking" | "zero_exec" | "wrong_exec" | "premise_failed"; note: string };
type RunRecord = {
  state: GameState; group: number[]; homeOf: Map<number, { x: number; y: number }>;
  turnsOut: TurnOut[];
};
type TurnOut = {
  say: string; modelRaw: string[]; delivered: unknown[]; screen: string[];
  appliedNow: number[]; ordersNow: { id: number; action: string; target: { x: number; y: number } | null }[];
  traces: { stage: string; data: Record<string, unknown> }[];
  pendingQuestion: string | null;
  /** 这一句之后交给 TTS 的每一段（语音、打字都记）。 */
  ear: { text: string; persona: string }[];
};

function pump(s: GameState, sec: number) {
  for (let t = 0; t < sec; t += 0.5) { core.updateFog(s); tick(s, 0.5); processEnemyAI(s, 0.5); core.processAutoBehavior(s, 0.5); }
}
const near = (a: { x: number; y: number } | null | undefined, b: { x: number; y: number }, r: number) =>
  !!a && Math.hypot(a.x - b.x, a.y - b.y) <= r;
const ctxFns = oldFunctions(source, ["MAX_CONTEXT_ENTRIES", "MAX_CONTEXT_CHARS", "createEmptyChannelContext", "pushContext", "formatContext"],
  ["createEmptyChannelContext", "pushContext", "formatContext"]) as {
  createEmptyChannelContext: () => Record<string, unknown[]>;
  pushContext: (c: unknown, ch: string, e: unknown) => void;
  formatContext: (c: unknown, ch: string) => string;
};
/** SSE 原文 → 模型写出的全文（把 delta.content 拼回去）。非流回包原样返回 message.content。 */
function modelTextOf(raw: { stream: boolean; text: string }): string {
  if (!raw.stream) { try { return JSON.parse(raw.text).choices?.[0]?.message?.content ?? raw.text; } catch { return raw.text; } }
  let out = "";
  for (const line of raw.text.split("\n")) {
    const t = line.trim(); if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
    try { out += JSON.parse(t.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { /* skip */ }
  }
  return out;
}

const NP = "ea_player_coastal_post";
const ASK = "中央前哨附近有没有能调的部队？";
const SEND2 = "派其中两个去北线前哨";

/** 第二句之后是否恰好派出了 2 个、出自那一群、去北线前哨（后面几种场景的前提）。 */
function sentTwo(r: RunRecord, turnIdx = 1): number[] | null {
  const t = r.turnsOut[turnIdx]; if (!t) return null;
  const north = r.state.facilities.get(NP)!.position;
  const ok = t.appliedNow.length === 2 && t.appliedNow.every((id) => r.group.includes(id))
    && t.ordersNow.filter((o) => t.appliedNow.includes(o.id)).every((o) => near(o.target, north, 6));
  return ok ? t.appliedNow : null;
}
const allApplied = (r: RunRecord) => [...new Set(r.turnsOut.flatMap((t) => t.appliedNow))];
/** 存了「派 stored 个」、长官答了一句：期望派 want 个（改数量＝want≠stored）。
 *  零执行＋说明＝可接受（澄清），派了旧的 stored 个＝错执行。 */
function approvalScore(r: RunRecord, stored: number, want: number): Score {
  const t = r.turnsOut[2]; const north = r.state.facilities.get(NP)!.position;
  if (!r.turnsOut[1].pendingQuestion?.startsWith("contract")) return { premise: false, outcome: "premise_failed", note: "没存成待批准方案" };
  const n = t.appliedNow.length;
  const onTarget = t.ordersNow.every((o) => near(o.target, north, 6)) && t.appliedNow.every((id) => r.group.includes(id));
  if (n === want && onTarget) return { premise: true, outcome: "first_right", note: `派 ${n} 个` };
  if (n > 0) return { premise: true, outcome: "wrong_exec", note: `派了 ${n} 个${n === stored && want !== stored ? "（执行了旧方案）" : ""}${onTarget ? "" : "（去处或来源不对）"}` };
  return { premise: true, outcome: t.pendingQuestion ? "still_asking" : "zero_exec", note: t.screen.at(-1) ?? "" };
}

const SCENARIOS: Scenario[] = [
  {
    name: "repeat-yes",
    turns: [{ say: ASK }, { say: SEND2 }, { say: "是的", pumpBefore: 20 }],
    score: (r) => {
      const first = sentTwo(r);
      if (!first) return { premise: false, outcome: "premise_failed", note: `第二句派出 ${r.turnsOut[1]?.appliedNow.length ?? 0} 个` };
      const extra = r.turnsOut[2].appliedNow.filter((id) => !first.includes(id));
      return extra.length > 0
        ? { premise: true, outcome: "wrong_exec", note: `「是的」又派出 ${extra.length} 个` }
        : { premise: true, outcome: "first_right", note: (r.turnsOut[2].appliedNow.length ? "重新下令给同一批" : "没有另派")
            + (/要再派吗/.test(r.turnsOut[2].screen.join(" ")) ? "（问了要不要再派）" : "")
            + (/已经在前往.*没有重新下令/.test(r.turnsOut[2].screen.join(" ")) ? "（★说成已在办）" : "") };
    },
  },
  {
    name: "quantity-total",
    turns: [{ say: ASK }, { say: "派两个坦克和步兵去北线前哨" }, { say: "一共两个" }],
    score: (r) => {
      const north = r.state.facilities.get(NP)!.position;
      const ids = allApplied(r);
      const t1 = r.turnsOut[1].appliedNow.length;
      const onTarget = ids.every((id) => r.group.includes(id)) && r.turnsOut.every((t) => t.ordersNow.filter((o) => t.appliedNow.includes(o.id)).every((o) => near(o.target, north, 6)));
      if (ids.length > 2 || (ids.length > 0 && !onTarget)) return { premise: true, outcome: "wrong_exec", note: `共派 ${ids.length} 个${onTarget ? "" : "（有人不在那一群或不去北线前哨）"}` };
      if (ids.length === 2) return { premise: true, outcome: t1 === 2 ? "first_right" : "right_after_clarify", note: "" };
      if (r.turnsOut.at(-1)!.pendingQuestion) return { premise: true, outcome: "still_asking", note: r.turnsOut.at(-1)!.pendingQuestion! };
      return { premise: true, outcome: "zero_exec", note: `共派 ${ids.length} 个` };
    },
  },
  ...(["刚才那两个叫回来", "刚才派去北线前哨的那两个叫回来"].map((line, k) => ({
    name: k === 0 ? "recall" : "recall-named",
    turns: [{ say: ASK }, { say: SEND2 }, { say: line, pumpBefore: 15 }],
    score: (r: RunRecord): Score => {
      const first = sentTwo(r);
      if (!first) return { premise: false, outcome: "premise_failed", note: `第二句派出 ${r.turnsOut[1]?.appliedNow.length ?? 0} 个` };
      const t = r.turnsOut[2];
      const others = t.appliedNow.filter((id) => !first.includes(id));
      if (others.length > 0) return { premise: true, outcome: "wrong_exec", note: `动了另外 ${others.length} 个` };
      const mine = t.ordersNow.filter((o) => first.includes(o.id) && t.appliedNow.includes(o.id));
      if (mine.length === 0) return { premise: true, outcome: t.pendingQuestion ? "still_asking" : "zero_exec", note: t.screen.at(-1) ?? "" };
      const home = mine.every((o) => near(o.target, r.homeOf.get(o.id)!, 3));
      return home
        ? { premise: true, outcome: mine.length === 2 ? "first_right" : "wrong_exec", note: `${mine.length} 个回出发地` }
        : { premise: true, outcome: "wrong_exec", note: `去了 ${JSON.stringify(mine.map((o) => o.target))}（出发地 ${JSON.stringify(mine.map((o) => r.homeOf.get(o.id)))}）` };
    },
  }))),
  {
    name: "quick",
    turns: [{ say: ASK }, { say: SEND2 }, { say: "刚才那两个快撤", pumpBefore: 15 }],
    score: (r) => {
      const first = sentTwo(r);
      if (!first) return { premise: false, outcome: "premise_failed", note: `第二句派出 ${r.turnsOut[1]?.appliedNow.length ?? 0} 个` };
      const t = r.turnsOut[2];
      const others = t.appliedNow.filter((id) => !first.includes(id));
      if (others.length > 0) return { premise: true, outcome: "wrong_exec", note: `动了另外 ${others.length} 个` };
      const exec = t.traces.filter((x) => x.stage === "exec").flatMap((x) => (x.data.intents as { intent: Record<string, unknown> }[] | undefined) ?? []);
      const retreat = exec.map((e) => e.intent).find((i) => i.type === "retreat");
      const mine = t.appliedNow.filter((id) => first.includes(id));
      if (!retreat || mine.length === 0) return { premise: true, outcome: t.pendingQuestion ? "still_asking" : "zero_exec", note: t.screen.at(-1) ?? "" };
      const bare = !retreat.targetFacility && !retreat.targetRegion && !retreat.toFront && !retreat.returnTo;
      const north = r.state.facilities.get(NP)!.position;
      const toNorth = t.ordersNow.some((o) => mine.includes(o.id) && near(o.target, north, 6));
      if (toNorth) return { premise: true, outcome: "wrong_exec", note: "撤往北线前哨" };
      return bare
        ? { premise: true, outcome: mine.length === 2 ? "first_right" : "wrong_exec", note: `裸撤退 ${mine.length} 个` }
        : { premise: true, outcome: "wrong_exec", note: `不是裸撤退：${JSON.stringify(retreat)}` };
    },
  },
  {
    name: "approval-one",
    turns: [{ say: ASK }, { say: "北线要不要加人", inject: "confirm-two" }, { say: "一个就够了" }],
    score: (r) => approvalScore(r, 2, 1),
  },
  {
    name: "approval-yes",
    turns: [{ say: ASK }, { say: "北线要不要加人", inject: "confirm-two" }, { say: "是的" }],
    score: (r) => approvalScore(r, 2, 2),
  },
  {
    name: "reinforce",
    turns: [{ say: ASK }, { say: SEND2 }, { say: "再派两个去北线前哨", pumpBefore: 20 }],
    score: (r) => {
      const first = sentTwo(r);
      if (!first) return { premise: false, outcome: "premise_failed", note: `第二句派出 ${r.turnsOut[1]?.appliedNow.length ?? 0} 个` };
      const t = r.turnsOut[2]; const north = r.state.facilities.get(NP)!.position;
      const fresh = t.appliedNow.filter((id) => !first.includes(id));
      if (fresh.length === 2 && t.ordersNow.filter((o) => fresh.includes(o.id)).every((o) => near(o.target, north, 6))) return { premise: true, outcome: "first_right", note: "又派 2 个" };
      if (fresh.length > 2) return { premise: true, outcome: "wrong_exec", note: `又派 ${fresh.length} 个` };
      if (fresh.length > 0) return { premise: true, outcome: "wrong_exec", note: `又派 ${fresh.length} 个（数或去处不对）` };
      return { premise: true, outcome: t.pendingQuestion ? "still_asking" : "zero_exec", note: t.screen.at(-1) ?? "" };
    },
  },
  {
    name: "voice-flow",
    turns: [{ say: "", voice: "ask.wav" }, { say: "", voice: "send.wav" }],
    score: (r) => {
      const [t1, t2] = r.turnsOut;
      const north = r.state.facilities.get(NP)!.position;
      const consultOk = t1.appliedNow.length === 0 && t1.ear.length >= 1;
      const execOk = t2.appliedNow.length === 2 && t2.ordersNow.every((o) => near(o.target, north, 6));
      const earOk = t2.ear.length === 1 && /2 个/.test(t2.ear[0].text) && t2.ear[0].text.includes(t2.screen.at(-1) ?? "\u0000");
      if (!consultOk) return { premise: true, outcome: "wrong_exec", note: `咨询句派了 ${t1.appliedNow.length} 个／耳朵 ${t1.ear.length} 段` };
      if (!execOk) return { premise: true, outcome: t2.appliedNow.length ? "wrong_exec" : (t2.pendingQuestion ? "still_asking" : "zero_exec"), note: `派 ${t2.appliedNow.length} 个 | ${t2.screen.at(-1) ?? ""}` };
      return earOk ? { premise: true, outcome: "first_right", note: `耳朵：${t2.ear[0].text}` }
        : { premise: true, outcome: "wrong_exec", note: `执行对，但耳朵：${JSON.stringify(t2.ear.map((x) => x.text))}` };
    },
  },
  {
    name: "voice-approval-one",
    turns: [{ say: "", voice: "ask.wav" }, { say: "北线要不要加人", inject: "confirm-two" }, { say: "", voice: "one.wav" }],
    score: (r) => {
      const base = approvalScore(r, 2, 1);
      const t = r.turnsOut[2];
      const ear = t.ear.map((x) => x.text).join(" ");
      // 零执行时耳朵必须说「没有执行」，不许有任何「派过去了/出发」一类的话；执行了就只能是回执那一句
      if (t.appliedNow.length === 0 && /派过去|出发|已下令/.test(ear)) return { ...base, outcome: "wrong_exec", note: `零执行却念：${ear}` };
      if (t.appliedNow.length > 0 && t.ear.length !== 1) return { ...base, outcome: "wrong_exec", note: `执行了，耳朵 ${t.ear.length} 段：${ear}` };
      return { ...base, note: `${base.note} | 耳朵：${ear}` };
    },
  },
  {
    name: "retreat-to-facility",
    turns: [{ say: ASK }, { say: SEND2 }, { say: "刚才那两个撤回中央前哨", pumpBefore: 15 }],
    score: (r) => {
      const first = sentTwo(r);
      if (!first) return { premise: false, outcome: "premise_failed", note: `第二句派出 ${r.turnsOut[1]?.appliedNow.length ?? 0} 个` };
      const t = r.turnsOut[2];
      const others = t.appliedNow.filter((id) => !first.includes(id));
      if (others.length > 0) return { premise: true, outcome: "wrong_exec", note: `动了另外 ${others.length} 个` };
      const cp = r.state.facilities.get("ea_player_central_post")!.position;
      const mine = t.ordersNow.filter((o) => first.includes(o.id) && t.appliedNow.includes(o.id));
      if (mine.length === 0) return { premise: true, outcome: t.pendingQuestion ? "still_asking" : "zero_exec", note: t.screen.at(-1) ?? "" };
      return mine.every((o) => near(o.target, cp, 6))
        ? { premise: true, outcome: mine.length === 2 ? "first_right" : "wrong_exec", note: "到中央前哨" }
        : { premise: true, outcome: "wrong_exec", note: `去了 ${JSON.stringify(mine.map((o) => o.target))}` };
    },
  },
];

async function main() {
  const S = await serverRoutes({ real: true, gapMs: GAP_MS });
  const summary: Record<string, Record<string, number>> = {};
  const dump: Record<string, unknown[]> = {};
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    summary[sc.name] = {}; dump[sc.name] = [];
    for (let k = 0; k < RUNS; k++) {
      core.resetEscalationTickets();
      const state = core.createInitialGameState("el_alamein");
      pump(state, 3);
      const chanCtx = { current: ctxFns.createEmptyChannelContext() };
      const h = harness(state, source, "combat", undefined, {
        buildDigestForChannel,
        channelContextRef: chanCtx,
        pushContext: ctxFns.pushContext,
        formatContext: ctxFns.formatContext,
        commanderMemoryRef: { current: { combat: { playerIntent: "", openCommitments: [] }, ops: { playerIntent: "", openCommitments: [] }, logistics: { playerIntent: "", openCommitments: [] } } },
      });
      const rec: RunRecord = { state, group: [], homeOf: new Map(), turnsOut: [] };
      for (const turn of sc.turns) {
        if (turn.pumpBefore) pump(state, turn.pumpBefore);
        const rawMark = S.llm.raw.length; const scrMark = h.screen.length; const trMark = h.traces.length; const appMark = h.results.length;
        const reqMark = h.requests.length; const earMark = h.speech.length;
        const before = new Map([...state.units.values()].map((u) => [u.id, { ...u.position }]));
        if (turn.inject === "confirm-two") {
          const g = _ticketsForTest().find((x) => x.label.includes("中央前哨") && !x.burned)?.gNumber ?? "G1";
          h.turn({ brief: `长官，从${g}里派两个去北线前哨，行吗？`, responseType: "CONFIRM", recommended: "A", urgency: 0.4,
            options: [{ label: "A: 派两个去北线前哨", description: "抽两个去北线前哨设防", risk: 0.2, reward: 0.4,
              intents: [{ type: "defend", fromSquad: g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨" }] }] },
          { userMsg: turn.say });
          void overTheWire;
        } else if (turn.voice) {
          const data = readFileSync(`${VOICE_DIR}/${turn.voice}`).toString("base64");
          await h.send("", S.clientFetch, { voice: true, voiceData: data });
        } else {
          await h.send(turn.say, S.clientFetch);
        }
        const appliedNow = [...new Set(h.results.slice(appMark).flatMap((x) => x.appliedUnitIds))];
        for (const id of appliedNow) if (!rec.homeOf.has(id)) rec.homeOf.set(id, before.get(id)!);
        const slot = h.pendingSelectionRef.current; const pc = h.pendingContractRef.current;
        rec.turnsOut.push({
          say: turn.say,
          modelRaw: S.llm.raw.slice(rawMark).map(modelTextOf),
          delivered: h.requests.slice(reqMark).map((q) => q.path),
          screen: h.screen.slice(scrMark).filter((m) => m.source !== "player").map((m) => m.text),
          appliedNow,
          ordersNow: appliedNow.map((id) => { const u = state.units.get(id); return { id, action: u?.orders[0]?.action ?? "none", target: u?.orders[0]?.target ?? null }; }),
          traces: h.traces.slice(trMark).filter((x) => ["route", "exec", "refuse", "pending", "selection", "ask_quantity", "ask_selection", "quantity_chosen", "repeat_dispatch", "model_failure", "confirm_captured", "destination_quote"].includes(x.stage)),
          pendingQuestion: slot ? `selection:${slot.kind ?? "source"}` : pc ? `contract:${pc.summary?.slice(0, 60)}` : null,
          ear: h.speech.slice(earMark),
        });
        if (rec.group.length === 0) {
          const t = _ticketsForTest().find((x) => x.label.includes("中央前哨"));
          if (t) rec.group = [...t.unitIds];
        }
      }
      const score = sc.score(rec);
      summary[sc.name][score.outcome] = (summary[sc.name][score.outcome] ?? 0) + 1;
      console.log(`[${sc.name} #${k + 1}] ${score.outcome} ${score.note}`);
      for (const t of rec.turnsOut) console.log(`    「${t.say}」 → 派 ${t.appliedNow.length} | ${t.screen.join(" / ").slice(0, 160)}${t.ear.length ? ` | 耳朵：${t.ear.map((x) => x.text).join(" / ").slice(0, 120)}` : ""}`);
      dump[sc.name].push({ run: k + 1, score, group: rec.group, homeOf: Object.fromEntries(rec.homeOf), turns: rec.turnsOut });
    }
  }
  console.log("\n== 汇总（分母＝跑的局数；premise_failed 不计入对错，单列）==");
  for (const [n, c] of Object.entries(summary)) console.log(`${n}: ${JSON.stringify(c)}`);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/send-chain-realmodel-${Date.now()}.json`, JSON.stringify({
      when: new Date().toISOString(), runs: RUNS, gapMs: GAP_MS, profile: process.env.LLM_PROFILE ?? null,
      chain: "真信封＋真上下文 → 生产 index.ts 路由 → 生产 callAdvisorStream → 生产 sendCommand/processAdvisorData → handleApprove → applyOrders",
      summary, dump,
    }, null, 1));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
