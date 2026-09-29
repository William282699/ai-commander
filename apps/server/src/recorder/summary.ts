// ============================================================
// 试玩记录仪 · 一局的摘要（边读边算，启动扫描与追加写共用同一个累加器）
//
// 完整性只按**看得见的证据**判：有结束边界、各生产者声明过最终序号且都收齐、
// 服务端的每次尝试都收了尾、没有丢弃/拒收/冲突/截断/尾部修复——才叫“已确认完整”。
// 其余一律如实分成“已知缺失”或“未正常结束/完整性未知”，绝不猜。
// ============================================================

import type { RecStoredLine } from "@ai-commander/shared/src/recorderProtocol";

interface ProducerState {
  src: "client" | "server";
  maxSeq: number;
  seqs: Set<number>;
  /** 生产者自己声明的最后一个序号（关页／停机时写）。 */
  finalSeq?: number;
}

export type CompletenessStatus = "complete" | "known_gaps" | "unknown";

export interface Completeness {
  status: CompletenessStatus;
  /** 中文原因，逐条可读。 */
  reasons: string[];
  producers: { pid: string; src: string; maxSeq: number; received: number; missing: string[]; declaredFinal: number | null }[];
  inFlightAttempts: number;
  drops: RunSummary["drops"];
  truncatedEvents: number;
  repairs: RunSummary["repairs"];
}

export class RunSummary {
  runId: string;
  tid = "";
  firstRt = 0;
  lastRt = 0;
  firstCt = 0;
  lastCt = 0;
  lastGt = 0;
  count = 0;
  bytes = 0;
  sampleBytes = 0;
  scenario: string | null = null;
  runStartCt: number | null = null;
  end: { kind: "game_end" | "run_end"; winner?: unknown; reason?: unknown; rating?: unknown; gt?: number; ct: number } | null = null;
  flags = 0;
  feedback = 0;
  counts: Record<string, number> = {};
  producers = new Map<string, ProducerState>();
  /** 客户端报的丢弃（按生产者取最大值再求和）与服务端自己记的缺失。 */
  private clientDrops = new Map<string, { critical: number; sample: number; rejected: number; memoryOnly: boolean }>();
  drops = { clientCritical: 0, clientSample: 0, clientRejected: 0, serverFacts: 0, serverQuotaRejected: 0, conflicts: 0, clientMemoryOnly: false };
  truncatedEvents = 0;
  repairs = { tailBytes: 0, corruptLines: 0 };
  private attempts = new Map<string, boolean>();
  /** 服务端的请求事实：回合 → 尝试编号列表（导出与报告串回合用）。 */
  build: string | null = null;

  constructor(runId: string) {
    this.runId = runId;
  }

  absorb(line: RecStoredLine, lineBytes: number): void {
    if (!this.tid) this.tid = line.tid;
    if (!this.firstRt || line.rt < this.firstRt) this.firstRt = line.rt;
    if (line.rt > this.lastRt) this.lastRt = line.rt;
    if (line.src === "client") {
      if (!this.firstCt || line.ct < this.firstCt) this.firstCt = line.ct;
      if (line.ct > this.lastCt) this.lastCt = line.ct;
    }
    if (typeof line.gt === "number" && line.gt > this.lastGt) this.lastGt = line.gt;
    this.count++;
    this.bytes += lineBytes;
    if (line.type === "snapshot" && (line.d as Record<string, unknown>)?.reason === "periodic") this.sampleBytes += lineBytes;
    this.counts[line.type] = (this.counts[line.type] ?? 0) + 1;
    if (line.trunc && line.trunc.length > 0) this.truncatedEvents++;

    let p = this.producers.get(line.pid);
    if (!p) { p = { src: line.src, maxSeq: 0, seqs: new Set() }; this.producers.set(line.pid, p); }
    p.seqs.add(line.seq);
    if (line.seq > p.maxSeq) p.maxSeq = line.seq;

    const d = (line.d ?? {}) as Record<string, unknown>;
    switch (line.type) {
      case "run_start":
        if (typeof d.scenario === "string") this.scenario = d.scenario;
        this.runStartCt = line.ct;
        break;
      case "game_end":
        this.end = { kind: "game_end", winner: d.winner, reason: d.reason, rating: d.rating, gt: line.gt, ct: line.ct };
        break;
      case "run_end":
        if (!this.end) this.end = { kind: "run_end", reason: d.reason, gt: line.gt, ct: line.ct };
        break;
      case "producer_close":
      case "srv_producer_close":
        if (typeof d.lastSeq === "number") p.finalSeq = d.lastSeq;
        break;
      case "flag":
        this.flags++;
        break;
      case "feedback":
        this.feedback++;
        break;
      case "drop_report": {
        const cur = this.clientDrops.get(line.pid) ?? { critical: 0, sample: 0, rejected: 0, memoryOnly: false };
        const num = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
        cur.critical = Math.max(cur.critical, num(d.critical));
        cur.sample = Math.max(cur.sample, num(d.sample));
        cur.rejected = Math.max(cur.rejected, num(d.rejected));
        cur.memoryOnly = cur.memoryOnly || d.memoryOnly === true;
        this.clientDrops.set(line.pid, cur);
        this.recountClientDrops();
        break;
      }
      case "srv_run_meta":
        if (typeof d.build === "string") this.build = d.build;
        break;
      case "srv_request":
        if (typeof d.attempt === "string" && !this.attempts.has(d.attempt)) this.attempts.set(d.attempt, false);
        break;
      case "srv_attempt_end":
        if (typeof d.attempt === "string") this.attempts.set(d.attempt, true);
        break;
      case "srv_marker": {
        const n = typeof d.count === "number" ? d.count : 1;
        if (d.kind === "conflict") this.drops.conflicts += n;
        else if (d.kind === "facts_dropped") this.drops.serverFacts += n;
        else if (d.kind === "quota_rejected") this.drops.serverQuotaRejected += n;
        else if (d.kind === "tail_repaired") this.repairs.tailBytes += typeof d.bytes === "number" ? d.bytes : 0;
        else if (d.kind === "corrupt_lines") this.repairs.corruptLines += n;
        break;
      }
    }
  }

  private recountClientDrops(): void {
    let c = 0, s = 0, r = 0, m = false;
    for (const v of this.clientDrops.values()) { c += v.critical; s += v.sample; r += v.rejected; m = m || v.memoryOnly; }
    this.drops.clientCritical = c; this.drops.clientSample = s; this.drops.clientRejected = r; this.drops.clientMemoryOnly = m;
  }

  inFlightAttempts(): number {
    let n = 0;
    for (const ended of this.attempts.values()) if (!ended) n++;
    return n;
  }

  /**
   * @param liveServerSeq 本次启动的服务端生产者此刻已发出的最后序号（导出前已全部落盘）。
   *   它还活着、没有“关闭”这回事；截至导出那一刻它发出的都应在包里，按此核对即可。
   */
  completeness(liveServerSeq?: ReadonlyMap<string, number>): Completeness {
    const reasons: string[] = [];
    let knownGap = false;
    let unknown = false;
    const producers: Completeness["producers"] = [];
    for (const [pid, p] of this.producers) {
      const live = liveServerSeq?.get(pid);
      const declared = p.finalSeq ?? live;
      const upto = declared ?? p.maxSeq;
      const missing: string[] = [];
      let runStart = -1;
      for (let s = 1; s <= upto + 1; s++) {
        const has = s <= upto ? p.seqs.has(s) : true;
        if (!has && runStart < 0) runStart = s;
        if (has && runStart >= 0) { missing.push(runStart === s - 1 ? `${runStart}` : `${runStart}-${s - 1}`); runStart = -1; }
      }
      producers.push({ pid, src: p.src, maxSeq: p.maxSeq, received: p.seqs.size, missing, declaredFinal: declared ?? null });
      const label = p.src === "server" ? `服务端生产者 ${pid}` : `浏览器生产者 ${pid}`;
      if (missing.length > 0) { knownGap = true; reasons.push(`${label} 缺序号 ${missing.slice(0, 6).join(",")}${missing.length > 6 ? "…" : ""}`); }
      if (declared === undefined) { unknown = true; reasons.push(`${label} 没有声明最终序号（关页/停机前的收尾没收到），之后可能还有没到的记录`); }
    }
    const inflight = this.inFlightAttempts();
    if (inflight > 0) { unknown = true; reasons.push(`服务端有 ${inflight} 次模型请求没有收尾记录`); }
    if (!this.end) { unknown = true; reasons.push("没有收到结束信号（游戏结束、重开或页面卸载）；多为关页时没送出来，不能据此断言缺了多少"); }
    const d = this.drops;
    if (d.clientCritical > 0) { knownGap = true; reasons.push(`浏览器缓存满，丢弃关键事件 ${d.clientCritical} 条`); }
    if (d.clientSample > 0) { knownGap = true; reasons.push(`浏览器缓存满，丢弃采样快照 ${d.clientSample} 条`); }
    if (d.clientRejected > 0) { knownGap = true; reasons.push(`服务端点名拒收 ${d.clientRejected} 条（浏览器已按拒收删除）`); }
    if (d.serverFacts > 0) { knownGap = true; reasons.push(`服务端自己的事实丢了 ${d.serverFacts} 条（队列过载或写盘失败）`); }
    if (d.serverQuotaRejected > 0) { knownGap = true; reasons.push(`超出单局配额被拒 ${d.serverQuotaRejected} 条`); }
    if (d.conflicts > 0) { knownGap = true; reasons.push(`同编号不同内容的冲突 ${d.conflicts} 次（保留先到的那份）`); }
    if (d.clientMemoryOnly) { unknown = true; reasons.push("浏览器存储不可用，曾退回内存缓存：关页时未上传的部分会丢"); }
    if (this.truncatedEvents > 0) { knownGap = true; reasons.push(`${this.truncatedEvents} 条事件有字段被截断（截断处在事件的 trunc 里）`); }
    if (this.repairs.tailBytes > 0) { knownGap = true; reasons.push(`重启时修掉了文件尾部 ${this.repairs.tailBytes} 字节的不完整行（未确认的写入）`); }
    if (this.repairs.corruptLines > 0) { knownGap = true; reasons.push(`${this.repairs.corruptLines} 行无法解析被跳过`); }
    const status: CompletenessStatus = knownGap ? "known_gaps" : unknown ? "unknown" : "complete";
    return { status, reasons, producers, inFlightAttempts: inflight, drops: { ...d }, truncatedEvents: this.truncatedEvents, repairs: { ...this.repairs } };
  }
}

export const COMPLETENESS_LABEL: Record<CompletenessStatus, string> = {
  complete: "已确认完整",
  known_gaps: "已知缺失",
  unknown: "未正常结束/完整性未知",
};
