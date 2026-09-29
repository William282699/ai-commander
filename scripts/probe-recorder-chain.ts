/**
 * 试玩记录仪 Step 2：答复 → 原方案 → 实际执行，从导出包里追得回来。
 * 运行：node --import tsx scripts/probe-recorder-chain.ts
 *
 * 三条**非快捷**路径（模型语义批准、数量选择、候选部队选择）＋ 快捷「对」对照，每条都：
 *   长官打字 → 生产 sendCommand（真 HTTP、带记录头）→ 生产服务端路由（假模型）→ 生产
 *   processAdvisorData / handleApprove / applyOrders；浏览器侧 trace 经生产记录器上传；
 *   → 管理员导出 ZIP → **只凭包里的记录**从答复的回合追到 pendingId/selectionId、原方案回合、
 *   实际接令的单位，并与游戏里真接到命令的单位逐个对上。
 * 负对照：把这次补的关联字段从 ChatPanel 源码里拿掉（其余一字不动）⇒ 同一条追踪断在“答复 → 原方案”那一环。
 */
import assert from "node:assert/strict";
import * as core from "@ai-commander/core";
import { harness, source } from "./chainHarness";
import { test, mustFail, rm, summary } from "./recorder-test-lib";
import {
  recordingServer, browserFetch, drainRecorder, parseJsonl, followReply, mixedGroup, southStayAndSent,
  CONFIRM, authorizeEcho, order, choose, splitTwo, reply, realFetch, NP,
} from "./recorder-chain-lib";
import { activateRecorder, recordTrace, recorderHeaders, recordStartRun, recorderStatus } from "../apps/web/src/recorder/index";
import { MemoryBackend } from "../apps/web/src/recorder/queue";
import type { LlmStep } from "./chainHarness";

/** 生产 traceClient ＝ recordTrace ＋ 仅开发构建才发的本地对账请求（node 里不是开发构建，即等于 recordTrace）。 */
const traceClient = (id: unknown, stage: string, d: Record<string, unknown>, run?: unknown, turnFrom?: "current") => recordTrace(id, stage, d, run, turnFrom);

/** 这次补的关联字段（Step 2 前置要求）。负对照把它们从源码里拿掉，模拟补之前的调用点。 */
const LINK_FIELDS = [
  ", contractId: pcSameEpoch?.id ?? null, planTraceId: pcSameEpoch?.execCtx.traceId ?? null",
  ", selectionId: selTagThisTurn.selectionId, slotId: selSlotAtJudge?.id ?? null, planTraceId: selSlotAtJudge?.execCtx?.traceId ?? null",
  ", selectionId: slot.id, planTraceId: slot.execCtx?.traceId ?? null",
  ", selectionId: pendingSelectionRef.current?.id, planTraceId: execCtx?.traceId ?? null",
];
function withoutLinkFields(src: string): string {
  let out = src;
  for (const f of LINK_FIELDS) {
    assert.ok(out.includes(f), `link field present in production source: ${f.slice(0, 60)}`);
    out = out.split(f).join("");
  }
  return out;
}

async function main() {
  const env = await recordingServer();
  const inv = await env.store.createInvite();
  await activateRecorder(inv.token, { apiUrl: env.srv.url, deps: { fetch: (u, i) => realFetch(u, i as RequestInit) as never }, backend: new MemoryBackend(), limits: { sampleIntervalMs: 10, uploadBusyMs: 5, uploadIdleMs: 20 } });
  const S = env.S;

  async function say(h: ReturnType<typeof harness>, text: string, steps: LlmStep[], opts: Parameters<typeof browserFetch>[1] = {}) {
    S.llm.queue = [...steps];
    await h.send(text, browserFetch(env.srv.url, opts) as never);
    assert.equal(S.llm.queue.length, 0, `model scripted for ${steps.length} call(s)`);
  }
  const mkHarness = (state: Parameters<typeof harness>[0], src = source) => {
    recordStartRun(state, { search: "" });     // 生产里由 GameCanvas 在建局时调用
    return harness(state, src, "combat", undefined, { traceClient, recorderHeaders });
  };
  const applied = (h: ReturnType<typeof harness>) => [...new Set(h.results.flatMap((r) => r.appliedUnitIds))].sort((a, b) => a - b);
  async function exported() {
    await drainRecorder(recorderStatus);
    await env.store.flush();
    const runId = recorderStatus()!.runId!;
    const { exportRun } = await import("../apps/server/src/recorder/export");
    const { readZip } = await import("../apps/server/src/recorder/zip");
    const out = await exportRun(env.store, runId);
    assert.ok(out, "export");
    const files = readZip(out!.zip);
    return { runId, traces: parseJsonl(files.get("traces.jsonl")), snapshots: parseJsonl(files.get("snapshots.jsonl")), manifest: JSON.parse(files.get("manifest.json")!.toString("utf8")), html: files.get("report.html")!.toString("utf8") };
  }
  const nearPt = (a: unknown, b: { x: number; y: number }, r = 6) => Array.isArray(a) && typeof a[7] === "number" && Math.hypot(a[7] - b.x, (a[8] as number) - b.y) <= r;

  // ── ① 模型语义批准（不走「对」捷径）──────────────────────────
  async function semanticApproval(src = source) {
    const f = mixedGroup(); const h = mkHarness(f.state, src);
    const cmd = "从那群里派两个去北线前哨";
    const answer = "嗯，就照你刚才说的那样办吧";
    await say(h, cmd, [CONFIRM(f.g)]);
    assert.ok(h.pendingContractRef.current, "plan stored");
    await say(h, answer, [authorizeEcho(f.g)]);
    return { f, h, cmd, answer };
  }
  await test("L1 ★模型语义批准：从答复追到 pendingId、原方案回合（CONFIRM 那一轮）、实际接令的 2 个单位；服务端两轮原话都在；执行后快照里这两个正开往北线前哨", async () => {
    const { f, h, cmd, answer } = await semanticApproval();
    const ids = applied(h);
    assert.equal(ids.length, 2, "the game really executed 2");
    const pkg = await exported();
    const c = followReply(pkg.traces, pkg.snapshots, answer, cmd, "pending");
    assert.equal(c.link.d.data.verdict, "authorize");
    assert.equal(c.link.d.data.pendingId, c.planSide.d.data.pendingId);
    assert.deepEqual(c.appliedIds, ids, "package's applied units = game's applied units");
    assert.equal(c.exec.turnFrom, "current", "exec turn is marked as taken from the current turn");
    assert.equal(c.serverReply?.d.message, answer);
    assert.equal(c.serverPlan?.d.message, cmd);
    assert.ok(pkg.traces.some((l) => l.type === "srv_result" && l.turn === c.replyTurn && l.d.pendingDecision === "authorize"));
    assert.ok(c.execSnapshot, "exec snapshot under the reply turn");
    const rows = (c.execSnapshot!.d.units as unknown[][]).filter((u) => ids.includes(u[0] as number));
    assert.equal(rows.length, 2);
    for (const r of rows) assert.ok(nearPt(r, f.north), `unit ${r[0]} ordered to the north post: ${JSON.stringify(r)}`);
    assert.ok(pkg.html.includes(`id="turn-${c.planTurn}"`) && pkg.html.includes(`href="#turn-${c.planTurn}"`), "report links the exec back to the plan turn");
  });
  await test("L1-负对照：拿掉这次补的关联字段（pending 事件里的 planTraceId 等）⇒ 包里从答复追不到原方案，同一条追踪失败", async () => {
    const { cmd, answer } = await semanticApproval(withoutLinkFields(source));
    const pkg = await exported();
    await mustFail("follow reply → plan", () => { followReply(pkg.traces, pkg.snapshots, answer, cmd, "pending"); });
  });

  // ── ② 数量选择 ──────────────────────────────────────────────
  async function quantityChoice(src = source) {
    const f = mixedGroup(); const h = mkHarness(f.state, src);
    const cmd = "派其中两个去北线前哨";
    const answer = "一共两个";
    await say(h, cmd, [order("两个去北线前哨。", splitTwo(f.g))]);
    assert.equal(h.applications.length, 0, "asked first, zero execution");
    assert.equal(h.pendingSelectionRef.current?.kind, "quantity");
    await say(h, answer, [choose("quantity:total")]);
    return { f, h, cmd, answer };
  }
  await test("L2 ★数量选择：从答复追到 selectionId、原方案回合（问“一共还是各”的那一轮）、实际接令的恰好 2 个；quantity_chosen 也带同一对编号", async () => {
    const { f, h, cmd, answer } = await quantityChoice();
    const ids = applied(h);
    assert.equal(ids.length, 2);
    const pkg = await exported();
    const c = followReply(pkg.traces, pkg.snapshots, answer, cmd, "selection");
    assert.equal(c.planSide.d.stage, "ask_quantity");
    assert.equal(c.link.d.data.plan, "quantity_chosen");
    const qc = pkg.traces.find((l) => l.type === "trace" && l.d.stage === "quantity_chosen" && l.turn === c.replyTurn);
    assert.ok(qc);
    assert.equal(qc!.d.data.selectionId, c.link.d.data.selectionId);
    assert.equal(qc!.d.data.planTraceId, c.planTurn);
    assert.deepEqual(c.appliedIds, ids);
    for (const id of ids) assert.ok(f.groupIds.has(id));
    assert.ok(pkg.traces.some((l) => l.type === "srv_result" && l.turn === c.replyTurn && l.d.dispatchSelection), "server result carries the model's selection");
  });
  await test("L2-负对照：拿掉关联字段 ⇒ 数量选择的答复追不到原方案", async () => {
    const { cmd, answer } = await quantityChoice(withoutLinkFields(source));
    const pkg = await exported();
    await mustFail("follow reply → plan", () => { followReply(pkg.traces, pkg.snapshots, answer, cmd, "selection"); });
  });

  // ── ③ 候选部队选择 ──────────────────────────────────────────
  async function candidateChoice(src = source) {
    const f = southStayAndSent(); const h = mkHarness(f.state, src);
    const cmd = "南线的都撤回南线前哨";
    await say(h, cmd, [order("南线撤回前哨。", [{ type: "retreat", fromFront: "front_south", quantity: "all", targetFacility: "ea_player_south_post", destinationQuote: "南线前哨" }])]);
    const slot = h.pendingSelectionRef.current;
    assert.equal(slot?.kind, "source", "asked which batch");
    const stayKey = slot.candidates.find((c: { selectionKey: string }) => c.selectionKey.startsWith("stay:"))!.selectionKey;
    const answer = "还守在南线的那几个";
    await say(h, answer, [reply("好。", { brief: "好。", responseType: "EXECUTE", options: [], recommended: "A", urgency: 0.4, dispatchSelection: { decision: "chose", candidate: stayKey } })]);
    return { f, h, cmd, answer };
  }
  await test("L3 ★候选部队选择：从答复追到 selectionId、原方案回合（问“是哪一批”的那一轮）、实际接令的正是留守的那 2 个", async () => {
    const { f, h, cmd, answer } = await candidateChoice();
    const ids = applied(h);
    assert.deepEqual(ids, f.stay.map((u) => u.id).sort((a, b) => a - b), "the game moved exactly the chosen batch");
    const pkg = await exported();
    const c = followReply(pkg.traces, pkg.snapshots, answer, cmd, "selection");
    assert.equal(c.planSide.d.stage, "ask_selection");
    assert.equal(c.link.d.data.plan, "execute");
    assert.deepEqual(c.appliedIds, ids);
    assert.ok(c.execSnapshot);
  });
  await test("L3-负对照：拿掉关联字段 ⇒ 候选选择的答复追不到原方案", async () => {
    const { cmd, answer } = await candidateChoice(withoutLinkFields(source));
    const pkg = await exported();
    await mustFail("follow reply → plan", () => { followReply(pkg.traces, pkg.snapshots, answer, cmd, "selection"); });
  });

  // ── 快捷「对」／「算了」（本来就有 planTraceId）────────────────
  await test("L4 快捷「对」：本地办完、不请求模型，也留新回复记录并连回原方案；「算了」同样留记录、零执行", async () => {
    const f = mixedGroup(); const h = mkHarness(f.state);
    const cmd = "从那群里派两个去北线前哨";
    await say(h, cmd, [CONFIRM(f.g)]);
    const calls = S.llm.calls.length;
    await say(h, "对", []);
    assert.equal(S.llm.calls.length, calls, "no model call");
    const ids = applied(h);
    assert.equal(ids.length, 2);
    const pkg = await exported();
    const t = pkg.traces.find((l) => l.type === "trace" && l.d.stage === "turn" && l.d.data.text === "对")!;
    const sc = pkg.traces.find((l) => l.type === "trace" && l.d.stage === "pending_shortcut" && l.turn === t.turn)!;
    assert.equal(sc.d.data.reply, "confirm");
    const planTurn = sc.d.data.planTraceId;
    assert.equal(pkg.traces.find((l) => l.type === "trace" && l.d.stage === "turn" && l.turn === planTurn)?.d.data.text, cmd);
    const exec = pkg.traces.find((l) => l.type === "trace" && l.d.stage === "exec" && l.turn === t.turn && l.d.data.planTraceId === planTurn)!;
    assert.deepEqual([...exec.d.data.applied].sort((a: number, b: number) => a - b), ids);
    assert.ok(!pkg.traces.some((l) => l.type === "srv_request" && l.turn === t.turn), "no server request for the shortcut turn");
    const f2 = mixedGroup(); const h2 = mkHarness(f2.state);
    await say(h2, cmd, [CONFIRM(f2.g)]);
    await say(h2, "算了", []);
    assert.equal(h2.applications.length, 0);
    const pkg2 = await exported();
    const t2 = pkg2.traces.find((l) => l.type === "trace" && l.d.stage === "turn" && l.d.data.text === "算了")!;
    assert.ok(pkg2.traces.some((l) => l.type === "trace" && l.d.stage === "pending_shortcut" && l.turn === t2.turn && l.d.data.reply === "cancel"));
  });

  // ── 失败/重试的尝试证据（T06）────────────────────────────────
  await test("L5 ★模型 429／解析失败／SSE 被代理拒、走兜底：包里有每一次真实到达服务端的尝试（请求、失败、收尾）；游戏零执行", async () => {
    const f = mixedGroup(); const h = mkHarness(f.state);
    await say(h, "刚才那两个快撤", [{ kind: "status", status: 429, body: "Resource exhausted" }]);
    await say(h, "北线怎么样", [{ kind: "text", text: "长官，那两个我这就让他们撤下来，" }]);
    await say(h, "派两个去北线前哨", [{ kind: "text", text: "没有 JSON" }], { streamDown: true });
    assert.equal(h.applications.length, 0, "nothing executed");
    const pkg = await exported();
    const turnOf = (t: string) => pkg.traces.find((l) => l.type === "trace" && l.d.stage === "turn" && l.d.data.text === t)!.turn!;
    const t429 = turnOf("刚才那两个快撤");
    assert.ok(pkg.traces.some((l) => l.type === "srv_model_error" && l.turn === t429), "model error recorded");
    assert.ok(pkg.traces.some((l) => l.type === "trace" && l.d.stage === "model_failure" && l.turn === t429));
    assert.ok(pkg.traces.some((l) => l.type === "srv_parse_failed" && l.turn === turnOf("北线怎么样")));
    const tFb = turnOf("派两个去北线前哨");
    const reqs = pkg.traces.filter((l) => l.type === "srv_request" && l.turn === tFb);
    assert.equal(reqs.length, 1, "stream route refused at the proxy; the one real attempt is the fallback /api/command");
    assert.equal(reqs[0].d.route, "command");
    const ends = pkg.traces.filter((l) => l.type === "srv_attempt_end" && l.turn === tFb);
    assert.equal(ends.length, 1);
    assert.equal(pkg.manifest.completeness.inFlightAttempts, 0);
  });
  await test("L6 ★SSE 在单子送达前断了、走 /api/command 兜底：同一回合两次真实尝试（不同 attempt、各自收尾）在包里分得开；游戏只执行一次", async () => {
    const f = mixedGroup(); const h = mkHarness(f.state);
    const text = "从那群里派两个去北线前哨";
    const step = order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }]);
    await say(h, text, [step, step], { truncateStream: true });
    assert.equal(h.applications.length, 1, "executed exactly once");
    const pkg = await exported();
    const t = pkg.traces.find((l) => l.type === "trace" && l.d.stage === "turn" && l.d.data.text === text)!.turn!;
    const reqs = pkg.traces.filter((l) => l.type === "srv_request" && l.turn === t);
    assert.deepEqual(reqs.map((r) => r.d.route).sort(), ["command", "command-stream"]);
    assert.notEqual(reqs[0].d.attempt, reqs[1].d.attempt);
    const ends = pkg.traces.filter((l) => l.type === "srv_attempt_end" && l.turn === t);
    assert.equal(ends.length, 2);
    assert.equal(new Set(ends.map((e) => e.d.attempt)).size, 2);
    const execs = pkg.traces.filter((l) => l.type === "trace" && l.d.stage === "exec" && l.turn === t);
    assert.equal(execs.length, 1, "one exec record, matching one execution");
  });

  // ── T03：派 2 个 → 半路改去修理厂 → 叫回 → 模拟走到并再等 30 秒，只凭包勾稽 ──
  await test("L7 ★T03（模拟子集：每步 tick＋processAutoBehavior，写明是子集）：包里同一对 ID 三次接令、三个真实目标；之后的快照里这一对回到各自起点并停住；其余单位没有新增下令", async () => {
    const f = mixedGroup(); const h = mkHarness(f.state);
    for (const u of [...f.state.units.values()]) if (u.team === "enemy") f.state.units.delete(u.id);
    const cmds = ["派其中两个去北线前哨", "那两个改去修理厂", "刚才那两个叫回来"];
    await say(h, cmds[0], [order("两个去北线前哨。", [{ type: "defend", fromSquad: f.g, quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
    const sent = applied(h);
    assert.equal(sent.length, 2);
    // 走一段（半路）：只跑 tick＋processAutoBehavior 两步（T03 只核移动），分段让记录器的采样定时器真的跑
    const pump = async (sec: number, stop?: () => boolean) => {
      for (let t = 0; t < sec; t += 0.25) {
        core.tick(f.state, 0.25); core.processAutoBehavior(f.state, 0.25);
        if (stop?.()) break;
        if (Math.round(t * 4) % 20 === 0) await new Promise((r) => setTimeout(r, 12));
      }
    };
    await pump(12);
    await say(h, cmds[1], [order("改去修理厂。", [{ type: "defend", fromSquad: f.g, targetFacility: "ea_repair_station", destinationQuote: "修理厂" }])]);
    await pump(6);
    await say(h, cmds[2], [order("回原处。", [{ type: "retreat", fromSquad: f.g, returnTo: "origin" }])]);
    await pump(150);   // 走回去（最多 150 秒）……
    await pump(30);    // ……再等 30 秒
    const pkg = await exported();
    const turnOf = (t: string) => pkg.traces.find((l) => l.type === "trace" && l.d.stage === "turn" && l.d.data.text === t)!.turn!;
    const execs = cmds.map((c) => pkg.traces.find((l) => l.type === "trace" && l.d.stage === "exec" && l.turn === turnOf(c))!);
    for (const e of execs) assert.ok(e, "one exec per command");
    const pairs = execs.map((e) => [...e.d.data.applied].sort((a: number, b: number) => a - b));
    assert.deepEqual(pairs[1], pairs[0], "the retarget moved the same pair");
    assert.deepEqual(pairs[2], pairs[0], "the recall moved the same pair");
    assert.deepEqual(pairs[0], sent, "and it is the pair the game really moved");
    const targetsOf = (e: typeof execs[number]) => (e.d.data.intents as { orders: { units: number[]; target: { x: number; y: number } }[] }[]).flatMap((i) => i.orders);
    const repair = f.state.facilities.get("ea_repair_station")!.position;
    for (const o of targetsOf(execs[0])) assert.ok(Math.hypot(o.target.x - f.north.x, o.target.y - f.north.y) < 6, "1st: north post");
    for (const o of targetsOf(execs[1])) assert.ok(Math.hypot(o.target.x - repair.x, o.target.y - repair.y) < 6, "2nd: repair station");
    // 起点：包里的开局快照
    const snaps = pkg.snapshots.slice().sort((a, b) => (a.gt ?? 0) - (b.gt ?? 0));
    const startSnap = snaps.find((s) => s.d.reason === "start")!;
    const pos = (s: typeof startSnap, id: number) => (s.d.units as unknown[][]).find((u) => u[0] === id) as number[] | undefined;
    for (const o of targetsOf(execs[2])) for (const id of o.units) {
      const home = pos(startSnap, id)!;
      assert.ok(Math.hypot(o.target.x - home[2], o.target.y - home[3]) < 3, `3rd: unit ${id} recalled to its own start ${home[2]},${home[3]} (target ${o.target.x},${o.target.y})`);
    }
    const last = snaps[snaps.length - 1];
    assert.ok((last.gt ?? 0) >= (execs[2].gt ?? 0) + 30, `a snapshot at least 30 s after the recall (last ${last.gt}, recall ${execs[2].gt})`);
    for (const id of sent) {
      const home = pos(startSnap, id)!; const now = pos(last, id)!;
      assert.ok(Math.hypot(now[2] - home[2], now[3] - home[3]) < 2, `unit ${id} back home in the last snapshot: ${now[2]},${now[3]} vs ${home[2]},${home[3]}`);
    }
    // 其余单位：包里没有任何一次执行/手动下令碰到它们；每份快照里它们都没有命令
    const touched = new Set(pkg.traces.filter((l) => l.type === "trace" && l.d.stage === "exec").flatMap((l) => l.d.data.applied as number[]));
    assert.deepEqual([...touched].sort((a, b) => a - b), sent);
    const others = [...f.groupIds].filter((id) => !sent.includes(id));
    for (const s of snaps) for (const id of others) assert.equal(pos(s, id)?.[6] ?? null, null, `unit ${id} got no order (snapshot t=${s.gt})`);
    assert.ok(snaps.length >= 6, `periodic snapshots were taken during the sim (${snaps.length})`);
  });

  await env.srv.close();
  rm(env.dir);
  summary("probe-recorder-chain");
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
