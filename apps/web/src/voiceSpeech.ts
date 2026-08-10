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
//   语音回合 · spoken 在场（正路）：
//     ① 本地应答（松手即播，不等模型）→ ② spoken 那一句。**就这两声。**
//     执行回执的 speak 并进 spoken 不再单独出声——那 4 个字是 spoken 的真子集，
//     排在它后面等于同一件事说三遍（「嗯。」→「G13那队这就过去。」→「照办，
//     长官。」），正是本层要治的播报员感；而"我在听"这一槽已被 ① 占住。
//
//   语音回合 · spoken 缺席（兜底）：
//     ① 本地应答 → ② 整段正文（options 到达后才起念，比今天晚 ~0.3s，R7 登记）
//     → ③ 执行回执照旧出声。**②③ 就是今天的行为**——这不是第三种堆叠，
//     这是"退回现状"的定义。一条规则覆盖四种缺席：模型忘写 / 白名单吃掉 /
//     JSON 解析失败走兜底 / 通讯中断。
//
//   打字回合：一个字节不动（用户钉的边界）——正文边流边念、回执照旧出声、
//     没有本地应答。
// ============================================================

export type SpeechRoute =
  | "typed"          // 打字回合＝现状
  | "spoken"         // 语音回合，模型交回了 spoken
  | "prose_fallback"; // 语音回合，spoken 缺席 → 退回念正文

export interface VoiceSpeechInput {
  /** 这一轮是不是语音回合。 */
  voiceTurn: boolean;
  /** 模型交回的 spoken。schema 已把空串规范化成 undefined；这里再 trim 一次
   *  是因为本函数也要能被别处（台架、将来的 V1.5）拿着裸数据调。 */
  spoken?: string;
  /** 屏上真出现的那段正文——缺席兜底念的就是它，不是别的什么摘要。 */
  prose: string;
}

export interface VoiceSpeechPlan {
  route: SpeechRoute;
  /** 录音一到手就播的那一声（走现有 VOICE_CONFIRMS 池，R6：一句不加、只出声不上屏）。 */
  playLocalAck: boolean;
  /** 流式期间边流边念正文——语音回合恒 false（正文是写给眼睛的那一版）。 */
  speakProseWhileStreaming: boolean;
  /** 回复到齐时念的那一段；空串＝这一格不出声。 */
  finalUtterance: string;
  /** 执行回执要不要单独出声（R2 二选一的落点）。 */
  speakExecReceipt: boolean;
}

export function planVoiceSpeech(input: VoiceSpeechInput): VoiceSpeechPlan {
  const spoken = (input.spoken ?? "").trim();

  // 打字回合：逐字等价于分层之前——本函数在这条路上不做任何决定。
  if (!input.voiceTurn) {
    return {
      route: "typed",
      playLocalAck: false,
      speakProseWhileStreaming: true,
      finalUtterance: "",
      speakExecReceipt: true,
    };
  }

  if (spoken.length > 0) {
    return {
      route: "spoken",
      playLocalAck: true,
      speakProseWhileStreaming: false,
      finalUtterance: spoken,
      speakExecReceipt: false,
    };
  }

  return {
    route: "prose_fallback",
    playLocalAck: true,
    speakProseWhileStreaming: false,
    finalUtterance: input.prose.trim(),
    speakExecReceipt: true,
  };
}
