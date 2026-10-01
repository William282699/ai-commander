// ============================================================
// 地点视角的我方兵力（据点驻军数）
//
// 病例（2026-09-30 线上首局）：中央前哨的 8 个全派走以后，长官两次问"空了吗"，
// 陈两次答"有 4 坦 4 步，没空"。信封里没有"某据点此刻有几个我方兵"这一项，
// 陈只能拿 FRONTS 的战线汇总或 DISPATCHES 的出处去顶。真模型对照：补上这个数
// 0/20 → 20/20；信封里的字样是「在场我方=N单位」（档 _archive/central-post-empty-20261001/FINDINGS.md、REVIEW-FABLE.md）。
//
// 这里只给事实（一个数），不给结论（"已空"）——结论归模型。
// ============================================================

import type { GameState, Position } from "./types";

/**
 * 「X 附近」的统一尺度（格，欧氏）。引擎里同值的三把尺都必须等于它：
 * 板子起名「X附近」（core/frontEscalationPayload.NAME_RADIUS_TILES）、
 * 外派出发据点（core/dispatchLedger.ORIGIN_FACILITY_RADIUS）、
 * 设施危机的近旁兵力（core/director.FACILITY_GATE.NEAR_RADIUS）。
 * 三者的定义原样留在各自文件里，由台架钉住"三者 ＝ 本常量"防漂。
 */
export const PLACE_NEAR_RADIUS_TILES = 12;

/**
 * 某点 radius 格内（含边界）此刻活着的我方单位数。
 * 口径与 director 的 `facilityEscalationFacts().nearbyPlayerUnits` 逐字相同：
 * 只看 team=player、活着（hp>0 且 state≠dead）；不过滤状态、兵种、手动接管或亲兵——
 * 路过的也算（瞬时存在，不是归属；排除"移动中"会把正在开进据点的守军数成 0）。
 */
export function countPlayerUnitsNear(state: GameState, pos: Position, radius: number): number {
  const r2 = radius * radius;
  let n = 0;
  state.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
    const dx = u.position.x - pos.x;
    const dy = u.position.y - pos.y;
    if (dx * dx + dy * dy <= r2) n++;
  });
  return n;
}
