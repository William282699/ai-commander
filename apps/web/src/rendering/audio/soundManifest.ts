// ============================================================
// AI Commander — Sound Manifest
// Maps sound IDs to file paths, volumes, and categories.
// All audio files are .mp3, served from apps/web/public/sfx/.
// ============================================================

export type SoundCategory = "combat" | "ambient" | "ui";

export interface SoundEntry {
  /** Unique sound ID */
  id: string;
  /** URL path (relative to public root) */
  src: string;
  /** Base volume (0-1) */
  volume: number;
  /** Category for volume group control */
  category: SoundCategory;
  /** Whether this sound loops */
  loop: boolean;
  /** Max simultaneous instances (prevents stacking 200 rifle sounds) */
  maxInstances: number;
}

export const SOUND_MANIFEST: SoundEntry[] = [
  // --- Combat ---
  { id: "rifle_01",        src: "/sfx/combat/rifle_01.mp3",        volume: 0.25, category: "combat", loop: false, maxInstances: 5 },
  { id: "rifle_02",        src: "/sfx/combat/rifle_02.mp3",        volume: 0.25, category: "combat", loop: false, maxInstances: 5 },
  { id: "cannon_01",       src: "/sfx/combat/cannon_01.mp3",       volume: 0.35, category: "combat", loop: false, maxInstances: 3 },
  { id: "explosion_01",    src: "/sfx/combat/explosion_01.mp3",    volume: 0.40, category: "combat", loop: false, maxInstances: 4 },
  { id: "explosion_02",    src: "/sfx/combat/explosion_02.mp3",    volume: 0.40, category: "combat", loop: false, maxInstances: 4 },
  { id: "explosion_03",    src: "/sfx/combat/explosion_03.mp3",    volume: 0.45, category: "combat", loop: false, maxInstances: 3 },
  { id: "death_scream_01", src: "/sfx/combat/death_scream_01.mp3", volume: 0.30, category: "combat", loop: false, maxInstances: 3 },

  // --- UI ---
  { id: "click",           src: "/sfx/ui/click.mp3",               volume: 0.30, category: "ui", loop: false, maxInstances: 2 },
  { id: "select",          src: "/sfx/ui/select.mp3",              volume: 0.25, category: "ui", loop: false, maxInstances: 2 },
  { id: "order",           src: "/sfx/ui/order.mp3",               volume: 0.30, category: "ui", loop: false, maxInstances: 2 },
  { id: "deselect",        src: "/sfx/ui/deselect.mp3",            volume: 0.20, category: "ui", loop: false, maxInstances: 2 },
  { id: "warning",         src: "/sfx/ui/warning.mp3",             volume: 0.35, category: "ui", loop: false, maxInstances: 2 },
  // ★步 5d 撤销：曾把 roger.mp3 当"参谋有话说"的到达提示音，手测判退。
  //   实测它是 1.646s 的无线电片段：静噪 → **男声约三音节**（0.20-0.66s，
  //   F0 128-155Hz、共振峰在动）→ 静噪 → 双音 beep。实播增益 0.35（category/
  //   master 系数全仓无调用点、恒为 1），RMS≈-21.8dBFS，与 Edge TTS 同级；
  //   而 play() 排在 ttsEnabled/loading/isBusy/capturing **所有闸之前**、与
  //   releaseOne 同拍 ⇒ 每句被念的台词开头都叠着一段人声，maxInstances:2 还
  //   允许两声互叠。**提示音不能是人声**。
  //   将来若要加：Web Audio 合成双音哔，且必须排到**仲裁之后**——只在"这句现在
  //   不会被念"的时候才响。（素材出处：2026-04-13 随音效系统进仓，原名
  //   Roger-that-sound-effect.mp3；全历史只有本刀引用过。）
];

// Unit type → attack sound ID mapping
export const ATTACK_SOUND_BY_UNIT_TYPE: Record<string, string[]> = {
  infantry:     ["rifle_01", "rifle_02"],
  elite_guard:  ["rifle_01", "rifle_02"],
  commander:    ["rifle_01", "rifle_02"],
  main_tank:    ["cannon_01"],
  light_tank:   ["cannon_01"],
  artillery:    ["cannon_01"],
  fighter:      ["cannon_01"],
  bomber:       ["cannon_01"],
  recon_plane:  ["cannon_01"],
};

// Unit category → death sound ID mapping
export const DEATH_SOUND_BY_CATEGORY: Record<string, string[]> = {
  ground_vehicle:  ["explosion_03"],                           // big explosion for tanks
  ground_infantry: ["explosion_01", "explosion_02", "death_scream_01"], // smaller explosion + scream for infantry
  air:             ["explosion_03"],                           // big explosion for aircraft
};
