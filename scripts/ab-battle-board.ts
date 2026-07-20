// ============================================================
// AI Commander — Battle Board bench (board-v1a)
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server)
//   --ab         real-model comparison + parser fixtures (step 4)
//
// Both modes read the ONE production builder (buildBattleBoard) — never a
// re-implementation. Bench-only symbols come from the module FILES directly
// (V1b precedent): core/index.ts stays builder-only for production.
//
// Run (from the worktree root):
//   ./node_modules/.bin/tsx scripts/ab-battle-board.ts --synthetic
// ============================================================

import { createInitialGameState, buildDigest, buildBattleContextV2 } from "@ai-commander/core";
import { generateDigestV1 } from "@ai-commander/shared";
import {
  buildBattleBoard,
  boardToDigestLines,
  boardToForcesLines,
} from "../packages/core/src/battleBoard";
import {
  buildReinforceOptions,
  spatialGroups,
  CLUSTER_DIAMETER_CAP,
} from "../packages/core/src/frontEscalationPayload";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
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

/** Independent conservation oracle — proposal §3.1 denominator, all four gates. */
function unassignedPoolUnits(s: GameState): Unit[] {
  const inSquad = new Set<number>();
  for (const sq of s.squads) for (const id of sq.unitIds) inSquad.add(id);
  const out: Unit[] = [];
  s.units.forEach((u) => {
    if (u.hp > 0 && u.type !== "commander" && isDispatchablePlayerUnit(u) && !inSquad.has(u.id)) {
      out.push(u);
    }
  });
  return out;
}

function groupDiameter(g: Unit[]): number {
  let d = 0;
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      const dx = g[i].position.x - g[j].position.x;
      const dy = g[i].position.y - g[j].position.y;
      d = Math.max(d, Math.sqrt(dx * dx + dy * dy));
    }
  }
  return d;
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== board-v1a synthetic assertions ==");

  // A) Aiden case (the empirical gap): a 1-survivor squad under fire must read
  //    交战中 — never idle/无任务 — and the suffix must carry task + hp.
  {
    const s = emptyBattlefield();
    s.time = 100;
    const survivor = addUnit(s, 30, 30, { hp: 8, lastDamagedAt: 97 } as Partial<Unit>);
    addSquad(s, [survivor.id], { id: "I1", leaderName: "Aiden" });
    const board = buildBattleBoard(s);
    const row = board.squads.find((r) => r.squadId === "I1");
    check("Aiden: row exists", row !== undefined);
    check("Aiden: task=交战中 (recent lastDamagedAt)", row?.task === "交战中", row?.task);
    const suffix = boardToDigestLines(board).squadLineSuffixById["I1"] ?? "";
    check("Aiden: suffix carries task + hp", suffix.includes("task=交战中") && /hp=\d+%/.test(suffix), suffix);
  }

  // B) Initial-0 timestamps must NOT read as engaged (engine init value).
  {
    const s = emptyBattlefield();
    s.time = 100;
    const calm = addUnit(s, 30, 30); // lastAttackTime 0, no lastDamagedAt
    addSquad(s, [calm.id], { id: "I2", leaderName: "Calm" });
    const board = buildBattleBoard(s);
    check("initial 0 timestamps: 无任务, not 交战中", board.squads[0]?.task === "无任务", board.squads[0]?.task);
  }

  // C) Uncertainty is omitted, never hard-labeled: stale mission id → unknown
  //    → NO task= token in the suffix (hp stays).
  {
    const s = emptyBattlefield();
    const u = addUnit(s, 30, 30);
    addSquad(s, [u.id], { id: "I3", leaderName: "Stale", currentMission: "msn-gone" });
    const board = buildBattleBoard(s);
    check("stale mission id: task=unknown", board.squads[0]?.task === "unknown", board.squads[0]?.task);
    const suffix = boardToDigestLines(board).squadLineSuffixById["I3"] ?? "";
    check("unknown: no task= token, hp kept", !suffix.includes("task=") && /hp=\d+%/.test(suffix), suffix);
  }

  // D) Squad rows cover ALL alive members — manualOverride included (the row
  //    reflects the whole squad); no leakage into unassigned groups.
  {
    const s = emptyBattlefield();
    const a = addUnit(s, 30, 30);
    const b = addUnit(s, 31, 30, { manualOverride: true });
    addSquad(s, [a.id, b.id], { id: "I4", leaderName: "Mixed" });
    const board = buildBattleBoard(s);
    check("squad row counts manualOverride member", board.squads[0]?.unitCount === 2, String(board.squads[0]?.unitCount));
    check("squad members never appear as groups", board.groups.length === 0, JSON.stringify(board.groups));
  }

  // E) Location phrases (V1b §3 via export-only reuse): static near a facility
  //    → "X附近"; all-moving with resolvable destination → "向X行进中";
  //    mixed motion → omitted (null), never fabricated.
  {
    const s = emptyBattlefield();
    const fac = Array.from(s.facilities.values()).find((f) => f.hp > 0)!;
    const a = addUnit(s, fac.position.x, fac.position.y);
    const b = addUnit(s, fac.position.x + 1, fac.position.y);
    addSquad(s, [a.id, b.id], { id: "I5", leaderName: "Static" });
    const board = buildBattleBoard(s);
    check("static squad: loc=X附近", board.squads[0]?.location === `${fac.name}附近`, String(board.squads[0]?.location));

    const s2 = emptyBattlefield();
    const fac2 = Array.from(s2.facilities.values()).find((f) => f.hp > 0)!;
    const m1 = addUnit(s2, 30, 30, { state: "moving", target: { ...fac2.position } });
    const m2 = addUnit(s2, 31, 30, { state: "moving", target: { ...fac2.position } });
    addSquad(s2, [m1.id, m2.id], { id: "I6", leaderName: "Rolling" });
    const b2 = buildBattleBoard(s2);
    check("moving squad: 向X行进中", b2.squads[0]?.location === `向${fac2.name}行进中`, String(b2.squads[0]?.location));

    const s3 = emptyBattlefield();
    const x1 = addUnit(s3, 30, 30, { state: "moving", target: { x: 50, y: 50 } });
    const x2 = addUnit(s3, 31, 30);
    addSquad(s3, [x1.id, x2.id], { id: "I7", leaderName: "Half" });
    const b3 = buildBattleBoard(s3);
    check("mixed motion: location omitted", b3.squads[0]?.location === null, String(b3.squads[0]?.location));
    const suffix = boardToDigestLines(b3).squadLineSuffixById["I7"] ?? "";
    check("mixed motion: no loc= token", !suffix.includes("loc="), suffix);
  }

  // F) Group rows are the V1b options VERBATIM (label zero-rebuild): field-level
  //    equality against buildReinforceOptions(state, null) minus squad entries.
  //    G) Conservation on the REAL opening: Σ group unitCount == §3.1 pool.
  {
    const s = createInitialGameState("el_alamein");
    const board = buildBattleBoard(s);
    const squadLabels = new Set(
      s.squads.filter((sq) => sq.role === "leader").map((sq) => `${sq.leaderName}(${sq.id})`),
    );
    const expect = buildReinforceOptions(s, null).options
      .filter((o) => !squadLabels.has(o.label))
      .map((o) => ({ label: o.label, unitCount: o.unitCount, composition: o.composition, hpPct: o.hpPct, task: o.task }));
    check("groups verbatim from V1b options", JSON.stringify(board.groups) === JSON.stringify(expect));

    const pool = unassignedPoolUnits(s);
    const sum = board.groups.reduce((n, g) => n + g.unitCount, 0);
    check(
      `conservation: Σ groups == pool (opening, pool=${pool.length})`,
      sum === pool.length,
      `sum=${sum} pool=${pool.length}`,
    );
    const labels = board.groups.map((g) => g.label);
    check("labels unique (opening)", new Set(labels).size === labels.length, labels.join(" | "));
    const diams = spatialGroups(pool).map(groupDiameter);
    check("group diameters ≤ cap (opening)", diams.every((d) => d <= CLUSTER_DIAMETER_CAP + 1e-9),
      diams.map((d) => d.toFixed(1)).join(","));
  }

  // H) Conservation denominator boundaries (proposal §3.1, all four):
  //    idle-but-hp=0 excluded / commander type excluded / manualOverride
  //    excluded / air RETAINED.
  {
    const s = emptyBattlefield();
    addUnit(s, 30, 30);
    addUnit(s, 31, 30);
    addUnit(s, 30, 31);
    addUnit(s, 32, 30, { hp: 0 });                                  // dead-in-place: out
    addUnit(s, 30, 32, { type: "commander" as Unit["type"] });      // commander: out
    addUnit(s, 31, 31, { manualOverride: true });                   // manual override: out
    addUnit(s, 70, 70, { type: "fighter" as Unit["type"] });        // air: IN
    const board = buildBattleBoard(s);
    const sum = board.groups.reduce((n, g) => n + g.unitCount, 0);
    check("boundaries: Σ == 4 (3 infantry + 1 air; hp0/commander/override out)", sum === 4,
      JSON.stringify(board.groups.map((g) => `${g.label}:${g.unitCount}`)));
    check("boundaries: air forms its own listed group", board.groups.some((g) => g.composition.includes("fighter")),
      JSON.stringify(board.groups.map((g) => g.composition)));
  }

  // I) Digest group lines: display budget 6, remainder line carries TRUE counts.
  {
    const s = emptyBattlefield();
    for (let i = 0; i < 8; i++) addUnit(s, 5 + (i % 3) * 38, 5 + Math.floor(i / 3) * 38);
    const board = buildBattleBoard(s);
    check("truncation precondition: 8 groups", board.groups.length === 8, String(board.groups.length));
    const lines = boardToDigestLines(board).unassignedGroupLines;
    check("truncation: 6 shown + remainder line", lines.length === 7, String(lines.length));
    check("truncation: true remainder counts", lines[6] === "...+2 more groups (2 units)", lines[6]);
  }

  // J) Fog invariance: hiding enemies and flipping the fog matrix must not
  //    change the board (friendly units + public place metadata only).
  {
    const s = createInitialGameState("el_alamein");
    const before = JSON.stringify(buildBattleBoard(s));
    addUnit(s, 90, 90, { team: "enemy" });
    s.fog = s.fog.map((row) => row.map(() => "hidden" as GameState["fog"][number][number]));
    const after = JSON.stringify(buildBattleBoard(s));
    check("fog invariance: hidden enemy + fog flip → board identical", before === after);
  }

  // K) Determinism: same state, two calls, byte-identical board + projections.
  {
    const s = createInitialGameState("el_alamein");
    const one = buildBattleBoard(s);
    const two = buildBattleBoard(s);
    check("determinism: builder", JSON.stringify(one) === JSON.stringify(two));
    check(
      "determinism: projections",
      JSON.stringify(boardToDigestLines(one)) === JSON.stringify(boardToDigestLines(two)) &&
        boardToForcesLines(one).join("\n") === boardToForcesLines(two).join("\n"),
    );
  }

  // L) DigestV1 wiring (step 2): the no-board render stays legacy-shaped; the
  //    board render extends SQUADS lines append-only (parser-contract prefix)
  //    and swaps bare UNASSIGNED counts for group lines. Same section skeleton.
  {
    const s = createInitialGameState("el_alamein");
    s.time = 100;
    const survivor = addUnit(s, 30, 30, { hp: 8, lastDamagedAt: 97 } as Partial<Unit>);
    addSquad(s, [survivor.id], { id: "I1", leaderName: "Aiden" });

    const neu = buildDigest(s, [], [], []); // mutates front power first…
    const old = generateDigestV1(s, [], [], []); // …then legacy render on the same state

    check("digest legacy: no board tokens", !old.includes(" task=") && !old.includes(" loc="));
    const oldUnassigned = sectionLines(old, "---UNASSIGNED_UNITS---");
    check("digest legacy: bare type counts", oldUnassigned.length > 0 && oldUnassigned.every((l) => /^\d+×/.test(l)),
      oldUnassigned.join(" | "));

    const oldLeaders = old.split("\n").filter((l) => l.includes(",leader)"));
    const neuLines = neu.split("\n");
    check(
      "digest: every legacy leader line is a byte-exact prefix of its board line",
      oldLeaders.length > 0 && oldLeaders.every((ol) => neuLines.some((nl) => nl.startsWith(ol))),
    );
    const aidenLine = neuLines.find((l) => l.includes("(I1,leader)"));
    check("digest Aiden: squad id + mission token kept + task=交战中 appended",
      aidenLine !== undefined && aidenLine.includes("mission=idle") && aidenLine.includes("task=交战中"),
      aidenLine);

    const neuUnassigned = sectionLines(neu, "---UNASSIGNED_UNITS---");
    check("digest board: group lines, no bare counts",
      neuUnassigned.length > 0 && neuUnassigned.every((l) => l.startsWith("- ") || l.startsWith("...+")) &&
        neuUnassigned.some((l) => l.includes("units(")),
      neuUnassigned.join(" | "));

    // Compare section NAME tokens — board headers may append a one-line
    // annotation after the ---NAME--- token; the skeleton (names + order)
    // must stay identical.
    const headers = (d: string) =>
      d.split("\n")
        .map((l) => l.match(/^---[A-Z_0-9()]+---/)?.[0])
        .filter((h): h is string => h !== undefined);
    check("digest: section skeleton unchanged", JSON.stringify(headers(old)) === JSON.stringify(headers(neu)),
      `old=${headers(old).join(",")} new=${headers(neu).join(",")}`);

    // Position-claim rule (live playtest: destination read as position): the
    // board SQUADS header carries the one-line rule; legacy header stays bare.
    check("digest legacy: SQUADS header bare", old.includes("---SQUADS---\n"));
    check("digest board: SQUADS header carries position rule",
      neu.split("\n").some((l) => l.startsWith("---SQUADS---") && l.includes("NOT the squad's position")));
  }

  // M) FORCES wiring (step 3): BattleContextV2 carries the SAME board rows
  //    (same-source, byte-level), four-tier deterministic order, and honest
  //    truncation — Aiden fixture must be inside the 8-line budget AND on
  //    the wire; the remainder line carries the true omitted count.
  {
    const s = createInitialGameState("el_alamein");
    s.time = 100;
    const survivor = addUnit(s, 30, 30, { hp: 8, lastDamagedAt: 97 } as Partial<Unit>);
    addSquad(s, [survivor.id], { id: "I1", leaderName: "Aiden" });

    const ctx = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
    const wired = sectionLines(ctx, "---FORCES---");
    const direct = boardToForcesLines(buildBattleBoard(s));
    check("FORCES same-source: context section == direct projection",
      JSON.stringify(wired) === JSON.stringify(direct));
    check("FORCES: Aiden row on the wire, engaged-first", wired[0]?.includes("Aiden(I1)") === true, wired[0]);

    // four-tier order on a constructed state: 交战中 → 无任务 → 守卫/巡逻 → unknown
    const s2 = emptyBattlefield();
    s2.time = 100;
    const fire = addUnit(s2, 20, 20, { lastDamagedAt: 97 } as Partial<Unit>);
    addSquad(s2, [fire.id], { id: "E1", leaderName: "Afire" });
    const guard = addUnit(s2, 40, 40, { state: "defending" });
    addSquad(s2, [guard.id], { id: "D1", leaderName: "Dug" });
    const lost = addUnit(s2, 60, 60);
    addSquad(s2, [lost.id], { id: "U1", leaderName: "Vague", currentMission: "msn-gone" });
    addUnit(s2, 80, 10); // unassigned idle → 无任务 group
    const order = boardToForcesLines(buildBattleBoard(s2));
    const idx = (needle: string) => order.findIndex((l) => l.includes(needle));
    check("FORCES tiers: 交战中 → 无任务 → 守卫 → unknown",
      idx("Afire(E1)") === 0 && idx("Afire(E1)") < idx("未编组群") &&
        idx("未编组群") < idx("Dug(D1)") && idx("Dug(D1)") < idx("Vague(U1)"),
      order.join(" | "));

    // truncation honesty: Aiden + 9 idle groups = 10 entries → 8 shown +2 omitted
    const s3 = emptyBattlefield();
    s3.time = 100;
    const a3 = addUnit(s3, 30, 30, { lastDamagedAt: 97 } as Partial<Unit>);
    addSquad(s3, [a3.id], { id: "I1", leaderName: "Aiden" });
    for (const x of [5, 45, 83]) for (const y of [5, 45, 83]) addUnit(s3, x, y);
    const f3 = boardToForcesLines(buildBattleBoard(s3));
    check("FORCES truncation: 8 shown + true remainder (rows AND units)",
      f3.length === 9 && f3[8] === "...+2 more (2 units)",
      `len=${f3.length} last=${f3[f3.length - 1]}`);
    check("FORCES truncation: Aiden still first", f3[0]?.includes("Aiden(I1)") === true, f3[0]);
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

/** Lines of one ---SECTION--- (exclusive of the header, up to the next header).
 *  Prefix match: headers may carry a one-line annotation after the name token. */
function sectionLines(digest: string, header: string): string[] {
  const lines = digest.split("\n");
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("---")) break;
    if (lines[i] !== "") out.push(lines[i]);
  }
  return out;
}

// ── --ab (real model via /api/command; server must be running) ──

interface AdvisorRespLite {
  brief?: string;
  responseType?: string;
  options?: { intents?: IntentLite[]; intent?: IntentLite }[];
}
interface IntentLite {
  type?: string;
  fromSquad?: string;
}

function allIntents(resp: AdvisorRespLite): IntentLite[] {
  const out: IntentLite[] = [];
  for (const o of resp.options ?? []) {
    if (Array.isArray(o.intents)) out.push(...o.intents);
    else if (o.intent) out.push(o.intent);
  }
  return out;
}

/** OLD ops context = current context minus the FORCES tail (last section). */
function stripForces(ctx: string): string {
  const lines = ctx.split("\n");
  const i = lines.findIndex((l) => l.startsWith("---FORCES---"));
  return i === -1 ? ctx : lines.slice(0, i).join("\n");
}

async function runAB(): Promise<void> {
  const cmdUrl = process.env.COMMAND_URL ?? "http://localhost:3001/api/command";

  // A/B fixture: el_alamein opening + the Aiden empirical case (1 survivor,
  // hp 8, under fire) — the state whose OLD digest lies (mission=idle).
  const s = createInitialGameState("el_alamein");
  s.time = 100;
  const survivor = addUnit(s, 30, 30, { hp: 8, lastDamagedAt: 97 } as Partial<Unit>);
  addSquad(s, [survivor.id], { id: "I1", leaderName: "Aiden" });
  const newDigest = buildDigest(s, [], [], []); // board render (mutates front power first)
  const oldDigest = generateDigestV1(s, [], [], []); // legacy render on the same state
  const ctxNew = buildBattleContextV2(s, "ops", { playerIntent: "", openCommitments: [] });
  const ctxOld = stripForces(ctxNew);

  // Parser fixture: a HEALTHY idle Aiden squad. Run-1 lesson: with the dying
  // engaged squad, the board digest made the model (correctly) refuse or
  // substitute forces for "派 I1 去 Coastal" — that measures judgment, not
  // parsing. Parsing is gated on a state where the order is sane; the dying
  // case stays in the A/B judgment probes above.
  const sParse = createInitialGameState("el_alamein");
  sParse.time = 100;
  const healthy = Array.from({ length: 5 }, (_, i) => addUnit(sParse, 30 + i, 30));
  addSquad(sParse, healthy.map((u) => u.id), { id: "I1", leaderName: "Aiden" });
  const parseNew = buildDigest(sParse, [], [], []);
  const parseOld = generateDigestV1(sParse, [], [], []);

  const ask = async (digest: string, message: string, channel: string): Promise<AdvisorRespLite> => {
    const res = await fetch(cmdUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        digest,
        message,
        styleNote: "risk=0.50 focus=0.50 obj=0.50 cas=0.50",
        channel,
        sessionId: "ab-board",
      }),
    });
    return (await res.json()) as AdvisorRespLite;
  };

  // 1) Parser regression fixtures (proposal §6.4). GATE: NEW digest, 9 calls,
  //    zero misses. OLD digest runs as a recorded control, not a gate.
  // EXACT contract per proposal §6.4 (Codex ruling): the name form must parse
  // to the leader name, the id form to the squad id — "either" is NOT enough.
  const fixtures: { utterance: string; kind: "dispatch" | "consult"; expect?: string }[] = [
    { utterance: "派 Aiden 去 Coastal", kind: "dispatch", expect: "Aiden" },
    { utterance: "派 I1 去 Coastal", kind: "dispatch", expect: "I1" },
    { utterance: "Aiden 那边怎么样", kind: "consult" },
  ];
  let gateMisses = 0;
  for (const variant of ["NEW", "OLD"] as const) {
    const digest = variant === "NEW" ? parseNew : parseOld;
    console.log(`\n== parser fixtures on ${variant} digest ==`);
    for (const f of fixtures) {
      for (let i = 0; i < 3; i++) {
        try {
          const resp = await ask(digest, f.utterance, "combat");
          const intents = allIntents(resp);
          let ok: boolean;
          let detail: string;
          if (f.kind === "dispatch") {
            const squads = intents.map((it) => it.fromSquad).filter((v): v is string => typeof v === "string");
            ok = squads.length > 0 && squads.every((v) => v === f.expect);
            detail = `fromSquad=[${squads.join(",")}] expect=${f.expect}`;
          } else {
            ok = intents.length === 0;
            detail = intents.length === 0
              ? `responseType=${resp.responseType} (no intents)`
              : `UNEXPECTED intents=${JSON.stringify(intents)}`;
          }
          if (variant === "NEW" && !ok) gateMisses++;
          console.log(`${ok ? "PASS" : "FAIL"} [${variant}] "${f.utterance}" #${i + 1} — ${detail}`);
        } catch (e) {
          console.log(`FAIL [${variant}] "${f.utterance}" #${i + 1} — FETCH: ${(e as Error).message} — server running?`);
          process.exit(1);
        }
      }
    }
  }

  // 2) Three-question A/B for HUMAN judgment (proposal §6.5): print, don't gate.
  const abProbes: { label: string; message: string; channel: string; old: string; neu: string }[] = [
    { label: "Chen/combat Aiden", message: "Aiden 那边怎么样了", channel: "combat", old: oldDigest, neu: newDigest },
    { label: "Marcus/ops Aiden", message: "Aiden 那边怎么样了", channel: "ops", old: ctxOld, neu: ctxNew },
    { label: "Marcus/ops reserves", message: "预备队都在哪", channel: "ops", old: ctxOld, neu: ctxNew },
  ];
  for (const p of abProbes) {
    console.log(`\n== A/B ${p.label}: "${p.message}" ==`);
    for (const [tag, digest] of [["OLD", p.old], ["NEW", p.neu]] as const) {
      for (let i = 0; i < 3; i++) {
        const resp = await ask(digest, p.message, p.channel);
        console.log(`[${p.label} ${tag} #${i + 1}] ${resp.brief ?? JSON.stringify(resp)}`);
      }
    }
  }

  console.log(gateMisses === 0
    ? "\nPARSER GATE PASS (NEW digest: 9/9)"
    : `\nPARSER GATE FAIL (NEW digest misses: ${gateMisses})`);
  process.exit(gateMisses === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--ab") void runAB();
else {
  console.log("usage: tsx scripts/ab-battle-board.ts --synthetic | --ab");
  process.exit(2);
}
