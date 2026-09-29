/**
 * 只凭一个导出的 ZIP 核对「派两个 → 改令 → 叫回」（T03 / 用户手测 §9 第 2 步）：
 *   · 三句话各有一次执行记录，接令的是同一对单位；
 *   · 三次的真实目标：第一次、第二次各是一个去处，第三次回到这两个单位**各自**开局快照里的位置；
 *   · 叫回之后的快照里这一对回到各自起点，并且之后至少 30 游戏秒都还在（没有再掉头）；
 *   · 整局里接到对话执行令的只有这一对（其余单位没有被新增下令）。
 * 运行：node --import tsx scripts/check-recorder-t03.ts <包.zip> [第一句] [第二句] [第三句]
 * 默认三句＝手测单上的写法；若玩家原话不同，按实际原话传入。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function main() {
  const [zipPath, ...said] = process.argv.slice(2);
  assert.ok(zipPath, "usage: check-recorder-t03.ts <zip> [cmd1] [cmd2] [cmd3]");
  const { readZip } = await import("../apps/server/src/recorder/zip");
  const files = readZip(readFileSync(zipPath));
  const parse = (n: string) => (files.get(n)?.toString("utf8") ?? "").split("\n").filter(Boolean).map((x) => JSON.parse(x));
  const traces = parse("traces.jsonl");
  const snaps = parse("snapshots.jsonl").sort((a: { gt?: number }, b: { gt?: number }) => (a.gt ?? 0) - (b.gt ?? 0));
  const turns = traces.filter((l: { type: string; d: { stage?: string } }) => l.type === "trace" && l.d.stage === "turn");
  const execs = traces.filter((l: { type: string; d: { stage?: string } }) => l.type === "trace" && l.d.stage === "exec");
  const cmds = said.length === 3 ? said : undefined;
  // 找三次有人接令的执行（按发生顺序）；若给了原话就按原话找
  const picked = cmds
    ? cmds.map((c) => { const t = turns.find((x: { d: { data: { text: string } } }) => x.d.data.text === c); assert.ok(t, `no turn for 「${c}」`); const e = execs.find((x: { turn: string }) => x.turn === t.turn); assert.ok(e, `no exec for 「${c}」`); return e; })
    : execs.filter((e: { d: { data: { applied: number[] } } }) => e.d.data.applied.length > 0).slice(0, 3);
  assert.equal(picked.length, 3, `three executions (found ${picked.length})`);
  const textOf = (e: { turn: string }) => turns.find((t: { turn: string }) => t.turn === e.turn)?.d.data.text ?? "?";
  const pair = [...picked[0].d.data.applied].sort((a: number, b: number) => a - b);
  const report: string[] = [];
  report.push(`1「${textOf(picked[0])}」→ 接令 ${pair.join(",")}`);
  for (const [i, e] of picked.entries()) {
    const ids = [...e.d.data.applied].sort((a: number, b: number) => a - b);
    assert.deepEqual(ids, pair, `execution ${i + 1} moved ${ids} but the first moved ${pair}`);
  }
  const targets = picked.map((e: { d: { data: { intents: { orders: { units: number[]; target: { x: number; y: number } }[] }[] } } }) =>
    new Map(e.d.data.intents.flatMap((it) => it.orders).flatMap((o) => o.units.map((u) => [u, o.target] as const))));
  const startSnap = snaps.find((s: { d: { reason: string } }) => s.d.reason === "start");
  assert.ok(startSnap, "start snapshot in the package");
  const pos = (s: { d: { units: unknown[][] } }, id: number) => s.d.units.find((u) => u[0] === id) as number[] | undefined;
  for (const id of pair) {
    const home = pos(startSnap, id)!;
    const t3 = targets[2].get(id)!;
    const dist = Math.hypot(t3.x - home[2], t3.y - home[3]);
    report.push(`单位 ${id}：起点 (${home[2]},${home[3]})；① → (${targets[0].get(id)?.x},${targets[0].get(id)?.y}) ② → (${targets[1].get(id)?.x},${targets[1].get(id)?.y}) ③ → (${t3.x},${t3.y})，离起点 ${dist.toFixed(1)} 格`);
    assert.ok(dist < 3, `unit ${id} recall target is its own start`);
  }
  const recallGt = picked[2].gt ?? 0;
  // 回到起点的时刻：之后每一份快照都在起点 2 格内
  const after = snaps.filter((s: { gt?: number }) => (s.gt ?? 0) >= recallGt);
  let homeFrom: number | null = null;
  for (const s of after) {
    const allHome = pair.every((id) => { const p = pos(s, id); const h = pos(startSnap, id)!; return p && Math.hypot(p[2] - h[2], p[3] - h[3]) < 2; });
    if (allHome && homeFrom === null) homeFrom = s.gt ?? 0;
    if (!allHome && homeFrom !== null) throw new Error(`left home again at t=${s.gt}`);
  }
  assert.ok(homeFrom !== null, "the pair got back home in a later snapshot");
  const last = after[after.length - 1];
  report.push(`叫回于游戏 ${recallGt.toFixed(1)}s；回到起点 ${homeFrom!.toFixed(1)}s；之后一直在起点，最后一份快照 ${(last.gt ?? 0).toFixed(1)}s（停住 ${((last.gt ?? 0) - homeFrom!).toFixed(1)}s）`);
  assert.ok((last.gt ?? 0) - homeFrom! >= 30, `held at home for ≥30 game seconds (only ${((last.gt ?? 0) - homeFrom!).toFixed(1)}s in the package)`);
  const touched = new Set(execs.flatMap((e: { d: { data: { applied: number[] } } }) => e.d.data.applied));
  assert.deepEqual([...touched].sort((a, b) => (a as number) - (b as number)), pair, `only the pair got dialogue orders (touched ${[...touched]})`);
  report.push(`整局对话执行令只碰了这一对：${pair.join(",")}`);
  console.log(report.join("\n"));
  console.log("T03 CHECK PASS");
}

main().catch((e) => { console.error(`T03 CHECK FAIL: ${(e as Error).message}`); process.exit(1); });
