// ============================================================
// AI Commander — Squad Hierarchy Operations (Phase 2 + 2.5)
// The ONLY module that writes squad hierarchy relationships.
// Other files read squad hierarchy fields only.
// ============================================================

import type { GameState, Squad, UnitType, CommanderKey } from "./types";
import { autoSquadId, autoSquadName, createSquadLeader } from "./squad";
import { pickLeaderName, getUsedLeaderNames } from "./namePool";

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

// ── Squad Reference Resolution ──
// These helpers are the CANONICAL resolvers for the three forms an external
// squad reference can take (see SYSTEM_PROMPT squad section and handoff):
//   - Squad ID       "I1"
//   - Leader name    "Aiden"
//   - Commander key  "chen" / "marcus" / "emily" — resolves to all squads
//                    owned by that commander
//
// All consumers (autoBehavior's doctrine gate, taskTracker's alive-units
// collection, ChatPanel's anchor / soft-fix / stale-ref checks, etc.) MUST
// delegate squad-ref matching here so the rule lives in exactly one place.
// If the form expands (aliases, unit IDs, fuzzy names, etc.) only this
// block changes.

const COMMANDER_KEYS: readonly CommanderKey[] = ["chen", "marcus", "emily"];

/** Is this string one of the three commander keys? Case-insensitive. */
export function isCommanderKey(ref: string): boolean {
  return (COMMANDER_KEYS as readonly string[]).includes(ref.toLowerCase());
}

/**
 * Resolve a squad reference string to all matching Squad entities.
 * - Squad ID / leader name: returns 0 or 1 squad (exact match).
 * - Commander key:          returns every squad under that commander.
 * - Empty / unresolvable:   returns empty array.
 */
export function resolveSquadRef(state: GameState, ref: string): Squad[] {
  if (!ref) return [];
  const refLower = ref.toLowerCase();
  if (isCommanderKey(refLower)) {
    return state.squads.filter(s => s.ownerCommander === refLower);
  }
  return state.squads.filter(s =>
    s.id === ref || s.leaderName?.toLowerCase() === refLower,
  );
}

/**
 * Test a single Squad against a ref. Equivalent to
 * `resolveSquadRef(state, ref).includes(squad)` but O(1).
 */
export function squadRefMatchesSquad(ref: string, squad: Squad): boolean {
  if (!ref) return false;
  const refLower = ref.toLowerCase();
  if (ref === squad.id) return true;
  if (squad.leaderName && squad.leaderName.toLowerCase() === refLower) return true;
  if (isCommanderKey(refLower) && squad.ownerCommander === refLower) return true;
  return false;
}

/**
 * Find the direct (leader) squad this unit belongs to. Commander squads
 * hold no unitIds (see assertCommanderEmpty invariant) so this always
 * returns the leaf leader — which is the level doctrine.assignedSquads
 * and task.assignedSquads typically reference.
 */
export function findLeaderSquadForUnit(state: GameState, unitId: number): Squad | null {
  for (const sq of state.squads) {
    if (sq.unitIds.includes(unitId)) return sq;
  }
  return null;
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
 * Phase 2.5: Promote a leader to commander.
 * Creates a new leader to take over the original leader's units.
 * Returns the newly created child leader.
 */
function promoteToCommander(state: GameState, leader: Squad): Squad {
  // Collect unit types for auto squad ID
  const unitTypes: UnitType[] = leader.unitIds
    .map((id) => state.units.get(id))
    .filter((u) => u !== undefined)
    .map((u) => u!.type);

  // Generate new child leader
  const usedNames = getUsedLeaderNames(state.squads);
  const childLeaderName = pickLeaderName(usedNames);
  const childId = autoSquadId(unitTypes.length > 0 ? unitTypes : ["infantry"], state.nextSquadNum);
  const childSquad: Squad = {
    id: childId,
    name: autoSquadName(childId),
    unitIds: [...leader.unitIds],
    leader: createSquadLeader(leader.unitIds.length),
    currentMission: leader.currentMission,
    missionTarget: leader.missionTarget ? { ...leader.missionTarget } : null,
    morale: leader.morale,
    formationStyle: leader.formationStyle,
    ownerCommander: leader.ownerCommander,
    leaderName: childLeaderName,
    role: "leader",
    parentSquadId: leader.id,
  };

  // Promote original to commander
  leader.unitIds = [];
  leader.role = "commander";
  leader.currentMission = null;
  leader.missionTarget = null;

  // Add child to state
  state.squads.push(childSquad);

  return childSquad;
}

/**
 * Phase 2.5: Try to demote a commander back to leader if it has exactly 1 child.
 * Merges the sole child's units into the commander and removes the child.
 */
function tryDemoteCommander(state: GameState, commander: Squad): void {
  if (commander.role !== "commander") return;
  const children = getChildren(state, commander.id);
  if (children.length !== 1) return;

  const child = children[0];
  // Only demote if child is a leader (not a nested commander)
  if (child.role !== "leader") return;

  // Absorb child's units
  commander.unitIds = [...child.unitIds];
  commander.role = "leader";
  commander.morale = child.morale;
  commander.currentMission = child.currentMission;
  commander.missionTarget = child.missionTarget ? { ...child.missionTarget } : null;

  // Remove the child squad
  const idx = state.squads.findIndex((s) => s.id === child.id);
  if (idx !== -1) {
    state.squads.splice(idx, 1);
  }
}

/**
 * Move a squad under a new parent.
 * Phase 2.5: if target is a leader, auto-promote it to commander first.
 * Validates: source=leader, no self-move, no cycle, depth ≤ 3, same ownerCommander.
 */
export function moveSquadUnder(
  state: GameState,
  squadId: string,
  newParentId: string,
): { ok: boolean; error?: string; promoted?: boolean } {
  // Invariant: all commanders must have empty unitIds
  assertAllCommandersEmpty(state);

  const squad = state.squads.find((s) => s.id === squadId);
  const parent = state.squads.find((s) => s.id === newParentId);

  if (!squad) return { ok: false, error: `Squad ${squadId} not found` };
  if (!parent) return { ok: false, error: `Parent ${newParentId} not found` };

  // Only leaders can be moved
  if (squad.role !== "leader") {
    return { ok: false, error: "Only leader squads can be moved" };
  }

  // Self-move
  if (squadId === newParentId) {
    return { ok: false, error: "Cannot move squad under itself" };
  }

  // Prevent cycle: can't move under own descendant
  if (isDescendantOrSelf(state, squadId, newParentId)) {
    return { ok: false, error: "Cannot move squad under its own descendant" };
  }

  // Cross-commander transfer: update ownerCommander for the moved squad and all descendants
  if (squad.ownerCommander !== parent.ownerCommander) {
    // Detach from old parent first
    if (squad.parentSquadId) {
      removeSquadFromParent(state, squadId);
    }
    // Recursively update ownerCommander
    const setOwner = (sid: string) => {
      const s = state.squads.find(sq => sq.id === sid);
      if (!s) return;
      s.ownerCommander = parent.ownerCommander;
      state.squads.filter(sq => sq.parentSquadId === sid).forEach(child => setOwner(child.id));
    };
    setOwner(squadId);
  }

  // Phase 2.5: auto-promote leader target to commander
  let promoted = false;
  if (parent.role === "leader") {
    // Check depth: after promotion, parent stays at same depth,
    // new child leader + moved squad will be at parentDepth+1
    const parentDepth = getSquadDepth(state, newParentId);
    if (parentDepth + 1 > 3) {
      return { ok: false, error: "Max depth 3 exceeded (promotion would exceed)" };
    }
    promoteToCommander(state, parent);
    promoted = true;
  }

  // Depth check after potential promotion
  const parentDepth = getSquadDepth(state, newParentId);
  const movedSubtreeDepth = getMaxSubtreeDepth(state, squadId);
  if (parentDepth + movedSubtreeDepth > 3) {
    return { ok: false, error: "Max depth 3 exceeded" };
  }

  // Perform the move
  squad.parentSquadId = newParentId;
  return { ok: true, promoted };
}

/**
 * Remove a squad from its parent, making it a direct report of root commander.
 * Phase 2.5: if parent commander has only 1 child left after removal, auto-demote.
 */
export function removeSquadFromParent(
  state: GameState,
  squadId: string,
): { ok: boolean } {
  // Invariant
  assertAllCommandersEmpty(state);

  const squad = state.squads.find((s) => s.id === squadId);
  if (!squad || !squad.parentSquadId) return { ok: false };

  const oldParentId = squad.parentSquadId;
  squad.parentSquadId = undefined;

  // Phase 2.5: try auto-demote the old parent if it now has only 1 child
  const oldParent = state.squads.find((s) => s.id === oldParentId);
  if (oldParent) {
    tryDemoteCommander(state, oldParent);
  }

  return { ok: true };
}

/**
 * Transfer a squad (and all its descendants) to a different commander as a root squad.
 * Detaches from old parent, recursively updates ownerCommander.
 */
export function transferSquadToCommander(
  state: GameState,
  squadId: string,
  newOwner: CommanderKey,
): { ok: boolean; error?: string } {
  const squad = state.squads.find((s) => s.id === squadId);
  if (!squad) return { ok: false, error: "Squad not found" };
  if (squad.ownerCommander === newOwner && !squad.parentSquadId) return { ok: false, error: "Already under this commander" };

  // Detach from old parent
  if (squad.parentSquadId) {
    removeSquadFromParent(state, squadId);
  }

  // Recursively update ownerCommander
  const setOwner = (sid: string) => {
    const s = state.squads.find(sq => sq.id === sid);
    if (!s) return;
    s.ownerCommander = newOwner;
    state.squads.filter(sq => sq.parentSquadId === sid).forEach(child => setOwner(child.id));
  };
  setOwner(squadId);

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
