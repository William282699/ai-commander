# 语音输入替换刀 V1 提案（voice-input-v1，2026-08-08，Fable 5 主审重推）

> 一句话：把「听」从浏览器 Web Speech 换成陈自己的耳朵——录音当附件夹进现有
> `/api/command{,-stream}` 请求直发 Gemini，信封 prompt 一字不动、输出保持文字、
> 全部合同零动；模型必吐一行「听到的原文」（heard），它同时是聊天框里长官气泡的
> 正文、auto-execute 闸的输入、和 I2/D4 两笔账等的语音日志。
> 账根＝LEDGER I2（中文 STT 听不懂地名）；上一窗口已裁死：端到端语音（声进声出）
> 永久否——文字是引擎与 AI 之间的合同书。本案是接法二；保守备选见 §7。
> 基线＝main `cb02c2b`（tag `envelope-precision-v1-done`）。设计期零实施，本档只裁不动。

## §1 病灶（全部亲手重推，file:line）

| # | 病灶 | 位置 | 一句话 |
|---|---|---|---|
| P1 | STT 引擎到顶 | `ChatPanel.tsx:682-740` | Web Speech API（Chrome 云端识别）：zh-CN 单语、无词表注入口、无战场上下文——I2 的结构根是识别器**根本拿不到**地图实体与信封，不是调参问题。用户判「拉完了」 |
| P2 | 请求链纯文字 | `ChatPanel.tsx:1707/1810`、`index.ts:90/122`、`providers.ts:9` | body=`{digest,message,…}`；`ChatMessage.content: string`——没有音频通道 |
| P3 | 三频道模型盘点（.env 实测） | `apps/server/.env` + `providers.ts:298-323` | 默认 profile=**gemini-2.5-flash**（OpenAI 兼容端点）管 combat 陈/logistics Emily/group 群聊；**LLM_PROFILE_OPS=deepseek** 管 ops 马克斯（纯文本）。音频只能进 Gemini 三个面；**ops 与群聊保持现状**（群聊另因 GROUP_SYSTEM_PROMPT 冻结，D2） |
| P4 | heard 会被闸剥掉 | `packages/shared/src/schema.ts:271` | `validateAdvisorResponse` 是白名单**重建**——新增根级字段不显式登记就静默丢弃；且 options:[] 早退路径（:307-321）与正常路径**两条 return 都要带** |
| P5 | body 尺寸闸 | `index.ts:34` | `express.json({limit:"100kb"})`——4.4s 16kHz WAV b64≈190KB 已超线 |
| P6 | ★ auto-execute 闸吃文本 | `ChatPanel.tsx:271`（定义）`:1531`（调用） | `canAutoExecute` 靠**正则扫 userMessage** 找锚（部队号/领队名/「选中」）。语音回合若无转录回填 → 永远 no_anchor → 高影响闸全弹确认——**砍卡法治过的病原样复发**。heard 不是装饰，是这个闸的输入 |
| P7 | send 时文本的其余消费者 | `ChatPanel.tsx:1248/1254`（合同词表 fast path）`:1279`（bareConfirm 记账）`:1343`（escalation 词表清除）`:1345`（playerIntent）`:1383`（pushContext user） | 语音回合 send 时没有文本，七处全要改在 **heard 到达时结算**（见 §2-D） |

## §2 修法（接法二主案）

**A · 客户端录音**（`ChatPanel.tsx` PTT 区）：🎤 按住不变；采 PCM → **16kHz mono WAV**
（AudioWorklet 或 decodeAudioData 重采样；**不用 MediaRecorder 的 webm/opus**——
OpenAI 兼容端点 `input_audio.format` 只文档化 wav/mp3，探针实证 wav 通）。录音上限
30s（b64≈1.28MB）。松手 → `sendCommand({audio})`。录音中显示 🔴+时长（interim 实时
转写字幕消失，是有意取舍，登记手测看点）。**capability fail-closed**：`/api/health`
扩一个 `voiceChannels` 字段（provider===gemini 的频道名单），client 启动拉一次；
不在名单的频道（ops/群聊）🎤 走 Web Speech 现状路，一个字节不改。

**B · 服务端通道**：`index.ts` `/api/command{,-stream}` body 增 `audio?:{data,format}`
（limit 100kb→4mb，校验 data 长度上限）；`ai.ts` `callAdvisor/callAdvisorStream` 增
可选 audio 参数——userContent 从 string 变 content parts `[{text:原样逐字},{input_audio}]`，
**信封/digest/persona/SYSTEM_PROMPT 文本零改动**（负对照：无 audio 时拼装逐字节同）；
`providers.ts` `ChatMessage.content` 扩为 `string | Part[]`，仅 OpenAICompatibleProvider
处理 parts，ClaudeProvider 收到 parts 即 throw（fail-closed，不静默降级）。

**C · heard 合同**（唯一新增输出字段，显式登记）：语音回合 text part 尾附固定说明
（音频=指挥官命令本体；JSON 根级必须含 `heard`=逐字转写；**prose 不复读转写**——
prose 会被 TTS 念出来）+ `withPendingReinforcement` 同族的【本次强制】钉一句
（先例：pendingDecision 45 调用零 MISSING 就是这么钉住的）。`schema.ts` 增 optional
`heard` 透传（P4 两条 return 路径）。**heard 缺席的兜底=现状无文本行为**：气泡显示
「（语音）」、闸走 no_anchor 弹确认——不猜、不编、fail-closed。

**D · heard 结算点**（`processAdvisorData` 开头，语音回合专用，七件）：
①回填长官气泡（send 时占位「🎤 …」，heard 到达替换；`messageStore` 加 `updateMessage(id)`，
跨窗口 bridge shape 同步加）②`pushContext(user, heard)`——**必须在 assistant 文本入
context 之前**，保持 user→assistant 顺序 ③`playerIntent=heard` ④**`canAutoExecute` 传
heard**（P6）⑤`isCancelReply/isDeclineReply(heard)`→clearEscalation ⑥`bareConfirmExecRef`
按 heard 补章（记账语义从 send 时挪到 heard 时，登记）⑦服务端解析出 heard 后补一行
`logEvent({type:"voice_heard", heard, sessionId})`——**这就是 I2/D4 等的真语音日志**
（I2 家法：必须基于真 STT log 禁脑内枚举——本刀开始产 log）。

## §3 有意行为差异（T1j 先例，逐条显式登记）

1. **合同词表 fast path 只对打字生效**：语音「可以」走 LLM 语义 pendingDecision 路
   （fail-closed 路由表已在，preflight 45 调用负例闸验证过）——批准从秒回变约 2s。
2. heard 回填让长官气泡内容**以陈听到的为准**（≈2s 后替换占位）——听错当场可见，
   这是 feature 不是 bug（D4/F2 对账靠它）。
3. bareConfirm 记账时点从 send 挪到 heard 到达。
4. 录音期间无实时字幕（换 🔴+时长指示）。
5. 新输出字段 `heard`（root，optional，仅语音回合强制）。

## §4 验收（判据全部效果级，含负对照）

**延迟（铁律 5，超线退 §7 保守案）**：探针已实测（§8）——文字臂 TTFT 中位 619ms，
音频臂 **1713ms**（+1.1s）；但现状 Web Speech 松手后 final transcript 还要 0.5-1.5s
才开始发请求，端到端预计打平。实机判据：**松手→陈第一个字，10 句中位 ≤2.0s、
p90 ≤3.0s**；命令链打字路径逐字节不变（秒回不受影响）。

**听错清单 A/B**（本刀的存在理由）：固定 10 句实机语音（须含：战狼点/南线前哨/
烽火台/驼峰山脊/中央前哨/El Alamein/阿拉曼/编队名 Aiden/番号 G#/一句纯确认「可以」），
同一人同一麦各念两遍：A 臂=现状 Web Speech 转写、B 臂=Gemini heard。**判据数地名与
番号命中率，不数总字错**（判据要测效果家法）；会动兵的句子**必须 resolveIntent 数
assignedUnitIds+核落点**，heard 对但派错兵不算过。

**heard 合规**：--live N=20 语音回合，heard 在场 ≥19/20；heard 不得出现在 prose
（TTS 污染检查，正则查流式文本里的转写复读）；带 pending contract 的语音「可以」→
pendingDecision=authorize 且执行的是钉死的那批（对象同一性现闸不动，顺带验证）。

**归一化风险看点**（探针 A2 实证的新面）：模型可能把没听清的音**就地归一成信封里的
战场词**（A2：TTS 念糊的「El Alamein」被听成「北部沿海」——在信封里的名字！）。
G 刀合同③「地名主权」管的是账本查无、管不到「听」这一层。判据：听错清单里故意含
一句念糊的地名，heard 须如实转写不确定内容或反问，**不许静默换成战场地名**；
n 小不设硬线，立观察账进 LEDGER（D 族），真 log 攒够再裁。

**台架硬线（全绿才许合）**：`ab-approval-v4 --synthetic` 195/0 + `--negctl` 48 条
红集合逐条同；`ab-g-knife --emily-guard/--sites` 绿（voice 指令面若被 --sites 咬到，
按规矩登记新面不许放宽断言）；13 台架全绿；**新增 `ab-voice-input.ts`**：
--synthetic=①无 audio 时 userContent/信封拼装逐字节同②schema heard 两条路径透传
③heard 缺席兜底断言；--live=heard 合规+地名命中（探针脚本与 wav 移植入库，
fixtures 不可再生家法）。**摘刀负对照**：关掉结算点④ → 语音高影响命令必须弹确认
（证明 heard→canAutoExecute 接线真承重）。

## §5 连带面（如实列全）

- `SPEECH_RULE_SITES` 22 面登记表：voice 指令面（text part 说明+【本次强制】）按
  规则语义登记；--sites C 断言（实测集合==登记集合）会咬，先登记后施工。
- `messageStore` 加 `updateMessage` + 跨窗口 `MessageStoreShape` 同步（:57）。
- ops/群聊/`/api/brief`/staff-ask 零改动；TTS 输出侧（`tts/*`）零改动。
- B3 换号、F2 上下文劫持**不在本刀**；但 heard 日志开始给 F2/D4/I2 喂对账数据
  （嘴里复述的 vs 票据实派的，第一次有了逐字记录）。
- 费用：音频约 32 token/s，4s≈130 token，免费档无感；免费档 RPM 限制不变。
- 安全面：limit 提到 4mb 只影响 /api（线上有 PLAYTEST gate）；服务端校验 audio 长度。

## §6 施工顺序（Opus 5 实施，新 worktree，一步一测一 commit）

1. **服务端通道**：providers parts + ai.ts audio 参数 + index.ts body/limit。
   负对照：无 audio 逐字节同；探针脚本改指本地端点手测往返。
2. **heard 合同**：schema 透传 + text part 说明 + 【本次强制】 + voice_heard 日志行。
3. **客户端录音**：WAV 采集 + capability 探测 + 占位气泡 + 发送。
4. **结算点七件**：canAutoExecute 传 heard 等 + messageStore.updateMessage。
5. **台架**：ab-voice-input 两模式 + 全家硬线跑绿。
6. **手测**：延迟 10 句 + 听错清单 A/B + 语音「可以」批准链 + 第 8 级四幕用语音重走。

## §7 保守备选案（延迟超线才启用）

Gemini 纯转写员：新端点 `/api/transcribe`（audio→text，转写 prompt 注入**地图实体
名清单**——来自 state 的数据驱动白名单，非同义词表，红线二不违），出文字后走
**完全现状**命令链。优点：ChatPanel send 路径零改动、fast path 全保留；代价：两跳
（转写 ~1.4s + 命令 ~1.0s），且「听」的时候信封不在场，消歧红利减半。主案的 §2-A/B
（录音+parts 通道）两案通用，先施工不白做。

## §8 探针数据（2026-08-08 实测，档在 `~/MyProjects/_archive/voice-input-probe-20260808/`）

镜像 providers.ts 请求形状（同端点/gemini-2.5-flash/reasoning_effort=none/stream），
say -v Flo(zh_CN) 生成 4.4s 16kHz WAV（b64 188KB），~5KB 合成信封，交替跑：

| 臂 | TTFT | 备注 |
|---|---|---|
| 文字 ×3 | 687/619/546ms（中位 619） | 现状等价 |
| 音频 ×3 | 1356/1968/1713ms（中位 1713） | **input_audio 在该端点可用**；转写「战狼点附近的闲置部队，去增援南线前哨」**3/3 逐字全对**（含两个地名，正是手测四幕原句） |
| 音频 A2 ×1 | 1539ms | 「派两个步兵班去 El Alamein，剩下的守住烽火台」→ heard「二营的部队去北部沿海，剩下的守住烽火台」：TTS 念糊段被**归一成信封内地名**（§4 看点的实证）；「烽火台」逐字对 |

---

# §V 修订（Opus 审后，Fable 复核裁定 2026-08-08；与正文冲突以本节为准）

> 审核档 `VOICE_INPUT_V1_OPUS_REVIEW_20260808.md`。三个 P0 全部亲手复算成立；
> 正文两处断言撤回（P6 方向、--sites 职责）；P1 十一条全收、P2 五条全收；
> P1-8 已当场补测（V-3）。四问答复在 V-4。**待用户拍板两件：V-1 的 P1-6 (a)/(b)、
> V-4 Q4 的降级出口日程线。**

## V-0 三个 P0 成立（逐条复算，file:line 与审核档一致）

**P0-1 承认，正文 P6 与 §2-C 兜底两处撤回。** 复算：`canAutoExecute` :334-338 的
high_impact 只读 intent 字段；文本为空时 :368 `anchor_mismatch(playerNamedSquad=false)`
/ :371 `no_anchor`，而 :1576-1581 这两个 reason 都是 bucket A 入场券→直接
`handleApprove` 自动执行。**真实行为=静默照发不是弹卡；真承重格=bucket B**
（点名不符→问一句），heard 不接线它就退化成静默派错兵。结论侥幸存活（heard 必须
接线），论证错了、风险被低估——判 P0 完全成立。
**修法（开工前提，进 §3 登记表第 6 条）**：语音回合且 heard 缺席 ⇒ **禁入 bucket A**，
落 bucket B 问一句「没听清，您刚才说的是？」。这一条同时封死第三层：
`createFallbackResponse()`（schema.ts:426-455）带可执行 intent 且 `data.warning`
客户端从不读，但 fallback 经白名单重建后 heard 必为 undefined ⇒ 语音回合的 fallback
被同一条判定拦住，不需要单独分支。**N1 立案入 LEDGER**（打字路径 main 今天就成立，
非本刀引入、不在本刀修）。

**P0-2 承认，正文 §4 摘刀负对照作废**（high_impact 不读文本，两臂同结果=同义反复）。
换成审核档给的**点名不符格**：语音说 A、模型返 B——接线在 ⇒ `playerNamedSquad=true`
⇒ bucket B 问一句；摘刀 ⇒ bucket A 静默派 B。判据数 `assignedUnitIds` 核实际动谁；
配正对照：点名相符 ⇒ `auto:true` 不弹卡（证明闸没被拧死）。**采纳搬家方案**：
`canAutoExecute`+`isValidTarget`+`detectStaleSquadRefs` 搬家不复制到
`apps/web/src/autoExecuteGate.ts`（纯函数），台架才够得到；搬家 commit 零行为变化，
13 台架+typecheck 当负对照；`runKnifeB1` 的 nth 计数已核不受影响，搬后重跑 --synthetic。

**P0-3 承认，正文 §5 漏了这一面。** `CONFIRM_WORD_SITES`（ab-approval-v4.ts:1186-1195）
按文件内 nth 钉死 4 个调用点，D⑤/D⑥ 新增即 TB1 FAIL。修法照审核档：同 commit 登记
新面——D⑤ `isCancelReply/isDeclineReply(heard)`=`context-only`、D⑥ `isConfirmReply(heard)`
=`telemetry`；:1279 那处若是**移动**则同步改 note 不加行；`isDeclineReply` 在表外
扫不到，**主动登记**。不许放宽断言。

## V-1 P1 十一条全收（增量注明）

| # | 裁定 |
|---|---|
| P1-1 | 收。延迟判据改**对照式**：同 10 句先量现状基线（松手→陈第一个字），裁决线=**中位劣化 ≤ +0.7s**，绝对毫秒数只作参考（两轮探针绝对值漂 ±0.3s、差值稳定 +1.0~1.1s）；在 demo 实际部署拓扑上量 |
| P1-2 | 收。`voiceChannels` = 显式白名单 `["combat","logistics"]` **∩** `provider==="gemini"`，双条件缺一不可 |
| P1-3 | 收。fail-closed 挂能力不挂类：服务端收到 audio 时校验 `getProviderConfig(channel).provider==="gemini"`，否则 400（deepseek 与 gemini 共用 OpenAICompatibleProvider，只 throw ClaudeProvider 挡不住 ops——正文写法作废） |
| P1-4 | 收。`audio`/`message` 互斥判定：至少一个在场，两个都缺仍 400 |
| P1-5 | 收。`getUserMedia({audio:{echoCancellation,noiseSuppression,autoGainControl}})` + 按下 🎤 即 `cancel()` TTS（防陈的声音录进长官命令） |
| P1-6 | 承认正文「≈2s 后替换」写错（把 TTFT 与整条回复完成时点混为一谈）；真实时点=**陈把话说完之后**。裁定：推荐 **(a)** 说完后回填（0 成本），**(b)** 流首 heard SSE 事件（~40 分钟+一个新解析态+一条 fail-closed）登记为 demo 后升级项——**交用户拍板** |
| P1-7 | 收。heard 缺席时 user 侧补一行占位「（语音·未转写）」进 context，防 F2 吃到单边对话 |
| P1-8 | 收且**已补测**（V-3）：组合机械可用；顺手拿到消歧红利的消融证据 |
| P1-9 | 收。音频说明进 Emily prompt=共享面有意变更，进 `REGISTERED_SHARED_SURFACE_RULINGS`（emily-guard 扫不到 userContent，正因如此更要主动登记） |
| P1-10 | 收。正文「--sites C 断言会咬」职责写反（C 只查已登记面、B 靠指纹而新面无指纹）——撤回；照刀2 先例：主动登记新面+同 commit 补指纹 |
| P1-11 | 收。16kHz 重采样从"路径"升为**承重项**（30s@48k b64=3.84MB 贴死 4mb 上限） |

## V-2 P2 五条全收

P2-1 施工步 3 前花 10 分钟真机测 webm/opus，通了改用 MediaRecorder 省掉重采样层；
P2-2 limit 挂两条命令路由不动全局；P2-3 用 `updateLastPlayerMessage(channel,text)`
省掉 addMessage 签名与跨窗口桥变更；P2-4 `playerIntent=heard` 照接但**禁写断言**
（combat/logistics 不读它，断言会是同义反复牙）；P2-5 保守案启用时归一化观察账跟着走。

## V-3 P1-8 补测（Fable 2026-08-08，档在 `_archive/voice-input-probe-20260808/nonstream-results.txt`）

非流 + `response_format:{type:"json_object"}` + input_audio，cmd1.wav 同一文件，各 2 跑：

| 臂 | heard | 判 |
|---|---|---|
| 无信封 | 「**占领附件**的闲置部队, 是**东原**南线前哨」×2 | 塌方：两个地名全错 |
| 带信封（同款 ~5KB） | 「**战狼点**附近在闲置部队,去增援**南线前哨**」 | 地名 2/2 全对；虚词小滑（的→在），n=2 记观察 |

结论：①兜底路（流失败→/api/command）机械可用，JSON+heard 都在；②**同一段音频，
信封的有无翻转地名对错——"耳朵带着信封听"的消歧红利第一次被消融实验直接证到**
（这也反向支持保守案条款：纯转写器没有信封，红利减半是实的）；③jsonMode 臂虚词
精度疑似低于流式臂（流式 3/3 逐字全对），听错清单覆盖，不单独立案。

## V-4 四问答复

**Q1（heard 走 JSON 尾巴）**：没注意到时序，不是权衡——承认。但流首方案的代价是真的
（heard 行绝不许进 text 事件，否则 TTS 念出来；多一个解析态+一条 fail-closed）。
裁定见 P1-6：demo 预算下推荐 (a)，(b) 登记升级项，用户拍板。

**Q2（Emily 一起换耳朵）**：有意。生产命令同样用嘴说（demo 有 Emily 戏份：$3,500
咨询→生产链），且只上陈需要在 userContent 组装里加 channel 分支——反而多一条路径。
P1-9 登记照办；§3 差异表补第 7 条「Emily 的 prompt 在语音回合多一段音频说明」。

**Q3（heard 命中词表本地直接 handleApprove）**：先更正一个前提——**批的"哪一批"从来
不在模型手里**：v4 立场=authorize 逐字执行**登记时引擎钉死的捕获案**（top 候选+unitIds
快照），`pendingDecision` 只决定"批不批"，不决定对象。所以词表 backstop 的净增益只是
模型漏判 authorize 时的救援（摩擦问题非安全问题），而代价是给最娇贵的合同消费路径加
第二个法官。裁定：**v1 不加，保持单法官**（【本次强制】已把 MISSING 钉到 45/45）；
立观察旋钮——手测语音「可以」漏批 ≥1 次即启用，启用时照 P0-3 规矩登记新面
policy=fast-path-on-heard。

**Q4（时间预算算不算保守案第二启用条件）**：算，收下这笔账。§7 启用条件补第二条：
施工进入步 4 之前若 demo 日程告急（**日程线用户定**），步 1-3 成果按 §7 转保守案上场
——两案通用件（录音+parts 通道+服务端校验）先施工不白做，正文这点维持。

## V-5 施工顺序改按审核档 §5 表

采纳全部：步 1 并入 B-a/B-b + 非流探针；步 2 并入三张登记表（SPEECH_RULE_SITES+指纹、
REGISTERED_SHARED_SURFACE_RULINGS、CONFIRM_WORD_SITES）；**新增步 2.5**（搬家
autoExecuteGate.ts 零行为变化 + ④负对照台架先 RED——回归网先行，第 7 级 `3267beb`
先例）；**步 3 必须含 heard 回填+④接线+P0-1 fail-closed 判定**——每个 commit 边界
都是安全可手测态，不许出现"装了录音没接闸"的中间 commit；步 6 手测加弹出面板一句
+ 延迟基线先量现状。

## V-6 三行人话摘要 v2（替换正文版；影响手感，开工前请拍板）

1. 听写引擎换成陈自己的耳朵：录音直达 Gemini，**地名听对率吃信封红利是量出来的**
   （同一段音频，拿掉信封两个地名全错、带信封全对）；说话时不再有实时字幕，你的
   气泡先显示 🎤，**陈说完话之后**正文才补上你刚才说的原文——若想要 ~1.4s 就补上，
   是 40 分钟加活，请在 (a)/(b) 里拍一个。
2. 语音说「可以」批准从秒回变约 2 秒（语义路，打字照旧秒回）；整体延迟验收改成与
   现状实测对照：同 10 句，**劣化超过 0.7 秒就退保守案**。
3. 陈和 Emily 换耳朵；马克斯与群聊保持旧听写。**新增一条安全行为：没听清时陈会
   反问而不是照做**——这是本刀最重要的行为变化（今天的引擎在听不清时会静默替你
   派兵，包括通讯故障时自动执行兜底方案那一格）。

---

# §W 开工基线（用户读大白话方案后通过，2026-08-09 拍板落定；连同 §V 一起构成 V1 开工合同）

1. **大白话方案已通过**，V1 范围维持 §V 修订后的形状：陈+Emily 换耳朵，ops/群聊不动。
2. **P1-6 裁定 (a)**：长官气泡在陈说完话后回填 heard；(b) 流首 heard SSE 事件登记为
   demo 后升级项，不进本刀。
3. **保守案降级出口=用户喊停制**：不设死日期；用户喊停时步 1-3 成果按 §7 转保守案
   上场（录音件+parts 通道+服务端校验全部复用）。
4. **V1.5 立项排队（V1 落地后，约半天，另立小提案）**：马克斯语音=转写中继——
   新端点 `/api/transcribe`（Gemini 带信封/实体词表转写，输出纯文字），文字走 ops 现有
   deepseek 链零改动（**脑子永远一副，耳朵可换**——文字合同铁律的应用）。群聊将来同
   路径（GROUP_SYSTEM_PROMPT 冻结不受碰）。P2-5 归一化观察账随中继带走。
   用户已确认延迟（净增约 +0.5~1.5s，咨询频道可受）与费用（免费档配额，付费档
   每句 0.1-0.2 美分）。
5. **TTS 嗓子线独立于本刀，零牵连**：画像与分配已**三人全钉死**（用户拍板 2026-08-09）
   ——陈=Alnilam（坚毅军人）、马克斯=Orus、Emily=Callirrhoe（低音克制对账，
   替换被判「篮球女主播」的 Xiaoxiao）；冠军样本+风格指令原文+标准测试句=完整采购
   规格，档在 `~/MyProjects/_archive/tts-voice-bakeoff-20260809/VOICE_PROFILE_SPEC.md`；
   上场引擎等 ElevenLabs/MiniMax key 选型（Gemini TTS 每句 5-8s 只当调音台）；
   集成排 V1 落地后、外测前。
6. 施工照审核档 §5 表 + §V-5 修正（含步 2.5 RED 先行；步 3 前先打 10 分钟 webm/opus
   探针）。手测第一件事：同 10 句量现状 Web Speech 基线（松手→陈第一个字），
   延迟判据=对照式中位劣化 ≤ +0.7s。

---

# §X R2 裁定（Fable 复核 2026-08-09；施工合同最终版=正文+§V+§W+§X，冲突以最新节为准）

R2 审核档 `VOICE_INPUT_V1_OPUS_REVIEW_R2_20260809.md`。§V 吸收 19/19 无走样、§W 无
新风险、消融定性双方独立复算一致（「战狼点」无信封 0/4→带信封 4/4；「南线前哨」
1/4→4/4；Opus 补的定性采纳入档：**TAGS 独有名——模型先验里不存在、只活在本局信封里
的名字——正是红利最大也是 Web Speech 结构上永远够不到的一格**）。

**P0 成立收下（R1 搬家清单欠账）**：`ChatPanel.tsx:1576-1581` 的 bucket 判定本体是
内联两行，不在 R1 三函数清单里 ⇒ ④负对照与 P0-1 fail-closed 断言全部没有落点。
修法照 R2：**步 2.5 搬家清单加第四项——bucket 判定抽成 `decideBucket()` 纯函数**
（零行为变化；ChatPanel 塌缩为一行路由；先例 H1 `describeCommittedPull`）。三条
机器断言全部落在 decideBucket 上：①语音回合 heard 缺席 ⇒ 禁入 A ②点名不符
负对照（摘刀 ⇒ A，RED 先行）③fallback 无 heard 被同一判定拦住。

**P1 六条全收**：
1. `CONFIRM_WORD_SITES` 登记**与新增调用点同 commit**（TB2 会咬提前登记的幽灵
   nth）；步 2 只登记 SPEECH_RULE_SITES+指纹 与 REGISTERED_SHARED_SURFACE_RULINGS
   两张表。
2. **§7 触发条件修正**：延迟超线 ⇒ **V1 不合并、退回现状 Web Speech**（保守案
   两跳更慢，救不了延迟——原"超线退保守案"作废）；§7 仅由工期喊停触发（§W-3）。
   V1.5（ops 中继）不受影响——ops 本就吃得住两跳。
3. **步 3 打包补 ②与⑤**（pushContext(user,heard) + isCancelReply/isDeclineReply(heard)
   清升级问句，约 4 行）——缺 ② 语音回合不进上下文、缺 ⑤ 语音「不用」清不掉悬挂
   问句，两者都直接喂 F2；步 4 剩 ③⑥⑦。
4. §V-0 论证措辞更正：`createFallbackResponse` 是手写字面量、**根本不经
   validateAdvisorResponse 白名单**；heard 缺席是因为字面量本就没有该字段。
   结论不变（fail-closed 照拦），理由改正，防后人按错理由改代码。
5. **V1.5 复用缝三处命名导出**（audio 参数类型 / parts 拼装函数 / 频道能力校验），
   步 1 落地时命名，别让 V1.5 靠复制。
6. **「没听清」不造新罐头**（07-22 台词禁死模板；且 heard 缺席时模型照样答了话，
   "没听清"字面为假）：fail-closed 只做**路由**（强制 bucket B），台词走现有
   bucket B 问句机器。§V-6 对用户的承诺行为不变（会反问不会照做），措辞出处改注。

**结论：施工合同就绪（正文+§V+§W+§X），等用户点头，Opus 开 worktree 按七步施工。**
