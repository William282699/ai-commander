/**
 * 试玩记录仪 × 生产命令链的公共件。
 *
 * 浏览器那一端：生产 ChatPanel（chainHarness 从源码 AST 取原函数）＋ 生产记录器（recorder/index.ts）。
 * 服务端那一端：本地 express，挂**生产**的命令路由处理函数（从 index.ts AST 取原文，traceWrite/envelopeOf/
 * traceResult 用生产实现）＋ 记录仪上下文中间件 ＋ 记录仪路由。模型是假的（chainHarness.serverRoutes 的排队回法）。
 * 浏览器 → 服务端走真 HTTP，带记录头；记录上传也走真 HTTP。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import express from "express";
import * as core from "@ai-commander/core";
import type { GameState, Unit, Intent } from "@ai-commander/shared";
import { serverRoutes, modelText, type LlmStep } from "./chainHarness";
import { startServer, tempDir } from "./recorder-test-lib";

export const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function astFind(src: string, pick: (n: ts.Node, sf: ts.SourceFile) => string | null): string {
  const sf = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = "";
  const visit = (n: ts.Node) => { const hit = pick(n, sf); if (hit) found = hit; ts.forEachChild(n, visit); };
  visit(sf);
  return found;
}
const toJs = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

export const reply = (prose: string, json: Record<string, unknown>): LlmStep => ({ kind: "text", text: modelText(prose, json) });
export const NP = "ea_player_coastal_post";
export const order = (brief: string, intents: Record<string, unknown>[], more: Record<string, unknown> = {}) => reply(brief, {
  brief, responseType: "EXECUTE", recommended: "A", urgency: 0.5,
  options: [{ label: "A: 派兵", description: brief, risk: 0.3, reward: 0.5, intents }], ...more,
});
export const choose = (key: string, brief = "明白。") => reply(brief, { brief, responseType: "EXECUTE", recommended: "A", urgency: 0.4, options: [],
  dispatchSelection: { decision: "chose", candidate: key } });
export const splitTwo = (g: string) => [
  { type: "defend", fromSquad: g, quantity: 2, unitType: "armor", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" },
  { type: "defend", fromSquad: g, quantity: 2, unitType: "infantry", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" },
];
export const CONFIRM = (g: string, n = 2) => reply(`长官，从${g}里派${n}个去北线前哨，行吗？`, {
  brief: `长官，从${g}里派${n}个去北线前哨，行吗？`, responseType: "CONFIRM", recommended: "A", urgency: 0.4,
  options: [{ label: `A: 派${n}个去北线前哨`, description: "抽人去北线前哨设防", risk: 0.2, reward: 0.4,
    intents: [{ type: "defend", fromSquad: g, quantity: n, targetFacility: NP, destinationQuote: "北线前哨" }] }],
});
export const authorizeEcho = (g: string) => reply("按您说的办。", {
  brief: "按您说的办。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "authorize",
  options: [{ label: "A: 方案1", description: "", risk: 0.2, reward: 0.4, intents: [{ type: "defend", fromSquad: g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨" }] }],
});

let nextId = 40000;
/** 空场地＋「中央前哨附近未编组」的混编群（4 坦克＋4 步兵），铸一个 G 号（同 probe-send-chain 的夹具）。 */
export function mixedGroup() {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein");
  const tpl = (type: string) => structuredClone([...state.units.values()].find((u) => u.team === "player" && u.type === type)!);
  const inf = tpl("infantry"); const tank = tpl("main_tank");
  state.units.clear(); state.squads = []; state.missions = []; state.dispatches = [];
  const add = (t: Unit, x: number, y: number) => {
    const u: Unit = { ...structuredClone(t), id: nextId++, position: { x, y }, state: "idle", orders: [], waypoints: [],
      patrolPoints: [], patrolTaskId: null, manualOverride: false, target: null, attackTarget: null };
    state.units.set(u.id, u); return u;
  };
  const cp = state.facilities.get("ea_player_central_post")!.position;
  const tanks = [0, 1, 2, 3].map((k) => add(tank, cp.x + k, cp.y + 2));
  const infantry = [0, 1, 2, 3].map((k) => add(inf, cp.x + k, cp.y + 3));
  const g = core.mintSpokenForce(state, null, { label: "中央前哨附近未编组群", memberIds: [...tanks, ...infantry].map((u) => u.id), etaSec: 40 })!;
  const north = state.facilities.get(NP)!.position;
  return { state, tanks, infantry, g, north, groupIds: new Set([...tanks, ...infantry].map((u) => u.id)), add, tpl };
}

/** 南线：2 个留守、2 个已从南线派出去（台账里有这一笔）——「南线的都撤回来」要问“是哪一批”。 */
export function southStayAndSent() {
  const f = mixedGroup();
  const sp = f.state.facilities.get("ea_player_south_post")!.position;
  const tpl = structuredClone(f.state.units.get(f.infantry[0].id)!);
  const mk = (x: number, y: number) => { const u: Unit = { ...structuredClone(tpl), id: nextId++, position: { x, y }, orders: [], state: "idle", target: null }; f.state.units.set(u.id, u); return u; };
  const stay = [mk(sp.x, sp.y), mk(sp.x + 1, sp.y)];
  const sent = [mk(sp.x + 2, sp.y), mk(sp.x + 3, sp.y)];
  const r = core.resolveIntent({ type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: 2 } as Intent, f.state, f.state.style, undefined, sent.map((u) => u.id));
  core.applyOrders(f.state, r.orders.map((o) => ({ ...o, origin: "advisor", dispatchMeta: { group: "s", sourceKind: "front", sourceKey: "front_south", action: "attack", targetName: r.destinationName } })) as Parameters<typeof core.applyOrders>[1]);
  for (const u of sent) u.position = { x: 360, y: 76 };
  return { ...f, stay, sent, southPost: sp };
}

/** 记录用的本地服务：生产命令路由＋记录仪上下文＋记录仪路由（真 HTTP）。 */
export async function recordingServer(opts: { collect?: boolean; limits?: Record<string, number> } = {}) {
  const S = await serverRoutes();
  const { createRecorder } = await import("../apps/server/src/recorder/routes");
  const { commandContext } = await import("../apps/server/src/recorder/context");
  const traceLog = await import("../apps/server/src/traceLog");
  const voice = await import("../apps/server/src/voiceInput");
  const idx = readFileSync(new URL("../apps/server/src/index.ts", import.meta.url), "utf8");
  const traceResultSrc = astFind(idx, (n, sf) => (ts.isFunctionDeclaration(n) && n.name?.text === "traceResult" ? n.getText(sf) : null));
  assert.ok(traceResultSrc, "production traceResult");
  const traceResult = new Function("traceWrite", "intentsOf", `${toJs(traceResultSrc)}\nreturn traceResult;`)(traceLog.traceWrite, traceLog.intentsOf);
  const noop = () => {};
  const deps: Record<string, unknown> = {
    rejectCommandBody: voice.rejectCommandBody, audioOf: voice.audioOf,
    callAdvisor: S.ai.callAdvisor, callAdvisorStream: S.ai.callAdvisorStream,
    logEvent: noop, speechDiagOf: () => undefined, traceWrite: traceLog.traceWrite, envelopeOf: traceLog.envelopeOf,
    logHeard: noop, logAdvisorIntents: noop, traceResult,
  };
  const handlerFor = (path: string) => {
    const text = astFind(idx, (n, sf) => (ts.isCallExpression(n) && n.expression.getText(sf) === "app.post"
      && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === path ? n.arguments[1].getText(sf) : null));
    assert.ok(text, `production route ${path}`);
    return new Function(...Object.keys(deps), `${toJs(`const handler = ${text};`)}\nreturn handler;`)(...Object.values(deps));
  };
  const dir = tempDir("chain");
  const rec = createRecorder({ dataDir: dir, collect: opts.collect ?? true, adminToken: "admin-token-for-tests-0123456789", limits: opts.limits ?? {}, buildInfo: { build: "test", models: [{ channel: "combat", profile: "stub", model: "stub" }] } });
  await rec.ready;
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(commandContext);
  app.use(rec.router);
  app.post("/api/command", handlerFor("/api/command"));
  app.post("/api/command-stream", handlerFor("/api/command-stream"));
  const srv = await startServer(app as unknown as Parameters<typeof startServer>[0]);
  const store = rec.store()!;
  return { S, srv, store, rec, dir };
}

/** 浏览器那一端的 fetch：命令请求走真 HTTP（带记录头），/api/brief（代价台词）给固定回包。 */
export function browserFetch(baseUrl: string, opts: { preflight?: string; streamDown?: boolean; truncateStream?: boolean } = {}) {
  return async (url: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => {
    const path = new URL(url, "http://harness").pathname;
    if (path === "/api/brief") return new Response(JSON.stringify({ brief: opts.preflight ?? "", urgency: 0.5 }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (opts.streamDown && path === "/api/command-stream") return new Response("bad gateway", { status: 502 });
    const res = await realFetch(`${baseUrl}${path}`, { method: init?.method ?? "POST", headers: init?.headers, body: init?.body });
    if (opts.truncateStream && path === "/api/command-stream") {
      // 服务端这一程完整跑完（它的尝试照记），但连接在单子送到浏览器之前断了：浏览器只收到正文，没收到 options。
      const text = await res.text();
      const cut = text.split("\n\n").filter((b) => b && !b.includes('"type":"options"') && !b.includes("[DONE]")).join("\n\n") + "\n\n";
      return new Response(cut, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return res;
  };
}

export async function drainRecorder(status: () => { queued: number } | null, ms = 8000): Promise<void> {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 20)); // 关键快照在下一拍
  while ((status()?.queued ?? 0) > 0) {
    if (Date.now() - t0 > ms) throw new Error("recorder did not drain");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export type Line = { type: string; turn?: string; turnFrom?: string; runFrom?: string; seq: number; pid: string; src: string; gt?: number; d: Record<string, any> };
export const stage = (l: Line) => (l.type === "trace" ? l.d.stage : l.type);
export const data = (l: Line) => (l.type === "trace" ? l.d.data : l.d);

export function parseJsonl(buf: Buffer | undefined): Line[] {
  return (buf?.toString("utf8") ?? "").split("\n").filter(Boolean).map((x) => JSON.parse(x));
}

export interface ChainFollow {
  replyTurn: string;
  link: Line;
  planTurn: string;
  planSide: Line;
  exec: Line;
  appliedIds: number[];
  serverReply: Line | undefined;
  serverPlan: Line | undefined;
  execSnapshot: Line | undefined;
}

/**
 * 只凭导出包里的记录，从“长官的这句答复”一路追到“它批准/选定的是哪一轮的方案”再到“实际接令的是谁”。
 * 任何一环断了就抛出（写明断在哪）。
 */
export function followReply(traces: Line[], snapshots: Line[], replyText: string, originalText: string, kind: "pending" | "selection"): ChainFollow {
  const turnEv = traces.find((l) => stage(l) === "turn" && data(l).text === replyText);
  assert.ok(turnEv?.turn, `no turn record for the reply 「${replyText}」`);
  const replyTurn = turnEv!.turn!;
  const link = traces.find((l) => l.turn === replyTurn && (kind === "pending" ? stage(l) === "pending" : stage(l) === "selection") && data(l).planTraceId);
  assert.ok(link, `reply turn ${replyTurn} has no ${kind} event carrying planTraceId`);
  const planTurn = data(link!).planTraceId as string;
  assert.notEqual(planTurn, replyTurn, "the plan is a different turn than the reply");
  const planTurnEv = traces.find((l) => stage(l) === "turn" && l.turn === planTurn);
  assert.ok(planTurnEv, `plan turn ${planTurn} not found`);
  assert.equal(data(planTurnEv!).text, originalText, "plan turn is the original command");
  const planSide = kind === "pending"
    ? traces.find((l) => stage(l) === "plan_registered" && data(l).pendingId === data(link!).pendingId && data(l).planTraceId === planTurn)
    : traces.find((l) => (stage(l) === "ask_selection" || stage(l) === "ask_quantity") && data(l).selectionId === data(link!).selectionId && data(l).planTraceId === planTurn);
  assert.ok(planSide, `no ${kind === "pending" ? "plan_registered" : "ask_*"} with the same id under plan turn ${planTurn}`);
  const exec = traces.find((l) => stage(l) === "exec" && l.turn === replyTurn && data(l).planTraceId === planTurn);
  assert.ok(exec, `no exec under reply turn ${replyTurn} naming plan ${planTurn}`);
  const appliedIds = (data(exec!).applied as number[]).slice().sort((a, b) => a - b);
  const serverReply = traces.find((l) => l.src === "server" && l.type === "srv_request" && l.turn === replyTurn);
  const serverPlan = traces.find((l) => l.src === "server" && l.type === "srv_request" && l.turn === planTurn);
  const execSnapshot = snapshots.find((l) => l.d.reason === "exec" && l.turn === replyTurn);
  return { replyTurn, link: link!, planTurn, planSide: planSide!, exec: exec!, appliedIds, serverReply, serverPlan, execSnapshot };
}

export type { GameState };
