// ============================================================
// 试玩记录仪 · 服务端存储（单写入进程，按局追加写 JSONL）
//
// 事实源只有一种：`<dir>/runs/<runId>.jsonl`（每局一个）与 `<dir>/invites.jsonl`。
// 去重表、局列表、邀请表、runId → 测试者的绑定，**全部在启动时扫这些文件重建**；
// 不另建索引/元数据文件，所以不存在“先确认、后补写索引”的窗口。
//
// 耐久边界：一批行 `write` 之后 `fsync`（新建文件时再 fsync 一次目录）成功，才算落盘；
// 客户端的 ACK 只在这之后发出。Node 追加写的回调成功不算。
//
// 纪律：
//   · 写盘全部串行（一个 flush 循环），异步进行，不堵任何请求；
//   · 服务端自己的事实走有界队列：满了就丢并记数，下一次落盘写一条“丢了 N 条”的标记；
//   · 容量触顶只停新记录并告警，不阻断游戏。
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  REC_PROTOCOL_VERSION, REC_ID_RE, recCanonicalJson, recValidateClientEvent, recEventClass, recUtf8Bytes,
  recBoundedCopy, type RecEvent, type RecStoredLine,
} from "@ai-commander/shared/src/recorderProtocol";
import { RunSummary } from "./summary.js";

export interface StoreLimits {
  runMaxBytes: number;
  runSampleMaxBytes: number;
  globalMaxBytes: number;
  /** 全局预算里留给“丢了几条/冲突/修复”这类标记的余量。 */
  markerReserveBytes: number;
  maxRunsPerTester: number;
  retentionMs: number;
  /** 最近这段时间内还有事件的局＝进行中，永不清理。 */
  activeMs: number;
  serverFactQueueMax: number;
  /** 服务端事实的落盘节拍（毫秒）；客户端上传则立即落盘。 */
  factFlushMs: number;
}

export const DEFAULT_LIMITS: StoreLimits = {
  runMaxBytes: 25 * 1024 * 1024,
  runSampleMaxBytes: 20 * 1024 * 1024,
  globalMaxBytes: 250 * 1024 * 1024,
  markerReserveBytes: 1024 * 1024,
  maxRunsPerTester: 200,
  retentionMs: 14 * 24 * 3600 * 1000,
  activeMs: 24 * 3600 * 1000,
  serverFactQueueMax: 5000,
  factFlushMs: 200,
};

export interface InviteRecord { tid: string; hash: string; createdAt: number; revokedAt: number | null }

export type IngestOutcome =
  | { status: 200; body: { recorder: "ok"; acked: string[]; rejected: { eid: string; reason: string }[] } }
  | { status: 400; body: { recorder: "rejected"; rejected: { eid: string; reason: string }[] } | { recorder: "bad_batch"; reason: string } }
  | { status: 503; body: { recorder: "write_failed" | "shutting_down" } }
  | { status: 507; body: { recorder: "storage_full" } };

interface PendingWrite {
  file: string; lines: string[]; bytes: number; isNew: boolean;
  waiters: { resolve: () => void; reject: (e: unknown) => void }[];
}

interface RunInfo {
  summary: RunSummary;
  file: string;
  /** eid → 内容哈希（去重依据；与落盘内容一一对应）。 */
  eids: Map<string, string>;
  /** 已排队但还没 fsync 的 eid（同一 eid 的并发重传等同一次落盘）。 */
  pendingEids: Map<string, { hash: string; done: Promise<void> }>;
  conflictsLogged: Set<string>;
}

const hashOf = (e: RecEvent) => crypto.createHash("sha256").update(recCanonicalJson(e)).digest("hex").slice(0, 32);
export const tokenHash = (token: string) => crypto.createHash("sha256").update(`aic-rec-invite:${token}`).digest("hex");

export class RecorderStore {
  readonly dir: string;
  readonly runsDir: string;
  readonly invitesPath: string;
  readonly limits: StoreLimits;
  readonly bootId: string;
  readonly serverPid: string;
  private now: () => number;
  private runs = new Map<string, RunInfo>();
  private invites = new Map<string, InviteRecord>();
  private inviteByHash = new Map<string, string>();
  private totalBytes = 0;
  private pending = new Map<string, PendingWrite>();
  private pendingBytes = 0;
  /** 正在写的那一轮的字节（还没进 totalBytes，也不在 pending 里）。 */
  private inflightBytes = 0;
  private flushing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private srvSeq = new Map<string, number>();
  private factsQueued = 0;
  private factsDropped = new Map<string, number>();
  private quotaRejected = new Map<string, number>();
  private closing = false;
  /** 最近一次写盘失败（给管理员页与健康检查看；不含任何对话内容）。 */
  lastWriteError: { at: number; code: string } | null = null;
  buildInfo: Record<string, unknown> = {};

  private constructor(dir: string, limits: StoreLimits, now: () => number) {
    this.dir = dir;
    this.runsDir = path.join(dir, "runs");
    this.invitesPath = path.join(dir, "invites.jsonl");
    this.limits = limits;
    this.now = now;
    this.bootId = crypto.randomBytes(6).toString("base64url");
    this.serverPid = `srv-${this.bootId}`;
  }

  static async open(dir: string, limits: Partial<StoreLimits> = {}, opts: { now?: () => number; buildInfo?: Record<string, unknown> } = {}): Promise<RecorderStore> {
    const s = new RecorderStore(dir, { ...DEFAULT_LIMITS, ...limits }, opts.now ?? Date.now);
    s.buildInfo = opts.buildInfo ?? {};
    await fsp.mkdir(s.runsDir, { recursive: true });
    await s.scanInvites();
    await s.scanRuns();
    await s.sweepRetention();
    return s;
  }

  // ── 启动扫描 ───────────────────────────────────────────────

  private async scanInvites(): Promise<void> {
    let text = "";
    try { text = await fsp.readFile(this.invitesPath, "utf8"); } catch { return; }
    const end = text.lastIndexOf("\n");
    if (end < text.length - 1) {
      // 尾部半行＝未确认的写入（生成邀请的请求没收到成功应答），截掉。
      await fsp.truncate(this.invitesPath, Buffer.byteLength(text.slice(0, end + 1)));
      text = text.slice(0, end + 1);
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.k === "create" && typeof o.tid === "string" && typeof o.h === "string") {
        this.invites.set(o.tid, { tid: o.tid, hash: o.h, createdAt: Number(o.at) || 0, revokedAt: null });
        this.inviteByHash.set(o.h, o.tid);
      } else if (o.k === "revoke" && typeof o.tid === "string") {
        const r = this.invites.get(o.tid);
        if (r) r.revokedAt = Number(o.at) || 0;
      }
    }
  }

  private async scanRuns(): Promise<void> {
    const names = await fsp.readdir(this.runsDir);
    for (const name of names) {
      const m = /^([A-Za-z0-9_-]{8,64})\.jsonl$/.exec(name);
      if (!m) continue;
      const runId = m[1];
      const file = path.join(this.runsDir, name);
      let buf = await fsp.readFile(file);
      const lastNl = buf.lastIndexOf(0x0a);
      let tailBytes = 0;
      if (lastNl < buf.length - 1) {
        tailBytes = buf.length - (lastNl + 1);
        await fsp.truncate(file, lastNl + 1);
        buf = buf.subarray(0, lastNl + 1);
      }
      const info: RunInfo = { summary: new RunSummary(runId), file, eids: new Map(), pendingEids: new Map(), conflictsLogged: new Set() };
      let corrupt = 0;
      let start = 0;
      while (start < buf.length) {
        const nl = buf.indexOf(0x0a, start);
        const end = nl < 0 ? buf.length : nl;
        const raw = buf.subarray(start, end);
        start = end + 1;
        if (raw.length === 0) continue;
        let line: RecStoredLine;
        try { line = JSON.parse(raw.toString("utf8")); } catch { corrupt++; continue; }
        if (!line || typeof line !== "object" || typeof line.eid !== "string") { corrupt++; continue; }
        info.summary.absorb(line, raw.length + 1);
        const { rt: _rt, tid: _tid, ...event } = line;
        info.eids.set(line.eid, hashOf(event as RecEvent));
        if (line.type === "srv_marker" && (line.d as Record<string, unknown>)?.kind === "conflict") {
          const eid = (line.d as Record<string, unknown>).eid;
          if (typeof eid === "string") info.conflictsLogged.add(eid);
        }
      }
      if (info.summary.count === 0 && tailBytes === 0) continue;
      this.runs.set(runId, info);
      this.totalBytes += buf.length;
      if (tailBytes > 0) this.enqueueFact(runId, info.summary.tid, "srv_marker", undefined, { kind: "tail_repaired", bytes: tailBytes });
      if (corrupt > 0) this.enqueueFact(runId, info.summary.tid, "srv_marker", undefined, { kind: "corrupt_lines", count: corrupt });
    }
    if (this.pending.size > 0) await this.flush();
  }

  /** 到期清理：只删“最后一条事件早于保留期、且早于进行中窗口”的局。进行中的局不碰。 */
  async sweepRetention(): Promise<string[]> {
    const now = this.now();
    const removed: string[] = [];
    for (const [runId, info] of this.runs) {
      const last = info.summary.lastRt;
      if (now - last < this.limits.activeMs) continue;
      if (now - last < this.limits.retentionMs) continue;
      if (this.pending.has(info.file)) continue;
      try {
        const st = await fsp.stat(info.file);
        await fsp.unlink(info.file);
        this.totalBytes -= st.size;
      } catch { /* 已不在 */ }
      this.runs.delete(runId);
      removed.push(runId);
    }
    return removed;
  }

  // ── 邀请 ───────────────────────────────────────────────────

  private nextTesterCode(): string {
    // 匿名代号：A, B, …, Z, AA, AB …（只按生成顺序，不含任何真实身份）
    let n = this.invites.size;
    let s = "";
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  async createInvite(): Promise<{ tid: string; token: string }> {
    const token = crypto.randomBytes(24).toString("base64url");
    const h = tokenHash(token);
    let tid = this.nextTesterCode();
    while (this.invites.has(tid)) tid = `${tid}X`;
    await this.appendDurable(this.invitesPath, JSON.stringify({ k: "create", tid, h, at: this.now() }) + "\n");
    this.invites.set(tid, { tid, hash: h, createdAt: this.now(), revokedAt: null });
    this.inviteByHash.set(h, tid);
    return { tid, token };
  }

  async revokeInvite(tid: string): Promise<boolean> {
    const r = this.invites.get(tid);
    if (!r || r.revokedAt) return false;
    const at = this.now();
    await this.appendDurable(this.invitesPath, JSON.stringify({ k: "revoke", tid, at }) + "\n");
    r.revokedAt = at;
    return true;
  }

  /** 凭证 → 测试者。没有＝null；作废了照样返回（由调用方决定怎么答）。 */
  testerForToken(token: unknown): InviteRecord | null {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
    const tid = this.inviteByHash.get(tokenHash(token));
    return tid ? this.invites.get(tid) ?? null : null;
  }

  listInvites(): (InviteRecord & { runs: number })[] {
    const runsBy = new Map<string, number>();
    for (const r of this.runs.values()) runsBy.set(r.summary.tid, (runsBy.get(r.summary.tid) ?? 0) + 1);
    return [...this.invites.values()].map((i) => ({ ...i, hash: "", runs: runsBy.get(i.tid) ?? 0 }));
  }

  // ── 绑定与配额 ─────────────────────────────────────────────

  ownerOf(runId: string): string | null {
    return this.runs.get(runId)?.summary.tid ?? null;
  }

  private runsOfTester(tid: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.summary.tid === tid) n++;
    return n;
  }

  private ensureRun(runId: string, tid: string): RunInfo | null {
    const cur = this.runs.get(runId);
    if (cur) return cur.summary.tid === tid ? cur : null;
    const info: RunInfo = {
      summary: new RunSummary(runId), file: path.join(this.runsDir, `${runId}.jsonl`),
      eids: new Map(), pendingEids: new Map(), conflictsLogged: new Set(),
    };
    info.summary.tid = tid;
    this.runs.set(runId, info);
    // 首见即绑定：本进程为这一局写的第一条服务端事实＝构建与模型配置（非敏感白名单）。
    this.enqueueFact(runId, tid, "srv_run_meta", undefined, { ...this.buildInfo });
    return info;
  }

  private globalRoom(extra: number, marker = false): boolean {
    const cap = this.limits.globalMaxBytes - (marker ? 0 : this.limits.markerReserveBytes);
    return this.totalBytes + this.pendingBytes + this.inflightBytes + extra <= cap;
  }

  // ── 客户端上传 ─────────────────────────────────────────────

  async ingest(tid: string, runId: unknown, rawEvents: unknown): Promise<IngestOutcome> {
    if (this.closing) return { status: 503, body: { recorder: "shutting_down" } };
    if (typeof runId !== "string" || !REC_ID_RE.test(runId)) return { status: 400, body: { recorder: "bad_batch", reason: "bad_run" } };
    if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > 2000) {
      return { status: 400, body: { recorder: "bad_batch", reason: "bad_events" } };
    }
    const eidOf = (x: unknown) => (x && typeof x === "object" && typeof (x as Record<string, unknown>).eid === "string"
      ? String((x as Record<string, unknown>).eid).slice(0, 64) : "?");
    const owner = this.ownerOf(runId);
    if (owner && owner !== tid) {
      // 知道 runId 也写不进别人的局：整批点名拒收（不泄露归属）。
      return { status: 400, body: { recorder: "rejected", rejected: rawEvents.map((x) => ({ eid: eidOf(x), reason: "run_forbidden" })) } };
    }
    if (!owner && this.runsOfTester(tid) >= this.limits.maxRunsPerTester) {
      return { status: 400, body: { recorder: "rejected", rejected: rawEvents.map((x) => ({ eid: eidOf(x), reason: "tester_run_limit" })) } };
    }
    const acked: string[] = [];
    const rejected: { eid: string; reason: string }[] = [];
    const waits: Promise<void>[] = [];
    const fresh: { event: RecEvent; hash: string; line: string; bytes: number; cls: "sample" | "critical" }[] = [];
    const seen = new Set<string>();
    for (const raw of rawEvents) {
      const v = recValidateClientEvent(raw, runId);
      if (!v.ok) { rejected.push({ eid: eidOf(raw), reason: v.reason }); continue; }
      const e = v.event;
      if (seen.has(e.eid)) { acked.push(e.eid); continue; }
      seen.add(e.eid);
      const h = hashOf(e);
      const info = this.runs.get(runId);
      const known = info?.eids.get(e.eid) ?? info?.pendingEids.get(e.eid)?.hash;
      if (known !== undefined) {
        if (known === h) {
          acked.push(e.eid);
          const p = info!.pendingEids.get(e.eid);
          if (p) waits.push(p.done);
        } else {
          rejected.push({ eid: e.eid, reason: "conflict" });
          if (!info!.conflictsLogged.has(e.eid)) {
            info!.conflictsLogged.add(e.eid);
            this.enqueueFact(runId, tid, "srv_marker", undefined, { kind: "conflict", eid: e.eid, count: 1 });
          }
        }
        continue;
      }
      const stored: RecStoredLine = { rt: this.now(), tid, ...e };
      const line = JSON.stringify(stored) + "\n";
      fresh.push({ event: e, hash: h, line, bytes: Buffer.byteLength(line), cls: recEventClass(e.type, e.d) });
    }
    if (fresh.length > 0) {
      const need = fresh.reduce((n, f) => n + f.bytes, 0);
      if (!this.globalRoom(need)) return { status: 507, body: { recorder: "storage_full" } };
      const info = this.ensureRun(runId, tid);
      if (!info) return { status: 400, body: { recorder: "rejected", rejected: rawEvents.map((x) => ({ eid: eidOf(x), reason: "run_forbidden" })) } };
      let runBytes = info.summary.bytes + this.pendingBytesFor(info.file);
      let sampleBytes = info.summary.sampleBytes;
      let quotaHits = 0;
      const accepted: typeof fresh = [];
      for (const f of fresh) {
        if (f.cls === "sample" && sampleBytes + f.bytes > this.limits.runSampleMaxBytes) {
          rejected.push({ eid: f.event.eid, reason: "run_sample_quota" }); quotaHits++; continue;
        }
        if (runBytes + f.bytes > this.limits.runMaxBytes) {
          rejected.push({ eid: f.event.eid, reason: "run_quota" }); quotaHits++; continue;
        }
        runBytes += f.bytes;
        if (f.cls === "sample") sampleBytes += f.bytes;
        accepted.push(f);
      }
      if (quotaHits > 0) this.bumpQuotaRejected(runId, quotaHits);
      if (accepted.length > 0) {
        const done = this.enqueueLines(info.file, accepted.map((f) => f.line), !fs.existsSync(info.file));
        for (const f of accepted) {
          info.pendingEids.set(f.event.eid, { hash: f.hash, done });
          acked.push(f.event.eid);
        }
        waits.push(done);
        // 落盘成功才进正式去重表与摘要；失败则撤回，让客户端重传。
        done.then(() => {
          for (const f of accepted) {
            info.pendingEids.delete(f.event.eid);
            info.eids.set(f.event.eid, f.hash);
            info.summary.absorb(JSON.parse(f.line) as RecStoredLine, f.bytes);
          }
        }, () => {
          for (const f of accepted) info.pendingEids.delete(f.event.eid);
        });
        this.scheduleFlush(0);
      }
    }
    try {
      await Promise.all(waits);
    } catch {
      return { status: 503, body: { recorder: "write_failed" } };
    }
    return { status: 200, body: { recorder: "ok", acked, rejected } };
  }

  private bumpQuotaRejected(runId: string, n: number): void {
    this.quotaRejected.set(runId, (this.quotaRejected.get(runId) ?? 0) + n);
  }

  // ── 服务端自己的事实（不等落盘，有界） ─────────────────────

  /**
   * 记一条服务端事实。返回 false＝没记（局不属于这个测试者 / 已在停机 / 队列满——满了会计数）。
   * 同步返回，绝不抛。
   */
  appendServerFact(runId: string, tid: string, type: string, turn: string | undefined, d: Record<string, unknown>): boolean {
    try {
      if (this.closing) return false;
      if (!REC_ID_RE.test(runId)) return false;
      const owner = this.ownerOf(runId);
      if (owner && owner !== tid) return false;
      if (!owner && this.runsOfTester(tid) >= this.limits.maxRunsPerTester) return false;
      if (!this.ensureRun(runId, tid)) return false;
      return this.enqueueFact(runId, tid, type, turn, d);
    } catch {
      return false;
    }
  }

  private enqueueFact(runId: string, tid: string, type: string, turn: string | undefined, d: Record<string, unknown>, marker = type === "srv_marker"): boolean {
    const info = this.runs.get(runId);
    if (!info) return false;
    if (!marker && this.factsQueued >= this.limits.serverFactQueueMax) {
      this.factsDropped.set(runId, (this.factsDropped.get(runId) ?? 0) + 1);
      return false;
    }
    const seq = (this.srvSeq.get(runId) ?? 0) + 1;
    const trunc: string[] = [];
    const data = recBoundedCopy(d, trunc, { longKeys: new Set(["text"]) }) as Record<string, unknown>;
    const event: RecEvent = {
      v: REC_PROTOCOL_VERSION, eid: `${this.serverPid}:${seq}`, pid: this.serverPid, seq, run: runId, src: "server",
      type, ct: this.now(), d: data, ...(turn ? { turn } : {}), ...(trunc.length ? { trunc } : {}),
    };
    const line = JSON.stringify({ rt: this.now(), tid, ...event }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (!this.globalRoom(bytes, marker)) {
      if (!marker) this.factsDropped.set(runId, (this.factsDropped.get(runId) ?? 0) + 1);
      return false;
    }
    if (!marker && info.summary.bytes + this.pendingBytesFor(info.file) + bytes > this.limits.runMaxBytes) {
      this.factsDropped.set(runId, (this.factsDropped.get(runId) ?? 0) + 1);
      return false;
    }
    this.srvSeq.set(runId, seq);
    this.factsQueued++;
    const done = this.enqueueLines(info.file, [line], !fs.existsSync(info.file) && !this.pending.has(info.file));
    done.then(() => {
      this.factsQueued--;
      info.eids.set(event.eid, hashOf(event));
      info.summary.absorb(JSON.parse(line) as RecStoredLine, bytes);
    }, () => {
      this.factsQueued--;
      // 落盘失败＝这条事实没了：记数，下次能写时补一条标记（序号的缺口本身也会在导出里显示）。
      this.factsDropped.set(runId, (this.factsDropped.get(runId) ?? 0) + 1);
    });
    this.scheduleFlush(this.limits.factFlushMs);
    return true;
  }

  // ── 写盘 ───────────────────────────────────────────────────

  private pendingBytesFor(file: string): number {
    return this.pending.get(file)?.bytes ?? 0;
  }

  private enqueueLines(file: string, lines: string[], isNew: boolean): Promise<void> {
    let p = this.pending.get(file);
    if (!p) { p = { file, lines: [], bytes: 0, isNew, waiters: [] }; this.pending.set(file, p); }
    for (const l of lines) { p.lines.push(l); const b = Buffer.byteLength(l); p.bytes += b; this.pendingBytes += b; }
    const target = p;
    return new Promise<void>((resolve, reject) => target.waiters.push({ resolve, reject }));
  }

  private scheduleFlush(delayMs: number): void {
    if (delayMs <= 0) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      void this.flush().catch(() => {});
      return;
    }
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush().catch(() => {}); }, delayMs);
  }

  /**
   * 把排队的行全部写盘并 fsync。串行：同一时刻只有一轮在写。
   * 每个文件各自成败：某个文件写失败，只有排在这个文件上的等待者失败（它们会重传），
   * 并把这个文件截回写之前的长度——不留半行、也不留“写进去了却报失败”的重复。
   */
  private async waitIdle(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => {});
  }

  async flush(): Promise<void> {
    await this.waitIdle();
    if (this.pending.size === 0) {
      await this.writeDropMarkers();
      if (this.pending.size === 0) return;
      await this.waitIdle();
      if (this.pending.size === 0) return;
    }
    const batch = [...this.pending.values()];
    this.pending = new Map();
    const bytes = batch.reduce((n, b) => n + b.bytes, 0);
    this.pendingBytes -= bytes;
    this.inflightBytes += bytes;
    const run = (async () => {
      for (const b of batch) {
        let before = -1;
        try {
          try { before = (await fsp.stat(b.file)).size; } catch { before = 0; }
          await this.writeAndSync(b.file, b.lines.join(""), b.isNew || before === 0);
          this.totalBytes += b.bytes;
          for (const w of b.waiters) w.resolve();
        } catch (e) {
          this.lastWriteError = { at: this.now(), code: (e as NodeJS.ErrnoException)?.code ?? "EUNKNOWN" };
          if (before >= 0) { try { await fsp.truncate(b.file, before); } catch { /* 启动扫描会把残行标成损坏 */ } }
          for (const w of b.waiters) w.reject(e);
        } finally {
          this.inflightBytes -= b.bytes;
        }
      }
    })();
    this.flushing = run;
    try { await run; } finally { this.flushing = null; }
    if (this.pending.size > 0) this.scheduleFlush(this.closing ? 0 : 1);
    else await this.writeDropMarkers();
  }

  /** 丢事实／配额拒收的计数 → 能写的时候写成标记行（使用预留的标记余量）。 */
  private async writeDropMarkers(): Promise<void> {
    if (this.factsDropped.size === 0 && this.quotaRejected.size === 0) return;
    const dropped = this.factsDropped; this.factsDropped = new Map();
    const quota = this.quotaRejected; this.quotaRejected = new Map();
    for (const [runId, count] of dropped) {
      const tid = this.ownerOf(runId);
      if (tid) this.enqueueFact(runId, tid, "srv_marker", undefined, { kind: "facts_dropped", count }, true);
    }
    for (const [runId, count] of quota) {
      const tid = this.ownerOf(runId);
      if (tid) this.enqueueFact(runId, tid, "srv_marker", undefined, { kind: "quota_rejected", count }, true);
    }
  }

  private async writeAndSync(file: string, text: string, isNew: boolean): Promise<void> {
    const fh = await fsp.open(file, "a");
    try {
      await fh.write(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (isNew) {
      // 新文件：目录项本身也要落盘，否则断电后文件可能“不存在”。
      try {
        const dh = await fsp.open(path.dirname(file), "r");
        try { await dh.sync(); } finally { await dh.close(); }
      } catch { /* 某些文件系统不支持目录 fsync；文件内容已 fsync */ }
    }
  }

  private async appendDurable(file: string, text: string): Promise<void> {
    const isNew = !fs.existsSync(file);
    await this.writeAndSync(file, text, isNew);
  }

  // ── 停机 ───────────────────────────────────────────────────

  /**
   * 停机前排空：不再收新上传/新事实，把排队的全部写盘，给本次启动碰过的每一局写一条
   * “服务端生产者最后序号”，再写盘。返回用时（毫秒）与剩余未写条数（应为 0）。
   */
  async drain(): Promise<{ ms: number; leftover: number }> {
    const t0 = Date.now();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.flush().catch(() => {});
    for (const [runId, lastSeq] of this.srvSeq) {
      const tid = this.ownerOf(runId);
      if (tid) this.enqueueFact(runId, tid, "srv_producer_close", undefined, { lastSeq: lastSeq + 1 }, true);
    }
    this.closing = true;
    await this.flush().catch(() => {});
    if (this.pending.size > 0) await this.flush().catch(() => {});
    let leftover = 0;
    for (const p of this.pending.values()) leftover += p.lines.length;
    return { ms: Date.now() - t0, leftover };
  }

  get isClosing(): boolean { return this.closing; }

  // ── 读取 ───────────────────────────────────────────────────

  runSummaries(): RunSummary[] {
    return [...this.runs.values()].map((r) => r.summary);
  }

  summaryOf(runId: string): RunSummary | null {
    return this.runs.get(runId)?.summary ?? null;
  }

  /** 这一局本次启动的服务端序号（给完整性核对）。 */
  serverSeqOf(runId: string): Map<string, number> {
    const m = new Map<string, number>();
    const s = this.srvSeq.get(runId);
    if (s !== undefined) m.set(this.serverPid, s);
    return m;
  }

  usage(): { totalBytes: number; pendingBytes: number; globalMaxBytes: number; runs: number; lastWriteError: RecorderStore["lastWriteError"] } {
    return { totalBytes: this.totalBytes, pendingBytes: this.pendingBytes, globalMaxBytes: this.limits.globalMaxBytes, runs: this.runs.size, lastWriteError: this.lastWriteError };
  }

  /**
   * 固定截止水位读一局：先 flush，再按此刻文件长度读——之后追加的行不进这次导出。
   * 返回原始行（落盘顺序＝服务端接收顺序）与截止信息。
   */
  async readRun(runId: string): Promise<{ lines: RecStoredLine[]; cutoffBytes: number; cutoffAt: number; rawSha256: string } | null> {
    if (!REC_ID_RE.test(runId)) return null;
    const info = this.runs.get(runId);
    if (!info) return null;
    await this.flush().catch(() => {});
    const cutoffAt = this.now();
    let fh: fsp.FileHandle;
    try { fh = await fsp.open(info.file, "r"); } catch { return { lines: [], cutoffBytes: 0, cutoffAt, rawSha256: "" }; }
    try {
      const st = await fh.stat();
      const size = st.size;
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await fh.read(buf, off, size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      const lastNl = buf.lastIndexOf(0x0a, off - 1);
      const usable = buf.subarray(0, lastNl + 1);
      const lines: RecStoredLine[] = [];
      for (const raw of usable.toString("utf8").split("\n")) {
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* 已计入 corrupt 标记 */ }
      }
      return { lines, cutoffBytes: usable.length, cutoffAt, rawSha256: crypto.createHash("sha256").update(usable).digest("hex") };
    } finally {
      await fh.close();
    }
  }
}
