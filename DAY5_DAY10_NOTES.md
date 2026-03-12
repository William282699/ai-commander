# Day5 and Day10 Implementation Notes

This note tracks two planned follow-ups from Day3 review:

- Day5: add MVP obstacle avoidance for movement.
- Day10: move scenario initialization out of `apps/web` into reusable core packages.

## Day5 Plan: MVP Obstacle Avoidance (No A*)

### Goal

Prevent units from hard-stopping at map edges, bridge entries, and forest/swamp borders when a direct step is blocked.

### Scope

- Keep current straight-line movement.
- Add local detour probing only when next tile is blocked.
- Do not build full pathfinding yet.

### Suggested Implementation

File: `packages/core/src/sim.ts`

1. Add helper:
- `tryResolveLocalDetour(unit, state, target)` returns a temporary reachable point or `null`.

2. When `canUnitEnterTile(...)` fails in `moveUnit(...)`:
- Try candidate headings around the direct vector.
- Candidate angles: `+45`, `-45`, `+90`, `-90` degrees.
- Candidate step distance: `1.0` to `2.0` tiles.
- First candidate whose tile is passable becomes the next short waypoint.

3. If no candidate is passable:
- Keep current behavior: clear target and set `idle`.

4. Keep this deterministic:
- Fixed candidate order.
- No random choice.

### Acceptance Criteria

- Units sent toward bridge approach do not instantly stop on edge contact.
- Units can slide around single-tile blockers.
- Typecheck/build pass.
- No regression for current Day3 movement.

## Day10 Plan: Core Boundary Refactor for Initial State

### Goal

Remove game-semantic initialization from `apps/web` so core logic is reusable by other renderers and future UE5 bridge.

### Current Coupling

- `apps/web/src/initState.ts` owns:
  - unit deployment
  - economy defaults
  - facilities/regions/chokepoints map assembly
  - game state bootstrapping

### Target Layout

Option A (recommended):
- `packages/core/src/scenario/createInitialGameState.ts`
- `packages/shared/src/scenario/mapData.ts`
- `packages/shared/src/scenario/terrainGen.ts`

Option B:
- new package `packages/scenario` if code volume grows.

### Migration Steps

1. Move `terrainGen.ts` to shared/scenario layer (pure data generation).
2. Move `mapData.ts` to shared/scenario layer (regions/facilities/chokepoints/fronts).
3. Move `createInitialGameState()` to core/scenario layer.
4. Re-export from `packages/core/src/index.ts`.
5. Update web import:
- from `./initState` to `@ai-commander/core`.
6. Keep web only responsible for:
- canvas loop
- input
- rendering

### Safety Checklist

- Keep IDs and initial positions unchanged during move.
- Verify `updateFog` still runs on first frame.
- Verify minimap and facility rendering still receive same data.
- Run `npm run typecheck` and `npm run build`.

## Day10 Implementation Record: Core Boundary Refactor (Completed)

Baseline: `main@1052ee4`. Chat-mode changes deferred to Day13.

### What was done

Executed Option A from the plan above. All files moved via `git mv` to preserve history.

**Files moved (verbatim, imports adjusted):**

| Original | Destination | Import changes |
|----------|-------------|----------------|
| `apps/web/src/mapData.ts` | `packages/shared/src/scenario/mapData.ts` | `@ai-commander/shared` → relative `../types` |
| `apps/web/src/terrainGen.ts` | `packages/shared/src/scenario/terrainGen.ts` | `@ai-commander/shared` → relative `../types`, `../constants` |
| `apps/web/src/initState.ts` | `packages/core/src/scenario/createInitialGameState.ts` | `@ai-commander/core` → relative `../fog`; `./terrainGen`, `./mapData` → `@ai-commander/shared` |

**New barrel files created:**
- `packages/shared/src/scenario/index.ts` — re-exports REGIONS, CHOKEPOINTS, FACILITIES, FRONTS, FRONT_CAMERA_TARGETS, generateTerrain
- `packages/core/src/scenario/index.ts` — re-exports createInitialGameState

**Updated barrel files:**
- `packages/shared/src/index.ts` — added `export * from "./scenario"`
- `packages/core/src/index.ts` — added `export { createInitialGameState } from "./scenario"`

**Web consumer updated:**
- `apps/web/src/GameCanvas.tsx` — `FRONT_CAMERA_TARGETS` from `@ai-commander/shared`, `createInitialGameState` from `@ai-commander/core`

**Old files removed:** `apps/web/src/mapData.ts`, `apps/web/src/terrainGen.ts`, `apps/web/src/initState.ts` (via git mv)

### Architecture after Day10

```
shared/src/scenario/   ← pure data + deterministic generation (no deps outside shared)
core/src/scenario/     ← state assembly (depends on shared + intra-core fog)
apps/web/              ← rendering + input + loop only (no scenario semantics)
```

### Verification

- `rg` confirmed zero stale `./mapData`, `./terrainGen`, `./initState` references
- `npm run typecheck` / `npm run build` pass in main workspace (or any workspace where npm links resolve to the same checked-out tree)
- Note: in isolated git worktree setups, workspace symlink resolution may point to a different tree and produce false-negative type errors
- No gameplay data changed: all unit IDs, coordinates, teams, resources, fronts identical

## Day11 Plan: Missions System Integration

### Goal

Implement `core/missions.ts` with sabotage/destroy/cut-supply mission types. Missions have progress bars, ETA timers, threat assessment, and trigger LLM three-option decisions at critical moments.

### Scope (Tentative)

- Mission data model already defined in `shared/types.ts`
- `processMissions()` stub exists in `core/missions.ts`
- Day11 fills in: mission creation, progress tick, threat detection, success/failure judgment
- TacticalPlanner Phase 2: sabotage/recon/escort intent resolvers
- Wire mission events into digest for LLM awareness

### Deferred to Day13

- Chat-mode UI changes (jolly-buck branch work)
- Full intent-only LLM schema switch

## Day10.5 Manual Test Notes (2026-03-10)

Day10.5 manual playtest passed for core acceptance checks (chain works, build/typecheck pass).
The following non-blocking issues are tracked for follow-up:

1. `fromSquad: "none"` false-positive from LLM can cause degraded execution (`无法找到分队: none`).
- Suggested fix: sanitize sentinel values (`none/unassigned/null`) as undefined in `sanitizeIntent`, and add prompt guard.
- Target day: **Day11** (command reliability / planner hardening).

2. Camera occasionally drifts left after zoom/click due to stale edge-scroll mouse coordinates.
- Suggested fix: refresh `mouseX/mouseY` on `mousedown` / `mouseenter`, reset on `mouseleave`; optionally disable edge-scroll while selecting.
- Target day: **Day13** (UX/input polish bundle).

3. Patrol end-position sometimes differs from commander expectation (MVP target granularity / safe-point fallback).
- Suggested fix: tighten patrol/retreat target resolution and add clearer target feedback in brief/log.
- Target day: **Day13** (behavior feel + feedback polish).

## Day11 Implementation Record: Missions System + Sabotage Resolver (Completed)

Baseline: `main@19a207f` (Day10.5 merged). Typecheck + build pass.

### What was done

**Part A: Missions Core (`packages/core/src/missions.ts`)**
- Full rewrite from stub → 220+ lines
- `createMission()` — creates tracked mission, links squad, writes diagnostics
- `processMissions(state, dt)` — per-tick lifecycle: prune dead units, check squad viability, tick progress, update threats/ETA
- 5 mission type tickers:
  - `sabotage` — facility damage ratio, complete at 80%+
  - `destroy` — enemy count in region bbox, complete at 0
  - `capture` — mirrors facility.captureProgress
  - `defend_area` — cumulative hold time vs required time
  - `cut_supply` — reuses sabotage logic

**Part B: Squad ↔ Mission Linkage**
- `createMission()` accepts `squadId` opt → sets `squad.currentMission = mission.id`
- `checkSquadFail()` — auto-fails mission when linked squad morale ≤ 0.1 or fully wiped
- `unlinkSquad()` — clears squad.currentMission on mission complete/fail

**Part C: TacticalPlanner Sabotage Resolver**
- Native `resolveSabotage()` in `tacticalPlanner.ts` (no longer falls back to attack)
- Prefers infantry + light_tank, `attack_move` to facility, creates tracking mission
- Added `"sabotage"` to `SUPPORTED_INTENTS` and `DAY7_SUPPORTED_INTENT_TYPES`
- Removed sabotage→attack mapping from `DAY7_INTENT_MAP` in `ai.ts`

**Part D: Digest + Prompt**
- Digest `---MISSIONS---` section already existed (Day 10.5) — no changes needed
- SYSTEM_PROMPT updated:
  - Mission system rules (sabotage needs targetFacility, progress auto-tracked)
  - fromSquad omission guidance ("省略该字段，不要填none")
  - Squad-with-active-mission caution

**Codex Note Fixes**
- `sanitizeIntent()` now filters fromSquad sentinel values: "none", "unassigned", "null", "n/a", "undefined"

**Game Loop**
- `processMissions(state, dt)` wired into GameCanvas.tsx after processEconomy, before AI/autoBehavior

**Exports**
- `core/index.ts` exports: `processMissions`, `createMission`, `resetMissionCounter`, `CreateMissionOpts`

### Files Changed

| File | Change |
|------|--------|
| `packages/core/src/missions.ts` | Full rewrite: mission lifecycle + 5 type tickers |
| `packages/core/src/tacticalPlanner.ts` | +sabotage resolver, +SUPPORTED_INTENTS entry |
| `packages/core/src/index.ts` | +createMission, resetMissionCounter exports |
| `packages/shared/src/schema.ts` | +sentinel filter in sanitizeIntent, +sabotage in DAY7_SUPPORTED |
| `apps/server/src/ai.ts` | SYSTEM_PROMPT mission rules, remove sabotage mapping |
| `apps/web/src/GameCanvas.tsx` | +processMissions in game loop |
| `DAY5_DAY10_NOTES.md` | This record |

### Architecture Invariants Preserved

- LLM → sanitizeIntent → resolveIntent → applyOrders chain intact
- resolveSourceUnits priority: fromSquad → fromFront+all → fromFront → broadDispatch → global
- selectedUnitIds hard constraint (intersection filter) unchanged
- SQUADS and PLAYER_SELECTED digest max 8 lines unchanged
- CommandPanel selectedIdsSnapshotRef unchanged
- PatrolTask unbind logic (Day 9.5) not touched

### Day11 Acceptance Closure (2026-03-11)

- Manual checkpoints core path passed: cp6/cp7/cp8/cp9/cp13.
- cp10 verified by local script: `---MISSIONS---` section capped at 8 lines with overflow marker (`...+N more`).
- cp11 verified by local script: selected-unit hard constraint remains effective; broadDispatch still dispatches multi-unit pool when applicable; squad button enable/disable logic unchanged.
- Observed movement jitter/stuck near bridge/water edges is non-blocking and remains deferred to Day13 polish scope.

### Not Done (Deferred to Day 13)

- **[Day 13 开工第一件事]** 补 1 条自动化用例：`processFacilitySabotage` 对 `attackDamage=0 / attackInterval=0` 单位必须无效（防回归护栏）
- escort resolver
- Mission UI panel (progress bars in web)
- destroy/capture/defend_area mission creation from tactical planner (currently only sabotage creates missions; others can be created via future LLM intents)
- Facility manual interaction UX: right-click facility context menu as primary entry (`占领` / `破坏`), keep `A/C + right-click` as advanced shortcut, add first-time hint text; LLM-issued commands execute directly without popup
- Clarification guard (minimal UX): when intent is degraded due to ambiguous/invalid target (e.g., sabotage target missing/unresolvable), cancel execution and show a lightweight "re-enter command" prompt instead of forcing fallback execution; keep main chain unchanged (`LLM -> sanitizeIntent -> resolveIntent -> applyOrders`)

## Day12 Implementation Record: War Phase + Game-Over Loop (Completed)

Baseline: Day11 merged. Typecheck + build pass.

### What was done

**Part A: War Phase Module (`packages/core/src/warPhase.ts` — NEW)**
- Phase transitions: PEACE → CONFLICT → WAR → ENDGAME
- PEACE → CONFLICT: time ≥ 120s + (readiness ≥ 0.3 OR any front engagement > 0)
- CONFLICT → WAR: manual declaration (warDeclared) OR per-front sustained engagement ≥ 0.6 for 30s
- Any → ENDGAME: time ≥ 900s (ENDGAME_TIME_SEC)
- Per-front engagement timers via module-level Map<string, number>
- Exports: updateGamePhase, checkGameOver, applyEndgamePressure, resetWarPhaseTimers

**Part B: Game-Over Conditions (symmetric)**
1. Player HQ hp ≤ 0 → enemy wins
2. Enemy HQ hp ≤ 0 → player wins
3. Player fuel + ammo == 0 for 60s → enemy wins (logistics collapse)
4. Enemy fuel + ammo == 0 for 60s → player wins (logistics collapse)
5. ENDGAME timeout 300s → score evaluation (Σhp + HQ hp)

**Part C: ENDGAME Pressure**
- 30% income drain on both sides
- 0.5 hp/s attrition on all living units

**Part D: State Model Updates (`packages/shared/src/types.ts`)**
- Added: warDeclared, gameOver, winner, phaseStartTime, endgameStartTime, logisticsZeroSec, warEngageSec, gameOverReason

**Part E: Game Loop Integration (`apps/web/src/GameCanvas.tsx`)**
- Order: tick → economy → updateGamePhase → checkGameOver → missions → AI → autoBehavior → endgamePressure → fog → render
- P1 fix: loop reads stateRef.current each frame (not captured local) for restart safety
- Game-over overlay with restart button, timer resets

**Part F: War Declaration UI (`apps/web/src/CommandPanel.tsx`)**
- "宣战" button: red, only visible in CONFLICT phase, polls every 200ms

**Part G: Digest Updates (`packages/shared/src/digest.ts`)**
- ENDGAME: eta=Ns line when in ENDGAME phase
- GAMEOVER: winner=X reason=Y line when game ends

**Part H: gameOver Guards**
- processMissions, processEnemyAI, processAutoBehavior: early return if state.gameOver

### Hotfix: resolveAttack facility targeting

- When `resolveAttack` targets a facility via `intent.targetFacility`, it now emits `sabotage` orders (with `targetFacilityId`) instead of plain `attack_move`
- Root cause: units with `attack_move` go idle on arrival; only `sabotage` orders trigger `processFacilitySabotage` damage
- Creates sabotage mission for progress tracking

### Hotfix: LLM prompt — fromSquad + unitType conflict

- Added prompt rule: when fromSquad is set, do NOT auto-fill unitType (squad defines the unit set)
- Only fill unitType when commander explicitly differentiates types within a squad (e.g., "T1步兵突击，坦克掩护")
- Root cause: LLM inferred unitType from squad name prefix ("I1" → infantry), filtering out tanks in mixed squads

### Codex Review Bugs Fixed

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| 1 | P2 | Stale closure: setGameOverInfo every frame | useRef guard (gameOverDetectedRef) |
| 2 | P2 | Engagement timer: global max not per-front | Per-front Map<string, number> |
| 3 | P3 | AI/autoBehavior timers not reset on restart | resetEnemyAITimer + resetAutoBehaviorTimer + resetWarPhaseTimers |
| 4 | P1 | handleRestart state split: loop captures old state | Loop reads stateRef.current each frame + identity check |

### Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | +8 GameState fields for war phase |
| `packages/core/src/warPhase.ts` | NEW: phase transitions + game-over + endgame pressure |
| `packages/core/src/scenario/createInitialGameState.ts` | Init new fields |
| `packages/core/src/index.ts` | +warPhase exports, +reset timer exports |
| `packages/core/src/missions.ts` | +gameOver guard |
| `packages/core/src/enemyAI.ts` | +gameOver guard, +resetEnemyAITimer |
| `packages/core/src/autoBehavior.ts` | +gameOver guard, +resetAutoBehaviorTimer |
| `packages/core/src/tacticalPlanner.ts` | resolveAttack facility → sabotage conversion |
| `apps/web/src/GameCanvas.tsx` | Loop integration, game-over overlay, restart |
| `apps/web/src/CommandPanel.tsx` | War declaration button |
| `packages/shared/src/digest.ts` | ENDGAME/GAMEOVER digest lines |
| `apps/server/src/ai.ts` | fromSquad + unitType prompt rule |

### Architecture Invariants Preserved

- LLM → sanitizeIntent → resolveIntent → applyOrders chain intact
- resolveSourceUnits priority unchanged
- selectedUnitIds hard constraint unchanged
- Digest max limits unchanged
- No Day10.5/11 regressions

---

## Day13 TODO (Tracked)

### P1: Clarification Guard UX
- When intent is degraded due to ambiguous/invalid command (e.g., "集合" → patrol instead of defend/move), cancel execution and show a lightweight "请重新输入" prompt
- Root cause: LLM sometimes maps rally/gather commands to patrol intent, which is semantically wrong
- Scope: intent validation + user-facing feedback, NOT changing the main chain (LLM → sanitizeIntent → resolveIntent → applyOrders)
- This was explicitly listed as Day12 non-goal: "No clarification-guard UX / No full intent-only schema migration"

### P2: fromSquad + unitType LLM Reliability Hardening
- Current fix is prompt-level only (telling LLM not to auto-fill unitType when fromSquad is set)
- If LLM doesn't follow prompt (still infers unitType from squad name prefix), mixed squads will still lose non-matching units
- Potential Day14 refinement: add resolver-level fallback — if fromSquad is set AND unitType filter reduces units to 0, retry without unitType filter
- Related: multi-intent squad splitting ("T1步兵突击，坦克掩护") works correctly as-is since unitType filter is intentional there

### P3: Deferred Items from Day11 Notes
- `processFacilitySabotage` regression test for attackDamage=0 / attackInterval=0 units
- escort resolver
- Mission UI panel (progress bars in web)
- destroy/capture/defend_area mission creation from tactical planner
- Facility right-click context menu (占领/破坏)
- Camera drift on zoom/click (edge-scroll stale coords)
- Patrol end-position target granularity

## Suggested Ticket Names

- Day5: `feat(core): local obstacle detour for blocked movement`
- Day10: `refactor(core/shared): move scenario bootstrap out of web`
- Day11: `feat(core): missions system + tacticalPlanner phase 2`
- Day12: `feat(core): war phase + game-over loop + endgame pressure`
- Day13: `feat(ux): clarification guard + intent validation feedback`
