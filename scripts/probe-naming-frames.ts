/**
 * 刀② 提案取证：真现场里未编组群到底叫什么名字，以及离长官会用的地标多远。
 *
 * ⚠ 本档是**取证附件，不是验收臂**（Fable P0-2）：与生产路径差三处——
 * 池 85 vs 74、群 12 vs 11、标签自己拼的（丢「附近」、跳 locationPhraseFor
 * 的行进中分支、滤单人群）。验收一律从 buildReinforceOptions(...).options
 * 与 preflight 生产路径读标签。
 *
 * ⚠ 距离一律印两位小数：首版 toFixed(0) 把 36.47 印成「36」，
 * 于是"封顶 36 恰好收住全部 6 群"这个假结论被两个人先后写进提案。
 * **判据不许读格式化后的数。**
 */
import { createInitialGameState } from "@ai-commander/core";
import { NAME_RADIUS_TILES, nearestPlaceWithin, compassOctant } from "../packages/core/src/frontEscalationPayload";
import { spatialGroups } from "../packages/core/src/frontDestination";
import type { GameState, Position, Unit } from "@ai-commander/shared";

function dist(a: Position, b: Position): number { return Math.hypot(a.x - b.x, a.y - b.y); }
const cen = (ps: Position[]): Position => ({
  x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
  y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
});

const s: GameState = createInitialGameState("el_alamein");
console.log(`NAME_RADIUS_TILES = ${NAME_RADIUS_TILES}；地图 ${s.mapWidth}x${s.mapHeight}，中心 (${s.mapWidth / 2},${s.mapHeight / 2})`);

// 玩家侧地标（长官嘴里会说的那些）
const landmarks: { name: string; pos: Position }[] = [];
s.facilities.forEach((f) => { if (f.team === "player" && f.hp > 0) landmarks.push({ name: f.name, pos: f.position }); });
console.log(`\n玩家地标：${landmarks.map((l) => `${l.name}(${l.pos.x},${l.pos.y})`).join("  ")}`);

// 未编组的玩家单位（squads 为空 ⇒ 全是未编组）
const free: Unit[] = [];
s.units.forEach((u) => { if (u.team === "player" && u.hp > 0 && !u.manualOverride) free.push(u); });
const groups = spatialGroups(free).filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);

console.log(`\n未编组空间群 ${groups.length} 个：\n`);
let compassNamed = 0;
for (const g of groups) {
  const c = cen(g.map((u) => u.position));
  const place = nearestPlaceWithin(s, c);
  const oct = compassOctant(s, c);
  // 离最近的玩家地标多远，以及那个地标叫什么
  let near = { name: "—", d: Infinity };
  for (const l of landmarks) { const d = dist(c, l.pos); if (d < near.d) near = { name: l.name, d }; }
  if (!place) compassNamed++;
  // 长官若以那个地标为参照，这支部队在它的哪个方向？（引擎用的是地图中心）
  const lm = landmarks.find((l) => l.name === near.name)!;
  const ang = Math.atan2(-(c.y - lm.pos.y), c.x - lm.pos.x);
  const OCT = ["东", "东北", "北", "西北", "西", "西南", "南", "东南"];
  const fromLandmark = OCT[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
  console.log(
    `  ${String(g.length).padStart(2)}人 @(${c.x.toFixed(0)},${c.y.toFixed(0)})  ` +
    `引擎叫「${place ?? `${oct}方向`}未编组群」  ` +
    `｜最近玩家地标=${near.name} ${near.d.toFixed(2)}格  ` +
    `｜以中心为参照=${oct} / 以${near.name}为参照=${fromLandmark}` +
    `${oct !== fromLandmark ? "  ★参照系不一致" : ""}`,
  );
}
console.log(`\n拿不到地标名、只能报罗盘方向的群：${compassNamed}/${groups.length}`);
