// ============================================================
// 战场轻量快照：只读、有界。**我方**全部单位（含没被调动的，才能验证“其他人没动”）、
// 资源、据点、任务台账摘要。不存地形、不存整份 GameState、不存敌军（全知信息不冒充玩家所见）。
//
// 单位一行是一个定长数组（省字节）：
//   [id, 类型, x, y, 血量百分比, 状态, 当前命令动作|null, 目标x|null, 目标y|null, 手动接管0/1]
// ============================================================

import type { GameState } from "@ai-commander/shared";
import { REC_SNAPSHOT_UNITS_MAX } from "@ai-commander/shared/src/recorderProtocol";

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface SnapshotExtras {
  viewport?: unknown;
  selectedUnitIds?: number[];
}

export function buildSnapshot(state: GameState, reason: string, extras: SnapshotExtras = {}): Record<string, unknown> {
  const units: unknown[][] = [];
  let playerTotal = 0;
  for (const u of state.units.values()) {
    if (u.team !== "player") continue;
    playerTotal++;
    if (units.length >= REC_SNAPSHOT_UNITS_MAX) continue;
    const o = u.orders?.[0];
    const t = o?.target ?? u.target ?? null;
    units.push([
      u.id, u.type, r1(u.position.x), r1(u.position.y),
      u.maxHp > 0 ? Math.round((u.hp / u.maxHp) * 100) : 0,
      u.state, o?.action ?? null, t ? r1(t.x) : null, t ? r1(t.y) : null, u.manualOverride ? 1 : 0,
    ]);
  }
  const res = state.economy.player.resources;
  const fac: unknown[][] = [];
  for (const f of state.facilities.values()) {
    if (fac.length >= 120) break;
    fac.push([f.id, f.team, f.maxHp > 0 ? Math.round((f.hp / f.maxHp) * 100) : 0, r1(f.captureProgress ?? 0), f.capturingTeam ?? null]);
  }
  const dispatches = (state.dispatches ?? []).slice(-30).map((d) => {
    const x = d as unknown as Record<string, unknown>;
    return { id: x.id, action: x.action, status: x.status, targetName: x.targetName, memberIds: Array.isArray(x.memberIds) ? (x.memberIds as unknown[]).slice(0, 100) : undefined };
  });
  return {
    reason,
    t: r1(state.time),
    phase: state.phase,
    gameOver: state.gameOver || undefined,
    units,
    unitsTotal: playerTotal,
    omitted: playerTotal > units.length ? playerTotal - units.length : undefined,
    res: { money: Math.round(res.money), fuel: r1(res.fuel), ammo: r1(res.ammo), intel: r1(res.intel) },
    queue: state.productionQueue?.player?.length ?? 0,
    fac,
    dispatches,
    view: extras.viewport ?? undefined,
    selected: extras.selectedUnitIds && extras.selectedUnitIds.length ? extras.selectedUnitIds.slice(0, 200) : undefined,
  };
}
