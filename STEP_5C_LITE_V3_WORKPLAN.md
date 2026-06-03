# Step 5C-lite v3.1 — Strategic Phase Director (路 B 重构)

> **v3 → v3.1 changelog (yuqiaohuang review)**:
> - **修正 endgame score 方向**：原 `score ≤ 0 → offense` 反了。正确语义：`score = capturedAxis - lostPlayer`（玩家视角，与 `warPhase.endGameWithRating` 一致），`score > 0` = 玩家领先 = 敌方落后 → **总攻**；`score ≤ 0` = 敌方持平或领先 → **总防/拖时间**
> - **加 legacy phase 保护 non-El-Alamein**：原 `getCurrentStrategicPhase` fallback 返回 `counter_attack`（grace 720/commit 0.4/cooldown 120）实际改变了 dual_island 行为（原 baseline 60/0.75/50）。新加 `legacy` phase key 完全 mirror 原 hardcoded baseline 参数，non-El-Alamein scenario 返回 `legacy`，dual_island 行为 0 变化
>
> **v3.1 post-impl doc fix (yuqiaohuang)**:
> - V25 / V27 验证方式改写：`getCurrentStrategicPhase` 虽 export 但前端未挂 `window`，dev console 无法直接调。改用**间接 diagnostic 观察**（按时间窗 cross-check `state.diagnostics` 里 P1/P2/P3 条目出现/缺失模式），不需改代码

> **目的**：在 V2.1 已完成的 deployment + economy 调整基础上，把 **strategic phase logic** 中心化到 `pressureDirector.ts`（导演），让 `defensiveAI.ts` 退回 executor 角色。修复 V2.1 playtest 发现的"开局 60s 钢铁洪流"问题（P2 massed offensive 在新 reserve pool 下输出超 spec）。
>
> **为什么是路 B 不是路 A**：路 A（直接调 defensiveAI const）工程量小但持续侵蚀 baseline，每加一轮就让 defensiveAI 越来越像 director；路 B 一次性把 strategic timing decisions 集中到 pressureDirector（它本来就是导演），defensiveAI 只读 phase config 当 executor。**路 B 多 16 行代码换"职责清晰 + 未来调参只改一个文件"**。
>
> **要 codex 评判的核心问题**：① PHASE_STRATEGY 的 5 个 phase 划分 + 参数是否合理；② defensiveAI 改 import + ~10 行 phase lookup 是否破坏链路；③ 删除路径从 3 步变 4 步是否可接受；④ codex round 1/2 的 fallback target 改动是否应该保留（我的判断是保留）。

---

## 0. 当前状态 + 问题诊断

### 0.1 V2.1 后状态 snapshot
- HEAD `2d281a4`（origin/main），worktree branch `worktree-step-5c-lite`
- 5C-lite v1 (pressureDirector + rating) ✓
- Codex round 1 fix (history time-window + per-index claim) ✓
- Codex round 2 fix (defensiveAI fallback target → forward post) ✓
- V2.1 deployment 增量 (+25 玩家 / +14 敌方) ✓
- V2.1 economy 调整 (敌方 money/fuel/ammo 下调) ✓

### 0.2 V2.1 playtest 发现的问题
- **症状**: 开局 60-150s 出现 ~30 enemy unit 一波"装甲洪流"压向玩家，随后坦克半路 fuel 耗尽停住，infantry 继续走
- **诊断**:
  - Root cause = `defensiveAI.massedOffensive()` 在 `state.time ≥ 60` 就 fire，且 `P2_COMMIT_RATIO=0.75 × pool ≈ 40 = 30 unit` 一波
  - fuel 400 起始不够支撑 30 unit movement → 半路停车（症状，不是 root cause）
  - **pressureDirector grace 是 90s，但 P2 已经在 60s fire 了，PD 还没启动就被抢戏**
- **不是问题的**:
  - fog 关闭状态跟洪流无关（`isVisibleToEnemy()` 不查 fog state）
  - codex round 1/2 的 fallback target 改动是对的（K=3 模式下打 forward post 是正确行为，不要撤回）

### 0.3 设计 intent（5C-lite 整体重申）

| 时间 | 主导节奏 | 玩家体验 |
|---|---|---|
| 0-3 min | 展开 + 试探 | 双方看清布阵, 第一波小骚扰 |
| 3-12 min | **多重战线压力** | 3 个 forward post 反复受压 + 玩家想推 Axis obj 时被反推 |
| 12-22 min | 反扑拉扯 | 中等规模 enemy 反攻 + 双方互拉据点 |
| 22-30 min | **总攻 / 总防** | 按 score 切 stance：落后总攻，领先总防 |

V2.1 的 deployment + economy 已经 set up，**V3 只解决"时序"问题**。

---

## 1. 路 B 核心架构理念

### 1.1 职责重新划分

```
┌─────────────────────────────────────────────────────────────────┐
│  pressureDirector.ts (扩展)                                      │
│                                                                  │
│  原职责: P4 wave director                                        │
│  + 新职责: Strategic Phase 计算 + 输出 phase config 供 executor 读 │
│                                                                  │
│  Exports:                                                        │
│    export function processPressureDirector(state, dt) // 已有    │
│    export function resetPressureDirector()             // 已有    │
│  + export const PHASE_STRATEGY = { observation: {...}, ... }     │
│  + export function getCurrentStrategicPhase(state): PhaseKey     │
└────────────────────┬─────────────────────────────────────────────┘
                     │ (defensiveAI import phase config)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  defensiveAI.ts (executor)                                       │
│                                                                  │
│  P0 reactiveCounterattack    : grace 0, 不变 (recapture 即时)    │
│  P1 opportunisticAttack      : grace/cap 从 phase config 读      │
│  P2 massedOffensive          : grace/cap/ratio/cooldown 从 cfg 读│
│  P3 proactiveProbe           : grace/max units 从 cfg 读         │
│                                                                  │
│  原硬编码 const 改为 const fallback default (删 PD 时用)         │
└──────────────────────────────────────────────────────────────────┘
                     │
                     ▼
              unit.state 协调层 (不变)
```

### 1.2 设计原则

| 原则 | 说明 |
|---|---|
| **单一 source of truth** | 所有 strategic timing decisions 都在 PHASE_STRATEGY，要调节奏只改一处 |
| **import const, 不 import state** | defensiveAI 从 PD import const + 1 个 pure function，**不读 PD 内部 module state**，符合 § 0 "不共享 module state" 铁律 |
| **deletability 对称** | 删 PD 后 defensiveAI 的 import 失败 → 替换为硬编码 fallback default 即可恢复（详见 § 10 删除路径） |
| **P0 不动** | reactiveCounterattack 是真"反应系统"，永远响应玩家威胁 Axis objective，不该被 phase gate |
| **codex round 1/2 保留** | fallback target → forward post 是设计修正（K=3 模式语义），与 timing 调整正交 |

---

## 2. PHASE_STRATEGY 定义

### 2.1 5 个 phase

```ts
// 在 pressureDirector.ts 新增

export type StrategicPhase =
  | "observation"       // 0-180s: 展开试探 (El Alamein only)
  | "multi_line"        // 180-720s: 多线压力 (主体, El Alamein only)
  | "counter_attack"    // 720-1320s: 反扑拉扯 (El Alamein only)
  | "endgame_offense"   // 1320s+, score > 0 (玩家领先): 总攻挽回 (El Alamein only)
  | "endgame_defense"   // 1320s+, score ≤ 0 (敌方持平/领先): 总防/拖时间 (El Alamein only)
  | "legacy";           // 非 El Alamein scenario (dual_island 等): 原 defensiveAI baseline 行为

export interface PhaseConfig {
  /** P1 opportunistic attack: 不早于这个时间 fire */
  p1Grace: number;
  /** P2 massed offensive: 不早于这个时间 fire (9999 = effectively disabled) */
  p2Grace: number;
  /** P3 probe: 不早于这个时间 fire */
  p3Grace: number;
  /** P2 commit ratio (pool 抽多少比例) */
  p2CommitRatio: number;
  /** P2 cooldown between waves */
  p2CooldownSec: number;
  /** P3 probe wave max unit count */
  p3MaxUnits: number;
  /** P1 opportunistic attack wave max unit count (replaces hard-coded P2_MAX_ATTACK=8) */
  p1MaxAttack: number;
}

export const PHASE_STRATEGY: Record<StrategicPhase, PhaseConfig> = {
  observation: {
    // 0-180s: 只允许 P0 reactive + P4 wave 1 (90s grace 后)
    p1Grace: 9999,
    p2Grace: 9999,
    p3Grace: 9999,
    p2CommitRatio: 0,
    p2CooldownSec: 9999,
    p3MaxUnits: 0,
    p1MaxAttack: 0,
  },
  multi_line: {
    // 180-720s: P1 opp + P3 probe + P4 cont, 不 fire P2
    p1Grace: 180,
    p2Grace: 9999,
    p3Grace: 120,
    p2CommitRatio: 0,
    p2CooldownSec: 9999,
    p3MaxUnits: 4,
    p1MaxAttack: 5,
  },
  counter_attack: {
    // 720-1320s: 加入 P2 中等反攻
    p1Grace: 0,
    p2Grace: 720,
    p3Grace: 0,
    p2CommitRatio: 0.4,
    p2CooldownSec: 120,
    p3MaxUnits: 4,
    p1MaxAttack: 5,
  },
  endgame_offense: {
    // 1320s+ AND score > 0 (玩家领先): 总攻挽回 (P2 aggressive + HQ unlock 已 gated 在 1200s/lost 2)
    p1Grace: 0,
    p2Grace: 0,
    p3Grace: 0,
    p2CommitRatio: 0.7,
    p2CooldownSec: 60,
    p3MaxUnits: 4,
    p1MaxAttack: 6,
  },
  endgame_defense: {
    // 1320s+ AND score ≤ 0 (敌方持平/领先): 总防 (P2 几乎不出击, 守住等 timeout)
    p1Grace: 0,
    p2Grace: 9999,
    p3Grace: 9999,
    p2CommitRatio: 0.15,
    p2CooldownSec: 240,
    p3MaxUnits: 0,
    p1MaxAttack: 4,
  },
  legacy: {
    // Non-El-Alamein scenarios (dual_island, etc.): mirror original
    // hardcoded defensiveAI baseline exactly — DO NOT change.
    // Hardcoded sources:
    //   p1Grace=60   ← opportunisticAttack line 497: `state.time < 60`
    //   p2Grace=60   ← massedOffensive line 563: `state.time < 60`
    //   p3Grace=60   ← proactiveProbe line 1198: `PROBE_START_TIME = 60`
    //   p2CommitRatio=0.75 ← original `P2_COMMIT_RATIO`
    //   p2CooldownSec=50   ← original `P2_COOLDOWN_SEC`
    //   p3MaxUnits=6       ← original `PROBE_MAX_UNITS`
    //   p1MaxAttack=8      ← original `P2_MAX_ATTACK` (was reused as P1 cap)
    p1Grace: 60,
    p2Grace: 60,
    p3Grace: 60,
    p2CommitRatio: 0.75,
    p2CooldownSec: 50,
    p3MaxUnits: 6,
    p1MaxAttack: 8,
  },
};
```

### 2.2 节奏验证 table

| 时间窗 | Phase | P0 反夺 | P1 opp | P2 massed | P3 probe | P4 (PD) | 玩家体验 |
|---|---|---|---|---|---|---|---|
| 0-90s | observation | ✅ | ❌ (9999) | ❌ (9999) | ❌ (9999) | ❌ grace | 双方展开 |
| 90-120s | observation | ✅ | ❌ | ❌ | ❌ | **P4 wave 1** | 第一波小骚扰 |
| 120-180s | observation | ✅ | ❌ | ❌ | ❌ | P4 cont | 仍然安静 |
| 180-300s | multi_line | ✅ | ✅ (just unlocked) | ❌ | ✅ probe 3-4 | P4 cont | 试探期 — 小队摸前哨 |
| 300s-12 min | multi_line | ✅ | ✅ opp 5 | ❌ | ✅ probe | P4 cont (mid 8 min+) | **多线压力期** Chen 高频 |
| 12-22 min | counter_attack | ✅ | ✅ | ✅ **P2 wave 12-16 every 2 min** | ✅ | P4 cont (hard 18 min+) | **反扑拉扯期** |
| 22-30 min | endgame_offense (score > 0, **玩家领先**) | ✅ | ✅ | ⚡ **P2 aggressive** (commit 0.7, cooldown 60s) | ✅ | P4 cont | 敌方**总攻**挽回 |
| 22-30 min | endgame_defense (score ≤ 0, **敌方持平/领先**) | ✅ | ✅ | ⚡ **P2 sleeping** (p2Grace=9999) | ❌ | P4 cont | 敌方**总防**, 守住等 timeout |

---

## 3. getCurrentStrategicPhase 逻辑

```ts
// 在 pressureDirector.ts 新增 (跟 PHASE_STRATEGY 同 file)

/**
 * Pure function: computes current strategic phase from game state.
 * No module-level state read. Idempotent. Safe to call multiple times per tick.
 */
export function getCurrentStrategicPhase(state: GameState): StrategicPhase {
  // Non-El-Alamein scenarios (dual_island etc.): return "legacy" phase whose
  // config exactly mirrors the original hardcoded defensiveAI baseline.
  // This preserves dual_island and any other legacy scenario behavior unchanged.
  if (state.scenarioId !== "el_alamein") return "legacy";
  if (!state.scenarioWinConfig) return "legacy";

  const t = state.time;
  if (t < 180) return "observation";
  if (t < 720) return "multi_line";
  if (t < 1320) return "counter_attack";

  // Endgame: score-aware stance.
  // score = capturedAxisObjectives - lostPlayerForwardPosts (player's perspective,
  // matches warPhase.endGameWithRating exactly)
  // From enemy AI viewpoint:
  //   score > 0  = player winning  → enemy is BEHIND  → "总攻" to break it
  //   score ≤ 0  = enemy tied/ahead → enemy holds advantage → "总防" to force timeout
  const captured = (state.captureObjectives ?? [])
    .filter((id) => state.facilities.get(id)?.team === "player").length;
  const lost = state.scenarioWinConfig.friendlyKeypoints.filter((id) => {
    const f = state.facilities.get(id);
    return !f || f.hp <= 0 || f.team !== "player";
  }).length;
  const score = captured - lost;

  return score > 0 ? "endgame_offense" : "endgame_defense";
}
```

**Key design**:
- Pure function（state in → enum out），无副作用，无 module state read
- Non-El-Alamein scenarios（dual_island 等）returns `"legacy"`，其 PHASE_STRATEGY.legacy 完全 mirror 原 hardcoded baseline (60/60/60, 0.75, 50, 6, 8)，**dual_island 行为 0 变化** — codex round 1/2 的 fallback target 改动也对 dual_island 自然 inert（它们走 `state.scenarioWinConfig.friendlyKeypoints` 路径，dual_island 无 scenarioWinConfig 则跳过新代码 path）
- score 公式跟 `warPhase.endGameWithRating` 完全一致（同一 source of truth）
- **score 方向**: 玩家视角，captured - lost；score > 0 = 玩家领先 = 敌方落后 → 总攻；score ≤ 0 = 敌方持平/领先 → 总防（V3.1 修正了 V3 反了的写法）

---

## 4. pressureDirector.ts 改动

### 4.1 新增内容 (~45 行)

```diff
+ // ── Strategic Phase Director (5C-lite v3) ──
+ //
+ // Centralized strategic timing logic. defensiveAI imports PHASE_STRATEGY
+ // const + getCurrentStrategicPhase() function, then uses the phase config
+ // to gate its P1/P2/P3 stage decisions. This keeps the "director" role in
+ // pressureDirector and lets defensiveAI stay an executor without growing
+ // its own time-phase logic.
+ //
+ // import-only coupling: defensiveAI imports the CONST and PURE FUNCTION,
+ // not module state. No shared mutable Set. Coordination layer is still
+ // unit.state (per § 0 of STEP_5C_LITE_WORKPLAN.md).
+
+ export type StrategicPhase =
+   | "observation"
+   | "multi_line"
+   | "counter_attack"
+   | "endgame_offense"
+   | "endgame_defense"
+   | "legacy";
+
+ export interface PhaseConfig {
+   p1Grace: number;
+   p2Grace: number;
+   p3Grace: number;
+   p2CommitRatio: number;
+   p2CooldownSec: number;
+   p3MaxUnits: number;
+   p1MaxAttack: number;
+ }
+
+ export const PHASE_STRATEGY: Record<StrategicPhase, PhaseConfig> = {
+   observation:     { p1Grace: 9999, p2Grace: 9999, p3Grace: 9999, p2CommitRatio: 0,    p2CooldownSec: 9999, p3MaxUnits: 0, p1MaxAttack: 0 },
+   multi_line:      { p1Grace: 180,  p2Grace: 9999, p3Grace: 120,  p2CommitRatio: 0,    p2CooldownSec: 9999, p3MaxUnits: 4, p1MaxAttack: 5 },
+   counter_attack:  { p1Grace: 0,    p2Grace: 720,  p3Grace: 0,    p2CommitRatio: 0.4,  p2CooldownSec: 120,  p3MaxUnits: 4, p1MaxAttack: 5 },
+   endgame_offense: { p1Grace: 0,    p2Grace: 0,    p3Grace: 0,    p2CommitRatio: 0.7,  p2CooldownSec: 60,   p3MaxUnits: 4, p1MaxAttack: 6 },
+   endgame_defense: { p1Grace: 0,    p2Grace: 9999, p3Grace: 9999, p2CommitRatio: 0.15, p2CooldownSec: 240,  p3MaxUnits: 0, p1MaxAttack: 4 },
+   // legacy = exact mirror of original hardcoded defensiveAI baseline; non-El-Alamein scenarios use this
+   legacy:          { p1Grace: 60,   p2Grace: 60,   p3Grace: 60,   p2CommitRatio: 0.75, p2CooldownSec: 50,   p3MaxUnits: 6, p1MaxAttack: 8 },
+ };
+
+ export function getCurrentStrategicPhase(state: GameState): StrategicPhase {
+   // Non-El-Alamein scenarios → legacy (mirrors original hardcoded baseline)
+   if (state.scenarioId !== "el_alamein") return "legacy";
+   if (!state.scenarioWinConfig) return "legacy";
+
+   const t = state.time;
+   if (t < 180) return "observation";
+   if (t < 720) return "multi_line";
+   if (t < 1320) return "counter_attack";
+
+   // Endgame: score = capturedAxisObjectives - lostPlayerForwardPosts (player's perspective).
+   // score > 0 = player winning = enemy losing → 总攻 (offense)
+   // score ≤ 0 = enemy tied/ahead → 总防 (defense, hold for timeout)
+   const captured = (state.captureObjectives ?? [])
+     .filter((id) => state.facilities.get(id)?.team === "player").length;
+   const lost = state.scenarioWinConfig.friendlyKeypoints.filter((id) => {
+     const f = state.facilities.get(id);
+     return !f || f.hp <= 0 || f.team !== "player";
+   }).length;
+   const score = captured - lost;
+
+   return score > 0 ? "endgame_offense" : "endgame_defense";
+ }
```

放在 pressureDirector.ts 文件顶部，紧跟 imports 之后、现有 cadence constants 之前。

### 4.2 pressureDirector 自己的 P4 logic 不变

P4 wave cadence、size、cooldown、history penalty、production boost、reissue claim — **全部不动**。strategic phase 只 export 出去给 defensiveAI 用，pressureDirector 自己不读。

（未来 5D 可以考虑让 P4 wave size 也跟 phase 走，但 V3 不做）

---

## 5. defensiveAI.ts 改动 (~15 行)

### 5.1 顶部 import + helper

```diff
  import type { GameState, Unit, Position, Order, UnitType } from "@ai-commander/shared";
  import { getUnitCategory } from "@ai-commander/shared";
  import { applyEnemyOrders } from "../../applyOrders";
  import { canUnitEnterTile } from "../../sim";
  import { enqueueProduction } from "../../economy";
+ import { PHASE_STRATEGY, getCurrentStrategicPhase, type PhaseConfig } from "./pressureDirector";
```

```diff
+ // ── 5C-lite v3 tuning history ──
+ // round 1: codex fallback target → forward post (designed K=3 semantic, kept)
+ // round 2: codex selectP2Target also routes to forward post (kept)
+ // round 3 (v3): timing gates pulled from PHASE_STRATEGY (pressureDirector)
+ //   - Original hard-coded grace `state.time < 60` in P1/P2/P3 replaced with
+ //     cfg.p1Grace / cfg.p2Grace / cfg.p3Grace
+ //   - PROBE_START_TIME, PROBE_MAX_UNITS, P2_COMMIT_RATIO, P2_COOLDOWN_SEC,
+ //     P2_MAX_ATTACK (which was actually P1 cap) — all read from PHASE_STRATEGY
+ //   - Original const kept as DEFAULT_FALLBACK_PHASE_CONFIG below for the
+ //     "delete pressureDirector entirely" path (see workplan § 10)
+
+ function getPhaseConfig(state: GameState): PhaseConfig {
+   return PHASE_STRATEGY[getCurrentStrategicPhase(state)];
+ }
```

### 5.2 P1 opportunisticAttack 改动

line ~496-558 范围：

```diff
  function opportunisticAttack(state: GameState): void {
-   if (state.time < 60) return; // grace period
+   const cfg = getPhaseConfig(state);
+   if (state.time < cfg.p1Grace) return; // phase-gated grace
    if (state.time < p1CooldownUntil) return;
    if (activeAttackerIds.size >= MAX_ACTIVE_ATTACKERS) return;
    ...
    const p1Budget = MAX_ACTIVE_ATTACKERS - activeAttackerIds.size;
-   const attackers = reserves.slice(0, Math.min(P2_MAX_ATTACK, reserves.length, p1Budget));
+   const attackers = reserves.slice(0, Math.min(cfg.p1MaxAttack, reserves.length, p1Budget));
```

### 5.3 P2 massedOffensive 改动

line ~562-619 范围：

```diff
  function massedOffensive(state: GameState): void {
-   if (state.time < 60) return;
+   const cfg = getPhaseConfig(state);
+   if (state.time < cfg.p2Grace) return; // phase-gated grace
    if (state.time < p2CooldownUntil) return;
    if (activeAttackerIds.size >= MAX_ACTIVE_ATTACKERS_HARD) return;
    ...
    const budget = MAX_ACTIVE_ATTACKERS_HARD - activeAttackerIds.size;
-   const commitCount = Math.min(Math.ceil(pool.length * P2_COMMIT_RATIO), budget);
+   const commitCount = Math.min(Math.ceil(pool.length * cfg.p2CommitRatio), budget);
    if (commitCount < 4) return;
    ...
    offensiveWaveCount++;
-   p2CooldownUntil = state.time + P2_COOLDOWN_SEC;
+   p2CooldownUntil = state.time + cfg.p2CooldownSec;
```

### 5.4 P3 proactiveProbe 改动

line ~1197-1256 范围：

```diff
  function proactiveProbe(state: GameState): void {
-   if (state.time < PROBE_START_TIME) return;
+   const cfg = getPhaseConfig(state);
+   if (state.time < cfg.p3Grace) return; // phase-gated grace
+   if (cfg.p3MaxUnits === 0) return; // phase explicitly disables probe
    if (state.time < probeCooldownUntil) return;
    if (activeAttackerIds.size >= MAX_ACTIVE_ATTACKERS) return;
    ...
    const budget = MAX_ACTIVE_ATTACKERS - activeAttackerIds.size;
-   const count = Math.min(PROBE_MAX_UNITS, sorted.length, budget);
+   const count = Math.min(cfg.p3MaxUnits, sorted.length, budget);
```

### 5.5 不动

- `reactiveCounterattack` (P0) — 无 grace，玩家碰 Axis objective 即时反应
- `manageEconomy` / `garrisonBehavior` / `reissueAttackerOrders` / `assignRoles` — 无 timing 决策
- `selectP2Target` / `findPlayerPressureTarget` / `shouldAssaultPlayerHQ` — 已经 codex round 1/2 改对了
- 原 const `P2_MAX_ATTACK`, `PROBE_START_TIME`, `PROBE_MAX_UNITS`, `P2_COMMIT_RATIO`, `P2_COOLDOWN_SEC` — **保留**，但实际不读。注释标记 "5C-lite v3: replaced by PHASE_STRATEGY, kept for fallback if PD removed"。

### 5.6 总改动统计

- import line: +1
- tuning history 注释 + helper function: +12 行
- P1 grace + p1MaxAttack: 改 2 行
- P2 grace + commitRatio + cooldown: 改 3 行
- P3 grace + maxUnits + 加 "explicitly disabled" check: 改 3 行
- **总计 ~21 行**（比 § 1.2 估算的 ~15 多 6 行，因为 history comment + p3 explicit disable check）

---

## 6. elAlamein/index.ts 改动 (fuel 调整)

### 6.1 enemy fuel: 400 → 1500

```diff
       enemy: (() => {
         const eco = makeEconomy();
-        // 5C-lite v2.1: 起始略弱玩家 (78 vs 85)、AI 持续产能效率更强
-        // money: 12,500 total (3500 + 150×60)
-        // fuel:  2,200 total (400 + 30×60) — 1.5× of 30-min demand (~1,150)
-        // ammo:  2,025 total (225 + 30×60)
+        // 5C-lite v3: fuel 调回 1500 (V2.1 时为 400, 不够支撑 P2 wave movement)
+        //   - Not used to control aggression rhythm — that's PHASE_STRATEGY's job
+        //   - 1500 起始 + 30×60 income = 3,300 total ≈ 1.6× of V2.1 30-min demand
+        // money: 12,500 total (3500 + 150×60) — unchanged from V2.1
+        // fuel:  3,300 total (1500 + 30×60) — was 2,200 in V2.1
+        // ammo:  2,025 total (225 + 30×60) — unchanged
         eco.resources.money = 3500;
-        eco.resources.fuel = 400;
+        eco.resources.fuel = 1500;
         eco.resources.ammo = 225;
         eco.baseIncome = { money: 150, fuel: 30, ammo: 30, intel: 10 };
         return eco;
       })(),
```

### 6.2 为什么 1500 不是 2000

- 30-min movement demand 估算（V2.1 § 3.4）: ~1,150 fuel
- 1500 起始 + 1,800 income = 3,300 total → **2.9× of demand**，buffer 充足
- 2000 起始 + 1,800 income = 3,800 total → **3.3× of demand**，过剩
- 1500 是"够用 + 不浪费"的 sweet spot

### 6.3 fuel 不再控节奏

V2.1 的 400 是 codex 想用 "低 fuel" 拖慢敌方装甲，但实际上：
- 30 unit P2 wave 一波就抽干 fuel（30 × ~30 tile = 900，超过 400）
- → 一半坦克半路停车，gameplay 视觉混乱
- **fuel 不该作为节奏 lever**，节奏由 PHASE_STRATEGY 控制；fuel 只保证装甲能完成 dispatch

---

## 7. § 0 铁律 status 更新

| 文件 | V1 plan 要求 | V3 状态 |
|---|---|---|
| `defensiveAI.ts` | 0 改动 | ❌ 3 轮改动累积（round 1/2 target，round 3 import + grace 替换）。V3 明确"defensiveAI 不再是 untouched baseline，是 5C-lite executor" |
| `autoBehavior.ts` / `combat.ts` / `sim.ts` / `pathfinding.ts` / `fog.ts` / `enemyAI.ts` / `reportSignals.ts` / `advisorTrigger.ts` | 0 改动 | ✅ 仍 0 改动 |
| shared `intents.ts` / `squad.ts` / `schema.ts` | 0 改动 | ✅ 仍 0 改动 |
| `apps/server/**` | 0 改动 | ✅ 仍 0 改动 |
| `pressureDirector.ts` | 新文件 | V3 扩展（+45 行 phase 系统） |
| `elAlamein/deployment.ts` / `index.ts` / `warPhase.ts` / shared types / GameCanvas / CSS | scenario polish 允许 | ✅ V1+V2.1 改动保留 |

### 7.1 V3 是诚实的妥协

V3 明确放弃 "defensiveAI 100% baseline" 的假设，但通过 import-only coupling（const + pure function，不共享 module state）把破坏控制在最小：

- defensiveAI 不读 PD 的 internal Set/Map
- defensiveAI 不写任何 PD 的 state
- 仍然是 unit-state 协调
- 删 PD 时 defensiveAI 只需替换 import 为本地 default config（详见 § 10）

---

## 8. 预期完整节奏（验证 design intent 满足）

### 8.1 时间线

```
0───3min──────────────12min─────────────────22min──────────────30min
│ observation │ multi_line │     counter_attack     │  endgame_*    │
│             │            │                        │ score-aware:  │
│             │            │                        │  >0 → offense │
│             │            │                        │  ≤0 → defense │
│ P0: ✓       │ P0: ✓      │ P0: ✓                  │ P0: ✓         │
│ P1: ❌      │ P1: ✓ 5    │ P1: ✓ 5                │ P1: ✓ 4-6     │
│ P2: ❌      │ P2: ❌     │ P2: 16-unit/2min       │ P2:           │
│             │            │                        │  off: 0.7/60s │
│             │            │                        │  def: sleeping│
│ P3: ❌      │ P3: ✓ 3-4  │ P3: ✓ 3-4              │ P3:           │
│             │            │                        │  off: ✓       │
│             │            │                        │  def: ❌      │
│ P4: 1-2wave │ P4: cont   │ P4: mid/hard phase     │ P4: cont      │
│             │            │                        │               │
│ Player:     │ Player:    │ Player:                │ Player:       │
│  展开       │  Chen 高频 │  忙救火 + 推 obj       │  决战 / 拖    │
│  布阵       │  3 线压力  │  双向拉扯              │  按 score     │
└─────────────┴────────────┴────────────────────────┴───────────────┘
```

### 8.2 关键测试场景预期

| 场景 | V2.1 实际表现 | V3 预期 |
|---|---|---|
| 0-90s | 30-unit 装甲洪流 + 半路停车 | 双方静默展开, 无 enemy 主动进攻 |
| 90-180s | 装甲第二波 | P4 wave 1 (4-5 unit) 打 forward post, 其他静默 |
| 3-12 min | 混乱叠加 | 3 个 forward post 反复受 P1+P3+P4 小骚扰, 多线压力 |
| 玩家推 Axis obj at t=600 | defensiveAI 没特殊反应 | P0 反推 + P1 opp 趁机打另一前哨 |
| 玩家拿下 Axis obj at t=800 | 立刻被 30 unit P2 总攻夺回 | P0 反夺 + P2 counter_attack 中规模反扑 (16 unit) |
| 12+ min | P2 持续大波 | P2 每 2 min fire 12-16 unit |
| 22+ min, score +1 (玩家领先) | 同上 | 切 **endgame_offense**, P2 commit 0.7 / cooldown 60s, HQ assault active, 敌方总攻挽回 |
| 22+ min, score 0 (平局) | 同上 | 切 **endgame_defense**, P2 几乎 sleep (p2Grace=9999), P3 关闭, 守住等 timeout (timeout 时玩家 draw rating) |
| 22+ min, score -1 (敌方领先) | 同上 | 切 **endgame_defense**, 同上, 守住等 timeout (timeout 时玩家 minor defeat rating) |

---

## 9. 验证 plan (V1-V19 + V20-V27)

### 9.1 V1-V19 (已在 5C-lite v1 通过, V3 不应破坏)

| # | 项 | V3 预期 |
|---|---|---|
| V1-V3 | typecheck / build / localhost leak | PASS |
| V4 | HUD 0/3 | 不变 |
| V5-V8 | playtest P4 / Chen | 不变 (PD 自己 logic 不动) |
| V9-V11.2 | 5 个 rating | 不变 |
| V12-V14 | 立即 endGame | 不变 |
| V15-V16 | commander 死 gate | 不变 |
| V17-V18 | prod / playtest off | 不变 |
| V19 | 删 5C-lite typecheck | **改 V19 验证流程**：删 PD 后还要 revert defensiveAI 的 import + grace 回硬编码 default (见 § 10)。验证 4-step delete typecheck pass |

### 9.2 V20-V27 (V2.1 加的 + V3 新加 V25)

| # | 项 | V3 预期 |
|---|---|---|
| V20 | 30-min 产能 ~33/玩家, ~50/敌方 | 不变 |
| V21 | fuel 不耗尽 | **改预期**: enemy fuel 1500 起始 + 没有 30-unit P2 wave 早期 → mechanized 不应再"集体停车" |
| V22 | P4 cadence 140s ± 20s | 不变 |
| V23 | 三线进攻可行 | 不变 |
| V24 | 前 10 min 敌方主力目标是 forward post | 不变 (codex round 1/2 保留) |
| **V25 (V3 新加)** | strategic phase 切换正确 | `getCurrentStrategicPhase` 是 pure function export，但前端没把它挂到 `window`，dev console 不能直接调。改用**间接 diagnostic 观察**：playtest 时盯 `state.diagnostics` 流（或事后 dump）按时间窗 cross-check phase 行为—— ① 0-180s：不应有 `P1`/`P2`/`P3` 开头条目（observation 全闸死）；② 180-720s：开始见 `P1 opp-attack`（multi_line p1Grace=180）和 `P3 probe`（p3Grace=120 在 phase 起点已满足），**不应**见 `P2 massed wave=`（p2Grace=9999）；③ 720s 之后首次 `P2 massed wave=1` 应出现（counter_attack p2Grace=720）；④ 1320s 后按 score 切 endgame_* 由 V27 单独验。如需精确确认 phase 名，可在 `processDefensiveAI` 顶层临时插一行 `pushDiagnostic(state, ...)`（打 `getCurrentStrategicPhase(state)` 字符串），观察后立即 revert——但本提案 default 不修代码 |
| **V26 (V3 新加)** | 0-180s 没有 P2 wave | playtest 头 3 min 内 `state.diagnostics` 不应有 `P2 ` 开头的日志 |
| **V27 (V3 新加)** | 22 min 后 score-aware stance 方向正确 | 同 V25 改用间接 diagnostic 观察。两次 playtest 跑到 22+ min 制造不同 score：① **score = +1（玩家领先）→ endgame_offense**：22-30 min 期间应见 `P2 massed wave=N` 高频出现（cooldown 60s，每 1-2 min 一波，commit 0.7 = 大波），`P3 probe` 仍 fire；② **score = 0 或 -1（敌方持平/领先）→ endgame_defense**：22-30 min 期间**不应**新增 `P2 massed wave=` 条目（p2Grace=9999 闸死），也不应见 `P3 probe`（p3MaxUnits=0 explicit disable），只剩 `P0 counterattack` 和 `P1 opp-attack`。如难精确控制 score，可临时改 `warPhase.ts` 把 timeout 调到 60s 跑短测；测完 revert |

---

## 10. 删除路径 (从 3 步变 4 步)

### 10.1 完整删 5C-lite 步骤 (V3)

| 步 | 操作 | 影响 |
|---|---|---|
| 1 | 删整个文件 `pressureDirector.ts` | TypeScript 报 defensiveAI.ts 的 import 错 |
| 2 | 删 `core/src/index.ts` 1 行 export | — |
| 3 | 删 `apps/web/src/GameCanvas.tsx` 6 行 (import + tick + 2 reset + P4_DBG) | — |
| **4 (新)** | **defensiveAI.ts revert: 删 import + helper function + 替换 cfg.xxx 回硬编码默认** | 恢复到 codex round 1/2 后状态（不是完全 origin） |

### 10.2 第 4 步具体内容

```diff
- import { PHASE_STRATEGY, getCurrentStrategicPhase, type PhaseConfig } from "./pressureDirector";
- // ... 12 行 tuning history 注释
- function getPhaseConfig(state: GameState): PhaseConfig { ... }

  function opportunisticAttack(state: GameState): void {
-   const cfg = getPhaseConfig(state);
-   if (state.time < cfg.p1Grace) return;
+   if (state.time < 60) return;
    ...
-   const attackers = reserves.slice(0, Math.min(cfg.p1MaxAttack, ...));
+   const attackers = reserves.slice(0, Math.min(P2_MAX_ATTACK, ...));
  }

  function massedOffensive(state: GameState): void {
-   const cfg = getPhaseConfig(state);
-   if (state.time < cfg.p2Grace) return;
+   if (state.time < 60) return;
    ...
-   const commitCount = Math.min(Math.ceil(pool.length * cfg.p2CommitRatio), budget);
+   const commitCount = Math.min(Math.ceil(pool.length * P2_COMMIT_RATIO), budget);
    ...
-   p2CooldownUntil = state.time + cfg.p2CooldownSec;
+   p2CooldownUntil = state.time + P2_COOLDOWN_SEC;
  }

  function proactiveProbe(state: GameState): void {
-   const cfg = getPhaseConfig(state);
-   if (state.time < cfg.p3Grace) return;
-   if (cfg.p3MaxUnits === 0) return;
+   if (state.time < PROBE_START_TIME) return;
    ...
-   const count = Math.min(cfg.p3MaxUnits, sorted.length, budget);
+   const count = Math.min(PROBE_MAX_UNITS, sorted.length, budget);
  }
```

### 10.3 V3 删除路径的 trade-off

| 维度 | V1 (原) | V3 (路 B) |
|---|---|---|
| 删除步骤数 | 3 步 | 4 步 |
| 删除涉及文件 | 3 个 | 4 个 |
| 第 4 步是否机械化 | — | ✅ 机械化, 完全可预测（只是替换 cfg.xxx → 硬编码原值） |
| defensiveAI 删后状态 | unchanged baseline | codex round 1/2 + V3 grace revert 后状态 (round 1/2 保留是设计修正) |

**关键**: 第 4 步是**纯机械的 search-and-replace**，没有 logic 改动判断。脚本化可行。

### 10.4 也可以选择"只删 V3 timing 改动，保留 PD"

如果以后觉得 P4 wave 系统好但 phase strategy 不对，可以单独 revert V3 而保留 PD：
1. 删 pressureDirector.ts 的 PHASE_STRATEGY block + getCurrentStrategicPhase function (~45 行)
2. defensiveAI.ts 执行 § 10.2 的 revert (~15 行)
3. PD 的 P4 wave 继续工作

这是 V3 比 V1 多的 flexibility。

---

## 11. 给 codex 的问题

1. **PHASE_STRATEGY 5 个 phase 划分 + 参数合理吗？**
   - 0-3 min observation, 3-12 min multi_line, 12-22 min counter_attack, 22+ endgame_* — 时间窗对吗？
   - p2CommitRatio 0.4 → 0.7 (offense) / 0.15 (defense) — 阈值过大/过小？
   - p1MaxAttack 5 (multi_line/counter), 6 (endgame_offense), 4 (endgame_defense) — 反应 OODA loop？

2. **defensiveAI 改 ~21 行是否破坏链路？**
   - import const + pure function (不是 import state) — 是否符合 § 0 "不共享 module state" 的精神？
   - 第 4 步删除路径机械化 search-and-replace 是否充分？

3. **codex round 1/2 fallback target 应该保留吗？**
   - 我的判断：保留。原因是 K=3 模式下打 forward post 是设计修正，不是 timing 改动。
   - 但是这意味着 defensiveAI 第 4 步删除后**不会回到完全 origin baseline** (round 1/2 残留)。这个 trade-off OK 吗？

4. **endgame_defense 的 p2Grace=9999 是否过度？**
   - 完全关 P2 是否会让"领先时玩家觉得 enemy 太被动"？
   - 替代方案: p2CommitRatio=0.15 + p2CooldownSec=240 (慢 + 小 wave), 不用 9999 grace。
   - 但 V2.1 测试时 commit ratio 0.4 都嫌大，0.15 是否真的够小？

5. **legacy phase 是否完全保护 non-El-Alamein scenario？**（V3.1 已加 legacy phase 解决）
   - V3 原方案：fallback 返回 `counter_attack` → dual_island 行为改变（grace 60→720, commit 0.75→0.4, cooldown 50→120）⚠
   - V3.1 修正：新增 `legacy` phase, config = `(60/60/60, 0.75, 50, 6, 8)` 完全 mirror 原硬编码 baseline
   - `getCurrentStrategicPhase` 在 `scenarioId !== "el_alamein" || !scenarioWinConfig` 时返回 `"legacy"`
   - codex round 1/2 的 fallback target 改动对 dual_island 自然 inert（它们走 `state.scenarioWinConfig.friendlyKeypoints` 路径，dual_island 无该字段则跳过新 path）
   - **请 codex 确认**: legacy phase config 跟原硬编码 baseline 是否真正 1:1 对应（line 19-38 我列的对应关系，line 497/563/1198 grace 硬编码 60，复用 `P2_MAX_ATTACK=8` 给 P1 cap）

---

## 12. 风险 + 回滚

### 12.1 风险

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | ~~dual_island scenario fallback 行为改变~~ | ~~中~~ | **V3.1 已解决** — 新增 `legacy` phase, config 完全 mirror 原硬编码 baseline, `getCurrentStrategicPhase` 在 non-El-Alamein 返回 `"legacy"`。dual_island 行为 0 变化。详 § 11 Q5 |
| R2 | endgame_defense 太被动玩家无聊 | 低 | playtest 调 commit 0.15 → 0.25 |
| R3 | endgame_offense 太凶玩家被秒 | 低 | playtest 调 commit 0.7 → 0.55 |
| R4 | phase 转切瞬间 P2 cooldown 残留导致延迟 fire | 低 | p2CooldownUntil 是绝对 state.time，phase 切换不重置 — 自然 self-correcting |
| R5 | score 计算瞬间在 22 min 边界变化导致 phase 抖动 | 低 | endgame_offense/defense 都 valid，抖动也不会出错 (commit/cooldown 平滑切换)，但日志可能多。可在 endgame phase 加 hysteresis (e.g., 一旦进入 offense, 60s 内不切回 defense) — V3 不做，留 polish |
| R6 | 第 4 步删除路径忘做导致 typecheck 失败 | 中 | workplan § 10.2 完整 diff 给出，可脚本化。V19 验证 4-step delete typecheck pass 即可 catch |

### 12.2 回滚

**V3 → V2.1 回滚** (3 步):
1. revert `pressureDirector.ts` 加的 PHASE_STRATEGY block + getCurrentStrategicPhase (~45 行)
2. revert `defensiveAI.ts` 加的 import + helper + grace/cap 替换 (~21 行, 按 § 10.2 操作)
3. revert `elAlamein/index.ts` fuel 1500 → 400

**V2.1 → V1 回滚** (不变, 见 V2.1 workplan)

**V1 → 完全删除 5C-lite** (4 步, 见 § 10.1)

---

## 13. 实施 sequence (codex 通过后)

| 步 | 操作 | 验证 |
|---|---|---|
| 1 | `pressureDirector.ts` 顶部追加 PHASE_STRATEGY + getCurrentStrategicPhase (~45 行) | typecheck — 应过 (纯加 export) |
| 2 | `defensiveAI.ts` 顶部加 import + tuning history 注释 + helper function (~15 行) | typecheck — 应过 (helper 未使用) |
| 3 | `defensiveAI.ts` P1 改 grace + p1MaxAttack (~2 行) | typecheck |
| 4 | `defensiveAI.ts` P2 改 grace + commitRatio + cooldown (~3 行) | typecheck |
| 5 | `defensiveAI.ts` P3 改 grace + maxUnits + explicit disable check (~3 行) | typecheck |
| 6 | `elAlamein/index.ts` enemy fuel 400 → 1500 + 注释 (~6 行) | typecheck |
| 7 | `npm run build` | 验证 bundle 包含新 phase consts (grep "observation", "multi_line", "endgame_offense") |
| 8 | grep -c localhost:3001 dist | 0 |
| 9 | **不 commit**, 交回 yuqiaohuang playtest |
| 10 | playtest 反馈 → 微调 PHASE_STRATEGY 参数 (中心化在 pressureDirector 1 处) |
| 11 | yuqiaohuang 确认 OK → commit + tag + push |

---

## 14. 总改动统计

| 文件 | 行数 | 类型 |
|---|---:|---|
| `pressureDirector.ts` | +45 | 加 PHASE_STRATEGY + getCurrentStrategicPhase |
| `defensiveAI.ts` | +21 | import + helper + 3 处 grace/cap/ratio 替换 |
| `elAlamein/index.ts` | +5 / -2 | enemy fuel + 注释 |
| **总计** | **~70 行** | |

跟 V2.1 时一样，**typecheck + build + localhost leak grep 全过 + 不 commit + 等 playtest**。

---

**End of V3 workplan.**
