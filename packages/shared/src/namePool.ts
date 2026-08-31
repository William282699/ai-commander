// ============================================================
// AI Commander — Leader Roster (队长名册)
//
// 这里是**名册**：一批预先存在的将军，每人有天生的、固定的性格。
// 编队不是"造一个队长"，是"从名册里派一个人出去" —— 所以性格不在编队时
// 决定，名册建立时就定了。玩家的权力是"派谁去哪儿"，不是"把数值调到几"。
//
// ★为什么名册在这个文件、而不是在 GameState 里（2026-08-30 用户拍板）：
//   名册内容一局之内**永不变化** ⇒ 它不是 state。而"谁已经被派出去了"
//   本来就能从 `state.squads` 算出来（getUsedLeaderNames，本文件下方）——
//   把静态表塞进 GameState 只会多一份纯重复的真相源，还要求每个手搓
//   GameState 的台架跟着改（或留可选兜底路径，那就是第二真相源）。
//   `packages/shared` 就是引擎侧，"引擎持有真相、不是 UI 本地状态"已满足。
//
// ★名册是有限的，这是设计地基，不是省事：如果每支队都能配到激进的队长，
//   "激进"就没有意义，用人决策会退化成一个带名字的下拉框。
// ============================================================

import type { LeaderPersonality } from "./types";

export interface LeaderProfile {
  name: string;
  personality: LeaderPersonality;
}

/**
 * 名册：12 人 · 激进 3 / 稳健 6 / 保守 3（2026-08-30 用户拍板的规模与分布）。
 *
 * 为什么是 12：85 个玩家单位按每队 ~8 人编，大约编得出 10 队；编制树上把一支队
 * 拖到另一支下面还会自动消耗一个名额（squadHierarchy.promoteToCommander 会现造
 * 一个新队长接管原队的兵）。12 ⇒ 基本够用但要挑，激进只有 3 个 ⇒ 派谁去哪儿
 * 是真决策。
 *
 * ★顺序是有意交错的，不是按性格分组：步 1 里引擎"取第一个没被用过的"来派人，
 *   若按性格分组排列，玩家编的头三支队会全是激进的。交错之后头三队正好
 *   激进/保守/稳健各一 —— 一眼就看得出三档确实不同。
 *
 * 名字沿用本文件原有的英文名单前 12 个：`leaderName` 才是玩家和 LLM 共同称呼
 * 那个人的名字（OrgTree 显示它、主义匹配 squadRefMatchesUnit 认它、信封里
 * 报的也是它）。`squad.leader.name` 那个中文名全仓零读取，别拿它当身份。
 */
export const LEADER_ROSTER: readonly LeaderProfile[] = [
  { name: "Aiden",   personality: "aggressive" },
  { name: "Blake",   personality: "cautious"   },
  { name: "Carter",  personality: "balanced"   },
  { name: "Drake",   personality: "balanced"   },
  { name: "Ellis",   personality: "aggressive" },
  { name: "Farrell", personality: "balanced"   },
  { name: "Griffin", personality: "cautious"   },
  { name: "Hayes",   personality: "balanced"   },
  { name: "Irving",  personality: "balanced"   },
  { name: "Jensen",  personality: "aggressive" },
  { name: "Knox",    personality: "cautious"   },
  { name: "Lawson",  personality: "balanced"   },
];

/**
 * 查名册：这个名字的将军是什么性格。**名册里没有 ⇒ 兜底 balanced。**
 *
 * 什么时候会查不到：名册用光后 pickLeaderName 会发 "Aiden-2" 这种带后缀的
 * 临时名（见下），以及台架/存档里手写的名字（"Bench"、"Zed"…）。
 *
 * ⚠ 这个函数只在**建队那一刻**调用一次，结果钉进 `squad.leader.personality`。
 *    不要在读取时按名字反查 —— 编制树支持改名（GameCanvas.handleRenameLeader），
 *    按名字反查会让"改个名字"顺手改掉这支队的打法。
 */
export function personalityForLeaderName(name: string): LeaderPersonality {
  return LEADER_ROSTER.find((p) => p.name === name)?.personality ?? "balanced";
}

/**
 * Pick a unique leader name not in usedNames.
 * Falls back to "Name-2", "Name-3", etc. if the roster is exhausted.
 *
 * 步 1 的"引擎自动挑"就是这个函数（取名册里第一个没被占用的）。步 2 换成
 * 玩家点将时，**数据模型一个字不动**，差别只有"谁来挑"。
 */
export function pickLeaderName(usedNames: Set<string>): string {
  for (const { name } of LEADER_ROSTER) {
    if (!usedNames.has(name)) {
      return name;
    }
  }
  // 名册用光 —— 加后缀。这些临时名不在名册里 ⇒ 查不到性格 ⇒ 兜底 balanced。
  // （步 2 会把"名册空了"改成"这支队没有队长"，是那一步的事，步 1 不动它。）
  for (let suffix = 2; ; suffix++) {
    for (const { name } of LEADER_ROSTER) {
      const candidate = `${name}-${suffix}`;
      if (!usedNames.has(candidate)) {
        return candidate;
      }
    }
  }
}

/**
 * Collect all leaderNames currently in use from squads.
 */
export function getUsedLeaderNames(squads: { leaderName: string }[]): Set<string> {
  return new Set(squads.map((s) => s.leaderName));
}
