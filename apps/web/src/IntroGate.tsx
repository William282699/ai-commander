// ============================================================
// 开场入口（教学关 步2）
// ------------------------------------------------------------
// 打开游戏看到的第一样东西。**两个按钮，一句话**——不是 12 张卡片。
//
// 为什么换掉原来那 12 张卡（`TutorialOverlay`，仍在，见下）：
//  · 首次外部试玩的结论是**没有人真正进入过"指挥 AI 参谋"这件事**——
//    注意力全被基本操作吃掉了。而那 12 张卡里，"你手下有 3 个参谋"排第 5、
//    "怎么跟参谋说话"排第 9，第 6 张还在教框选编队——**等于亲手把玩家的
//    心智设成 RTS**，然后他就按 RTS 的方式玩，然后觉得操作难受。
//  · 从头到尾没有一句话说"军队不听你的鼠标"。全场 85 个玩家单位里，
//    鼠标点得动的只有 1 个指挥官 + 10 个精锐卫队
//    （`createInitialGameState.ts` 里 `isPlayerControlled` 就那 11 个）。
//    这句是本作的产品命题，不该埋在第 9 张卡后面。
//
// 所以这一屏只干两件事：**说出那个反转**，然后给一个选择。
//
// ★ 命名：故意不叫 TutorialOverlay——那个名字已经被 12 张卡的组件占了
//   （审核提醒过会撞名）。这个是"入口/闸"，那个是"操作说明书"。
//
// 本组件是纯呈现：不碰暂停逻辑，也不碰场景选择，全部由 App 决定。
// ============================================================

import type { CSSProperties } from "react";

interface IntroGateProps {
  /** 「进入新手教学」——由 App 跳到 `?scenario=tutorial`。 */
  onEnterTutorial: () => void;
  /** 「跳过，直接开打」——关掉本屏，正式局开始。 */
  onSkip: () => void;
  /** 「只想看操作说明」——打开原来那 12 张卡。 */
  onOpenManual: () => void;
}

export function IntroGate({ onEnterTutorial, onSkip, onOpenManual }: IntroGateProps) {
  return (
    <div style={overlayStyle}>
      <div style={cardStyle} role="dialog" aria-modal="true" aria-label="开场">
        <div style={kickerStyle}>AI COMMANDER</div>

        {/* ★ 这一句就是全部。它必须是真的：11/85 指得回 isPlayerControlled。 */}
        <div style={titleStyle}>你是司令，不是操作员。</div>
        <div style={bodyStyle}>
          全场 <b style={numStyle}>85</b> 支部队里，你的鼠标只点得动身边
          <b style={numStyle}> 11 </b>个卫兵。其余的只听参谋的——
          <b style={{ color: "var(--hud-text-primary, #eaf1ff)" }}>想让谁动，就跟他说话。</b>
        </div>

        <div style={btnRow}>
          <button className="hud-btn" onClick={onEnterTutorial} style={primaryBtnStyle}>
            进入新手教学
          </button>
          <button className="hud-btn hud-btn-ghost" onClick={onSkip} style={secondaryBtnStyle}>
            跳过，直接开打
          </button>
        </div>

        <button className="hud-btn hud-btn-ghost hud-btn-sm" onClick={onOpenManual} style={manualLinkStyle}>
          只想看操作说明
        </button>
      </div>
    </div>
  );
}

// ── styles（与 TutorialOverlay 同一套视觉语言：同底色、同边框、圆角 ≥8）──

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  background: "rgba(5, 10, 20, 0.82)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  fontFamily: "var(--hud-font-mono)",
};

const cardStyle: CSSProperties = {
  width: "min(560px, 92vw)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  padding: "34px 30px 26px",
  background: "var(--hud-bg-panel, #0e1726)",
  border: "1px solid var(--hud-border, rgba(120, 160, 220, 0.35))",
  borderRadius: 12,
  boxShadow: "0 16px 60px rgba(0, 0, 0, 0.6)",
  color: "var(--hud-text-primary, #eaf1ff)",
};

const kickerStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--hud-text-dim, #8aa0c0)",
  marginBottom: 18,
};

const titleStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  lineHeight: 1.35,
  marginBottom: 14,
  color: "var(--hud-accent-cyan, #00d4ff)",
};

const bodyStyle: CSSProperties = {
  fontSize: 14.5,
  lineHeight: 1.9,
  color: "var(--hud-text-dim, #b9c8e0)",
  marginBottom: 26,
  maxWidth: 430,
};

const numStyle: CSSProperties = {
  color: "var(--hud-text-primary, #eaf1ff)",
  fontWeight: 700,
};

const btnRow: CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  justifyContent: "center",
  width: "100%",
};

const primaryBtnStyle: CSSProperties = {
  minWidth: 168,
  padding: "11px 22px",
  fontSize: 15,
  fontWeight: 700,
  borderRadius: 10,
};

const secondaryBtnStyle: CSSProperties = {
  minWidth: 168,
  padding: "11px 22px",
  fontSize: 15,
  borderRadius: 10,
};

const manualLinkStyle: CSSProperties = {
  marginTop: 16,
  opacity: 0.65,
  fontSize: 12.5,
};
