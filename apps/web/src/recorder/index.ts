// ============================================================
// 试玩记录仪 V1 · 浏览器侧入口（单例＋弹出面板委派）
//
// **主游戏窗口是本局记录的唯一 owner。** 弹出的聊天面板（?mode=panel）没有自己的记录器：
// 它的 trace / TTS / 操作经 `window.opener.__GAME_BRIDGE__.recorder` 交给主窗那一份。
// 消息不走这里转：弹窗的消息仓库本来就委派给主窗，只在主窗 messageStore 的变更点记。
//
// “关闭”＝每个入口第一行就返回（没邀请、没同意、撤回、采集关闭都是这个状态）。
// 本模块在 node 里也能 import（不碰 import.meta.env、不在顶层碰 window）。
// ============================================================

import type { GameState } from "@ai-commander/shared";
import { RecorderCore, DEFAULT_CORE_LIMITS, type CoreDeps, type CoreLimits, type RecorderStatus } from "./core";
import { IdbBackend, MemoryBackend, type QueueBackend } from "./queue";
import type { SnapshotExtras } from "./snapshot";

export type { RecorderStatus } from "./core";

const IS_PANEL: boolean = (() => {
  try { return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "panel"; }
  catch { return false; }
})();

let core: RecorderCore | null = null;
/** 主窗：记录器已激活；弹窗：恒为 true（去问主窗那一份）。 */
let on = IS_PANEL;

/** 主窗挂到桥上的那几个入口（弹窗只转这些）。 */
export interface RecorderBridgeApi {
  recordTrace: typeof recordTrace;
  recordTts: typeof recordTts;
  recordOp: typeof recordOp;
  recorderHeaders: typeof recorderHeaders;
}

function openerApi(): RecorderBridgeApi | null {
  try {
    const b = (window.opener as unknown as { __GAME_BRIDGE__?: { recorder?: RecorderBridgeApi } } | null)?.__GAME_BRIDGE__;
    return b?.recorder ?? null;
  } catch { return null; }
}

/** 既有 traceClient 的旁观挂点（advisorTrace.ts 调它）。 */
export function recordTrace(traceId: unknown, stage: string, data: Record<string, unknown>, state?: unknown, turnFrom?: "current"): void {
  if (!on) return;
  try {
    if (IS_PANEL) { openerApi()?.recordTrace(traceId, stage, data, state, turnFrom); return; }
    core?.trace(traceId, stage, data, state, turnFrom);
  } catch { /* 纯观测 */ }
}

/** messageStore 三个变更点（只在主窗那一份上调用）。 */
export function recordMessage(op: "add" | "update" | "clear", fields: Record<string, unknown>): void {
  if (!on || IS_PANEL) return;
  try { core?.message(op, fields); } catch { /* 纯观测 */ }
}

export function recordTts(text: unknown, persona: unknown, via: "speak" | "utterance"): void {
  if (!on) return;
  try {
    if (IS_PANEL) { openerApi()?.recordTts(text, persona, via); return; }
    core?.tts(text, persona, via);
  } catch { /* 纯观测 */ }
}

export function recordOp(kind: string, fields: Record<string, unknown> = {}): void {
  if (!on) return;
  try {
    if (IS_PANEL) { openerApi()?.recordOp(kind, { ...fields, window: "panel" }); return; }
    core?.op(kind, fields);
  } catch { /* 纯观测 */ }
}

/** 命令请求的观测头（局号＋凭证）；没在记录就是空对象，请求与今天逐字节相同。 */
export function recorderHeaders(state: unknown): Record<string, string> {
  if (!on) return {};
  try {
    if (IS_PANEL) {
      const h = openerApi()?.recorderHeaders(state);
      return h ? { ...h } : {};
    }
    return core?.headers(state) ?? {};
  } catch { return {}; }
}

/** 进局元数据里只收这几个地址参数（非敏感、影响玩法的开关）；邀请早已从地址栏抹掉。 */
const PARAM_WHITELIST = ["scenario", "nofog", "intro", "webspeech", "novoicewarm", "nag", "expire"];

export function recordStartRun(state: GameState, params: { search?: string; restart?: boolean }): void {
  if (!on || IS_PANEL) return;
  try {
    const url: Record<string, string> = {};
    try {
      const p = new URLSearchParams(params.search ?? "");
      for (const k of PARAM_WHITELIST) { const v = p.get(k); if (v !== null) url[k] = v.slice(0, 40); }
    } catch { /* 取不到就不带 */ }
    core?.startRun(state, { url, restart: params.restart === true || undefined });
  } catch { /* 纯观测 */ }
}

export function recordGameEnd(state: GameState, info: Record<string, unknown>): void {
  if (!on || IS_PANEL) return;
  try { core?.gameEnd(state, info); } catch { /* 纯观测 */ }
}

export function recordManualOrder(state: GameState, orders: unknown[], via: string): void {
  if (!on || IS_PANEL) return;
  try { core?.manualOrder(state, orders, via); } catch { /* 纯观测 */ }
}

export function setRecorderExtras(fn: (() => SnapshotExtras) | null): void {
  if (IS_PANEL) return;
  try { core?.setExtrasProvider(fn); } catch { /* 纯观测 */ }
}

export function flagProblem(text: string): boolean {
  if (!on || IS_PANEL) return false;
  try { return core?.flag(text) ?? false; } catch { return false; }
}

export function submitEndFeedback(text: string): boolean {
  if (!on || IS_PANEL) return false;
  try { return core?.feedback(text) ?? false; } catch { return false; }
}

export function withdrawRecording(): void {
  try { core?.withdraw(); } catch { /* 纯观测 */ }
  on = IS_PANEL ? on : false;
}

export function recorderStatus(): RecorderStatus | null {
  try { return core?.status() ?? null; } catch { return null; }
}

export function subscribeRecorderStatus(fn: (s: RecorderStatus) => void): () => void {
  try { return core?.subscribe(fn) ?? (() => {}); } catch { return () => {}; }
}

export const recorderBridgeApi: RecorderBridgeApi = { recordTrace, recordTts, recordOp, recorderHeaders };

export interface ActivateOptions {
  apiUrl: string;
  deps?: Partial<CoreDeps>;
  backend?: QueueBackend;
  limits?: Partial<CoreLimits>;
}

function defaultDeps(apiUrl: string): CoreDeps {
  return {
    now: () => Date.now(),
    randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    fetch: (url, init) => fetch(url, init),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    apiUrl,
  };
}

/**
 * 整页只建一个核心。★必须共用同一个“正在建”的承诺：同意框的 effect 在 StrictMode 下会跑两遍，
 * 两次调用都在 await 期间看到 core 为空、各建一个——游戏的局记在第一个上，第二个又把它顶掉
 * （浏览器手测抓到：记录中、却“没能标记”，命令也不带记录头）。
 */
let corePromise: Promise<RecorderCore> | null = null;
function makeCore(opts: ActivateOptions): Promise<RecorderCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const backend = opts.backend ?? (await IdbBackend.open()) ?? new MemoryBackend();
      return new RecorderCore({ ...defaultDeps(opts.apiUrl), ...opts.deps }, backend, { ...DEFAULT_CORE_LIMITS, ...opts.limits });
    })();
  }
  return corePromise;
}

/** 关页（浏览器里由 pagehide 触发）。`persisted`＝进了往返缓存、可能原样回来。 */
export function notifyPageHide(persisted = false): void {
  try { core?.pagehide(persisted); } catch { /* 尽力 */ }
}

let lifecycleWired = false;
function wireLifecycle(): void {
  if (lifecycleWired || typeof window === "undefined") return;
  lifecycleWired = true;
  try {
    window.addEventListener("pagehide", (e) => notifyPageHide((e as PageTransitionEvent).persisted === true));
    document.addEventListener("visibilitychange", () => { try { core?.visibility(document.visibilityState === "hidden"); } catch { /* 尽力 */ } });
  } catch { /* 纯观测 */ }
}

/** 同意之后：开始记录（主窗）。 */
export async function activateRecorder(token: string, opts: ActivateOptions): Promise<void> {
  if (IS_PANEL) return;
  try {
    core = await makeCore(opts);
    if (!core.isActive()) core.activate(token);
    on = true;
    wireLifecycle();
  } catch { on = false; }
}

/** 没在记录，但本机还有别的凭证名下没传完的积压：只负责传完。 */
export async function startBacklogUploader(opts: ActivateOptions): Promise<void> {
  if (IS_PANEL) return;
  try {
    core = await makeCore(opts);
    core.startBacklogOnly();
    wireLifecycle();
  } catch { /* 纯观测 */ }
}

export const RECORDER_IS_PANEL = IS_PANEL;
