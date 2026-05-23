# Step 5C-lite — Implementation Workplan v2

> **For handoff to a fresh Claude Code window.** Do NOT change code on first read — confirm all constraints with `yuqiaohuang` first, then implement step-by-step per §15 below.

---

## 0. 架构 / 链路保护约束（HARD CONSTRAINTS — read first）

**核心铁律：不破坏现有 function / logic，保持架构链路干净。**

### 必须 0 改动的文件
| 文件 | 不动的原因 |
|---|---|
| `packages/core/src/scenario/elAlamein/defensiveAI.ts` | 已测试稳定 baseline。pressureDirector 通过 `unit.state` 协调，不需要它改 |
| `packages/core/src/autoBehavior.ts` | team-agnostic 反射层，引擎一部分 |
| `packages/core/src/combat.ts` | 战斗结算，引擎一部分 |
| `packages/core/src/sim.ts` | 移动 / pathing 执行，引擎一部分 |
| `packages/core/src/pathfinding.ts` | A* 引擎 |
| `packages/core/src/fog.ts` | 5A 已落地，不改 |
| `packages/core/src/enemyAI.ts` | dual_island AI，El Alamein 不走它 |
| `packages/core/src/reportSignals.ts` | 事件检测器，复用即可 |
| `packages/core/src/advisorTrigger.ts` | Chen 触发规则，复用即可 |
| `packages/shared/src/intents.ts` | Intent schema，不扩 |
| `packages/shared/src/squad.ts` / `squadHierarchy.ts` | Squad 系统，不扩到 enemy |
| `packages/shared/src/schema.ts` | LLM 输出 schema，不改 |
| `apps/server/src/**` | Server / playtest deploy / LLM prompts — 全部不动 |

### 协调铁律
- **不共享 module-level state**。pressureDirector 不 import defensiveAI 的 `reserveIds`/`activeAttackerIds`/任何内部 Set
- 两个模块的协调**只能通过 `unit.state`**（idle / moving / attacking / dead）
- 如果 pressureDirector 需要 `isVisibleToEnemy` 之类 helper，在 pressureDirector.ts 里**复制 mini 版**，不 import
- pressureDirector 的内部 Set（`p4ClaimedIds` 等）**只在本文件内消费**，不 export

### 数据 schema 铁律
- **不改 Order schema**（`{ unitIds, action, target, priority, waypoints?, tradeType? }`）
- **不改 Intent schema**
- **不改 Squad / Mission 结构**
- `types.ts` 只**追加** optional 字段（`ratingThresholds` / `gameOverRating` / `gameOverBreakdown`），不删 / 不改语义

### Tick 顺序铁律
- `processPressureDirector(state, dt)` 插在 `processDefensiveAI(state, dt)` 之后、`processAutoBehavior(state, dt)` 之前
- 不动其他 tick 顺序
- 不引入新的全局调度器

### Scenario 隔离铁律
- pressureDirector 第一行 `if (state.scenarioId !== "el_alamein") return;` + `if (!state.scenarioWinConfig) return;`
- 资源调整 / deployment 替换 / win-rate / commander-death gate 全部走 `scenarioWinConfig` 路径
- **dual_island 必须 0 感知**（V16 验证项专门测这个）

### 依赖铁律
- 不引入新 npm 依赖
- 不改 `package.json` scripts
- 不改 build / deploy 流程

### 删除铁律（未来 5C-lite 退役时）
删除 5C-lite 应该是**3 步、不影响其他系统**的操作（详见 §14 末尾）。如果实现过程中发现某个改动让删除变得复杂，**停下来重新设计**。

---

## 1. 新架构图：defensiveAI 与 pressureDirector 平级协作

```
┌──────────────────────────────────────────────────────────────┐
│              GameCanvas.tsx — main tick loop                 │
│                                                              │
│  tick(state, dt):                                            │
│    updateFog(state)                                          │
│    applyPlayerCommands(state, ...)                           │
│    processEnemyAI(state, dt)         // dual_island only     │
│    processDefensiveAI(state, dt)     ◀────┐                  │
│    processPressureDirector(state, dt) ◀───┤ 平级,5s each     │
│    processAutoBehavior(state, dt)         │ no shared state  │
│    processCombat(state, dt)               │                  │
│    processReportSignals(state, dt)        │                  │
└──────────────────────────────────────────┼──────────────────┘
                                           │
                ┌──────────────────────────┴────────────────────┐
                ▼                                                ▼
   ┌─────────────────────────────┐               ┌─────────────────────────────┐
   │ defensiveAI.ts (UNCHANGED)   │               │ pressureDirector.ts (NEW)    │
   │ Strategic baseline           │               │ 5C-lite scripted pressure    │
   │                              │               │                              │
   │ Internal module state:       │               │ Internal module state:       │
   │   garrisonIds                │               │   p4Timer                    │
   │   hqGuardIds                 │               │   p4CooldownUntil            │
   │   reserveIds                 │               │   p4ClaimedIds:Set<number>   │
   │   activeAttackerIds          │               │   p4AttackerTargets:Map      │
   │   reinforcingIds             │               │   p4TargetHistory:Array      │
   │   probe/p0/p1/p2 cooldowns   │               │   p4WaveCount                │
   │                              │               │                              │
   │ Behaviors:                   │               │ Behaviors:                   │
   │   P0 reactive counterattack  │               │   P4 scored pressure event   │
   │   P1 opportunistic attack    │               │     (every 100-140s)         │
   │   P2 massed offensive        │               │   Phase escalation           │
   │   P3 proactive probe         │               │     (easy/mid/hard)          │
   │   Garrison reinforcement     │               │   Recapture priority         │
   │   Production baseline        │               │   Finish weak post           │
   │   Trade fuel/ammo            │               │   Raid w/ formation          │
   │                              │               │   Min garrison protection    │
   │                              │               │   Re-issue idle claimed      │
   │                              │               │   Production boost (if dry)  │
   │                              │               │                              │
   │ Reads state:                 │               │ Reads state:                 │
   │   units, facilities, fronts, │               │   units, facilities,         │
   │   regions, productionQueue,  │               │   captureObjectives,         │
   │   captureObjectives,         │               │   scenarioWinConfig          │
   │   reportEvents, diagnostics  │               │     .friendlyKeypoints       │
   │                              │               │   productionQueue.enemy      │
   │                              │               │   diagnostics                │
   └──────────────┬───────────────┘               └──────────────┬───────────────┘
                  │                                              │
                  └────────────── applyEnemyOrders ──────────────┘
                                       │
                                       ▼
                          state.units[id].state changes
                          to "moving" / "attacking" /
                          "retreating" / "patrolling"
                                       │
                                       ▼
                          ┌──────────────────────┐
                          │ Coordination layer:  │
                          │   unit.state         │
                          │  (NO shared module   │
                          │   state across       │
                          │   files)             │
                          └──────────────────────┘
                                       │
                                       ▼
                          ┌──────────────────────┐
                          │ sim / pathing /      │
                          │ combat / autoBehavior│
                          │   (engine layer)     │
                          └──────────────────────┘
```

**协调规则**：

| 事件 | 单位 state | defensiveAI 视角 | pressureDirector 视角 |
|---|---|---|---|
| pressureDirector 派出 | `moving` / `attacking` | `assignRoles` 不会划入 reserveIds（因为不是 idle/defending/patrolling） | `p4ClaimedIds` 持有 |
| P4 兵到达后变 idle | `idle` | 下一 tick 可能划入 reserveIds | `p4ClaimedIds` 在 reissue 阶段触发 arrival 释放 |
| defensiveAI 派出（P0-P3） | `moving` / `attacking` | 自己的 `activeAttackerIds` 持有 | 看 unit.state 非 idle → 不抢 |
| 单位 dead | `dead` | 两边都 cleanup | 两边都 cleanup |

**结论**：两个模块完全解耦，defensiveAI.ts 改动行数 = **0**。

---

## 2. pressureDirector.ts public API

新建 `packages/core/src/scenario/elAlamein/pressureDirector.ts`：

```ts
/**
 * Process the El Alamein 5C-lite scripted pressure director.
 *
 * Runs every DIRECTOR_INTERVAL_SEC (5s) using a while-loop drift guard.
 * Fires at most one P4 pressure wave per cooldown window (100-140s, phase-jittered).
 *
 * No-op when:
 *   - state.scenarioId !== "el_alamein"
 *   - state.scenarioWinConfig is undefined
 *   - state.gameOver
 *   - state.time < P4_GRACE_PERIOD_SEC
 *
 * Coordinates with defensiveAI ONLY via unit.state.
 * Does NOT import from defensiveAI; carries mini-helpers internally.
 */
export function processPressureDirector(state: GameState, dt: number): void;

/**
 * Reset module-level timers + tracking sets. Must be called on new game session,
 * alongside resetDefensiveAITimer / resetEnemyAITimer / resetAttackWaveState / etc.
 */
export function resetPressureDirector(): void;
```

完。**就这两个 export**。没有其他 public symbol。

---

## 3. Export / import 改动

### `packages/core/src/index.ts`
追加一行（参考现有 `resetDefensiveAITimer` 模式）：
```ts
export { processPressureDirector, resetPressureDirector } from "./scenario/elAlamein/pressureDirector";
```

### `apps/web/src/GameCanvas.tsx`
**(a) import 块**（line ~28-60 区域）：
```diff
   processEnemyAI,
   ...
   resetDefensiveAITimer,
+  processPressureDirector,
+  resetPressureDirector,
 } from "@ai-commander/core";
```

**(b) tick loop**（line ~1152，`processDefensiveAI` 之后）：
```diff
   processEnemyAI(state, dt);
   processDefensiveAI(state, dt);
+  processPressureDirector(state, dt);
   processAutoBehavior(state, dt);
```

**(c) 两处 reset 流程**（line ~745 和 ~786）：
```diff
   resetDefensiveAITimer();
+  resetPressureDirector();
```

总 GameCanvas 改动：**+5 行**（1 import line + 1 tick call + 2 reset calls + 1 SUPPRESSED_DIAG_CODES 行，如果加 `P4_DBG`）。

---

## 4. GameCanvas tick loop 和 reset 流程要改哪里

精确位置（基于 HEAD = `a850b02`）：

| 改动 | 文件 | 行号附近 | 内容 |
|---|---|---|---|
| import | `apps/web/src/GameCanvas.tsx` | ~28-60 import 块 | 加 `processPressureDirector, resetPressureDirector` |
| tick hook | `apps/web/src/GameCanvas.tsx` | line ~1152 | `processPressureDirector(state, dt);` 紧跟 `processDefensiveAI` |
| reset 1 | `apps/web/src/GameCanvas.tsx` | line ~745 | `resetPressureDirector();` 紧跟 `resetDefensiveAITimer()` |
| reset 2 | `apps/web/src/GameCanvas.tsx` | line ~786 | 同上 |

不动其他 tick 顺序、不动其他 reset 函数。

---

## 5. defensiveAI.ts 是否 0 改动？

**完全 0 改动**。

理由：
- pressureDirector 用 unit.state 协调，不需要 defensiveAI 暴露任何东西
- defensiveAI 现有 P0-P3 / garrison / production 行为是测过的 baseline
- 删除 5C-lite 时只需删 `pressureDirector.ts` + GameCanvas 5 行，defensiveAI 不动

**轻微非 0 改动的可能**（不推荐，列出来供 review）：

| 假设场景 | 推荐 |
|---|---|
| 5C-lite 测试中 P3 probe + P4 raid 同时打同一前哨碾压 | ❌ 不要改 defensiveAI。调 P4 cooldown 即可 |
| defensiveAI 产能不够支撑 P4 | ❌ 不要改 defensiveAI。在 `elAlamein/index.ts` 调高 enemy baseIncome 即可（已在本 plan §10） |
| 想让 defensiveAI 知道 P4 派出去了 | ❌ 不要。靠 unit.state 已经够 |

**最终方案：defensiveAI.ts diff = 0 行**。

---

## 6. pressureDirector 内部数据结构

全部 module-level，**无 export**：

```ts
// ── Cadence ──
let p4Timer = 0;                                    // accumulates dt for while-loop drift guard
let p4CooldownUntil = 0;                            // absolute state.time
let p4WaveCount = 0;                                // monotonic count of fires

// ── Claimed units (only inside this module) ──
const p4ClaimedIds = new Set<number>();             // unit ids currently owned by P4
const p4AttackerTargets = new Map<number, Position>(); // id → final target

// ── Target history (anti-monotone) ──
interface TargetHistoryEntry {
  targetId: string;
  firedAt: number;     // state.time
  kind: "recapture" | "finish_post" | "raid";
}
const p4TargetHistory: TargetHistoryEntry[] = [];    // FIFO, capped at 3

// ── Production boost (called when pool is dry) ──
let lastBoostAt = -Infinity;                         // state.time of last successful boost
```

```ts
// ── Constants ──
const DIRECTOR_INTERVAL_SEC = 5.0;
const P4_GRACE_PERIOD_SEC = 90;
const P4_BASE_COOLDOWN_EASY = 140;
const P4_BASE_COOLDOWN_MID = 120;
const P4_BASE_COOLDOWN_HARD = 100;
const P4_JITTER_SEC = 20;
const P4_PHASE_BREAKPOINTS = { easyEnd: 480, midEnd: 1080 };  // 8 min / 18 min
const P4_MIN_POOL_TO_FIRE = 4;
const P4_TARGET_HISTORY_SIZE = 3;
const P4_HISTORY_PENALTY = -25;

const P4_WAVE_SIZE = {
  easy: { probe: [4, 5], recapture: [5, 7],  raid: [4, 5], finish_post: [4, 6] },
  mid:  { probe: [5, 6], recapture: [7, 10], raid: [6, 9], finish_post: [6, 8] },
  hard: { probe: [6, 7], recapture: [8, 12], raid: [8, 10], finish_post: [7, 10] },
};

const MIN_GARRISON_ON_CAPTURED_POST = 2;
const CAPTURED_POST_GARRISON_RADIUS = 8;
const GARRISON_EXCLUSION_RADIUS = 15;               // Axis objectives
const HQ_EXCLUSION_RADIUS = 20;                     // Axis HQ
const ARRIVAL_RADIUS = 12;                           // for releasing claim
const LOW_HP_RETREAT_RATIO = 0.30;                  // release claim if damaged
const DRIFT_RELEASE_TILES_SQ = 8 * 8;               // claim drift threshold; > this → defensiveAI redirected, release

const PRODUCTION_BOOST_COOLDOWN_SEC = 30;           // min gap between boostEnemyProduction calls
const MAX_DIAGNOSTICS = 200;                        // soft cap on state.diagnostics array
```

无其他 state。

---

## 7. Target scoring 详细逻辑

```ts
type PressureKind = "recapture" | "finish_post" | "raid";

interface PressureCandidate {
  targetId: string;
  position: Position;
  kind: PressureKind;
  score: number;
}

function buildPressureTargets(state: GameState): PressureCandidate[] {
  const winCfg = state.scenarioWinConfig!;
  const out: PressureCandidate[] = [];

  // (A) Recapture: Axis objectives held by / being captured by player
  for (const objId of state.captureObjectives ?? []) {
    const f = state.facilities.get(objId);
    if (!f || f.hp <= 0) continue;
    let s = 0;
    if (f.team === "player") s += 100;
    else if (f.team === "enemy" && f.capturingTeam === "player") s += 70;
    else continue;
    s += historyPenalty(objId, "recapture");  // recapture exempt → 0
    out.push({ targetId: objId, position: { ...f.position }, kind: "recapture", score: s });
  }

  // (B) Finish weak player forward post
  for (const kpId of winCfg.friendlyKeypoints) {
    const f = state.facilities.get(kpId);
    if (!f || f.team !== "player" || f.hp <= 0) continue;
    let s = 0;
    const hpRatio = f.hp / f.maxHp;
    if (hpRatio < 0.5) s += 60;
    if (f.capturingTeam === "enemy") s += 60;
    if (hasActiveEnemyAttackersNear(state, f.position, 18)) s += 25;
    s += scoreLocalPlayerDefense(state, f.position, 18);
    s += historyPenalty(kpId, "finish_post", hpRatio);
    if (s > 0) out.push({ targetId: kpId, position: { ...f.position }, kind: "finish_post", score: s });
  }

  // (C) Raid healthy post (only if no recapture pending)
  const recaptureExists = out.some(c => c.kind === "recapture");
  if (!recaptureExists) {
    for (const kpId of winCfg.friendlyKeypoints) {
      const f = state.facilities.get(kpId);
      if (!f || f.team !== "player" || f.hp <= 0) continue;
      const hpRatio = f.hp / f.maxHp;
      if (hpRatio < 0.5) continue;  // already covered by finish_post
      let s = 20;
      if (kpId === "ea_player_central_post") s += 5;  // mild central bias
      s += scoreLocalPlayerDefense(state, f.position, 18);
      s += historyPenalty(kpId, "raid", hpRatio);
      if (s > 0) out.push({ targetId: kpId, position: { ...f.position }, kind: "raid", score: s });
    }
  }

  return out;
}

function historyPenalty(targetId: string, kind: PressureKind, hpRatio?: number): number {
  if (kind === "recapture") return 0;
  if (hpRatio !== undefined && hpRatio < 0.5) return 0;
  return p4TargetHistory.some(h => h.targetId === targetId) ? P4_HISTORY_PENALTY : 0;
}

function scoreLocalPlayerDefense(state: GameState, pos: Position, radius: number): number {
  let localHp = 0;
  state.units.forEach(u => {
    if (u.team !== "player" || u.state === "dead") return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (!isVisibleToEnemyMini(state, u.position)) return;
    const dx = u.position.x - pos.x, dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) localHp += u.hp;
  });
  if (localHp >= 250) return 0;
  if (localHp >= 100) return 20;
  if (localHp >= 30) return 30;
  return 40;
}

function hasActiveEnemyAttackersNear(state: GameState, pos: Position, radius: number): boolean {
  for (const id of p4ClaimedIds) {
    const u = state.units.get(id);
    if (!u || u.state === "dead") continue;
    const dx = u.position.x - pos.x, dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) return true;
  }
  let found = false;
  state.units.forEach(u => {
    if (found) return;
    if (u.team !== "enemy" || u.state === "dead") return;
    if (u.state !== "attacking" && u.state !== "moving") return;
    const dx = u.position.x - pos.x, dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) found = true;
  });
  return found;
}
```

**排序与选择**：score desc，ties 按 targetId 字典序（deterministic）。

**Mini helper：`isVisibleToEnemyMini`**（在本文件内复制，不 import）：
```ts
function isVisibleToEnemyMini(state: GameState, target: Position): boolean {
  // Copy of defensiveAI.isVisibleToEnemy logic. Kept here intentionally
  // so deleting pressureDirector doesn't touch defensiveAI.
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  let visible = false;
  state.units.forEach(u => {
    if (visible) return;
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    let vision = u.visionRange;
    if (getUnitCategory(u.type) === "ground") {
      const ux = Math.floor(u.position.x);
      const uy = Math.floor(u.position.y);
      if (ux >= 0 && ux < state.mapWidth && uy >= 0 && uy < state.mapHeight) {
        const terrain = state.terrain[uy][ux];
        if (terrain === "forest") vision = Math.max(1, vision - 2);
      }
    }
    const dx = tx - u.position.x, dy = ty - u.position.y;
    if (dx * dx + dy * dy <= vision * vision) visible = true;
  });
  if (visible) return true;

  state.facilities.forEach(f => {
    if (visible) return;
    if (f.team !== "enemy" || f.hp <= 0) return;
    let v = 6;
    if (f.type === "headquarters") v = 10;
    if (f.type === "radar") v = 20;
    const dx = tx - f.position.x, dy = ty - f.position.y;
    if (dx * dx + dy * dy <= v * v) visible = true;
  });
  return visible;
}
```

**例子走查**（t=600s，玩家刚占了 ea_kidney_ridge）：

| 目标 | 类别 | 分项 | total |
|---|---|---|---|
| ea_kidney_ridge | recapture | +100 (player held) | **100** |
| ea_alamein_town | — | 不在 player 手 | skip |
| ea_player_coastal_post | raid (hp 100%) | +20 base, +0 defense, -25 (recent) | -5 → skip |
| ea_player_central_post | finish_post (hp 51%) | 不入选（hp >= 50%） | skip |
| ea_player_south_post | raid (hp 100%) | +20 base, +30 (weak defense) | **50** |

→ 选 ea_kidney_ridge，recapture，wave size mid+recapture 范围 [7, 10]，roll 8。

---

## 8. Wave composition & phase scaling

### Phase
```ts
function getPressurePhase(state: GameState): "easy" | "mid" | "hard" {
  if (state.time < P4_PHASE_BREAKPOINTS.easyEnd) return "easy";   // < 8 min
  if (state.time < P4_PHASE_BREAKPOINTS.midEnd) return "mid";     // 8-18 min
  return "hard";                                                  // 18-30 min
}
```

### Wave size
```ts
function pickWaveSize(state: GameState, phase: ReturnType<typeof getPressurePhase>, kind: PressureKind): number {
  const sizeBucket =
    kind === "recapture" ? "recapture" :
    kind === "finish_post" ? "finish_post" :
    state.time < P4_GRACE_PERIOD_SEC + 60 ? "probe" :
    "raid";
  const [min, max] = P4_WAVE_SIZE[phase][sizeBucket];
  return min + Math.floor(Math.random() * (max - min + 1));
}
```

### Cooldown
```ts
function pickCooldown(phase: ReturnType<typeof getPressurePhase>): number {
  const base = phase === "easy" ? P4_BASE_COOLDOWN_EASY
             : phase === "mid"  ? P4_BASE_COOLDOWN_MID
             :                    P4_BASE_COOLDOWN_HARD;
  const jitter = (Math.random() - 0.5) * 2 * P4_JITTER_SEC;
  return base + jitter;
}
```

### 阵型
```ts
function pickFormation(kind: PressureKind, phase: ReturnType<typeof getPressurePhase>): FormationStyle {
  if (kind === "recapture") return phase === "hard" ? "encircle" : "wedge";
  if (kind === "finish_post") return "line";
  return phase === "easy" ? "column" : "wedge";
}
```

### 派单（dispatchWithFormation）
```ts
import { getFormationOffset, computeHeading, type FormationStyle } from "../../formation";
import { applyEnemyOrders } from "../../applyOrders";

function dispatchWithFormation(
  state: GameState,
  attackers: Unit[],
  target: Position,
  style: FormationStyle,
  priority: "high" | "medium" | "low",
): number {
  const centroid = {
    x: attackers.reduce((s, u) => s + u.position.x, 0) / attackers.length,
    y: attackers.reduce((s, u) => s + u.position.y, 0) / attackers.length,
  };
  const heading = computeHeading(centroid, target);

  // One Order per unit so each gets its own offset target
  const orders: Order[] = attackers.map((u, i) => {
    const off = getFormationOffset(target, i, attackers.length, style, heading);
    return {
      unitIds: [u.id],
      action: "attack_move" as const,
      target: {
        x: Math.max(0, Math.min(state.mapWidth - 1, off.x)),
        y: Math.max(0, Math.min(state.mapHeight - 1, off.y)),
      },
      priority,
    };
  });

  const result = applyEnemyOrders(state, orders);
  const totalApplied = result.appliedPerOrder.reduce((a, b) => a + b, 0);

  if (totalApplied > 0) {
    for (const u of attackers) {
      p4ClaimedIds.add(u.id);
      p4AttackerTargets.set(u.id, { ...target });
    }
  }
  return totalApplied;
}
```

### Re-issue 闲置 P4 兵（含 drift 检测，防 defensiveAI 抢人）

**关键背景**：tick 顺序是 `processDefensiveAI` → `processPressureDirector`。同一 tick 内，如果 P4 claimed unit 变 idle（达到中间点 / 目标死了 / 路径完成），defensiveAI 会**先看到**它 idle，可能 `assignRoles` 把它归入 `reserveIds`，再被 P0-P3 重新派到别处。等 pressureDirector 跑到 reissue 这一步时，单位的 state / target 已被改写。

**策略**：reissue 时先检测 drift。三种情况分别处理：

| u.state | 含义 | pressureDirector 行为 |
|---|---|---|
| `dead` | 已死 | cleanup |
| `patrolling` / `defending` / `retreating` | defensiveAI 用它做别的事 | **release claim**（不抢回） |
| `moving` / `attacking` 且 u.target 接近 p4Target | 还在执行 P4 任务 | 不动（避免 order churn）|
| `moving` / `attacking` 但 u.target 偏离 p4Target > 8 tile | defensiveAI / autoBehavior 重定向了 | **release claim**（5C-lite 简单原则：不抢回，避免 tug-of-war；下次 P4 fire 重新选）|
| `idle` 且离 p4Target ≤ 12 tile | 到达 | drop claim |
| `idle` 且离 p4Target > 12 tile | 半路停下 | **重发 P4 attack_move**（claim 胜出） |

```ts
function reissueClaimedUnits(state: GameState): void {
  for (const id of Array.from(p4ClaimedIds)) {
    const u = state.units.get(id);

    // 1. Dead → cleanup
    if (!u || u.state === "dead" || u.hp <= 0) {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    // 2. Badly damaged → release (autoBehavior retreat takes over)
    if (u.hp / u.maxHp < LOW_HP_RETREAT_RATIO) {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    const tgt = p4AttackerTargets.get(id);
    if (!tgt) {
      p4ClaimedIds.delete(id);
      continue;
    }

    // 3. defensiveAI re-classified this unit (patrol/defending/retreating)
    //    → release. We don't fight defensiveAI; next P4 fire picks fresh.
    if (u.state === "patrolling" || u.state === "defending" || u.state === "retreating") {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    // 4. Arrived at P4 final target → drop claim, success path
    const dx = u.position.x - tgt.x, dy = u.position.y - tgt.y;
    if (dx * dx + dy * dy <= ARRIVAL_RADIUS * ARRIVAL_RADIUS) {
      p4ClaimedIds.delete(id);
      p4AttackerTargets.delete(id);
      continue;
    }

    // 5. Moving/attacking — check drift between u.target and our p4Target.
    //    Formation offsets are normally < 5 tiles from center; > 8 tiles
    //    means another system redirected the unit.
    if ((u.state === "moving" || u.state === "attacking") && u.target) {
      const tdx = u.target.x - tgt.x, tdy = u.target.y - tgt.y;
      const driftSq = tdx * tdx + tdy * tdy;
      if (driftSq > DRIFT_RELEASE_TILES_SQ) {
        // Drift detected — defensiveAI/autoBehavior took control. Release.
        p4ClaimedIds.delete(id);
        p4AttackerTargets.delete(id);
        continue;
      }
      // On-track, don't churn orders.
      continue;
    }

    // 6. Idle but not arrived → re-issue P4 attack_move.
    //    Race window: if defensiveAI gave this unit a new idle-state order
    //    THIS same tick (before us), we'll overwrite it. Acceptable: our
    //    claim wins. Next tick's drift check will catch any contention.
    if (u.state === "idle") {
      applyEnemyOrders(state, [{
        unitIds: [id],
        action: "attack_move",
        target: { ...tgt },
        priority: "high",
      }]);
    }
  }
}
```

**为什么"release 而非 steal back"**：steal back 会导致 P4 vs defensiveAI 每 tick 互抢同一个 unit，造成 order spam + state oscillation。Release 让 defensiveAI 短期接管这个 unit，**下次 P4 fire（100-140s 后）会从新池子挑兵**，没有死循环。代价：当前波次可能少 1-2 个 unit。

### Production boost（pool 不够时调用）

```ts
/**
 * Called when buildPressureTargets has high-score candidates but
 * gatherPressurePool returns < P4_MIN_POOL_TO_FIRE units. Pushes 1-3
 * production orders to the enemy queue to accelerate force regeneration.
 *
 * Constraints:
 *   - Respects defensiveAI.manageEconomy's queue cap of 4
 *   - Own 30s cooldown via lastBoostAt
 *   - Phase-aware unit mix (cheap → expensive)
 *   - Skips unaffordable items, tries next in wishlist
 *   - On total failure (money too low for everything): does NOT update
 *     cooldown — next pressureDirector tick will retry immediately
 */
function boostEnemyProduction(state: GameState): void {
  if (state.time - lastBoostAt < PRODUCTION_BOOST_COOLDOWN_SEC) return;

  const queue = state.productionQueue.enemy;
  if (queue.length >= 4) return;  // respect defensiveAI's cap; don't conflict

  const eco = state.economy.enemy.resources;
  const phase = getPressurePhase(state);

  // Wishlist in order of preference for this phase.
  // Costs from UNIT_STATS: infantry=100, light_tank=250, main_tank=500.
  const wishlist: Array<{ type: "infantry" | "light_tank" | "main_tank"; cost: number }> = [];
  if (phase === "easy") {
    // Easy: cheap & fast — 2 infantry to refill foot pool
    wishlist.push({ type: "infantry",   cost: 100 });
    wishlist.push({ type: "infantry",   cost: 100 });
  } else if (phase === "mid") {
    // Mid: 1 infantry + 1 light_tank — maintain 3:1 step:tank-ish (defensiveAI's mix)
    wishlist.push({ type: "infantry",   cost: 100 });
    wishlist.push({ type: "light_tank", cost: 250 });
  } else {
    // Hard: 1 infantry + 1 main_tank if affordable; else light_tank fallback
    wishlist.push({ type: "infantry",   cost: 100 });
    if (eco.money >= 500) {
      wishlist.push({ type: "main_tank", cost: 500 });
    } else {
      wishlist.push({ type: "light_tank", cost: 250 });
    }
  }

  let added = 0;
  for (const item of wishlist) {
    if (queue.length >= 4) break;
    if (eco.money < item.cost) continue;  // try next item, don't bail
    const result = enqueueProduction(state, "enemy", item.type);
    if (result.ok) added++;
  }

  if (added > 0) {
    lastBoostAt = state.time;  // only update cooldown on success
    pushDiagnostic(state, `P4 prod-boost phase=${phase} added=${added} queue=${queue.length}`);
  }
  // If added === 0 (money too low for any wishlist item), don't set cooldown.
  // Next tick will retry — but the underlying problem is defensiveAI's economy,
  // not ours.
}
```

**Cooldown semantics**：
- 成功 → `lastBoostAt = state.time` → 至少 30s 后才会再次 boost
- 失败（钱不够 / 队列满）→ **不更新** cooldown → 下个 5s tick 再试
- 这样不会跟 defensiveAI 的 manageEconomy（每 5s 跑一次自己的生产决策）打架

**调用点**：在 `pressureDirector` 主流程里，当 `buildPressureTargets` 返回非空但 `gatherPressurePool` 返回 < `P4_MIN_POOL_TO_FIRE` 时调用：

```ts
const pool = gatherPressurePool(state, best.position, waveSize);
if (pool.length < P4_MIN_POOL_TO_FIRE) {
  boostEnemyProduction(state);
  // Extend P4 cooldown a little so we re-check after production has time to run.
  p4CooldownUntil = state.time + 30;
  return;
}
```

### Mini diagnostic helper（本文件内复制，不 import）

```ts
function pushDiagnostic(state: GameState, message: string): void {
  // Copy of defensiveAI.pushDiagnostic, but with code "P4_DBG" so it's
  // filtered separately by GameCanvas SUPPRESSED_DIAG_CODES.
  if (state.diagnostics.length >= MAX_DIAGNOSTICS) {
    state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS + 1);
  }
  state.diagnostics.push({
    time: state.time,
    code: "P4_DBG",
    message,
  });
}
```

---

## 9. Garrison exclusion / surplus unit 抽调逻辑

```ts
function gatherPressurePool(state: GameState, attackTarget: Position, want: number): Unit[] {
  const winCfg = state.scenarioWinConfig!;

  // 1. Identify enemy-occupied player forward posts (need min garrison protection)
  const occupiedPosts: { pos: Position; capacity: number; current: number }[] = [];
  for (const kpId of winCfg.friendlyKeypoints) {
    const f = state.facilities.get(kpId);
    if (f && f.team === "enemy") {
      occupiedPosts.push({ pos: { ...f.position }, capacity: MIN_GARRISON_ON_CAPTURED_POST, current: 0 });
    }
  }

  // 2. Axis objective + HQ exclusion zones (don't drain defensiveAI's garrisons)
  const axisProtectionZones: { pos: Position; radius: number }[] = [];
  for (const objId of state.captureObjectives ?? []) {
    const f = state.facilities.get(objId);
    if (f && f.team === "enemy") {
      axisProtectionZones.push({ pos: { ...f.position }, radius: GARRISON_EXCLUSION_RADIUS });
    }
  }
  state.facilities.forEach(f => {
    if (f.type === "headquarters" && f.team === "enemy") {
      axisProtectionZones.push({ pos: { ...f.position }, radius: HQ_EXCLUSION_RADIUS });
    }
  });

  // 3. Build candidate list
  const candidates: { u: Unit; postIdx: number | null }[] = [];
  state.units.forEach(u => {
    if (u.team !== "enemy" || u.state === "dead" || u.hp <= 0) return;
    if (getUnitCategory(u.type) !== "ground") return;
    if (u.type === "commander") return;
    if (p4ClaimedIds.has(u.id)) return;
    if (u.state !== "idle" && u.state !== "defending" && u.state !== "patrolling") return;

    // (a) Exclude if inside Axis garrison zone
    let excluded = false;
    for (const z of axisProtectionZones) {
      const dx = u.position.x - z.pos.x, dy = u.position.y - z.pos.y;
      if (dx * dx + dy * dy <= z.radius * z.radius) { excluded = true; break; }
    }
    if (excluded) return;

    // (b) Tag if inside captured player post
    let postIdx: number | null = null;
    for (let i = 0; i < occupiedPosts.length; i++) {
      const p = occupiedPosts[i];
      const dx = u.position.x - p.pos.x, dy = u.position.y - p.pos.y;
      if (dx * dx + dy * dy <= CAPTURED_POST_GARRISON_RADIUS * CAPTURED_POST_GARRISON_RADIUS) {
        postIdx = i;
        occupiedPosts[i].current++;
        break;
      }
    }
    candidates.push({ u, postIdx });
  });

  // 4. Sort by distance (closer first), then HP desc
  candidates.sort((a, b) => {
    const da = (a.u.position.x - attackTarget.x) ** 2 + (a.u.position.y - attackTarget.y) ** 2;
    const db = (b.u.position.x - attackTarget.x) ** 2 + (b.u.position.y - attackTarget.y) ** 2;
    if (Math.abs(da - db) > 100) return da - db;
    return b.u.hp - a.u.hp;
  });

  // 5. Take up to `want` units, leaving at least capacity behind on captured posts
  const taken: Unit[] = [];
  for (const { u, postIdx } of candidates) {
    if (taken.length >= want) break;
    if (postIdx !== null) {
      const post = occupiedPosts[postIdx];
      if (post.current <= post.capacity) continue;  // would drop below minimum
      post.current--;
    }
    taken.push(u);
  }

  return taken;
}
```

**Edge cases**：
- Axis objective 丢失 + Axis 占了一个 player post → 高分 recapture 拉，pool 从其他位置 + 该 post surplus 抽（保留 ≥ 2 守军）
- 占领点单位只有 2 个（刚 = MIN_GARRISON）→ 一个不抽
- 所有 reserve 都在 garrison 圈内 → pool 空 → 触发 production boost + 延迟下次 P4

---

## 10. 资源 & deployment 调整

### `packages/core/src/scenario/elAlamein/index.ts`
```diff
       player: (() => {
         const eco = makeEconomy();
-        eco.resources.money = 3000;
-        eco.resources.fuel = 150;
-        eco.resources.ammo = 150;
+        eco.resources.money = 3500;
+        eco.resources.fuel = 300;
+        eco.resources.ammo = 225;
+        eco.baseIncome = { money: 120, fuel: 30, ammo: 30, intel: 10 };
         return eco;
       })(),
       enemy: (() => {
         const eco = makeEconomy();
-        eco.resources.money = 4000;
-        eco.resources.fuel = 250;
-        eco.resources.ammo = 250;
-        eco.baseIncome = { money: 150, fuel: 35, ammo: 30, intel: 10 };
+        eco.resources.money = 5000;
+        eco.resources.fuel = 450;
+        eco.resources.ammo = 300;
+        eco.baseIncome = { money: 180, fuel: 45, ammo: 35, intel: 10 };
         return eco;
       })(),

     scenarioWinConfig: {
       timeLimitSec: 1800,
-      requiredCapturedObjectives: 2,
+      requiredCapturedObjectives: 3,
       friendlyKeypoints: [
         "ea_player_coastal_post",
         "ea_player_central_post",
         "ea_player_south_post",
       ],
-      maxFriendlyKeypointsLost: 2,
+      maxFriendlyKeypointsLost: 3,
+      ratingThresholds: {
+        majorVictory: 3, victory: 2, minorVictory: 1,
+        draw: 0, minorDefeat: -1, defeat: -2,
+      },
     },
```

### `packages/core/src/scenario/elAlamein/deployment.ts`

替换 player air wing (line ~159-161)：
```diff
-  // ── Air Wing (450, 128) ──
-  placeGroup("recon_plane", "player", lineFormation(452, 124, 3, 3));
-  placeGroup("fighter", "player", [[448, 130], [456, 130]]);
+  // ── HQ Mobile Reserve (5C-lite: replaces air wing) ──
+  placeGroup("infantry",   "player", blockFormation(450, 120, 2, 2));
+  placeGroup("light_tank", "player", lineFormation(450, 126, 2, 3));
+  placeGroup("main_tank",  "player", [[450, 132]]);
```

替换 enemy air wing (line ~213-214)：
```diff
-  // ── Air Wing (58, 128) ──
-  placeGroup("fighter", "enemy", lineFormation(58, 128, 3, 3));
-  placeGroup("bomber",  "enemy", [[56, 134], [64, 134]]);
+  // ── Axis Mobile Reserve (5C-lite: replaces air wing) ──
+  placeGroup("infantry",   "enemy", blockFormation(58, 122, 2, 2));
+  placeGroup("light_tank", "enemy", blockFormation(58, 128, 3, 3));
+  placeGroup("main_tank",  "enemy", [[55, 134], [65, 134]]);
```

**Axis 固定守军不动**。

---

## 11. 30 分钟评级接入

### `packages/shared/src/types.ts`
```diff
   scenarioWinConfig?: {
     timeLimitSec: number;
     requiredCapturedObjectives: number;
     friendlyKeypoints: string[];
     maxFriendlyKeypointsLost: number;
+    /** 5C-lite: 30-min timeout rating thresholds. */
+    ratingThresholds?: {
+      majorVictory: number; victory: number; minorVictory: number;
+      draw: number; minorDefeat: number; defeat: number;
+    };
   };
```

```diff
 export interface GameState {
   ...
   gameOverReason?: string;
+  /** 5C-lite: 30-min rating; absent on immediate win/loss. */
+  gameOverRating?: "major_victory" | "victory" | "minor_victory" | "draw" | "minor_defeat" | "defeat";
+  /** 5C-lite: score breakdown for game-over UI. */
+  gameOverBreakdown?: { capturedObjectives: number; lostKeypoints: number; score: number };
```

### `packages/core/src/warPhase.ts`

```diff
   if (winCfg) {
     // Victory: K of N objectives
     ...
     // Defeat: keypoints lost
     ...
-    // Defeat: timeout
+    // 5C-lite: timeout → rating, NOT immediate defeat
     if (state.time >= winCfg.timeLimitSec) {
-      endGame(state, "enemy", "超时未达成战略目标 — 进攻失败");
+      endGameWithRating(state, winCfg);
       return;
     }
   } else if (state.captureObjectives && state.captureObjectives.length > 0) {
     // Legacy path
     ...
   }

-  // MVP2 Rule 1: Commander killed → defeat
-  let commanderAlive = false;
-  state.units.forEach((u) => {
-    if (u.type === "commander" && u.team === "player" && u.state !== "dead" && u.hp > 0) {
-      commanderAlive = true;
-    }
-  });
-  if (!commanderAlive && state.time > 1) {
-    endGame(state, "enemy", "司令阵亡");
-    return;
-  }
+  // 5C-lite: commander-death failure only fires for scenarios WITHOUT scenarioWinConfig.
+  // El Alamein uses Chen/Marcus/Emily as chat personas; on-map commander unit death no
+  // longer ends the game. Legacy dual_island still uses this rule.
+  if (!state.scenarioWinConfig) {
+    let commanderAlive = false;
+    state.units.forEach((u) => {
+      if (u.type === "commander" && u.team === "player" && u.state !== "dead" && u.hp > 0) {
+        commanderAlive = true;
+      }
+    });
+    if (!commanderAlive && state.time > 1) {
+      endGame(state, "enemy", "司令阵亡");
+      return;
+    }
+  }
```

新加 `endGameWithRating`：
```ts
function endGameWithRating(state: GameState, winCfg: NonNullable<GameState["scenarioWinConfig"]>): void {
  const captured = (state.captureObjectives ?? []).filter(id =>
    state.facilities.get(id)?.team === "player",
  ).length;
  const lost = winCfg.friendlyKeypoints.filter(id => {
    const f = state.facilities.get(id);
    return !f || f.hp <= 0 || f.team !== "player";
  }).length;
  const score = captured - lost;

  const t = winCfg.ratingThresholds ?? {
    majorVictory: 3, victory: 2, minorVictory: 1, draw: 0, minorDefeat: -1, defeat: -2,
  };

  let rating: NonNullable<GameState["gameOverRating"]>;
  let winner: Team;
  let label: string;
  if (score >= t.majorVictory)      { rating = "major_victory";  winner = "player"; label = "大胜"; }
  else if (score >= t.victory)      { rating = "victory";        winner = "player"; label = "胜利"; }
  else if (score >= t.minorVictory) { rating = "minor_victory";  winner = "player"; label = "小胜"; }
  else if (score >= t.draw)         { rating = "draw";           winner = "player"; label = "平局"; }
  else if (score >= t.minorDefeat)  { rating = "minor_defeat";   winner = "enemy";  label = "小败"; }
  else                              { rating = "defeat";         winner = "enemy";  label = "失败"; }

  state.gameOverRating = rating;
  state.gameOverBreakdown = { capturedObjectives: captured, lostKeypoints: lost, score };
  endGame(state, winner, `战果评级 ${label}：占领 ${captured}/${winCfg.requiredCapturedObjectives}，丢失 ${lost}/${winCfg.maxFriendlyKeypointsLost}，净分 ${score >= 0 ? "+" : ""}${score}`);
}
```

### `apps/web/src/GameCanvas.tsx` game-over overlay

```diff
   const [gameOverInfo, setGameOverInfo] = useState<{
     winner: string;
     reason: string;
     time: number;
     playerUnits: number;
     enemyUnits: number;
     isVictory: boolean;
+    rating?: GameState["gameOverRating"];
+    breakdown?: GameState["gameOverBreakdown"];
   } | null>(null);
```

```diff
       setGameOverInfo({
         winner: ...,
         reason: state.gameOverReason ?? "未知原因",
+        rating: state.gameOverRating,
+        breakdown: state.gameOverBreakdown,
         ...
       });
```

JSX 新加 breakdown 行（在 stats div 后）：
```jsx
{gameOverInfo.breakdown && (
  <div className="hud-gameover-breakdown" style={{
    fontFamily: "monospace",
    marginTop: 12,
    color: "#94a3b8",
    fontSize: 13,
  }}>
    据点 {gameOverInfo.breakdown.capturedObjectives}/3 ·
    丢失 {gameOverInfo.breakdown.lostKeypoints}/3 ·
    净分 {gameOverInfo.breakdown.score >= 0 ? "+" : ""}{gameOverInfo.breakdown.score}
  </div>
)}
```

**Title rendering — 必须按 rating 优先，不能让平局/小胜/小败显示成 VICTORY 或 DEFEAT。**

现有 game-over title 用 `state.winner === "player"` 决定 `isVictory: true` 然后渲染大字 "VICTORY"。本 plan §11 末尾的 `endGameWithRating` 对 `draw` 也设了 `winner = "player"`，**会让平局误显示成 VICTORY**。必须改 title 渲染规则。

新增 rating label map（放在 GameCanvas.tsx 顶部 constants 区域）：

```ts
const RATING_LABELS: Record<NonNullable<GameState["gameOverRating"]>, string> = {
  major_victory: "MAJOR VICTORY",
  victory:       "VICTORY",
  minor_victory: "MINOR VICTORY",
  draw:          "DRAW",
  minor_defeat:  "MINOR DEFEAT",
  defeat:        "DEFEAT",
};
const RATING_TITLE_CLASS: Record<NonNullable<GameState["gameOverRating"]>, string> = {
  major_victory: "hud-gameover-title--victory",
  victory:       "hud-gameover-title--victory",
  minor_victory: "hud-gameover-title--victory",   // 共用 victory 配色 (defer 6 级配色)
  draw:          "hud-gameover-title--draw",      // 新增中性 class (灰色) — 见 CSS 备注
  minor_defeat:  "hud-gameover-title--defeat",
  defeat:        "hud-gameover-title--defeat",
};
```

JSX title 改为 rating 优先 + 现有 binary fallback：

```diff
-<div className={`hud-gameover-title ${gameOverInfo.isVictory ? "hud-gameover-title--victory" : "hud-gameover-title--defeat"}`}>
-  {gameOverInfo.winner}
-</div>
+<div className={`hud-gameover-title ${
+  gameOverInfo.rating
+    ? RATING_TITLE_CLASS[gameOverInfo.rating]
+    : (gameOverInfo.isVictory ? "hud-gameover-title--victory" : "hud-gameover-title--defeat")
+}`}>
+  {gameOverInfo.rating
+    ? RATING_LABELS[gameOverInfo.rating]
+    : gameOverInfo.winner}
+</div>
```

CSS 备注（手动加到现有 hud styles 文件，定位通过 grep `hud-gameover-title--victory`）：
```css
.hud-gameover-title--draw {
  color: var(--hud-text-dim, #94a3b8);   /* 中性灰 — 避免误读为胜利 */
}
```
如果项目 CSS 用 styled / inline / atomic，把这条放对应位置即可。**这是 5C-lite 必做项**，不是 defer。

剩余 6 级配色 polish（让 major_victory > victory 颜色更醒目）**仍然 defer**——breakdown 行已经显示 score，足以区分。

---

## 12. Chen push back 方案 & defer 项

### 不新加任何 Chen prompt / advisorTrigger 规则

5C-lite 完全**复用现有 infra**：

| 玩家感知点 | 触发链 | 已有？ |
|---|---|---|
| 前哨被攻击（player unit 掉血） | pressureDirector 派兵 → 接触 → 玩家单位掉血 → `reportSignals.detectUnderAttack` auto emit UNDER_ATTACK → `advisorTrigger` rule 1 fire → llm_advice → Chen brief | ✓ |
| 前哨被夺取中 | enemy capturingTeam → `reportSignals.detectFacilityContested` auto emit FACILITY_CONTESTED + actionRequired → `advisorTrigger` rule 4 fire → llm_advice + staff thread | ✓ |
| 战力对比悬殊 | `reportSignals.detectPositionCritical` 自动检测 local ratio < 0.3 + engaged → emit POSITION_CRITICAL + actionRequired | ✓ |
| 友军损失惨重 | `reportSignals.detectSquadHeavyLoss` 自动 | ✓ |

**pressureDirector 不 emit 任何 reportEvent**。只 push 一行 diagnostic（用 code `P4_DBG` 或沿用 `DEFAI_DBG`），被 GameCanvas SUPPRESSED_DIAG_CODES 过滤。

### 噪音控制（不动）
- reportSignals canFire: UNDER_ATTACK 15s/front, FACILITY_CONTESTED 30s/facility, POSITION_CRITICAL 30s/front
- advisorTrigger canFireTrigger: 30s/ruleKey
- ChatPanel staff-ask: 30s topicCooldown + in-flight gate

### Diagnostic 不进 feed
pressureDirector 用 `pushDiagnostic` 时 code 用 **`P4_DBG`**（新加），message 前缀 `P4 ...`。

`apps/web/src/GameCanvas.tsx` SUPPRESSED_DIAG_CODES 加一行（+1 行）：
```diff
 const SUPPRESSED_DIAG_CODES = new Set([
   "IMPASSABLE_TERRAIN",
   "DEFAI_ROLES",
   "DEFAI_DBG",
+  "P4_DBG",
 ]);
```

### Defer 项（明确列出）

| Defer 项 | 实现成本 | 决策 |
|---|---|---|
| Advance warning Chen brief（接触前预警） | 新 event type ENEMY_MASSING + advisorTrigger 规则 + LLM 文案调教 ~120 行 + 不确定调试 | **Defer**。先做接触后 Chen 喊，spec 明确允许 |
| 小 probe 不调 LLM | ReportEvent 加 severity / 大小 metadata + advisorTrigger 按 metadata gate | **Defer**。先全部 emit，靠现有 30s cooldown 控量 |
| Rating 颜色 polish（6 级配色） | 加 6 个 CSS modifier class + 改 JSX | **Defer**。先 victory/defeat 二色 + breakdown 显示 score |
| pressure summary 进 digest | 加 digest 字段 + pressureDirector 暴露 last event | **Defer**。Chen 已能从 fronts 和 facilities 看出战况 |

---

## 13. 验证计划

| # | 命令 / 操作 | 预期 |
|---|---|---|
| V1 | `npm run typecheck` | 4 workspaces 全过 |
| V2 | `npm run build` | dist 生成 |
| V3 | `grep -c localhost:3001 apps/web/dist/assets/*.js` | 0（deploy 模式没破坏） |
| V4 | `npm run dev:server` + `npm run dev` → `:3000/?scenario=el_alamein` | HUD 显示 `OBJECTIVES 0/3` `POSTS LOST 0/3` `TIME LEFT 29:xx` |
| V5 | 自跑 10 分钟，不下任何指令 | `state.diagnostics` 至少 3 行 `P4 ...`；至少 1 次 phase=easy probe |
| V6 | 主动占 1 个 Axis objective 后等 5 分钟 | 至少 1 次 P4 `kind=recapture` |
| V7 | 主动撤掉一个 forward post 的守军后等 5 分钟 | 至少 1 次 P4 `kind=finish_post` 或 `kind=raid` 打那个点；玩家看到 UNDER_ATTACK / FACILITY_CONTESTED Chen brief |
| V8 | 跨 10 分钟统计 | Chen 至少主动发 3 条 brief |
| V9 | 玩到 timeout，score = +1 | **大字 title = `MINOR VICTORY`**（不能是 `VICTORY`），reason 行含"战果评级 小胜：占领 ?/3，丢失 ?/3，净分 +1"，breakdown 行显示对应数字 |
| V10 | 玩到 timeout，score = -1 | **大字 title = `MINOR DEFEAT`**（不能是 `DEFEAT`），reason 含"小败" |
| V11 | 玩到 timeout，score = 0 | **大字 title = `DRAW`**（**绝不能是 `VICTORY`**），颜色中性灰（不是绿/红），reason 含"平局" |
| V11.1 | 玩到 timeout，score = +3 | **大字 title = `MAJOR VICTORY`**，reason 含"大胜" |
| V11.2 | 玩到 timeout，score = -2 | **大字 title = `DEFEAT`**，reason 含"失败" |
| V12 | 故意让 HQ 被毁 | 立即 endGame，**无** rating breakdown 显示（fallback） |
| V13 | 故意丢 3 个 forward post | 立即 endGame，"失守 3 处前哨" |
| V14 | 占满 3 个 Axis objective | 立即 endGame，"已夺取 3 处据点" |
| V15 | commander 单位被打死 | **游戏继续**（不再 endGame，因为 scenarioWinConfig gate） |
| V16 | dual_island 玩一局，commander 被打死 | 仍 endGame（legacy gate 路径） |
| V17 | `npm run start:prod` 浏览器 :3001 | El Alamein 仍能 load + 玩 |
| V18 | `PLAYTEST_ENABLED=false NODE_ENV=production` curl /api/health | 仍 `{"error":"playtest closed"}` |
| V19 | 删 pressureDirector.ts + GameCanvas 5 行 + index.ts 1 行 → typecheck | 全过（只是没了 P4 压力） |

---

## 14. 风险点 + 回滚

### 风险（按严重度排序）

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | `dispatchWithFormation` 单 unit 1 Order → applyEnemyOrders 一次处理 12+ orders | 中 | 现有 applyEnemyOrders 已支持 batch；每 100-140s 一次，性能可接受。**回滚**：N 个合并为 1 个 Order，共享同一 target |
| R2 | enemy 经济 +25% → 后期玩家追不上 | 中 | V5/V6 验证抓。**回滚**：income 调回原值 (money 150/fuel 35/ammo 30)，只动起始库存 |
| R3 | commander-death 移除后玩家不知 elite_guard 还是 manual-only | 低 | UI polish 单独做，5C-lite 不动 |
| R4 | P4 cooldown 太紧 → 玩家碾压感 | 低 | 改 P4_BASE_COOLDOWN_{phase} 常量，5 行内 |
| R5 | pressureDirector 抢光 reserves → defensiveAI P0-P3 哑火 | 中 | gatherPressurePool 已排除 garrison/HQ 圈，保留 baseline；如哑火，调高 GARRISON_EXCLUSION_RADIUS |
| R6 | P4 兵被 defensiveAI 抢走，pressureDirector 还持有 stale claim | 中 | reissueClaimedUnits **drift 检测**：① 到达 → drop claim；② 变 patrolling/defending/retreating → release；③ moving/attacking 但 u.target 偏离 p4Target > 8 tile → release；④ idle 未到 → 重发 P4 attack_move。**不 steal back**（避免 tug-of-war）。详见 §8 |
| R7 | rating thresholds 太苛 / 太松 | 低 | 改 elAlamein/index.ts ratingThresholds |
| R8 | fuel 300 仍不够 player 主攻 | 低 | 调高 fuel 起始 + baseIncome.fuel |

### 删除 5C-lite 时需要改的位置

**整体回滚（3 步，影响范围最小）**：

1. **删整个文件** `packages/core/src/scenario/elAlamein/pressureDirector.ts`
2. **`packages/core/src/index.ts`**：删 1 行 export
3. **`apps/web/src/GameCanvas.tsx`**：删 5 行（1 import block 增量 + 1 tick call + 2 reset calls + 1 SUPPRESSED_DIAG_CODES 的 `P4_DBG` 行）

**完全不动**：defensiveAI / autoBehavior / combat / sim / fog / 任何 shared engine。

**如要同时还原 30 min 评级机制**（额外 3 处）：
- `types.ts` 删 `ratingThresholds` + `gameOverRating` + `gameOverBreakdown` 字段
- `warPhase.ts` 还原 commander-death（去 `if (!state.scenarioWinConfig)` gate）+ 还原 timeout 立即 defeat + 删 `endGameWithRating`
- `elAlamein/index.ts` 还原资源 + 还原 `requiredCapturedObjectives: 2` / `maxFriendlyKeypointsLost: 2` + 删 `ratingThresholds`
- `deployment.ts` 还原 air wing
- `GameCanvas.tsx` 删 breakdown JSX + gameOverInfo rating/breakdown 字段

### 整体回滚保险
所有 5C-lite commit 在 worktree-local branch。push 到 origin/main 之前，可以 `git reset --hard 5C_script之前_上线ok_demoV2` 一键退回。

---

## 15. 实施顺序建议

每步独立 **typecheck + 浏览器 smoke**（typecheck 不过不进下一步）。

**Commit 规则（严格）**：
- ❌ 不要 `git commit`
- ❌ 不要 `git tag`
- ❌ 不要 `git push`
- ✅ 所有改动保持 **uncommitted**（working tree dirty 状态），直到 yuqiaohuang 明确批准
- ✅ 可以用 `git diff` / `git status` / `git stash`（临时备份）等只读工具管理改动
- ✅ 全部 V1-V19 验证通过后，把验证日志交给 yuqiaohuang，**等他下口令**再 commit + push

理由：5C-lite 是行为变化大的改动，需要 yuqiaohuang 亲手 playtest 几把决定要不要进 main。中间 commit 会让回滚变成 N 个 revert 而不是一次 `git checkout -- .`。

1. **`types.ts`** 加 `ratingThresholds` + `gameOverRating` + `gameOverBreakdown` 字段（10 min）→ typecheck
2. **`elAlamein/index.ts`** 资源 + K/N 阈值 + ratingThresholds（10 min）→ typecheck + 浏览器验证 HUD `0/3`
3. **`deployment.ts`** air → ground（15 min）→ 浏览器验证 mobile reserve 出现
4. **`warPhase.ts`** commander-death gate + `endGameWithRating`（30 min）→ typecheck + 把 timeLimitSec 临时改 60s 跑一次验证 rating 触发
5. **`pressureDirector.ts`** 新文件 + `core/src/index.ts` export（90 min）→ typecheck
6. **`GameCanvas.tsx`** tick hook + reset hook + import + SUPPRESSED_DIAG_CODES（15 min）→ 10 分钟自跑观察 P4 diagnostics
7. **`GameCanvas.tsx`** game-over overlay rating + breakdown（15 min）→ 触发 5 种结局测试
8. 全套验证 V1-V19
9. **不要 commit / tag**，把测试日志交给 yuqiaohuang，他决定 commit + push

---

## 最后明确回答

| 问 | 答 |
|---|---|
| 5C-lite 还是完整 5C？ | **5C-lite**。复用 defensiveAI baseline + 加 P4 独立模块 + 评级。**不**做战略推演 / dynamic difficulty / 多前线协调 / advance warning |
| 这个方案是否污染未来更聪明的 AI？ | **不污染**。pressureDirector.ts 独立文件，**不 import defensiveAI**、**不共享 module state**。defensiveAI.ts 改动 = **0**。未来重写 AI 可以 (a) 删 pressureDirector 重写 defensiveAI；(b) 保留 pressureDirector 当背景压力，新 AI 接 defensiveAI 位置；(c) 重写两者 |
| 未来删除 5C-lite pressure script，需要改什么？ | **3 个位置**：删整个 `pressureDirector.ts` + 删 `core/src/index.ts` 1 行 export + 删 `GameCanvas.tsx` 5 行。**完全不动**：defensiveAI / autoBehavior / combat / sim / fog / 任何 shared engine。如要同时还原评级 UI / 资源 / 阈值，参见 §14 |
| 是否会碰 deploy？ | **不会**。不动 `apps/server`、不动 PLAYTEST gate、不动 `api.ts`、不动 Express static / SPA fallback。可以同 commit 跑 `npm run start:prod` 部署 |
| 是否只限 El Alamein？ | **是**。`processPressureDirector` 第一行 `if (state.scenarioId !== "el_alamein") return;` + `if (!state.scenarioWinConfig) return;`。dual_island 完全无感（V16 专门验证） |

---

## 给下一个 Claude 窗口的提示

读完本文档后第一步：
1. **跟 yuqiaohuang 确认所有约束都对**（特别是 §0 铁律和 §15 实施顺序）
2. **不要立即写代码**，先做一次 inspection pass：确认本文档里的 line 号引用跟你的 worktree HEAD 仍匹配（HEAD 应该是 `a850b02 garrison 3 forward keypoints`）
3. 按 §15 顺序一步步实施，每步 typecheck，**不要 commit**
4. 实施过程中任何不确定，回来问 yuqiaohuang，**不要自己改方向**
5. 全部做完后，run 完整 V1-V19 验证，交日志给 yuqiaohuang
6. **永远不要碰 §0 列出的 "必须 0 改动" 文件**，如果某个改动看起来需要碰它们，停下来重新设计

---
