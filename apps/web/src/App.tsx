import { useRef, useState, useEffect, useCallback } from "react";
import { GameCanvas } from "./GameCanvas";
import { ChatPanel } from "./ChatPanel";
import type { GameState } from "@ai-commander/shared";
import type { GameBridge } from "./GameCanvas";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100vw", height: "100vh", color: "#a0c4ff", fontFamily: "monospace" }}>
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

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top status bar */}
      <div
        style={{
          height: 36,
          background: "#16213e",
          borderBottom: "1px solid #0f3460",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 24,
          fontSize: 13,
          color: "#a0c4ff",
          fontFamily: "monospace",
        }}
      >
        <span style={{ fontWeight: "bold" }}>AI COMMANDER</span>
        <span style={{ color: "#fbbf24" }}>${topBar.money}</span>
        <span style={{ color: topBar.fuel <= 20 ? "#ef4444" : "#a0c4ff" }}>
          Fu:{topBar.fuel}
        </span>
        <span style={{ color: topBar.ammo <= 20 ? "#ef4444" : "#a0c4ff" }}>
          Am:{topBar.ammo}
        </span>
        <span>In:{topBar.intel}</span>
        <span style={{ color: "#60a5fa" }}>Rd:{rdPct}%</span>
        {panelDetached && (
          <button
            onClick={() => setPanelDetached(false)}
            style={{ background: "none", border: "1px solid #475569", color: "#a0c4ff", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}
          >
            收回面板
          </button>
        )}
        {!panelDetached && (
          <button
            onClick={handlePopOut}
            style={{ background: "none", border: "1px solid #475569", color: "#a0c4ff", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}
          >
            弹出面板 ↗
          </button>
        )}
        <span style={{ marginLeft: "auto" }}>T:{formatTime(topBar.time)}</span>
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: "relative" }}>
        <GameCanvas onStateReady={registerStateGetter} panelDetached={panelDetached} />
      </div>
    </div>
  );
}
