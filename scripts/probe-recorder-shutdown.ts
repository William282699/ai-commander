/**
 * 停机排空（T15 的本机部分）：按 Dockerfile 的 CMD 原样起服务（从 Dockerfile 解析出来的那条命令，
 * 从仓库根起、NODE_ENV=production），只给顶层那个进程发信号（docker stop / Fly 停机都只打 PID 1），
 * 量 5 秒内有没有自己退出、服务端自己的事实有没有排空落盘。
 * 旧起法（npm run start / npx tsx）保留为负对照：顶层先于服务端退出，正是 Dockerfile 改成直接起 node 的原因。
 * 运行：node --import tsx scripts/probe-recorder-shutdown.ts
 *
 * ★这不是 Docker：本机进程链（npm → sh → tsx → node）与容器里 npm 当 PID 1 不完全相同。
 *   Docker 那一段须在装了 Docker 的机器上另跑（scripts/probe-recorder-docker.sh），这里不冒充。
 * 模型密钥在子进程里置空（不连任何真模型）：命令会被服务端以“密钥未配置”答 503，但请求事实照记。
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test, mustFail, tempDir, rm, summary } from "./recorder-test-lib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

interface Booted { child: ChildProcess; port: number; dir: string; admin: string; logs: string[]; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }> }

/** Dockerfile 里的 CMD（exec 形式的 JSON 数组）：探针照它起服务，Dockerfile 改了这里自动跟着变。 */
const DOCKER_CMD: string[] = (() => {
  const m = /^CMD\s+(\[.*\])\s*$/m.exec(readFileSync(`${ROOT}Dockerfile`, "utf8"));
  return m ? (JSON.parse(m[1]) as string[]) : [];
})();
const EXPECTED_DOCKER_CMD = ["node", "--import", "tsx", "apps/server/src/index.ts"];
/** 起服务的方式。"dockerfile"＝Dockerfile 现在的 CMD（从仓库根起，同容器的 WORKDIR /app）；npm / npx tsx 是旧起法，只作负对照。 */
type Launch = "dockerfile" | "npm" | "tsx";
const LAUNCH: Record<Launch, { cmd: string; args: string[]; cwd: string }> = {
  dockerfile: { cmd: DOCKER_CMD[0] === "node" ? process.execPath : (DOCKER_CMD[0] ?? "node"), args: DOCKER_CMD.slice(1), cwd: "" },
  npm: { cmd: "npm", args: ["run", "start", "--workspace=apps/server"], cwd: "" },
  tsx: { cmd: "npx", args: ["tsx", "src/index.ts"], cwd: "apps/server" },
};

async function boot(dir: string, launch: Launch = "npm"): Promise<Booted> {
  const port = await freePort();
  const admin = randomBytes(24).toString("base64url");
  const logs: string[] = [];
  const L = LAUNCH[launch];
  const child = spawn(L.cmd, L.args, {
    cwd: L.cwd ? `${ROOT}${L.cwd}` : ROOT,
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(port),
      RECORDER_COLLECT: "on", RECORDER_DATA_DIR: dir, RECORDER_ADMIN_TOKEN: admin, RECORDER_BUILD: "probe",
      GEMINI_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "", ADVISOR_TRACE: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
    // 自己一个进程组：信号只打 npm 这一个 pid（child.kill），收尾时整组清掉，不留孤儿服务。
    detached: true,
  });
  child.stdout!.on("data", (b) => logs.push(...String(b).split("\n").filter(Boolean)));
  child.stderr!.on("data", (b) => logs.push(...String(b).split("\n").filter(Boolean)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((r) => child.on("exit", (code, signal) => r({ code, signal, at: Date.now() })));
  const t0 = Date.now();
  while (!logs.some((l) => l.includes("[boot] recorder:"))) {
    if (Date.now() - t0 > 30_000) throw new Error(`server did not boot:\n${logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  // 记录仪的存储是异步打开的：等它就绪（邀请接口能用）
  for (let k = 0; k < 100; k++) {
    const r = await fetch(`http://127.0.0.1:${port}/api/rec/admin/invites`, { headers: { Authorization: `Bearer ${admin}` } }).catch(() => null);
    if (r?.status === 200) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  return { child, port, dir, admin, logs, exited };
}

/** 发一串命令请求（带记录头），全部拿到应答；返回应答数。每个应答之前服务端都已把“请求”事实排进了队列。 */
async function traffic(b: Booted, runId: string, token: string, n: number): Promise<number> {
  const base = `http://127.0.0.1:${b.port}`;
  const ev = { v: 1, eid: `cProbePid000001:1`, pid: "cProbePid000001", seq: 1, run: runId, src: "client", type: "run_start", ct: Date.now(), d: { scenario: "el_alamein" } };
  const ing = await fetch(`${base}/api/rec/events`, { method: "POST", headers: { "Content-Type": "application/json", "X-Rec-Invite": token }, body: JSON.stringify({ v: 1, run: runId, events: [ev] }) });
  assert.equal(ing.status, 200, "run bound to the tester");
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => fetch(`${base}/api/command`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Rec-Invite": token, "X-Rec-Run": runId },
    body: JSON.stringify({ digest: "DIGEST", message: `停机前的第${i}句`, channel: "combat", sessionId: "s", traceId: `t-shutdown-${String(i).padStart(4, "0")}` }),
  })));
  for (const r of rs) await r.text();
  return rs.length;
}

function killGroup(b: Booted): void {
  try { process.kill(-b.child.pid!, "SIGKILL"); } catch { /* 已经没了 */ }
}

async function onDisk(dir: string, runId: string) {
  const { RecorderStore } = await import("../apps/server/src/recorder/store");
  const s = await RecorderStore.open(dir);
  const read = await s.readRun(runId);
  const lines = read?.lines ?? [];
  return {
    requests: lines.filter((l) => l.type === "srv_request").length,
    ends: lines.filter((l) => l.type === "srv_attempt_end").length,
    closes: lines.filter((l) => l.type === "srv_producer_close"),
    serverLines: lines.filter((l) => l.src === "server"),
  };
}

async function main() {
  const { RecorderStore } = await import("../apps/server/src/recorder/store");
  void RecorderStore;
  /** 监听端口的那个进程＝真正的服务端 node（不是 npm/npx 外壳）。 */
  const serverPid = (port: number): number | null => {
    try {
      const out = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
      return out ? Number(out.split("\n")[0]) : null;
    } catch { return null; }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** 发信号后在 5 秒窗口内观察：外壳（顶层）与服务端各自何时退出、服务端有没有收到信号并排空。 */
  async function observe(b: Booted, sig: NodeJS.Signals) {
    const spid = serverPid(b.port);
    assert.ok(spid, "found the listening server process");
    const t0 = Date.now();
    b.child.kill(sig);                                  // 只打顶层这一个进程（同 docker stop / Fly 停机打 PID 1）
    let topExitMs: number | null = null;
    let serverExitMs: number | null = null;
    b.exited.then((e) => { topExitMs = e.at - t0; });
    while (Date.now() - t0 < 5000 && (topExitMs === null || serverExitMs === null)) {
      if (serverExitMs === null && !alive(spid!)) serverExitMs = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 2));
    }
    return {
      topIsServer: spid === b.child.pid,
      topExitMs: topExitMs as number | null,
      serverExitMs: serverExitMs as number | null,
      nodeSawSignal: b.logs.some((l) => l.includes(`[shutdown] ${sig} received`)),
      drainLine: b.logs.find((l) => /\[shutdown\] recorder drain /.test(l)) ?? null,
    };
  }
  await test("T15-local ★Dockerfile 的 CMD 直接起 node（不经 npm）——探针按它起服务；谁把它改回 npm 这里先红", () => {
    assert.deepEqual(DOCKER_CMD, EXPECTED_DOCKER_CMD, `Dockerfile CMD = ${JSON.stringify(DOCKER_CMD)}`);
  });
  for (const launch of ["dockerfile", "npm", "tsx"] as const) {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      const label = `${launch} / ${sig}`;
      let obs: Awaited<ReturnType<typeof observe>> | null = null;
      await test(`T15-local ${launch === "dockerfile" ? "★（Dockerfile 现在的 CMD）" : "（对照：旧起法，仅作证据）"} ${label}：服务端收到信号、5 秒内自己排空落盘并退出（已应答请求的事实全在、写了最后序号）`, async () => {
        const dir = tempDir(`shutdown-${launch}-${sig}`);
        const b = await boot(dir, launch);
        try {
          const inv = await (await fetch(`http://127.0.0.1:${b.port}/api/rec/admin/invites`, { method: "POST", headers: { Authorization: `Bearer ${b.admin}` } })).json() as { tid: string; token: string };
          const runId = `rShutdown${launch.replace(/[^a-z]/g, "")}${sig}${randomBytes(4).toString("hex")}`;
          const answered = await traffic(b, runId, inv.token, 40);
          obs = await observe(b, sig);
          const d = await onDisk(dir, runId);
          console.log(`     ${JSON.stringify({ launch, sig, ...obs, answered, onDiskRequests: d.requests, producerClose: d.closes.length })}`);
          assert.ok(obs.nodeSawSignal, "the node server itself received the signal");
          assert.ok(obs.drainLine && /done ms=\d+ leftover=0/.test(obs.drainLine), `drained: ${obs.drainLine}`);
          assert.ok(obs.serverExitMs !== null && obs.serverExitMs < 5000, "server exited by itself within 5s");
          assert.equal(d.requests, answered, "every answered request's fact on disk");
          assert.equal(d.closes.length, 1, "server producer declared its last seq");
        } finally {
          killGroup(b);
          rm(dir);
        }
      });
      const topNotBeforeServer = () => {
        assert.ok(obs, "previous step produced an observation");
        const o = obs!;
        assert.ok(o.topIsServer || (o.topExitMs !== null && o.serverExitMs !== null && o.topExitMs >= o.serverExitMs),
          `top process exited at ${o.topExitMs}ms, server at ${o.serverExitMs}ms`);
      };
      if (launch === "dockerfile") {
        await test(`T15-local ★（Dockerfile 现在的 CMD） ${label}：顶层进程不能先于服务端退出（容器里顶层＝PID 1，它一退出，整个容器里的进程当场被杀，排空作废）`, topNotBeforeServer);
      } else {
        await test(`T15-local-负对照 旧起法 ${label}：顶层（npm / npx）先于服务端退出 ⇒ 同一断言失败（这正是 Dockerfile 改成直接起 node 的原因；容器实测见 scripts/probe-recorder-docker.sh）`, () => mustFail("top not before server", topNotBeforeServer));
      }
    }
  }
  await test("T15-local-负对照：同样的流量之后 SIGKILL（不给排空的机会）⇒ 没有“最后序号”，最后一段排队的事实可能不在，同一断言失败", async () => {
    const dir = tempDir("shutdown-kill");
    const b = await boot(dir);
    const inv = await (await fetch(`http://127.0.0.1:${b.port}/api/rec/admin/invites`, { method: "POST", headers: { Authorization: `Bearer ${b.admin}` } })).json() as { tid: string; token: string };
    const runId = `rShutdownKILL${randomBytes(4).toString("hex")}`;
    const answered = await traffic(b, runId, inv.token, 40);
    killGroup(b);   // 整组 SIGKILL：node 也一起没了，没有排空的机会
    await b.exited;
    await new Promise((r) => setTimeout(r, 300));
    const d = await onDisk(dir, runId);
    await mustFail("drained + declared", () => {
      assert.equal(d.requests, answered);
      assert.ok(d.closes.length === 1);
    });
    rm(dir);
  });
  summary("probe-recorder-shutdown");
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
