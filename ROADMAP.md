# AI Commander 路线图（活文档：每步收口时更新状态。新窗口开工前先读这里）

> 使用法：新开 Claude 窗口 → 它会自动读跨窗口记忆 → 让它读本文件 → 找到 ▶ 的那一步 → 读对应提案文件 → 干活。每步收口：commit + tag + 更新本文件状态。

## 铁律（所有步骤共用，违者打回）

1. **信息层**：引擎推事实给 LLM（候选+代价，不传结论；不确定省略不硬标）；LLM 只做两件事——听懂人话、把事实说成人话。LLM 不算数、不找信息、不做决定。
2. **禁关键词穷举**：LLM 行为不对时写 1-2 行语义原则，永不写同义词表。
3. **确认是指挥关系，不是机械闸门**：Chen 角色内顶风险，玩家自然语言授权。
4. **流程**：一页纸提案 → 用户+Codex 裁决 → 新 worktree → 一步一测一 commit → 手测 → 合 main+tag。绝不在主仓库工作区实施。
5. **能跑 > 优雅**（MVP 验证期）；延迟是设计参数，命令链的秒回不可牺牲。

## 梯子（自下而上）

### ✅ 第 1 级 — V1b：front escalation 候选块
Chen 危机时报真实增援候选+ETA，替换说谎的布尔字段。F1 已修。
`tag: bfi-v1b-front-escalation-done` · 设计稿 `BATTLEFIELD_INFO_V2_DESIGN.md` · 已合 main。

### ✅ 第 2 级 — Voice Polish V1：模板句人话化
回执禁坐标（镜像 resolveTarget 命名）、单气泡去横幅、战报 30s 冷却、罗盘称呼+中央死区。
`tag: voice-polish-v1-done` · 已合 main。

### ✅ 第 3 级 — Command-Preflight V1：确认对话化
大命令：引擎纯预演真账（planAttack/planSabotage 共用管线，离队语义）→ Chen 角色内顶一句（mode:"preflight"，问号校验，真数字兜底）→ 玩家自然话授权（pendingDecision 严格四值 + 路由表 fail-closed + 词表封箱 NEVER EXPAND + 对象同一性重启守卫）。
`tag: preflight-v1-done` · 提案 `COMMAND_PREFLIGHT_V1_PROPOSAL.md` · Codex 七轮审查 · 真模型负例闸 45 调用零错误授权 · 手测："没问题，相信我，平推吧"三连中；游戏内重开双变体零幽灵。已合 main。
挂账（V2 弹药）：quantity 无分数概念（"一半"被译成 4 个）——**修法=移植 7b.1 tradeBudget 的 fraction_of_money 成熟合同**（LLM 只出 fraction、引擎算术、钳制[0,1]、畸形静默降级）到兵力量词 + 复诵回执（"37 出发 37 留守"）；负例偶发 MISSING；确认应答人格语域（"那就算了"）；静态降级模板人话化。

### ✅ 第 4 级 — V1a：三问态势板（"Aiden 那边怎么样了"）
玩家指得出的实体三问必答：`core/battleBoard.ts` 唯一 builder，DigestV1 SQUADS 行尾追加 task/hp/loc（现有 token 逐字前缀，fromSquad 解析契约不破）+ UNASSIGNED_UNITS 裸计数换空间群行（可指代把手，整层消费 V1b options 零重建 label）；BattleContextV2 加 FORCES 节（同一 board，交战中→无任务→守卫/巡逻→unknown 四级排序，8 行+真实省略数含单位数）。真模型跑出群 label 被塞 fromSquad 的诱惑 → 节头一行语义标注"NOT valid fromSquad"（引擎本就 fail-closed）。
`tag: battle-board-v1a-done` · 提案 `BATTLEFIELD_BOARD_V1A_PROPOSAL.md` · Codex 三轮裁决 · bench `ab-battle-board.ts` --synthetic 37 断言 + parser 精确闸真模型 9/9（Aiden→"Aiden"、I1→"I1"、问句零 intent）· 手测双态：健康态三路径 + 交战态实弹两轮——首轮抓到位置断言违约（实发行无 `loc=` 却答"在阿拉曼镇"=目的地冒充位置）→ SQUADS 节头补一行位置铁律（loc= 是唯一已证位置、缺席=未证、目的地≠位置）→ 复测零编造（"仅剩2个步兵单位，北部战线被压制，战力比1.26，预计还能支撑10秒"，全部可溯源）；V1b escalation 同局正常开火（勾稽活证）。已合 main。
**口径裁定（用户 2026-07-20）**：引擎给精确当前事实；参谋可做符合证据的战场化概括（hp=40% 说"损失过半"可），**不得虚构精确累计数字**（阵亡数/减员%/无预演依据的时间全禁）。
挂账：FORCES 交战行>8 条时第九条起截断（如实声明非 bug）；未编组群口头调度归 Preflight V2（需 command schema 来源字段）。

### ✅ 第 5 级 — Emily 生产合同（V1a 手测实证插队，2026-07-20）
实证双弹已灭：①digest 新增 PRODUCTION 事实节（三类各一行+queued，≤4 行；`now=min(钱界,油界)` 同扣款快照；谓词 cost>0&&buildTime>0 封口防除零；节头写死 now 不可加+max 10/order）；②produceBudget 合同=tradeBudget 完整解剖移植（LLM 只出 fraction、**一个 Order 携带、applyOrders 实时结算**——resolver 零件数宣称防假执行；enqueueProduction 仍是唯一真实入口；诚实拒绝三分：预算为零≠钱不够≠设施缺失）。
`tag: emily-production-v1-done` · 提案 `EMILY_PRODUCTION_V1_PROPOSAL.md` · Codex 两轮裁决+条件批准 · bench `ab-emily-production.ts` --synthetic 38 断言（全部最终状态口径：queue 增量+钱油差值+回执；含用户审计补的燃油为零负例——零件回执必须报真实约束，钱油分界不合并）+ 真模型 12/12（fraction 时 quantity 精确缺席；咨询答"9辆主战或19辆轻型"独立上限不相加）· 手测对账：$3,500 咨询报 8/17 原数；"剩下的钱都生产主战坦克"→ queue+8×main_tank、$3,500→$300、fuel−80、回执 `main_tank ×8：花了 $3200，还剩 $300`。已合 main。
挂账：stream 路径首答偶发不主动报数（事实已在 payload，追问即中；偶发波动非事实层缺陷，等真玩家反馈再议）。

### ❄ 第 6 级 — 批准合同化【三版判退，雪藏 2026-07-24】
v2（引擎模板问句）/v3（字符串校验）/v3.2（LLM 台词+引擎小条）连续三版：机制层全过 Codex 四轮+双跑 30/30 零错派，但用户手测判退——三个**结构病**：①会话焦点绑错（普通澄清问句插在合同后，"对的啊"误授权旧合同）②权力旁路（Bucket A 模型选兵自动执行仍在，合同不是唯一入口）③目标类型缺失（"夺回前哨"被降格成"增援战线"）；另 UI 确认件违反"对话是唯一界面"家法。**现场全部封存**：worktree `AI Commander-approval-contract` 工作分支停 `f83f032`（未获准合并），保护分支 `approval-contract-v3.2-failed-handtest`（17 实现 commit+判退全文 `HANDTEST_FAILURE_20260722.md`）。执行回到第 5 级现状：兵只听玩家自己的命令链。**将来重启=v4**，前置是第 6b 级判断执照（参谋敢提具体方案，批准才有对象）；§4b 跨频道身份规则随分支一起雪藏，重启时捞回。

### ✅ 第 6b 级 — 司令感 V1（Commander Presence）【全级收口 2026-07-28：Step A/B/C 三步完成；分支 `commander-presence-v1` 未合 main、未 push，是否合并等用户点头】
司令感=玩家不必学精确语法：四层拆解（感知/指代/判读/意图补全），前三层引擎材料已备只差接线——**引擎是将军的脑子，LLM 只是嘴**。提案 `COMMANDER_PRESENCE_V1_PROPOSAL.md`（v2，Opus5 审查五项实锤已采纳：ReportEvent 无坐标改 unitsInBox、camera 需新建只读桥、placeNameAt 玩家 tag 优先且禁改 nearestPlaceWithin 本体）。**三步各自独立收口，禁打包**：**Step A ✅ 判断执照+长度分档**（拆群聊"1-3句"封印 ai.ts:774+禁下结论旧口径；三 prompt 含 GROUP_SYSTEM_PROMPT；FRONT_JUDGMENT 引擎并列列；五轮手测闭环，tag `presence-step-a-done` @8097356）→ **Step B ✅ commanderMood 情绪温度**（三闸纯函数+信封尾行，calm 不渲染=Act-0 字节守卫；synthetic 48；审核⑤判出语气守则里「无 mood 行＝战场平稳」是 prompt 替引擎下战况结论=铁律1 自违 → fix1 删战况断言换纯语域【mood 行只定语气不定事实】，结构尺三组：修前裸断言 15/20 → 修后 9/30＝删守则对照 6/20 持平达标；⑦ 收口口径=同信封±mood 行、同内容更短 76.3 vs 93.0，不比 calm；四臂证伪与判据见 bench 注释；tag `presence-step-b-done`）→ **Step C ✅ PLAYER_VIEW 共同视野**（镜头是线索不是话题：GameCanvas 只挂 cameraRef 报生几何（camera px+canvas px，闭包捕获会静默冻结开局帧——躲开）、换算/unitsInBox 实体扫描/placeNameAt（玩家 tag 优先→nearestPlaceWithin 兜底，本体零改动）全在 core；PLAYER_VIEW 与 ACTIVE_ESCALATION **并排**进信封由 LLM 自判；选中单位通水既有 PLAYER_SELECTED 管不新造行；三 commit @`21ad676`，synthetic +20=68、真模型**五问法**+劫持护栏手读全过；**实际交付口径（勿夸大）**：✅「那儿是谁的」类空间指代由镜头消解 3/3 稳＝真正新增能力；⚠️ 升级问句在场时对话焦点恒赢、镜头基本不生效（交战时几乎常态）；⚠️「这边怎么样」冷清视口 0/4 不反问、直接报最急战线；⚠️ 台词偶带「镜头内是…」机制词出口（台词层小账）；tag `presence-step-c-done` @21ad676，证据档 `~/MyProjects/_archive/presence-step-c-real-20260728/`）。零执行牵连（判断只在台词）；基线=main `981f896`，worktree `AI Commander-presence` 分支 `commander-presence-v1`；五闸=38/37/40/66+typecheck+ab-commander-presence synthetic 68（无 ab-approval-contract）。治理：用户裁手感，Codex 只做完工安全审计（要求加可见确认件一律不采纳）。
Step B 记账（多为 981f896 老账，本级不动）：① `EnemyEngaged` 字段教学（ai.ts:84「≤10 tiles 可见敌军（此刻接触/交战）」）把"逼近"授权成"接火宣称"→ 陈假接火 8/20 ≈ 删守则对照 7/20（老账）；与已有「V2 缺敌军事实节」同一块地基——一条路少说、一条路多说。② 马克斯被问征询式问句（"有什么要我马上决定的吗"）答"无需决断"5/5、漏报 13 秒 4/5；删守则对照同为 5/5＝老账。③ 马克斯会说"我方占优"而 ratio=0.74。④ 信封 token 直读 1/30（「我方兵力（survival≈4s）」）。⑤ `/api/brief` 心跳/事件播报收到 mood 行但 `CHANNEL_PROMPTS`/`LIGHT_SYSTEM_PROMPT` 从未声明它（6 采样无复读，暂无害）。
方法教训（Step C 验收适用）：Step B 验收从头到尾只用过"现在情况怎么样？"一种问法——记账②是换问法才露出来的；Step C 提案的验收也只写了"这边怎么样"一种，**必须加多问法**。证据全档 `~/MyProjects/_archive/presence-step-b-audit-20260727/`。
Step C 收口四笔新账（2026-07-28 用户手测挖出，审核已核代码，按优先级；**全部不在 6b 动**）：**★★① 撤兵作用域反了（引擎 4 行，能一句话毁一局）**——`tacticalPlanner.ts` 选兵函数里 `quantity==="all"|"most" → 返回全军` 捷径（:1405）排在 fromFront 严格分支最前；玩家说「让北线前哨的部队都撤退」，LLM 单子六采样逐字正确（fromFront:front_coastal, quantity:all），引擎实派 **74/85**（北线只有十来个）。中文「X 的部队**都**撤退」的"都"管 X 那些部队不管全军——作用域理解反了。最讽刺：同文件 :1445 已写着 "Global fallback caused full-army mis-retreats" 的保护（全军误撤教训吃过一次），但它在"该线没兵"分支里、捷径先一步 return 走不到。同族已证：fromSquad 填领队名"Aiden"非编号 I1 → resolveIntent 找不到 → **0 单位动却回话"预计三分钟内抵达"**（静默失败比撤错更阴）。未查完记号：74 单位动员未触发 preflight 预演（阈值没覆盖 retreat？另一个洞？一并查）。tacticalPlanner 在 6b 禁改清单内——**另立一级**，按 Capture 雷区规矩一页纸提案先行，动手前先补 bench 覆盖（选兵逻辑溅 attack/defend）；与第 8 级 provenance 相邻但不同刀（那治"谁要求的"，这治"'都'字管谁"）。**② 存活秒数不计我方还手**——`crisisResponse.ts` estimateCollapseTime：`tCollapse = defenderHP / enemyDPS`（defenderDPS 算了不进公式，假设我方站着挨打）；ratio 13.34 压倒优势线仍报 survival≈34s 有限数，马克斯照读→"面临即时崩溃需优先增援"，陈同时读 ratio 未上当→两人相反建议；我方占优时该数系统性误导，判断执照放开后会被自信说出口。**③ R12 复读作废快照回归（9/10）**——雾线信封+旧快照（8秒/1:6）→ 复读；形态与 Step B「态势平稳+4秒」完全同形（范畴事实赢了、数字跟着上车）；与 Step C 无关已结构证死（presence-step-b-done..21ad676 对 ai.ts/digest.ts/intelDigest.ts/battleContext.ts diff 为空、R12 探针未改、bench 不经 ChatPanel 拿不到 PLAYER_VIEW）；fix5 当日 2/2 即收口——若真实率就是 10%，2/2 全过概率 1% → 更可能模型漂移；无论哪种，**N=2 不构成验收**。**④ 主动播报不进对话上下文**——GameCanvas 零处引用 channelContext/pushContext（grep 可核）：带问号升级问句走 setActiveEscalation → ---ACTIVE_ESCALATION--- ✅；不带问号的主动播报（"中央战线仅剩8秒"）哪儿都不进 ❌。后果：信封里"最近在聊什么"可能是 80 秒前玩家的旧命令且压过当前镜头——实测 80 秒前「Blake 去占领中央雷达」+ 三条播报（全没进信封）后，玩家盯着别的坦克说「把他们撤回来」两次都认成 Blake。三个下刀点不预设：播报进上下文 / 对话焦点加时效 / 不确定就问（反问能力已证存在——"您指的是中央战线我方单位，还是东北方向第一未编组群？"——只是没触发）。
方法教训（第四次判据误导，比结论更重要）：**只读回话字面，会漏掉"字面对、执行错"**。审核窗口先测得「说地名 9/9 全对」并据此建议"加地名就行"——是假的：判据只读 option.label（恒对），实派单位数在 8/74/0 之间跳，用户手测一局证伪。规矩立死：**凡会动兵的验收，必须跑 resolveIntent 数 assignedUnitIds.length，不许看台词**。本级四次判据误导（Step B 正则两向饱和 / 验收单一问法 / R12 关键词表 / 只读台词）共同形状：判据测的是"说了什么"，病在"做了什么"。

### ✅ 派兵作用域 V1（dispatch-scope-v1，插队于第 7 级前）【实施+审核通过 2026-07-28，tag `dispatch-scope-v1-done` @811dc4e；与 6b 一起合 main】
一句话病灶与刀：`quantity` 能改写"从哪个池子选兵"——「让北线前哨的部队都撤退」LLM 单子完全正确（fromFront:front_coastal, quantity:all）引擎却派 74/85。刀=删 `tacticalPlanner.ts` :1405 的 quantity=all/most→全军捷径；**口径（用户拍板 07-28）：作用域归 fromFront/fromSquad，数量归 quantity，quantity 永远不许扩大作用域；唯一全军入口=fromFront 本身为"全军/all"（isAllFrontHint，已 export 供闸共用防漂移）**。五 commit：①`3267beb` 回归网先行（发现 :1447"勿全军误撤"保护在 quantity=all 下是**死代码**，空战线也全军撤）②`5eefa5f` 刀+合同 C1-C8（C7=死保护复活）③`14e9dfa` 2a 静默封口——真机制在 **ChatPanel 软修复把解析不了的 fromSquad 删掉**（"将自动分配单位"→retreat+all 掉进广派），改硬失败+人话回执【清单外已披露】；引擎 leaderName 大小写对齐；ai.ts 一行"逐字抄 SQUADS 节"④`0445922` 2b 确认闸——**触发器在 ChatPanel:312 类型清单不在 preview:492**（preview 只给已判定的配数字）【清单外已披露】；retreat/defend 进清单，planRetreat 按 ONE-pipeline 范式抽取（P3=预演 ids===执行 ids）；fromFront 有名收窄的不算高影响（砍卡法：清楚就办）；attack/sabotage 闸字节不动⑤`811dc4e` 真模型：事故句 ×3→10/84 全在北线、南线句 ×3→14/84 全在南线（LLM 出单、本地引擎数人头）。审核独立复核（自造场景数 assignedUnitIds+核来源集合）：四动词 ×fromFront+all 各 10/10 零外溢、全军入口无误伤、假分队名 0 单位+degraded、六闸 38/37/40/66/68/19+typecheck 零 FAIL。
三笔待办（审核判定 07-28）：**① toFront-only + quantity=all 仍广派**（审核实测 74 个；提案只点名 :1405，C8 已把现状钉死——另立一刀）。**② 说明书纠偏（审核实测为准）：「全军后撤」的确认闸 13 次只响 2 次**——LLM 通常把它拆成三条前线级单子（coastal/center/south），每条 frontScoped=true 闸放行；结果仍正确（32 单位分三线撤），非危险，是"宣传与实际不符"；按家法「清楚就办」全军后撤本该直接办——**改说明书，不改闸**。**③ 两个待用户拍板先记着别动**：「您没点名部队，我按战况替您安排」罐头台词在玩家明说"全军"时照发；attack/sabotage 确认闸未放宽造成不对称（「北线的部队全部撤退」一句话就办、「北线的部队全部进攻」还要确认）——是否接受待裁。
bench 家法新条目（写在 ab-dispatch-scope.ts 注释）：会动兵的断言必须 resolveIntent 数 assignedUnitIds+核来源集合；bench 自造 fuzzy front 匹配当场烧手（"southern"配不上 id"front_south"，空 bbox 把全对判全错）——成员判定必须用生产 findFront，hint 配不上就 throw。

### ⏭ 第 7 级 — Capture 停滞反馈
实证 bug：占领圈 80% 静默卡死（半径 1.5 格+无对抗判定，战后单位散圈外，零反馈）。修法=停滞时 Chen 报一句+战后归位。Capture 雷区：必须一页纸提案先行（2026-07 大修撤回教训，归档 `~/MyProjects/_archive/capture-overhaul-20260717`）。

### 🔭 第 8 级 — Preflight V2：provenance
Intent 字段分 playerCommand / unspecified / advisorProposal，根治 74 单位洞（该 bug 目前**有意放回**，手测撞到不是新 bug）。

### 🔭 第 9 级 — Pull 模型（给 Chen 装手）
LLM 主动查询引擎（工具调用）。**触发条件**：V1a 验证发现 Chen 频繁答不上追问，或地图大到一屏摘要装不下。届时工具的返回值 = 现有 board 行/预演函数，前面的活不白干。

### 🔭 第 10 级 — Visual Consult（截图给 LLM）
空间直觉题（"是否被包抄"）文字表达不好，图一眼懂。需新图片通道。排在 V1a 验证"文字够不够"之后。

### 🔭 第 11 级 — 同局分叉实验
（用户+Codex 保留项，待展开成提案。）

### 🔭 第 12 级 — 培养自己的 AI Commanders ／ 不可重演的战争电影
护城河方向：不同玩家养出的 Chen 顶的话不一样（最小落地=preflight 顾虑随 style 参数变化）；跨局记忆与档案见北极星愿景。

## 归档与资产

- 冻结资料库：worktree `AI Commander-battlefield-facts-v1` @ `4298505`（生产抓包 fixtures 不可再生 + 事实层研究）。
- Capture 大修归档：`~/MyProjects/_archive/capture-overhaul-20260717/`（patch+commandGate+guard 用例，preflight V2 可复用其语义表）。
- bench：`scripts/ab-front-escalation.ts`（--synthetic 40 断言 / --ab 真 LLM 对比）。
