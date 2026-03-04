import { GameCanvas } from "./GameCanvas";

export default function App() {
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
        }}
      >
        <span>AI COMMANDER</span>
        <span>$2000</span>
        <span>Fu:100</span>
        <span>Am:100</span>
        <span>In:30</span>
        <span style={{ marginLeft: "auto" }}>T:00:00</span>
      </div>

      {/* Main canvas area */}
      <div style={{ flex: 1, position: "relative" }}>
        <GameCanvas />
      </div>
    </div>
  );
}
