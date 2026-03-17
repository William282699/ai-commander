// ============================================================
// AI Commander — Squad Hierarchy Operations (Phase 2)
// The ONLY module that writes squad hierarchy relationships.
// Other files read squad hierarchy fields only.
// ============================================================

import type { GameState, Squad } from "./types";

// ── Invariant ──

function assertCommanderEmpty(squad: Squad): void {
  if (squad.role === "commander" && squad.unitIds.length > 0) {
    throw new Error(`Invariant violated: commander ${squad.id} has unitIds`);
  }
}

/** Run invariant check on all squads in state. Called at the top of every write op. */
function assertAllCommandersEmpty(state: GameState): void {
  for (const sq of state.squads) {
    assertCommanderEmpty(sq);
  }
}

// ── Read Operations ──

/**
 * Recursively collect all unitIds under a squad node (inclusive).
 * For a leader: returns its own unitIds.
 * For a commander: returns unitIds of all descendant leaders.
 */
export function collectUnitsUnder(state: GameState, squadId: string): number[] {
  const squad = state.squads.find((s) => s.id === squadId);
  if (!squad) return [];

  if (squad.role === "leader") {
    return [...squad.unitIds];
  }

  // Commander: collect from children recursively
  const result: number[] = [];
  const children = getChildren(state, squadId);
  for (const child of children) {
    result.push(...collectUnitsUnder(state, child.id));
  }
  return result;
}

/**
 * Get depth from root (root commander direct report = 1).
 */
export function getSquadDepth(state: GameState, squadId: string): number {
  let depth = 1;
  let current = state.squads.find((s) => s.id === squadId);
  while (current?.parentSquadId) {
    depth++;
    current = state.squads.find((s) => s.id === current!.parentSquadId);
    if (!current) break;
  }
  return depth;
}

/**
 * Return all squads whose parentSquadId === squadId.
 */
export function getChildren(state: GameState, squadId: string): Squad[] {
  return state.squads.filter((s) => s.parentSquadId === squadId);
}

/**
 * Check if candidateId is a descendant of ancestorId (or equal).
 */
export function isDescendantOrSelf(state: GameState, ancestorId: string, candidateId: string): boolean {
  if (ancestorId === candidateId) return true;
  const children = getChildren(state, ancestorId);
  for (const child of children) {
    if (isDescendantOrSelf(state, child.id, candidateId)) return true;
  }
  return false;
}

/**
 * Get the maximum depth of a subtree rooted at squadId (1 = leaf).
 */
export function getMaxSubtreeDepth(state: GameState, squadId: string): number {
  const children = getChildren(state, squadId);
  if (children.length === 0) return 1;
  let max = 0;
  for (const child of children) {
    const d = getMaxSubtreeDepth(state, child.id);
    if (d > max) max = d;
  }
  return 1 + max;
}

// ── Write Operations ──

/**
 * Move a squad under a new parent.
 * Phase 2: source must be leader, target must already be a commander. No auto-promotion.
 * Validates: source=leader, no self-move, no cycle, depth ≤ 3, same ownerCommander.
 */
export function moveSquadUnder(
  state: GameState,
  squadId: string,
  newParentId: string,
): { ok: boolean; error?: string } {
  // Invariant: all commanders must have empty unitIds
  assertAllCommandersEmpty(state);

  const squad = state.squads.find((s) => s.id === squadId);
  const parent = state.squads.find((s) => s.id === newParentId);

  if (!squad) return { ok: false, error: `Squad ${squadId} not found` };
  if (!parent) return { ok: false, error: `Parent ${newParentId} not found` };

  // Phase 2: only leaders can be moved
  if (squad.role !== "leader") {
    return { ok: false, error: "Only leader squads can be moved in Phase 2" };
  }

  // Self-move
  if (squadId === newParentId) {
    return { ok: false, error: "Cannot move squad under itself" };
  }

  // Prevent cycle: can't move under own descendant
  if (isDescendantOrSelf(state, squadId, newParentId)) {
    return { ok: false, error: "Cannot move squad under its own descendant" };
  }

  // Same owner
  if (squad.ownerCommander !== parent.ownerCommander) {
    return { ok: false, error: "Cannot move squad across commanders" };
  }

  // Phase 2: target must be commander
  if (parent.role !== "commander") {
    return { ok: false, error: "Target must be a commander (Phase 2)" };
  }

  // Depth check: parent depth + 1 for the moved squad must be ≤ 3
  const parentDepth = getSquadDepth(state, newParentId);
  const movedSubtreeDepth = getMaxSubtreeDepth(state, squadId);
  if (parentDepth + movedSubtreeDepth > 3) {
    return { ok: false, error: "Max depth 3 exceeded" };
  }

  // Perform the move
  squad.parentSquadId = newParentId;
  return { ok: true };
}

/**
 * Remove a squad from its parent, making it a direct report of root commander.
 */
export function removeSquadFromParent(
  state: GameState,
  squadId: string,
): { ok: boolean } {
  // Invariant
  assertAllCommandersEmpty(state);

  const squad = state.squads.find((s) => s.id === squadId);
  if (!squad || !squad.parentSquadId) return { ok: false };
  squad.parentSquadId = undefined;
  return { ok: true };
}

/**
 * Dissolve a squad. Only allowed if squad has no unitIds (empty leader or commander).
 * Children move up one level.
 */
export function dissolveSquad(state: GameState, squadId: string): void {
  // Invariant
  assertAllCommandersEmpty(state);

  const squad = state.squads.find((s) => s.id === squadId);
  if (!squad) return;

  // Guard: only dissolve if no direct units
  if (squad.unitIds.length > 0) return;

  const parentId = squad.parentSquadId;

  // Re-parent children
  const children = getChildren(state, squadId);
  for (const child of children) {
    child.parentSquadId = parentId; // may be undefined (root)
  }

  // Remove squad from array
  const idx = state.squads.findIndex((s) => s.id === squadId);
  if (idx !== -1) {
    state.squads.splice(idx, 1);
  }
}
