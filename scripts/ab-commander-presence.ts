// ============================================================
// AI Commander — Commander Presence bench (presence-v1)
//
// Step A: FRONT_JUDGMENT engine section + judgment-license real-model probes.
// Step B: commanderMood three-band thresholds (per-gate negatives) + the
//         calm-vs-critical register probe (human-read, logged).
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server)
//   --real       real-model fixtures via the worktree server
//                (COMMAND_URL=http://localhost:3002/api/command)
//
// Both modes read the ONE production builder (buildFrontJudgmentLines) —
// never a re-implementation (V1b precedent).
//
// Run (from the worktree root):
//   ./node_modules/.bin/tsx scripts/ab-commander-presence.ts --synthetic
// ============================================================

import {
  createInitialGameState,
  buildDigest,
  buildBattleContextV2,
  buildBattleBoard,
} from "@ai-commander/core";
import { generateDigestV1 } from "@ai-commander/shared";
import { boardToDigestLines } from "../packages/core/src/battleBoard";
import { buildFrontJudgmentLines, commanderMood, buildCommanderMoodLine } from "../packages/core/src/commanderPresence";
import { buildReinforceOptions } from "../packages/core/src/frontEscalationPayload";
import type { GameState, Unit, Squad } from "@ai-commander/shared";

// ── Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

/** Fresh el_alamein state with all units/squads removed (fronts/regions/facilities kept). */
function emptyBattlefield(): GameState {
  const state = createInitialGameState("el_alamein");
  state.units.clear();
  state.squads = [];
  state.missions = [];
  return state;
}

let templateUnit: Unit | null = null;
function unitTemplate(): Unit {
  if (!templateUnit) {
    const s = createInitialGameState("el_alamein");
    let found: Unit | null = null;
    s.units.forEach((u) => {
      if (!found && u.team === "player" && u.type === "infantry") found = u;
    });
    if (!found) throw new Error("no player infantry in el_alamein opening");
    templateUnit = found;
  }
  return templateUnit;
}

let nextId = 9000;
function addUnit(state: GameState, x: number, y: number, over: Partial<Unit> = {}): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate()),
    id: nextId++,
    position: { x, y },
    state: "idle",
    orders: [],
    waypoints: [],
    patrolPoints: [],
    patrolTaskId: null,
    lastAttackTime: 0,
    manualOverride: false,
    target: null,
    attackTarget: null,
    ...over,
  };
  state.units.set(u.id, u);
  return u;
}

function addSquad(state: GameState, ids: number[], over: Partial<Squad> = {}): Squad {
  const sq: Squad = {
    id: over.id ?? `B${nextId++}`,
    name: "bench squad",
    unitIds: ids,
    leader: { name: "Bench", rank: "sergeant" as Squad["leader"]["rank"], personality: "balanced" },
    currentMission: null,
    missionTarget: null,
    morale: 1,
    formationStyle: "line",
    ownerCommander: "chen",
    leaderName: "Bench",
    role: "leader",
    ...over,
  };
  state.squads.push(sq);
  return sq;
}

/** Mark a tile (and unit tiles) visible so the fog gate reads the enemy as seen. */
function reveal(state: GameState, x: number, y: number): void {
  const ty = Math.floor(y);
  const tx = Math.floor(x);
  if (state.fog[ty]) state.fog[ty][tx] = "visible";
}

// Fixture geometry (el_alamein): points chosen inside exactly ONE front's bbox.
// front_coastal ("1. 北部战线") — northern_coastal bbox [200,22,490,55] (y<45 avoids
// the kidney_ridge overlap band); front_ridge ("2. 山脊战线") — kidney_ridge_zone
// bbox [200,45,260,75] (y>55 avoids the coastal band).
const COASTAL = { x: 300, y: 30 };
const RIDGE = { x: 220, y: 65 };

/** Two-front crisis: committed forces + visible enemies on both, one idle squad far south. */
function twoFrontCrisis(): GameState {
  const s = emptyBattlefield();
  s.time = 120;

  // Committed defenders (in squads, engaged-ish positions)
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 40 });
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 40 });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  const r1 = addUnit(s, RIDGE.x, RIDGE.y, { hp: 60 });
  const r2 = addUnit(s, RIDGE.x + 2, RIDGE.y, { hp: 60 });
  addSquad(s, [r1.id, r2.id], { id: "I2", leaderName: "Carter" });

  // Visible enemies — coastal outnumbered hard, ridge roughly even
  for (let i = 0; i < 6; i++) {
    const e = addUnit(s, COASTAL.x + 4 + i, COASTAL.y + 2, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  for (let i = 0; i < 2; i++) {
    const e = addUnit(s, RIDGE.x + 4 + i, RIDGE.y + 2, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }

  // One free reinforcement squad outside both crisis fronts. y=150 keeps Blake
  // strictly in southern_desert — y=140 sits ON the central_desert bbox edge
  // ([120,80,370,140] is inclusive) and would give the central front a combat
  // presence, hiding its no-force note.
  const f1 = addUnit(s, 300, 150);
  const f2 = addUnit(s, 302, 150);
  addSquad(s, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });

  return s;
}

/** Asymmetric crisis: coastal manned + visible enemies; central EMPTY (fallen);
 *  ridge unmanned too; Blake free in the south. The handtest shape: the player
 *  weighs a front the old frame silently omitted. */
function northCrisisCenterEmpty(): GameState {
  const s = emptyBattlefield();
  s.time = 150;
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 40 });
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 40 });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  for (let i = 0; i < 5; i++) {
    const e = addUnit(s, COASTAL.x + 4 + i, COASTAL.y + 2, { team: "enemy" } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  const f1 = addUnit(s, 300, 150);
  const f2 = addUnit(s, 302, 150);
  addSquad(s, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });
  return s;
}

/** Fogged brawl: coastal units carry OWN recent combat evidence (fired /
 *  took damage inside the 10s isEngaged window); enemies exist but are NEVER
 *  revealed — gate ② fails while the fight is on the player's screen. */
function foggedBrawl(opts: { staleEvidence?: boolean } = {}): GameState {
  const s = emptyBattlefield();
  s.time = 200;
  const t = opts.staleEvidence ? 100 : 197; // stale = far outside the window
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 30, lastDamagedAt: t } as Partial<Unit>);
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 50, lastAttackTime: t + 1 });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  for (let i = 0; i < 5; i++) {
    addUnit(s, COASTAL.x + 5 + i, COASTAL.y + 2, { team: "enemy" } as Partial<Unit>); // fog NOT revealed
  }
  const f1 = addUnit(s, 300, 150);
  const f2 = addUnit(s, 302, 150);
  addSquad(s, [f1.id, f2.id], { id: "T5", leaderName: "Blake" });
  return s;
}

/** twoFrontCrisis with OWN combat evidence stamped on both crisis fronts'
 *  defenders (Blake's southern reserve untouched) — the mood gates (①presence
 *  ②own-evidence engagement ③visible ratio) all pass. Coastal collapse ≈
 *  80HP / 24DPS ≈ 3s, ridge ≈ 120HP / 8DPS = 15s → both critical band,
 *  coastal tightest. */
function crisisEngaged(): GameState {
  const s = twoFrontCrisis();
  s.units.forEach((u) => {
    if (u.team === "player" && u.position.y < 100) {
      u.lastDamagedAt = s.time - 2; // inside the 10s isEngaged window
    }
  });
  return s;
}

/** Single-front boundary state: pooled defender HP vs ONE visible enemy
 *  infantry (DPS = 6/1.5 = 4) places collapse exactly at / just past the
 *  critical threshold: [40,40,40] → 120/4 = 30s; [40,40,48] → 128/4 = 32s. */
function boundaryMood(defenderHp: number[]): GameState {
  const s = emptyBattlefield();
  s.time = 300;
  const ids: number[] = [];
  defenderHp.forEach((hp, i) => {
    const u = addUnit(s, COASTAL.x + i, COASTAL.y, { hp, lastDamagedAt: s.time - 2 } as Partial<Unit>);
    ids.push(u.id);
  });
  addSquad(s, ids, { id: "I1", leaderName: "Aiden" });
  const e = addUnit(s, COASTAL.x + 8, COASTAL.y, { team: "enemy" } as Partial<Unit>);
  reveal(s, e.position.x, e.position.y);
  return s;
}

/** Enemy units brawling on a front with NO player force, the front's
 *  both-teams engagementIntensity forced high — a canary: if commanderMood
 *  ever consulted that metric, this state would read tense. */
function enemyOnlyFight(): GameState {
  const s = emptyBattlefield();
  s.time = 300;
  for (let i = 0; i < 6; i++) {
    const e = addUnit(s, COASTAL.x + i, COASTAL.y, { team: "enemy", lastDamagedAt: s.time - 1 } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }
  const front = s.fronts.find((f) => f.id === "front_coastal")!;
  front.engagementIntensity = 9.9;
  const p = addUnit(s, 300, 150); // far-south player unit keeps the state non-degenerate
  addSquad(s, [p.id], { id: "T5", leaderName: "Blake" });
  return s;
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== commander-presence Step A synthetic assertions ==");

  // A) Two-front crisis → one judgment line per pressured front, with survival,
  //    ratio, and a best_help drawn from the ONE V1b candidate builder.
  {
    const s = twoFrontCrisis();
    const lines = buildFrontJudgmentLines(s);
    check("A1 header present once", lines.filter((l) => l.startsWith("---FRONT_JUDGMENT---")).length === 1, lines.join(" | "));
    const coastal = lines.find((l) => l.startsWith("1. 北部战线:"));
    const ridge = lines.find((l) => l.startsWith("2. 山脊战线:"));
    check("A2 coastal line rendered", coastal !== undefined, lines.join(" | "));
    check("A3 ridge line rendered", ridge !== undefined, lines.join(" | "));
    // header + 2 real lines + 2 no-force notes (central fallen, axis rear);
    // southern front (Blake, no visible enemy) stays fog-silent entirely.
    check("A4 exactly 2 real + 2 no-force lines", lines.length === 5, `got ${lines.length}: ${lines.join(" | ")}`);
    check(
      "A5 survival+ratio tokens on both",
      [coastal, ridge].every((l) => !!l && /survival[≈=]/.test(l) && /ratio=\d/.test(l)),
      `${coastal} || ${ridge}`,
    );
    check("A6 no null/NaN leakage", lines.every((l) => !l.includes("null") && !l.includes("NaN") && !l.includes("Infinity")));

    // best_help must be the top shown V1b candidate for that front — same
    // builder, same sort; never a re-ranked or invented name.
    const coastalFront = s.fronts.find((f) => f.id === "front_coastal")!;
    const top = buildReinforceOptions(s, coastalFront).shown[0];
    check(
      "A7 best_help = V1b top candidate",
      !!top && !!coastal && coastal.includes(`best_help=${top.label}(`),
      `top=${top?.label} line=${coastal}`,
    );
    check("A8 eta token engine-sourced", !!coastal && (/eta≈\d+s/.test(coastal) || coastal.includes("eta=unknown")), coastal);

    // No-force notes (handtest fix): fallen/undeployed fronts appear as pure
    // existence facts — completing the compare frame with ZERO enemy-derived
    // data — and only ride along when at least one real judgment line exists.
    const center = lines.find((l) => l.startsWith("3. 中央战线:"));
    const rear = lines.find((l) => l.startsWith("5. 敌军后方:"));
    const south = lines.find((l) => l.startsWith("4. 南部战线:"));
    check("A9 central no-force note", center === "3. 中央战线: 无我方作战部队（增援须从后方调兵；早先提问里引用的该线存活/战力数字已作废）", center);
    check("A10 axis-rear no-force note", rear !== undefined, lines.join(" | "));
    check(
      "A11 no-force notes carry no engine combat data",
      [center, rear].every((l) => !!l && !/survival|ratio=|eta|best_help/.test(l)),
      `${center} || ${rear}`,
    );
    check("A12 fog-gated south stays silent", south === undefined, south);
  }

  // B) Presence gate: enemies visible on a front with NO committed player force
  //    → no line for it (the tCollapse=0 fake must never render).
  {
    const s = emptyBattlefield();
    s.time = 120;
    for (let i = 0; i < 4; i++) {
      const e = addUnit(s, COASTAL.x + i, COASTAL.y, { team: "enemy" } as Partial<Unit>);
      reveal(s, e.position.x, e.position.y);
    }
    // player presence only on ridge
    const r = addUnit(s, RIDGE.x, RIDGE.y);
    addSquad(s, [r.id], { id: "I2", leaderName: "Carter" });
    const e2 = addUnit(s, RIDGE.x + 3, RIDGE.y, { team: "enemy" } as Partial<Unit>);
    reveal(s, e2.position.x, e2.position.y);

    const lines = buildFrontJudgmentLines(s);
    const coastalLine = lines.find((l) => l.startsWith("1. 北部战线:"));
    check(
      "B1 empty-front fake killed (no-force note, zero combat data)",
      coastalLine !== undefined && coastalLine.includes("无我方作战部队") && !/survival|ratio=|eta/.test(coastalLine),
      coastalLine ?? lines.join(" | "),
    );
    check("B2 manned front still renders", lines.some((l) => l.startsWith("2. 山脊战线:") && /survival[≈=]/.test(l)), lines.join(" | "));
  }

  // C) Fog gate: enemy present but NOT visible → nothing to judge → no line.
  {
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    addUnit(s, COASTAL.x + 5, COASTAL.y, { team: "enemy" } as Partial<Unit>); // fog NOT revealed
    const lines = buildFrontJudgmentLines(s);
    check("C1 invisible enemy → no section", lines.length === 0, lines.join(" | "));
  }

  // D) Healthy battlefield (players only, no visible enemy) → section omitted.
  {
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    check("D1 healthy → no section", buildFrontJudgmentLines(s).length === 0);
  }

  // I) Engaged-unknown line (handtest round-2 fix): a front where OUR units
  //    are trading fire under fog must never vanish from the frame. Evidence
  //    source is the units' OWN timestamps (V1b isEngaged), never
  //    engagementIntensity (counts both teams → would leak unseen fights).
  {
    const s = foggedBrawl();
    const lines = buildFrontJudgmentLines(s);
    const coastal = lines.find((l) => l.startsWith("1. 北部战线:"));
    check(
      "I1 fogged brawl renders engaged-unknown line",
      !!coastal && coastal.includes("交战中") && coastal.includes("敌军实力未明"),
      lines.join(" | "),
    );
    check(
      "I2 own-strength tokens only (count + hp%)",
      !!coastal && /我方2units hp=\d+%/.test(coastal) && !/survival[≈=]|ratio=/.test(coastal),
      coastal,
    );
    check("I3 best_help rides (own geometry, zero enemy data)", !!coastal && /best_help=.*eta≈\d+s/.test(coastal), coastal);
    check(
      "I4 counts as body: no-force notes ride along",
      lines.some((l) => l.includes("无我方作战部队")),
      lines.join(" | "),
    );
    check(
      "I5 hidden enemy count (5) leaks nowhere",
      lines.every((l) => !l.includes("5units") && !l.includes("5×")),
      lines.join(" | "),
    );
  }

  // I6) Same front, evidence outside the 10s window → no line, and with no
  //     real/engaged line anywhere the section stays omitted entirely.
  {
    const s = foggedBrawl({ staleEvidence: true });
    check("I6 stale evidence → section omitted", buildFrontJudgmentLines(s).length === 0);
  }

  // M) Step B — commanderMood: three-band thresholds + one negative per gate.
  //    Same three gates as the judgment line kinds; the voice may never move
  //    on evidence the player can't see.
  {
    // No engagement anywhere (healthy field, collapse=Infinity on every front)
    // → calm, and calm renders NO envelope line (Act-0 guard).
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    const m = commanderMood(s);
    check("M1 no combat → calm", m.level === "calm", `${m.level}（${m.reason}）`);
    check("M2 calm renders no envelope line", buildCommanderMoodLine(s) === null);
  }
  {
    // Gate ① negative + engagementIntensity ban canary: an enemy-only brawl
    // with the both-teams metric forced high must not raise the voice.
    const m = commanderMood(enemyOnlyFight());
    check("M3 enemy-only fight (engagementIntensity=9.9) → calm", m.level === "calm", `${m.level}（${m.reason}）`);
  }
  {
    // Gate ② negatives: visible enemies massing against committed defenders
    // but no own fired-at/took-damage evidence — content may alarm (the
    // judgment section still renders), tone must not move until contact.
    const m = commanderMood(twoFrontCrisis());
    check("M4 massing without contact → calm", m.level === "calm", `${m.level}（${m.reason}）`);
    const m2 = commanderMood(foggedBrawl({ staleEvidence: true }));
    check("M5 stale own evidence → calm", m2.level === "calm", `${m2.level}（${m2.reason}）`);
  }
  {
    // Gate ③ fog branch: engaged under fog is tense on own facts alone; the
    // reason carries no collapse seconds (estimateCollapseTime counts unseen
    // enemies) and no ratio; the hidden enemy count leaks nowhere.
    const m = commanderMood(foggedBrawl());
    check("M6 fogged brawl → tense", m.level === "tense", `${m.level}（${m.reason}）`);
    check(
      "M7 fog reason: own facts, no seconds/ratio",
      m.reason.includes("交战中") && m.reason.includes("未明") && !m.reason.includes("秒") && !m.reason.includes("战力比"),
      m.reason,
    );
    check("M8 hidden enemy count leaks nowhere", !m.reason.includes("5"), m.reason);
  }
  {
    // Visible-branch banding at the named threshold (CRITICAL_COLLAPSE_SEC=30,
    // inclusive): 120HP/4DPS = 30s → critical with seconds; 128HP = 32s →
    // tense, seconds withheld, the fog-gated ratio speaks instead.
    const mCrit = commanderMood(boundaryMood([40, 40, 40]));
    check("M9 t=30s boundary → critical", mCrit.level === "critical", `${mCrit.level}（${mCrit.reason}）`);
    check("M10 critical reason: front + ~seconds", mCrit.reason.includes("北部战线") && /约30秒内/.test(mCrit.reason), mCrit.reason);
    const mTense = commanderMood(boundaryMood([40, 40, 48]));
    check(
      "M11 t=32s → tense w/ ratio, no seconds",
      mTense.level === "tense" && mTense.reason.includes("战力比3.00") && !mTense.reason.includes("秒"),
      `${mTense.level}（${mTense.reason}）`,
    );
  }
  {
    // Worst front wins (coastal 3s beats ridge 15s inside the critical band);
    // envelope tail rides BOTH routes; healthy renders stay mood-free.
    const s = crisisEngaged();
    const m = commanderMood(s);
    check("M12 two engaged fronts → critical band", m.level === "critical", `${m.level}（${m.reason}）`);
    check("M13 reason names the tightest front", m.reason.includes("北部战线") && /约\d+秒内/.test(m.reason), m.reason);
    const moodLine = buildCommanderMoodLine(s);
    check("M14 mood line format", moodLine !== null && /^mood: critical（.+）$/.test(moodLine), moodLine ?? "null");
    const d = buildDigest(s, [], [], []);
    check("M15 DigestV1 ends with mood line", moodLine !== null && d.endsWith(`${moodLine}\n`));
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    check("M16 V2 ends with mood line after judgment", moodLine !== null && ctx.endsWith(moodLine) && ctx.includes("---FRONT_JUDGMENT---"));
    const h = emptyBattlefield();
    h.time = 120;
    const hp = addUnit(h, COASTAL.x, COASTAL.y);
    addSquad(h, [hp.id], { id: "I1", leaderName: "Aiden" });
    check(
      "M17 healthy digests carry no mood line",
      !buildDigest(h, [], [], []).includes("mood:") &&
        !buildBattleContextV2(h, "ops", { playerIntent: "", openCommitments: [] }).includes("mood:"),
    );
  }

  // E) DigestV1 append-only contract: the digest WITHOUT judgment lines is a
  //    byte-exact prefix; the tail is exactly the builder's lines.
  {
    const s = twoFrontCrisis();
    const newDigest = buildDigest(s, [], [], []); // mutates front power, then renders
    const board = boardToDigestLines(buildBattleBoard(s));
    const oldDigest = generateDigestV1(s, [], [], [], board); // same state, no judgment
    const judgment = buildFrontJudgmentLines(s);
    const expectedTail = judgment.map((l) => `${l}\n`).join("");
    check("E1 DigestV1 byte-prefix", newDigest.startsWith(oldDigest), "legacy digest is not a prefix");
    check("E2 DigestV1 tail = judgment lines exactly", newDigest === oldDigest + expectedTail);
  }

  // E3) Same append-only contract on the engaged-unknown path. Step B: this
  //     fixture is engaged → the tense mood line rides the tail after the
  //     judgment section (twoFrontCrisis in E2 stays calm — no line, no drift).
  {
    const s = foggedBrawl();
    const newDigest = buildDigest(s, [], [], []);
    const board = boardToDigestLines(buildBattleBoard(s));
    const oldDigest = generateDigestV1(s, [], [], [], board);
    const judgment = buildFrontJudgmentLines(s);
    const mood = buildCommanderMoodLine(s);
    const expectedTail = [...judgment, ...(mood ? [mood] : [])].map((l) => `${l}\n`).join("");
    check("E3 engaged-unknown digest byte-prefix + exact tail (judgment + mood)", newDigest === oldDigest + expectedTail);
    check("E4 fog mood line is tense", mood !== null && mood.startsWith("mood: tense（"), mood ?? "null");
  }

  // F) BattleContextV2 append-only contract: judgment block sits at the very
  //    end, after FORCES, and is exactly the same ONE builder's output.
  {
    const s = twoFrontCrisis();
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    const judgment = buildFrontJudgmentLines(s);
    check("F1 V2 ends with judgment block", judgment.length > 0 && ctx.endsWith(judgment.join("\n")));
    const before = ctx.slice(0, ctx.length - judgment.join("\n").length);
    check("F2 V2 judgment after FORCES", before.includes("---FORCES---") && !before.includes("---FRONT_JUDGMENT---"));
  }

  // G) Healthy V2/V1 renders carry no judgment section at all (no empty header).
  {
    const s = emptyBattlefield();
    s.time = 120;
    const p = addUnit(s, COASTAL.x, COASTAL.y);
    addSquad(s, [p.id], { id: "I1", leaderName: "Aiden" });
    const d = buildDigest(s, [], [], []);
    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    check("G1 healthy DigestV1 clean", !d.includes("FRONT_JUDGMENT"));
    check("G2 healthy V2 clean", !ctx.includes("FRONT_JUDGMENT"));
  }

  // H) el_alamein opening state (production start): whatever renders must obey
  //    the gates — every body line names a real front with committed presence.
  {
    const s = createInitialGameState("el_alamein");
    const lines = buildFrontJudgmentLines(s);
    const frontNames = new Set(s.fronts.map((f) => f.name));
    const bodyOk = lines
      .filter((l) => !l.startsWith("---"))
      .every((l) => frontNames.has(l.slice(0, l.indexOf(":"))));
    check("H1 opening lines name real fronts only", bodyOk, lines.join(" | "));
    console.log(`   (opening state renders ${Math.max(0, lines.length - 1)} judgment line(s))`);
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── --real (real model via worktree server; COMMAND_URL points at :3002) ──

interface AdvisorRespLite {
  brief?: string;
  responseType?: string;
  options?: unknown[];
}
interface GroupRespLite {
  responses?: Array<{ from: string; brief: string }>;
  data?: AdvisorRespLite;
}

const PUNT_MARKERS = ["看您", "由您定", "您来定", "请您决断", "您定夺", "听您的", "请指示"];

// Concrete unit handles in the crisis fixtures (either script — the model
// voices "Carter" and "卡特" interchangeably).
const UNIT_NAMES = ["Blake", "Carter", "Aiden", "T5", "I2", "I1", "布雷克", "卡特", "艾登"];

function isPunt(text: string): boolean {
  return PUNT_MARKERS.some((m) => text.includes(m));
}
/** First two sentences — the delivery window for the asked-for unknown.
 *  ("长官，北线撑不过三秒。卡特最近，65秒能到。" delivers the who in sentence
 *  two behind a natural situational lead-in; buried-at-the-end doesn't count.) */
function deliveryWindow(text: string): string {
  return text.split(/[。！？!?\n]/).slice(0, 2).join("。");
}
function namesAUnit(text: string): boolean {
  return UNIT_NAMES.some((n) => text.includes(n));
}
function hasDigit(text: string): boolean {
  // Engine numbers may be voiced in Chinese numerals ("约三秒"/"六十五秒") —
  // both count as citing a number.
  return /[0-9〇零一二三四五六七八九十百千]/.test(text);
}
function namesAFront(text: string): boolean {
  return text.includes("北") || text.includes("山脊") || text.includes("沿海") || text.includes("中央");
}

async function runReal(): Promise<void> {
  const cmdUrl = process.env.COMMAND_URL ?? "http://localhost:3002/api/command";
  const groupUrl = cmdUrl.replace("/api/command", "/api/command-group");
  console.log(`== commander-presence Step A real-model fixtures (${cmdUrl}) ==`);

  const crisis = twoFrontCrisis();
  const crisisDigestV1 = buildDigest(crisis, [], [], []);
  const crisisCtxV2 = buildBattleContextV2(crisis, "ops", { playerIntent: "", openCommitments: [] });

  const healthy = emptyBattlefield();
  healthy.time = 120;
  const hp1 = addUnit(healthy, COASTAL.x, COASTAL.y);
  addSquad(healthy, [hp1.id], { id: "I1", leaderName: "Aiden" });
  const healthyDigestV1 = buildDigest(healthy, [], [], []);

  const QUESTION = "北线和山脊线都吃紧，先救哪条？";
  const style = "risk=0.50 focus=0.50 obj=0.50 cas=0.50";

  const ask = async (digest: string, message: string, channel: string): Promise<AdvisorRespLite> => {
    const res = await fetch(cmdUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, message, styleNote: style, channel, sessionId: "ab-presence" }),
    });
    return (await res.json()) as AdvisorRespLite;
  };
  const askGroup = async (digest: string, message: string): Promise<GroupRespLite> => {
    const res = await fetch(groupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, message, styleNote: style, sessionId: "ab-presence" }),
    });
    return (await res.json()) as GroupRespLite;
  };

  // 1) Chen (combat, DigestV1): must take a side with numbers, no punting, no intents.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisDigestV1, QUESTION, "combat");
    const brief = r.brief ?? "";
    const noExec = (r.options ?? []).length === 0;
    check(
      `R1.${i} chen picks a side w/ numbers`,
      noExec && hasDigit(brief) && namesAFront(brief) && !isPunt(brief),
      brief.slice(0, 160),
    );
    console.log(`   [chen #${i}] ${brief}`);
  }

  // 2) Marcus (ops, BattleContextV2): same contract.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisCtxV2, QUESTION, "ops");
    const brief = r.brief ?? "";
    const noExec = (r.options ?? []).length === 0;
    check(
      `R2.${i} marcus picks a side w/ numbers`,
      noExec && hasDigit(brief) && namesAFront(brief) && !isPunt(brief),
      brief.slice(0, 160),
    );
    console.log(`   [marcus #${i}] ${brief}`);
  }

  // 3) Healthy battlefield, same question: honest non-alarm (no exec, logged for
  //    the human read; hard assert = no intents, no punting).
  for (let i = 1; i <= 2; i++) {
    const r = await ask(healthyDigestV1, QUESTION, "combat");
    const brief = r.brief ?? "";
    check(`R3.${i} healthy → no exec, no punt`, (r.options ?? []).length === 0 && !isPunt(brief), brief.slice(0, 160));
    console.log(`   [healthy #${i}] ${brief}`);
  }

  // 4) Group war room: domain officer answers with numbers; banding logged
  //    (one may run long; interjections stay short).
  for (let i = 1; i <= 3; i++) {
    const g = await askGroup(crisisDigestV1, QUESTION);
    const responses = g.responses ?? [];
    const combined = responses.map((r) => r.brief).join(" ");
    check(
      `R4.${i} group answers w/ numbers, no punt`,
      responses.length > 0 && hasDigit(combined) && namesAFront(combined) && !isPunt(combined),
      combined.slice(0, 160),
    );
    for (const r of responses) {
      console.log(`   [group #${i} ${r.from} len=${r.brief.length}] ${r.brief}`);
    }
  }

  // 5) Deliver-the-unknown (handtest fix): "who do I send" must be answered
  //    with a concrete unit handle IN THE FIRST SENTENCE — numbers follow as
  //    evidence, never substitute for the asked-for unknown.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisDigestV1, "派谁去增援北部前线？", "combat");
    const brief = r.brief ?? "";
    const window = deliveryWindow(brief);
    check(
      `R5.${i} who-question → unit name delivered up front`,
      namesAUnit(window) && !isPunt(brief),
      `window="${window}" full=${brief.slice(0, 140)}`,
    );
    console.log(`   [who #${i}] ${brief}`);
  }

  // 6) Asymmetric frame (handtest shape): one front pressured, one FALLEN
  //    (no-force note on the wire). The answer must still take a stance and
  //    may cite the rebuild-from-rear fact; hard assert = stance + number.
  {
    const asym = northCrisisCenterEmpty();
    const asymDigest = buildDigest(asym, [], [], []);
    for (let i = 1; i <= 2; i++) {
      const r = await ask(asymDigest, "北线吃紧，中央又丢了，先顾哪头？", "combat");
      const brief = r.brief ?? "";
      check(
        `R6.${i} asymmetric → stance w/ numbers, no punt`,
        (r.options ?? []).length === 0 && hasDigit(brief) && namesAFront(brief) && !isPunt(brief),
        brief.slice(0, 160),
      );
      console.log(`   [asym #${i}] ${brief}`);
    }
  }

  // 7) Fogged brawl (handtest round-2 shape): north fighting under fog,
  //    central in a visible crisis. The previously-vanishing front must now
  //    be part of the comparison — the answer has to name it.
  {
    const s = foggedBrawl();
    // central front, exclusive point (outside minefield/ruweisat/axis_rear):
    // committed defenders + visible enemies → a REAL numeric line coexists
    // with the north's engaged-unknown line.
    const d1 = addUnit(s, 200, 130, { hp: 60 });
    const d2 = addUnit(s, 202, 130, { hp: 60 });
    addSquad(s, [d1.id, d2.id], { id: "I2", leaderName: "Carter" });
    for (let i = 0; i < 4; i++) {
      const e = addUnit(s, 204 + i, 132, { team: "enemy" } as Partial<Unit>);
      reveal(s, e.position.x, e.position.y);
    }
    const digest = buildDigest(s, [], [], []);
    for (let i = 1; i <= 2; i++) {
      const r = await ask(digest, "先救哪条线？", "combat");
      const brief = r.brief ?? "";
      check(
        `R7.${i} fogged front stays in the comparison`,
        (r.options ?? []).length === 0 && hasDigit(brief) && brief.includes("北") && !isPunt(brief),
        brief.slice(0, 160),
      );
      console.log(`   [fog #${i}] ${brief}`);
    }
  }

  // 8) Casual status question (handtest round-3 ★): "情况怎么样" was eaten by
  //    the greeting register 3/3. The exact failing utterance, crisis state:
  //    must get a real sitrep answer, never a 1-3字 greeting reply.
  for (let i = 1; i <= 3; i++) {
    const r = await ask(crisisDigestV1, "现在情况怎么样？", "combat");
    const brief = r.brief ?? "";
    check(
      `R8.${i} casual status question gets a real answer`,
      (r.options ?? []).length === 0 && brief.length >= 15 && hasDigit(brief) && namesAFront(brief),
      brief.slice(0, 160),
    );
    console.log(`   [casual #${i}] ${brief}`);
  }

  // 9) Counter-guard: a TRUE greeting must stay a short greeting — the
  //    boundary line must not kill the register the other way.
  {
    const rc = await ask(crisisDigestV1, "你好", "combat");
    const bc = rc.brief ?? "";
    check("R9.1 chen greeting stays short", bc.length <= 12 && !/\d/.test(bc), bc);
    console.log(`   [greet chen] ${bc}`);
    const rm = await ask(crisisCtxV2, "你好", "ops");
    const bm = rm.brief ?? "";
    check("R9.2 marcus greeting stays short", bm.length <= 12 && !/\d/.test(bm), bm);
    console.log(`   [greet marcus] ${bm}`);
  }

  // 10) Stale-snapshot precedence (handtest round-3 followup): the envelope
  //     carries BOTH an old escalation question (ask-time numbers) and the
  //     current FRONT_JUDGMENT frame. Recital must use the frame's current
  //     values, never the snapshot's. Frame truth here: coastal survival≈3s
  //     ratio=0.33; the fake snapshot deliberately contradicts (10秒/0.88).
  {
    const staleBlock =
      `\n---ACTIVE_ESCALATION---\n参谋刚问:「北部战线我方单位仅能支撑10秒，当前战力比0.88。Blake部队可在999秒内抵达，是否调动？」\n指挥官下面这句是对它的回应。`;
    for (let i = 1; i <= 2; i++) {
      const r = await ask(crisisDigestV1 + staleBlock, "现在情况怎么样？", "combat");
      const brief = r.brief ?? "";
      const usesCurrent = brief.includes("3秒") || brief.includes("三秒");
      const usesStale = brief.includes("10秒") || brief.includes("十秒") || brief.includes("0.88") || brief.includes("999");
      check(
        `R10.${i} current frame beats ask-time snapshot`,
        usesCurrent && !usesStale,
        brief.slice(0, 160),
      );
      console.log(`   [stale #${i}] ${brief}`);
    }
  }

  // 11) Numberless-row precedence, no-force branch (round-4 live failure: a
  //     fallen front's stale snapshot numbers were recited as current —
  //     "全灭" reported as "还能撑1秒"). Frame truth: 中央 has NO force; the
  //     fake snapshot claims impossible numbers for it.
  {
    const asym = northCrisisCenterEmpty();
    const asymDigest = buildDigest(asym, [], [], []);
    const staleCentral =
      `\n---ACTIVE_ESCALATION---\n参谋刚问:「中央战线我方单位仅能支撑7秒，敌我战力比1:9。Blake部队可在999秒内抵达，是否调动？」\n指挥官下面这句是对它的回应。`;
    for (let i = 1; i <= 2; i++) {
      const r = await ask(asymDigest + staleCentral, "中央那边现在到底什么情况？", "combat");
      const brief = r.brief ?? "";
      const saysNoForce = /无|没/.test(brief) && /部队|兵力|人/.test(brief);
      const usesStale = brief.includes("7秒") || brief.includes("七秒") || brief.includes("1:9") || brief.includes("999");
      check(`R11.${i} fallen front: no-force beats stale snapshot`, saysNoForce && !usesStale, brief.slice(0, 160));
      console.log(`   [void #${i}] ${brief}`);
    }
  }

  // 12) Numberless-row precedence, engaged-unknown branch: fogged brawl has no
  //     survival/ratio; a stale snapshot offering them must not be recited —
  //     the honest answer conveys "can't estimate" plus own-strength facts.
  {
    const fog = foggedBrawl();
    const fogDigest = buildDigest(fog, [], [], []);
    const staleNorth =
      `\n---ACTIVE_ESCALATION---\n参谋刚问:「北部战线我方单位仅能支撑8秒，敌我战力比1:6，是否后撤？」\n指挥官下面这句是对它的回应。`;
    for (let i = 1; i <= 2; i++) {
      const r = await ask(fogDigest + staleNorth, "北线现在到底什么情况？", "combat");
      const brief = r.brief ?? "";
      const conveysUnknown = /不明|未明|无法/.test(brief);
      const usesStale = brief.includes("8秒") || brief.includes("八秒") || brief.includes("1:6");
      check(`R12.${i} fogged front: unknown beats stale snapshot`, conveysUnknown && !usesStale, brief.slice(0, 160));
      console.log(`   [fogvoid #${i}] ${brief}`);
    }
  }

  // 13) Step B register probe: the SAME question against a calm envelope (no
  //     mood line) vs a critical one (mood: critical + seconds). Hard asserts
  //     stay mechanical (no exec / no punt / critical cites digits); the
  //     register contrast itself is a HUMAN read — lengths logged so the
  //     judgment is recordable in the run output.
  {
    const critDigest = buildDigest(crisisEngaged(), [], [], []);
    const REGISTER_Q = "现在情况怎么样？";
    for (let i = 1; i <= 3; i++) {
      const r = await ask(healthyDigestV1, REGISTER_Q, "combat");
      const brief = r.brief ?? "";
      check(`R13.${i} calm register: no exec, no punt`, (r.options ?? []).length === 0 && !isPunt(brief), brief.slice(0, 160));
      console.log(`   [mood-calm #${i} len=${brief.length}] ${brief}`);
    }
    for (let i = 1; i <= 3; i++) {
      const r = await ask(critDigest, REGISTER_Q, "combat");
      const brief = r.brief ?? "";
      check(
        `R14.${i} critical register: no exec, cites digits, no punt`,
        (r.options ?? []).length === 0 && hasDigit(brief) && !isPunt(brief),
        brief.slice(0, 160),
      );
      console.log(`   [mood-critical #${i} len=${brief.length}] ${brief}`);
    }
  }

  console.log(failCount === 0 ? "\nREAL-MODEL GATE PASS" : `\nREAL-MODEL FAILURES: ${failCount}`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--real") void runReal();
else {
  console.log("usage: tsx scripts/ab-commander-presence.ts --synthetic | --real");
  process.exit(2);
}
