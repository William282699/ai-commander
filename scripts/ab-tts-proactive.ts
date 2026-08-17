// ============================================================
// AI Commander — 「请示要缠人」刀台架（主判据下沉处）
//
// 本刀的判据主力按 plan §4「判据下沉」放在这里：能纯函数化的一律用 node 断言，
// 浏览器只留「确实进喇叭」那 2-3 格＋canary。
//
// 步 1（卫生刀＋探针四件）覆盖：延迟 A/B 探针的消费闸 shouldRecordSpeechDiag。
//
// 现场（勘察档 T3，v3 判定为**真·现存 bug**，不是接线后才有的前瞻风险）：
//   `releaseAtRef` 原来只有两个清点——观察者记下第一声时清、cancelPTT 清。
//   「松手了但这一轮压根没出声」的回合（喇叭没开／silent_echo 双层复读／录音
//   作废／断网）会把计时起点留在身上，被**之后任意一回合**的第一声消费掉，
//   包括一个纯打字回合念正文。产出的 firstSoundMs 量级完全错，还照样搭下一条
//   命令回服务端进日志。
//
// 判据形状（家法：测效果不测措辞）：断言**闸的判定结果**，不断言源码里有那行字。
//   --negctl 持"修复前预期"＝「只要 mark 在就记」，★ 条必须真 FAIL——
//   这就是本步的绊索：断言若不承重，NEGCTL 会全绿。
//
//   npx tsx scripts/ab-tts-proactive.ts --synthetic
//   npx tsx scripts/ab-tts-proactive.ts --negctl
// ============================================================

import {
  shouldRecordSpeechDiag,
  SPEECH_DIAG_MAX_AGE_MS,
  type ReleaseMark,
} from "../apps/web/src/speechDiagGate";
import {
  shouldSpeakMessage,
  spokenKey,
  personaOf,
  isDeferrable,
  UTTERANCE_MAX_AGE_SEC,
  type SpeakCandidate,
  type SpeakContext,
} from "../apps/web/src/proactiveSpeech";
import { decideEscalationFollowup, nagPoolSizes, nagLinesOf, EXPIRE_FALLBACK, type EscalationWatch } from "../apps/web/src/nagContract";

let passCount = 0;
let failCount = 0;
/** ★5b/B6：★ 刀的**总数**。negctl 的硬线从"有红就算过"改成"必须条条红"——
 *  原来 15 把刀里 14 把失效仍会打 NEGCTL OK 并 exit 0，覆盖面只活在
 *  commit message 的人工抄写里，机器不认。这个计数由 checkKnife 自增，自维护。 */
let knifeCount = 0;
const NEGCTL = process.argv[2] === "--negctl";

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) passCount++;
  else failCount++;
}
function checkKnife(name: string, after: boolean, before: boolean, detail = ""): void {
  knifeCount++;
  check(`★ ${name}`, NEGCTL ? before : after, detail);
}

/** 修复前的闸：观察者只看"起点在不在"（ChatPanel 旧代码 `if (t0 == null) return;`）。 */
function preFixGate(mark: ReleaseMark | null): boolean {
  return mark !== null;
}

const T0 = 1_000_000; // 任意 performance.now() 基准，纯函数不吃真实时钟

// ── 正路 ──────────────────────────────────────────────────────

function normalVoiceTurn(): void {
  const mark: ReleaseMark = { at: T0, turn: 7 };
  check(
    "语音回合正路：认领过＋reply＋新鲜 → 记",
    shouldRecordSpeechDiag({ mark, currentTurn: 7, nowMs: T0 + 1800, origin: "reply" }) === true,
  );
}

// ── ★T3 病的四种原形（修复前全部会误记）────────────────────────

function staleAcrossTurns(): void {
  // 病的原形：第 7 回合松手但没出声（喇叭没开），第 8 回合是打字，念正文的
  // 第一声把上一轮的起点吃掉 → 报一个跨回合的假 firstSoundMs。
  const mark: ReleaseMark = { at: T0, turn: 7 };
  const after = shouldRecordSpeechDiag({ mark, currentTurn: 8, nowMs: T0 + 2000, origin: "reply" }) === false;
  const before = preFixGate(mark) === false;
  checkKnife("跨回合残值不记（T3 原形：上一轮无声，下一轮首声吃掉起点）", after, before);
}

function neverAdopted(): void {
  // 这一按压根没发出去（太短/无声/解码失败）：起点无人认领，永远不许被消费。
  const mark: ReleaseMark = { at: T0, turn: null };
  const after = shouldRecordSpeechDiag({ mark, currentTurn: 3, nowMs: T0 + 500, origin: "reply" }) === false;
  const before = preFixGate(mark) === false;
  checkKnife("无人认领的起点不记（按下没发出去）", after, before);
}

function expired(): void {
  const mark: ReleaseMark = { at: T0, turn: 4 };
  const nowMs = T0 + SPEECH_DIAG_MAX_AGE_MS + 1;
  const after = shouldRecordSpeechDiag({ mark, currentTurn: 4, nowMs, origin: "reply" }) === false;
  const before = preFixGate(mark) === false;
  checkKnife("超时作废（认领了但迟迟不出声，不留隔夜饭）", after, before);
}

function proactiveNotCounted(): void {
  // 主动台词没有"松手"这个起点，记进去就是往延迟样本里掺沙子。
  const mark: ReleaseMark = { at: T0, turn: 5 };
  const after = shouldRecordSpeechDiag({ mark, currentTurn: 5, nowMs: T0 + 900, origin: "proactive" }) === false;
  const before = preFixGate(mark) === false;
  checkKnife("主动台词不进延迟 A/B（origin=proactive）", after, before);
}

// ── 边界与退化 ────────────────────────────────────────────────

function boundaries(): void {
  const mark: ReleaseMark = { at: T0, turn: 2 };
  check(
    `恰好 ${SPEECH_DIAG_MAX_AGE_MS}ms 仍记（边界不许滑）`,
    shouldRecordSpeechDiag({ mark, currentTurn: 2, nowMs: T0 + SPEECH_DIAG_MAX_AGE_MS, origin: "reply" }) === true,
  );
  check(
    "起点缺席不记",
    shouldRecordSpeechDiag({ mark: null, currentTurn: 2, nowMs: T0, origin: "reply" }) === false,
  );
  check(
    "负龄不记（时钟回拨/参数写反）",
    shouldRecordSpeechDiag({ mark, currentTurn: 2, nowMs: T0 - 1, origin: "reply" }) === false,
  );
  check(
    "回合号 0 不被当成 falsy 漏判",
    shouldRecordSpeechDiag({ mark: { at: T0, turn: 0 }, currentTurn: 0, nowMs: T0 + 10, origin: "reply" }) === true,
  );
}

// ============================================================
// 步 2（出声地基）：发射侧标记 + 消费侧三道闸
//
// 起算点照 plan 铁律 5：**功能开着，摘掉对应那道闸**——不是"没做功能"的基线
// （那个基线上什么都不念，九条负对照会全绿，等于八个假阳性的"绊索已验"）。
// 下面每个 ★ 的 before 就是那道闸被摘掉之后的判定。
// ============================================================

/** 摘闸①（fail-closed）：不看 utterance，只要 from 是三个人之一就念。 */
function gate1Removed(m: SpeakCandidate): boolean {
  return personaOf(m.from) !== null && !m.groupChat;
}
/** 摘闸②（白名单）：不查 from/persona，只看标记在不在。 */
function gate2Removed(m: SpeakCandidate): boolean {
  return !!m.utterance && !m.groupChat;
}
/** 摘闸③（群聊）：不查 groupChat。 */
function gate3Removed(m: SpeakCandidate): boolean {
  return !!m.utterance && personaOf(m.from) !== null;
}

const CHEN_ESCALATION: SpeakCandidate = {
  id: 11,
  from: "chen",
  utterance: { persona: "chen", kind: "escalation" },
};

function speakGatesPositive(): void {
  const v = shouldSpeakMessage(CHEN_ESCALATION);
  check("正路：陈的升级请示过闸，嗓子＝chen", v.speak === true && v.speak && v.persona === "chen");
  check(
    "kind 透传（步 3 的闸④要靠它认请示）",
    (() => { const r = shouldSpeakMessage(CHEN_ESCALATION); return r.speak && r.kind === "escalation"; })(),
  );
  for (const kind of ["proactive", "retrospect", "advice"] as const) {
    const m: SpeakCandidate = { id: 12, from: "marcus", utterance: { persona: "marcus", kind } };
    check(`正路：马克斯的 ${kind} 过闸`, shouldSpeakMessage(m).speak === true);
  }
}

function gateFailClosed(): void {
  // 没标记的消息（引擎回执/系统行/战报）一律不念——这是整层的地基。
  const m: SpeakCandidate = { id: 21, from: "chen" }; // 无 utterance
  const after = shouldSpeakMessage(m).speak === false;
  checkKnife("闸①fail-closed：没标记不出声（引擎回执/战报不会被顺带念）", after, gate1Removed(m) === false);
}

function gateSystemWhitelist(): void {
  // 勘察档新 HIGH-5：from:"system" 穿过黑名单式否决 → VOICE_CONFIG[persona] 解引用
  // undefined → 同步 TypeError → 全仓无 ErrorBoundary → 整个面板白屏。
  const m: SpeakCandidate = {
    id: 22,
    from: "system",
    utterance: { persona: "system" as never, kind: "proactive" }, // 伪造的不可能态＝纵深防御
  };
  const after = shouldSpeakMessage(m).speak === false;
  checkKnife("闸②白名单：from:\"system\" 挡在 VOICE_CONFIG 解引用之前（防白屏）", after, gate2Removed(m) === false);
}

function gatePersonaMismatch(): void {
  // 标记里的嗓子与 from 对不上＝伪造/串台，两道必须互相印证。
  const m: SpeakCandidate = { id: 23, from: "chen", utterance: { persona: "emily", kind: "proactive" } };
  check("闸②：标记 persona 与 from 不一致 → 不出声", shouldSpeakMessage(m).speak === false);
}

function gateGroupChat(): void {
  // ALL 频道三个人 2.2-4.0s 依次落，念出来是连珠炮。
  const m: SpeakCandidate = {
    id: 24, from: "chen", groupChat: true, utterance: { persona: "chen", kind: "proactive" },
  };
  const after = shouldSpeakMessage(m).speak === false;
  checkKnife("闸③：群聊回复不念（否则三人连珠炮）", after, gate3Removed(m) === false);
}

function gatePlayer(): void {
  // 长官自己那条气泡（含语音回填「🎤 …」原地改同 id 的那条）永不进耳朵。
  const m: SpeakCandidate = { id: 25, from: "player", utterance: { persona: "chen", kind: "proactive" } };
  check("闸②：长官自己的消息不念（回填复读的结构性堵死）", shouldSpeakMessage(m).speak === false);
}

function epochKey(): void {
  // 勘察档新 HIGH-1：clearMessages 把 nextId 重置回 1，而 ChatPanel 不随重开重挂 ⇒
  // 只按 id 去重的话，第一局的已播集合会把第二局同号的新台词全判成"已播"。
  const after = spokenKey(0, 3) !== spokenKey(1, 3);
  const before = String(3) !== String(3); // 摘掉 epoch＝键只有 id
  checkKnife("已播键带 epoch：重开一局同号消息不被误判已播（第二局不哑）", after, before);
  check("同局同号仍判已播", spokenKey(2, 7) === spokenKey(2, 7));
}

function personaNarrowing(): void {
  check("personaOf 收窄：system → null", personaOf("system") === null);
  check("personaOf 收窄：player → null", personaOf("player") === null);
  check("personaOf 收窄：undefined → null", personaOf(undefined) === null);
  check("personaOf 收窄：三个人全过", (["chen", "marcus", "emily"] as const).every((p) => personaOf(p) === p));
}

// ============================================================
// 步 3（闸口）：闸④新鲜度/请示存活 ＋ 闸⑤收音窗
// 起算点同样是"功能开着，摘掉对应那道闸"。
// ============================================================

const NOW = 500; // 游戏钟当下（秒）

/** 摘闸④：不查新鲜度、也不查活单（等价于把 ctx 的那两格喂成永远合格）。 */
function gate4Removed(m: SpeakCandidate): boolean {
  return shouldSpeakMessage(m, { nowGameTime: m.time ?? 0, escalationAlive: true, capturing: false }).speak;
}
/** 摘闸⑤：不查收音窗。 */
function gate5Removed(m: SpeakCandidate, ctx: SpeakContext): boolean {
  return shouldSpeakMessage(m, { ...ctx, capturing: false }).speak;
}

function freshEscalation(time = NOW): SpeakCandidate {
  return { id: 31, from: "chen", time, utterance: { persona: "chen", kind: "escalation" } };
}

function gate4Freshness(): void {
  const stale = freshEscalation(NOW - UTTERANCE_MAX_AGE_SEC - 1);
  const after = shouldSpeakMessage(stale, { nowGameTime: NOW, escalationAlive: true, capturing: false }).speak === false;
  checkKnife("闸④新鲜度：超窗的陈年台词不念（回灌/暂存释放都靠它）", after, gate4Removed(stale) === false);

  check(
    `恰好 ${UTTERANCE_MAX_AGE_SEC}s 仍念（边界不许滑）`,
    shouldSpeakMessage(freshEscalation(NOW - UTTERANCE_MAX_AGE_SEC), { nowGameTime: NOW, escalationAlive: true, capturing: false }).speak === true,
  );
  check(
    "msg.time 缺席＝无从判断，fail-closed",
    shouldSpeakMessage({ id: 32, from: "chen", utterance: { persona: "chen", kind: "proactive" } }, { nowGameTime: NOW, capturing: false }).speak === false,
  );
}

function gate4NegativeAge(): void {
  // 勘察档：llm_advice 那条异步 post 没有重开守卫，上一局的台词会带着上一局的
  // 时钟落进新局（新局钟从 0 起）⇒ age 是大负数。只写 `age > MAX` 会放行。
  const fromLastGame: SpeakCandidate = {
    id: 33, from: "marcus", time: 900, utterance: { persona: "marcus", kind: "advice" },
  };
  const after = shouldSpeakMessage(fromLastGame, { nowGameTime: 12, capturing: false }).speak === false;
  const before = 12 - 900 > UTTERANCE_MAX_AGE_SEC; // 只查上限的旧写法＝放行
  checkKnife("闸④负龄：上一局的台词落进新局不念（只查上限会放行）", after, before);
}

function gate4EscalationAliveOnlyForEscalation(): void {
  // 请示：活单没了就不念（长官已经答过/已经过期）。
  const dead = freshEscalation();
  const after = shouldSpeakMessage(dead, { nowGameTime: NOW, escalationAlive: false, capturing: false }).speak === false;
  checkKnife("闸④请示存活：活单没了的请示不念", after, gate4Removed(dead) === false);

  // ★P1-13 负对照：其余 kind **压根没有活单这回事**，不许拿同一把尺去量。
  //   这一条防的是把闸④写成「所有 kind 都要有活单」——那样 proactive/retrospect/
  //   advice 会全体永久静音，而且不会有任何别的断言抓得到。
  for (const kind of ["proactive", "retrospect", "advice"] as const) {
    const m: SpeakCandidate = { id: 34, from: "marcus", time: NOW, utterance: { persona: "marcus", kind } };
    check(
      `★P1-13 负对照：${kind} 无 escalation 登记也必须出声`,
      shouldSpeakMessage(m, { nowGameTime: NOW, capturing: false }).speak === true,
    );
    check(
      `${kind} 即使 escalationAlive=false 也照念（不查这一格）`,
      shouldSpeakMessage(m, { nowGameTime: NOW, escalationAlive: false, capturing: false }).speak === true,
    );
  }
}

function gate5Capturing(): void {
  const m = freshEscalation();
  const ctx: SpeakContext = { nowGameTime: NOW, escalationAlive: true, capturing: true };
  const v = shouldSpeakMessage(m, ctx);
  checkKnife("闸⑤收音窗：按住说话时到达不开口（否则被录进长官的命令）",
    v.speak === false, gate5Removed(m, ctx) === false);
  check("闸⑤的 deny 是**可延后**的（松手后补播，不是丢弃）",
    !v.speak && v.reason === "capturing" && isDeferrable(v.reason));
  check("其余 deny 都是终局的（不许被当成待补播挂着）",
    (["no_utterance", "from_not_persona", "persona_mismatch", "group_chat", "stale", "escalation_dead"] as const)
      .every((r) => !isDeferrable(r)));
  // 顺序：又旧又在收音 ⇒ 先判 capturing（可延后），松手后再按 stale 终局。
  const old = freshEscalation(NOW - 999);
  const v2 = shouldSpeakMessage(old, ctx);
  check("闸⑤排在闸④之前：又旧又在收音时先判 capturing（不提前钉成终局）",
    !v2.speak && v2.reason === "capturing");
}

// ============================================================
// 步 5（复呼／甩脸）：触发合同四条
// ============================================================

const NAG_SEC = 30;
const A = { actionId: "A", createdAt: 100 };
const B = { actionId: "B", createdAt: 160 };
const watchA = (nagged = false): EscalationWatch => ({ actionId: "A", createdAt: 100, nagged });

/** 摘掉"已回话"这一条（把 lastPlayerMsgTime 当成从来没有）。 */
function replyCheckRemoved(inp: Parameters<typeof decideEscalationFollowup>[0]) {
  return decideEscalationFollowup({ ...inp, lastPlayerMsgTime: null }).action;
}
/** 摘掉 actionId 比对（把快照的号伪装成与 live 一致）。 */
function idCheckRemoved(inp: Parameters<typeof decideEscalationFollowup>[0]) {
  const w = inp.watch ? { ...inp.watch, actionId: inp.live?.actionId ?? inp.watch.actionId } : null;
  return decideEscalationFollowup({ ...inp, watch: w }).action;
}

function contractNag(): void {
  check("没到点不复呼",
    decideEscalationFollowup({ now: 120, live: A, watch: watchA(), lastPlayerMsgTime: null, nagAfterSec: NAG_SEC }).action === "none");
  check("到点复呼",
    decideEscalationFollowup({ now: 130, live: A, watch: watchA(), lastPlayerMsgTime: null, nagAfterSec: NAG_SEC }).action === "nag");
  check("复呼只一次（nagged 之后不再喊）",
    decideEscalationFollowup({ now: 200, live: A, watch: watchA(true), lastPlayerMsgTime: null, nagAfterSec: NAG_SEC }).action === "none");
  check("第一次见到这张单＝先钉快照，不说话",
    decideEscalationFollowup({ now: 130, live: A, watch: null, lastPlayerMsgTime: null, nagAfterSec: NAG_SEC }).action === "track");
}

function contractPlayerReplied(): void {
  // ★P0-3：NOOP/澄清分支**有意保活** escalation ⇒「活单还在」≠「长官没回话」。
  //   长官反问一句「什么情况？」之后还去复呼/甩脸，比原来的静默失败更伤。
  const inp = { now: 130, live: A, watch: watchA(), lastPlayerMsgTime: 110, nagAfterSec: NAG_SEC } as const;
  checkKnife("★长官回过话就不复呼（反问也算回话——否则'你答了他还骂你'）",
    decideEscalationFollowup(inp).action === "drop", replyCheckRemoved(inp) === "drop");

  const inp2 = { now: 300, live: null, watch: watchA(), lastPlayerMsgTime: 110, nagAfterSec: NAG_SEC } as const;
  checkKnife("★答掉的不是黄掉的：回过话之后活单消失＝drop，不甩脸",
    decideEscalationFollowup(inp2).action === "drop", replyCheckRemoved(inp2) === "drop");

  check("回话早于这张单登记＝不算回这张单",
    decideEscalationFollowup({ now: 130, live: A, watch: watchA(), lastPlayerMsgTime: 90, nagAfterSec: NAG_SEC }).action === "nag");
}

function contractExpire(): void {
  // ①过期的唯一真相源＝引擎 TTL：这里只看 live===null，不自数 120 秒。
  check("曾发未答＋引擎说没了 ⇒ 甩脸",
    decideEscalationFollowup({ now: 300, live: null, watch: watchA(), lastPlayerMsgTime: null, nagAfterSec: NAG_SEC }).action === "expire");
  check("没盯着谁就不甩脸（本来就没发过请示）",
    decideEscalationFollowup({ now: 300, live: null, watch: null, lastPlayerMsgTime: null, nagAfterSec: NAG_SEC }).action === "none");
}

function contractActionIdSnapshot(): void {
  // ③ A 过期那一瞬 B 刚登记：必须整条放弃 A，且**不对着 B 喊 A 的话**。
  const inp = { now: 300, live: B, watch: watchA(), lastPlayerMsgTime: null, nagAfterSec: NAG_SEC } as const;
  const d = decideEscalationFollowup(inp);
  checkKnife("★换单：号对不上 ⇒ 重钉快照（不对着 B 喊 A 的话、不拿 A 的账清 B）",
    d.action === "track", idCheckRemoved(inp) === "track");
  check("重钉的快照是 B 的号与 B 的登记时刻",
    d.action === "track" && d.watch.actionId === "B" && d.watch.createdAt === 160 && d.watch.nagged === false);
}

function nagPoolFrozen(): void {
  // ★NEVER EXPAND 的机器锁（照 VOICE_CONFIRMS 先例）。要更自然的措辞＝走 LLM，
  //   不是往池子里加句子——固定句池一旦开始长，就是「台词禁死模板」判死的形态。
  const sizes = nagPoolSizes();
  check(`复呼池封箱·基数：三人各 3 句（实得 ${sizes.join("/")}）`,
    sizes.length === 3 && sizes.every((n) => n === 3));
  // ★5b/B5：只锁基数不锁内容 ⇒ 三句改成任意内容（甚至三句全同）照绿。补内容锁。
  const EXPECT: Record<string, readonly string[]> = {
    chen: ["长官，请回话。", "长官？还等您一句话。", "长官，我这边还等着。"],
    marcus: ["长官，请指示。", "长官？参谋部等您一句话。", "长官，还等您定夺。"],
    emily: ["长官，请回话。", "长官？后勤这边等您一句话。", "长官，我还等着您。"],
  };
  for (const p of ["chen", "marcus", "emily"] as const) {
    check(`复呼池封箱·内容：${p} 三句逐字未变`,
      JSON.stringify(nagLinesOf(p)) === JSON.stringify(EXPECT[p]), JSON.stringify(nagLinesOf(p)));
    check(`复呼池内三句互不相同：${p}`, new Set(nagLinesOf(p)).size === nagLinesOf(p).length);
  }
  // ★5b/B5：串池（陈说了 Emily 那句）现在抓得到——三人的池两两不重合的那部分
  //   足以定位归属。
  check("三人的池不是同一份（串池能被归属判定抓到）",
    JSON.stringify(nagLinesOf("chen")) !== JSON.stringify(nagLinesOf("marcus")) &&
    JSON.stringify(nagLinesOf("marcus")) !== JSON.stringify(nagLinesOf("emily")));
  check("甩脸兜底句三人各一句、互不相同",
    new Set(["chen", "marcus", "emily"].map((p) => EXPIRE_FALLBACK[p as "chen"])).size === 3);
}

function runAll(): void {
  normalVoiceTurn();
  staleAcrossTurns();
  neverAdopted();
  expired();
  proactiveNotCounted();
  boundaries();
  speakGatesPositive();
  gateFailClosed();
  gateSystemWhitelist();
  gatePersonaMismatch();
  gateGroupChat();
  gatePlayer();
  epochKey();
  personaNarrowing();
  gate4Freshness();
  gate4NegativeAge();
  gate4EscalationAliveOnlyForEscalation();
  gate5Capturing();
  contractNag();
  contractPlayerReplied();
  contractExpire();
  contractActionIdSnapshot();
  nagPoolFrozen();
}

function main(): void {
  if (NEGCTL) console.log("=== NEGCTL：★ 持修复前预期（只要 mark 在就记），必须出 FAIL ===");
  console.log("== 请示要缠人刀 · 步1 探针消费闸 ==");
  runAll();
  console.log(`\nPASS=${passCount} FAIL=${failCount}`);
  if (NEGCTL) {
    // 绊索常驻化：★ 条若哪天不再分辨得出修复前后（有人把闸削弱了），这一行
    // 就从 NEGCTL OK 变 BAD，硬线直接红——绊索不是跑一次就完的仪式。
    // ★5b/B6：条条都要红。少红一条＝那把刀不承重，机器必须知道。
    const ok = failCount === knifeCount;
    console.log(ok
      ? `NEGCTL OK — ${failCount}/${knifeCount} 条 ★ 全部真 FAIL`
      : `NEGCTL BAD — 只红了 ${failCount}/${knifeCount}，有 ★ 刀不承重`);
    process.exit(ok ? 0 : 1);
  } else {
    console.log(failCount === 0 ? "ALL PASS" : `${failCount} FAILED`);
    process.exit(failCount === 0 ? 0 : 1);
  }
}

const mode = process.argv[2];
if (mode === "--synthetic" || mode === "--negctl") main();
else console.log("usage: tsx scripts/ab-tts-proactive.ts --synthetic | --negctl");
