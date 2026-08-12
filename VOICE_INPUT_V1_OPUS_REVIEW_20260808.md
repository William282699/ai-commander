# 语音输入替换刀 V1 — Opus 5 独立审核报告（2026-08-08）

> 被审对象：`VOICE_INPUT_V1_PROPOSAL_20260808.md`（Fable 5 workplan）
> 基线：main = `cb02c2b` = origin/main，tag `envelope-precision-v1-done`，工作区干净。
> 家法执行：档案与提案自述只当线索，**结论全部从代码重推**（file:line 已注）；
> 探针**亲手重跑**（§6），Fable 报的三个数逐个复算。
> 本档零实施——未改任何项目代码；探针脚本副本跑在 scratchpad。

---

## §0 一句话结论

**方向对、病灶盘点准（P1-P5、P7 全部核实无误，line 号逐条对得上），但有三处必须改了才许开工**，
其中两处是同一个根：**提案对 `canAutoExecute` 失去文本后的行为判断反了方向**——不是"全弹卡"，
是"**全部落进 bucket A 自动执行**"。这既让 P6 的论证站不住，也让 §4 那条摘刀负对照变成空转。

| 判决 | 数 | 内容 |
|---|---|---|
| **P0（阻碍合并 / 会伤现有功能）** | 3 | ①无 heard = 静默自动执行（方向反了，兜底也跟着错）②摘刀负对照不咬 ③`CONFIRM_WORD_SITES` 会当场炸且没登记 |
| P1（开工前一句话就能修） | 6 | 见 §7 表 |
| P2（建议/记账） | 5 | 见 §7 表 |
| 给 Fable 的问题（先问原因，不默认是错） | 4 | 见 §8 |

**核准的部分（不重复审）**：P1-P5/P7 病灶属实；schema 两条 return 路径的判断精确且同文件有先例
（`pendingDecision` 就是这么加的，types.ts:765-768 的注释逐字写着"present on BOTH schema return paths"）；
"prose 不复读转写"的理由被代码坐实（ChatPanel.tsx:1743 `if (ttsEnabled) speak(event.content, ttsPersona)`
——prose 每一块到手即念）；16kHz 不是口味是承重（§4 算术）；§7 保守案立得住。

---

## §1 病灶 P1-P7 逐条核真伪

| # | 提案说法 | 核验 | 判 |
|---|---|---|---|
| P1 | `ChatPanel.tsx:682-740` Web Speech，zh-CN 单语、无词表注入口 | :681-736 亲读：`rec.lang="zh-CN"`、`interimResults`、`continuous`，**无任何 grammar/词表注入**；onend 里 `sendBtn?.click()` 自动发送（:723-733） | **属实** |
| P2 | 请求链纯文字，`:1707/:1810`、`index.ts:90/122`、`providers.ts:9` | 四处逐字核对：stream body `{digest, message: llmMessage, styleNote, channel, sessionId, escalateId}`（:1707）、非流同形（:1810）；index.ts:90/:122 解构同名；providers.ts:9 `content: string` | **属实** |
| P3 | 默认 profile=gemini-2.5-flash 管 combat/logistics/group；`LLM_PROFILE_OPS=deepseek` | `.env` 只有 `LLM_PROFILE=gemini-2.5-flash` + `LLM_PROFILE_OPS=deepseek`；`providers.ts:325-353` 频道覆盖优先、否则落默认 ⇒ **combat/logistics/group 三个面都是 gemini** | **属实**，但见 §4-连带面①（group 必须显式排除，不能靠 provider===gemini 推导） |
| P4 | `schema.ts:271` 白名单重建，两条 return 都要带 | :271 起亲读：:311-320 空 options 早退、:375+ 正常路径，两处都是**字段逐个列举的重建**；未列的根级字段静默消失 | **属实**。补一条提案没写的：**还有第三条路**——`validateAdvisorResponse` 返回 `null`（:275/:276/:363）时走 `createFallbackResponse()`，heard 一定丢，见 P0-1 |
| P5 | `index.ts:34` `limit:"100kb"`，190KB 已超线 | :34 逐字属实；探针实测 4.4s WAV b64 = **188KB**（我的重跑同样打印 188KB），超线属实 | **属实** |
| **P6** | `canAutoExecute` 无文本 → **永远 no_anchor → 高影响闸全弹确认** | **方向反了**，见 P0-1 | **不成立** |
| P7 | send 时文本七处消费者 :1248/:1254/:1279/:1343/:1345/:1383 | 六个 line 号**逐个精确命中**（`grep -n` 复核）。**漏了三处**：`:1203` `if (!state || !message.trim()) return;`（入口闸，语音回合没文本会当场返回）、`:1225` `setMessage("")`、`:1377-1381` `let llmMessage = userMsg` + declinedContext 拼接（**这条会把"重新制定方案"的上下文丢掉**） | **基本属实，三处待补** |

---

## §2 修法 A-D 可行性

### 🔴 P0-1 · heard 缺席不是"弹卡"，是"静默自动执行"（P6 论证 + §2-C 兜底 双错）

**代码事实**（`ChatPanel.tsx`，逐行）：

1. `canAutoExecute` 只有**一个**调用点（:1531），且第 4 参传的是**空数组** `[]`（不是 selectedIds 快照）。
2. `high_impact` 的判定 **完全不读 `userMessage`**：:331-338 只看 `intent.fromSquad / quantity / type / fromFront`。
3. 文本为空时的真实分流：
   - intent **有** `fromSquad` → :368 `anchor_mismatch`，且 `playerNamedSquad = (squadIdsInText.size>0 || mentionedAnchors.size>0)` = **false**；
   - intent **无** `fromSquad` → :371 `no_anchor`（`hasSelectedKeyword` 恒 false）。
4. :1576 `const bucketA = staleRefs.length===0 && opt0!=null && (reason==="no_anchor" || (reason==="anchor_mismatch" && !gate.playerNamedSquad));`
   :1579-1581 `if (bucketA) → handleApprove(opt0, 0, "auto", …)`。

⇒ **两条路都是 bucket A 的入场券，两条路都直接自动执行模型给的第一方案。**
不弹卡。一张卡都不弹。提案 §2-C 写的兜底「闸走 no_anchor 弹确认——不猜、不编、fail-closed」
**恰好把 fail-closed 说成了 fail-open**：`no_anchor` 是自动执行的判据，不是拦截的判据。

**这条错误的代价比听起来大三层**：

- **第一层（安全）**：真正被文本承重的不是 high_impact，是 **bucket B**——「长官点名了 A，模型返回了 B」
  这一格。它靠 `playerNamedSquad` 分辨，而 `playerNamedSquad` 只从文本里长出来。
  没有 heard ⇒ 所有语音回合的 `playerNamedSquad` 恒 false ⇒ **点名不符从"问一句"退化成"静默照发"**。
  这才是 heard 必须接线的真理由，比提案给的理由硬得多。
- **第二层（兜底反向）**：heard 缺席的兜底被写成"沿用现状"。现状 = bucket A = 执行。
  所以模型漏字段 / schema 掉字段 / 传输错误 / 429 —— **每一种失败都变成"照发"**，不是"停手"。
- **第三层（最脏的一格）**：`createFallbackResponse()`（`schema.ts:426-445`）返回的不是空壳，
  是**带可执行 intent 的三个选项**，A = `{type:"defend", urgency:"medium"}`，无 fromSquad、无 quantity。
  过 `isValidTarget`（:120-152 的守卫全部是"字段在场才检查"）⇒ true ⇒ 不是 high_impact ⇒
  `no_anchor` ⇒ **bucket A ⇒ 自动下一张全线防御单**。而 `data.warning` 客户端**从不检查**
  （全仓只有 :2407 一处渲染，而命令路径 `setResponse(null)` 早已把它清掉）。

**必须的修法（不是建议，是开工前提）**：
在 gate 上给语音回合加一条**显式** fail-closed 判定，而不是"沿用现状"——
语音回合且 `heard` 缺席 ⇒ **不许进 bucket A**（落 bucket B 问一句「没听清，您刚才说的是？」）。
这条判定是新增行为，按 T1j 先例进 §3 有意差异登记表。

> 顺带一笔**与本刀无关的 main 旧账**（见 §7-新账 N1）：上面第三层在**打字路径上今天就成立**——
> 玩家问一句不含番号/领队名的话、LLM 恰好 500，引擎会自动下一张「稳守阵地」全线防御单。
> 不在本刀修，但账本里没有这笔，建议立案。

### 🔴 P0-2 · §4 的摘刀负对照是空转（证不了接线承重）

§4 写的负对照是：「关掉结算点④ → 语音高影响命令必须弹确认」。
但由 P0-1 第 2 条：**high_impact 完全不读 userMessage**。所以：

- 接线在：high_impact → 弹确认；
- 摘刀后：high_impact → 照样弹确认。

**两臂同结果**，这条负对照关掉修复也是绿的——正是家法⑤（回归测试必做负对照，新断言要真的 FAIL）
和第 8 级方法资产②（常数化的期望值是陷阱：断言在测同义反复）点名的形状。

**真咬的负对照**（点名不符格）：
造一局，语音说「Aiden 去北线」，让模型返回 `fromSquad = 另一支`（或直接构造该 option）：

- 接线在 ⇒ `mentionedAnchors={aiden}` ⇒ `anchor_mismatch` + `playerNamedSquad=**true**` ⇒ **bucket B，问一句**；
- 摘刀 ⇒ `playerNamedSquad=false` ⇒ **bucket A，静默派另一支**。

**判据必须效果级**（家法①）：数 `assignedUnitIds`、核实际动的是哪一支，不看回执台词。
配一条正对照防过闸：语音点名 A、模型也返回 A ⇒ `auto:true`，**不弹卡**（证明 heard 没有把闸拧死）。

**台架落点问题（要一并解决）**：`canAutoExecute` 是 `ChatPanel.tsx` 里的模块私有函数，
node 台架够不到——这正是 LEDGER **H1「GameCanvas 接线无台架可测」的同族**，且第 7 级方法资产写死
「**负对照必须打在 bench 测得到的层上**」。两条路：

- **(推荐)** 把 `canAutoExecute` + `isValidTarget` + `detectStaleSquadRefs` **搬家不复制**到
  `apps/web/src/autoExecuteGate.ts`（纯函数、零 React），ChatPanel 只 import。
  先例齐全：§8 的"空间聚类搬家不复制"、H1 的 `isUnitIdle` 收敛成唯一一份；
  台架 import apps/web 也有先例（`ab-mapdata-audit.ts:29` import `rendererCanvas`）。
  代价：一次零行为变化的移动 + 13 台架与 typecheck 当负对照。**约 20 分钟**，换来 ④ 这条负对照真能跑。
- (次选) 只手测。但那样 ④ 的承重性没有机器证据，与本项目的家法不符。

> ⚠ 若采用搬家：`ab-approval-v4.ts:1197 CHATPANEL` 常量**读的是 ChatPanel 源码文本**做行级断言
> （`runKnifeB1`），搬走的函数体如果带走 `isConfirmReply/isCancelReply` 调用会连带影响 nth 计数
> ——实测这三个函数体内**不含**这两个 token，安全；但搬家后要重跑 `--synthetic` 确认 TB1/TB2 未动。

### 🔴 P0-3 · `CONFIRM_WORD_SITES` 会当场炸，而 §5 没列这一面

`scripts/ab-approval-v4.ts:1186-1195` 有一张**按"文件内第 n 次出现"钉死的登记表**，
登记了 ChatPanel 里 `isConfirmReply`/`isCancelReply` 的全部 4 个活调用点，
断言 TB1「没有未登记的调用点」/ TB2「登记表里没有已消失的调用点」/ TB3「没有一处被声明为闸」。

D⑤（`isCancelReply/isDeclineReply(heard)`）与 D⑥（`isConfirmReply(heard)` 补章）**都会新增调用点**
⇒ `isCancelReply#3` / `isConfirmReply#3` 未登记 ⇒ **TB1 当场 FAIL** ⇒ 硬线「195/0」破。

这与 §O-3 给刀1 标的 `CANDIDATE_FACES` nth 错位**是同一个形状**，那次登记了、这次漏了。

**正解（不许放宽断言）**：同 commit 把新面登记进 `CONFIRM_WORD_SITES`，policy 只能取
`telemetry`（D⑥）/ `context-only`（D⑤）——顺带强制实施者当场声明"语音路径上词表仍是捷径不是法官"（红线二）。
另：`isDeclineReply` 不在该表扫描范围内（只扫两个 token），不会自己红——**更要主动登记**。

**ordinal 稳定性已核**：`processAdvisorData` 定义在 :1387 之后，新增调用点排在现有 4 个之后，
现有 nth 不错位；但若把 :1279 的记账**移动**到 heard 时点（D⑥ 字面写的是"挪"），
`isConfirmReply#2` 的位置会变、note 会失真——**移动就同步改 note，新增就加行**，两者别混。

### 修法 A（客户端录音）· 可行，四笔要补

- **A-a（P1，会串音）**：现在按住 🎤 时，陈可能正在念上一条（TTS 逐块 speak，:1743）。
  裸 `getUserMedia` 录音**会把喇叭里的陈录进指挥官的命令**（Web Speech 那条路走的是同一套音频管线，
  默认带 AEC，所以今天没暴露）。两条一行的修法都要：`getUserMedia({audio:{echoCancellation:true,
  noiseSuppression:true, autoGainControl:true}})` + **按下 🎤 即 `cancel()` TTS**。
- **A-b（P1，算术承重）**：16kHz 不是口味。30s @48kHz mono 16-bit = 2.88MB → b64 **3.84MB**，
  贴着 4mb 上限（4.19MB）且没给 digest 留地方；16kHz = 960KB → b64 **1.28MB** 舒服。
  ⇒ **重采样是必需项**（`OfflineAudioContext` 到 16000 最省事），不是优化项。
  提案的 190KB/1.28MB 两个数我复算过，对。
- **A-c（P2，可能省掉最贵的一步）**：「OpenAI 兼容端点只文档化 wav/mp3」——探针只证了 **wav 通**，
  **webm/opus 从没测过**。若 opus 可用，客户端可以 `MediaRecorder` 一把梭，
  省掉 AudioWorklet + 重采样 + WAV 封装（本刀最大一块客户端代码 + 最容易在真机上翻车的一块）。
  **建议开工前花 10 分钟在浏览器录一段真 webm 打一发探针**——赌赢省掉 100+ 行。
  （本机无 ffmpeg，我造不出 opus 样本，所以没替你们测掉。）
- **A-d（P2）**：`/api/health` 拉不到时的默认值提案没写——必须**默认 Web Speech**（fail-closed 到现状）。

### 修法 B（服务端通道）· 可行，两笔要补

- **B-a（P1，fail-closed 只堵了半扇门）**：`createProvider`（providers.ts:439-445）**只有 claude 一支**
  走 ClaudeProvider，**deepseek 和 gemini 共用 `OpenAICompatibleProvider`**。
  所以"ClaudeProvider 收到 parts 即 throw"挡不住 ops：audio 若送进 ops，parts 会被**原样转发给 DeepSeek**，
  换回一个 400，再被 `callAdvisor` 的 catch 变成 `createFallbackResponse()`
  ——**又落回 P0-1 第三层**（兜底方案被自动执行）。
  修法：fail-closed 挂在**能力**上不挂在类上——`ai.ts` 收到 audio 时校验 `getProviderConfig(channel).provider === "gemini"`，
  否则 `index.ts` 直接 400。客户端 capability 探测是第一道，服务端这道才是硬的。
- **B-b（P1）**：`index.ts:92-99 / :124-131` `message` 是**必填**（`!message` 即 400）。
  语音回合没有文本 ⇒ 必须放宽成「audio 在场时 message 可空」，且写成**互斥判定**
  （`audio` 与 `message` 至少一个在场、两个都不在场仍 400），别顺手改成"都可空"。
- **B-c（P2）**：`limit` 从 100kb 提到 4mb 是**全局** `app.use(express.json(...))`（:34），
  连 `/api/log-event`、`/api/brief` 一起放开。改成两条命令路由上挂各自的 `express.json({limit:"4mb"})`、
  全局仍 100kb，一行的事。

### 修法 C（heard 合同）· 可行，一笔是手感、一笔是事实

- **C-a（P1，手感，需用户拍板）**：**heard 到达的时点，提案说错了。**
  流式路径里 JSON 在 `---JSON---` 之后（ai.ts:1041-1094），`processAdvisorData` 挂在
  `event.type === "options"`（ChatPanel.tsx:1744-1752）——也就是**整条回复念完之后**。
  所以 §3-2 写的「≈2s 后替换占位」不对，实际是「**陈把话说完之后**，长官气泡才补上自己刚才那句」。
  玩家会先看到（并听到）陈的回答，然后自己的话才出现在上面。
  这是可见的手感变化，按家法「影响手感的变更先三行人话确认」，**要单独说给用户听、由用户点头**。
  可选修法（**不是必须**）：让模型把「听到：…」作为**流首一行**吐出，服务端用现成的分隔符机器
  拆出来发一个 `{type:"heard"}` SSE 事件、**text 事件里绝不带它**（TTS 因此碰不到），
  客户端 ~1.4s 就能填气泡并提前结算 ④。代价：`callAdvisorStream` 多一个解析态 + 一条 fail-closed
  （首行不是标记就整段当 prose、heard 记缺席）。**约 40 分钟**，换气泡时序正常 + ④ 提前生效。
- **C-b（P2，事实）**：`heard` 字段名全仓无占用（已 grep），加在 `types.ts:755 AdvisorResponse` 上
  与 `pendingDecision` 同族，两条 return 路径的写法可以逐字照抄 :303 + :319 + :380 的做法。

### 修法 D（七件结算）· 可行，两笔更正

- **D-c（P2，别把空转当承重）**：D③ `playerIntent = heard` **对本刀的两个频道是死的**。
  `commanderMemoryRef` 只经 `buildDigestForChannel`（digestHelper.ts:29-32）进信封，
  而 `playerIntent` 唯一读者是 `battleContext.ts:185`，只在 `ch === "ops"` 时构建——
  **ops 恰恰是本刀不动的那个频道**；combat/logistics 走 `buildDigest`，根本不看 memory。
  接上无害（将来 ops 换耳朵就活），但**不许给它写断言**，那会是一条同义反复的牙（方法资产②）。
- **D-d（P1）**：D② 的顺序判断**是对的**，我复核过：send 时的 `pushContext(user,…)` 在 :1383，
  而当轮信封在 :1376 就拼好了 ⇒ 当前轮本来就不含自己这句 ⇒ 把它推迟到 heard 时点不影响本轮，
  只要排在 processAdvisorData 里那几处 assistant 推送（:1478/:1497/:1509/:1527）之前即可。
  **补一条提案没写的**：heard 缺席时 **user 侧要不要补一行**？不补 ⇒ 下一轮上下文里出现
  「assistant 说了话但没人问」的空洞，直接喂大 **F2（上下文劫持）**。建议补一行占位
  （如 `（语音·未转写）`），并登记。
- **D-e（P2）**：D① 要的 `updateMessage(id)` 需要 `addMessage` **返回 id**，而它现在
  `: void`（messageStore.ts:111-131），且它在 `MessageStoreShape`（:57-77）里——**改的是跨窗口桥的契约**。
  更省事的等价做法：`updateLastPlayerMessage(channel, text)`，桥面只加一个函数、不动 `addMessage` 签名。
- **D-f（P1）**：`logEvent`（index.ts:75-77）**只有 `console.log`，没有落盘**（O6 随 A5 缓办，§P 已裁）。
  所以 §2-D⑦ 说的「这就是 I2/D4 的真语音日志」目前只成立于「跑 dev server 的那个终端 / `fly logs`」。
  **不建议为此翻 §P 的裁定**；建议改成：手测阶段的 10 句 WAV + heard 逐条**手工入库**
  （§4 已写"探针脚本与 wav 移植入库"，把 heard 一起存进去即可）。I2 要的是真样本，不是持久化架构。

---

## §3 验收判据够不够硬

| 判据 | 评 |
|---|---|
| 延迟阈值「松手→陈第一个字 中位≤2.0s / p90≤3.0s」 | **数合理但缺基线**（P1）。我实测音频臂 TTFT 中位 1420ms（§6），加 WAV 编码+两跳上行，2.0s 是**贴边**。更要命的是：**现状那条路的同一指标从没量过**（§4 里"0.5-1.5s"是推测不是测量）。绝对阈值分不出"我们把它弄慢了"和"它本来就这样"。**修法：同 10 句先量现状基线，判据改成对照**（这才是"测效果"）。另：探针是 node 直连 Google，**demo 若走远端部署，浏览器→服务器还有一跳 190KB~1.28MB 上行**，阈值要在 demo 实际拓扑上量。 |
| 听错清单 A/B（10 句 ×2 臂） | **方向对，三笔要拧紧**：①A/B 两臂是"人念两遍"不是同一段音频，**顺序要交替**（否则第二遍念得更清楚 = 偏袒后测的臂）；②判据说"数地名与番号命中率"——n 这么小**不许报率**，逐条对照读、写清哪句错在哪；③"会动兵的句子必须 resolveIntent 数 assignedUnitIds"——**保留，这条是全篇最硬的一句**。 |
| heard 合规（在场 ≥19/20、prose 不含转写） | 够硬。补一条：**heard 与真实说话内容的逐字性**要单独看（见 §6 的新证据：脏音频下模型会**改写**而不只是换地名）。 |
| 归一化风险看点 | 立观察账的处理**判得对**（n 小不设硬线）。但要把范围写宽：不只是"换成信封里的地名"，是"**听不清就自己顺一句**"（§6 两次独立跑都出现）。 |
| 摘刀负对照 | ❌ **空转**，见 P0-2。 |
| 台架硬线（195/0、negctl 48、--sites、13 台架） | 基线我已亲手复跑确认：`typecheck` 四包过、`ab-approval-v4 --synthetic` **PASS=195 FAIL=0**、`--negctl` **PASS=147 FAIL=48「红的正是登记在案的那 48 条」**、`ab-g-knife --sites` 全绿。硬线本身没问题，**问题是它会红在一个没登记的面上**（P0-3）。 |
| 新台架 `ab-voice-input --synthetic` 三条 | ①②③ 都在服务端/shared 侧，跑得到，够。**缺 ④ 的落点**（P0-2 的搬家建议解决它）。 |

---

## §4 连带面（点名要查的四项 + 我另查到的）

1. **群聊与 ops 的隔离（P1，spec 有洞）**：§2-A 写 `voiceChannels = provider===gemini 的频道名单`。
   但 `.env` 没有 `LLM_PROFILE_GROUP` ⇒ group 落默认 ⇒ **group 就是 gemini** ⇒ 按这条规则算出来的名单
   **会把群聊装进去**，与 §5「群聊零改动」自相矛盾。修法：`voiceChannels` 写成**显式白名单**
   `["combat","logistics"] ∩ (provider===gemini)`——两个条件都要，一个防配置漂移，一个防语义漂移。
2. **emily-guard（P1，不会咬，但必须登记）**：`runEmilyGuard`（ab-g-knife.ts:1381-1440）只装配
   `SYSTEM_PROMPT + CHANNEL_PERSONA.logistics` 两个 span。音频说明若加在 `callAdvisor` 的
   `userContent` 模板里（ai.ts:751-757 / :1010-1016），**不在扫描面内 ⇒ guard 不会红**。
   但语义上它**确实会进 Emily 的 prompt**（她也换耳朵，§3-3 自己写的）——
   这属于共享面上的**有意变更**，按 §P 立的 carve-out 操作定义，得进
   `REGISTERED_SHARED_SURFACE_RULINGS`（ab-g-knife.ts:1371-1379）。§5 完全没提这份清单。
3. **`--sites`（P1，理由写反了）**：§5 说「--sites C 断言会咬，先登记后施工」。
   实际：C 只对**已登记**的面生效；新面靠 **B 断言**，而 B 只在 `detectRules` 命中
   `RULE_FINGERPRINTS`（ab-g-knife.ts:996-1030）时才响。提案那段音频说明的措辞
   **一个指纹都不匹配** ⇒ **B 不会响** ⇒ 靠台架提醒你登记 = 靠不住。
   正解照刀2 的先例：**主动登记新面 + 同时补一条指纹**（刀2 就是这么给 `/\[临时编队G#\]/` 加的）。
4. **跨窗口 bridge（P2）**：见 D-e。另：detached panel（`?mode=panel`）里的 `getUserMedia`
   要单独授权一次，**手测清单里加一条"在弹出面板里也说一句"**。
5. **我另查到的三面（提案未列）**：
   - `CONFIRM_WORD_SITES` —— P0-3。
   - `/api/staff-ask`（index.ts:220-246）复用 `callAdvisor` ⇒ **audio 参数必须是可选且默认不传**，
     否则 staff-ask 会顺带继承音频分支；核过，只要签名可选就零风险。
   - **非流路径 + jsonMode + audio 这个组合从没测过**（P1）：探针跑的是 `stream:true` 且**没有**
     `response_format`；而 `/api/command` 走 `callDeepSeek` → `chat()` → `jsonMode:true` →
     `response_format:{type:"json_object"}`（providers.ts:62-64）。而这条路**恰恰是流失败时的兜底路**。
     施工第 1 步的探针要把这个组合打一发。

---

## §5 施工顺序与步骤切分

**主要问题（P1）：第 3 步与第 4 步之间的那个 commit，是本刀最不安全的状态。**
装完客户端录音（步 3）而没接结算点（步 4）时，语音回合 = 无文本 = **每一句都走 bucket A 自动执行**
（P0-1）。按家法「一步一测」，用户会在这一步手测——测到的会是一个比首尾两端都危险的中间态。

**建议切法（不增总量，只挪边界）**：

| 步 | 内容 | 为什么这样切 |
|---|---|---|
| 1 | 服务端通道（parts + audio 参数 + body/limit + **B-a 能力 fail-closed** + **B-b message 互斥**） | 负对照"无 audio 拼装逐字节同"照旧；**加打一发非流+jsonMode 探针**（§4-5） |
| 2 | heard 合同（schema 两路径 + text part 说明 + 【本次强制】 + voice_heard 日志）+ **登记三张表**（`SPEECH_RULE_SITES`+指纹、`REGISTERED_SHARED_SURFACE_RULINGS`、`CONFIRM_WORD_SITES` 预留） | 登记与施工同 commit，别留到步 5 |
| **2.5（新增）** | **`canAutoExecute` 搬家到 `autoExecuteGate.ts`（零行为变化）+ 写 ④ 的负对照台架（此时应 RED）** | 回归网先行，第 7 级 `3267beb` 的先例；**RED 基线在接线之前拿到才算数** |
| 3 | 客户端录音 + capability 探测 + 占位气泡 + 发送 + **①heard 回填 + ④canAutoExecute 传 heard + P0-1 的 fail-closed 判定** | 让第 3 步结束时的状态**本身是安全可手测的** |
| 4 | 其余五件（②⑤⑥⑦ + D-d 的占位行） | |
| 5 | 台架补齐（`ab-voice-input` 三条 + 全家硬线） | |
| 6 | 手测（延迟基线+新值 / 听错清单 A/B / 语音「可以」批准链 / 第 8 级四幕重走 / **弹出面板一句**） | |

其余顺序无异议；步 1 的"探针脚本改指本地端点手测往返"是好习惯，保留。

---

## §6 探针重跑（家法⑥：谁报的数字，另一方必须重算）

**做法**：把 `~/MyProjects/_archive/voice-input-probe-20260808/` 整份复制到 scratchpad，
脚本**只加一行 `writeFileSync` 存全文**（请求形状逐字节未动），`node voice-probe.mjs` 原样跑一遍。
wav 的 sha256 已记录，与档案里的是同两个文件。

| 数 | Fable 报 | 我重跑 | 判 |
|---|---|---|---|
| 文字臂 TTFT | 687/619/546，中位 **619ms** | 540/395/380，中位 **395ms** | 绝对值不同（−224ms） |
| 音频臂 TTFT | 1356/1968/1713，中位 **1713ms** | 1386/1590/1420，中位 **1420ms** | 绝对值不同（−293ms） |
| **音频− 文字（真正承重的那个量）** | **+1094ms** | **+1025ms** | ✅ **两次独立复算一致（差 69ms）** |
| 「战狼点附近的闲置部队，去增援南线前哨」逐字全对 | **3/3** | **3/3**（三条 heard 逐字同、含两个地名） | ✅ **复现** |
| A2 归一化风险 | 「El Alamein」→**「北部沿海」**（信封内地名） | 「El Alamein」→**「北面」** | ✅ **同类复现，形不同** |

**结论一**：**绝对延迟数不要引用**（时段/网络漂移 ±0.3s），**要引用的是 +1.0~1.1s 这个差**。
§4 的阈值应该建立在差值和现状基线上，而不是"1713ms"这个具体数（P1，见 §3）。

**结论二（新证据，比 Fable 记的更宽）**：A2 那句在我这儿的 heard 是
「**两队步兵去北面，剩下的守住烽火台**」，而原句是「派两个步兵班去 El Alamein，剩下的守住烽火台」。
**「派两个步兵班」→「两队步兵」不是听错，是改写。** Fable 那次的「二营的部队」同理。
⇒ 两次独立跑、两种不同的改写 ⇒ **脏音频下模型交付的是"顺过的意思"，不是"逐字的原话"**。
这件事对 `heard` 的三重身份各有代价：
①当气泡显示 = 把改写过的句子当成长官自己说的话；
②当 `canAutoExecute` 的输入 = **改写会把番号/领队名这类锚点顺掉**，锚点一丢就掉回 bucket A（P0-1）；
③当 I2/D4 的语音日志 = 日志里存的是模型的复述，不是转写。
⇒ 建议：合同里"逐字转写"这条要配一句**不确定就原样保留/直说没听清，禁止顺句**；
并且 §4 的清单里**必须留一句故意念糊的**（提案已有，保留）。
清音频下 3/3 逐字全对 —— 所以这不是否决，是**边界**。

**结论三**：探针证的是「端点能听见 + 延迟」。**它没有证** heard 能被约束进 JSON 且不进 prose
（探针的 prompt 恰恰是**要求**模型把「听到：」写在第一行 prose 里）。这条只能靠 §4 的 --live 验收。

原始输出留在 `…/scratchpad/probe/rerun-stdout.txt` + `rerun-results.json`（含每条全文）。

---

## §7 判决清单（P1/P2 一句话）+ 新账

**P1（开工前修，多数一行）**

| # | 一句话 |
|---|---|
| P1-1 | 延迟判据缺现状基线：同 10 句先量「松手→陈第一个字」的现状值，判据改成对照而非绝对阈值。 |
| P1-2 | `voiceChannels` 必须是显式白名单 `["combat","logistics"]` ∩ gemini——按 provider 推导会把群聊圈进来。 |
| P1-3 | fail-closed 要挂在能力上：ops(deepseek) 与 gemini 共用 `OpenAICompatibleProvider`，只 throw ClaudeProvider 挡不住。 |
| P1-4 | `index.ts` 的 `message` 必填要改成 `audio` / `message` 互斥判定，别改成两个都可空。 |
| P1-5 | 录音必须显式开 `echoCancellation` 且按下 🎤 即 `cancel()` TTS——否则陈的声音会被录进长官的命令。 |
| P1-6 | heard 到达时点在**整条回复念完之后**（不是 ~2s）：这是可见手感变化，要单独说给用户拍板（§2 C-a）。 |
| P1-7 | heard 缺席时 user 侧要补一行占位进 context，否则下一轮上下文只有 assistant 的话，直接喂大 F2。 |
| P1-8 | 非流路径（jsonMode + `response_format`）+ audio 这个组合从未测过，而它是流失败的兜底路——步 1 补一发探针。 |
| P1-9 | emily-guard 扫不到 `userContent` 模板：音频说明进 Emily 的 prompt 属共享面有意变更，要进 `REGISTERED_SHARED_SURFACE_RULINGS`。 |
| P1-10 | `--sites` 不会自己咬（指纹不匹配）：主动登记新面 + 补一条指纹，照刀2 先例。 |
| P1-11 | 16kHz 重采样是必需项不是优化项（30s@48k b64=3.84MB 贴死 4mb 上限）。 |

**P2（建议 / 记账）**

| # | 一句话 |
|---|---|
| P2-1 | 开工前花 10 分钟测一发 webm/opus——通了就能用 MediaRecorder 省掉最大一块客户端代码。 |
| P2-2 | `limit` 提到 4mb 挂在两条命令路由上，全局仍 100kb。 |
| P2-3 | `updateLastPlayerMessage(channel,text)` 比 `updateMessage(id)` 省一次跨窗口桥契约变更（`addMessage` 现在返回 void）。 |
| P2-4 | D③ `playerIntent = heard` 对 combat/logistics 是死字段（只有 ops 的 BattleContextV2 读它）：接可以，**别给它写断言**。 |
| P2-5 | §7 保守案若启用，"地图实体名清单"注进转写器会**放大**归一化风险（§6 结论二），同一笔观察账要跟着走。 |

**新账（查过 LEDGER A-I 三十八笔，无重复；建议随本刀收口并入账本）**

| # | 账 | 一句话 | 出处 |
|---|---|---|---|
| **N1** | **通讯中断的兜底方案会被自动执行** | `createFallbackResponse()`（schema.ts:426-445）带可执行 intent，`data.warning` 客户端从不检查，一句不含番号/领队名的话 + LLM 失败 ⇒ `no_anchor` ⇒ bucket A ⇒ 自动下一张全线防御单。**main 今天就成立，非本刀引入**；本刀让它从"偶发"变成"每一个 heard 缺席的语音回合" | 本审 §2 P0-1 第三层 |
| **N2** | **heard 是复述不是转写（脏音频下）** | 两次独立探针两种改写（「派两个步兵班」→「两队步兵」/「二营的部队」）；影响 I2 日志的可信度与 ④ 的锚点 | 本审 §6 结论二 |

---

## §8 给 Fable 的四个问题（未覆盖的取舍先问原因，不默认是错）

1. **heard 走 JSON 尾巴是权衡过的，还是没注意到时序？** 如果是权衡过（"TTS 污染的风险不值得多一个解析态"），
   我接受，只要 §3 把手感差异写准（P1-6）。如果没注意到，§2 C-a 那条流首方案值 40 分钟。
2. **Emily 一起换耳朵是有意的吗？** 她与陈共用 `SYSTEM_PROMPT` 装配面，音频说明会进她的 prompt；
   只上陈能把共享面 blast radius 砍掉一半，而 demo 的主角是陈。如果理由是"生产指令也常用嘴说"，
   我没意见——只是要在 §3 登记"Emily 的 prompt 在语音回合会多一段"。
3. **§3-1 那 2 秒是不得已还是选择？** 我核过：词表 fast path 结构上不可能在语音回合秒回
   （要先发请求才有 heard），所以"不得已"没错。但**还有一个更硬的做法没被讨论**：
   heard 到达后若命中词表，**本地直接 `handleApprove(pendingNow.opt)`**（就是那份钉死的合同），
   而不是让模型的 `pendingDecision` 决定批的是哪一批。这把"批准对象"从模型手里收回引擎——
   与 v4 的"登记时钉死 top 候选+unitIds 快照"同精神。是刻意没做，还是可以加？
4. **保守案 §7 的启用条件只写了"延迟超线"——时间预算算不算第二个条件？**
   我的工时感觉：主案 = 服务端小 + 客户端录音中 + **结算七件重（碰的是待批合同/升级/上下文这三块最娇贵的机器）**；
   §7 = 同样的录音代价 + 一个新端点 + **命令链零改动、零新输出字段、零有意差异登记（除了没有实时字幕）**。
   延迟上主案确实更好（我实测 +1.0s vs 两跳约 +2.0~2.6s），消歧红利也更大。
   **方向是用户已经拍过的，我不重开**——只把这笔时间账摆出来：如果 demo 日期把步 4 挤掉，
   §7 是能单独上场的（步 1/3 两案通用，先施工不白做，这点提案说得对）。

---

## §9 我核过但没问题的（省得再审一遍）

- `ChatMessage.content` 扩成 `string | Part[]`：`chat()`（providers.ts:56-58）与 `chatStream()`（:90-95）
  都是把 `messages` 原样塞进 body，parts 天然透传，**不需要改这两个函数**。
- `withPendingReinforcement`（ai.ts:732-737）作为【本次强制】的先例成立，且它本身就是一个已登记的
  说话规则面（`SPEECH_RULE_SITES` ai.ts:962）——照抄它的形状是对的。
- 信封拼装零改动可验：`userContent` 里 `指挥官命令：${playerMessage}` 是**最后一段**（ai.ts:757/:1016），
  切成 `[{text: 前面全部 + 说明}, {input_audio}]` 不影响前面任何一个字节，负对照写得出来。
- `staff-ask` / `/api/brief` / `command-group` / `tts/*` 不受影响。
- 基线台架我亲手跑过：typecheck 四包 / `--synthetic` 195-0 / `--negctl` 48 条红集合原样 / `--sites` 全绿。

---

**审核人：Opus 5 · 2026-08-08 · 零实施（本档 + scratchpad 探针副本之外未动任何文件）**
