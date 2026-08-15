/**
 * 动画R2 步 2 · 无线电呼叫行（刀 A / A1）
 *
 * 按住 🎤 且**真在收音**时，对话流末尾落一条临时行：载波弧线脉动 ＋ 莫尔斯点划行进。
 * 松手 → 行卸载、正式消息落下。
 *
 * 铁律 1（真状态驱动，禁装饰循环）：**行的存在**由 ChatPanel 的 `pttStatus === "listening"`
 * 控——那是 C3 遗产里跟 🔴 红灯同一个源（录音臂只有 `arm.press()` 真返回 true 才置
 * listening，设备没到手不许亮）。行内的弧线/点划循环是"载波"这件事本身的隐喻，
 * 同 game-ui.css 既有 hud-pulse 家族先例。
 *
 * 铁律 2（素材零外部）：SVG 全手搓，颜色一律 currentColor，由 .rc-row 的 color 驱动，
 * 取消态只需换一个 class 就整体翻红。
 *
 * 铁律 3（隐喻分区）：电台＝语音，进对话流；电报（TelegraphKey）＝文字，钉在输入框旁
 * 不进对话流。两边互不触发。
 *
 * 本组件零持久化：不进 messageStore，digest/上下文拼装碰不到它。
 */

/** 莫尔斯带一个循环节 26px：点(3) 空(4) 划(9) 空(4) 点(3) 空(3)。
 *  画 4 节、只开 74px 的窗，配合 -26px 的位移动画＝无缝行进。 */
const MORSE_PERIOD = 26;
const MORSE_MARKS = [
  { x: 0, w: 3 },
  { x: 7, w: 9 },
  { x: 20, w: 3 },
];

export function RadioCallRow({ cancelIntent = false }: { cancelIntent?: boolean }) {
  return (
    <div
      data-radio-call
      data-cancel-intent={cancelIntent ? "1" : "0"}
      className={`rc-row${cancelIntent ? " rc-row--cancel" : ""}`}
    >
      <div className="rc-card">
        <svg className="rc-svg" viewBox="0 0 132 26" width="132" height="26" aria-hidden="true">
          {/* 天线塔：竖杆＋两条支腿＋塔尖 */}
          <g className="rc-mast" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round">
            <path d="M12 22 L12 6" />
            <path d="M6 22 L12 13 L18 22" />
            <circle cx="12" cy="4.6" r="1.6" fill="currentColor" stroke="none" />
          </g>

          {/* 载波弧线：三层同心，stagger 脉动（延迟错开＝一圈圈往外推的手感） */}
          <g className="rc-arcs" stroke="currentColor" fill="none" strokeLinecap="round">
            <path className="rc-arc rc-arc--1" strokeWidth="1.6" d="M17.1 6.9 A8 8 0 0 1 17.1 19.1" />
            <path className="rc-arc rc-arc--2" strokeWidth="1.4" d="M21 2.3 A14 14 0 0 1 21 23.7" />
            <path className="rc-arc rc-arc--3" strokeWidth="1.2" d="M27.3 0.1 A20 20 0 0 1 27.3 25.9" />
          </g>

          {/* 莫尔斯纸带：开一扇 74px 的窗，带子在里面匀速左行 */}
          <defs>
            <clipPath id="rc-tape-clip">
              <rect x="52" y="0" width="74" height="26" />
            </clipPath>
          </defs>
          <g clipPath="url(#rc-tape-clip)">
            <g className="rc-tape" transform="translate(52 0)" fill="currentColor">
              {[0, 1, 2, 3].map((period) =>
                MORSE_MARKS.map((m) => (
                  <rect
                    key={`${period}-${m.x}`}
                    x={period * MORSE_PERIOD + m.x}
                    y="11"
                    width={m.w}
                    height="4"
                    rx="1"
                  />
                )),
              )}
            </g>
          </g>
        </svg>

        <span className="rc-label">{cancelIntent ? "✕ 松手取消" : "📻 电台呼叫中…"}</span>
      </div>
    </div>
  );
}
