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
  /** Going TO the front to hold or help: defend / reinforce / move / support. */
  | "approach"
  /** Leaving it: retreat. Never lands on a cluster that is currently fighting. */
  | "withdraw"
  /** Taking it: attack. The objective is the enemy's, not our own line. */
  | "assault";

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
 * An enemy-held facility on this front. `objectivesOnly` splits the two rungs
 * the assault ladder needs: victory points are a rung of their own, plain enemy
 * facilities sit far lower down.
 *
 * Neutral facilities are NEVER returned — neutral is not the enemy, and the
 * front's neutral radar being treated as a target is exactly the regression
 * this rung exists to fix (hand-test 2026-08-05: an assault on 山脊战线 landed
 * on the neutral 中央雷达 our own squad happened to be fighting at).
 *
 * Ties resolve by distance to `reference` — our foothold on that line, or the
 * front center when we have none — then by id, so the choice never depends on
 * Map iteration order.
 *
 * Fog: a facility's team and position are public metadata, the same read the
 * friendly rung already makes. No enemy UNIT is read anywhere in this module.
 */
function enemyFacilityIn(
  state: GameState,
  front: Front,
  reference: Position | null,
  objectivesOnly: boolean,
): Facility | null {
  const objectives = new Set(state.captureObjectives ?? []);
  let best: Facility | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const f of state.facilities.values()) {
    if (f.team !== "enemy" || f.hp <= 0) continue;
    if (objectives.has(f.id) !== objectivesOnly) continue;
    if (!isInsideFront(state, front, f.position)) continue;
    const d = reference ? tileDist(reference, f.position) : 0;
    if (d < bestDist || (d === bestDist && best !== null && f.id < best.id)) {
      best = f;
      bestDist = d;
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

  if (mode === "assault") {
    // ── 刀F (regression fix + user ruling 2026-08-05) ──
    //
    // ONE principle generates the whole order: naming a REGION means "go change
    // what happens in that region", so the landing point is where THIS VERB has
    // the most effect. Ranking attack's options by that yields, top to bottom:
    //
    //   1. enemy victory point   — taking it changes who wins the battle
    //   2. our biggest FIGHT     — tipping a live engagement decides that line
    //   3. our biggest force     — massing on our own foothold projects from it
    //   4. enemy plain facility  — real enemy ground, but no scoreboard effect
    //   5. our own facility      — a place on the named front, effect near zero
    //   6. frontCenterPos        — a statistic; last, as everywhere else
    //
    // Two measured cases pin the order. 山脊战线 (2 enemy VPs, our 3-man squad
    // skirmishing on the front's NEUTRAL radar): §8 hung attack on the approach
    // ladder, whose rung 1 is "our biggest fight", so 14 units marched onto our
    // own skirmish — 36 tiles from the nearest VP, while the pre-§8 geometric
    // center (239,76) happened to sit 10.8 tiles from it. That center reading
    // better was a coincidence of this one front (its two VPs bracket the
    // centroid), so the fix is attack's own ladder, not a revert. 中央战线 pins
    // the other end: no VP, one enemy barracks in the far SW corner, our fight
    // at the east end 240 tiles away — rung 2 beating rung 4 is what stops
    // 「全军进攻中央战线」 from marching the army into the corner.
    //
    // ★ Rung 2 above rung 4 is deliberate and has a consequence worth stating
    // out loud: on a front with NO victory point where we are already fighting,
    // an attack still lands on our own fight. That is the same SHAPE as the
    // regression above, kept on purpose — there the enemy had a VP to take;
    // here winning the engagement in progress IS the largest available effect.
    const reference = biggestClusterCentroid(units) ?? frontCenterPos(state, front);
    const vp = enemyFacilityIn(state, front, reference, true);
    if (vp) return { ...vp.position };
    const fightingHere = biggestClusterCentroid(units.filter((u) => unitFoughtRecently(u, now)));
    if (fightingHere) return fightingHere;
    const standingHere = biggestClusterCentroid(units);
    if (standingHere) return standingHere;
    const enemyGround = enemyFacilityIn(state, front, reference, false);
    if (enemyGround) return { ...enemyGround.position };
    const ourFacility = friendlyFacilityIn(state, front);
    if (ourFacility) return { ...ourFacility.position };
    return frontCenterPos(state, front);
  }

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

  // ── approach ──
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
