// ============================================================
// AI Commander — 手测账① 路线丢弃（非 v4；执行链修复）
//
// 现场：玩家说「Blake，走南部山路，占领中央雷达」，兵没走南部山路。
// 病灶：createOrdersWithSpread 有 8 个形参（第 7/8 = routeId/routeIds），
// 但 resolveAttack 之外的五个调用点只传到第 6 个 —— 路线在实参层被静默
// 截断。数据与 prompt 都是好的（southern_pass 名为「南部山路」，与玩家用词
// 逐字一致；ai.ts:269 教了 routeId）。
//
// 判据（Fable 裁定）：数 WAYPOINTS，不验字段透传。字段传对而路线没生效，
// 是这类修复最容易假绿的地方。
//
//   npx tsx scripts/ab-handtest-route.ts --synthetic
//   npx tsx scripts/ab-handtest-route.ts --negctl
// ============================================================

import { createInitialGameState, resolveIntent } from "@ai-commander/core";
import type { GameState, Unit, Intent, Position } from "@ai-commander/shared";

let passCount = 0;
let failCount = 0;
const NEGCTL = process.argv[2] === "--negctl";

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) passCount++;
  else failCount++;
}
function checkKnife(name: string, after: boolean, before: boolean, detail = ""): void {
  check(`★ ${name}`, NEGCTL ? before : after, detail);
}

function emptyBattlefield(): GameState {
  const s = createInitialGameState("el_alamein");
  s.units.clear();
  s.squads = [];
  s.missions = [];
  return s;
}

let templateUnit: Unit | null = null;
function unitTemplate(): Unit {
  if (!templateUnit) {
    const s = createInitialGameState("el_alamein");
    let found: Unit | null = null;
    s.units.forEach((u) => { if (!found && u.team === "player" && u.type === "infantry") found = u; });
    if (!found) throw new Error("no player infantry");
    templateUnit = found;
  }
  return templateUnit;
}

let nextId = 7000;
function addUnit(state: GameState, x: number, y: number, over: Partial<Unit> = {}): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate()),
    id: nextId++, position: { x, y }, state: "idle", orders: [], waypoints: [],
    patrolPoints: [], patrolTaskId: null, lastAttackTime: 0, manualOverride: false,
    target: null, attackTarget: null, ...over,
  };
  state.units.set(u.id, u);
  return u;
}

const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);

/** How close does this order's path actually come to the named route's own line? */
function minDistToRoute(state: GameState, wps: Position[] | undefined, routeId: string): number {
  const route = state.namedRoutes.find((r) => r.id === routeId);
  if (!route || !wps || wps.length === 0) return Infinity;
  let best = Infinity;
  for (const w of wps) for (const rw of route.waypoints) best = Math.min(best, dist(w, rw));
  return best;
}

function runAll(): void {
  const s = emptyBattlefield();
  s.time = 100;
  const route = s.namedRoutes.find((r) => r.id === "southern_pass");
  check("R0 前置 southern_pass 存在且名为「南部山路」", !!route && route.name === "南部山路",
    route ? route.name : "缺失");
  if (!route) return;

  // Units start far from the route's line so a route-following path is
  // measurably different from a straight line.
  const start = { x: 470, y: 40 };
  const ids = [addUnit(s, start.x, start.y).id, addUnit(s, start.x + 1, start.y).id];
  const target = s.facilities.get([...s.facilities.keys()].find((k) => {
    const f = s.facilities.get(k)!; return f.name.includes("雷达") || f.tags.some((t) => t.includes("radar"));
  }) ?? "") ?? null;
  check("R1 前置 找到雷达类设施作占领目标", !!target, target ? target.name : "无");
  if (!target) return;

  const base: Intent = { type: "capture", targetFacility: target.id, quantity: 2 };

  // ── ① capture WITH an explicit route ──
  const withRoute = resolveIntent({ ...base, routeId: "southern_pass" }, s, s.style, undefined, ids);
  const wpsWith = withRoute.orders[0]?.waypoints;
  check("R2 前置 带路线的占领单产出了 orders", withRoute.orders.length > 0, withRoute.log);

  const dWith = minDistToRoute(s, wpsWith, "southern_pass");
  checkKnife(
    "R3 ★占领单真的走上了南部山路（数路点，不验字段）",
    Number.isFinite(dWith) && dWith <= 8,
    !Number.isFinite(dWith) || dWith > 8,
    `路点数=${wpsWith?.length ?? 0} 距路线最近=${Number.isFinite(dWith) ? dWith.toFixed(1) : "∞"} 格`,
  );
  checkKnife(
    "R4 ★带路线时路点非空（截断时这里是空/仅自动选路）",
    (wpsWith?.length ?? 0) > 0,
    (wpsWith?.length ?? 0) === 0,
    `${wpsWith?.length ?? 0} 个路点`,
  );

  // ── ② 同族四动词：defend / retreat / recon / sabotage ──
  const fam: { name: string; intent: Intent }[] = [
    { name: "defend", intent: { type: "defend", targetFacility: target.id, quantity: 2, routeId: "southern_pass" } },
    { name: "recon", intent: { type: "recon", targetFacility: target.id, quantity: 2, routeId: "southern_pass" } },
    { name: "sabotage", intent: { type: "sabotage", targetFacility: target.id, quantity: 2, routeId: "southern_pass" } },
  ];
  for (const f of fam) {
    const r = resolveIntent(f.intent, s, s.style, undefined, ids);
    const d = minDistToRoute(s, r.orders[0]?.waypoints, "southern_pass");
    checkKnife(
      `R5-${f.name} ★同族动词也走上了南部山路`,
      r.orders.length > 0 && Number.isFinite(d) && d <= 8,
      r.orders.length > 0 && (!Number.isFinite(d) || d > 8),
      `orders=${r.orders.length} 距路线=${Number.isFinite(d) ? d.toFixed(1) : "∞"}`,
    );
  }

  // ── ③ 安全性质：不指定路线时行为不变（本修复是纯加法）──
  const noRoute = resolveIntent({ ...base }, s, s.style, undefined, ids);
  check(
    "R6 不指定路线时仍产出 orders（修复是纯加法，不改默认行为）",
    noRoute.orders.length === withRoute.orders.length && noRoute.orders.length > 0,
    `无路线=${noRoute.orders.length} 有路线=${withRoute.orders.length}`,
  );

  // ── ④ 幻觉路线不得改变结果（LLM 编个不存在的路 → 静默忽略，不炸单）──
  const bogus = resolveIntent({ ...base, routeId: "no_such_road" }, s, s.style, undefined, ids);
  check(
    "R7 不存在的路线被安全忽略，命令照常执行",
    bogus.orders.length === noRoute.orders.length && bogus.orders.length > 0,
    `bogus=${bogus.orders.length}`,
  );
}

function main(): void {
  if (NEGCTL) console.log("=== NEGCTL：★ 持修复前预期（六参截断），必须出 FAIL ===");
  console.log("== 手测账① 路线丢弃 ==");
  runAll();
  console.log(`\nPASS=${passCount} FAIL=${failCount}`);
  if (NEGCTL) {
    console.log(failCount > 0 ? `NEGCTL OK — ${failCount} 条 ★ 真 FAIL` : "NEGCTL BAD — 断言不承重");
  } else {
    console.log(failCount === 0 ? "ALL PASS" : `${failCount} FAILED`);
  }
}

const mode = process.argv[2];
if (mode === "--synthetic" || mode === "--negctl") main();
else console.log("usage: tsx scripts/ab-handtest-route.ts --synthetic | --negctl");
