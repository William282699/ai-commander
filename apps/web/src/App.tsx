import { useRef, useState, useEffect, useCallback } from "react";
import { GameCanvas } from "./GameCanvas";
import type { GameState } from "@ai-commander/shared";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const stateGetterRef = useRef<(() => GameState | null) | null>(null);

  // Lightweight top-bar data refreshed 4x/sec
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
        <span style={{ marginLeft: "auto" }}>T:{formatTime(topBar.time)}</span>
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: "relative" }}>
        <GameCanvas onStateReady={registerStateGetter} />
      </div>
    </div>
  );
}
