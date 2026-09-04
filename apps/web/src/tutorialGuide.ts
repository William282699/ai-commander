// ============================================================
// 教学关引导（步 3）— 陈开口带路，不是一张勾选清单
// ------------------------------------------------------------
// **形式的理由（先读这段再改）**：
//
// 家法「对话是唯一界面」写着——UI 确认项／结构化小条／状态灯都是画蛇添足，
// 玩家看到可见控件的那一刻就想起"我在操作软件"。所以引导**不做浮层、不做
// 步骤条、不做打勾清单**，每一步都是**陈在他自己的频道里说一句话**，完成与否
// 由引擎在背后自己判。这样还白赚一件事：从第一秒起玩家就在被教
// 「参谋会主动跟你讲话」——那正是这个游戏要验证的核心动作。
//
// ★ 一处**有意的家法豁免，需要时可以推翻**：
//   「台词禁死模板」要求人物台词一律 LLM 生成、模板只当兜底。这里的引导句是
//   **写死的**。理由：教学指令必须逐字正确——"圈起来、点编队"被模型换个说法
//   就可能把新手带沟里，而这一步的全部价值就是把人送过门槛。
//   代价如实记：这几句会比陈平时说话**硬**一点。
//   将来若觉得出戏，正解不是让模型自由发挥，而是把指令当**事实**递给它、
//   由它用陈的语气复述一遍（preflight 那条成熟路子）。
//
// **判定一律测效果**：数 `state.squads.length`（引擎里真多出来的队），
// 不看玩家点没点按钮、也不看回执说了什么。家法栽过五次的那一族。
// ============================================================

import type { GameState } from "@ai-commander/shared";

/** 卡住多久算卡住（游戏秒）。用游戏时钟不用墙钟：玩家切走时 rAF 被饿死、
 *  游戏时间自然停住 ⇒ 人不在座位上就不会被催，正好是我们要的。 */
export const NUDGE_AFTER_SEC = 15;

/** 这一步要玩家去点的那个键。UI 层据此让**那一个**键呼吸。
 *  ★ 复用喇叭键那条先例的规矩：**绑这一步的生死**——步骤一完成就停，
 *  绝不做常驻 affordance（`game-ui.css` 里那段注释写着理由）。
 *  将来步 4/5 会加 `"channel:logistics"` / `"channel:ops"` 之类。 */
export type GuideHint = "squad";

export interface GuideStep {
  id: string;
  /** 这一步该点哪个键；省略＝这一步没有要点的键（例如只要说话）。 */
  hint?: GuideHint;
  /** 进入这一步时陈说的那句。 */
  say: string;
  /** 卡了 NUDGE_AFTER_SEC 还没动静时再说的一句。
   *  **换个说法，不复读**——复读是零信息，且撞过「逐字复读」那笔账。 */
  nudge: string;
  /** 这一步算不算完成了。判据只读引擎状态。 */
  done: (s: GameState) => boolean;
}

/**
 * 步 3 只铺前两步（编队 ×2）。第 3/4/5 步（艾米莉生产／问马克斯／打哨站）
 * 在后面的刀里往这个数组里加，`advanceGuide` 一行都不用改。
 */
export const GUIDE_STEPS: GuideStep[] = [
  {
    id: "squad_1",
    hint: "squad",
    say: "长官，先认认您的部队。北边那四个步兵，用鼠标拖个框圈上，点右下角的「编队」，给他们指个队长。",
    nudge: "长官？把北边那四个步兵拖个框圈上，然后点「编队」——挑谁当队长您说了算。",
    done: (s) => s.squads.length >= 1,
  },
  {
    id: "squad_2",
    hint: "squad",
    say: "好，这队归您点名了。地图上还有一批兵散着没编——照样圈上、点「编队」，咱们手上就有两支能整队调动的部队。",
    nudge: "长官，还有一批散兵没编队。圈上、点「编队」，跟刚才一样。",
    done: (s) => s.squads.length >= 2,
  },
];

/** 引导的全部状态。刻意做成纯数据：好存、好测、好在别处重放。 */
export interface GuideState {
  /** 当前第几步；`>= GUIDE_STEPS.length` ＝ 全部走完。 */
  index: number;
  /** 当前这一步是什么时候开始的（游戏秒）——催促计时的起点。 */
  stepStartedAt: number;
  /** 这一步催过没有。一步只催一次，别变成唠叨。 */
  nudged: boolean;
}

export function initialGuideState(now: number): GuideState {
  return { index: 0, stepStartedAt: now, nudged: false };
}

/** `advanceGuide` 要 App/GameCanvas 替它做的事（它自己不碰 React、不碰 DOM）。 */
export interface GuideEffect {
  /** 陈要说的话；null ＝ 这一拍没什么可说的。 */
  say: string | null;
  next: GuideState;
}

/**
 * 每拍调一次。**纯函数**：同样的输入永远给同样的输出，没有副作用，
 * 所以它可以在台架里被逐拍重放（真判据就该建在这上面）。
 *
 * 三件事，顺序有讲究：
 *  ① 先判完成——玩家可能在陈说完之前就自己做了，那就别再催他做已经做完的事
 *  ② 再判要不要开口（刚进这一步）
 *  ③ 最后才判要不要催
 */
export function advanceGuide(g: GuideState, s: GameState, now: number): GuideEffect {
  if (g.index >= GUIDE_STEPS.length) return { say: null, next: g };

  const step = GUIDE_STEPS[g.index];

  // ① 完成 → 进下一步，并把下一步的话说出来
  if (step.done(s)) {
    const index = g.index + 1;
    const next: GuideState = { index, stepStartedAt: now, nudged: false };
    return { say: index < GUIDE_STEPS.length ? GUIDE_STEPS[index].say : null, next };
  }

  // ③ 卡住了 → 催一次（一步只催一次）
  if (!g.nudged && now - g.stepStartedAt >= NUDGE_AFTER_SEC) {
    return { say: step.nudge, next: { ...g, nudged: true } };
  }

  return { say: null, next: g };
}

/** 当前这一步该点哪个键；引导走完或这一步没有键就返回 null。
 *  UI 层每拍读它——**没有第二份状态**，脉冲跟着引导进度自动生灭。 */
export function currentHint(g: GuideState | null): GuideHint | null {
  if (!g || g.index >= GUIDE_STEPS.length) return null;
  return GUIDE_STEPS[g.index].hint ?? null;
}

/** 开场那一句（第 0 步的 say）。由调用方在引导启动时发一次。 */
export function openingLine(): string {
  return GUIDE_STEPS[0].say;
}
