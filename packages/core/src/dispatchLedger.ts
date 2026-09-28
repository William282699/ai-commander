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

/** 按号找一条记录（在役或已结束都算）——只给来源继承用，**不给选兵用**。 */
function findDispatchById(state: GameState, id: string): Dispatch | undefined {
  const key = id.trim().toLowerCase();
  return state.dispatches.find((d) => d.id.toLowerCase() === key);
}

/**
 * 刀寅：这一批里某个成员**记下的**出发战线。
 * `undefined`＝这条记录里没有这人的来源事实（旧形状的记录）；`null`＝记过，且当时不在任何战线上。
 * 旧形状只认 `sourceKind === "front"` 那一种（当时的选兵本来就是"站在那条线上的人"）。
 */
function recordedOriginOf(state: GameState, d: Dispatch, unitId: number): string | null | undefined {
  const map = d.originFrontById;
  if (map && Object.prototype.hasOwnProperty.call(map, unitId)) return map[unitId] ?? null;
  if (d.sourceKind === "front") return resolver ? resolver.frontIdOf(state, d.sourceKey) : d.sourceKey;
  return undefined;
}

/** 这个单位此刻站在哪条战线上（与「还守在那条线上的」同一份几何）。 */
function currentFrontOf(state: GameState, unitId: number): string | null {
  const u = state.units.get(unitId);
  if (!u || !resolver) return null;
  return resolver.frontIdOfUnit(state, u);
}

/**
 * 出发时就近我方据点的半径——与板子给群起名「X附近」用的是同一个尺度
 * （frontEscalationPayload.NAME_RADIUS_TILES = 12；台架钉住两者相等，防漂）。
 */
export const ORIGIN_FACILITY_RADIUS = 12;

function tileDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 出发位置附近最近的**我方、还在的**据点 id；够不着就没有。 */
function friendlyFacilityNear(state: GameState, p: { x: number; y: number }): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const f of state.facilities.values()) {
    if (f.team !== "player" || f.hp <= 0) continue;
    const d = tileDist(f.position, p);
    if (d <= ORIGIN_FACILITY_RADIUS && (!best || d < best.d)) best = { id: f.id, d };
  }
  return best?.id;
}

/**
 * 刀寅：这个单位**这次外派**的出发地（台账里含它的那条在役任务记下的）。
 * 没有 ⇒ null（不在任何在役任务里、或那条记录没有出发位置）——调用方必须如实处理，
 * 不许拿「安全区」顶上。
 */
export function originOfUnit(
  state: GameState,
  unitId: number,
): { pos: { x: number; y: number }; facilityId?: string; dispatchId: string } | null {
  for (const d of state.dispatches) {
    if (d.status !== "active" || !d.memberIds.includes(unitId)) continue;
    const pos = d.originPosById?.[unitId];
    if (!pos) return null;
    return { pos: { ...pos }, facilityId: d.originFacilityById?.[unitId], dispatchId: d.id };
  }
  return null;
}

/** 刀寅：这批人现在还活着、能调的那些，按**出发战线**分组（null＝战线外）。 */
export function liveMembersByOrigin(state: GameState, d: Dispatch): Map<string | null, Unit[]> {
  const out = new Map<string | null, Unit[]>();
  for (const u of liveDispatchMembers(state, d)) {
    const o = recordedOriginOf(state, d, u.id) ?? null;
    const arr = out.get(o) ?? [];
    arr.push(u);
    out.set(o, arr);
  }
  return out;
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
  /** 刀寅：接到这道令之前每个人是否还在路上（applyOrders 下令前取的）。缺席＝都不在路上。 */
  enRouteBefore?: ReadonlyMap<number, boolean>,
): Dispatch | null {
  if (appliedUnitIds.length === 0) return null;

  // ⓪ 刀寅：来源事实，必须在摘除**之前**取（摘了就查不到这人原来属于哪批）。
  //   **同一次外派**（起点延续）＝「回原处」的令，或者这个人接到新令时**还在路上**。
  //   与长官用任务号、分队名还是别的说法指人无关（审核复现：按分队名连叫两次，第二次
  //   回到了半路——旧规则只认任务号）。到达之后再接到别的令，才从到达处重新起算；
  //   不用「离起点几格」判结束（刚出发就改令，起点会一点点挪走）。
  //   ★ 不看 intent 上写了什么战线、不看群名文本、不看票的目标战线。
  const prior = meta.sourceKind === "dispatch" ? findDispatchById(state, meta.sourceKey) : undefined;
  const originFrontById: Record<number, string | null> = {};
  const originPosById: Record<number, { x: number; y: number }> = {};
  const originFacilityById: Record<number, string> = {};
  for (const id of appliedUnitIds) {
    const u = state.units.get(id);
    const here = u ? { x: u.position.x, y: u.position.y } : null;
    const holder = state.dispatches.find((d) => d.status === "active" && d.memberIds.includes(id));
    const holderPos = holder?.originPosById?.[id];
    const continuing = !!holder && (meta.returnTo === "origin" || enRouteBefore?.get(id) === true);
    // 「从哪条战线派出去的」是**身份**事实（「北线派出去的那批」靠它认人）：同一次外派延续，
    //   或者按这批人的任务号改令（批次谱系），都继承；位置起点只跟外派走（下面）。
    const lineage = continuing ? holder : (prior && prior.memberIds.includes(id) ? prior : undefined);
    const inherited = lineage ? recordedOriginOf(state, lineage, id) : undefined;
    originFrontById[id] = inherited !== undefined ? inherited : currentFrontOf(state, id);
    if (continuing && holderPos) {
      originPosById[id] = { ...holderPos };
      const fac = holder!.originFacilityById?.[id];
      if (fac) originFacilityById[id] = fac;
    } else if (here) {
      originPosById[id] = here;
      const fac = friendlyFacilityNear(state, here);
      if (fac) originFacilityById[id] = fac;
    }
  }
  const ticketRef = meta.sourceKind === "ticket"
    ? (meta.sourceKey.trim().toUpperCase() || undefined)
    : prior?.ticketRef;

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
    originFrontById,
    originPosById,
    ...(meta.returnTo === "origin" ? { recall: true } : {}),
    ...(Object.keys(originFacilityById).length > 0 ? { originFacilityById } : {}),
    ...(ticketRef ? { ticketRef } : {}),
    ...(meta.sourceKind === "ticket" && meta.ticketLabel ? { ticketLabel: meta.ticketLabel }
      : prior?.ticketLabel && ticketRef === prior.ticketRef ? { ticketLabel: prior.ticketLabel } : {}),
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
  // ★刀寅：按**逐人记下的出发战线**认，不按"当时那条命令是怎么指的兵"认。
  //   过去只认 `sourceKind === "front"`——于是凭临时编队号派出去的（记成 pool）、
  //   以及对那批人改过一次令的（记成 dispatch:M1），都从"从这条线派出去的"里
  //   消失了：北线派走的坦克不再算北线的，撤回一次之后南线那批也不再算南线的。
  //   多来源的一批只算**从这条线出发的那几个**，不把别处来的人一起带上。
  const frontId = resolver ? resolver.frontIdOf(state, front) : front;
  for (const d of activeDispatches(state)) {
    const live = liveDispatchMembers(state, d);
    const fromHere = live.filter((u) => {
      const o = recordedOriginOf(state, d, u.id);
      return o != null && (frontId !== null ? o === frontId : sameFrontKey(state, o, front));
    });
    const away = fromHere.filter((u) => !onFront.some((o) => o.id === u.id));
    if (away.length === 0) continue;
    candidates.push({
      kind: "dispatch",
      key: d.id,
      selectionKey: selectionKeyOf("dispatch", d.id),
      label: dispatchCandidateLabel(d, away.length),
      unitIds: away.map((u) => u.id),
    });
  }

  return candidates;
}

/** 给长官听的那一句：它现在在干什么、多少人（号只给模型抄，屏上照印无妨）。 */
function dispatchCandidateLabel(d: Dispatch, n: number): string {
  if (!d.targetName) return `之前派出去的那批（${d.id}，${n} 个）`;
  return d.action === "retreat"
    ? `之前撤往${d.targetName}的那批（${d.id}，${n} 个）`
    : `之前派去${d.targetName}的那批（${d.id}，${n} 个）`;
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
  /** 刀寅：这个单位此刻站在哪条战线上（与 unitsOnFront 同一份几何）；不在任何线上 ⇒ null。 */
  frontIdOfUnit: (state: GameState, unit: Unit) => string | null;
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

/**
 * 刀寅：信封里 `from=` 那一栏——**出发战线的事实**，逐人记的那份。
 * 多条线来的就都写出来（带人数），不硬塞成一个；当时不在任何线上的写「战线外」。
 * 没有来源事实的旧记录才退回原来的写法（战线名 / 来源字段原文）。
 */
function dispatchFromText(state: GameState, d: Dispatch): string {
  const groups = liveMembersByOrigin(state, d);
  const known = [...groups.entries()].filter(([, us]) => us.some((u) => recordedOriginOf(state, d, u.id) !== undefined));
  if (known.length === 0) {
    const legacy = d.sourceKind === "front" ? frontDisplayName(state, d.sourceKey) : d.sourceKey;
    return legacy || "未指明";
  }
  const name = (o: string | null) => (o === null ? "战线外" : frontDisplayName(state, o));
  if (known.length === 1) return name(known[0][0]);
  return known.map(([o, us]) => `${name(o)}×${us.length}`).join("+");
}

/**
 * 刀寅：信封里 `home=` 那一栏——这批人这次外派的出发地。给模型看的是「有没有记下」
 * 以及能叫得出的据点名；坐标不进信封（回原处由引擎按台账取，不让模型抄坐标）。
 */
function homeText(state: GameState, d: Dispatch): string {
  const live = liveDispatchMembers(state, d);
  if (live.length === 0 || !d.originPosById) return "";
  const withPos = live.filter((u) => d.originPosById![u.id]);
  if (withPos.length === 0) return "";
  const facs = new Set(withPos.map((u) => d.originFacilityById?.[u.id] ?? ""));
  if (facs.size === 1) {
    const only = [...facs][0];
    const fac = only ? state.facilities.get(only) : undefined;
    return fac ? ` home=${fac.name}附近` : " home=已记下出发位置";
  }
  return " home=各自出发的位置";
}

// ── 信封：在役任务列给模型看 ──
//
// ★ 这是最容易漏的一环：号不进信封，模型永远不会填 `fromDispatch`，
//   前面所有工作对玩家都不可见。
//
// shared 不许 import core（既有契约），所以行在这里算好，由 buildDigest
// 当预算好的字符串递进去——与 board / judgment 两节同一条路。
export function buildDispatchDigestLines(
  state: GameState,
  /** 刀寅：用过的票 → 原群剩下那些人此刻的新号（由 intelDigest 注入；台账模块不直接碰票据表）。 */
  remainderHandleOf?: (gNumber: string) => string | null,
): string[] {
  const rows = activeDispatches(state);
  if (rows.length === 0) return [];
  const MAX = 8;
  const lines: string[] = [];
  for (const d of rows.slice(0, MAX)) {
    const to = d.targetName || "未指明";
    // 刀寅：via=G# ——这批人是凭哪张临时编队票派出去的。长官之后再说那个号，
    //   指的就是**这一批真走了的人**，不是票上原报的那份候选。
    // 刀寅：via 带上那张票当时的叫法——回执说的是「中央前哨附近未编组群里的 2 个已经出发」，
    //   长官之后说「刚才那两个」，模型要能把这句对到这一条（而不是同名的、剩下那几个的新号）。
    const rest = d.ticketRef && remainderHandleOf ? remainderHandleOf(d.ticketRef) : null;
    const via = d.ticketRef
      ? ` via=${d.ticketRef}${d.ticketLabel ? `「${d.ticketLabel}」里派出的` : ""}${rest ? `（那一群留下没派的现在是 ${rest}，不是这一批）` : ""}`
      : "";
    lines.push(`${d.id} from=${dispatchFromText(state, d)} to=${to} act=${d.action} left=${liveDispatchMembers(state, d).length}${via}${homeText(state, d)}`);
  }
  if (rows.length > MAX) lines.push(`...+${rows.length - MAX} more`);
  return lines;
}
