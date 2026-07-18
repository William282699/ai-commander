// ============================================================
// AI Commander — V1b front-escalation bench (battlefield-info-v2)
//
// Modes:
//   --synthetic  deterministic boundary assertions (no LLM, no server)
//   --ab         old-vs-new payload comparison through the REAL /api/brief
//
// Both modes get the NEW payload from the ONE production builder
// (buildFrontEscalationPayload) — never a re-implementation. The OLD payload
// is derived by swapping the reinforcement_options block back to the legacy
// idle_reinforcement_available line (the frozen 629c9f7 format): the shared
// five lines therefore stay literally identical between A and B.
//
// Run (from the worktree root, main-repo tsx):
//   "/Users/yuqiaohuang/MyProjects/AI Commander/node_modules/.bin/tsx" \
//     scripts/ab-front-escalation.ts --synthetic
// ============================================================

import { createInitialGameState, frontEscalationFacts } from "@ai-commander/core";
// Bench-only symbols come from the module FILE directly — core/index.ts stays
// builder-only for production (Codex round-4 P1-4). Same source file as prod,
// so "same builder" still holds.
import {
  buildFrontEscalationPayload,
  buildReinforceOptions,
  spatialGroups,
  CLUSTER_DIAMETER_CAP,
} from "../packages/core/src/frontEscalationPayload";
import type { GameState, Unit, Squad, CrisisEvent, Front } from "@ai-commander/shared";

// ── Helpers ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

function makeCrisis(front: Front): CrisisEvent {
  return {
    type: "DOCTRINE_BREACH",
    severity: "critical",
    doctrineId: "bench-synthetic",
    locationTag: front.id,
    message: `${front.name} 态势需要决断`,
    time: 0,
  };
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

function extractOptionsBlock(payload: string): string {
  const lines = payload.split("\n");
  const start = lines.findIndex((l) => l.startsWith("reinforcement_options"));
  const end = lines.findIndex((l) => l.startsWith("raw_signal:"));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** OLD payload (frozen 629c9f7 GameCanvas:463-475 format): same builder output
 *  with the options block swapped back to the legacy boolean line. */
function buildLegacyPayload(state: GameState, crisis: CrisisEvent): string {
  const neu = buildFrontEscalationPayload(state, crisis);
  const facts = frontEscalationFacts(state, crisis);
  const legacyLine = `idle_reinforcement_available: ${
    facts?.freeReinforcement
      ? `${facts.freeReinforcement.leaderName}, ${facts.freeReinforcement.aliveCount} men`
      : "none"
  }`;
  const lines = neu.split("\n");
  const start = lines.findIndex((l) => l.startsWith("reinforcement_options"));
  const end = lines.findIndex((l) => l.startsWith("raw_signal:"));
  return [...lines.slice(0, start), legacyLine, ...lines.slice(end)].join("\n");
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== synthetic boundary assertions ==");

  // 1) Chain diameter cap (Codex round-3): A–B≤10, B–C≤10 may merge while the
  //    span stays ≤ cap; the moment the span would exceed the cap the chain
  //    must break. All groups' diameters must be ≤ CLUSTER_DIAMETER_CAP.
  {
    const s = emptyBattlefield();
    const chain = [0, 9, 18, 27, 36].map((y) => addUnit(s, 5, y));
    const groups = spatialGroups(chain);
    check("chain: not one giant group", groups.length >= 2, `groups=${groups.length}`);
    check(
      "chain: every group diameter ≤ cap",
      groups.every((g) => groupDiameter(g) <= CLUSTER_DIAMETER_CAP + 1e-9),
      groups.map((g) => groupDiameter(g).toFixed(1)).join(","),
    );
    const spans = chain.filter((u) => {
      const g = groups.find((gr) => gr.includes(u));
      return g && g.some((v) => Math.abs(v.position.y - u.position.y) > CLUSTER_DIAMETER_CAP);
    });
    check("chain: no member pair beyond cap shares a group", spans.length === 0);
  }

  // 2) Long chain (10 units every 9 tiles, 81-tile span) → several bounded groups.
  {
    const s = emptyBattlefield();
    const chain = Array.from({ length: 10 }, (_, i) => addUnit(s, 40, i * 9));
    const groups = spatialGroups(chain);
    check("long chain: split into ≥4 groups", groups.length >= 4, `groups=${groups.length}`);
    check(
      "long chain: all diameters ≤ cap",
      groups.every((g) => groupDiameter(g) <= CLUSTER_DIAMETER_CAP + 1e-9),
    );
  }

  // 3) Naming never merges: two blobs 60 tiles apart stay two groups no matter
  //    what facility is nearest to both (grouping precedes naming).
  {
    const s = emptyBattlefield();
    const blobA = [addUnit(s, 10, 10), addUnit(s, 11, 10)];
    const blobB = [addUnit(s, 10, 70), addUnit(s, 11, 70)];
    const groups = spatialGroups([...blobA, ...blobB]);
    check("far blobs: two groups", groups.length === 2, `groups=${groups.length}`);
  }

  // 4) Task status five-level rules via the public candidate API (front=null →
  //    no exclusion, eta unknown — that is also assertion 5).
  {
    const s = emptyBattlefield();
    s.time = 100;

    // engaged beats everything; initial lastAttackTime=0 must NOT read as engaged
    const engaged = addUnit(s, 10, 10, { lastAttackTime: 97 });
    const calm = addUnit(s, 60, 60); // lastAttackTime 0 at time 100
    const r1 = buildReinforceOptions(s, null);
    const engagedOpt = r1.options.find((o) => o.unitCount === 1 && o.task === "交战中");
    check("engaged: fresh lastAttackTime → 交战中", engagedOpt !== undefined);
    check(
      "engaged: initial 0 timestamp not engaged",
      r1.options.some((o) => o.task === "无任务"),
      JSON.stringify(r1.options.map((o) => o.task)),
    );
    check("eta unknown without anchor", r1.options.every((o) => o.etaSec === null));
    s.units.delete(engaged.id);
    s.units.delete(calm.id);

    // mission id lookup: defend_area → 守卫; other type → unknown; stale id → unknown
    const mk = (missionId: string | null, missionType?: "defend_area" | "capture") => {
      const st = emptyBattlefield();
      st.time = 100;
      const u = addUnit(st, 20, 20);
      addSquad(st, [u.id], { currentMission: missionId, id: `S${u.id}`, leaderName: `L${u.id}` });
      if (missionId && missionType) {
        st.missions.push({
          id: missionId, type: missionType, name: "m", description: "m",
          assignedUnitIds: [u.id], progress: 0, status: "active", etaSec: 0,
          threats: [], createdAt: 0,
        });
      }
      return buildReinforceOptions(st, null).options[0]?.task;
    };
    check("mission defend_area → 守卫", mk("m1", "defend_area") === "守卫");
    check("mission capture → unknown", mk("m2", "capture") === "unknown");
    check("stale mission id → unknown", mk("advance") === "unknown");

    // uniform orders: hold → 守卫; patrolTask → 巡逻; mixed → unknown; idle → 无任务
    const mkOrders = (setup: (a: Unit, b: Unit) => void) => {
      const st = emptyBattlefield();
      st.time = 100;
      const a = addUnit(st, 20, 20);
      const b = addUnit(st, 21, 20);
      setup(a, b);
      addSquad(st, [a.id, b.id], { id: `S${a.id}`, leaderName: `L${a.id}` });
      return buildReinforceOptions(st, null).options[0]?.task;
    };
    const holdOrder = { unitIds: [], action: "hold" as const, target: null, priority: "medium" as const };
    check("uniform hold orders → 守卫", mkOrders((a, b) => { a.orders = [holdOrder]; b.orders = [holdOrder]; }) === "守卫");
    check("uniform patrolTask → 巡逻", mkOrders((a, b) => { a.patrolTaskId = 1; b.patrolTaskId = 1; }) === "巡逻");
    check("mixed hold+patrol → unknown", mkOrders((a, b) => { a.orders = [holdOrder]; b.patrolTaskId = 1; }) === "unknown");
    check("all idle no orders → 无任务", mkOrders(() => {}) === "无任务");
  }

  // 6) Truncation is presentation-only with a TRUE omitted count.
  {
    const s = emptyBattlefield();
    for (let k = 0; k < 5; k++) addUnit(s, 10 + k * 40, 10);
    const front = s.fronts[0];
    const res = buildReinforceOptions(s, front);
    check("truncation: total 5 shown 3 omitted 2", res.options.length === 5 && res.shown.length === 3 && res.omitted === 2,
      `total=${res.options.length} shown=${res.shown.length} omitted=${res.omitted}`);
    const payload = buildFrontEscalationPayload(s, makeCrisis(front));
    check("truncation: payload states 另有2股", payload.includes("(另有2股候选未列出)"));
  }

  // 7) Empty-set THREE-branch wording (Codex round-4):
  //    A: zero friendlies outside the front       → 战场上无其他友军
  //    B: friendlies outside but none listable    → generic "无可单列的增援候选"
  //    C: dispatchable members locked in a squad STRADDLING the crisis front —
  //       the same generic wording must stay true for this path too.
  {
    const sA = emptyBattlefield();
    const pA = buildFrontEscalationPayload(sA, makeCrisis(sA.fronts[0]));
    check("empty A: 战场上无其他友军", pA.includes("reinforcement_options: none (战场上无其他友军)"));

    const sB = emptyBattlefield();
    const frB = sB.fronts[0];
    addUnit(sB, 5, 5, { type: "commander" });
    const rB = buildReinforceOptions(sB, frB);
    const pB = buildFrontEscalationPayload(sB, makeCrisis(frB));
    check("empty B: no candidates but friendly counted", rB.options.length === 0 && rB.outsideFriendlyCount === 1,
      `opts=${rB.options.length} outside=${rB.outsideFriendlyCount}`);
    check("empty B: generic wording", pB.includes("front 外有1个友军单位, 但当前无可单列的增援候选"));

    const sC = emptyBattlefield();
    const frC = sC.fronts[0];
    const bboxC = sC.regions.get(frC.regionIds[0])!.bbox;
    const inside = addUnit(sC, Math.round((bboxC[0] + bboxC[2]) / 2), Math.round((bboxC[1] + bboxC[3]) / 2));
    const outside = addUnit(sC, bboxC[2] + 8, Math.round((bboxC[1] + bboxC[3]) / 2));
    addSquad(sC, [inside.id, outside.id], { id: "SX", leaderName: "Straddle" });
    const rC = buildReinforceOptions(sC, frC);
    const pC = buildFrontEscalationPayload(sC, makeCrisis(frC));
    check("empty C: straddling squad yields no candidates", rC.options.length === 0, `opts=${rC.options.length}`);
    check("empty C: wording true for straddle path", pC.includes("但当前无可单列的增援候选"));
  }

  // 7b) P1-1 probes: motion-aware naming — no fabricated proximity.
  {
    // A unit right NEXT to a facility but moving away must NOT be pinned to it.
    const s = emptyBattlefield();
    let fac: { position: { x: number; y: number } } | null = null;
    s.facilities.forEach((f) => { if (!fac && f.hp > 0) fac = f; });
    const fp = (fac as unknown as { position: { x: number; y: number } }).position;
    addUnit(s, fp.x + 1, fp.y, { state: "moving", target: { x: fp.x + 60, y: fp.y + 60 } });
    const r = buildReinforceOptions(s, null);
    const label = r.options[0]?.label ?? "";
    check("moving-away: label never 附近", !label.includes("附近"), label);

    // Moving WITH a resolvable destination → 向X行进中
    const s2 = emptyBattlefield();
    let fac2: { position: { x: number; y: number } } | null = null;
    s2.facilities.forEach((f) => { if (!fac2 && f.hp > 0) fac2 = f; });
    const fp2 = (fac2 as unknown as { position: { x: number; y: number } }).position;
    addUnit(s2, fp2.x + 40, fp2.y + 40, { state: "moving", target: { x: fp2.x, y: fp2.y } });
    const r2 = buildReinforceOptions(s2, null);
    check("moving-resolvable: 向…行进中", (r2.options[0]?.label ?? "").includes("行进中"), r2.options[0]?.label ?? "");

    // Round-5: RETREATING is movement too (engine sim.ts gate) — a unit
    // retreating away from a facility must not be pinned to it.
    const s2b = emptyBattlefield();
    let fac2b: { position: { x: number; y: number } } | null = null;
    s2b.facilities.forEach((f) => { if (!fac2b && f.hp > 0) fac2b = f; });
    const fp2b = (fac2b as unknown as { position: { x: number; y: number } }).position;
    addUnit(s2b, fp2b.x + 1, fp2b.y, { state: "retreating", target: { x: fp2b.x + 70, y: fp2b.y + 70 } });
    const r2b = buildReinforceOptions(s2b, null);
    check("retreating-away: label never 附近", !(r2b.options[0]?.label ?? "").includes("附近"), r2b.options[0]?.label ?? "");

    // Round-5: all members moving but ANY member without a target → one
    // member's destination must not speak for the group → phrase omitted.
    const s2c = emptyBattlefield();
    let fac2c: { position: { x: number; y: number } } | null = null;
    s2c.facilities.forEach((f) => { if (!fac2c && f.hp > 0) fac2c = f; });
    const fp2c = (fac2c as unknown as { position: { x: number; y: number } }).position;
    addUnit(s2c, fp2c.x + 40, fp2c.y + 40, { state: "moving", target: { x: fp2c.x, y: fp2c.y } });
    addUnit(s2c, fp2c.x + 41, fp2c.y + 40, { state: "moving", target: null });
    const r2c = buildReinforceOptions(s2c, null);
    check(
      "all-moving one target=null: phrase omitted",
      /^未编组群\d+$/.test(r2c.options[0]?.label ?? ""),
      r2c.options[0]?.label ?? "",
    );

    // Squads carry the phrase as a separate location token
    const s3 = emptyBattlefield();
    let fac3: { position: { x: number; y: number } } | null = null;
    s3.facilities.forEach((f) => { if (!fac3 && f.hp > 0) fac3 = f; });
    const fp3 = (fac3 as unknown as { position: { x: number; y: number } }).position;
    const a = addUnit(s3, fp3.x + 1, fp3.y);
    const b = addUnit(s3, fp3.x + 2, fp3.y);
    addSquad(s3, [a.id, b.id], { id: "SL", leaderName: "Loc" });
    const r3 = buildReinforceOptions(s3, null);
    check("squad static location token 附近", (r3.options[0]?.location ?? "").endsWith("附近"), String(r3.options[0]?.location));
  }

  // 7c) P1-2 probe: sub-second travel must surface as ≥1, never 0.
  {
    let probed: number | null = null;
    for (let dx = 2; dx <= 6 && probed === null; dx++) {
      const st = emptyBattlefield();
      const front = st.fronts.find((f) => f.id === "front_center")!;
      const bbox = st.regions.get(front.regionIds[0])!.bbox;
      addUnit(st, bbox[2] + dx, Math.round((bbox[1] + bbox[3]) / 2), { moveSpeed: 9999 });
      const r = buildReinforceOptions(st, front);
      if (r.options.length === 1 && r.options[0].etaSec !== null) probed = r.options[0].etaSec;
    }
    check("eta ceil: fast unit gets ≥1, never 0", probed !== null && probed >= 1, String(probed));
  }

  // 8) Fog safety: the options block must be byte-identical when a hidden enemy
  //    far outside any front changes (friendly-only reads by construction).
  {
    const s = emptyBattlefield();
    addUnit(s, 10, 10);
    addUnit(s, 60, 60);
    const front = s.fronts[0];
    const before = extractOptionsBlock(buildFrontEscalationPayload(s, makeCrisis(front)));
    addUnit(s, 90, 90, { team: "enemy" });
    const after = extractOptionsBlock(buildFrontEscalationPayload(s, makeCrisis(front)));
    check("fog: options block unchanged by hidden enemy", before === after);
  }

  // 9) Payload structure on the REAL opening state (the F1 case).
  {
    const s = createInitialGameState("el_alamein");
    const front = s.fronts.find((f) => f.id === "front_center")!;
    const payload = buildFrontEscalationPayload(s, makeCrisis(front));
    const lines = payload.split("\n");
    check("payload: SITUATION header first", lines[0].startsWith("SITUATION (voice ONE in-character line"));
    check("payload: legacy line order", lines[1].startsWith("front: ") && lines[2].startsWith("stake: ")
      && lines[3].startsWith("our_committed_force_survival_sec: ")
      && lines[4].startsWith("local_power_ratio_ours_to_visible_enemy: "));
    check("payload: raw_signal last", lines[lines.length - 1].startsWith("raw_signal: "));
    check("payload: no Infinity / no fake 0s eta", !payload.includes("Infinity") && !payload.includes("eta_est_sec=0\n"));
    check("payload: legacy boolean gone", !payload.includes("idle_reinforcement_available"));
    check("payload: has real candidates on opening", payload.includes("reinforcement_options:\n- "));
    // Legacy replica keeps shared lines byte-identical (A/B precondition).
    const legacy = buildLegacyPayload(s, makeCrisis(front));
    const shared = (p: string) => p.split("\n").filter((l) => !l.startsWith("- ") && !l.startsWith("reinforcement_options") && !l.startsWith("idle_reinforcement_available")).join("\n");
    check("A/B precondition: shared five lines identical", shared(legacy) === shared(payload));
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── --ab ──

async function runAB(): Promise<void> {
  const base = process.env.BRIEF_URL ?? "http://localhost:3001/api/brief";
  const s = createInitialGameState("el_alamein");
  const front = s.fronts.find((f) => f.id === "front_center")!;
  const crisis = makeCrisis(front);
  const variants = {
    OLD: buildLegacyPayload(s, crisis),
    NEW: buildFrontEscalationPayload(s, crisis),
  };
  console.log(`== A/B via ${base} (el_alamein opening, front_center) ==`);
  for (const [tag, digest] of Object.entries(variants)) {
    console.log(`\n---- ${tag} payload ----\n${digest}\n---- responses ----`);
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ digest, channel: "combat", mode: "escalation" }),
        });
        const body = await res.text();
        console.log(`[${tag} #${i + 1}] ${res.status} ${body}`);
      } catch (e) {
        console.log(`[${tag} #${i + 1}] FETCH FAILED: ${(e as Error).message} — is the server running?`);
        process.exit(1);
      }
    }
  }
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--ab") void runAB();
else {
  console.log("usage: tsx scripts/ab-front-escalation.ts --synthetic | --ab");
  process.exit(2);
}
