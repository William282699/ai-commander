import { useRef, useState, useEffect, useCallback } from "react";
import { GameCanvas } from "./GameCanvas";
import { ChatPanel } from "./ChatPanel";
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

  const [topBar, setTopBar] = useState({
    money: 2000,
    fuel: 100,
    ammo: 100,
    intel: 30,
    readiness: 0,
    time: 0,
  });

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
    }, 250);
    return () => clearInterval(id);
  }, []);

  const handlePopOut = useCallback(() => {
    const panelWin = window.open(
      `${window.location.origin}?mode=panel`,
      "ai-commander-panel",
      "width=520,height=900",
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

        <span className="hud-topbar__clock">{formatTime(topBar.time)}</span>
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: "relative" }}>
        <GameCanvas onStateReady={registerStateGetter} panelDetached={panelDetached} />
      </div>
    </div>
  );
}
