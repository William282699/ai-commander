// ============================================================
// 音量：两条滑块，挂在喇叭键旁边
//
// 用户 2026-09-12：「这两个音响放在一起，都放在右下角不行吗？为啥非要弄两个？」
// ——第一版把音量放顶栏、喇叭开关在右下角输入条，屏上就有了两个"管声音的地方"。
// 现在并排：**喇叭键管开不开口，紧挨着的这颗管多大声**，一处解决。
//
// ★ 为什么不干脆合成一颗键：喇叭是高频开关（吵了就先掐掉），点一下就得见效；
//   塞进弹层等于把最常用的动作变成两步。分开的是"开关"和"旋钮"，不是两套音量。
//
// ★ 为什么抽成独立文件：ChatPanel 里输入条有**两份渲染**（停靠版 / 嵌入版），
//   本项目在这上面栽过——只改一份的表现是"属性根本没渲染出来"。抽出来两边共用，
//   下次谁加东西也不会只加一半。
// ============================================================

import { useEffect, useRef, useState } from "react";
import {
  getVoiceVolume, setVoiceVolume, getSfxVolume, setSfxVolume, applyStoredAudioSettings,
} from "./audioSettings";

/** 小喇叭里那几条音波：音量越大波越多，静音时打叉。纯 SVG，跟 HornIcon 同一路子。 */
function VolumeIcon({ level }: { level: number }) {
  const waves = level === 0 ? 0 : level < 0.34 ? 1 : level < 0.67 ? 2 : 3;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 6h2L7.5 3.5v9L4.5 10h-2z" fill="currentColor" />
      {waves >= 1 && <path d="M9.4 6.2a2.4 2.4 0 0 1 0 3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
      {waves >= 2 && <path d="M11 4.6a4.6 4.6 0 0 1 0 6.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
      {waves >= 3 && <path d="M12.6 3a6.8 6.8 0 0 1 0 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
      {waves === 0 && <path d="M9.6 6l3.4 4M13 6l-3.4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}

interface Props {
  /** 停靠版和嵌入版的按钮样式不一样，各自把自己的传进来。 */
  className?: string;
  style?: React.CSSProperties;
}

export function VolumePopover({ className, style }: Props) {
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
        className={className}
        style={style}
        onClick={() => setOpen((o) => !o)}
        title="音量：参谋语音 / 战场音效"
        data-volume-btn
      >
        <VolumeIcon level={Math.max(voice, sfx)} />
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
          {row("参谋语音", voice, (n) => { setVoice(n); setVoiceVolume(n); })}
          {row("战场音效", sfx, (n) => { setSfx(n); setSfxVolume(n); })}
        </div>
      )}
    </div>
  );
}
