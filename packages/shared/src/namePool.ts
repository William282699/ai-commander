// ============================================================
// AI Commander — Leader Name Pool (Phase 2)
// Provides unique military-style names for squad leaders.
// ============================================================

const NAMES = [
  "Aiden", "Blake", "Carter", "Drake", "Ellis",
  "Farrell", "Griffin", "Hayes", "Irving", "Jensen",
  "Knox", "Lawson", "Mason", "Nash", "Owens",
  "Pierce", "Quinn", "Reed", "Shaw", "Tucker",
  "Vance", "Walsh", "York", "Barrett", "Callahan",
  "Donovan", "Emery", "Fischer", "Garrett", "Harper",
  "Kane", "Mercer", "Palmer", "Reeves", "Stone",
];

/**
 * Pick a unique leader name not in usedNames.
 * Falls back to "Name-2", "Name-3", etc. if all names exhausted.
 */
export function pickLeaderName(usedNames: Set<string>): string {
  // Shuffle deterministically by trying each name
  for (const name of NAMES) {
    if (!usedNames.has(name)) {
      return name;
    }
  }
  // All names used — add suffix
  for (let suffix = 2; ; suffix++) {
    for (const name of NAMES) {
      const candidate = `${name}-${suffix}`;
      if (!usedNames.has(candidate)) {
        return candidate;
      }
    }
  }
}

/**
 * Collect all leaderNames currently in use from squads.
 */
export function getUsedLeaderNames(squads: { leaderName: string }[]): Set<string> {
  return new Set(squads.map((s) => s.leaderName));
}
