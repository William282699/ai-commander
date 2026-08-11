// ============================================================
// AI Commander — 语音输入 V1：客户端录音
//
// 独立成模块（§X-5 第三缝）：V1.5 的 ops 转写中继要复用同一个录音件，
// 写在 PTT 事件处理器里就只能复制第二份。
//
// 采集路线：getUserMedia → **直采 PCM**（ScriptProcessor）→ OfflineAudioContext
//   重采样 16kHz 单声道 → Int16 PCM + WAV 头 → 分块 base64。
//
// ★为什么直采 PCM 而不是 MediaRecorder：**opus 是有损压缩，而这一刀的全部价值
//   押在"耳朵听得出玩家自造的标记名"上**（消融：同一段音频，无信封 0/4 →
//   带信封 4/4，救回来的正是「战狼点」这种只活在本局信封里的名字）。
//   采集端没有理由先把它压一道。这条第一性原理自己站得住，不借别的名义。
//
//   记述更正（Fable 步3b 审核指出，2026-08-09）：合同 §2-A 给的是**两条**路
//   （AudioWorklet 直采 / decodeAudioData 重采样），步 3 首版走的是后者、且已获
//   步 3 审核批准 ⇒ 3b 是**两条合同内路线之间的切换，不是纠偏**。之前这里写
//   "偏离合同已改回"是假的，改掉——承重注释里的错误出处会被照抄
//   （"80% 卡死"被抄了 11 天的教训）。
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

import {
  IDLE_CAPTURE, onArmed, onDisarmed, onPress, onRelease, onCancel, onFrame, shouldMute,
  type CaptureState,
} from "./voiceCaptureState";

const TARGET_RATE = 16000;
const MAX_SECONDS = 30;
/** 松手后再多听一会儿，等管线里在途的音频流完（Fable 裁定 2026-08-09：300ms）。 */
const TAIL_GRACE_MS = 300;

export interface VoiceRecording {
  /** base64 WAV（不带 data: 前缀），直接进请求体 */
  data: string;
  format: "wav";
  durationSec: number;
}

/**
 * 常驻采集件（刀 C）：设备与音频图**开局一次拿到、整局握着不放**，
 * 按下只翻一个标志位。
 *
 * 旧形状是 `startVoiceRecording()`——按下才开设备。它的代价是用户 2026-08-09
 * 真麦手测挖出来的那个病：`getUserMedia` 解析、AEC/AGC 热身这几百毫秒里，
 * 麦克风还没在收音，长官说的第一个词**物理上不存在**。危机中按下就喊必中，
 * 平静中按下有停顿则躲过——「南线前哨守军」→「全套的收军」、「Emily」→「Amaly」，
 * 跨频道同形，坏的永远是第一个词。
 */
export interface VoiceCaptureArm {
  /** 按下：立刻开始收（零设备操作）。返回是否真的开始了（没 armed 就没开始）。 */
  press(): boolean;
  /** 松手：停止收集并交出 wav。太短/无声/解码失败一律返回 null（不猜、不发空包）。 */
  release(): Promise<VoiceRecording | null>;
  /** 放弃这次（切频道、手滑）：丢掉已收的，**设备照旧握着**。 */
  cancel(): void;
  /** 真正撒手（组件卸载 / 切到不收音的频道）：关设备、关图。 */
  dispose(): void;
  /** 状态快照（🔴 指示灯读它——灯只许跟着 collecting 走，不许跟着"我打算开始"走）。 */
  snapshot(): CaptureState;
}

export function isVoiceCaptureSupported(): boolean {
  return typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia
    && typeof AudioContext !== "undefined";
}

/**
 * 常驻预热的开关（Fable 附加条件①）。
 *
 * 关掉它＝退回**旧行为**：按下那一刻才开设备。这不是"另一条代码路"——
 * 它只改**什么时候 arm**，采集件本身一个字节不变。所以它是 §6-5 那条必做负对照
 * 的真麦版：同一次坐下、同一支麦、同一副嗓子，开着念 5 句、关掉念同样 5 句，
 * 首词存活率一比就见分晓。两次分开测（今天旧的、明天新的）比不过这个。
 *
 * 关法二选一：网址加 `?novoicewarm`，或 localStorage 里 `voice.novoicewarm=1`。
 */
export function isVoiceWarmEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    if (new URLSearchParams(window.location.search).has("novoicewarm")) return false;
    if (window.localStorage?.getItem("voice.novoicewarm") === "1") return false;
  } catch { /* 隐私模式下 localStorage 会抛，按默认（预热开）走 */ }
  return true;
}

/** 冷/热分档用：本页面生命周期内 arm 了几次。 */
let armCount = 0;

/**
 * 握住麦克风。**权限在这里弹**（调用点必须在一个用户手势里，浏览器才肯弹）。
 *
 * ★三个开关不是可选项：陈的 TTS 正从喇叭里出来，裸录音会把**他的声音**录进
 * 长官的命令里。现状那条 Web Speech 走的是同一套带 AEC 的管线，所以今天不发作；
 * 换成自采集就必须自己开。（调用方另外还要在按下瞬间 cancel() 掉 TTS。）
 *
 * ★空闲静音：不在收集的时候 `track.enabled = false`，浏览器往图里送**数字静音**。
 * 于是"不按的时候不留声音"从"我们的代码有良心"变成"根本没东西可留"。它是标志位
 * 不是设备操作，翻回来是即时的 ⇒ 不牺牲零盲区。**橙点仍会整局亮着**——那是设备
 * 开着的系统提示，用户 2026-08-10 明确接受了这个代价。
 */
export async function armVoiceCapture(): Promise<VoiceCaptureArm> {
  // ★设备开启耗时自己记（Fable 附加条件②）：提案 §4 缺的就是这个数，而它
  //   只有真麦量得到。记在这里 ⇒ 长官正常玩的过程中自动采到，不必再贴控制台探针。
  //   冷/热分档：第一次开设备与后续开设备可能差一个量级。
  const tArm = performance.now();
  const cold = armCount === 0;
  armCount++;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const tGum = performance.now() - tArm;

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // 4096 帧一批：再小 onaudioprocess 太频繁，再大松手时尾巴丢得多。
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  // ★ 必须接到 destination 才会被调度，但**中间挂一个 gain=0**：
  //   直接接过去等于把麦克风原声播回喇叭（长官会听见自己 + 喂给 AEC 一个假回声）。
  const mute = ctx.createGain();
  mute.gain.value = 0;

  let state: CaptureState = onArmed(IDLE_CAPTURE);
  let chunks: Float32Array[] = [];
  const maxFrames = MAX_SECONDS * ctx.sampleRate;

  const applyMute = () => {
    const m = shouldMute(state);
    stream.getAudioTracks().forEach((t) => { t.enabled = !m; });
  };

  // ★图整局是热的：回调每秒响 ~21 次，一直在响。留不留由状态机说了算——
  //   这条判定是全仓最热的一条路，答错一次的后果不是性能，是隐私。
  let loggedFirstFrame = false;
  proc.onaudioprocess = (e) => {
    if (!loggedFirstFrame) {
      loggedFirstFrame = true;
      // 一行把三段分开：申请到设备多久（G1）、到第一帧真的流起来多久。
      // 这就是"按下就喊会丢多少"的上界——盲区本体。
      console.log(
        `[voice] device open: ${Math.round(performance.now() - tArm)}ms ` +
        `(gum ${Math.round(tGum)}ms, first frame ${Math.round(performance.now() - tArm)}ms, ${cold ? "cold" : "warm"})`,
      );
    }
    const src = e.inputBuffer.getChannelData(0);
    const { keep, next } = onFrame(state, src.length, maxFrames);
    state = next;
    if (keep) chunks.push(new Float32Array(src)); // 必须拷贝：这块缓冲下一批会被复用
  };
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  applyMute(); // 到手即静音：握住 ≠ 在录

  const stopCollecting = () => { state = onRelease(state); applyMute(); };

  return {
    snapshot: () => state,

    press(): boolean {
      // 切后台会让 AudioContext 挂起（常驻件才有这个问题，旧的每次新建没有）。
      // 不 await：resume 是异步的，等它就等于把盲区又请回来了；下一帧自然会来。
      if (ctx.state === "suspended") void ctx.resume();
      const next = onPress(state);
      if (next === state) return false; // 没 armed ⇒ 没开始，调用方不许亮灯
      state = next;
      chunks = [];
      applyMute(); // 解除静音——一个标志位，不是设备操作
      return true;
    },

    cancel() {
      state = onCancel(state);
      chunks = [];
      applyMute();
    },

    async release(): Promise<VoiceRecording | null> {
      // 松手 ≠ 声音已经到齐：AEC/降噪管线本身有延迟，加上 ScriptProcessor
      // 4096 帧一批，最后一段还在路上。立刻停就把尾巴切了——一句「…现在怎么办」
      // 到手成「…现在怎么」（刀 B，用户 2026-08-09 手测实录）。宽限一下再停。
      // ⚠ 这段宽限**测不出来于合成假麦**（假 getUserMedia 没有 AEC 管线，
      //   夹具里尾损只有 ~13ms）——真机效果的裁决权在手测。
      await new Promise((r) => setTimeout(r, TAIL_GRACE_MS));
      const frames = state.frames;
      const rate = ctx.sampleRate;
      const collected = chunks;
      stopCollecting();          // ★停的是收集，不是设备——下一次按下才没有盲区
      chunks = [];
      if (frames === 0) return null;
      const durationSec = frames / rate;
      if (durationSec < 0.3) return null; // 手滑点一下，不算命令

      try {
        const flat = new Float32Array(frames);
        let at = 0;
        for (const c of collected) { flat.set(c.subarray(0, Math.min(c.length, frames - at)), at); at += c.length; if (at >= frames) break; }
        const base64 = await resampleToWav16k(flat, rate);
        return { data: base64, format: "wav", durationSec };
      } catch {
        return null; // 采集/重采样出问题＝没听到，交给上层 fail-closed，不发半个包
      }
    },

    dispose() {
      state = onDisarmed(state);
      chunks = [];
      proc.onaudioprocess = null;
      try { source.disconnect(); proc.disconnect(); mute.disconnect(); } catch { /* 已断开 */ }
      stream.getTracks().forEach((t) => t.stop()); // 真正释放麦克风（橙点熄灭）
      void ctx.close();
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
