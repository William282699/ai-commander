# Step 7 — War Room Tension（把小 MVP 的紧张感接回大项目）

> **状态（2026-06-24 更新）：** Step 6a 已合入 `main`（commit `c5107a4`，tag `step6a-crisis-escalation`，已 push origin/main）。**7a（rev.2，含 stake/中性事实/证据制佯攻）+ 7b（director 降噪闸）已在 worktree `.claude/worktrees/step-7-war-room-director` 实现，typecheck 绿、已过 Codex 代码审，剩 bench + commit（未 commit）。** 本次又发现两个问题已纳入后续步：**新增 Step 7b.1（Emily 交易预算）** + **重写 Step 7c（结构化事实→LLM voice，替掉固定模板）**。下文 7c 为重写后版本。
> **配套：** `改造WORKPLAN.md`（Step 1-6 的工作方式与不碰区，全部沿用）、`改动方向-傻瓜版.md`。
> **小 MVP 来源：** `/Users/yuqiaohuang/MyProjects/commandersmallmvp`（server.js / public/app.js）。

---

## 0. 核心翻译原则（先定调，决定全步成败）

小 MVP 的紧张感来自三件事，但**都建立在「假状态」上**：`directorBeat()` 挑此刻唯一要紧的事、pulse 每 12s 逼一次决断、`mutateState()` 让 pressure 只升、油弹只降。大项目有**真状态、且被玩家控制**——所以**不能直接照搬 pulse 节奏**：玩家打得好时本就没危机，每 12s 硬造选择题 = 假紧张，违反「可玩状态神圣」和铁律「决策永远在引擎、别每几秒喂战场给 LLM」。

**Step 7 搬的是「形」不是「假」：**
- 搬 `directorBeat()` 的**选择逻辑**：从真实战场挑出此刻唯一最要紧的一件事，并用怀疑/取舍框定。
- 搬 pulse 的**消息形状**：一句危机事实 + 一句代价 + 一个真选择；但**只在有真取舍时触发**，平静时闭嘴（保住 Step 3 + heartbeat-off 已拿到的「参谋不是广播喇叭」成果）。
- 真实压力由**已有的敌人 AI / pressureDirector 制造**（`processEnemyAI` / `processPressureDirector`）——director 只**读**它，不伪造。世界太闷是敌人节奏的事（路线图单列，不在 Step 7 内）。

---

## 1–5：五个问题的分析（director 怎么接真实管线）

### MVP 假值 → 大项目真值映射

| MVP 假状态 | 大项目真值（已算好，现成） | 锚点 |
|---|---|---|
| `pressure`（只升） | 每条 `Front` 的 `engagementIntensity`(0-1) + 我/敌 power 比 + `estimateCollapseTime` 的 tCollapse | `packages/shared/src/types.ts` Front、`packages/core/src/crisisResponse.ts:218` |
| `fuel`/`ammo`（只降） | `economy.player.resources`（live）⚠️ **`front.supplyStatus` 是死字段——只在 scenario 初始化为 `OK`、运行时从不写，不要当输入** | `packages/shared/src/types.ts` EconomyState |
| `north/center/south`（5 档） | 每条真 Front 的 power 比 + engagement + keyEvents（**不含 `supplyStatus`，死字段**） | digest 内 `---FRONTS---` 段 |
| `directorBeat()` | **新增纯函数** `selectDirectorBeat(state)`，over 真 fronts/economy/crisis 数学 | 新建 `packages/core/src/director.ts` |
| pulse 12s 随机喊 | **复用休眠的 heartbeat 脚手架**（combat 20s / peace 40s、combat window、inFlight、session），由 director 门控 | `apps/web/src/GameCanvas.tsx:137`、`:1399`（现 `channels=[]` 全关） |
| history 隐式回指 | Step 1 日志 + 6a 的 `actionId`/`escalateId` 关联 → 真「决断 1-2 分钟后复盘」 | 6a `escalateCrisisToConversation`、`/api/log-event` |

> **digest 锚点（修正）：** 真实 digest 入口是 `packages/core/src/intelDigest.ts:64` 的 `buildDigest`（内部调 shared 的 `generateDigestV1` 作字段模板）；web 侧统一入口 `apps/web/src/digestHelper.ts:17` 的 `buildDigestForChannel`（ops 频道走 `buildBattleContextV2` 压缩版，其余走 `buildDigest`）。**不是** `packages/core/src/digest.ts`。

### ① 哪些真 state/digest 当 director input
每线 power 比 + `engagementIntensity` + `keyEvents`（⚠️ **不用 `supplyStatus`——死字段，运行时从不更新**）+ **可见集结证据**（对静线 bbox 做 fog-gated 可见敌军计数 / digest 的 `EnemyMassing` = Marcus 佯攻怀疑的 evidence；⚠️ **不靠 `enemyPowerKnown=false`——那只是"没看过"，absence-of-info ≠ 证据，7a rev.2 已弃用**）；crisis 数学 `estimateCollapseTime` / `assessCrisisEscalation`（6a 已导出：dilemma / safe_reinforce / report_only + bestCandidate）；economy fuel/ammo/readiness + 丢设施的 bonusIncome；phase + `WIN_PROGRESS`（objectives K/N、keypoints lost、time_left = 真·赌注时钟）。
**「pressure 趋势」要派生不要存**——比上一 tick 的 engagement / power 比 delta 算出来（director 内部缓存上 tick 快照即可，不写进 GameState）。

### ② 哪些 UI 战报降噪（actionRequired 分类已修正）
- **当前 actionRequired = true 的恰好 3 类**（reportSignals.ts）：`FACILITY_CONTESTED`(~266, cd 30s)、`POSITION_CRITICAL`(~392, cd 30s)、`MISSION_STALLED`(~427, cd 120s)——**这 3 类是 6a 报告道 escalate 问句的主要来源**。HQ 丢失走 advisorTrigger crisis_card 路径、doctrine 突破走 checkDoctrines，是另外两条独立来源。
- **report-only（当前不是问句类，应留安静报告道）：** `SQUAD_HEAVY_LOSS`、`SUPPLY_LOW`、`UNDER_ATTACK`、`FACILITY_LOST/CAPTURED`、`HQ_DAMAGED`、`MISSION_DONE/FAILED`、`ECONOMY_*`。
- 报告道分面已就绪（`apps/web/src/ChatPanel.tsx:487` `isReportMessage`），`ECONOMY_*` 已在 drain 处跳过，heartbeat 闲聊已全关。**真正要治的噪声 = 同 tick 多个 actionRequired 事件各自 escalate**（6a 现在会一次冒 2-3 个问句）。搬 MVP「不要把所有战线同时说崩」：同窗口内 director **只让排名第一的 beat 发声/问**，其余 actionRequired 事件降级进安静报告道；`SQUAD_HEAVY_LOSS`/`SUPPLY_LOW` 等 report-only 默认就只进报告道。

### ③ Chen/Marcus/Emily 何时主动说话
复用休眠 heartbeat 脚手架，但**由 director 门控、按 beat 领域选人格**（不像 MVP 随机、不像旧 heartbeat 环境闲聊）：塌线 beat → Chen(combat)；「这像佯攻 / 要不要动预备队」→ Marcus(ops)；「油只够一次大机动」→ Emily(logistics)。**有 beat 过阈值才说，没有就静默**；combat window 收紧到 20s、peace 放到 40s（复用现有常量）。

### ④ 何时必须问玩家决断
扩 6a 的 must-ask：真两难（救 A 抽空 B，6a 已有）；**油/弹稀缺逼「只能动一次」**（Emily）；**怀疑佯攻**（loud 线在响 + 另一条静线上有**可见集结证据**（fog-gated 可见敌军计数 / `EnemyMassing`）→ Marcus 问「押 loud 线还是留预备队等主攻」；⚠️ **不靠 `enemyPowerKnown=false`——7a rev.2 已改为必须真实 evidence**）；high_impact 无范围（Step 5 已有）。守不对称：增援可自动(6b)、**撤退永不自动**、取舍必问。
**关键 tuning：MVP「每 beat 必逼选择」太黏**——大项目只在有真分叉 + 真代价时问，否则只报或(6b)自己干，否则就退回旧 A/B/C 卡海。

**佯攻判据铁律（director feint，Codex 复审定）：** feint **只**能基于玩家**可见/半可见**的正向证据——fog-gated 可见敌军集结、侦察/雷达覆盖下的异常动向。**全盲方向不触发 feint——这是设计，不是待修 bug**（要 director 透过 fog 去「发现」佯攻，就是在造玩家根本没有的情报，违反 fog 规则 + 「引擎不造事实」铁律）。**绝不**用 `enemyPowerKnown=false` / 「没信息」当证据。可预期后果：feint 只在你**有部分视野**时偶发、真瞎时**沉默**——日后看到「feint 很少触发」**不要**靠放宽判据 / 透视 fog 来「修」，沉默本身就是正确行为。

### ⑤ 决断如何 1-2 分钟后复盘（MVP 没有，全新，接 6a 关联设施）
玩家答 director beat 时，6a 已用 `actionId`/`escalateId` 把决断和回复对上。Step 7 加：给该决断**打上它关乎的 front/objective + 当时关键指标快照**（power 比 / tCollapse / fuel），排一个 ~60–120s 后的 review 检查。到点引擎**比指标 delta**（线守住了没？赌中了没？），对应人格发一句**回指**（「您让北线死守那下——守住了，但 Carter 排打残了」「您赌中路是主攻——对了，北线那波是佯攻」）。**引擎算结果、人格只 voice。** 这条正好闭合校准种子循环：回指 + 玩家反应（同 correlation id 入日志）= 个性化的干净原料。

---

## Step 7 子步拆解（安全→危险，一次一步，每步独立可 bench）

> 全程铁律同 `改造WORKPLAN.md`：一步 → `npm run typecheck` 绿 → 停下手测 bench → 过了 commit+tag → 下一步；每步开 worktree（node_modules 软链按 worktree 陷阱处理）；只暂存该步文件，**永不 `git add .github/`**；worktree 跑 `npm install` 后 `git checkout main -- package-lock.json` 再暂存。

### 7a — Director 读盘（纯函数 + 观测，零行为变化）｜风险：极低 ✅ 已实现（worktree，待 commit）
- **目标：** 新建 `packages/core/src/director.ts` 纯函数 `selectDirectorBeat(state, prev?): DirectorBeat | null`——把真实战场排成**唯一一个**最要紧 beat，含派生 pressure 趋势。先**只输出到调试 console**（`describeDirectorBeat`），不产生任何新对话。
- **实现后的 beat 形（Codex rev.1/rev.2 定，7c voice 的输入契约）：** `{ kind, channel, frontId, frontName, stake, severity, estimatedCollapseSeconds, freeReinforcement, debugFact, debugTradeoff, metric }`。**关键纠偏：** 引擎只出**结构化事实 + 中性 `stake`**（`player_defense`/`player_attack_under_pressure`/`contested_objective`/`unknown`），**不写死「我方失守」**（同一信号在我方进攻/争夺时也会触发）；`debugFact`/`debugTradeoff` **仅 debug、非玩家文案来源**（玩家话术留给 7c LLM）。
- **关键 gate（Codex blocker 已修）：** collapse/dilemma 必须该 front 有真实我方 combat 部队才生成（否则 `tCollapse=0` 假紧张）；feint 必须有**可见集结证据**，不靠 `enemyPowerKnown=false`。
- **输入：** §① 列的真值；crisis 数学复用 6a 导出，**不动决策数学**。`supplyStatus` 是死字段、`front.playerPower` 只在 buildDigest 刷新——用 `engagementIntensity` / tCollapse / 经济资源等每 tick 新鲜值。
- **不碰：** 对话 / 渲染 / 引擎决策。
- **通过：** beat 选择合理、纯函数、typecheck 绿、游戏零可感知变化。**（已 typecheck 绿，待 bench。）**
- **完成：** commit + tag `step7a-director-read`。

### 7b — 战报降噪（门控 / 渲染）｜风险：低
- **目标：** 同窗口内只让 director top beat「响」，其余 actionRequired 事件降级进报告道（治 6a 的多问句齐冒）；`SQUAD_HEAVY_LOSS`/`SUPPLY_LOW` 等 report-only 保持只进报告道。
- **锚点：** GameCanvas report-drain 的 actionRequired 分支（6a 改成 escalate 的那段）按 `selectDirectorBeat` 排名分流；`isReportMessage` 报告道已就绪。
- **不碰：** 信号产生（reportSignals）、引擎。
- **通过：** 多危机同时发生时只冒 1 个问句、其余安静可查；无回归；typecheck 绿。
- **完成：** commit + tag `step7b-denoise`。**（已实现于 worktree，typecheck 绿、已过 Codex 代码审，剩 bench + commit；未 commit。）**

### 7b.1 — Emily 交易预算（通用预算抽象，不穷举资源）｜风险：低-中（命门小授权）
> 顺序：**先收口 7b，再做本步，再做 7c。** 本步是 Step 7 第一次明确授权碰命门——必须最小、加性、仅 trade。

- **根因（不是 LLM 不会算，是 schema 表达不了）：** 「全部钱买 fuel / 一半钱买 fuel / 四分之三钱买 fuel」执行不对，因为 trade intent/order 只有 `tradeAction?: string`（一次 buy），**没有预算/比例字段**。锚点：`intents.ts:53`、`schema.ts:116`；`executeTrade` 一次一买 `applyOrders.ts:193`；`TRADE_COSTS`（cost/gain/cooldown）`constants.ts:164`（注：cooldown 字段当前在 executeTrade **未强制**，批量买不冲突）。
- **设计原则（守反穷举铁律 `feedback_no_keyword_enumeration`）：**
  - **不做** `buy_all_fuel/buy_all_ammo/buy_all_intel` 这种穷举字段。
  - **不让 LLM** 算钱数/购买次数/剩余资源——LLM 只把自然语言预算意图解析成结构字段。
  - 引擎据 `TRADE_COSTS` + 当前 resources 算：买几次 / 花多少 / 得多少 / 剩多少。
  - 普通「买 fuel / buy fuel」**仍默认 single**，只买一次（旧行为一字不变）。
  - 只有**明确预算表达**才进比例预算：全部/all-in/尽可能多 → `fraction=1`；一半 → `0.5`；四分之三/75% → `0.75`。
  - 通用预算抽象——**ammo/intel 以后走同一结构**，绝不新增 `buy_all_xxx`。
- **结构：** `tradeBudget?: { mode: "single" | "fraction_of_money"; fraction?: number }`（intent + order 各加一个可选字段）。
- **明确 deferred（别现在做）：** `fill_to_target`（「把 fuel 补到 N」）模式**不在 7b.1**——当前本步只做 `mode = single | fraction_of_money`。标 deferred，免得有人提前穷举 mode。
- **执行规则（引擎，`executeTrade`/`handleEconomyOrder`）：** `single` 沿用现状执行一次；`fraction_of_money`：clamp `fraction∈[0,1]` → `budgetMoney = money*fraction` → `times = floor(budgetMoney / TRADE_COSTS[type].cost)` → `times<1` 反馈资金不足，否则执行 times 次等价交易；diagnostic / Emily 回报显示**实际花费 / 实际购买量 / 剩余 money**。
- **资源上限（实现前必查）：** 先确认 `resources`（fuel/ammo/intel）是否有 cap/上限。**若有上限，`fraction_of_money` 不能为了花完预算白烧钱**——`times` 还要被「到上限所需份数」再夹一刀，**买到上限就停**，Emily 回报「买到上限了，剩余资金保留」。若无上限，按上面 `times` 直执行。
- **命门小授权（明确、最小、加性、仅 trade）：** 本步**仅**允许对 trade 这一条做加性改动——`intents.ts`+`types.ts` 加可选 `tradeBudget`；`schema.ts` clean/校验该字段（缺省即 single）；`ai.ts` 加**仅 trade 预算**的解析说明（不动其它意图/否定/地名/Chen 人设/RULES）；`tacticalPlanner` 把 `intent.tradeBudget` 透传到 order。**不碰** 其它 intent、目标解析、produce、战斗/移动、7b director gate。
- **必跑回归（命门触碰必查）：** 普通「买 fuel」「造坦克」「一条进攻命令」行为同改前；命令解析准确度/延迟/双模型不退。
- **通过：** 三种预算表达正确执行 + Emily 报实花/实得/实余；普通 trade 与其它命令零变化；无回归；typecheck 绿。
- **完成：** commit + tag `step7b1-trade-budget`。

### 7c — 结构化事实 → LLM voice（替掉固定模板，不是堆模板）｜风险：中
> **本节为 Codex 复审后重写版。** 旧 7c 只讲「主动发声节奏」，未点出根因：玩家可见话术仍由引擎固定字符串生成。

- **根因（Codex 复审新增）：** Chen 像愣头青，根因**不是 prompt 不够好**，而是 6a 的 `escalateCrisisToConversation` 用**一套固定防守模板**套所有危机——我方正在敌后进攻时它也问「死守、后撤，还是抽人」，出戏。这套固定模板本质是**场景反应穷举**：危机 → 默认我方防线快失守 → 套「死守/后撤/抽人」。它不是关键词穷举，但同样把战场语义压扁。
- **头号红线：不要从「1 个固定模板」变成「5 个固定模板」。** 不做「防守模板 / 进攻模板 / 后勤模板 / 佯攻模板 / 据点模板」这种**模板堆叠**。要从**模板系统**转成**结构化事实 → LLM voice**。
- **目标：** 玩家可见话术**不再由引擎固定字符串生成**。引擎只提供**结构化事实 + safety gate**；LLM 据 facts + stake + persona + 最近上下文写自然人话。两个出口都改：(1) **escalation 问句**（替掉 `escalateCrisisToConversation` 的固定模板）；(2) **主动 beat 发声**（原 7c「重启门控 heartbeat」并入此处：`GameCanvas.tsx:1399` 的 `channels=[]` 换成 director 门控，复用 `heartbeatState`/combat window；beat 过阈值才说，无 beat 静默）。
- **铁律不变：** beat 永远由引擎 `selectDirectorBeat` 选定；是否/何时问由引擎 safety gate（见 7d）判定；**LLM 只 voice——不造事实、不选 beat、不决定 safety、不决定自动调兵**。
- **7c voice 输入（结构化 facts，来自 7a beat + 6a 关联，绝不喂全战场）：** `kind` / `stake` / `frontId`+`frontName` / `estimatedCollapseSeconds` / `freeReinforcement` / `metric`(engagement/powerRatio/trend) / event type / 最近 player intent / 最近 escalation 上下文。
- **stake/kind 必须影响语义，但不靠模板穷举：** stake = `player_defense` / `player_attack_under_pressure` / `contested_objective` / `unknown`；kind 另含 `supply_strain`(Emily) / `feint_suspicion`(Marcus)。**kind 定领域+人格，stake 细化攻防/争夺语义**——LLM 据此选词，不走 if-模板分支。
- **grounding facts（7c 真正的难点，Codex 复审新增）：** 7c 的风险是把「固定模板的错」转成「LLM 泛泛而谈的错」——只给抽象字段 + 语气指南，LLM 仍会滑回战争片腔/空泛口号。**对治：每个 beat kind 喂 LLM 前必须带 2-3 个具体 grounding facts，具体到「泛泛措辞不可能」**：
  - `front_collapse` / `cross_front_dilemma`：front 名、`stake`、`estimatedCollapseSeconds`、`freeReinforcement`（谁 / 几人）、`powerRatio` + trend。
  - `supply_strain`：fuel/ammo 当前值、最近消耗趋势、**还够几次大机动 / 哪类行动已受限**。
  - `feint_suspicion`：loud front、massing front、**可见敌军计数**、为什么这不是纯猜（证据是什么）。
  - `contested_objective`：facility 名、`captureProgress`、敌军 / 接触证据、**丢了的真实代价**。
  目标：让 LLM 没有退回空泛口号的余地——它只能围绕这几个具体数字 / 名字说话。
- **voice 通道：** 走现有 `/api/brief`（或一个只 voice 的小端点），**只喂「beat 聚焦的迷你 facts」（一件事）**；**绝不**喂全战场、**绝不**碰命令解析 `ai.ts` SYSTEM_PROMPT 中段/RULES。voice prompt 是**独立的 brief prompt**，与命令解析命门隔离。
- **语气原则（风格标尺，非行为规则）：** 不要 AI 腔；不要产品化二选一；不机械「要么 A 要么 B」；不喊口号；**不要把所有情况都说成「告急/失守/死守/后撤」**。像靠谱作战参谋/军官：短、具体、基于事实、点一个真实代价，只在真需要玩家决断时问一句。**可给少量 tone examples 当风格参考，但 examples 只能是风格标尺，绝不能变成行为规则或字符串匹配**（否则又退回穷举）。
- **不碰：** 命令解析命门（`ai.ts` SYSTEM_PROMPT 中段/RULES、`schema.ts` intent、`tacticalPlanner` 目标/intent 语义）、引擎决策、自动调兵。
- **风险点：** 别退回「广播喇叭」（必须 beat 驱动、可静默）；别把模板从引擎搬进 prompt 里再穷举一遍。
- **mandatory golden scenarios（判 7c 是否真比模板好；Codex 复审新增）：** voice 不能像模板那样 diff，必须靠定场景**肉眼并排比**。至少跑这 4+1 个，每个都和**旧 6a 模板输出**对比：
  1. 我方进攻敌方据点、前锋承压；
  2. 我方防守据点被压；
  3. 据点正在被夺取 / 争夺；
  4. fuel/ammo 不足、无法继续大机动；
  5.（可选）疑似佯攻但有可见集结证据。
  **通过判据不是「更戏剧化」**，而是：**更具体、更贴 `stake`、更少 AI 腔、更少错误防守语义**（进攻场景不再被说成「死守 / 后撤」）。任一场景比 6a 模板更空泛 / 更出戏 / 防守语义更错 = 不过。
- **通过：** 同一危机在进攻/防守/争夺/佯攻/补给场景下话术**语义不同且贴切**、不再千篇一律防守模板、平静时安静、真需要才问一句、无 AI 腔；无回归；typecheck 绿。
- **完成：** commit + tag `step7c-structured-voice`。
- **拆分（2026-06-25 定）：** 7c.1 = escalation 问句改 LLM voice（已实现，bench 暴露问题见下「7c.1 稳定化」）；7c.2 = 主动 beat 发声（重启门控 heartbeat），**尚未做**。

### 7c.2 — 主动发声节奏（门控 heartbeat）｜风险：中 ⏸ 未开始
- **目标：** director beat 过阈值 → 对应人格按 combat/peace 节奏主动说一句；无 beat 静默。`GameCanvas.tsx` 的 `channels: Channel[] = []` 换成 director 门控，复用 `heartbeatState`/combat window。
- **🚩 产品约束（2026-06-26 定，Marcus ≠ 第二个播报员）：** Marcus **不逐条复述 report**。他作为参谋长，**只在多条暗色战报合成出全局态势时**发声：①同一据点被多次试探；②一条线吸引我军主力、另一条线敌军集结（佯攻）；③中央前哨/关键点被偷；④玩家刚做的决策造成侧翼空档；⑤多条 report 指向同一战略风险。**输入 = director 聚合后的结构化态势，不是原始 report 原文列表；输出 = 分析/判断/提醒，不是复述。** 同一窗口仍只允许**一个**主动打断（Chen 和 Marcus 不抢话）。要求 Marcus **筛选/合成/判断**，不要「每条暗色战报念一遍」。
- **完成：** commit + tag `step7c2-proactive-voice`。

### 7d — 决断闸（何时必问）｜风险：中
> **与 7c 的边界：** 7d = 引擎决定**是否/何时**问（deterministic safety gate）；7c = 问句**怎么说**（LLM 据 facts voice）。7d 只产结构化「该问」信号，话术交给 7c voice，**不自己拼模板**。
- **目标：** 扩 6a escalation 的 must-ask：油弹稀缺、佯攻怀疑、跨线取舍；其余只报 / 留 6b。
- **锚点：** 6a `assessCrisisEscalation` + `escalateCrisisToConversation`（其固定模板应已在 7c 被结构化 voice 取代）；新增判据走 director（deterministic），**不穷举字符串**。
- **不碰：** 撤退绝不自动（守不对称）；命门区。
- **通过：** 真两难 / 真稀缺才问、平庸事不黏人、不回 A/B/C 卡海；typecheck 绿。
- **完成：** commit + tag `step7d-decision-gate`。

### 7e — 决断复盘循环（1-2 分钟回指）｜风险：较高 ⚠️ **最后做，建议排在 6b 之后**
- **依赖排序（修正）：** 6b（Chen 自主增援 + 撤销）尚未实现。**7e 建议放到 6b 落地之后**——这样复盘既覆盖玩家决断、也覆盖 Chen 的自主动作（用同一套 `actionId`/correlation）。若 6b 一时不做，7e **也必须是 Step 7 里最后一步**，且初版只复盘玩家决断。
- **目标：** pending-review 队列（仿 6a 的 escalation 关联存储，keyed by `actionId`，存 front / 指标快照 + due time）；tick 到点比 delta → 人格回指 + 玩家反应入日志（同 correlation id）。
- **锚点：** 6a 的 `actionId` / `/api/log-event` / `escalateId`；新增 review 队列 + tick 检查 + **回指走 7c 的结构化 facts→LLM voice**（喂 delta 事实，不写固定回指模板——同 7c 反模板堆叠铁律）。
- **不碰：** 引擎决策（review 只读：结果 delta 靠引擎算，话术靠 LLM voice，**LLM 不编结果、不堆模板**）。
- **通过：** 决断后 60–120s 出准确回指、日志里决断↔结果↔反应用 id 串上；typecheck 绿。
- **完成：** commit + tag `step7e-decision-review`。

---

## 顺序（2026-06-24 定）

1. **先收口已通过的 Step 7b**（typecheck 绿、Codex 复审 + bench 过 → commit + tag）。
2. **Step 7b.1 — Emily 交易预算**（命门小授权，独立小步，回归必跑）。
3. **Step 7c — 结构化事实 → LLM voice**（替掉 6a 固定模板）。
4. 7d 决断闸 → 7e 复盘（7e 仍最后做，建议排 6b 之后）。

## 前置依赖 & 不碰区

- **依赖 6a（已合 main `c5107a4`）：** escalation + correlation，Step 7 全程复用。
- **6b（自动增援 + 撤销）尚未做：** 与 7a–7d 正交，可先做也可交错；**7e 应在 6b 之后**（见上）。**6b vs 7e 的最终定序由你拍。**
- **不碰区（同 `改造WORKPLAN.md`）：** `apps/server/src/ai.ts` SYSTEM_PROMPT 中段 + RULES/DOCTRINE、`packages/shared/src/schema.ts` intent 清洗/校验、`packages/core/src/tacticalPlanner.ts` 目标/intent 语义、已验证的命令解析 / 延迟 / 双模型。
  - **唯一已授权的命门小例外 = Step 7b.1：** 仅对 **trade 预算**做加性改动（可选 `tradeBudget` 字段 + 仅 trade 的解析说明 + 透传），缺省=single=旧行为，必跑回归。**其余命门一字不动；7c 的 voice 走独立 brief prompt，不进命令解析命门。**
- **Step 7 头号陷阱（两条，都是「穷举压扁语义」的变体）：**
  1. **director ≠ 每几秒把战场喂 LLM 让它决定。** 选 beat、判取舍、算复盘结果永远在引擎（纯函数 + 死规矩）；LLM 只 voice 那一句。
  2. **固定模板 = 场景反应穷举。** 「危机→默认我方失守→死守/后撤/抽人」是把战场语义压扁的模板法；治它**不是堆更多模板**（防守/进攻/后勤/佯攻/据点），而是**结构化事实 + stake → LLM voice**。行为不对就写语义原则（1-2 行）或加结构化字段，**绝不写中文命令/战报/话术字符串清单，也绝不把模板从引擎搬进 prompt 再穷举一遍**——清单永远收敛不了。
