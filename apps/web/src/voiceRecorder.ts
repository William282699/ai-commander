// ============================================================
// AI Commander — 语音输入 V1：客户端录音
//
// 独立成模块（§X-5 第三缝）：V1.5 的 ops 转写中继要复用同一个录音件，
// 写在 PTT 事件处理器里就只能复制第二份。
//
// 采集路线：getUserMedia → **直采 PCM**（ScriptProcessor）→ OfflineAudioContext
//   重采样 16kHz 单声道 → Int16 PCM + WAV 头 → 分块 base64。
//
// ★为什么直采 PCM 而不是 MediaRecorder：**合同就是这么定的**（提案 §2-A：
//   「采 PCM → 16kHz mono WAV；不用 MediaRecorder 的 webm/opus」）。步 3 首版
//   拿 MediaRecorder 当中间件（webm 只过路、发出去仍是 wav）是偏离合同，已改回。
//   理由不用测也成立：opus 是有损压缩，而这一刀的全部价值押在"耳朵听得出玩家
//   自造的标记名"上（消融：无信封 0/4 → 带信封 4/4），采集端没有理由先压一道。
//
//   ⚠ 留痕（防后人拿错证据）：步 3 冒烟里我一度用"经 MediaRecorder 的转写掉了
//   「战狼点」、直接重采样没掉"来论证这件事——**那个对照不成立**。冒烟的假麦克风
//   是 MediaStreamDestination → MediaStreamSource 的合成往返，它自己就掉字
//   （换成直采 PCM 之后、把开口延后 1 秒排除掐头之后，「战狼点」照样丢）。
//   两个采集实现都被同一个夹具伤害 ⇒ 那组数**判不了 opus 与 PCM 的高下**。
//   采集保真度的裁决权在步 6 的真麦手测，这里不宣称。
//
// ScriptProcessor 已被标记废弃，这里仍然选它：零构建配置、目标浏览器全支持、
//   当场可验；AudioWorklet 是更正确的替代（要单独的 worklet 模块 + Vite 的
//   URL 处理），登记为 demo 后项。MVP 铁律 5：能跑 > 优雅。
//
// 16kHz 是承重项不是口味：30s@16k 单声道 16bit = 960KB → b64 1.28MB，
// 舒服地待在服务端 4mb 之内；同样 30 秒换 48kHz 就是 b64 3.84MB，贴死那条线。
// ============================================================

const TARGET_RATE = 16000;
const MAX_SECONDS = 30;

export interface VoiceRecording {
  /** base64 WAV（不带 data: 前缀），直接进请求体 */
  data: string;
  format: "wav";
  durationSec: number;
}

export interface VoiceRecorderHandle {
  /** 松手：停止采集并交出 wav。太短/无声/解码失败一律返回 null（不猜、不发空包）。 */
  stop(): Promise<VoiceRecording | null>;
  /** 放弃这次录音（切频道、组件卸载等），不产出。 */
  cancel(): void;
}

export function isVoiceCaptureSupported(): boolean {
  return typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia
    && typeof AudioContext !== "undefined";
}

/**
 * 开录。麦克风权限在这里第一次弹（按住 🎤 是用户手势，满足 getUserMedia 的要求）。
 *
 * ★三个开关不是可选项：陈的 TTS 正从喇叭里出来，裸录音会把**他的声音**录进
 * 长官的命令里。现状那条 Web Speech 走的是同一套带 AEC 的管线，所以今天不发作；
 * 换成自采集就必须自己开。（调用方另外还要在按下瞬间 cancel() 掉 TTS。）
 */
export async function startVoiceRecording(): Promise<VoiceRecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // 4096 帧一批：再小 onaudioprocess 太频繁，再大松手时尾巴丢得多。
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  // ★ 必须接到 destination 才会被调度，但**中间挂一个 gain=0**：
  //   直接接过去等于把麦克风原声播回喇叭（长官会听见自己 + 喂给 AEC 一个假回声）。
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  let frames = 0;
  const maxFrames = MAX_SECONDS * ctx.sampleRate;
  proc.onaudioprocess = (e) => {
    if (frames >= maxFrames) return;
    const src = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(src)); // 必须拷贝：这块缓冲下一批会被复用
    frames += src.length;
  };
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const teardown = () => {
    proc.onaudioprocess = null;
    try { source.disconnect(); proc.disconnect(); mute.disconnect(); } catch { /* 已断开 */ }
    stream.getTracks().forEach((t) => t.stop()); // 释放麦克风
    void ctx.close();
  };

  return {
    cancel() {
      chunks.length = 0;
      teardown();
    },
    async stop(): Promise<VoiceRecording | null> {
      const rate = ctx.sampleRate;
      teardown();
      if (frames === 0) return null;
      const durationSec = frames / rate;
      if (durationSec < 0.3) return null; // 手滑点一下，不算命令

      try {
        const flat = new Float32Array(frames);
        let at = 0;
        for (const c of chunks) { flat.set(c.subarray(0, Math.min(c.length, frames - at)), at); at += c.length; if (at >= frames) break; }
        const base64 = await resampleToWav16k(flat, rate);
        return { data: base64, format: "wav", durationSec };
      } catch {
        return null; // 采集/重采样出问题＝没听到，交给上层 fail-closed，不发半个包
      }
    },
  };
}

/** 任意采样率的单声道 Float32 → 16kHz WAV base64。 */
async function resampleToWav16k(samples: Float32Array, rate: number): Promise<string> {
  if (rate === TARGET_RATE) return encodeWavBase64(samples, TARGET_RATE);
  const frames = Math.max(1, Math.round((samples.length * TARGET_RATE) / rate));
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const buf = off.createBuffer(1, samples.length, rate);
  buf.getChannelData(0).set(samples);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return encodeWavBase64(out.getChannelData(0), TARGET_RATE);
}

/** Float32 [-1,1] → 16-bit PCM WAV → base64。
 *  导出只为台架够得到——采集链的其余部分要浏览器，这一段是纯计算，
 *  也是最容易写错又最难在真机上看出来的一段（头错了服务端不会报错，
 *  模型只会"听不清"）。 */
export function encodeWavBase64(samples: Float32Array, rate: number): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);      // fmt chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  // 分块转 base64：1MB 一次性展开成参数会爆栈。
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
