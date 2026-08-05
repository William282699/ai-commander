// ============================================================
// AI Commander — Front destination resolver (approval-contract-v4 §8)
//
// User ruling 2026-08-04 (proposed in DIALOGUE_AB_KNIFE_REVIEW_BRIEF_20260803
// §8, adjudicated by Fable 5): "去/守某条战线" must land on something that is
// ACTUALLY THERE, from specific to generic. Before this, all three front
// branches of resolveTarget went through the front's GEOMETRIC CENTER — an
// average of region bboxes, i.e. a statistic, not a place. Measured on
// front_center: tag → (301,110) ✓, facility → (361,105) ✓, front → (264,96),
// 97 tiles from the outpost the order was about.
//
// The ladder (mode "approach": defend / reinforce / move / support / attack):
//   1. friendly units in the front that FOUGHT RECENTLY → biggest cluster
//   2. any friendly units in the front            → biggest cluster
//   3. surviving friendly facility in the front   → that facility
//   4. nothing at all                             → frontCenterPos
//
// mode "withdraw" (retreat) inverts the first two rungs, because a retreat
// must never end up standing in the fight it is leaving:
//   1. surviving friendly facility (falling back ON a strongpoint is the point)
//   2. friendly units in the front that did NOT fight recently → biggest cluster
//   3. nothing → frontCenterPos (empty ground is an acceptable retreat floor)
//
// ★ Biggest CLUSTER, not the average. The average is what battleAnchorFor did
// and it is wrong the moment a front holds two fights: one at the west end and
// one at the east end average to the middle, ~100 tiles from either, and the
// relief column arrives where nobody is (hand-test 2026-08-02 round 4).
//
// ★ Fog: friendly units' OWN timestamps + facility metadata (public) only.
// Not one enemy field is read, so no enemy position can leak through the point
// this returns. Every helper here is friendly-filtered at the top.
//
// Position in the module graph is load-bearing: crisisResponse imports
// tacticalPlanner (findFront) and frontEscalationPayload imports crisisResponse,
// so a resolver reachable from BOTH tacticalPlanner and crisisResponse can only
// live below all three. Hence the clustering (was frontEscalationPayload) and
// the engagement predicate (was crisisResponse-private) moved down HERE rather
// than being copied — two copies of "who counts as fighting" is the bug class
// this whole rung exists to close.
// ============================================================

import type { Facility, Front, GameState, Position, Unit } from "@ai-commander/shared";

/** Straight-line tile distance. */
export function tileDist(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
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

/** Two groups merge only if their closest members are this near. */
const CLUSTER_LINK_TILES = 10;

/** …and only if the merged group still fits inside this span. */
const CLUSTER_DIAMETER_MAX_TILES = 20;

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
            const d = tileDist(merged[x].position, merged[y].position);
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

// ── Front geometry ──

/** Check if a position is inside a front's region bounding boxes. */
export function isInsideFront(state: GameState, front: Front, pos: Position): boolean {
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r && pos.x >= r.bbox[0] && pos.x <= r.bbox[2] && pos.y >= r.bbox[1] && pos.y <= r.bbox[3]) {
      return true;
    }
  }
  return false;
}

/** Get the center position of a front by averaging its region bboxes.
 *  The LAST rung of the ladder on purpose: it is a statistic about the map,
 *  not a place anything stands. */
export function frontCenterPos(state: GameState, front: Front): Position | null {
  let totalX = 0;
  let totalY = 0;
  let count = 0;
  for (const rid of front.regionIds) {
    const region = state.regions.get(rid);
    if (region) {
      totalX += (region.bbox[0] + region.bbox[2]) / 2;
      totalY += (region.bbox[1] + region.bbox[3]) / 2;
      count++;
    }
  }
  if (count === 0) return null;
  return { x: Math.round(totalX / count), y: Math.round(totalY / count) };
}

// ── Engagement evidence (the unit's OWN timestamps; never an enemy read) ──

const ANCHOR_ENGAGED_WINDOW_SEC = 10;

/** Recent combat evidence from the unit's own fired-at / took-damage stamps.
 *  The `> 0` guards keep an initial-0 timestamp from reading as "just fought". */
export function unitFoughtRecently(u: Unit, now: number): boolean {
  if (u.lastAttackTime > 0 && now - u.lastAttackTime < ANCHOR_ENGAGED_WINDOW_SEC) return true;
  if (u.lastDamagedAt !== undefined && u.lastDamagedAt > 0 &&
      now - u.lastDamagedAt < ANCHOR_ENGAGED_WINDOW_SEC) {
    return true;
  }
  return false;
}

// ── The ladder ──

export type FrontDestinationMode =
  /** Going TO the front: defend / reinforce / move / support / attack. */
  | "approach"
  /** Leaving it: retreat. Never lands on a cluster that is currently fighting. */
  | "withdraw";

/** Alive friendly units standing inside the front. Same predicate battleAnchorFor
 *  has always used (commanders included — a body at the fight is a body at the
 *  fight); narrowing it here would silently move every existing rally point. */
function friendlyUnitsIn(state: GameState, front: Front): Unit[] {
  const out: Unit[] = [];
  state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
    if (!isInsideFront(state, front, u.position)) return;
    out.push(u);
  });
  return out;
}

/** Centroid of the most populous cluster. Ties go to the group spatialGroups
 *  lists first (sorted by smallest member id ⇒ order-independent). Deliberately
 *  NOT rounded: callers compare it against ETA estimates measured to the same
 *  fractional point. */
function biggestClusterCentroid(units: Unit[]): Position | null {
  if (units.length === 0) return null;
  const groups = spatialGroups(units);
  let biggest = groups[0];
  for (const g of groups) {
    if (g.length > biggest.length) biggest = g; // strict > ⇒ first max wins
  }
  const x = biggest.reduce((s, u) => s + u.position.x, 0) / biggest.length;
  const y = biggest.reduce((s, u) => s + u.position.y, 0) / biggest.length;
  return { x, y };
}

/** The friendly facility on this front worth standing on: victory objectives and
 *  headquarters first, then by id so the choice never depends on Map order. */
function friendlyFacilityIn(state: GameState, front: Front): Facility | null {
  const objectives = new Set(state.captureObjectives ?? []);
  let best: Facility | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const f of state.facilities.values()) {
    if (f.team !== "player" || f.hp <= 0) continue;
    if (!isInsideFront(state, front, f.position)) continue;
    const rank = objectives.has(f.id) || f.type === "headquarters" ? 0 : 1;
    if (rank < bestRank || (rank === bestRank && best !== null && f.id < best.id)) {
      best = f;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Where an order that names only a FRONT should actually land.
 *
 * Returns null only when the front has no resolvable geometry at all (no
 * regions) — never a (0,0) placeholder.
 */
export function frontDestinationFor(
  state: GameState,
  front: Front,
  mode: FrontDestinationMode,
): Position | null {
  const now = state.time;
  const units = friendlyUnitsIn(state, front);

  if (mode === "withdraw") {
    // 1) Fall back ON something: a friendly facility is a strongpoint, and
    //    "retreat to the depot" is what a commander means by 撤.
    const fac = friendlyFacilityIn(state, front);
    if (fac) return { ...fac.position };
    // 2) Otherwise regroup on friendlies who are NOT in contact. Inverting the
    //    engagement test here is the whole point: retreating into the firefight
    //    is the 2026-08-03 §7④ defect (6 units ordered to retreat onto the
    //    enemy's own position).
    const quiet = biggestClusterCentroid(units.filter((u) => !unitFoughtRecently(u, now)));
    if (quiet) return quiet;
    // 3) Everyone is in contact, or the front is empty. Open ground is a poor
    //    rally point but a legitimate one to withdraw toward.
    return frontCenterPos(state, front);
  }

  // 1) The fight itself — the most concentrated one, not the average of all.
  const fighting = biggestClusterCentroid(units.filter((u) => unitFoughtRecently(u, now)));
  if (fighting) return fighting;
  // 2) Quiet front with troops on it: join them (relieve/reinforce the line).
  const standing = biggestClusterCentroid(units);
  if (standing) return standing;
  // 3) Empty front: the thing on it worth holding. Measured 2026-08-03: the
  //    geometric center of front_center is (263,96), open desert, while what we
  //    actually own there is the central outpost at (360,105).
  const fac = friendlyFacilityIn(state, front);
  if (fac) return { ...fac.position };
  // 4) Nothing of ours on this line at all.
  return frontCenterPos(state, front);
}
