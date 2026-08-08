# 对话层全量审计 — Fable 5 主审归因报告（2026-08-02）

> 审计对象：worktree `../AI Commander-approval-v4` @ `18e708a`（approval-contract-v4 八 commit 之上）。
> 读码范围：§3 必读清单 21 个文件共 16,600 行**全文读完，零抽样**；另核验 4 个勾稽支点文件
> （battleAwareness.ts / intelDigest.ts / digestHelper.ts / featureFlags.ts）与全部调用方 grep。
> 诊断期零实施，一行代码未改。结论全部从 worktree 分支 tip 的代码重推；前会话档案只当线索用。
> 所有 file:line 均指 worktree 内路径。

---

## 0. 一句话总判

对话劣化不是哪一刀砍坏的，是**四个结构病长期叠加、每刀切片审计各自全绿**的合成结果：
① 增援候选有**两台机器五个出口**，诚实闸只装了一个出口；② "战力比"在四个说话面有**四种互相矛盾的定义**（含一处不过雾的）；③ "可以"有六条路，其中两条是**死胡同**（stale 警告无消费通道、绊索误杀咨询后拍板）；④ **自动执行路径上 LLM 的真台词被抹掉**，transcript 里活下来的只有罐头确认 + 机器回执——屏上大部分"人话"其实是引擎模板戴着人格的脸。

---

## 1. 勾稽图（对 §4 假设骨架的验证与修正）

### 1.1 "撑几秒"三个钟 —— §4 假设**大体证伪**：互射钟已全链贯彻

逐面核验所有说"撑几秒"的活代码路径，**全部走互射钟**，无第四处漏网：

| 说话面 | 位置 | 钟 |
|---|---|---|
| 升级 payload survival_sec | director.ts:722-723（frontEscalationFacts） | 互射 ✓ |
| FRONT_JUDGMENT survival≈ | commanderPresence.ts:164（frontCollapseSeconds→spokenSeconds） | 互射 ✓ |
| mood reason "约X秒内承压" | commanderPresence.ts:217-219 | 互射 ✓ |
| 复盘 then/now | decisionReview.ts:163-164 | 互射 ✓ |
| proactive minifacts survival_sec | director.ts:393（tSec=round(spokenSeconds??tCollapse)，holds 已 continue） | 互射 ✓ |
| 升级兜底句 "约 X 秒" | GameCanvas.tsx:477-478（读 frontFacts.estimatedCollapseSeconds） | 互射 ✓ |
| 内部触发（告警阈值/urgency） | director.ts:381-382 | 悲观 ✓（合规） |

唯一还在念悲观钟的说话面是 `generateCrisisCard`（crisisResponse.ts:754-756 "阵地预计X秒后失守"）——**但它是死路径**：全仓 grep 无生产调用方（只在 core/index.ts 导出）。钟的口径问题已经解决；**真正的多真相源不在钟，在"战力比"**（见 1.2）。这是本审计对 §4 骨架最大的修正。

### 1.2 ★"战力比/力量比"有四种定义在同时说话（症状 4 的主根，新发现）

| # | 名字（屏上/信封里） | 定义 | 雾 | 新鲜度 | 位置 |
|---|---|---|---|---|---|
| 1 | FRONT_JUDGMENT `ratio=` / mood `战力比` / 升级 `local_power_ratio` | 纯 DPS 比（attackDamage/attackInterval） | 过雾 | 构建时新鲜 | director.ts:185-205（freshFrontPowerRatio，唯一正典源） |
| 2 | digest `---FRONTS---` OurPwr/EnemyPwr | (hp/maxHp)×DPS×10 | 过雾 | **只在 buildDigest 时刷新** | intelDigest.ts:17-60 |
| 3 | POSITION_CRITICAL "战力比 X%" | **HP 质量比** localPlayerHp/localEnemyHp | **不过雾**（雾外敌军全算） | 每帧 | reportSignals.ts:427-454, 483 |
| 4 | doctrine "敌我力量比 X:1" | front.enemyPower/playerPower（#2 的滞后副本，方向还是反的） | 过雾 | **滞后**（见下） | doctrine.ts:65-93 |
| 5 | battleContext FRONT_BALANCE 强度档 | 同 #4 的滞后字段 → DOMINANT/…/CRITICAL 档 | 过雾 | **滞后** | battleContext.ts:13-31, 121-131 |

**滞后的实锤**：`front.playerPower/enemyPower` 只在 `buildDigest`→`updateFrontPower`（intelDigest.ts:74）刷新；heartbeat 已禁用（GameCanvas.tsx:2131 `const channels: Channel[] = []`），所以刷新只搭玩家下命令、llm_advice、staff-ask（死代码）的便车。冷场几分钟后，`checkDoctrines`（每帧跑）与 Marcus 的 FRONT_BALANCE 读的都是几分钟前的战场。

**不过雾的实锤**：reportSignals.ts:437-449 `state.units.forEach` 累加 localEnemyHp 时没有任何 fog 检查——玩家看不见的敌军全部计入分母。同一时刻，#1 的 fresh 过雾 DPS 比可以是 0.81（缓和），#3 的不过雾 HP 比可以是 1%。**"兵力比零点八一…态势正在缓和"与"战力比仅0.01"同分钟并存，两句各自机器为真**——这不是 LLM 犯傻，是信封里就装着两套账。

另：battleContext.ts:127 还在渲染 `supply=${front.supplyStatus}`——director.ts:34-35 早已判死的字段（永远 "OK"）；`frontStatus` 的 SUPPLY_CRISIS 分支和 KEY_RISKS 的 "Supply crisis" 行是**永不可达的死代码**，且每次信封都对 Marcus 说一句"补给=OK"的假话。digest.ts:64 的 `Supply=${front.supplyStatus}` 同病。

### 1.3 ★增援候选：两台机器、五个出口，诚实闸只装了一个出口（§4"同一把尺"定律的完整版图）

**两台机器**（成员判定标准不同，同一战场可给出不同的"谁能来"）：

- **机器 A** `buildReinforceOptions`（frontEscalationPayload.ts:347-458）：isDispatchablePlayerUnit、含未编组空间群、按 front 内外分。
- **机器 B** `findBestReinforcements`（crisisResponse.ts:502-632，经 assessCrisisEscalation:826-869）：dispatchableStates={idle,patrolling,holding}、只看编队（过滤 __reserve__）、missionPri<2。

**五个出口逐面核过滤**：

| 出口 | 机器 | 诚实闸（晚到过滤） | 铸号 | 判定 |
|---|---|---|---|---|
| ① 升级 SITUATION payload | A | ✓ filterLateCandidates（escalationTicket.ts:159-163，一次构建同喂 payload+mint） | ✓ | 健康 |
| ② FRONT_JUDGMENT `best_help=`（有钟行） | A | **✗ 裸调**（commanderPresence.ts:120） | ✗ | **症状 1a 病灶** |
| ③ FRONT_JUDGMENT `best_help=`（交战中敌情未明行） | A | ✗ 裸调（commanderPresence.ts:101）——但该分支 ratio=null **无钟**，按 filterLateCandidates 合同 clock=null 本来就不滤 | ✗ | 半合规（要不要在无钟时闭嘴是产品决定） |
| ④ proactive minifacts `idle_reinforcement_available` | **B** | **✗ 无任何闸**：assessCrisisEscalation:857-859 取 candidates[0]，不看 assessment（晚到=insufficient 只是排序 -100，全晚到时仍取最不烂的那个）；squad 候选**无人数下限**（crisisResponse.ts:521-565；对照未编组池 :595 有 min 2） | ✗ | **"艾登一人可增援"病灶** |
| ⑤ 板子群行（UNASSIGNED_UNITS / FORCES） | A（front=null） | 无 ETA 无钟（观察行，合同如此） | ✗ | 合规，但其**群标签是 fromSquad 陷阱的原料**（症状 2） |

**信封自相矛盾的机制**（Opus 台架复现的那个）：①与②在**同一个信封里**——digest 尾部 FRONT_JUDGMENT 说 `best_help=某群(eta≈153s)`，升级块说 `reinforcement_options: none`。陈挑有内容的那句说 → 群名无号 → 撞闸。

### 1.4 ★"可以"有六条路，两条是死胡同（症状 1b/2 的路由图）

按 ChatPanel sendCommand 的判定顺序：

1. **pending 合同字面快路**（ChatPanel.tsx:1241-1262）：只有 high_impact 合同存在时可达 ✓
2. **pending 合同 LLM 语义路**（1341-1444，judgePendingConsumption）✓
3. **活跃升级 + 裸确认 → 进 LLM 绑定**（1272-1275 打点 V4_BARE_CONFIRM_EXEC；带 ticketLine 上下文）✓——LLM 写 G 号则结构安全，写群名则撞闸（见 5）
4. **绊索**（1289-1293）：无合同 + 无升级 + 裸确认 → `NO_PROPOSAL_GUIDANCE` 罐头拒绝，**永不进 LLM**。
   ★**误杀面**：咨询（NOOP）后陈刚给完带兵力数字的建议，玩家顺势说"可以"——没有升级在场，绊索吃掉这句话，回"我这儿没有待批的方案"。**"可以/行/是/对/执行/同意/确认/yes/ok" 九个词全部在 LLM 之前被截胡**，prompt 里的 SHORT FOLLOW-UP RESOLUTION（ai.ts:168）对这九个词**结构性死亡**。这是 v4 刀2b 相对旧版的**行为回退**：以前这句会进 LLM 按 CONTEXT 顺势成单。症状 1b 的一半疼痛在这里，另一半是 best_help 本来就无号可绑（铸号只发生在引擎主动升级时，escalationTicket.ts:150）。
5. **stale 警告后的"确认要继续"**：**哪条路都没接**。gate 问句承诺了"确认要继续，还是另指部队？"（ChatPanel.tsx:422），但 pending 合同只在 `reason==="high_impact"` 时登记（1569-1587）——staleRefs 分支不登记。玩家答"可以"：若升级还活着 → 路 3 进 LLM → LLM 在同样的信封（板子还在推销那个群）下**重新生成同样的病单** → detectStaleSquadRefs（222-267）再次命中 → 同一句模板复读。**死循环闭合**。
6. **gate 问句（anchor_mismatch/invalid）→ LLM 重解析**：只对不在九词表里的确认语（"就这么办""派吧"）有效。

**措辞误导的实锤**：detectStaleSquadRefs:249-252 把任何解析不到的 fromSquad（包括从来不是编制的群标签"东北方向第二未编组群"）一律归入 stale 集合，gate 问句统一说"已不在编"——对从未在编的东西说"已不在编"。

### 1.5 ★说话面版图：谁在屏上说话（症状 5/6 的底图）

- **人格 LLM 真台词**能留在 transcript 的场合：NOOP/咨询回复（ChatPanel.tsx:1456）、升级问句（source=command_ack）、proactive（source=proactive）、retrospect。
- **引擎模板戴人格脸**：messageStore.ts:123 `from=undefined → CHANNEL_PERSONA[channel]`——以下全部以陈/Marcus/Emily 的头像和名字显示：VOICE_CONFIRMS 罐头确认（ChatPanel.tsx:84-101，每人格 8 句随机轮换，**每次执行必说一句**）、`执行: ${resolver log}`（1919，resolver 的机器语）、ticket 回执、gate 问句、stale 警告、NO_PROPOSAL_GUIDANCE、调度权拒绝、doctrine 登记行、"目标 X 不存在"。
- ★**自动执行路径上 LLM 的真台词被抹掉**：流式 brief 只活在 streaming 气泡里，options 一到就 `setStreamingText(null)`（ChatPanel.tsx:1727-1733）；auto/bucketA 分支里 brief 只进 pushContext、**从不 addMessage**（1505-1521, 1556-1561）。一条命令在 transcript 里的最终残留 = 罐头 confirm + label + N×"执行: 调度 X 个单位…" + 回执。**下令这个最高频动作的对话面，几乎 100% 是模板**。
- **人格台词被降格成日志**：llm_advice 的陈语音播报以 `source="event_report"` 落地（GameCanvas.tsx:1829）→ isReportMessage → 灰色小字报表行，无头像。LLM 说的像机器，机器说的像人——**方向双反**。
- **report lane 与对话同一滚动区内联**（嵌入面板，ChatPanel.tsx:2151-2166），且明文不受任何预算管（GameCanvas.tsx:184-185）。

---

## 2. 六症状逐条归因（file:line）

### 症状 1a — 晚到候选从态势板漏出【已定罪，与前诊断一致，补一个第五面】

- 病灶：commanderPresence.ts:**120**（有钟行裸调 buildReinforceOptions，无 filterLateCandidates）；:**101**（无钟行，按闸合同本就不滤，是否闭嘴待裁）。
- 对照组：escalationTicket.ts:159-166（唯一装闸出口）。
- **前诊断漏掉的第五面**：GameCanvas.tsx:366-370 proactive minifacts 的 `idle_reinforcement_available` 出自**另一台候选机器**（1.3 出口④），同样无闸——修板子两处不封这里，"荐晚到/荐残兵"还会从主动播报冒出来。断言必须写在 1.3 的五出口枚举表上。

### 症状 1b — 来得及的候选经咨询路径无把手【归因扩大：不止无号，还有绊索误杀】

- 铸号只在引擎升级时（escalationTicket.ts:150 buildFrontEscalationWithTickets 是唯一生产 mint 入口）；板子 best_help 与咨询推荐天然无号——与前诊断一致。
- **新账**：ChatPanel.tsx:1289-1293 绊索把咨询后的"可以"截在 LLM 之前 → escalationTicket.ts:52 罐头拒绝。九个确认词对 SHORT FOLLOW-UP RESOLUTION（ai.ts:168）全灭。v4.1 无论选"best_help 铸号"还是"绊索放行咨询语境"，都必须把这条一起治，否则铸了号玩家的"可以"还是先撞罐头。

### 症状 2 — stale 警告死循环【坐实：承诺了不存在的通道】

- 问句承诺"确认要继续"：ChatPanel.tsx:419-423。
- 消费通道缺失：pending 合同只在 reason==="high_impact" 登记（1569-1587）；staleRefs 分支零登记。
- 循环闭合：升级活跃时"可以"进 LLM（1272-1293 绊索不触发）→ 信封里板子仍推销该群（症状 1a）→ LLM 复写 fromSquad=群名 → detectStaleSquadRefs（222-267）→ 同句模板再现（422 模板尾固定）。
- 措辞病：249-252 把"从来不是编制"与"曾在编现全灭"混为一类，统一说"已不在编"。
- 1a 修掉后晚到触发源消失，但**通道本身仍断**——玩家任何时候引用板子群名都会进同一个死循环，独立成账成立。

### 症状 3 — 战况播报谎报交火【坐实：措辞断言超过触发器测量 + 一处不过雾】

- **POSITION_CRITICAL**（reportSignals.ts:476-489）：模板断言"快顶不住了——正承受重火力"；触发器实测的是
  ① HP 质量比 < 0.3，**敌方不过雾**（:437-449，雾外集结的敌军全算进分母）；
  ② "接战"证据 = engagementIntensity > 0.3 **或** 任一 attack_zone 圆与前线 bbox 相交（:458-474）。
  engagementIntensity 双方都算 + attack_zone 每个贡献 0.4 + EMA τ=4s 拖尾（battleAwareness.ts:23-25, 226-266）；attack_zone 本身要求双方交火（battleAwareness.ts:157-159），但圆心落在**邻线 bbox 边缘**即可让安静前线"接战"成立；El Alamein 前线 bbox 是 region 并集的粗框，交界处战斗由 findFrontForPosition **首命中**归属（reportSignals.ts:63-79）——中央线无交火时照报的两条机制都在。
  另：注释说 60s 冷却（:131），代码是 30s（:476）。
- **UNDER_ATTACK**（reportSignals.ts:176-216）：任一单位掉一滴血 → 整线"遇袭，正在接战"，30s/front 循环；一发雾外炮弹就够。
- 放大链：每条事件行直接进屏（GameCanvas.tsx:1779/1801），UNDER_ATTACK 还触发 llm_advice 让陈拿全 digest 再复读一遍（advisorTrigger.ts:54-59 + GameCanvas.tsx:1814-1833）。

### 症状 4 — LLM 台词自相矛盾【主根 = 信封里的多套账，不是模型犯傻】

- "兵力比 0.81 缓和" vs "战力比 0.01"：四种战力比定义并存（1.2 表）。0.81≈freshFrontPowerRatio+trend=easing（proactive minifacts，GameCanvas.tsx:358-371）；0.01≈POSITION_CRITICAL 不过雾 HP 比（经 report lane / 升级 raw_signal / llm_advice 的 evtInfo 前缀 GameCanvas.tsx:1818 三条路进屏进信封）。
- "艾登一人可增援"：crisisResponse.ts:521-565 squad 候选**无人数下限**（对照 :595 未编组池强制 ≥2）；assessCrisisEscalation:857-862 不筛 insufficient → director freeReinforcement（director.ts:408-410）→ proactive "idle_reinforcement_available: Aiden, 1 men"（GameCanvas.tsx:366-370）；FRONT_JUDGMENT best_help 同病（commanderPresence.ts:120-124）。
- "第二未编组群→第三"：frontEscalationPayload.ts:405-431 罗盘序数按**当帧**组序分配；spatialGroups 按活体位置每帧重算，成员挪半格、同象限组增减，序数就换——escalationTicket.ts:21-26 的注释自己承认板子行无跨帧身份。同一支部队两个信封里换名字，LLM 忠实转述就是"自相矛盾"。
- **prompt 债（次因，非主因）**：SYSTEM_PROMPT ~280 行规则堆积（ai.ts:44-326）；CHANNEL_PERSONA.combat 在 user message 里**再注入一份缩写版同规则**（ai.ts:687）——同一套 enforcement 两处措辞已漂移；外加 escalation/proactive/retrospect/preflight 四套独立 prompt。矛盾主要不出在规则打架，而出在**喂进去的数字本身就有四套定义**——prompt 治理排 P2，数字治理排 P0/P1。

### 症状 5 — 播报轰炸【触发器×冷却×三层复读的算术题】

- 冷却矩阵：UNDER_ATTACK 30s/front、POSITION_CRITICAL 30s/front、FACILITY_CONTESTED 30s/设施、SQUAD_HEAVY_LOSS 每队一次、HQ_DAMAGED 30s、SUPPLY_LOW 60s、doctrine warn 60s/breach 30s、diagnostics ~1Hz drain（GameCanvas.tsx:1648-1663）。两三条热线同时打，report lane 每十几秒必刷一条。
- report lane 明文不受预算管（GameCanvas.tsx:184-185），且嵌入面板里与对话**同屏内联**（ChatPanel.tsx:2151-2166）。
- 同一事实三层说：模板事件行 + llm_advice 复读（30s/front）+ 升级问句/FRONT_JUDGMENT 行（每信封）。
- 模板句本身违家法「台词禁死模板」：「遇袭，正在接战」「快顶不住了」「减员严重」是引擎固定句式，逐字复读。

### 症状 6 — 整体机械感【= 1.5 说话面版图的合成】

一条被自动执行的命令，玩家实际读到的是：〔LLM 流式台词闪现后被抹（ChatPanel.tsx:1727/1505-1521）〕→ 罐头确认（84-101 八句轮换）→ N×"执行: 调度 X 个单位进攻…"（1919，resolver 机器语）→ ticket/预算回执。同时：人格的主动播报（llm_advice）以灰色日志行显示（GameCanvas.tsx:1829 source=event_report），机器模板句却顶着人格头像（messageStore.ts:123）。**"对话是唯一界面"的家法在渲染层被双向违反**——手测账②只删了一句"您没点名部队…"，结构还在原地。

---

## 3. 手术单（按疼痛排序；全部待用户拍板，本报告零实施）

| 刀 | 疼痛/优先 | 内容 | 大小 | 风险 |
|---|---|---|---|---|
| **A. 候选诚实闸补全（五出口一把尺）** | P0 | ②commanderPresence.ts:120 过 filterLateCandidates（钟就是同函数 :111 已算的 t，零新计算）；③:101 无钟行为明示化（裁定：无钟不滤 or 闭嘴）；④proactive/6a bestCandidate 加同款晚到闸 + squad 候选人数下限对齐未编组池的 ≥2（crisisResponse.ts:521/595）；bench 断言写在 1.3 五出口枚举表上，不逐面散写 | 小-中 | 出口④连动 6a 的 safe_reinforce/dilemma 分类 → 升级频率会变，需声明为预期变化 |
| **B. "可以"两条死胡同接线** | P0 | B1 stale 分支：要么登记 pending（"确认要继续"才成立），要么把问句改成只问"另指部队"（不承诺不存在的通道）；B2 绊索放行咨询语境（裸确认 + CONTEXT 上一条是本人格带兵建议 → 进 LLM）**或** v4.1 给 best_help 铸号——二选一须用户裁；B3 detectStaleSquadRefs 把"从来不是编制"与"已不在编"分成两种话术 | 中 | B2 放宽绊索会恢复一部分"LLM 绑定裸确认"的旧风险面——正是 V4_BARE_CONFIRM_EXEC 打点在量的东西，改前先看外测计数 |
| **C. 播报触发器诚实化** | P0 | C1 POSITION_CRITICAL：敌方 HP 加 fog gate（reportSignals.ts:437-449）+ 模板句改中性事实（或字段化交 LLM voice）+ "战力比"字样从 HP 比上摘掉；C2 UNDER_ATTACK：加掉血量/人数阈值或降频，不再一滴血报"遇袭，正在接战" | 中 | POSITION_CRITICAL 是升级排序高优事件（director.ts:604），改触发改变升级频率；掉血阈值需从真局数据定 |
| **D. 一个"战力比"** | P1 | 全仓收敛到 freshFrontPowerRatio 一个定义一个名字；doctrine/battleContext 的滞后 power 就地重算或明示口径；battleContext.ts:127 与 digest.ts:64 拔掉死字段 supplyStatus（连带 SUPPLY_CRISIS/KEY_RISKS 死分支） | 中 | doctrine 阈值 2.5/1.5 是按 power 口径调的，换定义需重标定 |
| **E. 台词去模板化第二刀（屏上只留活人说话）** | P1 | E1 自动执行路径把 LLM brief 落成正式消息，VOICE_CONFIRMS 罐头降级/删除；E2 "执行: {log}"降入 report lane 或并进人格句；E3 llm_advice 的人格台词从 event_report 改回对话面 | 中 | 纯渲染/落点层，不碰执行链；与手测账②同法系 |
| **F. 群名跨帧身份** | P2 | 短期：序数按位置哈希稳定或标签注明"以当前帧为准"；长期：cluster identity tracking（escalationTicket.ts:21-26 已点名） | 中 | 长期方案是新机制，短期方案先止血 |
| **G. prompt 债清理** | P2 | CHANNEL_PERSONA.combat（ai.ts:687）与 SYSTEM_PROMPT 的重复 enforcement 合一；四套 mode prompt 的共享段抽公共 | 小 | 措辞漂移已存在，合并本身是止漂移 |
| **H. 死代码清扫** | P2 | generateCrisisCard 无调用方；staffAsk pendingByChannel 无写入方（GameCanvas.tsx:2092-2106 整段死）；EVENTS(90s) 节所有生产调用传 []（永不渲染）；heartbeat channels=[] 若为永久决定应删块；reportSignals.ts:131 注释 60s↔实际 30s | 小 | 纯清扫，但动 heartbeat 块前确认无人打算复活它 |

**排序理由**：A/B/C 直接对应用户手测的三条最疼主诉（不可行动的推荐、死循环、谎报交火）；D 是症状 4 的根（不修 D，LLM 永远拿着四套账说话）；E 是症状 6 的根但纯表现层可后置；F/G/H 是止漂移与还债。

---

## 4. 与前会话诊断的分歧点（留给 Opus 联审对账）

1. **§4"三个钟"假设**：我判**已解决**（1.1 七面全过互射钟，唯一漏网是死路径）。真正的多真相源是"战力比"四定义（1.2）。若 Opus 仍把钟列为活病灶，请出 file:line。
2. **症状 1a 修法范围**：前诊断说"板子两处同过 filterLateCandidates"。我判 :101 无钟行**按闸合同本就不滤**（filterLateCandidates clock=null 直通），真正必修的是 :120；且**第五面（proactive 出口④，另一台机器）前诊断没覆盖**——只修板子两处，断言表不完整。
3. **症状 1b**：前诊断只说"无号可绑"。我加：**绊索把九个确认词在 LLM 之前全部截胡**（ChatPanel.tsx:1289 + ai.ts:168 SHORT FOLLOW-UP RESOLUTION 对这些词结构性死亡）——这是 v4 刀2b 的行为回退，v4.1 铸号若不同时治这条，铸了号"可以"还是撞罐头。
4. **症状 4 的一号嫌疑**：交接档提名"prompt 债"。我判 prompt 债是**次因**（P2），主因是信封数字四套定义 + 群名跨帧改号——模型忠实转述了互相矛盾的输入。
5. **症状 6 新证据**：自动执行路径 LLM 真台词被抹（1.5★）前会话未见记录——这可能是"整体拉完"里权重最大的单项，因为下令是最高频交互。

—— Fable 5 主审，2026-08-02。诊断期零实施；等 Opus 5 独立归因表出来后逐条对账。
