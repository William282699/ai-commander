/**
 * 连续消歧生产链接线探针。运行：node --import tsx scripts/probe-selection-chain.ts
 *
 * 从 ChatPanel AST 提取原函数（不复制执行逻辑），仅替换 React/UI/TTS I/O。
 * 选兵、权限、G 票、解析、applyOrders、回执均调用生产实现；核实际下令 ID。
 * 这是确定性 handler 测试，不冒充浏览器、真 LLM 或真实音频播放测试。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import * as core from "@ai-commander/core";
import * as shared from "@ai-commander/shared";
import type { GameState, Intent, AdvisorOption, Unit, Order } from "@ai-commander/shared";
import { buildExecFeedback } from "../apps/web/src/execReceipt";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { source, overTheWire, harness } from "./chainHarness";
import { tick } from "../packages/core/src/sim";

let nextId = 9000;
function fixture() {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein");
  const template = structuredClone([...state.units.values()].find(u => u.team === "player" && u.type === "infantry")!);
  state.units.clear(); state.squads = []; state.missions = []; state.dispatches = [];
  const add = (x: number, y: number) => {
    const u: Unit = { ...structuredClone(template), id: nextId++, position: { x, y },
      state: "idle", orders: [], waypoints: [], patrolPoints: [], patrolTaskId: null,
      manualOverride: false, target: null, attackTarget: null };
    state.units.set(u.id, u); return u;
  };
  const split = (frontId: string) => {
    const f = core.findFront(state, frontId)!;
    // Use a real player forward post inside the front's source bounds.
    const facility = state.facilities.get(frontId === "front_south" ? "ea_player_south_post" : "ea_player_coastal_post")!;
    const stay = add(facility.position.x, facility.position.y);
    const sent = [add(facility.position.x + 1, facility.position.y), add(facility.position.x + 2, facility.position.y)];
    const intent = { type: "attack", fromFront: f.id, toFront: "front_ridge", quantity: 2 } as Intent;
    const r = core.resolveIntent(intent, state, state.style, undefined, sent.map(u => u.id));
    assert.equal(r.orders.length > 0, true, r.log);
    core.applyOrders(state, r.orders.map(o => ({ ...o, origin: "advisor", dispatchMeta: {
      group: frontId, sourceKind: "front", sourceKey: f.id, action: "attack", targetName: r.destinationName,
    } })));
    // Deliberate deterministic battlefield fixture, not a simulated march/playthrough.
    for (const u of sent) u.position = { x: 360, y: 76 };
    const retreat = { type: "retreat", fromFront: frontId, quantity: "all",
      targetFacility: facility.id } as Intent;
    const candidates = core.findDispatchAmbiguity(state, retreat);
    assert.equal(candidates?.length, 2, JSON.stringify(candidates));
    return { stay, sent, retreat, candidates: candidates! };
  };
  const south = split("front_south");
  const north = split("front_coastal");
  const bystander = add(320, 90);
  return { state, add, south, north, bystander };
}
function option(intents: Intent[]): AdvisorOption {
  return { label: "B:复合命令", description: "完整原方案", risk: 0.9, reward: 0.8, intent: intents[0], intents };
}
function picked(h: ReturnType<typeof harness>, prefix: string) {
  const slot = h.pendingSelectionRef.current;
  return slot.candidates.find((c: any) => c.selectionKey.startsWith(prefix))?.selectionKey;
}
function applied(h: ReturnType<typeof harness>, group: string) {
  return [...new Set(h.results.flatMap((r, batch) => r.perOrder
    .filter(o => h.applications[batch][o.orderIndex].dispatchMeta?.group === group)
    .flatMap(o => o.appliedUnitIds)))].sort((a,b) => a-b);
}
function commands(s: GameState) { return JSON.stringify([...s.units].map(([id, u]) => [id, u.orders])); }
function factsMatch(h: ReturnType<typeof harness>) {
  const screen = h.screen.map(m => m.text);
  assert.deepEqual(screen.slice(1), h.context);
  assert.deepEqual(h.audio, [screen.join(" ")]);
}

let count = 0;
let negCount = 0;
function test(name: string, fn: () => void) {
  fn(); count++; if (name.includes("负对照")) negCount++; console.log(`PASS ${name}`);
}

function doubleStay(src = source) {
  const f = fixture(); const h = harness(f.state, src);
  const opt = option([f.south.retreat, f.north.retreat]); const original = JSON.stringify(opt);
  const before = commands(f.state);
  h.approve(opt);
  assert.equal(h.pendingSelectionRef.current.intentIndex, 0);
  assert.equal(commands(f.state), before);
  h.answer(picked(h, "stay:"));
  assert.equal(h.pendingSelectionRef.current?.intentIndex, 1, "must proceed to second question");
  assert.equal(commands(f.state), before, "no partial execution while asking");
  h.answer(picked(h, "stay:"));
  assert.ok(h.pendingSelectionRef.current === null, "must not ask first question again");
  assert.equal(h.applications.length, 1, "whole group applies once");
  assert.deepEqual(applied(h, "i0"), [f.south.stay.id]);
  assert.deepEqual(applied(h, "i1"), [f.north.stay.id]);
  assert.equal(JSON.stringify(opt), original, "original option is immutable");
  assert.equal(h.doctrineSources[0], h.response, "original doctrine response survives");
  assert.ok(f.state.style.riskTolerance > 0.5, "option risk survives both questions");
  return h;
}
test("两条都消歧且都选 stay：两问、零提前执行、只动两批留守、完整 option 不变", () => { doubleStay(); });

test("第一批等待期间有人死亡、有人进入原战线：最终按实时位置重绑，不用旧 roster", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat, f.north.retreat])); h.answer(picked(h, "stay:"));
  const southPost = f.state.facilities.get("ea_player_south_post")!;
  f.south.stay.hp = 0; f.south.stay.state = "dead";
  const replacement = f.add(southPost.position.x + 3, southPost.position.y);
  h.answer(picked(h, "stay:"));
  assert.deepEqual(applied(h, "i0"), [replacement.id]);
  assert.deepEqual(applied(h, "i1"), [f.north.stay.id]);
});

test("dispatch + stay 累计选择：第一批伤亡后只调存活成员，不夹带旁观者", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat, f.north.retreat])); h.answer(picked(h, "dispatch:"));
  f.south.sent[0].hp = 0; f.south.sent[0].state = "dead";
  h.answer(picked(h, "stay:"));
  assert.deepEqual(applied(h, "i0"), [f.south.sent[1].id]);
  assert.deepEqual(applied(h, "i1"), [f.north.stay.id]);
});

test("前面选定批次全灭：最后回答时整组零执行", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat, f.north.retreat])); h.answer(picked(h, "dispatch:"));
  for (const u of f.south.sent) { u.hp = 0; u.state = "dead"; }
  const before = commands(f.state); h.answer(picked(h, "stay:"));
  assert.equal(h.applications.length, 0); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /没有执行/);
});

test("后面的歧义在回答前缩成一批，仍然要问；unclear 不替玩家挑", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat, f.north.retreat]));
  for (const u of f.north.sent) { u.hp = 0; u.state = "dead"; }
  h.answer(picked(h, "stay:"));
  assert.equal(h.pendingSelectionRef.current.intentIndex, 1);
  assert.equal(h.pendingSelectionRef.current.candidates.length, 1);
  assert.match(h.screen.at(-1)!.text, /现在只剩/);
  assert.equal(h.answer(undefined, true).plan.kind, "reask");
  assert.equal(h.applications.length, 0);
  h.answer(picked(h, "stay:")); assert.equal(h.applications.length, 1);
});

test("Emily 无兵：歧义场景也先拒绝，不先追问；屏声同源", () => {
  const f = fixture(); const h = harness(f.state, source, "logistics");
  h.approve(option([f.south.retreat]));
  assert.ok(h.pendingSelectionRef.current === null);
  assert.equal(h.applications.length, 0); assert.match(h.screen[0].text, /名下没有部队/);
  assert.deepEqual(h.audio, h.context); assert.deepEqual(h.context, h.screen.map(m => m.text));
});

test("第一批等待时改隶 Emily：最后回答不能越权或退回全军", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat, f.north.retreat])); h.answer(picked(h, "stay:"));
  f.state.squads.push({ id: "foreign", ownerCommander: "emily", unitIds: [f.south.stay.id] } as shared.Squad);
  const before = commands(f.state); h.answer(picked(h, "stay:"));
  assert.equal(h.applications.length, 0); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /调不动/);
});

test("第一问迟到的重复答复不能消费第二问，新问不延长整组期限", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat, f.north.retreat]));
  const first = h.pendingSelectionRef.current;
  const key = picked(h, "stay:"); f.state.time += 20; h.answer(key);
  const second = h.pendingSelectionRef.current;
  assert.notEqual(second.id, first.id); assert.equal(second.expiresAt, first.expiresAt);
  assert.ok(second.candidates.every((c: object) => !("unitIds" in c)), "pending must not store rosters");
  const screenCount = h.screen.length; const ctxCount = h.context.length; const audioCount = h.audio.length;
  h.deliver({ dispatchSelection: { decision: "chose", candidate: key } },
    { selectionId: first.id, channel: first.channel, sessionId: first.sessionId });
  assert.ok(h.pendingSelectionRef.current === second);
  assert.equal(h.screen.length, screenCount); assert.equal(h.context.length, ctxCount); assert.equal(h.audio.length, audioCount);
  assert.equal(h.applications.length, 0);
  f.state.time = second.expiresAt + 1;
  h.answer(picked(h, "stay:"));
  assert.ok(h.pendingSelectionRef.current === null); assert.equal(h.applications.length, 0);
});

function ticketFirst(src = source) {
  const f = fixture(); const h = harness(f.state, src);
  const g = core.mintSpokenForce(f.state, null, { label: "两人测试队", memberIds: f.north.sent.map(u => u.id), etaSec: null })!;
  const ticketIntent = { type: "attack", fromSquad: g, toFront: "front_ridge", quantity: "all" } as Intent;
  const opt = option([ticketIntent, f.south.retreat]); const original = JSON.stringify(opt);
  const before = commands(f.state); h.approve(opt);
  assert.equal(commands(f.state), before); assert.equal(h.burned.length, 0);
  assert.equal(JSON.stringify(opt), original, "G handle and target must not mutate before question");
  h.answer(picked(h, "stay:"));
  assert.equal(h.applications.length, 1);
  assert.deepEqual(applied(h, "i0"), f.north.sent.map(u => u.id));
  assert.deepEqual(applied(h, "i1"), [f.south.stay.id]);
  assert.deepEqual(h.burned, [g]);
  assert.equal(JSON.stringify(opt), original, "working G retarget cannot mutate original option");
  return h;
}
test("G-ticket 在前、歧义在后：问前不改票，答后限于票内名单，只烧一次", () => { ticketFirst(); });

test("G-ticket 等回答时过期：整组零执行且不烧票", () => {
  const f = fixture(); const h = harness(f.state);
  const g = core.mintSpokenForce(f.state, null, { label: "测试队", memberIds: [f.bystander.id], etaSec: null })!;
  f.state.time = 60;
  h.approve(option([{ type: "attack", fromSquad: g, toFront: "front_ridge", quantity: "all" } as Intent, f.south.retreat]));
  // Expire only the ticket; selection has its own longer lifetime.
  f.state.time = 121;
  h.answer(picked(h, "stay:"));
  assert.equal(h.applications.length, 0); assert.equal(h.burned.length, 0);
});

test("mixed 回执：规划失败 + 实际成功的 screen / TTS / context 同顺序、黄字", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([{ type: "retreat", fromDispatch: "M999", quantity: "all" } as Intent,
    { type: "produce", produceType: "infantry", quantity: 1 } as Intent]));
  assert.equal(h.applications.length, 1); factsMatch(h);
  assert.ok(h.screen.slice(1).every(m => m.level === "warning"));
  assert.ok(h.context.length >= 2);
});
test("全部规划失败：screen / TTS / context 只有同一份理由，不漏声不重播", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([{ type: "retreat", fromDispatch: "M999", quantity: "all" } as Intent]));
  assert.equal(h.applications.length, 0);
  assert.deepEqual(h.screen.map(m => m.text), h.context); assert.deepEqual(h.audio, h.context);
});
test("degraded + already_doing 严重度仍是 partial，且不改变输入回执", () => {
  const original = { outcome: "already_doing" as const, lines: ["已经在办"], spokenText: "已经在办", facts: [] };
  const frozen = JSON.stringify(original); const out = buildExecFeedback(original, ["没办成"]);
  assert.equal(out.outcome, "partial"); assert.deepEqual(out.lines, ["没办成", "已经在办"]);
  assert.equal(out.spokenText, out.lines.join(" ")); assert.equal(JSON.stringify(original), frozen);
});

// ════════════════════════════════════════════════════════════
// ★真实服务端边界（玩家实测：连答两次「派出去的那批」仍重复第一问）
// ════════════════════════════════════════════════════════════
//
// 根因：schema 把模型原始 `{decision,candidate}` 规范成内部 `{kind,candidateKey}`
// 发给浏览器，core 却又拿**原始 parser** 再解析一遍 ⇒ undefined ⇒ protocol_failure
// ⇒ 「这道命令还没有执行」＋ 原样重问。下面每条都走 `overTheWire`（真 schema ＋ JSON
// 往返），不许再绕过这一层。

/** 玩家原话：双线派兵后「南线和北线全部撤退」，两问都答「派出去的那批」。 */
function doubleSent(planOverride?: typeof core.planSelectionTurn) {
  const f = fixture(); const h = harness(f.state, source, "combat", planOverride);
  const before = commands(f.state);
  h.approve(option([f.south.retreat, f.north.retreat]));
  assert.equal(h.pendingSelectionRef.current.intentIndex, 0, "first question is the south one");
  h.answer(picked(h, "dispatch:"));
  assert.equal(h.pendingSelectionRef.current?.intentIndex, 1, "must proceed to second question");
  assert.equal(commands(f.state), before, "no partial execution while asking");
  h.answer(picked(h, "dispatch:"));
  assert.ok(h.pendingSelectionRef.current === null, "must not ask first question again");
  assert.equal(h.applications.length, 1, "whole group applies once");
  // ★核实际下令名单（ApplyResult），不看计划人数，也不看 plan.kind。
  assert.deepEqual(applied(h, "i0"), f.south.sent.map(u => u.id).sort((a, b) => a - b), "south: exactly the dispatched batch");
  assert.deepEqual(applied(h, "i1"), f.north.sent.map(u => u.id).sort((a, b) => a - b), "north: exactly the dispatched batch");
  const allApplied = h.results.flatMap(r => r.appliedUnitIds);
  assert.ok(!allApplied.includes(f.south.stay.id) && !allApplied.includes(f.north.stay.id), "stay-behinds untouched");
  assert.ok(!allApplied.includes(f.bystander.id), "bystander untouched");
  return h;
}
test("★玩家原话复现：双线都答「派出去的那批」⇒ 进第二问、零提前执行、最后只调两批外派（真 schema 链路）", () => { doubleSent(); });

test("单问 chose（options=[]）经真 schema ⇒ 消费候选并按实际名单执行", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat]));
  h.answer(picked(h, "dispatch:"));
  assert.ok(h.pendingSelectionRef.current === null);
  assert.equal(h.applications.length, 1);
  assert.deepEqual(applied(h, "i0"), f.south.sent.map(u => u.id).sort((a, b) => a - b));
});

test("单问 chose（options 非空）经真 schema ⇒ 只绑定原待决命令，回答轮另带的 options 不许二次执行", () => {
  const f = fixture(); const h = harness(f.state);
  h.approve(option([f.south.retreat]));
  const extra = [{ label: "A: 顺手进攻", description: "模型在回答轮多写的单子", risk: 0.5, reward: 0.5,
    intents: [{ type: "attack", fromFront: "front_center", toFront: "front_ridge", quantity: "all" }] }];
  h.answer(picked(h, "dispatch:"), false, extra);
  assert.equal(h.applications.length, 1, "only the bound original command executes");
  assert.deepEqual(applied(h, "i0"), f.south.sent.map(u => u.id).sort((a, b) => a - b));
  assert.equal(f.state.units.get(f.bystander.id)!.orders.length, 0, "extra options never executed");
});

test("单问 unclear 经真 schema ⇒ 零执行、槽留着、原样再问", () => {
  const f = fixture(); const h = harness(f.state);
  const before = commands(f.state);
  h.approve(option([f.south.retreat]));
  const slotId = h.pendingSelectionRef.current.id;
  const d = h.answer(undefined, true);
  assert.equal(d.verdict, "unclear"); assert.equal(d.plan.kind, "reask");
  assert.equal(h.pendingSelectionRef.current?.id, slotId, "same slot kept");
  assert.equal(commands(f.state), before); assert.equal(h.applications.length, 0);
});

test("内部格式严格：非法 kind 带合法 key、原始格式直达客户端 ⇒ 都判协议失败、零执行", () => {
  for (const bad of [
    (key: string) => ({ kind: "随便一个非法值", candidateKey: key }),
    (key: string) => ({ kind: "chose" }),                          // 缺 candidateKey
    (key: string) => ({ kind: "chose", candidateKey: "  " }),      // 空 key
    (key: string) => ({ decision: "chose", candidate: key }),      // 原始格式不许在消费端被"猜"成合法
  ]) {
    const f = fixture(); const h = harness(f.state);
    const before = commands(f.state);
    h.approve(option([f.south.retreat]));
    const slot = h.pendingSelectionRef.current;
    h.deliver({ brief: "x", options: [], dispatchSelection: bad(picked(h, "dispatch:")!) },
      { selectionId: slot.id, channel: slot.channel, sessionId: slot.sessionId });
    assert.equal(h.applications.length, 0, JSON.stringify(bad("K")));
    assert.equal(commands(f.state), before);
    assert.ok(h.pendingSelectionRef.current, "slot kept for the retry");
  }
});

// ════════════════════════════════════════════════════════════
// ★刀寅：陈报出一批 → 长官只派其中几个 → 之后改令只动真走了的那几个
// ════════════════════════════════════════════════════════════
//
// 每一条命令都从**模型原始 JSON** 进：生产 schema → JSON 往返 → 生产 handleApprove
// → core → applyOrders；判据核 ApplyResult 里真接到命令的单位 ID。
// 「把人挪到修理厂」是**测试夹具**（这里没有跑模拟），不冒充实机行军。

const stageSource = execFileSync("git", ["show", "ef01bac:apps/web/src/ChatPanel.tsx"], {
  cwd: new URL("..", import.meta.url), encoding: "utf8",
});

/** 模型原始回包（只有一张方案）→ 生产 schema → JSON 往返 → 取客户端拿到的那张方案去批准。 */
function modelOrder(h: ReturnType<typeof harness>, intents: Record<string, unknown>[], playerText?: string) {
  const wire = overTheWire({ brief: "这就办。", responseType: "EXECUTE", recommended: "A", urgency: 0.5,
    options: [{ label: "A: 方案", description: "方案", risk: 0.3, reward: 0.5, intents }] });
  const opt = (wire.options as AdvisorOption[])[0];
  assert.ok(opt && opt.intents.length === intents.length, "schema kept every intent");
  // 刀寅：新增字段必须经过真 schema＋JSON 往返还在（传输中丢了，下面的核对就全是空转）
  opt.intents.forEach((it, i) => {
    for (const k of ["destinationQuote", "quantityQuote", "returnTo"] as const) {
      if (intents[i][k] !== undefined) assert.equal((it as unknown as Record<string, unknown>)[k], intents[i][k], `${k} survived the wire`);
    }
  });
  h.approve(opt, playerText);
}
/** 最近一次 applyOrders 里，某一条意图真接到命令的单位（applied ∪ 已在办）。 */
function lastTouched(h: ReturnType<typeof harness>, group: string) {
  const batch = h.applications.length - 1; const r = h.results[batch];
  if (!r) return [];
  return [...new Set(r.perOrder.filter(o => h.applications[batch][o.orderIndex].dispatchMeta?.group === group)
    .flatMap(o => [...o.appliedUnitIds, ...o.alreadyDoingUnitIds]))].sort((a, b) => a - b);
}
function lastApplied(h: ReturnType<typeof harness>, group: string) {
  const batch = h.applications.length - 1; const r = h.results[batch];
  if (!r) return [];
  return [...new Set(r.perOrder.filter(o => h.applications[batch][o.orderIndex].dispatchMeta?.group === group)
    .flatMap(o => o.appliedUnitIds))].sort((a, b) => a - b);
}
const ids = (us: Unit[]) => us.map(u => u.id).sort((a, b) => a - b);
const REPAIR = { x: 400, y: 90 }; // 野战修理厂：不在任何一条战线上

function gFixture() {
  core.resetEscalationTickets();
  const state = core.createInitialGameState("el_alamein");
  const template = structuredClone([...state.units.values()].find(u => u.team === "player" && u.type === "infantry")!);
  state.units.clear(); state.squads = []; state.missions = []; state.dispatches = [];
  const add = (x: number, y: number) => {
    const u: Unit = { ...structuredClone(template), id: nextId++, position: { x, y },
      state: "idle", orders: [], waypoints: [], patrolPoints: [], patrolTaskId: null,
      manualOverride: false, target: null, attackTarget: null };
    state.units.set(u.id, u); return u;
  };
  const np = state.facilities.get("ea_player_coastal_post")!.position;
  const sp = state.facilities.get("ea_player_south_post")!.position;
  // 陈报出的那一群：北线前哨附近 8 个未编组的
  const group = Array.from({ length: 8 }, (_, k) => add(np.x + (k % 4), np.y + Math.floor(k / 4)));
  const southAll = [add(sp.x, sp.y), add(sp.x + 1, sp.y), add(sp.x + 2, sp.y), add(sp.x + 3, sp.y)];
  const bystander = add(320, 90);
  const g = core.mintSpokenForce(state, null, { label: "北线前哨附近未编组群", memberIds: group.map(u => u.id), etaSec: 40 })!;
  return { state, add, group, southAll, bystander, g };
}
/** 长官：「那就派两个去修理厂」——模型把号写进 fromSquad。 */
function sendTwo(f: ReturnType<typeof gFixture>, h: ReturnType<typeof harness>) {
  const before = commands(f.state);
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_repair_station" }]);
  const sent = lastApplied(h, "i0");
  assert.equal(sent.length, 2, `exactly two dispatched: ${h.screen.map(m => m.text).join(" | ")}`);
  const untouched = f.group.filter(u => !sent.includes(u.id));
  assert.equal(untouched.length, 6);
  for (const u of untouched) assert.equal(u.orders.length, 0, "the six not picked get no order");
  void before;
  // 夹具：他们走到了修理厂（没跑模拟，直接挪位置）
  for (const id of sent) f.state.units.get(id)!.position = { ...REPAIR };
  return { sent, untouched };
}

/** 与 sendTwo 相同，但不挪位置（真模拟那条自己跑）。 */
function sendTwoNoMove(f: ReturnType<typeof gFixture>, h: ReturnType<typeof harness>) {
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_repair_station" }]);
  const sent = lastApplied(h, "i0");
  assert.equal(sent.length, 2);
  return { sent };
}
function simPump(s: GameState, sec: number) {
  for (let t = 0; t < sec; t += 0.25) { tick(s, 0.25); core.processAutoBehavior(s, 0.25); }
}

test("刀寅 K1 ★8 个里派 2 个：只动 2 个；台账记票号与真实出发战线；回执一句话、不说「不在编」", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent } = sendTwo(f, h);
  const rec = f.state.dispatches.find(d => d.status === "active")!;
  assert.equal(rec.sourceKind, "ticket"); assert.equal(rec.sourceKey, f.g); assert.equal(rec.ticketRef, f.g);
  assert.deepEqual([...rec.memberIds].sort((a, b) => a - b), sent, "ledger = the units ApplyResult says got the order");
  for (const id of sent) assert.equal(rec.originFrontById?.[id], "front_coastal", "origin is where they stood, not a display name");
  assert.deepEqual(h.burned, [f.g]);
  const lines = h.screen.map(m => m.text);
  assert.equal(lines.length, 2, `one ack + ONE receipt line, no second ticket line: ${JSON.stringify(lines)}`);
  const receipt = lines[1];
  assert.ok(!receipt.includes("不在编"), receipt);
  assert.match(receipt, /2 个/); assert.match(receipt, /原报 8 个/);
  // 审核 D：回执不再替长官说「您要的是 N 个」（那个数是模型写的，不一定是他说的）；实际人数照念出声。
  assert.doesNotMatch(receipt, /您要的是/);
  assert.ok(h.audio.some(a => a.includes(receipt)), `receipt is spoken: ${JSON.stringify(h.audio)}`);
  assert.match(receipt, /野战修理厂/);
  factsMatch(h);
  // 信封（生产 digest）：这批人从北线出发、凭这张票派出——不是「未指明」
  const env = buildDigestForChannel(f.state, "combat").split("\n").find(l => l.startsWith(`${rec.id} `))!;
  assert.ok(env && env.includes("from=1. 北部战线") && env.includes(`via=${f.g}`) && env.includes("left=2"), env);
});

test("刀寅 K1-负对照：阶段提交 ef01bac 的真 handler 在同一条上必须红（同一批人报两行 / 台账记成 pool）", () => {
  const f = gFixture(); const h = harness(f.state, stageSource);
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_repair_station" }]);
  const rec = f.state.dispatches.find(d => d.status === "active")!;
  const lines = h.screen.map(m => m.text);
  assert.ok(rec.sourceKind === "pool" && lines.length === 3, `old: ${rec.sourceKind} ${JSON.stringify(lines)}`);
});

function recallViaG(src = source) {
  const f = gFixture(); const h = harness(f.state, src);
  const { sent, untouched } = sendTwo(f, h);
  const n = h.applications.length;
  // 长官改主意：「刚才派出去的那两个回来」——模型拿号指人
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.equal(h.applications.length, n + 1, `recall must execute: ${h.screen.at(-1)?.text}`);
  assert.deepEqual(lastApplied(h, "i0"), sent, "exactly the two that actually left");
  for (const u of untouched) assert.equal(u.orders.length, 0, "the six never picked are never pulled");
  assert.equal(f.bystander.orders.length, 0);
  return { f, h, sent, untouched };
}
test("刀寅 K2 ★改主意叫回：用过的 G 号只指真走了的 2 个（另外 6 个一个不动）", () => {
  const { f, h, sent } = recallViaG();
  const rec = f.state.dispatches.find(d => d.status === "active" && d.action === "retreat")!;
  assert.equal(rec.sourceKind, "dispatch"); assert.equal(rec.ticketRef, f.g, "identity continues after the re-order");
  for (const id of sent) assert.equal(rec.originFrontById?.[id], "front_coastal", "origin inherited, not re-guessed from the repair station");
  assert.ok(!h.screen.some(m => /抽走/.test(m.text)), "re-ordering the batch by its own identity is not a 'pull'");
});
test("刀寅 K1b 剩下那 6 个被另铸新号（同一个群名）⇒ 信封里那批派出的写明「剩下的是 G#，不是这一批」", () => {
  const f = gFixture(); const h = harness(f.state);
  sendTwo(f, h);
  const env = buildDigestForChannel(f.state, "combat", { playerIntent: "", openCommitments: [] }, [], undefined, undefined, true);
  const rec = f.state.dispatches.find(d => d.status === "active")!;
  const line = env.split("\n").find(l => l.startsWith(`${rec.id} `))!;
  const board = env.split("\n").find(l => /临时编队G\d+\]: 6units/.test(l));
  assert.ok(board, "the six left behind got a new handle on the board");
  const g = board!.match(/临时编队(G\d+)/)![1];
  assert.notEqual(g, f.g);
  assert.ok(line.includes(`留下没派的现在是 ${g}，不是这一批`), line);
});
test("刀寅 K2-负对照：ef01bac 的真 handler 叫回时必须红（旧路：号烧了就拒绝）", () => {
  assert.throws(() => recallViaG(stageSource), /recall must execute/);
});

test("刀寅 K2b 模型直接写任务号（fromDispatch）也只动那 2 个", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent, untouched } = sendTwo(f, h);
  const m = f.state.dispatches.find(d => d.status === "active")!.id;
  modelOrder(h, [{ type: "retreat", fromDispatch: m, quantity: "all" }]);
  assert.deepEqual(lastApplied(h, "i0"), sent);
  for (const u of untouched) assert.equal(u.orders.length, 0);
});

test("刀寅 K3 ★同一条派兵再说一遍：已在办、不另开任务、不把没派的 6 个补派出去", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent, untouched } = sendTwo(f, h);
  const ledgerBefore = JSON.stringify(f.state.dispatches);
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_repair_station" }]);
  assert.deepEqual(lastApplied(h, "i0"), [], "nobody newly ordered");
  assert.deepEqual(lastTouched(h, "i0"), sent, "the same two, reported as already doing it");
  assert.equal(JSON.stringify(f.state.dispatches), ledgerBefore, "no new ledger record");
  for (const u of untouched) assert.equal(u.orders.length, 0);
  assert.match(h.screen.at(-1)!.text, /^没有重新下令/);
});

test("刀寅 K4 派出去的 2 个死了 1 个：叫回只动活着的那 1 个", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent, untouched } = sendTwo(f, h);
  const dead = f.state.units.get(sent[0])!; dead.hp = 0; dead.state = "dead";
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.deepEqual(lastApplied(h, "i0"), [sent[1]]);
  for (const u of untouched) assert.equal(u.orders.length, 0);
});

test("刀寅 K5 派出去的全死：明说、零执行，不回头去抓那 6 个", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent, untouched } = sendTwo(f, h);
  for (const id of sent) { const u = f.state.units.get(id)!; u.hp = 0; u.state = "dead"; }
  const n = h.applications.length; const before = commands(f.state);
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.equal(h.applications.length, n); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /没有能调的人了/);
  assert.doesNotMatch(h.screen.at(-1)!.text, /阵亡|改派/, "no structured evidence of why ⇒ do not guess");
  for (const u of untouched) assert.equal(u.orders.length, 0);
});

test("刀寅 K6 其中 1 个被长官手动接管：叫回不抢回它，只动另 1 个", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent } = sendTwo(f, h);
  const manual = f.state.units.get(sent[0])!; manual.manualOverride = true;
  const manualOrders = JSON.stringify(manual.orders);
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.deepEqual(lastApplied(h, "i0"), [sent[1]]);
  assert.equal(JSON.stringify(manual.orders), manualOrders, "manual unit keeps its own orders");
});

test("刀寅 K7 其中 1 个已被另一道令改派：叫回只动还在这批里的那 1 个", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent } = sendTwo(f, h);
  f.state.squads.push({ id: "T9", role: "leader", ownerCommander: "chen", unitIds: [sent[0]] } as shared.Squad);
  const n0 = h.applications.length;
  modelOrder(h, [{ type: "attack", fromSquad: "T9", toFront: "front_ridge", quantity: "all" }]);
  assert.equal(h.applications.length, n0 + 1, `reassign order executed: ${h.screen.at(-1)?.text}`);
  assert.deepEqual(lastApplied(h, "i0"), [sent[0]]);
  const reassignedOrders = JSON.stringify(f.state.units.get(sent[0])!.orders);
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.deepEqual(lastApplied(h, "i0"), [sent[1]]);
  assert.equal(JSON.stringify(f.state.units.get(sent[0])!.orders), reassignedOrders, "reassigned unit not grabbed back");
});

test("刀寅 K8 那 2 个改隶艾米莉：陈叫回 ⇒ 拒绝、零执行（权限走主链那一道）", () => {
  const f = gFixture(); const h = harness(f.state);
  const { sent } = sendTwo(f, h);
  f.state.squads.push({ id: "E1", role: "leader", ownerCommander: "emily", unitIds: sent } as shared.Squad);
  const n = h.applications.length; const before = commands(f.state);
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.equal(h.applications.length, n); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /不在陈军士麾下/);
});

test("刀寅 K9 那批被拆成两拨：用号指 ⇒ 列出来问、零执行，不合并", () => {
  const f = gFixture(); const h = harness(f.state);
  sendTwo(f, h);
  const m = f.state.dispatches.find(d => d.status === "active")!.id;
  modelOrder(h, [{ type: "retreat", fromDispatch: m, quantity: 1 }]);
  assert.equal(lastApplied(h, "i0").length, 1);
  const parts = f.state.dispatches.filter(d => d.status === "active" && d.ticketRef === f.g);
  assert.equal(parts.length, 2, "two live parts both descend from the same ticket");
  const n = h.applications.length; const before = commands(f.state);
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, quantity: "all" }]);
  assert.equal(h.applications.length, n); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /分成了 2 拨/);
  for (const d of parts) assert.ok(h.screen.at(-1)!.text.includes(d.id), "each part is named");
});

test("刀寅 K10 重开一局：旧局用过的号在新局不指任何人（零执行）", () => {
  const f = gFixture(); const h = harness(f.state);
  sendTwo(f, h);
  const oldG = f.g;
  // 新局：票号表随新局清零（GameCanvas 开局时调 resetEscalationTickets），陈还没报过任何一群
  const f2 = gFixture(); core.resetEscalationTickets(); const h2 = harness(f2.state);
  const before = commands(f2.state);
  modelOrder(h2, [{ type: "retreat", fromSquad: oldG, quantity: "all" }]);
  assert.equal(h2.applications.length, 0, h2.screen.at(-1)?.text);
  assert.equal(commands(f2.state), before);
  assert.equal(f2.state.dispatches.length, 0);
});

test("刀寅 K11 号根本不存在：拒绝、零执行", () => {
  const f = gFixture(); const h = harness(f.state);
  const before = commands(f.state);
  modelOrder(h, [{ type: "retreat", fromSquad: "G99", quantity: "all" }]);
  assert.equal(h.applications.length, 0); assert.equal(commands(f.state), before);
});

/** 玩家原话：南线派 3 个、北线凭号派 2 个，之后「南部战线和北部战线的部队全部撤退」，两问都答派出去的那批。 */
function compoundRetreat(opts: { stripOrigins?: boolean } = {}) {
  const f = gFixture(); const h = harness(f.state);
  modelOrder(h, [{ type: "defend", fromFront: "front_south", quantity: 3, targetFacility: "ea_repair_station" }]);
  const m1 = lastApplied(h, "i0"); assert.equal(m1.length, 3);
  for (const id of m1) f.state.units.get(id)!.position = { ...REPAIR };
  const { sent: m2 } = sendTwo(f, h);
  if (opts.stripOrigins) for (const d of f.state.dispatches) { delete d.originFrontById; }
  const southStay = f.southAll.filter(u => !m1.includes(u.id));
  const northStay = f.group.filter(u => !m2.includes(u.id));
  const before = commands(f.state); const n = h.applications.length;
  modelOrder(h, [{ type: "retreat", fromFront: "front_south", quantity: "all" },
    { type: "retreat", fromFront: "front_coastal", quantity: "all" }]);
  assert.equal(h.pendingSelectionRef.current?.intentIndex, 0, "south asked first");
  h.answer(picked(h, "dispatch:"));
  assert.equal(h.pendingSelectionRef.current?.intentIndex, 1, "north must be asked too (its dispatched batch is a real candidate)");
  assert.equal(commands(f.state), before, "no premature orders while asking");
  h.answer(picked(h, "dispatch:"));
  assert.equal(h.applications.length, n + 1, "whole group applies once");
  assert.deepEqual(lastApplied(h, "i0"), m1, "south: exactly the 3 sent earlier");
  assert.deepEqual(lastApplied(h, "i1"), m2, "north: exactly the 2 sent with the ticket");
  const last = h.applications.at(-1)!;
  assert.ok(last.every(o => o.action === "retreat"), `every order is a retreat: ${last.map(o => o.action)}`);
  for (const u of [...southStay, ...northStay, f.bystander]) {
    assert.ok(!last.some(o => o.unitIds.includes(u.id)), `stay-behind ${u.id} untouched`);
  }
  assert.ok(!h.screen.some(m => /不在编|抽走/.test(m.text)), JSON.stringify(h.screen.map(m => m.text)));
  return h;
}
test("刀寅 K12 ★玩家那一局：南北全部撤退、两问都答派出去的 ⇒ 仍是撤退，只动南 3 ＋北 2", () => { compoundRetreat(); });
test("刀寅 K12-负对照：去掉逐人出发战线（旧台账形状）⇒ 北线那一问消失，必须红", () => {
  assert.throws(() => compoundRetreat({ stripOrigins: true }), /north must be asked too/);
});

test("刀寅 K13 撤回一次之后，「北线派出去的那批」仍指那 2 个（身份不断）", () => {
  const { f, h, sent } = recallViaG();
  const n = h.applications.length;
  modelOrder(h, [{ type: "retreat", fromFront: "front_coastal", quantity: "all" }]);
  const slot = h.pendingSelectionRef.current;
  assert.ok(slot, "stay vs the recalled batch ⇒ ask");
  const cand = slot.candidates.find((c: any) => c.selectionKey.startsWith("dispatch:"));
  assert.ok(cand && /撤往/.test(cand.label), JSON.stringify(slot.candidates));
  h.answer(cand.selectionKey);
  assert.equal(h.applications.length, n + 1);
  assert.deepEqual(lastTouched(h, "i0"), sent);
  void f;
});

test("刀寅 K14 多来源的一批：来源逐人记、信封里分开写；「南线派出去的」只算南线那几个", () => {
  const f = gFixture(); const h = harness(f.state);
  const mixed = [f.group[0], f.group[1], f.southAll[0], f.southAll[1]];
  const g2 = core.mintSpokenForce(f.state, null, { label: "混编测试群", memberIds: mixed.map(u => u.id), etaSec: null })!;
  modelOrder(h, [{ type: "defend", fromSquad: g2, quantity: "all", targetFacility: "ea_repair_station" }]);
  assert.deepEqual(lastApplied(h, "i0"), ids(mixed));
  for (const u of mixed) f.state.units.get(u.id)!.position = { ...REPAIR };
  const rec = f.state.dispatches.find(d => d.status === "active" && d.ticketRef === g2)!;
  assert.equal(rec.originFrontById?.[f.group[0].id], "front_coastal");
  assert.equal(rec.originFrontById?.[f.southAll[0].id], "front_south");
  const env = buildDigestForChannel(f.state, "combat").split("\n").find(l => l.startsWith(`${rec.id} `))!;
  assert.ok(env.includes("1. 北部战线×2") && env.includes("4. 南部战线×2") && env.includes(`via=${g2}`),
    `multi-source written out, not squeezed into one: ${env}`);
  modelOrder(h, [{ type: "retreat", fromFront: "front_south", quantity: "all" }]);
  h.answer(picked(h, "dispatch:"));
  assert.deepEqual(lastTouched(h, "i0"), ids([f.southAll[0], f.southAll[1]]), "only the south-origin members");
});

test("刀寅 K15 票的目标战线不是出发战线：为中央前哨报的一群站在北线 ⇒ 记北线", () => {
  const f = gFixture(); const h = harness(f.state);
  const center = core.findFront(f.state, "front_center")!;
  const g3 = core.mintSpokenForce(f.state, center, { label: "中央前哨支援群", memberIds: [f.group[4].id, f.group[5].id], etaSec: null })!;
  modelOrder(h, [{ type: "defend", fromSquad: g3, quantity: "all", targetFacility: "ea_repair_station" }]);
  const rec = f.state.dispatches.find(d => d.status === "active" && d.ticketRef === g3)!;
  for (const id of rec.memberIds) assert.equal(rec.originFrontById?.[id], "front_coastal");
  for (const id of rec.memberIds) f.state.units.get(id)!.position = { ...REPAIR };
  const cands = core.enumerateDispatchCandidates(f.state, { type: "retreat", fromFront: "front_center", quantity: "all" } as Intent);
  assert.ok(cands.every(c => c.kind !== "dispatch"), "not a 'center dispatched' batch");
});

test("刀寅 K16 计划日志/方案标题不进 Staff Feed；燃油不足、路径受阻照常上屏", () => {
  const canvas = readFileSync(new URL("../apps/web/src/GameCanvas.tsx", import.meta.url), "utf8");
  const set = canvas.slice(canvas.indexOf("const SUPPRESSED_DIAG_CODES"), canvas.indexOf("]);", canvas.indexOf("const SUPPRESSED_DIAG_CODES")));
  for (const code of ["PLAN_LOG", "EXEC_PLAN_LABEL"]) assert.ok(set.includes(`"${code}"`), code);
  for (const code of ["NO_FUEL", "PATH_BLOCKED", "NO_AVAILABLE_UNITS"]) assert.ok(!set.includes(`"${code}"`), code);
  assert.ok(source.includes('code: "PLAN_LOG"'), "PLAN_LOG is still recorded internally");
});

test("刀寅 K17 票据差额只念有证据的原因；数不出原因就只报数", () => {
  const f = gFixture();
  const ticket = { gNumber: "G1", unitIds: f.group.map(u => u.id), label: "测试群", unitCount: 8, targetFrontId: null,
    anchor: null, etaSec: null, mintedAt: 0, burned: false, origin: "spoken", printedLabels: [], lastPrintedAt: 0 } as any;
  const bare = core.ticketDispatchReceipt(ticket, 2);
  assert.match(bare, /原报 8 个/); assert.doesNotMatch(bare, /不在|不归|手动|您要/);
  const gap = core.ticketGapFacts(f.state, ticket, f.group.slice(1).map(u => u.id));
  f.group[0].hp = 0; f.group[0].state = "dead";
  const gap2 = core.ticketGapFacts(f.state, ticket, f.group.slice(1).map(u => u.id));
  assert.equal(gap.dead, 0); assert.equal(gap2.dead, 1); assert.equal(gap2.unlawful, 0);
  const line = core.ticketDispatchReceipt(ticket, 2, "moved", { gap: gap2 });
  assert.match(line, /1 个已经不在了/); assert.doesNotMatch(line, /不在编|您要的是/);
});

test("刀寅 K17-负对照：ef01bac 的票据回执函数（从 git 取原文）在同一判据上必须红", () => {
  const old = execFileSync("git", ["show", "ef01bac:packages/core/src/escalationTicket.ts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
  });
  const sf = ts.createSourceFile("t.ts", old, ts.ScriptTarget.Latest, true);
  let fn = "";
  sf.forEachChild(n => { if (ts.isFunctionDeclaration(n) && n.name?.text === "ticketDispatchReceipt") fn = n.getText(sf); });
  assert.ok(fn, "old receipt function found");
  const js = ts.transpileModule(fn.replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const oldReceipt = new Function("spokenNameOf", `${js}\nreturn ticketDispatchReceipt;`)((t: { label: string }) => t.label);
  const bare = oldReceipt({ label: "测试群", unitCount: 8, etaSec: null }, 2);
  assert.throws(() => assert.doesNotMatch(bare, /不在|不归|手动|您要/), `old says: ${bare}`);
});

// ════════════════════════════════════════════════════════════
// ★刀寅（续）：叫回原处 · 确认案绑定 · 回执说实际发生的事
// ════════════════════════════════════════════════════════════
//
// 同样一律从模型原始 JSON 进。「把人挪到半路」是测试夹具（没跑模拟），单列真模拟那条。

/** 最后一轮：屏上那几行 = context 那几行 = 耳朵那一句（应答 + 同一组行）。 */
function lastFactsMatch(h: ReturnType<typeof harness>, n = 1) {
  const screen = h.screen.slice(-n).map(m => m.text);
  assert.deepEqual(h.context.slice(-n), screen, "context = screen");
  assert.equal(h.audio.at(-1), `收到。 ${screen.join(" ")}`, "ear = screen");
}
const near = (a: { x: number; y: number } | null | undefined, b: { x: number; y: number }, r = 2.5) =>
  !!a && Math.hypot(a.x - b.x, a.y - b.y) <= r;
/** 最近一次下令里，每个单位拿到的落点。 */
function lastTargets(h: ReturnType<typeof harness>): Map<number, { x: number; y: number } | null> {
  const m = new Map<number, { x: number; y: number } | null>();
  const batch = h.applications.at(-1) ?? [];
  const res = h.results.at(-1);
  const applied = new Set(res?.appliedUnitIds ?? []);
  for (const o of batch) for (const id of o.unitIds) if (applied.has(id)) m.set(id, o.target);
  return m;
}
/** 8 个站在北线前哨的一群，派 2 个去修理厂，记下出发位置，夹具把他们挪到半路。 */
function sentHalfway() {
  const f = gFixture(); const h = harness(f.state);
  const { sent, untouched } = sendTwo(f, h);
  const home = new Map(sent.map(id => [id, { ...f.state.dispatches.find(d => d.status === "active")!.originPosById![id] }]));
  for (const id of sent) f.state.units.get(id)!.position = { x: 380, y: 60 }; // 夹具：半路
  return { f, h, sent, untouched, home };
}

test("刀寅 O1 ★「刚才那两个叫回来」：只动真走了的 2 个，各回各的出发位置；回执说出发地（北线前哨附近），不说安全区", () => {
  const { f, h, sent, untouched, home } = sentHalfway();
  for (const id of sent) assert.ok(near(home.get(id), f.state.facilities.get("ea_player_coastal_post")!.position, 12), "fixture: they left from the north post");
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  assert.deepEqual(lastApplied(h, "i0"), sent);
  const tg = lastTargets(h);
  for (const id of sent) assert.ok(near(tg.get(id), home.get(id)!), `unit ${id} goes back to where it left from: ${JSON.stringify(tg.get(id))} vs ${JSON.stringify(home.get(id))}`);
  for (const u of untouched) assert.equal(u.orders.length, 0);
  assert.ok(h.applications.at(-1)!.every(o => o.action === "retreat"), "still the retreat chain (no chase en route)");
  const line = h.screen.at(-1)!.text;
  assert.match(line, /出发地（北线前哨附近）/); assert.doesNotMatch(line, /安全区域/);
  lastFactsMatch(h);
});
test("刀寅 O1-负对照：ef01bac 的真 handler + 同一句 ⇒ 必须红（旧路：用过的号被拒，叫不回来）", () => {
  const f = gFixture(); const h = harness(f.state, stageSource);
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_repair_station" }]);
  const n = h.applications.length;
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  assert.equal(h.applications.length, n, "old handler cannot recall");
});

test("刀寅 O2 ★途中改一次目的地再叫回：起点不漂移（不是半路、不是第二个目的地）", () => {
  const { f, h, sent, home } = sentHalfway();
  const m1 = f.state.dispatches.find(d => d.status === "active")!.id;
  modelOrder(h, [{ type: "defend", fromDispatch: m1, targetFacility: "ea_player_south_post" }]);
  assert.deepEqual(lastApplied(h, "i0"), sent);
  const rec = f.state.dispatches.find(d => d.status === "active")!;
  for (const id of sent) assert.ok(near(rec.originPosById![id], home.get(id)!, 0.01), "re-order inherits the original start");
  for (const id of sent) f.state.units.get(id)!.position = { x: 372, y: 120 }; // 夹具：又走了一段
  modelOrder(h, [{ type: "retreat", fromDispatch: rec.id, returnTo: "origin" }]);
  const tg = lastTargets(h);
  for (const id of sent) assert.ok(near(tg.get(id), home.get(id)!), `start did not drift: ${JSON.stringify(tg.get(id))}`);
});

test("刀寅 O3 重复叫回：已在办、不另开任务、起点不被改写", () => {
  const { f, h, sent, home } = sentHalfway();
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  const ledger = JSON.stringify(f.state.dispatches);
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  assert.deepEqual(lastApplied(h, "i0"), []);
  assert.deepEqual(lastTouched(h, "i0"), sent);
  assert.equal(JSON.stringify(f.state.dispatches), ledger);
  const rec = f.state.dispatches.find(d => d.status === "active")!;
  for (const id of sent) assert.ok(near(rec.originPosById![id], home.get(id)!, 0.01));
});

test("刀寅 O4 ★点了地方就去那个地方：「那批撤回南线前哨」到设施本身，不被出发地覆盖、不落到战线中心", () => {
  const { f, h, sent } = sentHalfway();
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, targetFacility: "ea_player_south_post", returnTo: "origin" }]);
  const post = f.state.facilities.get("ea_player_south_post")!.position;
  const tg = lastTargets(h);
  for (const id of sent) assert.ok(near(tg.get(id), post, 3), `explicit place wins: ${JSON.stringify(tg.get(id))}`);
  assert.match(h.screen.at(-1)!.text, /南线前哨/); assert.doesNotMatch(h.screen.at(-1)!.text, /南部战线|出发地/);
});

test("刀寅 O5 裸「快撤」保持老行为（安全区域），不被当成回原处", () => {
  const { f, h, sent } = sentHalfway();
  modelOrder(h, [{ type: "retreat", fromSquad: f.g }]);
  assert.deepEqual(lastApplied(h, "i0"), sent);
  assert.match(h.screen.at(-1)!.text, /安全区域/);
});

test("刀寅 O6 多来源的一批叫回：各回各的出发位置，不编一个共同据点", () => {
  const f = gFixture(); const h = harness(f.state);
  const mixed = [f.group[0], f.group[1], f.southAll[0], f.southAll[1]];
  const home = new Map(mixed.map(u => [u.id, { ...u.position }]));
  const g2 = core.mintSpokenForce(f.state, null, { label: "混编测试群", memberIds: mixed.map(u => u.id), etaSec: null })!;
  modelOrder(h, [{ type: "defend", fromSquad: g2, quantity: "all", targetFacility: "ea_repair_station" }]);
  for (const u of mixed) f.state.units.get(u.id)!.position = { ...REPAIR };
  modelOrder(h, [{ type: "retreat", fromSquad: g2, returnTo: "origin" }]);
  const tg = lastTargets(h);
  for (const u of mixed) assert.ok(near(tg.get(u.id), home.get(u.id)!), `${u.id} back to its own start`);
  assert.match(h.screen.at(-1)!.text, /各自的出发地/); assert.doesNotMatch(h.screen.at(-1)!.text, /北线前哨附近|南线前哨附近/);
});

test("刀寅 O7 没记下出发地的人：明说、零执行，不拿安全区顶上", () => {
  const f = gFixture(); const h = harness(f.state);
  const before = commands(f.state);
  modelOrder(h, [{ type: "retreat", fromFront: "front_south", quantity: "all", returnTo: "origin" }]);
  assert.equal(h.applications.length, 0); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /没有记下这次外派的出发地/); assert.doesNotMatch(h.screen.at(-1)!.text, /安全区域/);
});

test("刀寅 O8 阵亡 / 手动接管：叫回只动活着且没被接管的", () => {
  const { f, h, sent } = sentHalfway();
  const extra = f.group.find(u => !sent.includes(u.id))!;
  const dead = f.state.units.get(sent[0])!; dead.hp = 0; dead.state = "dead";
  void extra;
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  assert.deepEqual(lastApplied(h, "i0"), [sent[1]]);
});

test("刀寅 O9 出发地到不了：那个人不动并说出来，其余照回，不偷换成安全区", () => {
  const { f, h, sent, home } = sentHalfway();
  const rec = f.state.dispatches.find(d => d.status === "active")!;
  // 夹具：把其中一人的出发位置改到地图外（不可达）——验证的是"到不了"那一格的处理
  rec.originPosById![sent[0]] = { x: -500, y: -500 };
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  assert.deepEqual(lastApplied(h, "i0"), [sent[1]]);
  assert.ok(near(lastTargets(h).get(sent[1]), home.get(sent[1])!));
  assert.ok(h.screen.some(m => /1 个的出发地现在到不了，没有动/.test(m.text)), JSON.stringify(h.screen.map(m => m.text)));
  assert.ok(!h.screen.some(m => /安全区域/.test(m.text)));
  lastFactsMatch(h, 2);
});

test("刀寅 O10 ★不永久回出生点：被别的说法（分队）重新调走之后，叫回＝回到那一次的出发处", () => {
  const { f, h, sent } = sentHalfway();
  for (const id of sent) f.state.units.get(id)!.position = { ...REPAIR }; // 夹具：已到修理厂
  f.state.squads.push({ id: "T8", role: "leader", ownerCommander: "chen", unitIds: sent } as shared.Squad);
  modelOrder(h, [{ type: "defend", fromSquad: "T8", targetFacility: "ea_player_south_post" }]);
  assert.deepEqual(lastApplied(h, "i0"), sent);
  for (const id of sent) f.state.units.get(id)!.position = { x: 380, y: 130 }; // 夹具：半路
  modelOrder(h, [{ type: "retreat", fromSquad: "T8", returnTo: "origin" }]);
  const tg = lastTargets(h);
  for (const id of sent) assert.ok(near(tg.get(id), REPAIR, 3), `new outing started at the repair station: ${JSON.stringify(tg.get(id))}`);
});

test("刀寅 O11 出发据点命名半径与板子「X附近」同一尺度（防漂）", () => {
  const ledger = require("../packages/core/src/dispatchLedger");
  const payload = require("../packages/core/src/frontEscalationPayload");
  assert.equal(ledger.ORIGIN_FACILITY_RADIUS, payload.NAME_RADIUS_TILES);
  // place-presence V1：三把「X附近」尺（板子起名 / 出发据点 / 设施危机近旁）都等于 shared 常量
  const director = require("../packages/core/src/director");
  assert.equal(payload.NAME_RADIUS_TILES, shared.PLACE_NEAR_RADIUS_TILES);
  assert.equal(ledger.ORIGIN_FACILITY_RADIUS, shared.PLACE_NEAR_RADIUS_TILES);
  assert.equal(director.FACILITY_GATE.NEAR_RADIUS, shared.PLACE_NEAR_RADIUS_TILES);
});

// ── 确认案：陈要长官点头的具体方案 ──

/** 陈先问「从 G 里派两个去南线前哨，行吗？」（带着方案）；长官答是的时，模型把单子重写坏了。 */
const CONFIRM_PLAN = (g: string) => ({
  brief: `长官，从${g}里派两个去南线前哨，行吗？`, responseType: "CONFIRM", recommended: "A", urgency: 0.4,
  options: [{ label: "A: 派两个去南线前哨", description: "从这一批里抽两个去南线前哨设防", risk: 0.2, reward: 0.4,
    intents: [{ type: "defend", fromSquad: g, quantity: 2, targetFacility: "ea_player_south_post" }] }],
});
const YES_REWRITTEN_BADLY = (g: string) => ({
  brief: "依令。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "authorize",
  options: [{ label: "A: 派两个", description: "", risk: 0.2, reward: 0.4,
    intents: [{ type: "defend", fromSquad: g, quantity: 2, toFront: "front_south" }] }],
});

test("刀寅 C1 ★确认案：问的那一刻存下方案、零执行；「是的」执行**存下的**那份（南线前哨），不执行重写坏了的（南部战线）", () => {
  const f = gFixture(); const h = harness(f.state);
  const before = commands(f.state);
  assert.equal(h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" }), undefined, "confirm turn ends inside the ingress");
  assert.equal(commands(f.state), before, "zero execution on the question turn");
  assert.ok(h.pendingContractRef.current?.phase === "awaiting_reply");
  assert.match(h.screen.at(-1)!.text, /行吗？/);
  const tag = h.pendingTagNow();
  assert.ok(tag, "the next request is tagged with the contract");
  h.turn(YES_REWRITTEN_BADLY(f.g), { pendingTag: tag, userMsg: "是的" });
  assert.equal(h.applications.length, 1, "exactly one execution");
  assert.equal(lastApplied(h, "i0").length, 2);
  const post = f.state.facilities.get("ea_player_south_post")!.position;
  for (const [, t] of lastTargets(h)) assert.ok(near(t, post, 3), `captured destination kept: ${JSON.stringify(t)}`);
  assert.match(h.screen.at(-1)!.text, /南线前哨/); assert.doesNotMatch(h.screen.at(-1)!.text, /南部战线/);
  assert.ok(h.pendingContractRef.current === null, "consumed once");
});
test("刀寅 C1-对照：同一个「是的」若照旧执行模型重写的那份，就落到战线中心（这正是玩家那局的形状）", () => {
  const f = gFixture(); const h = harness(f.state);
  const opt = (overTheWire(YES_REWRITTEN_BADLY(f.g)).options as AdvisorOption[])[0];
  h.approve(opt);
  assert.match(h.screen.at(-1)!.text, /4\. 南部战线/);
});

test("刀寅 C2 「是的」那一轮重复投递：第二次 inert，不执行第二遍", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g)); const tag = h.pendingTagNow();
  h.turn(YES_REWRITTEN_BADLY(f.g), { pendingTag: tag });
  const n = h.applications.length; const screens = h.screen.length;
  h.turn(YES_REWRITTEN_BADLY(f.g), { pendingTag: tag });
  assert.equal(h.applications.length, n); assert.equal(h.screen.length, screens);
});

test("刀寅 C3 答「算了」＝cancel：零执行、合同清掉", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g)); const tag = h.pendingTagNow(); const before = commands(f.state);
  h.turn({ brief: "行，那就不动。", responseType: "NOOP", options: [], pendingDecision: "cancel" }, { pendingTag: tag });
  assert.equal(commands(f.state), before); assert.equal(h.applications.length, 0);
  assert.ok(h.pendingContractRef.current === null);
});

test("刀寅 C4 几个方案里挑一个时不登记：「好的」不能替长官选", () => {
  const f = gFixture(); const h = harness(f.state);
  const two = CONFIRM_PLAN(f.g) as any;
  two.options = [two.options[0], { ...two.options[0], label: "B: 派两个去修理厂",
    intents: [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_repair_station" }] }];
  const before = commands(f.state);
  h.turn(two);
  assert.ok(h.pendingContractRef.current === null, "no single plan ⇒ nothing to bind");
  assert.equal(commands(f.state), before, "and nothing executed");
  assert.equal(h.pendingTagNow(), null);
});

test("刀寅 C5 高影响方案不在这里登记（交给现成的高影响链：先说代价再批准）", () => {
  const f = gFixture(); const h = harness(f.state);
  const hi = { brief: "长官，全军撤退，行吗？", responseType: "CONFIRM", recommended: "A", urgency: 0.9,
    options: [{ label: "A: 全线撤退", description: "全军撤退", risk: 0.8, reward: 0.2, intents: [{ type: "retreat", quantity: "all" }] }] };
  const r = h.turn(hi);
  assert.equal(r, "passthrough", "falls to the high-impact chain below");
  assert.ok(h.pendingContractRef.current === null); assert.equal(h.applications.length, 0);
});

test("刀寅 C6 过期不执行：期限过了再说「是的」，存下的方案不会动", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g));
  f.state.time += 200;
  const tag = h.pendingTagNow();
  assert.equal(tag, null, "expired contract is not tagged at send");
  const r = h.turn({ ...YES_REWRITTEN_BADLY(f.g), pendingDecision: null }, {});
  assert.equal(r, "passthrough"); assert.equal(h.applications.length, 0);
});

test("刀寅 C7 批准前那批人有伤亡：执行前照常复核，只动活着的；全灭就明说不执行", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g)); const tag = h.pendingTagNow();
  for (const u of f.group.slice(0, 7)) { u.hp = 0; u.state = "dead"; }
  h.turn(YES_REWRITTEN_BADLY(f.g), { pendingTag: tag });
  assert.deepEqual(lastApplied(h, "i0"), [f.group[7].id]);
  const f2 = gFixture(); const h2 = harness(f2.state);
  h2.turn(CONFIRM_PLAN(f2.g)); const tag2 = h2.pendingTagNow();
  for (const u of f2.group) { u.hp = 0; u.state = "dead"; }
  h2.turn(YES_REWRITTEN_BADLY(f2.g), { pendingTag: tag2 });
  assert.equal(h2.applications.length, 0);
});

// ── 去处原话（destinationQuote）与目的地字段的一致性 ──
const SOUTH_POST = "ea_player_south_post";
function destOfLast(h: ReturnType<typeof harness>): string {
  const ex = h.traces.filter(t => t.stage === "exec").at(-1);
  return String(((ex?.data.intents as Record<string, unknown>[] | undefined) ?? [])[0]?.destination ?? "");
}

const SP = "ea_player_south_post";
const say = (h: ReturnType<typeof harness>, text: string, intents: Record<string, unknown>[]) => modelOrder(h, intents, text);
const two = (g: string, extra: Record<string, unknown>) => ({ type: "defend", fromSquad: g, quantity: 2, ...extra });
const noOrders = (h: ReturnType<typeof harness>) => h.applications.length === 0;

test("刀寅 Q1 ★长官说「去南线前哨」、单子只写到南部战线、原话标的是「南线前哨」⇒ 不静默改：零执行、提出按南线前哨办；他同意后才去南线前哨", () => {
  const f = gFixture(); const h = harness(f.state);
  say(h, "派其中两个去南线前哨", [two(f.g, { toFront: "front_south", destinationQuote: "南线前哨" })]);
  assert.ok(noOrders(h), "zero execution on the mismatch");
  assert.match(h.screen.at(-1)!.text, /您说的是南线前哨，这道令只写到了4\. 南部战线——按南线前哨办吗/);
  const pc = h.pendingContractRef.current;
  assert.ok(pc && pc.opt.intents[0].targetFacility === SP && !pc.opt.intents[0].toFront, "the proposal is the named post");
  h.turn({ brief: "好。", responseType: "EXECUTE", options: [], pendingDecision: "authorize" }, { pendingTag: h.pendingTagNow(), userMsg: "对" });
  assert.equal(destOfLast(h), "南线前哨"); assert.equal(lastApplied(h, "i0").length, 2);
});
test("刀寅 Q1-负对照：ef01bac 的真 handler 同一份单子 ⇒ 不问、静默落到「4. 南部战线」（玩家那局的形状），必须红", () => {
  const f = gFixture(); const h = harness(f.state, stageSource);
  const opt = (overTheWire({ brief: "x", responseType: "EXECUTE", options: [{ label: "A", description: "", risk: 0, reward: 0,
    intents: [two(f.g, { toFront: "front_south", destinationQuote: "南线前哨" })] }] }).options as AdvisorOption[])[0];
  h.approve(opt);
  assert.throws(() => assert.ok(noOrders(h)), "old code executes silently");
  assert.match(h.screen.map(m => m.text).join(" "), /4\. 南部战线/);
});

test("刀寅 Q2 ★目的地填对了、原话片段标错了（「南线前哨不用管」被当成去处）⇒ 不静默改坏：零执行、问", () => {
  const f = gFixture(); const h = harness(f.state); const before = commands(f.state);
  say(h, "南线前哨不用管，派其中两个去南部战线设防", [two(f.g, { toFront: "front_south", destinationQuote: "南线前哨" })]);
  assert.ok(noOrders(h)); assert.equal(commands(f.state), before);
  const f2 = gFixture(); const h2 = harness(f2.state);
  say(h2, "南线前哨不用管，派其中两个去南部战线设防", [two(f2.g, { toFront: "front_south", destinationQuote: "南部战线" })]);
  assert.equal(destOfLast(h2), "4. 南部战线", "correctly marked ⇒ executes as written");
});

test("刀寅 Q3 否定地点 / 来源地点 / 询问地点：去处片段标对了就照字段走，句里别的地名不掺进来", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["北线前哨不用管，派其中两个去南部战线", { toFront: "front_south", destinationQuote: "南部战线" }, "4. 南部战线"],
    ["从北线前哨派两个去南线前哨", { targetFacility: SP, destinationQuote: "南线前哨" }, "南线前哨"],
    ["南线前哨那边还有人吗？派两个去南部战线", { toFront: "front_south", destinationQuote: "南部战线" }, "4. 南部战线"],
  ];
  for (const [text, fields, want] of cases) {
    const f = gFixture(); const h = harness(f.state);
    say(h, text, [two(f.g, fields)]);
    assert.equal(destOfLast(h), want, text);
  }
});

test("刀寅 Q4 ★一句话两条命令（一条去设施、一条去战线）各用各的去处，不串；第二条借了第一条的地名 ⇒ 问，不静默改", () => {
  const f = gFixture(); const h = harness(f.state);
  const text = "两个去南线前哨，另外两个去南部战线";
  say(h, text, [two(f.g, { targetFacility: SP, destinationQuote: "南线前哨" }), two(f.g, { toFront: "front_south", destinationQuote: "南部战线" })]);
  const ex = h.traces.filter(t => t.stage === "exec").at(-1)!;
  assert.deepEqual((ex.data.intents as any[]).map(i => i.destination), ["南线前哨", "4. 南部战线"]);
  const f2 = gFixture(); const h2 = harness(f2.state); const before = commands(f2.state);
  say(h2, text, [two(f2.g, { targetFacility: SP, destinationQuote: "南线前哨" }), two(f2.g, { toFront: "front_south", destinationQuote: "南线前哨" })]);
  assert.ok(noOrders(h2), "whole command held"); assert.equal(commands(f2.state), before);
});

test("刀寅 Q5 长官明确改口：旧地点不覆盖新地点（同一句里改口；下一句改口时旧的待确认方案不执行）", () => {
  const f = gFixture(); const h = harness(f.state);
  say(h, "派两个去南线前哨，算了，改去南部战线", [two(f.g, { toFront: "front_south", destinationQuote: "南部战线" })]);
  assert.equal(destOfLast(h), "4. 南部战线");
  const f2 = gFixture(); const h2 = harness(f2.state);
  h2.turn(CONFIRM_PLAN(f2.g), { userMsg: "派其中两个去南线前哨" });
  const tag = h2.pendingTagNow();
  const r = h2.turn({ brief: "改去南部战线。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "amend",
    options: [{ label: "A", description: "", risk: 0, reward: 0, intents: [two(f2.g, { toFront: "front_south", destinationQuote: "南部战线" })] }] },
  { pendingTag: tag, userMsg: "改去南部战线" });
  assert.equal(r, "passthrough", "amend ⇒ the new plan goes through the normal path");
  assert.ok(h2.pendingContractRef.current === null, "old plan dropped"); assert.ok(noOrders(h2), "old plan never ran");
  modelOrder(h2, [two(f2.g, { toFront: "front_south", destinationQuote: "南部战线" })], "改去南部战线");
  assert.equal(destOfLast(h2), "4. 南部战线");
});

test("刀寅 Q6 错字：「南线前稍」「南部展现」照模型的理解走，不要求地图全名、不因错字就问；错字＋只写到战线的那一格覆盖不了（如实记录）", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["派其中两个去南线前稍", { targetFacility: SP, destinationQuote: "南线前稍" }, "南线前哨"],
    ["派其中两个去南部展现", { toFront: "front_south", destinationQuote: "南部展现" }, "4. 南部战线"],
    ["派其中两个去南线前稍", { toFront: "front_south", destinationQuote: "南线前稍" }, "4. 南部战线"], // 已知局限：认不出，不介入
  ];
  for (const [text, fields, want] of cases) {
    const f = gFixture(); const h = harness(f.state);
    say(h, text, [two(f.g, fields)]);
    assert.equal(destOfLast(h), want, `${text} ${JSON.stringify(fields)}`);
    assert.ok(!h.screen.some(m => /对不上|按.*办吗/.test(m.text)), "a typo alone does not trigger a question");
  }
});

test("刀寅 Q7 代词（「那边」）⇒ 不介入，照字段", () => {
  const f = gFixture(); const h = harness(f.state);
  say(h, "派两个去那边", [two(f.g, { targetFacility: SP, destinationQuote: "那边" })]);
  assert.equal(destOfLast(h), "南线前哨");
});

test("刀寅 Q8 ★确认回合核对用的是**存下那份方案绑定的原话**，不是「是的」", () => {
  const f = gFixture(); const h = harness(f.state);
  const plan = CONFIRM_PLAN(f.g) as any;
  plan.options[0].intents = [two(f.g, { toFront: "front_south", destinationQuote: "南线前哨" })];
  h.turn(plan, { userMsg: "派其中两个去南线前哨" });
  h.turn({ brief: "好。", responseType: "EXECUTE", options: [], pendingDecision: "authorize" }, { pendingTag: h.pendingTagNow(), userMsg: "是的" });
  assert.ok(noOrders(h), "checked against 「派其中两个去南线前哨」 ⇒ mismatch ⇒ asks (with 「是的」 it would have gone silently)");
  assert.match(h.screen.at(-1)!.text, /按南线前哨办吗/);
});

test("刀寅 Q9 字段缺失 ⇒ 不介入（没有原话片段时原来的静默降级仍在，如实记录）；引用不在原话里 ⇒ 不采信它补/改目的地，但单子自己前后不一就问", () => {
  const f = gFixture(); const h = harness(f.state);
  say(h, "派其中两个去南线前哨", [two(f.g, { toFront: "front_south" })]);
  assert.equal(destOfLast(h), "4. 南部战线", "no quote ⇒ no check (known limitation)");
  const f2 = gFixture(); const h2 = harness(f2.state);
  say(h2, "派两个去南部战线", [two(f2.g, { toFront: "front_south", destinationQuote: "北线前哨" })]);
  assert.ok(noOrders(h2), "self-inconsistent plan ⇒ held");
  assert.doesNotMatch(h2.screen.at(-1)!.text, /您说的/, "must not claim the player said it");
  const f3 = gFixture(); const h3 = harness(f3.state);
  say(h3, "派两个去南部战线", [two(f3.g, { destinationQuote: "南线前哨" })]);
  assert.ok(!h3.traces.some(t => t.stage === "exec" && (t.data.intents as any[])[0]?.destination === "南线前哨"), "unverified quote never fills a destination");
});

test("刀寅 Q13 ★陈先问了句**不带方案**的话、长官答「是的」、模型凭记忆重写成只到战线（片段仍是「北线前哨」）⇒ 不静默去战线中心：问，并提出按北线前哨办", () => {
  const f = gFixture(); const h = harness(f.state);
  for (const u of f.group) u.position = { x: 360 + (u.id % 4), y: 105 + Math.floor((u.id % 8) / 4) };
  say(h, "是的", [two(f.g, { toFront: "front_coastal", destinationQuote: "北线前哨" })]);
  assert.ok(noOrders(h));
  assert.match(h.screen.at(-1)!.text, /记下的去处却是北线前哨——按北线前哨办吗/);
  h.turn({ brief: "好。", responseType: "EXECUTE", options: [], pendingDecision: "authorize" }, { pendingTag: h.pendingTagNow(), userMsg: "对" });
  assert.equal(destOfLast(h), "北线前哨");
});

/**
 * 审核 P0：字段没写去处时，原话片段**绝不补去处**。成对比较：同一张单子带不带片段，
 * 下令结果必须一模一样（片段在这里只能被忽略）。
 */
function quoteIsInert(setup: () => { f: ReturnType<typeof gFixture>; h: ReturnType<typeof harness> },
  text: string, intents: (f: ReturnType<typeof gFixture>) => Record<string, unknown>[], quote: string) {
  const a = setup(); say(a.h, text, intents(a.f).map(it => ({ ...it, destinationQuote: quote })));
  const b = setup(); say(b.h, text, intents(b.f));
  const tA = [...lastTargets(a.h)].sort((x, y) => x[0] - y[0]);
  const tB = [...lastTargets(b.h)].sort((x, y) => x[0] - y[0]);
  assert.ok(tA.length > 0, `executed: ${a.h.screen.map(m => m.text).join(" | ")}`);
  // id 在两份夹具里一一对应（同一份构造顺序）——比较相对位置
  assert.deepEqual(tA.map(([, p]) => p), tB.map(([, p]) => p), "the quote changed nothing");
  return a;
}
test("刀寅 Q10 ★字段没写去处 ⇒ 原话片段一律不补（审核 P0：叫回 / 快撤 / 来源 / 否定都被补成开往那个地方）", () => {
  // ① 叫回：「派去野战修理厂的那两个」里的地名被标成去处
  const a = quoteIsInert(() => sentHalfway(), "刚才派去野战修理厂的那两个叫回来",
    f => [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }], "野战修理厂");
  for (const [, p] of lastTargets(a.h)) assert.ok(!near(p, REPAIR, 6), `recall must not head to the repair station: ${JSON.stringify(p)}`);
  // ② 快撤：没说去哪 ⇒ 安全方向，不是开往原话里提到的地方
  const b = quoteIsInert(() => sentHalfway(), "去野战修理厂的那两个快撤",
    f => [{ type: "retreat", fromSquad: f.g }], "野战修理厂");
  for (const [, p] of lastTargets(b.h)) assert.ok(!near(p, REPAIR, 6), `retreat must not head to the repair station: ${JSON.stringify(p)}`);
  // ③ 来源：「北线前哨的部队撤退」
  quoteIsInert(() => { const f = gFixture(); return { f, h: harness(f.state) }; }, "北线前哨的部队撤退",
    () => [{ type: "retreat", fromFront: "front_coastal", quantity: "all" }], "北线前哨");
  // ④ 否定：「别去南线前哨，原地设防」
  const d = quoteIsInert(() => { const f = gFixture(); return { f, h: harness(f.state) }; }, "北线的部队别去南线前哨，原地设防",
    () => [{ type: "defend", fromFront: "front_coastal", quantity: "all" }], "南线前哨");
  const sp = d.f.state.facilities.get(SP)!.position;
  for (const [, p] of lastTargets(d.h)) assert.ok(!near(p, sp, 6), "negation never becomes 'go there'");
  // ⑤ 已知局限（如实记录）：模型漏写了目的地字段、片段却点了去处 ⇒ 同样不补（不再替长官补去处）
  quoteIsInert(() => { const f = gFixture(); return { f, h: harness(f.state) }; }, "派其中两个去南线前哨",
    f => [two(f.g, {})], "南线前哨");
});
test("刀寅 Q10b 撤退单：长官说撤到北线前哨、字段只写到北部战线 ⇒ 只问，不替他出「按北线前哨办」的方案", () => {
  const { f, h } = sentHalfway();
  say(h, "刚才那两个撤到北线前哨", [{ type: "retreat", fromSquad: f.g, toFront: "front_coastal", destinationQuote: "北线前哨" }]);
  assert.equal(h.applications.length, 1, "only the original dispatch"); // sentHalfway 自己那一次
  assert.match(h.screen.at(-1)!.text, /两处对不上——您要去哪儿/);
  assert.ok(h.pendingContractRef.current === null, "no proposal stored for a retreat");
});
test("刀寅 Q11 ★字段写了设施、原话片段说的是战线（「北线前哨不用管，去北部战线」却写成去北线前哨）⇒ 冲突：零执行、问", () => {
  const f = gFixture(); const h = harness(f.state); const before = commands(f.state);
  for (const u of f.group) u.position = { x: 360 + (u.id % 4), y: 105 + Math.floor((u.id % 8) / 4) };
  say(h, "北线前哨不用管，派其中两个去北部战线设防", [two(f.g, { targetFacility: "ea_player_coastal_post", destinationQuote: "北部战线" })]);
  assert.ok(noOrders(h)); assert.equal(commands(f.state), before);
  assert.match(h.screen.at(-1)!.text, /对不上/);
});

test("刀寅 Q12 跨局旧引用：上一局存下的方案，新局里答「对」不执行", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" });
  const tag = h.pendingTagNow();
  h.gameEpochRef.current++; // 重开一局（生产里 syncGameEpoch 推进局次）
  h.turn({ brief: "好。", responseType: "EXECUTE", options: [], pendingDecision: "authorize" }, { pendingTag: tag });
  assert.ok(noOrders(h)); assert.ok(h.pendingContractRef.current === null, "old-battle plan dropped");
});

test("刀寅 C8 ★开放问题（ASK）即使夹着一张暂定单子也不进批准流程：不存、零执行", () => {
  const f = gFixture(); const h = harness(f.state); const before = commands(f.state);
  h.turn({ ...CONFIRM_PLAN(f.g), brief: "长官，您指哪两个？", responseType: "ASK" }, { userMsg: "派其中两个去南线前哨" });
  assert.equal(commands(f.state), before); assert.ok(h.pendingContractRef.current === null);
  assert.equal(h.pendingTagNow(), null, "nothing for 「对」 to consume");
});
test("刀寅 C8b ★审核复现：陈问「您指哪两个人？」且夹着暂定单子，长官回「对」（生产确认词捷径）⇒ 不执行", () => {
  const f = gFixture(); const h = harness(f.state); const before = commands(f.state);
  h.turn({ ...CONFIRM_PLAN(f.g), brief: "长官，您指哪两个人？", responseType: "ASK" }, { userMsg: "派其中两个去南线前哨" });
  assert.equal(h.confirmShortcut("对"), false, "nothing stored ⇒ the shortcut has nothing to execute");
  assert.equal(commands(f.state), before); assert.ok(noOrders(h));
});
test("刀寅 C8c 明确完整的确认方案（CONFIRM）＋「对」走捷径 ⇒ 执行存下的那份一次", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" });
  assert.equal(h.confirmShortcut("对"), true);
  assert.equal(h.applications.length, 1); assert.equal(destOfLast(h), "南线前哨");
  assert.equal(h.confirmShortcut("对"), false, "consumed once");
});
test("刀寅 C12 CONFIRM 但方案不完整（没说去哪）⇒ 不存", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn({ ...CONFIRM_PLAN(f.g), options: [{ label: "A", description: "", risk: 0, reward: 0, intents: [{ type: "attack", fromSquad: f.g, quantity: 2 }] }] });
  assert.ok(h.pendingContractRef.current === null); assert.ok(noOrders(h));
});

// ── 「两个变四个」：同一个数量被拆成几份 ──
const splitTwo = (g: string, q = "两个") => [
  { type: "defend", fromSquad: g, quantity: 2, unitType: "armor", targetFacility: SP, destinationQuote: "南线前哨", quantityQuote: q },
  { type: "defend", fromSquad: g, quantity: 2, unitType: "infantry", targetFacility: SP, destinationQuote: "南线前哨", quantityQuote: q },
];
const unitsOrdered = (h: ReturnType<typeof harness>) => h.results.reduce((n, r) => n + r.appliedUnitIds.length, 0);
const withTanks = (f: ReturnType<typeof gFixture>) => { for (let k = 0; k < 4; k++) f.state.units.get(f.group[k].id)!.type = "main_tank"; };
test("刀寅 N1 ★「派其中两个去南线前哨」被拆成坦克两个＋步兵两个 ⇒ 不派 4 个：零执行、问两种读法、不存方案（「对」不会执行任何一种）", () => {
  const f = gFixture(); const h = harness(f.state); withTanks(f);
  say(h, "派其中两个去南线前哨", splitTwo(f.g));
  assert.ok(noOrders(h));
  assert.match(h.screen.at(-1)!.text, /您说的「两个」——是一共 2 个，还是每种各 2 个（共 4 个）？/);
  assert.ok(h.audio.at(-1)!.includes("一共 2 个"), "the question is spoken too");
  assert.ok(h.pendingContractRef.current === null, "an open question is not a plan to nod through");
  assert.equal(h.confirmShortcut("对"), false); assert.ok(noOrders(h));
  // 长官答「一共两个」⇒ 下一轮模型写一条 ⇒ 派 2 个
  h.replyTurn();
  say(h, "一共两个", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: SP, destinationQuote: "南线前哨", quantityQuote: "两个" }]);
  assert.equal(unitsOrdered(h), 2);
});
test("刀寅 N1b（第六轮改写：旧的「紧接着一轮豁免」已删）长官答「每种各两个」而模型只是照旧拆成两条、没交选择 ⇒ 零执行再问；交回 by_type ⇒ 派 4 个；隔轮/换局答 ⇒ 零执行", () => {
  // ★测试调整（有意为之）：原 N1b 断言的是「问过一次，紧接着那一轮信模型」——交接档 §2 点名要删的设计
  //   （Codex 复现：答「一共两个」、模型照旧交两条 ⇒ 豁免放行 ⇒ 派 4 个）。现在数量读法是待决选择：
  //   执行的是按长官选的读法改写的原命令，模型那一轮写的单子不算数。
  const f = gFixture(); const h = harness(f.state); withTanks(f);
  say(h, "派其中两个去南线前哨", splitTwo(f.g));
  assert.equal(h.pendingSelectionRef.current?.kind, "quantity", "a real pending choice, not a one-shot question");
  h.replyTurn();
  say(h, "每种各两个", splitTwo(f.g));
  assert.equal(unitsOrdered(h), 0, "re-issuing the split is not an answer ⇒ still zero");
  h.answer("quantity:by_type");
  assert.equal(unitsOrdered(h), 4, "answered by_type ⇒ executes as he chose");
  // 隔了几轮、换了一局：旧问题不再能被答
  const f3 = gFixture(); const h3 = harness(f3.state); withTanks(f3);
  say(h3, "派其中两个去南线前哨", splitTwo(f3.g));
  h3.gameEpochRef.current++;
  const slot = h3.pendingSelectionRef.current;
  h3.deliver(overTheWire({ brief: "好。", options: [], dispatchSelection: { decision: "chose", candidate: "quantity:by_type" } }),
    { selectionId: slot.id, channel: slot.channel, sessionId: slot.sessionId });
  assert.equal(unitsOrdered(h3), 0, "new game ⇒ inert");
});
test("刀寅 N1-负对照：ef01bac 的真 handler 同一份单子 ⇒ 派出 4 个，必须红", () => {
  const f = gFixture(); const h = harness(f.state, stageSource); withTanks(f);
  const opt = (overTheWire({ brief: "x", responseType: "EXECUTE", options: [{ label: "A", description: "", risk: 0, reward: 0, intents: splitTwo(f.g) }] }).options as AdvisorOption[])[0];
  h.approve(opt, "派其中两个去南线前哨");
  assert.throws(() => assert.equal(unitsOrdered(h), 2), "old code sends four");
});
test("刀寅 N2 长官真说了两种各几个（「两辆坦克和两个步兵」各抄各的）⇒ 照派 4 个，不问", () => {
  const f = gFixture(); const h = harness(f.state); withTanks(f);
  const its = splitTwo(f.g); its[0].quantityQuote = "两辆坦克"; its[1].quantityQuote = "两个步兵";
  say(h, "派两辆坦克和两个步兵去南线前哨", its);
  assert.equal(unitsOrdered(h), 4);
});
test("刀寅 N3 同一个数说了两次 / 去处不同 / 数量不同（2＋1 是在分一个总数）/ 一个坦克一个步兵 ⇒ 都不问", () => {
  const f = gFixture(); const h = harness(f.state); withTanks(f);
  say(h, "两个坦克去南线前哨，两个步兵也去南线前哨", splitTwo(f.g));
  assert.equal(unitsOrdered(h), 4, "the number was said twice");
  const f2 = gFixture(); const h2 = harness(f2.state);
  say(h2, "两个去南线前哨，另外两个去南部战线", [
    { type: "defend", fromSquad: f2.g, quantity: 2, targetFacility: SP, destinationQuote: "南线前哨", quantityQuote: "两个" },
    { type: "defend", fromSquad: f2.g, quantity: 2, toFront: "front_south", destinationQuote: "南部战线", quantityQuote: "两个" }]);
  assert.equal(unitsOrdered(h2), 4, "different destinations");
  const f3 = gFixture(); const h3 = harness(f3.state); withTanks(f3);
  const three = splitTwo(f3.g, "三个"); three[1].quantity = 1;
  say(h3, "派其中三个去南线前哨", three);
  assert.equal(unitsOrdered(h3), 3, "2+1 distributes one total");
  const f4 = gFixture(); const h4 = harness(f4.state); withTanks(f4);
  const oneEach = splitTwo(f4.g); oneEach.forEach(it => { it.quantity = 1; });
  oneEach[0].quantityQuote = "一个坦克"; oneEach[1].quantityQuote = "一个步兵";
  say(h4, "派一个坦克一个步兵去南线前哨", oneEach);
  assert.equal(unitsOrdered(h4), 2, "1+1 said separately");
});
test("刀寅 N3b「派其中一个」被拆成坦克一个＋步兵一个 ⇒ 问", () => {
  const f = gFixture(); const h = harness(f.state); withTanks(f);
  const its = splitTwo(f.g, "一个"); its.forEach(it => { it.quantity = 1; });
  say(h, "派其中一个去南线前哨", its);
  assert.ok(noOrders(h)); assert.match(h.screen.at(-1)!.text, /是一共 1 个，还是每种各 1 个（共 2 个）/);
});
test("刀寅 N4 缺 quantityQuote / 抄的不在原话里 ⇒ 同样先问（不再放行），问句不冒充长官的原话", () => {
  const f = gFixture(); const h = harness(f.state); withTanks(f);
  say(h, "派其中两个去南线前哨", splitTwo(f.g).map(({ quantityQuote, ...rest }) => rest));
  assert.ok(noOrders(h)); assert.match(h.screen.at(-1)!.text, /这道令给2种兵各写了 2 个——是一共 2 个/);
  assert.doesNotMatch(h.screen.at(-1)!.text, /您说的/);
  const f2 = gFixture(); const h2 = harness(f2.state); withTanks(f2);
  say(h2, "派其中两个去南线前哨", splitTwo(f2.g, "两辆"));
  assert.ok(noOrders(h2)); assert.doesNotMatch(h2.screen.at(-1)!.text, /您说的/);
});

// ── 审核 B：一次只挂一个问题（存下的方案只认紧接着的那一句答复）──
const OTHER_TOPIC = { brief: "北线敌军在集结，要不要先把北线加强一下？", responseType: "ASK", recommended: "A", urgency: 0.4, options: [], pendingDecision: null };
/** 变异源码：把本轮加的某一处拿掉，证明对应的测试真能抓住它。 */
function mutated(from: string, to: string) {
  assert.ok(source.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`);
  return source.replace(from, to);
}
const TURN_CHECK = "      pc.createdTurn !== replyTurnOf(pc.channel) ||\n";
const UNRELATED_CLEAR = "if (pcSameEpoch && pendingTag && pcSameEpoch.id === pendingTag.pendingId) pendingContractRef.current = null;";
function staleByTopicChange(src = source) {
  const f = gFixture(); const h = harness(f.state, src);
  h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" });
  assert.ok(h.pendingContractRef.current);
  h.turn(OTHER_TOPIC, { pendingTag: h.pendingTagNow(), userMsg: "北线现在怎么样？" });
  const shortcut = h.confirmShortcut("对");
  return { f, h, shortcut };
}
test("刀寅 B1 ★审核反例 A：存了方案 → 长官换话题 → 陈问了别的 →「对」⇒ 不执行旧方案", () => {
  const { h, shortcut } = staleByTopicChange();
  assert.equal(shortcut, false); assert.ok(noOrders(h));
  assert.ok(h.pendingContractRef.current === null, "unrelated ⇒ the old plan is dropped");
  assert.ok(h.pendingTagNow() === null, "and the next request carries no contract tag");
});
test("刀寅 B1-负对照：拿掉「无关就作废」和「翻篇就作废」两处 ⇒ 旧方案被「对」执行，必须红", () => {
  const src = mutated(UNRELATED_CLEAR, "").replace(TURN_CHECK, "");
  const { h } = staleByTopicChange(src);
  assert.throws(() => assert.ok(noOrders(h)), "without the fix the stale plan runs");
});
test("刀寅 B2 模型没交判词（协议失败）/ 这一轮根本没带合同标签 / 之后来了新请示 ⇒ 旧方案都不再能被「对」消费", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" });
  h.turn({ ...OTHER_TOPIC, pendingDecision: undefined }, { pendingTag: h.pendingTagNow(), userMsg: "嗯……" });
  assert.equal(h.confirmShortcut("对"), false); assert.ok(noOrders(h));
  // 没带标签的一轮（例如长官那句发出去时合同还没登记）：轮次一过，照样作废
  const f2 = gFixture(); const h2 = harness(f2.state);
  h2.turn(CONFIRM_PLAN(f2.g), { userMsg: "派其中两个去南线前哨" });
  h2.turn(OTHER_TOPIC, { userMsg: "北线现在怎么样？" });
  assert.equal(h2.confirmShortcut("对"), false); assert.ok(noOrders(h2));
  // 新请示比方案新 ⇒ 「对」答的是请示，不是方案
  const f3 = gFixture(); const h3 = harness(f3.state);
  h3.turn(CONFIRM_PLAN(f3.g), { userMsg: "派其中两个去南线前哨" });
  f3.state.time += 5; h3.escalation.current = { actionId: "esc-1", createdAt: f3.state.time };
  assert.equal(h3.confirmShortcut("对"), false); assert.ok(noOrders(h3));
  // 对照：请示比方案旧 ⇒ 方案仍然有效（不是一刀切）
  const f4 = gFixture(); const h4 = harness(f4.state);
  h4.escalation.current = { actionId: "esc-0", createdAt: f4.state.time };
  f4.state.time += 5;
  h4.turn(CONFIRM_PLAN(f4.g), { userMsg: "派其中两个去南线前哨" });
  assert.equal(h4.confirmShortcut("对"), true); assert.equal(lastApplied(h4, "i0").length, 2);
  // 同一次回复重复投递不算"又答了一轮"
  const f5 = gFixture(); const h5 = harness(f5.state);
  h5.turn(CONFIRM_PLAN(f5.g), { userMsg: "派其中两个去南线前哨", traceId: "same-reply" });
  h5.replyTurn("same-reply");
  assert.equal(h5.confirmShortcut("对"), true, "a duplicate delivery of the same reply is not a new turn");
});
test("刀寅 B2-负对照：拿掉「翻篇就作废」⇒ 没带标签那一轮之后「对」仍执行旧方案，必须红", () => {
  const f = gFixture(); const h = harness(f.state, mutated(TURN_CHECK, ""));
  h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" });
  h.turn(OTHER_TOPIC, { userMsg: "北线现在怎么样？" });
  h.confirmShortcut("对");
  assert.throws(() => assert.ok(noOrders(h)));
});
function planThenSelectionQuestion(src = source) {
  const f = fixture(); const h = harness(f.state, src);
  const g = core.mintSpokenForce(f.state, null, { label: "路边那一个", memberIds: [f.bystander.id], etaSec: 30 })!;
  h.turn({ ...CONFIRM_PLAN(g), options: [{ label: "A", description: "", risk: 0.2, reward: 0.4,
    intents: [{ type: "defend", fromSquad: g, quantity: 1, targetFacility: "ea_player_south_post" }] }] }, { userMsg: "派路边那一个去南线前哨" });
  assert.ok(h.pendingContractRef.current, "a plan is waiting for a nod");
  h.approve(option([f.south.retreat]));
  assert.ok(h.pendingSelectionRef.current, "now Chen asks which batch");
  const shortcut = h.confirmShortcut("对");
  return { f, h, shortcut };
}
test("刀寅 B3 ★审核反例 B：存了方案 → 陈接着问「是哪一批 / 是这一批吗」→「对」⇒ 不执行旧方案（「对」答的是选兵问题）", () => {
  const { f, h, shortcut } = planThenSelectionQuestion();
  assert.equal(shortcut, false); assert.ok(noOrders(h));
  assert.equal(f.bystander.orders.length, 0, "the old plan's unit never moves");
  assert.ok(h.pendingContractRef.current === null);
});
test("刀寅 B3-负对照：拿掉「问选兵就作废旧方案」⇒ 旧方案被「对」执行，必须红", () => {
  const { f } = planThenSelectionQuestion(mutated(
    "    // 刀寅（审核 B）：一次只挂一个问题——这一问一出，之前等着点头的方案作废。\n    pendingContractRef.current = null;\n", ""));
  assert.throws(() => assert.equal(f.bystander.orders.length, 0));
});
test("刀寅 B4 这个频道刚真办了一道令 ⇒ 之前挂着的方案作废；存方案时清掉旧的选兵问题", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g), { userMsg: "派其中两个去南线前哨" });
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 1, targetFacility: "ea_repair_station" }], "先派一个去野战修理厂");
  assert.ok(h.pendingContractRef.current === null, "execution on the channel drops the waiting plan");
  const f2 = fixture(); const h2 = harness(f2.state);
  h2.approve(option([f2.south.retreat]));
  assert.ok(h2.pendingSelectionRef.current);
  const g = core.mintSpokenForce(f2.state, null, { label: "路边那一个", memberIds: [f2.bystander.id], etaSec: 30 })!;
  h2.turn({ ...CONFIRM_PLAN(g), options: [{ label: "A", description: "", risk: 0.2, reward: 0.4,
    intents: [{ type: "defend", fromSquad: g, quantity: 1, targetFacility: "ea_player_south_post" }] }] }, { userMsg: "算了，派路边那一个去南线前哨" });
  assert.ok(h2.pendingContractRef.current); assert.ok(h2.pendingSelectionRef.current === null, "one question at a time");
});

// ── 审核 C：引擎提出的修正方案要带着已经选好的那一批 ──
function narrowedAfterSelection(src = source, kill = false) {
  const f = fixture(); const h = harness(f.state, src);
  // 一道令两条：南线撤回（要问是哪一批）＋ 北线抽 1 个去北部战线设防（长官原话说的是北线前哨）
  const defend = { type: "defend", fromFront: "front_coastal", quantity: 1, toFront: "front_coastal", destinationQuote: "北线前哨" } as Intent;
  const opt = option([f.south.retreat, defend]);
  h.approve(opt, "南线的撤回南线前哨，北线抽一个去北线前哨设防");
  h.answer(picked(h, "dispatch:"));      // 南线：选外派出去的那一批
  if (h.pendingSelectionRef.current) h.answer(picked(h, "stay:")); // 北线：选留守的
  assert.ok(noOrders(h), "narrowed ⇒ asks first");
  assert.match(h.screen.at(-1)!.text, /按北线前哨办吗/);
  assert.ok(h.pendingContractRef.current?.selection, "the proposal carries the selection");
  if (kill) for (const u of f.south.sent) { u.hp = 0; u.state = "dead"; }
  h.confirmShortcut("对");
  return { f, h };
}
test("刀寅 C13 ★审核 C：选完兵后引擎提出「按北线前哨办吗」→「对」⇒ 用的仍是长官选的那一批，不退回按战线挑人", () => {
  const { f, h } = narrowedAfterSelection();
  assert.equal(h.applications.length, 1);
  assert.deepEqual(applied(h, "i0"), ids(f.south.sent), "the batch he picked, not the stay-behind");
  assert.equal(f.south.stay.orders.length, 0);
  assert.deepEqual(applied(h, "i1"), [f.north.stay.id]);
  const np = f.state.facilities.get("ea_player_coastal_post")!.position;
  for (const [id, p] of lastTargets(h)) if (id === f.north.stay.id) assert.ok(near(p, np, 3), `named post: ${JSON.stringify(p)}`);
});
test("刀寅 C13b 那一批在等点头时全灭 ⇒ 明说、整道零执行，绝不换成战线上别的人", () => {
  const { f, h } = narrowedAfterSelection(source, true);
  assert.ok(noOrders(h)); assert.equal(f.south.stay.orders.length, 0);
  assert.match(h.screen.at(-1)!.text, /先前选定的那一批已经不在了/);
});
test("刀寅 C13-负对照：执行存下的方案时不带选兵记录 ⇒ 选过的那一批丢了（重新问 / 换人），必须红", () => {
  const src = mutated("handleApprove(pc.opt, 0, \"auto\", pc.execCtx, pc.data, true, pc.selection);",
    "handleApprove(pc.opt, 0, \"auto\", pc.execCtx, pc.data, true);");
  const { f, h } = narrowedAfterSelection(src);
  assert.throws(() => assert.deepEqual(applied(h, "i0"), ids(f.south.sent)));
});

// ── 起点的生命周期（审核复现：按分队名连叫两次，第二次回半路）──
test("刀寅 O12 ★按分队名连叫两次回原处：两次都回真正的出发位置，第二次不回半路", () => {
  const { f, h, sent, home } = sentHalfway();
  f.state.squads.push({ id: "T8", role: "leader", ownerCommander: "chen", unitIds: sent } as shared.Squad);
  modelOrder(h, [{ type: "retreat", fromSquad: "T8", returnTo: "origin" }], "T8 回来");
  for (const id of sent) assert.ok(near(lastTargets(h).get(id), home.get(id)!), "first recall");
  for (const id of sent) f.state.units.get(id)!.position = { x: 372, y: 75 }; // 夹具：往回走了一段
  modelOrder(h, [{ type: "retreat", fromSquad: "T8", returnTo: "origin" }], "T8 回来");
  const rec = f.state.dispatches.find(d => d.status === "active" && d.memberIds.includes(sent[0]))!;
  for (const id of sent) assert.ok(near(rec.originPosById![id], home.get(id)!, 0.01), "start not rewritten to the halfway point");
  for (const id of sent) assert.ok(near(lastTargets(h).get(id), home.get(id)!), "second recall still goes home");
});
test("刀寅 O13 刚出发一步就改令（离起点不到三格）：起点不漂", () => {
  const f = gFixture(); const h = harness(f.state);
  modelOrder(h, [two(f.g, { targetFacility: "ea_repair_station" })]);
  const sent = lastApplied(h, "i0");
  const start = new Map(sent.map(id => [id, { ...f.state.units.get(id)!.position }]));
  for (const id of sent) { const u = f.state.units.get(id)!; u.position = { x: u.position.x + 1, y: u.position.y + 1 }; } // 夹具：刚走了一步
  f.state.squads.push({ id: "T7", role: "leader", ownerCommander: "chen", unitIds: sent } as shared.Squad);
  modelOrder(h, [{ type: "defend", fromSquad: "T7", targetFacility: SP }]);
  const rec = f.state.dispatches.find(d => d.status === "active" && d.memberIds.includes(sent[0]))!;
  for (const id of sent) assert.ok(near(rec.originPosById![id], start.get(id)!, 0.01), `start stays exactly where they left: ${JSON.stringify(rec.originPosById![id])}`);
});
test("刀寅 O14 到了目的地之后再接别的令＝新的一次外派（起点是到达的地方）；到达后直接叫回仍回最初出发地", () => {
  const f = gFixture(); const h = harness(f.state);
  modelOrder(h, [two(f.g, { targetFacility: "ea_repair_station" })]);
  const sent = lastApplied(h, "i0");
  const start = new Map(sent.map(id => [id, { ...f.state.units.get(id)!.position }]));
  const arrive = () => { for (const id of sent) { const u = f.state.units.get(id)!; u.position = { ...u.orders[0].target! }; } };
  arrive(); // 夹具：到了修理厂
  const m = f.state.dispatches.find(d => d.status === "active")!.id;
  modelOrder(h, [{ type: "retreat", fromDispatch: m, returnTo: "origin" }]);
  for (const id of sent) assert.ok(near(lastTargets(h).get(id), start.get(id)!), "recall after arrival ⇒ original start");
  const f2 = gFixture(); const h2 = harness(f2.state);
  modelOrder(h2, [two(f2.g, { targetFacility: "ea_repair_station" })]);
  const sent2 = lastApplied(h2, "i0");
  for (const id of sent2) { const u = f2.state.units.get(id)!; u.position = { ...u.orders[0].target! }; }
  const atRepair = new Map(sent2.map(id => [id, { ...f2.state.units.get(id)!.position }]));
  const m2 = f2.state.dispatches.find(d => d.status === "active")!.id;
  modelOrder(h2, [{ type: "defend", fromDispatch: m2, targetFacility: SP }]); // 到了之后派去别处＝新一次外派
  for (const id of sent2) f2.state.units.get(id)!.position = { x: 380, y: 130 };
  const m3 = f2.state.dispatches.find(d => d.status === "active")!.id;
  modelOrder(h2, [{ type: "retreat", fromDispatch: m3, returnTo: "origin" }]);
  for (const id of sent2) assert.ok(near(lastTargets(h2).get(id), atRepair.get(id)!), "recall ⇒ where this outing started (the repair station)");
});

test("刀寅 F8 多余的「是的」让模型把已办的单子重发成只到战线：不重派，回执说的是他们**正在去**的北线前哨", () => {
  const f = gFixture(); const h = harness(f.state);
  for (const u of f.group) u.position = { x: 360 + (u.id % 4), y: 105 + Math.floor((u.id % 8) / 4) }; // 夹具：这一群在中央前哨
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: "ea_player_coastal_post" }], "派其中两个去北线前哨");
  const sent = lastApplied(h, "i0");
  modelOrder(h, [{ type: "defend", fromSquad: f.g, quantity: 2, toFront: "front_coastal" }], "是的");
  assert.deepEqual(lastApplied(h, "i0"), [], "no re-dispatch");
  assert.deepEqual(lastTouched(h, "i0"), sent);
  const line = h.screen.at(-1)!.text;
  assert.match(line, /已经在前往北线前哨设防了/); assert.doesNotMatch(line, /北部战线/);
});
test("刀寅 C10 ★「批准」却带着动作不同的新单子（存的是去南线前哨设防，回复里是撤退）⇒ 零执行；旧方案作废（之后一句「对」不会执行设防）", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g)); const tag = h.pendingTagNow(); const before = commands(f.state);
  h.turn({ brief: "撤。", responseType: "EXECUTE", recommended: "A", urgency: 0.6, pendingDecision: "authorize",
    options: [{ label: "A: 快撤", description: "", risk: 0.2, reward: 0.2, intents: [{ type: "retreat", fromSquad: f.g }] }] },
  { pendingTag: tag, userMsg: "刚才那两个快撤" });
  assert.equal(commands(f.state), before, "neither the captured defend nor the new retreat ran");
  assert.equal(h.applications.length, 0);
  // 审核 B：判不清也算参谋又开了口——一次只挂一个问题，旧方案作废，长官要撤就再说一次撤。
  assert.ok(h.pendingContractRef.current === null, "the contradicted plan is dropped, not kept for a later 「对」");
  assert.equal(h.confirmShortcut("对"), false); assert.equal(h.applications.length, 0);
  assert.ok(h.traces.some(t => t.stage === "pending" && t.data.judged === "authorize" && t.data.verdict === "protocol_failure"));
});
test("刀寅 C10-负对照：去掉矛盾判定，同一份回复会执行存下的设防（玩家要的是撤）", () => {
  // 第六轮起判定换成 core 的实质比较；第七轮改名 contractReplyConflict（authorize 要求每一张都一致）。
  const f = gFixture();
  assert.equal(shared.pendingVerdictRoute("authorize").executeOldContract, true);
  assert.deepEqual(core.contractReplyConflict(f.state, { intents: [{ type: "defend" } as Intent] }, "authorize", [{ intents: [{ type: "retreat" }] }]),
    { kind: "authorize_changed", differences: ["动作"] });
  assert.equal(core.contractReplyConflict(f.state, { intents: [{ type: "defend", quantity: 2 } as Intent] }, "authorize", [{ intents: [{ type: "defend" }] }]), null,
    "an echo that omits fields is not a change");
});
test("刀寅 C11 「批准」且回复原样复述存下的方案 ⇒ 照存下的执行一次", () => {
  const f = gFixture(); const h = harness(f.state);
  h.turn(CONFIRM_PLAN(f.g)); const tag = h.pendingTagNow();
  const echo = { ...CONFIRM_PLAN(f.g), responseType: "EXECUTE", pendingDecision: "authorize" };
  h.turn(echo, { pendingTag: tag, userMsg: "行" });
  assert.equal(h.applications.length, 1); assert.equal(destOfLast(h), "南线前哨");
});
// ── 真模拟：叫回原处之后到位设防、不掉头回旧任务（含 processAutoBehavior）──
test("刀寅 S1 ★真模拟：派出 2 个 → 半路叫回 → 回到各自出发位置、转设防、之后 60 秒不掉头", () => {
  const f = gFixture(); const h = harness(f.state);
  for (const u of [...f.state.units.values()]) if (u.team === "enemy") f.state.units.delete(u.id); // 夹具：清掉敌人，只看行军与到位
  const { sent } = sendTwoNoMove(f, h);
  const home = new Map(sent.map(id => [id, { ...f.state.units.get(id)!.position }]));
  simPump(f.state, 20);
  for (const id of sent) assert.ok(!near(f.state.units.get(id)!.position, home.get(id)!, 3), "they actually left");
  modelOrder(h, [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }]);
  assert.deepEqual(lastApplied(h, "i0"), sent);
  simPump(f.state, 150);
  for (const id of sent) {
    const u = f.state.units.get(id)!;
    assert.ok(near(u.position, home.get(id)!, 3), `unit ${id} back home: ${JSON.stringify(u.position)} vs ${JSON.stringify(home.get(id))}`);
    assert.equal(u.state, "defending", `unit ${id} holds on arrival (${u.state})`);
  }
  simPump(f.state, 60);
  for (const id of sent) assert.ok(near(f.state.units.get(id)!.position, home.get(id)!, 3), "no turn-back to the old task");
});

// Fixed historical production code, not "delete an assertion" controls.
// They use the same real handlers and the same assertions above; both old bugs must fail.
const oldSource = execFileSync("git", ["show", "7a5ee05:apps/web/src/ChatPanel.tsx"], {
  cwd: new URL("..", import.meta.url), encoding: "utf8",
});
test("负对照：7a5ee05 的双 stay 真实 handler 必须被同一测试抓红", () => {
  assert.throws(() => doubleStay(oldSource), /must not ask first question again/);
});
test("负对照：7a5ee05 的 G-ticket 真实 handler 必须被同一测试抓红", () => {
  assert.throws(() => ticketFirst(oldSource), /G handle and target must not mutate/);
});
test("负对照：把旧的「二次原始解析」装回消费端 ⇒ 玩家原话那条必须在「进第二问」处红", () => {
  const reParse: typeof core.planSelectionTurn = (args) =>
    core.planSelectionTurn({ ...args, decision: shared.parseSelectionDecision(args.decision) });
  assert.throws(() => doubleSent(reParse), /must proceed to second question/);
});

// ── 两条真实传输路：/api/command（callAdvisor）与 SSE（callAdvisorStream）──
// 用假 fetch 回固定的模型回包，服务端解析、校验、normalize、序列化全走生产代码；
// 再把两条路各自交出的对象喂给生产客户端分支。
// （脚本按 CJS 执行、不支持顶层 await，所以这一段包在 async 函数里。）
async function transports(): Promise<void> {
  process.env.LLM_PROFILE = ""; process.env.LLM_PROFILE_COMBAT = "";
  process.env.LLM_PROVIDER = "deepseek"; process.env.DEEPSEEK_API_KEY = "stub-key";
  process.env.LLM_BASE_URL = "http://stub.invalid/v1";
  const ai = await import("../apps/server/src/ai");
  const realFetch = globalThis.fetch;
  let modelJson = "";
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const wantsStream = !!init?.body && JSON.parse(init.body).stream === true;
    if (!wantsStream) {
      return new Response(JSON.stringify({ choices: [{ message: { content: modelJson } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const text = `明白，就撤那一批。\n---JSON---\n${modelJson}`;
    const chunks = [text.slice(0, 7), text.slice(7)].map(c =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(chunks)); ctl.close(); } }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const shapes: Record<string, unknown> = {};
    for (const route of ["command", "stream"] as const) {
      const f = fixture(); const h = harness(f.state);
      h.approve(option([f.south.retreat, f.north.retreat]));
      const answerVia = async (key: string) => {
        modelJson = JSON.stringify({ brief: "明白，就撤那一批。", options: [], responseType: "NOOP",
          dispatchSelection: { decision: "chose", candidate: key } });
        let delivered: Record<string, unknown> | null = null;
        if (route === "command") {
          const r = await ai.callAdvisor("DIGEST", "派出去的那批", "style", "combat");
          delivered = JSON.parse(JSON.stringify(r.warning ? { ...r.data, warning: r.warning } : r.data));
        } else {
          for await (const ev of ai.callAdvisorStream("DIGEST", "派出去的那批", "style", "combat")) {
            if (ev.type === "options") delivered = JSON.parse(JSON.stringify(ev.content));
          }
        }
        assert.ok(delivered, `${route}: no options payload`);
        shapes[route] = delivered!.dispatchSelection;
        const slot = h.pendingSelectionRef.current;
        h.deliver(delivered!, { selectionId: slot.id, channel: slot.channel, sessionId: slot.sessionId });
      };
      await answerVia(picked(h, "dispatch:")!);
      assert.equal(h.pendingSelectionRef.current?.intentIndex, 1, `${route}: must proceed to second question`);
      await answerVia(picked(h, "dispatch:")!);
      assert.ok(h.pendingSelectionRef.current === null, `${route}: must not ask first question again`);
      assert.deepEqual(applied(h, "i0"), f.south.sent.map(u => u.id).sort((a, b) => a - b), `${route}: south`);
      assert.deepEqual(applied(h, "i1"), f.north.sent.map(u => u.id).sort((a, b) => a - b), `${route}: north`);
      count++; console.log(`PASS 传输路 ${route === "command" ? "/api/command" : "SSE /api/command-stream"}：真服务端解析 → 真客户端分支 ⇒ 两问都过、只调两批外派`);
    }
    assert.deepEqual(shapes.command, shapes.stream, "both transports deliver the same dispatchSelection shape");
    count++; console.log(`PASS 两条传输路交给浏览器的 dispatchSelection 形状完全相同：${JSON.stringify(shapes.command)}`);

    // 刀寅：新增的 destinationQuote / returnTo 在两条真实服务端路上都不丢
    modelJson = JSON.stringify({ brief: "办。", responseType: "EXECUTE", recommended: "A", urgency: 0.5,
      options: [{ label: "A", description: "", risk: 0, reward: 0, intents: [
        { type: "defend", fromSquad: "G1", quantity: 2, toFront: "front_south", destinationQuote: "南线前哨", quantityQuote: "两个" },
        { type: "retreat", fromDispatch: "M1", returnTo: "origin" }] }] });
    const got: Record<string, unknown> = {};
    const r1 = await ai.callAdvisor("DIGEST", "派两个去南线前哨", "style", "combat");
    got.command = JSON.parse(JSON.stringify(r1.data)).options[0].intents;
    for await (const ev of ai.callAdvisorStream("DIGEST", "派两个去南线前哨", "style", "combat")) {
      if (ev.type === "options") got.stream = JSON.parse(JSON.stringify(ev.content)).options[0].intents;
    }
    for (const route of ["command", "stream"]) {
      const it = got[route] as Record<string, unknown>[];
      assert.equal(it[0].destinationQuote, "南线前哨", `${route}: destinationQuote survived`);
      assert.equal(it[0].quantityQuote, "两个", `${route}: quantityQuote survived`);
      assert.equal(it[1].returnTo, "origin", `${route}: returnTo survived`);
    }
    count++; console.log("PASS 传输路：destinationQuote / quantityQuote / returnTo 经 /api/command 与 SSE 都原样到浏览器");
  } finally {
    globalThis.fetch = realFetch;
  }
}

transports().then(
  () => console.log(`ALL PASS (${count} production-chain scenarios, including ${negCount} negative controls)`),
  (e) => { console.error(e); process.exit(1); },
);
