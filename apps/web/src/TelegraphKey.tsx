/**
 * 动画R2 步 4 · 电报机（刀 B / B1）
 *
 * 输入框旁的一台小电报机：发报键杠杆＋纸带。输入框内容**真变一次**，键头敲一下、
 * 纸带上多一个点或划。
 *
 * 铁律 1（真状态驱动，禁装饰循环）：本组件**没有任何常驻循环动画**——键头只在
 * `pulses` 变化时敲一下（一次性），纸带上有几个记号完全由 `pulses` 算出来。
 * 不打字＝一动不动。
 *
 * 铁律 3（隐喻分区）：电报＝文字，钉在输入框旁**不进对话流**；电台（RadioCallRow）
 * ＝语音，进对话流。语音识别写进输入框的字是程序写入、不过 onChange，所以
 * 语音永远敲不响这台机器——这条隔离是免费的，但仍有断言盯着（步 4 反对照）。
 *
 * ★ 纸带记号**纯由 pulses 推导**，组件内不累积 state：dev 下 StrictMode 会重跑
 *   updater/effect，累积式写法会多记；纯推导天然免疫。
 */

/** 纸带上同时看得见几个记号。 */
const VISIBLE_MARKS = 5;
/** 每个记号占的槽宽（viewBox 单位）。 */
const SLOT = 5;

export function TelegraphKey({ pulses = 0, transmits = 0 }: { pulses?: number; transmits?: number }) {
  // 最新的记号贴着机器，越老越往右——纸带从机器里吐出来往外走。
  const marks: { n: number; dash: boolean }[] = [];
  for (let i = 0; i < VISIBLE_MARKS; i++) {
    const n = pulses - i;
    if (n <= 0) break;
    marks.push({ n, dash: n % 3 === 0 });   // 点划交替出现，纯看序号，不掷骰子
  }

  return (
    <span
      className="tk-wrap"
      data-telegraph
      data-telegraph-pulses={pulses}
      data-telegraph-transmits={transmits}
      title="电报机"
    >
      <svg className="tk-svg" viewBox="0 0 56 28" width="56" height="28" aria-hidden="true">
        {/* 底座 */}
        <rect x="2" y="21" width="22" height="4" rx="1" fill="currentColor" opacity="0.5" />
        {/* 支柱与触点 */}
        <path d="M18 21 L18 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
        <rect x="4" y="17.5" width="5" height="2" rx="0.8" fill="currentColor" opacity="0.6" />

        {/* 发报键杠杆：key 变了就重新挂载，一次性敲击动画因此每次都重放。
            key 同时吃 pulses 与 transmits——回车不改输入框内容（不过 onChange），
            只吃 pulses 的话发报那一下杠杆不会动。 */}
        <g key={`p${pulses}t${transmits}`} className={`tk-lever${pulses > 0 || transmits > 0 ? " tk-lever--strike" : ""}`}>
          <path d="M6 11 L20 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="6.5" cy="11" r="2.6" fill="currentColor" />
        </g>

        {/* 纸带：一条底线＋若干点划 */}
        <path d="M27 24 L54 24" stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
        {marks.map((m, i) => (
          <rect
            key={m.n}
            className="tk-mark"
            x={28 + i * SLOT}
            y="10"
            width={m.dash ? 4 : 1.8}
            height="3"
            rx="0.9"
            fill="currentColor"
          />
        ))}

        {/* 发报：一串长划打出去。key={transmits} ⇒ 每次发送重挂载重放，
            ~600ms 一次性、非循环（事件驱动，铁律 1）。transmits 为 0 时不渲染，
            所以开局静止。 */}
        {transmits > 0 && (
          <g key={`tx${transmits}`} className="tk-burst">
            <circle className="tk-burst__shock" cx="6.5" cy="11" r="5" fill="none"
                    stroke="currentColor" strokeWidth="1.2" />
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} className={`tk-burst__dash tk-burst__dash--${i}`}
                    x={28 + i * 7} y="10" width="5.5" height="3" rx="1" fill="currentColor" />
            ))}
          </g>
        )}
      </svg>
    </span>
  );
}
