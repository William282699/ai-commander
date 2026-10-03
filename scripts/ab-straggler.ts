// ============================================================
// AI Commander — straggler bench（掉队兵：派去防守的兵半路停下不走）
//
// 病例：2026-10-02 手测「从中央前哨派10个兵去烽火台」，中央战线遭遇战后一辆坦克停在半路不动。
// 确定性重放（线上首局夹具，坦克 #33）逐函数钉死：去烽火台的路上（defending＋target）被 autoBehavior
// 4c 拉去帮友军打一辆轻坦（交接档写的是 4a；R0 照抄三条判据复核，扳机是 4c——4a/4b/4c 同一条
// pinEpisode 路，修法三条一起关）→ pinEpisode 把**半路**记成追击的家 → 追到点没开火（sim: moving→idle）
// → 拴绳拉回半路 → 再 idle；combat.ts 的回岗分支只给进过 attacking 的兵 ⇒ 永久待命，令还挂着。
// 修法（autoBehavior Priority 3.5）：还在**第一次去岗路上**的玩家兵（defend 令、defending、有 target、
// 没有存活的追击锚点）在 P3.5 返回，不吃 4a/4b/4c；射程内照打（combat.ts 不动），打完照旧送往终点；
// 到岗后、以及出击后走回岗的路上，守军反应一字不改。交接档：主仓库根 STRAGGLER_FIX_HANDOFF_20261002.md。
//
// 本台架钉的（判据测效果——断言状态本身：位置／state／令／锚点，不读台词）：
//   R  重放线上首局（真实客户端链路＋录下的模型原文，生产序泵帧到 200 s）：
//      R0 前提自证：#33 第一次去岗途中确有 4a/4b/4c 会拉它走的局面（三条判据照抄源码，扳机在场）
//      R1 M1 八人第一次去岗途中，processAutoBehavior 一次都没改过他们的去向
//      R2 #33 110 s 前到烽火台 12 格内；110 s 时 defending、target 清空、令仍是 defend@原终点
//      R3 0–200 s 没有一个 M1 兵「挂着防守令、离终点 >12 格、停着 ≥20 s」
//      R4 110 s 时 M1 活着的全在烽火台 12 格内
//   G  合成局面（空战场＋手放的兵；泵 tick＋processAutoBehavior＋每秒 fog）：
//      G1/G2 守在阵地上的兵面对射程外在行动中的威胁：出去追、锚点＝阵地；打完回岗、锚点清掉（守军不回归）
//      G3/G3b 去岗路上同样的威胁：不追、去向不变；威胁消失后一路走到终点
//      G4/G4b 出击后走回岗的路上（锚点＝阵地）遇新威胁：照旧被拉出去（离家 6 格 / 1.5 格两种）
//      G5/G5b 带着旧锚点被改派去新岗：旧锚点在路上就被清掉、不追；到新岗后不被拴回旧处
//      G6 去岗路上射程内的敌人照打，打完接着走到终点（combat.ts 现成的路）
//      G7 敌军去岗路上照旧被拉（修法只给玩家；敌军自己的 defensiveAI 会把掉队的推回行军）
//   W  sweep（--sweep）：3 前哨 × 7 去处、各派 6 个防守、跑 240 s。「掉队」＝挂着防守令、离终点 >12 格、
//      停着（idle 或到岗姿态）≥20 s，**不含残血自撤**（P2：hp<5% 自己往总部退——用户 08-20 裁定的有意行为，
//      单列计数）。W1 掉队 0；另报存活、到达用时、没到就阵亡（手感代价）。
//
// 负对照（--negctl，--sweep-negctl）：读 autoBehavior.ts 源码、按变体逐字改一处（每处必须恰好命中一次，
// 否则判负对照无效）、写进临时文件 require 进来——sim / pathfinding / shared 与生产共用同一份模块实例
// （逐个核对），只有 autoBehavior 本身是改过的那份。每个变体点名的断言必须真 FAIL：
//   N1 摘掉修法（＝4b912c9 原样）        → R1 R2 R3 R4 G3 G3b G5 G5b
//   N2 判据只看 target、不看锚点          → G4 G4b
//   N3 去岗路上的返回提前到 P3（跳过锚点账）→ G5 G5b
//   N4 不分敌我                           → G7
//   N5 锚点在「回到家」清掉之后才读        → G4b
//   --sweep-negctl：W 在 N1 上跑，W1 必须真 FAIL（修前实测见 SWEEP_BEFORE）
//
// 用法（worktree 根；播种与生产序泵帧照档案复现脚本）：
//   node --import ./scripts/recorder-seed-random.mjs --import tsx scripts/ab-straggler.ts --synthetic
//   ... --negctl | --sweep | --sweep-negctl
// ============================================================

process.env.ADVISOR_TRACE = "off";

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as core from "@ai-commander/core";
import type { GameState, Unit, Position, Order } from "@ai-commander/shared";
import { findDispatch } from "../packages/core/src/dispatchLedger";
// 静态导入（不许 await import）：动态导入会让台架与被测代码各载一份 core，编队号在一份里登记、在另一份里查不到
import { harness, serverRoutes, source, oldFunctions } from "./chainHarness";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";

// ── harness ──

let failCount = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) { failCount++; failed.push(name); }
}
const info = (s: string) => console.log(`     · ${s}`);

/** 被测的 autoBehavior（生产那份，或负对照改过的那份）。 */
interface AB {
  label: string;
  processAutoBehavior: (s: GameState, dt: number) => void;
  resetAutoBehaviorTimer: () => void;
  chaseAnchorHomeOf: (id: number) => Position | null;
}
const LIVE: AB = {
  label: "engine",
  processAutoBehavior: core.processAutoBehavior,
  resetAutoBehaviorTimer: core.resetAutoBehaviorTimer,
  chaseAnchorHomeOf: core.chaseAnchorHomeOf,
};

const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);
const NEAR = 12;           // 「到了」＝离令终点 12 格内（与 place-presence 同一把尺）
const PARK_SECONDS = 20;   // 停着 ≥20 s 才算掉队（交接档 sweep 口径）

/** 生产序泵帧（GameCanvas 的逐帧调用序；与档案复现脚本一致），autoBehavior 换成被测那份。 */
function frame(s: GameState, dt: number, ab: AB, around?: { before: () => void; after: () => void }): void {
  core.tick(s, dt); core.processEconomy(s, dt); core.processReportSignals(s, dt); core.updateBattleMarkers(s, dt);
  core.processAdvisorTriggers(s); core.checkDoctrines(s); core.updateGamePhase(s, dt); core.checkGameOver(s, dt);
  core.processMissions(s, dt); core.updateTasks(s); core.processEnemyAI(s, dt); core.processDefensiveAI(s, dt);
  core.processPressureDirector(s, dt);
  around?.before(); ab.processAutoBehavior(s, dt); around?.after();
  core.applyEndgamePressure(s, dt); core.updateFog(s);
}

function freshState(ab: AB): GameState {
  const state = core.createInitialGameState("el_alamein") as GameState;
  core.resetEnemyAITimer(); core.resetEnemyProdToggle(); core.resetAttackWaveState(); core.resetAutoBehaviorTimer();
  ab.resetAutoBehaviorTimer();
  core.resetWarPhaseTimers(); core.resetReportSignals(); core.resetEngagementCache(); core.resetDefensiveAITimer();
  core.resetPressureDirector(); core.resetEscalationTickets();
  core.updateFog(state);
  return state;
}

/** 照抄 autoBehavior.ts isThreatInAction（判据逐字抄源码；R0 前提自证用，不参与判修法）。 */
function threatInAction(state: GameState, enemy: Unit): boolean {
  if (enemy.state === "attacking" || enemy.attackTarget !== null) return true;
  if (enemy.orders[0]?.targetFacilityId != null) return true;
  let takingGround = false;
  state.facilities.forEach((f) => {
    if (takingGround) return;
    if (f.hp <= 0 || f.capturingTeam !== enemy.team) return;
    if (dist(enemy.position, f.position) <= 3) takingGround = true;
  });
  return takingGround;
}
const visibleToPlayer = (state: GameState, u: Unit) => state.fog[Math.floor(u.position.y)]?.[Math.floor(u.position.x)] === "visible";

/**
 * R0 前提自证：此刻 autoBehavior 的 4a / 4b / 4c 有没有哪一条会把这个（没编队、balanced 档、没有锚点的）
 * 玩家兵拉走——三条判据照抄 autoBehavior.ts（findNearestEnemy＋isThreatInAction / findOutrangingAttacker /
 * findAllyBattleTarget），按引擎的先后顺序。只用来证明夹具里「路上被拉」的局面真在，不参与判修法。
 */
function pullTrigger(state: GameState, u: Unit): string | null {
  const enemies = [...state.units.values()].filter((e) => e.team !== u.team && e.hp > 0 && e.state !== "dead");
  // 4a：11 格（balanced）内最近的看得见的敌人，且它在行动中
  let nearest: Unit | null = null, nd = 11;
  for (const e of enemies) { const d = dist(e.position, u.position); if (visibleToPlayer(state, e) && d < nd) { nd = d; nearest = e; } }
  if (nearest && threatInAction(state, nearest)) return `4a ${nearest.type}#${nearest.id} ${nd.toFixed(1)} 格`;
  // 4b：3 s 内挨过打 → 打它的那个在 15 格内（不看视野），否则视野内、射程外最近的
  if (state.time - (u.lastDamagedAt ?? 0) <= 3) {
    const shooter = u.lastDamagedById !== undefined ? state.units.get(u.lastDamagedById) : undefined;
    if (shooter && shooter.hp > 0 && shooter.state !== "dead" && shooter.team !== u.team && dist(shooter.position, u.position) <= 15) return `4b 打它的 ${shooter.type}#${shooter.id}`;
    const fb = enemies.find((e) => visibleToPlayer(state, e) && dist(e.position, u.position) > u.attackRange && dist(e.position, u.position) < u.visionRange);
    if (fb) return `4b 视野内 ${fb.type}#${fb.id}`;
  }
  // 4c：12 格（defending）内有正在交火的友军，它的目标看得见
  for (const a of state.units.values()) {
    if (a.id === u.id || a.team !== u.team || a.hp <= 0 || a.state !== "attacking" || a.attackTarget === null) continue;
    if (dist(a.position, u.position) > 12) continue;
    const t = state.units.get(a.attackTarget);
    if (t && t.hp > 0 && t.state !== "dead" && t.team !== u.team && visibleToPlayer(state, t)) return `4c 帮友军 #${a.id} 打 ${t.type}#${t.id}`;
  }
  return null;
}

/**
 * 逐兵跟「这道防守令下达后有没有到过岗」（地面真相，不借被测代码的判据）：
 * 到岗＝sim 到点后 defending 且 target 清空、令还是同一个对象。
 * 没到过岗＝第一次去岗路上；此间 processAutoBehavior 改了它的 state 或去向 ⇒ 记一次「路上被拉走」。
 */
class MarchWatch {
  reached = new Map<number, Order>();
  pulls: string[] = [];
  private snap = new Map<number, { st: string; tg: Position | null; first: boolean }>();
  constructor(private s: GameState, private ids: () => number[]) {}
  track(): void {
    for (const id of this.ids()) {
      const u = this.s.units.get(id); const o = u?.orders[0];
      if (u && o && o.action === "defend" && u.state === "defending" && u.target === null) this.reached.set(id, o);
    }
  }
  firstMarch(u: Unit): boolean {
    const o = u.orders[0];
    return !!o && o.action === "defend" && u.state === "defending" && u.target !== null && this.reached.get(u.id) !== o;
  }
  before = (): void => {
    this.track();
    this.snap.clear();
    for (const id of this.ids()) {
      const u = this.s.units.get(id); if (!u) continue;
      this.snap.set(id, { st: u.state, tg: u.target ? { ...u.target } : null, first: this.firstMarch(u) });
    }
  };
  after = (): void => {
    for (const [id, b] of this.snap) {
      const u = this.s.units.get(id); if (!u || !b.first) continue;
      const moved = u.state !== b.st || u.target?.x !== b.tg?.x || u.target?.y !== b.tg?.y;
      // 残血自撤（P2，排在 P3 之前）不是本病：它把兵往总部送，单列
      if (moved && u.state !== "retreating") this.pulls.push(`t=${this.s.time.toFixed(2)} #${id} ${b.st}→${u.state}@${u.target ? `${Math.round(u.target.x)},${Math.round(u.target.y)}` : "null"}`);
    }
  };
}

/** 逐兵记「掉队」：挂着防守令、离令终点 >12 格、停着（idle 或到岗姿态）连续 ≥20 s；残血自撤过的单列。 */
class ParkWatch {
  since = new Map<number, number>();
  stuck = new Set<number>();
  lowHpRetreated = new Set<number>();
  lowHpParked = new Set<number>();
  constructor(private s: GameState, private ids: () => number[]) {}
  step(): void {
    for (const id of this.ids()) {
      const u = this.s.units.get(id);
      if (!u || u.hp <= 0) { this.since.delete(id); continue; }
      const o = u.orders[0];
      if (u.state === "retreating" && o?.action !== "retreat") this.lowHpRetreated.add(id);
      const away = !!o && o.action === "defend" && !!o.target && dist(u.position, o.target) > NEAR;
      const parked = away && (u.state === "idle" || (u.state === "defending" && u.target === null));
      if (!parked) { this.since.delete(id); continue; }
      if (!this.since.has(id)) this.since.set(id, this.s.time);
      if (this.s.time - this.since.get(id)! < PARK_SECONDS || this.stuck.has(id)) continue;
      if (this.lowHpRetreated.has(id)) this.lowHpParked.add(id); else this.stuck.add(id);
    }
  }
}

// ── R：重放线上首局 ──

async function R_replay(ab: AB): Promise<void> {
  console.log(`\n── R 重放线上首局（真实客户端链路＋录下的模型原文；autoBehavior=${ab.label}）──`);
  const fx = JSON.parse(readFileSync(new URL("./fixtures/central-post-empty-20260930.json", import.meta.url), "utf8"));
  const S: any = await serverRoutes();
  const state = freshState(ab);
  const ctxFns: any = oldFunctions(source, ["MAX_CONTEXT_ENTRIES", "MAX_CONTEXT_CHARS", "createEmptyChannelContext", "pushContext", "formatContext"],
    ["createEmptyChannelContext", "pushContext", "formatContext"]);
  const pv: any = oldFunctions(source, ["buildPlayerViewContext"], ["buildPlayerViewContext"], { buildPlayerViewLines: (core as any).buildPlayerViewLines });
  let view: any = fx.turns[0].view;
  const h: any = harness(state as any, source, "combat", undefined, {
    buildDigestForChannel,
    channelContextRef: { current: ctxFns.createEmptyChannelContext() },
    pushContext: ctxFns.pushContext, formatContext: ctxFns.formatContext,
    commanderMemoryRef: { current: { combat: { playerIntent: "", openCommitments: [] }, ops: { playerIntent: "", openCommitments: [] }, logistics: { playerIntent: "", openCommitments: [] } } },
    buildPlayerViewContext: pv.buildPlayerViewContext, getViewport: () => view,
  });

  let m1: number[] = [];
  const ids = () => m1;
  const march = new MarchWatch(state, ids);
  const park = new ParkWatch(state, ids);
  const TANK = 33;
  let trigger: string | null = null;   // R0：#33 第一次去岗途中，4a/4b/4c 的扳机第一次在场的时刻与是哪一条
  let arrived33: number | null = null;
  const around = {
    before: () => {
      march.before();
      const u = state.units.get(TANK);
      if (trigger === null && u && m1.includes(TANK) && march.firstMarch(u) && ab.chaseAnchorHomeOf(TANK) === null) {
        const why = pullTrigger(state, u);
        if (why) trigger = `t=${state.time.toFixed(2)} ${why}`;
      }
    },
    after: march.after,
  };
  const pumpTo = (t: number) => {
    while (state.time + 1e-9 < t) {
      frame(state, Math.min(0.05, t - state.time), ab, around);
      park.step();
      const u = state.units.get(TANK);
      if (arrived33 === null && u && m1.includes(TANK) && u.orders[0]?.target && dist(u.position, u.orders[0].target) <= NEAR) arrived33 = state.time;
    }
  };

  for (const turn of fx.turns) {
    pumpTo(turn.t); view = turn.view;
    S.llm.queue = [{ kind: "text", text: turn.raw }];
    await h.send(turn.text, S.clientFetch);
    if (m1.length === 0) m1 = [...(findDispatch(state, "M1")?.memberIds ?? [])];
  }
  const OBS = state.facilities.get("ea_observation_post")!.position;
  const order33 = state.units.get(TANK)?.orders[0];
  const dest33 = order33?.target ? { ...order33.target } : null;
  info(`M1 = ${m1.join(",")}；#33 令 ${order33?.action}@${dest33 ? `${dest33.x},${dest33.y}` : "?"}`);

  pumpTo(110);
  const u110 = state.units.get(TANK);
  const live110 = m1.map((id) => state.units.get(id)).filter((u): u is Unit => !!u && u.hp > 0);
  const farAt110 = live110.filter((u) => dist(u.position, OBS) > NEAR).map((u) => `#${u.id}@(${u.position.x.toFixed(0)},${u.position.y.toFixed(0)}) ${u.state}`);
  pumpTo(200);

  info(`#33 首次到烽火台终点 12 格内：${arrived33 === null ? "从没到" : `${arrived33.toFixed(1)} s`}；R0 扳机：${trigger ?? "无"}`);
  check("R0 前提自证：#33 第一次去岗途中，确有 autoBehavior 4a/4b/4c 会拉它走的局面（扳机在场；#33 没编队＝balanced 档）",
    m1.includes(TANK) && trigger !== null && !state.squads.some((q) => q.unitIds.includes(TANK)), `M1=${m1.join(",")}`);
  check("R1 M1 八人第一次去岗途中，processAutoBehavior 一次都没改过去向",
    m1.length === 8 && march.pulls.length === 0, march.pulls.slice(0, 6).join(" | "));
  check("R2 #33 110 s 前到烽火台 12 格内；110 s 时 defending、target 清空、令仍是 defend@原终点",
    !!u110 && !!dest33 && arrived33 !== null && arrived33 < 110 && dist(u110.position, dest33) <= NEAR &&
    u110.state === "defending" && u110.target === null && u110.orders[0]?.action === "defend" &&
    u110.orders[0]?.target?.x === dest33.x && u110.orders[0]?.target?.y === dest33.y,
    u110 ? `@(${u110.position.x.toFixed(1)},${u110.position.y.toFixed(1)}) ${u110.state} target=${JSON.stringify(u110.target)} 到达=${arrived33}` : "dead");
  check(`R3 0–200 s 没有 M1 兵挂着防守令、离终点 >${NEAR} 格停着 ≥${PARK_SECONDS} s`,
    park.stuck.size === 0, `掉队 ${[...park.stuck].map((i) => `#${i}`).join(",")}；残血自撤停半路 ${[...park.lowHpParked].join(",") || "无"}`);
  check("R4 110 s 时 M1 活着的全在烽火台 12 格内", live110.length > 0 && farAt110.length === 0, farAt110.join(" | "));
}

// ── G：合成局面 ──

let templateUnit: Unit | null = null;
function unitTemplate(): Unit {
  if (!templateUnit) {
    const s = core.createInitialGameState("el_alamein") as GameState;
    s.units.forEach((u) => { if (!templateUnit && u.team === "player" && u.type === "infantry") templateUnit = structuredClone(u); });
    if (!templateUnit) throw new Error("no player infantry in el_alamein opening");
  }
  return templateUnit;
}
let nextId = 9000;
function addUnit(s: GameState, p: Position, over: Partial<Unit> = {}): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate()),
    id: nextId++, position: { ...p }, state: "idle", orders: [], waypoints: [], patrolPoints: [], patrolTaskId: null,
    lastAttackTime: 0, manualOverride: false, target: null, attackTarget: null,
    ...over,
  };
  s.units.set(u.id, u);
  return u;
}
function emptyBattlefield(ab: AB): GameState {
  const s = core.createInitialGameState("el_alamein") as GameState;
  s.units.clear(); s.squads = []; s.missions = [];
  s.time = 120;
  ab.resetAutoBehaviorTimer();
  return s;
}
const defendOrder = (u: Unit, t: Position | null): Order => ({ unitIds: [u.id], action: "defend", target: t ? { ...t } : null, priority: "medium" });
/** 守在阵地上：defend 令、defending、target 清空（sim 到点后的样子）。 */
function garrison(s: GameState, p: Position): Unit {
  const u = addUnit(s, p, { state: "defending" });
  u.orders = [defendOrder(u, p)];
  return u;
}
/** 第一次去岗路上：defend 令、defending、target＝终点（applyOrders 下令后的样子）。 */
function marching(s: GameState, p: Position, dest: Position, team: Unit["team"] = "player"): Unit {
  const u = addUnit(s, p, { team, state: "defending", target: { ...dest }, waypoints: [{ ...dest }] } as Partial<Unit>);
  u.orders = [defendOrder(u, dest)];
  return u;
}
/** 射程外、在行动中的威胁（attacking 且锁着目标 ⇒ isThreatInAction）。 */
function threat(s: GameState, p: Position, victim: Unit, team: Unit["team"] = "enemy", hp = 10): Unit {
  return addUnit(s, p, { team, hp, maxHp: hp, state: "attacking", attackTarget: victim.id } as Partial<Unit>);
}
/** 一批 autoBehavior（2.0 s：任何余数下都恰好触发一批）。 */
function batch(s: GameState, ab: AB): void { core.updateFog(s); ab.processAutoBehavior(s, 2.0); }
function pump(s: GameState, ab: AB, seconds: number): void {
  const dt = 0.1; let sinceFog = 1;
  for (let t = 0; t < seconds; t += dt) {
    if (sinceFog >= 1) { core.updateFog(s); sinceFog = 0; }
    core.tick(s, dt); ab.processAutoBehavior(s, dt); sinceFog += dt;
  }
}
const at = (u: Unit) => `@(${u.position.x.toFixed(1)},${u.position.y.toFixed(1)}) ${u.state} target=${u.target ? `${u.target.x.toFixed(0)},${u.target.y.toFixed(0)}` : "null"}`;
const sameXY = (a: Position | null | undefined, b: Position | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y;

// 地点取 #33 那条路（中央战线 → 烽火台，主战坦克与步兵都走得通）
const ROAD_A: Position = { x: 297, y: 94 };
const ROAD_B: Position = { x: 251, y: 99 };
const POST: Position = { x: 297, y: 94 };

function G_synthetic(ab: AB): void {
  console.log(`\n── G 合成局面（autoBehavior=${ab.label}）──`);
  {
    const s = core.createInitialGameState("el_alamein") as GameState;
    const tiles = [ROAD_A, ROAD_B, { x: POST.x + 8, y: POST.y }, { x: POST.x, y: POST.y - 8 }, { x: POST.x + 6, y: POST.y - 8 }];
    check("G0 前提：用到的格子步兵都进得去", tiles.every((p) => core.canUnitEnterTile("infantry", p.x, p.y, s)));
  }

  // G1/G2 守在阵地上的兵：出去追、锚点＝阵地；打完回岗、锚点清掉
  {
    const s = emptyBattlefield(ab);
    const u = garrison(s, POST);
    const foe = threat(s, { x: POST.x + 8, y: POST.y }, u);
    batch(s, ab);
    const home = ab.chaseAnchorHomeOf(u.id);
    check("G1 守在阵地上的兵面对射程外在行动中的威胁 → 出去追，锚点＝阵地",
      u.state === "moving" && sameXY(u.target, foe.position) && sameXY(home, POST), `${at(u)} home=${JSON.stringify(home)}`);
    pump(s, ab, 60);
    const foeAfter = s.units.get(foe.id);
    check("G2 打完回岗：威胁死了、人在阵地 1 格内、defending、target 清空、锚点清掉",
      (!foeAfter || foeAfter.hp <= 0) && dist(u.position, POST) <= 1 && u.state === "defending" && u.target === null && ab.chaseAnchorHomeOf(u.id) === null,
      `${at(u)} foe=${foeAfter?.hp} home=${JSON.stringify(ab.chaseAnchorHomeOf(u.id))}`);
  }

  // G3/G3b 去岗路上：同样的威胁不追；威胁消失后一路走到终点
  {
    const s = emptyBattlefield(ab);
    const u = marching(s, ROAD_A, ROAD_B);
    const foe = threat(s, { x: ROAD_A.x, y: ROAD_A.y - 8 }, u);
    batch(s, ab);
    check("G3 去岗路上的兵面对同样的威胁 → 不追：仍 defending、去向仍是终点、没有锚点",
      u.state === "defending" && sameXY(u.target, ROAD_B) && ab.chaseAnchorHomeOf(u.id) === null, `${at(u)} home=${JSON.stringify(ab.chaseAnchorHomeOf(u.id))}`);
    s.units.delete(foe.id); // 威胁走了（追过去也扑空——#33 的原样）
    pump(s, ab, 90);
    check("G3b 威胁消失后一路走到终点：终点 2 格内、defending、target 清空",
      dist(u.position, ROAD_B) <= 2 && u.state === "defending" && u.target === null, at(u));
  }

  // G4/G4b 出击后走回岗的路上（锚点＝阵地）：新威胁照旧拉出去
  for (const [tag, off] of [["G4", 6], ["G4b", 1.5]] as const) {
    const s = emptyBattlefield(ab);
    const u = garrison(s, POST);
    const foe1 = threat(s, { x: POST.x + 8, y: POST.y }, u);
    batch(s, ab); // 出击：锚点钉在阵地
    s.units.delete(foe1.id);
    // combat.ts 回岗分支把它交回来的样子：defending、target＝阵地
    u.position = { x: POST.x + off, y: POST.y }; u.state = "defending"; u.target = { ...POST }; u.waypoints = [{ ...POST }];
    const homeBefore = ab.chaseAnchorHomeOf(u.id);
    const foe2 = threat(s, { x: POST.x + off, y: POST.y - 8 }, u);
    batch(s, ab);
    check(`${tag} 出击后走回岗的路上（离家 ${off} 格、锚点＝阵地）遇新威胁 → 照旧被拉出去`,
      sameXY(homeBefore, POST) && u.state === "moving" && sameXY(u.target, foe2.position),
      `${at(u)} homeBefore=${JSON.stringify(homeBefore)}`);
  }

  // G5/G5b 带着旧锚点被改派：旧锚点在路上就清掉、不追；到新岗后不被拴回旧处
  {
    const s = emptyBattlefield(ab);
    const u = addUnit(s, ROAD_A); // 没令、待命
    const foe1 = threat(s, { x: ROAD_A.x, y: ROAD_A.y - 8 }, u);
    batch(s, ab); // 待命的兵出击：锚点钉在 ROAD_A
    const oldHome = ab.chaseAnchorHomeOf(u.id);
    s.units.delete(foe1.id);
    core.applyOrders(s, [{ unitIds: [u.id], action: "defend", target: { ...ROAD_B }, priority: "medium" }]);
    const foe2 = threat(s, { x: u.position.x + 6, y: u.position.y - 8 }, u);
    batch(s, ab);
    check("G5 带着旧锚点被改派去新岗 → 下一批旧锚点就清掉，且路上不追新威胁",
      sameXY(oldHome, ROAD_A) && ab.chaseAnchorHomeOf(u.id) === null && u.state === "defending" && sameXY(u.target, ROAD_B),
      `${at(u)} oldHome=${JSON.stringify(oldHome)} home=${JSON.stringify(ab.chaseAnchorHomeOf(u.id))}`);
    s.units.delete(foe2.id);
    pump(s, ab, 120);
    check("G5b 到新岗后不被拴回旧处：120 s 时在新岗 2 格内、defending、没有锚点",
      dist(u.position, ROAD_B) <= 2 && u.state === "defending" && ab.chaseAnchorHomeOf(u.id) === null,
      `${at(u)} home=${JSON.stringify(ab.chaseAnchorHomeOf(u.id))}`);
  }

  // G6 去岗路上射程内的敌人照打，打完接着走到终点
  {
    const s = emptyBattlefield(ab);
    const u = marching(s, ROAD_A, ROAD_B);
    const foe = addUnit(s, { x: ROAD_A.x - 2, y: ROAD_A.y }, { team: "enemy", hp: 10, maxHp: 10 } as Partial<Unit>);
    pump(s, ab, 10);
    const foeAfter = s.units.get(foe.id);
    const fought = u.lastAttackTime > 0 && (!foeAfter || foeAfter.hp <= 0);
    pump(s, ab, 80);
    check("G6 去岗路上射程内的敌人照打（开过火、敌人死了），打完接着走到终点",
      fought && dist(u.position, ROAD_B) <= 2 && u.state === "defending" && u.target === null, `${at(u)} fought=${fought}`);
  }

  // G7 敌军去岗路上照旧被拉（修法只给玩家）
  {
    const s = emptyBattlefield(ab);
    const e = marching(s, ROAD_A, ROAD_B, "enemy");
    const p = threat(s, { x: ROAD_A.x, y: ROAD_A.y - 8 }, e, "player", 60);
    batch(s, ab);
    check("G7 敌军去岗路上遇射程外在行动中的我方 → 照旧被拉出去（敌军行为一字不改）",
      e.state === "moving" && sameXY(e.target, p.position), at(e));
  }
}

// ── W：sweep ──

/** 修前实测（--sweep-negctl：N1＝摘掉修法＝4b912c9 原样，同种子同口径，2026-10-03）。与交接档 sweep-before.log
 *  逐批对得上：那份的「半路停 10 个 / 8 批」＝ 这里的掉队 7 ＋ 残血自撤 3（旧口径没把残血自撤分出来）。 */
const SWEEP_BEFORE = "掉队 7 个 / 5 批（另残血自撤停半路 3）；存活 53；到过终点 75（中位 55.2 s）；没到就阵亡 46";

function W_sweep(ab: AB): void {
  console.log(`\n── W sweep：3 前哨 × 7 去处，各派 6 个防守，跑 240 s（autoBehavior=${ab.label}）──`);
  const POSTS = ["ea_player_coastal_post", "ea_player_central_post", "ea_player_south_post"];
  const DESTS = ["ea_observation_post", "ea_miteirya_ridge", "ea_kidney_ridge", "ea_fuel_depot", "ea_ammo_depot", "ea_himeimat", "ea_alamein_town"];
  let total = 0, stuck = 0, lowHp = 0, alive = 0, diedBefore = 0, batches = 0; const arrT: number[] = [];
  for (const post of POSTS) for (const dest of DESTS) {
    const s = freshState(ab);
    while (s.time < 10) frame(s, 0.05, ab);
    const P = s.facilities.get(post)!.position, D = s.facilities.get(dest)!.position;
    const ids = [...s.units.values()].filter((u) => u.team === "player" && (u.type === "infantry" || u.type === "main_tank" || u.type === "light_tank") && dist(u.position, P) <= 12).slice(0, 6).map((u) => u.id);
    const tgt = new Map<number, Position>();
    core.applyOrders(s, ids.map((id, i) => { const t = { x: D.x + (i % 3) - 1, y: D.y + Math.floor(i / 3) }; tgt.set(id, t); return { unitIds: [id], action: "defend", target: t, priority: "medium", origin: "advisor",
      dispatchMeta: { group: "sw", sourceKind: "selection", sourceKey: "", action: "defend", targetName: s.facilities.get(dest)!.name } } as unknown as Order; }));
    const park = new ParkWatch(s, () => ids);
    const t0 = s.time; const arrAt = new Map<number, number>();
    while (s.time < t0 + 240) {
      frame(s, 0.05, ab); park.step();
      for (const id of ids) { const u = s.units.get(id); if (u && u.hp > 0 && !arrAt.has(id) && dist(u.position, tgt.get(id)!) <= NEAR) arrAt.set(id, s.time - t0); }
    }
    const al = ids.filter((id) => (s.units.get(id)?.hp ?? 0) > 0);
    const lowParked = park.lowHpParked.size;
    total += ids.length; stuck += park.stuck.size; lowHp += lowParked; alive += al.length; batches += park.stuck.size > 0 ? 1 : 0;
    diedBefore += ids.filter((id) => (s.units.get(id)?.hp ?? 0) <= 0 && !arrAt.has(id)).length;
    arrT.push(...arrAt.values());
    const ts = [...arrAt.values()].sort((a, b) => a - b);
    info(`${s.facilities.get(post)!.name}→${s.facilities.get(dest)!.name}: 派 ${ids.length}、活 ${al.length}、到 ${arrAt.size}${ts.length ? `（${ts[0].toFixed(0)}–${ts[ts.length - 1].toFixed(0)}s）` : ""}、掉队 ${park.stuck.size}${park.stuck.size ? ` (#${[...park.stuck].join(",#")})` : ""}${lowParked ? `、残血自撤停半路 ${lowParked}` : ""}`);
  }
  arrT.sort((a, b) => a - b);
  const med = arrT.length ? arrT[Math.floor(arrT.length / 2)] : NaN;
  const now = `掉队 ${stuck} 个 / ${batches} 批（另残血自撤停半路 ${lowHp}）；存活 ${alive}；到过终点 ${arrT.length}（中位 ${med.toFixed(1)} s）；没到就阵亡 ${diedBefore}`;
  info(`本次：${now}`);
  info(`修前：${SWEEP_BEFORE}`);
  check(`W1 21 批 ${total} 个兵里，掉队（挂着防守令、离终点 >${NEAR} 格停着 ≥${PARK_SECONDS} s，不含残血自撤）＝ 0`, stuck === 0, now);
}

// ── 负对照：改过的 autoBehavior ──

const CORE_SRC = fileURLToPath(new URL("../packages/core/src/", import.meta.url));
const SHARED_INDEX = fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url));
const req = createRequire(import.meta.url);

const FIX_BLOCK = `    if (
      unit.team === "player" &&
      inDefendPosture &&
      unit.state === "defending" &&
      unit.target !== null &&
      !returningFromSortie
    ) return;
`;
const P3_LINE = "    if (unit.orders.length > 0 && !inDefendPosture && !orderSpent) return;\n";
const VARIANTS: Array<{ tag: string; label: string; edits: Array<[string, string]>; mustFail: RegExp[] }> = [
  { tag: "N1", label: "摘掉修法（＝4b912c9 原样）", edits: [[FIX_BLOCK, ""]],
    mustFail: [/^R1 /, /^R2 /, /^R3 /, /^R4 /, /^G3 /, /^G3b /, /^G5 /, /^G5b /] },
  { tag: "N2", label: "判据只看 target、不看锚点", edits: [["      !returningFromSortie\n    ) return;", "      true\n    ) return;"]],
    mustFail: [/^G4 /, /^G4b /] },
  { tag: "N3", label: "去岗路上的返回提前到 P3（跳过锚点账）",
    edits: [[FIX_BLOCK, ""], [P3_LINE, P3_LINE + `    if (unit.team === "player" && inDefendPosture && unit.state === "defending" && unit.target !== null) return;\n`]],
    mustFail: [/^G5 /, /^G5b /] },
  { tag: "N4", label: "不分敌我", edits: [[`      unit.team === "player" &&\n      inDefendPosture &&`, `      inDefendPosture &&`]],
    mustFail: [/^G7 /] },
  { tag: "N5", label: "锚点在「回到家」清掉之后才读", edits: [["      !returningFromSortie\n    ) return;", "      episode === null\n    ) return;"]],
    mustFail: [/^G4b /] },
];

function loadVariant(tag: string, edits: Array<[string, string]>): AB {
  let src = readFileSync(join(CORE_SRC, "autoBehavior.ts"), "utf8");
  for (const [from, to] of edits) {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`负对照 ${tag} 无效：改动锚点命中 ${n} 次（应恰好 1 次）——源码变了，先更新变体：${JSON.stringify(from.slice(0, 80))}`);
    src = src.replace(from, to);
  }
  const imports: Array<[string, string]> = [
    ['from "@ai-commander/shared"', `from ${JSON.stringify(SHARED_INDEX)}`],
    ['from "./sim"', `from ${JSON.stringify(join(CORE_SRC, "sim.ts"))}`],
    ['from "./pathfinding"', `from ${JSON.stringify(join(CORE_SRC, "pathfinding.ts"))}`],
  ];
  for (const [from, to] of imports) {
    if (!src.includes(from)) throw new Error(`负对照 ${tag} 无效：找不到导入 ${from}`);
    src = src.replaceAll(from, to);
  }
  if (/from "\.\//.test(src)) throw new Error(`负对照 ${tag} 无效：还有没改写的相对导入`);
  const dir = mkdtempSync(join(tmpdir(), "ab-straggler-"));
  const file = join(dir, `autoBehavior.${tag}.ts`);
  writeFileSync(file, src);
  try {
    const m = req(file);
    // 只有 autoBehavior 是改过的那份；sim / shared 必须与生产同一实例（否则负对照测的是另一个世界）
    if (req(join(CORE_SRC, "sim.ts")).tick !== core.tick) throw new Error(`负对照 ${tag} 无效：sim 不是同一份模块`);
    if (req(SHARED_INDEX).UNIT_STATS !== (req("@ai-commander/shared") as any).UNIT_STATS) throw new Error(`负对照 ${tag} 无效：shared 不是同一份模块`);
    if (m.processAutoBehavior === core.processAutoBehavior) throw new Error(`负对照 ${tag} 无效：载到的还是生产那份`);
    return { label: `${tag} ${edits.length} 处改动`, processAutoBehavior: m.processAutoBehavior, resetAutoBehaviorTimer: m.resetAutoBehaviorTimer, chaseAnchorHomeOf: m.chaseAnchorHomeOf };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ──

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--synthetic";
  console.log(`=== ab-straggler (掉队兵) · ${mode} ===`);
  if (!(globalThis as any).__REC_SEEDED__) console.log("     · 注意：未经 recorder-seed-random 播种（R / W 段数值可能与档案不符）");

  if (mode === "--synthetic") {
    await R_replay(LIVE);   // R 必须最先跑：要从干净的随机序列开始，才与档案复现逐位一致
    G_synthetic(LIVE);
    console.log(`\n=== ${failCount === 0 ? "ALL SYNTHETIC PASS" : `${failCount} FAIL`} ===`);
    process.exit(failCount === 0 ? 0 : 1);
  }
  if (mode === "--sweep") {
    W_sweep(LIVE);
    console.log(`\n=== ${failCount === 0 ? "SWEEP PASS" : `${failCount} FAIL`} ===`);
    process.exit(failCount === 0 ? 0 : 1);
  }
  if (mode === "--sweep-negctl") {
    W_sweep(loadVariant("N1", VARIANTS[0].edits));
    const ok = failed.some((n) => /^W1 /.test(n));
    console.log(`\n=== ${ok ? "SWEEP NEGCTL OK — 摘掉修法后 W1 真 FAIL" : "SWEEP NEGCTL 没咬住"} ===`);
    process.exit(ok ? 0 : 1);
  }
  if (mode === "--negctl") {
    let bitten = 0;
    for (const v of VARIANTS) {
      failCount = 0; failed.length = 0;
      console.log(`\n▶ 负对照 ${v.tag} ${v.label}`);
      const ab = loadVariant(v.tag, v.edits);
      if (v.mustFail.some((re) => /^\^R/.test(re.source))) await R_replay(ab);
      G_synthetic(ab);
      const missing = v.mustFail.filter((re) => !failed.some((n) => re.test(n)));
      const ok = missing.length === 0;
      if (ok) bitten++;
      console.log(`   ${ok ? "★ 真 FAIL（台架咬得住）" : `✗ 没咬住：${missing.map((r) => r.source).join(" ")}`}：${failed.join(" / ") || "（零 FAIL）"}`);
    }
    console.log(`\n=== ${bitten === VARIANTS.length ? `NEGCTL OK — ${bitten}/${VARIANTS.length} 个变体点名的断言全部真 FAIL` : `NEGCTL 没咬住 ${VARIANTS.length - bitten} 个变体`} ===`);
    process.exit(bitten === VARIANTS.length ? 0 : 1);
  }
  console.log("usage: ... scripts/ab-straggler.ts --synthetic | --negctl | --sweep | --sweep-negctl");
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
