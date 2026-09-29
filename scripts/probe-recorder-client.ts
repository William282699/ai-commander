/**
 * 试玩记录仪 Step 1：浏览器侧记录核心 × 真服务端（进程内 express，只挂记录仪路由）。
 * 运行：node --import tsx scripts/probe-recorder-client.ts
 *
 * 走生产 RecorderCore（同一份 core.ts）＋生产上传应答分类＋生产存储。网络层用真 fetch，
 * 故障（掉 ACK、断网、429、代理 HTML、400/413、410）用一层转发代理注入。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import * as core from "@ai-commander/core";
import { test, mustFail, tempDir, rm, startServer, summary } from "./recorder-test-lib";
import { classifyUploadResponse } from "../apps/web/src/recorder/uploadVerdict";
import { resolveInvite, extractInvite } from "../apps/web/src/recorder/identity";
import { RecorderCore, DEFAULT_CORE_LIMITS, type CoreDeps } from "../apps/web/src/recorder/core";
import { MemoryBackend, type QItem, type QueueBackend } from "../apps/web/src/recorder/queue";
import { REC_BATCH_MAX_BYTES } from "../packages/shared/src/recorderProtocol";

const FAST = { ...DEFAULT_CORE_LIMITS, uploadBusyMs: 5, uploadIdleMs: 30, backoffMinMs: 15, backoffMaxMs: 120, requestTimeoutMs: 3000, sampleIntervalMs: 3_600_000 };

/** 持久层替身：同一个 Map 跨“两次页面加载”共享（模拟 IndexedDB 在关页后还在）。 */
class SharedBackend implements QueueBackend {
  readonly kind = "idb" as const;
  constructor(public store = new Map<string, QItem>()) {}
  async loadAll() { return [...this.store.values()].sort((a, b) => a.order - b.order); }
  async put(items: QItem[]) { for (const i of items) this.store.set(i.eid, i); return true; }
  async remove(eids: string[]) { for (const e of eids) this.store.delete(e); return true; }
}

async function until(cond: () => boolean, ms = 5000, label = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function main() {
  const { createRecorder } = await import("../apps/server/src/recorder/routes");
  const { exportRun } = await import("../apps/server/src/recorder/export");

  // ════════ 纯规则 ════════
  await test("C1 ★上传应答三分类：只有 410＋recorder:closed/invite_revoked 才清队列；400/413 只删点名的；429/5xx/代理 HTML/网络错/看不懂的 200 一律保留重试", () => {
    const batch = ["p:1", "p:2", "p:3"];
    const J = (o: unknown) => JSON.stringify(o);
    assert.deepEqual(classifyUploadResponse(410, J({ recorder: "closed" }), batch), { kind: "clear", reason: "closed" });
    assert.deepEqual(classifyUploadResponse(410, J({ recorder: "invite_revoked" }), batch), { kind: "clear", reason: "invite_revoked" });
    assert.equal(classifyUploadResponse(410, "<html>Gone</html>", batch).kind, "retry", "410 proxy page is not the special reply");
    assert.equal(classifyUploadResponse(410, J({ recorder: "other" }), batch).kind, "retry");
    assert.equal(classifyUploadResponse(200, J({ recorder: "closed" }), batch).kind, "retry", "closed only counts with its status code");
    assert.equal(classifyUploadResponse(429, J({ recorder: "closed" }), batch).kind, "retry");
    assert.equal(classifyUploadResponse(429, "Too Many Requests", batch).kind, "retry");
    assert.equal(classifyUploadResponse(502, "<html>Bad Gateway</html>", batch).kind, "retry");
    assert.equal(classifyUploadResponse(503, J({ recorder: "write_failed" }), batch).kind, "retry");
    assert.equal(classifyUploadResponse(507, J({ recorder: "storage_full" }), batch).kind, "retry");
    assert.equal(classifyUploadResponse(0, "", batch).kind, "retry");
    assert.equal(classifyUploadResponse(200, "<html>captive portal</html>", batch).kind, "retry");
    assert.equal(classifyUploadResponse(403, J({ recorder: "invite_unknown" }), batch).kind, "retry");
    assert.deepEqual(classifyUploadResponse(400, J({ recorder: "rejected", rejected: [{ eid: "p:2", reason: "bad_type" }, { eid: "not-in-batch", reason: "x" }] }), batch),
      { kind: "reject_named", rejected: [{ eid: "p:2", reason: "bad_type" }] });
    assert.equal(classifyUploadResponse(400, J({ recorder: "rejected", rejected: [{ eid: "other:9", reason: "x" }] }), batch).kind, "split", "naming only foreign ids is not naming");
    assert.equal(classifyUploadResponse(400, "<html>Bad Request</html>", batch).kind, "split");
    assert.equal(classifyUploadResponse(413, "PayloadTooLargeError", batch).kind, "split");
    assert.equal(classifyUploadResponse(413, "PayloadTooLargeError", ["p:1"]).kind, "retry", "single unnamed → keep & back off");
    assert.equal(classifyUploadResponse(400, J({ recorder: "bad_batch", reason: "x" }), ["p:1"]).kind, "retry");
    const ok = classifyUploadResponse(200, J({ recorder: "ok", acked: ["p:1", "zz:1"], rejected: [{ eid: "p:3", reason: "conflict" }] }), batch);
    assert.deepEqual(ok, { kind: "acked", acked: ["p:1"], rejected: [{ eid: "p:3", reason: "conflict" }] });
  });
  await test("C1-负对照：若把“429 当成采集关闭”（清队列）⇒ 同一张表的断言失败", async () => {
    const broken = (s: number, t: string, b: string[]) => (s === 429 ? { kind: "clear" } : classifyUploadResponse(s, t, b));
    await mustFail("429 retries", () => assert.equal(broken(429, "Too Many Requests", ["p:1"]).kind, "retry"));
  });
  await test("C2 ★邀请规则（★24）：首次问；同一邀请不重问；拒绝/撤回后重开链接再问；换邀请以地址栏为准并报出被替换的旧凭证；地址栏抹掉邀请其余参数原样", () => {
    const A = "AAAAAAAAAAAAAAAAAAAAAAAA"; const B = "BBBBBBBBBBBBBBBBBBBBBBBB";
    let r = resolveInvite(A, null, 1);
    assert.deepEqual([r.ask, r.identity?.token, r.identity?.consent, r.replacedToken], [true, A, "unanswered", null]);
    r = resolveInvite(A, { token: A, consent: "granted", at: 1 }, 2);
    assert.deepEqual([r.ask, r.identity?.consent], [false, "granted"]);
    r = resolveInvite(null, { token: A, consent: "granted", at: 1 }, 2);
    assert.deepEqual([r.ask, r.identity?.consent], [false, "granted"], "plain reload: no re-ask");
    for (const c of ["declined", "withdrawn"] as const) {
      r = resolveInvite(A, { token: A, consent: c, at: 1 }, 2);
      assert.deepEqual([r.ask, r.identity?.consent], [true, "unanswered"], `${c}: reopening the link asks again`);
      r = resolveInvite(null, { token: A, consent: c, at: 1 }, 2);
      assert.deepEqual([r.ask, r.identity?.consent], [false, c], `${c}: plain reload stays ${c}`);
    }
    r = resolveInvite(B, { token: A, consent: "granted", at: 1 }, 2);
    assert.deepEqual([r.ask, r.identity?.token, r.identity?.consent, r.replacedToken], [true, B, "unanswered", A]);
    r = resolveInvite("bad token!", { token: A, consent: "granted", at: 1 }, 2);
    assert.equal(r.identity?.token, A, "malformed invite ignored");
    const x = extractInvite(`?scenario=tutorial&invite=${A}&nofog=1`, "/", "#h");
    assert.deepEqual(x, { token: A, cleanUrl: "/?scenario=tutorial&nofog=1#h" });
    assert.deepEqual(extractInvite("?scenario=tutorial", "/", ""), { token: null, cleanUrl: null });
  });
  await test("C3 记录器代码里没有 Math.random（浏览器侧、协议、服务端记录仪目录逐文件查）", () => {
    const dirs = ["apps/web/src/recorder", "apps/server/src/recorder"];
    const files = dirs.flatMap((d) => readdirSync(d).map((f) => join(d, f))).concat(["packages/shared/src/recorderProtocol.ts"]);
    assert.ok(files.length >= 12);
    for (const f of files) assert.ok(!readFileSync(f, "utf8").includes("Math.random"), `${f} uses Math.random`);
  });

  // ════════ 核心 × 真服务端 ════════
  const ADMIN = "admin-token-for-tests-0123456789";
  async function env(opts: { collect?: boolean } = {}) {
    const dir = tempDir("client");
    const rec = createRecorder({ dataDir: dir, collect: opts.collect ?? true, adminToken: ADMIN, limits: {}, buildInfo: { build: "test" } });
    await rec.ready;
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use(rec.router);
    const srv = await startServer(app as unknown as Parameters<typeof startServer>[0]);
    const store = rec.store()!;
    const a = await store.createInvite();
    const b = await store.createInvite();
    /** 故障注入：每次请求先问 fault(n)，返回 null＝正常转发。 */
    const net = { calls: 0, bodies: [] as { bytes: number; headers: Record<string, string>; events: number }[], fault: (_n: number): null | "offline" | "drop_ack" | { status: number; body: string } => null };
    const fetchImpl: CoreDeps["fetch"] = async (url, init) => {
      net.calls++;
      net.bodies.push({ bytes: Buffer.byteLength(init.body), headers: init.headers, events: (JSON.parse(init.body).events as unknown[]).length });
      const f = net.fault(net.calls);
      if (f === "offline") throw new TypeError("Failed to fetch");
      if (f && typeof f === "object") return { status: f.status, text: async () => f.body };
      const res = await fetch(url.replace("http://recorder", srv.url), { method: init.method, headers: init.headers, body: init.body });
      const text = await res.text();
      if (f === "drop_ack") throw new TypeError("connection reset after server processed");
      return { status: res.status, text: async () => text };
    };
    const mk = (backend: QueueBackend = new SharedBackend(), limits = FAST, depsOver: Partial<CoreDeps> = {}) => new RecorderCore({
      now: () => Date.now(), randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      fetch: fetchImpl, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      apiUrl: "http://recorder", ...depsOver,
    }, backend, limits);
    const lines = (runId: string) => {
      const f = join(dir, "runs", `${runId}.jsonl`);
      try { return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    };
    const close = async () => { await srv.close(); rm(dir); };
    return { dir, store, a, b, net, mk, lines, close };
  }
  const game = () => core.createInitialGameState("el_alamein");

  await test("C4 ★开局→记录→上传：局号首见绑定给该测试者；命令请求头只对本局的 state 给出（局号＋凭证）；别的 state 给空", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, { url: {} });
    c.trace("t-1111-aaaa", "turn", { channel: "combat", text: "派两个去北线前哨" }, s);
    c.message("add", { id: 1, text: "派两个去北线前哨", channel: "combat", from: "player" });
    c.op("channel", { commanders: ["chen"] });
    const h = c.headers(s);
    const runId = c.status().runId!;
    assert.deepEqual(h, { "X-Rec-Invite": e.a.token, "X-Rec-Run": runId });
    assert.deepEqual(c.headers(game()), {}, "unknown state → no headers");
    await until(() => c.status().queued === 0 && e.lines(runId).filter((l) => l.type === "snapshot").length >= 1, 5000, "drain");
    const ls = e.lines(runId);
    assert.ok(ls.every((l) => l.tid === e.a.tid));
    const types = ls.map((l) => `${l.type}${l.d.stage ? ":" + l.d.stage : ""}`);
    for (const t of ["run_start", "trace:turn", "message", "op", "snapshot"]) assert.ok(types.includes(t), `${t} in ${types.join(",")}`);
    const tr = ls.find((l) => l.type === "trace");
    assert.equal(tr.turn, "t-1111-aaaa");
    assert.equal(tr.runFrom, undefined, "run taken from the departure state, not current");
    const msg = ls.find((l) => l.type === "message");
    assert.equal(msg.runFrom, "current");
    const snap = ls.find((l) => l.type === "snapshot");
    assert.equal(snap.d.units.length, [...s.units.values()].filter((u) => u.team === "player").length, "every player unit, no 80-item clip");
    assert.ok(snap.d.units.length > 80, `El Alamein has ${snap.d.units.length} player units`);
    await e.close();
  });
  await test("C5 ★ACK 丢了（服务端已落盘、应答没回到浏览器）⇒ 浏览器重传，服务端只留一份；队列清空", async () => {
    const e = await env();
    e.net.fault = (n) => (n <= 2 ? "drop_ack" : null);
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    for (let i = 0; i < 20; i++) c.trace(`t-${1000 + i}-aaaa`, "turn", { text: `第${i}句` }, s);
    const runId = c.status().runId!;
    await until(() => c.status().queued === 0, 8000, "drain");
    const ls = e.lines(runId).filter((l) => l.src === "client");
    assert.equal(new Set(ls.map((l) => l.eid)).size, ls.length, "no duplicate lines");
    assert.ok(e.net.calls >= 3);
    await e.close();
  });
  await test("C6 ★断网：事件留在队列、退避、显示故障；恢复后补传且不重复", async () => {
    const e = await env();
    let offline = true;
    e.net.fault = () => (offline ? "offline" : null);
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    for (let i = 0; i < 5; i++) c.op("probe", { i });
    await until(() => c.status().phase === "fault", 5000, "fault phase");
    const q = c.status().queued;
    assert.ok(q >= 6, `still queued: ${q}`);
    offline = false;
    await until(() => c.status().queued === 0, 8000, "drain after reconnect");
    assert.equal(c.status().phase, "recording");
    const runId = c.status().runId!;
    const ls = e.lines(runId).filter((l) => l.src === "client");
    assert.equal(new Set(ls.map((l) => l.eid)).size, ls.length);
    assert.equal(ls.filter((l) => l.type === "op").length, 5);
    await e.close();
  });
  for (const [label, reply] of [
    ["429 限流", { status: 429, body: "Too Many Requests" }],
    ["502 代理 HTML 页面", { status: 502, body: "<html><body>502 Bad Gateway</body></html>" }],
    ["503 冷启动", { status: 503, body: "<html>service unavailable</html>" }],
    ["410 但却是代理 HTML（不是专门应答）", { status: 410, body: "<html>Gone</html>" }],
    ["200 却是门户页面", { status: 200, body: "<html>Please log in to Wi-Fi</html>" }],
  ] as const) {
    await test(`C7 ★${label} ⇒ 不清队列、保留、故障可见；恢复后照常补传`, async () => {
      const e = await env();
      let bad = true;
      e.net.fault = () => (bad ? reply : null);
      const c = e.mk();
      c.activate(e.a.token);
      const s = game();
      c.startRun(s, {});
      c.op("probe", {});
      await until(() => c.status().failures >= 3, 5000, "failures");
      assert.equal(c.status().phase, "fault");
      assert.ok(c.status().queued >= 2, "kept");
      assert.equal(c.isActive(), true, "not treated as collection closed");
      bad = false;
      await until(() => c.status().queued === 0, 8000, "drain");
      assert.ok(e.lines(c.status().runId!).some((l) => l.type === "op"));
      await e.close();
    });
  }
  await test("C8 ★400 结构化点名 ⇒ 只删被点名的那条并计数（导出里显示），其余照收；400/413 不点名的多条批次 ⇒ 拆小再发，一条不删", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    await until(() => c.status().queued === 0, 5000, "first drain");
    // 手工构造：让服务端点名拒收一条——用一个会被服务端校验拒收的事件（非法类型）进同一批
    const runId = c.status().runId!;
    c.op("a", {}); c.op("b", {});
    const q = (c as unknown as { queue: Map<string, QItem> }).queue;
    const items = [...q.values()];
    const bad = items[0];
    const badEv = JSON.parse(bad.body); badEv.type = "srv_result"; bad.body = JSON.stringify(badEv);
    await until(() => c.status().queued === 0, 5000, "drain with rejection");
    assert.equal(c.status().drops.rejected, 1);
    assert.ok(!e.lines(runId).some((l) => l.eid === bad.eid));
    assert.ok(e.lines(runId).some((l) => l.eid === items[1].eid));
    await until(() => e.lines(runId).some((l) => l.type === "drop_report" && l.d.rejected === 1), 5000, "drop_report");
    await e.store.flush();
    const out = await exportRun(e.store, runId);
    assert.ok((out!.manifest as { completeness: { reasons: string[] } }).completeness.reasons.some((r) => r.includes("点名拒收 1 条")));
    // 不点名的 413：拆小再发
    let splits = 0;
    e.net.fault = (n) => (e.net.bodies[n - 1].events > 1 ? (splits++, { status: 413, body: "PayloadTooLargeError: request entity too large" }) : null);
    for (let i = 0; i < 6; i++) c.op("x", { i });
    await until(() => c.status().queued === 0, 8000, "drain after split");
    assert.ok(splits >= 1);
    assert.equal(c.status().drops.rejected, 1, "unnamed 413 deleted nothing");
    assert.equal(e.lines(runId).filter((l) => l.type === "op" && l.d.kind === "x").length, 6);
    await e.close();
  });
  await test("C9 ★采集关闭（410 {recorder:closed}）⇒ 这个凭证名下的待传队列清空、记录入口关闭；游戏侧调用照常返回", async () => {
    const e = await env({ collect: false });
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    c.op("probe", {});
    await until(() => !c.isActive(), 5000, "deactivated");
    assert.equal(c.status().phase, "closed");
    assert.equal(c.status().queued, 0);
    c.trace("t-2222-aaaa", "turn", {}, s);   // 入口第一行就返回
    assert.equal(c.status().queued, 0);
    assert.deepEqual(c.headers(s), {});
    await e.close();
  });
  await test("C10 ★换了测试者：A 的积压（上一页留下的持久队列）仍用 A 的凭证补传、记在 A 名下；新页的事件记 B；A 那一局正常关页 ⇒ 已确认完整", async () => {
    const e = await env();
    const shared = new SharedBackend();
    e.net.fault = () => "offline";
    const c1 = e.mk(shared);
    c1.activate(e.a.token);
    const s1 = game();
    c1.startRun(s1, {});
    c1.op("from_a", {});
    const runA = c1.status().runId!;
    await until(() => shared.store.size >= 2, 5000, "persisted");
    c1.pagehide();
    await new Promise((r) => setTimeout(r, 50));
    // 第二次页面加载：B 的邀请
    e.net.fault = () => null;
    const c2 = e.mk(shared);
    c2.activate(e.b.token);
    const s2 = game();
    c2.startRun(s2, {});
    c2.op("from_b", {});
    const runB = c2.status().runId!;
    await until(() => c2.status().queued === 0, 8000, "drain both");
    assert.ok(e.lines(runA).length > 0 && e.lines(runA).every((l) => l.tid === e.a.tid), "A's backlog under A");
    assert.ok(e.lines(runA).some((l) => l.type === "op" && l.d.kind === "from_a"));
    assert.ok(e.lines(runB).every((l) => l.tid === e.b.tid), "new events under B");
    const aHeaders = e.net.bodies.filter((b) => b.headers["X-Rec-Invite"] === e.a.token).length;
    assert.ok(aHeaders >= 1);
    // 正常关页：这一局记下“页面卸载”（不是“玩家退出”）与最后序号 ⇒ 所有该到的都到了，导出为“已确认完整”
    assert.ok(e.lines(runA).some((l) => l.type === "run_end" && l.d.reason === "page_unload"));
    assert.ok(e.lines(runA).some((l) => l.type === "producer_close"));
    await e.store.flush();
    const outA = await exportRun(e.store, runA);
    const compA = (outA!.manifest as { completeness: { status: string; reasons: string[] } }).completeness;
    assert.equal(compA.status, "complete", compA.reasons.join(" | "));
    await e.close();
  });
  await test("C11 ★撤回同意：本凭证名下没上传的立即清空、之后一条不采；已上传的不动", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    await until(() => c.status().queued === 0, 5000, "first drain");
    const runId = c.status().runId!;
    const uploaded = e.lines(runId).length;
    e.net.fault = () => "offline";
    for (let i = 0; i < 5; i++) c.op("pending", { i });
    assert.ok(c.status().queued >= 5);
    c.withdraw();
    assert.equal(c.status().queued, 0);
    assert.equal(c.status().phase, "withdrawn");
    c.op("after", {});
    c.trace("t-3333-aaaa", "turn", {}, s);
    assert.equal(c.status().queued, 0);
    e.net.fault = () => null;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(e.lines(runId).length, uploaded, "server data untouched, nothing new");
    await e.close();
  });
  await test("C12 没同意＝核心从未激活 ⇒ 零请求、命令请求头为空", async () => {
    const e = await env();
    const c = e.mk();
    const s = game();
    c.startRun(s, {});
    c.trace("t-4444-aaaa", "turn", { text: "x" }, s);
    c.op("x", {});
    assert.deepEqual(c.headers(s), {});
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(e.net.calls, 0);
    await e.close();
  });
  await test("C12-负对照：绕过同意保护（不经 activate 直接打开入口开关）⇒ 发出了记录请求、命令请求头带上凭证，同一断言失败", async () => {
    const e = await env();
    const c = e.mk();
    (c as unknown as { active: boolean; token: string }).active = true;   // 摘保护
    (c as unknown as { token: string }).token = e.a.token;
    const s = game();
    c.startRun(s, {});
    c.op("x", {});
    await new Promise((r) => setTimeout(r, 120));
    await mustFail("zero requests & empty headers", () => { assert.equal(e.net.calls, 0); assert.deepEqual(c.headers(s), {}); });
    await e.close();
  });
  await test("C9-负对照：采集开关若不看（服务端 collect 当成开着）⇒ 事件被收下、队列没清，“关闭即清空”的断言失败", async () => {
    const e = await env({ collect: true });
    const c = e.mk();
    c.activate(e.a.token);
    c.startRun(game(), {});
    c.op("probe", {});
    await until(() => c.status().queued === 0, 5000, "drain");
    await mustFail("closed ⇒ deactivated", () => assert.equal(c.status().phase, "closed"));
    await e.close();
  });
  await test("C13 ★缓存上限：采样先停并计数、关键事件挤掉采样；挤不下的关键事件才丢并计数；状态显示“可能不完整”，丢弃账最终到服务端", async () => {
    const e = await env();
    e.net.fault = () => "offline";
    const c = e.mk(new MemoryBackend(), { ...FAST, memoryOnlyMaxBytes: 60_000, cacheMaxBytes: 60_000 });
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 40; i++) c.trace(`t-${5000 + i}-aaaa`, "exec", { pad: "中".repeat(1500) }, s);
    const st = c.status();
    assert.ok(st.drops.critical > 0 || st.drops.sample > 0, JSON.stringify(st.drops));
    assert.equal(st.phase === "degraded" || st.phase === "fault", true);
    e.net.fault = () => null;
    const runId = st.runId!;
    await until(() => c.status().queued === 0, 10000, "drain");
    await until(() => e.lines(runId).some((l) => l.type === "drop_report" && (l.d.critical > 0 || l.d.sample > 0)), 5000, "drop report");
    await e.store.flush();
    const out = await exportRun(e.store, runId);
    const comp = (out!.manifest as { completeness: { status: string; reasons: string[] } }).completeness;
    assert.equal(comp.status, "known_gaps");
    assert.ok(comp.reasons.some((r) => r.includes("浏览器缓存满")) || comp.reasons.some((r) => r.includes("缺序号")), comp.reasons.join("|"));
    await e.close();
  });
  await test("C14 ★批次字节上限按 UTF-8 算：大量中文事件，每个请求体 ≤ 64 KiB", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    for (let i = 0; i < 60; i++) c.trace(`t-${6000 + i}-aaaa`, "turn", { text: "长官北线前哨需要增援".repeat(200) }, s);
    await until(() => c.status().queued === 0, 10000, "drain");
    assert.ok(e.net.bodies.length >= 2);
    for (const b of e.net.bodies) assert.ok(b.bytes <= REC_BATCH_MAX_BYTES, `${b.bytes} > ${REC_BATCH_MAX_BYTES}`);
    await e.close();
  });
  await test("C15 ★记录器内部出错（注入会抛异常的时钟）⇒ 每个入口照常返回、不抛给游戏；只记内部错误数", async () => {
    const e = await env();
    const c = e.mk(new MemoryBackend(), FAST, { now: () => { throw new Error("boom"); } });
    c.activate(e.a.token);
    const s = game();
    assert.doesNotThrow(() => {
      c.startRun(s, {});
      c.trace("t-7777-aaaa", "exec", { applied: [1] }, s);
      c.message("add", { text: "x" });
      c.tts("x", "chen", "speak");
      c.op("x", {});
      c.manualOrder(s, [{ action: "attack_move", unitIds: [1] }], "right_click_move");
      c.flag("x");
      c.gameEnd(s, {});
      c.headers(s);
      c.pagehide();
    });
    assert.ok(c.internalErrors > 0);
    await e.close();
  });
  await test("C16 认局不猜：手里的 state 不是开过的局 ⇒ 不记（只计数），不挂到当前局", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    c.startRun(s, {});
    await until(() => c.status().queued === 0, 5000, "drain");
    const runId = c.status().runId!;
    const before = e.lines(runId).length;
    c.trace("t-8888-aaaa", "exec", { applied: [1] }, game());
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(e.lines(runId).length, before);
    await e.close();
  });
  await test("C17 ★重开：旧局写 run_end(replaced)，迟到回调带着旧 state 仍记到旧局（不续写新局），新局另起局号", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s1 = game();
    c.startRun(s1, {});
    const r1 = c.status().runId!;
    const s2 = game();
    c.startRun(s2, { restart: true });
    const r2 = c.status().runId!;
    assert.notEqual(r1, r2);
    c.trace("t-9999-aaaa", "exec", { applied: [5] }, s1);   // 旧局的迟到回调
    await until(() => c.status().queued === 0, 5000, "drain");
    const l1 = e.lines(r1); const l2 = e.lines(r2);
    assert.ok(l1.some((l) => l.type === "run_end" && l.d.reason === "replaced"), JSON.stringify(l1.map((l) => [l.type, l.seq, l.d.reason])));
    assert.ok(l1.some((l) => l.type === "trace" && l.turn === "t-9999-aaaa"), "late callback stays with the old run");
    assert.ok(!l2.some((l) => l.turn === "t-9999-aaaa"));
    assert.ok(!l2.some((l) => l.type === "run_end" || l.type === "game_end"), "no fake end for the new run");
    await e.close();
  });

  await test("C18 开局前那一瞬的观察（面板挂载时的静音/频道/页签）接到本页第一局开头、标 preRun；带 state 的 trace 不借此归局", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    c.op("tts_state", { enabled: false });
    c.op("channel", { commanders: ["chen"] });
    c.trace("t-0101-aaaa", "turn", { text: "x" }, game());   // 带着别的 state：不归局、只计数
    const s = game();
    c.startRun(s, {});
    const runId = c.status().runId!;
    await until(() => c.status().queued === 0, 5000, "drain");
    const ls = e.lines(runId);
    const ops = ls.filter((l) => l.type === "op");
    assert.deepEqual(ops.map((l) => l.d.kind), ["tts_state", "channel"]);
    assert.ok(ops.every((l) => l.d.preRun === true && l.runFrom === "current"));
    assert.ok(!ls.some((l) => l.turn === "t-0101-aaaa"));
    // 第二局开局时不再挂任何“开局前”的东西
    c.startRun(game(), { restart: true });
    const r2 = c.status().runId!;
    await until(() => c.status().queued === 0, 5000, "drain 2");
    assert.ok(!e.lines(r2).some((l) => l.d.preRun === true));
    await e.close();
  });

  await test("C19 ★T11 截断如实：3 万个中文字按上限截断（超单条上限再从原文收紧）、trunc 点出路径、标出被截字数；500 个单位的快照写明省略 100 个、不是悄悄截到 80；非 ASCII 全程按 UTF-8 计", async () => {
    const e = await env();
    const c = e.mk();
    c.activate(e.a.token);
    const s = game();
    const tpl = [...s.units.values()].find((u) => u.team === "player")!;
    let id = 900000;
    while ([...s.units.values()].filter((u) => u.team === "player").length < 500) { const u = { ...structuredClone(tpl), id: id++ }; s.units.set(u.id, u); }
    c.startRun(s, {});
    const long = "长官，".repeat(10000);    // 3 万字
    c.trace("t-1901-aaaa", "confirm_captured", { text: long, items: Array.from({ length: 450 }, (_, i) => i) }, s);
    const runId = c.status().runId!;
    await until(() => c.status().queued === 0 && e.lines(runId).some((l) => l.type === "snapshot"), 5000, "drain");
    const tr = e.lines(runId).find((l) => l.type === "trace")!;
    assert.ok(tr.trunc.includes("data.text") && tr.trunc.includes("data.items"), JSON.stringify(tr.trunc));
    // 3 万个中文字 ≈ 90 KB：先按 1.6 万字截仍超 48 KiB，于是收紧到 4000 字；两层截断都点名、被截字数写在尾巴上
    assert.ok(tr.d.data.text.endsWith(`…(+${long.length - 4000})`), `re-cut from the original at 4000 chars, the cut size exact: …${tr.d.data.text.slice(-24)}`);
    assert.ok(Buffer.byteLength(JSON.stringify(tr)) <= 48 * 1024 + 200, "the stored event fits the per-event cap");
    assert.ok(!("tooLarge" in tr.d), "kept the event instead of a placeholder");
    assert.equal(tr.d.data.items.at(-1), "(+250 more)", "array cap tightened to 200 and says how many were left out");
    const snap = e.lines(runId).find((l) => l.type === "snapshot")!;
    assert.equal(snap.d.unitsTotal, 500);
    assert.equal(snap.d.units.length, 400);
    assert.equal(snap.d.omitted, 100);
    await e.close();
  });

  summary("probe-recorder-client");
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
