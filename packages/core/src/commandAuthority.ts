// ============================================================
// AI Commander — Command authority (手测账③, 2026-08-02)
//
// 现场：玩家对 Emily（后勤）说「Drake，派你的两个 light tank 去占领沿海雷达
// 站」，Emily 照办了 —— Drake 挂在 Chen 名下，Emily 名下是空的。
//
// 归属事实早就在信封里（digest.ts 按 ownerCommander 分组渲染 SQUADS，Emily
// 看得见 Drake 属于 Chen、自己名下为空）。缺的不是数据，是「这件事有约束力」。
//
// ★ 规则按人格算，不按点名算（Fable 裁定 2026-08-02 的补全）：
//   只闸「点名的队」堵不住同族的另一半 —— Emily 不点名、直接说「派两个坦克去
//   占雷达」，Bucket A 照样从全局池抓兵（74 单位洞的 Emily 变体）。所以调度类
//   intent 的可用池 = 本人格麾下，与说没说出番号无关。
//
// 未编组单位的调度权归 **combat 角色**（COMMANDER_CHANNEL 查表），不是硬编码
// 的 "chen" —— 把战斗角色改派给别人，规则跟着走。
//
// 生产 / 交易不受影响：那是 Emily 的本职，与兵权无关。
// ============================================================

import type { GameState, CommanderKey, IntentType, Intent } from "@ai-commander/shared";
import { COMMANDER_CHANNEL, isDispatchablePlayerUnit } from "@ai-commander/shared";
import { collectUnitsUnder } from "@ai-commander/shared";

/** Intent types that move troops. Everything NOT here is economy (produce/trade). */
const ECONOMY_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>(["produce", "trade"]);

/** True when this intent would put units under orders. */
export function isDispatchIntent(type: IntentType): boolean {
  return !ECONOMY_INTENTS.has(type);
}

/** The commander who holds the combat role — default owner of unassigned units. */
export function combatRoleHolder(): CommanderKey {
  const found = (Object.keys(COMMANDER_CHANNEL) as CommanderKey[])
    .find((k) => COMMANDER_CHANNEL[k] === "combat");
  // COMMANDER_CHANNEL is exhaustive over CommanderKey; the fallback keeps this
  // total without asserting a specific name.
  return found ?? (Object.keys(COMMANDER_CHANNEL) as CommanderKey[])[0];
}

/**
 * Every unit this persona may lawfully put under orders:
 *   squads whose ownerCommander is this persona (including their sub-squads),
 *   plus — for the combat-role holder only — the unassigned dispatchable units.
 *
 * Empty pool ⇒ this persona commands nothing and may not dispatch at all.
 */
export function commanderDispatchPool(state: GameState, persona: CommanderKey): number[] {
  const pool = new Set<number>();
  for (const sq of state.squads ?? []) {
    if (sq.ownerCommander !== persona) continue;
    for (const id of collectUnitsUnder(state, sq.id)) pool.add(id);
  }
  if (persona === combatRoleHolder()) {
    const assigned = new Set<number>();
    for (const sq of state.squads ?? []) for (const id of sq.unitIds) assigned.add(id);
    state.units.forEach((u) => {
      if (u.team !== "player" || u.hp <= 0 || u.state === "dead") return;
      if (assigned.has(u.id)) return;
      if (!isDispatchablePlayerUnit(u)) return;
      pool.add(u.id);
    });
  }
  // Alive + dispatchable only — a pool full of corpses is not authority.
  return Array.from(pool).filter((id) => {
    const u = state.units.get(id);
    return !!u && u.hp > 0 && u.state !== "dead" && isDispatchablePlayerUnit(u);
  });
}

export type AuthorityVerdict =
  /** Not a troop movement (produce/trade) — authority does not apply. */
  | { kind: "not_dispatch" }
  /** This persona may proceed; pool is what they command. */
  | { kind: "allowed"; pool: number[] }
  /** Zero execution. `reason` is the STRUCTURAL fact for the voice to speak from. */
  | { kind: "denied"; reason: "commands_no_forces" | "squad_not_theirs"; ownerOfNamed?: CommanderKey };

/**
 * The one authority check. Structural only — it decides IF, never what to say.
 * The refusal is voiced by the persona from the fact carried in `reason`
 * (家法：台词禁死模板 — the engine never writes a line three personas recite).
 */
export function checkDispatchAuthority(
  state: GameState,
  persona: CommanderKey,
  intent: Intent,
): AuthorityVerdict {
  if (!isDispatchIntent(intent.type)) return { kind: "not_dispatch" };

  const pool = commanderDispatchPool(state, persona);
  if (pool.length === 0) return { kind: "denied", reason: "commands_no_forces" };

  // A named squad must be inside this persona's own command tree. Ticket refs
  // (G-numbers) are NOT squad names and are judged by the ticket layer — this
  // check only looks at squad id / leaderName.
  if (intent.fromSquad) {
    const fs = intent.fromSquad.toLowerCase();
    const named = (state.squads ?? []).find(
      (s) => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs,
    );
    if (named && named.ownerCommander !== persona) {
      return { kind: "denied", reason: "squad_not_theirs", ownerOfNamed: named.ownerCommander };
    }
  }
  return { kind: "allowed", pool };
}
