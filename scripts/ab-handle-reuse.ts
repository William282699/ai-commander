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
import { isDispatchablePlayerUnit } from "@ai-commander/shared";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { buildReinforceOptions } from "../packages/core/src/frontEscalationPayload";
import {
  mintSpokenForce, mintEscalationTickets, lookupEscalationTicket, burnEscalationTicket,
  ticketPromptLine, spokenNameOf, TICKET_TTL_SEC,
} from "../packages/core/src/escalationTicket";
import type { EscalationTicket } from "../packages/core/src/escalationTicket";

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

  runStep5();

  console.log(bad === 0 ? "\nALL SYNTHETIC PASS" : `\n${bad} 条不过（修前 RED 阶段：这就是要的红）`);
  process.exit(bad === 0 ? 0 : 1);
}

// ============================================================
// 步 5 收官断言
// ============================================================

/** 可调度玩家单位的 id（已排序）——最小名单，够用且确定。
 *
 *  ★必须与生产池同一条筛法（剔 commander + 非 dispatchable）：首版按 id 排序
 *  直接取前 n 个，取到的是 commander 与 elite_guard（manual-only），
 *  于是 ⑤③c 那格「圈成编队」在真信封里根本不出现——**夹具挑错了人，
 *  差点被读成产品缺陷**。台架取样必须照生产的筛法取。 */
function rosterOf(s: GameState, n: number, skip = 0): number[] {
  const ids: number[] = [];
  s.units.forEach((u) => {
    if (u.team !== "player" || u.hp <= 0) return;
    if (u.type === "commander" || !isDispatchablePlayerUnit(u)) return;
    ids.push(u.id);
  });
  return ids.sort((a, b) => a - b).slice(skip, skip + n);
}

function freshScene(): GameState {
  resetEscalationTickets();
  const s = createInitialGameState("el_alamein");
  s.time = 0;
  return s;
}

/** 走 lookup 的一句话结果，便于逐形比对。 */
function refOutcome(raw: string, now: number): string {
  const r = lookupEscalationTicket(raw, now);
  return r.ok ? r.ticket.gNumber : `拒(${r.reason})`;
}

function runStep5(): void {
  console.log("\n── ⑤① 拆组：名单一变就不许复用 ──");
  {
    const s = freshScene();
    const nine = rosterOf(s, 9);
    const g0 = mintSpokenForce(s, null, { label: "甲群", memberIds: nine, etaSec: null })!;
    // 子集
    const gSub = mintSpokenForce(s, null, { label: "甲群", memberIds: nine.slice(0, 5), etaSec: null })!;
    check("⑤①a 子集（9→5 人）不复用，发新号", gSub !== g0, `${g0} vs ${gSub}`);
    // 并组
    const gSuper = mintSpokenForce(s, null, { label: "甲群", memberIds: rosterOf(s, 12), etaSec: null })!;
    check("⑤①b 并组（9→12 人）不复用，发新号", gSuper !== g0 && gSuper !== gSub, `${gSuper}`);
    // 同名单原样再点 ⇒ 仍复用（证明上面两条红不是"谁来都新铸"）
    const gSame = mintSpokenForce(s, null, { label: "甲群", memberIds: nine, etaSec: null })!;
    check("⑤①c ★正对照：名单原样 ⇒ 仍复用（否则上面两条毫无意义）", gSame === g0, `${gSame}`);
    // 旧号不再被重印 ⇒ 到点诚实过期，而不是静默派一张旧名单
    check("⑤①d 旧号停印后如期过期（诚实拒绝，不静默派旧名单）",
      refOutcome(g0, TICKET_TTL_SEC + 1) === "拒(expired)", refOutcome(g0, TICKET_TTL_SEC + 1));
  }

  console.log("\n── ⑤② 挪窝：同名单换了名字，号不变、新旧引用都认 ──");
  {
    const s = freshScene();
    const ids = rosterOf(s, 3);
    const g = mintSpokenForce(s, null, { label: "兵营东北未编组群", memberIds: ids, etaSec: null })!;
    s.time = 60;
    const g2 = mintSpokenForce(s, null, { label: "兵营西北未编组群", memberIds: ids, etaSec: null })!;
    check("⑤②a 挪窝改名 ⇒ 同号", g === g2, `${g}`);
    check("⑤②b 旧 glued 形（首铸名+号）仍解析到同一张票",
      refOutcome(`兵营东北未编组群${g}`, 60) === g, refOutcome(`兵营东北未编组群${g}`, 60));
    check("⑤②c 新 glued 形（最新名+号）解析到同一张票",
      refOutcome(`兵营西北未编组群${g}`, 60) === g, refOutcome(`兵营西北未编组群${g}`, 60));
    check("⑤②d ★负对照：没印过的组合 + 真号 ⇒ 拒",
      refOutcome(`我军机场西未编组群${g}`, 60) === "拒(unknown)", refOutcome(`我军机场西未编组群${g}`, 60));
    // ★这一格才防得住"全局名字池"那种写法：名字是真的、号是真的，但不是这张票印的
    const other = mintSpokenForce(s, null, { label: "南线前哨附近未编组群", memberIds: rosterOf(s, 4, 20), etaSec: null })!;
    check("⑤②e ★★负对照：**别的票**印过的名 + 这个号 ⇒ 拒（证明不是全局名字池）",
      other !== g && refOutcome(`南线前哨附近未编组群${g}`, 60) === "拒(unknown)",
      refOutcome(`南线前哨附近未编组群${g}`, 60));
    check("⑤②f 裸号照旧解析", refOutcome(g, 60) === g);
    check("⑤②g 回执/拒绝话术念的是**最新**印出的名",
      spokenNameOf(lookupEscalationTicket(g, 60).ok ? (lookupEscalationTicket(g, 60) as { ticket: EscalationTicket }).ticket : ({} as EscalationTicket)) === "兵营西北未编组群");
  }

  console.log("\n── ⑤③ burn 一次性 + 编队路不受影响 ──");
  {
    const s = freshScene();
    const ids = rosterOf(s, 3);
    const g = mintSpokenForce(s, null, { label: "甲群", memberIds: ids, etaSec: null })!;
    burnEscalationTicket(g);
    check("⑤③a burn 后点旧号 ⇒ 拒(burned)", refOutcome(g, 0) === "拒(burned)", refOutcome(g, 0));
    const gNew = mintSpokenForce(s, null, { label: "甲群", memberIds: ids, etaSec: null })!;
    check("⑤③b burn 过的票不参与复用（同名单发新号，不会把花掉的人再派一次）",
      gNew !== g, `${g} → ${gNew}`);
  }
  {
    // 圈成编队：这批人从"未编组群"变成 squad，板子不再把它当群行 ⇒ 走编队路
    const s = freshScene();
    const ids = rosterOf(s, 3);
    s.squads.push({
      id: "I9", name: "测试队", unitIds: ids,
      leader: { name: "Zed", rank: "sergeant", personality: "balanced" },
      currentMission: null, missionTarget: null, morale: 0.9, formationStyle: "line",
      ownerCommander: "chen", leaderName: "Zed", role: "leader",
    } as unknown as GameState["squads"][number]);
    // 信封里编制队印成 `Zed(I9,leader)`——首版按 `Zed(I9)` 精确匹配 ⇒ 假红：
    // **断言写错，不是产品错**（本刀第二次栽在夹具/断言上，都留痕）。
    const digest = buildDigestForChannel(s, "combat", undefined, [], undefined, undefined, true);
    const asSquad = digest.includes("Zed(I9");
    // 咬住"不再靠临时番号"：从生产候选集判，别在文本里绕——
    // 这三个人不许再出现在任何一条未编组群里。
    const inGroupRow = buildReinforceOptions(s, null).options
      .some((o) => o.label.endsWith("未编组群") && o.memberIds.some((id) => ids.includes(id)));
    check("⑤③c 圈成编队后按队名点名（Zed(I9,…)），这批人不再出现在未编组群行",
      asSquad && !inGroupRow, `按队名=${asSquad} 仍在群行=${inGroupRow}`);
  }

  console.log("\n── TTL 两族分岔（步3 探针固化）──");
  {
    const s = freshScene();
    const ids = rosterOf(s, 3);
    s.time = 0;   const g = mintSpokenForce(s, null, { label: "甲群", memberIds: ids, etaSec: null })!;
    s.time = 100; mintSpokenForce(s, null, { label: "甲群", memberIds: ids, etaSec: null });
    check("T1 spoken：t=100 重印 ⇒ t=150 仍活（旧起算法在这一格必死）",
      refOutcome(g, 150) === g, refOutcome(g, 150));
    check("T2 spoken：**不再重印** ⇒ t=225 如期死（是滑动窗，不是永生）",
      refOutcome(g, 225) === "拒(expired)", refOutcome(g, 225));
  }
  {
    const s = freshScene();
    const front = s.fronts.find((f) => f.id === "front_center")!;
    const ts = mintEscalationTickets(s, front);
    const e = ts[0];
    check("T3 escalation：t=100 可用", refOutcome(e.gNumber, 100) === e.gNumber);
    check("T4 escalation：**t=150 照旧过期**（mintedAt 起算，⇄ ESCALATION_WINDOW_SEC 未动）",
      refOutcome(e.gNumber, 150) === "拒(expired)", refOutcome(e.gNumber, 150));
  }

  console.log("\n── 跨族不复用（② 修正案的承重梁）──");
  {
    const s = freshScene();
    const front = s.fronts.find((f) => f.id === "front_center")!;
    const ts = mintEscalationTickets(s, front);
    const e = ts[0];
    // 判读行拿**同名单同战线**去铸——按原谓词字面会吃掉这张升级票
    const g = mintSpokenForce(s, front, { label: e.label, memberIds: [...e.unitIds], etaSec: e.etaSec })!;
    check("X1 ★判读行不吃升级票（同名单同战线也必须发新号）", g !== e.gNumber, `esc=${e.gNumber} spoken=${g}`);
    // 板子行（front=null）与判读行（front.id）是两个子形，互不复用
    const gBoard = mintSpokenForce(s, null, { label: e.label, memberIds: [...e.unitIds], etaSec: null })!;
    check("X2 板子行与判读行两个子形互不复用（同信封双号仍在＝B3b，有意为之）",
      gBoard !== g, `判读=${g} 板子=${gBoard}`);
  }

  console.log("\n── escalation negctl 三件式（rider R1）──");
  {
    const s = freshScene();
    const front = s.fronts.find((f) => f.id === "front_center")!;
    const ts = mintEscalationTickets(s, front);
    const e = ts[0];
    // 件一：promptLine 逐字节——escalation 族 printedLabels 恒单条 ⇒ 访问器恒等原值
    const line = ticketPromptLine(s, ts) ?? "";
    check("R1-1 promptLine 里印的就是票面 label（该族永不复用 ⇒ 访问器恒等原值）",
      line.includes(`${e.label}(${e.unitCount}units)`) && e.printedLabels.length === 1,
      `printedLabels=${JSON.stringify(e.printedLabels)}`);
    // 件二：生命周期行为同（T3/T4 已覆盖过期；这里补 burned）
    burnEscalationTicket(e.gNumber);
    check("R1-2 生命周期：burn 后 ⇒ 拒(burned)", refOutcome(e.gNumber, 0) === "拒(burned)");

    // 件三：对象投影 —— ★手钉字段清单，不是"动态取 keys 再剔除"那种恒真形。
    //   将来谁再加第四个字段，实际 keys 会多出一项、下面这条当场红，
    //   于是这条断言兼任「新字段必须报备」的绊索。
    const LEGACY_FIELDS = [
      "gNumber", "unitIds", "label", "unitCount", "targetFrontId",
      "anchor", "etaSec", "mintedAt", "burned",
    ];                                        // targetFacilityId 缺席时不出现（前线族）
    const B3_NEW_FIELDS = ["origin", "printedLabels", "lastPrintedAt"];
    const actual = Object.keys(e).sort();
    const expected = [...LEGACY_FIELDS, ...B3_NEW_FIELDS].sort();
    check("R1-3 ★票据字段集 == 手钉清单（旧 9 项 + B3 新 3 项）——多一项就红＝新字段必须报备",
      JSON.stringify(actual) === JSON.stringify(expected),
      `实际 ${JSON.stringify(actual)}`);
    const projected = Object.keys(e).filter((k) => !B3_NEW_FIELDS.includes(k)).sort();
    check("R1-3b 剔除 B3 三个新字段后的投影 == 旧字段清单（前线族票据形状未变）",
      JSON.stringify(projected) === JSON.stringify([...LEGACY_FIELDS].sort()),
      `投影 ${JSON.stringify(projected)}`);
  }
}

if (MODE === "--synthetic") runSynthetic();
else { console.log(`未知模式 ${MODE}`); process.exit(1); }
