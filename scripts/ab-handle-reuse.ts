// ============================================================
// AI Commander — B3 号复用台架（同一批人，别每回合换一个号）
//
// Modes:
//   --synthetic   确定性断言（不调模型）。默认，进全家扫描。
//
// Run（worktree 根）：
//   npx tsx scripts/ab-handle-reuse.ts --synthetic
//
// 病历：LEDGER B3（G38→G42、G32→G39、G45→G53，刀② 手测 G12→G33 同局
// 00:59/02:48 是最短一手证据）。机制：`mintSpokenForce` 有两个调用点，
// 都在 `intelDigest` 里，而 digest **每条命令重建一次** ⇒ 每回合每行无条件
// `mintOne`、`seq++`。
//
// ★R3（裁定 2026-08-12）：RED 必须走**生产 opt-in**
// `buildDigestForChannel(…, mintForceHandles=true)`。那个 flag 的本意就是
// "台架默认不铸票"——**不开它就是在测一条不铸票的死路**，永远绿，永远没意义。
//
// 家法：判据测效果不测措辞。这里的"效果"＝**信封上印出去的那个号**，
// 所以断言从 digest 文本里把号抠出来比，不看内部对象。
// ============================================================

import { createInitialGameState, resetEscalationTickets } from "@ai-commander/core";
import type { GameState } from "@ai-commander/shared";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";

const MODE = process.argv[2] ?? "--synthetic";

let bad = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) bad++;
};

/** 生产路径印一次信封（opt-in 铸票），把「群名 → 番号」抠出来。 */
function printedHandles(state: GameState): Map<string, string> {
  const digest = buildDigestForChannel(state, "combat", undefined, [], undefined, undefined, true);
  const out = new Map<string, string>();
  // 信封里的形状：`- 我军兵营西北未编组群[临时编队G6]: 9units(...)`
  //           与 FRONT_JUDGMENT 行里的 `名字[临时编队G#]`
  for (const m of digest.matchAll(/([^\s\[\]:]+?未编组群)\[临时编队(G\d+)\]/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

function runSynthetic(): void {
  console.log("\n── R1 现场自证：生产 opt-in 真的铸了票（不开 flag 就是测死路）──");
  {
    resetEscalationTickets();
    const s = createInitialGameState("el_alamein");
    const withFlag = buildDigestForChannel(s, "combat", undefined, [], undefined, undefined, true);
    resetEscalationTickets();
    const s2 = createInitialGameState("el_alamein");
    const noFlag = buildDigestForChannel(s2, "combat", undefined, [], undefined, undefined, false);
    check("R1a 开 mintForceHandles ⇒ 信封里有[临时编队G#]",
      /\[临时编队G\d+\]/.test(withFlag), `${(withFlag.match(/\[临时编队G\d+\]/g) ?? []).length} 个号`);
    check("R1b 不开 ⇒ 一个号都没有（证明这个 flag 就是铸票开关，RED 必须开它）",
      !/\[临时编队G\d+\]/.test(noFlag));
  }

  console.log("\n── R2 ★RED：同一批人、连着两回合，号变没变 ──");
  // 真路径：**同一个 state**（战局没动、部队没动、名单逐字节同）连印两次信封,
  // 正是长官连问两句话时发生的事。
  {
    resetEscalationTickets();
    const s = createInitialGameState("el_alamein");
    const first = printedHandles(s);
    const second = printedHandles(s);   // 第二条命令，同一局同一批人
    const changed: string[] = [];
    for (const [name, g1] of first) {
      const g2 = second.get(name);
      if (g2 !== undefined && g2 !== g1) changed.push(`${name} ${g1}→${g2}`);
    }
    check(
      `R2 ★同一批人连印两次，号必须不变（今天预期红）★ 共 ${first.size} 群`,
      changed.length === 0,
      changed.length ? changed.slice(0, 4).join(" | ") : "",
    );
  }

  console.log("\n── R3 号的总量：每回合重铸会让 seq 无限涨 ──");
  {
    resetEscalationTickets();
    const s = createInitialGameState("el_alamein");
    let maxG = 0;
    for (let turn = 0; turn < 5; turn++) {
      for (const g of printedHandles(s).values()) maxG = Math.max(maxG, Number(g.slice(1)));
    }
    const groups = printedHandles(s).size;
    check(
      `R3 五回合之后最大号应仍在群数量级（${groups} 群）而不是五倍（今天预期红）`,
      maxG <= groups * 2,
      `最大号 G${maxG}，群数 ${groups}`,
    );
  }

  console.log(bad === 0 ? "\nALL SYNTHETIC PASS" : `\n${bad} 条不过（修前 RED 阶段：这就是要的红）`);
  process.exit(bad === 0 ? 0 : 1);
}

if (MODE === "--synthetic") runSynthetic();
else { console.log(`未知模式 ${MODE}`); process.exit(1); }
