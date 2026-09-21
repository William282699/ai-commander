// ============================================================
// AI Commander — 任务台账（retreat-scope 刀C）
//
// 问题：「某条战线的部队」过去只有一种解释——此刻站在那条线包围盒里的可调单位
// （`getUnitsOnFront`，纯几何）。部队一开拔就不再"属于"原战线，于是
// 「让刚从南线派出去那批撤回来」这句话，intent 里**没有任何字段能表达**，
// 模型只好就近抓一个已知把手（LEDGER §F2）。
//
// 解法：新增一类可被指代的对象——**任务**（Dispatch）。每次玩家命令真的派出了
// 兵，引擎在**真派兵那一刻**记一条；「位置」与「任务」走两个不同的 intent 字段，
// 各自独立解析，不互相兜底、不静默合并。
//
// 三条纪律：
//   ① 台账由引擎写，不从对话历史反推（§F2 就是被上下文带偏的）。
//   ② 记账只认 `Order.origin`，**不认调用的是哪个函数**——`applyPlayerCommands`
//      是鼠标专用且会盖 manualOverride，对话派兵走的是 `applyOrders`。
//   ③ **活成员现查**。名单是快照，战场不是：人会死、会被改派。
//      「看到移动状态或命令变化就认定已改派」是错的——撤退抵达后
//      `sim.ts` 会把命令改写成持久 defend 单、`autoBehavior` 会直接改 state，
//      那都是原任务自身的演进，不是改派。**按事件摘除，不按状态嗅探。**
// ============================================================

import type { GameState, Dispatch, DispatchMeta, Unit, Intent } from "@ai-commander/shared";
import { isDispatchablePlayerUnit } from "@ai-commander/shared";

/** 已结束历史的保留上限。**仍有关联部队的任务一律保留**，不因为超额被删。 */
const CLOSED_HISTORY_CAP = 32;

/** 任务号的命名空间：M#。刻意避开 `G#`（临时编队号）与分队号
 *  （`[TIANF]\d+`，见 autoExecuteGate 的锚正则），两套号不许互相冒认。 */
function mintDispatchId(state: GameState): string {
  const n = state.nextDispatchNum ?? 1;
  state.nextDispatchNum = n + 1;
  return `M${n}`;
}

/** 这条任务此刻还剩哪些人能调。**现查**，不读快照里的死人。 */
export function liveDispatchMembers(state: GameState, d: Dispatch): Unit[] {
  const out: Unit[] = [];
  for (const id of d.memberIds) {
    const u = state.units.get(id);
    if (u && isDispatchablePlayerUnit(u)) out.push(u);
  }
  return out;
}

/** 按号找一条**在役**任务（号不区分大小写；模型常把 m3 写成小写）。 */
export function findDispatch(state: GameState, id: string): Dispatch | undefined {
  const key = id.trim().toLowerCase();
  return state.dispatches.find((d) => d.status === "active" && d.id.toLowerCase() === key);
}

/** 在役且还有人的任务——信封、消歧、选兵三处共用这一个口径。 */
export function activeDispatches(state: GameState): Dispatch[] {
  return state.dispatches.filter((d) => d.status === "active" && liveDispatchMembers(state, d).length > 0);
}

/** 失效清理：成员全死/全被改派的记录转 closed；已结束历史只保留最近 32 条。
 *  ★ 仍有关联部队的任务**一律保留**——不许因为"满 32 条"删掉一条活着的任务。 */
function pruneLedger(state: GameState): void {
  for (const d of state.dispatches) {
    if (d.status === "active" && liveDispatchMembers(state, d).length === 0) d.status = "closed";
  }
  const closed = state.dispatches.filter((d) => d.status === "closed");
  if (closed.length > CLOSED_HISTORY_CAP) {
    const drop = new Set(closed.slice(0, closed.length - CLOSED_HISTORY_CAP));
    state.dispatches = state.dispatches.filter((d) => !drop.has(d));
  }
}

/**
 * 玩家命令落地：把这批人从**旧**任务里摘除，再开一条新任务。
 *
 * 只由 `applyOrders` 在 `origin` 是 advisor/mouse 时调用，且只拿**真接到命令**
 * 的那些 id（`appliedUnitIds`）——计划选中的人不算数。
 *
 * 幂等跳过（alreadyDoing）那批**不摘也不记**：它们本来就在执行同一件事，
 * 既不是新派兵，也没离开旧任务。
 */
export function recordPlayerDispatch(
  state: GameState,
  appliedUnitIds: readonly number[],
  meta: DispatchMeta,
): Dispatch | null {
  if (appliedUnitIds.length === 0) return null;

  // ① 从旧任务摘除——这一步只在"玩家命令落地"这一处发生。
  const moved = new Set(appliedUnitIds);
  for (const d of state.dispatches) {
    if (d.status !== "active") continue;
    d.memberIds = d.memberIds.filter((id) => !moved.has(id));
  }

  // ② 开新任务
  const fresh: Dispatch = {
    id: mintDispatchId(state),
    atGameTime: state.time,
    sourceKind: meta.sourceKind,
    sourceKey: meta.sourceKey,
    action: meta.action,
    targetName: meta.targetName,
    memberIds: [...appliedUnitIds],
    status: "active",
  };
  state.dispatches.push(fresh);

  pruneLedger(state);
  return fresh;
}

// ── 消歧：什么时候该问一句 ──
//
// 该问的是「**有两条及以上候选同样符合**」，不是「玩家有没有说编号」。
//   ·「现在守南线的部队」＝明确（指位置）⇒ 直接走 fromFront，不问。
//   ·「刚派去山脊那批」＝明确（指任务，且只有一条匹配）⇒ 直接走 fromDispatch，不问。
//   · 同一来源派出了两批、或者"留守的"与"派出去的"同时存在 ⇒ 问。
// **绝不要求玩家念出 M3**——号是给模型用的把手，不是给人背的。

export interface DispatchCandidate {
  kind: "stay" | "dispatch";
  /** stay: 战线 id；dispatch: 任务号。 */
  key: string;
  /**
   * 刀己：给模型/合同用的**稳定、自描述**的 key（`stay:front_south` /
   * `dispatch:M1`）。两类各带前缀，所以永不可能互相冒认，模型也只需逐字抄。
   * 选择合同的闸押在这一份 key 名单上，`key` 那一栏保持原样给现有判据用。
   */
  selectionKey: string;
  /** 给玩家看的一句话（谁、多少人、去了哪）。 */
  label: string;
  unitIds: number[];
}

/** 刀己：key 的唯一构造处（拼字符串只许有一份实现）。 */
export function selectionKeyOf(kind: "stay" | "dispatch", key: string): string {
  return `${kind}:${key}`;
}

/**
 * 刀己：把候选**枚举**与「该不该问」拆开。
 *
 * 为什么必须拆：执行前复查要的是"这个 key 现在还对应谁"，而那一刻候选可能只剩
 * 一条（留守的全死了 / 旧任务关了）——`findDispatchAmbiguity` 的 `>= 2` 闸会把
 * 它判成 null，于是绑定就无从复查。枚举是事实，"问不问"是策略，两件事。
 *
 * ★ 名单一律**现查**（`unitsOnFrontKey` / `liveDispatchMembers`）：
 *   这就是「执行前按本局实时任务、存活成员重新检查」那一条的落点。
 */
export function enumerateDispatchCandidates(
  state: GameState,
  intent: Intent,
  selectedUnitIds?: readonly number[],
): DispatchCandidate[] {
  if (selectedUnitIds && selectedUnitIds.length > 0) return []; // 框选优先，指代已唯一
  if (intent.fromDispatch || intent.fromSquad) return [];
  const front = typeof intent.fromFront === "string" ? intent.fromFront.trim() : "";
  if (!front) return [];

  const candidates: DispatchCandidate[] = [];

  // 候选一：此刻还站在那条线上的（"留守的"）
  const onFront = unitsOnFrontKey(state, front);
  if (onFront.length > 0) {
    candidates.push({
      kind: "stay",
      key: front,
      selectionKey: selectionKeyOf("stay", front),
      label: `还守在${frontDisplayName(state, front)}的 ${onFront.length} 个`,
      unitIds: onFront.map((u) => u.id),
    });
  }

  // 候选二…N：从那条线派出去、此刻人已不在线上的任务
  for (const d of activeDispatches(state)) {
    if (d.sourceKind !== "front") continue;
    if (!sameFrontKey(state, d.sourceKey, front)) continue;
    const live = liveDispatchMembers(state, d);
    const away = live.filter((u) => !onFront.some((o) => o.id === u.id));
    if (away.length === 0) continue;
    candidates.push({
      kind: "dispatch",
      key: d.id,
      selectionKey: selectionKeyOf("dispatch", d.id),
      label: d.targetName
        ? `之前派去${d.targetName}的那批（${d.id}，${away.length} 个）`
        : `之前派出去的那批（${d.id}，${away.length} 个）`,
      unitIds: away.map((u) => u.id),
    });
  }

  return candidates;
}

/**
 * 这条意图指的是哪一批人？——候选唯一就不问，两条及以上才问。
 *
 * 只对「按位置指代」（fromFront，且没点名任务/分队/框选）判。玩家已经点名了
 * 任务号或分队，指代本来就唯一。
 */
export function findDispatchAmbiguity(
  state: GameState,
  intent: Intent,
  selectedUnitIds?: readonly number[],
): DispatchCandidate[] | null {
  // ── 刀丙：只在**原病例那个字段形状**上判歧义 ──
  //
  // 收窄前这里不看意图类型，只看"这条线上有留守的 + 有派出去的"。实测同一条线
  // 连下 4 条 fromFront 命令 ⇒ 奇数轮问、偶数轮办（追问槽一次性消费，下一条
  // 又从零判），被问的包括「南线再派两个去中央」「南线设防」这种玩家心里毫无
  // 歧义的命令——撞玩家已定的「清楚就办，勿变 20 问」。
  //
  // 原病例的形状是「把某条线的部队**整批撤回来**」：撤退 + 数量是"全部/大部"。
  // 只有这一格，"留守的"与"之前从这儿派出去的"才真的都可能是他指的那批。
  // 判据只看**字段形状**——不许加中文关键词表（「刚才」「之前」之类），
  // 穷举永不收敛（家法：写原则不写同义词表）。
  if (intent.type !== "retreat") return null;
  if (intent.quantity !== "all" && intent.quantity !== "most") return null;

  const candidates = enumerateDispatchCandidates(state, intent, selectedUnitIds);
  return candidates.length >= 2 ? candidates : null;
}

// ── 刀己：把选定的那个 key 绑回一条可执行的 intent（**执行前现查**）──

export type SelectionBindFailure =
  /** 这个 key 现在已经对不上任何候选（人全死了 / 任务关了 / 人已回到线上）。 */
  | "gone"
  /** 快照里没有 `fromFront`，重建无从下手（理论上进不来，fail-closed）。 */
  | "no_source";

export type SelectionBindResult =
  | {
      ok: true;
      kind: "stay" | "dispatch";
      selectionKey: string;
      /** 绑定后的 intent：来源字段被**改写成明确的那一种**，冲突字段清掉。 */
      intent: Intent;
      /** 此刻**现查**出来的成员（执行时还要与该参谋的可调池取交集）。 */
      unitIds: number[];
      /** 给玩家看的那一句（回执/拒绝语用）。 */
      label: string;
    }
  | { ok: false; reason: SelectionBindFailure };

/**
 * 按 key 重新解析候选，并把选择映射回**原 intent 的明确来源**。
 *
 * ★ 这里是「不许用旧 roster」那条的落点：函数**只收 key**，名单一律从当前
 *   `GameState` 现查。等模型回复的那几秒里人会死、会被改派、任务会关——
 *   拿登记时的快照执行，就是把"长官选的那批"偷换成"当时那批"。
 */
export function bindDispatchSelection(
  state: GameState,
  snapshot: Intent,
  selectionKey: string,
): SelectionBindResult {
  if (typeof snapshot.fromFront !== "string" || snapshot.fromFront.trim().length === 0) {
    return { ok: false, reason: "no_source" };
  }
  // 现查：用与提问时同一份枚举实现（一份实现，两处用）。
  const fresh = enumerateDispatchCandidates(state, snapshot);
  const hit = fresh.find((c) => c.selectionKey === selectionKey);
  if (!hit || hit.unitIds.length === 0) return { ok: false, reason: "gone" };

  // 映射回明确来源。两个字段互斥——绝不同时填，也不留下会互相兜底的残留。
  const intent: Intent = { ...snapshot };
  if (hit.kind === "stay") {
    // 「还守在那条线上的」＝位置指代，本来就是 fromFront 那一档；
    // 它此刻的明确性由下面那份现查名单保证（作为硬约束一起传下去）。
    intent.fromFront = hit.key;
    intent.fromDispatch = undefined;
  } else {
    intent.fromDispatch = hit.key;
    intent.fromFront = undefined;
  }
  intent.fromSquad = undefined;
  return { ok: true, kind: hit.kind, selectionKey, intent, unitIds: [...hit.unitIds], label: hit.label };
}

// ── 两个小工具：战线 key 的解析交给 tacticalPlanner 注入，避免循环依赖 ──
//
// dispatchLedger 需要"这个 hint 指哪条战线"和"那条线上此刻有谁"，而这两件事的
// 唯一真相源在 tacticalPlanner（findFront / getUnitsOnFront）。反过来 import
// 会成环，所以由 tacticalPlanner 在模块加载时注入一次——**一份实现，两处用**，
// 不在这里复制一份几何判断（复制就会漂）。
type FrontResolver = {
  frontIdOf: (state: GameState, hint: string) => string | null;
  frontNameOf: (state: GameState, hint: string) => string;
  unitsOnFront: (state: GameState, hint: string) => Unit[];
};
let resolver: FrontResolver | null = null;

export function installFrontResolver(r: FrontResolver): void {
  resolver = r;
}

function sameFrontKey(state: GameState, a: string, b: string): boolean {
  if (!resolver) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const ida = resolver.frontIdOf(state, a);
  const idb = resolver.frontIdOf(state, b);
  return ida !== null && idb !== null && ida === idb;
}

function frontDisplayName(state: GameState, hint: string): string {
  return resolver ? resolver.frontNameOf(state, hint) : hint;
}

function unitsOnFrontKey(state: GameState, hint: string): Unit[] {
  return resolver ? resolver.unitsOnFront(state, hint) : [];
}

// ── 信封：在役任务列给模型看 ──
//
// ★ 这是最容易漏的一环：号不进信封，模型永远不会填 `fromDispatch`，
//   前面所有工作对玩家都不可见。
//
// shared 不许 import core（既有契约），所以行在这里算好，由 buildDigest
// 当预算好的字符串递进去——与 board / judgment 两节同一条路。
export function buildDispatchDigestLines(state: GameState): string[] {
  const rows = activeDispatches(state);
  if (rows.length === 0) return [];
  const MAX = 8;
  const lines: string[] = [];
  for (const d of rows.slice(0, MAX)) {
    const from = d.sourceKind === "front" ? frontDisplayName(state, d.sourceKey) : d.sourceKey;
    const to = d.targetName || "未指明";
    lines.push(`${d.id} from=${from || "未指明"} to=${to} act=${d.action} left=${liveDispatchMembers(state, d).length}`);
  }
  if (rows.length > MAX) lines.push(`...+${rows.length - MAX} more`);
  return lines;
}
