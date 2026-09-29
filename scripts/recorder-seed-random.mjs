// 走时间的对照臂用：在导入任何 core 模块之前把全局 Math.random 换成固定种子的序列
// （enemyAI.ts 在模块加载时就会调一次）。用法：node --import ./scripts/recorder-seed-random.mjs --import tsx <脚本>
// 种子取 REC_SEED（默认 20260928）。只给台架用；记录器自己从不调用 Math.random。
let s = (Number(process.env.REC_SEED) || 20260928) >>> 0;
Math.random = function seededRandom() {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
globalThis.__REC_SEEDED__ = true;
