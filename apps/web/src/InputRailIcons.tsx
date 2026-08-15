/**
 * 动画R2 步 6 · 输入排图标年代化（用户 08-15 刀 B 手测后点单）
 *
 * 🎤/🔇 是系统 emoji 字形，不吃 HUD 色板、样式也管不住（与砍 📻 同一病）。
 * 这里手搓两颗 SVG 顶替，线条与 RadioCallRow 同族，颜色一律 `currentColor`
 * ——按钮的 color 给什么就是什么，状态色仍由 ChatPanel 那套状态机说了算。
 *
 * ★只换皮：状态机零改动。铁律 1 的真状态源（pttStatus 只有 arm.press() 真进
 *   collecting 才置 listening）原封不动，这里拿到什么画什么。
 */

/** 年代感电台手持话筒：圆头＋格栅横条＋短柄。listening 时套一圈细呼吸环。 */
export function MicIcon({ listening = false }: { listening?: boolean }) {
  return (
    <svg className="ir-icon ir-mic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      {/* 呼吸环：只在真在收音时出现（与 🔴 同源，不是装饰） */}
      {listening && (
        <circle className="ir-mic__ring" cx="12" cy="9.5" r="8.2"
                fill="none" stroke="currentColor" strokeWidth="0.9" />
      )}
      {/* 话筒圆头 */}
      <circle cx="12" cy="9.5" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {/* 格栅横条（三道，两端短一点，贴着圆边收） */}
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <path d="M8.4 7.2 L15.6 7.2" />
        <path d="M7.6 9.5 L16.4 9.5" />
        <path d="M8.4 11.8 L15.6 11.8" />
      </g>
      {/* 短柄＋底座 */}
      <path d="M12 15.5 L12 19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.8 20.6 L15.2 20.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 号角喇叭（锥口朝右）：开＝亮，关＝调暗＋斜杠。 */
export function HornIcon({ on = false }: { on?: boolean }) {
  return (
    <svg className={`ir-icon ir-horn${on ? "" : " ir-horn--off"}`}
         viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      {/* 喉管 */}
      <path d="M3 10.4 L3 13.6 L7.5 13.6 L7.5 10.4 Z"
            fill="currentColor" opacity="0.85" />
      {/* 号口：向右张开的喇叭 */}
      <path d="M7.5 9.6 L7.5 14.4 C 11 14.6, 13.5 17.6, 17.5 19.4 L17.5 4.6 C 13.5 6.4, 11 9.4, 7.5 9.6 Z"
            fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {/* 开着时两道声波弧 */}
      {on && (
        <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.9">
          <path d="M19.6 9.4 A 4 4 0 0 1 19.6 14.6" />
          <path d="M21.4 6.8 A 7.4 7.4 0 0 1 21.4 17.2" />
        </g>
      )}
      {/* 关着时一道斜杠 */}
      {!on && (
        <path className="ir-horn__slash" d="M3.6 20.4 L20.4 3.6"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}
