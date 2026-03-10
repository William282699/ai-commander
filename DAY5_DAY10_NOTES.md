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

## Suggested Ticket Names

- Day5: `feat(core): local obstacle detour for blocked movement`
- Day10: `refactor(core/shared): move scenario bootstrap out of web`
- Day11: `feat(core): missions system + tacticalPlanner phase 2`
