/**
 * 试玩记录仪：消息变更点、隐私出口、凭证不符只不记录、TTS 零改动。
 * 运行：node --import tsx scripts/probe-recorder-privacy.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { test, mustFail, rm, summary } from "./recorder-test-lib";
import { recordingServer, realFetch, order, NP } from "./recorder-chain-lib";
import { activateRecorder, recordStartRun, recorderStatus, recordTrace, recorderHeaders } from "../apps/web/src/recorder/index";
import { MemoryBackend } from "../apps/web/src/recorder/queue";
import * as messageStore from "../apps/web/src/messageStore";
import * as core from "@ai-commander/core";

const SECRET_WORDS = "长官我的真名叫张三住在幸福路八号";

async function main() {
  const env = await recordingServer();
  const inv = await env.store.createInvite();
  const other = await env.store.createInvite();
  // 同意框的 effect 在 StrictMode 下跑两遍 ⇒ 两次并发激活（浏览器手测抓到的竞态）。这里原样复现。
  const opts = { apiUrl: env.srv.url, deps: { fetch: (u: string, i: unknown) => realFetch(u, i as RequestInit) as never }, backend: new MemoryBackend(), limits: { uploadBusyMs: 5, uploadIdleMs: 20 } };
  await Promise.all([activateRecorder(inv.token, opts), activateRecorder(inv.token, opts)]);
  const drain = async () => {
    await new Promise((r) => setTimeout(r, 20));
    for (let k = 0; k < 400 && (recorderStatus()?.queued ?? 0) > 0; k++) await new Promise((r) => setTimeout(r, 10));
    await env.store.flush();
  };
  const linesOf = async (runId: string) => (await env.store.readRun(runId))!.lines;

  await test("P0 ★两次并发激活（StrictMode 下同意框的 effect 跑两遍）⇒ 只有一个核心：开局登记后，命令请求头与状态都认得这一局", () => {
    const s = core.createInitialGameState("el_alamein");
    recordStartRun(s, { search: "" });
    const st = recorderStatus()!;
    assert.ok(st.runId, "the run is registered on the one live core");
    assert.deepEqual(Object.keys(recorderHeaders(s)).sort(), ["X-Rec-Invite", "X-Rec-Run"]);
  });

  // ── 消息仓库的三个变更点 ─────────────────────────────────
  await test("P1 ★消息三个变更点（新增／改写最后一条玩家消息／清空）各记一条，按“局号＋消息编号”；被挤出 200 条不是事件、不记成清空", async () => {
    const s = core.createInitialGameState("el_alamein");
    recordStartRun(s, { search: "" });
    const runId = recorderStatus()!.runId!;
    messageStore.clearMessages();
    messageStore.addMessage("info", "🎤 …", 3, "combat", "player", "player");
    messageStore.updateLastPlayerMessage("combat", "北线那两个撤回来");
    messageStore.addMessage("info", "群里说一句", 4, "combat", "player", "player", true);
    for (let i = 0; i < 205; i++) messageStore.addMessage("info", `战报${i}`, 5, "ops", undefined, "event_report");
    messageStore.clearMessages();
    messageStore.addMessage("info", "等待指令...", 0, "ops", "system", "system");
    await drain();
    const msgs = (await linesOf(runId)).filter((l) => l.type === "message");
    const ops = msgs.map((l) => (l.d as Record<string, unknown>).op);
    assert.equal(ops.filter((o) => o === "clear").length, 2, "exactly the two explicit clears");
    assert.equal(ops.filter((o) => o === "add").length, 1 + 1 + 205 + 1);
    const upd = msgs.find((l) => (l.d as Record<string, unknown>).op === "update")!;
    assert.equal((upd.d as Record<string, unknown>).text, "北线那两个撤回来");
    assert.equal((upd.d as Record<string, unknown>).id, 1, "update names the placeholder's message id");
    const group = msgs.find((l) => (l.d as Record<string, unknown>).text === "群里说一句")!;
    assert.equal((group.d as Record<string, unknown>).groupChat, true);
    const last = msgs[msgs.length - 1];
    assert.equal((last.d as Record<string, unknown>).id, 1, "ids restart at 1 after a clear");
    assert.ok(msgs.every((l) => l.runFrom === "current"), "marked as taken from the current run");
  });

  // ── 凭证不符：只是不记录，命令照常 ───────────────────────────
  const post = (headers: Record<string, string>, traceId: string) => realFetch(`${env.srv.url}/api/command`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ digest: "DIGEST", message: SECRET_WORDS, channel: "combat", sessionId: "s", traceId }),
  });
  await test("P2 ★命令请求头：没头／错凭证／作废凭证／拿别人的局号 ⇒ 命令照常 200、服务端一条不记；对的头 ⇒ 记在这一局", async () => {
    const mine = core.createInitialGameState("el_alamein");
    recordStartRun(mine, { search: "" });
    const myRun = recorderStatus()!.runId!;
    await drain();   // 这一局先被浏览器自己的首批事件绑定给测试者 A
    assert.equal(env.store.ownerOf(myRun), inv.tid);
    const reply = order("收到。", [{ type: "defend", fromFront: "front_center", quantity: 2, targetFacility: NP }]);
    const runsBefore = env.store.runSummaries().length;
    env.S.llm.queue = [reply, reply, reply, reply];
    const r1 = await post({}, "t-p2a-0001");
    const r2 = await post({ "X-Rec-Invite": "not-a-real-invite-0000", "X-Rec-Run": "rZZZZZZZZZZZZZZZZZZZZZZ9" }, "t-p2b-0001");
    const r3 = await post({ "X-Rec-Invite": other.token, "X-Rec-Run": myRun }, "t-p2c-0001");
    for (const r of [r1, r2, r3]) { assert.equal(r.status, 200); assert.ok(Array.isArray((await r.json() as { options: unknown[] }).options)); }
    await env.store.flush();
    assert.equal(env.store.runSummaries().length, runsBefore, "no run created by bad headers");
    assert.ok(!(await linesOf(myRun)).some((l) => l.turn === "t-p2c-0001"), "another tester cannot write server facts into my run");
    const r4 = await post({ "X-Rec-Invite": inv.token, "X-Rec-Run": myRun }, "t-p2d-0001");
    assert.equal(r4.status, 200);
    await r4.json();
    await env.store.flush();
    const facts = (await linesOf(myRun)).filter((l) => l.turn === "t-p2d-0001");
    assert.ok(facts.some((l) => l.type === "srv_request" && (l.d as Record<string, unknown>).message === SECRET_WORDS));
    assert.ok(facts.every((l) => !("sessionId" in (l.d as Record<string, unknown>))), "browser id not archived");
    assert.equal(env.S.llm.queue.length, 0);
  });

  // ── 生产控制台只打长度 ───────────────────────────────────
  function capture(fn: () => Promise<void> | void) {
    const out: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...a: unknown[]) => { out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    console.log = grab; console.warn = grab; console.error = grab;
    return Promise.resolve().then(fn).finally(() => { Object.assign(console, orig); }).then(() => out.join("\n"));
  }
  await test("P3 ★生产环境控制台：[EVENT] 行不含玩家原话/听写/模型的话（只有长度），开发环境照旧（对照）", async () => {
    const idx = readFileSync("apps/server/src/index.ts", "utf8");
    const sf = ts.createSourceFile("index.ts", idx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const pick: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && ["logEvent", "consoleSafe", "logHeard"].includes(n.name?.text ?? "")) pick.push(n.getText(sf));
      if (ts.isVariableStatement(n) && n.getText(sf).includes("CONSOLE_SAFE_KEYS = new Set")) pick.push(n.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.equal(pick.length, 4);
    const js = ts.transpileModule(pick.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const mod = new Function("echoesHeard", `${js}\nreturn { logEvent, logHeard };`)(() => false) as { logEvent: (o: Record<string, unknown>) => void; logHeard: (...a: unknown[]) => void };
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const prod = await capture(() => {
        mod.logEvent({ type: "command", route: "command-stream", sessionId: "s1", channel: "combat", message: SECRET_WORDS, prevSpeech: { firstSoundMs: 1, text: SECRET_WORDS } });
        mod.logHeard("s1", "combat", SECRET_WORDS, undefined, SECRET_WORDS);
        mod.logEvent({ type: "advisor_intents", options: [[{ type: "defend", toFront: "front_coastal" }]], warning: SECRET_WORDS });
      });
      assert.ok(prod.includes("[EVENT]"));
      assert.ok(!prod.includes("张三") && !prod.includes("幸福路"), `no raw words: ${prod}`);
      assert.match(prod, /\(len=\d+\)/);
      assert.ok(prod.includes("front_coastal") && prod.includes("command-stream"), "ids stay readable");
      process.env.NODE_ENV = "development";
      const dev = await capture(() => mod.logEvent({ type: "command", message: SECRET_WORDS }));
      assert.ok(dev.includes("张三"), "development keeps the text (control)");
    } finally { process.env.NODE_ENV = saved; }
  });
  await test("P4 ★生产环境控制台：模型解析失败的四处（非流/流/群聊/短报）只打长度，不打原文片段", async () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const bad = { kind: "text" as const, text: `${SECRET_WORDS} 不是 JSON` };
      const out = await capture(async () => {
        env.S.llm.queue = [bad];
        await env.S.ai.callAdvisor("DIGEST", "x", "", "combat", undefined, "t-p4a-0001");
        env.S.llm.queue = [bad];
        for await (const _e of env.S.ai.callAdvisorStream("DIGEST", "x", "", "combat", undefined, "t-p4b-0001")) { /* drain */ }
        env.S.llm.queue = [bad];
        await env.S.ai.callGroupAdvisor("DIGEST", "x", "", "");
        env.S.llm.queue = [bad];
        await env.S.ai.callLightBrief("DIGEST", "combat", "brief");
      });
      assert.equal(env.S.llm.queue.length, 0);
      for (const tag of ["LLM returned invalid JSON", "Stream: failed to parse JSON", "Group LLM returned invalid JSON", "[lightBrief] channel=combat validation_failed"]) {
        assert.ok(out.includes(tag), `${tag} logged`);
      }
      assert.ok(!out.includes("张三"), `no raw model text in production console:\n${out}`);
      assert.equal((out.match(/\(len=\d+\)/g) ?? []).length, 4);
    } finally { process.env.NODE_ENV = saved; }
  });
  await test("P4-负对照：同样四处在开发环境会打出原文片段（证明上面的断言咬得住）", async () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      const out = await capture(async () => {
        env.S.llm.queue = [{ kind: "text", text: `${SECRET_WORDS} 不是 JSON` }];
        await env.S.ai.callAdvisor("DIGEST", "x", "", "combat");
      });
      await mustFail("no raw text", () => assert.ok(!out.includes("张三")));
    } finally { process.env.NODE_ENV = saved; }
  });

  // ── TTS 零改动 ───────────────────────────────────────────
  await test("P5 ★tts/index.ts 与基线逐字节相同；既有单槽 playbackObserver 只有 ChatPanel 那一处在用；记录器与 TTS 包装不碰它", () => {
    execFileSync("git", ["diff", "--quiet", "ac237c7", "--", "apps/web/src/tts/"]);
    const cp = readFileSync("apps/web/src/ChatPanel.tsx", "utf8");
    assert.equal((cp.match(/setPlaybackObserver\(\(/g) ?? []).length, 1);
    for (const f of ["core.ts", "index.ts", "ttsTap.ts", "RecorderGate.tsx"]) {
      assert.ok(!readFileSync(`apps/web/src/recorder/${f}`, "utf8").includes("setPlaybackObserver"), f);
    }
    const tap = readFileSync("apps/web/src/recorder/ttsTap.ts", "utf8");
    assert.match(tap, /recordTts\(text, persona, "speak"\);\s*\n\s*if \(origin === undefined\) ttsSpeak\(text, persona\);/);
  });
  await test("P6 记录器关着时（inactive）trace 入口第一行就返回：什么都不排队", async () => {
    const before = recorderStatus()!.queued;
    const { RecorderCore } = await import("../apps/web/src/recorder/core");
    const idle = new RecorderCore({ now: () => { throw new Error("must not be called"); }, randomBytes: (n) => new Uint8Array(n), fetch: () => { throw new Error("no"); },
      setTimeout: () => 0, clearTimeout: () => {}, apiUrl: "" }, new MemoryBackend());
    idle.trace("t-0000-aaaa", "exec", { applied: [1] }, {});
    idle.message("add", {}); idle.op("x"); idle.tts("x", "chen", "speak");
    assert.equal(idle.status().queued, 0);
    assert.equal(idle.internalErrors, 0, "not even reached the try block");
    void before; void recordTrace;
  });

  await env.srv.close();
  rm(env.dir);
  summary("probe-recorder-privacy");
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
