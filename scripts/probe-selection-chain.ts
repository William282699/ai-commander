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
import { isKnownLocation, isValidTarget } from "../apps/web/src/autoExecuteGate";
import { buildExecReceipt, buildExecFeedback } from "../apps/web/src/execReceipt";
import { cloneSelectionOption, optionWithResolvedIntents } from "../apps/web/src/selectionOption";

const panelPath = new URL("../apps/web/src/ChatPanel.tsx", import.meta.url);
const source = readFileSync(panelPath, "utf8");

function declaration(src: string, name: string): string {
  const sf = ts.createSourceFile("ChatPanel.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = "";
  function visit(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n.getText(sf);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = `const ${n.getText(sf)};`;
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  assert.ok(found, `production declaration missing: ${name}`);
  return found;
}

/** Extract the complete real selection-response branch, including lifecycle and reask wiring. */
function selectionIngress(src: string): string {
  const text = declaration(src, "processAdvisorData");
  const sf = ts.createSourceFile("ingress.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
  const body = (decl.initializer as ts.ArrowFunction).body as ts.Block;
  const statements = body.statements.map(s => s.getText(sf));
  const start = statements.findIndex(s => s.startsWith("const selSlotAtJudge ="));
  const end = statements.findIndex(s => s.startsWith('if (selTurn.plan.kind !== "passthrough")'));
  assert.ok(start >= 0 && end > start, "production selection ingress structure changed");
  return `const answerResponse = (data, selectionTag) => {
    const state = getState(); const ch = getActiveChannel();
    ${statements.slice(start, end + 1).join("\n")}
  };`;
}

const noop = () => {};
/**
 * ★线上传输的真实边界：模型原始 JSON → **生产** `validateAdvisorResponse`
 * → `JSON.stringify` / `JSON.parse`（SSE 的 `res.write(JSON.stringify(event))`
 * 与 `/api/command` 的 `res.json(result.data)` 都是这一步）→ 浏览器收到的对象。
 *
 * 旧 `answer()` 直接把**模型原始格式**塞给客户端分支，**绕过了这一层**——
 * 于是 schema 把 `{decision,candidate}` 规范成 `{kind,candidateKey}`、core 又拿
 * 原始 parser 再解析一遍、得到 undefined 的那个 bug，台架一条都看不见，
 * 玩家实测却连答两次「派出去的那批」都被判协议失败、重复第一问。
 * 这里不手写"等价 schema"，也不在交给客户端前偷偷转回原始格式。
 */
function overTheWire(rawModelResponse: Record<string, unknown>): Record<string, unknown> {
  const validated = shared.validateAdvisorResponse(rawModelResponse);
  assert.ok(validated, "production schema rejected the model response");
  return JSON.parse(JSON.stringify(validated));
}

function harness(
  state: GameState,
  src = source,
  channel = "combat",
  /** 负对照注入口：替换 core 的 planSelectionTurn（默认就是生产实现）。 */
  planOverride?: typeof core.planSelectionTurn,
) {
  const screen: Array<{ level: string; text: string }> = [];
  const context: string[] = [];
  const audio: string[] = [];
  const applications: Order[][] = [];
  const results: shared.ApplyResult[] = [];
  const doctrineSources: unknown[] = [];
  const burned: string[] = [];
  const pendingSelectionRef = { current: null as any };
  const response = { recommended: "B", options: [], standingOrder: { type: "must_hold" } };
  const execCtx = { channel, requestId: "test", run: shared.stampRun(0, state) };
  let lastDecision: ReturnType<typeof core.planSelectionTurn>;
  let serial = 0;
  const deps = {
    ...core, ...shared, isKnownLocation, isValidTarget,
    buildExecReceipt, buildExecFeedback, cloneSelectionOption, optionWithResolvedIntents,
    getState: () => state, getActiveChannel: () => channel, response,
    responseExecCtxRef: { current: execCtx }, gameEpochRef: { current: 0 },
    selectedIdsSnapshotRef: { current: undefined }, pendingSelectionRef,
    pendingGroupResponsesRef: { current: [] }, latestRequestIdRef: { current: "test" },
    bareConfirmExecRef: { current: null }, channelContextRef: { current: {} },
    SESSION_ID: "test-session", makePendingId: () => `selection-${++serial}`,
    setResponse: noop, setError: noop, setClarification: noop, setApprovedIdx: noop,
    ttsEnabled: true, setTimeout: noop, crypto: globalThis.crypto,
    pickVoiceConfirm: () => "收到。", resolveThread: noop,
    sayToEar: () => ({ speakExecReceipt: true }),
    planSelectionTurn: (args: Record<string, unknown>) => {
      // 历史负对照兼容：7a5ee05 的 handler 用旧参数名 `rawDecision` 递同一份数据。
      // 那两条对照要证明的是**旧 handler 的逻辑病**（双问回头 / G 票被改），
      // 所以这里只把参数名接上，让解析层正常工作，病才归因得到 handler 头上。
      const a = ("decision" in args ? args : { ...args, decision: args.rawDecision }) as
        Parameters<typeof core.planSelectionTurn>[0];
      lastDecision = (planOverride ?? core.planSelectionTurn)(a); return lastDecision;
    },
    addMessage: (level: string, text: string) => screen.push({ level, text }),
    pushContext: (_c: unknown, _ch: string, entry: { text: string }) => context.push(entry.text),
    speak: (text: string) => audio.push(text), flush: noop,
    processDoctrineFields: (data: unknown) => doctrineSources.push(data),
    applyOrders: (s: GameState, orders: Order[]) => {
      applications.push(structuredClone(orders));
      const result = core.applyOrders(s, orders);
      results.push(result);
      return result;
    },
    burnEscalationTicket: (g: string) => { burned.push(g); core.burnEscalationTicket(g); },
  };
  // Constants and closure functions are taken verbatim from the current production file.
  const names = ["COMMANDERS", "COMMANDER_CHANNEL", "COMMANDER_META", "COMMANDER_REFS",
    "HIGH_IMPACT_CONFIRM_WINDOW_SEC", "softFixTargetFields", "dispatchSourceOf",
    "refuseAloud", "askWhichDispatch", "handleApprove"];
  const js = ts.transpileModule(names.map(n => declaration(src, n)).join("\n") + "\n" + selectionIngress(src), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const external = Object.entries(deps).filter(([name]) => !names.includes(name));
  const api = new Function(...external.map(([name]) => name), `${js}\nreturn { handleApprove, answerResponse };`)(...external.map(([, value]) => value));
  const approve = (opt: AdvisorOption) => api.handleApprove(opt, 1, "auto", execCtx, response, true);
  // ★测试输入调整（有意为之，理由写明）：原先绕过了真实服务端边界。
  //   现在只构造**模型原始回包**，其余一律走生产代码：
  //   原始 JSON → validateAdvisorResponse → JSON 往返 → 客户端选择分支 → core → 主链。
  //   `extraOptions` 非空 ⇒ 覆盖 schema 的"非空 options"那条 return 路径，并顺带
  //   验证"回答轮另带的 options 不许造成第二次执行"。
  const answer = (key?: string, unclear = false, extraOptions: unknown[] = []) => {
    const slot = pendingSelectionRef.current;
    assert.ok(slot, "answer requires an actual pending question");
    const raw = {
      brief: unclear ? "您指哪一批？" : "明白，就撤那一批。",
      options: extraOptions,
      dispatchSelection: unclear ? { decision: "unclear" } : { decision: "chose", candidate: key },
    };
    api.answerResponse(overTheWire(raw),
      { selectionId: slot.id, channel: slot.channel, sessionId: slot.sessionId });
    return lastDecision;
  };
  return { approve, answer, deliver: api.answerResponse, pendingSelectionRef, screen, context, audio, applications, results, burned, doctrineSources, response };
}

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
function test(name: string, fn: () => void) {
  fn(); count++; console.log(`PASS ${name}`);
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
  } finally {
    globalThis.fetch = realFetch;
  }
}

transports().then(
  () => console.log(`ALL PASS (${count} production-chain scenarios, including 3 negative controls)`),
  (e) => { console.error(e); process.exit(1); },
);
