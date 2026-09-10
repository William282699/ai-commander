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
export const NUDGE_AFTER_SEC = 30;

/** 要玩家**派兵走一段路**的步骤，催促得更晚——行军本来就要时间，
 *  15 秒就催等于对着正在走的兵喊"你怎么还没到"。 */
export const NUDGE_AFTER_SEC_SLOW = 75;

/** 一步做完之后**先静一拍**再说下一句（游戏秒）。
 *  ★ 用户 2026-09-08 手测第二次抓的同一族噪音，比催促那次更狠：
 *  判松＝玩家一按发送这步就算完，于是**艾米莉还在回话、兵还在造，
 *  陈已经把下一句推出来、马克斯的键已经在闪了**。
 *  静这一拍里陈不说话、什么都不闪——让当前这件事自己收尾。 */
export const SETTLE_SEC = 4;
/** 跟参谋说话那两步要静更久：LLM 回话本身要几秒，玩家还要读。 */
export const SETTLE_SEC_TALK = 12;

/** 这一步要玩家去点的那个键。UI 层据此让**那一个**键呼吸。
 *  ★ 复用喇叭键那条先例的规矩：**绑这一步的生死**——步骤一完成就停，
 *  绝不做常驻 affordance（`game-ui.css` 里那段注释写着理由）。
 *  将来步 4/5 会加 `"channel:logistics"` / `"channel:ops"` 之类。 */
/**
 * 这一步要玩家看的**每一个**东西。用户 2026-09-08 定的规矩：
 * **引导提到什么，什么就得自己亮**——不管它是屏边的按钮还是地图上的兵/设施。
 * 不亮的话玩家得满地图找，那正是首次外部试玩里"注意力全被找东西吃掉"的翻版。
 *
 * 分两族，由 UI 层各自认领：
 *  · `btn:*` / `chan:*` / `hud:*` ＝ DOM 元素，挂 `data-guide-pulse`（CSS 呼吸）
 *  · `units:*` / `fac:*`        ＝ 地图上的东西，canvas 里画呼吸圈
 * 两边节奏刻意都是 1.6s，看起来是同一件事在闪。
 */
export type GuideTarget =
  // — 屏边的键 —
  | "btn:squad"          // 「编队」
  | "btn:input"          // 打字输入框
  | "btn:mic"            // 麦克风
  | "btn:paneltab"       // 右上那个第二页签（陈＝编制／艾米莉＝军械，同一个键）
  | "btn:chattab"        // 右上「通讯」页签
  | "chan:combat" | "chan:logistics" | "chan:ops"
  | "hud:objectives"     // 顶栏 OBJECTIVES 计数
  | "hud:resources"      // 顶栏那排家底（钱/油/弹/情报/战备）
  | "btn:popout"         // 「弹出面板 ↗」
  // — 地图上的东西 —
  | "units:unsquadded"   // 还没编队的玩家部队（第几坨由引擎当场算，不写死兵种）
  | "fac:barracks" | "fac:beacon" | "fac:enemy_post";

/** 老名字保留给不需要区分的地方；现在一步可以同时点亮多个目标。 */
export type GuideHint = GuideTarget;

/** 判定这一步用得到的东西。
 *  ★ 为什么不是直接传 GameState：从步 4 起，"完成"不再只是引擎状态
 *  （多没多一支队），还包括"玩家有没有跟某个参谋说过话"——那条信息在
 *  `messageStore` 里不在 GameState 里。用一个 ctx 把两边并起来，
 *  `advanceGuide` 仍然是**纯函数**（依赖全从参数进来，台架照样能逐拍重放）。 */
export interface GuideCtx {
  state: GameState;
  /** 从这一步开始到现在，玩家有没有**动过手**（下过命令、编过队、点过右键）。
   *  ★ 用户 2026-09-08 手测抓出来的：催促响的那一刻他其实正在做，五秒后就做完了，
   *  于是屏上变成"催一句＋紧接着下一句"两条挤在一起，催的那句纯属噪音。
   *  **正在动手的人不该被催。** 这是"判据要测效果"的同一族——
   *  旧判据测的是"时间到了没有"，真正该测的是"他是不是卡住了"。 */
  playerActedSince: (sinceGameTime: number) => boolean;
  /** 玩家有没有点开过第二页签（艾米莉那儿＝军械）。判松：切过去就算。 */
  playerSawArsenal: () => boolean;
  /** 参谋此刻正在回话（流式还没完）。
   *  ★ 用户 2026-09-09：「马克斯说话太久了，需要再延迟一下到下一步」。
   *  与其猜一个秒数，不如**等他真说完**——静拍到点了但参谋还在说，就继续等。 */
  advisorBusy: () => boolean;
  /** 玩家在这个频道**发过消息**没有。★判松（用户 2026-09-06 裁定）：
   *  说什么都算，哪怕只是"你好"。这一步教的是"你可以跟她说话"，
   *  不是"你得说对咒语"——判紧等于在教学关里亲手造一个新手过不去的门槛，
   *  而"词汇不通"（她说人话、Agent 等军语）正是账本里还没结的账。 */
  playerSpokeIn: (ch: Channel) => boolean;
  /** 这一步已经开始了多少游戏秒。
   *  ★ 有些步骤**没有要做的动作，只是读一眼**（顶栏那排家底）。它们靠时间自己走完，
   *  否则玩家会对着一句"看一眼"发愣、等一个根本不存在的动作。 */
  sinceStepStart: number;
}

/**
 * 玩家**真有的**队长名字（`squad.leaderName` ＝ 真身份，见 LEDGER §V3；
 * `squad.leader.name` 是另一条全仓零读取的死轴，别读错那个）。
 *
 * ★ 用户 2026-09-09：示范台词原本写死「派 Farrell…」「派 Ellis…」，而玩家那局的
 * 队长是 Aiden/Blake/Griffin/Carter——**举的例子里没有一个是他的人**，
 * 照着念反而会被引擎拒。名册是 `namePool` 按顺序发的，写死等于赌运气。
 */
function leaderNamesOf(c: GuideCtx): string[] {
  return c.state.squads
    .map((sq) => sq.leaderName)
    .filter((n) => !!n && !n.startsWith("无队长"));   // 占位名不往台词里放
}

export interface GuideStep {
  id: string;
  /** 这一步要点亮的东西，可以多个。省略＝这一步没有要指的地方。 */
  targets?: GuideTarget[];
  /** 进入这一步时陈说的那句。
   *  可以是函数——★用户 2026-09-08：合并那句原本写「让上级那个人进攻」，
   *  玩家会纳闷"上级是谁"。引擎其实知道（`parentSquadId` 指向谁），
   *  所以让台词**把那个名字说出来**，别让玩家猜。 */
  say: string | ((c: GuideCtx) => string);
  /** 卡了这么久还没动静时再说的一句。
   *  **换个说法，不复读**——复读是零信息，且撞过「逐字复读」那笔账。 */
  nudge: string;
  /** 这一步等多久才催；省略＝`NUDGE_AFTER_SEC`。行军类的步骤要给足时间。 */
  nudgeAfterSec?: number;
  /** **做完这一步之后**静多久再说下一句；省略＝`SETTLE_SEC`。
   *  跟参谋说话那种"发出去还没收到回话"的步骤要给更久。 */
  settleSec?: number;
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
    targets: ["units:unsquadded", "btn:squad"],
    say: "长官，先认认您的部队。地图上闪着的那批兵还没编队——用鼠标拖个框圈上，"
       + "点右下角的「编队」，给他们指个队长。",
    nudge: "长官？把闪着的那批兵拖个框圈上，然后点「编队」——挑谁当队长您说了算。",
    done: (c) => c.state.squads.length >= 1,
  },
  {
    id: "squad_2",
    targets: ["units:unsquadded", "btn:squad"],
    say: "好，这队归您点名了。还有一批兵在闪，照样圈上、点「编队」，"
       + "咱们手上就有两支能整队调动的部队。",
    nudge: "长官，还有一批散兵没编队。圈上、点「编队」，跟刚才一样。",
    done: (c) => c.state.squads.length >= 2,
  },
  {
    // ★ 用户 2026-09-09：顶栏和「弹出面板」一次都没介绍过。
    //   放在艾米莉之前——**下一步就要花钱**，先知道自己有多少家底才讲得通。
    //   ⚠ 这一步**没有要做的动作**，靠 `sinceStepStart` 自己走完；
    //   要求玩家"点一下资源条"是硬造动作，反而添堵。
    id: "read_hud",
    targets: ["hud:resources", "btn:popout"],
    nudgeAfterSec: 9999,     // 时间步不需要催——它自己会走完
    say: "抬头看一眼闪着的那排数字，那是您的家底："
       + "💰钱造兵、⛽油让坦克跑得动、🔫弹打仗要耗、🛰情报看得更远、⚡战备是部队状态。"
       + "右边那个「弹出面板」能把我们几个的对话框拉成单独一个窗口，嫌挤就用它。",
    nudge: "长官，顶上那排数字就是您的家底，看一眼就行。",
    done: (c) => c.sinceStepStart >= 12,   // 读一拍（12 游戏秒）自动往下
  },
  {
    // ★ 台词结构（用户 2026-09-06 定）：**给一句示范 + 明说可以随便讲**。
    //   只给示范，玩家会当成咒语照念；只说随便讲，他对着空输入框不知道从哪开口。
    id: "talk_emily",
    settleSec: SETTLE_SEC_TALK,
    targets: ["chan:logistics", "btn:input", "btn:mic", "fac:barracks"],
    say: "后勤归艾米莉。点上面闪着的「艾米莉中尉」，跟她说句话——比如「造两个步兵」。"
       + "打字或者按住麦克风说都行，两个都在闪。不用照着念，您想怎么说就怎么说。"
       + "造出来的新兵会出现在闪着的那个我军兵营旁边。",
    nudge: "长官，艾米莉那边还没您的消息。点她的名字，打字或按住麦克风都行——"
         + "让她造两个步兵，一会儿要用。",
    done: (c) => c.playerSpokeIn("logistics"),
  },
  {
    // ★ 用户 2026-09-08：下完生产令之后，让玩家看一眼「军械」——知道到底能造什么，
    //   以后才说得出口。判据只要他**切到那一页**，不要求他看懂（判松同一条道理）。
    id: "see_arsenal",
    targets: ["btn:paneltab"],
    say: "对了，在艾米莉这儿点一下右上角闪着的「军械」——那一页列着现在能造什么、"
       + "各要多少钱。看一眼心里有数，以后想造什么直接跟她说就行。",
    nudge: "长官，右上角那个「军械」页签点一下，看看手上能造哪些兵。",
    done: (c) => c.playerSawArsenal(),
  },
  {
    id: "talk_marcus",
    settleSec: SETTLE_SEC_TALK,
    // ★ 用户 2026-09-09 手测：上一步刚看过「军械」，页签停在面板页 ⇒ 点到马克斯
    //   落在他的「计策」页，看不见对话框。所以「通讯」页签也要亮、台词也要点名。
    targets: ["chan:ops", "btn:chattab", "btn:input", "btn:mic"],
    say: "马克斯管战况判读。点闪着的「马克斯上尉」——刚才您在看军械，"
       + "记得把右上角切回闪着的「通讯」，才看得见对话框。"
       + "然后问他一句，比如「现在什么情况」。打字、语音，怎么问都行。",
    nudge: "长官，还没跟马克斯说过话。点他的名字，右上角切到「通讯」，问一句就行。",
    done: (c) => c.playerSpokeIn("ops"),
  },
  {
    // ★ 用户 2026-09-08 加的一步：让艾米莉造的兵派上用场，凑够三个队长。
    //   ⚠ 卡点提醒：玩家手上原有的兵在前两步就编完了，指挥官与卫队是
    //   `SQUAD_EXCLUDED_TYPES`（createSquad 会滤掉）⇒ **不生产就编不出第三队**。
    //   所以台词与催促都必须把"先让艾米莉造兵"说出来，否则这一步是个死结。
    id: "squad_3",
    nudgeAfterSec: NUDGE_AFTER_SEC_SLOW,   // 要等艾米莉把兵造出来
    // ★ 用户 2026-09-09 手测：这一步玩家还在马克斯的频道，而**「编队」键只在
    //   陈的频道里才有**（ChatPanel: `onCreateSquad && isChenChannel`）——
    //   不先回陈那儿，他根本按不到那个键。所以陈的频道键也要亮、台词也要点名。
    targets: ["chan:combat", "units:unsquadded", "btn:squad", "fac:barracks"],
    say: "长官，先切回我这儿——上面闪着的「陈军士」，编队的按钮在我这边才有。"
       + "然后把兵营旁边艾米莉刚造的那批新兵圈起来，点「编队」编成第三队，"
       + "这样您手上就有三个队长了。要是还没造，先跟艾米莉要两个步兵。",
    nudge: "长官，先点回闪着的「陈军士」，再把兵营旁边的新兵圈起来点「编队」；"
         + "还没造的话，先让艾米莉造两个步兵。",
    done: (c) => c.state.squads.length >= 3,
  },
  {
    // ★ 编队层级引导（用户 2026-09-08）：教"两队并一队、点名上级＝整个都动"。
    id: "merge_squads",
    // 「编制」页签同样只在陈的频道里（陈＝编制／艾米莉＝军械／马克斯＝计策）
    targets: ["chan:combat", "btn:paneltab"],
    say: (c) => {
      // 已经合过了就直接点名那个人；还没合就先讲怎么合（这一步刚开始时的常态）。
      const child = c.state.squads.find((sq) => !!sq.parentSquadId);
      const boss = child && c.state.squads.find((sq) => sq.id === child.parentSquadId);
      const who = boss?.leaderName;
      return "右边「编制」页签点开——那儿能看见每个队长手下都有谁。"
        + "用鼠标把一个队长拖到另一个队长身上，两支队就合成一支，被拖上去的那个是上级。"
        + (who
          ? `合完了：${who} 现在是上级。以后您只要说「${who} 进攻某某地方」，他手下两支队会一起动。`
          : "合完之后，您只要点那个上级队长的名字下令——比如「让他进攻某某地方」——"
            + "他手下两支队就会一起动。这一步不急，先合上再说。");
    },
    nudge: "长官，去右边「编制」页签，把一个队长拖到另一个队长身上——两队就并成一队了。",
    done: (c) => c.state.squads.some((sq) => !!sq.parentSquadId),
  },
  {
    // ★ 插旗（用户 2026-09-08 要的）：这是真功能，不是点缀——玩家自己起的名字会进
    //   信封的 TAGS 节，之后他说「去战狼点」参谋听得懂（语音刀实测该类名字 10/10）。
    //   门槛也低：按 T、点一下、起个名，卡不住人。
    //
    //   ★「别跟已有地名重名」这句指得回真机制，不是吓唬人：
    //   `nearestPlaceScan`（frontEscalationPayload.ts）里**标记绝对优先**——
    //   半径内有 tag，设施根本不参与比较。重名 ⇒ 地图上两个「烽火台」，
    //   陈说的和长官想的对不上。
    id: "place_tag",
    targets: ["btn:input"],
    say: "还有一手您会用得上：按一下键盘 T，再在地图上点一个地方，给它起个名字——"
       + "比如「三角洲」。那儿就成了您自己的地标，以后跟我说「去三角洲」我就懂。"
       + "名字随您起，只要别跟地图上已有的地名重样——重了我分不清您说的是哪个。",
    nudge: "长官，试试按 T 再点地图上一个点，起个名字——起个新名，别跟现成的地名重样。",
    done: (c) => (c.state.tags?.length ?? 0) >= 1,
  },
  {
    // ★ 第一次占领刻意选中立、无人守的烽火台：先在没有战斗的情况下把机制教干净，
    //   还给一个看得见的奖励（东边迷雾散开）。打仗留给下一步。
    id: "take_beacon",
    nudgeAfterSec: NUDGE_AFTER_SEC_SLOW,
    targets: ["fac:beacon", "btn:input", "btn:mic"],
    say: (c) => {
      const who = leaderNamesOf(c)[0];
      return "来真的。地图中间闪着的那座烽火台没人守，占下它东边就亮了，能看见敌人在哪。"
        + (who
          ? `跟我说一句就行——比如「派 ${who} 去占领烽火台」。换成您别的队长也行，`
          : "跟我说一句就行——比如「派一队人去占领烽火台」。")
        + "怎么说都行，我听得懂。";
    },
    nudge: "长官，烽火台还空着。跟我说「派某某去占领烽火台」，或者直接右键点它也行。",
    done: (c) => c.state.facilities.get("tut_beacon")?.team === "player",
  },
  {
    // ★ 胜负条件在这一步讲（用户 2026-09-08）：玩家正要去打那个点，
    //   此刻指着顶栏的 OBJECTIVES 说"占它就算赢"最有画面。
    id: "take_post",
    nudgeAfterSec: NUDGE_AFTER_SEC_SLOW,
    targets: ["fac:enemy_post", "hud:objectives"],
    say: (c) => {
      const [a, b] = leaderNamesOf(c);
      const demo = a && b
        ? `可以说「派 ${a} 去攻占敌军哨站」，也可以说「派 ${a} 和 ${b} 一起打敌军哨站」，两支队就一块儿上。`
        : a
          ? `可以说「派 ${a} 去攻占敌军哨站」；想让两个队长一块儿上，就把两个名字都说出来。`
          : "可以说「派某某去攻占敌军哨站」；想让两个队长一块儿上，就把两个名字都说出来。";
      return "东岭上那个插着旗的敌军哨站在闪——占下它这一关就算赢，"
        + "顶上「OBJECTIVES」那个数就是记这个的，插旗的点占几个算几个。"
        + "它有人守，别一个人上：" + demo + "怎么说都行。"
        + "还能顺手指定阵型——「楔形阵冲敌军哨站」是尖头突破，「长蛇阵」是沿路走。"
        + "真想一次压上去，就说「全军进攻敌军哨站」，能动的都会去。";
    },
    nudge: "长官，敌军哨站还在敌人手里。跟我说派谁去打——一个队长嫌少就点两个名字。",
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
  /** 这一步的开场白还没说出口——正在"静一拍"。null ＝ 已经说过了。
   *  静拍期间 `currentTargets` 返回空：**不说话就什么都不闪**，
   *  免得玩家还在跟艾米莉说话、马克斯的键就先亮了。 */
  sayAt: number | null;
}

export function initialGuideState(now: number): GuideState {
  // 开场第一句由调用方直接发（openingLine），所以这里 sayAt 已经是 null
  return { index: 0, stepStartedAt: now, nudged: false, sayAt: null };
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
  // ⓪ 正在"静一拍"：时间到了才把这一步的话说出口，没到就完全安静。
  //    ★ 催促计时从**说出口那一刻**起算，不从上一步完成起算——
  //      否则静拍会白吃掉玩家的思考时间。
  if (g.sayAt !== null) {
    if (now < g.sayAt) return { say: null, next: g };
    // ★ 时间到了，但参谋还在回话 ⇒ 再等一拍。用户手测：马克斯话长，
    //   静拍走完他还没说完，陈就插进来了。等他说完比猜一个秒数准。
    if (c.advisorBusy()) return { say: null, next: g };
    const line = g.index < GUIDE_STEPS.length ? resolveSay(GUIDE_STEPS[g.index].say, c) : OUTRO_LINE;
    return { say: line, next: { ...g, sayAt: null, stepStartedAt: now, nudged: false } };
  }

  if (g.index >= GUIDE_STEPS.length) return { say: null, next: g };

  const step = GUIDE_STEPS[g.index];

  // ① 完成 → 进下一步，但**先静一拍**再开口（下一拍由 ⓪ 说出来）
  if (step.done(c)) {
    const settle = step.settleSec ?? SETTLE_SEC;
    const next: GuideState = {
      index: g.index + 1, stepStartedAt: now, nudged: false, sayAt: now + settle,
    };
    return { say: null, next };
  }

  // ③ 卡住了 → 催一次（一步只催一次）
  //   ★ 两道闸，缺一不可：等够时间**且**这段时间里他一下都没动过。
  //     只看时间会催到正在操作的人；只看动作会永远不催（他一直在乱点）。
  const wait = step.nudgeAfterSec ?? NUDGE_AFTER_SEC;
  if (!g.nudged && now - g.stepStartedAt >= wait && !c.playerActedSince(g.stepStartedAt)) {
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

/** 当前这一步要点亮的东西；引导走完或这一步没有目标就返回空数组。
 *  UI 层每拍读它——**没有第二份状态**，脉冲跟着引导进度自动生灭。 */
export function currentTargets(g: GuideState | null): readonly GuideTarget[] {
  if (!g || g.index >= GUIDE_STEPS.length) return EMPTY_TARGETS;
  // 静拍期间什么都不闪——话还没说，先亮起来就是"抢跑"（用户手测：
  // 还在跟艾米莉说话，马克斯的键已经在闪了）。
  if (g.sayAt !== null) return EMPTY_TARGETS;
  return GUIDE_STEPS[g.index].targets ?? EMPTY_TARGETS;
}
const EMPTY_TARGETS: readonly GuideTarget[] = [];

/** 旧接口的兼容壳：返回第一个目标或 null。台架里还在用它做单值断言。 */
export function currentHint(g: GuideState | null): GuideTarget | null {
  return currentTargets(g)[0] ?? null;
}

/** 开场那一句（第 0 步的 say）。由调用方在引导启动时发一次。 */
export function openingLine(): string {
  return resolveSay(GUIDE_STEPS[0].say, null);
}

/** 台词可能是函数——统一在这里解开。ctx 缺席时函数式台词退回它的兜底写法。 */
export function resolveSay(
  say: string | ((c: GuideCtx) => string), c: GuideCtx | null,
): string {
  return typeof say === "string" ? say : (c ? say(c) : "");
}
