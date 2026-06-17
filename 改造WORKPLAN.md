# 对话化改造 · 开工 WORKPLAN（完整执行版）

> **给接手的 Claude Code 窗口:** 这份是自带上下文的执行计划。**先从头读完**,再按步骤开工。
> 工作目录 = 当前仓库根 `AI Commander`(直接在这个文件夹,不要开 worktree)。
> 配套(背景参考,非必读):`改动方向-傻瓜版.md`(为什么/变成什么样)。

---

## ⚠️ 最高优先级的工作方式（违反 = 失败）

1. **一次只做一步。** 做完一步 → `npm run typecheck` 绿 → **停下,让用户手动测,过了 bench 才 commit。** 用户没确认通过之前,绝不开下一步。
2. **行号是快照,会漂。** 每步动手前**先读那几个文件**,确认当前代码和本文一致,不一致就按实际情况适配,别盲改。
3. **不碰命门:** `apps/server/src/ai.ts` 里 `SYSTEM_PROMPT` 的**中段**(意图语义 / 否定处理 / 地名匹配 / Chen 人设)——**除了最后"prompt 精简"那步,一个字不动**。那是已验证的"命令理解",碰了就毁核心资产。
4. **永不退步。** 任何一步让原本能跑的变差 = 不算过,回滚。
5. 建议开一个分支 `conversation-redesign`(同一文件夹,不用 worktree),每步 commit + tag;不想分支就在 main 上,但每步必 commit 以便回滚。

---

## 0. 项目速览（冷启动必读）

**游戏:** AI Commander —— 玩家用自然语言(语音/文字)指挥有人格的 AI 参谋打即时战略。玩家不微操;命令 → LLM 解析成结构化 intent(JSON)→ schema 校验 → 引擎执行。三个参谋:**Chen(陈军士,战斗)/ Marcus(参谋)/ Emily(后勤=生产/补给)**。核心要做的是「司令感」:说了就办、部下回报、会自己拿主意。

**Monorepo 结构(npm workspaces):**
- `apps/web` —— React + Vite 前端。`ChatPanel.tsx`(对话/命令,2500+行)、`GameCanvas.tsx`(战场)、`messageStore.ts`(消息流)。
- `apps/server` —— Express,LLM 代理 + TTS。`index.ts`(路由)、`ai.ts`(prompt + LLM 调用)、`providers.ts`、`routes/tts.ts`。
- `packages/core` —— **纯模拟引擎,无 I/O 无 console**。`sim.ts`、`combat.ts`、`economy.ts`、`tacticalPlanner.ts`、`enemyAI.ts`、`autoBehavior.ts`、`crisisResponse.ts`、`advisorTrigger.ts`、`applyOrders.ts`。
- `packages/shared` —— 类型 / `schema.ts`(LLM 输出校验)/ `digest.ts` / 常量。

**运行 & 验证:**
- 前端:`npm run dev`(:3000) 　 后端:`npm run dev:server`(:3001)
- 类型检查(每步必跑):`npm run typecheck`(全 workspace,当前是绿的)
- 后端需要 `apps/server/.env` 里的 LLM key 才能跑命令解析(已存在)。Step 1/3/5 大部分不依赖 LLM;Step 2/4/6 要后端在线。

**架构铁律(贯穿):** LLM 只做两件事——**解析命令** + **用 Chen 口气说话**;**决策和执行永远在引擎**。别把决策搬给 LLM,别破坏命令解析。

---

## 顺序总表

| 步 | 内容 | 主要文件 | 风险 |
|---|---|---|---|
| 1 | 日志地基(纯增量) | server `index.ts` + 前端请求体 | 极低 |
| 2 | Emily/生产不弹卡 | `ChatPanel.tsx` `canAutoExecute` | 低 |
| 3 | 战报与对话分面 | `messageStore.ts` + ChatPanel 渲染 | 低 |
| 4 | 砍 A/B/C 卡(前端) | ChatPanel 流式结果处理 + 卡渲染 | 中 |
| 5 | 据点有分量 | `economy.ts`(+ 可选 `combat.ts`) | 中 |
| 6 | Chen 自主 + 回报/上报 | `advisorTrigger`+`crisisResponse`+`applyOrders` | 高·会反复改 |

(据点 5 故意排在 Chen 自主 6 前面:6 行为复杂会反复调,先把确定性的全落稳。)

---

## Step 1 — 日志地基（纯增量）

**目标:** 服务器端把玩家每条命令 + 关键事件结构化记下来,为以后的个性化攒干净数据,顺带治"测试者到底玩没玩"的盲区。

**文件/锚点:**
- 后端:`apps/server/src/index.ts` —— 路由 `/api/command`、`/api/command-stream`、`/api/command-group`、`/api/staff-ask`。
- 前端:各 fetch 调用点(`ChatPanel.tsx` ~938 / ~1145 / ~1248;`GameCanvas.tsx` ~1162 / ~1282 / ~1412)。目前**没有 sessionId**(已确认),需新增。

**具体改动:**
1. 前端:新建一个 `apps/web/src/session.ts`,模块加载时生成一次 `export const SESSION_ID = crypto.randomUUID()`(或存 localStorage 跨刷新)。在每个 `/api/*` 请求体里加 `sessionId: SESSION_ID`。
2. 后端:在 `index.ts` 加一个 `function logEvent(o: object) { console.log("[EVENT] " + JSON.stringify({ t: Date.now(), ...o })); }`。在每个命令路由里调用:记 `{ type:"command", sessionId, channel, message }`(message 截断到比如 500 字),以及响应摘要 `{ type:"response", sessionId, responseType, options: n, briefLen }`。
3. **保留区:** 不改任何决策/prompt/游戏逻辑。纯加日志。
- **持久化备注(不在本步做):** `console.log` 在 `fly logs` 里看得到(测试窗口期足够);要跨重启留存,以后挂 Fly volume 写 JSONL。本步只做 console 结构化输出。

**不碰:** 决策、prompt、引擎、前端表现。

**手动测试:**
1. 本地起前后端,玩一局,下 3-5 条命令(中英文都来)。
2. 看后端终端输出。

**通过 bench:**
- [ ] 每条命令产生一行 `[EVENT] {...}`,含 `sessionId` + `t`(时间戳) + `message` 原话。
- [ ] 游戏玩起来跟改之前**零差别**。
- [ ] `npm run typecheck` 绿。

**完成:** commit + tag `step1-logging`,停,等用户确认。

---

## Step 2 — Emily / 生产命令不弹卡（改动 2）

**目标:** 清楚的生产/交易命令直接执行 + Emily 回报,不弹卡。

**锚点:** `apps/web/src/ChatPanel.tsx` → `canAutoExecute`(~253),内部按 intent 逐个判定的 for 循环(~291)。
**病因(已确认):** `produce`/`trade` 类 intent 天生没有 `fromSquad` → 掉进 `else` 分支(~327)→ 要求 `hasSelectedKeyword` → 普通生产命令没有 → 返回 `{auto:false, reason:"no_anchor"}` → 弹卡。Emily 全职 produce/trade,故必弹。

**具体改动:** 在逐个 intent 的循环开头(`isValidTarget` 检查之后、anchor 逻辑之前)加一个早判:
```
if (intent.type === "produce" || intent.type === "trade") continue; // 不派部队,无需 anchor
```
即 produce/trade **绕开部队来源闸门**。钱够不够由下游 resolver(`resolveProduce`/`resolveTrade`,在 `tacticalPlanner.ts`)处理——先读一眼确认不够钱时引擎是 refund 还是拒绝,卡这一层不该管钱。

**不碰:** 解析 prompt、其它 intent 类型的弹卡逻辑、canAutoExecute 里别的安全检查。

**手动测试:**
1. 跟 Emily(后勤频道)说「生产 3 辆主战坦克」(钱够)。
2. 「造一艘航母」(钱不够时)。
3. 回归:跟 Chen 下一条普通进攻命令。

**通过 bench:**
- [ ] (1) 不弹卡 + Emily 文字确认 + 生产队列出现 3 辆主战坦克。
- [ ] (2) 不弹卡;钱不够时引擎按现有逻辑处理(不崩、有反馈)。
- [ ] (3) 进攻命令行为跟改前一致(没误伤)。
- [ ] typecheck 绿。

**完成:** commit + tag `step2-emily-no-card`。

---

## Step 3 — 战报与对话分面（改动 3）

**目标:** 系统战报和参谋说的话在 UI 上分开;参谋只说人话,不当广播喇叭。

**锚点:** `apps/web/src/messageStore.ts` —— 已有 `MessageLevel = info|warning|urgent`、`MessageSource = heartbeat|event_report|command_ack|player|system`、`MessageFrom = player|chen|marcus|emily|system`(数据已经分好,这步主要是**渲染层用起来**)。ChatPanel 里消息渲染处(搜 `displayMessages` / `getMessages` 的 `.map`)。

**具体改动:** 渲染时按来源分两类:
- `from === "system"` 或 `source ∈ {heartbeat, event_report, system}` → 渲染成**「战报」行**:压暗、字小、**无头像**、单独一条视觉道。
- `from ∈ {chen, marcus, emily, player}` → 渲染成**人物气泡**(现有样式)。
- `level === "urgent"` 的系统消息:仍在战报道,但颜色突出(可置顶)。

**不碰:** 消息怎么产生(`addMessage` 调用点)、引擎、LLM。只动渲染。

**手动测试:**
1. 打一场有战斗的局。
2. 观察聊天区。

**通过 bench:**
- [ ] 系统战报(「X 受攻击」「弹药 40%」)在单独、低调的战报道(无头像)。
- [ ] Chen/Marcus/Emily 的话在人物气泡里。
- [ ] 两者不再混成一样的气泡;下命令→回复仍正常。
- [ ] typecheck 绿。

**完成:** commit + tag `step3-feed-split`。

---

## Step 4 — 砍 A/B/C 决策卡（前端，改动 1）

**目标:** 清楚命令直接执行 + Chen 回报;有歧义问一句;有风险顶一句确认。**不再弹 A/B/C 菜单。** prompt 不动。

**锚点(已定位):** `ChatPanel.tsx` 流式结果处理 ~1100-1130:
- `gate = canAutoExecute(options[0], ...)`(~1100)
- `if (gate.auto && options.length>=1)` → `handleApprove(...)` 自动执行(~1108)
- `else` → `setResponse(data)` (~1124) ← **这一行渲染了那张卡**
- 非流式路径 ~1248;空 options/澄清路径 ~1063-1082;`handleApprove`(~1267);卡的 JSX(搜 `response.options` 的 `.map`)。

**具体改动:** 把"`gate.auto=false` → 弹卡"改成走对话分支:
- options ≥ 1 且可执行 → **自动执行推荐项**(`handleApprove(options[recommendedIdx])`)+ 把 Chen 的 brief 作为消息显示,**即使 gate.auto=false**——除非下列两种"该问"的情况。
- 真歧义(options:[] / 澄清 / NOOP)→ 显示 Chen 的问题/brief(~1063-1082 已部分处理),不弹卡。
- 风险(responseType="CONFIRM",若有)→ 显示 Chen 一句顾虑 + 一个**轻量 yes/no 确认**(不是 3 选项卡)。
- 净效果:`setResponse(data)` 那条渲染 A/B/C 卡的路径被替换为「自动执行+回报」或「问一句」;隐藏/删掉多选项卡渲染。
- **保留安全网:** `detectStaleSquadRefs`(~208)、`mission_conflict` 等——若推荐项引用了已阵亡的 squad 或冲突,**回退到"问一句",别盲目执行**。这些 guard 不能丢。
- **prompt 不改:** LLM 照旧返回 1-3 选项,前端只取推荐那个、永不显示菜单。解析安全。

**不碰:** 解析 prompt;canAutoExecute 内部的安全判断(复用它来决定"执行还是问",只是不再据此弹菜单)。

**手动测试:**
1. 清楚命令:「Aiden 去打 El Alamein」。
2. 有歧义:「去北边」(多个"北"目标时)。
3. 有风险:能触发 CONFIRM 的命令。
4. 回归:之前能正确执行的几条再下一遍。
5. 故意引用一支刚阵亡的 squad → 应"问/警告",不该误执行。

**通过 bench:**
- [ ] (1) 不弹卡,直接执行 + Chen 回报,部队真动了。
- [ ] (2) 不弹 3 卡,Chen 问一句澄清(或按最合理执行)。
- [ ] (3) Chen 顶一句 + 单个确认,你确认后才执行。
- [ ] (4) 无回归。
- [ ] (5) stale-ref → 问/警告,不盲执行。
- [ ] typecheck 绿。

**完成:** commit + tag `step4-no-card`。

---

## Step 5 — 据点有分量（改动 5）

**目标:** 占据点 → 持续收入,丢了 → 没了,让 Chen 的回报有分量。

**锚点(基础设施基本已存在!):** `packages/core/src/economy.ts`:
- `processEconomy`(~71)每帧调 `tickIncome`(~92,加 base+bonus 收入)、`tickFacilityCapture`(~109,占领进度)、`recalcBonusIncome`(~170,**从拥有的设施算 bonusIncome**)。
- 可选:`combat.ts` `calculateDamage`(~86),高地/entrench 攻击加成(entrenchLevel + 地形防御加成 ~116 已有,镜像加一个攻击侧)。

**具体改动:**
1. **先读 `recalcBonusIncome` 的现状** —— 如果它已经按设施给 bonusIncome,只是值太小/为 0,就**调成有感的值**(按设施类型/重要度,money/fuel),让占/丢一眼看出收入变化。如果还没接,就按"每个玩家拥有的可占设施贡献一份 bonusIncome"补上。这步多半是**调数值,不是从零写**。
2. **(可选,可砍)高地攻击加成:** `calculateDamage` 里,若 attacker 是 foot 单位且在高地(或 entrenched),加个小攻击乘数(+10~20%),照抄现有防御加成的写法。时间紧就跳过。

**不碰:** 对话 / LLM / 卡 / feed / 前几步逻辑。

**手动测试:**
1. 占一个据点,盯 money/fuel 收入。
2. 丢一个据点,盯收入。
3. (可选)高地步兵 vs 平地步兵的输出。

**通过 bench:**
- [ ] (1) 占点后每段时间收入增加(重要点增得多)。
- [ ] (2) 丢点后那份收入消失。
- [ ] (3,可选)高地步兵攻击更高。
- [ ] 其它系统不受影响;typecheck 绿。

**完成:** commit + tag `step5-stakes`。

---

## Step 6 — Chen 自主 + 回报 / 上报（改动 4）⚠️ 会反复改,放最后

**目标:** 明显又安全的事 Chen 自己干了 + 回报;有两难就问你。**初版关到最死。**

**锚点:**
- `advisorTrigger.ts`(~43 `processAdvisorTriggers`)—— **挑事 + 路由**(现在只输出 crisis_card / llm_advice)。
- `crisisResponse.ts` —— **决策**:`estimateCollapseTime`、`findBestReinforcements`(~400,返回带 `assessment: decisive|delaying|insufficient` 的候选)、`assessReinforcement`。
- `applyOrders.ts` —— `applyOrders` / `applyPlayerCommands`(~42 起)**下发玩家方订单**(参考 `enemyAI.ts` 用 `applyEnemyOrders` 的写法)。
- `autoBehavior.ts` —— **护栏范式**:Priority 1「玩家正操作的单位绝不碰」、Priority 3「有命令的不覆盖」、doctrine 闸门。照搬这些约束。
- 发声:复用 `/api/staff-ask` 流程,或 v1 直接用模板;消息发进 Step 3 的"对话道"。
- 记录:扩展 Step 1 日志,记 (特征 + 动作 + 玩家随后的原话反应)。

**v1 范围(只做这一小块,关到最死):**
- **触发:** advisorTrigger 检测到玩家某条线要塌(用 `estimateCollapseTime`)。
- **决策:** `findBestReinforcements` 取最佳候选,**仅当**:`assessment === "decisive"` **且** 候选是闲置 squad(missionPriority 0)**且** 抽它不掏空另一条危险线 **且** 不是玩家在操作/有命令/doctrine 锁的单位。
- **执行:** 给该 squad 下一个 defend/move 订单到该线(`applyOrders`,玩家方);标记为"自主动作"以便区分 + 可撤销。
- **回报:** 往对话道发**一条** Chen 口气的消息(v1 用模板即可:「{front}告急,我把 {leader} 调过去了,能守住。」)。
- **可撤销:** 给一个"召回"入口 / 短时间内可回退。
- **永不自动撤退**(高后悔);**两难就问**(escalate),不自作主张。
- **记录:** 把 (特征+动作+玩家随后反应) 写进日志。

**护栏(照搬 autoBehavior):** 绝不动玩家在操作的 / 有玩家命令的 / doctrine 锁的 / 高优先级任务的 squad。

**不碰:** 玩家手动命令路径、解析 prompt。

**手动测试(脚本化场景):**
1. 造"南线告急 + 北线有闲置预备队"→ Chen 是否自动增援 + 回报 + 召回可用?
2. 造"救 A 就得抽空 B"两难 → Chen 是否改成**问你**(不自作主张)?
3. 你正手动操作某队时触发危机 → 那支队是否**绝对没被碰**?
4. 自动动作后看日志:有没有 (特征+动作+你的反应)?
5. 你骂「谁让你动的」→ 反应是否被记下(v1 至少记录;Chen 当面提议规则可作下一子步)?

**通过 bench:**
- [ ] (1) 自动增援发生 + 一句回报 + 能一键召回。
- [ ] (2) 两难时是"问"不是自作主张。
- [ ] (3) 玩家在操作/下过令/doctrine 锁的单位**绝对没被自动移动**。
- [ ] (4) 日志有那一条三元组。
- [ ] (5) 反应被记录。
- [ ] typecheck 绿。

**⚠️ 注意:** 预计**反复调阈值**——**每次只调一个参数再测**,别一把改一堆。必须 Step 1-5 全稳后才进这步。

**完成:** commit + tag `step6-chen-autonomy-v1`。

---

## 本轮之后（不要现在做）

- **prompt 精简:** 让 prompt 对清楚命令只生成一个方案(省 token)。`ai.ts` SYSTEM_PROMPT 第 104 / 151 行 +「有风险用 CONFIRM、真不懂用 ASK」。**碰命门,风险最高,全稳后单独小步。**
- **个性化算法:** 用 Step 1/6 攒的数据,长偏好维度表 + 调引擎闸门。
- **敌人节奏 + influence map。**

---

## 每步通用清单（每步都照做）

1. 读本步点名的文件,核对当前代码(行号会漂,按实际适配)。
2. 只做这**一**处改动。
3. `npm run typecheck` → 绿。
4. 本地跑起来,**停下,请用户照 bench 手测**。
5. 用户确认通过 → commit + tag → 下一步。绝不跳步、不批量。
