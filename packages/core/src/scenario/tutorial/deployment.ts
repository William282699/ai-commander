// ============================================================
// AI Commander — 教学关部署
//
// ★ 摆位是教学设计的一部分，不是随手撒的：
//   玩家侧刻意摆成**两坨分得很开**的兵（步兵在北、坦克在南，隔着 20 格），
//   因为教学第 1、2 步要玩家"圈一队"再"圈另一队"——两坨挨在一起，
//   一次框选就全进去了，那两步就教不成。
//
//   敌方只有守哨站的一小撮，且**不给 `enemyAIMode`**（见 ../index.ts），
//   所以 El Alamein 那套 2298 行防御 AI 整个不跑；敌人只会被打了还手
//   （autoBehavior 4b），不会主动摸过来打新手。
// ============================================================

import type { Unit, UnitType, Team } from "@ai-commander/shared";
import { createUnit } from "../createInitialGameState";

export function deployTutorialUnits(): { units: Map<number, Unit>; nextUnitId: number } {
  const units = new Map<number, Unit>();
  let uid = 1;

  function placeGroup(
    type: UnitType, team: Team,
    positions: [number, number][],
    opts?: { playerControlled?: boolean },
  ) {
    for (const [x, y] of positions) {
      const u = createUnit(uid, type, team, { x, y });
      if (opts?.playerControlled) u.isPlayerControlled = true;
      units.set(uid, u);
      uid++;
    }
  }

  // ═══════════ 玩家侧（西） ═══════════

  // 指挥官 + 卫队——鼠标点得动的就这几个（isPlayerControlled）
  const commander = createUnit(uid, "commander", "player", { x: 16, y: 40 });
  commander.isPlayerControlled = true;
  units.set(uid, commander);
  uid++;
  placeGroup("elite_guard", "player", [
    [14, 38], [18, 38], [14, 42], [18, 42],
  ], { playerControlled: true });

  // ── 第一坨：步兵四个，靠北，我方哨站旁边 ──
  placeGroup("infantry", "player", [
    [32, 27], [35, 27], [32, 30], [35, 30],
  ]);

  // ── 第二坨：轻坦三辆，靠南，离第一坨 20 格以上 ──
  placeGroup("light_tank", "player", [
    [32, 50], [35, 50], [33, 53],
  ]);

  // ═══════════ 敌方（东，守哨站） ═══════════

  placeGroup("infantry", "enemy", [
    [90, 37], [94, 37], [90, 43],
  ]);
  placeGroup("light_tank", "enemy", [
    [95, 43],
  ]);

  return { units, nextUnitId: uid };
}
