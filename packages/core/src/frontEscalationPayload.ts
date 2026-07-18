// ============================================================
// AI Commander — Front Escalation Payload (battlefield-info-v2 V1b)
//
// THE single assembly point for the front-escalation /api/brief mini-payload.
// Production (GameCanvas front-escalation branch) and the A/B bench
// (scripts/ab-front-escalation.ts) MUST both call buildFrontEscalationPayload;
// a hand-rolled copy in either place tests a replica, not the product.
//
// Contract (BATTLEFIELD_INFO_V2_DESIGN.md v3 §2-3):
// - The five legacy lines (SITUATION header, front, stake, survival, power
//   ratio, raw_signal) stay byte-identical to the pre-V1b GameCanvas branch;
//   the ONLY change is that `idle_reinforcement_available` is replaced by a
//   `reinforcement_options` block.
// - The block carries CANDIDATES + facts (size, hp%, task, eta), never a
//   pre-baked conclusion. The full candidate set is built first; display
//   truncates to DISPLAY_BUDGET and reports the TRUE omitted count.
//   Truncation is presentation only — nothing here feeds dispatch.
// - Friendly-only reads → fog-safe by construction. Engagement evidence is
//   the unit's own combat timestamps (guarded against the 0 initial value);
//   no enemy-position reads anywhere in this module.
// ============================================================

import type {
  GameState,
  Front,
  Position,
  Unit,
  Squad,
  CrisisEvent,
} from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import { frontEscalationFacts } from "./director";
import { frontCenterPos, estimateSquadTravelTime } from "./crisisResponse";

// ── Tunables (explicit, no defaults hidden in call sites) ──

/** Spatial-grouping link distance (tiles): two groups may merge only if their
 *  CLOSEST members are within this range — "moves as one local force", same
 *  order of magnitude as the facility NEAR_RADIUS (12). */
const CLUSTER_LINK_TILES = 10;

/** Hard cap on a group's DIAMETER (max pairwise member distance). Pure
 *  connected-component expansion lets chains (A–B≤10, B–C≤10, …) snowball
 *  into one "force" with unbounded span — a fake force no commander would
 *  treat as one body (Codex round-3 boundary). Every merge must keep the
 *  merged diameter within this cap, so the bound holds by construction. */
const CLUSTER_DIAMETER_MAX_TILES = 20;

/** Naming radius (tiles): a group is "near <facility>" only within this range.
 *  Beyond it we fall back to the nearest front's name ("<front>方向") instead
 *  of claiming proximity to a place the group is not actually near. */
const NAME_RADIUS_TILES = 12;

/** Combat-evidence window (seconds): fired or took damage this recently ⇒
 *  the candidate is 交战中. Timestamps must be > 0 — the engine initializes
 *  lastAttackTime to 0, which must never read as "attacked at t=0". */
const ENGAGED_WINDOW_SEC = 10;

/** Presentation budget: entries shown in the payload. NOT a candidate cap and
 *  NOT a dispatch cap — the omitted count below the list is the real remainder. */
const DISPLAY_BUDGET = 3;

// ── Candidate model (exported for the bench's synthetic assertions) ──

export type ReinforceTaskStatus = "交战中" | "守卫" | "巡逻" | "无任务" | "unknown";

export interface ReinforceOption {
  /** Player-addressable label: "Blake(T5)" or "大本营附近未编组群". Never a bare internal id. */
  label: string;
  unitCount: number;
  /** Composition summary, e.g. "infantry×52" / "infantry×12+armor×4" (top 3 types). */
  composition: string;
  /** Alive members only: Σhp / Σ maxHp of ALIVE members (dead excluded from both sides). */
  hpPct: number;
  task: ReinforceTaskStatus;
  /** Straight-line terrain-sampled slowest-member estimate (NOT A*); null = unknown. */
  etaSec: number | null;
}

export interface ReinforceOptionsResult {
  options: ReinforceOption[]; // full set, sorted (无任务 first, then eta asc)
  shown: ReinforceOption[];   // first DISPLAY_BUDGET
  omitted: number;            // options.length - shown.length (true count)
}

// ── Geometry helpers (front bboxes; local on purpose — the only crisisResponse
//    symbols we are allowed to import are frontCenterPos + the ETA helper) ──

function frontBboxes(state: GameState, front: Front): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r) out.push(r.bbox);
  }
  return out;
}

function insideBboxes(bboxes: [number, number, number, number][], p: Position): boolean {
  return bboxes.some(([x1, y1, x2, y2]) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2);
}

function dist(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Evidence helpers ──

/** Recent combat evidence from the unit's OWN timestamps. Initial-0 guarded. */
function isEngaged(u: Unit, now: number): boolean {
  if (u.lastAttackTime > 0 && now - u.lastAttackTime < ENGAGED_WINDOW_SEC) return true;
  if (u.lastDamagedAt !== undefined && u.lastDamagedAt > 0 && now - u.lastDamagedAt < ENGAGED_WINDOW_SEC) {
    return true;
  }
  return false;
}

/** Map a uniform order/state picture to a task status; null = not uniform/typed. */
function orderTaskOf(u: Unit): ReinforceTaskStatus | null {
  const active = u.orders.find((o) => o.action === "defend" || o.action === "hold" || o.action === "patrol");
  if (active) return active.action === "patrol" ? "巡逻" : "守卫";
  if (u.patrolTaskId !== null) return "巡逻";
  if (u.state === "patrolling") return "巡逻";
  if (u.state === "defending") return "守卫";
  if (u.state === "idle" && u.orders.length === 0) return "无任务";
  return null; // moving/attacking/other → cannot type from orders alone
}

/**
 * Five-level task status for a group of alive members (design v3 §3):
 *  1. any recent combat evidence            → 交战中
 *  2. active mission id → state.missions    → defend_area = 守卫, else unknown
 *  3. uniform member orders defend/hold     → 守卫 ; patrol/patrolTask → 巡逻
 *  4. all members idle with no orders       → 无任务
 *  5. mixed / unresolvable                  → unknown  (majority vote forbidden)
 */
function groupTaskStatus(state: GameState, members: Unit[], missionId: string | null): ReinforceTaskStatus {
  const now = state.time;
  if (members.some((u) => isEngaged(u, now))) return "交战中";

  if (missionId) {
    const mission = state.missions.find((m) => m.id === missionId && m.status === "active");
    if (mission) return mission.type === "defend_area" ? "守卫" : "unknown";
    return "unknown"; // id present but unresolvable (stale/legacy string) — never guess
  }

  const statuses = new Set<ReinforceTaskStatus | null>(members.map(orderTaskOf));
  if (statuses.size === 1) {
    const only = statuses.values().next().value;
    if (only !== null && only !== undefined) return only;
  }
  return "unknown";
}

function hpPctOf(members: Unit[]): number {
  let hp = 0;
  let max = 0;
  for (const u of members) {
    hp += u.hp;
    max += u.maxHp;
  }
  return max > 0 ? Math.round((hp / max) * 100) : 0;
}

function compositionOf(members: Unit[]): string {
  const counts = new Map<string, number>();
  for (const u of members) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${t}×${n}`)
    .join("+");
}

function etaOf(state: GameState, memberIds: number[], anchor: Position | null): number | null {
  if (!anchor) return null;
  const t = estimateSquadTravelTime(state, memberIds, anchor);
  return Number.isFinite(t) && t > 0 ? Math.round(t) : null;
}

// ── Deterministic spatial grouping with a hard diameter cap ──
//
// Greedy agglomerative, smallest link first. A merge happens only when BOTH
// hold: (a) closest members of the two groups are within CLUSTER_LINK_TILES,
// (b) the merged group's diameter stays ≤ CLUSTER_DIAMETER_MAX_TILES. (b) is
// the invariant that stops chain snowballing (A–B≤10, B–C≤10, A–C≫10 must
// NOT become one group once its span exceeds the cap). Deterministic: groups
// are kept sorted by smallest member id; candidate scan order + strict
// "better (link, diam)" comparison make tie-breaks order-independent.

/** Exported for the bench: groups whose max pairwise distance must stay ≤ cap. */
export const CLUSTER_DIAMETER_CAP = CLUSTER_DIAMETER_MAX_TILES;

export function spatialGroups(units: Unit[]): Unit[][] {
  let groups: Unit[][] = [...units]
    .sort((a, b) => a.id - b.id)
    .map((u) => [u]);

  for (;;) {
    let best: { i: number; j: number; link: number; diam: number } | null = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let link = Infinity;
        let diam = 0;
        const merged = [...groups[i], ...groups[j]];
        for (let x = 0; x < merged.length; x++) {
          for (let y = x + 1; y < merged.length; y++) {
            const d = dist(merged[x].position, merged[y].position);
            if (d > diam) diam = d;
            const cross =
              (x < groups[i].length) !== (y < groups[i].length); // one from each side
            if (cross && d < link) link = d;
          }
        }
        if (link > CLUSTER_LINK_TILES || diam > CLUSTER_DIAMETER_MAX_TILES) continue;
        if (!best || link < best.link || (link === best.link && diam < best.diam)) {
          best = { i, j, link, diam };
        }
      }
    }
    if (!best) break;
    const merged = [...groups[best.i], ...groups[best.j]].sort((a, b) => a.id - b.id);
    groups = groups.filter((_, k) => k !== best.i && k !== best.j);
    groups.push(merged);
    groups.sort((ga, gb) => ga[0].id - gb[0].id);
  }
  return groups;
}

/** Name a group AFTER grouping — naming never merges. Within NAME_RADIUS of a
 *  standing facility → "「名」附近"; else nearest front → "「名」方向"; else a
 *  neutral numbered label (fabricating a place is forbidden). */
function groupLabel(state: GameState, centroid: Position, ordinal: number): string {
  let bestFac: { name: string; d: number } | null = null;
  state.facilities.forEach((f) => {
    if (f.hp <= 0) return;
    const d = dist(centroid, f.position);
    if (!bestFac || d < bestFac.d) bestFac = { name: f.name, d };
  });
  if (bestFac !== null && (bestFac as { name: string; d: number }).d <= NAME_RADIUS_TILES) {
    return `${(bestFac as { name: string; d: number }).name}附近未编组群`;
  }
  let bestFront: { name: string; d: number } | null = null;
  for (const fr of state.fronts) {
    const c = frontCenterPos(state, fr);
    if (!c) continue;
    const d = dist(centroid, c);
    if (!bestFront || d < bestFront.d) bestFront = { name: fr.name, d };
  }
  if (bestFront !== null) return `${(bestFront as { name: string; d: number }).name}方向未编组群`;
  return `未编组群${ordinal}`;
}

// ── Candidate collection ──

/**
 * Build the FULL reinforcement candidate set for a crisis front, sorted.
 * Candidates = dispatchable player units OUTSIDE the crisis front (units inside
 * are already committed — they are what survival_sec/power_ratio describe).
 * Exported so the bench can assert on structured results, not string-parse.
 */
export function buildReinforceOptions(
  state: GameState,
  front: Front | null,
): ReinforceOptionsResult {
  const bboxes = front ? frontBboxes(state, front) : [];
  const anchor = front ? frontCenterPos(state, front) : null;
  const outsideFront = (p: Position): boolean => bboxes.length === 0 || !insideBboxes(bboxes, p);

  // Dispatchable pool (friendly-only; commanders and manual-only excluded).
  const pool = new Map<number, Unit>();
  state.units.forEach((u) => {
    if (u.hp <= 0 || u.type === "commander") return;
    if (!isDispatchablePlayerUnit(u)) return;
    pool.set(u.id, u);
  });

  const options: ReinforceOption[] = [];
  const inAnySquad = new Set<number>();
  for (const sq of state.squads ?? []) for (const id of sq.unitIds) inAnySquad.add(id);

  // 1) Organized squads (leader role only; CMD wrappers are hierarchy, not forces).
  for (const sq of state.squads ?? []) {
    if (sq.role !== "leader") continue;
    const members = sq.unitIds.map((id) => pool.get(id)).filter((u): u is Unit => u !== undefined);
    if (members.length === 0) continue;
    // Any member already inside the crisis front ⇒ the squad is committed there,
    // not a reinforcement option (it is part of the survival math instead).
    if (members.some((u) => !outsideFront(u.position))) continue;
    options.push({
      label: `${sq.leaderName}(${sq.id})`,
      unitCount: members.length,
      composition: compositionOf(members),
      hpPct: hpPctOf(members),
      task: groupTaskStatus(state, members, sq.currentMission),
      etaSec: etaOf(state, members.map((u) => u.id), anchor),
    });
  }

  // 2) Unorganized units: spatial groups first, names second (never merged by name).
  const unassigned = Array.from(pool.values()).filter(
    (u) => !inAnySquad.has(u.id) && outsideFront(u.position),
  );
  let ordinal = 1;
  for (const group of spatialGroups(unassigned)) {
    const cx = group.reduce((s, u) => s + u.position.x, 0) / group.length;
    const cy = group.reduce((s, u) => s + u.position.y, 0) / group.length;
    options.push({
      label: groupLabel(state, { x: cx, y: cy }, ordinal++),
      unitCount: group.length,
      composition: compositionOf(group),
      hpPct: hpPctOf(group),
      task: groupTaskStatus(state, group, null),
      etaSec: etaOf(state, group.map((u) => u.id), anchor),
    });
  }

  // Sort: 无任务 first, then eta ascending (unknown eta last), stable label tiebreak.
  options.sort((a, b) => {
    const fa = a.task === "无任务" ? 0 : 1;
    const fb = b.task === "无任务" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ea = a.etaSec ?? Number.MAX_SAFE_INTEGER;
    const eb = b.etaSec ?? Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;
    return a.label.localeCompare(b.label);
  });

  const shown = options.slice(0, DISPLAY_BUDGET);
  return { options, shown, omitted: options.length - shown.length };
}

// ── Serialization ──

function serializeOptions(result: ReinforceOptionsResult): string[] {
  if (result.options.length === 0) {
    // Empty set ≠ "no idle troops anywhere". Say precisely what is true:
    // there is no dispatchable friendly force outside the crisis front at all.
    return ["reinforcement_options: none (crisis front 外无可派遣友军)"];
  }
  const lines = ["reinforcement_options:"];
  for (const o of result.shown) {
    const eta = o.etaSec !== null ? `${o.etaSec}` : "unknown";
    lines.push(
      `- ${o.label}: ${o.unitCount}units(${o.composition}) hp=${o.hpPct}% ${o.task} eta_est_sec=${eta}`,
    );
  }
  if (result.omitted > 0) {
    lines.push(`- (另有${result.omitted}股候选未列出)`);
  }
  return lines;
}

// ── The single production payload builder ──

/**
 * Build the COMPLETE front-escalation mini-payload. The five legacy lines are
 * byte-identical to the pre-V1b GameCanvas branch; only the old
 * `idle_reinforcement_available` line is replaced by the options block.
 */
export function buildFrontEscalationPayload(state: GameState, crisis: CrisisEvent): string {
  const facts = frontEscalationFacts(state, crisis);
  const front = facts ? state.fronts.find((f) => f.id === facts.frontId) ?? null : null;
  const place = facts?.frontName ?? crisis.locationTag;
  const stake = facts?.stake ?? "unknown";

  const optionsBlock = serializeOptions(buildReinforceOptions(state, front));

  return [
    "SITUATION (voice ONE in-character line for THIS single point only):",
    `front: ${place}`,
    `stake: ${stake}`,
    `our_committed_force_survival_sec: ${facts?.estimatedCollapseSeconds ?? "unknown"}`,
    `local_power_ratio_ours_to_visible_enemy: ${facts?.powerRatio ?? "unknown"}`,
    ...optionsBlock,
    `raw_signal: ${crisis.message}`,
  ].join("\n");
}
