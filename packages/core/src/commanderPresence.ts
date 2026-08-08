// ============================================================
// Commander Presence V1 — engine-side judgment material (pure)
//
// Step A: FRONT_JUDGMENT — per-front survival / power-ratio / best-help
// columns rendered side by side, so "which front first" questions are
// answered from engine numbers, never from LLM mental arithmetic.
//
// Constitution: candidates + costs, never conclusions. Every number here
// is read from the ONE existing production estimator for that quantity:
//   - survival    → assessCrisisEscalation (6a collapse math, untouched)
//   - ratio       → freshFrontPowerRatio (7a fog-gated DPS read, untouched)
//   - best_help   → buildReinforceOptions (V1b candidate set, untouched)
//   - 交战中/hp%  → groupTaskStatus / hpPctOf (V1b own-evidence reads)
// No re-implementation of any of them lives in this file.
// ============================================================

import type { GameState, CrisisEvent, Front, Unit, Position } from "@ai-commander/shared";
import { TILE_SIZE } from "@ai-commander/shared";
import { assessCrisisEscalation } from "./crisisResponse";
import { hasPlayerCombatPresence, freshFrontPowerRatio } from "./director";
import { buildReinforceOptions, filterLateCandidates, groupTaskStatus, hpPctOf, nearestPlaceWithin, NAME_RADIUS_TILES, TASK_IDLE } from "./frontEscalationPayload";
import { forceHandleTag } from "./escalationTicket";
import type { ReinforceOptionsResult } from "./frontEscalationPayload";

/**
 * What the row says when NO candidate can be recommended (A 刀 fix1, 手测 2026-08-02).
 *
 * The F1 lesson — "no candidates" must never read as "no friendlies" — was
 * encoded on the escalation face (serializeOptions) and NOT here. The honesty
 * gate then made the empty case common, and the row answered it with silence:
 * `1. 北部战线: survival≈3s ratio=0.33` and nothing else. Live hand-test: the
 * commander asked "有没有可支援部队", the staff answered "只有 Blake" while six
 * idle main tanks sat outside the front. A force that exists was hidden.
 *
 * So EXISTENCE and REACHABILITY are stated as two separate facts. A force that
 * cannot arrive in time is still the commander's to spend — counter-attack,
 * screen, retake — so this DISCLOSES it; it never re-recommends it (the label
 * only ever appears inside a none(...) clause, never as `best_help=<label>(`).
 *
 * Friendly-only reads (options + outsideFriendlyCount + our own clock), so the
 * disclosure cannot leak fog the way a hidden-enemy-derived number would.
 */
function describeNoHelp(
  all: ReinforceOptionsResult,
  clock: number | null,
  /** 刀2：号必须贴在**被点名的那支部队**后面，所以铸号发生在造句时，
   *  不再由调用方事后追加到行尾。不传=不铸号（纯度路径字节不变）。 */
  tagFor?: (o: ReinforceOptionsResult["options"][number]) => string,
): { text: string; named: ReinforceOptionsResult["options"][number] | null } {
  // ⑦ (v4 §8, 2026-08-04): 闲着 means IDLE, and this whole sentence — count AND
  // the force it names — may only speak about idle forces. Measured 2026-08-03:
  // the line announced 「线外2股/10units 闲着」 with four of those units carrying
  // task=交战中, troops already in contact offered to the commander as spare.
  //
  // fix (Fable ruling 2026-08-04): the "最近 X" half was first left measuring
  // ALL candidates, on the argument that "how late would help be" is answered
  // by the soonest arrival whoever it is. Measured consequence: a 交战中 group
  // got NAMED — and handle-minted — inside a sentence that opens with 「闲着」.
  // Same defect, moved from the count to the name. The sentence is about spare
  // capacity, so every part of it is about spare capacity; a slower honest
  // answer beats a faster one that offers troops already in a firefight.
  const idle = all.options.filter((o) => o.task === TASK_IDLE);
  const idleTimed = idle.filter((o) => o.etaSec !== null);
  if (idleTimed.length > 0) {
    // Gate emptied a non-empty set ⇒ every survivor had a finite eta above the
    // clock. Report the SOONEST one: "how late are we" is the actual question.
    const nearest = idleTimed.reduce((a, b) => ((b.etaSec ?? 0) < (a.etaSec ?? 0) ? b : a));
    const units = idle.reduce((s, o) => s + o.unitCount, 0);
    const vs = clock !== null ? ` > survival ${clock}s` : "";
    return {
      // `named` rides back out so the caller can mint a handle for it: the
      // commander who hears "有 6 辆闲着但赶不到" must be able to say "还是让他们
      // 去" and have it land (B 刀 — address ≠ endorsement).
      text: `线外${idle.length}股/${units}units 闲着，最近 ${nearest.label}${tagFor ? tagFor(nearest) : ""} eta≈${nearest.etaSec}s${vs}，都赶不到`,
      named: nearest,
    };
  }
  // Same two reachable truths, same wording as the escalation face (F1).
  return {
    text: all.outsideFriendlyCount > 0
      ? `front 外有${all.outsideFriendlyCount}个友军单位, 但当前无可单列的增援候选`
      : "战场上无其他友军",
    named: null,
  };
}

/**
 * Player COMBAT units inside a front's bboxes. Mirrors the predicate inside
 * director's hasPlayerCombatPresence (which returns only a boolean; director.ts
 * is outside this rung's allowed change set, so the 4-line filter is repeated
 * here). Drift between the two fails SAFE: a unit the boolean counts but this
 * filter misses only suppresses an engaged-note — it can never leak.
 */
function playerCombatUnitsInFront(state: GameState, front: Front): Unit[] {
  const bboxes: [number, number, number, number][] = [];
  for (const rid of front.regionIds) {
    const r = state.regions.get(rid);
    if (r) bboxes.push(r.bbox);
  }
  const members: Unit[] = [];
  if (bboxes.length === 0) return members;
  state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
    if (u.type === "commander" || u.attackDamage <= 0) return;
    const inFront = bboxes.some(
      ([x1, y1, x2, y2]) => u.position.x >= x1 && u.position.x <= x2 && u.position.y >= y1 && u.position.y <= y2,
    );
    if (inFront) members.push(u);
  });
  return members;
}

/**
 * Render the FRONT_JUDGMENT section. Three line kinds, all fog-honest:
 *
 *  - REAL line   — front has committed player combat force AND visible enemy
 *    DPS: survival≈/ratio=/best_help engine columns (gate ① kills the
 *    tCollapse=0 fake — the 7a Codex blocker; gate ② keeps hidden enemy DPS
 *    out of the survival estimate).
 *  - ENGAGED-UNKNOWN line — gate ① passes, gate ② fails, but OUR OWN units
 *    carry recent combat evidence (V1b isEngaged semantics via
 *    groupTaskStatus: the unit's own fired-at / took-damage timestamps —
 *    everything on the line is player-observable: own unit count, own hp%,
 *    own knowledge state, own-geometry best_help). Handtest 2026-07-25 round
 *    2: a front actively fighting under fog vanished from the frame — the
 *    MOST urgent front was the silent one. NOT rendered from
 *    engagementIntensity, which counts both teams and would leak enemy-only
 *    fights the player cannot see (battleAwareness.ts:235).
 *  - NO-FORCE note — gate ① fails: pure deployment fact (handtest round 1:
 *    the player was weighing a fallen front the frame silently omitted).
 *
 * Notes ride along only when at least one REAL or ENGAGED-UNKNOWN line
 * exists; a healthy battlefield (no visible enemies, no combat evidence)
 * keeps its byte-identical, section-free digest (Act-0 guard).
 */
/**
 * B 刀 (2026-08-02): mints an addressable handle for a force this frame is
 * about to NAME to the commander, and returns the number to print beside it.
 *
 * Passed IN rather than called directly because minting MUTATES (a monotonic
 * counter + a registry), and this builder is a pure function every bench,
 * heartbeat and digest rebuild runs. Only the real conversation path supplies a
 * minter; everyone else gets byte-identical rows and mints nothing.
 */
export type ForceHandleMinter = (
  front: Front,
  option: { label: string; memberIds: number[]; etaSec: number | null },
) => string | null;

export function buildFrontJudgmentLines(
  state: GameState,
  mintHandle?: ForceHandleMinter,
): string[] {
  const body: string[] = [];
  const engagedUnknown: string[] = [];
  const noForce: string[] = [];
  /** `[临时编队G13]` when a minter is supplied and the force has members.
   *  刀2：号紧跟部队名，不再是行尾独立 token——行的主语是战线，行尾的号会被
   *  绑给行首那个名字（9/131 实测）。印法唯一定义在 escalationTicket。 */
  const handleOf = (front: Front, option: { label: string; memberIds: number[]; etaSec: number | null } | undefined): string => {
    if (!mintHandle || !option) return "";
    const g = mintHandle(front, option);
    return g ? forceHandleTag(g) : "";
  };

  for (const front of state.fronts) {
    if (!hasPlayerCombatPresence(state, front)) {
      // In-row void clause (fix4 followup): a numberless row gives the header's
      // "superseded by these" nothing to substitute, and the consultation
      // digit mandate then pulls the model toward the ONLY number source left —
      // a stale escalation snapshot ("全灭" recited as "还能撑1秒"). Voiding
      // the old numbers in the row the model actually reads for this front
      // kills that source; the categorical fact becomes the only compliant
      // answer. Vacuously true when no snapshot ever mentioned this front.
      noForce.push(`${front.name}: 无我方作战部队（增援须从后方调兵；早先提问里引用的该线存活/战力数字已作废）`);
      continue;
    }
    const ratio = freshFrontPowerRatio(state, front);
    if (ratio === null) {
      // Gate ② (fog). If our own units are trading fire here, that fact is on
      // the player's screen — silence would misreport the hottest front as
      // uneventful. hp%/count are instantaneous OWN quantities (no casualty
      // bookkeeping to invent, no cumulative-number fabrication — 07-20 口径).
      const members = playerCombatUnitsInFront(state, front);
      if (members.length > 0 && groupTaskStatus(state, members, null) === "交战中") {
        // Same in-row void clause as the no-force note: this row has no
        // survival/ratio either, so stale ask-time numbers would win by
        // being the only ones on offer.
        let line = `${front.name}: 交战中，我方${members.length}units hp=${hpPctOf(members)}%，敌军实力未明（无法给出存活估计；早先提问里引用的该线存活/战力数字已作废）`;
        // 同一把尺 (A 刀 2026-08-02): EVERY face that renders a candidate goes
        // through the SAME honesty gate. Here the clock is null BY CONSTRUCTION,
        // and that is the point of routing through the gate at all:
        // ratio===null means we cannot see the enemy, while estimateCollapseTime
        // DOES count unseen enemies (crisisResponse.ts FOG-TODO). Feeding its
        // seconds in would let hidden enemy DPS shorten this list — the fog
        // would leak through the SHAPE of the candidate set, the same sneaky
        // channel gate ③ of commanderMood exists to close. So: null clock,
        // zero behaviour change today, and the call site is here so the gate
        // cannot be silently skipped if this row ever gains a clock.
        const all = filterLateCandidates(buildReinforceOptions(state, front), null);
        const top = all.shown[0];
        if (top) {
          const eta = top.etaSec !== null ? `eta≈${top.etaSec}s` : "eta=unknown";
          line += ` best_help=${top.label}${handleOf(front, top)}(${top.unitCount}units ${top.task} ${eta})`;
        } else {
          // F1 on this face too: no candidate ≠ no friendlies. Nothing was
          // filtered here (null clock), so this can only mean the candidate set
          // is genuinely empty — say which of the two truths it is.
          const nh = describeNoHelp(all, null, (o) => handleOf(front, o));
          line += ` best_help=none(${nh.text})`;
        }
        engagedUnknown.push(line);
      }
      continue;
    }

    const t = frontCollapseSeconds(state, front);
    const survival =
      t !== null && t !== Infinity ? `survival≈${Math.round(t)}s` : "survival=stable";

    let line = `${front.name}: ${survival} ratio=${ratio.toFixed(2)}`;

    // Top V1b candidate (无任务 first, then eta asc) — who could actually
    // steady this front and how long the engine says they need. eta=unknown
    // stays unknown; never a fabricated number.
    //
    // 同一把尺 (A 刀 2026-08-02): the row is filtered against the SAME clock it
    // prints one field earlier. Rounded exactly like the printed survival≈ and
    // like the escalation face's facts.estimatedCollapseSeconds, so promise and
    // filter cannot disagree by a fraction of a second. null (stable / we win
    // the exchange) ⇒ no basis to call anything late ⇒ nothing filtered.
    // Before this gate the board could recommend a 153s march to a fight with
    // 7s left while the escalation block in the SAME envelope said
    // "reinforcement_options: none".
    const clock = t !== null && Number.isFinite(t) ? Math.round(t) : null;
    const unfiltered = buildReinforceOptions(state, front);
    const top = filterLateCandidates(unfiltered, clock).shown[0];
    if (top) {
      const eta = top.etaSec !== null ? `eta≈${top.etaSec}s` : "eta=unknown";
      line += ` best_help=${top.label}${handleOf(front, top)}(${top.unitCount}units ${top.task} ${eta})`;
    } else {
      // fix1 (手测 2026-08-02): the gate's empty set must SPEAK, not vanish.
      // Silence here answered "有没有可支援部队" with "只有 Blake" while six
      // idle tanks stood outside the front. Disclose existence + why they are
      // not being recommended; the commander decides what to do with a force
      // that arrives late — and B 刀 gives that force a handle so the decision
      // can actually be executed.
      const nh = describeNoHelp(unfiltered, clock, (o) => handleOf(front, o));
      line += ` best_help=none(${nh.text})`;
    }

    body.push(line);
  }

  // Existence notes COMPLETE a comparison frame; with nothing real to compare
  // (no numeric line, no engaged front) the whole section stays omitted.
  if (body.length === 0 && engagedUnknown.length === 0) return [];
  return [
    // Header carries the precedence rule ON THE WIRE, right next to the fresh
    // numbers (handtest round-3 followup: Chen recited his own earlier
    // escalation question's ask-time numbers over this frame's current ones —
    // the stale source sits in the same envelope, so the correction must too).
    "---FRONT_JUDGMENT--- (CURRENT values for this reply — numbers quoted in earlier questions/escalations are ask-time snapshots, superseded by these; survival=committed HP vs visible enemy DPS, eta=straight-line terrain estimate; read these numbers — do NOT hand-compute distance/time from coordinates)" +
      // B 刀: the handle is an ADDRESS, not an endorsement — it is printed for
      // forces the row just declared too slow as well, because refusing to
      // recommend and refusing to let the commander reach them are different
      // things. Only stated when handles were actually minted this frame.
      (mintHandle
        ? " | 部队名后方括号里的[临时编队G#]是这支部队的临时番号，可直接作为 fromSquad 下令；它只是地址，不代表引擎推荐——赶不到的部队同样有号，长官坚持要派就照号派"
        : ""),
    ...body,
    ...engagedUnknown,
    ...noForce,
  ];
}

/**
 * The ONE route to the production collapse estimator — the same synthetic-crisis
 * pattern decisionReview uses to reach it through its exported entry point.
 * null = estimator unavailable for this front (never substitute a number).
 */
function frontCollapseSeconds(state: GameState, front: Front): number | null {
  const crisis: CrisisEvent = {
    type: "DOCTRINE_BREACH",
    severity: "critical",
    doctrineId: "__presence__",
    locationTag: front.id,
    message: `${front.name} 判读基线`,
    time: state.time,
  };
  const a = assessCrisisEscalation(state, crisis);
  // v4 刀3 SPEAKING FACE: the board row (survival≈Ns) and the mood line are
  // both read by the commander, so this wrapper carries the exchange clock.
  // null now covers "stable" AND "we win this exchange" — the caller already
  // renders null as survival=stable, so a won fight stops being reported as a
  // countdown. 对内触发用悲观钟，对人说话用互射钟。
  return a ? a.exchange.spokenSeconds : null;
}

// ============================================================
// Step B: commanderMood — battlefield temperature for the voice
//
// Same frame as FRONT_JUDGMENT, read for tone instead of columns. Three
// gates, IDENTICAL sources to the three line kinds above:
//   ① hasPlayerCombatPresence — the tCollapse=0 fake (7a Codex blocker)
//     must not raise the voice either.
//   ② engagement evidence = our OWN units' fired-at / took-damage
//     timestamps (groupTaskStatus). NEVER engagementIntensity — it counts
//     BOTH teams (battleAwareness), so a pure enemy-vs-enemy fight the
//     player cannot see would tighten the voice; a tone jump is a sneakier
//     leak than a number because the player can't ask where it came from.
//   ③ collapse seconds may drive the level and appear in the reason ONLY
//     where freshFrontPowerRatio is non-null (visible enemy DPS on the
//     line — estimateCollapseTime counts unseen enemies, FOG-TODO in
//     crisisResponse.ts). A fogged brawl is tense on own observable facts
//     alone and its reason carries no seconds.
// ============================================================

export type CommanderMoodLevel = "calm" | "tense" | "critical";

export interface CommanderMood {
  level: CommanderMoodLevel;
  /** One engine-fact line justifying the level — player-observable sources only. */
  reason: string;
}

/** critical = a front passes all three gates AND collapse is this close (≤, sec). */
const CRITICAL_COLLAPSE_SEC = 30;

export function commanderMood(state: GameState): CommanderMood {
  // Worst front wins: higher band first; inside a band, smaller collapse time.
  let best: { rank: number; t: number; reason: string } | null = null;
  const consider = (rank: number, t: number, reason: string) => {
    if (!best || rank > best.rank || (rank === best.rank && t < best.t)) {
      best = { rank, t, reason };
    }
  };

  for (const front of state.fronts) {
    if (!hasPlayerCombatPresence(state, front)) continue; // gate ①
    const members = playerCombatUnitsInFront(state, front);
    if (members.length === 0 || groupTaskStatus(state, members, null) !== "交战中") continue; // gate ②

    const ratio = freshFrontPowerRatio(state, front);
    if (ratio === null) {
      // Gate ③ fog branch: own facts only, no seconds.
      consider(1, Infinity, `${front.name}交战中，敌军实力未明`);
      continue;
    }
    const t = frontCollapseSeconds(state, front);
    if (t !== null && t <= CRITICAL_COLLAPSE_SEC) {
      consider(2, t, `${front.name}约${Math.max(1, Math.round(t))}秒内承压加剧`);
    } else {
      // Engaged with a visible enemy but no imminent collapse: tense on the
      // fight itself; the ratio is the fog-gated fact that sizes it.
      consider(1, t ?? Infinity, `${front.name}交战中，战力比${ratio.toFixed(2)}`);
    }
  }

  if (best === null) return { level: "calm", reason: "我方部队无接战" };
  const b: { rank: number; t: number; reason: string } = best;
  return { level: b.rank === 2 ? "critical" : "tense", reason: b.reason };
}

/**
 * Envelope line for both digest routes. calm renders NOTHING — a battlefield
 * with no engaged player force keeps its byte-identical pre-presence envelope
 * (same Act-0 guard as FRONT_JUDGMENT); the prompts read the line's absence
 * as the calm register.
 */
export function buildCommanderMoodLine(state: GameState): string | null {
  const mood = commanderMood(state);
  if (mood.level === "calm") return null;
  return `mood: ${mood.level}（${mood.reason}）`;
}

// ============================================================
// Step C: PLAYER_VIEW — shared eyes. The staff learns where the player's
// camera points so spatial deixis ("这边/那儿") can resolve. The camera is a
// CLUE, never a topic: the section header carries that rule on the wire
// (Step A fix4 precedent — the correction rides next to the data it governs).
//
// Layering: GameCanvas exposes RAW viewport geometry (camera px + canvas px)
// and nothing else; every conversion and spatial query lives here, pure and
// bench-testable. ReportEvents have no position and drain every tick, so the
// view summary scans LIVE units (position always present) — never reports.
// ============================================================

/** Raw geometry as the render layer holds it: camera top-left in PIXELS
 *  (tile × TILE_SIZE), zoom 0.5–2.0, canvas size in device pixels. */
export interface ViewportGeometry {
  x: number;
  y: number;
  zoom: number;
  canvasWidth: number;
  canvasHeight: number;
}

/** Tile-space box, fractional edges, inclusive membership. */
export interface TileBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Pixel viewport → tile box. The formula is the renderer's own visible-range
 * computation (rendererCanvas renderTerrain): screen width divided by zoom is
 * the visible pixel span, divided by TILE_SIZE is tiles. Getting this wrong
 * doesn't crash — it renders as "nothing in view" or "everything in view" —
 * so the bench pins both ends.
 */
export function viewportToTileBox(view: ViewportGeometry): TileBox {
  return {
    left: view.x / TILE_SIZE,
    top: view.y / TILE_SIZE,
    right: (view.x + view.canvasWidth / view.zoom) / TILE_SIZE,
    bottom: (view.y + view.canvasHeight / view.zoom) / TILE_SIZE,
  };
}

/** Alive units inside the box, edges inclusive (same convention as the front
 *  bbox filters). Both teams — callers apply their own visibility rules. */
export function unitsInBox(state: GameState, box: TileBox): Unit[] {
  const out: Unit[] = [];
  state.units.forEach((u) => {
    if (u.hp <= 0 || u.state === "dead") return;
    if (
      u.position.x >= box.left && u.position.x <= box.right &&
      u.position.y >= box.top && u.position.y <= box.bottom
    ) out.push(u);
  });
  return out;
}

/**
 * Speakable name for a point — now an ALIAS of `nearestPlaceWithin`.
 *
 * 第 8 级 刀4：这里曾经是"这点叫什么"的第二份实现（标记优先，然后委托给共享
 * 解析器）。Step C 当时不许改 nearestPlaceWithin 本体，那是当级的爆炸半径管控，
 * 代价是两份定义并存——一份认标记（只服务 PLAYER_VIEW），一份不认（服务候选
 * label / SQUADS loc= / preflight 来源地）。同一个点在长官耳朵里有两个名字。
 *
 * 本刀把标记扫描搬进 nearestPlaceWithin 本体，两份合成一份，这里只留别名：
 * Step C 的调用面一个字不用改，而全部消费面同时获得标记命名。
 * export 保留——它是 core/index.ts 的公开面。
 */
export function placeNameAt(state: GameState, p: Position): string | null {
  return nearestPlaceWithin(state, p);
}

function typeBreakdown(units: Unit[]): string {
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  return Array.from(counts.entries()).map(([t, n]) => `${n}×${t}`).join(",");
}

/**
 * Render the PLAYER_VIEW section (≤5 lines, omission over fabrication):
 *  - 镜头对准: place name at the viewport CENTER (unresolvable → line omitted).
 *    The label is deliberately "镜头对准" and never "你正看着" — the second
 *    phrasing would let the camera impersonate the topic.
 *  - 选中单位: from the ids the caller passes. DigestV1 routes already carry
 *    ---PLAYER_SELECTED--- (the pipe Step C waters), so callers pass [] there
 *    and real ids only where the route has no such section (BattleContextV2).
 *  - friendly / visible-enemy summaries from the live-unit scan. Enemies only
 *    count on fog-visible tiles — a hidden force must not leak through a
 *    view summary any more than through a mood line.
 * No content lines → empty array (no lone header — Act-0 guard).
 */
export function buildPlayerViewLines(
  state: GameState,
  view: ViewportGeometry,
  selectedUnitIds: number[],
): string[] {
  const box = viewportToTileBox(view);
  const body: string[] = [];

  const center: Position = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const place = placeNameAt(state, center);
  if (place !== null) body.push(`镜头对准: ${place}`);

  const selected: Unit[] = [];
  for (const id of selectedUnitIds) {
    const u = state.units.get(id);
    if (u && u.hp > 0 && u.state !== "dead") selected.push(u);
  }
  if (selected.length > 0) {
    const shown = selected.slice(0, 8).map((u) => `#${u.id}(${u.type})`).join(" ");
    const rest = selected.length > 8 ? ` …+${selected.length - 8}` : "";
    body.push(`选中单位: ${shown}${rest}`);
  }

  const inView = unitsInBox(state, box);
  const friendly = inView.filter((u) => u.team === "player");
  const visibleEnemy = inView.filter((u) => {
    if (u.team !== "enemy") return false;
    const tx = Math.floor(u.position.x);
    const ty = Math.floor(u.position.y);
    return state.fog[ty]?.[tx] === "visible";
  });
  if (friendly.length > 0) body.push(`视口内我方: ${friendly.length}units(${typeBreakdown(friendly)})`);
  if (visibleEnemy.length > 0) body.push(`视口内可见敌军: ${visibleEnemy.length}units(${typeBreakdown(visibleEnemy)})`);

  if (body.length === 0) return [];
  return [
    "---PLAYER_VIEW--- (镜头是线索不是话题：默认由对话定话题，镜头只用来消解\"这边/那儿\"这类空间指代；拿不准指哪就先问一句)",
    ...body,
  ];
}
