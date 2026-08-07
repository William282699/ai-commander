// ============================================================
// AI Commander — map data invariants bench (第 8 级 刀3)
//
// Modes:
//   (default)  invariant assertions over the PRODUCTION map data
//   --negctl   PRE-FIX expectations: put any one rectangle back to its old value
//              and the invariants MUST go red. A --negctl run that stays green
//              means the invariant is a tautology, not a judge
//              (家法⑤：摘掉修复必须真 FAIL).
//   --report   print the full overlap / orphan / facility tables (no assertions)
//
// Why this bench exists: before 刀3 the map had THIRTEEN cross-front rectangle
// overlaps. A point inside two fronts is counted twice by every reader that asks
// "how strong is this front" — updateFrontPower, commanderMood, the judgment
// rows, the crisis triggers. Nothing ever failed; the numbers were just quietly
// wrong. The invariant below is the thing that was missing, not the fix.
//
// Membership is judged with the PRODUCTION predicate (isInsideFront's closed
// interval), never a bench re-implementation — the dispatch-scope lesson: a
// bench that invents its own front matching burns your hand.
//
// Run (worktree root):
//   npx tsx scripts/ab-mapdata-audit.ts
//   npx tsx scripts/ab-mapdata-audit.ts --negctl
// ============================================================

import { createInitialGameState } from "@ai-commander/core";
import { isInsideFront } from "../packages/core/src/frontDestination";
import type { GameState, Front, Region } from "@ai-commander/shared";

const NEGCTL = process.argv.includes("--negctl");
const REPORT = process.argv.includes("--report");

let pass = 0;
let fail = 0;
/** ids of the assertions that went red, in declaration order. negctl compares the
 *  SET, not the count: a negative control that only counts FAILs cannot tell
 *  "the fix is load-bearing" from "one tooth died and another broke"
 *  (第 8 级审计实证：ab-approval-v4 的 48→47 背后是 6 掉 4 塌). */
const redIds: string[] = [];
function check(id: string, name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`PASS ${id} ${name}`);
  } else {
    fail += 1;
    redIds.push(id);
    console.log(`FAIL ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── The map under test ──

function buildState(): GameState {
  const state = createInitialGameState("el_alamein");
  if (NEGCTL) {
    // Restore ONE pre-刀3 rectangle: central_desert's old west+south edges, which
    // swallowed the Axis rear whole (60×60) and reached under alam_halfa. One
    // rectangle is enough — the invariant is "at most one front", so a single
    // regression must be enough to break it, or it is not an invariant.
    const cd = state.regions.get("central_desert");
    if (!cd) throw new Error("negctl: central_desert missing");
    cd.bbox = [120, 80, 370, 140];
  }
  return state;
}

const state = buildState();
const regions = Array.from(state.regions.values());
const fronts = state.fronts;

/** Every integer tile the map data can address. */
const MAP_W = state.mapWidth;
const MAP_H = state.mapHeight;

// ── Which fronts claim a point? (production predicate only) ──

function frontsAt(x: number, y: number): Front[] {
  return fronts.filter((f) => isInsideFront(state, f, { x, y }));
}

// ============================================================
// ① 任何一点至多属于一条战线（front level, whole map)
// ============================================================

function assertOnePointOneFront(): void {
  let doubled = 0;
  let firstExample = "";
  const pairSeen = new Set<string>();
  for (let x = 0; x <= MAP_W; x++) {
    for (let y = 0; y <= MAP_H; y++) {
      const claims = frontsAt(x, y);
      if (claims.length <= 1) continue;
      doubled += 1;
      const key = claims.map((f) => f.id).sort().join("+");
      if (!pairSeen.has(key)) {
        pairSeen.add(key);
        if (!firstExample) firstExample = `(${x},${y}) → ${key}`;
      }
    }
  }
  check(
    "①",
    "全图任何一点至多属于一条战线",
    doubled === 0,
    doubled === 0 ? "" : `${doubled} 格被多条战线认领；首例 ${firstExample}；组合 [${[...pairSeen].join(" / ")}]`,
  );
}

// ============================================================
// ② 每个设施：declared regionId 的 bbox 必须含其坐标
// ============================================================

function assertFacilityInsideDeclaredRegion(): void {
  const bad: string[] = [];
  state.facilities.forEach((f) => {
    const r: Region | undefined = state.regions.get(f.regionId);
    if (!r) {
      bad.push(`${f.id}: regionId="${f.regionId}" 不存在`);
      return;
    }
    const inside =
      f.position.x >= r.bbox[0] && f.position.x <= r.bbox[2] &&
      f.position.y >= r.bbox[1] && f.position.y <= r.bbox[3];
    if (!inside) {
      bad.push(`${f.id} (${f.position.x},${f.position.y}) ∉ ${r.id} [${r.bbox.join(",")}]`);
    }
  });
  check("②", "设施坐标落在它自称的 region 里", bad.length === 0, bad.join(" ; "));
}

// ============================================================
// ③ 每个设施：几何认领的战线 ≤1，且与 regionId 推出的战线一致
// ============================================================

function frontOfRegion(regionId: string): Front | null {
  return fronts.find((f) => f.regionIds.includes(regionId)) ?? null;
}

function assertFacilityFrontAgrees(): void {
  const bad: string[] = [];
  state.facilities.forEach((f) => {
    const geo = frontsAt(f.position.x, f.position.y);
    if (geo.length > 1) {
      bad.push(`${f.id} 几何双认领 [${geo.map((g) => g.id).join(",")}]`);
      return;
    }
    const declared = frontOfRegion(f.regionId);
    // A region outside every front (british_hq_area) is legal — then geometry
    // must agree that this point belongs to no front either.
    const geoId = geo[0]?.id ?? null;
    const decId = declared?.id ?? null;
    if (geoId !== decId) {
      bad.push(`${f.id} 几何=${geoId ?? "(none)"} 但 regionId 推出=${decId ?? "(none)"}`);
    }
  });
  check("③", "设施的几何战线与 regionId 战线一致（且不双认领）", bad.length === 0, bad.join(" ; "));
}

// ============================================================
// ④ region.facilities[] 是 facility.regionId 的单向派生（第三份真相源收敛）
//
// 这一条不是本刀新造的病：修前三个玩家前哨不在任何 region 的清单里，
// 而 enemyAI.frontHasFacility 读的正是这份清单。合并成一份，台架盯着它别再分家。
// ============================================================

function assertRegionFacilityListsDerived(): void {
  const derived = new Map<string, string[]>();
  for (const r of regions) derived.set(r.id, []);
  state.facilities.forEach((f) => {
    const list = derived.get(f.regionId);
    if (list) list.push(f.id);
  });
  const bad: string[] = [];
  for (const r of regions) {
    const want = [...(derived.get(r.id) ?? [])].sort();
    const got = [...r.facilities].sort();
    if (want.join("|") !== got.join("|")) {
      bad.push(`${r.id}: 清单=[${got.join(",")}] 派生=[${want.join(",")}]`);
    }
  }
  check("④", "region.facilities[] == 由 facility.regionId 派生的清单", bad.length === 0, bad.join(" ; "));
}

// ============================================================
// ⑤ 缝隙预算（不是断言零，是断言"没有偷偷长大"）
//
// R5 裁定：宁留无主薄缝不留双主重叠。所以这里钉的是 KNOWN 数量。
//
// 「缝」的定义要精确，否则这条断言测的是别的东西：**不属于任何战线、但上下（或左右）
// 8 格内两侧都有战线的格子**。这样才只数"战线织物上的洞"——大本营区（有意不属任何
// 战线）与地图边上从来没人要的开阔沙漠都不算数，它们不是本刀造的，也不是本刀该管的。
// 一个兵站在洞里，对每一个"这条线多强"的读者都是隐形的（#153 那笔账就是这么来的）。
//
// 登记值来自本刀落地实测：300 格 = y138-139 中央↔南部 250 + x200-209×y76-80 山脊↔中央 50
// （后者是修前就有的老缝，本刀让它从 4 行变 5 行，一并登记）。
// ============================================================

const SEAM_BUDGET = 300;
const SEAM_LOOK = 8;

function assertSeamBudget(): void {
  const claim: (string | null)[][] = [];
  for (let y = 0; y <= MAP_H; y++) {
    claim[y] = [];
    for (let x = 0; x <= MAP_W; x++) {
      const c = frontsAt(x, y);
      claim[y][x] = c.length === 1 ? c[0].id : (c.length > 1 ? "MULTI" : null);
    }
  }
  let holes = 0;
  const rows = new Map<number, number>();
  const between = new Map<string, number>();
  for (let y = 0; y <= MAP_H; y++) {
    for (let x = 0; x <= MAP_W; x++) {
      if (claim[y][x] !== null) continue;
      let up: string | null = null, down: string | null = null;
      let left: string | null = null, right: string | null = null;
      for (let d = 1; d <= SEAM_LOOK; d++) {
        if (up === null && y - d >= 0) up = claim[y - d][x];
        if (down === null && y + d <= MAP_H) down = claim[y + d][x];
        if (left === null && x - d >= 0) left = claim[y][x - d];
        if (right === null && x + d <= MAP_W) right = claim[y][x + d];
      }
      const vert = up !== null && down !== null;
      const horiz = left !== null && right !== null;
      if (!vert && !horiz) continue;
      holes += 1;
      rows.set(y, (rows.get(y) ?? 0) + 1);
      const k = vert ? `${up}|${down}` : `${left}|${right}`;
      between.set(k, (between.get(k) ?? 0) + 1);
    }
  }
  const top = [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([y, n]) => `y${y}:${n}`).join(" ");
  const pairs = [...between.entries()].map(([k, n]) => `${k}=${n}`).join(" ");
  check(
    "⑤",
    `战线之间的缝 == 登记值 ${SEAM_BUDGET} 格（缝可以有，不许悄悄变大）`,
    holes === SEAM_BUDGET,
    `实得 ${holes}（登记 ${SEAM_BUDGET}）主要行 ${top}；两侧 ${pairs}`,
  );
}

// ============================================================
// ⑥ 开局没有任何单位被双计（效果级：不变量真的在保护读数）
// ============================================================

function assertNoUnitDoubleCounted(): void {
  const bad: string[] = [];
  state.units.forEach((u) => {
    const claims = frontsAt(Math.round(u.position.x), Math.round(u.position.y));
    if (claims.length > 1) {
      bad.push(`#${u.id} ${u.team} (${u.position.x},${u.position.y}) → ${claims.map((c) => c.id).join("+")}`);
    }
  });
  check(
    "⑥",
    "开局零单位被两条战线同时计入（战力/判读/危机读数不再重复记账）",
    bad.length === 0,
    `${bad.length} 个：${bad.slice(0, 5).join(" ; ")}`,
  );
}

// ── report mode ──

function runReport(): void {
  console.log("\n== region 两两交叠（same=同战线，合法嵌套；CROSS=违反不变量）==");
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      const x1 = Math.max(a.bbox[0], b.bbox[0]), x2 = Math.min(a.bbox[2], b.bbox[2]);
      const y1 = Math.max(a.bbox[1], b.bbox[1]), y2 = Math.min(a.bbox[3], b.bbox[3]);
      if (x1 > x2 || y1 > y2) continue;
      const fa = frontOfRegion(a.id)?.id ?? "(none)";
      const fb = frontOfRegion(b.id)?.id ?? "(none)";
      const tag = fa === fb ? "same " : (fa === "(none)" || fb === "(none)" ? "nofrnt" : "CROSS");
      console.log(`  ${tag} ${a.id.padEnd(20)} × ${b.id.padEnd(20)} [${x1},${y1},${x2},${y2}]  ${fa} vs ${fb}`);
    }
  }
  console.log("\n== 每条战线的设施 ==");
  for (const f of fronts) {
    const facs: string[] = [];
    state.facilities.forEach((fac) => {
      if (isInsideFront(state, f, fac.position)) facs.push(`${fac.id}(${fac.team})`);
    });
    console.log(`  ${f.id.padEnd(18)} ${facs.join(", ") || "(无)"}`);
  }
}

// ── main ──

/** negctl 期望：把 central_desert 一个矩形放回旧值，必须恰好这几条红。
 *  钉的是**集合**不是条数——本级审计实测过 48→47 这种"掉一颗牙、塌一条前置"
 *  的换手，只看条数完全看不见。 */
const EXPECTED_NEGCTL_RED = ["①", "③", "⑤", "⑥"];

console.log("=== ab-mapdata-audit (envelope-precision 刀3) ===");
if (NEGCTL) {
  console.log(
    `=== NEGCTL 模式：central_desert 回旧值 [120,80,370,140]，恰 [${EXPECTED_NEGCTL_RED.join(",")}] 必须 FAIL ===`,
  );
  console.log("    ②④ 保持绿是对的：它们量的是 regionId/清单的自洽，不受矩形边界影响。");
}

if (REPORT) {
  runReport();
} else {
  assertOnePointOneFront();
  assertFacilityInsideDeclaredRegion();
  assertFacilityFrontAgrees();
  assertRegionFacilityListsDerived();
  assertSeamBudget();
  assertNoUnitDoubleCounted();

  console.log(`\nPASS=${pass} FAIL=${fail}`);
  if (NEGCTL) {
    const got = [...redIds].sort().join(",");
    const want = [...EXPECTED_NEGCTL_RED].sort().join(",");
    const ok = got === want;
    console.log(
      ok
        ? `NEGCTL OK — 红的正是 [${redIds.join(",")}]，不变量确实承重`
        : `NEGCTL BAD — 期望红 [${want}] 实得红 [${got || "(无)"}]：` +
          "不变量与负对照对不上，先查是哪一边变了，不许改期望迁就实测",
    );
    process.exit(ok ? 0 : 1);
  } else {
    console.log(fail === 0 ? "ALL PASS" : `${fail} FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
}
