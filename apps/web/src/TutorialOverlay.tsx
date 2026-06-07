// ============================================================
// Onboarding Tutorial Overlay — 12-step guided intro (workplan §5)
// ------------------------------------------------------------
// Full-viewport modal (z-index above every HUD layer; existing max is 200,
// see workplan §1 P0-3) shown over a FROZEN map. The overlay captures all
// pointer/scroll input, and GameCanvas is `paused` while it is mounted, so the
// battle/timer do not advance.
//
// onStart() (跳过教程, or 开始作战 on the last page) dismisses the overlay →
// App sets tutorialActive=false → GameCanvas unpauses → simulation + 30-min
// clock begin. This component is presentation only — it does NOT touch the
// pause / scenario-gate logic.
// ============================================================

import { useState, type ReactNode, type CSSProperties } from "react";

interface TutorialOverlayProps {
  onStart: () => void;
}

/** Emphasised inline term. */
function B({ children }: { children: ReactNode }) {
  return <strong style={{ color: "var(--hud-text-primary, #eaf1ff)", fontWeight: 700 }}>{children}</strong>;
}

/** Keyboard key glyph. */
function Kbd({ children }: { children: ReactNode }) {
  return <kbd style={kbdStyle}>{children}</kbd>;
}

interface Step {
  title: string;
  body: ReactNode;
}

// Copy is verbatim from workplan §5 (Codex-approved). Only presentational
// line-breaks are added (e.g. one advisor per line); no wording is changed.
const STEPS: Step[] = [
  {
    title: "欢迎 + 你的目标",
    body: (
      <>长官，欢迎来到阿拉曼前线。<B>30 分钟内，从敌人手里夺下 4 个据点中的 3 个</B>就赢；你的 3 个前哨全被打下来就输。先花一分钟认认战场。</>
    ),
  },
  {
    title: "顶上这排数字 = 你的家底",
    body: (
      <>💰钱 造兵 ｜ ⛽油 坦克要跑 ｜ 🔫弹 打仗要用 ｜ 🛰情报 看得更远 ｜ ⚡战备 部队状态。<br />右上角随时看：夺了几个据点、丢了几个前哨、还剩多少时间。</>
    ),
  },
  {
    title: "怎么看战场、怎么动镜头",
    body: (
      <>移动视角：<B>WASD</B> 或鼠标移到屏幕边缘 ｜ 缩放：<B>滚轮</B> ｜ 平移：<B>按住鼠标中键拖</B> ｜ 跳到某条战线：<B>数字键 1-5</B> ｜ 总览全局：点<B>右下角小地图</B>任意位置直接跳过去。</>
    ),
  },
  {
    title: "嫌挤？把对讲面板拉出去",
    body: (
      <>右上角「弹出面板 ↗」把跟参谋对话的窗口单独拉出来放另一个屏幕；不要了点「收回面板」。</>
    ),
  },
  {
    title: "你手下有 3 个参谋",
    body: (
      <>
        三个参谋分工不一样：
        <br />🔴 <B>Chen（战斗）</B>负责执行打仗、进攻、防守
        <br />🔵 <B>Marcus（参谋）</B>只帮你分析局势、给建议，不负责直接派兵执行
        <br />🟢 <B>Emily（后勤）</B>负责补给、造兵、油弹
      </>
    ),
  },
  {
    title: "把零散的兵编成一队（分队）",
    body: (
      <>地图上框选一批兵 → 点「编队」按钮，他们就成一支<B>分队</B>，归当前参谋。编了队，一句话指挥一整队，不用一个个点。</>
    ),
  },
  {
    title: "编制树：合并分队、安排上下级",
    body: (
      <>点<B>右边面板的「编制 🏗️」标签</B>，能看到你所有部队归谁管。你可以把一个<B>分队</B>拖到另一个<B>分队</B>上，让它当下级/下手；也可以拖回某个参谋那一栏里拆开。简单说：这里是整理部队结构的地方。</>
    ),
  },
  {
    title: "在地图上插旗做记号（tag）",
    body: (
      <>想让部队去某个具体位置，先做记号：<B>按 <Kbd>T</Kbd> → 在地图上点一下 → 弹出命名框，打个名字（比如 tag_1）按 Enter</B>。之后就能跟参谋说「派一队去 tag_1」「守住 tag_1」。不要了：<B>右键那面旗 → 删除</B>。（Esc 退出插旗模式）</>
    ),
  },
  {
    title: "给参谋下命令 + 阵型怎么说 + 造的兵在哪",
    body: (
      <>
        <B>打字</B>：对话框输入。<B>语音</B>：按住 🎤 按钮说话、松开发送。想让参谋回复被读出来，点 🔊 开关。
        <br />大白话说你想干嘛：「Chen 带主力打中路据点」「Marcus 帮我判断先打北线还是中线」「Emily 造 5 个步兵」「派一队去西边侦察」。
        <br />还能指定<B>阵型</B>：<B>楔形阵</B>适合冲锋突破；<B>长蛇阵</B>适合沿路走/穿窄路；<B>横队</B>适合铺开防守或正面推进；<B>合围</B>适合包住敌人打。
        <br />⚠️ <B>造的新兵在哪</B>：让 Emily 生产后，新部队在你后方的「<B>我军兵营</B>」旁边出现（不是凭空到前线），记得把他们调上去。
      </>
    ),
  },
  {
    title: "哪些是敌人、哪些是我的",
    body: (
      <>🔵 蓝色=你的（东边）｜🔴 红色=敌人（西边，Rommel 的部队）。西边那 <B>4 个带标记的据点</B>就是目标，抢到 3 个就赢。</>
    ),
  },
  {
    title: "你有哪几种兵",
    body: (
      <>
        <B>步兵</B> 便宜灵活、占点守点 ｜ <B>轻型坦克</B> 跑得快、侦察抄侧翼 ｜ <B>主战坦克</B> 皮厚火力猛、正面硬刚 ｜ <B>火炮</B> 打得远、躲后面、怕近身。
      </>
    ),
  },
  {
    title: "（可选）看不见的地方要侦察",
    body: (
      <>
        地图灰蒙蒙的是你看不到的（战争迷雾）。派部队过去、或下「侦察」命令，就能揭开看清敌情。
        <br />
        <br />就这些，打起来就懂了。点<B>「开始作战」</B>，计时开始 —— 祝你好运，长官。
      </>
    ),
  },
];

export function TutorialOverlay({ onStart }: TutorialOverlayProps) {
  const [step, setStep] = useState(0);
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;
  const cur = STEPS[step];

  return (
    <div style={overlayStyle}>
      <div style={cardStyle} role="dialog" aria-modal="true" aria-label="新手教程">

        {/* Header: progress counter + skip */}
        <div style={headerRow}>
          <span style={counterStyle}>新手教程 · {step + 1}/{STEPS.length}</span>
          <button className="hud-btn hud-btn-ghost hud-btn-sm" onClick={onStart}>
            跳过教程
          </button>
        </div>

        <div style={titleStyle}>{cur.title}</div>
        <div style={bodyStyle}>{cur.body}</div>

        {/* Progress dots */}
        <div style={dotsRow}>
          {STEPS.map((_, i) => (
            <button
              key={i}
              aria-label={`第 ${i + 1} 步`}
              onClick={() => setStep(i)}
              style={dotStyle(i === step)}
            />
          ))}
        </div>

        {/* Navigation */}
        <div style={navRow}>
          <button
            className="hud-btn hud-btn-ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={isFirst}
            style={{ opacity: isFirst ? 0.35 : 1, cursor: isFirst ? "default" : "pointer" }}
          >
            上一步
          </button>
          {isLast ? (
            <button className="hud-btn" onClick={onStart} style={primaryBtnStyle}>
              开始作战 ▶
            </button>
          ) : (
            <button className="hud-btn" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} style={primaryBtnStyle}>
              下一步
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  background: "rgba(5, 10, 20, 0.78)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  fontFamily: "var(--hud-font-mono)",
};

const cardStyle: CSSProperties = {
  width: "min(620px, 92vw)",
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  padding: "22px 28px 24px",
  background: "var(--hud-bg-panel, #0e1726)",
  border: "1px solid var(--hud-border, rgba(120, 160, 220, 0.35))",
  borderRadius: 8,
  boxShadow: "0 16px 60px rgba(0, 0, 0, 0.6)",
  color: "var(--hud-text-primary, #eaf1ff)",
};

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 14,
};

const counterStyle: CSSProperties = {
  fontSize: 12,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--hud-text-dim, #8aa0c0)",
};

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  marginBottom: 12,
  color: "var(--hud-accent-cyan, #00d4ff)",
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 132,
  overflowY: "auto",
  fontSize: 14.5,
  lineHeight: 1.85,
  color: "var(--hud-text-secondary, #c4d2e8)",
  marginBottom: 16,
};

const dotsRow: CSSProperties = {
  display: "flex",
  gap: 7,
  justifyContent: "center",
  marginBottom: 16,
};

function dotStyle(active: boolean): CSSProperties {
  return {
    width: active ? 18 : 8,
    height: 8,
    padding: 0,
    borderRadius: 4,
    border: "none",
    cursor: "pointer",
    background: active ? "var(--hud-accent-cyan, #00d4ff)" : "rgba(180, 200, 230, 0.25)",
    transition: "width 0.15s ease, background 0.15s ease",
  };
}

const navRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const primaryBtnStyle: CSSProperties = {
  minWidth: 120,
};

const kbdStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  margin: "0 3px",
  fontSize: "0.82em",
  fontFamily: "var(--hud-font-mono)",
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.28)",
  borderRadius: 4,
  color: "var(--hud-text-primary, #eaf1ff)",
};
