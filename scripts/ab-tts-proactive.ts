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

function runAll(): void {
  normalVoiceTurn();
  staleAcrossTurns();
  neverAdopted();
  expired();
  proactiveNotCounted();
  boundaries();
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
