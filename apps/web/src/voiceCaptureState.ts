// ============================================================
// AI Commander — 采集状态机（刀 C 头部盲区）
//
// 为什么单独成模块：刀 C 的本体是**时序**——"按下的那一刻设备已经在收音了"。
// 时序活在浏览器里，node 台架一格都够不到；但时序背后的那条**不变量**够得到：
//
//     没按下 ⇒ 一个样本都不许留。
//
// 这条不变量正是"麦克风一直开着"这个决定的全部安全边界。它要是哪天被人改反了，
// 游戏就变成了一个常开的录音机——所以它必须被机器咬着，不能只写在注释里。
//
// ★ 分账（提案 §6，Fable 审定）：本模块的断言是**结构断言，不冒充效果断言**。
//   "首词有没有被吃掉"只有长官的真麦能判；合成假麦连"设备开启"这一段都没有，
//   结构上表达不出那个病（刀 B 先例）。这里管的是另一件事：常开之后，
//   不按的时候到底留没留东西。
// ============================================================

export interface CaptureState {
  /** 设备与音频图是否已握在手里（开局一次，松手不撒手——这是刀 C 的本体）。 */
  armed: boolean;
  /** 按下到松手之间。**只有这一段的样本会被留下。** */
  collecting: boolean;
  /** 本次按下已收的样本数（每次按下清零）。 */
  frames: number;
}

export const IDLE_CAPTURE: CaptureState = { armed: false, collecting: false, frames: 0 };

/** 设备到手。**不自动开始收**——握住 ≠ 在录，这两件事分开正是本刀的全部意思。 */
export function onArmed(s: CaptureState): CaptureState {
  return { ...s, armed: true };
}

/** 释放设备（组件卸载 / 切到不收音的频道）。收集中被释放 ⇒ 一并停止。 */
export function onDisarmed(s: CaptureState): CaptureState {
  return { armed: false, collecting: false, frames: 0 };
}

/**
 * 按下。
 *
 * ★没 armed 就按下**不进入 collecting**：设备还没到手，此刻"开始录"是句假话，
 * 而假话会一路传到 🔴 指示灯上——那正是本刀要治的病（旧代码先亮灯后开设备）。
 */
export function onPress(s: CaptureState): CaptureState {
  if (!s.armed) return s;
  return { ...s, collecting: true, frames: 0 };
}

/** 松手。停止收集，**armed 保持不变**——不拆设备，下一次按下才没有盲区。 */
export function onRelease(s: CaptureState): CaptureState {
  return { ...s, collecting: false };
}

/** 放弃这次（切频道、手滑）。已收的丢掉，设备照旧握着。 */
export function onCancel(s: CaptureState): CaptureState {
  return { ...s, collecting: false, frames: 0 };
}

/**
 * 一帧到手，留还是不留。
 *
 * 常开之后每秒有 ~21 次回调**一直在响**（图是热的），所以这个判定是全仓最热的
 * 一条路：它每响一次就要回答一次"这一帧该不该进内存"。答错一次的后果不是性能，
 * 是隐私。
 */
export function onFrame(
  s: CaptureState,
  frameLen: number,
  maxFrames: number,
): { keep: boolean; next: CaptureState } {
  if (!s.collecting) return { keep: false, next: s };
  if (s.frames >= maxFrames) return { keep: false, next: s };  // 封顶（沿用 MAX_SECONDS 语义）
  return { keep: true, next: { ...s, frames: s.frames + frameLen } };
}

/**
 * 这一刻音轨该不该静音。
 *
 * 不在收集 ⇒ 静音。`track.enabled = false` 让浏览器往图里送**数字静音**，
 * 于是"不按的时候我们不留声音"这件事从"我们的代码有良心"变成"根本没东西可留"。
 * 它是个标志位不是设备操作，翻回来是即时的 ⇒ 不牺牲零盲区。
 */
export function shouldMute(s: CaptureState): boolean {
  return !s.collecting;
}
