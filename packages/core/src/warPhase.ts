// ============================================================
// AI Commander — War Phase & Game-Over (Day 12)
// Phase transitions: PEACE → CONFLICT → WAR → ENDGAME
// Game-over conditions: HQ destroyed, logistics collapse, ENDGAME timeout
// ============================================================

import type { GameState, Team, DiagnosticEntry } from "@ai-commander/shared";
import { ENDGAME_TIME_SEC } from "@ai-commander/shared";

// ── Constants ──

const PEACE_MIN_SEC = 120;
const WAR_ENGAGE_THRESHOLD = 0.6;
const WAR_ENGAGE_SUSTAIN_SEC = 30;
const ENDGAME_START_SEC = ENDGAME_TIME_SEC; // 900
const ENDGAME_MAX_SEC = 300;
const LOGISTICS_ZERO_SEC = 60;

const ENDGAME_INCOME_MULT = 0.7;

// Per-front engagement timers (module-level, reset on new game via resetWarPhaseTimers)
const frontEngageTimers = new Map<string, number>();

/** Reset module-level timers — call on new game session. */
export function resetWarPhaseTimers(): void {
  frontEngageTimers.clear();
}

// ── Phase transitions ──

export function updateGamePhase(state: GameState, dt: number): void {
  if (state.gameOver) return;

  switch (state.phase) {
    case "PEACE":
      tryPeaceToConflict(state);
      break;
    case "CONFLICT":
      tryConflictToWar(state, dt);
      break;
    case "WAR":
      // WAR → ENDGAME handled by time check below
      break;
    case "ENDGAME":
      // Already in endgame, no further phase transition
      break;
  }

  // Any phase → ENDGAME when time threshold reached
  if (state.phase !== "ENDGAME" && state.time >= ENDGAME_START_SEC) {
    transitionTo(state, "ENDGAME");
    state.endgameStartTime = state.time;
  }
}

function tryPeaceToConflict(state: GameState): void {
  if (state.time < PEACE_MIN_SEC) return;

  // Gate: readiness met OR any front has engagement
  const readinessGate = state.economy.player.readiness >= 0.3;
  const engagementSignal = state.fronts.some((f) => f.engagementIntensity > 0);

  if (readinessGate || engagementSignal) {
    transitionTo(state, "CONFLICT");
  }
}

function tryConflictToWar(state: GameState, dt: number): void {
  // Path 1: manual declaration
  if (state.warDeclared) {
    transitionTo(state, "WAR");
    return;
  }

  // Path 2: sustained high engagement — per-front continuous tracking
  // Spec: "any front.engagementIntensity >= threshold continuously for 30s"
  let triggered = false;
  for (const front of state.fronts) {
    if (front.engagementIntensity >= WAR_ENGAGE_THRESHOLD) {
      const prev = frontEngageTimers.get(front.id) ?? 0;
      const next = prev + dt;
      frontEngageTimers.set(front.id, next);
      if (next >= WAR_ENGAGE_SUSTAIN_SEC) {
        triggered = true;
      }
    } else {
      // This specific front dropped below threshold — reset its counter
      frontEngageTimers.set(front.id, 0);
    }
  }

  // Mirror best per-front value into state for digest/debug visibility
  state.warEngageSec = Math.max(0, ...Array.from(frontEngageTimers.values()));

  if (triggered) {
    state.warDeclared = true;
    transitionTo(state, "WAR");
  }
}

function transitionTo(state: GameState, newPhase: GameState["phase"]): void {
  const oldPhase = state.phase;
  state.phase = newPhase;
  state.phaseStartTime = state.time;

  const phaseNames: Record<string, string> = {
    PEACE: "和平",
    CONFLICT: "冲突",
    WAR: "战争",
    ENDGAME: "终局",
  };
  state.diagnostics.push({
    time: state.time,
    code: "PHASE_CHANGE",
    message: `阶段转变: ${phaseNames[oldPhase]} → ${phaseNames[newPhase]}`,
  });
}

// ── Game-over checks (symmetric) ──

export function checkGameOver(state: GameState, dt: number): void {
  if (state.gameOver) return;

  // El Alamein: All capture objectives taken → victory
  if (state.captureObjectives && state.captureObjectives.length > 0) {
    const allCaptured = state.captureObjectives.every(objId => {
      const fac = state.facilities.get(objId);
      return fac && fac.team === "player";
    });
    if (allCaptured) {
      endGame(state, "player", "所有据点已夺取 — 阿拉曼大捷！");
      return;
    }
  }

  // El Alamein: 20-minute timeout → defeat
  if (state.scenarioId === "el_alamein" && state.time >= 1200) {
    endGame(state, "enemy", "超时未能夺取全部据点 — 进攻失败");
    return;
  }

  // MVP2 Rule 1: Commander killed → defeat
  let commanderAlive = false;
  state.units.forEach((u) => {
    if (u.type === "commander" && u.team === "player" && u.state !== "dead" && u.hp > 0) {
      commanderAlive = true;
    }
  });
  // Only check after game has started (time > 1s to avoid false trigger before units spawn)
  if (!commanderAlive && state.time > 1) {
    endGame(state, "enemy", "司令阵亡");
    return;
  }

  // MVP2 Rule 2: Player HQ destroyed → defeat
  const playerHQ = findHQ(state, "player");
  if (playerHQ && playerHQ.hp <= 0) {
    endGame(state, "enemy", "我方总部被摧毁");
    return;
  }

  // MVP2 Rule 3: Enemy HQ destroyed → victory
  const enemyHQ = findHQ(state, "enemy");
  if (enemyHQ && enemyHQ.hp <= 0) {
    endGame(state, "player", "敌方总部已被摧毁");
    return;
  }

  // Fallback: ENDGAME timeout → forced game-over by score
  if (state.phase === "ENDGAME" && state.endgameStartTime !== null) {
    const endgameElapsed = state.time - state.endgameStartTime;
    if (endgameElapsed >= ENDGAME_MAX_SEC) {
      const winner = evaluateScore(state);
      endGame(state, winner, `终局超时 — 按综合战力评定${winner === "player" ? "我方" : "敌方"}获胜`);
    }
  }
}

function findHQ(state: GameState, team: Team) {
  for (const [, f] of state.facilities) {
    if (f.type === "headquarters" && f.team === team) return f;
  }
  return null;
}

function evaluateScore(state: GameState): Team {
  // Simple score: sum of unit HP + HQ HP
  let playerScore = 0;
  let enemyScore = 0;

  state.units.forEach((u) => {
    if (u.state === "dead") return;
    if (u.team === "player") playerScore += u.hp;
    else if (u.team === "enemy") enemyScore += u.hp;
  });

  const playerHQ = findHQ(state, "player");
  const enemyHQ = findHQ(state, "enemy");
  if (playerHQ) playerScore += playerHQ.hp;
  if (enemyHQ) enemyScore += enemyHQ.hp;

  return playerScore >= enemyScore ? "player" : "enemy";
}

function endGame(state: GameState, winner: Team, reason: string): void {
  state.gameOver = true;
  state.winner = winner;
  state.gameOverReason = reason;

  state.diagnostics.push({
    time: state.time,
    code: "GAME_OVER",
    message: `游戏结束: ${reason} — ${winner === "player" ? "我方胜利" : "敌方胜利"}`,
  });
}

// ── ENDGAME pressure ──

export function applyEndgamePressure(state: GameState, dt: number): void {
  if (state.gameOver) return;
  if (state.phase !== "ENDGAME") return;

  // Reduce effective income for both sides
  for (const team of ["player", "enemy"] as const) {
    const eco = state.economy[team];
    eco.resources.money = Math.max(0, eco.resources.money - eco.baseIncome.money * (1 - ENDGAME_INCOME_MULT) * (dt / 30));
    eco.resources.fuel = Math.max(0, eco.resources.fuel - eco.baseIncome.fuel * (1 - ENDGAME_INCOME_MULT) * (dt / 30));
    eco.resources.ammo = Math.max(0, eco.resources.ammo - eco.baseIncome.ammo * (1 - ENDGAME_INCOME_MULT) * (dt / 30));
  }

  // Attrition removed: units don't lose HP from thin air during endgame.
  // Endgame pressure comes from resource income reduction + timeout forced scoring.
}
