# 主动台词接线刀 · 勘察档 v3（2026-08-16）

> 缘起：内测账第 3 笔（陈主动提问无声）。版本史：v1＝外部审计（属实判定）；
> v2＝Fable 五路复核编队（49 万 token，审计确认＋12 风险图）；
> **v3＝Opus 窗九路对审（100 万 token）反杀修订，Fable 亲验决定性声明后并档**。
> 谁修谁的档：v3 由 Fable（原作者）执笔，改判出处均标注。开刀 plan 以本版为准。

## 一、审计与复核的最终对账（三轮互审后的定论）

**核心结构声明不动摇（三轮全确认）**：`./tts` 唯一 importer＝ChatPanel；`speak(`
4 处＋`flush(` 2 处全在玩家动作闭包；消息侧（addMessage/messageStore）零接线；
无第二条读台词的音频路；过期全静默；「发声」在旧档一贯＝文字落流（真喇叭词＝「出声」）。
**玩家撞到的病（陈主动提问无声）三轮均属实。**

**逐条改判（v3 定稿）**：
- ~~C1 危机卡点击无声~~ → **空账，删**。thread 危机卡整链是死代码（Fable 亲验闭环）：
  `PendingStaffAsk` 全仓只有 interface＋null 初始化，从无构造；`tryStartStaffAsk`
  唯一调用点在 `if (!pending) continue;` 之后（锚 `staffAskState.pendingByChannel[ch]`
  只有置 null 的写点）→ `createThread`@1744 不可达 → `activeThreads` 恒空 → 卡
  渲染不出来。**接线刀不许去"修"这条死路**；staff-ask 简报行（:1741 event_report）
  同链同死。
- C2 反转回审计原判（半对）：响应卡 A/B/C 点击（:2676，speakReceipt 默认 true）
  **那一刻确实不发消息就出声**；v2 用「speak 前必先 addMessage」否证是偷换概念，
  且该前提对 spoken 路不成立（喇叭念 `data.spoken`、屏上写 `data.brief`——念的字
  未必是屏上的字）。准确边界＝本局早前发过至少一次命令，但出声瞬间不需要发消息。
- C4 修正：无持久化属实；「面板收放即重置」不对——窗内 ◀/▶ 只是 `display:none`
  不卸载，**弹出/收回/刷新才重置**。总闸结论（默认关）不受影响。
- flush 两处（:1623/:2045）计入发声点清单；无句末标点短句 flush 常是唯一出声者。

## 二、勾稽风险图 v3（原 12 条修三改，另加五条新 HIGH）

### 原 HIGH（改判处标 ★v3）

| # | 风险 | 机制 | 躲法 |
|---|---|---|---|
| T1 | persona 互斥抢占 | 单全局队列，换人即 cancel 整代——主动台词与在播应答互相绞杀 | 应答进行中主动台词暂存，回合收尾按人释放 |
| T2 ★v3 机制改写 | sticky streamEngine **同人连说**泄漏 | streamEngine 是模块级单变量；**换 persona 时 speak 自触发 cancel→resetStreamState＝解毒**，毒只在同一 persona 连续两段、中间无 cancel 时存活（一次 503/autoplay 拒后第二段钉 native/silent）。**台架陷阱：用"换个人说一句"验毒＝恒绿假阴**，真复现＝同人连发两段 | 每段主动播报前走 cancel 协议不变；负对照必须同人连发 |
| T3 ★v3 定性改 | 探针污染＝**接线后才成立的前瞻风险**（今天主动台词进不了 TTS）；但对审挖出**真·现存 bug**：`releaseAtRef` 无时限——ttsEnabled 关/silent_echo/录音作废的回合把起点留着，被**之后任意回合的首声**（含打字回合念正文）消费掉 | 修法升级：origin 标记不够，**releaseAtRef 须绑回合或加超时**；顺手补 speechDiagRef 上报后清空（重复上报既有 bug） |
| U1 ★v3 细化 | 录音撞喇叭 | 今天录音臂实际零触发（应答期 loading 闸＋按钮 disabled 按不下去）；**Web Speech 臂今天已可触发**（按下不掐 TTS）。且 `pttPressedRef` 非充分闸：录音臂松手后 300ms TAIL_GRACE 仍在收音、Web Speech stop() 后仍交付 final | 闸口＝pttPressed ∪ 尾窗（TAIL_GRACE 期）∪ Web Speech 未 onend；Web Speech 臂漏掐单独记账 |
| U2 | ttsEnabled 跨层＋默认关 | （被新 HIGH-2 加重，见下） | 接线点放 ChatPanel；默认值改动＝用户板 1 |
| U3 ★v3 细化 | 路由缺口 | 陈的请示 source=command_ack 与回执同源（不变）；event_report 里**活的只有 llm_advice 一类**（staff-ask 已死）。治 llm_advice 必然伴随可见渲染迁移（报告行→人物气泡）＝手感变更，**须先给用户三行人话** | 发射侧显式声明可配音性不变 |

### ★五条新 HIGH（v3 新增，对审发现，Fable 亲验前两条＋第三条）

1. **重开局 id 回收＝第二局整局哑**：`handleRestart→clearMessages()→nextId=1`
   （messageStore 锚 `nextId = 1;`），ChatPanel 挂载点无 key 不重挂——「已播 id
   集合」带着第一局的 1..N 进第二局，同号新台词全判已播。躲法＝集合叠 epoch，
   或在 clearMessages 处连带清集合（挂载打底救不了没有重挂的场景）。
2. **收回面板不关弹窗＝两个 ChatPanel 同时活**：`panelWin` 是局部量（App.tsx 锚
   `const panelWin = window.open(`），「收回面板」只 `setPanelDetached(false)` 从不
   close，弹窗只在 opener 死时自尽——两 realm 各一份 tts 模块，同一条主动台词
   念两遍且互相掐不掉。**v2 的「单实例保证」作废**。躲法＝声音属主仲裁（如只有
   聚焦窗/主窗发声）或收回时真 close，属产品裁定项。
3. **探针在 `audio.play()` 之前同步触发**（Fable 亲验：`playbackObserver?.()` 在
   playAudio 顶部、play() 在其下）——autoplay 拒/静音标签/音量 0 照记一声。
   **v2 刀形第 4 步「断言探针记到一声」在全静音浏览器恒绿＝判据家法第六次同形**
   （这次栽在勘察阶段）。真判据＝`timeupdate`/`ended`/`currentTime > 0`。
4. **autoplay 全链静默零痕迹**：autoplay 拒 → 降级 speechSynthesis 同样被策略封，
   且 fallback 批绕过观察者——零声零日志。比「三人同嗓」狠，常见形态是彻底无声。
5. **from 白名单而非黑名单**：`from:"system"` 能穿过「from!=="player"＋!groupChat」
   两道否决，而 `VOICE_CONFIG[persona]` 两处解引用不设防→同步 TypeError 且全仓无
   ErrorBoundary（MessageFrom 5 值、Persona 仅 3 值）。躲法＝只准
   from ∈ {chen, marcus, emily} 进 speak。

### MEDIUM（v3 修订处标注）

- T4 句子缓冲搁浅（speakUtterance＝speak+flush）不变；★splitter 旧账勘误不变
  （逗号保留；真怪癖＝ASCII 句点切小数）。
- U4 voiceSpeech「不许别处长出第三声」合同不变。
- U5 ★v3 细化：StrictMode 双跑只在 dev；**回灌在生产照发**——点当前频道键也触发
  （`[cmd]` 每次是新数组）。id 打底方案仍有效，但要盖住"同频道重点击"。
- U6 占位回填原地编辑（id 去重＋from 否决双保险）不变。
- U7 过期请示配音（id 打底＋释放前重查/新鲜度上限）不变。
- U8 群聊注释撒谎顺手修，不变。

### 台架的必付成本（v3 新增）

`scripts/ab-voice-input.ts:533-545` 用**源码字符串扫描**钉死现有接线形状（数
`"ttsEnabled && sendPlan.speakProseWhileStreaming"` 出现次数等），挂在
`run-benches.sh` 硬线里——刀一动那几行**现有台架先红**。这是必付成本要写进 plan，
红了按绊索家法改锚不改判。

## 三、刀的形状 v3

1. **发射侧语义标记**（治 U3 根；死代码路不碰；llm_advice 渲染迁移先过用户三行）。
2. **消费侧接线（ChatPanel 内）**：id＋epoch 去重（治新 HIGH-1）＋否决组改
   **白名单制**（from ∈ 三人，治新 HIGH-5）＋pttPressed∪尾窗闸（U1 v3）＋语音回合
   暂存＋speakUtterance＋每段 cancel 协议＋异 persona 仲裁。
3. **声音属主仲裁**（治新 HIGH-2 双面板双声——方案属产品裁定，plan 里给选项）。
4. **探针防污染 v3**：origin 标记＋**releaseAtRef 绑回合/超时**（真·现存 bug 一并修）
   ＋speechDiagRef 清空。
5. **台架**：活体判据一律 `currentTime>0`/`timeupdate`/`ended`（不许拿观察者响
   当出声）；T2 负对照同人连发；预算 ab-voice-input 源码扫描锚的迁移。

## 四、两个板 —— **用户已拍定（2026-08-16），照推荐执行**

1. **ttsEnabled 默认值**：推荐＝**默认仍关＋加持久化＋首局陈请长官开电台**（对话式）。
   硬理由 v3 版：主窗有「开始作战▶」教程遮罩＝用户手势（仅 `?scenario=dual_island`
   绕过），**弹窗 PanelApp 没有任何必点按钮且 window.open 不继承 opener 激活**——
   「默认开」会在弹出态踩新 HIGH-4（零声零日志）。「陈请开电台」恰好给两窗各挣一次
   真手势，还合「对话是唯一界面」家法。
2. **Edge 503/autoplay 降级形态**：推荐＝**silent＋文字**。native 三人同嗓是坐实的
   必然（三 persona nativeLang 全 zh-CN，注释在案「Apr 29 试过两次都失败」）；且
   autoplay 场景 native 同被封——"降级同嗓"经常实际是静默。主动台词恰恰最依赖
   嗓子当身份线索，丢身份的提醒不如不响，文字照旧上屏零损失。

## 五、方法学

v1 静态依赖图（审计）→ v2 五路证伪＋测绘（Fable，49 万）→ v3 九路对审（Opus，
100 万）＋Fable 亲验决定性声明（死代码闭环/双面板/重开 id/T2 解毒语义/探针先于
play）。教训入库两条：**判据恒真第六次同形**（观察者响≠出声——负对照要在全静音
环境下先红）；**死代码上不立哑账**（给玩家碰不到的路记账＝空账）。活体验收仍缺，
是开刀台架的硬要求。

—— v3 定稿，2026-08-16。开刀 plan 以本档＋内测账第 3 笔为输入。
**两板已拍（08-16）：①默认关＋持久化＋首局陈请长官开电台；②降级＝silent＋文字。
前置全清，用户说开工即出 plan。**
