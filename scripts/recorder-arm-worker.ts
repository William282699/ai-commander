/**
 * 对照臂的单臂进程（由 probe-recorder-arms.ts 分进程拉起；每臂一个进程，种子在导入 core 之前装好）。
 *
 * 同一初始局（阿拉曼真实开局，85 个我方单位＋敌军）、同一串固定模型回包，走生产命令链（真 HTTP、
 * 生产服务端路由、生产记录器接线）；之后按 GameCanvas 每帧的顺序调 15 个 core 函数走 150 游戏秒
 * （跳过两处 escalateCrisisToConversation 危机上报——那是 GameCanvas 自己的函数、会调模型），
 * 再下一道命令。末尾打印这一臂的全部可比结果。
 *
 * 臂：off（记录仪从未激活）、on（正常记录上传）、fail（上传全失败）、full（服务端满盘＋浏览器缓存极小）、
 *     throw（记录器内部每次都抛）、neg_rng（负对照：记录器偷用了模拟的 Math.random）。
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as core from "@ai-commander/core";
import type { GameState } from "@ai-commander/shared";
import { harness, source, type LlmStep } from "./chainHarness";
import { recordingServer, browserFetch, drainRecorder, order, reply, NP, realFetch } from "./recorder-chain-lib";
import { activateRecorder, recordTrace, recorderHeaders, recordStartRun, recordGameEnd, recorderStatus } from "../apps/web/src/recorder/index";
import { MemoryBackend } from "../apps/web/src/recorder/queue";
import { rm } from "./recorder-test-lib";

const arm = (process.argv.find((a) => a.startsWith("--arm=")) ?? "--arm=off").slice(6);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  assert.ok((globalThis as Record<string, unknown>).__REC_SEEDED__, "seed must be preloaded before core (use --import ./scripts/recorder-seed-random.mjs)");
  const env = await recordingServer({ limits: arm === "full" ? { globalMaxBytes: 1024 * 1024 + 4096, markerReserveBytes: 1024 * 1024 } : {} });
  const S = env.S;
  // 模型输入：假模型那一层看到的每个请求体（服务端 → 模型）
  const llmBodies: string[] = [];
  const fakeLlm = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof init?.body === "string") llmBodies.push(init.body);
    return fakeLlm(url, init);
  }) as typeof fetch;
  const inv = await env.store.createInvite();
  let netCalls = 0;
  let netFailures = 0;
  const netFetch = (u: string, i: unknown) => { netCalls++; return realFetch(u, i as RequestInit) as never; };
  const limits = { sampleIntervalMs: 15, uploadBusyMs: 5, uploadIdleMs: 20, backoffMinMs: 10, backoffMaxMs: 60 };
  if (arm === "on" || arm === "neg_rng") {
    await activateRecorder(inv.token, { apiUrl: env.srv.url, deps: { fetch: netFetch }, backend: new MemoryBackend(), limits });
  } else if (arm === "fail") {
    await activateRecorder(inv.token, { apiUrl: env.srv.url, deps: { fetch: () => { netCalls++; netFailures++; return Promise.reject(new TypeError("Failed to fetch")); } }, backend: new MemoryBackend(), limits });
  } else if (arm === "full") {
    await activateRecorder(inv.token, { apiUrl: env.srv.url, deps: { fetch: netFetch }, backend: new MemoryBackend(), limits: { ...limits, cacheMaxBytes: 30_000, memoryOnlyMaxBytes: 30_000 } });
  } else if (arm === "throw") {
    await activateRecorder(inv.token, { apiUrl: env.srv.url, deps: { fetch: netFetch, now: () => { throw new Error("recorder clock exploded"); } }, backend: new MemoryBackend(), limits });
  } else {
    assert.equal(arm, "off");
  }
  // 生产接线：traceClient ＝ recordTrace（node 里不是开发构建）；负对照臂让它偷用一次模拟的随机数。
  const traceClient = (id: unknown, stage: string, d: Record<string, unknown>, run?: unknown, turnFrom?: "current") => {
    if (arm === "neg_rng") Math.random();
    recordTrace(id, stage, d, run, turnFrom);
  };

  // 同一初始局；模块级计时器按 GameCanvas 开局的顺序复位
  const state: GameState = core.createInitialGameState("el_alamein");
  core.resetEnemyAITimer(); core.resetEnemyProdToggle(); core.resetAttackWaveState(); core.resetAutoBehaviorTimer();
  core.resetWarPhaseTimers(); core.resetReportSignals(); core.resetEngagementCache(); core.resetDefensiveAITimer();
  core.resetPressureDirector(); core.resetEscalationTickets();
  recordStartRun(state, { search: "" });
  const h = harness(state, source, "combat", undefined, { traceClient, recorderHeaders });
  const say = async (text: string, steps: LlmStep[]) => {
    S.llm.queue = [...steps];
    await h.send(text, browserFetch(env.srv.url) as never);
    assert.equal(S.llm.queue.length, 0, `scripted ${steps.length} model call(s) for 「${text}」`);
  };

  // ── 命令串（固定回包）──
  await say("派两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromFront: "front_center", quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  const southPlan = { type: "defend", fromFront: "front_center", quantity: 2, targetFacility: "ea_player_south_post", destinationQuote: "南线前哨" };
  await say("南线要不要加人", [reply("长官，从中路派两个去南线前哨，行吗？", { brief: "长官，从中路派两个去南线前哨，行吗？", responseType: "CONFIRM", recommended: "A", urgency: 0.4,
    options: [{ label: "A: 两个去南线前哨", description: "", risk: 0.2, reward: 0.4, intents: [southPlan] }] })]);
  await say("嗯就这么办", [reply("按您说的办。", { brief: "按您说的办。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "authorize",
    options: [{ label: "A: 方案1", description: "", risk: 0.2, reward: 0.4, intents: [southPlan] }] })]);
  await say("从中路派两个去北线前哨", [order("两个去北线前哨。", [
    { type: "defend", fromFront: "front_center", quantity: 2, unitType: "armor", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" },
    { type: "defend", fromFront: "front_center", quantity: 2, unitType: "infantry", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  await say("一共两个", [reply("明白。", { brief: "明白。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, options: [], dispatchSelection: { decision: "chose", candidate: "quantity:total" } })]);
  await say("刚才那两个快撤", [{ kind: "status", status: 429, body: "Resource exhausted" }]);

  // ── 走时间：每帧 15 个 core 函数，顺序照抄 GameCanvas.tsx:1916–1998 ──
  const dt = 0.05;
  let frames = 0;
  let gameOverSeen = false;
  const t0 = performance.now();
  const frameMs: number[] = [];
  for (let chunk = 0; chunk < 30; chunk++) {
    for (let k = 0; k < 100; k++) {
      const f0 = performance.now();
      core.tick(state, dt);
      core.processEconomy(state, dt);
      core.processReportSignals(state, dt);
      core.updateBattleMarkers(state, dt);
      core.processAdvisorTriggers(state);          // crisis_card → escalateCrisisToConversation：跳过（GameCanvas 自己的函数，会调模型）
      core.checkDoctrines(state);                   // DOCTRINE_BREACH 的对话上报同样跳过
      core.updateGamePhase(state, dt);
      core.checkGameOver(state, dt);
      core.processMissions(state, dt);
      core.updateTasks(state);
      core.processEnemyAI(state, dt);
      core.processDefensiveAI(state, dt);
      core.processPressureDirector(state, dt);
      core.processAutoBehavior(state, dt);
      core.applyEndgamePressure(state, dt);
      if (state.gameOver && !gameOverSeen) { gameOverSeen = true; recordGameEnd(state, { winner: state.winner, reason: state.gameOverReason }); }
      frameMs.push(performance.now() - f0);
      frames++;
    }
    // 让记录器的定时器（采样、上传）在两段之间真的跑起来，像浏览器里那样与游戏交错
    await new Promise((r) => setTimeout(r, 16));
  }
  const loopMs = performance.now() - t0;
  await say("北线的都撤回来", [order("北线撤。", [{ type: "retreat", fromFront: "front_coastal", quantity: "all", targetFacility: NP, destinationQuote: "北线前哨" }])]);

  // ── 本臂的记录仪状态（不进可比结果）──
  if (arm !== "off" && arm !== "fail" && arm !== "throw") { try { await drainRecorder(recorderStatus, 4000); } catch { /* full 臂可能永远清不空 */ } }
  await env.store.flush();
  const st = recorderStatus();
  const runs = env.store.runSummaries().map((r) => ({ runId: r.runId, count: r.count, clientEvents: r.count - (r.counts.srv_run_meta ?? 0), types: r.counts }));
  const recorderEvidence = { arm, status: st, netCalls, netFailures, serverRuns: runs, usage: env.store.usage() };

  // ── 可比结果 ──
  const units = [...state.units.values()].sort((a, b) => a.id - b.id).map((u) => [u.id, u.team, u.type, r2(u.position.x), r2(u.position.y), r2(u.hp), u.state,
    u.orders.map((o) => [o.action, o.target ? [r2(o.target.x), r2(o.target.y)] : null, o.unitIds.length]), u.manualOverride]);
  const facilities = [...state.facilities.values()].sort((a, b) => a.id.localeCompare(b.id)).map((f) => [f.id, f.team, r2(f.hp), r2(f.captureProgress)]);
  const comparable = {
    applications: h.applications.map((batch) => batch.map((o) => [o.action, [...o.unitIds].sort((a, b) => a - b), o.target ? [r2(o.target.x), r2(o.target.y)] : null])),
    results: h.results.map((r) => [r.appliedUnitIds, r.alreadyDoingUnitIds, r.rejectedUnitIds]),
    screen: h.screen.map((m) => [m.level, m.text, m.source ?? null]),
    speech: h.speech.map((s) => [s.text, s.persona]),
    context: h.contextEntries,
    clientRequests: h.requests.map((r) => [r.path, JSON.stringify(r.body)]),
    llmCalls: S.llm.calls.length,
    llmBodies,
    economy: { player: state.economy.player.resources, enemy: state.economy.enemy.resources, queue: state.productionQueue },
    dispatches: state.dispatches.map((d) => [d.id, d.action, d.targetName, d.memberIds, d.status]),
    time: r2(state.time), tick: state.tick, phase: state.phase, gameOver: state.gameOver, winner: state.winner,
    units, facilities,
    enemyCount: [...state.units.values()].filter((u) => u.team === "enemy").length,
  };
  frameMs.sort((a, b) => a - b);
  const perf = { frames, loopMs: Math.round(loopMs), p50: r2(frameMs[Math.floor(frames * 0.5)]), p95: r2(frameMs[Math.floor(frames * 0.95)]), max: r2(frameMs[frames - 1]) };
  // 结果写文件（管道里 process.exit 之前可能写不完）
  const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  assert.ok(outPath, "--out=<file> required");
  writeFileSync(outPath!, JSON.stringify({ arm, comparable, recorderEvidence, perf }));
  await env.srv.close();
  rm(env.dir);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
