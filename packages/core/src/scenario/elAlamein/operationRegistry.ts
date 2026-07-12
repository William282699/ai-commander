// ============================================================
// AI Commander — El Alamein Operation Registry
//
// Tiny shared ownership ledger for the P2 armored-fist operation.
// ONE writer (defensiveAI's operation layer), read-only consumers
// (pressureDirector's P4 pool gathering). Holds unit ids that belong
// to an operation in ANY phase — assembling, launched, or occupation
// garrison duty — so no other AI path may re-task them.
//
// Deliberately dumb: a Set and four functions. No imports, no game
// state, no lifecycle logic (that all lives with the owner). Empty
// outside el_alamein (operations are only ever created there), so
// isOperationReserved is a constant `false` for dual_island et al.
// ============================================================

const reservedIds = new Set<number>();

/** Owner (defensiveAI operation layer) claims units. */
export function reserveOperationUnits(ids: Iterable<number>): void {
  for (const id of ids) reservedIds.add(id);
}

/** Owner releases units (death / retreat / cancel / operation end). */
export function releaseOperationUnits(ids: Iterable<number>): void {
  for (const id of ids) reservedIds.delete(id);
}

/** Read-only check for every other AI path (P0-P4, garrison, roles). */
export function isOperationReserved(id: number): boolean {
  return reservedIds.has(id);
}

/** Full reset on new game session (called from resetDefensiveAITimer). */
export function clearOperationRegistry(): void {
  reservedIds.clear();
}
