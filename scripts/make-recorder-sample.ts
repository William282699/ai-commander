/**
 * 生成一个**合成**的单局样包（可离线打开）：走生产命令链＋生产记录器＋生产服务端导出，
 * 模型是假的（固定回包），玩家原话是写死的合成句子，不含任何真实试玩数据。
 *
 * 运行：node --import ./scripts/recorder-seed-random.mjs --import tsx scripts/make-recorder-sample.ts <输出目录>
 * 产出：<输出目录>/<服务器生成的文件名>.zip 以及同名 .manifest.json（便于不解压就看完整性）。
 *
 * 剧本：派两个去北线前哨 → 陈请长官点头（CONFIRM）→ 长官用自己的话批准（非「对」捷径）→ 数量读法歧义 →
 *       答「一共两个」→ 南线「是哪一批」→ 选留守那批 → 一次 429 → 模拟走 90 秒（15 个 core 函数）→
 *       问题标记（含 HTML 片段，验证转义）→ 手动下令一次 → 结局与结束反馈 → 关页收尾。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@ai-commander/core";
import { harness, source, type LlmStep } from "./chainHarness";
import { recordingServer, browserFetch, drainRecorder, order, choose, reply, NP, realFetch } from "./recorder-chain-lib";
import { activateRecorder, recordTrace, recorderHeaders, recordStartRun, recordGameEnd, recordManualOrder, recorderStatus, flagProblem, submitEndFeedback, notifyPageHide } from "../apps/web/src/recorder/index";
import type { QItem, QueueBackend } from "../apps/web/src/recorder/queue";

/** node 里没有 IndexedDB：用一个 Map 替身扮演浏览器的持久队列（样包因此不带“退回内存”的限制说明）。 */
class MapBackend implements QueueBackend {
  readonly kind = "idb" as const;
  private m = new Map<string, QItem>();
  async loadAll() { return [...this.m.values()]; }
  async put(items: QItem[]) { for (const i of items) this.m.set(i.eid, i); return true; }
  async remove(eids: string[]) { for (const e of eids) this.m.delete(e); return true; }
}
import * as messageStore from "../apps/web/src/messageStore";

async function main() {
  const outDir = process.argv[2];
  assert.ok(outDir, "usage: make-recorder-sample.ts <outDir>");
  mkdirSync(outDir, { recursive: true });
  const env = await recordingServer();
  const inv = await env.store.createInvite();
  await activateRecorder(inv.token, { apiUrl: env.srv.url, deps: { fetch: (u, i) => realFetch(u, i as RequestInit) as never }, backend: new MapBackend(), limits: { sampleIntervalMs: 25, uploadBusyMs: 5, uploadIdleMs: 20 } });
  const traceClient = (id: unknown, stage: string, d: Record<string, unknown>, run?: unknown, turnFrom?: "current") => recordTrace(id, stage, d, run, turnFrom);

  const state = core.createInitialGameState("el_alamein");
  core.resetEnemyAITimer(); core.resetEnemyProdToggle(); core.resetAttackWaveState(); core.resetAutoBehaviorTimer();
  core.resetWarPhaseTimers(); core.resetReportSignals(); core.resetEngagementCache(); core.resetDefensiveAITimer();
  core.resetPressureDirector(); core.resetEscalationTickets();
  recordStartRun(state, { search: "?scenario=el_alamein" });
  messageStore.clearMessages();
  messageStore.addMessage("info", "等待指令...", 0, "ops", "system", "system");
  // 屏幕消息：台架把 addMessage 换成了收屏函数；这里再同时交给生产 messageStore，让消息变更点照常记录。
  const h = harness(state, source, "combat", undefined, {
    traceClient, recorderHeaders,
  });
  const say = async (text: string, steps: LlmStep[]) => {
    env.S.llm.queue = [...steps];
    messageStore.addMessage("info", text, state.time, "combat", "player", "player");
    await h.send(text, browserFetch(env.srv.url) as never);
    for (const m of h.screen.splice(0)) if (m.source !== "player") messageStore.addMessage(m.level as "info", m.text, state.time, "combat", undefined, (m.source ?? "command_ack") as "command_ack");
  };
  const step = (sec: number) => {
    for (let t = 0; t < sec; t += 0.05) {
      core.tick(state, 0.05); core.processEconomy(state, 0.05); core.processReportSignals(state, 0.05); core.updateBattleMarkers(state, 0.05);
      core.processAdvisorTriggers(state); core.checkDoctrines(state); core.updateGamePhase(state, 0.05); core.checkGameOver(state, 0.05);
      core.processMissions(state, 0.05); core.updateTasks(state); core.processEnemyAI(state, 0.05); core.processDefensiveAI(state, 0.05);
      core.processPressureDirector(state, 0.05); core.processAutoBehavior(state, 0.05); core.applyEndgamePressure(state, 0.05);
    }
  };
  const breathe = () => new Promise((r) => setTimeout(r, 40));

  await say("派两个去北线前哨", [order("两个去北线前哨。", [{ type: "defend", fromFront: "front_center", quantity: 2, targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  step(5); await breathe();
  const southPlan = { type: "defend", fromFront: "front_center", quantity: 2, targetFacility: "ea_player_south_post", destinationQuote: "南线前哨" };
  await say("南线要不要加人", [reply("长官，从中路派两个去南线前哨，行吗？", { brief: "长官，从中路派两个去南线前哨，行吗？", responseType: "CONFIRM", recommended: "A", urgency: 0.4,
    options: [{ label: "A: 两个去南线前哨", description: "", risk: 0.2, reward: 0.4, intents: [southPlan] }] })]);
  await say("嗯，就照你说的办", [reply("按您说的办。", { brief: "按您说的办。", responseType: "EXECUTE", recommended: "A", urgency: 0.4, pendingDecision: "authorize",
    options: [{ label: "A: 方案1", description: "", risk: 0.2, reward: 0.4, intents: [southPlan] }] })]);
  step(5); await breathe();
  await say("从中路再派两个去北线前哨", [order("两个去北线前哨。", [
    { type: "defend", fromFront: "front_center", quantity: 2, unitType: "armor", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" },
    { type: "defend", fromFront: "front_center", quantity: 2, unitType: "infantry", targetFacility: NP, destinationQuote: "北线前哨", quantityQuote: "两个" }])]);
  await say("一共两个", [choose("quantity:total")]);
  step(5); await breathe();
  await say("刚才那两个快撤", [{ kind: "status", status: 429, body: "Resource exhausted" }]);
  for (let k = 0; k < 18; k++) { step(5); await breathe(); }
  flagProblem("合成样例：这里派的人数看着不对 <b>测试转义</b>");
  const manualIds = [...state.units.values()].filter((u) => u.team === "player" && u.isPlayerControlled).slice(0, 2).map((u) => u.id);
  if (manualIds.length) {
    const o = { unitIds: manualIds, action: "attack_move" as const, target: { x: 250, y: 120 }, priority: "medium" as const };
    core.applyPlayerCommands(state, [o]);
    recordManualOrder(state, [o], "right_click_move");
  }
  step(10); await breathe();
  // 合成的结局（样包需要一个结束边界；真实对局里由 GameCanvas 在 gameOver 时记）
  recordGameEnd(state, { winner: "player", reason: "合成样例：手动结束", rating: null });
  submitEndFeedback("合成样例：整体挺顺，就是第二次派兵问得有点多。");
  await breathe();
  await drainRecorder(recorderStatus, 8000);
  // 关页收尾（生产里由 pagehide 触发，调的是同一个函数）
  notifyPageHide(false);
  await drainRecorder(recorderStatus, 8000);
  await env.store.flush();
  const { exportRun } = await import("../apps/server/src/recorder/export");
  const out = await exportRun(env.store, recorderStatus()!.runId!);
  assert.ok(out);
  writeFileSync(join(outDir, out!.filename), out!.zip);
  writeFileSync(join(outDir, out!.filename.replace(/\.zip$/, ".manifest.json")), JSON.stringify(out!.manifest, null, 2));
  console.log(`sample: ${join(outDir, out!.filename)} (${out!.zip.length} bytes); completeness=${(out!.manifest as { completeness: { status: string } }).completeness.status}`);
  await env.srv.close();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
