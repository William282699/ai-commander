// ============================================================
// AI Commander — spoken 层：一个回合里，耳朵到底听见什么
//
// 为什么单独成模块（同 autoExecuteGate 的理由）：这是一条**手感合同**，
// 而它原本会散在 ChatPanel 的三四个闭包里（流式那两处 speak、options 到达
// 那一处、执行回执那一处）——node 台架一格都够不到，于是"语音回合到底出了
// 几声、都是什么"永远只能靠手测碰运气。搬成纯函数，判据才落得下来。
//
// ★ 审定 R2「听觉序列写死」的落点就是这个函数：一个语音命令回合的完整出声
//   序列在这里一次算完，不许在别处再长出第三声。
//
//   语音回合 · spoken 在场（正路）：**只有 spoken 那一声。**
//     执行回执的 speak 并进 spoken 不再单独出声——那 4 个字是 spoken 的真子集，
//     排在它后面等于同一件事说两遍，正是本层要治的播报员感。
//
//   语音回合 · spoken 缺席（兜底）：
//     ① 整段正文（options 到达后才起念，比分层前晚 ~0.3s，R7 登记）
//     → ② 执行回执照旧出声。**这就是今天的行为**——"退回现状"的定义。
//     一条规则覆盖四种缺席：模型忘写 / 白名单吃掉 / JSON 解析失败走兜底 / 通讯中断。
//
// ★★本地即时应答音已砍（用户手测判退 2026-08-10）★★
//   原设计在松手瞬间从 VOICE_CONFIRMS 池里播一句（「收到。」「照办。」），
//   用意是零模型延迟地占住"我在听"那一槽。用户实测原话：**「我刚说完话之后的
//   『长官、照办』这些可以取消，太墨迹了」**。两条独立的理由支持砍掉：
//     ① 墨迹——一个命令回合耳朵里出现三段（应答→正文→回执），用户明确判退；
//     ② **承诺早于理解**（我在步 1 就挂账、当时请审的那一条）当场实锤：
//        长官问「我军兵营附近有没有空闲的部队」——一个**问句**——而池子里抽中的
//        是「动手。」。模型还没听懂，嘴已经先答应了要动手。
//   这一槽现在空着：松手后到 spoken 起念之间没有声音。**若长官反过来嫌"死寂"，
//   复活它只要把这一段接回去**（砍的是调用，不是池子——R6「池子 NEVER EXPAND」
//   照旧成立，一句没加也一句没删）。
//
//   打字回合：★刀B「办法一」之前是「正文边流边念」，现在改成**先缓冲**。
//     用户钉的那条边界（打字路径零改动）到此为止有了一个具名的例外，理由写在
//     下面 planVoiceSpeech 的打字分支里：会动兵的回合，边流边念等于在引擎跑
//     之前就把计划念出去，话收不回来。咨询的内容一字不差，只是开口时间晚到
//     "回复写完＋裁决"那一刻——**这是手感损失，如实登记**。
//
// ★刀B 新增的一条横贯规则（`execTurn`）：**会动兵的回合，这一层一声不出**。
//   耳朵等 `ApplyResult` 出来的执行回执（execReceipt.ts）。四条路由结构不动，
//   只是 finalUtterance / speakExecReceipt 两个字段的取值多认一个输入。
// ============================================================

import { echoesHeard } from "@ai-commander/shared";

export type SpeechRoute =
  | "typed"           // 打字回合＝现状
  | "spoken"          // 语音回合，模型交回了 spoken
  | "prose_fallback"  // 语音回合，spoken 缺席（或复读）→ 退回念正文
  | "silent_echo"     // 语音回合，spoken 与正文**双层复读** → 这一段不出声
  | "engine";         // 这一段是**引擎的裁定**（拒绝／没执行／要问长官）——只念它，spoken 一概不念

export interface VoiceSpeechInput {
  /** 这一轮是不是语音回合。 */
  voiceTurn: boolean;
  /** 模型交回的 spoken。schema 已把空串规范化成 undefined；这里再 trim 一次
   *  是因为本函数也要能被别处（台架、将来的 V1.5）拿着裸数据调。 */
  spoken?: string;
  /** 屏上真出现的那段正文——缺席兜底念的就是它，不是别的什么摘要。 */
  prose: string;
  /** 长官这一轮的原话（heard）。**引擎闸拿它当尺**：要念出去的那段若整句
   *  复读了它，就等于把他的话念回给他——这一层存在的全部理由就是不干这件事。 */
  heard?: string;
  /** retreat-scope 刀B：这一回合**会不会真动兵**。
   *  会动兵 ⇒ 这一段（spoken / 正文）一律不进耳朵，耳朵等 `ApplyResult` 出来的
   *  执行回执。理由是根因而非措辞：这一段文字是模型在引擎跑**之前**写的，
   *  它说的是计划；计划选中 8 个、实际只对 5 个下了令，照念就是假确认。
   *  缺省 false＝不会动兵，逐字等价于刀B 之前。 */
  execTurn?: boolean;
  /**
   * 第七轮：`prose` 是谁的话。
   *   · "model"（缺省）＝模型的咨询内容（回答、提议、反问）：语音回合优先念 spoken（口语那一版）。
   *   · "engine"＝引擎已经裁定的结果（协议失败、通讯失败、没执行、要问长官）：**只念 prose**，
   *     spoken 不管多像话都不念——它是模型在引擎裁定**之前**写的，引擎一旦拒绝，那一版就可能是
   *     假成功（Codex 复现：spoken「那两个已经派过去了」而实际零执行）。prose 为空 ⇒ 这一段不出声
   *     （引擎的那句话由它自己的出口 refuseAloud 念，不在这里念第二遍）。
   * 屏上／耳朵／context 说同一件事的保证就押在这一格：调用方交进来的是屏上那一句，耳朵念的也是它。
   */
  authority?: "model" | "engine";
  /**
   * 第九轮：引擎**附在这一段后面**的事实——批准问题里存下的那份完整方案（「要办的是：…」）。
   * 不论走哪条路（spoken / 正文 / 复读静音）都照念，而且就是屏上那一句里的同一串字：
   * 模型的 CONFIRM 问句只说了北线、方案却含北南两条时，耳朵不能只听模型那半句。
   * 会动兵的回合（execTurn）不念——那一轮耳朵只等执行回执。
   */
  appendix?: string;
}

export interface VoiceSpeechPlan {
  route: SpeechRoute;
  /** 流式期间边流边念正文——语音回合恒 false（正文是写给眼睛的那一版）。 */
  speakProseWhileStreaming: boolean;
  /** 回复到齐时念的那一段；空串＝这一格不出声。 */
  finalUtterance: string;
  /** 执行回执要不要单独出声（R2 二选一的落点）。 */
  speakExecReceipt: boolean;
}

export function planVoiceSpeech(input: VoiceSpeechInput): VoiceSpeechPlan {
  const plan = planBaseSpeech(input);
  const appendix = (input.appendix ?? "").trim();
  if (!appendix || input.execTurn === true) return plan;
  return { ...plan, finalUtterance: [plan.finalUtterance, appendix].filter((x) => x.length > 0).join(" ") };
}

function planBaseSpeech(input: VoiceSpeechInput): VoiceSpeechPlan {
  const spoken = (input.spoken ?? "").trim();
  const execTurn = input.execTurn === true;

  // 第七轮：引擎的裁定——打字、语音一个样：念屏上那一句，spoken 不参与。
  if (input.authority === "engine") {
    return {
      route: "engine",
      speakProseWhileStreaming: false,
      finalUtterance: execTurn ? "" : input.prose.trim(),
      speakExecReceipt: true,
    };
  }

  // 打字回合。★刀B「办法一」改了这里：不再**边流边念**。
  //   为什么必须改：流式那一刻还不知道这回合会不会动兵（模型先写正文、后写
  //   JSON），照旧边流边念 ⇒ 会动兵的回合，耳朵在引擎跑之前就把计划念出去了，
  //   话收不回来。办法一＝流式期间只收不念，等裁决完再决定放哪一段。
  //   代价如实登记：咨询失去"边写边念"的临场感，开口时间晚到"回复写完＋裁决"
  //   那一刻。这是手感损失，不是零成本（用户已定办法一，计划 §5）。
  if (!input.voiceTurn) {
    return {
      route: "typed",
      speakProseWhileStreaming: false,
      // 会动兵 ⇒ 缓冲整段丢弃，耳朵改听执行回执。
      finalUtterance: execTurn ? "" : input.prose.trim(),
      speakExecReceipt: true,
    };
  }

  // ★引擎闸（Fable 裁定 2026-08-10，替代改 prompt）：
  //   spoken 整句复读了长官的原话 ⇒ **视同缺席**，走 R7 退回念正文。
  //   理由见 speechEcho.ts：这一格跟输入质量走、措辞管不住，而 spoken 又是
  //   唯一会被念出来的那段文字。真信封 N=20 实测 6/20 犯病。
  if (spoken.length > 0 && !echoesHeard(spoken, input.heard)) {
    return {
      route: "spoken",
      speakProseWhileStreaming: false,
      // 刀B：会动兵 ⇒ spoken 也不念。它同样是**执行之前**写的那一版，
      //   而这一回合耳朵只许听一声——那一声得是真结果。
      finalUtterance: execTurn ? "" : spoken,
      speakExecReceipt: execTurn ? true : false,
    };
  }

  // 兜底之前拿同一把尺量正文：正文也是复读 ⇒ **双层复读**。
  const prose = input.prose.trim();
  if (prose.length > 0 && !echoesHeard(prose, input.heard)) {
    return {
      route: "prose_fallback",
      speakProseWhileStreaming: false,
      finalUtterance: execTurn ? "" : prose,
      speakExecReceipt: true,
    };
  }

  // ★有意行为登记（T1j）：双层复读 ⇒ **这一段不出声**。
  //   与「不许静默」那条不冲突——那条管的是**信息丢失**，而复读零信息：
  //   把长官刚说的话念回给他，他没多知道一个字。执行回执照旧出声，
  //   所以"到底办没办"这个信息一点没少。
  //   犯病率由服务端 `voice_heard` 的 echo 标记计数（同一把尺），不靠这里。
  return {
    route: "silent_echo",
    speakProseWhileStreaming: false,
    finalUtterance: "",
    speakExecReceipt: true,
  };
}
