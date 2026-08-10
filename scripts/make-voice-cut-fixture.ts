// ============================================================
// AI Commander — 脏样本夹具生成器：从 cmd1.wav 机器切尾
//
// 为什么入库（而不是"我切了一下"）：这段音频是判据的一半。切法一变，
// "归一化率"这个数就不可比了——而切法活在某次会话的 shell 历史里，
// 等于没有切法（同 run-benches.sh 那条教训：换个窗口就没了的东西不算工装）。
//
// ★为什么不能直接砍最后 600ms：cmd1.wav 尾部有 ~0.5s 的**数字静音**
//   （`say` 合成的收尾）。直接砍 600ms 只砍掉 100ms 的语音，夹具就是废的。
//   所以先按 RMS 剥掉尾部静音，再从**语音结束点**往回切 600ms。
//
// 切出来的东西模仿的是用户 2026-08-09 手测那个病：松手即拆线 → 尾巴被切掉
// →「…现在怎么办」变成「…现在怎么」。cmd1 原句结尾是「…去增援南线前哨」，
// 切掉 600ms 语音 ≈ 最后三个音节（能量剖面里三个音节团），即「前哨」连同
// 「线」的尾音一起没了——而信封的 ---FACILITIES--- 里明明白白写着
// 「南线前哨@(280,130)」。**模型能不能忍住不去补那两个字**，就是 A-1 要治的
// 那笔账（手测「骂人→中央战线」是同一个机制的另一个方向）。
//
// 用法（worktree 根）：
//   npx tsx scripts/make-voice-cut-fixture.ts
// 产物：scripts/fixtures/voice/cmd1_cut600.wav（+ 打印 sha256 与切点证据）
//
// 台架侧的自证不靠这支脚本：`--live` 会**拿 cmd1.wav 现场重算**，断言
// 切出来的文件是原始样本的**逐字节前缀**（纯截断、没重编码），且被切掉的
// 那一段确实是语音不是静音。见 ab-voice-input.ts 的 L0 段。
// ============================================================

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const SRC = "scripts/fixtures/voice/cmd1.wav";
const OUT = "scripts/fixtures/voice/cmd1_cut600.wav";

/** 切掉多少**语音**（不含尾部静音）。600ms ≈ 这段语速下的三个音节。 */
export const CUT_MS = 600;
/** 静音判定：峰值 RMS 的 3%。cmd1 尾部静音是真 0，阈值给多少都一样；
 *  写成相对值只为将来换夹具时不必重调。 */
const SILENCE_RATIO = 0.03;
const WIN_MS = 20;

export interface WavPcm {
  rate: number;
  channels: number;
  bits: number;
  /** 采样数据在文件里的字节偏移 */
  dataOffset: number;
  samples: Int16Array;
}

/**
 * 按 chunk 走，不假设 data 在第 44 字节。
 *
 * ★这不是防御性编程，是被咬出来的：入库的 cmd1/cmd2 是 afconvert 产的，
 * fmt 后面插了一个 4044 字节的 `FLLR` 填充块，data 实际起于 4096。
 * first cut 按"44 字节标准头"读，量出来的是 0.126 秒静音，切点算在 0 秒
 * ——**产物是个空文件，而生成脚本一声不吭**。判据要是挂在那上面，
 * "归一化率 0/10" 会是个漂亮的假绿。
 */
export function readWav(path: string): WavPcm {
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).toString("latin1") !== "RIFF" || buf.subarray(8, 12).toString("latin1") !== "WAVE") {
    throw new Error(`${path} 不是 RIFF/WAVE`);
  }
  let rate = 0, channels = 0, bits = 0, dataOffset = -1, dataBytes = 0;
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.subarray(i, i + 4).toString("latin1");
    const size = buf.readUInt32LE(i + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(i + 10);
      rate = buf.readUInt32LE(i + 12);
      bits = buf.readUInt16LE(i + 22);
    } else if (id === "data") {
      dataOffset = i + 8;
      dataBytes = Math.min(size, buf.length - dataOffset);
      break;
    }
    i += 8 + size + (size & 1);
  }
  if (dataOffset < 0) throw new Error(`${path} 没有 data 块`);
  if (bits !== 16) throw new Error(`${path} 不是 16bit（${bits}）`);
  const copy = Buffer.from(buf.subarray(dataOffset, dataOffset + dataBytes)); // 对齐拷贝
  const samples = new Int16Array(copy.buffer, copy.byteOffset, dataBytes / 2);
  return { rate, channels, bits, dataOffset, samples };
}

/** 标准 44 字节头（产物不再带 FLLR 填充块——它对判据没用，只会挡路）。 */
function wavHeader(samples: number, rate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + samples * 2, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(samples * 2, 40);
  return h;
}

/** 逐窗 RMS（20ms 一窗）。 */
export function rmsWindows(samples: Int16Array, rate: number): number[] {
  const win = Math.floor((rate * WIN_MS) / 1000);
  const out: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let acc = 0;
    for (let j = i; j < i + win; j++) acc += samples[j] * samples[j];
    out.push(Math.sqrt(acc / win));
  }
  return out;
}

/** 语音结束点（样本下标）：最后一个高于静音门限的窗的右边界。 */
export function speechEndSample(samples: Int16Array, rate: number): number {
  const win = Math.floor((rate * WIN_MS) / 1000);
  const rms = rmsWindows(samples, rate);
  const floor = Math.max(...rms) * SILENCE_RATIO;
  let last = rms.length - 1;
  while (last >= 0 && rms[last] <= floor) last--;
  return Math.min(samples.length, (last + 1) * win);
}

/** 切点＝语音结束点往回 CUT_MS。返回保留的样本数。 */
export function cutPointSample(samples: Int16Array, rate: number): number {
  const end = speechEndSample(samples, rate);
  return Math.max(0, end - Math.round((rate * CUT_MS) / 1000));
}

function writeWav(path: string, samples: Int16Array, rate: number, channels: number): void {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  wavHeader(samples.length, rate, channels).copy(out, 0);
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(out, 44);
  writeFileSync(path, out);
}

function main(): void {
  const src = readWav(SRC);
  const keep = cutPointSample(src.samples, src.rate);
  const end = speechEndSample(src.samples, src.rate);
  const cut = src.samples.subarray(0, keep);

  // 被切掉的那一段是不是真语音？（若它是静音，这个夹具什么也证明不了）
  const removed = src.samples.subarray(keep, end);
  const removedRms = rmsWindows(removed, src.rate);
  const srcRms = rmsWindows(src.samples, src.rate);
  const peak = Math.max(...srcRms);

  writeWav(OUT, cut, src.rate, src.channels);
  const sha = createHash("sha256").update(readFileSync(OUT)).digest("hex");

  console.log(`源       ${SRC}  ${(src.samples.length / src.rate).toFixed(3)}s（data 块起于第 ${src.dataOffset} 字节，不是 44）`);
  console.log(`语音结束 ${(end / src.rate).toFixed(3)}s（尾部静音 ${((src.samples.length - end) / src.rate).toFixed(3)}s——直接砍 600ms 会砍在这上面）`);
  console.log(`切点     ${(keep / src.rate).toFixed(3)}s  保留 ${keep} 样本`);
  console.log(`切掉     ${(removed.length / src.rate).toFixed(3)}s 语音，其中最大窗 RMS ${Math.max(...removedRms).toFixed(0)}（全曲峰值 ${peak.toFixed(0)}）`);
  console.log(`产物     ${OUT}`);
  console.log(`sha256   ${sha}`);
}

// 只有被直接运行时才产文件——ab-voice-input 的截断自证要 import 这里的切法
// （同一份代码算生成、算验收，"生成时这么切、验收时那么算"就没有发生的余地），
// 而 import 一下就把夹具重写一遍，是另一种形式的"夹具自己会变"。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
