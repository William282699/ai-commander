// ============================================================
// 试玩记录仪 V1 · 记录协议（客户端与服务端共用的唯一一份合同）
//
// 纪律：
//   · 纯数据与纯函数：不碰游戏状态、不碰网络、不用全局伪随机数。
//   · 不进 @ai-commander/shared 的 index（游戏链路与台架的依赖表不因记录仪多一个名字）；
//     web / server 用深路径 `@ai-commander/shared/src/recorderProtocol` 引。
//   · 事件是“事实的副本”：进来之前已经按白名单复制、截断并标明截断处。
// ============================================================

export const REC_PROTOCOL_VERSION = 1 as const;

/** 上传批次上限（UTF-8 字节）。也是关页 keepalive 的上限（浏览器 64 KiB）。 */
export const REC_BATCH_MAX_BYTES = 64 * 1024;
/** 单条事件序列化后的上限——保证任何一条都装得进一批（批头另留余量）。 */
export const REC_EVENT_MAX_BYTES = 48 * 1024;
/** 普通文字字段截断（UTF-16 码元数）。 */
export const REC_TEXT_MAX = 8000;
/** 模型原文这类长字段的截断。 */
export const REC_LONG_TEXT_MAX = 16000;
/** 数组截断（快照另有自己的上限与省略计数）。 */
export const REC_ARRAY_MAX = 400;
export const REC_DEPTH_MAX = 8;
/** 快照里的单位上限；超过就记省略数量，不静默截。 */
export const REC_SNAPSHOT_UNITS_MAX = 400;

/** 客户端可以上传的事件类型。关键事件与采样事件分开计额。 */
export const REC_CLIENT_TYPES = [
  "run_start", "run_end", "game_end", "producer_close",
  "trace", "message", "tts", "op", "manual_order",
  "flag", "feedback", "snapshot", "drop_report", "consent",
] as const;
export type RecClientType = typeof REC_CLIENT_TYPES[number];

/** 服务端自己写的事实（客户端永远不许上传这些类型）。 */
export const REC_SERVER_TYPES = [
  "srv_run_meta", "srv_request", "srv_model_raw", "srv_result", "srv_parse_failed",
  "srv_model_error", "srv_attempt_end", "srv_marker", "srv_producer_close",
] as const;
export type RecServerType = typeof REC_SERVER_TYPES[number];

/** 采样类：压力下先降、先停、先被拒。其余都是关键事件。 */
export function recEventClass(type: string, d?: Record<string, unknown>): "sample" | "critical" {
  return type === "snapshot" && d?.reason === "periodic" ? "sample" : "critical";
}

export interface RecEvent {
  v: typeof REC_PROTOCOL_VERSION;
  /** 稳定事件编号＝`${pid}:${seq}`；重传一字不差。 */
  eid: string;
  /** 生产者：一次页面加载里的一局（客户端）或一次服务进程启动（服务端）。 */
  pid: string;
  /** 同一生产者（因而同一局）内从 1 起的连续序号。 */
  seq: number;
  run: string;
  src: "client" | "server";
  type: string;
  /** 发生时的墙上时间（毫秒；各设备时钟不严格一致，排序以序号与关联为主）。 */
  ct: number;
  /** 游戏时间（秒），适用时才有。 */
  gt?: number;
  /** 回合编号（既有 traceId）。 */
  turn?: string;
  /** 固定字段：回合取自“当前轮”（traceIdRef.current），不是调用点手里的不可变编号。 */
  turnFrom?: "current";
  /** 固定字段：局取自“主窗当前局”，不是出发时的 GameState。 */
  runFrom?: "current";
  d: Record<string, unknown>;
  /** 被截断的字段路径（没有＝没截）。 */
  trunc?: string[];
}

/** 服务端落盘的一行：事件本身＋服务端元数据（元数据由服务端写，事件里的同名字段进不来）。 */
export interface RecStoredLine extends RecEvent {
  /** 服务端接收时间（毫秒）。 */
  rt: number;
  /** 匿名测试者代号。 */
  tid: string;
}

export const REC_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const REC_PID_RE = /^[A-Za-z0-9_-]{4,48}$/;
export const REC_EID_RE = /^[A-Za-z0-9_-]{4,48}:[0-9]{1,10}$/;
export const REC_TURN_RE = /^[A-Za-z0-9-]{4,64}$/;

/** 任何层级上都不许出现的键名（鉴权、凭证、音频、密钥）。命中＝整条拒收并点名。 */
const FORBIDDEN_KEY_RE = /^(authorization|cookie|set-cookie|x-rec-[a-z-]*|api[_-]?key|apikey|password|passwd|secret|token|invite|admin[_-]?token|audio|voicedata)$/i;

export function recForbiddenKeyPath(v: unknown, path = "", depth = 0): string | null {
  if (depth > REC_DEPTH_MAX + 2 || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = recForbiddenKeyPath(v[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (FORBIDDEN_KEY_RE.test(k)) return p;
    const hit = recForbiddenKeyPath(x, p, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** UTF-8 字节数（不依赖 TextEncoder，node 与浏览器同一结果）。 */
export function recUtf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

/** 键排序的 JSON（内容哈希用：同一事件不同键序算同一份）。 */
export function recCanonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => recCanonicalJson(x === undefined ? null : x)).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${recCanonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * 有界复制：只收 JSON 能表达的东西；字符串、数组、深度都有上限，截断处记进 `trunc`。
 * 调用方拿到的是与活对象再无关联的纯数据。
 */
export function recBoundedCopy(
  v: unknown,
  trunc: string[],
  opts: { textMax?: number; longKeys?: ReadonlySet<string>; arrayMax?: number } = {},
  path = "",
  depth = 0,
  key = "",
): unknown {
  const textMax = opts.longKeys?.has(key) ? REC_LONG_TEXT_MAX : (opts.textMax ?? REC_TEXT_MAX);
  if (typeof v === "string") {
    if (v.length > textMax) { trunc.push(path || "."); return `${v.slice(0, textMax)}…(+${v.length - textMax})`; }
    return v;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (v === undefined || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") return undefined;
  if (depth >= REC_DEPTH_MAX) { trunc.push(path || "."); return "(…)"; }
  if (Array.isArray(v)) {
    const max = opts.arrayMax ?? REC_ARRAY_MAX;
    const out: unknown[] = [];
    const n = Math.min(v.length, max);
    for (let i = 0; i < n; i++) {
      const x = recBoundedCopy(v[i], trunc, opts, `${path}[${i}]`, depth + 1, key);
      out.push(x === undefined ? null : x);
    }
    if (v.length > max) { trunc.push(path || "."); out.push(`(+${v.length - max} more)`); }
    return out;
  }
  if (v instanceof Map || v instanceof Set) {
    return recBoundedCopy([...v], trunc, opts, path, depth, key);
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>)) {
    const x = recBoundedCopy((v as Record<string, unknown>)[k], trunc, opts, path ? `${path}.${k}` : k, depth + 1, k);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

const CLIENT_TYPE_SET: ReadonlySet<string> = new Set(REC_CLIENT_TYPES);
const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set(["v", "eid", "pid", "seq", "run", "src", "type", "ct", "gt", "turn", "turnFrom", "runFrom", "d", "trunc"]);

export type RecValidation = { ok: true; event: RecEvent } | { ok: false; reason: string };

/**
 * 服务端对一条客户端事件的校验。**只重建白名单字段**（不 spread 原对象），
 * 服务端元数据（rt/tid）由服务端另写，事件里带同名字段一律拒收。
 */
export function recValidateClientEvent(raw: unknown, runId: string): RecValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_object" };
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!ALLOWED_TOP_KEYS.has(k)) return { ok: false, reason: `unknown_key:${k.slice(0, 20)}` };
  if (e.v !== REC_PROTOCOL_VERSION) return { ok: false, reason: "bad_version" };
  if (typeof e.pid !== "string" || !REC_PID_RE.test(e.pid)) return { ok: false, reason: "bad_pid" };
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 1 || e.seq > 1e9) return { ok: false, reason: "bad_seq" };
  if (typeof e.eid !== "string" || e.eid !== `${e.pid}:${e.seq}`) return { ok: false, reason: "bad_eid" };
  if (e.run !== runId) return { ok: false, reason: "run_mismatch" };
  if (e.src !== "client") return { ok: false, reason: "bad_src" };
  if (typeof e.type !== "string" || !CLIENT_TYPE_SET.has(e.type)) return { ok: false, reason: "bad_type" };
  if (typeof e.ct !== "number" || !Number.isFinite(e.ct)) return { ok: false, reason: "bad_ct" };
  if (e.gt !== undefined && (typeof e.gt !== "number" || !Number.isFinite(e.gt))) return { ok: false, reason: "bad_gt" };
  if (e.turn !== undefined && (typeof e.turn !== "string" || !REC_TURN_RE.test(e.turn))) return { ok: false, reason: "bad_turn" };
  if (e.turnFrom !== undefined && e.turnFrom !== "current") return { ok: false, reason: "bad_turnFrom" };
  if (e.runFrom !== undefined && e.runFrom !== "current") return { ok: false, reason: "bad_runFrom" };
  if (!e.d || typeof e.d !== "object" || Array.isArray(e.d)) return { ok: false, reason: "bad_d" };
  if (e.trunc !== undefined && (!Array.isArray(e.trunc) || e.trunc.some((x) => typeof x !== "string") || e.trunc.length > 200)) {
    return { ok: false, reason: "bad_trunc" };
  }
  const forbidden = recForbiddenKeyPath(e.d);
  if (forbidden) return { ok: false, reason: `forbidden_field:${forbidden.slice(0, 60)}` };
  const event: RecEvent = {
    v: REC_PROTOCOL_VERSION, eid: e.eid, pid: e.pid, seq: e.seq, run: runId, src: "client",
    type: e.type, ct: e.ct, d: e.d as Record<string, unknown>,
    ...(e.gt !== undefined ? { gt: e.gt as number } : {}),
    ...(e.turn !== undefined ? { turn: e.turn as string } : {}),
    ...(e.turnFrom !== undefined ? { turnFrom: "current" as const } : {}),
    ...(e.runFrom !== undefined ? { runFrom: "current" as const } : {}),
    ...(e.trunc !== undefined ? { trunc: e.trunc as string[] } : {}),
  };
  if (recUtf8Bytes(JSON.stringify(event)) > REC_EVENT_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, event };
}

/** 上传批次的请求体。 */
export interface RecBatch {
  v: typeof REC_PROTOCOL_VERSION;
  run: string;
  events: RecEvent[];
}

/** 服务端对上传的应答。`recorder` 字段是分类的唯一依据（见 uploadVerdict）。 */
export type RecIngestReply =
  | { recorder: "ok"; acked: string[]; rejected: { eid: string; reason: string }[] }
  | { recorder: "rejected"; rejected: { eid: string; reason: string }[] }
  | { recorder: "closed" }
  | { recorder: "invite_revoked" }
  | { recorder: "invite_unknown" }
  | { recorder: "storage_full" }
  | { recorder: "write_failed" }
  | { recorder: "shutting_down" }
  | { recorder: "bad_batch"; reason: string };

/** “采集已关闭／邀请已作废”的专门应答所用的状态码（写进协议、有测试）。 */
export const REC_STATUS_CLEAR = 410;

export const REC_HEADER_INVITE = "X-Rec-Invite";
export const REC_HEADER_RUN = "X-Rec-Run";
