// ============================================================
// 试玩记录仪 V1 · 浏览器侧核心（纯逻辑＋注入的时钟/随机/网络/持久层，node 台架可直接跑）
//
// 硬纪律（workplan §3）：
//   · 只观察：每个入口第一行 `if (!this.active) return;`，其余全在 try/catch 里；
//     取数、复制、白名单都在这里做，调用点只递手头现成的值。
//   · 不等上传、不等落盘；不在渲染热循环里做重活（快照走定时器、上传走定时器）。
//   · 不用全局伪随机数：编号与退避抖动一律来自注入的安全随机源（crypto.getRandomValues）。
//   · 认局：GameState 对象身份 → 本局记录（WeakMap）。手里没有出发 state 的观察点
//     （消息/TTS/操作/问题按钮）按主窗当前局记，并打固定字段 runFrom:"current"。
// ============================================================

import type { GameState } from "@ai-commander/shared";
import {
  REC_PROTOCOL_VERSION, REC_BATCH_MAX_BYTES, REC_EVENT_MAX_BYTES, REC_TURN_RE, REC_HEADER_INVITE, REC_HEADER_RUN,
  recBoundedCopy, recEventClass, recUtf8Bytes, type RecEvent,
} from "@ai-commander/shared/src/recorderProtocol";
import { classifyUploadResponse } from "./uploadVerdict";
import type { QItem, QueueBackend } from "./queue";
import { buildSnapshot, type SnapshotExtras } from "./snapshot";

export interface CoreDeps {
  now: () => number;
  /** 安全随机字节（浏览器 crypto.getRandomValues）。 */
  randomBytes: (n: number) => Uint8Array;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; keepalive?: boolean }) => Promise<{ status: number; text: () => Promise<string> }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  apiUrl: string;
}

export interface CoreLimits {
  cacheMaxBytes: number;
  memoryOnlyMaxBytes: number;
  sampleIntervalMs: number;
  uploadBusyMs: number;
  uploadIdleMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  requestTimeoutMs: number;
  /** 连续失败几次算“故障”（显示给玩家）。 */
  faultAfterFailures: number;
}

export const DEFAULT_CORE_LIMITS: CoreLimits = {
  cacheMaxBytes: 20 * 1024 * 1024,
  memoryOnlyMaxBytes: 4 * 1024 * 1024,
  sampleIntervalMs: 10_000,
  uploadBusyMs: 1500,
  uploadIdleMs: 4000,
  backoffMinMs: 2000,
  backoffMaxMs: 60_000,
  requestTimeoutMs: 15_000,
  faultAfterFailures: 3,
};

export type RecorderPhase = "off" | "recording" | "degraded" | "fault" | "closed" | "revoked" | "withdrawn";

export interface RecorderStatus {
  phase: RecorderPhase;
  queued: number;
  queuedBytes: number;
  lastAckAt: number;
  drops: { critical: number; sample: number; rejected: number };
  memoryOnly: boolean;
  fault: string | null;
  failures: number;
  runId: string | null;
  flags: number;
  gameOver: boolean;
}

interface Drops { critical: number; sample: number; rejected: number }
/**
 * 一局在本页的记录状态。★生产者编号按“本页 × 本局”各给一个：序号在每局里从 1 起，
 * 若整页共用一个生产者编号，第二局的 `pid:1` 会与第一局的撞号（台架 C17 抓到的）。
 */
interface RunRec { runId: string; pid: string; token: string; seq: number; drops: Drops; reported: string; foreign: boolean }

const LONG_KEYS: ReadonlySet<string> = new Set(["text", "raw"]);

function b64url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) { const n = bytes[i] << 16; out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63]; }
  else if (rest === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63]; }
  return out;
}

export class RecorderCore {
  private active = false;
  private token: string | null = null;
  private runs = new WeakMap<object, RunRec>();
  private runsById = new Map<string, RunRec>();
  private current: { state: GameState; rec: RunRec } | null = null;
  private queue = new Map<string, QItem>();
  private queueBytes = 0;
  private toPersist: QItem[] = [];
  private toRemove: string[] = [];
  private persistTimer: unknown = null;
  private uploadTimer: unknown = null;
  private sampleTimer: unknown = null;
  private inflight = false;
  private backoffMs = 0;
  private failures = 0;
  private fault: string | null = null;
  private splitLimit = Number.POSITIVE_INFINITY;
  private samplingPaused = false;
  private memoryOnly: boolean;
  private orderSeq = 0;
  private lastTurn: string | null = null;
  private lastSampleGt = -1;
  private stopReason: RecorderPhase = "off";
  private lastAckAt = 0;
  private flagsCount = 0;
  private gameOver = false;
  private listeners = new Set<(s: RecorderStatus) => void>();
  private lastStatusKey = "";
  private extras: (() => SnapshotExtras) | null = null;
  /** 在任何一局开始之前到来的观察（没有局可归）：超出暂存上限的只计数，写进下一局的 run_start。 */
  private preRun = 0;
  /**
   * 本页第一局开局之前的少量观察（聊天面板挂载时的静音/频道/页签、开场暂停……）：它们发生在
   * 同一页、同一玩家、第一局建立之前的那一瞬，暂存下来接到本页**第一局**的开头，并标 preRun:true。
   * 只收“局取自当前局”这一类（消息/TTS/操作）；带着出发 state 的 trace 不在此列（不猜归属）。
   */
  private preRunBuffer: { type: string; d: Record<string, unknown>; trunc: string[] }[] = [];
  private firstRunStarted = false;
  /** 手里有 state、但那个 state 不是我们开过的局（不猜归属，只计数）。 */
  private unattributed = 0;
  /** 记录器自己出过的错（只计数；游戏不受影响）。 */
  internalErrors = 0;

  constructor(private deps: CoreDeps, private backend: QueueBackend, private limits: CoreLimits = DEFAULT_CORE_LIMITS) {
    this.memoryOnly = backend.kind === "memory";
  }

  // ── 生命周期 ───────────────────────────────────────────────

  /** 同意之后开始记录。先同步打开入口（开局就记得上），再异步接上旧队列。 */
  activate(token: string): void {
    this.token = token;
    this.active = true;
    this.stopReason = "recording";
    void this.loadBacklog();
    this.scheduleSample();
    this.notify();
  }

  /** 没同意（或换了测试者没同意）也要把旧凭证名下的积压传完：只上传，不记录。 */
  startBacklogOnly(): void {
    void this.loadBacklog();
  }

  private async loadBacklog(): Promise<void> {
    try {
      const items = await this.backend.loadAll();
      if (items.length === 0) return;
      const merged = new Map<string, QItem>();
      let bytes = 0;
      for (const it of items) { if (!this.queue.has(it.eid)) { merged.set(it.eid, it); bytes += it.bytes; } }
      for (const [k, v] of this.queue) merged.set(k, v);
      this.queue = merged;
      this.queueBytes += bytes;
      this.scheduleUpload(this.limits.uploadBusyMs);
      this.notify();
    } catch { this.internalErrors++; }
  }

  isActive(): boolean { return this.active; }

  setExtrasProvider(fn: (() => SnapshotExtras) | null): void { this.extras = fn; }

  // ── 入口（每个都：首行判开关，其余 try/catch）─────────────

  startRun(state: GameState, params: Record<string, unknown>): void {
    if (!this.active) return;
    try {
      if (this.runs.has(state)) return;
      const rec = this.newRun(this.token!);
      this.runs.set(state, rec);
      const prev = this.current;
      if (prev) this.emit(prev.rec, "run_end", { reason: "replaced" }, { gt: prev.state.time });
      this.current = { state, rec };
      this.gameOver = false;
      this.lastSampleGt = -1;
      this.emit(rec, "run_start", {
        scenario: state.scenarioId, params, protocol: REC_PROTOCOL_VERSION,
        preRunUnrecorded: this.preRun || undefined, storage: this.memoryOnly ? "memory" : "indexeddb",
      }, { gt: state.time });
      this.preRun = 0;
      if (!this.firstRunStarted) {
        this.firstRunStarted = true;
        for (const p of this.preRunBuffer) this.emit(rec, p.type, { ...p.d, preRun: true }, { gt: state.time, runFrom: "current" }, p.trunc);
      }
      this.preRunBuffer = [];
      if (this.memoryOnly) this.reportDrops(rec, true);
      this.keySnapshot(state, rec, "start");
      this.notify();
    } catch { this.internalErrors++; }
  }

  gameEnd(state: GameState, info: Record<string, unknown>): void {
    if (!this.active) return;
    try {
      const rec = this.runs.get(state);
      if (!rec) { this.unattributed++; return; }
      this.emit(rec, "game_end", this.copy(info), { gt: state.time });
      if (this.current?.state === state) this.gameOver = true;
      this.keySnapshot(state, rec, "end");
      this.notify();
    } catch { this.internalErrors++; }
  }

  /**
   * 既有 traceClient 取数点：`state`＝调用点手里的出发 state（认局）；`turnFrom`＝"current" 表示
   * traceId 读自 traceIdRef.current（认回合的固定字段）。
   */
  trace(traceId: unknown, stage: string, data: Record<string, unknown>, state?: unknown, turnFrom?: "current"): void {
    if (!this.active) return;
    try {
      const r = this.resolveRun(state);
      if (!r) return;
      const turn = typeof traceId === "string" && REC_TURN_RE.test(traceId) ? traceId : undefined;
      if (turn) this.lastTurn = turn;
      const trunc: string[] = [];
      const st = String(stage).slice(0, 40);
      const d = { stage: st, data: recBoundedCopy(data, trunc, { longKeys: LONG_KEYS }) };
      this.emit(r.rec, "trace", d, {
        gt: r.state?.time, turn, turnFrom: turn && turnFrom === "current" ? "current" : undefined, runFrom: r.runFrom,
      }, trunc.map((p) => `data.${p}`), { input: data, wrap: (x) => ({ stage: st, data: x }), prefix: "data." });
      if (stage === "exec" && r.state) this.keySnapshot(r.state, r.rec, "exec", turn);
    } catch { this.internalErrors++; }
  }

  /** messageStore 的三个变更点（只在主窗那一份上发生）。 */
  message(op: "add" | "update" | "clear", fields: Record<string, unknown>): void {
    if (!this.active) return;
    try {
      const trunc: string[] = [];
      const d = { op, ...(recBoundedCopy(fields, trunc) as Record<string, unknown>) };
      const cur = this.current;
      if (!cur) { this.holdPreRun("message", d, trunc); return; }
      this.emit(cur.rec, "message", d, { gt: cur.state.time, runFrom: "current" }, trunc);
    } catch { this.internalErrors++; }
  }

  /** 交给 TTS 的文字（不代表真的念出来、更不代表玩家听见）。 */
  tts(text: unknown, persona: unknown, via: "speak" | "utterance"): void {
    if (!this.active) return;
    try {
      const trunc: string[] = [];
      const d = recBoundedCopy({ text, persona, via }, trunc) as Record<string, unknown>;
      const cur = this.current;
      if (!cur) { this.holdPreRun("tts", d, trunc); return; }
      this.emit(cur.rec, "tts", d, { gt: cur.state.time, runFrom: "current" }, trunc);
    } catch { this.internalErrors++; }
  }

  op(kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.active) return;
    try {
      const trunc: string[] = [];
      const d = { kind: String(kind).slice(0, 40), ...(recBoundedCopy(fields, trunc) as Record<string, unknown>) };
      const cur = this.current;
      if (!cur) { this.holdPreRun("op", d, trunc); return; }
      this.emit(cur.rec, "op", d, { gt: cur.state.time, runFrom: "current" }, trunc);
    } catch { this.internalErrors++; }
  }

  /** 手动下令：在既有操作落点记下真实下出去的 order（不重跑 planner）。 */
  manualOrder(state: GameState, orders: unknown[], via: string): void {
    if (!this.active) return;
    try {
      const rec = this.runs.get(state);
      if (!rec) { this.unattributed++; return; }
      const list = orders.map((o) => {
        const x = o as Record<string, unknown>;
        return { action: x.action, unitIds: x.unitIds, target: x.target, targetUnitId: x.targetUnitId, targetFacilityId: x.targetFacilityId };
      });
      const trunc: string[] = [];
      this.emit(rec, "manual_order", { via, orders: recBoundedCopy(list, trunc), unitIds: recBoundedCopy(list.flatMap((o) => (Array.isArray(o.unitIds) ? o.unitIds : [])), trunc) }, { gt: state.time }, trunc);
      this.keySnapshot(state, rec, "manual");
    } catch { this.internalErrors++; }
  }

  /** “这里有问题”：记时刻、最近的回合、可选描述，并补一份关键快照。 */
  flag(text: unknown): boolean {
    if (!this.active) return false;
    try {
      const cur = this.current;
      if (!cur) return false;
      const t = typeof text === "string" ? text.slice(0, 500) : "";
      this.emit(cur.rec, "flag", { text: t }, {
        gt: cur.state.time, runFrom: "current", turn: this.lastTurn ?? undefined, turnFrom: this.lastTurn ? "current" : undefined,
      });
      this.flagsCount++;
      this.keySnapshot(cur.state, cur.rec, "flag", this.lastTurn ?? undefined);
      this.notify();
      return true;
    } catch { this.internalErrors++; return false; }
  }

  feedback(text: unknown): boolean {
    if (!this.active) return false;
    try {
      const cur = this.current;
      if (!cur) return false;
      const t = typeof text === "string" ? text.slice(0, 1000) : "";
      this.emit(cur.rec, "feedback", { text: t }, { gt: cur.state.time, runFrom: "current" });
      return true;
    } catch { this.internalErrors++; return false; }
  }

  /** 命令请求上的观测头（局号＋凭证）。游戏请求体一个字节不动。 */
  headers(state: unknown): Record<string, string> {
    if (!this.active) return {};
    try {
      const rec = state && typeof state === "object" ? this.runs.get(state) : undefined;
      if (!rec) return {};
      return { [REC_HEADER_INVITE]: rec.token, [REC_HEADER_RUN]: rec.runId };
    } catch { this.internalErrors++; return {}; }
  }

  /** 玩家撤回同意：立刻停采；本凭证名下还没上传的缓存当场清空；已上传的不动。 */
  withdraw(): void {
    try {
      const tok = this.token;
      this.deactivate("withdrawn");
      if (tok) this.clearToken(tok);
    } catch { this.internalErrors++; }
  }

  /**
   * 关页：当前这一局记一条“页面卸载了”（事实：这一局的 GameState 随页面没了；不代表玩家主动退出），
   * 给本页开过的每一局写“最后序号”，把还没确认落到 IndexedDB 的那一截同步暂存并用 keepalive 送一次（尽力而为）。
   * `persisted`＝页面进了往返缓存、可能原样回来：这时只落盘，不写结束与最后序号。
   */
  pagehide(persisted = false): void {
    try {
      if (this.active && !persisted) {
        const cur = this.current;
        if (cur && !this.gameOver) this.emit(cur.rec, "run_end", { reason: "page_unload" }, { gt: cur.state.time });
        for (const rec of this.runsById.values()) {
          if (rec.foreign && rec.seq === 0) continue;
          this.emit(rec, "producer_close", { lastSeq: rec.seq + 1 });
        }
      }
      // IndexedDB 在卸载时多半写不完：还没确认落盘的那一截同步暂存一份（下次加载并回队列）。
      const tail = this.toPersist.filter((it) => this.queue.has(it.eid));
      if (tail.length && this.backend.stashSync) this.backend.stashSync(tail);
      this.flushPersistNow();
      this.keepaliveFlush();
    } catch { this.internalErrors++; }
  }

  visibility(hidden: boolean): void {
    if (!this.active) return;
    try {
      this.op("visibility", { hidden });
      if (hidden) this.flushPersistNow();
    } catch { this.internalErrors++; }
  }

  // ── 状态 ───────────────────────────────────────────────────

  status(): RecorderStatus {
    const drops: Drops = { critical: 0, sample: 0, rejected: 0 };
    for (const r of this.runsById.values()) { drops.critical += r.drops.critical; drops.sample += r.drops.sample; drops.rejected += r.drops.rejected; }
    let phase: RecorderPhase;
    if (!this.active) phase = this.stopReason === "recording" ? "off" : this.stopReason;
    else if (this.failures >= this.limits.faultAfterFailures) phase = "fault";
    else if (this.memoryOnly || drops.critical + drops.sample + drops.rejected > 0) phase = "degraded";
    else phase = "recording";
    return {
      phase, queued: this.queue.size, queuedBytes: this.queueBytes, lastAckAt: this.lastAckAt, drops,
      memoryOnly: this.memoryOnly, fault: this.fault, failures: this.failures,
      runId: this.current?.rec.runId ?? null, flags: this.flagsCount, gameOver: this.gameOver,
    };
  }

  subscribe(fn: (s: RecorderStatus) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    try {
      const s = this.status();
      const key = `${s.phase}|${s.queued}|${s.drops.critical}|${s.drops.sample}|${s.drops.rejected}|${s.fault}|${s.runId}|${s.flags}|${s.gameOver}`;
      if (key === this.lastStatusKey) return;
      this.lastStatusKey = key;
      for (const fn of this.listeners) { try { fn(s); } catch { /* UI 的错不回流 */ } }
    } catch { this.internalErrors++; }
  }

  // ── 内部 ───────────────────────────────────────────────────

  private newRun(token: string): RunRec {
    const rec: RunRec = { runId: `r${b64url(this.deps.randomBytes(15))}`, pid: this.newPid(), token, seq: 0, drops: { critical: 0, sample: 0, rejected: 0 }, reported: "", foreign: false };
    this.runsById.set(rec.runId, rec);
    return rec;
  }

  private holdPreRun(type: string, d: Record<string, unknown>, trunc: string[]): void {
    if (this.firstRunStarted || this.preRunBuffer.length >= 50) { this.preRun++; return; }
    this.preRunBuffer.push({ type, d, trunc });
  }

  private newPid(): string {
    return `c${b64url(this.deps.randomBytes(12))}`;
  }

  private resolveRun(state: unknown): { rec: RunRec; state: GameState | null; runFrom?: "current" } | null {
    if (state && typeof state === "object") {
      const rec = this.runs.get(state);
      if (rec) return { rec, state: state as GameState };
      this.unattributed++;
      return null;
    }
    const cur = this.current;
    if (!cur) { this.preRun++; return null; }
    return { rec: cur.rec, state: cur.state, runFrom: "current" };
  }

  private copy(v: Record<string, unknown>): Record<string, unknown> {
    return recBoundedCopy(v, []) as Record<string, unknown>;
  }

  private emit(rec: RunRec, type: string, d: Record<string, unknown>,
    extra: { gt?: number; turn?: string; turnFrom?: "current"; runFrom?: "current" } = {}, trunc: string[] = [],
    /** 原始输入：单条超上限时从它重新复制（截断计数才准），而不是在已截过的副本上再截。 */
    raw?: { input: unknown; wrap: (copied: unknown) => Record<string, unknown>; prefix: string }): string | null {
    rec.seq += 1;
    const seq = rec.seq;
    let ev: RecEvent = {
      v: REC_PROTOCOL_VERSION, eid: `${rec.pid}:${seq}`, pid: rec.pid, seq, run: rec.runId, src: "client", type,
      ct: this.deps.now(), d,
    };
    if (typeof extra.gt === "number" && Number.isFinite(extra.gt)) ev.gt = Math.round(extra.gt * 100) / 100;
    if (extra.turn) ev.turn = extra.turn;
    if (extra.turnFrom) ev.turnFrom = extra.turnFrom;
    if (extra.runFrom) ev.runFrom = extra.runFrom;
    if (trunc.length) ev.trunc = trunc.slice(0, 100);
    let body = JSON.stringify(ev);
    let bytes = recUtf8Bytes(body);
    // 单条超上限（中文按 UTF-8 算，1.6 万字就是 48 KB）：逐级收紧文字与数组上限再装，截在哪儿都记进 trunc；
    // 实在装不下才留一条“这里本有一条多大的什么”，不静默吞掉。
    for (const cap of [4000, 1000, 200]) {
      if (bytes <= REC_EVENT_MAX_BYTES) break;
      const more: string[] = [];
      const opts = { textMax: cap, arrayMax: cap >= 1000 ? 200 : 50 };
      const d2 = raw
        ? raw.wrap(recBoundedCopy(raw.input, more, opts))
        : recBoundedCopy(d, more, opts) as Record<string, unknown>;
      const merged = [...new Set([...(raw ? [] : ev.trunc ?? []), ...more.map((p) => (raw ? raw.prefix + p : p))])].slice(0, 100);
      ev = { ...ev, d: d2, ...(merged.length ? { trunc: merged } : {}) };
      body = JSON.stringify(ev);
      bytes = recUtf8Bytes(body);
    }
    if (bytes > REC_EVENT_MAX_BYTES) {
      ev = { ...ev, d: { tooLarge: true, bytes, stage: typeof d.stage === "string" ? d.stage : undefined, reason: typeof d.reason === "string" ? d.reason : undefined }, trunc: ["d"] };
      body = JSON.stringify(ev);
      bytes = recUtf8Bytes(body);
    }
    const cls = recEventClass(type, d);
    if (!this.admit(rec, cls, bytes)) return null;
    const item: QItem = { eid: ev.eid, run: rec.runId, token: rec.token, cls, bytes, body, order: this.deps.now() * 1000 + (this.orderSeq++ % 1000) };
    this.queue.set(item.eid, item);
    this.queueBytes += bytes;
    this.toPersist.push(item);
    this.schedulePersist();
    this.scheduleUpload(this.limits.uploadBusyMs);
    return ev.eid;
  }

  /** 缓存上限：采样先让路（停采并计数），关键事件挤掉本页最旧的采样；还挤不下才丢，且都计数。 */
  private admit(rec: RunRec, cls: "sample" | "critical", bytes: number): boolean {
    const cap = this.memoryOnly ? this.limits.memoryOnlyMaxBytes : this.limits.cacheMaxBytes;
    if (this.queueBytes + bytes <= cap) return true;
    if (cls === "sample") {
      rec.drops.sample++;
      this.samplingPaused = true;
      this.notify();
      return false;
    }
    for (const [eid, it] of this.queue) {
      if (this.queueBytes + bytes <= cap) break;
      if (it.cls !== "sample") continue;
      const owner = this.runsById.get(it.run);
      if (!owner || owner.foreign) continue;
      this.removeItem(eid);
      owner.drops.sample++;
    }
    if (this.queueBytes + bytes <= cap) { this.samplingPaused = true; this.notify(); return true; }
    rec.drops.critical++;
    this.notify();
    return false;
  }

  private reportDrops(rec: RunRec, force = false): void {
    const key = `${rec.drops.critical}|${rec.drops.sample}|${rec.drops.rejected}|${this.memoryOnly}`;
    if (!force && key === rec.reported) return;
    const eid = this.emit(rec, "drop_report", { ...rec.drops, memoryOnly: this.memoryOnly || undefined });
    if (eid) rec.reported = key;
  }

  private keySnapshot(state: GameState, rec: RunRec, reason: string, turn?: string): void {
    this.deps.setTimeout(() => {
      if (!this.active) return;
      try {
        this.emit(rec, "snapshot", buildSnapshot(state, reason, this.extras?.() ?? {}), { gt: state.time, turn });
      } catch { this.internalErrors++; }
    }, 0);
  }

  private scheduleSample(): void {
    if (this.sampleTimer) return;
    this.sampleTimer = this.deps.setTimeout(() => {
      this.sampleTimer = null;
      if (!this.active) return;
      try {
        const cur = this.current;
        const cap = this.memoryOnly ? this.limits.memoryOnlyMaxBytes : this.limits.cacheMaxBytes;
        if (this.samplingPaused && this.queueBytes < cap / 2) this.samplingPaused = false;
        if (cur && cur.state.time !== this.lastSampleGt) {
          if (this.samplingPaused) {
            cur.rec.drops.sample++; // 压力下停采：没采的那一份也记账
          } else {
            this.lastSampleGt = cur.state.time;
            this.emit(cur.rec, "snapshot", buildSnapshot(cur.state, "periodic", this.extras?.() ?? {}), { gt: cur.state.time });
          }
        }
      } catch { this.internalErrors++; }
      this.scheduleSample();
    }, this.limits.sampleIntervalMs);
  }

  private removeItem(eid: string): void {
    const it = this.queue.get(eid);
    if (!it) return;
    this.queue.delete(eid);
    this.queueBytes -= it.bytes;
    this.toRemove.push(eid);
    this.schedulePersist();
  }

  private clearToken(token: string): void {
    for (const [eid, it] of [...this.queue]) if (it.token === token) this.removeItem(eid);
    this.toPersist = this.toPersist.filter((it) => it.token !== token);
    this.flushPersistNow();
    this.notify();
  }

  private deactivate(reason: RecorderPhase): void {
    this.active = false;
    this.stopReason = reason;
    if (this.sampleTimer) { this.deps.clearTimeout(this.sampleTimer); this.sampleTimer = null; }
    this.notify();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = this.deps.setTimeout(() => { this.persistTimer = null; this.flushPersistNow(); }, 500);
  }

  private flushPersistNow(): void {
    if (this.persistTimer) { this.deps.clearTimeout(this.persistTimer); this.persistTimer = null; }
    const put = this.toPersist.filter((it) => this.queue.has(it.eid));
    const rm = this.toRemove;
    this.toPersist = [];
    this.toRemove = [];
    if (put.length) {
      void this.backend.put(put).then((ok) => {
        if (!ok && !this.memoryOnly) { this.memoryOnly = true; for (const r of this.runsById.values()) if (!r.foreign) this.reportDrops(r, true); this.notify(); }
      }).catch(() => { this.internalErrors++; });
    }
    if (rm.length) void this.backend.remove(rm).catch(() => { this.internalErrors++; });
  }

  private scheduleUpload(delayMs: number): void {
    if (this.uploadTimer || this.inflight) return;
    if (this.queue.size === 0) return;
    const d = this.backoffMs > 0 ? this.backoffMs : delayMs;
    this.uploadTimer = this.deps.setTimeout(() => { this.uploadTimer = null; void this.uploadOnce(); }, d);
  }

  /** 取最早那条所在的（局, 凭证）组，按序装满一批（≤64 KiB 字节）。 */
  private pickBatch(): { token: string; run: string; items: QItem[]; body: string } | null {
    let first: QItem | undefined;
    for (const it of this.queue.values()) { first = it; break; }
    if (!first) return null;
    const head = `{"v":${REC_PROTOCOL_VERSION},"run":${JSON.stringify(first.run)},"events":[`;
    let bytes = recUtf8Bytes(head) + 2;
    const items: QItem[] = [];
    for (const it of this.queue.values()) {
      if (it.run !== first.run || it.token !== first.token) continue;
      if (items.length >= Math.min(500, this.splitLimit)) break;
      if (items.length > 0 && bytes + it.bytes + 1 > REC_BATCH_MAX_BYTES) break;
      items.push(it);
      bytes += it.bytes + 1;
    }
    return { token: first.token, run: first.run, items, body: `${head}${items.map((i) => i.body).join(",")}]}` };
  }

  private async uploadOnce(): Promise<void> {
    if (this.inflight) return;
    const batch = this.pickBatch();
    if (!batch) return;
    this.inflight = true;
    let status = 0;
    let text = "";
    let timer: unknown = null;
    try {
      const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (ac) timer = this.deps.setTimeout(() => ac.abort(), this.limits.requestTimeoutMs);
      const res = await this.deps.fetch(`${this.deps.apiUrl}/api/rec/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [REC_HEADER_INVITE]: batch.token },
        body: batch.body,
        signal: ac?.signal,
      });
      status = res.status;
      try { text = await res.text(); } catch { text = ""; }
    } catch {
      status = 0;
    } finally {
      if (timer) this.deps.clearTimeout(timer);
      this.inflight = false;
    }
    try {
      this.applyVerdict(batch, status, text);
    } catch { this.internalErrors++; }
    this.scheduleUpload(this.queue.size > 0 ? 200 : this.limits.uploadIdleMs);
    this.notify();
  }

  private runRecFor(runId: string, token: string): RunRec {
    let rec = this.runsById.get(runId);
    if (!rec) {
      // 上一次页面加载留下的积压：本生产者没开过这一局，拒收计数也得有地方记。
      rec = { runId, pid: this.newPid(), token, seq: 0, drops: { critical: 0, sample: 0, rejected: 0 }, reported: "", foreign: true };
      this.runsById.set(runId, rec);
    }
    return rec;
  }

  private applyVerdict(batch: { token: string; run: string; items: QItem[] }, status: number, text: string): void {
    const v = classifyUploadResponse(status, text, batch.items.map((i) => i.eid));
    if (v.kind === "acked" || v.kind === "reject_named") {
      const acked = v.kind === "acked" ? v.acked : [];
      for (const e of acked) this.removeItem(e);
      if (v.rejected.length) {
        const rec = this.runRecFor(batch.run, batch.token);
        for (const r of v.rejected) { if (this.queue.has(r.eid)) { this.removeItem(r.eid); rec.drops.rejected++; } }
      }
      this.failures = 0;
      this.backoffMs = 0;
      this.fault = null;
      this.splitLimit = Number.POSITIVE_INFINITY;
      if (v.kind === "acked") this.lastAckAt = this.deps.now();
      // 有空间了：把积下的丢弃账补报一条（关键事件，进同一局）。
      if (this.active) for (const r of this.runsById.values()) if (r.drops.critical + r.drops.sample + r.drops.rejected > 0) this.reportDrops(r);
      return;
    }
    if (v.kind === "clear") {
      this.clearToken(batch.token);
      if (batch.token === this.token) this.deactivate(v.reason === "closed" ? "closed" : "revoked");
      this.failures = 0;
      this.backoffMs = 0;
      this.fault = null;
      return;
    }
    if (v.kind === "split") {
      this.splitLimit = Math.max(1, Math.floor(batch.items.length / 2));
      return;
    }
    // retry：原样保留、退避、显示故障。
    this.failures++;
    this.fault = v.fault;
    const jitter = this.deps.randomBytes(1)[0] / 255;
    const base = Math.min(this.limits.backoffMaxMs, Math.max(this.limits.backoffMinMs, this.backoffMs * 2));
    this.backoffMs = Math.round(base * (1 + 0.25 * jitter));
  }

  private keepaliveFlush(): void {
    const cur = this.current;
    const run = cur?.rec.runId ?? null;
    if (!run) return;
    // 最新的一截（多半还没确认落到 IndexedDB）优先：从队尾往前装满 64 KiB。
    const all = [...this.queue.values()].filter((i) => i.run === run && i.token === cur!.rec.token);
    const head = `{"v":${REC_PROTOCOL_VERSION},"run":${JSON.stringify(run)},"events":[`;
    let bytes = recUtf8Bytes(head) + 2;
    const pick: QItem[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      if (bytes + all[i].bytes + 1 > REC_BATCH_MAX_BYTES) break;
      pick.unshift(all[i]);
      bytes += all[i].bytes + 1;
    }
    if (pick.length === 0) return;
    try {
      void this.deps.fetch(`${this.deps.apiUrl}/api/rec/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [REC_HEADER_INVITE]: cur!.rec.token },
        body: `${head}${pick.map((i) => i.body).join(",")}]}`,
        keepalive: true,
      }).catch(() => {});
    } catch { /* 尽力而为 */ }
  }
}
