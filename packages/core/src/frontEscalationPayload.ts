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
import { frontCenterPos, battleAnchorFor, estimateSquadTravelTime } from "./crisisResponse";
// v4 §8: the clustering moved DOWN to frontDestination so the destination
// resolver can use it without importing this module (which would close the
// crisisResponse ↔ frontEscalationPayload loop). Same function, one copy.
import { spatialGroups, tileDist as dist } from "./frontDestination";
export { spatialGroups, CLUSTER_DIAMETER_CAP } from "./frontDestination";

// ── Tunables (explicit, no defaults hidden in call sites) ──

// Spatial-grouping tunables (link distance 10, diameter cap 20) live with the
// clustering itself in frontDestination.ts, re-exported above.

/** Naming radius (tiles): a candidate is "near <place>" (or "en route to
 *  <place>") only within this range of a standing facility or front center.
 *  Beyond it the location phrase is OMITTED — proximity is never approximated
 *  and there is no unbounded fallback (P1-1: a fabricated place is worse than
 *  silence). Exported (presence Step C): placeNameAt must judge tag proximity
 *  with the SAME radius — a second constant would drift. */
export const NAME_RADIUS_TILES = 12;

/** Combat-evidence window (seconds): fired or took damage this recently ⇒
 *  the candidate is 交战中. Timestamps must be > 0 — the engine initializes
 *  lastAttackTime to 0, which must never read as "attacked at t=0". */
const ENGAGED_WINDOW_SEC = 10;

/** Presentation budget: entries shown in the payload. NOT a candidate cap and
 *  NOT a dispatch cap — the omitted count below the list is the real remainder. */
const DISPLAY_BUDGET = 3;

// ── Candidate model (exported for the bench's synthetic assertions) ──

export type ReinforceTaskStatus = "交战中" | "守卫" | "巡逻" | "无任务" | "unknown";

/** THE idle value. Exported so consumers that mean "actually free" test against
 *  the source of truth instead of re-typing the string (v4 §8 ⑦: the disclosure
 *  line called 10 units "闲着" while 4 of them were 交战中). */
export const TASK_IDLE: ReinforceTaskStatus = "无任务";

export interface ReinforceOption {
  /** Player-addressable label: "Blake(T5)" or "大本营附近未编组群". Never a bare internal id. */
  label: string;
  /** v4 刀2: STRUCTURED capture only — the escalation ticket freezes these ids
   *  at mint time. MUST NEVER appear in serializeOptions: the payload text
   *  stays byte-identical to 163d86e (the V1b bench is the gate). */
  memberIds: number[];
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
//    symbols we are allowed to import are frontCenterPos, battleAnchorFor
//    [v4 刀1: the anchor truth source lives next to frontCenterPos] and the
//    ETA helper) ──

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

// `dist` is frontDestination's tileDist, imported above under the old local
// name — one euclid helper, not two that could drift apart in rounding.

// ── Evidence helpers ──

/** Recent combat evidence from the unit's OWN timestamps. Initial-0 guarded. */
function isEngaged(u: Unit, now: number): boolean {
  if (u.lastAttackTime > 0 && now - u.lastAttackTime < ENGAGED_WINDOW_SEC) return true;
  if (u.lastDamagedAt !== undefined && u.lastDamagedAt > 0 && now - u.lastDamagedAt < ENGAGED_WINDOW_SEC) {
    return true;
  }
  return false;
}

/**
 * THE idle predicate: nothing ordered and nothing being done.
 *
 * Exported (H1, 2026-08-05) so the receipt's "these were pulled off a task"
 * disclosure and the board's 无任务 label are the SAME ruler. A unit the
 * envelope calls 闲着 must never be reported as torn off a mission, and vice
 * versa; two predicates for one word is how those two faces drift apart.
 */
export function isUnitIdle(u: Unit): boolean {
  return u.state === "idle" && u.orders.length === 0;
}

/** Map a uniform order/state picture to a task status; null = not uniform/typed. */
function orderTaskOf(u: Unit): ReinforceTaskStatus | null {
  const active = u.orders.find((o) => o.action === "defend" || o.action === "hold" || o.action === "patrol");
  if (active) return active.action === "patrol" ? "巡逻" : "守卫";
  if (u.patrolTaskId !== null) return "巡逻";
  if (u.state === "patrolling") return "巡逻";
  if (u.state === "defending") return "守卫";
  if (isUnitIdle(u)) return "无任务";
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

// The spatial grouping itself now lives in frontDestination.ts (re-exported
// at the top of this file) — see the import note there for why it had to move.

// ── Location phrase (contract v3 §3; shared by squads and groups) ──

/** Nearest named place within NAME_RADIUS; null beyond it. Used both for static
 *  naming and destination resolution.
 *
 *  ── 第 8 级 刀4：玩家插的标记也是地名 ──
 *  以前这里只扫设施与战线中心，于是一支停在玩家自己插的标记点旁边的闲兵，
 *  长官听到的只能是"东北方向未编组群"——他明明在那儿插了一面旗。
 *
 *  **标记优先**：半径内有标记就用标记名，哪怕设施更近。理由不是"标记更准"，
 *  是**精度是长官自己花力气标出来的**，引擎没有资格用一个通用地名盖过它。
 *  这条语义原样来自 Step C 的 placeNameAt（现已塌缩成本函数的别名），
 *  同一个 NAME_RADIUS_TILES，不新设常量。
 *
 *  并列时先入者赢（strict `<`）——与塌缩前的 placeNameAt 逐字同规则。
 *  刻意不按 tag id 排序：id 是 "tag_1"/"tag_10" 这种字符串，字典序会把 tag_10
 *  排在 tag_2 前面，那不是"确定性"，那是另一种任意。
 *
 *  标记零雾风险：tag 是玩家自己插的，不含任何敌情读数。 */
export function nearestPlaceWithin(state: GameState, p: Position): string | null {
  return nearestPlaceScan(state, p, NAME_RADIUS_TILES)?.name ?? null;
}

/** 一个够得着的地名，连它站在哪。 */
export interface NearestPlace {
  name: string;
  position: Position;
  /** 到查询点的格数。 */
  d: number;
}

/**
 * 「离这个点最近、且够得着的地名是谁」——**唯一一套扫描纪律**（刀② ②）。
 *
 * 半径是参数，规则不是：标记优先、并列先入者赢（strict `<`）、设施要活着、
 * 战线用中心点——四条对 12 格（取地名）与 36 格（取方位原点）**是同一套**。
 * 抽成一份的理由不是省行数：**两套扫描各带各的优先级，就是本刀要杀的
 * 参照系分裂在代码层重生。**
 *
 * `radius === NAME_RADIUS_TILES` 时与抽取前逐字节等价（`ab-commander-presence`
 * 的 K4-3 别名断言是现成的闸）。
 */
function nearestPlaceScan(state: GameState, p: Position, radius: number): NearestPlace | null {
  let bestTag: NearestPlace | null = null;
  for (const t of state.tags ?? []) {
    const d = dist(p, t.position);
    if (!bestTag || d < bestTag.d) bestTag = { name: t.name, position: t.position, d };
  }
  if (bestTag !== null && bestTag.d <= radius) return bestTag;

  let best: NearestPlace | null = null;
  state.facilities.forEach((f) => {
    if (f.hp <= 0) return;
    const d = dist(p, f.position);
    if (!best || d < best.d) best = { name: f.name, position: f.position, d };
  });
  for (const fr of state.fronts) {
    const c = frontCenterPos(state, fr);
    if (!c) continue;
    const d = dist(p, c);
    if (!best || d < best.d) best = { name: fr.name, position: c, d };
  }
  const b = best as NearestPlace | null;
  return b !== null && b.d <= radius ? b : null;
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

/**
 * 「这个点该叫什么方位」——**唯一命名内核**（刀② ①，2026-08-12）。
 *
 * 在此之前，"没地名就报方位"这套组合在两处各写了一份：本文件的候选标签
 * （带 第一/第二 序数去重）与 `commandPreflight` 的来源清单（按名聚合计数）。
 * 两处的**聚合与去重语义不同、各自都对**，收敛它们是错的；真正重复的只是
 * 内核这一问：**这个点的方位词是什么、以谁为原点**。
 *
 * `origin` ＝ 方位的参照原点名。**今天恒为 null**：今天的方位以**地图中心**
 * 为原点，而地图中心不是战场上的东西、说不出口，所以名字里不带它。
 * ② 要换的就是这一个函数——让 origin 变成长官看得见的那个地名
 * （`兵营西北`），两个调用点一个字都不用改。
 */
export interface BearingName {
  /** 八向方位词（或近中心时的「中央」）。 */
  word: string;
  /** 方位相对谁而言；null ＝ 相对地图中心，不说出口。 */
  origin: string | null;
}

/**
 * 方位原点够得着的最远距离 ＝ **派生自现有常数** `3 × NAME_RADIUS_TILES`。
 * 超出它就没有可说的原点，退回罗盘——**罗盘兜底分支因此保持活着、可测**。
 * 换张图（地标密度不同）必须重量这个倍数。
 */
export const BEARING_ORIGIN_MAX_TILES = 3 * NAME_RADIUS_TILES;

/**
 * 刀② ②：方位以**长官看得见的那个地名**为原点，不以地图中心。
 *
 * 原点集合与取地名**同一套扫描纪律**（`nearestPlaceScan`，只换半径）——
 * 洞二裁定：两套集合＝第三个参照系，正是本刀要杀的病。
 *
 * 前提：本函数只在「12 格内取不到地名」时被调用，所以找到的原点必然 >12 格，
 * 不存在"原点就在脚下、方位角无意义"那一格。
 */
export function bearingNameFor(state: GameState, p: Position): BearingName {
  const origin = nearestPlaceScan(state, p, BEARING_ORIGIN_MAX_TILES);
  if (origin === null) return { word: compassOctant(state, p), origin: null };
  return { word: octantWord(p.x - origin.position.x, p.y - origin.position.y), origin: origin.name };
}

/** 组装成可念的短语：有原点 ⇒「兵营西北」；无原点 ⇒「东北方向」。
 *  ★ 它也是**同名碰撞的判定键**——序数去重按这个短语数，不按裸方位词，
 *  否则 ② 之后「兵营西北」与「机场西北」会被算成同一个名字。 */
export function bearingPhrase(b: BearingName): string {
  return b.origin === null ? `${b.word}方向` : `${b.origin}${b.word}`;
}

/**
 * 「一个位移该叫哪个八向词」——**唯一一份角度数学**（刀② ②，Fable 裁定 2）。
 *
 * 只做几何，不含任何"原点是谁"的知识：`compassOctant` 的**地图中心 + 10 格
 * 「中央」死区**留在它自己那儿，**不许跟着抄进来**——那条死区是"离地图正中
 * 太近时八向是噪声"，而从一个 12-36 格外的地名量方位时方位并不含糊，
 * 死区语义不成立。
 *
 * 屏幕坐标 y 向南增，故北＝-dy；0 rad ＝ 东。
 */
export function octantWord(dx: number, dy: number): string {
  const ang = Math.atan2(-dy, dx);
  const idx = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return OCTANT_NAMES[idx];
}

export function compassOctant(state: GameState, p: Position): string {
  const cx = state.mapWidth / 2;
  const cy = state.mapHeight / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (Math.sqrt(dx * dx + dy * dy) <= CENTER_DEADZONE_TILES) return "中央";
  return octantWord(dx, dy);
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
  /** 第 8 级 刀1（R9 乙案）：设施危机的候选池与战线危机不是一回事。
   *
   *  战线危机问的是「线外谁能来」——线内的人已经投入了，他们就是 survival/ratio
   *  描述的对象。设施危机问的不是这个：北线前哨挨打时，最该派的往往正是**同在
   *  北部战线、但在别处闲着**的那坨人。照战线口径他们连号都拿不到，长官点不到。
   *
   *  所以设施危机传 front=null（全图为池）+ 下面两个参数：
   *   - anchorOverride：ETA 量到**设施**，不是量到该线打得最凶那处；
   *   - excludeNear：把设施身边那圈人排除掉——他们正在那儿挨打，不是援兵。
   *     （自我增援谬误：prompt 规则 [D] 只覆盖 UNDER_ATTACK 消息面，不覆盖此面。
   *     半径与 payload 的 nearby_forces_ours 同一常量＝同一把尺。）
   *
   *  三个参数全可选、默认关；不传时既有调用方逐字节不变。 */
  opts?: {
    anchorOverride?: Position | null;
    excludeNear?: { center: Position; radius: number } | null;
  },
): ReinforceOptionsResult {
  const bboxes = front ? frontBboxes(state, front) : [];
  // v4 刀1: the ETA promise is measured to where the FIGHT is, not to the
  // front's geometric center. Every downstream consumer of etaSec (the
  // escalation question and commanderPresence's best_help row) inherits the
  // fix from this one line — they all read this builder's output.
  const anchor = opts?.anchorOverride !== undefined
    ? opts.anchorOverride
    : (front ? battleAnchorFor(state, front) : null);
  const ring = opts?.excludeNear ?? null;
  const ringR2 = ring ? ring.radius * ring.radius : 0;
  const insideRing = (p: Position): boolean => {
    if (!ring) return false;
    const dx = p.x - ring.center.x;
    const dy = p.y - ring.center.y;
    return dx * dx + dy * dy <= ringR2;
  };
  const outsideFront = (p: Position): boolean =>
    !insideRing(p) && (bboxes.length === 0 || !insideBboxes(bboxes, p));

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
      memberIds: members.map((u) => u.id).sort((a, b) => a - b),
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
  // Unresolvable-place groups fall back to the bearing kernel; count per bearing
  // PHRASE first so same-direction groups get 第一/第二… (deterministic, no
  // duplicates). ★键是短语不是裸方位词——② 之后「兵营西北」与「机场西北」
  // 是两个名字，按裸词数会把它们并成一个。今天短语＝`${词}方向`，两者一一对应，
  // 所以这一步改键**不改任何输出**。
  const octants = groups.map((g, i) =>
    phrases[i] === null
      ? bearingPhrase(bearingNameFor(state, centroidOf(g.map((u) => u.position))))
      : null,
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
      const o = octants[i]!;   // 已是短语（今天＝「东北方向」）
      if ((octantTotals.get(o) ?? 0) <= 1) {
        label = `${o}未编组群`;
      } else {
        const k = (octantSeen.get(o) ?? 0) + 1;
        octantSeen.set(o, k);
        // 1-10 use Chinese ordinals; beyond that, real numbers — labels must
        // stay ABSOLUTELY unique, never saturate at 第十 (round-2 #3).
        const ord = k <= CN_ORDINALS.length ? CN_ORDINALS[k - 1] : String(k);
        label = `${o}第${ord}未编组群`;
      }
    }
    options.push({
      label,
      memberIds: group.map((u) => u.id).sort((a, b) => a - b),
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
/**
 * 诚实闸 (v4 刀3, §8-3): drop candidates that cannot arrive before the line
 * breaks. `clock` is the EXCHANGE clock (facts.estimatedCollapseSeconds), so
 * "too late" is judged against a real mutual-fire estimate, not against the
 * one-sided countdown that used to make everything look too late.
 *
 * Offering a 68s march to a fight with 7s left is not a choice, it is noise
 * dressed as a choice — and if the commander approves it, the units leave
 * their posts for nothing.
 *
 * clock === null (stable, or we win the exchange) ⇒ no basis to call anything
 * late, so nothing is filtered. Unknown eta is never filtered either: an
 * absent number may not be read as a verdict.
 */
export function filterLateCandidates(
  result: ReinforceOptionsResult,
  clock: number | null,
): ReinforceOptionsResult {
  if (clock === null) return result;
  const options = result.options.filter((o) => o.etaSec === null || o.etaSec <= clock);
  if (options.length === result.options.length) return result;
  const shown = options.slice(0, DISPLAY_BUDGET);
  return { ...result, options, shown, omitted: options.length - shown.length };
}

export function buildFrontEscalationPayload(
  state: GameState,
  crisis: CrisisEvent,
  /** v4 刀2b: pass the candidate set that was ALREADY built for this tick so the
   *  payload and the escalation tickets cannot describe two different candidate
   *  sets. Additive and optional — every pre-existing caller is byte-identical.
   *  Production goes through buildFrontEscalationWithTickets, which always
   *  supplies it; omitting it just rebuilds (pure, same state → same result). */
  precomputed?: ReinforceOptionsResult,
): string {
  const facts = frontEscalationFacts(state, crisis);
  const front = facts ? state.fronts.find((f) => f.id === facts.frontId) ?? null : null;
  const place = facts?.frontName ?? crisis.locationTag;
  const stake = facts?.stake ?? "unknown";

  const optionsBlock = serializeOptions(
    filterLateCandidates(
      precomputed ?? buildReinforceOptions(state, front),
      facts?.estimatedCollapseSeconds ?? null,
    ),
  );

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
