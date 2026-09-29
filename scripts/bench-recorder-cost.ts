/**
 * 记录器同步开销（主线程每次调用付出的时间）。运行：node --import tsx scripts/bench-recorder-cost.ts
 * 只量入口的同步部分（复制白名单、序列化、入队）；上传、落盘都在定时器里、不在这里。
 */
import * as core from "@ai-commander/core";
import { RecorderCore, DEFAULT_CORE_LIMITS } from "../apps/web/src/recorder/core";
import { MemoryBackend } from "../apps/web/src/recorder/queue";
import { buildSnapshot } from "../apps/web/src/recorder/snapshot";

const c = new RecorderCore({
  now: () => Date.now(), randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  fetch: async () => ({ status: 200, text: async () => JSON.stringify({ recorder: "ok", acked: [], rejected: [] }) }),
  setTimeout: () => 0, clearTimeout: () => {}, apiUrl: "",
}, new MemoryBackend(), { ...DEFAULT_CORE_LIMITS, cacheMaxBytes: 1 << 30, memoryOnlyMaxBytes: 1 << 30 });
c.activate("tokentokentokentokentoken");
const s = core.createInitialGameState("el_alamein");
c.startRun(s, {});
const typical = { intents: [{ i: 0, intent: { type: "defend", fromFront: "front_center", quantity: 2, targetFacility: "ea_player_coastal_post" }, destination: "北线前哨", orders: [{ action: "defend", units: [34], target: { x: 361, y: 35 } }, { action: "defend", units: [35], target: { x: 359, y: 35 } }] }], applied: [34, 35], already: [], rejected: [], receipt: ["中央前哨附近未编组群里的 2 个已经出发，前往北线前哨。"], planTraceId: "t-0000-0000" };
const N = 20000;
const time = (label: string, n: number, fn: () => void) => {
  for (let i = 0; i < 200; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const us = ((performance.now() - t0) / n) * 1000;
  console.log(`${label.padEnd(34)} ${us.toFixed(1)} µs/call`);
  return us;
};
time("trace(exec, typical payload)", N, () => c.trace("t-1111-2222", "exec", typical, s, "current"));
time("message(add)", N, () => c.message("add", { id: 1, level: "info", text: "长官，北线前哨需要增援。", time: 12, channel: "combat", from: "chen", source: "command_ack" }));
time("op(channel)", N, () => c.op("channel", { commanders: ["chen"] }));
time("headers(state)", N, () => c.headers(s));
time("buildSnapshot(85 units)", 2000, () => buildSnapshot(s, "periodic"));
const off = new RecorderCore({ now: () => 0, randomBytes: (n) => new Uint8Array(n), fetch: async () => ({ status: 0, text: async () => "" }), setTimeout: () => 0, clearTimeout: () => {}, apiUrl: "" }, new MemoryBackend());
time("trace() when recording is off", N * 10, () => off.trace("t-1111-2222", "exec", typical, s, "current"));
console.log(`snapshot bytes (85 units): ${JSON.stringify(buildSnapshot(s, "periodic")).length}`);
process.exit(0);
