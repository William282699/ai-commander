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
  type SpeakCandidate,
} from "../apps/web/src/proactiveSpeech";

let passCount = 0;
let failCount = 0;
const NEGCTL = process.argv[2] === "--negctl";

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (ok) passCount++;
  else failCount++;
}
function checkKnife(name: string, after: boolean, before: boolean, detail = ""): void {
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
}

function main(): void {
  if (NEGCTL) console.log("=== NEGCTL：★ 持修复前预期（只要 mark 在就记），必须出 FAIL ===");
  console.log("== 请示要缠人刀 · 步1 探针消费闸 ==");
  runAll();
  console.log(`\nPASS=${passCount} FAIL=${failCount}`);
  if (NEGCTL) {
    // 绊索常驻化：★ 条若哪天不再分辨得出修复前后（有人把闸削弱了），这一行
    // 就从 NEGCTL OK 变 BAD，硬线直接红——绊索不是跑一次就完的仪式。
    const ok = failCount > 0;
    console.log(ok ? `NEGCTL OK — ${failCount} 条 ★ 真 FAIL` : "NEGCTL BAD — 断言不承重");
    process.exit(ok ? 0 : 1);
  } else {
    console.log(failCount === 0 ? "ALL PASS" : `${failCount} FAILED`);
    process.exit(failCount === 0 ? 0 : 1);
  }
}

const mode = process.argv[2];
if (mode === "--synthetic" || mode === "--negctl") main();
else console.log("usage: tsx scripts/ab-tts-proactive.ts --synthetic | --negctl");
