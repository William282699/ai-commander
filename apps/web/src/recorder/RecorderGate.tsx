// ============================================================
// 试玩记录仪 · 同意框（游戏载入之前）＋ 记录状态与“这里有问题”小窗（左上角、顶栏之下，不压任务条）
//
// 没有邀请的普通访客：原样渲染子树，界面与今天完全相同。
// 有邀请、还没作答：先问同意，答完才挂载游戏（不借 paused——教学关开场句不看它）。
// 拒绝或撤回：照常玩，不显示问题按钮和记录状态。
// ============================================================

import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { BOOT, saveConsent, type BootState } from "./boot";
import {
  activateRecorder, startBacklogUploader, subscribeRecorderStatus, recorderStatus, flagProblem, submitEndFeedback,
  withdrawRecording, type RecorderStatus,
} from "./index";
import { REC_HEADER_INVITE } from "@ai-commander/shared/src/recorderProtocol";
import { API_URL } from "../api";

type GateView =
  | { kind: "play" }
  | { kind: "checking" }
  | { kind: "ask" }
  | { kind: "activating" }
  | { kind: "note"; text: string };

async function serverStatus(token: string): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    const r = await fetch(`${API_URL}/api/rec/status`, { headers: { [REC_HEADER_INVITE]: token }, signal: ac.signal, cache: "no-store" });
    if (!r.ok) return "unknown";
    const j = await r.json() as { recorder?: unknown };
    return typeof j.recorder === "string" ? j.recorder : "unknown";
  } catch { return "unknown"; } finally { clearTimeout(t); }
}

const overlay: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(5, 8, 16, 0.92)", fontFamily: "var(--hud-font-mono)", color: "var(--hud-text-primary)",
};
const card: CSSProperties = {
  maxWidth: 520, margin: 16, padding: "22px 26px", border: "1px solid var(--hud-border-bright)", borderRadius: 4,
  background: "var(--hud-bg-secondary)", boxShadow: "var(--hud-shadow-panel)", lineHeight: 1.7, fontSize: 14,
};

function ConsentCard({ onAnswer }: { onAnswer: (yes: boolean) => void }) {
  return (
    <div style={overlay} data-recorder-consent="1">
      <div style={card}>
        <h2 style={{ margin: "0 0 10px", fontSize: 18, color: "var(--hud-accent-amber)", fontFamily: "var(--hud-font-display)", letterSpacing: 1 }}>试玩记录说明</h2>
        <p style={{ margin: "0 0 8px" }}>
          这次试玩会记录你在本游戏内发送的文字、语音被系统听成的文字、你的操作和战场状态，用于改进游戏。
        </p>
        <p style={{ margin: "0 0 8px" }}>
          不保存原始录音，不录桌面，不记录游戏以外的任何东西。记录保存 14 天；想删除请联系邀请你的人。
        </p>
        <p style={{ margin: "0 0 16px", color: "var(--hud-text-secondary)" }}>
          不同意也可以照常玩，只是不记录。之后随时可以在地图左上方的记录条里停止记录。
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="hud-btn hud-btn-ghost" onClick={() => onAnswer(false)}>不记录，直接玩</button>
          <button className="hud-btn hud-btn-primary" onClick={() => onAnswer(true)}>同意并开始</button>
        </div>
      </div>
    </div>
  );
}

function Note({ text }: { text: string }) {
  const [shown, setShown] = useState(true);
  if (!shown) return null;
  return (
    <div style={{ position: "fixed", left: 240, top: 60, zIndex: 9000, maxWidth: 360, padding: "6px 10px", fontSize: 12,
      fontFamily: "var(--hud-font-mono)", color: "var(--hud-text-secondary)", background: "rgba(10,14,26,0.9)",
      border: "1px solid var(--hud-border-base)", borderRadius: 3 }}>
      {text} <button className="hud-btn hud-btn-ghost hud-btn-sm" style={{ marginLeft: 6 }} onClick={() => setShown(false)}>知道了</button>
    </div>
  );
}

const PHASE_TEXT: Record<RecorderStatus["phase"], string> = {
  recording: "记录中",
  degraded: "记录可能不完整",
  fault: "记录故障：上传失败，正在重试",
  off: "未记录",
  closed: "记录已由组织者关闭",
  revoked: "邀请已作废，已停止记录",
  withdrawn: "已停止记录",
};
const PHASE_COLOR: Record<RecorderStatus["phase"], string> = {
  recording: "var(--hud-accent-green)", degraded: "var(--hud-accent-amber)", fault: "var(--hud-accent-red)",
  off: "var(--hud-text-dim)", closed: "var(--hud-text-dim)", revoked: "var(--hud-text-dim)", withdrawn: "var(--hud-text-dim)",
};

function RecorderWidget({ onWithdrawn }: { onWithdrawn: () => void }) {
  const [st, setSt] = useState<RecorderStatus | null>(recorderStatus());
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagText, setFlagText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [endAsked, setEndAsked] = useState<string | null>(null);
  const [endText, setEndText] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    setSt(recorderStatus());
    return subscribeRecorderStatus(setSt);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!st) return null;
  const live = st.phase === "recording" || st.phase === "degraded" || st.phase === "fault";
  const showEnd = live && st.gameOver && st.runId && endAsked !== st.runId;
  const box: CSSProperties = {
    // 顶栏之下、左上角选中单位信息框（约 8–230px）的右侧：不压任务条、不压选中信息、不压聊天面板。
    position: "fixed", left: 240, top: 60, zIndex: 9000, fontFamily: "var(--hud-font-mono)", fontSize: 12,
    color: "var(--hud-text-primary)", background: "rgba(10,14,26,0.88)", border: "1px solid var(--hud-border-base)",
    borderRadius: 3, padding: "6px 10px", maxWidth: 380, pointerEvents: "auto",
  };
  const detail = st.phase === "fault" ? "（游戏不受影响）"
    : st.queued > 0 && st.phase !== "withdrawn" && st.phase !== "closed" && st.phase !== "revoked" ? `· ${st.queued} 条待上传` : "";
  return (
    <div style={box} data-recorder-widget="1" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: PHASE_COLOR[st.phase], display: "inline-block" }} />
        <span data-recorder-phase={st.phase}>{PHASE_TEXT[st.phase]} {detail}</span>
        {live && !flagOpen && (
          <button className="hud-btn hud-btn-warning hud-btn-sm" data-recorder-flag="1" onClick={() => setFlagOpen(true)}>这里有问题</button>
        )}
        {live && !confirmStop && !more && (
          <button className="hud-btn hud-btn-ghost hud-btn-sm" title="更多" onClick={() => setMore(true)}>⋯</button>
        )}
        {live && !confirmStop && more && (
          <button className="hud-btn hud-btn-ghost hud-btn-sm" onClick={() => { setMore(false); setConfirmStop(true); }}>停止记录</button>
        )}
      </div>
      {confirmStop && (
        <div style={{ marginTop: 6 }}>
          停止之后本局不再记录，本机还没上传的记录会删除；已经上传的不会自动删除（要删请联系邀请你的人）。
          <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
            <button className="hud-btn hud-btn-danger hud-btn-sm" onClick={() => { withdrawRecording(); setConfirmStop(false); onWithdrawn(); setToast("已停止记录：本机未上传的记录已删除。"); }}>确定停止</button>
            <button className="hud-btn hud-btn-ghost hud-btn-sm" onClick={() => { setConfirmStop(false); setMore(false); }}>继续记录</button>
          </div>
        </div>
      )}
      {flagOpen && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={flagText} maxLength={500} rows={3} autoFocus placeholder="（可选）一句话说说哪里不对，游戏不会暂停"
            onChange={(e) => setFlagText(e.target.value)}
            style={{ width: 340, maxWidth: "100%", fontFamily: "inherit", fontSize: 12, background: "var(--hud-bg-tertiary)", color: "var(--hud-text-primary)", border: "1px solid var(--hud-border-bright)" }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button className="hud-btn hud-btn-primary hud-btn-sm" data-recorder-flag-submit="1" onClick={() => {
              const ok = flagProblem(flagText.trim());
              setFlagOpen(false); setFlagText("");
              setToast(ok ? "已标记这一刻（游戏没有暂停）" : "没能标记：现在没有在记录");
            }}>标记</button>
            <button className="hud-btn hud-btn-ghost hud-btn-sm" onClick={() => { setFlagOpen(false); setFlagText(""); }}>取消</button>
          </div>
        </div>
      )}
      {showEnd && (
        <div style={{ marginTop: 6 }}>
          这一局结束了。想说一句感受吗？（可选）
          <textarea value={endText} maxLength={1000} rows={2} onChange={(e) => setEndText(e.target.value)}
            style={{ width: 340, maxWidth: "100%", display: "block", marginTop: 4, fontFamily: "inherit", fontSize: 12, background: "var(--hud-bg-tertiary)", color: "var(--hud-text-primary)", border: "1px solid var(--hud-border-bright)" }} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button className="hud-btn hud-btn-primary hud-btn-sm" onClick={() => { if (endText.trim()) submitEndFeedback(endText.trim()); setEndAsked(st.runId); setEndText(""); setToast(endText.trim() ? "谢谢，已记下" : null); }}>提交</button>
            <button className="hud-btn hud-btn-ghost hud-btn-sm" onClick={() => { setEndAsked(st.runId); setEndText(""); }}>不用了</button>
          </div>
        </div>
      )}
      {toast && <div style={{ marginTop: 4, color: "var(--hud-accent-cyan)" }}>{toast}</div>}
    </div>
  );
}

function initialView(b: BootState): GateView {
  switch (b.kind) {
    case "none": return { kind: "play" };
    case "no_storage": return { kind: "note", text: "本次不记录（浏览器不允许本地存储），游戏照常。" };
    case "ask": return { kind: "checking" };
    case "granted": return { kind: "activating" };
    case "declined": return { kind: "play" };
  }
}

/**
 * 这一页的同意流程已经走完的结果。BOOT 是页面加载那一刻的快照；万一这个组件被重新挂载
 * （开发时的热更新会这样），不许凭旧快照再问一遍、也不许重复激活。
 */
let settled: { widget: boolean; note: string | null } | null = null;

export function RecorderGate({ children }: { children: ReactNode }) {
  const [view, setViewRaw] = useState<GateView>(() => (settled ? (settled.note ? { kind: "note", text: settled.note } : { kind: "play" }) : initialView(BOOT)));
  const [widget, setWidgetRaw] = useState(() => settled?.widget ?? false);
  const setView = (v: GateView) => {
    if (v.kind === "play" || v.kind === "note") settled = { widget: settled?.widget ?? false, note: v.kind === "note" ? v.text : null };
    setViewRaw(v);
  };
  const setWidget = (w: boolean) => { settled = { widget: w, note: settled?.note ?? null }; setWidgetRaw(w); };
  useEffect(() => {
    if (settled) return;
    const b = BOOT;
    if (b.kind === "declined") { void startBacklogUploader({ apiUrl: API_URL }); return; }
    if (b.kind === "granted") {
      void activateRecorder(b.identity.token, { apiUrl: API_URL }).then(() => { setWidget(true); setView({ kind: "play" }); });
      return;
    }
    if (b.kind === "ask") {
      void serverStatus(b.identity.token).then((s) => {
        if (s === "closed") setView({ kind: "note", text: "组织者已关闭记录，本次不记录，游戏照常。" });
        else if (s === "invite_revoked") setView({ kind: "note", text: "这个邀请已作废，本次不记录，游戏照常。" });
        else if (s === "invite_unknown") setView({ kind: "note", text: "邀请链接无效，本次不记录，游戏照常。" });
        else setView({ kind: "ask" });
      });
    }
  }, []);
  if (view.kind === "checking" || view.kind === "activating") {
    return <div style={overlay}><div style={{ fontSize: 13, color: "var(--hud-text-secondary)" }}>准备中…</div></div>;
  }
  if (view.kind === "ask" && BOOT.kind === "ask") {
    const identity = BOOT.identity;
    return <ConsentCard onAnswer={(yes) => {
      if (!yes) {
        saveConsent(identity, "declined");
        void startBacklogUploader({ apiUrl: API_URL });
        setView({ kind: "play" });
        return;
      }
      if (!saveConsent(identity, "granted")) { setView({ kind: "note", text: "本次不记录（浏览器不允许本地存储），游戏照常。" }); return; }
      setView({ kind: "activating" });
      void activateRecorder(identity.token, { apiUrl: API_URL }).then(() => { setWidget(true); setView({ kind: "play" }); });
    }} />;
  }
  return (
    <>
      {children}
      {view.kind === "note" && <Note text={view.text} />}
      {widget && <RecorderWidget onWithdrawn={() => {
        if (BOOT.kind === "granted" || BOOT.kind === "ask") saveConsent(BOOT.identity, "withdrawn");
      }} />}
    </>
  );
}
