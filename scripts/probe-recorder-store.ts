/**
 * 试玩记录仪 Step 1：记录合同与可靠存储（服务端）。运行：node --import tsx scripts/probe-recorder-store.ts
 *
 * 全部用合成事件，走生产存储/导出/路由代码：
 *   持久 ACK（确认过的事件重启后一定在）· 重传去重（含重启后）· 同编号不同内容 = 冲突不覆盖 ·
 *   跨局绑定（知道 runId 也写不进别人的局）· 尾部半行修复 · 配额/满盘 · 到期清理 ·
 *   邀请只存哈希 · ZIP/离线 HTML（转义、无脚本、无外链、校验和、截止水位）· HTTP 鉴权与三开关。
 * 关键保护都有“摘掉保护 ⇒ 同一断言真的失败”的负对照。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, readdirSync, chmodSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { test, mustFail, tempDir, rm, ev, startServer, summary } from "./recorder-test-lib";

async function main() {
  const { RecorderStore } = await import("../apps/server/src/recorder/store");
  const { exportRun, listRuns } = await import("../apps/server/src/recorder/export");
  const { readZip } = await import("../apps/server/src/recorder/zip");
  const { createRecorder } = await import("../apps/server/src/recorder/routes");
  type Store = InstanceType<typeof RecorderStore>;

  const RUN_A = "rAAAAAAAAAAAAAAAAAAAAAAAA1";
  const RUN_B = "rBBBBBBBBBBBBBBBBBBBBBBBB2";
  const PID = "cPIDaaaaaaaaaaaaaaa1";
  const diskEids = (dir: string, run: string) => {
    const f = join(dir, "runs", `${run}.jsonl`);
    if (!existsSync(f)) return [] as string[];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).eid as string);
  };
  const clientEids = (dir: string, run: string) => diskEids(dir, run).filter((e) => !e.startsWith("srv-"));
  async function fresh(label: string, limits = {}) {
    const dir = tempDir(label);
    const store = await RecorderStore.open(dir, limits);
    const a = await store.createInvite();
    const b = await store.createInvite();
    return { dir, store, a, b };
  }

  // ── 持久 ACK ─────────────────────────────────────────────
  await test("S1 ★持久 ACK：确认过的每一条，立刻“崩溃重启”（新进程重扫文件）后都在盘上", async () => {
    const { dir, store, a } = await fresh("ack");
    const events = [1, 2, 3, 4, 5].map((i) => ev(RUN_A, PID, i, "trace", { stage: "turn", data: { text: `第${i}句` } }));
    const r = await store.ingest(a.tid, RUN_A, events);
    assert.equal(r.status, 200);
    const acked = (r.body as { acked: string[] }).acked;
    assert.equal(acked.length, 5);
    // 不走 drain、不 flush：模拟 ACK 一发出进程就没了，下一次启动只能看盘上有什么
    const reopened = await RecorderStore.open(dir);
    const onDisk = new Set(clientEids(dir, RUN_A));
    for (const e of acked) assert.ok(onDisk.has(e), `acked ${e} must be on disk`);
    assert.equal(reopened.summaryOf(RUN_A)?.count, diskEids(dir, RUN_A).length);
    rm(dir);
  });
  await test("S1-负对照：把“等 fsync 再 ACK”摘掉（写队列直接放行、从不落盘）⇒ 确认过的事件重启后不在，同一断言失败", async () => {
    const { dir, store, a } = await fresh("ack-neg");
    const s = store as unknown as { enqueueLines: (...x: unknown[]) => Promise<void>; flush: () => Promise<void> };
    s.enqueueLines = () => Promise.resolve();   // 摘保护：ACK 不再等落盘
    s.flush = async () => {};
    const events = [1, 2, 3].map((i) => ev(RUN_A, PID, i, "trace", { stage: "turn", data: {} }));
    const r = await store.ingest(a.tid, RUN_A, events);
    const acked = (r.body as { acked: string[] }).acked;
    await mustFail("acked ⊆ disk", () => {
      const onDisk = new Set(clientEids(dir, RUN_A));
      for (const e of acked) assert.ok(onDisk.has(e));
    });
    rm(dir);
  });

  // ── 去重 / 冲突 ───────────────────────────────────────────
  await test("S2 ★重传去重：同一批传两次、ACK 丢了再传、重启后再传 ⇒ 盘上每个编号只一行", async () => {
    const { dir, store, a } = await fresh("dedup");
    const batch = [1, 2, 3].map((i) => ev(RUN_A, PID, i, "message", { op: "add", id: i, text: `m${i}` }));
    assert.equal((await store.ingest(a.tid, RUN_A, batch)).status, 200);
    const again = await store.ingest(a.tid, RUN_A, batch);
    assert.deepEqual((again.body as { acked: string[] }).acked.sort(), batch.map((e) => e.eid).sort());
    // 同一批里重复同一条
    await store.ingest(a.tid, RUN_A, [batch[0], batch[0]]);
    const s2 = await RecorderStore.open(dir);
    const r3 = await s2.ingest(a.tid, RUN_A, batch);
    assert.equal(r3.status, 200);
    const ids = clientEids(dir, RUN_A);
    assert.equal(ids.length, 3, `each eid once: ${ids.join(",")}`);
    assert.equal(new Set(ids).size, 3);
    rm(dir);
  });
  await test("S2-负对照：重启后不重建去重表（清空 eid 表）⇒ 重传被写成重复行，同一断言失败", async () => {
    const { dir, store, a } = await fresh("dedup-neg");
    const batch = [1, 2].map((i) => ev(RUN_A, PID, i, "message", { op: "add", id: i }));
    await store.ingest(a.tid, RUN_A, batch);
    const s2 = await RecorderStore.open(dir);
    const runs = (s2 as unknown as { runs: Map<string, { eids: Map<string, string> }> }).runs;
    runs.get(RUN_A)!.eids.clear(); // 摘保护
    await s2.ingest(a.tid, RUN_A, batch);
    await mustFail("each eid once after restart", () => assert.equal(clientEids(dir, RUN_A).length, 2));
    rm(dir);
  });
  await test("S3 ★同编号不同内容 ⇒ 点名拒收（conflict），旧事实不被覆盖，并留一条冲突标记；重启后照样判冲突", async () => {
    const { dir, store, a } = await fresh("conflict");
    const e1 = ev(RUN_A, PID, 1, "message", { op: "add", id: 1, text: "原文" });
    await store.ingest(a.tid, RUN_A, [e1]);
    const forged = { ...e1, d: { op: "add", id: 1, text: "改过的" } };
    const r = await store.ingest(a.tid, RUN_A, [forged]);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as { rejected: { eid: string; reason: string }[] }).rejected, [{ eid: e1.eid, reason: "conflict" }]);
    await store.flush();
    const lines = readFileSync(join(dir, "runs", `${RUN_A}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.eid === e1.eid).length, 1);
    assert.equal(lines.find((l) => l.eid === e1.eid).d.text, "原文");
    assert.ok(lines.some((l) => l.type === "srv_marker" && l.d.kind === "conflict"));
    const s2 = await RecorderStore.open(dir);
    const r2 = await s2.ingest(a.tid, RUN_A, [forged]);
    assert.equal((r2.body as { rejected: { reason: string }[] }).rejected[0]?.reason, "conflict");
    rm(dir);
  });

  // ── 跨局绑定 ─────────────────────────────────────────────
  await test("S4 ★跨局绑定：A 的局首见即绑定给 A；B 拿着同一个 runId 写不进（整批点名拒收），盘上没有 B 的一条", async () => {
    const { dir, store, a, b } = await fresh("bind");
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", { scenario: "el_alamein" })]);
    const r = await store.ingest(b.tid, RUN_A, [ev(RUN_A, "cPIDbbbbbbbbbbbbbbb2", 1, "message", { text: "伪造" })]);
    assert.equal(r.status, 400);
    assert.equal((r.body as { rejected: { reason: string }[] }).rejected[0].reason, "run_forbidden");
    assert.equal(store.appendServerFact(RUN_A, b.tid, "srv_request", "t1234", { message: "伪造" }), false);
    await store.flush();
    const lines = readFileSync(join(dir, "runs", `${RUN_A}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => l.tid === a.tid), "every line belongs to A");
    // 重启后绑定仍在（取自这一局的首条事件）
    const s2 = await RecorderStore.open(dir);
    assert.equal(s2.ownerOf(RUN_A), a.tid);
    assert.equal((await s2.ingest(b.tid, RUN_A, [ev(RUN_A, "cPIDbbbbbbbbbbbbbbb2", 2, "message", {})])).status, 400);
    rm(dir);
  });
  await test("S4-负对照：摘掉归属检查（两道：ownerOf 恒返回空，且 ensureRun 不再比对测试者）⇒ B 写进了 A 的局，同一断言失败", async () => {
    const { dir, store, a, b } = await fresh("bind-neg");
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {})]);
    const raw = store as unknown as { ownerOf: () => null; ensureRun: (r: string) => unknown; runs: Map<string, unknown> };
    raw.ownerOf = () => null;
    raw.ensureRun = (r: string) => raw.runs.get(r);
    await store.ingest(b.tid, RUN_A, [ev(RUN_A, "cPIDbbbbbbbbbbbbbbb2", 1, "message", { text: "伪造" })]);
    await store.flush();
    await mustFail("every line belongs to A", () => {
      const lines = readFileSync(join(dir, "runs", `${RUN_A}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.every((l) => l.tid === a.tid));
    });
    rm(dir);
  });

  // ── 校验 ─────────────────────────────────────────────────
  await test("S5 字段校验：服务端元数据同名字段、伪装成服务端、未知类型、敏感键名（鉴权/凭证/音频）一律点名拒收，好的照收", async () => {
    const { dir, store, a } = await fresh("validate");
    const good = ev(RUN_A, PID, 1, "message", { text: "好的" });
    const bad = [
      { ...ev(RUN_A, PID, 2, "message", {}), rt: 1 },
      { ...ev(RUN_A, PID, 3, "message", {}), tid: "Z" },
      { ...ev(RUN_A, PID, 4, "srv_result", {}), src: "server" },
      ev(RUN_A, PID, 5, "srv_result", {}),
      ev(RUN_A, PID, 6, "trace", { stage: "x", data: { headers: { authorization: "Bearer x" } } }),
      ev(RUN_A, PID, 7, "trace", { stage: "x", data: { audio: "UklGR" } }),
      ev(RUN_A, PID, 8, "trace", { stage: "x", data: { "X-Rec-Invite": "abc" } }),
      { ...ev(RUN_A, PID, 9, "message", {}), eid: `${PID}:99` },
    ];
    const r = await store.ingest(a.tid, RUN_A, [good, ...bad]);
    assert.equal(r.status, 200);
    const body = r.body as { acked: string[]; rejected: { eid: string; reason: string }[] };
    assert.deepEqual(body.acked, [good.eid]);
    assert.equal(body.rejected.length, bad.length, JSON.stringify(body.rejected));
    assert.ok(body.rejected.some((x) => x.reason.startsWith("forbidden_field")));
    rm(dir);
  });

  // ── 尾部修复 ─────────────────────────────────────────────
  await test("S6 ★崩溃留下的半行：重启时截掉、留修复标记；导出显示“已知缺失”，客户端重传那条照常补上", async () => {
    const { dir, store, a } = await fresh("tail");
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", { scenario: "el_alamein" })]);
    const file = join(dir, "runs", `${RUN_A}.jsonl`);
    const half = JSON.stringify({ rt: 1, tid: a.tid, ...ev(RUN_A, PID, 2, "message", { text: "半截" }) }).slice(0, 40);
    appendFileSync(file, half);
    const s2 = await RecorderStore.open(dir);
    const text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("\n"), "no partial tail left");
    assert.ok(!text.includes("半截"));
    const out = await exportRun(s2, RUN_A);
    assert.ok(out);
    const man = out!.manifest as { completeness: { status: string; reasons: string[] } };
    assert.equal(man.completeness.status, "known_gaps");
    assert.ok(man.completeness.reasons.some((r) => r.includes("修掉了文件尾部")));
    const r = await s2.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 2, "message", { text: "重传" })]);
    assert.equal((r.body as { acked: string[] }).acked.length, 1);
    rm(dir);
  });

  // ── 配额 ─────────────────────────────────────────────────
  await test("S7 配额：单局采样额度满 ⇒ 采样点名拒收、关键照收；单局总额满 ⇒ 关键也点名拒收并留标记；全局满 ⇒ 507（客户端保留重试）", async () => {
    const { dir, store, a } = await fresh("quota", { runSampleMaxBytes: 2500, runMaxBytes: 6000 });
    const big = "x".repeat(900);
    const samples = [1, 2, 3, 4].map((i) => ev(RUN_A, PID, i, "snapshot", { reason: "periodic", pad: big }));
    const r1 = await store.ingest(a.tid, RUN_A, samples);
    const rej1 = (r1.body as { rejected: { reason: string }[] }).rejected;
    assert.ok(rej1.length >= 1 && rej1.every((x) => x.reason === "run_sample_quota"), JSON.stringify(rej1));
    const crit = [5, 6, 7, 8, 9, 10].map((i) => ev(RUN_A, PID, i, "trace", { stage: "exec", data: { pad: big } }));
    const r2 = await store.ingest(a.tid, RUN_A, crit);
    const rej2 = (r2.body as { rejected: { reason: string }[] }).rejected;
    assert.ok(rej2.some((x) => x.reason === "run_quota"), JSON.stringify(rej2));
    await store.flush();
    const out = await exportRun(store, RUN_A);
    assert.equal((out!.manifest as { completeness: { status: string } }).completeness.status, "known_gaps");
    rm(dir);
    const g = await fresh("global", { globalMaxBytes: 1024 * 1024 + 3000, markerReserveBytes: 1024 * 1024 });
    const r3 = await g.store.ingest(g.a.tid, RUN_B, [5, 6, 7, 8].map((i) => ev(RUN_B, PID, i, "trace", { stage: "exec", data: { pad: big } })));
    assert.equal(r3.status, 507);
    assert.deepEqual(r3.body, { recorder: "storage_full" });
    rm(g.dir);
  });
  await test("S8 服务端事实队列过载 ⇒ 丢的计数、下一次落盘写“丢了 N 条”；导出不报完整", async () => {
    const { dir, store, a } = await fresh("facts", { serverFactQueueMax: 3, factFlushMs: 50 });
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {})]);
    let ok = 0;
    for (let i = 0; i < 10; i++) if (store.appendServerFact(RUN_A, a.tid, "srv_request", "t1234", { attempt: `a${i}`, message: `m${i}` })) ok++;
    assert.ok(ok < 10);
    await store.flush(); await store.flush();
    const lines = readFileSync(join(dir, "runs", `${RUN_A}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const m = lines.find((l) => l.type === "srv_marker" && l.d.kind === "facts_dropped");
    assert.ok(m, "a facts_dropped marker");
    const out = await exportRun(store, RUN_A);
    const c = (out!.manifest as { completeness: { status: string; reasons: string[] } }).completeness;
    assert.equal(c.status, "known_gaps");
    assert.ok(c.reasons.some((r) => r.includes("服务端自己的事实丢了")));
    rm(dir);
  });
  await test("S9 服务端不可写（目录只读）⇒ 上传回 503、不 ACK；恢复可写后重传成功且不重复", async () => {
    const { dir, store, a } = await fresh("rofs");
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {})]);
    const runs = join(dir, "runs");
    const file = join(runs, `${RUN_A}.jsonl`);
    chmodSync(file, 0o444);
    const r = await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 2, "message", { text: "写不进" })]);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { recorder: "write_failed" });
    chmodSync(file, 0o644);
    const r2 = await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 2, "message", { text: "写不进" })]);
    assert.equal(r2.status, 200);
    assert.equal(clientEids(dir, RUN_A).filter((e) => e === `${PID}:2`).length, 1);
    rm(dir);
  });

  // ── 到期清理 ─────────────────────────────────────────────
  await test("S10 到期清理：超过保留期的局删掉；24 小时内还有事件的“进行中”局不碰", async () => {
    let now = 1_800_000_000_000;
    const dir = tempDir("retention");
    const store = await RecorderStore.open(dir, { retentionMs: 14 * 86400e3 }, { now: () => now });
    const a = await store.createInvite();
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {})]);
    now += 15 * 86400e3;
    await store.ingest(a.tid, RUN_B, [ev(RUN_B, PID, 1, "run_start", {})]);
    const removed = await store.sweepRetention();
    assert.deepEqual(removed, [RUN_A]);
    assert.ok(!existsSync(join(dir, "runs", `${RUN_A}.jsonl`)));
    assert.ok(existsSync(join(dir, "runs", `${RUN_B}.jsonl`)));
    rm(dir);
  });

  // ── 邀请 ─────────────────────────────────────────────────
  await test("S11 ★邀请只存哈希与匿名代号：文件里没有凭证原文；作废后重启仍作废；未知凭证认不出", async () => {
    const { dir, store, a, b } = await fresh("invite");
    const text = readFileSync(join(dir, "invites.jsonl"), "utf8");
    assert.ok(!text.includes(a.token) && !text.includes(b.token), "token never stored");
    assert.equal(store.testerForToken(a.token)?.tid, a.tid);
    await store.revokeInvite(a.tid);
    const s2 = await RecorderStore.open(dir);
    assert.ok(s2.testerForToken(a.token)?.revokedAt, "revoked after restart");
    assert.equal(s2.testerForToken(b.token)?.revokedAt, null);
    assert.equal(s2.testerForToken("x".repeat(32)), null);
    assert.deepEqual([a.tid, b.tid], ["A", "B"]);
    rm(dir);
  });

  // ── 导出 ─────────────────────────────────────────────────
  const XSS = `<script>alert("x")</script><img src=x onerror=alert(1)> ../../etc/passwd https://evil.example/a.js`;
  async function sampleRun(store: Store, tid: string, closed: boolean) {
    const evs = [
      ev(RUN_A, PID, 1, "run_start", { scenario: "el_alamein", params: {} }, { gt: 0 }),
      ev(RUN_A, PID, 2, "trace", { stage: "turn", data: { channel: "combat", text: XSS, voice: false } }, { gt: 12, turn: "t-0001-aaaa" }),
      ev(RUN_A, PID, 3, "message", { op: "add", id: 5, text: XSS, channel: "combat", from: "player", source: "player" }, { gt: 12, runFrom: "current" }),
      ev(RUN_A, PID, 4, "trace", { stage: "exec", data: { applied: [31, 32], intents: [{ orders: [{ action: "defend", units: [31, 32], target: { x: 10, y: 20 } }] }], receipt: ["2 个去北线前哨"], planTraceId: "t-0001-aaaa" } }, { gt: 14, turn: "t-0001-aaaa", turnFrom: "current" }),
      ev(RUN_A, PID, 5, "snapshot", { reason: "exec", units: [[31, "infantry", 10, 20, 100, "moving", "defend", 30, 40, 0], [32, "infantry", 11, 20, 100, "moving", "defend", 30, 40, 0], [33, "infantry", 5, 5, 100, "idle", null, null, null, 0]] }, { gt: 14 }),
      ev(RUN_A, PID, 6, "flag", { text: XSS }, { gt: 20, turn: "t-0001-aaaa", turnFrom: "current", runFrom: "current" }),
      ev(RUN_A, PID, 7, "game_end", { winner: "player", reason: "测试" }, { gt: 30 }),
    ];
    if (closed) evs.push(ev(RUN_A, PID, 8, "producer_close", { lastSeq: 8 }));
    const r = await store.ingest(tid, RUN_A, evs);
    assert.equal(r.status, 200);
    store.appendServerFact(RUN_A, tid, "srv_request", "t-0001-aaaa", { attempt: "at1", route: "/api/command-stream", message: XSS });
    store.appendServerFact(RUN_A, tid, "srv_model_raw", "t-0001-aaaa", { attempt: "at1", mode: "stream", text: XSS + "模型原文" });
    store.appendServerFact(RUN_A, tid, "srv_attempt_end", "t-0001-aaaa", { attempt: "at1", status: 200 });
    await store.flush();
  }
  await test("S12 ★ZIP 包：七个文件、manifest 校验和与内容一致；report.html 全部转义、无脚本、无外链、有 CSP；包内分类不另算", async () => {
    const { dir, store, a } = await fresh("zip");
    await sampleRun(store, a.tid, true);
    const out = await exportRun(store, RUN_A);
    assert.ok(out);
    const files = readZip(out!.zip);
    assert.deepEqual([...files.keys()].sort(), ["README.txt", "events.jsonl", "feedback.json", "manifest.json", "report.html", "snapshots.jsonl", "traces.jsonl"]);
    const man = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const { createHash } = await import("node:crypto");
    for (const f of man.files) {
      assert.equal(createHash("sha256").update(files.get(f.name)!).digest("hex"), f.sha256, `${f.name} checksum`);
      assert.equal(files.get(f.name)!.length, f.bytes);
    }
    const html = files.get("report.html")!.toString("utf8");
    assert.ok(!/<script/i.test(html), "no script tag at all");
    assert.ok(!/onerror=/i.test(html.replace(/&lt;img src=x onerror=/g, "")), "no live handler");
    assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"), "escaped");
    assert.ok(!/(src|href)\s*=\s*"https?:/i.test(html), "no external resource");
    assert.ok(html.includes(`Content-Security-Policy" content="default-src 'none'`));
    // 各文件行数之和 = 截止水位内的行数（同一事实源的分类，不另算）
    const n = (name: string) => files.get(name)!.toString("utf8").split("\n").filter(Boolean).length;
    assert.equal(n("events.jsonl") + n("traces.jsonl") + n("snapshots.jsonl"), man.cutoff.lines);
    const fb = JSON.parse(files.get("feedback.json")!.toString("utf8"));
    assert.equal(fb.flags.length, 1);
    assert.deepEqual(fb.endFeedback, []);
    assert.equal(man.tester, a.tid);
    assert.equal(man.completeness.status, "complete", JSON.stringify(man.completeness.reasons));
    assert.ok(files.get("README.txt")!.toString("utf8").includes("不能证明什么"));
    // 文件名只由服务器生成
    assert.match(out!.filename, /^playtest-A-rAAAAAAAAAAA-[0-9TZ-]+\.zip$/);
    rm(dir);
  });
  await test("S13 完整性三分：没关页收尾 ⇒ 完整性未知；缺序号 ⇒ 已知缺失；两样都齐 ⇒ 已确认完整", async () => {
    const f1 = await fresh("c1");
    await sampleRun(f1.store, f1.a.tid, false);
    assert.equal(((await exportRun(f1.store, RUN_A))!.manifest as { completeness: { status: string } }).completeness.status, "unknown");
    rm(f1.dir);
    const f2 = await fresh("c2");
    await f2.store.ingest(f2.a.tid, RUN_A, [
      ev(RUN_A, PID, 1, "run_start", {}), ev(RUN_A, PID, 3, "game_end", {}), ev(RUN_A, PID, 4, "producer_close", { lastSeq: 4 }),
    ]);
    const c2 = ((await exportRun(f2.store, RUN_A))!.manifest as { completeness: { status: string; reasons: string[] } }).completeness;
    assert.equal(c2.status, "known_gaps");
    assert.ok(c2.reasons.some((r) => r.includes("缺序号 2")), c2.reasons.join("|"));
    rm(f2.dir);
  });
  await test("S14 ★中途导出 vs 结束后导出：各有截止水位；前一个包说“未确认完整”，不冒充最终包；两包各自校验和自洽", async () => {
    const { dir, store, a } = await fresh("cutoff");
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {}), ev(RUN_A, PID, 2, "message", { text: "中途" })]);
    const mid = await exportRun(store, RUN_A);
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 3, "game_end", {}), ev(RUN_A, PID, 4, "producer_close", { lastSeq: 4 })]);
    const end = await exportRun(store, RUN_A);
    const m1 = mid!.manifest as { cutoff: { lines: number; bytes: number }; completeness: { status: string } };
    const m2 = end!.manifest as { cutoff: { lines: number; bytes: number }; completeness: { status: string } };
    assert.ok(m1.cutoff.lines < m2.cutoff.lines && m1.cutoff.bytes < m2.cutoff.bytes);
    assert.notEqual(m1.completeness.status, "complete");
    assert.equal(m2.completeness.status, "complete");
    for (const out of [mid!, end!]) {
      const files = readZip(out.zip);
      const man = JSON.parse(files.get("manifest.json")!.toString("utf8"));
      const { createHash } = await import("node:crypto");
      for (const f of man.files) assert.equal(createHash("sha256").update(files.get(f.name)!).digest("hex"), f.sha256);
    }
    rm(dir);
  });
  await test("S15 管理员列表：按测试者分、第几局按开局先后、问题标记数与完整性标签", async () => {
    const { dir, store, a, b } = await fresh("list");
    await sampleRun(store, a.tid, true);
    await store.ingest(a.tid, RUN_B, [ev(RUN_B, PID, 1, "run_start", { scenario: "tutorial" })]);
    await store.ingest(b.tid, "rCCCCCCCCCCCCCCCCCCCCCCCC3", [ev("rCCCCCCCCCCCCCCCCCCCCCCCC3", "cPIDccccccccccccccc3", 1, "run_start", { scenario: "el_alamein" })]);
    const rows = listRuns(store);
    const ra = rows.filter((r) => r.tid === "A");
    assert.equal(ra.length, 2);
    assert.deepEqual(ra.map((r) => r.index), [1, 2]);
    assert.equal(ra[0].flags, 1);
    assert.equal(ra[0].completeness.label, "已确认完整");
    assert.equal(rows.filter((r) => r.tid === "B").length, 1);
    rm(dir);
  });

  // ── HTTP：三开关与鉴权 ───────────────────────────────────
  const ADMIN = "admin-token-for-tests-0123456789";
  async function http(collect: boolean, adminToken: string | null = ADMIN) {
    const dir = tempDir("http");
    const rec = createRecorder({ dataDir: dir, collect, adminToken, limits: {}, buildInfo: { build: "test" } });
    await rec.ready;
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use(rec.router);
    const srv = await startServer(app as unknown as Parameters<typeof startServer>[0]);
    return { dir, rec, srv };
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  await test("S16 ★HTTP 三开关：采集关 ⇒ 410 {recorder:closed}；未知凭证 ⇒ 403 invite_unknown；作废 ⇒ 410 invite_revoked；正常 ⇒ 200 ack", async () => {
    const off = await http(false);
    const r0 = await post(`${off.srv.url}/api/rec/events`, { v: 1, run: RUN_A, events: [ev(RUN_A, PID, 1, "run_start", {})] }, { "X-Rec-Invite": "whatever-whatever-1" });
    assert.equal(r0.status, 410);
    assert.deepEqual(await r0.json(), { recorder: "closed" });
    await off.srv.close(); rm(off.dir);
    const on = await http(true);
    const inv = await on.rec.store()!.createInvite();
    const bad = await post(`${on.srv.url}/api/rec/events`, { v: 1, run: RUN_A, events: [ev(RUN_A, PID, 1, "run_start", {})] }, { "X-Rec-Invite": "unknown-token-000000" });
    assert.equal(bad.status, 403);
    assert.deepEqual(await bad.json(), { recorder: "invite_unknown" });
    const ok = await post(`${on.srv.url}/api/rec/events`, { v: 1, run: RUN_A, events: [ev(RUN_A, PID, 1, "run_start", {})] }, { "X-Rec-Invite": inv.token });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { acked: string[] }).acked.length, 1);
    await on.rec.store()!.revokeInvite(inv.tid);
    const rv = await post(`${on.srv.url}/api/rec/events`, { v: 1, run: RUN_A, events: [ev(RUN_A, PID, 2, "message", {})] }, { "X-Rec-Invite": inv.token });
    assert.equal(rv.status, 410);
    assert.deepEqual(await rv.json(), { recorder: "invite_revoked" });
    await on.srv.close(); rm(on.dir);
  });
  await test("S17 ★管理员鉴权：无凭证/错凭证 401；对的凭证能列表、看报告、下 ZIP；凭证不在 URL 也能用；路径穿越的 runId 400；没配管理员凭证整组 404", async () => {
    const h = await http(true);
    const inv = await h.rec.store()!.createInvite();
    await post(`${h.srv.url}/api/rec/events`, { v: 1, run: RUN_A, events: [ev(RUN_A, PID, 1, "run_start", { scenario: "el_alamein" })] }, { "X-Rec-Invite": inv.token });
    assert.equal((await fetch(`${h.srv.url}/api/rec/admin/runs`)).status, 401);
    assert.equal((await fetch(`${h.srv.url}/api/rec/admin/runs`, { headers: { Authorization: "Bearer wrong-wrong-wrong-wrong" } })).status, 401);
    assert.equal((await fetch(`${h.srv.url}/api/rec/admin/runs?token=${ADMIN}`)).status, 401, "token in URL is not accepted");
    const auth = { Authorization: `Bearer ${ADMIN}` };
    const list = await fetch(`${h.srv.url}/api/rec/admin/runs`, { headers: auth });
    assert.equal(list.status, 200);
    const j = await list.json() as { runs: { runId: string }[] };
    assert.equal(j.runs[0].runId, RUN_A);
    const zip = await fetch(`${h.srv.url}/api/rec/admin/runs/${RUN_A}/zip`, { headers: auth });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.match(zip.headers.get("content-disposition") ?? "", /attachment; filename="playtest-A-/);
    for (const badId of ["..%2F..%2Fetc%2Fpasswd", "..", "a"]) {
      const r = await fetch(`${h.srv.url}/api/rec/admin/runs/${badId}/zip`, { headers: auth });
      assert.ok(r.status === 400 || r.status === 404, `${badId} → ${r.status}`);
    }
    const page = await fetch(`${h.srv.url}/rec-admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const pageText = await page.text();
    assert.ok(!pageText.includes(ADMIN), "page carries no credential");
    await h.srv.close(); rm(h.dir);
    const noAdmin = await http(true, null);
    assert.equal((await fetch(`${noAdmin.srv.url}/api/rec/admin/runs`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${noAdmin.srv.url}/rec-admin`)).status, 404);
    await noAdmin.srv.close(); rm(noAdmin.dir);
  });
  await test("S18 停机排空：排队中的服务端事实全部落盘、写一条“服务端生产者最后序号”；之后的上传回 503 shutting_down（客户端会重试）", async () => {
    const { dir, store, a } = await fresh("drain", { factFlushMs: 60_000 });
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {})]);
    for (let i = 0; i < 50; i++) store.appendServerFact(RUN_A, a.tid, "srv_request", "t1234", { attempt: `a${i}`, message: `m${i}` });
    const before = diskEids(dir, RUN_A).filter((e) => e.startsWith("srv-")).length;
    const out = await store.drain();
    assert.equal(out.leftover, 0);
    const after = readFileSync(join(dir, "runs", `${RUN_A}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const srv = after.filter((l) => l.src === "server");
    assert.ok(before < srv.length, `pending facts were only in memory before drain (${before} on disk)`);
    assert.equal(srv.filter((l) => l.type === "srv_request").length, 50);
    const close = srv.find((l) => l.type === "srv_producer_close");
    assert.ok(close && close.d.lastSeq === close.seq);
    const r = await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 2, "message", {})]);
    assert.equal(r.status, 503);
    rm(dir);
  });
  await test("S18-负对照：不排空直接“退出”（新进程重扫）⇒ 排队中的服务端事实不在盘上，同一断言失败", async () => {
    const { dir, store, a } = await fresh("drain-neg", { factFlushMs: 60_000 });
    await store.ingest(a.tid, RUN_A, [ev(RUN_A, PID, 1, "run_start", {})]);
    for (let i = 0; i < 50; i++) store.appendServerFact(RUN_A, a.tid, "srv_request", "t1234", { attempt: `a${i}` });
    await mustFail("all 50 facts on disk", () => {
      const lines = readFileSync(join(dir, "runs", `${RUN_A}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(lines.filter((l) => l.type === "srv_request").length, 50);
    });
    void statSync; void readdirSync; void writeFileSync;
    rm(dir);
  });

  summary("probe-recorder-store");
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
