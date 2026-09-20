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
  /** 给玩家看的一句话（谁、多少人、去了哪）。 */
  label: string;
  unitIds: number[];
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
  if (selectedUnitIds && selectedUnitIds.length > 0) return null; // 框选优先，指代已唯一
  if (intent.fromDispatch || intent.fromSquad) return null;
  const front = typeof intent.fromFront === "string" ? intent.fromFront.trim() : "";
  if (!front) return null;

  const candidates: DispatchCandidate[] = [];

  // 候选一：此刻还站在那条线上的（"留守的"）
  const onFront = unitsOnFrontKey(state, front);
  if (onFront.length > 0) {
    candidates.push({
      kind: "stay",
      key: front,
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
      label: d.targetName
        ? `之前派去${d.targetName}的那批（${d.id}，${away.length} 个）`
        : `之前派出去的那批（${d.id}，${away.length} 个）`,
      unitIds: away.map((u) => u.id),
    });
  }

  return candidates.length >= 2 ? candidates : null;
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
