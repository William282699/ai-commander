# 对话化改造 · 开工 WORKPLAN（v2 · 已纳入 Codex 审核）

> **给接手的 Claude Code 窗口:** 自带上下文的执行计划。**先从头读完**,再开工。工作目录 = 仓库根 `AI Commander`(直接在此文件夹,不开 worktree)。
> **v2.1 改动:** 据 Codex 两轮静态审核修订——重排顺序(安全四步先行)、重写 Step 5(砍卡:false-reason 三分流 + anchor_mismatch 细分)、拆 Step 6(6a/6b)、扩"不碰区"。行号经 Codex 对照实时代码核过,但仍**先读后改**。Codex 复审结论:可开工,新窗口先做 1-4。
> 配套背景:`改动方向-傻瓜版.md`。

---

## ⚠️ 工作方式（违反 = 失败）

1. **一次只做一步。** 做完 → `npm run typecheck` 绿 → **停下,让用户手动测,过了 bench 才 commit。** 用户没确认通过前,绝不开下一步。
2. **行号是快照,会漂。** 每步动手前**先读点名的文件**核对,不一致按实际适配,别盲改。
3. **永不退步。** 任何一步让原本能跑的变差 = 不算过,回滚。
4. 建议开分支 `conversation-redesign`(同文件夹,不开 worktree),每步 commit + tag。

## 🚫 不碰区（命门,扩大版）

这些是已验证的"命令理解"核心,**除非某步明确授权,一律一个字不动**:
- `apps/server/src/ai.ts` 的 `SYSTEM_PROMPT` **中段**:意图语义 / 否定处理 / 地名匹配 / Chen 人设;以及 **RULES + DOCTRINE SYSTEM(~216 行之后的 squad / location / doctrine 规则)**。
- `packages/shared/src/schema.ts` 的 intent 清洗 / 校验。
- `packages/core/src/tacticalPlanner.ts` 的目标解析 / intent 语义。
- 已验证的命令解析准确度、延迟、双模型架构。

---

## 0. 项目速览（冷启动必读）

**游戏:** AI Commander —— 玩家用自然语言指挥有人格的 AI 参谋打 RTS。命令 → LLM 解析成 intent(JSON)→ schema 校验 → 引擎执行。参谋:**Chen(战斗)/ Marcus(参谋)/ Emily(后勤=生产/补给)**。要做的是「司令感」:说了就办、部下回报、会自己拿主意。

**结构(npm workspaces):** `apps/web`(React+Vite 前端:`ChatPanel.tsx`、`GameCanvas.tsx`、`messageStore.ts`)、`apps/server`(Express + LLM:`index.ts`、`ai.ts`)、`packages/core`(**纯引擎、无 I/O**:`sim.ts`、`combat.ts`、`economy.ts`、`crisisResponse.ts`、`advisorTrigger.ts`、`applyOrders.ts`)、`packages/shared`(`types.ts`、`schema.ts`、`constants.ts`、`digest.ts`)。

**运行/验证:** 前端 `npm run dev`(:3000);后端 `npm run dev:server`(:3001,需 `apps/server/.env` 的 LLM key);`npm run typecheck`(每步必跑,当前绿)。

**架构铁律:** LLM 只做两件事——**解析命令** + **用 Chen 口气说话**;**决策和执行永远在引擎**。

---

## 顺序总表（v2:安全四步先行,重活压后）

| 步 | 内容 | 风险 | Codex 状态 |
|---|---|---|---|
| 1 | 日志地基 | 极低 | 小修(补 /api/brief 口径) |
| 2 | Emily/生产不弹卡 | 低 | 小修(补失败反馈) |
| 3 | 战报与对话分面 | 低 | 小修(分面规则更精确) |
| 4 | 据点有分量 | 低-中 | 锚点准(数值覆盖问题) |
| 5 | 砍卡(命令卡) | **中-高·已重写** | 必须按 reason 三分流 |
| 6a | 自主-只上报问你 | 中·已重写 | 先定数据结构 + 执行位置 |
| 6b | 自主-act-and-report+撤销 | 高·会反复改 | 不复用 staff-ask |

新窗口可**先连做 1→2→3→4**(都安全);5 / 6 在动手前再读一遍本文对应段(已按审核改细)。

---

## Step 1 — 日志地基（纯增量）

**目标:** 服务器端结构化记下玩家命令,为个性化攒数据 + 治"测试者玩没玩"盲区。

**锚点:** 后端 `apps/server/src/index.ts` 命令路由;前端 fetch 点 `ChatPanel.tsx`(~938 group / ~1145 stream / ~1248 command)。**当前无 sessionId(已确认)。**

**具体改动:**
1. 前端:新建 `apps/web/src/session.ts` → `export const SESSION_ID = crypto.randomUUID()`(或存 localStorage)。给**命令类**请求体加 `sessionId`。
2. 后端:加 `function logEvent(o){ console.log("[EVENT] "+JSON.stringify({t:Date.now(),...o})); }`。
3. **明确记录范围(用 `type` 字段区分,Codex 复审):** 记两类但分开标——`type:"command"` = **玩家原话命令**(`/api/command`、`/api/command-stream`、`/api/command-group` ~72/~100/~134);`type:"staff_event"` = **系统事件触发的参谋发问**(`/api/staff-ask` ~173,它**不是玩家输入**,别混算成玩家原话)。**不记** `/api/brief`(~156,系统周期简报)。前端只给命令类请求加 sessionId。
4. 持久化备注(不在本步):console.log 在 `fly logs` 可见;跨重启留存以后挂 Fly volume 写 JSONL。

**不碰:** 决策 / prompt / 引擎 / 游戏表现。

**手测:** 玩一局下 3-5 条命令(中英文);看后端终端。
**通过 bench:**
- [ ] 每条命令一行 `[EVENT]`,含 `sessionId`+`t`+`message`。
- [ ] `/api/brief` 不产生 [EVENT](或按口径明确只记命令)。
- [ ] 游戏零可感知变化;typecheck 绿。

**完成:** commit + tag `step1-logging`。

---

## Step 2 — Emily / 生产命令不弹卡（改动 2）

**目标:** 清楚的生产/交易命令直接执行 + Emily 回报,不弹卡;**失败有反馈**。

**锚点(Codex 核实):** `ChatPanel.tsx` `canAutoExecute`(~253),produce/trade 因无 `fromSquad` 掉到 `no_anchor`(~327)。失败链路:生产失败只进 `diagnostics`、交易钱不够直接 `return`(`applyOrders.ts` ~182 / ~202)——**当前到不了玩家面前**。

**具体改动:**
1. `canAutoExecute` 逐 intent 循环开头加:`if (intent.type==="produce"||intent.type==="trade") continue;`(绕开部队 anchor 闸)。
2. **补失败反馈(Codex):** 钱/资源不够时,让 Emily 在对话里说一句(如「钱不够,只够造 X 辆」)。**别大改核心 `applyOrders`**(它现在返回 void,生产失败 push diagnostic、交易失败直接 return,~42/~177)——两个轻办法选一:**前端 preflight**(发送前查钱够不够,不够就让 Emily 说),或**加一个很小的 economy result/diagnostic 通道**让前端读到失败原因。**不要为这个动 applyOrders 的合约。**

**不碰:** 解析 prompt、其它 intent 的弹卡逻辑、命门区。

**手测:** (1)「生产 3 辆主战坦克」钱够 (2)「造航母」钱不够 (3) 给 Chen 一条普通进攻命令(回归)。
**通过 bench:**
- [ ] (1) 不弹卡 + Emily 确认 + 队列出现 3 辆。
- [ ] (2) 不弹卡 + **玩家能即时看到"钱不够"反馈**(不是静默 diagnostics)。
- [ ] (3) 进攻命令行为同改前。
- [ ] typecheck 绿。

**完成:** commit + tag `step2-emily-no-card`。

---

## Step 3 — 战报与对话分面（改动 3）

**目标:** 系统战报和参谋人话在 UI 上分开。

**锚点(Codex 核实):** `messageStore.ts` 有 `MessageLevel/Source/From`(~9)。**注意陷阱:** `addMessage`(~115)会把没有 `from` 的 `event_report`/`heartbeat` **自动套上 channel persona**,所以不能简单"有 persona from 就当人话"。

**具体改动(按 Codex 把规则定精确):**
- 渲染分两道,**主要按 `source` 判,不被 persona from 骗**:
  - `source ∈ {heartbeat, event_report}` 或 `from==="system"` → **战报道**(压暗、字小、无头像),即使它被套了 persona。
  - `source ∈ {command_ack, player}`(玩家命令的直接回复 / 玩家自己的话) → **人物气泡**。
- `level==="urgent"` 的战报:仍在战报道,但颜色突出。
- **边界 case 暂缓:** "Chen 对某事件的主动解读"(人话型 event 简报)严格说该进气泡——但这种消息要到 Step 6 才产生。**本步只处理现有的"周期简报/事件战报 vs 命令回复"两类**,Chen 主动解读留到 6a 再归类。

**不碰:** 消息怎么产生(`addMessage` 调用点)、引擎、LLM。只动渲染。

**手测:** 打一场有战斗的局,看聊天区。
**通过 bench:**
- [ ] 系统战报在单独低调战报道(无头像)。
- [ ] 命令回复在人物气泡。
- [ ] 被套了 persona 的 event_report **没有**混进气泡。
- [ ] 下命令→回复仍正常;typecheck 绿。

**完成:** commit + tag `step3-feed-split`。

---

## Step 4 — 据点有分量（原改动 5,提前）

**目标:** 占据点→持续收入,丢了→没了。

**锚点(Codex 核实,基础设施已存在):** `economy.ts` `processEconomy`(~71)已调 `recalcBonusIncome`(~170,从拥有设施算 bonusIncome)。**问题是数值覆盖:** `constants.ts`(~145)里 radar 没 bonus、repair_station 是空对象——所以"据点不疼"是**数值/类型没覆盖,不是没接线**。

**具体改动:**
1. **补常量(主活):** 在 `constants.ts` 给缺 bonus 的可占设施类型(radar / repair_station / 等)填上有感的 bonusIncome(money/fuel,按重要度)。先读现有有 bonus 的类型照着给量级。
2. (可选,可砍)高地攻击加成:`combat.ts` `calculateDamage`(~86),foot 单位在高地/entrench 时加小攻击乘数,照抄现有防御加成写法。时间紧跳过。

**不碰:** 对话 / LLM / 卡 / feed。

**手测:** (1) 占一个点盯收入 (2) 丢一个点盯收入 (3) 可选高地输出。
**通过 bench:**
- [ ] (1) 占点后收入增加(重要点增得多)。
- [ ] (2) 丢点后那份收入消失。
- [ ] (3,可选)高地步兵攻击更高。
- [ ] 其它系统不受影响;typecheck 绿。

**完成:** commit + tag `step4-stakes`。

---

## Step 5 — 砍卡（命令卡）⚠️ v2 重写（Codex:最危险的一步）

**目标:** 清楚命令直接执行+回报;该问的问一句;**高后悔/不可逆的必须先确认**。**不再弹命令的 A/B/C 菜单。** prompt 不动。

**关键纠正(Codex):** `canAutoExecute` 返回 `false` 是**安全闸**,原因各不同,**绝不能"false 也直接执行"**。必须**按 reason 三分流**。还有**两套卡**,本步只砍其一。

**锚点(Codex 核实):**
- 命令卡渲染:`ChatPanel.tsx` `setResponse(data)`(~1124),处理 `processAdvisorData`(~1044)。
- `canAutoExecute` 的 false 原因:`invalid_intent_fields`(~292)、`high_impact`(~302)、`anchor_mismatch`(~322)、`mission_conflict`(~324)、`no_anchor`(~329)、`no_selected_units`(~330)。
- **第二套卡(本步不动,见 6a):** staff thread 紧急卡,渲染 `~1521`、批准 `~735`。

**具体改动 —— 把 false 原因分三桶:**
- **桶 A · 自动降级执行 + 回报**(低后悔):命令清楚,且玩家**原话里没有任何显式部队**(无 squad/leader/commander),LLM 替他挑了(`no_anchor`,或 `anchor_mismatch` 但用户原话本就没点名任何部队)→ **按推荐项执行,回报里说明替你挑了谁**(「我让 Aiden 上了,跟您说一声」),玩家可纠正。
- **桶 B · 必须问一句**(真歧义):`invalid_intent_fields`(目标不存在)、`no_selected_units`(说"选中的"但没选)、**⚠️ `anchor_mismatch` 且用户原话有显式部队、但和 LLM 给的不一致**(用户说 Carter、LLM 给 Aiden → 可能误读,**自动执行 = 错调兵,必须问**)。**判据用现成的:** `canAutoExecute` 已算出 `squadIdsInText` / `mentionedAnchors`——用户原话提过任意部队(集合非空)但 `intent.fromSquad` 不在其中 → 桶 B;一个都没提 → 桶 A。
  - **注(Codex):** "多个目标同等可能"这种歧义**没有现成 deterministic detector**(`isValidTarget` 只判字段有效性,不判歧义)——靠 LLM 返回 `options:[]`/澄清问句触发,前端只处理这种返回,别假设有本地歧义判据。
- **桶 C · 必须确认**(高后悔/不可逆):`high_impact`(无范围全军调动)、`mission_conflict`(打断正在执行任务的部队)→ **Chen 顶一句顾虑 + 要一个 yes 才动**。
- **CONFIRM 不另建(Codex:它现在不存在):** prompt 写的是"warn but execute"、前端无 CONFIRM 分支。所以桶 C 的"确认"**复用现成 ASK/澄清回合**——Chen 在对话里问 yes/no,玩家答"行",由 prompt 里已有的 **SHORT FOLLOW-UP RESOLUTION** 规则接住执行。**不碰 schema、不加新 responseType。**
- **保留所有安全网:** `detectStaleSquadRefs`(~208)、`mission_conflict`、`high_impact` 一个都不能丢——它们决定进哪个桶,不是被绕过。
- **只砍命令卡:** `setResponse` 渲染的那套 A/B/C 不再出现。**staff thread 紧急卡本步仍在**(它在 6a 处理)——**这是预期的中间态**,测试时知道"命令不弹卡了,但危机仍弹 thread 卡",别当 bug。
- **prompt 不改:** LLM 照旧返回方案,前端只取推荐项 + 按桶分流。解析安全。

**不碰:** 解析 prompt、命门区、staff thread 卡(留 6a)。

**手测:**
1. 清楚命令(指明部队):直接执行+回报。
2. 玩家没指明部队的命令:执行推荐+回报说明挑了谁(桶 A)。
3. 目标不存在 / 多义:问一句(桶 B)。
4. 「全军压上」无范围:Chen 顶一句+要确认(桶 C)。
5. 正在打任务的部队被改派:问/确认,不直接打断。
6. 引用已阵亡 squad:不盲执行,问/警告。
7. 回归:之前能正确执行的命令仍正确。

**通过 bench:**
- [ ] (1)(2) 不弹卡、执行+回报(2 里回报说明挑了谁)。
- [ ] (3) 问一句,不弹 3 卡。
- [ ] (4)(5) **没有**自动执行,而是 Chen 顶一句+等你确认。
- [ ] (6) stale-ref 不盲执行。
- [ ] (7) 无回归;命令卡彻底不出现;typecheck 绿。
- [ ] (已知中间态)危机 thread 卡仍在 = 正常,留 6a。

**完成:** commit + tag `step5-no-command-card`。

---

## Step 6a — Chen 自主:只"上报问你"（escalate）⚠️ 先打地基

**目标:** 危机有真两难时,Chen **在对话里问你**(替掉 staff thread 紧急卡),**还不自动动兵**。先把数据结构、执行位置、日志关联打好,风险最低。

**关键纠正(Codex):**
- `processAdvisorTriggers`(`advisorTrigger.ts` ~36/43)是**纯扫描/路由,只改 cooldown**——**不要在这里执行任何动作**。执行放 **GameCanvas 消费 trigger 之后的一个明确 autonomous helper**(或 core 里新函数,由 GameCanvas 调)。
- `crisisResponse.ts` 的 `estimateCollapseTime`(~218)、`assessReinforcement`(~272)是**私有**;`findBestReinforcements`(~400)已导出,但还会返回 `squadId:"__reserve__"` 的未编组预备队(~510)。
- `types.ts` 的 `Order`(~237)只有 `provisional`/`isPlayerCommand`/`crisisFrontId`——**没有 autonomous/actionId/undo**。

**具体改动:**
1. **先定数据结构(动手前):** 给自主动作设计承载——`Order` 加(或单独结构)`autonomous: boolean`、`actionId: string`;一个**日志 correlation id**(把"动作"和玩家随后的反应在 Step 1 日志里对上)。撤销字段留给 6b,但 id 现在就要有。
2. **决定 `__reserve__` 候选:** 明确"上报/自主"是否接受未编组预备队。建议 6a/6b 先**只认有编组的闲置 squad**,`__reserve__` 暂不自动用(避免动到玩家没意识到的散兵)。
3. **执行位置:** GameCanvas 拿到 `crisis_card`/escalate 类 trigger 后,调 helper 判断;有真两难(救 A 要抽空 B)→ 发一条 Chen 口气的**问句**进对话道,替掉 thread 紧急卡。
4. **私有 API:** 若 helper 不在 crisisResponse 内,把要用的判断**导出**(或把逻辑收进 crisisResponse 暴露一个干净入口)。
5. **砍 thread 紧急卡——关源头,不只藏 JSX(Codex):** thread 卡的**创建路径不止一处**:advisorTrigger crisis card 创建在 `GameCanvas.tsx` ~1144、doctrine breach 创建在 ~1189、staff-ask 走 `createThread`。要**在这些创建源头改走对话**(发问句进对话道),**不是只隐藏渲染层**(render ~1521 / approve ~735)。

**不碰:** 玩家手动命令路径、解析 prompt、命门区。

**手测:**
1. 造"救 A 要抽空 B"两难 → Chen 是否在**对话里问你**(不是弹 thread 卡、也不自动动兵)?
2. 你答了之后,是否按你的答案走?
3. 日志里是否有这次 escalate 的记录(带 correlation id)?
**通过 bench:**
- [ ] 两难时出对话问句,**thread 紧急卡不再弹**。
- [ ] **没有任何自动调兵**(6a 只问不动)。
- [ ] 日志含 escalate 记录 + correlation id;typecheck 绿。

**完成:** commit + tag `step6a-escalate`。

---

## Step 6b — Chen 自主:act-and-report + 可撤销 ⚠️ 会反复改,最后做

**目标:** 明显又安全的事,Chen **自己干了 + 回报**;一律可撤销。

**初版关到最死:** 仅当【线要塌(`estimateCollapseTime`)+ 增援"decisive"(`assessReinforcement`)+ 候选是**有编组的闲置 squad**(非 `__reserve__`、missionPriority 0)+ 不掏空另一条危险线 + 非玩家操作/有令/doctrine 锁(照搬 `autoBehavior.ts` 护栏)】→ **自动增援 + 回报 + 可撤销**;**永不自动撤退**(撤退看 doctrine,没设就走 6a 问)。

**具体改动:**
1. 用 6a 的数据结构(`autonomous`/`actionId`)下增援订单(`applyOrders.ts` 的 `applyOrders`/`applyPlayerCommands`),走 GameCanvas 的 autonomous helper,**不在 advisorTrigger 里**。
2. **回报别复用 staff-ask(Codex):** `/api/staff-ask`(index.ts ~186)的 prompt 要"2-3 options",会继续造卡。改用**模板**(最便宜:「{front}告急,我把 {leader} 调过去了,能守住。」)或一个**只 voice 不给选项的新小调用**。
3. **可撤销:** 用 `actionId` 实现"召回"(10 秒窗口 / 一个按钮),把该自主订单回滚。
4. **记反应:** 自主动作后,把玩家随后的原话反应用 correlation id 关到这次动作上(Step 1 日志)。

**护栏(照搬 autoBehavior):** 绝不动玩家在操作 / 有玩家命令 / doctrine 锁 / 高优先级任务的 squad。

**手测:**
1. 南线告急+北线有闲置编组预备队 → 自动增援+回报+召回可用?
2. 你正手动操作某队时触发 → 那队绝对没被碰?
3. 自动动作 + 你随后骂一句 → 日志里两者用 correlation id 对上了?
4. 两难场景 → 仍走 6a 问,不自动动?
**通过 bench:**
- [ ] (1) 自动增援+一句回报+一键召回。
- [ ] (2) 玩家在操作/有令/doctrine 锁的单位**绝对没被自动移动**。
- [ ] (3) 日志里动作与反应用 id 关联上。
- [ ] (4) 两难仍是"问"不是"干"。
- [ ] typecheck 绿。

**⚠️** 预计反复调阈值——**每次只调一个参数再测**。必须 6a 稳了再上。

**完成:** commit + tag `step6b-act-and-report`。

---

## 本轮之后（不要现在做）

- **prompt 精简:** 让 prompt 对清楚命令只出一个方案。**碰命门(ai.ts),风险最高,全稳后单独小步。**
- **个性化算法:** 用 Step 1/6 攒的数据长偏好维度表 + 调引擎闸门。
- **敌人节奏 + influence map。**

---

## 每步通用清单（每步都照做）

1. 读本步点名的文件,核对当前代码(行号会漂,按实际适配)。
2. 只做这**一**步。
3. `npm run typecheck` → 绿。
4. 本地跑,**停下,请用户照 bench 手测**。
5. 用户确认通过 → commit + tag → 下一步。绝不跳步、不批量。
