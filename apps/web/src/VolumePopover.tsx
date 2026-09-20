// ============================================================
// 声音：一颗喇叭键，管所有关于声音的事
//
// 用户 2026-09-12/13 连说两次：「这两个音响放在一起，都放在右下角不行吗？
// 为啥非要弄两个？」「不能把这两个音响放在一起吗？」
//
// 走过的两版都被否了，理由值得留着：
//   v1 音量放顶栏、喇叭开关在输入条 ⇒ 屏上两个"管声音的地方"，隔了半个屏幕。
//   v2 把音量挪到喇叭旁边 ⇒ 更糟：**并排两个长得一样的喇叭图标**，谁也不知道
//      哪个干什么。我当时的理由是"开关要一步到位、旋钮可以两步"——那是从
//      交互成本推的，没从**屏上看起来是什么**推。两个同形图标就是两个功能，
//      玩家不会读我的心。
//   v3（本版）＝**一颗键**：点开就是一块声音面板，朗读开关和两条音量都在里面。
//      代价是静音从一步变两步；换来的是屏上再没有"这俩有啥区别"。
//
// ★ 一颗键还得同时是状态灯：朗读关着时图标打叉，不点开也看得出来。
// ★ `data-tts-*` 三个属性必须留在这颗键上——`game-ui.css` 的
//   `[data-tts-pulse="on"]` 靠它做电台脉冲动画，掉了动画就哑了。
// ★ 抽成独立文件而不是写两遍：ChatPanel 的输入条有**两份渲染**（停靠版/嵌入版），
//   本项目在这上面栽过（只改一份＝属性根本没渲染出来）。
// ============================================================

import { useEffect, useRef, useState } from "react";
import { HornIcon } from "./InputRailIcons";
import {
  getVoiceVolume, setVoiceVolume, getSfxVolume, setSfxVolume, applyStoredAudioSettings,
} from "./audioSettings";

interface Props {
  /** 参谋朗读开着没有（这颗键同时是它的状态灯）。 */
  ttsEnabled: boolean;
  /** 电台脉冲：有新播报时闪一下，CSS 认 `data-tts-pulse`。 */
  radioPulse: boolean;
  onToggleTts: () => void;
  /** 停靠版和嵌入版按钮样式不同，各自把自己的传进来。 */
  className?: string;
  style?: React.CSSProperties;
}

export function VolumePopover({ ttsEnabled, radioPulse, onToggleTts, className, style }: Props) {
  const [open, setOpen] = useState(false);
  const [voice, setVoice] = useState(getVoiceVolume);
  const [sfx, setSfx] = useState(getSfxVolume);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { applyStoredAudioSettings(); }, []);

  // 点别处就收起来——弹层压在地图上，忘了收会挡视线
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const row = (label: string, v: number, on: (n: number) => void) => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, whiteSpace: "nowrap" }}>
      <span style={{ width: 52, color: "var(--hud-text-secondary)" }}>{label}</span>
      <input
        type="range" min={0} max={1} step={0.05} value={v}
        onChange={(e) => on(parseFloat(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}   // 别让方向键滚地图
        style={{ width: 104, accentColor: "var(--hud-accent-cyan)" }}
      />
      <span style={{ width: 30, textAlign: "right", color: "var(--hud-text-primary)" }}>
        {Math.round(v * 100)}%
      </span>
    </label>
  );

  return (
    <div ref={boxRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        data-tts-btn
        data-tts-state={ttsEnabled ? "on" : "off"}
        data-tts-pulse={radioPulse ? "on" : "off"}
        data-volume-btn
        className={className}
        style={style}
        onClick={() => setOpen((o) => !o)}
        title="声音：参谋朗读开关 + 两条音量"
      >
        <HornIcon on={ttsEnabled} />
      </button>
      {open && (
        <div
          style={{
            // ★ 往**上**弹：这颗键在屏幕最下边，往下弹就掉到视口外面去了
            position: "absolute", bottom: "calc(100% + 8px)", right: 0, zIndex: 300,
            background: "rgba(10, 14, 26, 0.97)",
            border: "1px solid rgba(0, 212, 255, 0.28)",
            borderRadius: 4, padding: "10px 12px",
            display: "flex", flexDirection: "column", gap: 8,
            boxShadow: "0 6px 24px rgba(0,0,0,0.65)",
          }}
        >
          {/* 朗读开关排第一行：吵起来最先想关的就是它 */}
          <button
            onClick={onToggleTts}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 10, fontSize: 11, padding: "5px 8px", cursor: "pointer",
              background: ttsEnabled ? "rgba(0, 212, 255, 0.18)" : "rgba(255,255,255,0.05)",
              border: "1px solid rgba(0, 212, 255, 0.25)", borderRadius: 3,
              color: "var(--hud-text-primary)", fontFamily: "inherit",
            }}
          >
            <span>参谋朗读</span>
            <span style={{ color: ttsEnabled ? "var(--hud-accent-cyan)" : "var(--hud-text-dim)" }}>
              {ttsEnabled ? "开" : "关"}
            </span>
          </button>
          {row("参谋语音", voice, (n) => { setVoice(n); setVoiceVolume(n); })}
          {row("战场音效", sfx, (n) => { setSfx(n); setSfxVolume(n); })}
        </div>
      )}
    </div>
  );
}
