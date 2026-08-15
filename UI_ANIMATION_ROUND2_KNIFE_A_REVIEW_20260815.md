# 动画R2 · 刀 A 审核简报（给 Fable 审核窗，Opus 实施窗出稿 2026-08-15）

> 权威需求＝`UI_ANIMATION_ROUND2_HANDOFF_20260815.md`；施工图＝
> `UI_ANIMATION_ROUND2_PLAN_20260815.md`（定稿，已过两轮 Opus 审）。
> 本档只报**刀 A（步 1-3）实施结果与偏差**，供审核判是否放行刀 B。

## 0. 现场

| 项 | 值 |
|---|---|
| 基线 | main `1de78eb`（含 tag `ui-simplify-v1-done`），worktree `AI Commander-voice-input` |
| 分支 | `ui-anim-round2`（从 main 切） |
| commit | `78866e6` 步1 → `9c67128` 步2 → `8ccf5ab` 步2b → `a38ec7d` 步3 |
| 验收 | 每步 typecheck 干净＋台架 `bash scripts/run-benches.sh` 25/25＋新断言＋绊索自证 FAIL-first |
| 手测 | **用户 2026-08-15 判过**：原话「应该可以过，非常完美」。★未逐项报现象——本档不把它写成"四项逐项 PASS"，只记"用户判过"（家法：不许把含糊裁定充成精确结论） |
| 改动面 | `apps/web/src/ChatPanel.tsx`（挂点＋PTT 机器）、`apps/web/src/RadioCallRow.tsx`（新）、`apps/web/src/styles/game-ui.css`。引擎/prompt/信封/messageStore **零字节** |

## 1. 三步做了什么

- **步 1 · PTT 键加大**：嵌入态加 `pttBigStyle` 覆盖层（不动被喇叭键复用的
  `pttBtnStyle`）；弹窗态 PTT 换 class `--ptt-main`，CSS 拆「共享外观（原值原样）」
  ＋「PTT 独有尺寸」。PTT 32×37→50×48（嵌入）、37×35→47×44（弹窗）。
- **步 2 · 无线电呼叫行**：新文件 `RadioCallRow.tsx`（天线塔＋三层载波弧 stagger
  脉动＋莫尔斯纸带行进），挂 `pttStatus === "listening"`＝与 🔴 红灯同源。
  ChatPanel 只加 import＋一个条件渲染＋一个滚底 useEffect。
- **步 2b**：砍文案里的 📻（用户裁定）。
- **步 3 · 滑开取消＋Esc**：删两处 `onPointerLeave → stopPTT`（病本体），
  新增 `cancelPTT()` 两臂一函数、pointer capture＋12px 外扩 hit-test、
  Esc/blur 临时监听、Web Speech 臂快照回滚。

## 2. 五个 P0 落点（审核可逐条 grep 核）

| P0 | 落点 | 核法 |
|---|---|---|
| ①cancelPTT 真首行闸 | `const cancelPTT = useCallback(() => { if (!pttPressedRef.current) return;` | 首行，无公共头在它之前 |
| ②pointerup／pointercancel 各自的闸 | `onPttPointerUp` / `onPttPointerCancel` 各自 `if (!pttPressedRef.current) return;` | 两处独立，未并进 cancelPTT 那道 |
| ③Web Speech onend 封口 | `rec.onend` **头部** `if (pttCancelledRef.current) {…return;}` | 在 `setMessage(prev=>…)` 自动发送段之前 |
| ④置位在各臂早退之后 | 录音臂 `pressWantedRef.current = true;` 后一行；Web Speech `if (!SpeechRecCtor) return;` 后一行 | 两处 `setPressed(true)` |
| ⑤Esc capture 相 | `document.addEventListener("keydown", onKey, true)` ＋ `stopImmediatePropagation()` | 已核 `input.ts:335` 是 window 冒泡相，无 capture 参数 |

`onLostPointerCapture` 兜底行**保留**（异常丢 capture 时的隐私逃生口），空转靠 ① 挡。

## 3. 新证据（本刀实测，非推理）

1. **lostpointercapture 每次正常松手都补发**——真鼠标实测序列
   `pointerdown → gotpointercapture → pointerup → lostpointercapture`
   （`probe-capture-order2.mjs`）。P0-① 从"论证"升级为"证据"：无闸则马克斯
   每一次正常语音发送都会被自己的兜底网静默取消。
2. **★工装教训：合成事件碰不到 capture 路**。`dispatchEvent` 造的 PointerEvent
   其 pointerId 不是活动指针 ⇒ `setPointerCapture` 抛 NotFoundError ⇒
   capture／lostpointercapture 整条承重路根本不执行（`probe-capture-order.mjs`
   实测：全程只有 pointerdown/move/up，无 got/lost）。**步 3 全部断言改真鼠标
   `page.mouse`**；步 4/5 凡涉及 capture 或真实指针语义的必须沿用。
3. **React 认 `onLostPointerCapture`**（不被当成 capture 相后缀吞掉）——实测
   按钮 `__reactProps$` 上确有该 prop。

## 4. 与 plan 的偏差（审核重点，逐条已知）

| # | 偏差 | 理由 | 状态 |
|---|---|---|---|
| D1 | 步 1 负对照：嵌入态喇叭/编队/发送**高度**随行高 37→48 co-move，未做到 plan §3 的"rect 与基线一致" | `inputContainerStyle` 是 `display:flex` 无 `alignItems`＝默认 stretch，既有属性；治它要加 `alignItems:center`，代价是三键反而缩到自然高度、动静更大 | **用户已裁：接受不治**。断言里明写成 co-move，不把负对照偷改成只测宽 |
| D2 | 步 1 多加 `data-ptt-btn` 测试锚（plan 未写） | PTT 的 title 随 status 四变，不是稳定把手；步 2/3 的 hit-test 也要抓它 | 用户已认可，同 plan 里 `data-radio-call` 一类 |
| D3 | 步 2b 砍 📻（plan §4 文案写的是「📻 电台呼叫中…」） | 天线塔已手搓，emoji 重复且是整行唯一不吃 cyan 色板的东西 | **用户裁定砍**，断言锚「电台呼叫中」不受影响 |
| D4 | 步 1 `pttBigStyle` 加了 `minHeight`（plan 只写 `minWidth: 44`） | 判据要求 offsetHeight ≥44，只给 minWidth 达不成 | 建议追认 |
| D5 | **步 3 Esc 负对照改法**：plan §5.4(b) 要求"未挂 capture 监听的**中间态**跑一遍必红"；实施改为**同一份构建、只差按没按住 PTT**的状态对照（没按住时 Esc 确实清选区＝判据会响；按住时选区不动） | 同构建对照排除了"改了代码顺带改了别的"这一变量，且不需要造中间态；效果同样是"先证明判据会响" | **请审核裁定是否等价**。若判不等价，我补跑注释掉监听的中间态版本 |
| D6 | 步 3 `cancelPTT` 末尾多一条兜底：两臂都没挂上时也把灯收回 idle（plan 未列） | 覆盖"按下与 arm 赋值之间"的极窄同步窗口 | 建议追认 |
| D7 | 步 3 `onend` **正常**路径也清 `messageSnapshotRef`（plan 只写取消路径清） | 否则快照残值跨回合留着 | 建议追认 |
| D8 | 判据加强：发包计数从**按下之前**起算覆盖整段 | 见 §5 | 建议追认 |

## 5. 绊索自证抓出的判据自身缺陷（已改，值得记进方法资产）

步 3 断言原本从"松手前"起算发包计数。对基线跑时它是**绿的**——因为基线的病是
**滑出按钮那一刻**（`onPointerLeave → stopPTT`）就把包发了，松手后自然零新增。
即：本刀最要紧的一条正断言，原设计恒真、测了等于没测。改成从按下之前起算覆盖
整段后，基线才红（录音臂 10 红／Web Speech 4 红）。

Web Speech 基线那一格尤其能说明病相：输入框被清成 `""`（半句错令已发走），
修好后是逐字回滚成 `"A线"`。

**教训形状**：负对照的"起算点"也要对齐病的**发生时刻**，不能只对齐操作的结束时刻。
与 LEDGER 既有「判据要测效果不测措辞」同族，是它的时间轴版本。

## 6. 断言清单（32 条全绿）

- `assert-step1.mjs` 18 条（PTT ≥44 两态两向＋三键盒模型零 diff＋高度口径分两态写）
- `assert-step2.mjs` 11 条（前置闸硬核录音臂身份→反① idle 无行→正 出行/🔴/文案/
  松手消失[带"先出现过"前提防恒真]/占位轮询→反② `?novoicewarm`＋down/up 同 tick 无灯无行）
- `assert-step3-record.mjs` 23 条（滑出→翻红→滑回反悔→整段零发包／无占位；
  正对照照常发包；Esc 3a 中间态先红→3b 取消且选区不动；Esc 后松手仍零发包）
- `assert-step3-webspeech.mjs` 9 条（假 SpeechRecognition：abort 非 stop、
  逐字回滚非清空、整段零发包；正对照自动发送照旧）
- 弹窗态取消态在 `shoot-step3.mjs` 里硬判（不靠肉眼）

脚本目录：`/private/tmp/claude-501/-Users-yuqiaohuang-MyProjects-AI-Commander/afc3dce5-7e21-4c5d-959d-9ddb2fd36aa5/scratchpad/`

## 7. 挂账（收口时进 LEDGER）

1. **嵌入态输入行高 37→48 co-move**（stretch 既有属性）——用户裁定接受不治，留档备查。
2. **12px 滑出阈值**＝首版值，用户手测未提异议；如后续真手指嫌灵敏/迟钝，改
   `PTT_CANCEL_SLOP` 一个常量即可。
3. **手测未逐项报现象**——用户整体判过，四项逐项结果无记录。若刀 B 手测时顺手
   复验第 3 项（Esc 与地图选区），可把这笔销掉。
4. 步 2 的 `cancelIntent` 分支在步 2 时不可达，当时只源码点名未做 DOM 断言；
   步 3 已补上真断言，该笔自然销账。

## 8. 剩余工作

- **步 4（B1）**：电报机仪器＋打字敲键（`TelegraphKey.tsx`，onChange 驱动）。
- **步 5（B2/B3）**：发报动画＋来源分流；★B3 标记必须钉进 `rec.onend` 内层
  `setTimeout` 回调体、紧贴 `click()`（plan §7 有样例），写在外层 updater 里会
  提前 50ms 被清掉、分流失效。
- **收口**：更新主仓库 `ROADMAP.md` 收口段＋LEDGER 新账、tag `ui-anim-round2-done`、
  用户点头后合 main。

## 9. 请审核明确回答

1. **D5（Esc 负对照改法）算不算等价**？不等价我补跑中间态版本。
2. D4/D6/D7/D8 四条小偏差是否追认。
3. 刀 A 是否放行开刀 B。

—— Opus 实施窗，2026-08-15。
