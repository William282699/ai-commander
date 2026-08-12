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

import { createInitialGameState, frontEscalationFacts, previewHighImpactIntent } from "@ai-commander/core";
import { buildPreflightConcernFacts } from "../packages/core/src/commandPreflight";
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

const OCTANTS = ["东北", "西北", "西南", "东南", "东", "北", "西", "南", "中央"]; // 先长后短，防「东」吃掉「东北」

/**
 * 「这个 label 是方位式的吗」——刀② 之后判"退回方位"不能再写死「方向」两个字。
 * 方位式 ＝ 裸罗盘（`东北方向…`）**或** 真实地名 + 八向词（`我军兵营西北…`）。
 * ★ 前缀必须是**这一局真实存在的地名**，所以它咬得住"编个地方出来"这件事
 *   ——不是把断言改成恒真。
 *
 * ⚠ 松紧账（Fable 记，2026-08-12，不设闸）：真地名校验**只罩住原点形**。
 *   裸罗盘分支只判 `八向词+方向$`，所以「假地名北方向」这种编造形它放得过去。
 *   要收紧就得连罗盘形也判前缀为空——现无实例，先记账不动手。
 */
function isBearingLabel(state: GameState, label: string): boolean {
  if (!label.endsWith("未编组群")) return false;
  const core = label.slice(0, -"未编组群".length).replace(/第[一二三四五六七八九十]|第\d+/g, "");
  if (/(?:东北|西北|西南|东南|东|南|西|北|中央)方向$/.test(core)) return true;
  const places = new Set<string>();
  for (const t of state.tags ?? []) places.add(t.name);
  state.facilities.forEach((f) => { if (f.hp > 0) places.add(f.name); });
  for (const fr of state.fronts) places.add(fr.name);
  for (const o of OCTANTS) {
    if (core.endsWith(o) && places.has(core.slice(0, -o.length))) return true;
  }
  return false;
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
    const labelC = r2c.options[0]?.label ?? "";
    // 刀②：退回的不再是裸罗盘词，而是「地名+方位」（够得着原点时）。
    // **这一条要守的东西没变**：短语省略时不许编出"贴着某地"或"正在去某地"，
    // 只许给方位。两条禁令原样保留，只把"长什么样"从写死的「方向」
    // 换成 isBearingLabel（方位式 ＝ 裸罗盘方向 或 真实地名+八向词）。
    check(
      "all-moving one target=null: 短语省略 ⇒ 退回方位式命名（不许 附近／行进中）",
      isBearingLabel(s2c, labelC) && !labelC.includes("附近") && !labelC.includes("行进中"),
      labelC,
    );

    // Voice-polish: two no-place groups in the SAME octant must get distinct
    // deterministic names (第一/第二…) — never two identical candidate labels.
    const s2d = emptyBattlefield();
    addUnit(s2d, 15, 230); addUnit(s2d, 16, 230);
    addUnit(s2d, 50, 230); addUnit(s2d, 51, 230);
    const r2d = buildReinforceOptions(s2d, null);
    const labels2d = r2d.options.map((o) => o.label);
    check(
      "same-octant fallback groups: distinct ordinal labels",
      labels2d.length === 2 && labels2d[0] !== labels2d[1] && labels2d.every((l) => /第[一二三四五六七八九十]未编组群$/.test(l)),
      labels2d.join(" | "),
    );

    // Round-2 #3a: ELEVEN same-octant groups — labels must stay absolutely
    // unique past 第十 (arabic numerals from the 11th on).
    const s2e = emptyBattlefield();
    // Exact -45° diagonal from the RUNTIME map center → every point is in the
    // 西南 octant by construction, regardless of map dimensions; 9√2≈12.7 tile
    // spacing keeps the 11 units as 11 separate spatial groups.
    const cxE = Math.round(s2e.mapWidth / 2);
    const cyE = Math.round(s2e.mapHeight / 2);
    for (let k = 0; k < 11; k++) { addUnit(s2e, cxE - 40 - 9 * k, cyE + 40 + 9 * k); }
    const r2e = buildReinforceOptions(s2e, null);
    const labels2e = r2e.options.map((o) => o.label);
    check(
      "11 same-octant groups: all labels unique incl. >第十",
      labels2e.length === 11 && new Set(labels2e).size === 11 && labels2e.some((l) => /第11未编组群$/.test(l)),
      labels2e.slice(-3).join(" | "),
    );

    // Round-2 #3b: dead-center group must read 中央, not a spurious octant.
    // ★刀②：死区**只在够不着任何原点时**才该出场（36 格内有地名就该报地名+方位，
    //   那比「中央」有用得多）。所以这条一分为二，两个分支都钉住——
    //   否则死区会变成一条永不执行、悄悄烂掉的死路。
    {
      // (a) 死区仍然活着：把设施清空，图心 36 格内再无任何地名
      //     （最近的是 front_center 中心，52 格 > 36）。
      const s2f = emptyBattlefield();
      s2f.facilities.clear();
      addUnit(s2f, Math.round(s2f.mapWidth / 2), Math.round(s2f.mapHeight / 2), { state: "moving", target: null });
      const r2f = buildReinforceOptions(s2f, null);
      check(
        "dead-center 群 · 够不着任何原点：仍报 中央方向（死区分支还活着）",
        (r2f.options[0]?.label ?? "").startsWith("中央方向"),
        r2f.options[0]?.label ?? "",
      );
    }
    {
      // (b) 有原点就不该退死区：图心插一面旗，名字必须变成「旗名+方位」。
      const s2g = emptyBattlefield();
      const cx = Math.round(s2g.mapWidth / 2), cy = Math.round(s2g.mapHeight / 2);
      s2g.tags.push({ id: "tag_1", name: "观察哨", position: { x: cx - 20, y: cy }, createdAt: 0 });
      addUnit(s2g, cx, cy, { state: "moving", target: null });
      const label2g = buildReinforceOptions(s2g, null).options[0]?.label ?? "";
      check(
        "dead-center 群 · 20 格外有标记：报「观察哨东」而不是「中央方向」（原点优先于死区）",
        label2g.startsWith("观察哨东") && !label2g.includes("中央方向"),
        label2g,
      );
    }

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

  // ── 刀② 判据 2：跨面同名一致性（Fable 裁定 3 的操作定义）──
  //
  // 比的是**命名核**（origin+方位词，或裸地名），**不是表面字符串**：
  // 「南线前哨」（preflight）与「南线前哨附近未编组群」（escalation）的包装差
  // 是两面各自的语法，不在本刀改动权内；核相同即算一致。
  // 只在**静止、成员集相同**的场景断言——preflight 命名的是被动员子集的质心、
  // escalation 命名整群，行进中的群两面本就该说不同的话。
  //
  // ★这条的长期价值是**绊索**：谁再引入第二条命名路，它咬谁。
  {
    const s = createInitialGameState("el_alamein");   // 开局全体静止
    const escCores = new Set(
      buildReinforceOptions(s, null as never).options
        .filter((o) => o.label.endsWith("未编组群"))
        .map((o) => o.label
          .slice(0, -"未编组群".length)
          .replace(/第[一二三四五六七八九十]$|第\d+$/, "")
          .replace(/附近$/, "")),
    );
    // 全军开赴最远那条战线 ⇒ 动员子集＝全体，与 escalation 的成员集对齐
    const pv = previewHighImpactIntent(
      { type: "attack", toFront: "front_axis_rear", quantity: "all" } as never, s, s.style,
    );
    const pfCores = new Set((pv ? buildPreflightConcernFacts(s, pv as never).sources : []).map((x) => x.place));
    const onlyEsc = [...escCores].filter((c) => !pfCores.has(c));
    const onlyPf = [...pfCores].filter((c) => !escCores.has(c));
    check(
      `跨面同名一致性：escalation 与 preflight 的命名核逐个相同（各 ${escCores.size}/${pfCores.size} 个）`,
      escCores.size > 0 && onlyEsc.length === 0 && onlyPf.length === 0,
      onlyEsc.length || onlyPf.length ? `只在 esc: ${onlyEsc.join(",")} | 只在 pf: ${onlyPf.join(",")}` : "",
    );
  }

  // ── 刀② 观察账：同群跨 tick 名字翻转率（Fable 裁定 4：记数不判红）──
  //
  // 原点变近 ⇒ 角度对位移更敏感 ⇒ 名字更容易翻，与 B3（模型抄旧名）互动。
  // 这里用**确定性扰动**代替真 tick：把每个群整体平移 1 格（八个方向），
  // 数名字变了几次。不设线，只记数——给第 9 级和 B3 攒证据。
  {
    const s = createInitialGameState("el_alamein");
    const base = buildReinforceOptions(s, null as never).options;
    let flips = 0, trials = 0;
    const detail: string[] = [];
    const kinds = { cliff: 0, swap: 0, angle: 0 };
    for (const o of base) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const s2 = createInitialGameState("el_alamein");
        for (const id of o.memberIds) {
          const u = s2.units.get(id);
          if (u) u.position = { x: u.position.x + dx, y: u.position.y + dy };
        }
        const after = buildReinforceOptions(s2, null as never).options
          .find((x) => x.memberIds.join(",") === o.memberIds.join(","));
        trials++;
        if (after && after.label !== o.label) {
          flips++;
          detail.push(`${o.label} → ${after.label}  (平移 ${dx},${dy})`);
          const originOf = (l: string): string | null => {
            const core = l.slice(0, -"未编组群".length).replace(/第[一二三四五六七八九十]$|第\d+$/, "");
            if (/方向$/.test(core)) return null;              // 无原点（裸罗盘）
            for (const oc of OCTANTS) if (core.endsWith(oc)) return core.slice(0, -oc.length);
            return core.replace(/附近$/, "");                  // 地名形
          };
          const a = originOf(o.label), b = originOf(after.label);
          if (a === null || b === null) kinds.cliff++;         // 够着/够不着原点，翻过 36 格悬崖
          else if (a !== b) kinds.swap++;                      // 原点换人（两地标近乎等距）
          else kinds.angle++;                                  // 同一个原点，纯方位角翻转
        }
      }
    }
    console.log(`观察账（不判红）· 同群平移 1 格的名字翻转率：${flips}/${trials} = ${(flips / trials * 100).toFixed(1)}%`);
    console.log(`   ↳ 对照：② **之前**同一把量具量出来是 0/88 = 0.0%（拿 660226c 的核跑的）。`);
    console.log(`   ↳ 机制明细：**悬崖 ${kinds.cliff}（够着/够不着 36 格原点）｜原点换人 ${kinds.swap}（两地标近乎等距，`
      + `strict < 先入者赢被 1 格打翻）｜纯方位角 ${kinds.angle}**`);
    console.log(`     ★主力病灶是**原点身份不稳**，不是角度敏感——按错误病因去做角度平滑会打空。`);
    console.log(`     **这是 ② 的真实代价，不是噪声**：名字一翻，模型抄上一轮的旧名就落空（撞 B3）。`);
    for (const d of detail) console.log(`       · ${d}`);
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
