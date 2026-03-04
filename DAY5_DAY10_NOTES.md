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

## Suggested Ticket Names

- Day5: `feat(core): local obstacle detour for blocked movement`
- Day10: `refactor(core/shared): move scenario bootstrap out of web`
