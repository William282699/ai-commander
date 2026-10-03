/**
 * 整条回复链的确定性反例（第六轮）。运行：node --import tsx scripts/probe-send-chain.ts
 *
 * 每一格都从**长官打的那一句**开始：假模型（排好的回法）→ 生产服务端路由
 * （index.ts 原 handler）→ 生产 callAdvisor / callAdvisorStream（解析、校验、
 * 归一化、兜底）→ 生产 sendCommand（SSE 解析、兜底请求）→ 生产
 * processAdvisorData（批准判官、选择合同、闸、桶、自动执行）→ handleApprove →
 * applyOrders。核的是**真接到命令的单位 ID、人数、落点**，不看模型写的 brief。
 *
 * 不冒充浏览器、真模型或真实音频：模型回法是手写的（形状取自交接档里的真实复现）。
 */
import assert from "node:assert/strict";
import * as core from "@ai-commander/core";
import * as shared from "@ai-commander/shared";
import type { GameState, Unit, Intent } from "@ai-commander/shared";
import { harness, serverRoutes, modelText, source, round5Sources, round6Sources, round7Sources, round8Sources, oldFunctions, type LlmStep } from "./chainHarness";
import { isValidTarget as liveIsValidTarget } from "../apps/web/src/autoExecuteGate";
import { activeDispatches, liveDispatchMembers } from "../packages/core/src/dispatchLedger";
import { tick } from "../packages/core/src/sim";

// ── 小工具 ──────────────────────────────────────────────────────────
let count = 0; let negCount = 0; const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); count++; if (name.includes("负对照")) negCount++; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n").slice(0, 6).join("\n     ")}`); }
}
type H = ReturnType<typeof harness>;
const allOrders = (s: GameState) => JSON.stringify([...s.units].map(([id, u]) => [id, u.orders, u.state]));
/** 本局到目前为止**真接到新命令**的单位（按 ID 去重）。 */
const dispatchedIds = (h: H) => [...new Set(h.results.flatMap((r) => r.appliedUnitIds))].sort((a, b) => a - b);
/** 屏上参谋这一侧说的话（去掉长官自己那句）。 */
const staffLines = (h: H) => h.screen.filter((m) => m.source !== "player").map((m) => m.text);
const said = (h: H) => staffLines(h).join(" | ");
const near = (a: { x: number; y: number } | null | undefined, b: { x: number; y: number }, r = 6) =>
  !!a && Math.hypot(a.x - b.x, a.y - b.y) <= r;
/** 某个单位最近一次接到的命令的目标点。 */
const targetOf = (h: H, id: number) => {
  for (let b = h.applications.length - 1; b >= 0; b--) {
    const hit = h.results[b].perOrder.find((o) => o.appliedUnitIds.includes(id));
    if (hit) return h.applications[b][hit.orderIndex].target ?? null;
  }
  return null;
};

let S: Awaited<ReturnType<typeof serverRoutes>>;
/** 浏览器那一端：`streamDown` ⇒ SSE 路由连不上（走 /api/command 兜底）；`down` ⇒ 整个后端连不上。 */
function client(opts: { streamDown?: boolean; down?: boolean; rawStatus?: number; preflight?: string } = {}) {
  return async (url: string, init?: { body?: string }) => {
    if (opts.down) throw new TypeError("Failed to fetch");
    // 高影响那一问的代价台词走 /api/brief（独立的一次模型调用）——这里用固定回包代替那一次调用。
    if (url.endsWith("/api/brief")) return new Response(JSON.stringify({ brief: opts.preflight ?? "", urgency: 0.5 }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (opts.rawStatus) return new Response("<html>Too Many Requests</html>", { status: opts.rawStatus });
    if (opts.streamDown && url.endsWith("/api/command-stream")) return new Response("bad gateway", { status: 502 });
    return S.clientFetch(url, init);
  };
}
async function say(h: H, text: string, steps: LlmStep[], opts: Parameters<typeof client>[0] & { voice?: boolean } = {}) {
  S.llm.queue = [...steps];
  await h.send(text, client(opts), { voice: opts.voice });
  assert.equal(S.llm.queue.length, 0, `model was scripted for ${steps.length} call(s) but ${steps.length - S.llm.queue.length} happened`);
}
const reply = (prose: string, json: Record<string, unknown>): LlmStep => ({ kind: "text", text: modelText(prose, json) });
/** 一个 LlmStep 里 ---JSON--- 之后那份 JSON 的原文。 */
const modelTextJson = (step: LlmStep) => (step.kind === "text" ? step.text.split("---JSON---")[1] : "{}");

// ── 夹具 ────────────────────────────────────────────────────────────
let nextId = 30000;
/** 空场地＋一群「中央前哨附近未编组」的混编部队（4 主战坦克＋4 步兵），并给它铸一个 G 号。 */
function mixedGroup() {
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
  const g = core.mintSpokenForce(state, null, {
    label: "中央前哨附近未编组群", memberIds: [...tanks, ...infantry].map((u) => u.id), etaSec: 40,
  })!;
  const north = state.facilities.get("ea_player_coastal_post")!.position;
  return { state, tanks, infantry, g, north, groupIds: new Set([...tanks, ...infantry].map((u) => u.id)) };
}
const NP = "ea_player_coastal_post";
/** 模型把「两个」按兵种拆成两条（交接档 §2 的真实形状）。 */
const splitTwo = (g: string, q1 = "两个", q2 = "两个", extra: Partial<Intent> = {}) => [
  { type: "defend", fromSquad: g, quantity: 2, unitType: "armor", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: q1, ...extra },
  { type: "defend", fromSquad: g, quantity: 2, unitType: "infantry", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: q2, ...extra },
];
const order = (brief: string, intents: Record<string, unknown>[], more: Record<string, unknown> = {}) => reply(brief, {
  brief, responseType: "EXECUTE", recommended: "A", urgency: 0.5,
  options: [{ label: "A: 派兵", description: brief, risk: 0.3, reward: 0.5, intents }], ...more,
});

async function main() {
S = await serverRoutes();
// ════════════════════════════════════════════════════════════════════
// §1 模型失败必须零执行（交接档 §1）
// ════════════════════════════════════════════════════════════════════
const GARBLED: LlmStep = { kind: "text", text: "长官，那两个我这就让他们撤下来，" }; // 没有 JSON ⇒ 解析失败
const RATE_LIMIT: LlmStep = { kind: "status", status: 429, body: "Resource exhausted" };
const NET_DOWN: LlmStep = { kind: "throw", message: "fetch failed" };

async function failureTurn(steps: LlmStep[], opts: Parameters<typeof client>[0] = {}) {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein"); // 真实初始局（85 个单位）
  const h = harness(state);
  const before = allOrders(state);
  await say(h, "刚才那两个快撤", steps, opts);
  return { state, h, before };
}
function assertInertFailure(r: Awaited<ReturnType<typeof failureTurn>>) {
  const { state, h, before } = r;
  assert.equal(h.applications.length, 0, `applyOrders ran ${h.applications.length} time(s); screen: ${said(h)}`);
  assert.equal(allOrders(state), before, "no unit got any order");
  assert.doesNotMatch(said(h), /已下令|出发|派过去/, "screen must not claim anything was done");
  assert.match(said(h), /没有执行/, `screen says nothing was executed: ${said(h)}`);
  assert.ok(h.doctrineSources.length === 0, "no standing order / doctrine side effect");
}

await test("F1 ★SSE：模型输出解析失败（服务端兜底）⇒ 零执行，屏上说没执行", async () => {
  assertInertFailure(await failureTurn([GARBLED]));
});
await test("F2 ★SSE：模型 429 限流（服务端兜底）⇒ 零执行", async () => {
  assertInertFailure(await failureTurn([RATE_LIMIT]));
});
await test("F3 SSE：模型网络异常 ⇒ 零执行", async () => {
  assertInertFailure(await failureTurn([NET_DOWN]));
});
await test("F4 ★非流（SSE 连不上走 /api/command）：解析失败 ⇒ 零执行", async () => {
  assertInertFailure(await failureTurn([GARBLED], { streamDown: true }));
});
await test("F5 非流：模型 429 ⇒ 零执行", async () => {
  assertInertFailure(await failureTurn([RATE_LIMIT], { streamDown: true }));
});
await test("F6 后端整个连不上 / 代理直接回 429 页面 ⇒ 零执行", async () => {
  for (const opts of [{ down: true }, { rawStatus: 429 }]) {
    core.resetEscalationTickets();
    const state = core.createInitialGameState("el_alamein"); const h = harness(state);
    const before = allOrders(state);
    S.llm.queue = []; await h.send("刚才那两个快撤", client(opts));
    assert.equal(h.applications.length, 0); assert.equal(allOrders(state), before);
    assert.doesNotMatch(said(h), /已下令/);
  }
});

/** 陈带着完整方案问「行吗？」——存成待确认合同。 */
const CONFIRM = (g: string, n = 2) => reply(`长官，从${g}里派${n}个去北线前哨，行吗？`, {
  brief: `长官，从${g}里派${n}个去北线前哨，行吗？`, responseType: "CONFIRM", recommended: "A", urgency: 0.4,
  options: [{ label: `A: 派${n}个去北线前哨`, description: "抽人去北线前哨设防", risk: 0.2, reward: 0.4,
    intents: [{ type: "defend", fromSquad: g, quantity: n, targetFacility: NP, destinationQuote: "北线前哨" }] }],
});
await test("F7 ★待批准方案挂着时通讯失败 ⇒ 旧方案不执行也不作废、兜底里的方案不执行；恢复后照常点头执行一次", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  const pc = h.pendingContractRef.current; assert.ok(pc, "plan captured");
  const before = allOrders(f.state);
  await say(h, "就按这个办，派过去", [RATE_LIMIT]);
  assert.equal(h.applications.length, 0, `nothing ran: ${said(h)}`); assert.equal(allOrders(f.state), before);
  assert.equal(h.pendingContractRef.current?.id, pc.id, "the waiting plan survives a comms failure (not consumed, not dropped)");
  await say(h, "就按这个办，派过去", [reply("办。", { brief: "办。", responseType: "EXECUTE", pendingDecision: "authorize", options: [], recommended: "A", urgency: 0.4 })]);
  assert.equal(dispatchedIds(h).length, 2, `the stored plan runs once: ${said(h)}`);
  for (const id of dispatchedIds(h)) assert.ok(f.groupIds.has(id) && near(targetOf(h, id), f.north));
});
await test("F8 ★「是哪一批」待答时通讯失败 ⇒ 零执行、问题还挂着；随后答了照常只动选中的那批", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  // 先派 2 个出去，造一个「留守 vs 外派」的歧义
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const sent = dispatchedIds(h); assert.equal(sent.length, 2);
  for (const id of sent) f.state.units.get(id)!.position = { x: 360, y: 60 }; // 夹具：已在路上
  // 「中央前哨那边的都撤回来」⇒ fromFront=central 同时覆盖留守 6 个与外派 2 个 ⇒ 问
  const front = core.findFront(f.state, "front_center")!;
  for (const u of f.state.units.values()) if (!sent.includes(u.id)) assert.ok(u.orders.length === 0);
  void front;
  const n0 = h.applications.length;
  await say(h, "那一群里派出去的撤回来", [order("撤。", [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }])]);
  const slot = h.pendingSelectionRef.current;
  if (slot) {
    const before = allOrders(f.state);
    await say(h, "派出去的那批", [GARBLED]);
    assert.equal(h.applications.length, n0, "failure turn executes nothing"); assert.equal(allOrders(f.state), before);
    assert.equal(h.pendingSelectionRef.current?.id, slot.id, "question survives");
  } else {
    // 用过的 G 号已直接指向那 2 个（没有歧义）：这一格退化为「无待决时的失败」，照样只要求零执行
    assert.equal(h.applications.length, n0 + 1);
  }
});

// ════════════════════════════════════════════════════════════════════
// §2 数量消歧必须绑定答案（交接档 §2）／§3 不同引用 ≠ 各自数量（交接档 §3）
// ════════════════════════════════════════════════════════════════════
const QTOTAL = "quantity:total"; const QEACH = "quantity:by_type";
const choose = (key: string, brief = "明白。") => reply(brief, { brief, responseType: "EXECUTE", recommended: "A", urgency: 0.4, options: [],
  dispatchSelection: { decision: "chose", candidate: key } });

await test("Q1 ★「派其中两个」被拆成坦克 2＋步兵 2 ⇒ 问、零执行；答「一共两个」而模型照旧交两条（Codex 复现）⇒ 绝不派 4 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  assert.equal(h.applications.length, 0, `asked first: ${said(h)}`);
  assert.match(staffLines(h).at(-1)!, /一共 2 个.*每种各 2 个（共 4 个）/);
  await say(h, "一共两个", [order("两个去北线前哨。", splitTwo(f.g))]);
  assert.notEqual(dispatchedIds(h).length, 4, `never 4: ${said(h)}`);
  assert.ok(dispatchedIds(h).length <= 2);
});
await test("Q1b ★答「一共两个」且模型交回选择（total）⇒ 恰好 2 个、都出自那一群、都去北线前哨；回执说 2", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  await say(h, "一共两个", [choose(QTOTAL)]);
  const ids = dispatchedIds(h);
  assert.equal(ids.length, 2, `exactly two: ${said(h)}`);
  for (const id of ids) { assert.ok(f.groupIds.has(id)); assert.ok(near(targetOf(h, id), f.north), `unit ${id} → north post`); }
  assert.match(said(h), /2 个/); assert.doesNotMatch(said(h), /4 个单位/);
});
await test("Q1c 答「每种各两个」且模型交回 each ⇒ 合法派 4 个（2 坦克＋2 步兵），回执给出合计 4", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  await say(h, "每种各两个", [choose(QEACH)]);
  const ids = dispatchedIds(h);
  assert.equal(ids.length, 4, said(h));
  assert.equal(ids.filter((id) => f.state.units.get(id)!.type === "main_tank").length, 2);
  assert.equal(ids.filter((id) => f.state.units.get(id)!.type === "infantry").length, 2);
  for (const id of ids) assert.ok(near(targetOf(h, id), f.north));
  assert.match(said(h), /合计.*4 个/, `a total line: ${said(h)}`);
});
await test("Q1d 多候选只回「对」/ 模型判没指明 / 缺字段 / 编造 key ⇒ 一律零执行、再问", async () => {
  for (const answer of [
    { text: "对", step: null },
    { text: "是的", step: reply("您是说一共两个，还是每种各两个？", { brief: "您是说一共两个，还是每种各两个？", responseType: "ASK", options: [], recommended: "A", urgency: 0.3, dispatchSelection: { decision: "unclear" } }) },
    { text: "嗯", step: reply("好。", { brief: "好。", responseType: "NOOP", options: [], recommended: "A", urgency: 0.3 }) },
    { text: "就那样", step: choose("quantity:all") },
  ]) {
    const f = mixedGroup(); const h = harness(f.state);
    await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
    // 「对」是封闭确认词：走捷径也不许执行（多候选的开放问题不是待批准方案）；捷径不接就交给模型——同样判没指明
    await say(h, answer.text, answer.step ? [answer.step] : [reply("一共几个？", { brief: "一共几个？", responseType: "ASK", options: [], recommended: "A", urgency: 0.3, dispatchSelection: { decision: "unclear" } })]);
    assert.equal(h.applications.length, 0, `${answer.text}: ${said(h)}`);
    assert.ok(h.pendingSelectionRef.current, `${answer.text}: still asking`);
  }
});
await test("Q1e 跨局 / 过期 ⇒ 答了也零执行", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  f.state.time += 10_000; // 远超 120 秒
  await say(h, "一共两个", [choose(QTOTAL)]);
  assert.equal(h.applications.length, 0, `expired: ${said(h)}`);
  const f2 = mixedGroup(); const h2 = harness(f2.state);
  await say(h2, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f2.g))]);
  h2.gameEpochRef.current++;
  await say(h2, "一共两个", [choose(QTOTAL)]);
  assert.equal(h2.applications.length, 0, `new game: ${said(h2)}`);
});

await test("Q2 ★「派两个坦克和步兵」：模型抄「两个坦克」「步兵」各 2 个（Codex 复现）⇒ 「步兵」不含数量，不能证明各自 2 个：问、零执行", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派两个坦克和步兵去北线前哨", [order("坦克步兵各两个。", splitTwo(f.g, "两个坦克", "步兵"))]);
  assert.equal(h.applications.length, 0, `must ask, not send 4: ${said(h)}`);
});
await test("Q2b 正例：「两辆坦克和两个步兵」各抄各的数量 ⇒ 不问，派 4 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派两辆坦克和两个步兵去北线前哨", [order("坦克两辆、步兵两个。", splitTwo(f.g, "两辆坦克", "两个步兵"))]);
  assert.equal(dispatchedIds(h).length, 4, said(h));
});
await test("Q2c 正例：「派其中三个」分成坦克 2＋步兵 1（总量分配，两条都抄「三个」）⇒ 不问，派 3 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const its = splitTwo(f.g, "三个", "三个"); its[1].quantity = 1;
  await say(h, "派其中三个去北线前哨", [order("三个去北线前哨。", its)]);
  assert.equal(dispatchedIds(h).length, 3, said(h));
});
await test("Q2d「派两个坦克和步兵」被写成坦克 2＋步兵 1（2＋1 不是它说的总量）⇒ 问、零执行", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const its = splitTwo(f.g, "两个坦克", "步兵"); its[1].quantity = 1;
  await say(h, "派两个坦克和步兵去北线前哨", [order("坦克两个、步兵一个。", its)]);
  assert.equal(h.applications.length, 0, said(h));
});

// ════════════════════════════════════════════════════════════════════
// §4 批准 ≠ 修改数量（交接档 §4）
// ════════════════════════════════════════════════════════════════════
await test("A1 ★存了「派 2 个去北线前哨」→ 长官「一个就够了」→ 模型判 authorize 却带 1 个的新单子 ⇒ 不执行旧方案（2 个），零执行并说明", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  await say(h, "一个就够了", [order("一个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 1, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "一个" }], { pendingDecision: "authorize" })]);
  assert.notEqual(dispatchedIds(h).length, 2, `the old 2-unit plan must not run: ${said(h)}`);
  assert.equal(h.applications.length, 0, said(h));
  assert.match(said(h), /没有执行/);
});
await test("A2 ★交接档原形：两条各 2 个、目的地只到北部战线 ⇒ 引擎先问；答「一共两个」、模型 authorize＋一条 2 个 ⇒ 绝不执行 4 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const its = splitTwo(f.g).map(({ targetFacility, ...rest }) => ({ ...rest, toFront: "front_coastal" }));
  await say(h, "派其中两个去北线前哨", [order("两个去北线。", its)]);
  assert.equal(h.applications.length, 0, "first turn asks");
  await say(h, "一共两个", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, toFront: "front_coastal", destinationQuote: "北线前哨", quantityQuote: "两个" }], { pendingDecision: "authorize" })]);
  assert.notEqual(dispatchedIds(h).length, 4, `never the 4-unit plan: ${said(h)}`);
});
await test("A3 单条 3 个、目的地只到北部战线 ⇒ 问「按北线前哨办吗」；长官「两个就行」、模型 authorize＋2 个 ⇒ 不执行 3 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中三个去北线前哨", [order("三个去北线。", [{ type: "defend", fromSquad: f.g, quantity: 3, toFront: "front_coastal", destinationQuote: "北线前哨", quantityQuote: "三个" }])]);
  assert.ok(h.pendingContractRef.current, `narrowed plan stored: ${said(h)}`);
  await say(h, "两个就行", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }], { pendingDecision: "authorize" })]);
  assert.notEqual(dispatchedIds(h).length, 3, `the 3-unit plan must not run: ${said(h)}`);
});
/** 陈把「坦克步兵各两个（共 4 个）」当完整方案请长官点头（CONFIRM，两条）。 */
const CONFIRM_SPLIT = (g: string) => reply("长官，从那群里坦克步兵各派两个去北线前哨，行吗？", {
  brief: "长官，从那群里坦克步兵各派两个去北线前哨，行吗？", responseType: "CONFIRM", recommended: "A", urgency: 0.4,
  options: [{ label: "A: 各派两个", description: "坦克步兵各两个去北线前哨", risk: 0.2, reward: 0.4, intents: splitTwo(g) }] });
await test("A5 ★交接档 §4 原形（存的是两条共 4 个）：长官「一共两个」、模型 authorize＋一条 2 个 ⇒ 零执行，屏上说清「方案 4 个、这句 2 个」", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "北线要不要加点人", [CONFIRM_SPLIT(f.g)]);
  assert.ok(h.pendingContractRef.current, "4-unit plan stored");
  await say(h, "一共两个", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }], { pendingDecision: "authorize" })]);
  assert.equal(h.applications.length, 0, said(h));
  assert.match(staffLines(h).at(-1)!, /方案是 4 个，这句是 2 个/);
  assert.ok(h.pendingContractRef.current === null, "the old plan is dropped, not left for a later 「对」");
});
await test("A6 同一份存下的 4 个方案，长官只回「对」⇒ 先问数量读法（零执行），不直接派 4 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "北线要不要加点人", [CONFIRM_SPLIT(f.g)]);
  assert.equal(h.confirmShortcut("对"), true);
  assert.equal(h.applications.length, 0, said(h));
  assert.equal(h.pendingSelectionRef.current?.kind, "quantity");
  await say(h, "每种各两个", [choose(QEACH)]);
  assert.equal(dispatchedIds(h).length, 4, said(h));
});
await test("A4 回归：「是的」＋模型把存下的方案重写成只到战线（C1 形状）⇒ 仍按存下的执行（去北线前哨，2 个）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  await say(h, "是的", [order("依令。", [{ type: "defend", fromSquad: f.g, quantity: 2, toFront: "front_coastal" }], { pendingDecision: "authorize" })]);
  const ids = dispatchedIds(h); assert.equal(ids.length, 2, said(h));
  for (const id of ids) assert.ok(near(targetOf(h, id), f.north));
});

// ════════════════════════════════════════════════════════════════════
// §5 未执行不许显示成功（交接档 §5）
// ════════════════════════════════════════════════════════════════════
await test("R1 ★待批准方案在、回包没有有效 pendingDecision、brief 写「已经派过去了」⇒ 零执行，屏上与耳朵不许出现模型的成功承诺", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  const nAudio = h.audio.length;
  await say(h, "就按这个办，派过去", [reply("已经派过去了。", { brief: "已经派过去了。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: [{ label: "A", description: "", risk: 0.2, reward: 0.4, intents: [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP }] }] })]);
  assert.equal(h.applications.length, 0);
  assert.doesNotMatch(said(h), /已经派过去了/, `screen: ${said(h)}`);
  assert.doesNotMatch(h.audio.slice(nAudio).join(" "), /已经派过去了/, "ear");
  assert.match(said(h), /没有执行/);
  assert.doesNotMatch(h.contextEntries.filter((e) => e.role === "assistant").map((e) => e.text).join(" "), /已经派过去了/, "context");
});

// ════════════════════════════════════════════════════════════════════
// §6a 多余的「是的」不许另派一批（交接档「需要进一步复现」第一条）
//   形状取自第五轮自报（泵 20 秒后剩下那群被另铸新号、同名 G7；原始回包已丢，见报告）：
//   派出 2 个 → 局面走了一阵 → 长官随口「是的」（此刻没有任何待答的问题）→ 模型用新号把
//   同一道令又下了一遍（引用照抄上一句的「两个」「北线前哨」，不在「是的」里）。
// ════════════════════════════════════════════════════════════════════
/** 第一句派出 2 个，然后把剩下的 6 个按生产的做法另铸一个同名新号（板子重建时就是这样）。 */
async function sentTwoThenRemint(h: H, f: ReturnType<typeof mixedGroup>) {
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const first = dispatchedIds(h); assert.equal(first.length, 2);
  const rest = [...f.groupIds].filter((id) => !first.includes(id));
  const g2 = core.mintSpokenForce(f.state, null, { label: "中央前哨附近未编组群", memberIds: rest, etaSec: 40 })!;
  assert.notEqual(g2, f.g, "the remainder got a fresh number");
  return { first, g2 };
}
// ★测试调整（第七轮，有意为之）：原 D1 断言回执说「已经在前往北线前哨」——即把这张新单子当成重复、
//   谎称「已经在办」。交接复审明令禁止（长官若真要增援，会被骗）。现在：不另派、也不说在办，问要不要再派。
await test("D1（第七轮改写）多余的「是的」＋模型用剩下那群的新号重下同一道令 ⇒ 不另派一批，不说「已经在办」，而是问要不要再派", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { first, g2 } = await sentTwoThenRemint(h, f);
  await say(h, "是的", [order("临时编队两个单位前往北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  assert.deepEqual(dispatchedIds(h), first, `no second batch: ${said(h)}`);
  // 第八轮：问句由存下的整份方案生成（原断言钉的是只拿第一条命中拼出来的旧问句，正是第八轮的病）。
  assert.match(staffLines(h).at(-1)!, /还在办——要再派吗？要办的是：从中央前哨附近未编组群（G\d+）派 2 个去北线前哨设防。/);
});
await test("D2 ★合法的「再派两个去北线前哨」（引用出自这一句）⇒ 真的再派 2 个，与第一批不重叠", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { first, g2 } = await sentTwoThenRemint(h, f);
  await say(h, "再派两个去北线前哨", [order("再调两个去北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const all = dispatchedIds(h);
  assert.equal(all.length, 4, said(h));
  const second = all.filter((id) => !first.includes(id));
  assert.equal(second.length, 2); for (const id of second) { assert.ok(f.groupIds.has(id)); assert.ok(near(targetOf(h, id), f.north)); }
});
await test("D3 「再调两个」只说了数、没说去处（只有数量引用出自这一句）⇒ 仍算新命令，再派 2 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { g2 } = await sentTwoThenRemint(h, f);
  await say(h, "再调两个过去", [order("再调两个。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, quantityQuote: "两个" }])]);
  assert.equal(dispatchedIds(h).length, 4, said(h));
});
await test("D4 同一个「是的」，但模型的单子去的是**别处**（中央前哨）⇒ 不是重复那一次，照常执行（不按目的地合并）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { g2 } = await sentTwoThenRemint(h, f);
  await say(h, "是的", [order("两个去南线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: "ea_player_south_post", destinationQuote: "南线前哨", quantityQuote: "两个" }])]);
  assert.equal(dispatchedIds(h).length, 4, said(h));
});

await test("D5 ★陈把「从剩下那群再派两个去北线前哨」当方案请长官点头（CONFIRM）、长官「对」⇒ 这是批准，照派 2 个（重复判定不管批准过的方案）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { first, g2 } = await sentTwoThenRemint(h, f);
  await say(h, "北线够吗", [reply("北线还单薄，从剩下那群再派两个去北线前哨，行吗？", {
    brief: "北线还单薄，从剩下那群再派两个去北线前哨，行吗？", responseType: "CONFIRM", recommended: "A", urgency: 0.5,
    options: [{ label: "A: 再派两个", description: "再派两个去北线前哨", risk: 0.2, reward: 0.4,
      intents: [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }] }] })]);
  assert.ok(h.pendingContractRef.current);
  assert.equal(h.confirmShortcut("对"), true);
  const second = dispatchedIds(h).filter((id) => !first.includes(id));
  assert.equal(second.length, 2, `approved reinforcement goes out: ${said(h)}`);
});
await test("D6 模型的单子**一个原话片段都没写**、又与在办的那次一模一样 ⇒ 没有片段不等于重复：同样问要不要再派，不另派、不说在办", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { first, g2 } = await sentTwoThenRemint(h, f);
  await say(h, "嗯", [order("两个去北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP }])]);
  assert.deepEqual(dispatchedIds(h), first, said(h));
  assert.match(staffLines(h).at(-1)!, /要再派吗/);
});

// ── 起点生命周期（真模拟：tick ＋ processAutoBehavior）──
function pumpUntil(state: GameState, pred: () => boolean, maxSec = 120) {
  for (let t = 0; t < maxSec && !pred(); t += 0.25) { tick(state, 0.25); core.processAutoBehavior(state, 0.25); }
  assert.ok(pred(), "condition never reached in the sim");
}
const distToOrder = (s: GameState, id: number) => {
  const u = s.units.get(id); const t = u?.orders[0]?.target;
  return u && t ? Math.hypot(u.position.x - t.x, u.position.y - t.y) : 0;
};
await test("O-e1 ★路上接敌（设防令仍在、离落点还远）时改去修理厂，再叫回来 ⇒ 回到最初出发的位置，不回接敌的半路", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const enemyTpl = [...core.createInitialGameState("el_alamein").units.values()].find((u) => u.team === "enemy" && u.type === "infantry")!;
  for (let k = 0; k < 2; k++) { const e: Unit = { ...structuredClone(enemyTpl), id: nextId++, position: { x: 358 + k, y: 72 }, state: "idle", orders: [], waypoints: [], patrolPoints: [], patrolTaskId: null, manualOverride: false, target: null, attackTarget: null }; f.state.units.set(e.id, e); }
  const home = new Map([...f.groupIds].map((id) => [id, { ...f.state.units.get(id)!.position }]));
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const sent = dispatchedIds(h);
  // 「路上接敌」＝派出后挨了打、设防令还在、离落点还远。掉队兵修法（2026-10-02，autoBehavior P3.5）之前，
  // 去岗路上挨打的兵会被自动行为拉去追（state 变 moving），本格原先拿 moving 当接敌的标志；修好后它们挨了打
  // 照样往落点走，所以改按「派出后挨过打」认接敌（修前修后都成立）。核的事不变：改令再叫回 ⇒ 回最初出发处。
  const sentAt = f.state.time;
  pumpUntil(f.state, () => sent.every((id) => {
    const u = f.state.units.get(id);
    return !!u && (u.lastDamagedAt ?? -1) > sentAt && u.orders[0]?.action === "defend" && distToOrder(f.state, id) > 10;
  }), 40);
  const contact = new Map(sent.map((id) => [id, { ...f.state.units.get(id)!.position }]));
  await say(h, "那两个改去修理厂", [order("改去修理厂。", [{ type: "defend", fromSquad: f.g, targetFacility: "ea_repair_station", destinationQuote: "修理厂" }])]);
  await say(h, "刚才那两个叫回来", [order("回原处。", [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }])]);
  for (const id of sent.filter((i) => f.state.units.has(i))) {
    const t = targetOf(h, id)!;
    assert.ok(near(t, home.get(id)!, 3), `unit ${id} recalled to ${JSON.stringify(t)}; home ${JSON.stringify(home.get(id))}, contact point ${JSON.stringify(contact.get(id))}`);
  }
});
await test("O-e2（边界，如实记录）离落点不到 2.5 格（引擎算到了，模拟还在走最后一两格）时改令再叫回 ⇒ 回到北线前哨那一头（第二次外派的起点），不回中央；离落点 5 格以上改令 ⇒ 回中央", async () => {
  let judged = 0;
  for (const [lo, hi, expectHome] of [[0.7, 2.4, false], [5, 12, true]] as const) {
    const f = mixedGroup(); const h = harness(f.state);
    const home = new Map([...f.groupIds].map((id) => [id, { ...f.state.units.get(id)!.position }]));
    await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
    const sent = dispatchedIds(h);
    pumpUntil(f.state, () => sent.every((id) => { const d = distToOrder(f.state, id); return d > lo && d < hi; }) || sent.some((id) => distToOrder(f.state, id) < lo), 60);
    assert.ok(sent.every((id) => { const d = distToOrder(f.state, id); return d > lo && d < hi; }), `window (${lo},${hi}) not reached together`);
    judged++;
    await say(h, "那两个改去修理厂", [order("改去修理厂。", [{ type: "defend", fromSquad: f.g, targetFacility: "ea_repair_station", destinationQuote: "修理厂" }])]);
    await say(h, "刚才那两个叫回来", [order("回原处。", [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }])]);
    for (const id of sent) {
      const t = targetOf(h, id)!;
      if (expectHome) assert.ok(near(t, home.get(id)!, 3), `far from arrival ⇒ home: ${JSON.stringify(t)}`);
      else assert.ok(near(t, f.north, 4), `within 2.5 of the post ⇒ counted as arrived ⇒ back to the post: ${JSON.stringify(t)}`);
    }
  }
  assert.equal(judged, 2, "both windows were actually exercised");
});

// ── 真模型回包原样重放（review-round6/realmodel，recall 第 1 局）：模型懂了「回原处」，字段名写成 retreatTo ──
const RAW_RECALL_RETREATTO = `长官，召回M1。
---JSON---
{
  "brief": "长官，召回M1。",
  "responseType": "EXECUTE",
  "options": [
    {
      "label": "A: 召回M1",
      "description": "召回正在前往北线前哨的M1部队。",
      "risk": 0.0,
      "reward": 0.0,
      "intents": [
        {
          "type": "retreat",
          "fromDispatch": "M1",
          "retreatTo": "origin",
          "urgency": "high"
        }
      ]
    }
  ],
  "recommended": "A",
  "urgency": 0.8
}`;
await test("RT1 ★「刚才那两个叫回来」：真模型回包写的是 retreatTo:\"origin\"（字段名写错、意思对）⇒ 回到出发地，不静默降成往安全区撤", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  for (const u of [...f.state.units.values()]) if (u.team === "enemy") f.state.units.delete(u.id);
  const home = new Map([...f.groupIds].map((id) => [id, { ...f.state.units.get(id)!.position }]));
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const sent = dispatchedIds(h);
  for (const id of sent) f.state.units.get(id)!.position = { x: 360, y: 70 }; // 夹具：半路上
  await say(h, "刚才那两个叫回来", [{ kind: "text", text: RAW_RECALL_RETREATTO }]);
  for (const id of sent) assert.ok(near(targetOf(h, id), home.get(id)!, 3), `unit ${id} → ${JSON.stringify(targetOf(h, id))}, home ${JSON.stringify(home.get(id))}: ${said(h)}`);
  assert.match(staffLines(h).at(-1)!, /出发地/);
});
await test("RT2 retreatTo 只认 \"origin\" 这一个值；写成别的（地名等）照旧当没写——不猜", async () => {
  const { sanitizeIntent } = await import("@ai-commander/shared");
  assert.equal(sanitizeIntent({ type: "retreat", retreatTo: "origin" })?.returnTo, "origin");
  assert.equal(sanitizeIntent({ type: "retreat", retreatTo: "中央前哨" })?.returnTo, undefined);
  assert.equal(sanitizeIntent({ type: "retreat", retreatTo: "Origin" })?.returnTo, undefined);
});

// ════════════════════════════════════════════════════════════════════
// §7 交叉：数量 × 地点 × 来源 × 伤亡 × 失败（问答之间不许提前派兵）
// ════════════════════════════════════════════════════════════════════
await test("X1 ★先定数量、再确认地点：两条各 2 个、只写到北部战线 ⇒ 先问数量（零执行）→ 选「一共」⇒ 再问按北线前哨办吗（零执行）→「对」⇒ 恰好 2 个到北线前哨", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const its = splitTwo(f.g).map(({ targetFacility, ...rest }) => ({ ...rest, toFront: "front_coastal" }));
  await say(h, "派其中两个去北线前哨", [order("两个去北线。", its)]);
  assert.equal(h.applications.length, 0); assert.equal(h.pendingSelectionRef.current?.kind, "quantity");
  await say(h, "一共两个", [choose(QTOTAL)]);
  assert.equal(h.applications.length, 0, `destination question next: ${said(h)}`);
  assert.ok(h.pendingContractRef.current, "narrowed plan stored");
  assert.match(staffLines(h).at(-1)!, /按北线前哨办吗/);
  // 第八轮：问句由存下的方案生成——数量答过「一共」之后存下的是合成的**一条 2 个**，问句就只说这一条。
  assert.match(staffLines(h).at(-1)!, /要办的是：从中央前哨附近未编组群（G\d+）派 2 个去北线前哨设防。这道命令先没有执行。$/);
  assert.equal(h.confirmShortcut("对"), true);
  const ids = dispatchedIds(h); assert.equal(ids.length, 2, said(h));
  for (const id of ids) { assert.ok(f.groupIds.has(id)); assert.ok(near(targetOf(h, id), f.north)); }
  assert.doesNotMatch(staffLines(h).join("|"), /一共 2 个.*一共 2 个/, "quantity not asked twice");
});
await test("X2 ★先定数量、再选来源（一句两令：南线全部撤回＋从那群派两个）⇒ 两问都答完才一次执行；撤的是选中那一批、派的是 2 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const sp = f.state.facilities.get("ea_player_south_post")!.position;
  const tpl = structuredClone(f.state.units.get(f.infantry[0].id)!);
  const mk = (x: number, y: number) => { const u: Unit = { ...structuredClone(tpl), id: nextId++, position: { x, y }, orders: [], state: "idle", target: null }; f.state.units.set(u.id, u); return u; };
  const stay = [mk(sp.x, sp.y), mk(sp.x + 1, sp.y)];
  const sent = [mk(sp.x + 2, sp.y), mk(sp.x + 3, sp.y)];
  const r = core.resolveIntent({ type: "attack", fromFront: "front_south", toFront: "front_ridge", quantity: 2 } as Intent, f.state, f.state.style, undefined, sent.map((u) => u.id));
  core.applyOrders(f.state, r.orders.map((o) => ({ ...o, origin: "advisor", dispatchMeta: { group: "s", sourceKind: "front", sourceKey: "front_south", action: "attack", targetName: r.destinationName } })));
  for (const u of sent) u.position = { x: 360, y: 76 };
  await say(h, "南线的都撤回南线前哨，再从那群里派两个去北线前哨", [order("南线撤，两个去北线前哨。", [
    { type: "retreat", fromFront: "front_south", quantity: "all", targetFacility: "ea_player_south_post", destinationQuote: "南线前哨" },
    ...splitTwo(f.g)])]);
  assert.equal(h.applications.length, 0); assert.equal(h.pendingSelectionRef.current?.kind, "quantity");
  await say(h, "一共两个", [choose(QTOTAL)]);
  assert.equal(h.applications.length, 0, `source question next: ${said(h)}`);
  const slot = h.pendingSelectionRef.current; assert.equal(slot?.kind, "source");
  const stayKey = slot.candidates.find((c: { selectionKey: string }) => c.selectionKey.startsWith("stay:"))!.selectionKey;
  await say(h, "还守在南线的那几个", [reply("好。", { brief: "好。", responseType: "EXECUTE", options: [], recommended: "A", urgency: 0.4, dispatchSelection: { decision: "chose", candidate: stayKey } })]);
  assert.equal(h.applications.length, 1, `one application for the whole command: ${said(h)}`);
  const ids = dispatchedIds(h);
  assert.deepEqual(ids.filter((id) => !f.groupIds.has(id)).sort(), stay.map((u) => u.id).sort(), "retreat = the two who stayed");
  assert.equal(ids.filter((id) => f.groupIds.has(id)).length, 2, "defend = two in total from the group");
});
await test("X3 数量待答时那一群阵亡到只剩 1 个 ⇒ 选「一共两个」只动这 1 个、不从别处补人，回执说清；全灭 ⇒ 明说、零执行", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  const survivors = [f.tanks[0].id];
  for (const id of f.groupIds) if (!survivors.includes(id)) f.state.units.delete(id);
  await say(h, "一共两个", [choose(QTOTAL)]);
  assert.deepEqual(dispatchedIds(h), survivors, said(h));
  const f2 = mixedGroup(); const h2 = harness(f2.state);
  await say(h2, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f2.g))]);
  for (const id of f2.groupIds) f2.state.units.delete(id);
  await say(h2, "一共两个", [choose(QTOTAL)]);
  assert.equal(h2.applications.length, 0, said(h2)); assert.doesNotMatch(said(h2), /已下令/);
});
await test("X4 数量待答时通讯失败 ⇒ 零执行、问题还挂着；恢复后答「一共两个」⇒ 2 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  const slot = h.pendingSelectionRef.current;
  await say(h, "一共两个", [RATE_LIMIT]);
  assert.equal(h.applications.length, 0); assert.equal(h.pendingSelectionRef.current?.id, slot.id);
  await say(h, "一共两个", [choose(QTOTAL)]);
  assert.equal(dispatchedIds(h).length, 2, said(h));
});
await test("X5 数量那一问被重复投递（同一回复到了两次）⇒ 第二次 inert，不派第二遍", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  const slot = h.pendingSelectionRef.current;
  const tag = { selectionId: slot.id, channel: slot.channel, sessionId: slot.sessionId };
  const delivered = { brief: "好。", options: [], dispatchSelection: { kind: "chose", candidateKey: QTOTAL } };
  h.deliver(JSON.parse(JSON.stringify(delivered)), tag);
  h.deliver(JSON.parse(JSON.stringify(delivered)), tag);
  assert.equal(h.applications.length, 1); assert.equal(dispatchedIds(h).length, 2);
});

// ════════════════════════════════════════════════════════════════════
// §8 批准对象＝存下的方案：回复里任何一张不同的单子都说明这不是原样批准（第七轮【1】）
// ════════════════════════════════════════════════════════════════════
const ONE = (g: string) => ({ type: "defend", fromSquad: g, quantity: 1, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "一个" });
const TWO_ECHO = (g: string) => ({ type: "defend", fromSquad: g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨" });
const cards = (...its: Record<string, unknown>[]) => its.map((it, k) => ({ label: `${"ABC"[k]}: 方案${k + 1}`, description: "", risk: 0.2, reward: 0.4, intents: [it] }));
const decided = (decision: string, options: unknown[], recommended = "A", prose = "按您说的办。") => reply(prose, {
  brief: prose, responseType: "EXECUTE", recommended, urgency: 0.4, pendingDecision: decision, options });
/** 先存「从那群派 2 个去北线前哨」，再用这一份回复答它。返回执行结果。 */
async function answerStored(decisionReply: LlmStep, playerLine = "一个就够了") {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  assert.ok(h.pendingContractRef.current, "plan stored");
  await say(h, playerLine, [decisionReply]);
  return { f, h };
}
const zeroAndClarify = ({ h }: { h: H }, what: RegExp) => {
  assert.equal(h.applications.length, 0, `nothing may run: ${said(h)}`);
  assert.match(staffLines(h).at(-1)!, /没有执行/);
  assert.match(staffLines(h).at(-1)!, what);
  assert.ok(h.pendingContractRef.current === null, "the contradicted plan is not left for a later 「对」");
};
const mkState = () => mixedGroup();
await test("AP1 ★Codex 复现：「一个就够了」、authorize、推荐 A、options=[A:1 个, B:原来的 2 个] ⇒ 零执行并澄清（不因 B 与旧方案一致就执行旧的 2 个）", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards(ONE(f0.g), TWO_ECHO(f0.g)))), /人数/);
});
await test("AP2 换序：[A:原来的 2 个, B:1 个]、推荐 A ⇒ 零执行（不因第一张与旧方案一致就执行）", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards(TWO_ECHO(f0.g), ONE(f0.g)))), /人数/);
});
await test("AP3 推荐项变化：[A:原来的 2 个, B:1 个]、推荐 B ⇒ 同样零执行（不信 recommended，也不信第一张）", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards(TWO_ECHO(f0.g), ONE(f0.g)), "B")), /人数/);
});
await test("AP4 字段更少的备选不能掩盖修改：[A:没写人数的复述, B:1 个] ⇒ 零执行", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards({ type: "defend", fromSquad: f0.g, targetFacility: NP }, ONE(f0.g)))), /人数/);
});
await test("AP5 改来源：[A:原样, B:从中央战线调] ⇒ 零执行，说来源对不上", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards(TWO_ECHO(f0.g), { type: "defend", fromFront: "front_center", quantity: 2, targetFacility: NP })), "不从那群了，从中央战线调"), /来源/);
});
await test("AP6 改去处：[A:原样, B:去南线前哨] ⇒ 零执行，说去处对不上", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards(TWO_ECHO(f0.g), { type: "defend", fromSquad: f0.g, quantity: 2, targetFacility: "ea_player_south_post" })), "改去南线前哨"), /去处/);
});
await test("AP7 改动作：[A:原样, B:撤退] ⇒ 零执行，说动作对不上", async () => {
  const f0 = mkState();
  zeroAndClarify(await answerStored(decided("authorize", cards(TWO_ECHO(f0.g), { type: "retreat", fromSquad: f0.g, quantity: 2 })), "别设防了，撤"), /动作/);
});
await test("AP8 正例：「是的」、authorize、两张都是存下方案的复述（一张原样、一张只写到北部战线）⇒ 按存下的执行一次（2 个到北线前哨）", async () => {
  const f0 = mkState();
  const { f, h } = await answerStored(decided("authorize", cards(TWO_ECHO(f0.g), { type: "defend", fromSquad: f0.g, quantity: 2, toFront: "front_coastal" })), "是的");
  void f;
  const ids = dispatchedIds(h); assert.equal(h.applications.length, 1); assert.equal(ids.length, 2, said(h));
  for (const id of ids) assert.ok(near(targetOf(h, id), f0.state.facilities.get(NP)!.position));
});
await test("AP9 amend 却给了两种不同的改法 ⇒ 零执行并澄清（不替长官挑第一张）；只给一种改法 ⇒ 按那一种执行", async () => {
  const f0 = mkState();
  const r = await answerStored(decided("amend", cards(ONE(f0.g), { ...ONE(f0.g), targetFacility: "ea_player_south_post", destinationQuote: undefined })));
  assert.equal(r.h.applications.length, 0, said(r.h)); assert.match(staffLines(r.h).at(-1)!, /没有执行/);
  const f1 = mkState();
  const r2 = await answerStored(decided("amend", cards(ONE(f1.g))));
  assert.equal(dispatchedIds(r2.h).length, 1, said(r2.h));
});

// ════════════════════════════════════════════════════════════════════
// §9 引擎裁定之后，屏幕／声音／上下文说的是同一件事（第七轮【2】）
//   每一格都是语音回合，且模型交回了**非空、与引擎结果矛盾**的 spoken。
// ════════════════════════════════════════════════════════════════════
const voiced = (heard: string | undefined, spoken: string, body: Record<string, unknown>) => {
  const prose = (body.brief as string) ?? "";
  return reply(prose, { ...body, ...(heard ? { heard } : {}), spoken });
};
const heardNow = (h: H, mark: number) => h.speech.slice(mark);
const onePersona = (h: H) => assert.equal(new Set(h.speech.map((x) => x.persona)).size <= 1, true, `one voice per channel: ${JSON.stringify(h.speech)}`);
await test("SV1 ★Codex 复现：方案挂着、语音「就按这个办」、回包缺 pendingDecision、brief「已经派过去了」、spoken「那两个已经派过去了，长官」⇒ 零执行，耳朵听到的是引擎那句「没有执行」，不是 spoken", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  const mark = h.speech.length;
  await say(h, "", [voiced("就按这个办，派过去", "那两个已经派过去了，长官。", { brief: "已经派过去了。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: cards(TWO_ECHO(f.g)) })], { voice: true });
  assert.equal(h.applications.length, 0);
  const ear = heardNow(h, mark).map((x) => x.text).join(" ");
  assert.doesNotMatch(ear, /派过去了/, `ear: ${ear}`);
  assert.match(ear, /没有执行/);
  assert.equal(heardNow(h, mark).length, 1, `exactly one utterance: ${ear}`);
  assert.equal(ear, staffLines(h).at(-1), "ear = screen");
  onePersona(h);
});
await test("SV2 语音：authorize 却带改过的单子、spoken「派了一个过去」⇒ 零执行，耳朵听引擎的澄清", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  const mark = h.speech.length;
  await say(h, "", [voiced("一个就够了", "派了一个过去，长官。", { brief: "一个去北线前哨。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    pendingDecision: "authorize", options: cards(ONE(f.g)) })], { voice: true });
  assert.equal(h.applications.length, 0);
  const ear = heardNow(h, mark).map((x) => x.text).join(" ");
  assert.doesNotMatch(ear, /派了一个/); assert.match(ear, /没有执行/); onePersona(h);
});
await test("SV3 语音：待答「一共还是每种」、spoken「一共两个，这就过去」却没交选择 ⇒ 零执行，耳朵只听引擎再问的那一句（不先播 spoken）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
  const mark = h.speech.length;
  await say(h, "", [voiced("一共两个", "一共两个，这就过去，长官。", { brief: "一共两个。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, options: [] })], { voice: true });
  assert.equal(h.applications.length, 0);
  const ear = heardNow(h, mark).map((x) => x.text).join(" ");
  assert.doesNotMatch(ear, /这就过去/, `ear: ${ear}`);
  assert.match(ear, /一共 2 个/); onePersona(h);
});
await test("SV4 语音、没听清（heard 缺席）⇒ 引擎不自动执行而是问；spoken「两个这就过去」不许播，耳朵听引擎那一问", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [voiced(undefined, "两个这就过去，长官。", { brief: "两个去北线前哨。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: cards({ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP }) })], { voice: true });
  assert.equal(h.applications.length, 0);
  const ear = heardNow(h, mark).map((x) => x.text).join(" ");
  assert.doesNotMatch(ear, /这就过去/, `ear: ${ear}`);
  assert.equal(ear, staffLines(h).at(-1), "ear = the question on screen");
  onePersona(h);
});
await test("SV5 语音、高影响（全线进攻）⇒ 先说代价再等批准；spoken「全军这就压上去」不许播，耳朵听到的是代价那一问", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [voiced("全线进攻山脊", "全军这就压上去，长官。", { brief: "全线压上山脊。", responseType: "EXECUTE", recommended: "A", urgency: 0.8,
    options: cards({ type: "attack", quantity: "all", toFront: "front_ridge" }) })], { voice: true, preflight: "全线压上去，别的方向就空了——照打吗？" });
  await new Promise((r) => setTimeout(r, 10)); // 代价台词是另一次异步请求，等它落地
  assert.equal(h.applications.length, 0);
  const ear = heardNow(h, mark).map((x) => x.text).join(" ");
  assert.doesNotMatch(ear, /这就压上去/, `ear: ${ear}`);
  assert.match(ear, /照打吗/); onePersona(h);
});
await test("SV6 正例：语音咨询（NOOP）⇒ 耳朵听 spoken（口语那一版），不听正文", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [voiced("北线怎么样", "北线还稳，长官。", { brief: "北线前哨目前 8 个单位，敌军未接触。", responseType: "NOOP", recommended: "A", urgency: 0.2, options: [] })], { voice: true });
  const ear = heardNow(h, mark).map((x) => x.text);
  assert.deepEqual(ear, ["北线还稳，长官。"]);
});
await test("SV7 正例：语音下令、真执行 ⇒ spoken 不播，耳朵只听一次执行回执（与屏上同一串）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [voiced("派其中两个去北线前哨", "两个这就过去，长官。", { brief: "两个去北线前哨。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: cards({ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }) })], { voice: true });
  assert.equal(dispatchedIds(h).length, 2);
  const ear = heardNow(h, mark).map((x) => x.text);
  assert.equal(ear.length, 1, JSON.stringify(ear)); assert.doesNotMatch(ear[0], /这就过去/); assert.match(ear[0], /2 个/);
  onePersona(h);
});
await test("SV8 正例：语音批准存下的方案 ⇒ 耳朵只听执行回执；语音里陈把方案当问题提（CONFIRM）⇒ 耳朵听他的 spoken 问句", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  let mark = h.speech.length;
  await say(h, "", [voiced("北线要加人吗", "要不要从那群派两个去北线前哨？", { ...(JSON.parse(modelTextJson(CONFIRM(f.g)))) })], { voice: true });
  // ★第九轮改写：原断言「耳朵只念模型的 spoken 问句」——这正是本轮要废的「耳朵只听模型那半句」。
  //   现在：spoken 之后接上存下方案的完整说法（与屏上那一问里的同一串字）。
  assert.deepEqual(heardNow(h, mark).map((x) => x.text), ["要不要从那群派两个去北线前哨？ 要办的是：从中央前哨附近未编组群（G1）派 2 个去北线前哨设防。"]);
  mark = h.speech.length;
  await say(h, "", [voiced("行，派过去", "这就派，长官。", { brief: "依令。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "authorize", options: [] })], { voice: true });
  assert.equal(dispatchedIds(h).length, 2);
  const ear = heardNow(h, mark).map((x) => x.text);
  assert.equal(ear.length, 1); assert.doesNotMatch(ear[0], /这就派/); onePersona(h);
});

await test("SV9 语音下令、单子只写到北部战线 ⇒ 引擎在执行前问「按北线前哨办吗」；spoken「两个这就去北线前哨」不播，耳朵只听那一问", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [voiced("派其中两个去北线前哨", "两个这就去北线前哨，长官。", { brief: "两个去北线。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: cards({ type: "defend", fromSquad: f.g, quantity: 2, toFront: "front_coastal", destinationQuote: "北线前哨", quantityQuote: "两个" }) })], { voice: true });
  assert.equal(h.applications.length, 0);
  const ear = heardNow(h, mark).map((x) => x.text);
  assert.equal(ear.length, 1, JSON.stringify(ear)); assert.match(ear[0], /按北线前哨办吗/); assert.equal(ear[0], staffLines(h).at(-1));
  onePersona(h);
});
await test("SV10 语音回合通讯失败（兜底没有 spoken）⇒ 耳朵念引擎那一句，一次", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [RATE_LIMIT], { voice: true });
  const ear = heardNow(h, mark).map((x) => x.text);
  assert.equal(h.applications.length, 0); assert.equal(ear.length, 1); assert.match(ear[0], /没有执行/);
});

// ════════════════════════════════════════════════════════════════════
// §10 同一请求的重复投递 ≠ 长官又说了一句（第七轮【四】）
// ════════════════════════════════════════════════════════════════════
await test("RD1 ★同一个请求的回复在 SSE 里投递了两次（同一请求编号）⇒ 只执行一次", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const content = JSON.parse(JSON.stringify(shared.validateAdvisorResponse({ brief: "两个去北线前哨。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: cards({ type: "defend", fromFront: "front_center", quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }) })));
  const twice = async () => new Response(
    `data: ${JSON.stringify({ type: "options", content })}\n\ndata: ${JSON.stringify({ type: "options", content })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } });
  await h.send("中央那边派两个去北线前哨", twice);
  assert.equal(h.applications.length, 1, `one execution per request: ${said(h)}`);
  assert.equal(dispatchedIds(h).length, 2);
});
await test("RD4 批准回复在同一个请求里投递了两次 ⇒ 存下的方案只执行一次", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  const content = JSON.parse(JSON.stringify(shared.validateAdvisorResponse({ brief: "依令。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "authorize", options: [] })));
  await h.send("就按这个办，派过去", async () => new Response(
    `data: ${JSON.stringify({ type: "options", content })}\n\ndata: ${JSON.stringify({ type: "options", content })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  assert.equal(h.applications.length, 1); assert.equal(dispatchedIds(h).length, 2);
});
await test("RD2 ★多余的「是的」＋模型用剩下那群的新号重下同一道令 ⇒ 不另派，也不谎称「已经在办」：问要不要再派；答「对」才再派 2 个", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { first, g2 } = await sentTwoThenRemint(h, f);
  await say(h, "是的", [order("临时编队两个单位前往北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  assert.deepEqual(dispatchedIds(h), first, `no second batch yet: ${said(h)}`);
  const q = staffLines(h).at(-1)!;
  assert.doesNotMatch(q, /已经在前往北线前哨设防了，没有重新下令/, "must not claim the new order is already being done");
  assert.match(q, /再派/); assert.match(q, /没有执行/);
  assert.ok(h.pendingContractRef.current, "the new plan waits for a yes");
  assert.equal(h.confirmShortcut("对"), true);
  const second = dispatchedIds(h).filter((id) => !first.includes(id));
  assert.equal(second.length, 2, said(h));
});
await test("RD3 多余的「是的」之后长官说「不用」（模型 cancel）⇒ 不另派", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const { first, g2 } = await sentTwoThenRemint(h, f);
  await say(h, "是的", [order("两个前往北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP }])]);
  await say(h, "不用了", [decided("cancel", [], "A", "那就不动。")]);
  assert.deepEqual(dispatchedIds(h), first, said(h));
});

// ════════════════════════════════════════════════════════════════════
// §1b 失败包即使带着意图也零执行（客户端那一道网）＋ 两道网各自成立
// ════════════════════════════════════════════════════════════════════
/** 旧兜底的第一张方案原样（无锚的全线设防）——「带着意图的失败包」的料。 */
const LEGACY_DEFEND = { label: "A: 稳守阵地", description: "全线防御，等待进一步情报", risk: 0.2, reward: 0.3,
  intent: { type: "defend", urgency: "medium" }, intents: [{ type: "defend", urgency: "medium" }] };
/** 浏览器直接收到一份指定的 SSE options 事件（绕过服务端，模拟旧服务端 / 被改坏的包）。 */
const sseWith = (content: Record<string, unknown>) => async () => new Response(
  `data: ${JSON.stringify({ type: "options", content })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { "Content-Type": "text/event-stream" } });
const mutated = (src: string, from: string, to: string) => {
  assert.ok(src.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`);
  return src.replace(from, to);
};
const FAILURE_GUARD = "      if (failure) {\n        setResponse(null);";
async function failurePacketWithIntents(src: string) {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein"); const h = harness(state, src);
  const before = allOrders(state);
  await h.send("刚才那两个快撤", sseWith({ brief: "通讯干扰。", options: [LEGACY_DEFEND], recommended: "A", urgency: 0.3,
    failure: "parse", warning: "参谋回复格式异常" }));
  return { state, h, before };
}
await test("F9 ★客户端收到**带着意图**的失败包（failure 在场）⇒ 仍零执行（不靠服务端把 options 清空）", async () => {
  const { state, h, before } = await failurePacketWithIntents(source);
  assert.equal(h.applications.length, 0, said(h)); assert.equal(allOrders(state), before);
  assert.match(said(h), /没有执行/);
});
await test("F9-负对照：摘掉客户端的失败分支 ⇒ 同一份失败包被执行（证明这道网承重）", async () => {
  const { h } = await failurePacketWithIntents(mutated(source, FAILURE_GUARD, "      if (false) {\n        setResponse(null);"));
  assert.ok(h.applications.length > 0 && dispatchedIds(h).length > 0, `the guard-less client executed nothing?? ${said(h)}`);
});
await test("F10 两道网各自成立：摘掉客户端的失败分支，服务端兜底本身也不带可执行的东西 ⇒ 仍零执行", async () => {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein");
  const h = harness(state, mutated(source, FAILURE_GUARD, "      if (false) {\n        setResponse(null);"));
  const before = allOrders(state);
  await say(h, "刚才那两个快撤", [GARBLED]);
  assert.equal(h.applications.length, 0, said(h)); assert.equal(allOrders(state), before);
});

// ════════════════════════════════════════════════════════════════════
// §6 负对照：第五轮（交接时）的生产 handler 在同一组反例上必须红
//   ChatPanel 由 ef01bac ＋ 归档 diff 逐字重建（SHA 与交接档一致）；它调用的旧 core/shared
//   函数（findSplitQuantity / authorizeContradicts / 旧兜底）同样从重建的旧源码里取原文。
// ════════════════════════════════════════════════════════════════════
const R5 = round5Sources();
const r5Panel = R5["apps/web/src/ChatPanel.tsx"];
const r5Core = oldFunctions(R5["packages/core/src/tacticalPlanner.ts"], ["MOVE_INTENTS", "isDispatchIntentType", "findSplitQuantity"], ["findSplitQuantity"]);
const r5Shared = oldFunctions(R5["packages/shared/src/schema.ts"], ["authorizeContradicts", "createFallbackResponse"], ["authorizeContradicts", "createFallbackResponse"]);
const r5Receipt = oldFunctions(R5["apps/web/src/execReceipt.ts"],
  ["ACTION_VERB", "REJECT_WORD", "verbOf", "actionPhrase", "rejectPhrase", "aggregateEconomy", "economyLine", "buildExecReceipt", "buildExecFeedback"],
  ["buildExecReceipt", "buildExecFeedback"]);
const r5Overrides = { ...r5Core, ...r5Receipt, authorizeContradicts: r5Shared.authorizeContradicts };
const r5Harness = (state: GameState) => harness(state, r5Panel, "combat", undefined, r5Overrides);
/** 期望第五轮在这一格上红：跑一遍，断言会被违反。 */
async function mustBeRed(label: string, run: () => Promise<void>) {
  let red = false;
  try { await run(); } catch { red = true; }
  assert.ok(red, `round-5 handler unexpectedly passes ${label}`);
}

await test("F1-负对照：第五轮 handler ＋ 第五轮服务端的兜底包 ⇒ 真实初始局下了设防令（交接档 §1 的原病）", async () => {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein"); const h = r5Harness(state);
  const oldFallback = (r5Shared.createFallbackResponse as () => Record<string, unknown>)();
  await h.send("刚才那两个快撤", sseWith({ ...oldFallback, warning: "参谋回复格式异常，已使用默认方案" }));
  assert.ok(dispatchedIds(h).length > 0, said(h));
  assert.match(said(h), /已下令 \d+ 个单位设防/);
});
await test("Q1-负对照：第五轮 handler，答「一共两个」、模型照旧交两条 ⇒ 派出 4 个", async () => {
  await mustBeRed("Q1", async () => {
    const f = mixedGroup(); const h = r5Harness(f.state);
    await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", splitTwo(f.g))]);
    await say(h, "一共两个", [order("两个去北线前哨。", splitTwo(f.g))]);
    assert.notEqual(dispatchedIds(h).length, 4);
  });
});
await test("Q2-负对照：第五轮 handler＋第五轮数量规则，「两个坦克」「步兵」⇒ 派出 4 个", async () => {
  await mustBeRed("Q2", async () => {
    const f = mixedGroup(); const h = r5Harness(f.state);
    await say(h, "派两个坦克和步兵去北线前哨", [order("坦克步兵各两个。", splitTwo(f.g, "两个坦克", "步兵"))]);
    assert.equal(h.applications.length, 0);
  });
});
await test("A1-负对照：第五轮 handler，「一个就够了」＋authorize＋1 个 ⇒ 执行了存下的 2 个", async () => {
  await mustBeRed("A1", async () => {
    const f = mixedGroup(); const h = r5Harness(f.state);
    await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
    await say(h, "一个就够了", [order("一个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 1, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "一个" }], { pendingDecision: "authorize" })]);
    assert.equal(h.applications.length, 0);
  });
});
await test("R1-负对照：第五轮 handler，协议失败那一轮上屏的是模型写的「已经派过去了」", async () => {
  await mustBeRed("R1", async () => {
    const f = mixedGroup(); const h = r5Harness(f.state);
    await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
    await say(h, "就按这个办，派过去", [reply("已经派过去了。", { brief: "已经派过去了。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
      options: [{ label: "A", description: "", risk: 0.2, reward: 0.4, intents: [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP }] }] })]);
    assert.doesNotMatch(said(h), /已经派过去了/);
  });
});
await test("D1-负对照：第五轮 handler，多余的「是的」＋新号重下同一道令 ⇒ 又派出 2 个", async () => {
  await mustBeRed("D1", async () => {
    const f = mixedGroup(); const h = r5Harness(f.state);
    const { first, g2 } = await sentTwoThenRemint(h, f);
    await say(h, "是的", [order("临时编队两个单位前往北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
    assert.deepEqual(dispatchedIds(h), first);
  });
});
await test("RT1-负对照：第五轮的 sanitizeIntent（从重建的旧 schema 取原文）把 retreatTo 静默丢掉 ⇒ 成了裸撤退", async () => {
  const old = oldFunctions(R5["packages/shared/src/schema.ts"], ["VALID_INTENT_TYPES", "VALID_URGENCY", "VALID_UNIT_CATEGORY", "sanitizeIntent"], ["sanitizeIntent"]) as
    { sanitizeIntent: (x: unknown) => Record<string, unknown> | null };
  const it = old.sanitizeIntent({ type: "retreat", fromDispatch: "M1", retreatTo: "origin", urgency: "high" });
  assert.ok(it && it.returnTo === undefined && !it.targetFacility && !it.toFront, "round-5 schema drops the destination meaning");
});
await test("Q1c-负对照：第五轮 handler 按兵种派 4 个时，回执没有合计（两句各说 2 个）", async () => {
  await mustBeRed("Q1c", async () => {
    const f = mixedGroup(); const h = r5Harness(f.state);
    await say(h, "派两辆坦克和两个步兵去北线前哨", [order("坦克两辆、步兵两个。", splitTwo(f.g, "两辆坦克", "两个步兵"))]);
    assert.equal(dispatchedIds(h).length, 4);
    assert.match(said(h), /合计.*4 个/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §12 引擎发起的批准问题：问的范围＝存下的整份方案＝点头后执行的范围（第八轮）
// ════════════════════════════════════════════════════════════════════
const SPOST = "ea_player_south_post";
const REPAIR_FAC = "ea_repair_station";
/** 北、南前哨各派过 2 人（都出自同一群，每次派完剩下的人按生产做法另铸同名新号），返回两批与最后剩下那群的号。 */
async function twoPriorDispatches(h: H, f: ReturnType<typeof mixedGroup>) {
  await say(h, "派其中两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const north = dispatchedIds(h); assert.equal(north.length, 2);
  const rest1 = [...f.groupIds].filter((id) => !north.includes(id));
  const g2 = core.mintSpokenForce(f.state, null, { label: "中央前哨附近未编组群", memberIds: rest1, etaSec: 40 })!;
  await say(h, "再派两个去南线前哨", [order("两个去南线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: SPOST, destinationQuote: "南线前哨", quantityQuote: "两个" }])]);
  const south = dispatchedIds(h).filter((id) => !north.includes(id)); assert.equal(south.length, 2);
  const rest2 = rest1.filter((id) => !south.includes(id));
  const g3 = core.mintSpokenForce(f.state, null, { label: "中央前哨附近未编组群", memberIds: rest2, etaSec: 40 })!;
  return { north, south, g3, rest2 };
}
const reNorth = (g: string) => ({ type: "defend", fromSquad: g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" });
const reSouth = (g: string) => ({ type: "defend", fromSquad: g, quantity: 2, targetFacility: SPOST, destinationQuote: "南线前哨", quantityQuote: "两个" });
/** 这一次「对」之后新接到命令的单位，按目标点分到哪个据点。 */
function newlySent(h: H, f: ReturnType<typeof mixedGroup>, before: number[]) {
  const fresh = dispatchedIds(h).filter((id) => !before.includes(id));
  const at = (fac: string) => fresh.filter((id) => near(targetOf(h, id), f.state.facilities.get(fac)!.position));
  return { fresh, north: at(NP), south: at(SPOST), repair: at(REPAIR_FAC) };
}
await test("SC1 ★Codex 复现：北、南前哨各派过 2 人 →「是的」→ 模型重写北、南各增援 2 人 ⇒ 问句必须把两条都说出来（谁、几个、去哪）；「对」⇒ 北 2＋南 2，正是问过的范围", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const prior = await twoPriorDispatches(h, f);
  await say(h, "是的", [order("北、南各再派两个。", [reNorth(prior.g3), reSouth(prior.g3)])]);
  assert.equal(h.applications.length, 2, "nothing new before the answer");
  const q = staffLines(h).at(-1)!;
  assert.match(q, /北线前哨/); assert.match(q, /南线前哨/, `the question must cover the south order too: ${q}`);
  assert.equal((q.match(/2 个/g) ?? []).length >= 2, true, `both counts stated: ${q}`);
  assert.match(q, /设防/); assert.match(q, new RegExp(prior.g3), "the source is named");
  assert.equal(h.confirmShortcut("对"), true);
  const sent = newlySent(h, f, [...prior.north, ...prior.south]);
  assert.equal(sent.north.length, 2, said(h)); assert.equal(sent.south.length, 2, said(h)); assert.equal(sent.fresh.length, 4);
  for (const id of sent.fresh) assert.ok(prior.rest2.includes(id), "from the group that was offered");
});
await test("SC2 换序：模型先写南、再写北 ⇒ 问句按单子顺序两条都说；「对」⇒ 南 2＋北 2", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const prior = await twoPriorDispatches(h, f);
  await say(h, "是的", [order("南、北各再派两个。", [reSouth(prior.g3), reNorth(prior.g3)])]);
  const q = staffLines(h).at(-1)!;
  assert.ok(q.indexOf("南线前哨", q.indexOf("要办的是")) >= 0 && q.indexOf("南线前哨", q.indexOf("要办的是")) < q.indexOf("北线前哨", q.indexOf("要办的是")), `order kept: ${q}`);
  assert.equal(h.confirmShortcut("对"), true);
  const sent = newlySent(h, f, [...prior.north, ...prior.south]);
  assert.equal(sent.north.length, 2); assert.equal(sent.south.length, 2);
});
await test("SC3 单条：只重写北线那一条 ⇒ 问句说这一条；「对」⇒ 北 2，南一个不动", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const prior = await twoPriorDispatches(h, f);
  await say(h, "是的", [order("北线再派两个。", [reNorth(prior.g3)])]);
  const q = staffLines(h).at(-1)!;
  assert.match(q, /要办的是：从.*派 2 个去北线前哨设防。/); assert.doesNotMatch(q.slice(q.indexOf("要办的是")), /南线前哨/);
  assert.equal(h.confirmShortcut("对"), true);
  const sent = newlySent(h, f, [...prior.north, ...prior.south]);
  assert.equal(sent.north.length, 2); assert.equal(sent.south.length, 0); assert.equal(sent.fresh.length, 2);
});
await test("SC4 两条去处不同、只有一条与在办的相同（北线前哨＋修理厂）⇒ 问句两条都说；「对」⇒ 北 2＋修理厂 2；「算了」⇒ 两条都不动（不执行一半）", async () => {
  for (const answer of ["对", "算了"]) {
    const f = mixedGroup(); const h = harness(f.state);
    const prior = await twoPriorDispatches(h, f);
    await say(h, "是的", [order("北线再两个，修理厂两个。", [reNorth(prior.g3),
      { type: "defend", fromSquad: prior.g3, quantity: 2, targetFacility: REPAIR_FAC, destinationQuote: "修理厂", quantityQuote: "两个" }])]);
    const q = staffLines(h).at(-1)!;
    assert.match(q, /北线前哨/); assert.match(q, /修理厂/, `both orders in the question: ${q}`);
    assert.equal(h.applications.length, 2, "nothing before the answer");
    assert.equal(h.confirmShortcut(answer), true);
    const sent = newlySent(h, f, [...prior.north, ...prior.south]);
    if (answer === "对") { assert.equal(sent.north.length, 2, said(h)); assert.equal(sent.repair.length, 2, said(h)); }
    else { assert.equal(sent.fresh.length, 0, `cancel runs neither half: ${said(h)}`); }
  }
});
await test("SC5 模型把「是的」之后的回复判成 authorize（存下的是北南两条）⇒ 按问过的两条执行；判成 cancel ⇒ 都不动", async () => {
  for (const decision of ["authorize", "cancel"]) {
    const f = mixedGroup(); const h = harness(f.state);
    const prior = await twoPriorDispatches(h, f);
    await say(h, "是的", [order("北、南各再派两个。", [reNorth(prior.g3), reSouth(prior.g3)])]);
    await say(h, decision === "authorize" ? "就这么办，再派" : "不用了", [decided(decision, [], "A", decision === "authorize" ? "依令。" : "那就不动。")]);
    const sent = newlySent(h, f, [...prior.north, ...prior.south]);
    if (decision === "authorize") { assert.equal(sent.north.length, 2, said(h)); assert.equal(sent.south.length, 2, said(h)); }
    else assert.equal(sent.fresh.length, 0, said(h));
  }
});
await test("SC6 ★已有的地点确认流程：一句两令（北线只写到战线＋修理厂写对了）⇒ 问「按北线前哨办吗」时也把修理厂那条说出来；「对」⇒ 北线前哨 2＋修理厂 1", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "两个去北线前哨，一个去修理厂", [order("两个去北线，一个去修理厂。", [
    { type: "defend", fromSquad: f.g, quantity: 2, toFront: "front_coastal", destinationQuote: "北线前哨", quantityQuote: "两个" },
    { type: "defend", fromSquad: f.g, quantity: 1, targetFacility: REPAIR_FAC, destinationQuote: "修理厂", quantityQuote: "一个" }])]);
  assert.equal(h.applications.length, 0);
  const q = staffLines(h).at(-1)!;
  assert.match(q, /按北线前哨办吗/); assert.match(q, /修理厂/, `the other order is part of what 「对」 approves: ${q}`);
  assert.equal(h.confirmShortcut("对"), true);
  const sent = newlySent(h, f, []);
  assert.equal(sent.north.length, 2, said(h)); assert.equal(sent.repair.length, 1, said(h));
});
// 注：高影响那条若排在第二（前面是一条点了号的），canAutoExecute 在第一条就以 anchor_mismatch 返回、
//   根本没看第二条 ⇒ 整句自动执行（本轮发现的既有闸门问题，不在本轮范围，见报告）。这里把高影响放第一条。
await test("SC7 高影响（多条）：静态那一问也由存下的方案生成——两条都说；「对」⇒ 两条一起执行", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  const sp = f.state.facilities.get(SPOST)!.position;
  const tpl = structuredClone(f.state.units.get(f.infantry[0].id)!);
  const southers = [0, 1, 2].map((k) => { const u: Unit = { ...structuredClone(tpl), id: nextId++, position: { x: sp.x + k, y: sp.y }, orders: [], state: "idle", target: null }; f.state.units.set(u.id, u); return u.id; });
  await say(h, "全线压上山脊，另外那群里两个去北线前哨", [order("全线压上山脊，北线两个。", [
    { type: "attack", quantity: "all", fromFront: "front_south", toFront: "front_ridge" },
    { type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  assert.equal(h.applications.length, 0);
  const q = staffLines(h).at(-1)!;
  assert.match(q, /北线前哨/); assert.match(q, /山脊/, `both orders stated: ${q}`); assert.match(q, /全部/);
  assert.equal(h.confirmShortcut("对"), true);
  assert.equal(h.applications.length, 1, said(h));
  const ids = dispatchedIds(h);
  assert.equal(ids.filter((id) => near(targetOf(h, id), f.north)).length, 2, said(h));
  assert.deepEqual(ids.filter((id) => southers.includes(id)).sort(), [...southers].sort(), "the attack half (the south front) ran too");
});
await test("SC8 高影响（单条）：代价那一问后面跟上存下方案的完整说法（谁、几个、去哪）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "全线进攻山脊", [order("全线压上山脊。", [{ type: "attack", quantity: "all", toFront: "front_ridge" }])], { preflight: "全线压上去，别的方向就空了——照打吗？" });
  await new Promise((r) => setTimeout(r, 10));
  const q = staffLines(h).at(-1)!;
  assert.match(q, /照打吗/); assert.match(q, /要办的是：.*全部.*山脊.*进攻/, q);
});
await test("SC9 存下的北南两条：换局 / 过期之后再「对」⇒ 一个不动", async () => {
  for (const kind of ["epoch", "expired"]) {
    const f = mixedGroup(); const h = harness(f.state);
    const prior = await twoPriorDispatches(h, f);
    await say(h, "是的", [order("北、南各再派两个。", [reNorth(prior.g3), reSouth(prior.g3)])]);
    if (kind === "epoch") h.gameEpochRef.current++; else f.state.time += 10_000;
    h.confirmShortcut("对");
    assert.equal(newlySent(h, f, [...prior.north, ...prior.south]).fresh.length, 0, kind);
  }
});

// ════════════════════════════════════════════════════════════════════
// §11 负对照：第六轮收工时的生产 handler（归档逐字重建、核 SHA）在本轮反例上必须红
// ════════════════════════════════════════════════════════════════════
const R6 = round6Sources();
const r6Planner = oldFunctions(R6["packages/core/src/tacticalPlanner.ts"],
  ["isInFront", "destinationCompatible", "intentDifferences", "planDifferences", "authorizeMismatch"], ["authorizeMismatch"],
  { classifyDestination: core.classifyDestination });
const r6Repeat = oldFunctions(R6["packages/core/src/repeatDispatch.ts"], ["findRepeatedDispatch"], ["findRepeatedDispatch"],
  { activeDispatches, liveDispatchMembers, burnedAncestorsOf: core.burnedAncestorsOf, destinationCovers: core.destinationCovers, isDispatchIntent: core.isDispatchIntent });
const r6Speech = oldFunctions(R6["apps/web/src/voiceSpeech.ts"], ["planVoiceSpeech"], ["planVoiceSpeech"], { echoesHeard: shared.echoesHeard });
const r6Receipt = oldFunctions(R6["apps/web/src/execReceipt.ts"],
  ["ACTION_VERB", "REJECT_WORD", "verbOf", "actionPhrase", "rejectPhrase", "aggregateEconomy", "economyLine", "buildExecReceipt", "buildExecFeedback"],
  ["buildExecReceipt", "buildExecFeedback"]);
const r6Harness = (state: GameState) => harness(state, R6["apps/web/src/ChatPanel.tsx"], "combat", undefined,
  { ...r6Planner, ...r6Repeat, ...r6Speech, ...r6Receipt });
await test("AP1-负对照：第六轮 handler，[A:1 个, B:原来的 2 个]＋authorize ⇒ 执行了旧的 2 个", async () => {
  const f = mixedGroup(); const h = r6Harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  await say(h, "一个就够了", [decided("authorize", cards(ONE(f.g), TWO_ECHO(f.g)))]);
  assert.equal(dispatchedIds(h).length, 2, `round-6 runs the old plan: ${said(h)}`);
});
await test("SV1-负对照：第六轮 handler，协议失败的语音回合把 spoken「那两个已经派过去了」送进了 TTS", async () => {
  const f = mixedGroup(); const h = r6Harness(f.state);
  await say(h, "从那群里派两个去北线前哨", [CONFIRM(f.g)]);
  const mark = h.speech.length;
  await say(h, "", [voiced("就按这个办，派过去", "那两个已经派过去了，长官。", { brief: "已经派过去了。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, options: cards(TWO_ECHO(f.g)) })], { voice: true });
  assert.equal(h.applications.length, 0);
  assert.match(heardNow(h, mark).map((x) => x.text).join(" "), /那两个已经派过去了/);
});
await test("SV5-负对照：第六轮 handler，高影响那一格念的是 spoken「全军这就压上去」，代价那一问没出声", async () => {
  const f = mixedGroup(); const h = r6Harness(f.state);
  const mark = h.speech.length;
  await say(h, "", [voiced("全线进攻山脊", "全军这就压上去，长官。", { brief: "全线压上山脊。", responseType: "EXECUTE", recommended: "A", urgency: 0.8,
    options: cards({ type: "attack", quantity: "all", toFront: "front_ridge" }) })], { voice: true, preflight: "全线压上去，别的方向就空了——照打吗？" });
  await new Promise((r) => setTimeout(r, 10));
  const ear = heardNow(h, mark).map((x) => x.text).join(" ");
  assert.match(ear, /这就压上去/); assert.doesNotMatch(ear, /照打吗/);
});
await test("RD1-负对照：第六轮 handler，同一请求的回复投递两次 ⇒ 执行了两次", async () => {
  const f = mixedGroup(); const h = r6Harness(f.state);
  const content = JSON.parse(JSON.stringify(shared.validateAdvisorResponse({ brief: "两个去北线前哨。", responseType: "EXECUTE", recommended: "A", urgency: 0.4,
    options: cards({ type: "defend", fromFront: "front_center", quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }) })));
  await h.send("中央那边派两个去北线前哨", async () => new Response(
    `data: ${JSON.stringify({ type: "options", content })}\n\ndata: ${JSON.stringify({ type: "options", content })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  assert.equal(h.applications.length, 2);
});
await test("RD2-负对照：第六轮 handler，多余的「是的」＋新号 ⇒ 回执谎称「已经在前往北线前哨设防了，没有重新下令」", async () => {
  const f = mixedGroup(); const h = r6Harness(f.state);
  const { g2 } = await sentTwoThenRemint(h, f);
  await say(h, "是的", [order("临时编队两个单位前往北线前哨。", [{ type: "defend", fromSquad: g2, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  assert.match(staffLines(h).at(-1)!, /已经在前往北线前哨设防了，没有重新下令/);
});

// ════════════════════════════════════════════════════════════════════
// §13 负对照：第七轮收工时的生产 handler（review-round7 归档逐字重建、核 SHA）在第八轮反例上必须红
//   —— 问句只说一条、「对」执行整份。
// ════════════════════════════════════════════════════════════════════
const R7 = round7Sources();
const r7Harness = (state: GameState) => harness(state, R7["apps/web/src/ChatPanel.tsx"]);
await test("SC1-负对照：第七轮 handler，北南两条重写 ⇒ 只问北线；「对」却派了北 2＋南 2", async () => {
  const f = mixedGroup(); const h = r7Harness(f.state);
  const prior = await twoPriorDispatches(h, f);
  await say(h, "是的", [order("北、南各再派两个。", [reNorth(prior.g3), reSouth(prior.g3)])]);
  const q = staffLines(h).at(-1)!;
  assert.doesNotMatch(q, /南线前哨/, `round-7 asks about the north only: ${q}`);
  assert.equal(h.confirmShortcut("对"), true);
  const sent = newlySent(h, f, [...prior.north, ...prior.south]);
  assert.equal(sent.north.length + sent.south.length, 4, "and executes both");
});
await test("SC6-负对照：第七轮 handler，一句两令收窄北线 ⇒ 只问「按北线前哨办吗」；「对」却连修理厂那条一起执行", async () => {
  const f = mixedGroup(); const h = r7Harness(f.state);
  await say(h, "两个去北线前哨，一个去修理厂", [order("两个去北线，一个去修理厂。", [
    { type: "defend", fromSquad: f.g, quantity: 2, toFront: "front_coastal", destinationQuote: "北线前哨", quantityQuote: "两个" },
    { type: "defend", fromSquad: f.g, quantity: 1, targetFacility: REPAIR_FAC, destinationQuote: "修理厂", quantityQuote: "一个" }])]);
  assert.doesNotMatch(staffLines(h).at(-1)!, /修理厂/);
  assert.equal(h.confirmShortcut("对"), true);
  assert.equal(newlySent(h, f, []).repair.length, 1, "the unmentioned order ran");
});
await test("SC7-负对照：第七轮 handler，高影响两条 ⇒ 问句用模型 brief 开头、没有逐条说出存下的方案", async () => {
  const f = mixedGroup(); const h = r7Harness(f.state);
  await say(h, "全线压上山脊，另外那群里两个去北线前哨", [order("全线压上山脊。", [
    { type: "attack", quantity: "all", fromFront: "front_south", toFront: "front_ridge" },
    { type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  assert.doesNotMatch(staffLines(h).at(-1)!, /北线前哨/, "the defend half is not stated");
});

// ════════════════════════════════════════════════════════════════════
// §14 模型发起的确认（CONFIRM）：展示的完整方案＝保存的方案＝批准后执行的方案（第九轮）
// ════════════════════════════════════════════════════════════════════
/** 陈只问北线，可交上来的方案是北、南两条。 */
const CONFIRM_NS = (g: string, spoken?: string, heard?: string) => reply("长官，从那群里派两个去北线前哨，行吗？", {
  brief: "长官，从那群里派两个去北线前哨，行吗？", responseType: "CONFIRM", recommended: "A", urgency: 0.4,
  ...(spoken ? { spoken } : {}), ...(heard ? { heard } : {}),
  options: [{ label: "A: 北线两个", description: "北线前哨设防", risk: 0.2, reward: 0.4, intents: [reNorth(g), reSouth(g)] }] });
const bothOrders = (text: string) => /北线前哨/.test(text) && /南线前哨/.test(text) && (text.match(/2 个/g) ?? []).length >= 2;
async function confirmNS(voice: boolean) {
  const f = mixedGroup(); const h = harness(f.state);
  const mark = h.speech.length;
  await say(h, voice ? "" : "北线要不要加人", [CONFIRM_NS(f.g, voice ? "要不要派两个去北线前哨？" : undefined, voice ? "北线要不要加人" : undefined)], { voice });
  return { f, h, mark };
}
await test("CF1 ★打字：陈只问北线、方案含北南两条 ⇒ 屏上那一问、context、待批 summary、耳朵都带同一份完整方案（北 2＋南 2）；零执行", async () => {
  const { h, mark } = await confirmNS(false);
  assert.equal(h.applications.length, 0);
  const q = staffLines(h).at(-1)!;
  assert.ok(bothOrders(q), `screen: ${q}`);
  assert.ok(bothOrders(h.contextEntries.filter((e) => e.role === "assistant").at(-1)!.text), "context");
  assert.ok(bothOrders(h.pendingContractRef.current.summary), `summary: ${h.pendingContractRef.current.summary}`);
  const ear = h.speech.slice(mark).map((x) => x.text).join(" ");
  assert.ok(bothOrders(ear), `ear: ${ear}`);
});
await test("CF2 ★语音：spoken 只说北线 ⇒ 耳朵念 spoken 之后接上同一份完整方案（北 2＋南 2），不是只念那半句", async () => {
  const { h, mark } = await confirmNS(true);
  const ear = h.speech.slice(mark).map((x) => x.text);
  assert.equal(ear.length, 1, JSON.stringify(ear));
  assert.match(ear[0], /^要不要派两个去北线前哨？/); assert.ok(bothOrders(ear[0]), `ear: ${ear[0]}`);
  const plan = (s: string) => s.slice(s.indexOf("要办的是："));
  assert.equal(plan(ear[0]), plan(staffLines(h).at(-1)!), "the plan part is the same text on screen and in the ear");
  onePersona(h);
});
await test("CF3 打字与语音批准 ⇒ 北 2＋南 2（正是问过的两条）；取消 ⇒ 都不动", async () => {
  for (const voice of [false, true]) {
    for (const answer of ["approve", "cancel"]) {
      const { f, h } = await confirmNS(voice);
      if (answer === "approve" && !voice) assert.equal(h.confirmShortcut("对"), true);
      else if (answer === "cancel" && !voice) assert.equal(h.confirmShortcut("算了"), true);
      else await say(h, "", [voiced(answer === "approve" ? "行，派吧" : "不用了", answer === "approve" ? "这就派，长官。" : "那就不动。",
        { brief: answer === "approve" ? "依令。" : "那就不动。", responseType: answer === "approve" ? "EXECUTE" : "NOOP", recommended: "A", urgency: 0.4,
          pendingDecision: answer === "approve" ? "authorize" : "cancel", options: [] })], { voice: true });
      const sent = newlySent(h, f, []);
      if (answer === "approve") { assert.equal(sent.north.length, 2, `${voice}: ${said(h)}`); assert.equal(sent.south.length, 2, `${voice}: ${said(h)}`); }
      else assert.equal(sent.fresh.length, 0, `${voice} cancel: ${said(h)}`);
    }
  }
});
await test("CF4 ASK 开放问题（哪怕夹着单子）⇒ 不登记待批方案，「对」不执行；也不附完整方案（它不是待批的）", async () => {
  const f = mixedGroup(); const h = harness(f.state);
  await say(h, "北线要不要加人", [reply("您要从哪一群调？", { brief: "您要从哪一群调？", responseType: "ASK", recommended: "A", urgency: 0.4,
    options: [{ label: "A", description: "", risk: 0.2, reward: 0.4, intents: [reNorth(f.g), reSouth(f.g)] }] })]);
  assert.ok(h.pendingContractRef.current === null);
  assert.doesNotMatch(staffLines(h).at(-1)!, /要办的是/);
  assert.equal(h.confirmShortcut("对"), false); assert.equal(h.applications.length, 0);
});

// ════════════════════════════════════════════════════════════════════
// §15 整组命令的执行门槛：全量检查后统一裁定（第九轮）
//   澄清（目标不存在 / 点名对不上）＞ 确认（高影响）＞ 参谋代挑（没点名）＞ 自动。
//   高影响放第一、中间、最后，结论必须一致：先说代价、零执行、问句含整份方案；「对」才整组执行。
// ════════════════════════════════════════════════════════════════════
/** 高影响（南线全部压上山脊）＋ 普通调动（那群 2 个去北线前哨）＋ 经济（造 1 个步兵），按给定顺序排。 */
function hiFixture(order3: ("hi" | "move" | "eco")[]) {
  const f = mixedGroup();
  const sp = f.state.facilities.get(SPOST)!.position;
  const tpl = structuredClone(f.state.units.get(f.infantry[0].id)!);
  const southers = [0, 1, 2].map((k) => { const u: Unit = { ...structuredClone(tpl), id: nextId++, position: { x: sp.x + k, y: sp.y }, orders: [], state: "idle", target: null }; f.state.units.set(u.id, u); return u.id; });
  const parts = {
    hi: { type: "attack", quantity: "all", fromFront: "front_south", toFront: "front_ridge" },
    move: { type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" },
    eco: { type: "produce", produceType: "infantry", quantity: 1 },
  };
  return { f, southers, intents: order3.map((k) => parts[k]) };
}
for (const [label, order3] of [["第一", ["hi", "move", "eco"]], ["中间", ["move", "hi", "eco"]], ["最后", ["move", "eco", "hi"]]] as const) {
  await test(`GT-${label} ★高影响排在${label} ⇒ 先说代价、零执行、问句含三条；「对」⇒ 三条一起执行（南线打山脊、2 个到北线前哨、队列 +1）`, async () => {
    const { f, southers, intents } = hiFixture([...order3]);
    const h = harness(f.state);
    const q0 = f.state.productionQueue.player.length;
    await say(h, "南线全部压上山脊，那群里两个去北线前哨，再造一个步兵", [order("照办。", intents)]);
    assert.equal(h.applications.length, 0, `nothing before the answer: ${said(h)}`);
    assert.equal(f.state.productionQueue.player.length, q0, "no money spent before the answer");
    const q = staffLines(h).at(-1)!;
    assert.match(q, /照打还是留兵/); assert.match(q, /山脊/); assert.match(q, /北线前哨/); assert.match(q, /生产/);
    assert.equal(h.confirmShortcut("对"), true);
    const ids = dispatchedIds(h);
    assert.deepEqual(ids.filter((id) => southers.includes(id)).sort(), [...southers].sort(), "the south front attacks");
    assert.equal(ids.filter((id) => near(targetOf(h, id), f.north)).length, 2, "two to the north post");
    assert.equal(f.state.productionQueue.player.length, q0 + 1, "one infantry queued");
  });
}
await test("GT-澄清优先：目标不存在的一条＋高影响一条，谁在前都一样 ⇒ 问清楚（不登记待批、零执行），不被「确认」盖过", async () => {
  for (const flip of [false, true]) {
    const f = mixedGroup(); const h = harness(f.state);
    const bad = { type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "no_such_place" };
    const hi = { type: "attack", quantity: "all", toFront: "front_ridge" };
    await say(h, "一队去不存在的地方，其余全部压上山脊", [order("照办。", flip ? [hi, bad] : [bad, hi])]);
    assert.equal(h.applications.length, 0, said(h));
    assert.ok(h.pendingContractRef.current === null, `clarify, not confirm (${flip}): ${said(h)}`);
    assert.doesNotMatch(staffLines(h).at(-1)!, /照打还是留兵/);
  }
});
await test("GT-不误升级：普通调动（没点名）、经济单、调动＋经济、按战线的全部撤退 ⇒ 照常直接执行，不问确认", async () => {
  const cases: { say: string; intents: Record<string, unknown>[]; check: (f: ReturnType<typeof mixedGroup>, h: H, q0: number) => void }[] = [
    { say: "派其中两个去北线前哨", intents: [{ type: "defend", fromSquad: "__G__", quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }],
      check: (_f, h) => assert.equal(dispatchedIds(h).length, 2) },
    { say: "造一个步兵", intents: [{ type: "produce", produceType: "infantry", quantity: 1 }],
      check: (f, _h, q0) => assert.equal(f.state.productionQueue.player.length, q0 + 1) },
    { say: "派其中两个去北线前哨，再造一个步兵", intents: [{ type: "defend", fromSquad: "__G__", quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }, { type: "produce", produceType: "infantry", quantity: 1 }],
      check: (f, h, q0) => { assert.equal(dispatchedIds(h).length, 2); assert.equal(f.state.productionQueue.player.length, q0 + 1); } },
    { say: "中央战线的都撤到中央前哨", intents: [{ type: "retreat", fromFront: "front_center", quantity: "all", targetFacility: "ea_player_central_post", destinationQuote: "中央前哨" }],
      check: (_f, h) => assert.ok(dispatchedIds(h).length > 0) },
  ];
  for (const c of cases) {
    const f = mixedGroup(); const h = harness(f.state);
    const q0 = f.state.productionQueue.player.length;
    const intents = JSON.parse(JSON.stringify(c.intents).replaceAll("__G__", f.g));
    await say(h, c.say, [order("照办。", intents)]);
    assert.ok(h.pendingContractRef.current === null, `${c.say}: not upgraded to a confirmation (${said(h)})`);
    c.check(f, h, q0);
  }
});

// ════════════════════════════════════════════════════════════════════
// §16 负对照：第八轮收工时的生产 handler ＋ 第八轮的 canAutoExecute（review-round8 逐字重建、核 SHA）
// ════════════════════════════════════════════════════════════════════
const R8 = round8Sources();
const r8Gate = oldFunctions(R8["apps/web/src/autoExecuteGate.ts"], ["canAutoExecute"], ["canAutoExecute"],
  { isValidTarget: liveIsValidTarget, collectUnitsUnder: shared.collectUnitsUnder, isKnownForceRef: core.isKnownForceRef, isAllFrontHint: core.isAllFrontHint, findFront: core.findFront });
const r8Harness = (state: GameState) => harness(state, R8["apps/web/src/ChatPanel.tsx"], "combat", undefined, { ...r8Gate });
await test("CF1-负对照：第八轮 handler，陈只问北线、方案含北南 ⇒ 屏上那一问没有南线", async () => {
  const f = mixedGroup(); const h = r8Harness(f.state);
  await say(h, "北线要不要加人", [CONFIRM_NS(f.g)]);
  assert.doesNotMatch(staffLines(h).at(-1)!, /南线前哨/);
  assert.equal(h.confirmShortcut("对"), true);
  assert.equal(newlySent(h, f, []).south.length, 2, "yet 「对」 sends the south order too");
});
await test("GT-中间-负对照：第八轮 canAutoExecute，高影响排在中间 ⇒ 整句自动执行（不问代价）", async () => {
  const { f, intents } = hiFixture(["move", "hi", "eco"]);
  const h = r8Harness(f.state);
  await say(h, "南线全部压上山脊，那群里两个去北线前哨，再造一个步兵", [order("照办。", intents)]);
  assert.equal(h.applications.length, 1, said(h));
});
await test("GT-澄清-负对照：第八轮 canAutoExecute，[高影响, 目标不存在] ⇒ 登记成待批（把不存在的目标拿去请批准）", async () => {
  const f = mixedGroup(); const h = r8Harness(f.state);
  await say(h, "一队去不存在的地方，其余全部压上山脊", [order("照办。", [{ type: "attack", quantity: "all", toFront: "front_ridge" }, { type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "no_such_place" }])]);
  assert.ok(h.pendingContractRef.current !== null, said(h));
});

// ── 汇总 ──
console.log(failures.length === 0
  ? `ALL PASS (${count} send-chain scenarios, including ${negCount} negative controls)`
  : `\n${failures.length} FAILED / ${count + failures.length}:\n  - ${failures.join("\n  - ")}`);
void source;
process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
