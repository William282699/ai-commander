// ============================================================
// AI Commander — Squad Helpers (Day 10.5)
// Auto-generate squad IDs, ranks, and leader names.
// ============================================================

import type { UnitType, SquadRank, SquadLeader, Squad, CommanderKey, SquadRole, Position } from "./types";

// ── Unit type → squad prefix (P1-2: explicit deterministic mapping) ──

const UNIT_PREFIX_MAP: Record<UnitType, string> = {
  // Ground
  infantry: "I",
  light_tank: "T",
  main_tank: "T",
  artillery: "A",
  commander: "CMD",
  elite_guard: "E",
  // Naval
  patrol_boat: "N",
  destroyer: "N",
  cruiser: "N",
  carrier: "N",
  // Air
  fighter: "F",
  bomber: "F",
  recon_plane: "F",
};

/**
 * Determine the squad ID prefix from the majority unit type.
 * Counts occurrences of each prefix and returns the most common.
 */
function getMajorityPrefix(unitTypes: UnitType[]): string {
  const counts = new Map<string, number>();
  for (const t of unitTypes) {
    const prefix = UNIT_PREFIX_MAP[t] || "U";
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  let best = "U";
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Generate a squad ID like "T5", "I3", etc.
 * Mutates nextNums to increment the counter.
 */
export function autoSquadId(
  unitTypes: UnitType[],
  nextNums: { [prefix: string]: number },
): string {
  const prefix = getMajorityPrefix(unitTypes);
  const num = nextNums[prefix] || 1;
  nextNums[prefix] = num + 1;
  return `${prefix}${num}`;
}

/**
 * Determine squad leader rank based on unit count.
 */
export function autoRank(unitCount: number): SquadRank {
  if (unitCount <= 8) return "squad_leader";
  if (unitCount <= 30) return "platoon_leader";
  if (unitCount <= 100) return "company_commander";
  return "battalion_commander";
}

// ── Leader name pool (simple deterministic pick) ──

const LEADER_NAMES = [
  "赵铁柱", "钱卫国", "孙志刚", "李建军", "周勇", "吴强",
  "郑大鹏", "王海龙", "冯雷", "陈刚", "褚虎", "卫青",
  "蒋云飞", "沈磊", "韩石", "杨猛",
];

let leaderNameIdx = 0;

/**
 * Create a SquadLeader with auto-generated attributes.
 */
export function createSquadLeader(unitCount: number): SquadLeader {
  const name = LEADER_NAMES[leaderNameIdx % LEADER_NAMES.length];
  leaderNameIdx++;
  return {
    name,
    rank: autoRank(unitCount),
    personality: "balanced",
  };
}

// ── Rank display names ──

const RANK_LABELS: Record<SquadRank, string> = {
  squad_leader: "班长",
  platoon_leader: "排长",
  company_commander: "连长",
  battalion_commander: "团长",
};

export function rankLabel(rank: SquadRank): string {
  return RANK_LABELS[rank];
}

// ── Squad name generation ──

const PREFIX_LABELS: Record<string, string> = {
  T: "装甲", I: "步兵", A: "炮兵", N: "海军", F: "航空", U: "混编",
};

/**
 * Generate a human-readable squad name like "装甲5分队".
 */
export function autoSquadName(squadId: string): string {
  const prefix = squadId.charAt(0);
  const num = squadId.slice(1);
  const label = PREFIX_LABELS[prefix] || "混编";
  return `${label}${num}分队`;
}

/**
 * Create a full Squad object from selected unit IDs.
 * Caller must ensure unitIds are validated (player, alive, not in another squad).
 */
/** MVP2: Unit types that cannot be assigned to squads (mouse-only elite units) */
const SQUAD_EXCLUDED_TYPES: readonly UnitType[] = ["commander", "elite_guard"];

export function createSquad(
  unitIds: number[],
  unitTypes: UnitType[],
  nextNums: { [prefix: string]: number },
  ownerCommander: CommanderKey,
  leaderName: string,
  opts?: { role?: SquadRole; parentSquadId?: string },
): Squad {
  // MVP2: Filter out elite units that are mouse-only
  const filteredIds = unitIds.filter((_, i) => !SQUAD_EXCLUDED_TYPES.includes(unitTypes[i]));
  const filteredTypes = unitTypes.filter((t) => !SQUAD_EXCLUDED_TYPES.includes(t));
  const id = autoSquadId(filteredTypes.length > 0 ? filteredTypes : unitTypes, nextNums);
  return {
    id,
    name: autoSquadName(id),
    unitIds: [...filteredIds],
    leader: createSquadLeader(unitIds.length),
    currentMission: null,
    missionTarget: null,
    morale: 1.0,
    formationStyle: "line",
    ownerCommander,
    leaderName,
    role: opts?.role ?? "leader",
    parentSquadId: opts?.parentSquadId,
  };
}
