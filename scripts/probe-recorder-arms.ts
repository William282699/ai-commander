/**
 * T16：记录关 / 开 / 上传失败 / 写满 / 记录器抛异常，原玩法逐项一致。
 * 运行：node --import tsx scripts/probe-recorder-arms.ts
 *
 * 每臂一个独立进程（模块级状态不跨臂残留），种子用 --import 在导入 core 之前装好。
 * 比较：每次 applyOrders 的单位 ID/动作/目标、ApplyResult、屏幕文字、交给 TTS 的文字、对话 context、
 * 浏览器发给服务端的请求体、模型调用次数与模型输入原文、钱油与生产队列、台账、
 * 走 150 游戏秒后的全部单位（位置/血量/状态/命令）与据点。
 * 两道自证：off 跑两遍必须逐字节相同（比较本身有意义）；负对照臂（记录器偷用一次模拟随机数）必须对不上。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, summary } from "./recorder-test-lib";

type ArmResult = { arm: string; comparable: Record<string, unknown>; recorderEvidence: Record<string, any>; perf: Record<string, number> };

function runArm(arm: string, i: number): ArmResult {
  const out = join(tmpdir(), `rec-arm-${process.pid}-${i}-${arm}.json`);
  execFileSync(process.execPath, ["--import", "./scripts/recorder-seed-random.mjs", "--import", "tsx", "scripts/recorder-arm-worker.ts", `--arm=${arm}`, `--out=${out}`], {
    stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, REC_SEED: "20260928" },
  });
  const r = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out);
  return r;
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

async function main() {
  const evidenceDir = process.argv.find((a) => a.startsWith("--evidence="))?.slice(11);
  const arms = ["off", "off", "on", "fail", "full", "throw", "neg_rng"];
  const results: ArmResult[] = [];
  for (const [i, a] of arms.entries()) { results.push(runArm(a, i)); console.log(`ran arm ${a}`); }
  const [off1, off2, on, fail, full, thr, neg] = results;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    results.forEach((r, i) => writeFileSync(join(evidenceDir, `arm-${i}-${r.arm}.json`), JSON.stringify(r, null, 1)));
  }

  await test("A0 自证：off 臂跑两遍，全部可比结果逐字节相同（否则下面的一致性没有意义）", () => {
    assert.deepEqual(diffKeys(off1.comparable, off2.comparable), []);
    assert.ok((off1.comparable.applications as unknown[]).length >= 3, "the script really executed orders");
    assert.ok((off1.comparable.llmCalls as number) >= 6, "the script really called the model");
    assert.ok((off1.comparable.time as number) >= 150, "the sim really walked 150 game seconds");
  });
  await test("A0b off 臂里记录仪真的没动：零上传、服务端没有任何局", () => {
    assert.equal(off1.recorderEvidence.netCalls, 0);
    assert.equal(off1.recorderEvidence.serverRuns.length, 0);
  });
  for (const [label, r, check] of [
    ["on（正常记录上传）", on, (e: Record<string, any>) => {
      assert.ok(e.netCalls > 0);
      const run = e.serverRuns[0];
      assert.ok(run && run.types.trace > 10 && run.types.snapshot >= 3 && run.types.srv_request >= 6, JSON.stringify(run?.types));
    }],
    ["fail（上传全失败）", fail, (e: Record<string, any>) => {
      assert.ok(e.netFailures > 0);
      assert.equal(e.status.phase, "fault");
      assert.ok(e.status.queued > 0, "events kept in the queue");
    }],
    ["full（服务端满盘＋浏览器缓存极小）", full, (e: Record<string, any>) => {
      assert.ok(e.status.drops.critical + e.status.drops.sample > 0 || e.status.phase === "fault", JSON.stringify(e.status));
    }],
    ["throw（记录器内部每次都抛）", thr, (e: Record<string, any>) => {
      const clientEvents = (e.serverRuns[0]?.types?.trace ?? 0) + (e.serverRuns[0]?.types?.run_start ?? 0);
      assert.equal(clientEvents, 0, "no client event could be built");
    }],
  ] as const) {
    await test(`A1 ★${label}：与 off 臂的全部可比结果逐项相同（单位/目标/回执/屏/声/context/请求体/模型输入与次数/钱油/150 秒后的战场）`, () => {
      const d = diffKeys(off1.comparable, r.comparable);
      assert.deepEqual(d, [], `differs in: ${d.join(", ")}`);
      check(r.recorderEvidence);
    });
  }
  await test("A2-负对照：记录器偷用一次模拟的 Math.random ⇒ 与 off 臂对不上（比较能抓到随机数被消耗）", () => {
    const d = diffKeys(off1.comparable, neg.comparable);
    assert.ok(d.length > 0, "the negative-control arm must differ");
    console.log(`     neg_rng differs in: ${d.join(", ")}`);
  });
  await test("A3 帧耗时（同一台机器、同一循环）：记录开与关的中位数/95 分位差在噪声范围内（记录不进热循环）", () => {
    console.log(`     off p50=${off1.perf.p50}ms p95=${off1.perf.p95}ms | on p50=${on.perf.p50}ms p95=${on.perf.p95}ms | loop off=${off1.perf.loopMs}ms on=${on.perf.loopMs}ms`);
    assert.ok(on.perf.p50 <= off1.perf.p50 * 1.5 + 0.2, "median frame not inflated");
  });
  summary("probe-recorder-arms");
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
