// ============================================================
// 音量 —— 参谋的嗓子 和 战场的动静，各一条
//
// 用户 2026-09-12：「音量，有时候太吵了，有没有能调节音量的，
// 调节 both 将军的语音音量和战斗声效的音量？」
//
// ★ 为什么是两条而不是一条总音量：这两样吵起来的原因不一样。参谋一直在说话
//   （那是本作的主界面，不能关死）；战场音效是密集的小声响，人多的时候糊成一片。
//   合成一条总音量的话，想压住炮声就得连陈的话一起压掉。
//
// ★ 单一真相源：两条播放路（Edge 的 <audio> 与浏览器原生 utterance）都从这里取，
//   别在播放点各存一份——那是"同一个数两处写"的老毛病。
// ============================================================

import { soundManager } from "./rendering/audio/soundManager";

const VOICE_KEY = "aic_vol_voice_v1";
const SFX_KEY = "aic_vol_sfx_v1";

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));

/** localStorage 在无痕窗口/禁用站点数据时会直接抛，不能裸读（同 `introSeen` 那条）。 */
function load(key: string, dflt: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? dflt : clamp(parseFloat(raw));
  } catch { return dflt; }
}
function save(key: string, v: number): void {
  try { window.localStorage.setItem(key, String(v)); } catch { /* 存不下就本局有效 */ }
}

let voiceVolume = load(VOICE_KEY, 1);
let sfxVolume = load(SFX_KEY, 1);

/** 正在播的那一条也要跟着变——拖滑块时听得见反馈，否则得等下一句才知道调没调对。 */
type Listener = (v: number) => void;
const voiceListeners = new Set<Listener>();

export function getVoiceVolume(): number { return voiceVolume; }
export function setVoiceVolume(v: number): void {
  voiceVolume = clamp(v);
  save(VOICE_KEY, voiceVolume);
  for (const fn of voiceListeners) { try { fn(voiceVolume); } catch { /* 观察点不许影响播放 */ } }
}
export function onVoiceVolumeChange(fn: Listener): () => void {
  voiceListeners.add(fn);
  return () => voiceListeners.delete(fn);
}

export function getSfxVolume(): number { return sfxVolume; }
export function setSfxVolume(v: number): void {
  sfxVolume = clamp(v);
  save(SFX_KEY, sfxVolume);
  soundManager.setMasterVolume(sfxVolume);
}

/** 开局把存下来的值推给音效系统（语音那条是播放时现取的，不用推）。 */
export function applyStoredAudioSettings(): void {
  soundManager.setMasterVolume(sfxVolume);
}
