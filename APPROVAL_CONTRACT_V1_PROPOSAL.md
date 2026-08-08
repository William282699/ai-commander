# 批准合同化 V1 — 一页纸提案 v1（2026-07-21，待 Codex 裁决）

## 0. 实证与目标

实证（2026-07-20 用户实弹，V1a 收口局）：Chen escalation 问"卡特队7人可增援，是否立即调动？"，玩家答"批准"——但 escalation 只是**软上下文**（ChatPanel.tsx:1225-1239 把"参谋刚问「…」"塞进 digest，模型重新解析），且**最新一条覆盖旧条**（messageStore 每信道单槽 latest-wins）。结果：玩家打"批准"时问题已被连环升级换成"野战修理厂8辆是否调往北部"，模型对着换掉的问题重新解析，还执行歪了（8 单位被派往**中央**）。代码注释早已自认：`Deterministic resolve of a confirm is Tier 2, deferred`（ChatPanel.tsx:1236）。
目标：**批准 = 对一份被捕获的具体提案的授权**，不是一句需要再解析的新命令。authorize 逐字执行捕获案；cancel 零执行；amend 走新命令；一切歧义 fail-closed。

## 1. 核心裁定问题：复用 Preflight pending 合同（提案立场 = 复用）

Preflight V1 的机器（66 断言在闸）解决的就是同构问题：**合同先登记 → digest 带 `---PENDING_CONTRACT---` → pendingDecision 严格四值 → `pendingVerdictRoute` fail-closed 路由 → id+channel+session+expiry+对象同一性(epoch) 五重守卫**。本提案不新造机制，只加一个**合同来源**：`origin: "player_command" | "escalation_proposal"`。收益：消费侧（"批准/算了/改派"的判定与路由）**零新逻辑**，负例语料闸直接复跑；差异只在**登记侧**（合同对象由引擎的 escalation 提案生成，而非玩家自己的大命令）与**执行侧**（authorize 执行的是捕获的提案单位清单）。

## 2. 合同对象 contract（登记时引擎钉死，禁重算）

- **登记时机**：GameCanvas front-escalation 分支发出 voice 请求**之前**（preflight 同款 voicing→awaiting_reply 两阶段：顾虑/问句未上屏不可授权）。
- **捕获内容**（全部引擎事实，LLM 零参与）：`{ escalateId, origin:"escalation_proposal", channel, sessionId, epoch(GameState 对象同一性), expiry(=现 120s 窗), proposal: { candidateLabel, candidateUnitIds 快照, unitCount, targetFrontId, etaSec } }`。candidate = V1b `buildReinforceOptions` 排序后的 **top 候选**（无任务优先→ETA 升序，引擎已定序）；unitIds 在登记刻快照。
- **authorize**：只执行捕获案——快照 unitIds 过滤存活/仍可派遣 → 向 targetFront anchor 下达增援 orders（走 applyOrders 唯一入口）→ **复诵回执报实际出发数**（"Blake(T5) 11/12 人出发 → 北部战线"；含损耗如实）。存活为 0 或 front 已灭 → 诚实拒绝零执行，绝不换部队顶替。**绝不重新解析玩家文本、绝不重选候选。**
- **cancel**：零执行（preflight 语义原样）。**amend**（"换 Carter 去/只派一半"）：按路由表只执行新响应的 intents，合同作废——新 intents 走普通命令全流程（含 preflight 大命令闸，互不豁免）。
- **歧义 fail-closed**：四值缺失=协议失败零执行；错 id/错信道/错 session/过期/voicing 未上屏/epoch 不符 → stale 零执行（`judgePendingConsumption` 原样复用）。
- **群候选可执行性说明**：候选若是未编组群，执行走**捕获的 unitIds**，不经 fromSquad——与 V1a"群 label 不是 fromSquad"零冲突（这是引擎自己的提案对象，不是玩家口头调度，后者仍是非目标）。

## 3. 连环升级规则（本次事故的直接修复）

- **单槽+显式替代**：新 escalation 登记时，旧合同若 awaiting_reply → 标 superseded（=stale 家族，授权词一律拒绝）；玩家消息绑定的是**发送瞬间**读到的合同（ChatPanel 同步读 ref，preflight 同款），窗口内换代即拒绝——宁可让玩家再说一遍，绝不执行换掉的案。
- **stale/superseded 的应答**（设计点，请 Codex 裁）：preflight 的 stale 是纯静默；但"批准"落空无反馈伤司令感。提案 = 静态一行角色内提示（"情况已变，刚才那件事作废了——现在的问题是…"，引擎模板非 LLM），不新增 LLM 调用。

## 4. voice 约束（1-2 行语义原则，禁穷举）

escalation 的 voice prompt 加一行：**你问的候选必须且只能是合同里那一个**（payload 首位候选）；问号校验+真数字兜底沿 preflight 原样（voice 跑偏/非问句 → 引擎模板句报捕获案，合同照常有效）。兜底句本身即复诵（"中央前哨附近8单位可43秒抵达北部战线，是否调动？"）。

**4b. 跨频道点名身份规则（2026-07-21 实证并入，用户裁定同批处理）**：实证=玩家在 Chen 频道说"emily，能生产多少坦克"，Chen 答"Emily, here. We can produce…"——冒充艾米莉+转英文，一次点名双破人设（身份+全中文）。现有防线只在解析层（ai.ts:240 "Persona vocative is not fromSquad"），语音层无对应规则。修法=命令 prompt 共享人设区加**一行语义原则，不挂例句**（例句有鹦鹉学舌复读风险，用户已裁）：「长官点名的若不是你本人，绝不冒充对方——始终以自己的身份、用中文回应；答案在 digest 里就直接答，属他人职权的可自然点明归属。」纯出戏问题零执行风险，与本提案的 escalation voice 条款同文件同批裁决。

## 5. 改动面（draft，允许清单待 Codex 精确化）

`APPROVAL_CONTRACT_V1_PROPOSAL.md`（修订）· `apps/web/src/ChatPanel.tsx`（合同登记/消费扩 origin；现 escalation 软上下文路径**由合同路径取代**）· `apps/web/src/messageStore.ts`（escalation 记录携带 proposal 对象）· `apps/web/src/GameCanvas.tsx`（仅 front-escalation 分支：登记合同+voice 兜底）· `packages/core/src/frontEscalationPayload.ts`（**仅** ReinforceOption 增 memberIds 结构字段——序列化文本零变化，bench 40 逐字是闸）· `packages/core/src/commandPreflight.ts`（origin 字段+judgeConsumption 参数化，行为不变）· `apps/server/src/ai.ts`（仅两处 additive：escalation voice 约束一行 + 共享人设区跨频道点名身份一行 §4b；**消费侧零改动**——pendingDecision 条款现成）· 新增 `scripts/ab-approval-contract.ts` · `ROADMAP.md`（仅收口）。

## 6. 红线与勾稽

五闸原样全绿是闸：emily 38 / board 37 / **V1b 40（payload 逐字节，memberIds 不得进序列化）** / **preflight 66（player_command 合同行为逐字不变）** / typecheck。preflight 负例语料（45 调用零错误授权）复跑作对照。escalation 的触发/预算/降噪逻辑不动；proactive/facility 分支不碰；digest 各节不动。

## 7. 验收

1. 五闸 + 新 bench synthetic 全绿。
2. **synthetic**（最终状态口径）：登记两阶段（voicing 不可授权）；authorize 执行单位 = 快照 unitIds 精确集合（含部分阵亡→只派存活+回执如实）；cancel/amend 路由；错 id/错信道/错 session/过期/epoch 不符/superseded 六路 fail-closed 全零执行；**连环升级重放案**（登记 A→升级 B 替代→"批准"→A 拒绝 B 待答，或按发送瞬间绑定语义断言）；群候选执行不经 fromSquad。
3. **真模型**：preflight 负例语料复跑（零错误授权）+ 新正例"批准/可以/去吧"×3 → authorize；歧义句（"再等等"/"你觉得呢"）×3 → 非 authorize；**身份 fixture（§4b）**：Chen 频道点名 emily ×3、Marcus 频道点名 chen ×3——判读零冒充、零英文、自称正确。
   **方案对照（用户 2026-07-21 批准加入）**：连环升级重放 fixture 双跑——A=现行纯上下文路径、B=合同路径，同一事故场景各 N 次，报误执行率对照（证"prompt 加上下文不够"以数字落案）。
4. **手测（真实局）**：复刻事故——等连环升级发生，说"批准"，对账实际出发单位==当时屏上问句的捕获案（或收到"情况已变"提示零执行）；Network+state 前后快照取证。

## 8. 非目标

未编组群玩家口头调度（仍归 Preflight V2 command schema）；provenance 全量（第 8 级）；多合同并行（单槽是本轮语义）；escalation 触发条件/频率调整；proactive statement 合同化。

## 9. 考虑过并否决

- **新造独立审批机制**：与 preflight 平行两套四值/路由/守卫=双真相源，必然漂移——复用。
- **authorize 后按 label 文本匹配验证 voice 是否说对候选**：字符串脆弱；改为 prompt 约束+兜底复诵+真模型 fixture 统计验证。
- **保留软上下文与合同并行**：同一句"批准"两条路径竞争=事故重演——合同路径整体取代软上下文。
- **stale 完全静默（preflight 原样）**：授权词落空无反馈伤司令感——静态模板一行，标给 Codex 终裁。
