// ============================================================
// AI Commander — Commander Presence bench (presence-v1)
//
// Step A: FRONT_JUDGMENT engine section + judgment-license real-model probes.
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
import { buildFrontJudgmentLines } from "../packages/core/src/commanderPresence";
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
    check("A9 central no-force note", center === "3. 中央战线: 无我方作战部队（增援须从后方调兵）", center);
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

  // E3) Same append-only contract on the engaged-unknown path.
  {
    const s = foggedBrawl();
    const newDigest = buildDigest(s, [], [], []);
    const board = boardToDigestLines(buildBattleBoard(s));
    const oldDigest = generateDigestV1(s, [], [], [], board);
    const judgment = buildFrontJudgmentLines(s);
    const expectedTail = judgment.map((l) => `${l}\n`).join("");
    check("E3 engaged-unknown digest byte-prefix + exact tail", newDigest === oldDigest + expectedTail);
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
