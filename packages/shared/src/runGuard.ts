// ============================================================
// AI Commander — 这条回调还属不属于**当初那一局**（刀癸 / 审核 §六）
//
// 病：`processAdvisorData` 头上有一道按对象身份的重开守卫，那一道是对的。
// 可它**过了之后**还要 `setTimeout(..., 0)` 才真正去 `handleApprove`，而
// `ExecContext` 里没有来源局的任何印记，`handleApprove` 只是重新 `getState()`
// 当场用——中间那一跳只要撞上重开一局，上一局的单子就落进新局。
// 群聊那条路更长：每条回复押 2.2–4 秒才上屏，还带着**旧局的** `state.time`。
//
// 修法：所有会跨过一次事件循环的动作，出发时盖一个"局印"，落地前拿它复核。
//
// ★ 铁律：**守局次与对象身份，不守游戏时间**。新局的钟从 0 起，任何按时间写的
//   迟到闸在重开面前都失效（这条在 postFollowup 那笔账上栽过一次）。
// ============================================================

/** 出发那一刻的局印：局次 + GameState 的**对象身份**。 */
export interface RunStamp {
  epoch: number;
  /** 只比 `===`，不读内容——重开一局会换一个新对象。 */
  state: unknown;
}

export type RunGuardVerdict =
  /** 还是当初那一局，可以落地。 */
  | "same_run"
  /** 局次变了（重开过一局）⇒ 作废。 */
  | "restarted"
  /** GameState 对象被换掉了（轮询还没把 epoch 追上的那个race）⇒ 作废。 */
  | "state_replaced"
  /** 压根没盖印 ⇒ 按作废处理（fail-closed：宁可漏做，不许做错局）。 */
  | "no_stamp";

export function stampRun(epoch: number, state: unknown): RunStamp {
  return { epoch, state };
}

/**
 * 这条回调还属不属于当初那一局。**纯函数**，不碰时间。
 *
 * 两道各管一种走样，缺一不可：
 *   · `epoch` 管"重开过"——它由对象身份的变化推进，是已经被记下来的事实；
 *   · `state` 身份管"刚换、epoch 还没追上"——200ms 轮询留下的那个 race 窗口。
 */
export function judgeRunGuard(
  stamp: RunStamp | null | undefined,
  nowEpoch: number,
  nowState: unknown,
): RunGuardVerdict {
  if (!stamp) return "no_stamp";
  if (stamp.state !== nowState) return "state_replaced";
  if (stamp.epoch !== nowEpoch) return "restarted";
  return "same_run";
}

/** 落地前的唯一问句：这条回调准不准跑。 */
export function runGuardAllows(
  stamp: RunStamp | null | undefined,
  nowEpoch: number,
  nowState: unknown,
): boolean {
  return judgeRunGuard(stamp, nowEpoch, nowState) === "same_run";
}
