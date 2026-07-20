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

/** Naming radius (tiles): a candidate is "near <place>" (or "en route to
 *  <place>") only within this range of a standing facility or front center.
 *  Beyond it the location phrase is OMITTED — proximity is never approximated
 *  and there is no unbounded fallback (P1-1: a fabricated place is worse than
 *  silence). */
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
  /** Contract v3 §3: all-static → "X附近" (place within NAME_RADIUS); all-moving
   *  with resolvable destination → "向X行进中"; mixed/unresolvable → null and
   *  the phrase is omitted. Groups carry the phrase inside their label instead. */
  location: string | null;
  task: ReinforceTaskStatus;
  /** Straight-line terrain-sampled slowest-member estimate (NOT A*); null = unknown. */
  etaSec: number | null;
}

export interface ReinforceOptionsResult {
  options: ReinforceOption[]; // full set, sorted (无任务 first, then eta asc)
  shown: ReinforceOption[];   // first DISPLAY_BUDGET
  omitted: number;            // options.length - shown.length (true count)
  /** ALL alive friendly units outside the crisis front — any kind, including
   *  commanders, manual-only and squad-locked members. Grounds the empty-set
   *  wording: "no candidates" must never read as "no friendlies" (F1). */
  outsideFriendlyCount: number;
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
export function groupTaskStatus(state: GameState, members: Unit[], missionId: string | null): ReinforceTaskStatus {
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

export function hpPctOf(members: Unit[]): number {
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
  // ceil, not round: a sub-second estimate must surface as 1 — never a fake 0
  // (P1-2: Math.round(0.4) === 0 slipped past the t > 0 guard).
  return Number.isFinite(t) && t > 0 ? Math.ceil(t) : null;
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

// ── Location phrase (contract v3 §3; shared by squads and groups) ──

/** Nearest named place (standing facility or front center) within NAME_RADIUS;
 *  null beyond it. Used both for static naming and destination resolution. */
export function nearestPlaceWithin(state: GameState, p: Position): string | null {
  let best: { name: string; d: number } | null = null;
  state.facilities.forEach((f) => {
    if (f.hp <= 0) return;
    const d = dist(p, f.position);
    if (!best || d < best.d) best = { name: f.name, d };
  });
  for (const fr of state.fronts) {
    const c = frontCenterPos(state, fr);
    if (!c) continue;
    const d = dist(p, c);
    if (!best || d < best.d) best = { name: fr.name, d };
  }
  const b = best as { name: string; d: number } | null;
  return b !== null && b.d <= NAME_RADIUS_TILES ? b.name : null;
}

function centroidOf(points: Position[]): Position {
  const x = points.reduce((s, p) => s + p.x, 0) / points.length;
  const y = points.reduce((s, p) => s + p.y, 0) / points.length;
  return { x, y };
}

/** The engine's OWN movement gate (sim.ts tick step 1) — a unit in any of
 *  these states physically moves this tick. Kept in sync with sim.ts; a
 *  retreating/patrolling unit is just as "not here anymore" as a moving one
 *  (Codex round-5). */
function isActuallyMoving(u: Unit): boolean {
  return (
    u.state === "moving" ||
    u.state === "retreating" ||
    u.state === "patrolling" ||
    (u.state === "defending" && u.target !== null)
  );
}

/**
 * Location phrase for a candidate's members (P1-1, round-5 tightened):
 *  - no member actually moving                     → "X附近" (place within radius, else null)
 *  - ALL members moving AND ALL have a target      → "向X行进中" (targets centroid resolvable)
 *  - mixed motion / any missing target / unresolvable → null (phrase omitted)
 * A force leaving a place must not be pinned to it, and one member's target
 * must not speak for the whole group — uncertainty is omitted, never guessed.
 */
export function locationPhraseFor(state: GameState, members: Unit[]): string | null {
  const moving = members.filter(isActuallyMoving);
  if (moving.length === 0) {
    const place = nearestPlaceWithin(state, centroidOf(members.map((u) => u.position)));
    return place !== null ? `${place}附近` : null;
  }
  if (moving.length === members.length) {
    const targets = members.map((u) => u.target).filter((t): t is Position => t !== null);
    if (targets.length !== members.length) return null;
    const place = nearestPlaceWithin(state, centroidOf(targets));
    return place !== null ? `向${place}行进中` : null;
  }
  return null;
}


// ── Compass-octant fallback (voice-polish v1, Codex-approved) ──
// For groups with NO resolvable place: pure geometry relative to MAP CENTER —
// a direction is not a proximity claim, so the P1-1 contract holds. Same-octant
// collisions get deterministic 第一/第二… suffixes (counting order = group
// order, sorted by smallest member id) so the payload never carries two
// identical candidate names.
const OCTANT_NAMES = ["东", "东北", "北", "西北", "西", "西南", "南", "东南"] as const;
const CN_ORDINALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"] as const;

/** Within this radius of map center an octant is noise (dead-center would
 *  read 东) — such groups are named 中央 instead (Codex polish round-2 #3). */
const CENTER_DEADZONE_TILES = 10;

export function compassOctant(state: GameState, p: Position): string {
  const cx = state.mapWidth / 2;
  const cy = state.mapHeight / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (Math.sqrt(dx * dx + dy * dy) <= CENTER_DEADZONE_TILES) return "中央";
  // Screen coordinates: y grows southward, so north = -dy. 0 rad = east.
  const ang = Math.atan2(-dy, dx);
  const idx = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return OCTANT_NAMES[idx];
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
  // Separately: EVERY alive friendly outside the front, no eligibility filter —
  // the empty-set wording must distinguish "no friendlies at all" from
  // "friendlies exist but none forms a listable candidate" (F1 lesson).
  let outsideFriendlyCount = 0;
  state.units.forEach((u) => {
    if (u.team === "player" && u.hp > 0 && u.state !== "dead" && outsideFront(u.position)) {
      outsideFriendlyCount++;
    }
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
      location: locationPhraseFor(state, members),
      task: groupTaskStatus(state, members, sq.currentMission),
      etaSec: etaOf(state, members.map((u) => u.id), anchor),
    });
  }

  // 2) Unorganized units: spatial groups first, names second (never merged by name).
  const unassigned = Array.from(pool.values()).filter(
    (u) => !inAnySquad.has(u.id) && outsideFront(u.position),
  );
  const groups = spatialGroups(unassigned);
  const phrases = groups.map((g) => locationPhraseFor(state, g));
  // Unresolvable-place groups fall back to compass octants; count per octant
  // first so same-direction groups get 第一/第二… (deterministic, no duplicates).
  const octants = groups.map((g, i) =>
    phrases[i] === null ? compassOctant(state, centroidOf(g.map((u) => u.position))) : null,
  );
  const octantTotals = new Map<string, number>();
  for (const o of octants) if (o !== null) octantTotals.set(o, (octantTotals.get(o) ?? 0) + 1);
  const octantSeen = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const phrase = phrases[i];
    // The location phrase IS the group's speakable handle, so it folds into
    // the label; unresolvable → compass direction, never a fabricated place.
    let label: string;
    if (phrase !== null) {
      label = phrase.startsWith("向") ? `${phrase}的未编组群` : `${phrase}未编组群`;
    } else {
      const o = octants[i]!;
      if ((octantTotals.get(o) ?? 0) <= 1) {
        label = `${o}方向未编组群`;
      } else {
        const k = (octantSeen.get(o) ?? 0) + 1;
        octantSeen.set(o, k);
        // 1-10 use Chinese ordinals; beyond that, real numbers — labels must
        // stay ABSOLUTELY unique, never saturate at 第十 (round-2 #3).
        const ord = k <= CN_ORDINALS.length ? CN_ORDINALS[k - 1] : String(k);
        label = `${o}方向第${ord}未编组群`;
      }
    }
    options.push({
      label,
      unitCount: group.length,
      composition: compositionOf(group),
      hpPct: hpPctOf(group),
      location: null, // already carried by the label
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
  return { options, shown, omitted: options.length - shown.length, outsideFriendlyCount };
}

// ── Serialization ──

function serializeOptions(result: ReinforceOptionsResult): string[] {
  if (result.options.length === 0) {
    // Empty set ≠ "no idle troops anywhere" (the F1 lie). Two reachable truths
    // (Codex round-4): either the field outside the crisis front is literally
    // empty, or friendlies exist there but none forms a listable candidate
    // right now (manual-only/commander units, squads straddling the crisis
    // front, …). The second wording stays GENERIC on purpose — asserting a
    // fixed reason would manufacture a new wrong conclusion.
    if (result.outsideFriendlyCount === 0) {
      return ["reinforcement_options: none (战场上无其他友军)"];
    }
    return [
      `reinforcement_options: none (front 外有${result.outsideFriendlyCount}个友军单位, 但当前无可单列的增援候选)`,
    ];
  }
  const lines = ["reinforcement_options:"];
  for (const o of result.shown) {
    const eta = o.etaSec !== null ? `${o.etaSec}` : "unknown";
    lines.push(
      `- ${o.label}: ${o.unitCount}units(${o.composition}) hp=${o.hpPct}%${o.location !== null ? ` ${o.location}` : ""} ${o.task} eta_est_sec=${eta}`,
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
