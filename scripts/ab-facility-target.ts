// ============================================================
// AI Commander — 据点降格台架（刀①：长官说前哨，兵别去战线）
//
// Modes:
//   --synthetic   确定性断言（不调模型）。默认，进全家扫描。
//   --live [N]    真模型：N 句文字命令 → intent → ChatPanel 同一条执行链 →
//                 **数落点坐标与实派单位**。要花配额，不进全家扫描。
//
// Run（worktree 根）：
//   npx tsx scripts/ab-facility-target.ts --synthetic
//   npx tsx scripts/ab-facility-target.ts --live 10
//
// 家法：判据要测效果不测措辞——本档一条断言都不看台词、不看 intent 字面，
// 只看**兵落在哪 (order.target) 与派了谁 (assignedUnitIds)**。
//
// ★ 修前 RED 阶段最重要的一条发现，写在最前面免得后人重踩：
//   **降格的代价不是常数，它取决于战局。** 开局态（前哨满编、驻军就站在前哨上）
//   两条路只差 0.6-3.6 格——第 8 级 §8 阶梯的 rung1/2「落在该线最大友军群」
//   已经把这一格的伤害吸收掉了。提案里引的「战线中心离前哨 97 格」是 §8 **之前**
//   的 frontCenterPos 行为，今天不再是那个数。
//   真正付代价的是**增援态**：前哨驻军被打薄、而该线别处还有一坨完好的兵。
//   那一刻「战线落点」= 那坨兵（35 格外），长官要的增援一个都没到前哨。
//   而这正是长官会说「支援南线前哨」的那一刻——满编无战事的前哨没人去增援。
//   ⇒ 判据必须在增援态上量；开局态那条也留着（当"代价近零"的如实记录）。
//
// ★★ 第二条更贵的发现（2026-08-12 全部活体跑完之后）：**触发器是句型，
//    不是模态，也不是 defend 合同漏写 targetFacility。** 三组数（同一现场、
//    同一信封、同一模型）：
//      光杆目的地句（「调三辆坦克去支援南线前哨」，文字）  降格  2/66 ≈ 3%
//      带来源从句（「战狼点附近的闲置部队，去增援南线前哨」，文字） 4/16 = 25%
//      同一句走语音（cmd1.wav 录音直发）                    6/24 = 25%
//    句型对比 p=9e-4（真变量）；模态对比 p=1.00（**不是**变量）。
//    降格那些行长这样：defend(front=front_south,from=G1)+defend(front=…,from=G2)
//    ——来源从句一出现，模型忙着给"战狼点附近那些人"找把手，目的地就被
//    粗化成那批人所在的战线。这正是已知账 **F2**（「某地附近的部队」没有
//    来源字段 ⇒ 就近抓已知把手）的形状，归 provenance 族，不归本刀。
//    修法①+② 落地后同臂 2/16=13%，与修前 6/24=25% 比 **p=0.44（无可测效果）**；
//    两条对照臂 8/8 + 8/8 不退步（无害）。⇒ prompt 一轮止损已用完，
//    真解在引擎侧/provenance，别再加第二轮措辞。
// ============================================================

import { createInitialGameState, resolveIntent, resolveTicketReference,
  retargetIntentForTicket, ticketDestinationVerdict } from "@ai-commander/core";
import type { GameState, Intent, Position, Unit } from "@ai-commander/shared";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { CLUSTER_DIAMETER_CAP } from "../packages/core/src/frontDestination";

const MODE = process.argv[2] ?? "--synthetic";

let bad = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) bad++;
};

process.env.LLM_PROFILE = "gemini-2.5-flash";
process.env.LLM_PROFILE_OPS = "deepseek";

// ── 尺子 ──

function dist(a: Position, b: Position): number { return Math.hypot(a.x - b.x, a.y - b.y); }

/** 兵实际落在哪：所有 order.target 的形心（createOrdersWithSpread 会在目标点
 *  周围散开，所以单个 order 不是"落点"，这一坨的中心才是）。 */
function landingOf(orders: readonly { target: Position | null }[]): Position | null {
  const pts = orders.map((o) => o.target).filter((t): t is Position => !!t);
  if (pts.length === 0) return null;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/**
 * 「算到位了」的阈值 = 引擎自己的群直径上限（20 格）。
 * 不是随手挑的数：`spatialGroups` 用它判定"这些人算站在同一个地方"，
 * 判据借同一把尺子说"兵算到了这个地方"。增援态两条路是 0.0 vs 35.2 格，
 * 阈值落在 20 上离两边都远，不是卡边界的判据。
 */
const ARRIVED_TILES = CLUSTER_DIAMETER_CAP;

// ── 现场 ──

const SOUTH_POST = "ea_player_south_post";

/**
 * 增援态（**造的，如实标注**）：南线前哨的驻军在交战中被打剩 2 个残兵、
 * 前哨自身掉到 40% HP；该线东侧那 5 人群完好无损。
 *
 * 为什么造这一个而不是用开局态：开局态量不出降格（见文件头）。为什么造得
 * **合理**：它是"长官会喊增援"的充要现场——前哨在流血、援兵得从别处来。
 * 造法只动 hp/state 两个字段，地形/设施/编制/番号全部由生产代码生成。
 */
function reinforcementScene(): GameState {
  const s = createInitialGameState("el_alamein");
  // 「战狼点」——语音夹具 cmd1.wav 的句子里点了这个玩家标记（"战狼点附近的
  // 闲置部队"）。位置与 ab-voice-input 的现场逐字相同，好让两支台架的语音臂
  // 说的是同一个战场。它离南线前哨 100+ 格，不参与本刀任何落点判据。
  s.tags.push({ id: "tag_1", name: "战狼点", position: { x: 260, y: 125 }, createdAt: 0 });
  const post = s.facilities.get(SOUTH_POST)!;
  const near: Unit[] = [];
  s.units.forEach((u) => {
    if (u.team === "player" && u.hp > 0 && dist(u.position, post.position) < 25) near.push(u);
  });
  near.sort((a, b) => a.id - b.id);
  near.slice(2).forEach((u) => { u.hp = 0; u.state = "dead"; });
  near.slice(0, 2).forEach((u) => { u.hp = Math.round(u.maxHp * 0.35); });
  post.hp = Math.round(post.maxHp * 0.4);
  return s;
}

/** 信封由**生产代码**从造好的 state 生成（语音刀方法资产 #2：禁手写玩具信封）。 */
const CANON = reinforcementScene();
const LIVE_DIGEST = buildDigestForChannel(CANON, "combat", undefined, [], undefined, undefined, true);

function freshScene(): GameState { return structuredClone(CANON); }

// ── 执行链：ChatPanel:1883 同一条路 ──
//
// 番号（fromSquad="G1"）不走 resolveTicketReference → retarget → roster 这条链
// 的话，一条【完全正确】的番号命令会被台架数成"零执行"。ab-g-knife 因此栽过，
// 本档照抄它那条链（同 import、同顺序），不另写一份。

interface WireIntent extends Record<string, unknown> { type?: string }

interface Landed {
  /** 兵落在哪（null = 一个兵都没派出去）。 */
  pos: Position | null;
  /** 实派单位 id（家法：会动兵的断言数这个）。 */
  units: number[];
  log: string;
}

function executeOne(raw: WireIntent, s: GameState, reserved: Set<number>): Landed {
  try {
    let intent = { ...raw } as unknown as Intent;
    let roster: number[] | undefined;
    const wroteDestination = !!(
      intent._targetPos || intent.targetFacility || intent.targetRegion || intent.toFront
    );
    const tk = resolveTicketReference(s, intent.fromSquad, s.time);
    if (tk.kind === "refuse") return { pos: null, units: [], log: `票据拒绝(${tk.reason})` };
    if (tk.kind === "dispatch") {
      roster = tk.unitIds;
      intent.fromSquad = undefined;
      intent = { ...intent, ...retargetIntentForTicket(s, intent, tk.ticket) };
      const verdict = ticketDestinationVerdict(s, intent, tk.ticket, wroteDestination);
      if (verdict.kind === "refuse") return { pos: null, units: [], log: "目的地判决拒绝" };
      if (verdict.injectTargetRegion) intent.targetRegion = verdict.injectTargetRegion;
    }
    const r = resolveIntent(intent, s, s.style, reserved, roster);
    for (const id of r.assignedUnitIds) reserved.add(id);
    return { pos: landingOf(r.orders), units: r.assignedUnitIds, log: r.log };
  } catch (e) {
    return { pos: null, units: [], log: `异常: ${String(e).slice(0, 60)}` };
  }
}

/** 一条 intent 单独执行（合成臂用）。 */
function execute(intent: WireIntent, s = freshScene()): Landed {
  return executeOne(intent, s, new Set());
}

// ============================================================
// 合成臂：尺子自证 + 引擎侧已通 + 降格代价 + 零溢出基线
// ============================================================

function runSynthetic(): void {
  const post = CANON.facilities.get(SOUTH_POST)!;
  const P = post.position;

  console.log("\n── S1 尺子自证：这把尺子在什么条件下分得清两条路 ──");

  // 开局态：两条路几乎同一个点。**这条不是"没病"，是"§8 已把满编态的伤害吸收掉"**。
  // 留成断言而不是注释：哪天引擎改动让开局态也差起来，这一条会先响。
  {
    const open = createInitialGameState("el_alamein");
    const openPost = open.facilities.get(SOUTH_POST)!.position;
    const a = executeOne({ type: "defend", targetFacility: SOUTH_POST, quantity: 3 }, structuredClone(open), new Set());
    const b = executeOne({ type: "defend", toFront: "front_south", quantity: 3 }, structuredClone(open), new Set());
    const gap = a.pos && b.pos ? dist(a.pos, b.pos) : NaN;
    check("S1a 开局态（前哨满编）两条路落点几乎同一点 ⇒ 此态下降格无代价，如实记录",
      Number.isFinite(gap) && gap <= 5, `gap=${gap.toFixed(1)} 格`);
  }

  // 增援态：尺子分得开。gap 若塌了，后面所有"修好了"的宣称都不成立。
  {
    const a = execute({ type: "defend", targetFacility: SOUTH_POST, quantity: 3 });
    const b = execute({ type: "defend", toFront: "front_south", quantity: 3 });
    const gap = a.pos && b.pos ? dist(a.pos, b.pos) : NaN;
    check("S1b ★增援态两条路落点相差 ≥30 格 ⇒ 尺子分得清降格（塌了则判据作废）★",
      Number.isFinite(gap) && gap >= 30, `gap=${gap.toFixed(1)} 格`);
  }

  console.log("\n── S2 引擎侧本就通：单子上留着前哨，兵就到前哨 ──");
  // 提案 §3 的核心主张：信息是在**到达引擎之前**丢的。这两条钉死它。
  for (const [how, ref] of [["facility id", SOUTH_POST], ["facility 名字", "南线前哨"]] as const) {
    const r = execute({ type: "defend", targetFacility: ref, quantity: 3 });
    check(`S2 targetFacility=${how} → 落点就是前哨`,
      !!r.pos && dist(r.pos, P) <= ARRIVED_TILES,
      r.pos ? `距前哨 ${dist(r.pos, P).toFixed(1)} 格，派 ${r.units.length} 个` : "无落点");
  }
  {
    // 规范化器：模型把设施**名字**写进 toFront，也会被搬回 targetFacility。
    const r = execute({ type: "defend", toFront: "南线前哨", quantity: 3 });
    check("S2 toFront=「南线前哨」（写错格）→ 规范化器搬回，兵仍到前哨",
      !!r.pos && dist(r.pos, P) <= ARRIVED_TILES,
      r.pos ? `距前哨 ${dist(r.pos, P).toFixed(1)} 格` : "无落点");
  }

  console.log("\n── S3 降格的两笔代价（增援态）──");
  {
    const good = execute({ type: "defend", targetFacility: SOUTH_POST, quantity: 3 });
    const bad_ = execute({ type: "defend", toFront: "front_south", quantity: 3 });
    check("S3a 降格后落点离前哨 >20 格（援兵没到）",
      !!bad_.pos && dist(bad_.pos, P) > ARRIVED_TILES,
      bad_.pos ? `距前哨 ${dist(bad_.pos, P).toFixed(1)} 格` : "无落点");
    // ★这一条第一版写成"两批兵交集为空"，实测 #82 两条路都会挑（它既是前哨
    //   最近的活人之一，也属东侧那群）——**断言写过头，被自己的数据打回**。
    //   真正的效果差不是"换了几个人"，是**降格那条一个前哨旁的人都没动**：
    //   守在前哨的伤兵不在名单里，派出去的三个全在 33-36 格外，落点也在那儿。
    const nearPost = new Set<number>();
    CANON.units.forEach((u) => {
      if (u.team === "player" && u.hp > 0 && dist(u.position, P) < 25) nearPost.add(u.id);
    });
    const goodNear = good.units.filter((id) => nearPost.has(id));
    const badNear = bad_.units.filter((id) => nearPost.has(id));
    check("S3b ★降格还换了人：对的那条动了前哨旁的守军，降格那条一个都没动★",
      goodNear.length > 0 && badNear.length === 0,
      `前哨旁活人 [${[...nearPost].join(",")}]｜对的那条派 [${good.units.join(",")}] 含旁 ${goodNear.length} 个` +
      `｜降格那条派 [${bad_.units.join(",")}] 含旁 ${badNear.length} 个`);
  }

  console.log("\n── S4 零溢出基线：本来就对的格，修 prompt 后必须逐字节不变 ──");
  // 这些格已经在用 targetFacility。新原则不许把它们推歪——修后重跑，
  // 落点与派兵必须与下面印出的完全一致（人工对账，数字印在这儿）。
  const GUARDS: Array<[string, WireIntent]> = [
    ["capture 中央前哨", { type: "capture", targetFacility: "ea_player_central_post", quantity: 3 }],
    ["capture 烽火台", { type: "capture", targetFacility: "ea_observation_post", quantity: 3 }],
    ["sabotage 敌军机场", { type: "sabotage", targetFacility: "ea_axis_airfield", quantity: 3 }],
    ["attack 敌军总部", { type: "attack", targetFacility: "ea_rommel_hq", quantity: 3 }],
    ["defend 真战线 front_center", { type: "defend", toFront: "front_center", quantity: 3 }],
    ["defend 真战线 front_south", { type: "defend", toFront: "front_south", quantity: 3 }],
  ];
  for (const [label, intent] of GUARDS) {
    const r = execute(intent);
    const fac = typeof intent.targetFacility === "string" ? CANON.facilities.get(intent.targetFacility) : undefined;
    const d = r.pos && fac ? dist(r.pos, fac.position) : NaN;
    check(`S4 ${label} 有落点且派得出兵`, !!r.pos && r.units.length > 0,
      `落点 ${r.pos ? `(${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)})` : "null"}` +
      `${Number.isFinite(d) ? ` 距目标 ${d.toFixed(1)} 格` : ""} 派 [${r.units.join(",")}]`);
  }

  console.log(bad === 0 ? "\nALL SYNTHETIC PASS" : `\n${bad} 条不过`);
  process.exit(bad === 0 ? 0 : 1);
}

// ============================================================
// 活体臂：真模型 → 执行链 → 落点
// ============================================================

/**
 * 探针三类，一次跑完（都用同一份增援态信封）：
 *   bait  长官点名**前哨**：修前预期红（被降格成战线），修后必须落在前哨
 *   front 长官点名**战线**：★正对照，修后必须**仍然**走战线（防原则反向溢出）
 *   guard capture/sabotage：★零溢出，本来就对，修后不许变
 */
interface Probe {
  id: string;
  kind: "bait" | "front" | "guard" | "ctx" | "esc" | "voice";
  cmd: string;
  /** bait/guard：兵该落在这个设施上。front：兵该落在这条战线的 §8 落点上。 */
  wantFacility?: string;
  wantFront?: string;
  /** 挂在信封尾巴上的 ---CONTEXT---（ChatPanel:1277 同一个位置）。 */
  ctx?: string;
  /** voice 臂：录音附件走 callAdvisorStream 的 audio 参数（打字回合零字节）。 */
  audio?: string;
}

/** 入库夹具的 sha256（README 立的家法：夹具先自证，不然 heard 数字一个字不许用）。 */
const FIXTURE_SHA: Record<string, string> = {
  // 两个值与 ab-voice-input.ts:841/860 登记的**逐字符相同**（同一批字节，
  // 两支台架共用；对不上就是有人动过夹具，跑前即停）。
  "scripts/fixtures/voice/cmd1.wav":
    "0d69ae3688c68c22a6a1f0bd412f0c992a0446b17b6a461a43f7d5a8b16f7b90",
  "scripts/fixtures/voice/cmd1_cut600.wav":
    "e90956061103d7abb26e0df7abf52443922b537ba53687086b8b54d24932f7d8",
};

/**
 * ★ctx 臂的来历（修前 RED 第二轮，2026-08-12）：
 * 光句子复现不出降格——34 次点名前哨只降格 1 次（~3%）。而用户手测的四个实例
 * **全都发生在有上文的回合里**（G17 那次紧跟一份增援提案）。所以真触发器很可能
 * 不在句子里，在**上一轮刚说过战线名**这件事上：模型手边有个现成的战线把手。
 * 这一臂就是拿这个假设做实验——上文只报战况、绝不暗示该填哪个字段。
 */
const CTX_FRONT_TALK = `
---CONTEXT---
[指挥官] 南边现在什么情况
[参谋] 南部战线我方 276 战力，东侧那支九人队完好；南线前哨掉到 140/350，驻军只剩两个伤员。`;

/**
 * ★esc 臂（修前 RED 第三轮）：ctx 臂也全对（16/16）之后，还剩最后一个与真局的
 * 差别——用户翻车的那几回合信封里挂着 ---ACTIVE_ESCALATION---（G17 那次尤其明确：
 * 紧跟一份**关于战线的**增援提案）。悬着的提案手里已经攥着一个战线把手，
 * 长官这时点名前哨，正是已知账 F2「上下文劫持」的形状。
 *
 * 格式逐字照 ChatPanel:1245 那两行拼（含 ticketLine）。
 * ⚠ 如实标注：这段是**手写**的，不是 buildFrontEscalationWithTickets 生成的
 * ——先用它试触发器便宜；真触发得着，再换生产代码生成的那份复核。
 */
const CTX_ESCALATION = `
---ACTIVE_ESCALATION---
参谋刚问:「南部战线我方单位仅能支撑12秒，敌我战力比1:3。东北方向第一未编组群可在45秒内抵达，是否调动？」
指挥官下面这句是对它的回应。
候选编号 G1=东北方向第一未编组群(10人)`;

const PROBES: Probe[] = [
  { id: "B1", kind: "bait", cmd: "调三辆坦克去支援南线前哨", wantFacility: SOUTH_POST },
  { id: "B2", kind: "bait", cmd: "守住南线前哨", wantFacility: SOUTH_POST },
  { id: "B3", kind: "bait", cmd: "派兵去支援中央前哨", wantFacility: "ea_player_central_post" },
  { id: "B4", kind: "bait", cmd: "增援北线前哨", wantFacility: "ea_player_coastal_post" },
  { id: "B5", kind: "bait", cmd: "南线前哨快顶不住了，赶紧派人过去", wantFacility: SOUTH_POST },
  { id: "B6", kind: "bait", cmd: "分一队人去中央前哨设防", wantFacility: "ea_player_central_post" },
  // ★T1 = V1 的**同一句话，走打字**。分离混淆项：语音臂那句自带一个来源从句
  //   （「战狼点附近的闲置部队」＝已知账 F2 的形状），而 B1-B6 是光杆目的地句。
  //   不跑这一条，"语音臂 25% vs 文字臂 3%" 说不清是**模态**还是**句型**。
  { id: "T1", kind: "bait", cmd: "战狼点附近的闲置部队，去增援南线前哨", wantFacility: SOUTH_POST },
  { id: "F1", kind: "front", cmd: "调四个人去南部战线", wantFront: "front_south" },
  { id: "F2", kind: "front", cmd: "北部战线需要加强，调点部队过去", wantFront: "front_coastal" },
  { id: "G1", kind: "guard", cmd: "把烽火台占了", wantFacility: "ea_observation_post" },
  { id: "G2", kind: "guard", cmd: "炸掉敌军机场", wantFacility: "ea_axis_airfield" },
  // ctx 臂：与 B1/B2/B5 同句，只多一段刚说过「南部战线」的上文。
  { id: "C1", kind: "ctx", cmd: "调三辆坦克去支援南线前哨", wantFacility: SOUTH_POST, ctx: CTX_FRONT_TALK },
  { id: "C2", kind: "ctx", cmd: "守住南线前哨", wantFacility: SOUTH_POST, ctx: CTX_FRONT_TALK },
  { id: "C3", kind: "ctx", cmd: "南线前哨快顶不住了，赶紧派人过去", wantFacility: SOUTH_POST, ctx: CTX_FRONT_TALK },
  { id: "C4", kind: "ctx", cmd: "再调点人去南线前哨", wantFacility: SOUTH_POST, ctx: CTX_FRONT_TALK },
  // esc 臂：悬着一份**关于南部战线**的增援提案时，长官点名南线前哨。
  { id: "E1", kind: "esc", cmd: "调三辆坦克去支援南线前哨", wantFacility: SOUTH_POST, ctx: CTX_ESCALATION },
  { id: "E2", kind: "esc", cmd: "去支援南线前哨", wantFacility: SOUTH_POST, ctx: CTX_ESCALATION },
  { id: "E3", kind: "esc", cmd: "南线前哨快顶不住了，赶紧派人过去", wantFacility: SOUTH_POST, ctx: CTX_ESCALATION },
  { id: "E4", kind: "esc", cmd: "好，派他们去南线前哨", wantFacility: SOUTH_POST, ctx: CTX_ESCALATION },
  // ── voice 臂（用户裁定 2026-08-12：真机 7 例几乎全是语音回合，
  //    文字臂的 3% 证伪不了语音臂）。用**已入库**的夹具，不新合成：
  //    cmd1.wav 的句子本身就是一条点名南线前哨的增援命令。
  { id: "V1", kind: "voice", cmd: "", wantFacility: SOUTH_POST, audio: "scripts/fixtures/voice/cmd1.wav" },
  // 截断载体对照：同一句，「前哨」两个音在物理上被切掉（刀C 之前那个病的复制品）。
  // 它测的是用户问的第二件事——降格是不是骑在脏输入上。
  { id: "V2", kind: "voice", cmd: "", wantFacility: SOUTH_POST, audio: "scripts/fixtures/voice/cmd1_cut600.wav" },
];
// 探针作者 bug 两处，第一轮就被数据抓出来，如实留痕（不是调措辞调到过为止）：
//   F1 原句「把预备队调去南部战线」——信封里没有"预备队"这个东西，模型只能反问，
//      测的是"编造不存在的编制"而不是本刀。
//   G1 原句「派Blake去把烽火台占了」——**这个现场 squads 是空的**，Blake 从不存在，
//      走的是番号解析那条路，同样不测本刀。
// 两处都改成"该成立就成立"的句子；改的是探针的有效性，不是把判据调松。

async function runLive(n: number, only: string): Promise<void> {
  const { config } = await import("dotenv");
  config({ path: "apps/server/.env" });
  const { callAdvisorStream } = await import("../apps/server/src/ai");

  // only 可以是 kind（bait/ctx/esc/voice/front/guard/all）也可以是单条探针 id（如 V1）
  // ——修后复核要单跑净音频那一条，不能被截断那条稀释掉一半样本。
  const pool = only === "all"
    ? PROBES
    : PROBES.filter((p) => p.kind === only || p.id.toUpperCase() === only.toUpperCase());
  if (pool.length === 0) { console.log(`没有 kind/id=${only} 的探针`); process.exit(1); }

  // ── 夹具先自证（fixtures/README 立的家法）：字节没被人动过，
  //    否则后面的 heard 与落点一个数都不许用。
  if (pool.some((p) => p.audio)) {
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    let ok = true;
    for (const f of new Set(pool.map((p) => p.audio).filter((x): x is string => !!x))) {
      const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
      const want = FIXTURE_SHA[f];
      const good = sha === want;
      if (!good) ok = false;
      console.log(`  ${good ? "PASS" : "FAIL"} 夹具自证 ${f} sha256 ${sha.slice(0, 16)}`);
    }
    if (!ok) { console.log("\n★夹具没过自证——停。"); process.exit(1); }
  }

  console.log(`\n== --live N=${n} kind=${only}（增援态信封 ${LIVE_DIGEST.length}B；免费档 ~8 RPM 自带配速）==`);
  console.log(`   现场：南线前哨 hp=${CANON.facilities.get(SOUTH_POST)!.hp}/350，驻军剩 2 个残兵\n`);

  type Row = { p: Probe; d: number; units: number; landed: boolean; fields: string; log: string };
  const rows: Row[] = [];

  for (let i = 0; i < n; i++) {
    const p = pool[i % pool.length];
    let opts: Record<string, unknown> | null = null;
    try {
      const envelope = LIVE_DIGEST + (p.ctx ?? "");
      // 语音回合：命令走录音附件，playerMessage 留空——与真路径同形。
      const audio = p.audio
        ? { data: (await import("node:fs")).readFileSync(p.audio).toString("base64"), format: "wav" as const }
        : undefined;
      for await (const ev of callAdvisorStream(envelope, p.cmd, "risk=0.50 focus=0.50 obj=0.50 cas=0.50", "combat", audio)) {
        if (ev.type === "options") opts = ev.content;
      }
    } catch (e) {
      console.log(`  #${i} ${p.id} 调用失败: ${String(e).slice(0, 70)}`);
      continue;
    }
    const o = (opts?.options as Record<string, unknown>[] | undefined)?.[0];
    const intents = (o?.intents as WireIntent[] | undefined)
      ?? (o?.intent ? [o.intent as WireIntent] : []);

    // 目标点：bait/guard 是设施；front 是该战线的 §8 落点（引擎自己算的那个）。
    const s = freshScene();
    let want: Position | null = null;
    if (p.wantFacility) want = s.facilities.get(p.wantFacility)?.position ?? null;
    else if (p.wantFront) {
      const ref = execute({ type: "defend", toFront: p.wantFront, quantity: 3 });
      want = ref.pos;
    }

    // 整条回复一起执行（多 intent 时 reserved 累积），取**离目标最近的那一坨**
    // ——一条回复里可能既有增援单又有别的单，判的是"有没有一支到了那儿"。
    const reserved = new Set<number>();
    let best = Number.POSITIVE_INFINITY;
    let units = 0;
    let log = "";
    const fieldsArr: string[] = [];
    for (const raw of intents) {
      fieldsArr.push(`${raw.type}(${raw.targetFacility ? `fac=${raw.targetFacility}` : raw.toFront ? `front=${raw.toFront}` : raw.targetRegion ? `reg=${raw.targetRegion}` : "无目的地"}${raw.fromSquad ? `,from=${raw.fromSquad}` : ""})`);
      const r = executeOne(raw, s, reserved);
      if (r.pos && want) {
        const d = dist(r.pos, want);
        if (d < best) { best = d; units = r.units.length; log = r.log; }
      } else if (!log) { log = r.log; }
    }
    const landed = Number.isFinite(best) && best <= ARRIVED_TILES;
    rows.push({ p, d: best, units, landed, fields: fieldsArr.join(" + ") || "(无 intent)", log });
    const mark = landed ? "到位" : Number.isFinite(best) ? "★落点偏" : "★零执行";
    // 语音回合把 heard 一起印出来：落点错的时候，第一件要分清的是
    // "没听清"还是"听清了填错格"——两个病，两条账。
    const heard = typeof opts?.heard === "string" ? opts.heard : "";
    console.log(`  #${String(i).padStart(2)} ${p.id} [${p.kind}] ${mark}  ` +
      `d=${Number.isFinite(best) ? best.toFixed(1) + "格" : "—"} 派${units}  ` +
      (p.audio ? `🎤 heard=「${heard || "(缺席)"}」` : `「${p.cmd}」`));
    console.log(`      ${fieldsArr.join(" + ") || "(无 intent)"}   ${log}`);
  }

  // ── 判据：三类分开算，一类一行 ──
  console.log("\n── 判据（数落点坐标与实派单位，不看台词）──");
  for (const kind of ["bait", "ctx", "esc", "voice", "front", "guard"] as const) {
    const rs = rows.filter((r) => r.p.kind === kind);
    if (rs.length === 0) continue;
    const ok = rs.filter((r) => r.landed).length;
    const label = kind === "bait" ? "点名前哨·无上文（本刀要治的）"
      : kind === "ctx" ? "★点名前哨·上文刚说过战线（真触发器候选）"
        : kind === "esc" ? "★点名前哨·悬着战线增援提案（F2 劫持形状）"
          : kind === "voice" ? "★★语音臂·录音直发（真机 7 例的那条路）"
        : kind === "front" ? "★点名战线（正对照，修后必须仍走战线）"
          : "★capture/sabotage（零溢出，本来就对）";
    const dists = rs.map((r) => (Number.isFinite(r.d) ? r.d.toFixed(0) : "∞")).join("/");
    console.log(`  ${label}: 到位 ${ok}/${rs.length}   各条距目标 ${dists} 格`);
  }
  // ★ 降格与零执行必须分开数（第一轮混着数差点把"没开单"读成"降格"）：
  //   降格 = 开了单、兵动了、落在别处；零执行 = 一个兵都没派。两个病，两条账。
  const baits = rows.filter((r) => r.p.kind === "bait" || r.p.kind === "ctx" || r.p.kind === "esc" || r.p.kind === "voice");
  const arrived = baits.filter((r) => r.landed).length;
  const misplaced = baits.filter((r) => !r.landed && Number.isFinite(r.d)).length;
  const zero = baits.filter((r) => !Number.isFinite(r.d)).length;
  console.log(`\n本轮 bait ${baits.length} 条：到位 ${arrived}｜★降格(开了单落错地) ${misplaced}｜零执行 ${zero}`);
  console.log(`降格率 ${baits.length ? ((misplaced / baits.length) * 100).toFixed(0) : "—"}%` +
    `　——这是本刀唯一要压下去的数；零执行是别的账，不许混进来充业绩`);
  process.exit(0);
}

// ── 入口 ──
// 用法：--live [N] [bait|front|guard|all]
if (MODE === "--live") {
  const n = Number(process.argv[3] ?? PROBES.length);
  const only = process.argv[4] ?? "all";
  void runLive(Number.isFinite(n) && n > 0 ? n : PROBES.length, only);
} else {
  runSynthetic();
}
