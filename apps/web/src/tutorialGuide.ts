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

import type { GameState, Channel } from "@ai-commander/shared";

/** 卡住多久算卡住（游戏秒）。用游戏时钟不用墙钟：玩家切走时 rAF 被饿死、
 *  游戏时间自然停住 ⇒ 人不在座位上就不会被催，正好是我们要的。 */
export const NUDGE_AFTER_SEC = 15;

/** 这一步要玩家去点的那个键。UI 层据此让**那一个**键呼吸。
 *  ★ 复用喇叭键那条先例的规矩：**绑这一步的生死**——步骤一完成就停，
 *  绝不做常驻 affordance（`game-ui.css` 里那段注释写着理由）。
 *  将来步 4/5 会加 `"channel:logistics"` / `"channel:ops"` 之类。 */
export type GuideHint = "squad" | "channel:logistics" | "channel:ops";

/** 判定这一步用得到的东西。
 *  ★ 为什么不是直接传 GameState：从步 4 起，"完成"不再只是引擎状态
 *  （多没多一支队），还包括"玩家有没有跟某个参谋说过话"——那条信息在
 *  `messageStore` 里不在 GameState 里。用一个 ctx 把两边并起来，
 *  `advanceGuide` 仍然是**纯函数**（依赖全从参数进来，台架照样能逐拍重放）。 */
export interface GuideCtx {
  state: GameState;
  /** 玩家在这个频道**发过消息**没有。★判松（用户 2026-09-06 裁定）：
   *  说什么都算，哪怕只是"你好"。这一步教的是"你可以跟她说话"，
   *  不是"你得说对咒语"——判紧等于在教学关里亲手造一个新手过不去的门槛，
   *  而"词汇不通"（她说人话、Agent 等军语）正是账本里还没结的账。 */
  playerSpokeIn: (ch: Channel) => boolean;
}

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
  done: (c: GuideCtx) => boolean;
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
    done: (c) => c.state.squads.length >= 1,
  },
  {
    id: "squad_2",
    hint: "squad",
    say: "好，这队归您点名了。地图上还有一批兵散着没编——照样圈上、点「编队」，咱们手上就有两支能整队调动的部队。",
    nudge: "长官，还有一批散兵没编队。圈上、点「编队」，跟刚才一样。",
    done: (c) => c.state.squads.length >= 2,
  },
  {
    // ★ 台词结构（用户 2026-09-06 定）：**给一句示范 + 明说可以随便讲**。
    //   只给示范，玩家会当成咒语照念（"说错了会不会不认"）；只说随便讲，
    //   他对着空输入框不知道从哪开口。两句都要。
    //   与结束语同一条道理：给的是范围，不是菜单。
    id: "talk_emily",
    hint: "channel:logistics",
    say: "后勤这块归艾米莉。点上面「艾米莉中尉」，跟她说句话——比如「造两个步兵」。"
       + "不用照着念，您想怎么说就怎么说，她听得懂人话。",
    nudge: "长官，艾米莉那边还没您的消息。点她的名字，随便说句什么都行——问问现在能造什么也算。",
    done: (c) => c.playerSpokeIn("logistics"),
  },
  {
    id: "talk_marcus",
    hint: "channel:ops",
    say: "马克斯管战况判读。点「马克斯上尉」问他一句——比如「现在什么情况」。同样，怎么问都行。",
    nudge: "长官，还没跟马克斯说过话。点他的名字问一句，随便什么都行。",
    done: (c) => c.playerSpokeIn("ops"),
  },
  {
    // ★ 第一次占领刻意选中立、无人守的烽火台：**先在没有战斗的情况下**把占领
    //   机制教干净，还给一个看得见的奖励（东边的迷雾散开）。打仗留给下一步。
    id: "take_beacon",
    say: "基本功您已经有了，来真的。中央谷地那座烽火台没人守——派队人过去站上去，"
       + "占下它东边就亮了，能看见敌人在哪。怎么派由您，说话或者直接右键都行。",
    nudge: "长官，烽火台还空着。派一队过去占了它，东边才看得见。",
    done: (c) => c.state.facilities.get("tut_beacon")?.team === "player",
  },
  {
    id: "take_post",
    say: "看见东岭上那个敌军哨站了吧？打下它这一关就算过。它有人守，别一个人上。",
    nudge: "长官，敌军哨站还在敌人手里。派兵过去打下来——这一关就差它了。",
    // 过关目标翻蓝＝这一步完成，同时引擎也判胜（`requiredCapturedObjectives: 1`）
    done: (c) => c.state.facilities.get("tut_enemy_post")?.team === "player",
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
export function advanceGuide(g: GuideState, c: GuideCtx, now: number): GuideEffect {
  if (g.index >= GUIDE_STEPS.length) return { say: null, next: g };

  const step = GUIDE_STEPS[g.index];

  // ① 完成 → 进下一步，并把下一步的话说出来
  if (step.done(c)) {
    const index = g.index + 1;
    const next: GuideState = { index, stepStartedAt: now, nudged: false };
    // 走完最后一步 ⇒ 说结束语（解除引导），不是静默收摊
    return { say: index < GUIDE_STEPS.length ? GUIDE_STEPS[index].say : OUTRO_LINE, next };
  }

  // ③ 卡住了 → 催一次（一步只催一次）
  if (!g.nudged && now - g.stepStartedAt >= NUDGE_AFTER_SEC) {
    return { say: step.nudge, next: { ...g, nudged: true } };
  }

  return { say: null, next: g };
}

/**
 * 引导走完时陈说的最后一句。
 *
 * ★ 为什么必须有它（用户 2026-09-04 提出，是个很硬的设计观察）：
 *   手把手引导有个自带的副作用——**它会把玩家训练成"等指令"**。走完两步之后
 *   玩家很容易继续坐着等下一条提示，而不是自己开口。这对别的游戏只是节奏问题，
 *   对本作是**要命**的：整个产品命题就是"你用自己的话指挥"，玩家一旦进入
 *   "照着教程做完就算玩过了"的模式，我们要验证的那件事根本不会发生。
 *
 *   所以最后一句的职责不是道别，是**明确解除引导**：告诉他从现在起不用等我说话。
 *
 * 措辞上有意举两三个例子而不列清单——是给他看**范围**（打哪儿/派谁/要不要先看看），
 * 不是给他一张命令菜单。给菜单他就会照着念，那又变成另一种"等指令"。
 */
export const OUTRO_LINE =
  "拿下了。长官，您已经会指挥了——往后不用等我开口，想到什么就直接跟我说，"
  + "用平常说话的方式：打哪儿、派谁去、要不要先摸一摸敌情，都由您定。"
  + "真正的仗在阿拉曼，我们那边见。";

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
