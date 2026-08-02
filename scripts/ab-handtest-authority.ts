// ============================================================
// AI Commander — 手测账③ 调度权按人格算（非 v4）
//
// 现场：玩家对 Emily（后勤）说「Drake，派你的两个 light tank 去占领沿海雷达
// 站」，Emily 照办了 —— Drake 挂在 Chen 名下，Emily 名下是空的。
//
// ★ Fable 裁定的补全：只闸「点名的队」堵不住同族的另一半。Emily 不点名、
// 直接说「派两个坦克去占雷达」，Bucket A 照样从全局池抓兵。所以规则按人格算，
// 不按点名算 —— 本档两条都要有牙。
//
//   npx tsx scripts/ab-handtest-authority.ts --synthetic
//   npx tsx scripts/ab-handtest-authority.ts --negctl
// ============================================================

import { createInitialGameState } from "@ai-commander/core";
import {
  checkDispatchAuthority, commanderDispatchPool, isDispatchIntent, combatRoleHolder,
} from "../packages/core/src/commandAuthority";
import { COMMANDER_CHANNEL } from "@ai-commander/shared";
import type { GameState, Unit, Squad, Intent } from "@ai-commander/shared";

let passCount = 0;
let failCount = 0;
const NEGCTL = process.argv[2] === "--negctl";

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) passCount++; else failCount++;
}
function checkKnife(name: string, after: boolean, before: boolean, detail = ""): void {
  check(`★ ${name}`, NEGCTL ? before : after, detail);
}

function emptyBattlefield(): GameState {
  const s = createInitialGameState("el_alamein");
  s.units.clear(); s.squads = []; s.missions = [];
  return s;
}
let tpl: Unit | null = null;
function unitTemplate(): Unit {
  if (!tpl) {
    const s = createInitialGameState("el_alamein");
    let f: Unit | null = null;
    s.units.forEach((u) => { if (!f && u.team === "player" && u.type === "infantry") f = u; });
    if (!f) throw new Error("no infantry");
    tpl = f;
  }
  return tpl;
}
let nextId = 6000;
function addUnit(s: GameState, x: number, y: number, over: Partial<Unit> = {}): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate()), id: nextId++, position: { x, y }, state: "idle",
    orders: [], waypoints: [], patrolPoints: [], patrolTaskId: null, lastAttackTime: 0,
    manualOverride: false, target: null, attackTarget: null, ...over,
  };
  s.units.set(u.id, u);
  return u;
}
function addSquad(s: GameState, ids: number[], over: Partial<Squad>): Squad {
  const sq: Squad = {
    id: over.id ?? `B${nextId++}`, name: "bench", unitIds: ids,
    leader: { name: over.leaderName ?? "Bench", rank: "sergeant" as Squad["leader"]["rank"], personality: "balanced" },
    currentMission: null, missionTarget: null, morale: 1, formationStyle: "line",
    ownerCommander: "chen", leaderName: "Bench", role: "leader", ...over,
  };
  s.squads.push(sq);
  return sq;
}

const dispatch: Intent = { type: "capture", targetFacility: "x", quantity: 2 };

function run(): void {
  console.log("== 手测账③ 调度权按人格算 ==");

  // 复刻现场：Drake 挂 Chen 名下，Emily/Marcus 名下皆空。
  const s = emptyBattlefield();
  s.time = 100;
  const drakeIds = [addUnit(s, 300, 100).id, addUnit(s, 301, 100).id];
  addSquad(s, drakeIds, { id: "T4", leaderName: "Drake", ownerCommander: "chen" });
  const loose = [addUnit(s, 320, 100).id, addUnit(s, 321, 100).id]; // 未编组

  check("A0 前置 战斗角色由查表得出，非硬编码字符串",
    COMMANDER_CHANNEL[combatRoleHolder()] === "combat", combatRoleHolder());

  // ── ① 无兵人格：任何调度 intent 零执行（不点名也拦得住）──
  const emilyPool = commanderDispatchPool(s, "emily");
  check("A1 Emily 名下可调池为空", emilyPool.length === 0, `${emilyPool.length}`);

  checkKnife(
    "A2 ★点名版★ Emily 点名 Drake → 拒绝（现场那一句）",
    checkDispatchAuthority(s, "emily", { ...dispatch, fromSquad: "Drake" }).kind === "denied",
    checkDispatchAuthority(s, "emily", { ...dispatch, fromSquad: "Drake" }).kind === "allowed",
    checkDispatchAuthority(s, "emily", { ...dispatch, fromSquad: "Drake" }).kind,
  );
  checkKnife(
    "A3 ★不点名版★ Emily 不点名「派两个坦克去占雷达」→ 同样拒绝（Fable 补全的那一半）",
    checkDispatchAuthority(s, "emily", dispatch).kind === "denied",
    checkDispatchAuthority(s, "emily", dispatch).kind === "allowed",
    checkDispatchAuthority(s, "emily", dispatch).kind,
  );
  const v = checkDispatchAuthority(s, "emily", dispatch);
  check("A4 拒绝理由是结构事实（供人格开口用），非成品台词",
    v.kind === "denied" && v.reason === "commands_no_forces",
    v.kind === "denied" ? v.reason : v.kind);

  // ── ② 生产/交易不受影响 ──
  check("A5 Emily 生产不受影响", checkDispatchAuthority(s, "emily", { type: "produce", produceType: "infantry" }).kind === "not_dispatch");
  check("A6 Emily 交易不受影响", checkDispatchAuthority(s, "emily", { type: "trade", tradeAction: "buy_fuel" }).kind === "not_dispatch");
  check("A7 isDispatchIntent 只把 produce/trade 排除在外",
    !isDispatchIntent("produce") && !isDispatchIntent("trade") &&
    isDispatchIntent("capture") && isDispatchIntent("retreat") && isDispatchIntent("defend"));

  // ── ③ 有兵人格照常，且未编组归战斗角色 ──
  const chenPool = commanderDispatchPool(s, "chen");
  check("A8 Chen 池含自己的队 + 未编组散兵",
    drakeIds.every((i) => chenPool.includes(i)) && loose.every((i) => chenPool.includes(i)),
    `${chenPool.length} 个`);
  check("A9 Chen 点名自己的 Drake → 放行",
    checkDispatchAuthority(s, "chen", { ...dispatch, fromSquad: "Drake" }).kind === "allowed");

  // ── ④ 角色改派，规则跟着走（不写死 Chen）──
  const s2 = emptyBattlefield();
  s2.time = 100;
  const l2 = [addUnit(s2, 300, 100).id];
  addSquad(s2, l2, { id: "T9", leaderName: "Ann", ownerCommander: "marcus" });
  addUnit(s2, 330, 100); // 未编组
  check("A10 Marcus 有了自己的队就调得动",
    checkDispatchAuthority(s2, "marcus", { ...dispatch, fromSquad: "Ann" }).kind === "allowed");
  check("A11 未编组散兵不归 Marcus（他不持战斗角色）",
    commanderDispatchPool(s2, "marcus").length === 1, `${commanderDispatchPool(s2, "marcus").length}`);

  // ── ⑤ 跨人格点名：必须在「他自己有兵」的局里测，否则先撞 commands_no_forces
  //     （那个理由更准确，不是 bug）。s2 里 Marcus 有 Ann，再给 Chen 一支队。
  addSquad(s2, [addUnit(s2, 360, 100).id], { id: "T7", leaderName: "Zed", ownerCommander: "chen" });
  check("A12a 前置 Marcus 在本局确实有兵（否则测不到跨人格分支）",
    commanderDispatchPool(s2, "marcus").length > 0);
  const cross = checkDispatchAuthority(s2, "marcus", { ...dispatch, fromSquad: "Zed" });
  checkKnife(
    "A12 ★ Marcus 有兵但点 Chen 的 Zed → 拒绝，且报出该队真正归属",
    cross.kind === "denied" && cross.reason === "squad_not_theirs" && cross.ownerOfNamed === "chen",
    cross.kind === "allowed",
    cross.kind === "denied" ? `${cross.reason}/${cross.ownerOfNamed}` : cross.kind,
  );

  // ── ⑥ 尸体不构成兵权 ──
  for (const id of drakeIds) { const u = s.units.get(id); if (u) { u.hp = 0; u.state = "dead"; } }
  for (const id of loose) { const u = s.units.get(id); if (u) { u.hp = 0; u.state = "dead"; } }
  check("A13 全员阵亡后 Chen 也无兵可调（尸体不是兵权）",
    commanderDispatchPool(s, "chen").length === 0 &&
    checkDispatchAuthority(s, "chen", dispatch).kind === "denied");
}

function main(): void {
  if (NEGCTL) console.log("=== NEGCTL：★ 持修复前预期（无权限概念），必须出 FAIL ===");
  run();
  console.log(`\nPASS=${passCount} FAIL=${failCount}`);
  if (NEGCTL) console.log(failCount > 0 ? `NEGCTL OK — ${failCount} 条 ★ 真 FAIL` : "NEGCTL BAD");
  else console.log(failCount === 0 ? "ALL PASS" : `${failCount} FAILED`);
}
const mode = process.argv[2];
if (mode === "--synthetic" || mode === "--negctl") main();
else console.log("usage: tsx scripts/ab-handtest-authority.ts --synthetic | --negctl");
