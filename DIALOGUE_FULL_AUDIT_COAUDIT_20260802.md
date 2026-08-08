# 对话层全量审计 — 联审独立归因 + 与主审对账（2026-08-02）

> 联审窗口。审计对象：worktree `../AI Commander-approval-v4` @ `18e708a`。
> §3 必读清单 21 个文件 16,600 行**全文读完，零抽样**；另核 digestHelper.ts / intelDigest.ts /
> battleAwareness.ts / featureFlags.ts 及 `updateFrontPower`、`generateCrisisCard`、
> `findBestReinforcements`、`staffAskState.pendingByChannel` 的全部调用方。
> 声明：主审三分钟版摘要在开工前已进入本窗口上下文（用户贴的），完全盲评做不到；
> 补偿手段＝主审每一条 file:line 结论都独立到代码里重推核验，不采信任何未核验断言。
> 归因表先于读主审全文写成；§3 对账为逐条核验结果。诊断期零实施。

---

## 1. 我的六症状归因表（独立版，每条到 file:line）

### 症状 1a — 晚到候选从态势板漏出
- **病灶**：`commanderPresence.ts:120` 与 `:101` 两处裸调 `buildReinforceOptions(state, front).shown[0]`，
  不过 `filterLateCandidates`；对照组＝唯一装闸出口 `escalationTicket.ts:159-163`
  （`buildFrontEscalationWithTickets` 一次构建同喂 payload+铸号）。
- **:120（有钟行）必修**：同函数 `:111` 已算出互射钟 `t`，闸零成本。
- **:101（交战中敌情未明行）**：该分支 `ratio===null` → 无钟，按 `filterLateCandidates`
  合同（`frontEscalationPayload.ts:511-516`，clock=null 直通）本就不滤——要不要在敌情未明时
  干脆不荐援（或明示"以下推荐未经晚到过滤"）是产品裁定，不是遗漏 bug。
- **第五面（板子之外）**：`GameCanvas.tsx:366-370` proactive 播报的
  `idle_reinforcement_available: ${leaderName}, ${aliveCount} men` 出自**另一台机器**
  `findBestReinforcements`（`crisisResponse.ts:502-632` 经 `assessCrisisEscalation:857-862`）：
  晚到只是 timeScore −100 排序惩罚（`:541-542`），全晚到时仍取 candidates[0]；不看 assessment。
- **第六面（两位前审都要补的）**：设施升级 payload 的
  `idle_reinforcement_available: true/false`（`director.ts:795` ←
  `facilityEscalationFacts` `:807-818`）是**第三台机器**——全图**任一** idle 带枪单位
  （不限设施附近、无 ETA、无番号、无人数）即 true。且设施升级**从不铸号**
  （`GameCanvas.tsx:469` `withTickets = facFacts ? null : …`）——设施问句后的"可以"
  天然无 G 号可绑。同一个信封字段名 `idle_reinforcement_available` 由两台语义不同的机器喂。

### 症状 1b — 来得及的候选经咨询路径无把手
- 铸号唯一生产入口＝引擎主动升级（`escalationTicket.ts:150`）；咨询（NOOP）里的
  best_help 推荐天然无号。
- **加重项（绊索误杀）**：`ChatPanel.tsx:1289-1293` —— 无 pending 合同 + 无活跃升级时，
  `HIGH_IMPACT_CONFIRM_WORDS`（`:387`："确认/是/对/执行/同意/可以/行/yes/ok" 九词）
  在 LLM 之前被截胡，回 `NO_PROPOSAL_GUIDANCE` 罐头（`escalationTicket.ts:52`）。
  prompt 的 SHORT FOLLOW-UP RESOLUTION（`ai.ts:168`）对九词结构性死亡。
  带尾确认（"可以，派他们去"）不匹配词表、可活；裸确认全灭。
- 细分：best_help 若是**编制队名**（Blake/T5），带尾确认能走通（squad 名合法）；
  若是**未编组群标签**，带尾确认也死（撞症状 2 的闸）——群标签推荐两条路全断。

### 症状 2 — stale 警告死循环
- 问句承诺"确认要继续"：`ChatPanel.tsx:419-423`。
- 消费通道零登记：pending 合同只在 `reason==="high_impact"` 时登记（`:1569-1587`）；
  staleRefs 分支不登记。
- **终点一（升级仍活）**：`可以` 经 `:1272-1275` 打点后进 LLM（绊索不触发），信封里
  FRONT_JUDGMENT 仍推销该群（症状 1a）→ LLM 复写群名 → `detectStaleSquadRefs:222-267`
  再命中 → `:422` 同句复读。死循环。
- **终点二（无升级在场，主审未列）**：绊索直接吃掉"可以"，回"我这儿没有待批的方案"——
  机器上一句刚问"确认要继续？"，下一句否认有任何待批事项。**问完自我否认**，比循环更瘆人。
- 措辞病：`:249-252` 把"从来不是编制的群标签"与"曾在编现全灭"混为一类，统一说"已不在编"。
- **接线的法理约束**（给手术单 B1 的裁定材料）："确认要继续"在现行家法下**语义上不可兑现**——
  fromSquad 解析失败必须响亮拒绝（`:1878-1887`，dispatch-scope-v1 裁定），"继续"要么
  静默放宽（74/85 家族，已立法禁止）要么无事可执行。唯一合法修法是改问句只问"另指部队"
  （或披露式"去掉该队执行剩余部分？"）——不是接线问题，是承诺本身违法。

### 症状 3 — 战况播报谎报交火
- **POSITION_CRITICAL**（`reportSignals.ts:476-489`）：模板断言"快顶不住了——正承受重火力"；
  触发实测＝① HP 质量比 `localPlayerHp/localEnemyHp < 0.3`，敌方**不过雾**
  （`:437-449` 无任何 fog 检查，雾外集结全进分母）；② "接战"＝`engagementIntensity>0.3`
  （EMA，双方都算，battleAwareness.ts:277 拖尾）**或**任一 attack_zone 圆与前线 bbox
  相交（`:458-474`）——邻线战斗的圆蹭到本线粗框边缘即成立。
  注释说 60s 冷却（`:131`），代码 30s（`:476`）。
- **UNDER_ATTACK**（`:176-216`）：任一单位一帧内掉任意 HP → 整线"遇袭，正在接战"，
  30s/front 循环；一发雾外炮弹足够。
- 放大链：事件行直进屏（`GameCanvas.tsx:1779/1801`）+ UNDER_ATTACK 触发 llm_advice
  让陈拿 `[事件]\n\n全digest` 复读（`advisorTrigger.ts:54-59` + `GameCanvas.tsx:1814-1833`）。

### 症状 4 — LLM 台词自相矛盾（主根＝信封多套账）
- **"战力比"四种定义并存**：
  ① `freshFrontPowerRatio`（DPS 比、过雾、新鲜）`director.ts:185-205`
  → FRONT_JUDGMENT ratio / mood / 升级 local_power_ratio；
  ② digest FRONTS OurPwr/EnemyPwr（(hp/maxHp)×DPS×10、过雾、**只在 buildDigest 刷新**）
  `intelDigest.ts:17-60`；
  ③ POSITION_CRITICAL "战力比 X%"（HP 比、**不过雾**、每帧）`reportSignals.ts:454,483`；
  ④ doctrine "敌我力量比 X:1"（②的滞后字段、方向倒置）`doctrine.ts:65-93` ＝
  battleContext FRONT_BALANCE 档位（`battleContext.ts:13-31,121-131`）同源。
- **滞后实锤**：`updateFrontPower` 只在 `buildDigest`（`intelDigest.ts:74`）跑；heartbeat
  已停（`GameCanvas.tsx:2131` `channels: Channel[] = []`）。**精确化（主审未写足）**：
  ops 路由走 BattleContextV2（`digestHelper.ts:26-28`），V2 **不调 updateFrontPower**——
  跟 Marcus 说话本身永不刷新他读的字段；只有对 Chen/Emily 下令或 llm_advice 才搭上便车。
- **第五套账（新增）**：所有 spoken survival 秒数出自 `estimateCollapseTime`——**不过雾**
  （`crisisResponse.ts:333-341` FOG-TODO 明示 enemyHP/enemyDPS 含看不见的敌军）。
  同一条 FRONT_JUDGMENT 行里 `survival≈Ns`（含隐身敌）与 `ratio=`（只算可见敌）**雾口径打架**；
  mood 门 ③（`commanderPresence.ts:213-219`）只挡了 ratio=null 的场合，可见 2 个+雾里 10 个时
  照样说"约N秒"。
- "艾登一人可增援"：squad 候选无人数下限（`crisisResponse.ts:521-565`；对照未编组池 `:595`
  强制 ≥2）→ bestCandidate/freeReinforcement → proactive minifacts（`GameCanvas.tsx:366-370`）；
  板子 best_help top-1 同病（机器 A 也无下限，1 人小队/1 人空间群可当推荐首选）。
- "第二未编组群→第三"：`frontEscalationPayload.ts:405-431` 罗盘序数按当帧组序分配，
  spatialGroups 每帧按活体位置重算——跨帧无身份（`escalationTicket.ts:21-26` 注释自认）。
- **prompt 债（次因）**：SYSTEM_PROMPT 陈段 ~50 行 enforcement（`ai.ts:47-98`）+
  user message 里 CHANNEL_PERSONA.combat 再注入一遍缩写版（`:687`），措辞已漂移；
  **具体自相矛盾一处**：`ai.ts:87` 明文教陈用 "---FRONTS--- 的力量对比…支持时间推断"
  （＝教模型拿滞后的②推时间），与 FRONT_JUDGMENT header 的"读引擎已算好的数"直接抵触。
  死字段 `Supply=OK` 每信封说一遍假话：`digest.ts:64` + `battleContext.ts:127`。

### 症状 5 — 播报轰炸
- 冷却矩阵：UNDER_ATTACK 30s/front、POSITION_CRITICAL 30s/front、FACILITY_CONTESTED
  30s/设施、HQ_DAMAGED 30s、SUPPLY_LOW 60s、doctrine breach 30s/warn 60s、
  diagnostics ~1Hz drain（`GameCanvas.tsx:1648-1663`）。
- report lane 明文不受任何预算管（`GameCanvas.tsx:184-185` 注释自认），嵌入面板与对话
  同滚动区内联（`ChatPanel.tsx:2151-2166`）。
- 同一事实最多三层：模板事件行 + llm_advice 全 digest 复读 + 升级问句/FRONT_JUDGMENT。
- 模板句逐字复读违「台词禁死模板」：`reportSignals.ts:213/408/483`。

### 症状 6 — 整体机械感（说话面双反）
- **LLM 真台词被抹**：流式 brief 在 options 到达时 `setStreamingText(null)`
  （`ChatPanel.tsx:1727`）；auto（`:1518-1520`）与 bucketA（`:1556-1561`）分支 brief 只进
  pushContext（`:1505-1507`）**从不 addMessage**。玩家眼睁睁看台词流出来再消失。
- **transcript 残留全是机器**：`VOICE_CONFIRMS` 罐头（`:84-101`，每人格 8 句轮换）+
  `执行: ${resolver log}`（`:1919`）+ 回执。
- **★罐头说的正是 prompt 禁的话（主审未点破）**：`VOICE_CONFIRMS.chen` ＝
  "收到。/明白。/这就办。/是，长官。…"——逐字命中 `ai.ts:51/88-89` ENFORCEMENT [A]
  和新增禁词表（"是，长官"/"明白"/"这就办"全在禁列）。引擎逼陈每次执行说一遍
  prompt 花几百 token 禁止他说的话。人格法典与引擎台词互相打脸。
- **人格台词降格成日志**：llm_advice 的陈播报以 `source="event_report"` 落地
  （`GameCanvas.tsx:1829`）→ `isReportMessage`（`ChatPanel.tsx:542-545`）→ 灰色小字报表行。
  机器话戴人格脸的通道：`messageStore.ts:123`（from 缺省自动补人格）。

---

## 2. 主审报告逐条核验结果

主审全部 file:line 断言**逐条到代码核验，无一虚报**。特别核过的硬断言：
七面互射钟全过（含 `director.ts:393` holds-continue 顺序）✓；`generateCrisisCard` 死路径
（全仓 grep 仅 index.ts 导出）✓；heartbeat `channels=[]` ✓；`staffAskState.pendingByChannel`
无写入方（整段 `GameCanvas.tsx:2092-2106` 死代码，/api/staff-ask 与 thread 机器全体休眠）✓；
`EVENTS(90s)` 生产调用全传 `[]` ✓；`updateFrontPower` 唯一调用点 `intelDigest.ts:74` ✓；
绊索/词表/stale 零登记/序数跨帧 ✓✓✓✓。

**§4 假设骨架的两个大修正我均独立复核成立**：三个钟已收口（多真相源在战力比不在钟）；
候选是两台机器多出口。

---

## 3. 分歧与补充（联审 → 主审）

无一条推翻性分歧；六条**扩展**、一条**主审报告内部矛盾**、两条**修法精化**：

1. **【补】第六个候选出口**：设施升级的 `idle_reinforcement_available` 布尔（第三台机器，
   全图任一 idle 即 true）+ 设施升级永不铸号（§1-1a）。A 刀断言表须从"五出口"扩成
   "六出口"；B 刀（可以接线）须覆盖"设施问句后的可以无号可绑"。
2. **【补】第五套账＝互射钟不过雾**：spoken survival 含隐身敌军，与同行 ratio 雾口径打架
   （§1-4）。并入 D 刀裁定：survival 是否切可见敌 DPS（数字会变乐观、雾中伏兵场景漏报），
   还是保悲观口径但措辞披露。这是 07-20"每个说出的数字指回可辩护字段"家法的未了账。
3. **【补】症状 2 终点二**：无升级在场时 stale 警告后的"可以"得到"我这儿没有待批的方案"——
   问完自我否认（§1-2）。B1 的验收必须两个终点都断言。
4. **【补】VOICE_CONFIRMS 与 prompt 禁词表逐字冲突**（§1-6）。E 刀不只是"降级罐头"，
   是解一个法典级自相矛盾。
5. **【补】Marcus 滞后精确化**：ops 路由不经 updateFrontPower，跟 Marcus 对话本身永不刷新
   FRONT_BALANCE（§1-4）。D 刀风险评估要按"最坏冷场时长"算。
6. **【补】`ai.ts:87` prompt 自相矛盾条目**（教用滞后 FRONTS 推时间）——G 刀里最该先拔的一根刺。
7. **【主审报告内部矛盾】**：手术单 B2 写"绊索放行咨询语境 **或** best_help 铸号——二选一"，
   但其症状 1b 段自述"无论选哪个都必须把绊索一起治，否则铸了号'可以'还是撞罐头"。
   后者才对（我独立推演同结论：铸号不产生 activeEscalation，绊索照样先吃掉裸确认）。
   **正解＝绊索必治为前提，铸号是叠加项，不是替代项**。B 刀措辞应改。
8. **【修法精化】A 刀人数下限**：主审只给机器 B 加 ≥2。病灶其实在**推荐面**（bestCandidate /
   best_help top-1 是"引擎替你挑的"）而非**列举面**（payload 列 "1units" 是诚实披露）。
   下限应作为"同一把尺"加在两台机器的推荐面上；列举面是否保留 1 人行披露，待裁。
9. **【修法精化】B1 唯一合法解**：见 §1-2 末——"确认要继续"违 dispatch-scope-v1 家法，
   问句必须改成只问"另指部队"（或明示"去掉该队执行其余"），不存在合法的"接线"方案。
   主审给的两选项里，"登记 pending 让确认执行"那一支应当废弃。

---

## 4. 待用户裁清单（联审汇总，含推荐立场）

1. **:101 无钟行**要不要在敌情未明时闭嘴不荐援？（推荐：改为披露式——荐可以，但行内注明
   无晚到判据；彻底闭嘴会让雾战场失去唯一援兵线索）
2. **1 人小队可否被推荐为 best_help/bestCandidate**？（推荐：推荐面两台机器统一 ≥2；
   列举面保留但必须带人数——现状已带）
3. **B2 选型**：绊索按上下文放行（裸确认 + 上一条是本人格带兵建议 → 进 LLM）vs
   咨询建议也铸号 + 绊索认号。（推荐：先放行——小刀，可被 V4_BARE_CONFIRM_EXEC 打点
   计数验证；铸号扩围是 v4.1 的大刀，等外测数据）
4. **互射钟雾口径**（上 §3-2）：可见口径 vs 悲观口径+措辞披露。（推荐：披露先行——
   一行措辞改动零执行牵连；切口径动的是每一个说出的数字，需要台架）
5. **B1 问句改法**：只问"另指部队" vs 增加"去掉该队执行其余"选项。（推荐：前者，最小惊讶）
6. **heartbeat 复活与否**（H 刀前提）；**doctrine 阈值 2.5/1.5 重标定时机**（D 刀内 or 独立）。

---

## 5. 手术单结论

主审八刀（A-H）的**排序我全部同意**（A/B/C=P0，D=P1，E=P1，F/G/H=P2），修改意见仅限：
- A 刀：断言表五出口 → **六出口**；人数下限按 §3-8 改到推荐面、两台机器一把尺。
- B 刀：B2 "二选一"改为"绊索必治 + 铸号可选"；B1 收敛到"改问句"一条合法路；
  验收覆盖症状 2 的**两个**终点。
- C 刀：不变（我核验的触发机制与主审完全一致）。
- D 刀：范围加一项——互射钟雾口径裁定（§3-2）+ Marcus 最坏冷场滞后（§3-5）。
- E 刀：理由加码——VOICE_CONFIRMS 与禁词表逐字冲突（§3-4），此刀顺带解法典自相矛盾。
- G 刀：具体化第一刀＝删 `ai.ts:87` 的"用 FRONTS 推时间"指引。
- H 刀：不变，全部核实。

—— 联审，2026-08-02。零实施；六症状归因与主审收敛，无待辩分歧，仅余 §4 六项待用户拍板。

---

## 6. 用户核后裁定（2026-08-02 第二轮，已收敛）

用户核了一遍，四刀方向确认，五条意见+一条补充，裁定如下：

### 6.1 A 刀出口账本定稿（用户硬意见一，双方各对一半）
- **battleBoard 出口不装、也不用装**（用户对；两份审计原判"观察行合规"一致）：
  `buildReinforceOptions(state, null)` 无战线上下文 → anchor=null → 行内无 ETA，
  说不出"N 秒能到"，过滤器无从下手。按"六出口都装"施工＝造新复杂度，禁止。
- **但"只补两处"漏账**（用户只数了机器 A 的调用点——恰是本次事故原形）：
  - **必装第三处＝proactive 播报**：`findBestReinforcements` 晚到只扣分不淘汰
    （timeScore −100，全晚到时仍取 candidates[0]）→ bestCandidate → 播报
    `idle_reinforcement_available: 名字, N men`，指名道姓推销来不及的兵；
    附带后果：存在任一（哪怕晚到的）候选即把 dilemma（必问）翻成
    safe_reinforce——**废候选压掉该问的问句**。钟与 tArrive 该机器内现成，闸可装。
  - **设施布尔降 P1**：不报数字不报时间，改话术/加距离限定即可，不进 P0。
- **定稿：装闸三处（commanderPresence:101/:120 + proactive bestCandidate），
  设施布尔一处改话术（P1），board 零处。**
- **一人残兵禁令从 A 刀拆出**（用户软意见①）：是设计变更不是修 bug，单独议，
  不与 P0 回滚绑定。

### 6.2 C 刀联测铁律（用户硬意见二，结论全收、机制修正一处）
- 机制修正：C 刀改的是 reportSignals 的 POSITION_CRITICAL **HP 账**，不碰
  crisisResponse 的 tCollapse/互射钟（两本独立账——又一"多套账"证据）。
  叠加方式＝两个独立减话闸门同向拧（C 刀砍升级最大候选来源，诚实闸砍打赢时的升级），
  不是同一个数变两次。
- **验收三件套，缺一不过**：
  ① 雾外集结无交火场景 → 断言不响（负对照）；
  ② 真崩线场景 → 断言 POSITION_CRITICAL 照响 + 升级问句照升（正对照，
  即"同时压住两个变化"的那条断言）；
  ③ 整局每分钟发声次数改前后对比，定发声底线（防失声）。
  C 刀与已上线的互射钟诚实闸**不得各自"一刀一测全绿"分开验**。

### 6.3 其余裁定
- **刀序硬约束**（用户软意见②）：刀 1 合并之前刀 2 不许开测——"可以"放行放大的是
  未修的刀 1 之毒（更顺畅地执行来不及的方案）。
- **拍板题①定案**（用户软意见③，理由升级）：互射钟雾口径**不动数字只改措辞**。
  强理由：`estimateCollapseTime` 一处扫描同时喂报警钟（tCollapse）与说话钟（exchange），
  动一处两钟齐漂，变化不可归因。
- **绊索归因**：用户自认第二刀（绊索九词截胡）为其上轮所写；病根＝"日常建议 ≠ 在案升级"
  在代码里不可区分。修法不变（B 刀）。
- **★sprint 收口验收（用户补充，此前两份报告均未列）**：四刀只是通向那一格的路，
  「陈提议 → 玩家裸说"可以" → 那批兵开拔」全链从未在活人手里跑通过。收口＝活人局里
  升级触发 → 裸"可以" → **数 assignedUnitIds + 核落点**（家法：会动兵的验收必须数兵）。
  计数器已在案：`V4_BARE_CONFIRM_EXEC` 打点。

---

## 7. 主审签核（Fable，2026-08-02 第二轮）——同意开工，附三个施工钉子

§6 裁定逐条对代码复核通过，可开工。用户硬意见一的机制账验证成立：
`assessCrisisEscalation` 分类＝`bestCandidate ? safe_reinforce : dilemma`
（crisisResponse.ts:861-862），不看 assessment——废候选压掉必问问句属实。

**施工钉子（工单必抄，防刀造歪）**：
1. **:101 的闸喂 null 钟**：该分支 ratio===null，但 `estimateCollapseTime` 不过雾、
   机械上能给出含隐身敌的秒数——禁止把它接进 :101 的过滤器，否则雾中敌情经候选
   名单形状泄露（mood 门③同族漏洞）。:101 装闸＝统一走一把尺，行为零变化是设计如此。
2. **机器 B 晚到判据用互射钟**（`a.exchange.spokenSeconds`），不用候选行自带的悲观
   tCollapse——两台机器的闸必须同钟，否则修"多套账"的刀里再造一套账。
3. **机器 B 的闸装在 assessCrisisEscalation 一处**：bestCandidate / kind / freeReinforcement
   三个消费者一次全喂，不在 GameCanvas 消费点分装。

**两笔预期账（外测判读用）**：
- A 刀装闸后废候选局翻回 dilemma → 必问问句有一笔**预期上行**，与 C 刀下行对冲；
  验收③的发声底线量的是净数，对照跑须同剧本同种子、在集成构建上量。
- 残兵禁令拆出后，**按时到达的一人残兵仍会被推荐**（晚到闸拦不住）——外测再见
  "艾登一人"不是回归，是排队待议的设计题。

**范围备注**：§6 未写死第四刀身份；主审按 §5 排序理解为 D（战力比统一）。若本 sprint
不含 E（抹台词+罐头确认），症状 6 最大单项仍在外测手感里，勿误记为新刀回归。

---

## 8. 联审复核（第三轮）——三钉子核验通过 + 四刀身份定案

### 8.1 §7 三钉子逐条核验：全部成立，补一条覆盖率实证
1. **:101 喂 null 钟 ✓ 且必须写死**：该分支 ratio===null，而 `frontCollapseSeconds`
   走 `estimateCollapseTime`（crisisResponse.ts:333 FOG-TODO 不过雾）。接进去 → 候选
   名单因隐身敌军变短 → **雾情经名单形状泄露**（mood 门③同族）。装闸后
   `filterLateCandidates(result, null)` 原样返回（frontEscalationPayload.ts:515），
   今日行为零变化＝设计如此，不是没装上。
2. **机器 B 用互射钟 ✓**，补边界：`exchange.holds===true` 时 spokenSeconds=null → 不滤，
   与 filterLateCandidates 合同同构，不会出现"打赢反而滤光候选"。
   取数零成本：`assessCrisisEscalation:842` 本就同时解构 exchange。
3. **装 assessCrisisEscalation 一处 ✓，补覆盖率实证**：`findBestReinforcements` 的
   **活调用点全仓仅 crisisResponse.ts:857 一个**（generateCrisisCard 死路径；
   core/index.ts:26 仅导出；apps 层零引用）。装此一处＝机器 B 全流量覆盖，无第二漏口。

### 8.2 预期账补充：dilemma 上行是双份的
kind 翻 dilemma 后不只 severity 0.6+→0.8+，还**获得 7d must-ask 升级资格**
（≤DILEMMA_MUST_ASK_SEC=60s 的 cross_front_dilemma 从播报升为问句，
GameCanvas.tsx:1862-1879）。上行幅度大于直觉，验收③净数对照须同剧本同种子。

### 8.3 ★四刀身份定案：A / B / C / **E**（不是 D）
本窗口给用户的说人话编号原文：一＝候选闸(A)、二＝"可以"接线(B)、三＝播报诚实化(C)、
**四＝「让活人说话，别让机器冒充」(E)**、"顺手的第五刀"＝战力比统一(D)。
用户答"四刀都该修"时五条意见只点刀1/刀2/刀3，未改编号 → **记录上的四刀＝A/B/C/E**。

**故 §7 范围备注方向相反**：留在外测手感里的风险项是 **D**（战力比四套账 → 症状 4
自相矛盾数字），不是 E。且 D 已部分裁定（§6.3 互射钟雾口径＝改措辞不改数），
状态为"部分裁定、整体待排"，非"未议"。**外测若再见同分钟两个打架的比值，
不是回归，是 D 未做。**

—— 联审第三轮，2026-08-02。零实施。四刀（A/B/C/E）+ 三钉子 + 收口验收已全部钉死，
待用户一句确认即可开工；D 的排期是唯一未决项。

---

## 9. A 刀施工记录（2026-08-02，分支 approval-contract-v4）

### 9.1 落地内容（生产代码净改 4 行逻辑，其余为注释）
- `commanderPresence.ts` 两处调用点包进 `filterLateCandidates`：
  有钟行喂 `Math.round(t)`（与该行印出的 survival≈ 同一个数）；
  无钟行喂 `null`（钉子①：**禁**接不过雾的秒数，否则雾情经名单形状泄露）。
- `crisisResponse.ts` `assessCrisisEscalation` 装闸一处（钉子②③）：判据
  `Math.round(exchange.spokenSeconds)`，`tArrive` 非有限值视为"缺数不判决"直通；
  bestCandidate / kind / freeReinforcement 三消费者一次全喂。
- **未做**（按裁定拆出）：一人残兵禁令、设施布尔话术、battleBoard（零处）。

### 9.2 验收
typecheck 4 包过；12 个 bench 全绿；`--negctl` 下 A 刀 4 条 ★ 真 FAIL（承重确认）。
bench 断言写成**出口枚举表 + 源码扫描不变量**（`CANDIDATE_FACES`，键＝文件+符号+第几处，
**不用行号**——行号会因上方加注释而漂，是噪声不是信号）：新增任何未登记出口 → TA1 直接 FAIL。
含钉子①专项守卫 TA14：同一局有/无隐身敌军，无钟行必须**逐字相同**（若有人把不过雾的钟
接进 :101，此断言立刻炸）。

### 9.3 回归测试的合同变更（deliberate，非改绿）
`ab-commander-presence` A7/A8 原本断言"板子 best_help == **未过滤**的 V1b top"——
那正是本刀砍掉的行为（该局只剩 3 秒，谁都赶不到）。改写为"== **过闸后**的 top，
空集则该行一个字不提增援"，并加 A6b 防空转前置（本局必须真有候选被拦下）。
原性质（同一 builder、同一排序、不改名不重排）未放松。

### 9.4 ★新账：机器 B 的 ETA 仍锚在几何中心（刀1 只修了机器 A）
`findBestReinforcements` 的 `tArrive` 量到 `frontCenterPos`（crisisResponse.ts:510/533），
而机器 A 早在 v4 刀1 改用 `battleAnchorFor`（frontEscalationPayload.ts:356）。
即 **刀1 修的"承诺量到战斗点不是几何中心"只覆盖了一台机器**——7-22 事故档记录的
同一现象（中心 (263,96) vs 实战 (360,105)，差 97 格）在机器 B 里原样存在。
后果：A 刀的晚到判据在机器 B 上是拿一个可能偏差近百格的距离在判"来不来得及"。
不属 A 刀范围（A 刀＝诚实闸，不是锚点），**单独记账待议**；修法极小
（:510 换 `battleAnchorFor`），但会动 timeScore 排序与 assessment 分级，需台架。

### 9.5 状态
未提交，未 tag——按家法等用户手测。手测看点：陈不再推荐赶不到的援兵；
原本被废候选压掉的"要不要抽兵"问句会**变多**（预期上行，非回归）。

---

## 10. 手测第一局结果（2026-08-02，web:3009）

### 10.1 刀1 自身：负对照过，主看弱通过，但发现一个漏判的洞
- **负对照 PASS**：陈仍然照常点名部队（02:53 / 03:03 主动说出"东北方向第一未编组群，
  6 辆主战坦克"），**没有砍过头**。
- **主看 弱通过**：02:23 玩家问"有没有可支援部队"、中央战线只剩 ~6 秒时，陈答
  "只有 Blake 一个步兵连"——**没有推销远在东北的那支**。与闸的预期一致，但属旁证。
  硬证据仍是 `--negctl` 四条 ★ 真 FAIL。
- **★漏判的洞（我判错了一处）**：01:12 的 llm_advice 里陈说"我方 Aiden 及东北方向
  第一未编组群可支援"——那支当时同样赶不到。**闸关掉的是引擎的推荐，关不掉 LLM
  自己的眼睛**：板子 ---UNASSIGNED_UNITS--- / ---SQUADS--- / ---FORCES--- 全在信封里，
  陈可以自己挑人推荐，且**不带任何 eta**。
  §6.1「board 零处」的裁定对**ETA 谎报**成立（该面结构上说不出秒数），对
  **不可行动的推荐**不成立——那面推荐得出来，只是不带数字。
  修法不在闸层（板子 front-agnostic，算不出 per-front eta），只能在 prompt 层加一条
  语义原则：**荐援兵只用 FRONT_JUDGMENT 的 best_help；板子上的群是观察对象不是候选**。
  归 G 刀（prompt 债），但优先级应从 P2 提到 **P1**——它是症状 1a 的另一半。

### 10.2 ★★最重发现：承诺 6 辆、实派 1 个、坦克一步没动（收口那格首次真实失败）
手测现场（03:02-03:11）：
```
玩家：附近不是有一队6主战坦克的部队吗
陈  ：长官，您说的是东北方向第一未编组群，6辆主战坦克。
玩家：派他们去部可以吗？   →   陈：您指的是…6辆主战坦克吗？   →   玩家：是的
陈  ：执行: 1 个单位前往3. 中央战线设防        ← 机器日志（真话）
陈  ：是，长官。 6辆主战坦克增援中央战线        ← 人格罐头（假话）
```
用户观测：**坦克没有动。**

**台架复现（数 assignedUnitIds，不读台词——家法）**，同局：中央战线内 2 名幸存者 +
线外 6 辆主战坦克，喂 LLM 在"群标签无合法把手"时最可能产出的四种 intent：

| 形态 | 实派 |
|---|---|
| ① `defend` + `toFront=中央战线`，无 fromSquad、无 quantity | **2 个原地幸存者，东北坦克 0** |
| ② 同上 + `quantity=6` | **2 个原地幸存者，东北坦克 0** |
| ③ 同上 + `quantity="all"` | 8 个（含 6 辆坦克）✓ |
| ④ `fromSquad="东北方向第一未编组群"` | 0，响亮拒绝「无法找到分队」 |

**病因链（坐实）**：群标签不是合法 fromSquad → LLM 退回 `toFront` 兜底 →
`resolveSourceUnitsRaw` 的 toFront **就近优先**分支（tacticalPlanner.ts:1582-1600）
把源池取成**目的地已有的部队** → 「增援中央战线」执行成「中央战线的最后幸存者原地设防」，
承诺的 6 辆坦克从未进入源池。`quantity=6` 也救不了——池子里根本只有 2 个。
**唯一能歪打正着的是 `quantity="all"`**（触发 wantsBroadDispatch 走全局池）。

**性质**：静默失败。无警告、无拒绝，日志「2 个单位前往中央战线设防」字面为真、
语义相反——正是家法 `feedback_verdict_measures_effect` 点名的"字面对、执行错"家族。
④ 那条反而是好的：至少响亮失败。

### 10.3 归属与对手术单的影响
- **不是刀1 造成的**：刀1 只删候选，不参与 intent 生成与源池解析。
- **刀2 按现行范围（绊索放行 + stale 问句改法）修不好这条**：即使"可以/是的"顺利进
  LLM，LLM 手里仍然没有指向那 6 辆坦克的合法把手，照样退回 toFront，照样派错人。
- **∴ 这就是主审 §7 说的"等外测数据"的那个数据**：B2 的"铸号扩围"（给咨询/best_help
  推荐也铸 G 号）从"可选叠加项"升为**必需项**。否则收口那格永远过不了——
  它这次失败的方式正是 ⚠️ 那格：陈提议 → 玩家点头 → 兵没动。
- 建议刀2 范围改为三件套：**绊索放行 + 问句改法 + 咨询推荐铸号**（三者缺一，
  「陈提议→可以→兵动」这条链就仍有断点）。

### 10.4 A 刀 fix1：空集必须开口（用户批准后当场落地）
**病**：闸清空候选后，板子行直接把 `best_help` 整个字段丢掉——
`1. 北部战线: survival≈3s ratio=0.33`，关于"有没有援兵"零信息。
F1 教训（**无候选 ≠ 无友军**）此前只写在升级面 `serializeOptions`，没上板子；
闸让空集变常见，于是沉默被读成"没有部队"。手测实证：长官问"有没有可支援部队"，
参谋答"只有 Blake"，六辆闲着的主战坦克被藏掉。**这是 A 刀自己留的洞，非旧病。**

**修**（`commanderPresence.describeNoHelp`，两处调用点共用）——存在与可达分开报：
```
有闲兵但赶不到 → best_help=none(线外1股/6units 闲着，最近 Farrell(T9) eta≈154s > survival 30s，都赶不到)
有友军无可列候选 → best_help=none(front 外有N个友军单位, 但当前无可单列的增援候选)   ← 与升级面逐字同源
真的没有友军     → best_help=none(战场上无其他友军)
```
只披露、不回推荐：番号只出现在 `none(...)` 从句内，`best_help=<番号>(` 的推荐形态
不再出现（TA8c 专项断言）。赶不到的部队仍是长官可以花的牌（反打/掩护/夺回），
决定权交回去。

**连带**：`GameCanvas` proactive 字段 `idle_reinforcement_available` 改名为
`reinforcement_able_to_arrive_in_time`——闸装完后该字段的 `none` 已从"没有闲兵"
悄悄变成"没有赶得到的兵"，旧名会说谎。改名后 `none` 恢复为真。

**验收**：typecheck 4 包过；12 bench 全绿（94 条）；`--negctl` 18 条 ★ 真 FAIL。
新增 TA8b（空集必须披露股数/人数+最近 eta+赶不到）、TA8c（披露不得变相推荐）、
presence A8b（三种空集话术各自可达）。

### 10.5 B 刀①②施工记录（用户批准后当场落地）

**① 听得见 —— 拆绊索 + 把 Codex 的护栏变成断言**
- 事故复盘：`57e021b` 引入确认词表时，Codex（preflight round-2 #4）在词表正上方立了护栏——
  **"NEVER EXPAND — semantic fallback owns natural language；ANY word-list miss goes to the LLM"**：
  词表只准当**捷径**（命中抄近路，未命中必须落回 LLM），没有语义裁决权。
  `2f30003`（v4 刀2b）把同一个词表**反过来用**：命中就拦下、不进 LLM、回罐头。
  安全性质翻转（miss→LLM 变成 hit→罐头），词表从加速器变成法官。
  **护栏就写在同一个文件里，往上九百行，没人看见。**
- 违的两条家法：禁关键词枚举（词表做语义裁决）+ 台词禁死模板（罐头句）。
- 修法＝**删**（不是把词表改小——那是同一个错再犯）：绊索整段删除，罐头引用删除。
  捷径那两处保留（它们 miss→LLM，合规）。
- ★ **护栏变断言**：`CONFIRM_WORD_SITES` 登记表 —— 确认词的每个调用点必须登记并声明政策
  （fast-path / telemetry / context-only，**无 blocker 类**）；多一个未登记的调用点，
  台架当场 FAIL。这才是能防复发的东西：注释拦不住人，断言可以。

**② 知道指谁 —— 说出口的部队都铸临时番号**
```
赶不到（披露）：1. 北部战线: survival≈30s ratio=0.33
                best_help=none(线外1股/6units 闲着，最近 Farrell(T9) eta≈154s > survival 30s，都赶不到) handle=G1
赶得上（推荐）：1. 北部战线: survival≈30s ratio=0.33 best_help=Farrell(T9)(6units 无任务 eta≈19s) handle=G1
                G1 → 冻结 6 个单位，eta 随号携带
```
- **核心裁定：番号是地址，不是背书。** 引擎拒绝**推荐**赶不到的部队（诚实闸）与拒绝
  **让长官够得着**它们，是两件事，只有前者归引擎管。推翻"赶不到"是正当指挥判断
  （反打／掩护／夺回），所以赶不到的那批**照样铸号**。
- 铸号是**副作用**，因此做成 opt-in：只有真实对话轮（ChatPanel 的 `buildDigestForChannel`
  传 true）铸号；台架/心跳/任何复算的信封**字节不变、零铸号**（TB6 专项断言）。
  Marcus 的 ops 路不铸——他不下调令。
- 连带三处：① `checkDispatchAuthority` 的 pool 此前**算完就丢**，番号又绕过"具名分队"
  检查 ⇒ 番号是调度权旁路。现改为把冻结名单与本人格可调池取交集，空交集响亮拒绝。
  ② 回执带到达估算（"约 154 秒到位"）——派赶不到的兵，代价要说出口。
  ③ prompt 授权从"仅 ACTIVE_ESCALATION 带号时"扩到"信封里印出号的任何地方"，
  并明写"handle 是地址不是背书"。
- **验收**：typecheck 4 包过；12 bench 全绿（107 条）；`--negctl` 22 条 ★ 真 FAIL。

**③ Bucket A 未动（我主动缩了范围，理由记档）**
原计划第三件是"管住 Bucket A 无锚自动执行"。实施前推演发现：区分「新命令没点名」
（`no_anchor`，砍卡法要保的"清楚就办"）与「跟进句被乱绑」（Aiden 顶包）需要语义，
引擎侧只能靠"玩家原话里有没有出现分队名"——而两种情况在这个判据下**同形**。
硬做会让"派兵去北线设防"这类清楚命令也开始弹确认，正是用户砍掉的确认卡手感。
**改为：先看番号落地后 Aiden 顶包是否复发**——番号给了模型正确把手，很可能自行消失；
真复发再按证据设计，不凭推演动刀。

### 10.6 手测第三局：番号落地后的两个新断点（当场修完）

**局面**：披露／追问／列出两股空闲部队全部工作 ✓。但最后一步仍未派出兵，且一局里
**两个独立断点各炸一次**：

**断点一（02:42）：陈从板子上念的部队没有号**
陈答「附近有空闲部队吗」时念的是 ---UNASSIGNED_UNITS--- 的群行，而 B 刀②只给
FRONT_JUDGMENT 那一行铸了号 → 模型只能把**标签**写进 fromSquad → 撞 stale 闸
（「东北方向第四未编组群 已不在编」）。
**用户当初说的"每次推都该给号"是对的，是我把范围收窄了。**
→ 修：板子群行也铸号（`BoardGroupRow.memberIds` + `boardToDigestLines` 可选铸号器）；
digest 表头改为「LABEL 不是合法 fromSquad —— 用行末 handle=G#」。

**断点二（02:50）：番号解析成功了，却派出 0 个单位**
`框选的单位不在可调度范围内` —— 冻结名单经 `selectedUnitIds` 进入 planner，而那是对
**源池的硬过滤**，不是源池替换。intent 带 `toFront` 时源池 = **目的地已有的部队**，
于是 名单 ∩ 目的地 = ∅。台架实测：
| 形态 | 实派 |
|---|---|
| 名单 + `toFront=该线` | **0**（`框选的单位不在可调度范围内`） |
| 名单 + 无 front 字段 | **6，全是名单内的** |
这是 v4 刀2b 的老接线，加号之后才被踩到。
→ 修：`retargetIntentForTicket()`（**放在 core**，因 ChatPanel 无台架——反向 frame
label 就是从这个盲区溜过去的）：`fromFront` 丢弃（票据没有来源战线，来源就是名单）、
`toFront` 降级为 `targetRegion`（目的地不丢）、命令没给目的地时回退到票据冻结的集合点
（ETA 正是对它承诺的）。

**验收**：typecheck 4 包过；12 bench 全绿（114 条）；`--negctl` 24 条 ★ 真 FAIL。
TB16 是**数 assignedUnitIds** 的端到端断言（承诺 6 == 实派 6），不读 log 字面。
`ab-battle-board` 的逐字段等值断言同步加入 `memberIds`（仍是 V1b 选项的逐字复制）。

**★ 未修、且不是番号能解决的：复读与不回答（03:23-03:52）**
玩家问「你觉得应该增援吗」，陈三次给出**几乎逐字相同的战况陈述**，一次都没交付
"该/不该"这个被等待的判断。prompt 里 `判断执照`（"用战况陈述顶替那个未知量＝没有回答"）
与 `NEVER repeat yourself` 两条都在，都没生效。这属症状 4/6（prompt 债 + 台词层），
**A/B 两刀结构上都碰不到它**。疑似加重因素：fix1 的披露给了他一句可复读的现成话
（"无即时增援能赶到"）。需独立立案，不在本刀范围。

### 10.7 手测第四局：链子通了，但落点错——刀1 的另一半

**通了的部分**：陈说出「东北方向第二未编组群（**G24**）有6辆主战坦克和4步兵」——
番号进了台词；玩家「不管了，派他们去支援」→ **10 个单位出发，正是那一批**，回执对账。
「陈提议 → 玩家点头 → 那批兵开拔」这条链**第一次真的走通**。

**★ 落点错了，而且是我上一条修法引入的**：单位开进了空沙漠，不是打仗的地方。
`retargetIntentForTicket` 把 `toFront` 降级成 `targetRegion`，而 `resolveTarget` 对
front id 走 `getFrontCenterPos` = **区域并集的几何中心**——正是 7-22 事故档那个
「中心 (263,96) vs 实战 (360,105)」。**刀1 修的是 ETA 承诺那一面，派兵这一面原样留着**，
我的降级修法把它直接踩响了。票据里明明冻着 `battleAnchorFor`（战斗点），却只在
"命令完全没给目的地"时才用。
→ 修：优先级重排为 **精确目的地（设施/标记点）> 票据战斗锚点 > front 提示降级**；
且锚点只在"目的地就是本票据那条线（或没给目的地）"时生效——指向别的战线时不得劫持。
本局实测锚点与几何中心相距 **44 格**（TB17a 前置按实测定门槛 30，不拍脑袋）。

**验收**：typecheck 4 包过；12 bench 全绿（116 条）；`--negctl` 25 条 ★ 真 FAIL。
新增 TB17（★ 落点＝锚点非中心）／TB17b（别的战线不得劫持）／TB17c（精确目的地优先）。

**★★ 未修、且两刀都碰不到：ORDER 被当成 CONSULTATION（"墨迹"的真身）**
本局两次清楚的祈使被答成战况陈述、零执行：
- 01:43「**调附近空闲军去支援**」→ 只回"附近无部队能在13秒内赶到"
- 02:12「**全部过去**」→ 只回一条战况播报
第三次改口「不管了，派他们去支援」才动。加上第三局的「你觉得应该增援吗」→ 三次逐字复读，
**四个数据点同形**：prompt 里 `CONSULTATION vs ORDER`（纯祈使→EXECUTE）、`判断执照`
（战况陈述顶替被等待的答案＝没有回答）、`NEVER repeat yourself` 三条**全部未生效**。
这是 prompt 债（G 刀，审计原判 P2）的真实代价，**A/B 两刀结构上碰不到**，
且很可能是"说话傻逼"这句总判的**当前最大单项**。建议 G 刀从 P2 提到 **P0**，
与 E 刀（台词去模板化）合并为一刀。

### 10.8 附带实证（供 E 刀立案）
03:11 同一秒两行并列：机器日志说「1 个单位」，人格罐头说「6 辆主战坦克增援」——
**机器话说真、人格话说假**，且假话那句是 `VOICE_CONFIRMS` + LLM 未经校验的 option.label。
这是 §1-6「说话面双反」最干净的一份现场标本。
