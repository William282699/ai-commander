// ============================================================
// 教学关地图 · 结构探针（probe- 前缀 ⇒ 不进 run-benches）
//
// 为什么要有它：教学关的三条命脉全是**台架碰不到**的东西——
//   ① 敌方 AI 会不会跑（碰它就等于新手被主动扑上来打）
//   ② 玩家那两坨兵分不分得开（分不开＝教学第 1、2 步教不成）
//   ③ **参谋在这张小图上有没有话可说**（digest 空掉＝整个教学关白做）
// 屏幕上看不出这三样，所以用脚本量。
//
// 跑法：npx tsx scripts/probe-tutorial-map.ts
// ============================================================

import { createInitialGameState, isCapturableFacilityType } from "../packages/core/src/index";
import { processPressureDirector } from "../packages/core/src/scenario/elAlamein/pressureDirector";
import { processDefensiveAI } from "../packages/core/src/scenario/elAlamein/defensiveAI";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import type { Unit } from "../packages/shared/src/types";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name} — ${detail}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

const s = createInitialGameState("tutorial");

console.log("\n── ① 地图骨架 ──");
check("尺寸", s.mapWidth === 120 && s.mapHeight === 80, `${s.mapWidth}×${s.mapHeight}`);
check("场景 id", s.scenarioId === "tutorial", String(s.scenarioId));

const facs = [...s.facilities.values()];
const capturable = facs.filter(f => isCapturableFacilityType(f.type));
const myPosts = capturable.filter(f => f.team === "player");
const foePosts = capturable.filter(f => f.team === "enemy");
check("两个据点：我方 1 / 敌方 1", myPosts.length === 1 && foePosts.length === 1,
  `我方[${myPosts.map(f => f.name)}] 敌方[${foePosts.map(f => f.name)}]`);

// ★ 最容易犯的错：把过关目标做成 barracks/headquarters（引擎黑名单，永远打不下来）
const objIds = s.captureObjectives ?? [];
const objs = objIds.map(id => s.facilities.get(id)!).filter(Boolean);
check("过关目标可占", objs.length === 1 && isCapturableFacilityType(objs[0].type),
  `${objs.map(o => `${o.name}(${o.type})`).join()} · 需要 ${s.scenarioWinConfig?.requiredCapturedObjectives} 个`);
check("目标属于敌方", objs.every(o => o.team === "enemy"), objs.map(o => o.team).join());

const barracks = facs.find(f => f.type === "barracks" && f.team === "player");
check("有我方兵营（艾米莉才有得造）", !!barracks, barracks?.name ?? "缺失");
check("有战线（马克斯才有得报）", s.fronts.length >= 1,
  `${s.fronts.length} 条：${s.fronts.map(f => f.name).join()}`);

console.log("\n── ② 敌方 AI 必须不跑 ──");
check("enemyAIMode 缺席", s.enemyAIMode === undefined, String(s.enemyAIMode));

// 效果级：真调那两个函数，看敌方单位会不会被推着动（不看注释、不看字段）
function enemySnapshot(): string {
  return JSON.stringify([...s.units.values()]
    .filter((u: Unit) => u.team === "enemy")
    .map((u: Unit) => [u.id, u.position.x, u.position.y, u.state, u.orders.length]));
}
const before = enemySnapshot();
for (let i = 0; i < 40; i++) {          // 40 × 5s = 200 游戏秒，远超两者的 5s 间隔
  processDefensiveAI(s, 5);
  processPressureDirector(s, 5);
}
const after = enemySnapshot();
check("跑 200 秒后敌军一动不动", before === after,
  before === after ? "两次快照逐字节相同" : "★敌军被推动了——闸没关住");

console.log("\n── ③ 玩家两坨兵必须分得开 ──");
const mine = [...s.units.values()].filter((u: Unit) => u.team === "player" && !u.isPlayerControlled);
const inf = mine.filter((u: Unit) => u.type === "infantry");
const tanks = mine.filter((u: Unit) => u.type === "light_tank");
const cy = (us: Unit[]) => us.reduce((a, u) => a + u.position.y, 0) / us.length;
const gap = Math.abs(cy(inf) - cy(tanks));
check("两坨都非空", inf.length > 0 && tanks.length > 0, `步兵 ${inf.length} / 轻坦 ${tanks.length}`);
// 判据是"一次框选圈不到两坨"——20 格是屏上一框的量级
check("两坨纵向间距 ≥20 格", gap >= 20, `实测 ${gap.toFixed(1)} 格`);
const manual = [...s.units.values()].filter((u: Unit) => u.isPlayerControlled);
check("鼠标点得动的只有指挥官+卫队", manual.every((u: Unit) => u.type === "commander" || u.type === "elite_guard"),
  `${manual.length} 个：${[...new Set(manual.map((u: Unit) => u.type))].join()}`);

console.log("\n── ④ 参谋有没有话可说（最贵的一格）──");
// ★判据自证的教训（首版栽在这）：我原本查的是**分区名**（我军营地/中央谷地/东岭），
//   报"地名缺席"三连红——而地图是好的，是判据错了。拿 el_alamein 当参照量了一次：
//   **分区名 1/16 进信封，设施名 19/19 进**。信封压根不印分区名，它印设施名和战线名。
//   判据要照参照场景的**实际行为**写，不照自己以为的写。
const SPEAKABLE = ["我军兵营", "我方哨站", "敌军哨站"];   // 玩家要能说出口的那几个
for (const ch of ["combat", "ops", "logistics"] as const) {
  const d = buildDigestForChannel(s, ch, undefined, [], undefined, undefined, true);
  const hit = SPEAKABLE.filter(n => d.includes(n));
  const front = d.includes("中央战线");
  // ops 是摘要面，只保证战线名在；combat/logistics 要能指到设施
  const ok = ch === "ops" ? (d.length > 200 && front) : (d.length > 200 && hit.length >= 2);
  check(`${ch} 信封非空且指得到地方`, ok,
    `${d.length} 字节 · 设施名 ${hit.length}/${SPEAKABLE.length} · 战线名${front ? "在" : "缺"}`);
}
const dLog = buildDigestForChannel(s, "logistics", undefined, [], undefined, undefined, true);
check("艾米莉看得见可生产清单", /PRODUCTION|可生产|生产/.test(dLog), "PRODUCTION 节");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
