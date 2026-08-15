# UI 动画 Round 2 · 工程 Plan（Fable 出稿 2026-08-15，待 Opus 审）

> 权威需求＝`UI_ANIMATION_ROUND2_HANDOFF_20260815.md`，冲突以交接档为准。
> 本 plan 已亲核代码（铁律 6），所有病灶引用给 **grep 锚点**（行号必漂）。
> 流程：本档 → Opus 审 → 用户三行概要过目 → 开工。
> **2026-08-15 Opus 审核「有条件通过」→ P0×5/P1×8 落文本 → 复核四过一不过 → 已修二处（P0-3b cancelPTT 真首行闸、P2-3 驳回理由勘误）＋两 nit（§7 样例补类型转型、§4 反② down/up 同 tick）＝本版定稿，审核明示两处逐字可核不必再回审。锚点抽查全属实；勘误/步0/pointercancel 三条交办全过。**

## 0. 现场核账（plan 窗 2026-08-15 亲核，全过）

| 项 | 结果 |
|---|---|
| 基线 | `ui-simplify-v1-done`@e97b8e9 **在 main 上**（main HEAD `1de78eb` 是收口立档 commit）✓ |
| worktree | `AI Commander-voice-input` 在 `ui-simplify-v1`@e97b8e9，干净 ✓ |
| dev 服务 | `frame-web`(3025)/`frame-api`(3024) 脚本确认 cd 进 voice-input worktree ✓（`web`=3003=主仓库，勿用） |
| 工装 | round 1 scratchpad 仍在（`assert-step*.mjs`＋playwright），路径见交接档 §0 ✓ |
| 病灶① | ChatPanel 两处 PTT 按钮均有 `onPointerLeave={() => { if (pttStatus === "listening") stopPTT(); }}`＝滑出即发送（交接档 A2 陷阱属实） |
| 病灶② | Web Speech 臂 `rec.onend` 里 `document.querySelector("[data-send-btn]")…click()`＝语音发送与打字发送共用一颗键、**无来源标记**（B3 属实） |
| 半成品 | `voiceRecorder.ts` 的 `cancel()` 真丢弃（`chunks = []`＋`onCancel`），`stopPTT` 设备未就绪分支已在用（交接档铁律 6 属实） |
| 语音占位 | `sendCommand(voice)` 语音回合立即落 `"🎤 …"` 占位（grep `isVoiceTurn ? "🎤 …"`）→ A1「松手→动画消失、正式消息落下」有现成落点 |
| 色板 | `--hud-accent-purple/yellow` 已在 `game-ui.css` `:root` ✓（二者**无 -dim/-glow 变体**，辉光只用 cyan/amber 家族） |
| ★交接档勘误 | 交接档 §0 账①「PTT 真麦手测从未做过」**已过时**：round 1 收口时已由用户亲测销账（LEDGER 销账记录＋ROADMAP「PTT 真麦克风 PASS（08-15）」在案；交接档写于收口前）。本轮步 3 的真麦手测是**本刀自身验收**（重接了 stopPTT 收尾路径，须重验），不销旧账——修一笔划一笔，不双销 |

关键结构事实（实施窗必读）：

- **ChatPanel 单文件双态**：`isDetached` 分岔，`if (isDetached) { return … }`（grep 锚点）之前是共享逻辑。弹窗态输入区在 `dp-conv-dock`（`className="dp-dock-btn dp-dock-btn--ptt"`），嵌入态输入区在文件尾 `inputContainerStyle` 一带（内联 `pttBtnStyle`）。**每份 document 只渲染其中一态**，故 `[data-send-btn]` 唯一、PTT 按钮唯一。弹窗是独立 window（自己的 ChatPanel 实例、自己的 pttStatus），动画各自独立，天然正确。
- **对话流共享**：`chatContentFragment`（grep `Shared chat content fragment`）两态共用，A1 行插一处、两态都有。
- **两臂分岔在 `startPTT`**：`channelUsesVoiceCapture(voiceCh) && isVoiceCaptureSupported()` → 录音臂（`pressWantedRef`/`arm.press()`）；否则 Web Speech 臂（`rec.onresult` 把 interim **实时写进 `setMessage`**、`rec.onend` 自动点发送键）。
- **红灯真源**：录音臂只有 `arm.press()` 返回 true 才 `setPttStatus("listening")`（C3 遗产）。A1 行挂 `pttStatus === "listening"`＝与红灯同源（铁律 1 达标）。
- **Enter 路径**：`handleKeyDown` → `sendCommand()`；空输入被 `sendCommand` 函数体第 3 行的完整守卫 `if (!state || (!voice && !message.trim())) return;` 弹回——**`!state` 项对 B2 挂点承重**（fireTransmit 必须落在整条守卫之后，state 为 null 不许放空炮）；loading 时 input/按钮双 disabled，事件根本进不来——B2 两格负对照的物理来源。
- **Esc 冲突**：主窗 `input.ts` 有 `e.key === "Escape"` → 释放选区（grep `escPressed`）。PTT 按住期间的 Esc 监听必须 **document capture 相＋stopImmediatePropagation**，且只在按住期间挂载（弹窗无 GameCanvas，无此冲突）。

## 1. 总步序（5 步，每步＝一 commit＋typecheck＋台架 25/25＋新断言＋截图报审；报审给**截图绝对路径**，跨会话「发图」发不过去）

分支：voice-input worktree 内 `git checkout -b ui-anim-round2 main`。
刀 A（步 1-3）全部落地并手测后才开刀 B（步 4-5），两刀 commit 不混（铁律 5）。
commit 题头 `动画R2 步N: 一句话主题`（家法：编号必附主题）。只暂存本步文件；
不碰 lockfile（家法）；不 add `.github/`。

| 步 | 刀 | 主题 |
|---|---|---|
| ~~0~~ | — | ~~风格条数字跟色~~ **已裁「不跟」（用户 2026-08-15）＝划账，本轮无步 0** |
| 1 | A | A3 PTT 键加大（两态） |
| 2 | A | A1 无线电呼叫行（手搓 SVG，挂红灯同源状态） |
| 3 | A | A2 滑开取消＋Esc（两臂收尾，反转 onPointerLeave 陷阱）→ **刀 A 真麦手测（本刀自身验收，见 §0 勘误）** |
| 4 | B | B1 电报机仪器＋打字敲键（onChange 驱动） |
| 5 | B | B2 发报动画＋B3 来源分流 → 刀 B 手测 |
| 6 | 补 | 输入排图标年代化（用户 08-15 手测后新点单：🎤/🔇 emoji 换手搓 SVG，见 §7c） |

收口：更新主仓库 `ROADMAP.md` 收口段（＋LEDGER 若有新账）、tag `ui-anim-round2-done`、等用户点头后合 main。

---

## 2. ~~步 0~~ · 风格条数字跟色 — **已裁「不跟」（用户 2026-08-15）**

用户裁定：数字列保持统一 cyan（竖排扫读＋「值变闪红」信号在任何底色上
对比度不衰减）。LEDGER §M「数字跟色待裁」这笔账**划掉**；本轮无步 0，
实施窗勿做。收口时同步更新 LEDGER。

## 3. 步 1 · A3 PTT 键加大

- 嵌入态：`pttBtnStyle`（grep `const pttBtnStyle`）padding `6px 8px`→`10px 14px`、fontSize 11→16、加 `minWidth: 44`（同 style 被 TTS 喇叭键复用——喇叭键**不跟**，给 PTT 单独加量，别动共享 const，加一个 `pttBigStyle` 覆盖层）。
- 弹窗态：喇叭键与 PTT 共用 `.dp-dock-btn--ptt`（现值 font-size:14px/padding:5px 8px，审核已查）。拆法（审核定稿）＝PTT 换新 class `dp-dock-btn--ptt-main`，CSS 写 `.dp-dock-btn--ptt, .dp-dock-btn--ptt-main { …原值原样… }` 再单独给 `-main` 加量——喇叭键侧**零 diff**，截图核对不靠肉眼。
- `touchAction: "none"` 已有，保留。
- **实施注记（步 1 落地，78866e6）**：两处 PTT 加了 `data-ptt-btn` 测试锚（plan 原稿没写；title 随 status 四变不是稳定把手）——**步 2/3 的 DOM 断言与指针 hit-test 一律抓它**，与 `data-radio-call` 同族。
- 44 是触屏 a11y 下限，桌面鼠标场景只作**首版起点**：终值由步 1 截图用户目测定（家法：幅度对齐真实场景）。
- **判据**：截图两态对比；DOM 断言 PTT 按钮 `offsetWidth/Height ≥ 44`；负对照＝喇叭/编队/发送键**宽/字号/内边距**与基线零 diff（基线取数与本步**同分辨率、同 dev server 3025**，否则不可比）；弹窗态取数必须从主页面点「弹出面板」进（直连 `?mode=panel` 无 opener 自关）。**高度例外有案（步 1 报审，用户 08-15 裁「接受」）**：嵌入态 `inputContainerStyle` 是 flex 无 alignItems＝默认 stretch（既有布局属性，非本刀改动），行高随最高项 37→48、三邻键高度 co-move——整行等高像一条仪表栏；治它（alignItems:center）反而让三键缩到比原值还矮，不治。弹窗态 `.dp-conv-dock` 自带 align-items:center，喇叭键 rect 零 diff 严格成立。**尺寸定稿**＝嵌入 50×48／弹窗 47×44（用户 08-15 裁「够了」）。

## 4. 步 2 · A1 无线电呼叫行

**新文件 `apps/web/src/RadioCallRow.tsx`**（新组件文件不算重构 ChatPanel；ChatPanel 只加一个条件渲染）＋ `game-ui.css` keyframes。

- 挂点：`chatContentFragment` 内 `conversationMessages.map(...)` 之后、`{/* Inline staff threads */}` 之前（grep 锚点），条件 `pttStatus === "listening"`，两态共享。
- 形态：右对齐（玩家侧）临时行，手搓 SVG：载波弧线（三层嵌套弧 stagger 脉动）＋莫尔斯点划行进（rect 序列 CSS 位移/明暗）＋文案「电台呼叫中…」（**📻 已裁掉**——用户 08-15 步 2 报审裁定：手搓天线塔在前 emoji 重复、且是整行唯一不吃 cyan 色板的元素、还压宽度致嵌入态截断；步 2b 小 commit 落地，断言锚定「电台呼叫中」不受影响）。色＝cyan 系（`--hud-accent-cyan(-glow)`）；组件收 `cancelIntent` prop（步 3 用：翻红＋「松手取消」）。**取消态红版长相已由用户过目定稿（08-15 步 2 报审，预览图＝手工加 class 拍摄、DOM 断言未碰隐藏分支）——步 3 只接线不改样**。
- 循环动画合法性：**行的存在**由真收音状态驱动（铁律 1），行内循环是载波隐喻，同 `game-ui.css` 既有 pulse keyframes 先例。
- 滚动：复用 ChatPanel 既有滚底机制（grep `scrollRef.current.scrollTop = scrollRef.current.scrollHeight`，deps `[displayMessages.length]` 不会为本行触发）——新加一个 `useEffect([pttStatus])` 调同一句。**不用 `scrollIntoView`**（会连带滚动祖先容器，嵌入态在 HUD 里有位移风险，审核 P1-5）。
- 不进 messageStore：纯渲染态条件块，零持久化，digest/上下文拼装碰不到它。
- **行为规格：呼叫行两臂都出现**（语音＝电台，隐喻不分臂；马克斯 Web Speech 臂 `rec.start()` 后同样亮灯出行——审核问原因①，plan 窗答复：该出现，铁律 3 的分区是「语音 vs 文字」不是「录音臂 vs 识别臂」）。
- 消失＝松手：录音臂 `stopPTT` 里 `setPttStatus("idle")` 同步执行 → 行卸载；占位 `"🎤 …"` 至少晚 300ms 落下（`arm.release()` 内 `TAIL_GRACE_MS` await＋重采样），且录音 <0.3s 或无声时 `rec` 为 null **永远不落占位——这是规格不是 bug**（审核 P1-1）。Web Speech 臂 status 在 `abort()/stop()` 后的 `onend` 里才回 idle（内含 50ms setTimeout），行消失晚于松手一拍，可接受。
- **判据**（playwright＋`--use-fake-ui/device-for-media-stream` 假麦，陈频道）：
  - 正：pointerdown → 行出现（DOM 有 RadioCallRow 测试锚 `data-radio-call`）且按钮 🔴；pointerup → 行消失、`🎤 …` 占位**轮询等待**落下（≥300ms 见上；按住时长 ≥1s 防「太短→null」假绿）。
  - 反①：idle 态无行。
  - 反②（真负对照，咬铁律 1「灯不许撒谎」，审核 P0-5 定稿）：录音臂 `?novoicewarm` 关预热＋按下后立刻松手——设备没到手 `pressWantedRef` 已 false ⇒ `press()` 永不执行 ⇒ 全程无灯**无行**（复用既有负对照臂开关，零新工装）。**down/up 必须同 tick 派发**（一次 page.evaluate 连发）——假麦 getUserMedia 解析极快，隔 tick 松手 `press()` 会真跑起来，此条变假红（审核复核 nit）。
  - ~~「马克斯 headless unsupported 无行」~~ **审核毙掉勿做**：它把「浏览器没 API」错当规格（真 Chrome 里马克斯该有行，见上规格），且与步 4/5 注入假 SpeechRecognition 的复用工装打架。
  - 绊索自证：断言脚本先对基线跑一遍必须 FAIL（基线无此行）。
  - 隐藏条件块（`cancelIntent` 分支步 2 尚不可达）源码点名，不做 DOM 断言（家法：DOM 断言只覆盖渲染出来的）。

## 5. 步 3 · A2 滑开取消＋Esc（本轮技术核心）

### 5.1 指针模型（两处 PTT 按钮对称改，弹窗态＋嵌入态）

| 事件 | 新行为 |
|---|---|
| pointerdown | 现行为＋`setPointerCapture(e.pointerId)`（**包 try/catch**：pointerId 失效抛 NotFoundError，不许连累 startPTT——审核 P2-4）＋`setPttCancelIntent(false)` |
| pointermove | 按住期间：指针坐标对按钮 `getBoundingClientRect()` 外扩 12px 做 hit-test；出界→`setPttCancelIntent(true)`，回界→`false`（微信手感：滑回可反悔）。12px 是鼠标尺度手感参数，随 pointercancel 一起进用户概要 |
| pointerup | **首行闸 `if (!pttPressedRef.current) return;`（审核 P0-3）**：Esc 取消后手指仍按着，随后的 pointerup 不许再走 stopPTT——否则 ① `releaseAtRef` 被钉假计时起点，下一次任何 TTS 出声都被算成这次已取消按下的 firstSoundMs 送回服务端；② Web Speech 臂对已 abort 的 recognition 再 stop()。过闸后 `releasePointerCapture`（早退跳过它无害——pointerup 后浏览器本就隐式释放）；`cancelIntent ? cancelPTT() : stopPTT()`。**此闸保留，不能只靠 cancelPTT 内的闸——这里还要挡 stopPTT** |
| pointercancel | 同上首行闸；**改 `cancelPTT()`**（现＝stopPTT 即发送。系统夺走指针≠长官下令，半句错令照发正是本病；有意手感变更，必须进用户概要） |
| pointerleave | **删掉 stopPTT 调用**（陷阱本体）。删除理由写进代码注释：释放 capture 时浏览器会向 capture 目标**补发 pointerout/leave**，旧 handler 若在、pttStatus 同 tick 仍是 listening，会在 cancelPTT 之后再补一发 stopPTT——删 leave 是必要不是顺手（审核决断点 2 定稿） |
| lostpointercapture | → `cancelPTT()` 兜底（审核 P1-3）。**每次正常松手它都必然补发**（规范：pointerup 后隐式释放 capture）——空转不靠运气，**由 cancelPTT 真首行闸保证**（§5.3，审核复核 P0-3b）；异常丢 capture 才真咬——不兜则 collecting 卡真、麦克风轨道保持 unmuted，踩 voiceCaptureState.ts 隐私不变量「没按下⇒一个样本都不许留」 |
| window blur | 按住期间挂临时监听 → `cancelPTT()`（切窗＝系统打断，同 pointercancel 语义；空转同由 cancelPTT 首行闸保证） |

取消态视觉：按钮翻深红闪烁＋图标 ✕＋title「松手取消」；A1 行同步翻红＋「松手取消」（`cancelIntent` prop）。

### 5.2 Esc 同效

新状态 `pttPressed`＋同步 ref `pttPressedRef`（§5.1 判闸用 ref 不用 state——同 tick 内 state 未更新）。置 true 的位置必须在 `startPTT` **两处早退之后**（grep `if (loading) return` 与 `if (!SpeechRecCtor) return`），否则 unsupported/loading 边界留下永挂的 capture 监听（审核 P1-4）；stop/cancel 全路径置 false（含设备在途窗口）。
`useEffect(pttPressed)`：挂 `document.addEventListener("keydown", h, true)`；
`h`＝Escape → `preventDefault`＋`stopImmediatePropagation`＋`cancelPTT()`。
capture 相在 `input.ts` 的 window 冒泡监听之前截断（实施时核 input.ts 挂载相位，若也是 capture 再调整）。松手即卸监听。

### 5.3 cancelPTT()（两臂一函数，新 useCallback）

```
真首行闸: if (!pttPressedRef.current) return;
  // ★先于公共头（审核复核 P0-3b）。lostpointercapture 不是异常路径——规范规定
  // pointerup 派发完浏览器隐式释放 capture 并补发它，**每次正常松手都响**；
  // 无此闸，cancelPTT 会在 stopPTT 之后再跑一遍：清掉刚写的 releaseAtRef
  // （延迟 A/B 探针对每个语音回合永久哑），且落进 Web Speech 分支 abort 掉
  // pending 的 onend——马克斯每次正常语音发送都被自己的兜底网静默取消回滚。
  // §5.4 正对照咬得出这病，但修错位置（顺手删兜底行）会把 P1-3 隐私逃生口
  // 一起删掉，故闸必须钉在这里，兜底行不许删。
公共头: pttPressedRef = false;
  releaseAtRef.current = 置空;   // ★cancelPTT 不许写计时起点也要清掉残值——
  // stopPTT 首行那句 performance.now() 是发送回合专属，取消回合不参与
  // 延迟 A/B 探针，否则假 firstSoundMs 搭顺风车回服务端（审核 P0-3）
录音臂（pressWantedRef.current 为真，含设备在途）:
  pressWantedRef = false; voiceArmRef.current?.cancel();
  预热关闭时 dispose 并置 null（与 stopPTT 的 releaseDevice 完全对齐）;
  setPttStatus(idle, error 保持); return;
Web Speech 臂（pttRecRef.current 存在）:
  pttCancelledRef = true; pttRecRef.current.abort();
  // 回滚在 onend 里做——abort 后 onend 仍会 fire，且已 final 的文字可能非空，
  // 现 onend 会照样自动发送——这一格必须封死：
onend 头部新增:
  if (pttCancelledRef) { 清标志; setMessage(快照); 清快照; status→idle;
    pttRecRef=null; return; }   // 不自动发送、不点 [data-send-btn]
```

快照点＝Web Speech 臂 `startPTT` 里 `rec.start()` 前：
`setMessage(prev => { messageSnapshotRef.current = prev; return prev; })`
（startPTT 闭包里没有新鲜 `message`，函数式 set 拿真值；React 同值 bail-out 无副作用）。
审核 P2-3 提议改读 `inputRef.current.value`——**不采纳，维持函数式捕获**：`inputRef` 两态都挂着（grep `ref={inputRef}` 双命中＝弹窗 `dp-dock-input` 与嵌入态 input，每 document 只渲染一态故无歧义），两条路都可行，但函数式捕获已成立、改动更小，P2-3 本就是可选项。（勘误：本段初版驳回理由「弹窗态无 ref」是 plan 窗读漏一行造出的假事实，审核复核抓出已改——承重档里的错出处会被照抄，教训同「80%」旧案。）

### 5.4 判据

- **前置闸（审核 P0-2，防整组断言测错臂）**：录音臂任何断言前先**硬失败**核臂身份。`channelUsesVoiceCapture` 读的是启动时 `/api/health` 拉回的白名单（服务端＝`VOICE_INPUT_CHANNELS ∩ provider==="gemini"`），拉不到/超时/字段缺席 ⇒ 空名单 fail-closed，陈频道**静悄悄退回 Web Speech 臂**——断言全绿而臂是错的（家法「测效果不测措辞」栽过的形状）。判法二选一：断言 `knownVoiceChannels()` 含 combat，或断言 console 出现 `[voice] device open:` 行；不过 → **abort 整脚本并报「臂不对」**（不是 skip，skip 会被读成 PASS）。
- **录音臂**（假麦可全自动；按住时长一律 **≥1s**——短于 0.3s 的 `rec=null` 会让「零发包」恒真，基线跑同一时长，审核 P1-2）：按下→滑出按钮 12px 外→断言 `data-radio-call` 翻红文案「松手取消」＋按钮 ✕；松手→**无网络 POST**（拦 fetch 断言零发包）、**无 `🎤 …` 占位入流**、status idle；再按一次正常说→松手→照常发出（正对照，防"取消把臂弄坏"）。Esc 路径同断言。
- **Esc 与 input.ts 的冲突负对照（审核 P0-4 重做，原设计恒真）**：`input.ts` 首行 `isTextEditingElement` 早退＋`handleKeyDown` 的 `stopPropagation` ⇒ 焦点在输入框时「选区未被释放」无论有无新监听都过。重做法：(a) 断言前把焦点打离输入框（点 canvas，并断言 `document.activeElement` 非 input）；(b) 此条也走绊索自证——未挂 capture 监听的中间态跑一遍，Esc **必须清掉选区**（红），挂上监听后转绿。没有 (b) 不算负对照。
- **Web Speech 臂**（headless 无原生 API → playwright `addInitScript` 注入假 `SpeechRecognition`，脚本化吐 interim/final）：输入框预置「A线」→按住→假引擎吐「全军撤退」→断言框内实时出现→滑出→松手→**框内回滚为「A线」逐字相等**（绊索：快照回滚不是清空）、无发送、无占位；正对照＝不滑出松手→自动发送照旧。
- 绊索自证：滑出-不发断言对基线跑必须 FAIL（基线滑出＝发送，正是病）。
- 台架 25/25 无回归；typecheck。
- **步 3 过审后立即真麦手测**（本刀重接 stopPTT 收尾路径，须重验；round 1 的 PTT 手测账已销勿双销，见 §0 勘误；清单见 §8）。

## 6. 步 4 · B1 电报机仪器＋打字敲键

**新文件 `apps/web/src/TelegraphKey.tsx`**＋`game-ui.css` keyframes。

- 位置：两态输入框右侧、PTT 键左侧各插一台（每 document 只渲染一态，实例唯一）。尺寸 ~40×28：发报键杠杆＋纸带条。amber 系（`--hud-accent-amber`），与电台 cyan 分区。
- 驱动：两处 `onChange={(e) => setMessage(e.target.value)}`（grep 双命中，**都换**）改 `handleTypedChange`：`setMessage` 照旧＋`delta = |新长 − 旧长|`（旧值＝闭包里的 `message`），敲键 `min(max(delta,1), 8)` 连击（粘贴响一串、上限 8）。杠杆压下＋纸带出一点划并左移。
- **onChange 只被真实 DOM 输入触发**：`rec.onresult` 的 `setMessage` 是程序写入，不过 onChange——语音写字不敲键的隔离是免费的，但必须断言（见下）。
- **判据**（DOM 断言敲键脉冲计数器 `data-telegraph-pulses` 或 class 翻转计数）：
  - 正：type "abc" → 3 次脉冲；粘贴 10 字 → 一串（≤8）；退格 → 响（内容真变）。
  - 反：ArrowLeft/Shift/Tab → 0；**假 SpeechRecognition 吐字入框 → 0**（隐喻不串的第一半）；IME 组合输入响（组合更新是真 onChange，预期内，截图确认手感）。
  - 绊索自证：脉冲断言对基线 FAIL（基线无仪器）。
- **步 4 收口记录（08-15，commit `d91767d`）**：外观三项（56×28／琥珀／纸带同屏
  5 记号）**用户裁「照此定稿」**。两笔口径在案：①「粘贴」格 headless 拒剪贴板权限，
  改 `fill()` 单次灌入＝对 onChange-only 的 handler 等价刺激，断言措辞如实未谎称真
  粘贴；②绊索加了 `TRIPWIRE=1` 放行前置闸让计数断言真红——顺带证明「零响」类负
  断言在仪器缺席时恒真（null→null、Δ=0），**负断言只有站在前置闸背后才有意义**，
  此为闸的存在理由（方法注记，与 §12 资产同族）。
  - 计数断言一律 `>=` 不写 `===`：dev 下 StrictMode（main.tsx）双跑 updater，`===` 会假红；要精确计数就在 build 产物上跑（审核 P2-1，§7 同规则）。

## 7. 步 5 · B2 发报动画＋B3 来源分流

- **B3 标记（审核 P0-1：落点钉死在最内层）**：`rec.onend` 的自动发送裹在**两层包装**里——外层是 `setMessage(prev => …)` state updater（非同步执行），内层是 `setTimeout(…, 50)`，真正的 `click()` 在 setTimeout 回调体内。`voiceAutoSendRef` 的置/清必须写进 **setTimeout 回调体内**、紧贴 click：
  ```js
  setTimeout(() => {
    const sendBtn = document.querySelector("[data-send-btn]") as HTMLButtonElement | null;
    voiceAutoSendRef.current = true;
    try { sendBtn?.click(); } finally { voiceAutoSendRef.current = false; }
  }, 50);
  ```
  `click()→onClick→sendCommand` 首段同步跑完，标记同步清（disabled 空点也不残留）。**禁止**把置/清写在 `onend` 函数体或 `setMessage` updater 里——标记会在 click 前 50ms 就被清掉，B3 分流失效。`[data-send-btn]` 与点击机制**不动**（保留 disabled 免费闸）。
- **B2 挂点**：`sendCommand` 首行守卫**之后**：`if (!voice && !voiceAutoSendRef.current) fireTransmit()`。守卫在前＝空输入回车天然不响；loading 时 input/按钮双 disabled＝事件进不来（物理负对照）；`voice` 参数在＝陈/Emily 语音回合不响；标记在＝马克斯语音不响。四格全封。
- 动画：发报键重击＋纸带打出一串长划（~600ms 一次性，非循环，事件驱动＝铁律 1）。
- **判据**：
  - 正：打字＋Enter → transmit fire（计数器 +1）＋消息落下；点「发送」同。
  - 反：空 Enter → 0；假 SpeechRecognition 自动发送 → 消息落下但 transmit 0（隐喻不串第二半——此断言就是 B3 的验收）；陈频道假麦语音回合 → transmit 0；loading 中 Enter → input disabled 无事件、transmit 0。
  - 绊索自证：「语音发送 transmit=0」断言先对**只做了 B2 未做 B3 标记**的中间态跑一遍必须 FAIL（证明分流断言真的在咬人）——实施顺序即 B2 先行本地验 FAIL、再补 B3 让它转绿，一并入本步 commit（中间态不落 commit，不违一步一 commit——审核 §六 认可）。**★可执行前提（审核补）**：那次 FAIL 必须在假 SpeechRecognition 吐出**非空 final** 的前提下跑——`clean.trim()` 为空时 `onend` 根本不点发送键，断言会因「压根没发送」假绿。
- 步 5 过审后刀 B 手测（§8）。

## 7c. 步 6 · 输入排图标年代化（用户 08-15 刀 B 手测后点单）

用户原话要点：🎤/🔇 两颗按钮太现代、麦克大白色难看，换「无线电那种」。
成因＝emoji 是系统字形不吃 HUD 色板——与砍 📻 同一病（D3 先例）。**只动这两颗**，
编队/发送/宣战/电报机/呼叫行零字节。

- **PTT 键**：手搓年代感电台手持话筒 SVG（圆头＋格栅横条＋短柄，RadioCallRow 同族
  线条），`currentColor` 吃色板：idle＝cyan 勾线；listening＝翻红（替掉 🔴 emoji，
  背景红保留）＋细呼吸环；cancel-armed 仍 ✕。**状态机零改动，只换皮**（铁律 1
  的真状态源全部原样）。
- **TTS 键**：手搓号角喇叭 SVG（锥口朝右）：开＝cyan；关＝调暗＋斜杠（替掉 🔊/🔇）。
- **★判据迁移（必须点名，不许静默）**：旧断言认按钮**文本**（`btnText.includes("🎤")`
  等，assert-step2/step3 两套）——换 SVG 后按钮无文本，断言锚迁到新 data 属性
  `data-ptt-state="idle|listening|cancel"`／`data-tts-state="on|off"`（属性由同一状态
  派生，与皮无关）；受影响套件全数重跑＋步 4/5 回归，绊索照家法先证新锚会咬
  （手工把 data-ptt-state 钉死成 idle 跑一遍必红之类，实施窗自选形状）。
- 判据：两态截图（idle/listening/cancel、TTS 开/关）＋data 锚 DOM 断言；
  负对照＝编队/发送/宣战按钮与电报机 rect/内容零 diff。

## 8. 手测收口清单（真麦＋真 Web Speech，chrome 非 headless）

刀 A（本刀自身验收——收尾路径重接后的重验，非销旧账）：
1. 陈频道按住说完整命令 → 红灯＋呼叫行 → 松手 → 行消失、`🎤 …` 落下、命令执行；
2. 说一半滑出按钮 → 按钮 ✕ 红闪＋行变「松手取消」→ 松手 → 什么都没发；
3. 按住中途 Esc → 同 2，且地图选区不受影响；
4. 弹窗态重复 1-2（从主页面点「弹出面板」进，直连 `?mode=panel` 自关）。

刀 B：
5. 马克斯频道说话 → 文字实时入框（电报机**不响**）→ 松手 → 自动发送（transmit 不响）；
6. 马克斯说一半滑开 → 框内回滚到按下前原文；
7. 打字 → 键头逐字敲、纸带出点划；Enter → 重击长划、消息发出；空 Enter 无动静；
8. ~~复验刀 A 手测第 3 项（Esc 取消后地图选区不受影响）~~ **已销（用户 08-15 刀 B
   手测亲验：走过、选区还在——简报挂账 3 划掉）**。

## 9. 铁律对照（审核用）

| 铁律 | 落点 |
|---|---|
| 1 真状态驱动 | A1 挂 `pttStatus==="listening"`（红灯同源）；B1 挂 onChange 真变；B2 挂真发送（守卫后）；唯一循环动画（载波）的**存在**由状态控 |
| 2 素材零外部 | 全部手搓 SVG＋`game-ui.css` keyframes，色只用 `--hud-*` 变量 |
| 3 隐喻分区 | 电台（cyan）进对话流、电报（amber）钉在输入旁；两向互不触发各有断言（§6 反、§7 反） |
| 4 纯 web 层 | 改动面＝ChatPanel 挂点＋2 新组件文件＋game-ui.css；引擎/prompt/信封/messageStore 零字节；ChatPanel 不重构（新逻辑进新文件，ChatPanel 只加挂点） |
| 5 commit 纪律 | 刀内一步一 commit，刀 A 全收才开刀 B，两刀不混 |
| 6 两臂亲核 | §0 病灶表＋§5.3 两臂 cancel 设计（`arm.cancel()` 半成品复用、Web Speech abort＋快照回滚） |
| 7 判据家法 | 每步正反双断言、负对照先行（基线取数）、绊索自证 FAIL-first、锚点全 grep、隐藏条件块源码点名；幅度对齐＝滑出阈值 12px 真手指尺度、真麦手测收口 |

## 10. 明确不做（交接档 §3 照抄，实施窗勿越）

声音效果（滴答/底噪）；停靠态风格条死账（getState 引用不稳，LEDGER §M 在案，修了会凭空多东西）；数字跟色（**已裁「不跟」划账**，§2）；引擎侧语音/发送逻辑（取消只动 web 层两臂收尾）。

## 11. 已知风险与决断点（Opus 审核重点看这里）

1. **pointercancel 改为取消**（§5.1）——有意手感变更，理由＝与病同源；若审核不同意，退路＝保持 stopPTT 但加 cancelIntent 判定。**★无论审核结论如何，此条必须出现在开工前给用户的三行人话概要里**（家法：影响手感的变更先人话确认，审核裁决不豁免）。
2. **pointer capture 与 pointerleave 的浏览器差异**——capture 期 boundary 事件仍会 fire，本设计不依赖 leave（只删它的 stopPTT），hit-test 全走 move；chrome-only 项目，风险低。
3. **假 SpeechRecognition 注入**（§5.4/§6/§7）——新工装，一次写好三步复用；退路**不许降级为源码点名**（审核否决原退路：「语音发送 transmit=0」是 B3 唯一功能验收，降级＝本刀无验收）：注入失败改用真 Chrome 非 headless（`channel:"chrome", headless:false`）跑同一脚本，仍拿机器判据。
4. **`setPointerCapture` 在 disabled 边界**：loading 中 startPTT 首行 return，capture 不会挂；按下瞬间 loading 翻转的窗口极窄，pointerup 的 cancelIntent 分支兜底。
5. **喇叭键与 PTT 同 class/同 const**（§3）——拆分时最小化 diff，截图核喇叭键没跟着长个。

## 12. 刀 A 收口审核记录（Fable 裁，2026-08-15）

简报＝`UI_ANIMATION_ROUND2_KNIFE_A_REVIEW_20260815.md`。四 commit `78866e6→9c67128→8ccf5ab→a38ec7d`，五 P0 落点实码抽查全对位，32 断言绿。偏差裁定：

- **D5（Esc 负对照改同构建按住/没按住对照）＝等价且更强，追认**。裁定依据（亲读
  `assert-step3-record.mjs`）：焦点打离＋activeElement 断言在两臂共用的设置段（恒真
  成因先封死）；3a/3b 之间无任何再聚焦动作（pointerdown 有 preventDefault）；未挂
  监听＝没按住，变量唯一；且同构建排除了中间态版本「diff 里别的改动致红」的混杂。
  plan §5.4(b) 原文的「中间态构建」自本裁定起以此替代法为准。可选加固（非必须）：
  3b 按 Esc 前再断言一次 activeElement。
- **D4/D6/D7/D8 全部追认**：minHeight（plan 自己的 ≥44 判据所需）；cancelPTT 尾部
  两臂皆空收灯（按下与 arm 赋值间的窄窗，fail-safe 方向正确）；onend 正常路径清快照
  （防跨回合残值，亲核 grep `正常收尾也把快照清掉`）；发包计数从按下前起算（见下）。
- **方法资产两条**（收口时进档）：①合成 PointerEvent 碰不到 capture 路
  （pointerId 非活动指针 ⇒ setPointerCapture 抛 NotFoundError），凡涉真实指针语义
  一律 `page.mouse`；②负对照**起算点要对齐病的发生时刻**（原「松手后计数」对
  「滑出即发」的病恒真）——「判据要测效果不测措辞」的时间轴版本。
- 挂账过账：简报挂账 1/2 已在案；挂账 3（手测未逐项）→ §8 第 8 条复验后销；
  挂账 4（cancelIntent 步 2 不可达）步 3 已自然销。
- **放行刀 B**。

—— plan 完。**开工前置全清（用户 2026-08-15 三件全拍板）**：
①pointercancel/切窗改「取消不发送」＋滑开取消——**生效照做**（§5.1/§11.1）；
②滑出阈值按钮外扩 12px——**生效**（首版值，步 3 截图后用户可再调）；
③年代感参考图——**没有**，按现有 HUD 色板手搓首版，靠每步截图迭代。
步 0 数字跟色已裁「不跟」划账。实施窗可直接从步 1 开工。
