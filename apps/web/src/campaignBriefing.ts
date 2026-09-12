// ============================================================
// 正式战役 · 开场简报——陈在开局说的那几句
//
// 用户 2026-09-11 原话：「进入主游戏的时候，开头让 Chen 继续说一下，就是让玩家看地图，
// 然后告诉玩家我们需要进攻哪几个敌军哨站，拿下三个就算赢，然后我军三个哨站，不能丢，
// 就是告诉玩家正式游戏的输赢规则，然后 Emily 的生产的兵营在哪儿，也说一下…
// 然后不卡玩家，就是说一下…然后蓝色是我方，红色是敌军」。
//
// ★ 与教学关的根本区别：**这里不卡玩家**。没有 done、没有催促、没有状态机——
//   几句话说完就闭嘴，玩家爱干嘛干嘛。教学关那套手把手是为了送人过门槛，
//   正式局再手把手，就把「等指令」那个毛病又教回来了（收口段 §4.3）。
//
// ★ 每个数字、每个地名都从 `scenarioWinConfig` 和设施表**算**出来，一个都不许写死。
//   文案红线：屏上每句话必须指回一个能派生的数字或真机制。改平衡的人只动配置，
//   这几句自己跟着变；写死的话，下一个调 K 值的人不会记得来改台词。
// ============================================================

import type { GameState, Facility } from "@ai-commander/shared";

export interface BriefingLine {
  /** 陈说的话 */
  text: string;
  /** 开局后第几游戏秒说它（用游戏时间，暂停时不会自己往下念） */
  atSec: number;
  /** 说这句时**地图上要跟着闪**的设施。
   *  ★ 家法：引导提到什么，什么就得自己亮（用户 09-08 立、09-12 在正式局重申：
   *  「说红色的四个点…这时候四个红旗需要闪烁，同理，我方介绍 3 个蓝旗据点和兵营
   *  的时候，也要闪烁」）。光报名字等于让玩家拿着名单满图找。 */
  facilityIds?: string[];
}

/** 蓝＝我方、红＝敌军。**这不是文案作者的记忆，是渲染层真在用的两个色**
 *  （`rendererCanvas.ts` 单位色 `#4488ff` / `#ff4444`）。换色的人会改到这里的注释，
 *  改不到的话探针会提醒——它拿同一处常量对账。 */
const COLOR_SENTENCE = "蓝的是咱们，红的是敌人";

function nameOf(state: GameState, id: string): string | null {
  return state.facilities.get(id)?.name ?? null;
}

/** 兵营在哪儿——找个**地标当原点**（挨着谁），实在没有才退回罗盘。
 *  （§L 刀②：方位以最近地名为原点比纯罗盘好认，罗盘只当兜底。）
 *  ★ 地标优先总部：开局玩家唯一认得的就是自己的总部。实测最近的其实是"野战修理厂"
 *    ——拿一个他同样没听过的地方当原点，等于没说（循环指路）。 */
function whereIs(state: GameState, fac: Facility): string {
  const near = (o: Facility) =>
    Math.hypot(o.position.x - fac.position.x, o.position.y - fac.position.y);
  const hq = [...state.facilities.values()]
    .find((o) => o.team === "player" && o.type === "headquarters");
  if (hq && near(hq) <= 80) return `挨着${hq.name}`;
  let best: { name: string; d: number } | null = null;
  for (const other of state.facilities.values()) {
    if (other.id === fac.id || other.team !== "player") continue;
    const d = near(other);
    if (!best || d < best.d) best = { name: other.name, d };
  }
  if (best && best.d <= 60) return `挨着${best.name}`;
  const ew = fac.position.x > state.mapWidth / 2 ? "东" : "西";
  const ns = fac.position.y > state.mapHeight / 2 ? "南" : "北";
  return `在地图${ew}${ns}角`;
}

/**
 * 开场简报。没有 `scenarioWinConfig` 的场景（dual_island）返回空数组——
 * 那种图没有"占几个算赢"这回事，硬说就是编。
 */
export function campaignBriefing(state: GameState): BriefingLine[] {
  const cfg = state.scenarioWinConfig;
  if (!cfg) return [];

  const objIds = (state.captureObjectives ?? []).filter((id) => state.facilities.has(id));
  const keepIds = (cfg.friendlyKeypoints ?? []).filter((id) => state.facilities.has(id));
  const objs = objIds.map((id) => nameOf(state, id)!) ;
  const keeps = keepIds.map((id) => nameOf(state, id)!);
  const need = cfg.requiredCapturedObjectives;
  const mins = Math.round(cfg.timeLimitSec / 60);
  const barracks = [...state.facilities.values()]
    .find((f) => f.team === "player" && f.type === "barracks");

  const lines: BriefingLine[] = [];

  lines.push({
    atSec: 2,
    text: `长官，开打之前先看一眼整张图——${COLOR_SENTENCE}。`
        + `这会儿是全景，滚轮往里推能看清每一个人。`,
  });

  if (objs.length > 0) {
    lines.push({
      atSec: 10,
      facilityIds: objIds,
      // ★「插红旗的」不是修辞：胜负点是真插旗的（`renderFacilities` 给
      //   captureObjectives + friendlyKeypoints 画旗杆，旗色恒等 fac.team）。
      text: `正在闪的那${objs.length}个插红旗的据点，是要拿的：${objs.join("、")}。`
          + `占下其中${need}个，这仗就赢了——顶上「OBJECTIVES」记的就是这个数。`,
    });
  }

  if (keeps.length > 0) {
    // ★ 别把 maxFriendlyKeypointsLost 说成"一个都不能丢"。真规则是"丢满这个数才判负"，
    //   说满了玩家会为了守一个前哨放弃进攻——而结算是 2×占领 − 丢失，进攻才是分的大头。
    const loseRule = cfg.maxFriendlyKeypointsLost >= keeps.length
      ? `${keeps.length}个全丢光才算输`
      : `丢满${cfg.maxFriendlyKeypointsLost}个就算输`;
    lines.push({
      atSec: 18,
      facilityIds: keepIds,
      text: `再看这${keeps.length}个闪着的蓝旗，是咱们自己的前哨，得看住：${keeps.join("、")}。${loseRule}，`
          + `不过丢一个结算就少一分，能守还是守住。全场${mins}分钟，`
          + `到点按占了几个、丢了几个算账。`,
    });
  }

  if (barracks) {
    lines.push({
      atSec: 26,
      facilityIds: [barracks.id],
      text: `兵不够就找艾米莉，新兵从闪着的那个${barracks.name}出来，${whereIs(state, barracks)}。`
          + `打法您定，不用等我开口——想问什么随时喊我。`,
    });
  }

  return lines;
}
