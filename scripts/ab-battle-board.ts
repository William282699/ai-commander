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

import { createInitialGameState } from "@ai-commander/core";
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

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--ab") {
  console.log("--ab (real-model A/B + parser fixtures) lands in step 4");
  process.exit(2);
} else {
  console.log("usage: tsx scripts/ab-battle-board.ts --synthetic | --ab");
  process.exit(2);
}
