/**
 * 侧栏刀 步0 取证：digest 金样（重构 buildProductionOptions 前后逐字节比对）。
 *
 * ⚠ 本档是**取证附件，不是验收臂**（照 probe-naming-frames.ts 家法）：
 * 不进 run-benches.sh，不做断言——它只把六个状态的【完整 digest】打出来，
 * 判据在外面：重构前跑一次存 /tmp/golden-before.txt，重构后跑一次存
 * /tmp/golden-after.txt，diff 零差异才算过。单态比对不够，六态覆盖：
 * 钱界、油界、兵营缺席行、机场缺席行、queued 聚合与插入序。
 *
 * ⚠ buildDigest 的 mintForceHandles 必须保持缺省 false（true 会灼号，
 * 且 mint 有全局计数器，金样就不可复跑了）。
 */
import { createInitialGameState, buildDigest, enqueueProduction } from "@ai-commander/core";
import type { GameState } from "@ai-commander/shared";

function fullDigest(state: GameState): string {
  // 完整 digest（不是只打 PRODUCTION 节）；mintForceHandles 缺省 false。
  return buildDigest(state, [], [], []);
}

function scenario(title: string, mutate: (s: GameState) => void): string {
  const s = createInitialGameState("el_alamein");
  mutate(s);
  return `===== ${title} =====\n${fullDigest(s)}`;
}

const out: string[] = [];

out.push(scenario("S1 initial (el_alamein 原样)", () => {}));

out.push(scenario("S2 money=0（钱界收敛到 0）", (s) => {
  s.economy.player.resources.money = 0;
}));

out.push(scenario("S3 fuel=0（油界 + fuelCost=0 的步兵不受限）", (s) => {
  s.economy.player.resources.fuel = 0;
}));

out.push(scenario("S4 兵营 hp=0（ground 缺席行）", (s) => {
  const f = s.facilities.get("ea_player_barracks");
  if (!f) throw new Error("ea_player_barracks 不存在——地图改了？金样作废");
  f.hp = 0;
}));

out.push(scenario("S5 机场 hp=0（air 缺席行）", (s) => {
  const f = s.facilities.get("ea_player_airfield");
  if (!f) throw new Error("ea_player_airfield 不存在——地图改了？金样作废");
  f.hp = 0;
}));

out.push(scenario("S6 enqueue main_tank,infantry,main_tank（queued 聚合＋插入序＋扣款后 now）", (s) => {
  for (const t of ["main_tank", "infantry", "main_tank"] as const) {
    const r = enqueueProduction(s, "player", t);
    if (!r.ok) throw new Error(`enqueueProduction(${t}) 被拒：${r.reason}——金样前提破了`);
  }
}));

console.log(out.join("\n"));
