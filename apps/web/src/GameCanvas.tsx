import { useRef, useEffect, useCallback, useState } from "react";
import {
  renderTerrain,
  renderMinimap,
  renderFacilities,
  renderFrontLabels,
  renderRouteLabels,
  renderRegionLabels,
  renderUnits,
  renderFog,
  renderCombatEffects,
  drawBattleMarkers,
  renderSelectionBox,
  renderInfoPanel,
  renderTags,
  type Camera,
  type SelectedSquadInfo,
} from "./rendererCanvas";
import {
  createInputState,
  setupInputListeners,
  processKeyboardCamera,
  centerCameraOn,
  screenToTile,
  isBoxSelection,
} from "./input";
import { FRONT_CAMERA_TARGETS, EL_ALAMEIN_CAMERA_TARGETS } from "@ai-commander/shared";
import { createInitialGameState } from "@ai-commander/core";
import {
  tick,
  updateFog,
  applyPlayerCommands,
  releaseManualOverride,
  processEnemyAI,
  processAutoBehavior,
  processEconomy,
  processMissions,
  updateGamePhase,
  checkGameOver,
  applyEndgamePressure,
  resetEnemyAITimer,
  resetEnemyProdToggle,
  resetAttackWaveState,
  resetAutoBehaviorTimer,
  resetWarPhaseTimers,
  processReportSignals,
  drainReportEvents,
  resetReportSignals,
  buildDigest,
  checkDoctrines,
  cancelDoctrine,
  findBestReinforcements,
  generateCrisisCard,
  updateTasks,
  updateBattleMarkers,
  processAdvisorTriggers,
  processDefensiveAI,
  resetDefensiveAITimer,
} from "@ai-commander/core";
import type { AdvisorTriggerResult } from "@ai-commander/core";
import type { Unit, Order, GameState, Facility, Tag, Channel, ReportEventType, TaskPriority, CrisisEvent } from "@ai-commander/shared";
import { TILE_SIZE } from "@ai-commander/shared";
import { createSquad, pickLeaderName, getUsedLeaderNames, moveSquadUnder, removeSquadFromParent, dissolveSquad, transferSquadToCommander } from "@ai-commander/shared";
import { ChatPanel } from "./ChatPanel";
import { TaskBar } from "./TaskBar";
import * as messageStoreModule from "./messageStore";
import { preloadSprites, spriteCount } from "./rendering/spriteLoader";
import {
  addMessage,
  clearMessages,
  clearThreads,
  createThread,
  expireStaleThreads,
  getLastMessageTimeBySource,
  type MessageLevel,
} from "./messageStore";

// ── Day 16B: event → channel routing ──

const EVENT_CHANNEL_MAP: Record<ReportEventType, Channel> = {
  UNDER_ATTACK: "combat",
  SUPPLY_LOW: "logistics",
  FACILITY_CAPTURED: "ops",
  FACILITY_LOST: "ops",
  MISSION_DONE: "ops",
  MISSION_FAILED: "ops",
  HQ_DAMAGED: "combat",
  SQUAD_HEAVY_LOSS: "combat",
  POSITION_CRITICAL: "combat",
  MISSION_STALLED: "ops",
  ECONOMY_SURPLUS: "logistics",
  ECONOMY_REPORT: "logistics",
};

// ── Phase 3: Feature flags ──
const ENABLE_STAFF_ASK = true;
const ENABLE_STAFF_THREADS = true;

// ── Phase 3: Staff-ask concurrency control ──
interface PendingStaffAsk {
  topicKey: string;
  eventType: ReportEventType;
  eventMessage: string;
}

const staffAskState = {
  inFlight: { ops: false, logistics: false, combat: false } as Record<Channel, boolean>,
  topicCooldown: new Map<string, number>(), // topicKey → game time of last trigger
  // Keep only the latest actionRequired event per channel; dispatch when channel is free and cooldown allows.
  pendingByChannel: { ops: null, logistics: null, combat: null } as Record<Channel, PendingStaffAsk | null>,
  session: 0, // incremented on restart to discard stale responses
};
const STAFF_ASK_TOPIC_COOLDOWN_SEC = 30;

function resetStaffAskState(): void {
  for (const ch of ["ops", "logistics", "combat"] as Channel[]) {
    staffAskState.inFlight[ch] = false;
    staffAskState.pendingByChannel[ch] = null;
  }
  staffAskState.topicCooldown.clear();
  staffAskState.session++;
}

// ── Diagnostic → Staff Feed bridge ──

// ── Day 16B: Heartbeat state ──

const COMBAT_HEARTBEAT_INTERVAL_SEC = 20;
const PEACE_HEARTBEAT_INTERVAL_SEC = 40;
const COMBAT_WINDOW_SEC = 25;
const API_URL = "http://localhost:3001";

const heartbeatState = {
  lastTime: { ops: 0, logistics: 0, combat: 0 } as Record<Channel, number>,
  inFlight: { ops: false, logistics: false, combat: false } as Record<Channel, boolean>,
  session: 0, // incremented on restart; stale async responses compare against this
  lastPeacePulse: 0,
  combatWindowUntil: 0,
};

function resetHeartbeatState(): void {
  for (const ch of ["ops", "logistics", "combat"] as Channel[]) {
    heartbeatState.lastTime[ch] = 0;
    heartbeatState.inFlight[ch] = false;
  }
  heartbeatState.session++;
  heartbeatState.lastPeacePulse = 0;
  heartbeatState.combatWindowUntil = 0;
}

/** Diagnostic codes suppressed from Staff Feed (still logged to state.diagnostics).
 *
 * PATH_BLOCKED and NO_FUEL are intentionally NOT suppressed — when a player
 * squad silently halts mid-march, the player has no way to tell whether it's
 * a fuel issue, a pathfinding failure, or a combat engagement. Both codes
 * already have a 30s dedup at source (DIAG_LOW_VALUE_DEDUP_SEC in sim.ts),
 * so they won't flood the feed.
 */
const SUPPRESSED_DIAG_CODES = new Set([
  "IMPASSABLE_TERRAIN",
  // El Alamein defensive-AI debug diagnostics — useful in dev tooling, too noisy for the feed.
  "DEFAI_ROLES",
  "DEFAI_DBG",
]);

/** Map diagnostic code → feed message level */
const DIAG_LEVEL: Record<string, MessageLevel> = {
  NO_FUEL: "warning",
  PATH_BLOCKED: "warning",
  PRODUCE_FAIL: "warning",
  TRADE_FAIL: "warning",
  NO_VISIBLE_TARGET: "warning",
  NO_AVAILABLE_UNITS: "warning",
  IMPASSABLE_TARGET: "warning",
  UNSUPPORTED_INTENT: "warning",
  DEGRADED_TARGET: "info",
  PATROL_SUMMARY: "info",
};

/** Distance threshold for single-click unit selection (in tiles) */
const CLICK_SELECT_RADIUS = 1.5;

/** Find all player units within a screen-space bounding box */
function findUnitsInBox(
  state: GameState,
  camera: Camera,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number[] {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);

  const ids: number[] = [];
  state.units.forEach((unit) => {
    if (unit.team !== "player" || unit.state === "dead") return;

    const screenX =
      (unit.position.x * TILE_SIZE - camera.x) * camera.zoom +
      (TILE_SIZE * camera.zoom) / 2;
    const screenY =
      (unit.position.y * TILE_SIZE - camera.y) * camera.zoom +
      (TILE_SIZE * camera.zoom) / 2;

    if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) {
      ids.push(unit.id);
    }
  });

  return ids;
}

/** Find the closest player unit to a screen position (for single click) */
function findUnitAtClick(
  state: GameState,
  camera: Camera,
  screenX: number,
  screenY: number,
): number | null {
  let closestId: number | null = null;
  let closestDist = Infinity;

  const clickTile = screenToTile(screenX, screenY, camera);

  state.units.forEach((unit) => {
    if (unit.team !== "player" || unit.state === "dead") return;

    const dx = unit.position.x - clickTile.tileX;
    const dy = unit.position.y - clickTile.tileY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < CLICK_SELECT_RADIUS && dist < closestDist) {
      closestDist = dist;
      closestId = unit.id;
    }
  });

  return closestId;
}

/** Find the closest visible enemy unit near a world position (for right-click attack) */
function findEnemyAtPosition(
  state: GameState,
  worldTileX: number,
  worldTileY: number,
): Unit | null {
  let closest: Unit | null = null;
  let closestDist = Infinity;
  const attackClickRadius = 1.5; // tiles

  state.units.forEach((unit) => {
    if (unit.team !== "enemy" || unit.state === "dead") return;

    // Must be visible
    const tx = Math.floor(unit.position.x);
    const ty = Math.floor(unit.position.y);
    if (tx < 0 || ty < 0 || tx >= state.mapWidth || ty >= state.mapHeight) return;
    if (state.fog[ty]?.[tx] !== "visible") return;

    const dx = unit.position.x - worldTileX;
    const dy = unit.position.y - worldTileY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < attackClickRadius && dist < closestDist) {
      closestDist = dist;
      closest = unit;
    }
  });

  return closest;
}

/** Day 13: Find a non-player facility near the clicked tile position. */
function findFacilityAtPosition(
  state: GameState,
  worldTileX: number,
  worldTileY: number,
): Facility | null {
  let closest: Facility | null = null;
  let closestDist = Infinity;
  const clickRadius = 2.0; // tiles

  state.facilities.forEach((fac) => {
    // Only show menu for non-player facilities (enemy or neutral)
    if (fac.team === "player") return;
    if (fac.hp <= 0) return;

    // Must be visible on the fog
    const tx = Math.floor(fac.position.x);
    const ty = Math.floor(fac.position.y);
    if (tx < 0 || ty < 0 || tx >= state.mapWidth || ty >= state.mapHeight) return;
    if (state.fog[ty]?.[tx] !== "visible") return;

    const dx = fac.position.x - worldTileX;
    const dy = fac.position.y - worldTileY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < clickRadius && dist < closestDist) {
      closestDist = dist;
      closest = fac;
    }
  });

  return closest;
}

/** Non-capturable facility types (same as economy.ts) */
const NON_CAPTURABLE_TYPES = new Set([
  "headquarters", "barracks", "shipyard", "airfield", "defense_tower",
]);

// ── Split-screen bridge: expose ChatPanel props on window for pop-out panel ──
export interface GameBridge {
  getState: () => GameState | null;
  getSelectedUnitIds: () => number[];
  onCreateSquad: (owner: "chen" | "marcus" | "emily") => void;
  canCreateSquad: () => boolean;
  onDeclareWar: () => void;
  onSelectUnits: (unitIds: number[]) => void;
  onMoveSquad: (squadId: string, newParentId: string) => void;
  onRemoveFromParent: (squadId: string) => void;
  onRenameLeader: (squadId: string, newName: string) => void;
  onTransferSquad: (squadId: string, newOwner: "chen" | "marcus" | "emily") => void;
  // Shared messageStore (so detached panel sees same threads/messages as main window)
  messageStore: typeof import("./messageStore");
}

declare global {
  interface Window {
    __GAME_BRIDGE__?: GameBridge;
    __PANEL_DETACHED__?: boolean;
  }
}

interface GameCanvasProps {
  onStateReady?: (getter: () => GameState | null) => void;
  panelDetached?: boolean;
}

export function GameCanvas({ onStateReady, panelDetached }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState | null>(null);
  const inputRef = useRef(createInputState());

  // Day 12: game-over overlay state
  const [gameOverInfo, setGameOverInfo] = useState<{
    winner: string;
    reason: string;
    time: number;
    playerUnits: number;
    enemyUnits: number;
    isVictory: boolean;
  } | null>(null);
  const gameOverDetectedRef = useRef(false); // loop-safe flag (avoids stale closure on gameOverInfo)

  // Day 13: facility context menu state
  const [facilityMenu, setFacilityMenu] = useState<{
    facility: Facility;
    screenX: number;
    screenY: number;
    canCapture: boolean;
  } | null>(null);

  // Preload sprite atlas PNGs once on mount. The renderer silently falls back
  // to a procedural placeholder for any bitmap that hasn't finished loading,
  // so the game can start immediately and sprites pop in as they arrive.
  useEffect(() => {
    preloadSprites().then(() => {
      console.log(`[sprites] loaded ${spriteCount()} bitmaps`);
    });
  }, []);

  // Day 15: poll tag mode from input ref for React-driven banner
  const [isTagMode, setIsTagMode] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setIsTagMode(inputRef.current.tagMode), 100);
    return () => clearInterval(id);
  }, []);

  // Day 15: Tag naming dialog state
  const [tagNaming, setTagNaming] = useState<{ worldX: number; worldY: number } | null>(null);
  const [tagNameInput, setTagNameInput] = useState("");

  // Day 15: Tag right-click context menu
  const [tagMenu, setTagMenu] = useState<{
    tag: Tag;
    screenX: number;
    screenY: number;
  } | null>(null);
  const [tagRenaming, setTagRenaming] = useState<{ tag: Tag } | null>(null);
  const [tagRenameInput, setTagRenameInput] = useState("");

  // Prompt 3: Task bar state — snapshot tasks for React rendering
  const [taskSnapshot, setTaskSnapshot] = useState<GameState["tasks"]>([]);
  const taskHashRef = useRef("");
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current;
      if (!s) return;
      const hash = JSON.stringify(s.tasks);
      if (hash !== taskHashRef.current) {
        taskHashRef.current = hash;
        setTaskSnapshot([...s.tasks]);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const handleTaskCancel = useCallback((taskId: string) => {
    const state = stateRef.current;
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || task.status === "completed" || task.status === "cancelled") return;

    task.status = "cancelled";
    task.statusChangedAt = state.time;

    // Cancel associated doctrine
    if (task.doctrineId) {
      const result = cancelDoctrine(state, task.doctrineId);
      if (result.cancelled) {
        addMessage("info", `${result.locationTag} 的 ${result.type} 命令已取消，部队恢复自由调度。`, state.time, result.channel, undefined, "command_ack");
      }
    }

    // Clear squad missions
    for (const sqId of task.assignedSquads) {
      const sq = state.squads.find(s => s.id === sqId);
      if (sq) {
        sq.currentMission = null;
        sq.missionTarget = null;
      }
    }

    addMessage("info", `任务已取消: ${task.title}`, state.time, task.commander, undefined, "command_ack");
    setTaskSnapshot([...state.tasks]);
  }, []);

  const handleTaskPriority = useCallback((taskId: string, priority: TaskPriority) => {
    const state = stateRef.current;
    if (!state) return;
    const task = state.tasks.find(t => t.id === taskId);
    if (task) {
      task.priority = priority;
      setTaskSnapshot([...state.tasks]);
    }
  }, []);

  // Debug: Shift+D to simulate a doctrine breach (for testing crisis response cards)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "D" || !e.shiftKey) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;

      const state = stateRef.current;
      if (!state) return;
      const activeDoctrine = state.doctrines.find(d => d.status === "active");
      if (!activeDoctrine) {
        addMessage("warning", "[DEBUG] 无活跃 doctrine，无法模拟 breach", state.time, "ops", undefined, "system");
        return;
      }
      const crisis: CrisisEvent = {
        type: "DOCTRINE_BREACH",
        severity: "critical",
        doctrineId: activeDoctrine.id,
        locationTag: activeDoctrine.locationTag,
        message: `[DEBUG] 模拟 breach @ ${activeDoctrine.locationTag}`,
        time: state.time,
      };
      const channel = activeDoctrine.commander ?? "ops";
      addMessage("urgent", crisis.message, state.time, channel, undefined, "event_report");
      const candidates = findBestReinforcements(state, crisis, activeDoctrine);
      const crisisOptions = generateCrisisCard(state, crisis, candidates, activeDoctrine);
      createThread(
        `DOCTRINE_BREACH:${activeDoctrine.id}:debug`,
        "DOCTRINE_BREACH",
        channel,
        crisis.message,
        crisis.message,
        crisisOptions,
        state.time,
      );
      addMessage("info", `[DEBUG] Crisis card 已生成 (${crisisOptions.length} 选项, ${candidates.length} 候选增援)`, state.time, "ops", undefined, "system");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Stable callback: returns current box-selected unit IDs
  const getSelectedUnitIds = useCallback((): number[] => {
    return inputRef.current.selectedUnitIds;
  }, []);

  // Stable callback: check if selected units can form a squad
  // Phase 2.5: allow already-squadded units (they will be extracted)
  const canCreateSquad = useCallback((): boolean => {
    const state = stateRef.current;
    if (!state) return false;
    const ids = inputRef.current.selectedUnitIds;
    if (ids.length === 0) return false;
    return ids.some((id) => {
      const u = state.units.get(id);
      return u && u.team === "player" && u.state !== "dead";
    });
  }, []);

  // Stable callback: create a squad from selected units
  // Phase 2.5: allows extracting units from existing squads (dissolves empty squads)
  const handleCreateSquad = useCallback((owner: "chen" | "marcus" | "emily") => {
    const state = stateRef.current;
    if (!state) return;
    const ids = inputRef.current.selectedUnitIds;
    if (ids.length === 0) return;

    // Filter: player + alive
    const validIds = ids.filter((id) => {
      const u = state.units.get(id);
      return u && u.team === "player" && u.state !== "dead";
    });
    if (validIds.length === 0) {
      addMessage("warning", "选中的单位不可用", state.time, "ops", "player", "player");
      return;
    }

    // Phase 2.5: Remove these units from any existing squads
    const validIdSet = new Set(validIds);
    const affectedSquads = new Set<string>();
    for (const sq of state.squads) {
      const before = sq.unitIds.length;
      sq.unitIds = sq.unitIds.filter((id) => !validIdSet.has(id));
      if (sq.unitIds.length !== before) {
        affectedSquads.add(sq.id);
      }
    }

    // Dissolve squads that became empty (leader role with 0 units)
    for (const sqId of affectedSquads) {
      const sq = state.squads.find((s) => s.id === sqId);
      if (sq && sq.role === "leader" && sq.unitIds.length === 0) {
        dissolveSquad(state, sqId);
      }
    }

    // MVP2: Filter out elite units (commander/elite_guard are mouse-only, not assignable to squads)
    const squadIds = validIds.filter((id) => {
      const u = state.units.get(id);
      return u && !u.isPlayerControlled;
    });
    if (squadIds.length === 0) {
      addMessage("info", "精英部队不可编入分队，请用鼠标直接操控", state.time, "ops", "system", "system");
      return;
    }
    const unitTypes = squadIds
      .map((id) => state.units.get(id)!)
      .map((u) => u.type);
    const usedNames = getUsedLeaderNames(state.squads);
    const leaderName = pickLeaderName(usedNames);
    const squad = createSquad(squadIds, unitTypes, state.nextSquadNum, owner, leaderName);
    state.squads.push(squad);
    addMessage("info", `新建分队 ${squad.id}:${squad.name} (${squadIds.length}人) → ${owner}`, state.time, "ops", "player", "player");
  }, []);

  // Phase 2: OrgTree callbacks
  const handleSelectUnits = useCallback((unitIds: number[]) => {
    const input = inputRef.current;
    input.selectedUnitIds = unitIds;
  }, []);

  const handleMoveSquad = useCallback((squadId: string, newParentId: string) => {
    const state = stateRef.current;
    if (!state) return;
    const result = moveSquadUnder(state, squadId, newParentId);
    if (!result.ok) {
      addMessage("warning", `编制移动失败: ${result.error}`, state.time, "ops", "player", "player");
    } else if (result.promoted) {
      addMessage("info", `${newParentId} 已晋升为指挥官`, state.time, "ops", "player", "player");
    }
  }, []);

  const handleRemoveFromParent = useCallback((squadId: string) => {
    const state = stateRef.current;
    if (!state) return;
    removeSquadFromParent(state, squadId);
  }, []);

  const handleTransferSquad = useCallback((squadId: string, newOwner: "chen" | "marcus" | "emily") => {
    const state = stateRef.current;
    if (!state) return;
    const result = transferSquadToCommander(state, squadId, newOwner);
    if (!result.ok) {
      addMessage("warning", `调拨失败: ${result.error}`, state.time, "ops", "player", "player");
    } else {
      addMessage("info", `${squadId} 已调拨至 ${newOwner}`, state.time, "ops", "player", "player");
    }
  }, []);

  const handleRenameLeader = useCallback((squadId: string, newName: string) => {
    const state = stateRef.current;
    if (!state) return;
    const squad = state.squads.find((s) => s.id === squadId);
    if (squad) squad.leaderName = newName;
  }, []);

  // Day 12: war declaration callback
  const handleDeclareWar = useCallback(() => {
    const state = stateRef.current;
    if (!state || state.phase !== "CONFLICT" || state.warDeclared) return;
    state.warDeclared = true;
    addMessage("urgent", "宣战！进入全面战争状态", state.time, "ops", "player", "player");
  }, []);

  // ── Split-screen: expose bridge on window for pop-out panel ──
  useEffect(() => {
    window.__GAME_BRIDGE__ = {
      getState: () => stateRef.current,
      getSelectedUnitIds,
      onCreateSquad: handleCreateSquad,
      canCreateSquad,
      onDeclareWar: handleDeclareWar,
      onSelectUnits: handleSelectUnits,
      onMoveSquad: handleMoveSquad,
      onRemoveFromParent: handleRemoveFromParent,
      onRenameLeader: handleRenameLeader,
      onTransferSquad: handleTransferSquad,
      messageStore: messageStoreModule,
    };
    return () => { delete window.__GAME_BRIDGE__; };
  }, [getSelectedUnitIds, handleCreateSquad, canCreateSquad, handleDeclareWar, handleSelectUnits, handleMoveSquad, handleRemoveFromParent, handleRenameLeader, handleTransferSquad]);

  // Day 12: restart callback
  // Day 13: Facility context menu action handlers
  const handleFacilityCapture = useCallback(() => {
    const state = stateRef.current;
    const input = inputRef.current;
    const menu = facilityMenu;
    if (!state || !menu || input.selectedUnitIds.length === 0) return;

    // Move selected units to the facility position (proximity capture is automatic)
    const order: Order = {
      unitIds: [...input.selectedUnitIds],
      action: "attack_move",
      target: { x: menu.facility.position.x, y: menu.facility.position.y },
      priority: "high",
    };
    applyPlayerCommands(state, [order]);
    addMessage("info", `派遣单位占领 ${menu.facility.name}`, state.time, "ops", "player", "player");
    setFacilityMenu(null);
  }, [facilityMenu]);

  const handleFacilitySabotage = useCallback(() => {
    const state = stateRef.current;
    const input = inputRef.current;
    const menu = facilityMenu;
    if (!state || !menu || input.selectedUnitIds.length === 0) return;

    // Issue sabotage order with targetFacilityId
    const order: Order = {
      unitIds: [...input.selectedUnitIds],
      action: "sabotage",
      target: { x: menu.facility.position.x, y: menu.facility.position.y },
      targetFacilityId: menu.facility.id,
      priority: "high",
    };
    applyPlayerCommands(state, [order]);
    addMessage("info", `派遣单位破坏 ${menu.facility.name}`, state.time, "ops", "player", "player");
    setFacilityMenu(null);
  }, [facilityMenu]);

  const handleRestart = useCallback(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const scenarioParam = urlParams.get("scenario");
    const sid = scenarioParam === "el_alamein" ? "el_alamein" as const : "dual_island" as const;
    const newState = createInitialGameState(sid);
    stateRef.current = newState;
    gameOverDetectedRef.current = false;
    setGameOverInfo(null);
    // Recompute fog for the fresh state so enemies are visible on first frame
    updateFog(newState);
    const urlParams2 = new URLSearchParams(window.location.search);
    if (urlParams2.get("nofog") === "1") {
      for (const row of newState.fog) {
        for (let i = 0; i < row.length; i++) row[i] = "visible";
      }
    }
    // Reset module-level timers so new session starts clean
    resetEnemyAITimer();
    resetEnemyProdToggle();
    resetAttackWaveState();
    resetAutoBehaviorTimer();
    resetWarPhaseTimers();
    resetReportSignals();
    resetDefensiveAITimer();
    resetHeartbeatState();
    resetStaffAskState();
    clearMessages();
    clearThreads();
    addMessage("info", "等待指令...", 0, "ops", "system", "system");
    onStateReady?.(() => stateRef.current);
  }, [onStateReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas to fill container
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    // Create game state — read scenario from URL param (?scenario=el_alamein)
    const urlParams = new URLSearchParams(window.location.search);
    const scenarioParam = urlParams.get("scenario");
    const scenarioId = scenarioParam === "el_alamein" ? "el_alamein" as const : "dual_island" as const;
    const noFog = urlParams.get("nofog") === "1";
    const initialState = createInitialGameState(scenarioId);
    stateRef.current = initialState;

    // P3: reset module-level timers for clean start (handles StrictMode / HMR)
    resetEnemyAITimer();
    resetEnemyProdToggle();
    resetAttackWaveState();
    resetAutoBehaviorTimer();
    resetWarPhaseTimers();
    resetReportSignals();
    resetDefensiveAITimer();
    resetHeartbeatState();
    resetStaffAskState();

    // Expose state getter to parent (for top bar etc)
    onStateReady?.(() => stateRef.current);

    // Camera: center on player HQ
    const camera: Camera = { x: 0, y: 0, zoom: 1.0 };
    const hqCenter = scenarioId === "el_alamein" ? { x: 430, y: 90 } : { x: 100, y: 7 };
    centerCameraOn(camera, hqCenter.x, hqCenter.y, canvas.width, canvas.height, initialState.mapWidth, initialState.mapHeight);

    // Input — use ref so it's accessible outside useEffect
    const input = inputRef.current;
    input.mapWidth = initialState.mapWidth;
    input.mapHeight = initialState.mapHeight;
    const cleanup = setupInputListeners(canvas, camera, input);

    // Fronts array (ordered 1-5 for hotkey mapping) — `let` so restart can refresh
    let frontIds = initialState.fronts.map((f) => f.id);
    // Select camera targets by scenario (no merge — keys like front_center overlap)
    const cameraTargets = scenarioId === "el_alamein"
      ? EL_ALAMEIN_CAMERA_TARGETS
      : FRONT_CAMERA_TARGETS;

    // Compute initial fog so first frame shows visibility
    updateFog(initialState);
    // Debug: reveal all fog when ?nofog=1
    if (noFog) {
      for (const row of initialState.fog) {
        for (let i = 0; i < row.length; i++) row[i] = "visible";
      }
    }

    // Track "Return to AI" button rect for click detection
    let returnToAIBtnRect: { x: number; y: number; w: number; h: number } | null = null;

    // Diagnostic drain cursor (time-based to survive array shifts)
    let lastDrainedDiagTime = -Infinity;

    // Track current state object so the loop can detect restart (ref swap)
    let currentLoopState: GameState = initialState;

    // Game loop
    let lastTime = performance.now();
    let animId = 0;

    const loop = (now: number) => {
      // P1 fix: read state from ref each frame so handleRestart takes effect
      const state = stateRef.current;
      if (!state) { animId = requestAnimationFrame(loop); return; }

      // Detect state swap (restart) — reset loop-local bookkeeping
      if (state !== currentLoopState) {
        currentLoopState = state;
        lastDrainedDiagTime = -Infinity;
        frontIds = state.fronts.map((f) => f.id);
        input.selectedUnitIds = [];
        if (!noFog) updateFog(state);
      }

      const dt = Math.min((now - lastTime) / 1000, 0.05); // cap dt
      lastTime = now;

      // Process front jump hotkeys (1-5)
      if (input.frontJumpRequest !== null) {
        const idx = input.frontJumpRequest - 1;
        if (idx >= 0 && idx < frontIds.length) {
          const target = cameraTargets[frontIds[idx]];
          if (target) {
            centerCameraOn(
              camera,
              target.x,
              target.y,
              canvas.width,
              canvas.height,
              input.mapWidth,
              input.mapHeight,
            );
          }
        }
        input.frontJumpRequest = null;
      }

      // Process keyboard + edge scrolling
      processKeyboardCamera(input, camera, dt, canvas.width, canvas.height);

      // ── Day 5: Process selection complete ──
      if (input.selectionComplete) {
        input.selectionComplete = false;

        if (isBoxSelection(input)) {
          // Box selection: find all player units inside the box
          const ids = findUnitsInBox(
            state,
            camera,
            input.selectionStartScreenX,
            input.selectionStartScreenY,
            input.selectionEndScreenX,
            input.selectionEndScreenY,
          );
          input.selectedUnitIds = ids;
        } else {
          // Single click: check if clicked on "Return to AI" button first
          const clickX = input.selectionEndScreenX;
          const clickY = input.selectionEndScreenY;

          if (
            returnToAIBtnRect &&
            clickX >= returnToAIBtnRect.x &&
            clickX <= returnToAIBtnRect.x + returnToAIBtnRect.w &&
            clickY >= returnToAIBtnRect.y &&
            clickY <= returnToAIBtnRect.y + returnToAIBtnRect.h
          ) {
            // Clicked "Return to AI" button
            releaseManualOverride(state, input.selectedUnitIds);
            input.selectedUnitIds = [];
          } else {
            // Single click: select one unit
            const unitId = findUnitAtClick(state, camera, clickX, clickY);
            if (unitId !== null) {
              input.selectedUnitIds = [unitId];
            } else {
              // Clicked empty ground — deselect
              input.selectedUnitIds = [];
            }
          }
        }
      }

      // ── Day 5: ESC / Return to AI ──
      if (input.escPressed) {
        input.escPressed = false;
        if (input.selectedUnitIds.length > 0) {
          // Release manual override on all selected units
          releaseManualOverride(state, input.selectedUnitIds);
          input.selectedUnitIds = [];
        }
      }

      if (input.returnToAIPressed) {
        input.returnToAIPressed = false;
        releaseManualOverride(state, input.selectedUnitIds);
        input.selectedUnitIds = [];
      }

      // ── Day 15: Pending tag → open naming dialog ──
      if (input.pendingTag) {
        setTagNaming({ worldX: input.pendingTag.worldX, worldY: input.pendingTag.worldY });
        setTagNameInput("");
        input.pendingTag = null;
      }

      // ── Day 5: Right-click command ──
      if (input.rightClickCommand) {
        const cmd = input.rightClickCommand;
        input.rightClickCommand = null;

        // Close any open menus on new right-click
        setFacilityMenu(null);
        setTagMenu(null);

        // Day 15: Check if right-clicking on a tag → show tag context menu
        const TAG_HIT_RADIUS = 1.5;
        let tagHit: Tag | null = null;
        for (const t of state.tags) {
          const dx = t.position.x - cmd.worldX;
          const dy = t.position.y - cmd.worldY;
          if (Math.sqrt(dx * dx + dy * dy) < TAG_HIT_RADIUS) {
            tagHit = t;
            break;
          }
        }
        if (tagHit) {
          const screenX = (tagHit.position.x * TILE_SIZE - camera.x) * camera.zoom;
          const screenY = (tagHit.position.y * TILE_SIZE - camera.y) * camera.zoom;
          setTagMenu({ tag: tagHit, screenX: Math.round(screenX), screenY: Math.round(screenY) });
        } else if (input.selectedUnitIds.length > 0) {
          // MVP2: Filter to only controllable units (isPlayerControlled=true)
          const controllableIds = input.selectedUnitIds.filter((id) => {
            const u = state.units.get(id);
            return u && u.isPlayerControlled;
          });

          if (controllableIds.length === 0 && input.selectedUnitIds.length > 0) {
            // All selected units are non-controllable — show voice hint
            state.diagnostics.push({
              time: state.time,
              code: "VOICE_HINT",
              message: "请用语音指挥这些部队",
            });
          } else if (controllableIds.length > 0) {
            // Check if clicking on an enemy unit (highest priority)
            const enemyTarget = findEnemyAtPosition(state, cmd.worldX, cmd.worldY);

            if (controllableIds.length < input.selectedUnitIds.length) {
              // Mixed selection — notify about non-controllable units
              state.diagnostics.push({
                time: state.time,
                code: "VOICE_HINT",
                message: "部分部队需要语音指挥",
              });
            }

            if (enemyTarget) {
              // Attack order
              const order: Order = {
                unitIds: [...controllableIds],
                action: "attack_move",
                target: { x: enemyTarget.position.x, y: enemyTarget.position.y },
                targetUnitId: enemyTarget.id,
                priority: "high",
              };
              applyPlayerCommands(state, [order]);
            } else {
              // Day 13: Check if clicking on a facility → show context menu
              const facTarget = findFacilityAtPosition(state, cmd.worldX, cmd.worldY);
              if (facTarget) {
                const screenX = (facTarget.position.x * TILE_SIZE - camera.x) * camera.zoom;
                const screenY = (facTarget.position.y * TILE_SIZE - camera.y) * camera.zoom;
                const canCapture = !NON_CAPTURABLE_TYPES.has(facTarget.type);
                setFacilityMenu({
                  facility: facTarget,
                  screenX: Math.round(screenX),
                  screenY: Math.round(screenY),
                  canCapture,
                });
              } else {
                // Move order (no enemy unit, no facility)
                const order: Order = {
                  unitIds: [...controllableIds],
                  action: "attack_move",
                  target: { x: cmd.worldX, y: cmd.worldY },
                  priority: "medium",
                };
                applyPlayerCommands(state, [order]);
              }
            }
          }
        }
      }

      // --- Simulation ---
      tick(state, dt);

      // --- Economy (Day 9) ---
      processEconomy(state, dt);         // income, capture, production, readiness

      // --- Event Detection (Day 16A) ---
      processReportSignals(state, dt);

      // --- Battle Awareness (Prompt 5) ---
      updateBattleMarkers(state, dt);

      // --- Advisor Triggers (Prompt 6) ---
      // Track which topics got a rule-based crisis card this tick,
      // so the staff-ask LLM path skips them (avoids duplicate cards).
      const crisisCardTopics = new Set<string>();
      const advisorTriggers = processAdvisorTriggers(state);
      for (const trig of advisorTriggers) {
        if (trig.type === "crisis_card") {
          // Build synthetic doctrine + crisis for generateCrisisCard reuse
          const locationTag = trig.event.type === "FACILITY_LOST" && trig.event.entityId
            ? (state.facilities.get(trig.event.entityId)?.regionId ?? trig.event.entityId)
            : (trig.event.entityId ?? "unknown");
          // Synthetic doctrine — assignedSquads unused; crisisResponse.ts
          // scans the battlefield directly via scanBattlefield().
          const syntheticDoctrine = {
            id: `advisor_trig_${Date.now()}`,
            type: "must_hold" as const,
            commander: trig.channel,
            locationTag,
            priority: "high" as const,
            allowAutoReinforce: true,
            assignedSquads: [] as string[],
            createdAt: state.time,
            status: "active" as const,
          };
          const syntheticCrisis = {
            type: "DOCTRINE_BREACH" as const,
            severity: "critical" as const,
            doctrineId: syntheticDoctrine.id,
            locationTag,
            message: trig.event.message,
            time: state.time,
          };
          const candidates = findBestReinforcements(state, syntheticCrisis, syntheticDoctrine);
          const crisisOptions = generateCrisisCard(state, syntheticCrisis, candidates, syntheticDoctrine);
          if (crisisOptions.length > 0) {
            const threadKey = `ADVISOR_CRISIS:${trig.event.type}:${trig.event.entityId ?? "global"}`;
            createThread(
              threadKey,
              trig.event.type,
              trig.channel,
              trig.event.message,
              trig.event.message,
              crisisOptions,
              state.time,
            );
            // Mark this topic so staff-ask LLM path won't create a duplicate card
            crisisCardTopics.add(`${trig.event.type}:${trig.event.entityId ?? "global"}`);
          }
        } else if (trig.type === "llm_advice") {
          // Fire-and-forget /api/brief call
          const digest = buildDigest(state, [], [], []);
          const evtInfo = `[${trig.event.type}] ${trig.event.message}`;
          const capturedTime = state.time;
          const ch = trig.channel;
          fetch(`${API_URL}/api/brief`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ digest: `${evtInfo}\n\n${digest}`, channel: ch }),
          })
            .then((r) => r.json())
            .then((data) => {
              if (data?.brief) {
                addMessage("info", data.brief, capturedTime, ch, undefined, "event_report");
              }
            })
            .catch(() => {}); // advisor trigger brief failure is silent
        }
      }

      // --- Doctrine Checks ---
      const crises = checkDoctrines(state);
      for (const crisis of crises) {
        const level: MessageLevel = crisis.severity === "critical" ? "urgent" : "warning";
        const doctrine = state.doctrines.find(d => d.id === crisis.doctrineId);
        const channel = doctrine?.commander ?? "ops";
        addMessage(level, crisis.message, crisis.time, channel, undefined, "event_report");

        // DOCTRINE_BREACH: generate zero-delay crisis card + thread
        if (crisis.type === "DOCTRINE_BREACH" && doctrine && doctrine.status === "active") {
          const candidates = findBestReinforcements(state, crisis, doctrine);
          const crisisOptions = generateCrisisCard(state, crisis, candidates, doctrine);
          createThread(
            `DOCTRINE_BREACH:${crisis.doctrineId}`,
            "DOCTRINE_BREACH",
            channel,
            crisis.message,
            crisis.message,
            crisisOptions,
            state.time,
          );
          // Mark so staff-ask LLM path won't duplicate
          crisisCardTopics.add(`UNDER_ATTACK:${crisis.locationTag}`);
        }
      }

      // --- War Phase & Game-Over (Day 12) ---
      updateGamePhase(state, dt);        // PEACE→CONFLICT→WAR→ENDGAME transitions
      checkGameOver(state, dt);          // HQ destroyed / logistics collapse / timeout

      // --- Missions (Day 11) --- (guards: if gameOver return)
      processMissions(state, dt);        // mission progress, success/fail, squad linkage

      // --- Task Tracker (Prompt 3) ---
      updateTasks(state);

      // --- AI & Auto-Behavior (Day 8) --- (guards: if gameOver return)
      processEnemyAI(state, dt);        // enemy strategic decisions (5s interval)
      processDefensiveAI(state, dt);    // El Alamein defensive AI (5s interval, no-op for other scenarios)
      processAutoBehavior(state, dt);    // both teams micro-behavior (2s interval)

      // --- ENDGAME Pressure (Day 12) ---
      applyEndgamePressure(state, dt);   // resource drain + attrition in ENDGAME

      // Day 12: detect game-over and set React state for overlay
      // Uses ref instead of closure-captured gameOverInfo to avoid stale-closure re-render storm
      if (state.gameOver && !gameOverDetectedRef.current) {
        gameOverDetectedRef.current = true;
        // Count surviving units for stats
        let playerAlive = 0;
        let enemyAlive = 0;
        state.units.forEach((u) => {
          if (u.state === "dead" || u.hp <= 0) return;
          if (u.team === "player") playerAlive++;
          else if (u.team === "enemy") enemyAlive++;
        });
        const isVictory = state.winner === "player";
        setGameOverInfo({
          winner: isVictory ? "VICTORY" : "DEFEAT",
          reason: state.gameOverReason ?? "未知原因",
          time: state.time,
          playerUnits: playerAlive,
          enemyUnits: enemyAlive,
          isVictory,
        });
      }

      if (!noFog) updateFog(state);

      // --- Drain diagnostics → Staff Feed (≈1/sec) ---
      if (state.tick % 60 === 0 && state.diagnostics.length > 0) {
        for (const d of state.diagnostics) {
          if (d.time > lastDrainedDiagTime) {
            if (SUPPRESSED_DIAG_CODES.has(d.code)) continue; // Day 9.5: suppress spam
            const lvl = DIAG_LEVEL[d.code] ?? "warning";
            addMessage(lvl, d.message, d.time, "ops", undefined, "system");
          }
        }
        lastDrainedDiagTime =
          state.diagnostics[state.diagnostics.length - 1].time;
      }

      // --- Drain report events → Staff Feed (Day 16A+B) + Phase 3 staff-ask ---
      const tryStartStaffAsk = (
        evt: { type: ReportEventType; message: string; entityId?: string },
        channel: Channel,
        nowSec: number,
        topicKey?: string,
      ): boolean => {
        if (!ENABLE_STAFF_ASK) return false;
        if (staffAskState.inFlight[channel]) return false;

        const key = topicKey ?? `${evt.type}:${evt.entityId ?? "global"}`;
        const lastTrigger = staffAskState.topicCooldown.get(key) ?? -Infinity;
        if (nowSec - lastTrigger < STAFF_ASK_TOPIC_COOLDOWN_SEC) return false;

        staffAskState.topicCooldown.set(key, nowSec);
        staffAskState.inFlight[channel] = true;

        const digest = buildDigest(state, [], [], []);
        const capturedTime = nowSec;
        const reqSession = staffAskState.session;
        fetch(`${API_URL}/api/staff-ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            digest,
            eventType: evt.type,
            eventMessage: evt.message,
            channel,
          }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (reqSession !== staffAskState.session) return; // stale
            if (!ENABLE_STAFF_THREADS) return;
            if (data?.brief) {
              addMessage("info", data.brief, capturedTime, channel, undefined, "event_report");
            }
            if (data?.options && Array.isArray(data.options) && data.options.length > 0) {
              createThread(
                key,
                evt.type,
                channel,
                data.brief || evt.message,
                evt.message,
                data.options,
                capturedTime,
              );
            }
          })
          .catch(() => {
            // staff-ask failure is silent (event message already shown)
          })
          .finally(() => {
            if (reqSession !== staffAskState.session) return;
            staffAskState.inFlight[channel] = false;
          });

        return true;
      };

      const reportEvts = drainReportEvents(state, 5);
      for (const evt of reportEvts) {
        const channel = EVENT_CHANNEL_MAP[evt.type] || "ops";
        const level: MessageLevel =
          evt.severity === "critical" ? "urgent" : evt.severity === "warning" ? "warning" : "info";

        // Throttle: suppress ECONOMY_REPORT if logistics heartbeat message arrived < 30s ago
        if (evt.type === "ECONOMY_REPORT") {
          const lastHb = getLastMessageTimeBySource("logistics", "heartbeat");
          if (lastHb !== null && state.time - lastHb < 30) continue;
        }

        // Phase 3: actionRequired events should always surface and eventually produce a decision thread.
        // Skip staff-ask if a rule-based crisis card was already generated for this topic
        // (avoids duplicate English LLM card + Chinese rule card for the same event).
        if (ENABLE_STAFF_ASK && evt.actionRequired) {
          const topicKey = `${evt.type}:${evt.entityId ?? "global"}`;
          addMessage(level, evt.message, state.time, channel, undefined, "event_report");

          if (crisisCardTopics.has(topicKey)) continue; // rule-based card already covers this

          const started = tryStartStaffAsk(
            { type: evt.type, message: evt.message, entityId: evt.entityId },
            channel,
            state.time,
            topicKey,
          );
          if (started) {
            // New ask started for this channel; stale pending payload is no longer useful.
            staffAskState.pendingByChannel[channel] = null;
          } else {
            // Channel busy or topic in cooldown → queue latest actionRequired event for retry.
            staffAskState.pendingByChannel[channel] = {
              topicKey,
              eventType: evt.type,
              eventMessage: evt.message,
            };
          }
        } else {
          // Regular report-only message
          addMessage(level, evt.message, state.time, channel, undefined, "event_report");
        }
      }

      // Phase 3: retry one pending actionRequired event per channel once inFlight/cooldown constraints clear.
      if (ENABLE_STAFF_ASK) {
        for (const ch of ["ops", "logistics", "combat"] as Channel[]) {
          const pending = staffAskState.pendingByChannel[ch];
          if (!pending) continue;
          const started = tryStartStaffAsk(
            { type: pending.eventType, message: pending.eventMessage },
            ch,
            state.time,
            pending.topicKey,
          );
          if (started) {
            staffAskState.pendingByChannel[ch] = null;
          }
        }
      }

      // Phase 3: expire stale threads
      if (ENABLE_STAFF_THREADS) {
        expireStaleThreads(state.time);
      }

      // --- Combat window detection (uses drain'd reportEvts, before heartbeat) ---
      {
        const hasCombatSignal =
          reportEvts.some(e =>
            e.type === "UNDER_ATTACK" || e.type === "HQ_DAMAGED" || e.type === "POSITION_CRITICAL"
          ) ||
          state.battleMarkers.some(m => m.type === "attack_zone");
        if (hasCombatSignal) {
          heartbeatState.combatWindowUntil = state.time + COMBAT_WINDOW_SEC;
        }
      }
      const inCombat = state.time <= heartbeatState.combatWindowUntil;

      // --- Heartbeat LLM brief (async, non-blocking) ---
      if (!state.gameOver) {
        const channels = ["ops", "logistics", "combat"] as Channel[];
        const heartbeatInterval = inCombat ? COMBAT_HEARTBEAT_INTERVAL_SEC : PEACE_HEARTBEAT_INTERVAL_SEC;

        const sendHeartbeat = (ch: Channel) => {
          heartbeatState.lastTime[ch] = state.time;
          heartbeatState.inFlight[ch] = true;
          const digest = buildDigest(state, [], [], []);
          const reqSession = heartbeatState.session;
          fetch(`${API_URL}/api/brief`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ digest, channel: ch }),
          })
            .then((r) => r.json())
            .then((data) => {
              if (reqSession !== heartbeatState.session) return;
              if (data?.brief) {
                addMessage("info", data.brief, state.time, ch, undefined, "heartbeat");
              }
            })
            .catch(() => {})
            .finally(() => {
              if (reqSession !== heartbeatState.session) return;
              heartbeatState.inFlight[ch] = false;
            });
        };

        if (inCombat) {
          // Combat mode: all channels independently, 20s interval
          for (const ch of channels) {
            if (
              state.time - heartbeatState.lastTime[ch] > heartbeatInterval &&
              !heartbeatState.inFlight[ch]
            ) {
              sendHeartbeat(ch);
            }
          }
        } else {
          // Peace mode: one random channel every 40s
          if (state.time - heartbeatState.lastPeacePulse > heartbeatInterval) {
            const available = channels.filter(ch => !heartbeatState.inFlight[ch]);
            if (available.length > 0) {
              const ch = available[Math.floor(Math.random() * available.length)];
              heartbeatState.lastPeacePulse = state.time;
              sendHeartbeat(ch);
            }
          }
        }
      }

      // --- Rendering ---
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 1. Terrain tiles
      renderTerrain(ctx, state.terrain, camera, canvas.width, canvas.height);

      // 2. Facilities on map
      const facArray = Array.from(state.facilities.values());
      renderFacilities(ctx, facArray, camera);

      // 3. Fog of war overlay (darkens unseen areas)
      if (!noFog) {
        renderFog(ctx, state.fog, camera, canvas.width, canvas.height);
      }

      // 3.5 Day 15: Tags (player map markers) — rendered AFTER fog so tags are visible on fogged areas
      renderTags(ctx, state.tags, camera, input.tagMode, input.mouseX, input.mouseY);

      // 4. Units (enemy only visible in lit fog)
      const unitArray = Array.from(state.units.values());
      const selectedSet = new Set(input.selectedUnitIds);
      renderUnits(
        ctx,
        unitArray,
        state.fog,
        camera,
        canvas.width,
        canvas.height,
        state.time,
        selectedSet,
      );

      // 5. Combat effects (attack lines + explosions) — drawn above units
      renderCombatEffects(ctx, state.combatEffects, camera, state.fog, state.time);

      // 5.5 Battle markers (attack zones, death marks, critical fronts)
      drawBattleMarkers(ctx, state.battleMarkers, camera, state.fog, state.time);

      // 6. Selection box (while dragging)
      if (input.isSelecting) {
        renderSelectionBox(
          ctx,
          input.selectionStartScreenX,
          input.selectionStartScreenY,
          input.selectionEndScreenX,
          input.selectionEndScreenY,
        );
      }

      // 7. Front labels (when zoomed out)
      renderFrontLabels(ctx, state.fronts, cameraTargets, camera);

      // 7.5 Route labels + region labels (on terrain, zoomed out)
      if (state.namedRoutes.length > 0) {
        renderRouteLabels(ctx, state.namedRoutes, camera);
      }
      const regions = state.regions ? Array.from(state.regions.values()) : [];
      if (regions.length > 0) {
        renderRegionLabels(ctx, regions, camera);
      }

      // 8. Minimap (bottom-right, with facility + unit dots)
      renderMinimap(
        ctx,
        state.terrain,
        camera,
        canvas.width,
        canvas.height,
        facArray,
        unitArray,
        state.fog,
        state.mapWidth,
        state.mapHeight,
      );

      // 9. Info panel (bottom-left, when units selected)
      const selectedUnits = input.selectedUnitIds
        .map((id) => state.units.get(id))
        .filter((u): u is Unit => u !== undefined && u.state !== "dead");

      // Clean up dead units from selection
      if (selectedUnits.length !== input.selectedUnitIds.length) {
        input.selectedUnitIds = selectedUnits.map((u) => u.id);
      }

      // Build unitId → squadId mapping for selected units
      const unitToSquad = new Map<number, string>();
      for (const sq of state.squads) {
        for (const uid of sq.unitIds) unitToSquad.set(uid, sq.id);
      }
      const squadCounts = new Map<string, number>();
      for (const u of selectedUnits) {
        const sqId = unitToSquad.get(u.id);
        if (sqId) squadCounts.set(sqId, (squadCounts.get(sqId) ?? 0) + 1);
      }
      const selectedSquads: SelectedSquadInfo[] = Array.from(squadCounts.entries())
        .map(([squadId, count]) => ({ squadId, count }))
        .sort((a, b) => b.count - a.count);

      const panelResult = renderInfoPanel(
        ctx,
        selectedUnits,
        canvas.width,
        canvas.height,
        selectedSquads,
      );
      returnToAIBtnRect = panelResult.returnToAIBtnRect;

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
      cleanup();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      <TaskBar
        tasks={taskSnapshot}
        onChangePriority={handleTaskPriority}
        onCancel={handleTaskCancel}
      />
      {!panelDetached && (
        <ChatPanel
          getState={() => stateRef.current}
          getSelectedUnitIds={getSelectedUnitIds}
          onCreateSquad={handleCreateSquad}
          canCreateSquad={canCreateSquad}
          onDeclareWar={handleDeclareWar}
          onSelectUnits={handleSelectUnits}
          onMoveSquad={handleMoveSquad}
          onRemoveFromParent={handleRemoveFromParent}
          onRenameLeader={handleRenameLeader}
          onTransferSquad={handleTransferSquad}
        />
      )}
      {/* Day 13: Facility context menu */}
      {facilityMenu && (
        <div
          className="hud-context-menu"
          style={{
            position: "absolute",
            left: facilityMenu.screenX + 10,
            top: facilityMenu.screenY - 10,
          }}
        >
          <div className="hud-context-menu__title">
            {facilityMenu.facility.name}
          </div>
          {facilityMenu.canCapture && (
            <button onClick={handleFacilityCapture} className="hud-context-menu__item">
              占领
            </button>
          )}
          <button onClick={handleFacilitySabotage} className="hud-context-menu__item">
            破坏
          </button>
          <button
            onClick={() => setFacilityMenu(null)}
            className="hud-context-menu__item"
            style={{ color: "var(--hud-text-dim)" }}
          >
            取消
          </button>
        </div>
      )}
      {/* Day 15: Tag naming dialog */}
      {tagNaming && (
        <div
          className="hud-dialog"
          style={{
            position: "absolute",
            left: "50%",
            top: "40%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <div className="hud-dialog__title">标记地点</div>
          <input
            type="text"
            value={tagNameInput}
            onChange={(e) => setTagNameInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && tagNameInput.trim()) {
                const state = stateRef.current;
                if (state) {
                  const trimmed = tagNameInput.trim();
                  const dup = state.tags.find(t => t.name === trimmed);
                  if (dup) {
                    addMessage("warning", `标记名「${trimmed}」已存在 (${dup.id})，请换一个名字`, state.time, "ops", "system", "system");
                    return; // keep dialog open, let user change name
                  }
                  state.tags.push({
                    id: `tag_${state.nextTagNum}`,
                    name: trimmed,
                    position: { x: tagNaming.worldX, y: tagNaming.worldY },
                    createdAt: state.time,
                  });
                  state.nextTagNum++;
                  addMessage("info", `标记: ${trimmed}`, state.time, "ops", "player", "player");
                }
                setTagNaming(null);
                setTagNameInput("");
              }
              if (e.key === "Escape") {
                setTagNaming(null);
                setTagNameInput("");
              }
            }}
            placeholder="输入名称..."
            autoFocus
            className="hud-dialog__input"
          />
          <div className="hud-dialog__hint">
            Enter 确认 / Escape 取消
          </div>
        </div>
      )}
      {/* Day 15: Tag right-click context menu */}
      {tagMenu && (
        <div
          className="hud-context-menu"
          style={{
            position: "absolute",
            left: tagMenu.screenX + 10,
            top: tagMenu.screenY - 10,
            borderColor: "var(--hud-accent-amber)",
          }}
        >
          <div className="hud-context-menu__title">
            {tagMenu.tag.name}
          </div>
          <button
            onClick={() => {
              setTagRenaming({ tag: tagMenu.tag });
              setTagRenameInput(tagMenu.tag.name);
              setTagMenu(null);
            }}
            className="hud-context-menu__item"
          >
            重命名
          </button>
          <button
            onClick={() => {
              const state = stateRef.current;
              if (state) {
                state.tags = state.tags.filter(t => t.id !== tagMenu.tag.id);
                addMessage("info", `删除标记: ${tagMenu.tag.name}`, state.time, "ops", "player", "player");
              }
              setTagMenu(null);
            }}
            className="hud-context-menu__item"
            style={{ color: "var(--hud-accent-red)" }}
          >
            删除
          </button>
          <button
            onClick={() => setTagMenu(null)}
            className="hud-context-menu__item"
            style={{ color: "var(--hud-text-dim)" }}
          >
            取消
          </button>
        </div>
      )}
      {/* Day 15: Tag rename dialog */}
      {tagRenaming && (
        <div
          className="hud-dialog"
          style={{
            position: "absolute",
            left: "50%",
            top: "40%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <div className="hud-dialog__title">重命名标记</div>
          <input
            type="text"
            value={tagRenameInput}
            onChange={(e) => setTagRenameInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && tagRenameInput.trim()) {
                const state = stateRef.current;
                if (state) {
                  const t = state.tags.find(t => t.id === tagRenaming.tag.id);
                  if (t) {
                    t.name = tagRenameInput.trim();
                    addMessage("info", `标记重命名: ${t.name}`, state.time, "ops", "player", "player");
                  }
                }
                setTagRenaming(null);
              }
              if (e.key === "Escape") {
                setTagRenaming(null);
              }
            }}
            autoFocus
            className="hud-dialog__input"
          />
          <div className="hud-dialog__hint">
            Enter 确认 / Escape 取消
          </div>
        </div>
      )}
      {/* Day 15: Tag mode indicator */}
      {isTagMode && (
        <div className="hud-mode-indicator">
          标记模式 — 点击地图放置标记 (ESC 退出)
        </div>
      )}
      {gameOverInfo && (
        <div className="hud-gameover-overlay">
          <div className="hud-gameover-box hud-scanline">
            <div className={`hud-gameover-title ${gameOverInfo.isVictory ? "hud-gameover-title--victory" : "hud-gameover-title--defeat"}`}>
              {gameOverInfo.winner}
            </div>
            <div className="hud-gameover-reason">
              {gameOverInfo.reason}
            </div>
            <div className="hud-gameover-stats">
              <div>
                <div className="hud-gameover-stat__label">存活单位</div>
                <div className="hud-gameover-stat__value" style={{ color: "var(--hud-accent-green)" }}>{gameOverInfo.playerUnits}</div>
              </div>
              <div>
                <div className="hud-gameover-stat__label">敌方存活</div>
                <div className="hud-gameover-stat__value" style={{ color: "var(--hud-accent-red)" }}>{gameOverInfo.enemyUnits}</div>
              </div>
              <div>
                <div className="hud-gameover-stat__label">用时</div>
                <div className="hud-gameover-stat__value" style={{ color: "var(--hud-text-primary)" }}>
                  {Math.floor(gameOverInfo.time / 60)}:{String(Math.floor(gameOverInfo.time % 60)).padStart(2, "0")}
                </div>
              </div>
            </div>
            <button onClick={handleRestart} className="hud-btn hud-btn-primary hud-btn-lg" style={{ marginTop: 20 }}>
              再来一局
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles (now mostly handled by CSS classes in game-ui.css) ──
