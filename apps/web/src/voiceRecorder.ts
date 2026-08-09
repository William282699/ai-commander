// ============================================================
// AI Commander — 语音输入 V1：客户端录音
//
// 独立成模块（§X-5 第三缝）：V1.5 的 ops 转写中继要复用同一个录音件，
// 写在 PTT 事件处理器里就只能复制第二份。
//
// 采集路线（只用稳定 API，不碰已废弃的 ScriptProcessor、也不引 AudioWorklet 模块）：
//   MediaRecorder（浏览器原生，容器随浏览器）
//     → decodeAudioData → OfflineAudioContext 重采样到 16kHz 单声道
//     → Int16 PCM + WAV 头 → base64
// 中间那段 webm 只是过路，**发出去的永远是 wav**：探针实证该端点吃 wav，
// webm/opus 至今没测过（本机无 ffmpeg/opusenc、afconvert 写 opus 失败），
// 不许拿没测过的容器上场。
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
    && typeof MediaRecorder !== "undefined"
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

  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  rec.start();

  const startedAt = Date.now();
  let capped: number | undefined = window.setTimeout(() => {
    if (rec.state === "recording") rec.stop();
  }, MAX_SECONDS * 1000);

  const teardown = () => {
    if (capped !== undefined) { clearTimeout(capped); capped = undefined; }
    stream.getTracks().forEach((t) => t.stop());
  };

  return {
    cancel() {
      if (rec.state === "recording") rec.stop();
      chunks.length = 0;
      teardown();
    },
    async stop(): Promise<VoiceRecording | null> {
      if (rec.state === "recording") {
        await new Promise<void>((resolve) => { rec.onstop = () => resolve(); rec.stop(); });
      }
      teardown();
      const elapsed = (Date.now() - startedAt) / 1000;
      if (chunks.length === 0 || elapsed < 0.3) return null; // 手滑点一下，不算命令

      try {
        const raw = await new Blob(chunks).arrayBuffer();
        const wav = await toWav16k(raw);
        if (!wav) return null;
        return { data: wav.base64, format: "wav", durationSec: wav.durationSec };
      } catch {
        return null; // 解码失败＝没听到，交给上层走 fail-closed，不发半个包
      }
    },
  };
}

/** 任意浏览器容器 → 16kHz 单声道 WAV base64。 */
async function toWav16k(raw: ArrayBuffer): Promise<{ base64: string; durationSec: number } | null> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(raw.slice(0));
  } finally {
    void ctx.close();
  }
  if (decoded.duration <= 0) return null;

  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const resampled = await off.startRendering();

  return {
    base64: encodeWavBase64(resampled.getChannelData(0), TARGET_RATE),
    durationSec: decoded.duration,
  };
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
