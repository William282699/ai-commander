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

// El Alamein is the default scenario (only ?scenario=dual_island opts out). The
// onboarding tutorial runs on El Alamein, so it shows on the default load too.
const isTutorialScenario = new URLSearchParams(window.location.search).get("scenario") !== "dual_island";

function PanelApp() {
  const [bridge, setBridge] = useState<GameBridge | null>(null);

  useEffect(() => {
    // Poll for bridge from opener window (it may take a moment to be ready)
    const id = setInterval(() => {
      const b = (window.opener as Window | null)?.__GAME_BRIDGE__;
      if (b) { setBridge(b); clearInterval(id); }
    }, 100);
    // If opener closes, close this window too.
    //
    // ★步 5d：光看 `closed` 不够——**主窗刷新时它是假的**。`window.opener` 绑的是
    //   browsing context 不是 Document，主窗 reload 之后这个引用照旧有效、
    //   `closed` 仍为 false ⇒ 弹窗不自尽；而主窗那边 `panelDetached` 是没有持久化
    //   的 useState ⇒ 复位成 false ⇒ 嵌入版又挂回来。于是**两个 realm 各一份
    //   ChatPanel、各一份模块级 tts**：cancel 互相碰不到、persona 各判各的，
    //   手测听到的「一个马克斯一个陈同时说」就是这么来的。更糟的是 panelWinRef
    //   随旧 realm 一起没了，主窗上「收回面板」按钮也不再渲染 ⇒ 僵尸窗界面上关不掉。
    //   （vite dev 的 full-reload 会同时刷两扇窗，正好凑齐"两边都活"的条件。）
    //
    //   信号取 `__GAME_BRIDGE__` 的**对象身份**：探针实测正常游玩 28 拍 0 次变化
    //   （那 10 个 useCallback 依赖是稳的），主窗 reload 后变 1 次。连续两拍都对不上
    //   才自尽——防的是桥被短暂重建的那一瞬（真发生了也只是晚 1 秒关）。
    //
    //   理由不只是省事：主窗一刷新，弹窗显示的就是**上一份世界**了，本来就该关。
    let missStreak = 0;
    const bornWith = (window.opener as Window | null)?.__GAME_BRIDGE__;
    const checkOpener = setInterval(() => {
      if (!window.opener || (window.opener as Window).closed) { window.close(); return; }
      const now = (window.opener as Window).__GAME_BRIDGE__;
      if (bornWith && now !== bornWith) {
        if (++missStreak >= 2) window.close();
      } else {
        missStreak = 0;
      }
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
        getViewport={bridge.getViewport}
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
    pool: number;      // 刀3: 地图上插旗的目标总数（4），HUD tooltip 讲清"4 取 3"
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
          pool: (state.captureObjectives ?? []).length,
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

  // ★步1：把弹窗句柄存下来。原来它是 handlePopOut 里的一个闭包局部量，谁也拿不到，
  //   于是「收回面板」只能翻 panelDetached 这个 flag——**弹窗从来没被关过**。
  //   两下点完（弹出→收回）就有两个 ChatPanel 同时在线：嵌入版挂回来了、弹窗还活着，
  //   两个 realm 各有一份 tts 模块，同一条主动台词会被念两遍且互相掐不掉
  //   （勘察档新 HIGH-2，v2 的「单实例保证」作废）。接线之前先把这颗地雷拆了。
  const panelWinRef = useRef<Window | null>(null);
  const handlePopOut = useCallback(() => {
    // ★P1-12（勘察档）：原来这里用的是 `origin`——**query 全被丢掉**，于是弹出
    //   面板里 `?webspeech` / `?novoicewarm` / 本刀的 `?nag`/`?expire` 一个都不生效：
    //   延迟 A/B 的 `isBaselineArm()` 只读本窗 search，弹过面板的那一局臂标签与
    //   实际路径对不上（已污染的历史样本另账）。改成把原 query 原样带过去，
    //   再覆上 mode=panel。
    const params = new URLSearchParams(window.location.search);
    params.set("mode", "panel");
    const panelWin = window.open(
      `${window.location.origin}${window.location.pathname}?${params.toString()}`,
      "ai-commander-panel",
      "width=1280,height=900",
    );
    if (panelWin) {
      panelWinRef.current = panelWin;
      setPanelDetached(true);
      // Listen for child window close → re-attach panel
      const check = setInterval(() => {
        if (panelWin.closed) {
          setPanelDetached(false);
          if (panelWinRef.current === panelWin) panelWinRef.current = null;
          clearInterval(check);
        }
      }, 500);
    }
  }, []);

  /** 「收回面板」＝真把弹窗关掉，按钮从此名副其实。 */
  const handleReattach = useCallback(() => {
    try { panelWinRef.current?.close(); } catch { /* 已关/跨源，忽略 */ }
    panelWinRef.current = null;
    setPanelDetached(false);
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
            onClick={handleReattach}
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
            <div
              className="hud-resource-chip hud-resource-chip--info"
              title={`夺下地图上 ${winProgress.pool} 面旗中的任意 ${winProgress.required} 面即胜`}
            >
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
