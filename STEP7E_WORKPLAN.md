# Step 7e — 战斗中决策复盘 / 决策后果记忆（workplan，2026-07-04）

> **状态（2026-07-04 完结）：** 7e.1 全部完成，Codex bench PASS。worktree `.claude/worktrees/step-7e-decision-retrospect`（基于 main `d9007e7`），commit 链：`849d287` (7e.1a core) → `3cbd221` (7e.1b record+observe) → `f31baf7` (7e.1c voice)→ `4fcbd70` (锚点修复，R1 手测 PASS)，tag `step7e1a-review-core` / `step7e1b-review-observe` / `step7e1c-decision-retrospect` / `step7e1-anchor-fix`，未合 main。实现期修正：类型进 shared 非 core；两个 scenario 都初始化；handleThreadApprove 明确不记录；"resolved assigned units" 命名（applyOrders 未动）；Marcus 路由仅用跨线事实；escalateId 经 ExecContext 透传全部四条批准路径。Codex 两轮 blocker 修复：question-block 需 STICKY per-record grace（180s > escalation TTL 120s，`questionBlockedRecordIds` Set），否则问句解除瞬间 grace 缩回 60s 导致复盘在能发声那一帧被丢；log kind 记录 front+facility 双 outcome。
> **定位：** 玩家做了一个重要决定后，引擎在 ~90s 后用**结构化事实**判定这个决定产生了什么后果，由**引擎选定的一个人物**说**一句陈述式复盘**。不是战斗结束报告、不是 UI 面板、不是 6b 自动执行。
> **铁律（同 STEP7_WORKPLAN 头号陷阱）：** 引擎决定「是否复盘 / 何时复盘 / 谁复盘 / 复盘什么事实」；LLM 只把结构化事实说成人话。不做固定回指模板、不做关键词穷举。

---

## 1. 现状路径诊断（勾稽关系，全部已读源码确认）

### 1a. 玩家命令路径（执行路径）
```
ChatPanel.sendCommand (ChatPanel.tsx:1084)
  → buildDigestForChannel + ---CONTEXT--- + ---ACTIVE_ESCALATION---（若该频道有未答问句，ChatPanel.tsx:1156-1170）
  → POST /api/command-stream（fallback /api/command），带 { digest, message, styleNote, channel, sessionId, escalateId }
  → server ai.ts callAdvisorStream：channel=combat/logistics 走 SYSTEM_PROMPT（命门）；
    channel=ops 走 SYSTEM_PROMPT_MARCUS_V2 + coerceMarcusConsult → 永远 NOOP/options:[]（Marcus 结构上不能执行）
  → AdvisorResponse { brief, options[].intents, responseType, standingOrder }
  → ChatPanel.processAdvisorData (1189)：NOOP→只说话；options:[]→澄清；否则 canAutoExecute 安全闸 (256)
  → handleApprove (1447)：soft-fix → resolveIntent（tacticalPlanner）→ applyOrders (1531) → 建 TaskCard (1570-1605) → doctrine
```
**关键事实：`handleApprove` 里 `applyOrders` 成功返回处，是「玩家决策变成引擎状态」的唯一汇合点**——auto-execute、手动批准、high_impact 确认词、escalation 回应，全部走到这里。7e 的记录点就是它。

### 1b. escalation（must-ask 问句）路径
```
engine 信号（reportSignals actionRequired / checkDoctrines / advisorTriggers crisis_card / 7d director dilemma）
  → GameCanvas loop → escalateCrisisToConversation (GameCanvas.tsx:359)
    闸：topic 冷却 30s → 频道 inFlight → facility worthiness (director.ts:778)
       → 7d 全局问句预算：anyQuestionOccupied + 15s gap (GameCanvas.tsx:206-223)
  → 引擎产 mini-facts（frontEscalationFacts director.ts:690 / facilityEscalationFacts :735）
  → POST /api/brief mode="escalation"（ai.ts ESCALATION_PROMPTS :442，与命门隔离）
  → postQuestion：addMessage(urgent, command_ack) + setActiveEscalation{actionId, question}（messageStore.ts:341）
    + POST /api/log-event type="escalate" 带 actionId
```
玩家回应：sendCommand 读 getActiveEscalation → 带 `escalateId` 上报 + 问句喂回 context；
**清除时机（7e 关键）：** 玩家 decline 词即清（ChatPanel.tsx:1170）；**可执行回应（options≥1）在 processAdvisorData 清（:1246），发生在 handleApprove 之前**——所以 handleApprove 时刻已经拿不到 escalateId，需要经 ExecContext 透传（见 §6）。

### 1c. proactive（主动陈述）路径
```
GameCanvas loop 每 8s (proactive 块 :1767-1892)
  → collectDirectorBeats + snapshotForDirector（trend）
  → 7d：cross_front_dilemma ≤60s → 升级为 must-ask 问句（走 1b 同一入口）
  → 否则合并候选：Chen/Emily beats + Marcus collectStrategicSituations(recentReports)（director.ts:890）
  → 闸：本频道无未答问句 → topic 冷却（Chen/Emily 45s，Marcus 120s）→ 全局陈述预算 12s (proactiveBudget :175)
  → POST /api/brief mode="proactive"（ai.ts PROACTIVE_PROMPTS :472）
  → 只收陈述（带问号即丢弃 :1878）→ addMessage(info, source="proactive")
```

### 1d. 暗色战报路径
reportSignals.ts 每帧检测 → state.reportEvents → GameCanvas drainReportEvents(5)（:1650）→ addMessage(source="event_report") 进安静报告道；actionRequired 的经 7b selectEscalationEvent 只放一个去 escalate。Marcus 的聚合 buffer `recentReports` 也在这里喂（:1656）。

### 1e. ai.ts 里 voice 与命令解析的边界（7e 必须沿用的隔离模式）
- **命门（不碰）：** SYSTEM_PROMPT（:44-310）、SYSTEM_PROMPT_MARCUS_V2、GROUP_SYSTEM_PROMPT、CHANNEL_PERSONA——都在 callAdvisor/callAdvisorStream 命令解析链上。
- **voice 区（7e 加东西的地方）：** CHANNEL_PROMPTS（heartbeat 已休眠）/ ESCALATION_PROMPTS / PROACTIVE_PROMPTS + callLightBrief(mode)（:1030）+ index.ts /api/brief mode 分发（:203）。7c/7c.2 已建立「按 mode 加一组独立 prompt」的加性模式，7e 照抄这个形状加 `mode="retrospect"`。

### 1f. 现状缺口（7e 要补的）
- actionId/escalateId 关联只到「决策发出」为止：[EVENT] 日志有 escalate → command(escalateId)，**没有 outcome**。
- TaskCard（taskTracker.ts）只跟单位状态机（moving/engaged/holding→completed），**不含决策时刻的战场基线快照**，无法回答「这个决定让局面变好还是变坏、付了什么代价」。
- 没有任何「决策 → 延时 → 比 delta → 回指」机制。这正是 STEP7_WORKPLAN §⑤ 留给 7e 的。

---

## 2. 7e 记录哪些「玩家决策」（记录闸，防噪声第一道）

**记录点：** `handleApprove` 内 `applyOrders(state, allOrders)` 成功且 `allOrders.length > 0` 之后（ChatPanel.tsx:1531 后）。一次 approve = 至多一条记录（多 intent 合并为一条，取主锚点）。

**7e.1 只记两类（其余不记）：**
1. **escalation 问句的可执行回应**（ExecContext 透传的 escalateId 存在）——系统开口问过的决断，天然值得闭环，且优先级最高。
2. **有明确战场锚点的战斗类命令**：executed intents 里含 attack / defend / retreat / capture / sabotage，且能确定唯一锚点（intent.targetFacility → facility id；intent.toFront/targetRegion → findFront/region 命中 front；都没有 → 按 assignedUnitIds 派驻多数所在 front 兜底；仍无 → **不记录**），且实际派出单位数 ≥ 3（recon 单机、1 人巡逻这类不记）。

**明确不记（7e.1）：** produce/trade（Emily 的生产/交易复盘留 7e.2）、doctrine standingOrder（有自己的 breach 监控）、右键手操精英单位（applyPlayerCommands，微操非决策）、staff thread 批准（6a 后休眠）、group chat（本来就不执行）。

**记录内容（DecisionReviewRecord，存 GameState 新增数组字段）：**
- `id`（复用 makeActionId 风格）、`escalateId?`（若是问句回应）、`channel`（下令频道）、`createdAt`、`dueAt = createdAt + REVIEW_DELAY_SEC(90)`
- `kind`：executed intents 的主类型（attack/defend/retreat/capture/sabotage）
- 锚点：`frontId?` / `facilityId?`（二选一或都有）
- `assignedUnitIds`（去重后的实际派出单位）
- **基线快照（决策时刻，引擎算）：** 锚点 front 的 engagementIntensity、assessCrisisEscalation 的 tCollapse（沿用 director 的调用形状，crisisResponse 数学一字不动）、freshFrontPowerRatio；facility 的 team/captureProgress/hp；assignedUnitIds 存活数；全局 fuel/ammo/money；**其余各 front 的 {engagementIntensity, tCollapse 有限与否} 摘要**（Marcus 跨线判定用）
- 队列上限 4 条，满了丢最旧（防堆积）；每条只复盘一次。

---

## 3. 怎么判定「这个决策后来产生了什么后果」（引擎，纯函数）

到 `dueAt`，核心纯函数 `assessDecisionReview(state, record)` 用**当时快照 vs 现在**算结构化 delta，全部是可验证数字/名字，不写话术：

- **锚点 front：** engagementIntensity delta、tCollapse then→now（有限→Infinity = 稳住；变小 = 恶化）、powerRatio then→now、front 内我方存在与否。
- **锚点 facility：** team then→now（还在/丢了/夺下）、captureProgress、hp。
- **兵力代价：** assignedUnitIds 存活数 then→now（伤亡数/比例）。
- **资源代价（窗口事实，不假设全因这一单）：** fuel/ammo/money then→now delta。
- **跨线事实（Marcus 用）：** 快照里的其他 front，窗口内是否出现 keypoint/objective 丢失（对照 scenarioWinConfig）、或原本 tCollapse=∞ 的线变成有限。
- **中性 outcome 标签（同 stake 的做法——引擎给中性分类，不写「胜/败」话术）：** 按 kind 各给一个小枚举，如 front 类 `held / broken / eased / still_contested`、facility 类 `captured / lost / still_contested / unchanged`，加 `casualtyLevel: none/light/heavy`（阈值常数集中一处 TUNING，playtest 后调）。

**worthiness 闸（第二道防噪声）：** 至少一个显著 delta 才发声——(a) outcome 非 unchanged/still_contested，或 (b) 伤亡 ≥ heavy 阈值，或 (c) escalation 回应类（问过就该闭环，「顶住了」的正向 delta 本身就算显著：tCollapse 有限→∞）。全部不显著 → **静默丢弃记录**（沉默是默认，同 director）。实体消失（squad 全灭已清、front 找不到）→ 静默丢弃，不硬凑。

---

## 4. 谁复盘什么（deterministic 路由，一条记录只出一个人一句话）

| 人物 | 复盘什么 | 触发条件（引擎判，按此优先级取唯一一人） |
|---|---|---|
| **Marcus (ops)** | 战略取舍：你把力量押在 A，窗口内 B 线付了什么代价 / 赌对了没 | ① 该决策回应的是 DIRECTOR_DILEMMA / cross_front_dilemma 问句，或 ② 跨线事实非空（别线 keypoint 丢失 / 别线 tCollapse 由 ∞ 变有限） |
| **Chen (combat)** | 战斗结果：锚点守没守住 / 打没打下来 / 弟兄们伤亡 | 默认——kind 为战斗类且非 Marcus 情形 |
| **Emily (logistics)** | 资源/后勤代价：这一窗口油弹钱烧了多少、还剩多少 | 战斗 outcome 不显著（unchanged）但资源 delta 显著（如降幅 ≥30 或跌破 SUPPLY_STRAIN_THRESHOLD） |

**角色边界硬保证（结构上成立，不靠 prompt 求饶）：**
- 复盘走 `/api/brief` mode="retrospect" → 只回 `{brief, urgency}` → `addMessage`。**这条链路根本不经过 resolveIntent/applyOrders，谁也不可能执行命令。**
- 陈述不是问句：沿用 proactive 的守卫——LLM 输出带 `？/?` 直接丢弃（GameCanvas.tsx:1878 同款）。Marcus 因此**不可能**「问要不要派兵」。
- retrospect prompt 里给 Marcus 的是**语义原则一两行**（「陈述这次取舍的已发生代价与结果，不建议下一步行动、不发起任何决断问句」），不是禁词清单——守 `feedback_no_keyword_enumeration`。

---

## 5. 7e.1 最小实现范围（三个可独立 commit 的子步）

### 7e.1a — core 纯函数 + 类型（零行为变化）
- 新建 `packages/core/src/decisionReview.ts`：`DecisionReviewRecord` / `DecisionReviewFacts` 类型、`captureDecisionSnapshot(state, anchor, unitIds)`、`assessDecisionReview(state, record)`、`REVIEW_TUNING` 常数、`buildRetrospectMiniFacts(facts)`（结构化 key: value 文本，形状同 buildProactiveMiniFacts）。
- `packages/shared/src/types.ts` 加性：GameState 增 `decisionReviews: DecisionReviewRecord[]`（类型放 shared 或 core 视 import 方向定，倾向 shared 只放最小 record 形状）；`createInitialGameState.ts:263` 附近初始化 `decisionReviews: []`。
- director.ts 一行加性 export：`freshFrontPowerRatio`（或在 decisionReview 内自算同一公式——写码时二选一，倾向 export 复用唯一真相源，守 `feedback_treat_root_cause`）。
- 通过：typecheck 绿，游戏零可感知变化。commit + tag `step7e1a-review-core`。

### 7e.1b — 记录 + 到期判定，只输出 console（观测先行，仿 7a）
- ChatPanel：`ExecContext` 增 `escalateId?`（processAdvisorData 建 execCtx 处捕获，:1258）；handleApprove 成功后按 §2 闸记录进 `state.decisionReviews`。
- GameCanvas loop：proactive 块之后加 retrospect 扫描（节流 ~2s 一次）：到期 → assess → worthiness → **只 console.log 结构化 facts + 路由人选**，不发消息不调 LLM。加 `resetDecisionReviewState`（session/inFlight），挂进两处 reset 站点（:1148-1165 / :1195-1211）。
- 通过：手测一局，console 里决策→90s→facts/人选 全对（front 名、伤亡数、outcome 标签与棋盘一致），不值得说的决策正确静默。commit + tag `step7e1b-review-observe`。

### 7e.1c — voice 接通
- ai.ts 加 `RETROSPECT_PROMPTS`（combat/ops/logistics 三条，形状同 PROACTIVE_PROMPTS：结构化事实→一句陈述回指，共享一段 RETROSPECT_BASE；**不给例句**，同 7c 反模板铁律）；`callLightBrief` mode 联合类型加 `"retrospect"`；index.ts /api/brief mode 分发加一枝（:203）。
- GameCanvas retrospect 扫描把 console 换成：闸（该频道无未答问句 + `proactiveBudgetAllowsStatement` + 消费预算 + 一次 inFlight + session 守卫）→ POST /api/brief mode="retrospect" → 非问句才 `addMessage(info, source="retrospect")` → POST /api/log-event `type:"retrospect", actionId, escalateId?, outcome` 闭环日志。
- messageStore.ts 加性：`MessageSource` 联合加 `"retrospect"`（不进 isReportMessage 黑名单 → 渲染为人物说话）。
- 通过：§8 golden scenarios。commit + tag `step7e1c-decision-retrospect`。

**明确 deferred（7e.2+，现在别做）：** produce/trade 的 Emily 装备到位复盘；提前触发（锚点在 due 前就崩了立即复盘）；同一决策的二次追踪；玩家对复盘的反应再分析；6b 自主动作复盘（等 6b）。

---

## 6. 改动文件清单（7e.1 全量）

| 文件 | 改动 | 性质 |
|---|---|---|
| `packages/core/src/decisionReview.ts` | **新建**：类型 + capture/assess/miniFacts 纯函数 | 新增 |
| `packages/core/src/index.ts` | export 新模块 | 加性 |
| `packages/core/src/director.ts` | `freshFrontPowerRatio` 加 export（一行，或不动改为自算） | 加性 |
| `packages/shared/src/types.ts` | GameState 增 `decisionReviews` 字段 + record 最小类型 | 加性 |
| `packages/core/src/scenario/createInitialGameState.ts` | 初始化 `decisionReviews: []` | 加性 |
| `apps/web/src/ChatPanel.tsx` | ExecContext 增 escalateId 透传；handleApprove 成功处按闸记录（~30 行） | 加性，不动命令流程 |
| `apps/web/src/GameCanvas.tsx` | retrospect 扫描块（proactive 块之后）+ reset 挂载 | 加性 |
| `apps/web/src/messageStore.ts` | MessageSource 加 `"retrospect"` | 加性一行 |
| `apps/server/src/ai.ts` | RETROSPECT_PROMPTS + callLightBrief mode 扩展 | 加性，voice 区 |
| `apps/server/src/index.ts` | /api/brief mode 分发加 retrospect | 加性一行 |

## 7. 绝不碰清单（红线，一字不动）

- `ai.ts` 命令解析命门：SYSTEM_PROMPT、SYSTEM_PROMPT_MARCUS_V2、GROUP_SYSTEM_PROMPT、CHANNEL_PERSONA、RULES/DOCTRINE 段。
- `packages/shared/src/schema.ts`（intent 清洗/校验，整个文件）。
- `packages/core/src/tacticalPlanner.ts`（intent 语义/目标解析，整个文件）。
- `packages/core/src/applyOrders.ts`、`crisisResponse.ts`（决策数学）、`reportSignals.ts`（信号产生）、`taskTracker.ts`。
- director.ts 除上述一行 export 外不动：beat 选择、severity、7b 闸、7d 闸全不碰。
- escalation / proactive / question-budget 现有行为不动（retrospect 只作为一个新的**陈述**参与者共享既有预算闸）。
- 不恢复 A/B/C 卡；不加任何自动增援/撤退；不开始 6b；Marcus 永不进执行路径、永不发决断问句。

## 8. 风险 + bench 标准

**风险与对策：**
1. **变成新噪声源（最大风险）** → 三道闸：记录闸（§2，两类 + ≥3 单位）、worthiness 闸（§3，无显著 delta 静默）、发声闸（全局陈述预算 + 问句让路 + 队列上限 4 + 每决策一次）。bench 里专设「安静场景不说话」用例。
2. **归因错觉**（资源窗口 delta ≠ 全因这一单）→ 引擎只给「窗口内」事实字段；RETROSPECT_BASE 写一行语义原则「只陈述窗口内已发生的事实与代价，不推断因果链之外的东西」。
3. **LLM 滑回模板/问句** → 不给例句；问号丢弃守卫；每次换说法要求同 proactive。
4. **stale 实体**（squad 全灭被清、facility 引用失效）→ assess 全部从 live state 现查，查不到静默丢弃。
5. **restart 竞态** → reqSession 守卫（照抄 proactiveDirectorState 模式）+ state 换代时 decisionReviews 随新 GameState 自然清零。
6. **worktree 陷阱** → packages/* 改动需本地 node_modules 软链（`reference_worktree_workspace`）；`npm install` 后 `git checkout main -- package-lock.json`；只暂存该步文件，永不 add `.github/`。

**bench（7e.1c 通过判据，每子步 typecheck 绿 + 手测 + commit/tag，一步一停）：**
- **G1 问句闭环：** escalation 问「X 线吃紧」→ 玩家派援 → ~90s 后 Chen 一句陈述回指，front 名/伤亡数/守住与否与棋盘一致；[EVENT] 日志 escalate → command(escalateId) → retrospect(actionId) 三段可串。
- **G2 主动进攻：** 玩家命令攻某 facility → 打下/没打下 两种结局各测一次，Chen 事实正确、无防守腔（stake 语义沿用）。
- **G3 跨线取舍：** 回应 dilemma 问句抽兵救 A、窗口内 B 线丢 keypoint → **Marcus** 出声且是陈述取舍（无问号、不提议派兵、不执行任何东西）。
- **G4 正确沉默：** 派 1-2 单位侦察、或决策后战场无显著变化 → 无复盘消息、console 显示记录被闸掉/静默丢弃。
- **G5 资源路由：** 战斗无进展但窗口油弹大跌 → Emily 出声报代价数字。
- **回归：** 普通命令解析/延迟/auto-execute 行为与改前一致（命令路径零改动，抽查 3-5 条命令）；escalation/proactive 频率无变化；G1-G5 中任何时刻不出现 A/B/C 卡、不出现自动调兵。
