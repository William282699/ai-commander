// ============================================================
// 教学关地图 · 结构探针（probe- 前缀 ⇒ 不进 run-benches 的硬编码清单）
//
// 跑法：npx tsx scripts/probe-tutorial-map.ts
//
// ★ 本文件第二版。第一版被审核窗抓出**四处假绿**，形状值得留着：
//   ① 绊索装在没承重的闸上——只调 `processDefensiveAI`，而这张图上真正会动
//      敌军的是 `processEnemyAI`（那道闸是**反向**的）。摘掉真闸不红＝假绿。
//   ② `every` 在空数组上恒真——"鼠标点得动的只有指挥官+卫队"把所有单位的
//      `isPlayerControlled` 清成 false 之后仍然绿。
//   ③ `---PRODUCTION---` 是无条件输出的，"艾米莉看得见清单"删光设施还绿。
//   ④ combat 与 logistics 的信封逐字节相同（`digestHelper` 只对 ops 分岔），
//      "三条频道断言"实为两条。
//   共同形状＝**判据没有前置存在性检查，也没被证明会红**。本版每条要么带
//   非空前置，要么在下面的 `--tripwire` 里有对应的摘刀实验。
//
// ★ 还补了第一版整个缺掉的那条：**「用摆出来的兵真的打得通」**。
//   P0-① 就是它漏掉的——地图数据全对、信封全对、派兵全对，而玩家的坦克
//   在引擎里根本占不了点，回执还说"已派出"。判据要测效果，不测配置。
// ============================================================

import { createInitialGameState, isCapturableFacilityType, processEconomy } from "../packages/core/src/index";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { processDefensiveAI } from "../packages/core/src/scenario/elAlamein/defensiveAI";
import { processPressureDirector } from "../packages/core/src/scenario/elAlamein/pressureDirector";
import { processAutoBehavior } from "../packages/core/src/autoBehavior";
import { updateFog } from "../packages/core/src/fog";
import { tick } from "../packages/core/src/sim";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { centerCameraOn, getMinZoom } from "../apps/web/src/input";
import { factionGlowScale, unitRingBase } from "../apps/web/src/rendererCanvas";
import type { GameState, Unit, UnitType } from "../packages/shared/src/types";
import { TILE_SIZE } from "../packages/shared/src/constants";

const TRIPWIRE = process.argv.includes("--tripwire");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name} — ${detail}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

const s = createInitialGameState("tutorial");

// ────────────────────────────────────────────────
console.log("\n── ① 地图骨架 ──");
check("尺寸", s.mapWidth === 120 && s.mapHeight === 80, `${s.mapWidth}×${s.mapHeight}`);
check("场景 id", s.scenarioId === "tutorial", String(s.scenarioId));

const facs = [...s.facilities.values()];
check("设施表非空", facs.length > 0, `${facs.length} 个`);          // ← ③ 那类假绿的前置
const capturable = facs.filter(f => isCapturableFacilityType(f.type));
check("三个可占点（我方哨站/烽火台/敌军哨站）", capturable.length === 3,
  capturable.map(f => `${f.name}:${f.team}`).join(" "));

const objIds = s.captureObjectives ?? [];
const objs = objIds.map(id => s.facilities.get(id)!).filter(Boolean);
check("过关目标唯一且可占且属敌",
  objs.length === 1 && isCapturableFacilityType(objs[0].type) && objs[0].team === "enemy",
  objs.map(o => `${o.name}(${o.type},${o.team})`).join());
check("通关文案不是「阿拉曼大捷」", !!s.scenarioWinConfig?.victoryLabel,
  s.scenarioWinConfig?.victoryLabel ?? "★缺席，会喊阿拉曼大捷");

const barracks = facs.find(f => f.type === "barracks" && f.team === "player");
check("有我方兵营（艾米莉才有得造）", !!barracks, barracks?.name ?? "缺失");
check("有战线", s.fronts.length >= 1, `${s.fronts.length} 条：${s.fronts.map(f => f.name).join()}`);
// ★ 战线必须真盖住玩家的兵，否则马克斯手上是空的（审核挖出）
const baseCovered = s.fronts.some(f => f.regionIds.includes("tut_base"));
check("战线盖住玩家所在的营地区", baseCovered,
  `regionIds=[${s.fronts[0].regionIds.join()}]`);

// ────────────────────────────────────────────────
console.log("\n── ② 敌方 AI 必须不跑（★绊索改装在真闸上）──");
check("enemyAIMode === \"none\"", s.enemyAIMode === "none", String(s.enemyAIMode));

function enemyPosSnapshot(st: GameState): string {
  return JSON.stringify([...st.units.values()]
    .filter((u: Unit) => u.team === "enemy")
    .map((u: Unit) => [u.id, +u.position.x.toFixed(3), +u.position.y.toFixed(3), u.state, u.orders.length]));
}
{
  const g = createInitialGameState("tutorial");
  const before = enemyPosSnapshot(g);
  // ★ 镜像生产循环序（GameCanvas）：光跑 tick() 测不到自动行为与敌方 AI。
  //   处处都要有 processEnemyAI——它才是这张图上会动敌军的那个。
  for (let i = 0; i < 60; i++) {
    tick(g, 5);
    processEnemyAI(g, 5);
    processDefensiveAI(g, 5);
    processPressureDirector(g, 5);
    processAutoBehavior(g, 5);
    updateFog(g);
  }
  const after = enemyPosSnapshot(g);
  check("跑 300 游戏秒后敌军原地不动", before === after,
    before === after ? "位置/状态/单数逐字节相同" : "★敌军动了——闸没关住");
}

// ────────────────────────────────────────────────
console.log("\n── ③ ★这张图用摆出来的兵真的打得通（P0-① 漏掉的那条）──");
/** 把某类型的玩家单位瞬移到设施上，跑经济结算，看它到底占不占得下来。
 *  判据是**引擎里那面旗子翻没翻**，不是回执说了什么。 */
function canCaptureWith(type: UnitType, facId: string): { ok: boolean; secs: number } {
  const g = createInitialGameState("tutorial");
  const fac = g.facilities.get(facId)!;
  const movers = [...g.units.values()].filter(u => u.team === "player" && u.type === type);
  if (movers.length === 0) return { ok: false, secs: -1 };
  for (const u of movers) { u.position = { x: fac.position.x, y: fac.position.y }; }
  for (let t = 0; t < 400; t++) {
    processEconomy(g, 1);
    if (g.facilities.get(facId)!.team === "player") return { ok: true, secs: t + 1 };
  }
  return { ok: false, secs: -1 };
}
for (const t of ["infantry", "light_tank"] as UnitType[]) {
  const r = canCaptureWith(t, "tut_enemy_post");
  check(`${t} 占得下过关目标`, r.ok, r.ok ? `${r.secs}s 拿下` : "★400s 拿不下——占领谓词又分家了");
}
{
  // 指挥官/卫队是唯一鼠标点得动的单位；旧规则 `type === "infantry"` 把它们也挡了
  const r = canCaptureWith("elite_guard", "tut_enemy_post");
  check("elite_guard 占得下（鼠标能点的那批）", r.ok, r.ok ? `${r.secs}s 拿下` : "★拿不下");
}

// ────────────────────────────────────────────────
console.log("\n── ④ 烽火台＝迷雾的钥匙 ──");
{
  const g = createInitialGameState("tutorial");
  const beacon = g.facilities.get("tut_beacon")!;
  check("烽火台是中立、无人守", beacon.team === "neutral"
    && ![...g.units.values()].some(u => u.team === "enemy"
      && Math.hypot(u.position.x - beacon.position.x, u.position.y - beacon.position.y) < 10),
    `team=${beacon.team}`);

  updateFog(g);
  const post = g.facilities.get("tut_enemy_post")!;
  const hq = g.facilities.get("tut_enemy_hq")!;
  const vis = (p: { x: number; y: number }) => g.fog[Math.floor(p.y)][Math.floor(p.x)];
  check("占之前：敌军哨站看不见", vis(post.position) === "unknown", `fog=${vis(post.position)}`);

  // 走上去占（中立设施——LEDGER §G2 记过中立占领的账，所以这里实测不推理）
  const inf = [...g.units.values()].filter(u => u.team === "player" && u.type === "infantry");
  for (const u of inf) u.position = { x: beacon.position.x, y: beacon.position.y };
  let took = -1;
  for (let t = 0; t < 400; t++) {
    processEconomy(g, 1);
    if (g.facilities.get("tut_beacon")!.team === "player") { took = t + 1; break; }
  }
  check("中立烽火台占得下来（§G2 那笔账没咬到这里）", took > 0,
    took > 0 ? `${took}s 拿下` : "★占不下——中立设施捕获有问题");

  updateFog(g);
  check("占之后：敌军哨站被照亮", vis(post.position) !== "unknown", `fog=${vis(post.position)}`);
  // ★ 反向也要成立：照到总部就等于把玩家引向那条不该走的通关路
  check("占之后：敌军指挥部仍看不见（别引向总部）", vis(hq.position) === "unknown", `fog=${vis(hq.position)}`);
}

// ────────────────────────────────────────────────
console.log("\n── ⑤ 玩家两坨兵：包围盒不重叠 ──");
// ★判据换过一次：原本写「一框圈不到两坨」——那是**不可能满足**的要求（任何一框
//   都能圈住整个视口），审核据这个错前提推出"没有画布尺寸能满足两边"。
//   真需求是「两坨各自圈得干净」＝包围盒不重叠。
const mine = [...s.units.values()].filter((u: Unit) => u.team === "player" && !u.isPlayerControlled);
const inf = mine.filter((u: Unit) => u.type === "infantry");
const tanks = mine.filter((u: Unit) => u.type === "light_tank");
check("两坨都非空", inf.length > 0 && tanks.length > 0, `步兵 ${inf.length} / 轻坦 ${tanks.length}`);
const box = (us: Unit[]) => ({
  y1: Math.min(...us.map(u => u.position.y)), y2: Math.max(...us.map(u => u.position.y)),
});
const bi = box(inf), bt = box(tanks);
const clear = bi.y2 < bt.y1 || bt.y2 < bi.y1;
check("两坨纵向包围盒不重叠", clear, `步兵 y∈[${bi.y1},${bi.y2}] 轻坦 y∈[${bt.y1},${bt.y2}]`);
check("两坨之间留出 ≥10 格空档", Math.abs(bt.y1 - bi.y2) >= 10, `空档 ${Math.abs(bt.y1 - bi.y2)} 格`);

const manual = [...s.units.values()].filter((u: Unit) => u.isPlayerControlled);
check("鼠标点得动的是且只是指挥官+卫队",
  manual.length > 0 && manual.every((u: Unit) => u.type === "commander" || u.type === "elite_guard"),
  `${manual.length} 个：${[...new Set(manual.map((u: Unit) => u.type))].join()}`);  // ← ② 补了非空前置

// ────────────────────────────────────────────────
console.log("\n── ⑥ 开局镜头：玩家得看得见自己的兵 ──");
// 审核实测：镜头对准 HQ(14,40) 时，小画布下自己的兵 0/7 可见（被 clampCamera 顶到 x=0）
for (const [cw, ch] of [[900, 700], [1000, 800], [1280, 668]] as [number, number][]) {
  const cam = { x: 0, y: 0, zoom: 1.0 };
  centerCameraOn(cam, 26, 40, cw, ch, s.mapWidth, s.mapHeight);   // 与 GameCanvas 同一个值
  const TILE = TILE_SIZE;   // ★别抄第二份：第一版硬写 16，生产是 32，判据整段算错
  const x1 = cam.x / TILE, x2 = (cam.x + cw / cam.zoom) / TILE;
  const y1 = cam.y / TILE, y2 = (cam.y + ch / cam.zoom) / TILE;
  const seen = mine.filter(u => u.position.x >= x1 && u.position.x <= x2
    && u.position.y >= y1 && u.position.y <= y2).length;
  check(`${cw}×${ch} 开局看得见自己的兵`, seen === mine.length,
    `${seen}/${mine.length} 可见，视口 x∈[${x1.toFixed(1)},${x2.toFixed(1)}]`);
}

// ────────────────────────────────────────────────
console.log("\n── ⑦ 参谋有没有话可说 ──");
// combat 与 logistics 信封逐字节相同（digestHelper 只对 ops 分岔）⇒ 如实当一条测
const dCombat = buildDigestForChannel(s, "combat", undefined, [], undefined, undefined, true);
const dOps = buildDigestForChannel(s, "ops", undefined, [], undefined, undefined, true);
const dLog = buildDigestForChannel(s, "logistics", undefined, [], undefined, undefined, true);
check("combat 与 logistics 确实同源（如实记，不当两条）", dCombat === dLog,
  `${dCombat.length} vs ${dLog.length} 字节`);

const SPEAKABLE = ["我军兵营", "我方哨站", "敌军哨站", "烽火台"];
const hit = SPEAKABLE.filter(n => dCombat.includes(n));
check("陈/艾米莉的信封指得到地方", dCombat.length > 200 && hit.length >= 3,
  `${dCombat.length} 字节 · 设施名 ${hit.length}/${SPEAKABLE.length} [${hit.join()}]`);
check("艾米莉的可生产清单里真有东西",
  /infantry\[|light_tank\[|main_tank\[/.test(dLog), "PRODUCTION ground 行有单价");  // ← ③ 换成有内容才算
// ★ 马克斯：战线补上 tut_base 之后，OurPwr 不该再是 0
const ourPwr = /OurPwr=(\d+(?:\.\d+)?)/.exec(dOps) ?? /OurPwr=(\d+(?:\.\d+)?)/.exec(dCombat);
check("马克斯手上不是空的（OurPwr > 0）", !!ourPwr && parseFloat(ourPwr[1]) > 0,
  ourPwr ? `OurPwr=${ourPwr[1]}` : "★没找到 OurPwr");
check("ops 面不再是 EMPTY?/QUIET", !dOps.includes("EMPTY?"),
  dOps.includes("EMPTY?") ? "★仍是 EMPTY?" : "有内容");

// ────────────────────────────────────────────────
if (TRIPWIRE) {
  console.log("\n── ⑧ 绊索自证（--tripwire）──");
  // 摘掉捕获谓词的修复 ⇒ ③ 的坦克那条必须变红
  const g = createInitialGameState("tutorial");
  (g as unknown as { scenarioId: string }).scenarioId = "dual_island";   // 走回"只有步兵"那侧
  const fac = g.facilities.get("tut_enemy_post")!;
  for (const u of [...g.units.values()].filter(u => u.team === "player" && u.type === "light_tank")) {
    u.position = { x: fac.position.x, y: fac.position.y };
  }
  let ok = false;
  for (let t = 0; t < 400; t++) { processEconomy(g, 1); if (g.facilities.get("tut_enemy_post")!.team === "player") { ok = true; break; } }
  console.log(`  ${!ok ? "✅" : "❌"} 摘掉谓词修复后坦克应占不下来 — ${ok ? "★仍占下了，判据抓不住病" : "确实占不下（判据会红）"}`);
}

// ────────────────────────────────────────────────
console.log("\n── ⑦ 右边被操作台盖住那条：拉得出来吗（用户 09-11 实拍）──");
// 画布是整幅铺开的、操作台浮在它上面 ⇒ "画出来的"比"看得见的"宽 460。
// 镜头的下限与边界要是按画布宽算，地图最右边那条**永远**躲在面板底下，怎么拖都没用。
{
  const CW = 1440, CH = 790, DOCK = 460;
  const rightEdgeScreenX = (cam: { x: number; zoom: number }, mapW: number) =>
    (mapW * TILE_SIZE - cam.x) * cam.zoom;

  // 都先缩到各自的下限，再往右拖到头
  const mk = (inset: number) => {
    const c = { x: 0, y: 0, zoom: getMinZoom(CW - inset, CH, s.mapWidth, s.mapHeight) };
    centerCameraOn(c, 1e6, s.mapHeight / 2, CW, CH, s.mapWidth, s.mapHeight, inset);
    return c;
  };
  const bad = mk(0);        // 旧行为：假装整幅画布都看得见
  const good = mk(DOCK);    // 新行为：只认露在外面那条

  check("★旧算法：拖到头，地图右边界还压在面板底下",
    rightEdgeScreenX(bad, s.mapWidth) > CW - DOCK + 1,
    `右边界落在 x=${Math.round(rightEdgeScreenX(bad, s.mapWidth))}，面板左边在 ${CW - DOCK}`);
  check("新算法：拖到头，地图右边界正好顶到面板左边",
    Math.abs(rightEdgeScreenX(good, s.mapWidth) - (CW - DOCK)) < 1.5,
    `右边界落在 x=${Math.round(rightEdgeScreenX(good, s.mapWidth))}，面板左边在 ${CW - DOCK}`);

  // 镜头跳转也一样：对准的点该落在**看得见那块**的中间，不是画布中间
  const c2 = { x: 0, y: 0, zoom: 1 };
  centerCameraOn(c2, 60, 40, CW, CH, s.mapWidth, s.mapHeight, DOCK);
  const targetScreenX = (60 * TILE_SIZE - c2.x) * c2.zoom;
  check("镜头跳转对准的是露出来那块的中点",
    Math.abs(targetScreenX - (CW - DOCK) / 2) < 1.5,
    `目标落在 x=${Math.round(targetScreenX)}，露出来那块的中点是 ${(CW - DOCK) / 2}`);

  // 面板收起/弹出时 inset=0，行为必须回到原样（别把没盖住的情况也当成盖住）
  const c3 = { x: 0, y: 0, zoom: 1 };
  centerCameraOn(c3, 60, 40, CW, CH, s.mapWidth, s.mapHeight, 0);
  check("面板收起(inset=0)时回到画布中点，不留空条",
    Math.abs((60 * TILE_SIZE - c3.x) * c3.zoom - CW / 2) < 1.5,
    `目标落在 x=${Math.round((60 * TILE_SIZE - c3.x) * c3.zoom)}`);
}

// ────────────────────────────────────────────────
console.log("\n── ⑧ 全景下阵营光晕别糊住旗子（用户 09-12 实拍）──");
// 「我军的蓝旗看不清楚，因为蓝色光圈太大了」。病根是圈的 8px 地板：
// 全景下一格才 3px，圈却按 8px 起算 ⇒ 一个兵糊 35px 光斑，几十个连成一片。
{
  const t = (zoom: number) => TILE_SIZE * zoom;
  const glowW = (zoom: number) =>
    unitRingBase(t(zoom)) * 1.4 * 1.55 * 2 * factionGlowScale(t(zoom));

  // ★ 先钉住"没改坏正常玩的观感"——这是本刀最大的风险。
  //   拿**旧公式**当对照：正常游玩那一段两者必须逐字相等。
  const OLD = (zoom: number) => Math.max(8, t(zoom) * 0.7) * 1.4 * 1.55 * 2;
  for (const z of [1, 0.8, 0.6, 0.5]) {
    check(`正常缩放(zoom=${z})外晕与旧公式逐字相等`,
      Math.abs(glowW(z) - OLD(z)) < 0.01 && factionGlowScale(t(z)) === 1,
      `新 ${glowW(z).toFixed(1)} / 旧 ${OLD(z).toFixed(1)}`);
  }
  check("★缩远了才不一样（否则这刀等于没做）", glowW(0.15) < OLD(0.15),
    `新 ${glowW(0.15).toFixed(1)} / 旧 ${OLD(0.15).toFixed(1)}`);

  check("全景(zoom=0.09)外晕彻底不画", glowW(0.09) === 0, `${glowW(0.09).toFixed(0)}px`);
  check("教学关全景(zoom=0.28)外晕收到一格上下", glowW(0.28) < t(0.28) * 2.2,
    `${glowW(0.28).toFixed(0)}px vs 一格 ${t(0.28).toFixed(1)}px`);
  // ★ 本体圈**不许**跟着消失——那是唯一的敌我色标
  check("圈的基准尺寸永不超过一格宽（超了就是占别人地盘）",
    [1, 0.5, 0.28, 0.15, 0.09].every(z => unitRingBase(t(z)) <= Math.max(t(z), t(z) * 0.7) + 0.01),
    [1, 0.5, 0.28, 0.09].map(z => `${z}:${unitRingBase(t(z)).toFixed(1)}/${t(z).toFixed(1)}`).join(" "));
  check("缩到最远本体圈仍然存在（敌我色标不能没）", unitRingBase(t(0.09)) > 0,
    `${unitRingBase(t(0.09)).toFixed(1)}px`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
