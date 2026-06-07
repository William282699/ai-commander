import { useRef, useState, useEffect, useCallback } from "react";
import { GameCanvas } from "./GameCanvas";
import { ChatPanel } from "./ChatPanel";
import { TutorialOverlay } from "./TutorialOverlay";
import type { GameState } from "@ai-commander/shared";
import type { GameBridge } from "./GameCanvas";

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Panel-only mode (pop-out window) ──

const isPanelMode = new URLSearchParams(window.location.search).get("mode") === "panel";

// Onboarding tutorial only runs on El Alamein (same URL gate GameCanvas uses for scenarioId).
const isTutorialScenario = new URLSearchParams(window.location.search).get("scenario") === "el_alamein";

function PanelApp() {
  const [bridge, setBridge] = useState<GameBridge | null>(null);

  useEffect(() => {
    // Poll for bridge from opener window (it may take a moment to be ready)
    const id = setInterval(() => {
      const b = (window.opener as Window | null)?.__GAME_BRIDGE__;
      if (b) { setBridge(b); clearInterval(id); }
    }, 100);
    // If opener closes, close this window too
    const checkOpener = setInterval(() => {
      if (!window.opener || (window.opener as Window).closed) window.close();
    }, 1000);
    return () => { clearInterval(id); clearInterval(checkOpener); };
  }, []);

  if (!bridge) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100vw", height: "100vh", color: "var(--hud-text-primary)", fontFamily: "var(--hud-font-mono)" }}>
        连接主窗口中...
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <ChatPanel
        getState={bridge.getState}
        getSelectedUnitIds={bridge.getSelectedUnitIds}
        onCreateSquad={bridge.onCreateSquad}
        canCreateSquad={bridge.canCreateSquad}
        onDeclareWar={bridge.onDeclareWar}
        onSelectUnits={bridge.onSelectUnits}
        onMoveSquad={bridge.onMoveSquad}
        onRemoveFromParent={bridge.onRemoveFromParent}
        onRenameLeader={bridge.onRenameLeader}
        onTransferSquad={bridge.onTransferSquad}
        isDetached
      />
    </div>
  );
}

// ── Main app (map + optional panel) ──

export default function App() {
  if (isPanelMode) return <PanelApp />;

  const stateGetterRef = useRef<(() => GameState | null) | null>(null);
  const [panelDetached, setPanelDetached] = useState(false);
  // Onboarding tutorial overlay gate (every El Alamein launch; skippable). When
  // active, GameCanvas is paused (frozen map, clock stopped) until 开始作战/跳过.
  const [tutorialActive, setTutorialActive] = useState(isTutorialScenario);

  const [topBar, setTopBar] = useState({
    money: 2000,
    fuel: 100,
    ammo: 100,
    intel: 30,
    readiness: 0,
    time: 0,
  });

  // Step 5B: win-progress snapshot for the top-right HUD. When set, the topbar
  // replaces the legacy clock with a 3-line scenario progress block. Null means
  // the scenario has no scenarioWinConfig — fall back to the legacy clock.
  const [winProgress, setWinProgress] = useState<{
    captured: number;
    required: number;
    lost: number;
    maxLost: number;
    timeLeftSec: number;
  } | null>(null);

  const registerStateGetter = useCallback((getter: () => GameState | null) => {
    stateGetterRef.current = getter;
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const state = stateGetterRef.current?.();
      if (!state) return;
      const r = state.economy.player.resources;
      setTopBar({
        money: Math.floor(r.money),
        fuel: Math.floor(r.fuel),
        ammo: Math.floor(r.ammo),
        intel: Math.floor(r.intel),
        readiness: state.economy.player.readiness,
        time: state.time,
      });
      // Step 5B: scenario win-progress (only for scenarios with scenarioWinConfig).
      const cfg = state.scenarioWinConfig;
      if (cfg) {
        const captured = (state.captureObjectives ?? []).filter(fid =>
          state.facilities.get(fid)?.team === "player",
        ).length;
        const lost = cfg.friendlyKeypoints.filter(fid => {
          const f = state.facilities.get(fid);
          return !f || f.hp <= 0 || f.team !== "player";
        }).length;
        setWinProgress({
          captured,
          required: cfg.requiredCapturedObjectives,
          lost,
          maxLost: cfg.maxFriendlyKeypointsLost,
          timeLeftSec: Math.max(0, cfg.timeLimitSec - state.time),
        });
      } else {
        setWinProgress(null);
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  const handlePopOut = useCallback(() => {
    const panelWin = window.open(
      `${window.location.origin}?mode=panel`,
      "ai-commander-panel",
      "width=1280,height=900",
    );
    if (panelWin) {
      setPanelDetached(true);
      // Listen for child window close → re-attach panel
      const check = setInterval(() => {
        if (panelWin.closed) { setPanelDetached(false); clearInterval(check); }
      }, 500);
    }
  }, []);

  const rdPct = Math.round(topBar.readiness * 100);

  // Resource gauge helper — percentage clamped 0..100
  const moneyPct = Math.min(100, (topBar.money / 5000) * 100);
  const fuelPct = Math.min(100, topBar.fuel);
  const ammoPct = Math.min(100, topBar.ammo);
  const intelPct = Math.min(100, (topBar.intel / 100) * 100);

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top HUD bar */}
      <div className="hud-topbar">
        <span className="hud-topbar__title">AI COMMANDER</span>
        <span className="hud-status-badge">
          <span className="hud-status-badge__dot" />
          OPERATIONAL
        </span>

        <div className="hud-topbar__resources">
          {/* Money */}
          <div className={`hud-resource-chip hud-resource-chip--success`}>
            <span className="hud-resource-chip__label">MONEY</span>
            <span className="hud-resource-chip__value">${topBar.money.toLocaleString()}</span>
          </div>

          {/* Fuel */}
          <div className={`hud-resource-chip ${topBar.fuel <= 20 ? "hud-resource-chip--danger" : "hud-resource-chip--warning"}`}>
            <span className="hud-resource-chip__label">FUEL</span>
            <span className="hud-resource-chip__value">{topBar.fuel}%</span>
          </div>

          {/* Ammo */}
          <div className={`hud-resource-chip ${topBar.ammo <= 20 ? "hud-resource-chip--danger" : "hud-resource-chip--warning"}`}>
            <span className="hud-resource-chip__label">AMMO</span>
            <span className="hud-resource-chip__value">{topBar.ammo}%</span>
          </div>

          {/* Intel */}
          <div className="hud-resource-chip hud-resource-chip--success">
            <span className="hud-resource-chip__label">INTEL</span>
            <span className="hud-resource-chip__value">{topBar.intel}</span>
          </div>

          {/* Readiness */}
          <div className="hud-resource-chip hud-resource-chip--info">
            <span className="hud-resource-chip__label">READINESS</span>
            <span className="hud-resource-chip__value">{rdPct}%</span>
          </div>
        </div>

        {panelDetached && (
          <button
            className="hud-btn hud-btn-ghost hud-btn-sm"
            onClick={() => setPanelDetached(false)}
          >
            收回面板
          </button>
        )}
        {!panelDetached && (
          <button
            className="hud-btn hud-btn-ghost hud-btn-sm"
            onClick={handlePopOut}
          >
            弹出面板 ↗
          </button>
        )}

        {/* Step 5B: scenario win-progress as a horizontal chip group, sharing
            the Money/Fuel/Ammo chip style. Pinned to the far right via
            marginLeft:auto. Dual_island and other scenarios with no
            scenarioWinConfig fall back to the legacy clock. */}
        {winProgress ? (
          <div className="hud-topbar__resources" style={{ marginLeft: "auto" }}>
            <div className="hud-resource-chip hud-resource-chip--info">
              <span className="hud-resource-chip__label">OBJECTIVES</span>
              <span className="hud-resource-chip__value">
                {winProgress.captured}/{winProgress.required}
              </span>
            </div>
            <div className="hud-resource-chip hud-resource-chip--danger">
              <span className="hud-resource-chip__label">POSTS LOST</span>
              <span className="hud-resource-chip__value">
                {winProgress.lost}/{winProgress.maxLost}
              </span>
            </div>
            <div className="hud-resource-chip hud-resource-chip--success">
              <span className="hud-resource-chip__label">TIME LEFT</span>
              <span className="hud-resource-chip__value">
                {String(Math.floor(winProgress.timeLeftSec / 60)).padStart(2, "0")}:{String(Math.floor(winProgress.timeLeftSec % 60)).padStart(2, "0")}
              </span>
            </div>
          </div>
        ) : (
          <span className="hud-topbar__clock">{formatTime(topBar.time)}</span>
        )}
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: "relative" }}>
        <GameCanvas onStateReady={registerStateGetter} panelDetached={panelDetached} paused={tutorialActive} />
      </div>

      {tutorialActive && <TutorialOverlay onStart={() => setTutorialActive(false)} />}
    </div>
  );
}
