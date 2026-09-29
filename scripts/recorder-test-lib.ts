/**
 * 试玩记录仪台架的公共件（合成事件、临时目录、起一个只挂记录仪路由的本地服务）。
 * 只用合成内容；所有目录都在系统临时目录里，跑完删掉。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

export let passCount = 0;
export let negCount = 0;
export const failures: string[] = [];

export async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passCount++;
    if (name.includes("负对照")) negCount++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String((e as Error)?.stack ?? e).split("\n").slice(0, 8).join("\n     ")}`);
  }
}

/** 负对照：把保护摘掉后，同一条断言必须真的失败。 */
export async function mustFail(what: string, fn: () => Promise<void> | void): Promise<void> {
  let failed = false;
  try { await fn(); } catch { failed = true; }
  assert.ok(failed, `negative control did not fail: ${what}`);
}

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `rec-${label}-`));
}
export function rm(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let seqCounter = 0;
/** 一条合成的客户端事件（形状与浏览器 RecorderCore 产出的一致）。 */
export function ev(run: string, pid: string, seq: number, type: string, d: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  seqCounter++;
  return { v: 1, eid: `${pid}:${seq}`, pid, seq, run, src: "client", type, ct: 1_790_000_000_000 + seqCounter, d, ...extra };
}

export async function startServer(app: { listen: (port: number, host: string, cb: () => void) => import("node:http").Server }): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

export function summary(label: string): void {
  console.log("");
  if (failures.length) {
    console.log(`${label}: ${failures.length} FAILED of ${passCount + failures.length}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`${label}: ALL PASS (${passCount} checks, including ${negCount} negative controls)`);
  }
}
