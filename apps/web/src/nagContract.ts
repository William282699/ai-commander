// ============================================================
// AI Commander — 复呼／甩脸的触发合同（纯函数）
//
// 病的后半截：陈主动提问之后，长官没看见 ⇒ 静默过期 ⇒ 兵一直没动，**而且屏上
// 没有任何一行交代这事黄了**。前半截（没声）步 2/3/4 已经治了，这一层管"没交代"。
//
// ★这一层最容易翻车的地方不是"没提醒"，是**提醒错人**：
//   代码里逐字写着（ChatPanel）——「The NOOP / clarification branches above
//   deliberately keep the escalation alive for a follow-up.」也就是说长官回了
//   一句「什么情况？」之后，escalation **照样活着**。若把"活单还在"当成"长官
//   没回话"，陈会对着刚跟他说完话的长官复呼、甩脸。那比原来的静默失败更伤
//   ——所以合同里必须有"自请示登记以来该频道有没有玩家消息"这一条。
//
// 四条合同（plan §5，逐条落在下面的判定里）：
//   ① 过期的唯一真相源＝**引擎 TTL**。这里不自数 120 秒、不新增第四份硬编码：
//      调用方把 `getActiveEscalation(ch, now)` 的结果作为 `live` 传进来，
//      live===null 就是引擎说的"过期了"。
//   ② 一律游戏钟（调用方传 getState().time），由既有 200ms 轮询驱动。
//   ③ actionId 快照比对：号对不上＝换了一张单，**整条放弃**（不对着 B 单喊
//      A 单的话，也不拿 A 的账去清 B）。
//   ④ 自 createdAt 之后该频道有玩家消息 ⇒ 视为已回话，不复呼不甩脸（反问也算）。
// ============================================================

import type { Persona } from "./tts";

// ── 「请示要缠人」刀 · 复呼小池 ────────────────────────────────────────
//
// 定性（审核决断点①裁定）：复呼是**零内容的程序性招呼**，与执行回执前缀
// （VOICE_CONFIRMS）同形，而那个池子正在生产里跑着、既上屏也出声——所以固定池
// 站得住。**甩脸不一样**：它承载内容与情绪，走 LLM＋兜底（见 EXPIRE_FALLBACK）。
//
// ★NEVER EXPAND — 这三句一句都不许加。
//   固定句一旦成了池子就会有人"顺手再写两句"，那正是「台词禁死模板」判死的形态。
//   一局里长官会听见它很多次，池子越大越像在演戏；三句够不重样，多一句都是在往
//   死模板上滑。要更自然的措辞＝走 LLM，不是扩池。
//   台架有计数断言钉死这个数（ab-tts-proactive 的 nagPoolFrozen）。
const NAG_LINES: Record<Persona, readonly string[]> = {
  chen:   ["长官，请回话。", "长官？还等您一句话。", "长官，我这边还等着。"],
  marcus: ["长官，请指示。", "长官？参谋部等您一句话。", "长官，还等您定夺。"],
  emily:  ["长官，请回话。", "长官？后勤这边等您一句话。", "长官，我还等着您。"],
};

/** 甩脸的兜底句（LLM 那条路取不到或跑偏时用）。同样不许扩。 */
export const EXPIRE_FALLBACK: Record<Persona, string> = {
  chen:   "长官没回话，这事我先按兵不动了。",
  marcus: "长官没回话，参谋部这条先搁下了。",
  emily:  "长官没回话，后勤这条先搁下了。",
};

export function nagPoolSizes(): number[] {
  return (Object.keys(NAG_LINES) as Persona[]).map((p) => NAG_LINES[p].length);
}

export function pickNagLine(persona: Persona): string {
  const pool = NAG_LINES[persona];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 盯着的那张单的快照。 */
export interface EscalationWatch {
  actionId: string;
  createdAt: number;
  /** 这张单已经复呼过一次了（复呼只一次）。 */
  nagged: boolean;
}

export interface FollowupInput {
  /** 当前游戏钟。 */
  now: number;
  /** `getActiveEscalation(ch, now)` 的结果——**引擎 TTL 是唯一真相源**。 */
  live: { actionId: string; createdAt: number } | null;
  /** 上一拍留下的快照。 */
  watch: EscalationWatch | null;
  /** 该频道最后一条玩家消息的游戏时刻（`getLastMessageTimeBySource(ch,"player")`）。 */
  lastPlayerMsgTime: number | null;
  /** 复呼阈值（游戏秒）。 */
  nagAfterSec: number;
}

export type FollowupDecision =
  /** 什么都不做（继续等）。 */
  | { action: "none" }
  /** 换单/新单：重钉快照，不说话。 */
  | { action: "track"; watch: EscalationWatch }
  /** 复呼一次。 */
  | { action: "nag" }
  /** 甩脸（这事黄了，说一句交代）。 */
  | { action: "expire" }
  /** 放弃盯这张单（长官已回话）：不说话、不记账。 */
  | { action: "drop" };

/** 自这张单登记之后，该频道有没有来过玩家消息（反问也算回话）。 */
function playerRepliedSince(lastPlayerMsgTime: number | null, createdAt: number): boolean {
  return lastPlayerMsgTime != null && lastPlayerMsgTime > createdAt;
}

export function decideEscalationFollowup(input: FollowupInput): FollowupDecision {
  const { now, live, watch, lastPlayerMsgTime, nagAfterSec } = input;

  if (live) {
    // ③ 号对不上（或第一次见到）＝换了一张单：重钉快照，这一拍不说话。
    //    这一条同时挡住"对着 B 单喊 A 单的话"和"拿 A 的账去清 B"。
    if (!watch || watch.actionId !== live.actionId) {
      return { action: "track", watch: { actionId: live.actionId, createdAt: live.createdAt, nagged: false } };
    }
    // ④ 长官已经回过话了（哪怕只是反问一句）⇒ 不缠。
    //    ★注意这一格为什么必须存在：NOOP/澄清分支**有意保活** escalation，
    //    "活单还在"完全不等于"长官没理你"。
    if (playerRepliedSince(lastPlayerMsgTime, watch.createdAt)) return { action: "drop" };
    // 复呼：只一次。
    if (!watch.nagged && now - watch.createdAt >= nagAfterSec) return { action: "nag" };
    return { action: "none" };
  }

  // live===null：引擎说这张单已经不在了（过期，或被一次可执行的回答清掉了）。
  if (!watch) return { action: "none" };            // 本来就没盯着谁
  if (playerRepliedSince(lastPlayerMsgTime, watch.createdAt)) return { action: "drop" }; // 是答掉的，不是黄掉的
  // ① 曾发过、没答过、引擎说没了 ⇒ 甩脸。
  return { action: "expire" };
}
