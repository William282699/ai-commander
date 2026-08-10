// ============================================================
// AI Commander — G 刀（陈的说话合同）A/B bench
//
// 提案：DIALOGUE_G_KNIFE_MOUTH_CONTRACT_PROPOSAL_20260805.md（v2.1）
//
// 本刀是 prompt 层的刀：引擎一行不改。本文件属【测试层】。
//
// Modes:
//   --digest            打印本刀唯一 fixture 的信封（设计/复核用，不调模型）
//   --run A|B [n]       跑一臂真模型探针，transcript 存 JSON
//   --sites             SPEECH_RULE_SITES 登记表扫描断言（源码层，不调模型）
//   --report A.json B.json   双向指标 + 跑前钉死的判定规则
//
// 铁律（家法在案，逐条对应）：
//  ① 判据测效果不测措辞：会动兵的断言跑真 resolveIntent 数 assignedUnitIds，
//     不读台词字面（feedback_verdict_measures_effect）。
//  ② 语料全部来自真实 transcript 原话（提案 §4 出处清单），禁脑内枚举。
//  ③ A 臂基线必须在改第一个字之前跑完（提案 §4 硬约束）。
//  ④ 双臂信封必须逐字节相同——B 臂启动时对 A 臂存档里的 digest 做 SHA 比对，
//     不同就炸红，不许"看起来差不多"。
//  ⑤ 主判是盲读（指标 6）；本台架的数字是线索与硬线，不是全部判据。
//
// Run (from the worktree root):
//   ./node_modules/.bin/tsx scripts/ab-g-knife.ts --digest
//   COMMAND_URL=http://localhost:3014/api/command ./node_modules/.bin/tsx scripts/ab-g-knife.ts --run A
// ============================================================

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname } from "node:path";

import {
  createInitialGameState,
  buildDigest,
  resolveIntent,
  resolveTicketReference,
  retargetIntentForTicket,
  ticketDestinationVerdict,
} from "@ai-commander/core";
import type { GameState, Unit, Squad, Intent } from "@ai-commander/shared";

// ── Fixture helpers (copied shape from ab-commander-presence.ts) ──

/** Fresh el_alamein state with all units/squads removed (fronts/regions/facilities kept). */
function emptyBattlefield(): GameState {
  const state = createInitialGameState("el_alamein");
  state.units.clear();
  state.squads = [];
  state.missions = [];
  return state;
}

let templateUnit: Unit | null = null;
function unitTemplate(): Unit {
  if (!templateUnit) {
    const s = createInitialGameState("el_alamein");
    let found: Unit | null = null;
    s.units.forEach((u) => {
      if (!found && u.team === "player" && u.type === "infantry") found = u;
    });
    if (!found) throw new Error("no player infantry in el_alamein opening");
    templateUnit = found;
  }
  return templateUnit;
}

let nextId = 9000;
function addUnit(state: GameState, x: number, y: number, over: Partial<Unit> = {}): Unit {
  const u: Unit = {
    ...structuredClone(unitTemplate()),
    id: nextId++,
    position: { x, y },
    state: "idle",
    orders: [],
    waypoints: [],
    patrolPoints: [],
    patrolTaskId: null,
    lastAttackTime: 0,
    manualOverride: false,
    target: null,
    attackTarget: null,
    ...over,
  };
  state.units.set(u.id, u);
  return u;
}

function addSquad(state: GameState, ids: number[], over: Partial<Squad> = {}): Squad {
  const sq: Squad = {
    id: over.id ?? `B${nextId++}`,
    name: "bench squad",
    unitIds: ids,
    leader: { name: "Bench", rank: "sergeant" as Squad["leader"]["rank"], personality: "balanced" },
    currentMission: null,
    missionTarget: null,
    morale: 1,
    formationStyle: "line",
    ownerCommander: "chen",
    leaderName: "Bench",
    role: "leader",
    ...over,
  };
  state.squads.push(sq);
  return sq;
}

function reveal(state: GameState, x: number, y: number): void {
  const ty = Math.floor(y);
  const tx = Math.floor(x);
  if (state.fog[ty]) state.fog[ty][tx] = "visible";
}

// ── THE fixture：四张脸现场（G1-G4 四个症状都在这一个局面里可复现）──
//
// 几何（el_alamein bbox 见 mapData）：
//   front_coastal「1. 北部战线」= northern_coastal[200,22,490,55] + tel_el_eisa
//     → 北线前哨 ea_player_coastal_post 在 (360,35)，就在这条线上。
//       我方 Aiden(I1) 两个残兵在挨打，敌军 6 个可见 → survival 短。
//   front_ridge「2. 山脊战线」= kidney_ridge_zone[200,45,260,75] 等
//     → 我方 6 个单位（Carter/I2 + Evans/T3）正在交战。
//       ★这条线是 G3 最硬标本的现场：说"山脊战线没有我方部队"就是说瞎话。
//   front_center「3. 中央战线」= central_desert[120,80,370,140]
//     → 中央前哨 (360,105) 旁边 6 个【未编组】闲兵 = 板子群行 + handle=G#。
//       离北线 70 格开外 → 对北部战线属"赶不到"的候选（诚实闸会点名但不推荐），
//       正好是 O4「派他们去吧，不用管时间」这条真语料的现场。
const COASTAL = { x: 300, y: 30 };
const RIDGE = { x: 220, y: 65 };
const IDLE_POOL = { x: 355, y: 105 };

function theScene(): GameState {
  const s = emptyBattlefield();
  s.time = 420;

  // 交战时间戳：isEngaged 读 lastAttackTime / lastDamagedAt，这是"正在打"
  // 在数据里的样子（ab-approval-v4 的 engagedTimestamps 同一手法）。不加的话
  // 两条正在交火的线在信封里都印成"无任务"，G3 标本的现场就被抹平了。
  const fighting = { lastAttackTime: s.time - 2, lastDamagedAt: s.time - 1 } as Partial<Unit>;

  // 北部战线：残兵顶着，敌军压上（survival 短到"赶不到"成立）
  const c1 = addUnit(s, COASTAL.x, COASTAL.y, { hp: 45, ...fighting });
  const c2 = addUnit(s, COASTAL.x + 2, COASTAL.y, { hp: 45, ...fighting });
  addSquad(s, [c1.id, c2.id], { id: "I1", leaderName: "Aiden" });
  for (let i = 0; i < 5; i++) {
    const e = addUnit(s, COASTAL.x + 3 + i, COASTAL.y + 2, {
      team: "enemy",
      ...fighting,
    } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }

  // 山脊战线：我方 6 个单位交战中（G3 最硬标本的现场）
  const ridgeA: number[] = [];
  for (let i = 0; i < 3; i++) ridgeA.push(addUnit(s, RIDGE.x + i, RIDGE.y, { hp: 52, ...fighting }).id);
  addSquad(s, ridgeA, { id: "I2", leaderName: "Carter" });
  const ridgeB: number[] = [];
  for (let i = 0; i < 3; i++) ridgeB.push(addUnit(s, RIDGE.x + i, RIDGE.y + 3, { hp: 46, ...fighting }).id);
  addSquad(s, ridgeB, { id: "T3", leaderName: "Evans" });
  for (let i = 0; i < 4; i++) {
    const e = addUnit(s, RIDGE.x + 4 + i, RIDGE.y + 1, {
      team: "enemy",
      ...fighting,
    } as Partial<Unit>);
    reveal(s, e.position.x, e.position.y);
  }

  // 中央：6 个未编组闲兵（板子群行 → handle=G#），没打过也没挨过打
  for (let i = 0; i < 6; i++) addUnit(s, IDLE_POOL.x + (i % 3), IDLE_POOL.y + Math.floor(i / 3));

  return s;
}

/** 信封：与真对话路径同源（buildDigest + mintForceHandles=true）。 */
function sceneDigest(state: GameState): string {
  return buildDigest(state, [], [], [], true);
}

const STYLE_NOTE = "risk=0.50 focus=0.50 obj=0.50 cas=0.50";

// ── 探针语料（提案 §4：全部真实 transcript 原话，不许自造）──
//
// order/goal/consult/G2/G4 五类。context 一律模拟 ChatPanel 的 ---CONTEXT---
// 后缀（formatContext 的格式：[指挥官]/[参谋] 两行），因为真语料里的那几句
// 短命令本来就是接在陈上一句之后说的——脱离上下文测它们不是同一个题。

const CTX_ORDER =
  "\n---CONTEXT---\n" +
  "[指挥官] 北线现在什么情况？\n" +
  "[参谋] 长官，北线前哨在挨打，Aiden两个残兵顶着，对面六个单位压上来。中央那边还有一批弟兄闲着。\n";

type ProbeClass = "order" | "goal" | "consult" | "g2" | "g4";

interface Probe {
  id: string;
  cls: ProbeClass;
  message: string;
  context: string;
  reps: number;
  /** G2 专用：长官原话里那个不存在的地名。 */
  fakeName?: string;
}

const PROBES: Probe[] = [
  // order 类（★N≥40/臂：4 探针 × 10 = 40。用户点名最担心"该办的犹豫了"）
  { id: "O1", cls: "order", message: "调附近空闲军去支援", context: CTX_ORDER, reps: 10 },
  { id: "O2", cls: "order", message: "全部过去", context: CTX_ORDER, reps: 10 },
  { id: "O3", cls: "order", message: "不管了，派他们去支援", context: CTX_ORDER, reps: 10 },
  { id: "O4", cls: "order", message: "派他们去吧，不用管时间", context: CTX_ORDER, reps: 10 },

  // goal 类（2 × 10 = 20；每条第一轮同时是指标 3 两轮链的第一轮）
  {
    id: "GO1",
    cls: "goal",
    message: "算了，放弃北线前哨，我们现在重要的是拿下两个山脊战线",
    context: "",
    reps: 10,
  },
  {
    id: "GO2",
    cls: "goal",
    message: "先不管北线了，中央前线当前最重要，先等Emily准备好主战部队",
    context: "",
    reps: 10,
  },

  // consult 类（3 × 7 = 21）
  { id: "C1", cls: "consult", message: "您说怎么处理", context: CTX_ORDER, reps: 7 },
  { id: "C2", cls: "consult", message: "你觉得应该增援吗", context: CTX_ORDER, reps: 7 },
  { id: "C3", cls: "consult", message: "附近有空闲部队增援吗", context: "", reps: 7 },

  // G2 类（假地名 2 × 10 = 20；一个真语料 + 一个结构同型新造假名）
  {
    id: "X1",
    cls: "g2",
    message: "让Aiden带兵去卡拉马佐夫高地设防",
    context: "",
    reps: 10,
    fakeName: "卡拉马佐夫高地",
  },
  {
    id: "X2",
    cls: "g2",
    message: "让Carter去兹韦尼哥罗德高地设防",
    context: "",
    reps: 10,
    fakeName: "兹韦尼哥罗德高地",
  },

  // G4 类（板子群行入信封的问句 × 10）
  { id: "H1", cls: "g4", message: "附近有空闲部队吗", context: "", reps: 10 },
];

/** 指标 3 两轮链的第二轮（跟在 goal 类第一轮之后）。 */
const CHAIN_FOLLOWUP = "可以";

/**
 * ★回归对照（不属 A/B 判定，判据不在钉死清单里，单独跑单独报）。
 *
 * 为什么要有：合同要删的三条口号里，「判断执照」这一条**自己那份活是验过的**
 * （presence Step A 的 R5「派谁去」/R1「先救哪条」——第一句先交付未知量、
 * 不把选择推回长官）。删口号 ≠ 删义务：义务被折进合同的判定条款重新措辞。
 * 折进去有没有折丢，只能靠把 presence 那两个形状在两臂上各跑一遍来看。
 * A 臂必须在动 prompt 之前跑完（和主探针同一条铁律）。
 */
const REG_PROBES: Probe[] = [
  { id: "R1", cls: "consult", message: "派谁去增援北部前线？", context: "", reps: 6 },
  { id: "R2", cls: "consult", message: "北线和山脊线都吃紧，先救哪条？", context: "", reps: 6 },
];

// ── 引擎侧核算（家法①：数 assignedUnitIds，不读台词）──

interface WireIntent {
  type?: string;
  fromSquad?: string;
  fromFront?: string;
  toFront?: string;
  targetFacility?: string;
  targetRegion?: string;
  quantity?: string | number;
  [k: string]: unknown;
}

interface WireOption {
  label?: string;
  intents?: WireIntent[];
  intent?: WireIntent;
}

interface WireResponse {
  brief?: string;
  responseType?: string;
  options?: WireOption[];
  recommended?: string;
  urgency?: number;
  standingOrder?: { type?: string; locationTag?: string } | null;
  warning?: string;
}

/** ChatPanel 执行的是 options[0]（不是 recommended）——照它数。 */
function firstOptionIntents(r: WireResponse): WireIntent[] {
  const o = r.options?.[0];
  if (!o) return [];
  if (Array.isArray(o.intents) && o.intents.length > 0) return o.intents;
  return o.intent ? [o.intent] : [];
}

/** 唯一的现场（信封就是从它建的，番号 G# 冻的是它的 unitIds）。 */
const CANON = theScene();

/** 每次核算用一份克隆——resolveIntent 会往 state 里写 orders，不能串场。
 *  必须是 CANON 的克隆而不是重建：番号里冻的是 CANON 那批 unit id。 */
function freshScene(): GameState {
  return structuredClone(CANON);
}

/**
 * 真 resolveIntent 数实派单位（家法①）。番号（fromSquad="G1"）走 ChatPanel
 * 同一条路：resolveTicketReference → retarget → 目的地判决 → roster 作
 * selectedUnitIds。不走这条路的话，一条【完全正确】的番号命令会被台架数成
 * "零执行"，指标 2 直接测反。
 */
function assignedUnitCount(intents: WireIntent[]): number {
  if (intents.length === 0) return 0;
  const s = freshScene();
  const reserved = new Set<number>();
  let total = 0;
  for (const raw of intents) total += resolveOne(raw, s, reserved);
  return total;
}

/** 一条 intent 实派了几个兵（番号单走 ChatPanel 同一条路）。reserved 跨 intent 累积。 */
function resolveOne(raw: WireIntent, s: GameState, reserved: Set<number>): number {
  {
    try {
      let intent = { ...raw } as unknown as Intent;
      let roster: number[] | undefined;

      // 软修之前的快照：「说了个找不到的地方」和「什么地方都没说」在软修之后
      // 长得一模一样，而目的地判决要靠这一位把它们分开。
      const wroteDestination = !!(
        intent._targetPos || intent.targetFacility || intent.targetRegion || intent.toFront
      );

      const tk = resolveTicketReference(s, intent.fromSquad, s.time);
      if (tk.kind === "refuse") return 0; // 引擎明确拒绝 = 零执行
      if (tk.kind === "dispatch") {
        roster = tk.unitIds;
        intent.fromSquad = undefined;
        intent = { ...intent, ...retargetIntentForTicket(s, intent, tk.ticket) };
        const verdict = ticketDestinationVerdict(s, intent, tk.ticket, wroteDestination);
        if (verdict.kind === "refuse") return 0; // 零执行 + 反问
        if (verdict.injectTargetRegion) intent.targetRegion = verdict.injectTargetRegion;
      }

      const r = resolveIntent(intent, s, s.style, reserved, roster);
      for (const id of r.assignedUnitIds) reserved.add(id);
      return r.assignedUnitIds.length;
    } catch {
      // 解析失败 = 零执行，照记 0（不吞成"过了"）
    }
  }
  return 0;
}

/** 进攻类 intent：把一句战略表态翻成一场攻势，翻的就是这三种。
 *  （判据修订第 1 版 2026-08-06：指标1 只咬这三种，因为合同④要求逐子句处理——
 *  「放弃北线前哨」该开的撤退单是【正确行为】，旧判据把它也记成病。） */
const OFFENSIVE_TYPES = new Set(["attack", "capture", "sabotage"]);

/** 一条回复里：有没有进攻单 / 进攻单实派了多少兵。
 *  兵力仍走真 resolveIntent（家法①），且按原顺序处理以保持占位一致。 */
function offensiveDispatch(intents: WireIntent[]): { hasOffensive: boolean; units: number } {
  if (intents.length === 0) return { hasOffensive: false, units: 0 };
  const s = freshScene();
  const reserved = new Set<number>();
  let units = 0;
  let hasOffensive = false;
  for (const raw of intents) {
    const offensive = OFFENSIVE_TYPES.has(String(raw.type));
    if (offensive) hasOffensive = true;
    const n = resolveOne(raw, s, reserved);
    if (offensive) units += n;
  }
  return { hasOffensive, units };
}

/**
 * ★判据修订第 2 版（2026-08-06）：goal 类的【三件套】。
 * 一条 goal 记录算通过，当且仅当：
 *   ① 攻击单 0（无 attack/capture/sabotage）
 *   ② doctrine 0（无 root 级 standingOrder）——B′ 回归逼出来的第二件
 *   ③ 撤退半句照开：探针含"指着现在"的撤退子句时必须有 retreat intent；
 *      不含时本条自动成立（不许因此要求它凭空开单）
 * 三件套让这一格两个方向都咬：只罚"开了不该开的"会奖励"什么都不开"，
 * 而合同④要求的是逐子句处理。
 */
const PROBES_WITH_RETREAT_CLAUSE = new Set(["GO1"]);

function goalTriad(r: Record): { pass: boolean; noOffensive: boolean; noDoctrine: boolean; retreatOk: boolean } {
  const noOffensive = !r.intents.some((it) => OFFENSIVE_TYPES.has(String(it.type)));
  const noDoctrine = !r.standingOrder;
  const needsRetreat = PROBES_WITH_RETREAT_CLAUSE.has(r.probeId);
  const retreatOk = !needsRetreat || r.intents.some((it) => String(it.type) === "retreat");
  return { pass: noOffensive && noDoctrine && retreatOk, noOffensive, noDoctrine, retreatOk };
}

/** 台词把番号贴到了别的东西上（战线/别的部队）。
 *  单列观察项，不进合同的编话账——根因在引擎的信封印法（handle 印在行末，
 *  而那一行的主语是战线），已另立引擎小刀，本轮不碰信封。 */
const HANDLE_OWNER_CONFUSABLES = [
  "Aiden", "Carter", "Evans", "I1", "I2", "T3",
  "北部战线", "山脊战线", "中央战线", "北线", "前哨",
];
function misboundHandles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/G\d+/g)) {
    const pre = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
    if (HANDLE_OWNER_CONFUSABLES.some((t) => pre.includes(t))) out.push(pre.slice(-8) + m[0]);
  }
  return out;
}

/** 地图上真实存在的地名/ID 全集（G2 硬线用：长官没说过的真 id 一个都不许出现）。 */
function realPlaceTokens(state: GameState): string[] {
  const out: string[] = [];
  for (const f of state.fronts) {
    out.push(f.id, f.name);
    for (const rid of f.regionIds) out.push(rid);
  }
  state.regions.forEach((r) => out.push(r.id, r.name));
  state.facilities.forEach((f) => {
    out.push(f.id, f.name);
    for (const t of f.tags) out.push(t);
  });
  return out.filter((t) => typeof t === "string" && t.trim().length > 0);
}

const REAL_TOKENS = realPlaceTokens(CANON).map((t) => t.toLowerCase());

/** 这个字段值指到地图上一个真实地点了吗（引擎 isKnownLocation / 设施模糊匹配的口径）。 */
function pointsAtRealPlace(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s.length === 0) return false;
  return REAL_TOKENS.some((t) => t === s || t.includes(s) || s.includes(t));
}

const TARGET_FIELDS = ["toFront", "fromFront", "targetFacility", "targetRegion"] as const;

/**
 * G2 硬线（指标 4）：intent JSON 里出现了长官【没说过】的真实地点 id/名。
 *
 * 通过的两个出口都不在这里判：出口(a)=原话进字段（值就是那个假地名 → 不指向
 * 任何真地点，返回空）、出口(b)=零 intent（根本没有字段）。失败只有一种形状：
 * 长官说的是不存在的地方，字段里却躺着一个真地点——这条返回它。
 */
function unspokenRealIds(intents: WireIntent[], message: string): string[] {
  const out: string[] = [];
  for (const it of intents) {
    for (const f of TARGET_FIELDS) {
      const v = it[f];
      if (typeof v !== "string" || v.trim().length === 0) continue;
      if (message.includes(v.trim())) continue; // 长官自己说的，合法
      if (pointsAtRealPlace(v)) out.push(`${f}=${v}`);
    }
  }
  return out;
}

// ── HTTP ──

interface Record {
  probeId: string;
  cls: ProbeClass | "chain2";
  rep: number;
  message: string;
  context: string;
  turn: 1 | 2;
  latencyMs: number;
  brief: string;
  responseType: string;
  intents: WireIntent[];
  intentCount: number;
  assignedUnits: number;
  standingOrder: string | null;
  warning?: string;
  error?: string;
  /** 重试次数 + 原因：基础设施故障必须留痕，不许静默掺进数据。 */
  retries: number;
  retryReasons: string[];
  /** true = 这条到最后还是兜底句，指标计算必须排除它。 */
  unusable: boolean;
}

// ── 限速 + 重试 ──
//
// 第一次跑 A 臂时 131 次调用 / concurrency 4 直接把 gemini 的 RPM 打爆：44 条
// 记录是 429 兜底句「通讯干扰，无法解析参谋建议」——而兜底句自带一个默认
// option，会被台架数成"开单"。基础设施故障混进数据里，比没有数据更坏。
// 所以：全局最小发车间隔 + 兜底一律重试 + 重试次数进档案。

// gemini 免费档 gemini-2.5-flash 是 10 RPM。5.5s（≈11 RPM）实测仍在 429 边缘
// 反复挨打——重试本身也占额度，越挨打越挤。7.5s ≈ 8 RPM，留出重试的余量。
const MIN_GAP_MS = 7500;
let lastLaunch = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lastLaunch + MIN_GAP_MS - now);
  lastLaunch = Math.max(now, lastLaunch + MIN_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** 兜底句 = 引擎的 createFallbackResponse，不是陈说的话。它必须永远不进数据。 */
function isFallback(r: WireResponse): boolean {
  if (r.warning) return true;
  return (r.brief ?? "").includes("通讯干扰");
}

async function askOnce(
  url: string,
  digest: string,
  message: string,
): Promise<{ resp: WireResponse; latencyMs: number; error?: string }> {
  await pace();
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        digest,
        message,
        styleNote: STYLE_NOTE,
        channel: "combat",
        sessionId: "ab-g-knife",
      }),
    });
    const json = (await res.json()) as WireResponse;
    return { resp: json, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      resp: {},
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface AskResult {
  resp: WireResponse;
  latencyMs: number;
  error?: string;
  retries: number;
  /** 重试掉的那几次分别是什么原因（429 / 格式异常），进档案备查。 */
  retryReasons: string[];
}

async function ask(url: string, digest: string, message: string): Promise<AskResult> {
  const reasons: string[] = [];
  let last: { resp: WireResponse; latencyMs: number; error?: string } = {
    resp: {},
    latencyMs: 0,
  };
  for (let attempt = 0; attempt <= 5; attempt++) {
    last = await askOnce(url, digest, message);
    if (!last.error && !isFallback(last.resp)) {
      return { ...last, retries: attempt, retryReasons: reasons };
    }
    reasons.push((last.error ?? last.resp.warning ?? "unknown").slice(0, 80));
    // 429 要等到下一个额度窗口才有意义（RPM 是滑动一分钟）
    await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
  }
  return { ...last, retries: 6, retryReasons: reasons };
}

/** ChatPanel 的 pushContext 上限：3 轮 / 600 字。这里模拟单轮追加。 */
function chainContext(userMsg: string, assistantBrief: string): string {
  const a = assistantBrief.slice(0, 400);
  return `\n---CONTEXT---\n[指挥官] ${userMsg}\n[参谋] ${a}\n`;
}

async function runReg(arm: string, outPath: string): Promise<void> {
  const url = process.env.COMMAND_URL ?? "http://localhost:3014/api/command";
  const digest = sceneDigest(CANON);
  console.log(`== G 刀回归对照 — 臂 ${arm} ==（判断执照那份活有没有被折丢）`);
  const records: Record[] = [];
  for (const p of REG_PROBES) {
    for (let rep = 1; rep <= p.reps; rep++) {
      const a = await ask(url, digest + p.context, p.message);
      const unusable = !!a.error || isFallback(a.resp);
      const intents = unusable ? [] : firstOptionIntents(a.resp);
      records.push({
        probeId: p.id,
        cls: p.cls,
        rep,
        message: p.message,
        context: p.context,
        turn: 1,
        latencyMs: a.latencyMs,
        brief: a.resp.brief ?? "",
        responseType: a.resp.responseType ?? "",
        intents,
        intentCount: intents.length,
        assignedUnits: assignedUnitCount(intents),
        standingOrder: a.resp.standingOrder?.type ?? null,
        warning: a.resp.warning,
        error: a.error,
        retries: a.retries,
        retryReasons: a.retryReasons,
        unusable,
      });
      console.log(`   [${p.id}#${rep}] ${(a.resp.brief ?? "").slice(0, 100)}`);
    }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ arm, kind: "regression", startedAt: new Date().toISOString(), records }, null, 2),
  );
  console.log(`\n存档：${outPath}（${records.length} 条）`);
}

async function runArm(arm: string, outPath: string): Promise<void> {
  const url = process.env.COMMAND_URL ?? "http://localhost:3014/api/command";
  const digest = sceneDigest(CANON);
  const digestSha = createHash("sha256").update(digest).digest("hex");

  console.log(`== G 刀 A/B — 臂 ${arm} ==`);
  console.log(`   url=${url}`);
  console.log(`   digest sha256=${digestSha} (${digest.length} chars)`);

  // 铁律④：B 臂必须跑在与 A 臂逐字节相同的信封上。
  const baselinePath = process.env.BASELINE_JSON;
  if (baselinePath) {
    const base = JSON.parse(readFileSync(baselinePath, "utf8")) as { digestSha: string };
    if (base.digestSha !== digestSha) {
      console.error(
        `FAIL 信封漂移：本臂 digest sha=${digestSha}，基线=${base.digestSha}。A/B 变量不唯一，停。`,
      );
      process.exit(1);
    }
    console.log(`   信封与基线逐字节一致 ✓`);
  }

  const jobs: Array<{ probe: Probe; rep: number }> = [];
  for (const p of PROBES) for (let i = 1; i <= p.reps; i++) jobs.push({ probe: p, rep: i });

  const records: Record[] = [];
  const CONCURRENCY = 2;
  let cursor = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= jobs.length) return;
      const { probe, rep } = jobs[idx];
      const d1 = digest + probe.context;
      const a1 = await ask(url, d1, probe.message);
      const { resp, latencyMs, error } = a1;
      const unusable1 = !!error || isFallback(resp);
      const intents = unusable1 ? [] : firstOptionIntents(resp);
      const rec: Record = {
        probeId: probe.id,
        cls: probe.cls,
        rep,
        message: probe.message,
        context: probe.context,
        turn: 1,
        latencyMs,
        brief: resp.brief ?? "",
        responseType: resp.responseType ?? "",
        intents,
        intentCount: intents.length,
        assignedUnits: assignedUnitCount(intents),
        standingOrder: resp.standingOrder?.type ?? null,
        warning: resp.warning,
        error,
        retries: a1.retries,
        retryReasons: a1.retryReasons,
        unusable: unusable1,
      };
      records.push(rec);

      // 指标 3：goal 类第一轮之后立刻跟一句「可以」——同一条链，同一个 rep。
      if (probe.cls === "goal") {
        const d2 = digest + chainContext(probe.message, rec.brief);
        const r2 = await ask(url, d2, CHAIN_FOLLOWUP);
        const unusable2 = !!r2.error || isFallback(r2.resp) || unusable1;
        const i2 = unusable2 ? [] : firstOptionIntents(r2.resp);
        records.push({
          probeId: probe.id,
          cls: "chain2",
          rep,
          message: CHAIN_FOLLOWUP,
          context: d2.slice(d2.indexOf("---CONTEXT---")),
          turn: 2,
          latencyMs: r2.latencyMs,
          brief: r2.resp.brief ?? "",
          responseType: r2.resp.responseType ?? "",
          intents: i2,
          intentCount: i2.length,
          assignedUnits: assignedUnitCount(i2),
          standingOrder: r2.resp.standingOrder?.type ?? null,
          warning: r2.resp.warning,
          error: r2.error,
          retries: r2.retries,
          retryReasons: r2.retryReasons,
          unusable: unusable2,
        });
      }

      done++;
      if (done % 10 === 0) console.log(`   ... ${done}/${jobs.length} probes`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 哪一版 prompt 说的这些话——臂标签会记错，sha 不会。
  const promptSha = createHash("sha256")
    .update(readFileSync("apps/server/src/ai.ts", "utf8"))
    .digest("hex");

  const payload = {
    arm,
    startedAt: new Date().toISOString(),
    url,
    promptSha,
    digestSha,
    digest,
    styleNote: STYLE_NOTE,
    probes: PROBES,
    records,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n存档：${outPath}（${records.length} 条）`);

  const unusable = records.filter((r) => r.unusable).length;
  const retried = records.filter((r) => r.retries > 0).length;
  console.log(`   重试过的：${retried} 条；最终仍不可用：${unusable} 条`);
  if (unusable > 0) console.log(`⚠ 不可用记录会被指标排除，但会在报告里点名——别当没发生`);
}

// ============================================================
// SPEECH_RULE_SITES — 说话规则面登记表（提案 §3 审核 🔴1）
//
// 不是一份 doc，是一张【会咬人的表】。先例＝A 刀的 CANDIDATE_FACES /
// CONFIRM_WORD_SITES，两张表施工中各抓到一次真实漂移。护栏写成注释拦不住
// 后来的人，断言可以。
//
// ★登记原则（v2.1 订正）：**按规则语义登记，不按标签串 grep**。
//   判断执照在 CHANNEL_PERSONA:combat 是无标签压缩版、在 GROUP_SYSTEM_PROMPT
//   是英文改写版——只 grep「判断执照」四个字会只看见 2/4 份。
//
// 三条断言：
//   A. 登记过的面必须还在（有人删了/改名 → 红）
//   B. 带说话规则标记的面必须登记过（有人新加一个面 → 红）
//   C. 每个面【实测到的规则集合】必须等于登记的集合（有人在某一份副本上
//      加/删了一条规则而别的副本没动 → 红。这正是 G 刀要治的"多副本漂移"）
// ============================================================

type RuleTag =
  | "enforcement" // ENFORCEMENT RULES [A]-[D]（含 ❌/✅ 例句块）
  | "judgment_license" // 判断执照：先交付那个未知量
  | "no_repeat" // 别重复自己 / 每次换开头
  | "consultation_vs_order" // 咨询 vs 命令的判定口
  | "length_band" // 长度按言语行为分档
  | "mood_register" // mood 行只定语气不定战况
  | "handle_addressing" // 番号是地址不是推荐 / 群名不是 fromSquad
  | "speech_contract" // G 刀：说话合同（替换掉三条死口号的那份）
  | "voice_transcript" // 语音输入 V1：heard 的义务 +「不要顺句」那条原则
  | "voice_spoken"; // spoken 层：只给耳朵那一两句的义务 +「从属正文」那条原则

type SiteKind =
  | "chen_command" // 陈的命令解析面 ← 本刀合同的落点
  | "chen_voice" // 陈的单向发声面（引擎给事实，一句话）
  | "other_persona" // 马克斯 / Emily 专属
  | "shared_face" // 多人格共享
  | "envelope"; // 信封口径行（引擎侧）

type Disposition =
  | "contract" // 本刀替换成说话合同
  | "keep" // 本刀不动，也不属二期
  | "legacy_phase2" // 别的人格 / 别的模型，G 刀二期
  | "frozen_phase2" // 共享面，本刀冻结，G 刀二期
  | "engine_untouched" // 引擎侧，本刀零改动
  | "voice_input_v1"; // 语音输入 V1 新开的面（只在带音频那一轮出现）

interface SpeechRuleSite {
  file: string;
  symbol: string;
  /** Record 常量按 channel 键分面登记（.combat 是陈的，.ops 是马克斯的）。 */
  channel?: string;
  kind: SiteKind;
  rules: RuleTag[];
  disposition: Disposition;
  note: string;
}

const AI_TS = "apps/server/src/ai.ts";

const SPEECH_RULE_SITES: SpeechRuleSite[] = [
  {
    file: AI_TS,
    symbol: "SYSTEM_PROMPT",
    kind: "chen_command",
    rules: [
      "enforcement",
      "judgment_license",
      "no_repeat",
      "consultation_vs_order",
      "length_band",
      "mood_register",
      "handle_addressing",
      "speech_contract",
    ],
    disposition: "contract",
    note: "陈的主 prompt（execute 模式）。★这是【共享面】：combat=陈 + logistics=Emily（ops 走 MARCUS_V2，flag=true 已分家）。用户裁定 2026-08-06 a 案：合同只插进陈的人格块内部；两条全局口号（NEVER repeat / CONSULTATION vs ORDER）从全局位置删除后【原文逐字搬进 Emily 的人格行】，她的行为一字不变（--emily-guard 断言 + Emily 生产台架效果级负对照两道防护）。判断执照本来就在陈块内，直删，义务重新措辞进合同④。ENFORCEMENT:49 的 ❌✅ 例句块照 🟡7 冻结不动。no_repeat / consultation_vs_order 这两个标记现在指的是【Emily 那两份搬运件】，不再对陈生效。",
  },
  {
    file: AI_TS,
    symbol: "CHANNEL_PERSONA",
    channel: "combat",
    kind: "chen_command",
    rules: ["enforcement", "judgment_license", "length_band", "speech_contract", "handle_addressing"],
    disposition: "contract",
    note: "★同一条命令路径上的第二份陈规则（注入 user content）。判断执照在这儿是【无标签压缩版】、别重复是「每次换开头」——两条都不带标签串。★这一条是登记表第一次开跑就咬到的：手工登记漏了 no_repeat，扫描抓了出来（提案 §2 说三条旧规则'散在多面多副本'，实测比手数的还多一份）。",
  },
  {
    file: AI_TS,
    symbol: "CHANNEL_PROMPTS",
    channel: "combat",
    kind: "chen_voice",
    rules: ["enforcement", "no_repeat"],
    disposition: "keep",
    note: "陈的单条主动战报（/api/brief），非对话面：引擎给 digest，陈写一句战报。本刀不改——合同治的是「说话不看账本」，这一面本来就只有账本可读，且它与 A/B 变量无关。",
  },
  {
    file: AI_TS,
    symbol: "GROUP_SYSTEM_PROMPT",
    kind: "shared_face",
    rules: ["enforcement", "judgment_license", "no_repeat", "length_band", "mood_register"],
    disposition: "frozen_phase2",
    note: "★三人格共享面（全体频道）。判断执照在这儿是【英文改写版】。提案 §2 已提前裁定冻结归二期——陈在全体频道暂留旧规是 c 案范围的诚实代价。",
  },
  {
    file: AI_TS,
    symbol: "SYSTEM_PROMPT_MARCUS_V2",
    kind: "other_persona",
    rules: ["judgment_license", "no_repeat", "length_band", "mood_register"],
    disposition: "legacy_phase2",
    note: "马克斯专属，跑 deepseek（不同模型）。只在陈（gemini-2.5-flash）上 A/B 过的合同不许静默套过来。",
  },
  {
    file: AI_TS,
    symbol: "LIGHT_SYSTEM_PROMPT",
    kind: "other_persona",
    rules: [],
    disposition: "legacy_phase2",
    note: "马克斯一行 sitrep，无说话规则条款。",
  },
  {
    file: AI_TS,
    symbol: "CHANNEL_PROMPTS",
    channel: "ops",
    kind: "other_persona",
    rules: ["no_repeat"],
    disposition: "legacy_phase2",
    note: "马克斯的 light brief。",
  },
  {
    file: AI_TS,
    symbol: "CHANNEL_PROMPTS",
    channel: "logistics",
    kind: "other_persona",
    rules: ["no_repeat"],
    disposition: "legacy_phase2",
    note: "Emily 的 light brief。",
  },
  {
    file: AI_TS,
    symbol: "CHANNEL_PERSONA",
    channel: "ops",
    kind: "other_persona",
    rules: [],
    disposition: "legacy_phase2",
    note: "一行人设，无条款。",
  },
  {
    file: AI_TS,
    symbol: "CHANNEL_PERSONA",
    channel: "logistics",
    kind: "other_persona",
    rules: [],
    disposition: "legacy_phase2",
    note: "一行人设，无条款。",
  },
  {
    file: AI_TS,
    symbol: "ESCALATION_BASE",
    kind: "chen_voice",
    rules: ["no_repeat"],
    disposition: "keep",
    note: "危机问句面：引擎给结构化事实，写一句问话。事实来源已经被钉死在 payload 上，本刀不动。",
  },
  {
    file: AI_TS,
    symbol: "PREFLIGHT_BASE",
    kind: "chen_voice",
    rules: ["no_repeat"],
    disposition: "keep",
    note: "大命令代价面：引擎预演后给真实代价事实。同上。",
  },
  {
    file: AI_TS,
    symbol: "PROACTIVE_BASE",
    kind: "chen_voice",
    rules: ["no_repeat"],
    disposition: "keep",
    note: "主动态势播报面。同上。",
  },
  {
    file: AI_TS,
    symbol: "RETROSPECT_BASE",
    kind: "chen_voice",
    rules: ["no_repeat"],
    disposition: "keep",
    note: "决策复盘面。同上。",
  },
  {
    file: AI_TS,
    symbol: "ESCALATION_PROMPTS",
    kind: "chen_voice",
    rules: [],
    disposition: "keep",
    note: "三人格的一行语域尺（register ruler），无条款。",
  },
  {
    file: AI_TS,
    symbol: "PREFLIGHT_PROMPTS",
    kind: "chen_voice",
    rules: [],
    disposition: "keep",
    note: "同上。",
  },
  {
    file: AI_TS,
    symbol: "PROACTIVE_PROMPTS",
    kind: "chen_voice",
    rules: [],
    disposition: "keep",
    note: "同上。",
  },
  {
    file: AI_TS,
    symbol: "RETROSPECT_PROMPTS",
    kind: "chen_voice",
    rules: [],
    disposition: "keep",
    note: "同上。",
  },
  {
    file: AI_TS,
    symbol: "withPendingReinforcement",
    kind: "chen_command",
    rules: [],
    disposition: "keep",
    note: "不是说话规则：它钉的是 pendingDecision 这个【字段义务】，条款语义仍定义在 PENDING CONTRACT DECISION 一处。",
  },
  // ── 信封口径行（引擎侧，本刀零改动；登记是为了让合同别和账本自带的口径打架）──
  {
    file: "packages/shared/src/digest.ts",
    symbol: "SQUADS_HEADER",
    kind: "envelope",
    rules: [],
    disposition: "engine_untouched",
    note: "loc= 才是位置、目的地≠位置（07-20 用户裁定）。账本条款直接依赖它。",
  },
  {
    file: "packages/shared/src/digest.ts",
    symbol: "UNASSIGNED_HEADER",
    kind: "envelope",
    rules: ["handle_addressing"],
    disposition: "engine_untouched",
    note: "群名不是合法 fromSquad，行末 handle=G# 才是。番号条款依赖它。",
  },
  {
    file: "packages/core/src/commanderPresence.ts",
    symbol: "FRONT_JUDGMENT_HEADER",
    kind: "envelope",
    rules: ["handle_addressing"],
    disposition: "engine_untouched",
    note: "当前值优先于提问时快照；番号是地址不是推荐。账本条款与番号条款都依赖它。",
  },
  // ── 语音输入 V1 新增两面（2026-08-09，步 2）──
  // 先登记后施工，不等台架来提醒：--sites 的 B 断言只在**指纹命中**时才响，
  // 而新面天生没有旧指纹——靠它提醒等于没有护栏（Opus 审 P1-10 更正了这一点）。
  // 照刀2 先例：新面进表 + 同 commit 补一条新指纹。
  {
    file: AI_TS,
    symbol: "VOICE_COMMAND_NOTE",
    kind: "shared_face",
    rules: [],
    disposition: "voice_input_v1",
    note: "user content 尾巴，只在带音频那一轮出现：告诉模型「指挥官命令：」后面为空不是漏字、原话在附件语音里。**不含规则**（规则全在 withVoiceReinforcement），所以 rules 为空——登记它是为了 A 断言：这一面被删掉或改名必须有人知道。共享面（combat+logistics 同读），已进 REGISTERED_SHARED_SURFACE_RULINGS。",
  },
  {
    file: AI_TS,
    symbol: "withVoiceReinforcement",
    kind: "shared_face",
    rules: ["voice_transcript", "voice_spoken"],
    disposition: "voice_input_v1",
    note: "语音回合的【本次强制】，两项义务：① heard=逐字转写 + 一条语义原则「不要顺句、不要拿信封里的名字补没听清的音」+ 转写不进正文；② **spoken**（spoken 层 2026-08-09 新增）=只说给耳朵的那一两句 + 一条语义原则「从属正文，不带正文与单子没有的事实」。位置照抄 withPendingReinforcement（同一个位置把 pendingDecision 的 MISSING 从 45/45 钉成 0）。★①那条原则是 N2 的对症药：探针两次独立复算都拍到「音频含糊 → 模型交付顺过的意思而非逐字原话」，而 heard 会被当原话去找锚点。★②这一面同 commit 改了 ① 里一句**理由**：原文写「正文里不要复述它（正文会被念出来给他听）」——分层后语音回合的正文不再被念，该理由为假 ⇒ 换成真理由（正文写的是你要对长官说的话），规则本身未撤。共享面（combat+logistics 同读），两次变更都已进 REGISTERED_SHARED_SURFACE_RULINGS。",
  },
];

/** 语义指纹：一条规则的多种写法（中/英/压缩/无标签）都要能认出来。 */
const RULE_FINGERPRINTS: Record<RuleTag, RegExp[]> = {
  enforcement: [/ENFORCEMENT RULES/, /首字禁 ?acknowledgment/],
  judgment_license: [
    /未知量/,
    /unknown he is waiting for you to deliver/i,
    /他在等你交付的那一样/,
    /等你交付的那一样/,
  ],
  no_repeat: [
    /NEVER repeat yourself/i,
    /每次回复换开头/,
    /每次换开头/,
    /不重复上一条/,
    /VARY your style/i,
    /Never open the same way twice/i,
    /别落定式/,
    /每次换说法/,
    /每次的问法都不一样/,
    /每次问法都不一样/,
    /Vary phrasing/i,
  ],
  consultation_vs_order: [/CONSULTATION vs ORDER/, /纯祈使/],
  length_band: [/言语行为分档/, /speech-act banding/i, /Length follows the speech act/i],
  mood_register: [/mood 行/, /mood line/i],
  speech_contract: [/说话合同/],
  handle_addressing: [
    // 第 8 级 刀2：印法从行尾 `handle=G#` 改成紧贴部队名的 `名[临时编队G#]`。
    // 改的是**指纹**（规则的新写法），SPEECH_RULE_SITES 的登记条目一个字没动——
    // 规则还是那条规则，只是它在源码里长这样了。旧写法保留：一处漏改会被
    // 断言 C 抓成"规则集合漂移"，而不是安静地当成"这一面没这条规则"。
    /\[临时编队G#\]/,
    /handle=G#/,
    /group labels are NOT valid fromSquad/i,
    /LABEL is NOT a valid fromSquad/i,
    /a force handle — a G-number/i,
  ],
  // 语音输入 V1：两条写法都指同一条规则——义务（heard 必须在）与
  // 原则（逐字，不许顺句）。故意不写 /heard/ 这种宽指纹：它会把注释里
  // 顺口提到 heard 的面也钓上来，B 断言就成了噪音源。
  voice_transcript: [/逐字转写/, /根级 "heard"/],
  // spoken 层：同上两条写法——义务（spoken 必须在）与原则（从属正文）。
  // 同样避开宽指纹 /spoken/：那三个字母在英文 prompt 里到处都是。
  voice_spoken: [/根级 "spoken"/, /耳朵听的那一两句/],
};

interface Span {
  key: string;
  text: string;
}

/** 把 ai.ts 切成"面"：顶层 const 一个面；Record 常量按 channel 键再切。 */
function extractAiTsSpans(src: string): Span[] {
  const lines = src.split("\n");
  const starts: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export )?(?:const|function|async function|interface|type) ([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]);
    if (m) starts.push({ name: m[1], line: i });
  }
  const spans: Span[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].line;
    const to = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    const body = lines.slice(from, to);
    const name = starts[i].name;
    // Record 常量：按两空格缩进的 channel 键切分
    const keyed: { key: string; from: number }[] = [];
    for (let j = 0; j < body.length; j++) {
      const km = /^ {2}(combat|ops|logistics|group):/.exec(body[j]);
      if (km) keyed.push({ key: km[1], from: j });
    }
    if (keyed.length > 0) {
      for (let k = 0; k < keyed.length; k++) {
        const s = keyed[k].from;
        const e = k + 1 < keyed.length ? keyed[k + 1].from : body.length;
        spans.push({ key: `${name}.${keyed[k].key}`, text: body.slice(s, e).join("\n") });
      }
      // 键之外的前言（Record 的头部注释/类型行）也留一份，规则不许藏在那儿
      spans.push({ key: name, text: body.slice(0, keyed[0].from).join("\n") });
    } else {
      spans.push({ key: name, text: body.join("\n") });
    }
  }
  return spans;
}

/** 信封面：按 section header 的行切（这些是引擎代码里的字符串，不是 prompt 常量）。 */
function envelopeSpans(): Span[] {
  const out: Span[] = [];
  const dig = readFileSync("packages/shared/src/digest.ts", "utf8").split("\n");
  for (const line of dig) {
    if (line.includes("---SQUADS--- (loc=")) out.push({ key: "SQUADS_HEADER", text: line });
    if (line.includes("---UNASSIGNED_UNITS--- (spatial")) out.push({ key: "UNASSIGNED_HEADER", text: line });
  }
  const cp = readFileSync("packages/core/src/commanderPresence.ts", "utf8").split("\n");
  for (let i = 0; i < cp.length; i++) {
    if (cp[i].includes("---FRONT_JUDGMENT--- (CURRENT values")) {
      out.push({ key: "FRONT_JUDGMENT_HEADER", text: cp.slice(i, i + 8).join("\n") });
    }
  }
  return out;
}

/** 源码注释里的字不是规则——模型永远看不到它们。检测前先把 // 行剥掉，
 *  否则"给后来的人解释这刀干了什么"的注释会被当成第 23 个说话规则面。 */
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

function detectRules(raw: string): RuleTag[] {
  const text = stripLineComments(raw);
  const out: RuleTag[] = [];
  for (const tag of Object.keys(RULE_FINGERPRINTS) as RuleTag[]) {
    if (RULE_FINGERPRINTS[tag].some((re) => re.test(text))) out.push(tag);
  }
  return out;
}

function runSites(): void {
  let bad = 0;
  const fail = (msg: string) => {
    console.log(`FAIL ${msg}`);
    bad++;
  };

  const aiSrc = readFileSync(AI_TS, "utf8");
  const spans = new Map<string, string>();
  for (const s of extractAiTsSpans(aiSrc)) spans.set(s.key, s.text);
  const envSpans = new Map<string, string>();
  for (const s of envelopeSpans()) envSpans.set(s.key, s.text);

  const registered = new Map<string, SpeechRuleSite>();
  for (const site of SPEECH_RULE_SITES) {
    registered.set(site.channel ? `${site.symbol}.${site.channel}` : site.symbol, site);
  }

  console.log("== SPEECH_RULE_SITES 登记表 ==\n");
  console.log("面".padEnd(32) + "种类".padEnd(16) + "处置".padEnd(20) + "规则");
  for (const site of SPEECH_RULE_SITES) {
    const key = site.channel ? `${site.symbol}.${site.channel}` : site.symbol;
    console.log(
      key.padEnd(32) + site.kind.padEnd(16) + site.disposition.padEnd(20) + (site.rules.join(",") || "—"),
    );
  }
  console.log("");

  // A. 登记过的面必须还在
  for (const [key, site] of registered) {
    const text = site.kind === "envelope" ? envSpans.get(site.symbol) : spans.get(key);
    if (text === undefined) fail(`A 登记的面不见了：${key}（${site.file}）——改名/删除必须同步改表`);
  }

  // B. 带说话规则标记的面必须登记过
  for (const [key, text] of spans) {
    const found = detectRules(text);
    if (found.length > 0 && !registered.has(key)) {
      fail(`B 未登记的说话规则面：${key} 带 [${found.join(",")}]——新面必须进表`);
    }
  }
  for (const [key, text] of envSpans) {
    const found = detectRules(text);
    if (found.length > 0 && !registered.has(key)) {
      fail(`B 未登记的信封口径面：${key} 带 [${found.join(",")}]`);
    }
  }

  // C. 实测规则集合 == 登记规则集合
  for (const [key, site] of registered) {
    const text = site.kind === "envelope" ? envSpans.get(site.symbol) : spans.get(key);
    if (text === undefined) continue;
    const found = detectRules(text).sort();
    const want = [...site.rules].sort();
    if (found.join("|") !== want.join("|")) {
      fail(`C ${key} 规则集合漂移：登记=[${want.join(",")}] 实测=[${found.join(",")}]`);
    }
  }

  console.log(bad === 0 ? "\n登记表全绿（A/B/C 三条断言）" : `\n登记表 ${bad} 条不过`);
  process.exit(bad === 0 ? 0 : 1);
}

// ============================================================
// --report：双向指标（判定规则见 _archive/.../JUDGMENT_RULES_PINNED.md，
// 跑前钉死，本文件只负责算，不负责改判据）
// ============================================================

interface ArmFile {
  arm: string;
  promptSha?: string;
  digestSha: string;
  records: Record[];
}

interface ArmStats {
  arm: string;
  promptSha: string;
  digestSha: string;
  unusable: number;
  retried: number;
  goal: { n: number; fail: number; offensive: number; offUnits: number; noDoctrine: number; retreatOk: number; opened: number; dispatched: number; doctrines: number };
  order: { n: number; zeroExec: number; medianMs: number; questionEnd: number; ask: number };
  chain2: { n: number; opened: number; dispatched: number };
  consult: { n: number; opened: number };
  g2: { n: number; violations: number; exitA: number; exitB: number; samples: string[] };
  g4: { n: number; withHandle: number };
  repeat: { n: number; dupes: number };
  misbound: { n: number; hits: number; samples: string[] };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function statsOf(f: ArmFile): ArmStats {
  const usable = f.records.filter((r) => !r.unusable);
  const cls = (c: string) => usable.filter((r) => r.cls === c);

  const goal = cls("goal");
  const order = cls("order");
  const chain = cls("chain2");
  const consult = cls("consult");
  const g2 = cls("g2");
  const g4 = cls("g4");

  // 逐字复读：同一探针格内 brief 完全相同的条数（第一条不算重复）
  let dupes = 0;
  const seen = new Map<string, Set<string>>();
  for (const r of usable) {
    const key = `${r.cls}/${r.probeId}`;
    if (!seen.has(key)) seen.set(key, new Set());
    const set = seen.get(key)!;
    const b = r.brief.trim();
    if (b.length === 0) continue;
    if (set.has(b)) dupes++;
    else set.add(b);
  }

  const g2v = g2.map((r) => unspokenRealIds(r.intents, r.message));
  return {
    arm: f.arm,
    promptSha: (f.promptSha ?? "?").slice(0, 12),
    digestSha: f.digestSha.slice(0, 12),
    unusable: f.records.filter((r) => r.unusable).length,
    retried: f.records.filter((r) => r.retries > 0).length,
    goal: {
      n: goal.length,
      // ★判据修订第 2 版：主判＝没过三件套的比例
      fail: goal.filter((r) => !goalTriad(r).pass).length,
      noDoctrine: goal.filter((r) => goalTriad(r).noDoctrine).length,
      retreatOk: goal.filter((r) => goalTriad(r).retreatOk).length,
      // 修订第 1 版的分项，继续报告
      offensive: goal.filter((r) => offensiveDispatch(r.intents).hasOffensive).length,
      offUnits: goal.reduce((a, r) => a + offensiveDispatch(r.intents).units, 0),
      opened: goal.filter((r) => r.intentCount > 0).length,
      dispatched: goal.filter((r) => r.assignedUnits > 0).length,
      doctrines: goal.filter((r) => r.standingOrder).length,
    },
    order: {
      n: order.length,
      zeroExec: order.filter((r) => r.intentCount === 0).length,
      medianMs: median(order.map((r) => r.latencyMs)),
      questionEnd: order.filter((r) => /[?？]\s*$/.test(r.brief.trim())).length,
      ask: order.filter((r) => r.responseType === "ASK").length,
    },
    chain2: {
      n: chain.length,
      opened: chain.filter((r) => r.intentCount > 0).length,
      dispatched: chain.filter((r) => r.assignedUnits > 0).length,
    },
    consult: { n: consult.length, opened: consult.filter((r) => r.intentCount > 0).length },
    g2: {
      n: g2.length,
      violations: g2v.filter((v) => v.length > 0).length,
      exitA: g2.filter((r, i) => g2v[i].length === 0 && r.intentCount > 0).length,
      exitB: g2.filter((r) => r.intentCount === 0).length,
      samples: g2v.flat().slice(0, 8),
    },
    g4: { n: g4.length, withHandle: g4.filter((r) => /G\d+/.test(r.brief)).length },
    repeat: { n: usable.length, dupes },
    misbound: {
      n: usable.length,
      hits: usable.filter((r) => misboundHandles(r.brief).length > 0).length,
      samples: usable.flatMap((r) => misboundHandles(r.brief)).slice(0, 6),
    },
  };
}

function pct(a: number, b: number): string {
  return b === 0 ? "—" : `${a}/${b} (${Math.round((a / b) * 100)}%)`;
}

function printArm(s: ArmStats): void {
  console.log(`\n── 臂 ${s.arm}（prompt ${s.promptSha} / 信封 ${s.digestSha}）──`);
  console.log(`  不可用记录=${s.unusable}  重试过=${s.retried}`);
  console.log(`  指标1 误执行（goal 未过【三件套】）: ${pct(s.goal.fail, s.goal.n)}   进攻实派兵力合计: ${s.goal.offUnits}`);
  console.log(`        三件套分项：攻击单0 ${pct(s.goal.n - s.goal.offensive, s.goal.n)} ｜ doctrine0 ${pct(s.goal.noDoctrine, s.goal.n)} ｜ 撤退半句照开 ${pct(s.goal.retreatOk, s.goal.n)}`);
  console.log(`        （旧判据留档对照：有任何 intent ${pct(s.goal.opened, s.goal.n)}，实派>0 ${pct(s.goal.dispatched, s.goal.n)}）`);
  console.log(`  指标2 误咨询（order 零执行）  : ${pct(s.order.zeroExec, s.order.n)}`);
  console.log(`  指标3 两轮链第二轮开单        : ${pct(s.chain2.opened, s.chain2.n)}   实派>0: ${pct(s.chain2.dispatched, s.chain2.n)}`);
  console.log(`  指标4 G2 假地名违规（硬线）   : ${pct(s.g2.violations, s.g2.n)}   出口a(原话进字段)=${s.g2.exitA} 出口b(零单)=${s.g2.exitB}`);
  if (s.g2.samples.length) console.log(`        违规样本: ${s.g2.samples.join(" | ")}`);
  console.log(`  指标5 G4 番号在场             : ${pct(s.g4.withHandle, s.g4.n)}`);
  console.log(`  指标6 逐字复读（线索，非判据）: ${pct(s.repeat.dupes, s.repeat.n)}`);
  console.log(`  指标7 order 摩擦：问号收尾 ${pct(s.order.questionEnd, s.order.n)}  ASK ${pct(s.order.ask, s.order.n)}  中位延迟 ${s.order.medianMs}ms`);
  console.log(`  观察项 番号贴错对象（不进编话账）: ${pct(s.misbound.hits, s.misbound.n)}${s.misbound.samples.length ? "  例: " + s.misbound.samples.slice(0, 3).join(" | ") : ""}`);
  console.log(`  （未预登记，仅描述）consult 被开单: ${pct(s.consult.opened, s.consult.n)}`);
}

function runReport(aPath: string, bPath?: string): void {
  const A = JSON.parse(readFileSync(aPath, "utf8")) as ArmFile;
  const sa = statsOf(A);
  printArm(sa);
  if (!bPath) return;
  const B = JSON.parse(readFileSync(bPath, "utf8")) as ArmFile;
  const sb = statsOf(B);
  printArm(sb);

  console.log(`\n══ 判定（规则钉死于 A 臂开跑之前，见 JUDGMENT_RULES_PINNED.md）══`);
  if (A.digestSha !== B.digestSha) {
    console.log(`✗ 信封不同（A=${A.digestSha.slice(0, 12)} B=${B.digestSha.slice(0, 12)}）——A/B 变量不唯一，本次比较无效`);
    process.exit(1);
  }

  let verdict = true;
  const line = (ok: boolean, text: string) => {
    console.log(`${ok ? "过" : "退"} ${text}`);
    if (!ok) verdict = false;
  };

  // 指标1：B 低于 A，且差 ≥3/20（按 20 局折算）
  const scale = (x: number, n: number) => (n === 0 ? 0 : (x / n) * 20);
  const gA = scale(sa.goal.fail, sa.goal.n);
  const gB = scale(sb.goal.fail, sb.goal.n);
  line(
    gB < gA && gA - gB >= 3,
    `指标1 误执行（三件套未过）：A=${gA.toFixed(1)}/20 → B=${gB.toFixed(1)}/20（要求 B<A 且差≥3）｜进攻实派兵力 ${sa.goal.offUnits} → ${sb.goal.offUnits}`,
  );

  // 指标2：B 误咨询 ≤ A + 4（按 40 局折算）
  const scale40 = (x: number, n: number) => (n === 0 ? 0 : (x / n) * 40);
  const oA = scale40(sa.order.zeroExec, sa.order.n);
  const oB = scale40(sb.order.zeroExec, sb.order.n);
  line(oB <= oA + 4, `指标2 误咨询：A=${oA.toFixed(1)}/40 → B=${oB.toFixed(1)}/40（非劣界 ≤A+4）`);

  // 指标4：B 违规必须为 0
  line(sb.g2.violations === 0, `指标4 G2 硬线：B 违规=${sb.g2.violations}（要求 0）`);

  // 指标7：order 摩擦不得显著增加（问号收尾 + ASK，按比例，允许 +5% 噪声）
  const fA = (sa.order.questionEnd + sa.order.ask) / Math.max(1, sa.order.n);
  const fB = (sb.order.questionEnd + sb.order.ask) / Math.max(1, sb.order.n);
  line(fB <= fA + 0.05, `指标7 order 摩擦：A=${(fA * 100).toFixed(0)}% → B=${(fB * 100).toFixed(0)}%（允许 +5pt 噪声）`);

  console.log(`\n数字面结论：${verdict ? "四条判退线全过" : "★有判退线未过"}`);
  console.log(`★主判仍是盲读（指标 6 rubric）——数字过线不等于这刀成了。`);
}

/**
 * --emily-guard：★用户裁定 2026-08-06 的第 1 道防护。
 *
 * SYSTEM_PROMPT 是共享面（combat=陈 / logistics=Emily；ops 走 MARCUS_V2 已分家）。
 * a 案的承诺是：Emily 装配后的最终 prompt **只许出现位置移动，内容零增删**。
 * 这条断言就是那句承诺的机器版：
 *   ① 旧版里 Emily 读到的每一行，新版必须还在（逐字，允许缩进变化）→ 零删除
 *   ② 新版多出来的每一行，必须落在【陈的人格块】里面 → 零注入
 * "内容没动所以应该没变"不算证明——那是第 2 道防护（Emily 生产台架效果级负对照）的活。
 */
/**
 * 共享面（SYSTEM_PROMPT + CHANNEL_PERSONA.logistics）上历次**经裁**的变更。
 *
 * 这份清单印进每次 guard 报告里，而不是一次性追加到 emily-guard.md ——
 * 那个文件每跑一次都被 writeFileSync 重写，追加的裁定记录下一次就没了。
 * 记录要活下来，就得由生成它的那支笔每次重写一遍。
 *
 * ★ carve-out 的操作定义（两次触发合起来才说得清，2026-08-07/08）：
 *     旧行**因线变而为假** → 必须改（留着＝共享面上挂一句假话）；
 *     线变了旧行**仍然为真** → 不碰（那不是例外，是本来就无权改）。
 *   绊线的职责是逼停待裁——两次都停对了，一次判"无权改"，一次判"必须改"。
 */
const REGISTERED_SHARED_SURFACE_RULINGS: readonly string[] = [
  "2026-08-07 第 8 级 fix B：ai.ts tag 格式指称【判退·回退】——旧文说的是「值 tag_1」，" +
    "新印法 `\"名字\"(tag_1)` 里 id 仍在，旧文句句属实 ⇒ carve-out 前提不成立，无权改。",
  "2026-08-09 语音输入 V1 步2：共享面新增两段【授权·新增，只在带音频那一轮出现】——" +
    "`VOICE_COMMAND_NOTE`（user content 尾巴：原话在附件语音里）与 " +
    "`withVoiceReinforcement`（system prompt 尾巴：heard 的义务 + 不许顺句）。" +
    "★这不是 carve-out（没有旧行为假），是**新增**：Emily 也换耳朵是用户裁定（§V-4 Q2），" +
    "所以她的 prompt 在语音回合会多这两段。打字回合两段都不出现、共享面逐字节不变" +
    "——emily-guard 因此仍然全绿，但它扫不到 userContent 模板，登记不能靠它提醒（Opus 审 P1-9）。",
  "2026-08-09 spoken 层 步2：共享面 `withVoiceReinforcement` 两笔——" +
    "①【授权·新增】语音回合的【本次强制】多一段 spoken 义务（只给耳朵的一两句 + 从属正文），" +
    "与 heard 同一段落、同样只在带音频那一轮出现，打字回合仍逐字节不变；" +
    "②【carve-out·必须改】heard 那句「正文里不要复述它（**正文会被念出来给他听**）」——" +
    "分层之后语音回合的正文不再被念，括号里那句理由当场为假 ⇒ 换成真理由" +
    "（正文写的是你要对长官说的话，不是他刚说过的那句），规则本身一个字没撤。" +
    "Emily 与陈同读这一面，所以她在语音回合也会拿到 spoken 的义务——那是 §V-4 Q2 " +
    "「Emily 一起换耳朵」的既有裁定的延长线，不是新范围。",
  "2026-08-08 第 8 级 刀2：ai.ts 解析器 prompt 的番号 token 指称【授权·已改】——" +
    "旧文写 `any ---FRONT_JUDGMENT--- row's handle=G# token`，而刀2 后 `handle=` 全仓绝迹，" +
    "该句字面为假、把模型指向一个不存在的 token ⇒ 必须改。§O-4 原文授权 + Fable 裁定。" +
    "同句位、只换形的指称，不加规则不加例句；保留 `a force handle — a G-number` 短语。",
];

function runEmilyGuard(baseRef: string, outPath: string): void {
  const newSrc = readFileSync(AI_TS, "utf8");
  const baseSrc = execSync(`git show ${baseRef}:${AI_TS}`, { encoding: "utf8", maxBuffer: 1 << 24 });

  const spansOf = (src: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const s of extractAiTsSpans(src)) m.set(s.key, s.text);
    return m;
  };
  const oldSpans = spansOf(baseSrc);
  const newSpans = spansOf(newSrc);

  const assemble = (sp: Map<string, string>): string =>
    `${sp.get("SYSTEM_PROMPT") ?? ""}\n\n${sp.get("CHANNEL_PERSONA.logistics") ?? ""}`;

  const norm = (t: string): string[] =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  const oldLines = norm(assemble(oldSpans));
  const newLines = norm(assemble(newSpans));

  const bag = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ob = bag(oldLines);
  const nb = bag(newLines);

  const removed: string[] = [];
  for (const [line, n] of ob) {
    const have = nb.get(line) ?? 0;
    for (let i = 0; i < n - have; i++) removed.push(line);
  }
  const added: string[] = [];
  for (const [line, n] of nb) {
    const have = ob.get(line) ?? 0;
    for (let i = 0; i < n - have; i++) added.push(line);
  }

  // 陈的人格块 = combat 那一条到 ops 那一条之间
  const chenBlockOf = (sp: Map<string, string>): Set<string> => {
    const sysLines = (sp.get("SYSTEM_PROMPT") ?? "").split("\n");
    const from = sysLines.findIndex((l) => l.includes("combat channel → 陈军士"));
    const to = sysLines.findIndex((l) => l.includes("ops channel → CPT Marcus"));
    return new Set(
      from >= 0 && to > from ? sysLines.slice(from, to).map((l) => l.trim()).filter(Boolean) : [],
    );
  };
  const chenBlock = chenBlockOf(newSpans);
  const oldChenBlock = chenBlockOf(oldSpans);

  // ★ 用户裁定 2026-08-06 的准确边界：陈块【内部】的删除是本刀的活
  // （判断执照直删已获批）；陈块【外部】——也就是 Emily 自己那些规则——
  // 一行都不许少，只许换位置。所以"零删除"这条只对陈块外的行成立。
  const strayRemoves = removed.filter((l) => !oldChenBlock.has(l));
  const strayAdds = added.filter((l) => !chenBlock.has(l));

  const report = [
    `# Emily 共享面防护（a 案第 1 道）`,
    ``,
    `基线 ref: ${baseRef}`,
    `装配对象: SYSTEM_PROMPT + CHANNEL_PERSONA.logistics（logistics 频道实际收到的 prompt 文本）`,
    ``,
    `## ① 零删除（陈块之外）：Emily 自己那些规则一行都不许少`,
    strayRemoves.length === 0
      ? `✓ 陈块外零删除（旧版 ${oldLines.length} 行，删掉的 ${removed.length} 行全部来自陈的人格块内部）`
      : `✗ 陈块【外】丢了 ${strayRemoves.length} 行：`,
    ...strayRemoves.map((l) => `   - ${l}`),
    ``,
    `### 陈块内被删的行（本刀的活，已获用户裁定）`,
    ...removed.filter((l) => oldChenBlock.has(l)).map((l) => `   - ${l}`),
    ``,
    `## ② 零注入：新增行是否全部落在陈的人格块内`,
    strayAdds.length === 0
      ? `✓ 新增 ${added.length} 行全部在陈块内（陈块 ${chenBlock.size} 行）`
      : `✗ 有 ${strayAdds.length} 行新增落在陈块之外：`,
    ...strayAdds.map((l) => `   - ${l}`),
    ``,
    `## 新增行清单（供人读）`,
    ...added.map((l) => `   + ${l}`),
    ``,
    `## 共享面上【经裁】的变更（历次）`,
    `将来任何人看到共享面上的这些 diff，应读作「经裁的变更」，不是漂移。`,
    ...REGISTERED_SHARED_SURFACE_RULINGS.map((r) => `   · ${r}`),
  ].join("\n");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report + "\n");
  console.log(report);
  const ok = strayRemoves.length === 0 && strayAdds.length === 0;
  console.log(`\n${ok ? "PASS" : "FAIL"} Emily 共享面防护（存档：${outPath}）`);
  process.exit(ok ? 0 : 1);
}

/**
 * --blind：把两臂台词洗牌、去掉臂标签写成一份待读稿（答案另写一份 key）。
 *
 * 指标 6 是主判，而主判必须盲读——Step B 的教训是"关键词正则会饱和、两向皆坏"，
 * 而知道哪句是 B 臂的人读出来的结果不叫盲读。
 */
function runBlind(aPath: string, bPath: string, outPath: string): void {
  const A = JSON.parse(readFileSync(aPath, "utf8")) as ArmFile;
  const B = JSON.parse(readFileSync(bPath, "utf8")) as ArmFile;
  const items: { id: string; arm: string; cls: string; probeId: string; message: string; brief: string }[] = [];
  let n = 0;
  for (const [arm, f] of [["A", A], ["B", B]] as const) {
    for (const r of f.records) {
      if (r.unusable || !r.brief.trim()) continue;
      items.push({
        id: `S${String(++n).padStart(3, "0")}`,
        arm,
        cls: r.cls,
        probeId: r.probeId,
        message: r.message,
        brief: r.brief,
      });
    }
  }
  // 确定性洗牌（同一份输入永远同一个顺序，复核时可重放）
  let seed = 20260806;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const lines = items.map(
    (it, i) => `[${String(i + 1).padStart(3, "0")}] (${it.cls}/${it.probeId}) 长官：${it.message}\n     陈：${it.brief}\n`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n"));
  writeFileSync(
    outPath.replace(/\.txt$/, "") + ".KEY.json",
    JSON.stringify(items.map((it, i) => ({ idx: i + 1, arm: it.arm, cls: it.cls, probeId: it.probeId })), null, 2),
  );
  console.log(`盲读稿：${outPath}（${items.length} 条）\n答案：${outPath.replace(/\.txt$/, "")}.KEY.json`);
}

// ── main ──

const mode = process.argv[2];

if (mode === "--selftest") {
  // 台架自检（家法：会动兵的判据本身也要有负对照——一把数不动兵的尺，
  // 比没有尺更坏，它会把"办了"读成"没办"）。跑前必过。
  sceneDigest(CANON); // 铸号：番号只有铸过才存在
  let bad = 0;
  const t = (name: string, intents: WireIntent[], want: (n: number) => boolean, hint: string) => {
    const n = assignedUnitCount(intents);
    const ok = want(n);
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} — 实派=${n}（期望${hint}）`);
  };
  t("番号 G1 + toFront 能真派出去", [{ type: "defend", fromSquad: "G1", toFront: "front_coastal", quantity: 6 }], (n) => n === 6, "=6");
  t("队长名 Aiden 能真派出去", [{ type: "defend", fromSquad: "Aiden", toFront: "front_ridge", quantity: 2 }], (n) => n === 2, "=2");
  t("普通进攻单能真派出去", [{ type: "attack", targetFacility: "ea_kidney_ridge", quantity: 3 }], (n) => n > 0, ">0");
  t("空单 = 零执行", [], (n) => n === 0, "=0");
  t("未知番号 G99 = 零执行", [{ type: "defend", fromSquad: "G99", toFront: "front_coastal", quantity: 6 }], (n) => n === 0, "=0");
  // ★ 假地名单【不是】零执行：引擎侧 softFixTargetFields 会先把找不到的字段
  //   清掉并点名报错，剩下的字段照常执行（defend 就地设防）。所以 G2 的判据
  //   是下面那条 JSON 硬线，不是实派数——实派数在这一格测的是别的东西。
  t("假地名单会就地执行（记录引擎真实行为，非判据）", [{ type: "defend", targetRegion: "卡拉马佐夫高地", quantity: 3 }], (n) => n >= 0, "≥0");

  const g2 = (name: string, intents: WireIntent[], msg: string, wantHit: boolean) => {
    const hits = unspokenRealIds(intents, msg);
    const ok = hits.length > 0 === wantHit;
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} — 命中=${JSON.stringify(hits)}`);
  };
  g2("G2 硬线：假名换成真 id → 抓住", [{ type: "defend", targetFacility: "ea_himeimat" }], "让Aiden带兵去卡拉马佐夫高地设防", true);
  g2("G2 出口(a)：原话进字段 → 不算违规", [{ type: "defend", targetRegion: "卡拉马佐夫高地" }], "让Aiden带兵去卡拉马佐夫高地设防", false);
  g2("G2 出口(b)：零 intent → 不算违规", [], "让Aiden带兵去卡拉马佐夫高地设防", false);
  g2("G2 负对照：长官自己说的真地名 → 不算违规", [{ type: "defend", toFront: "front_coastal" }], "去front_coastal设防", false);
  console.log(bad === 0 ? "\n台架自检全过" : `\n台架自检 ${bad} 条不过——先修尺再跑臂`);
  process.exit(bad === 0 ? 0 : 1);
} else if (mode === "--digest") {
  const d = sceneDigest(CANON);
  console.log(d);
  console.log("\n---- meta ----");
  console.log(`sha256=${createHash("sha256").update(d).digest("hex")}`);
  console.log(`chars=${d.length}`);
  console.log(`真实地名 token 数=${realPlaceTokens(CANON).length}`);
} else if (mode === "--sites") {
  runSites();
} else if (mode === "--run-reg") {
  const arm = (process.argv[3] ?? "").toUpperCase();
  if (arm !== "A" && arm !== "B") {
    console.error("usage: --run-reg A|B [outPath]");
    process.exit(1);
  }
  void runReg(
    arm,
    process.argv[4] ?? `${process.env.HOME}/MyProjects/_archive/g-knife-ab-20260805/reg-${arm}.json`,
  );
} else if (mode === "--emily-guard") {
  runEmilyGuard(
    process.argv[3] ?? "HEAD",
    process.argv[4] ?? `${process.env.HOME}/MyProjects/_archive/g-knife-ab-20260805/emily-guard.md`,
  );
} else if (mode === "--blind") {
  const a = process.argv[3];
  const b = process.argv[4];
  if (!a || !b) {
    console.error("usage: --blind A.json B.json [out.txt]");
    process.exit(1);
  }
  runBlind(
    a,
    b,
    process.argv[5] ?? `${process.env.HOME}/MyProjects/_archive/g-knife-ab-20260805/blind-read.txt`,
  );
} else if (mode === "--report") {
  const a = process.argv[3];
  if (!a) {
    console.error("usage: --report A.json [B.json]");
    process.exit(1);
  }
  runReport(a, process.argv[4]);
} else if (mode === "--run") {
  const arm = (process.argv[3] ?? "").toUpperCase();
  if (arm !== "A" && arm !== "B") {
    console.error("usage: --run A|B [outPath]");
    process.exit(1);
  }
  const out =
    process.argv[4] ??
    `${process.env.HOME}/MyProjects/_archive/g-knife-ab-20260805/arm-${arm}.json`;
  void runArm(arm, out);
} else {
  console.log(
    "usage: tsx scripts/ab-g-knife.ts --digest | --selftest | --sites | --run A|B [out] | --run-reg A|B [out] | --report A.json [B.json] | --blind A.json B.json [out.txt]",
  );
}
