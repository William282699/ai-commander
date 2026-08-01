# Capture 停滞反馈 V1 提案（第 7 级 · capture-stall-feedback-v1）— v2

> 基线 main `b73d973`。只治"卡住时玩家一无所知 + 打完仗没人回圈"，**不碰占领系统本体**。
> 雷区背景：2026-07 Capture 大修整个撤回（归档 `~/MyProjects/_archive/capture-overhaul-20260717`）。本刀范围刻意小。
> **v2（2026-07-29）**：Opus 审核六条修改全部采纳（审核档 scratchpad `CAPTURE_REVIEW_HANDOFF.md`，探针脚本随档）；用户三条裁定落定（频道 ops / 两刀都做含驻守 / 右键路径一并补）；Fable 重读补一刀 A 结构修正（按设施键控，见 §2）。

## 0. 三行人话（影响手感，已含用户裁定）

1. 占领圈开始往回掉的那一刻，作战处（马克斯频道）会报一句为什么（圈里没人了 / 敌人还在圈里 / 对方反占了），不再是 3 分钟后一句"卡在 1%"。
2. 受命占领的部队（说话下令的和**鼠标右键点的都算**）到圈即驻防：打完仗自己走回圈里继续占，占下来就地驻守。已披露代价：驻守单位算"忙碌"，危机自动增援的严格 idle-only 选兵会跳过他们（tacticalPlanner.ts:1436/:1444-1448）；玩家点名指挥不受影响。
3. 占领的速度、半径、规则一个字节不动——只加"嘴"和"回岗的腿"。

## 1. 病灶（逐行复核 + 一手现场溯源）

**一手现场（2026-07-18 22:44 session `82f750ef`，用户原话，记忆档 `project_capture_stall_provenance` + Opus 审核档 §1）**：carter **夺回**中央前哨（`ea_player_central_post`，当时 `fac.team === "enemy"`，非中立），敌军被**打跑**（未打死），蓝圈"**剩大概 20%** 的时候突然不转了"。"80%"是下一条助手回复的换算，被逐窗口抄了 8 次进 ROADMAP，无人重核。**用户看的是蓝色圆环**（rendererCanvas.ts:406），不是任务条。

**占领判定**（`packages/core/src/economy.ts:109-166` tickFacilityCapture）：
- 半径 1.5 格（:131）、非 El Alamein 只认步兵（:124-126）、**必须无对抗**（:138-141）；
- 满圈 5 秒（`CAPTURE_TIME_SEC = 5`），失守**半速衰减**（:159；0.8→0 实测 8.00 秒，1.0→0 实测 10.00 秒，双方独立算得一致）；
- 全函数**零事件输出**。

**两条终态路线（都真实，环从不"冻结"）**：
- **锯齿悬停**：单位/敌兵反复进出圈（P0 反击波次下的常态）→ 环在某个值附近抖；
- **掉光归零**：圈彻底空/被敌占住 → 环 8 秒内掉光后整个不画（renderer :385 跳过）→ 玩家回头看什么都没有。
- **"冻结"只存在于任务条**：missions.ts:194-195 是带守卫的**单向镜像**（仅 `capturingTeam === "player"` 时更新）——capturingTeam 一旦变 null/enemy，mission.progress 冻在末值。环与任务条两个口径，验收分开断言。

**为什么打完仗人不在圈里**（机制链，v2 修正归因）：
- planCapture 派 `attack_move` + `order.targetFacilityId`（tacticalPlanner.ts:1249-1263）；`attack_move ∈ ONE_SHOT_ACTIONS`（sim.ts:21-23）→ 到达落 idle 时 `clearOneShotOrders` **清空 orders**（sim.ts:272-274）；
- orders 空 + idle/defending 正是 **autoBehavior 4a/4b/4c** 拖走单位的前提（**不是** combat 自动接战——combat 只原地开火，且 :218-220 目标死后还回 unit.target 让在途单位继续走）；拖走要求敌人在**视野 5 格内**（findNearestEnemy 对玩家有雾门控），bench 造场景必须踩准；
- **敌兵来源两路（v2.1 探路修正）**：El Alamein defensiveAI **P0 反击**（scenario/elAlamein/defensiveAI.ts:1426-1453，前置闸 `state.enemyAIMode === "defensive"`）**只巡视 captureObjectives 四个剧本目标**——打剧本目标必被 4-6 预备队反扑；用户真实那局的中央前哨**不在四目标里**，圈里的敌兵是**原驻守军被打跑未打死的散兵**。两路都真实，bench 两臂分别覆盖；
- 打完停在交火终点（Opus 探针实测：终态离圈 3.8-4.0 格，+120 秒仍不回）；chaseAnchor leash 只管 >12 格。

**为什么 3 分钟都静默**：衰减期间 capturingTeam 仍是 "player" → mission.progress 每帧镜像衰减值 → `detectMissionStalled`（reportSignals.ts:401-439）"进度没变 180 秒"的计时器**每帧被重置**；归零冻住后才起算 180 秒，端到端实测约 180 秒后才有一句字面"卡在 1%"。唯一近亲 FACILITY_CONTESTED（:254-270）只管敌占我，方向反。

**右键路径全盲**（用户裁定③）：`handleFacilityCapture`（GameCanvas.tsx:1143-1151）发**裸 attack_move**——无 targetFacilityId、不建 mission → 刀B 的闸门、任何任务级检测、现有停滞检测**全都看不见它**。

**另一笔账（记账不动）**：中立设施被敌接管 → 任务条冻 0.80 → neutral→enemy 零事件 → 180 秒后原话报"卡在 80%"（Opus 复现）。真 bug，用户已裁定不扩本刀范围。

## 2. 修法（两刀 + 一补，语义原则）

**刀A · 报一句（v2 结构修正：按设施键控，不按任务）**：占领的"没进展"不是"数字没变"，是"圈子空了/有对手/对方反占了"。停滞是**设施状态现象**，mission 只是消费者之一——右键路径根本不建 mission，任务级检测对它天生全瞎。检测器按 facility 键控：
- 对 `capturingTeam === "player"` 的设施记进度峰值（模块 Map + resetReportSignals 接线，reportSignals.ts 既有模式）；峰值 ≥ 0.25（防路过误触）后从峰值回落 → emit `CAPTURE_STALLED`（severity "warning"、actionRequired true、entityId=设施 id），事实字段：进度%、圈内我方/敌方计数（共用 §2 抽出的计数函数）、三类原因候选（圈内无人 / 敌在圈内 / 对方开始反占）。引擎只推事实，不下结论。
- **★完成态护栏（v2.1，Opus 探路实测 6/6 必踩）**：占领**成功**的那一帧轨迹是 `0.98 → 0`（economy.ts:151-154 满格清零 + capturingTeam 归 null + team 翻转）——形状上就是"从峰值回落"。检测器必须显式排除完成态：进度归零同帧 `fac.team` 已翻为 "player"（或本帧发生翻转）＝占下来了，不是停滞，零触发；T7 对此单独断言。
- **停止条件（在检测器内，不动 missions.ts）**：capture mission 只有"完成/全员阵亡"两个终点、无墙钟超时（missions.ts:79-97），纯 60s 冷却＝永久复读机。每设施每次停滞事件（episode）**最多报 2 次**；进度重新爬升越过峰值线或设施易主则 episode 重置。
- **频道＝ops/马克斯（用户裁定①）**：四个近亲（FACILITY_CAPTURED/LOST/CONTESTED、MISSION_STALLED）全在 ops；combat 在占领卡壳时刻最堵；性质是"你的命令没在推进"＝作战处。
- **director 两张表必须补条目（Opus §3.5，typecheck 不强制）**：`ESCALATION_TYPE_PRIORITY`（director.ts:592，Partial Record，缺条目 `?? 0` 比 MISSION_STALLED 的 1 还低）加 `CAPTURE_STALLED: 2`（比泛用 stall 急、比正被人夺 CONTESTED=3 缓）；`eventFrontId`（:606）加 case：设施 → frontIdForRegion（镜像 FACILITY_CONTESTED 写法），否则永远拿不到导演本拍前线的 +1000，有第二候选就必输。

**刀B · 战后归位**：受命占领的单位，岗位就是那个圈——**到达即驻防，打完回岗**。镜像 retreat-semantics-v1 修法2（sim.ts:255-271）：
- sim.ts 到达分支、**末尾 else 之前**插 else-if：`team === "player" && orders[0]?.action === "attack_move" && orders[0]?.targetFacilityId != null` → `state = "defending"` + **整体替换** `unit.orders = [新 defend 单]`（锚定落点）。
- **★实现口径写死（Opus §3.6，已核 applyOrders.ts:439）**：applyOrders 把**同一个 Order 对象引用**存进全组每个单位的 orders[0]——绝不就地改字段（一动溅一组），必须像 sim.ts:266 那样整数组替换。
- 闸门唯一性（v2 更正计数，结论不变）：Order.targetFacilityId 写入**4 处**——tacticalPlanner :424/:1172（action 均为 "sabotage"）、:1262（planCapture，attack_move）、GameCanvas.tsx 破坏菜单（action "sabotage"）。`attack_move + targetFacilityId` 仍是占领流独有；enemyAI 零写入，team 闸再兜一层。
- defend 机器"射程内还手、脱战回岗、永不追"＝combat.ts:209-217（Opus 探针实测：手工模拟刀B 后 3/3 回圈 0.0-0.8 格、state=defending）。
- 副作用（用户裁定②已接受）：占完就地驻守；驻守算忙碌，危机自动增援 idle-only 跳过（§0 已披露）。

**补 · 右键路径进合同（用户裁定③）**：`handleFacilityCapture` 的 order 加一行 `targetFacilityId: menu.facility.id`。安全性已核：combat.ts:349 伤设施要求 `action === "sabotage"`，attack_move 带此字段不会误伤设施本体。加字段后刀B 闸门认它；刀A 按设施键控天然覆盖（不依赖 mission）。

两刀互补不变：刀B 治人回圈，刀A 覆盖残余（P0 波次僵持、被拽 >12 格、spread 落圈外）并解释"圈为什么掉"。

## 3. 允许改动清单 / 禁改清单

**允许（7 处）**：
1. `packages/shared/src/types.ts` — ReportEventType 加 `"CAPTURE_STALLED"`（一行）。
2. `packages/core/src/economy.ts` — 仅抽 :118-134 计数块为导出纯函数（唯一真相源），行为字节等价。
3. `packages/core/src/reportSignals.ts` — 新检测器（设施键控 + 峰值 Map + episode 预算）+ reset 接线 + 注册。
4. `packages/core/src/sim.ts` — 到达分支一个 else-if（刀B，整组替换 orders）。
5. `packages/core/src/director.ts` — 两张表各加一条目（priority=2 + eventFrontId case）。
6. `apps/web/src/GameCanvas.tsx` — **两处**：EVENT_CHANNEL_MAP 加 `CAPTURE_STALLED: "ops"`（穷举 Record，typecheck 强制）；handleFacilityCapture 加 targetFacilityId 一行。
7. `scripts/ab-capture-stall.ts` — 新 bench。收口时更新 ROADMAP.md。

**禁改**：economy.ts 判定语义（半径 1.5 / 无对抗 / 5s / 半速衰减）· tacticalPlanner.ts 零字节 · autoBehavior.ts 零字节（chaseAnchors 刚动完 fix1）· combat.ts · missions.ts（**含停滞的停止条件——落检测器不落这里**）· detectMissionStalled · defensiveAI/pressureDirector（剧本是测试对象不是修改对象）· 一切 prompt 文件 · 一切 UI 组件（对话是唯一界面）。

## 4. 验收（判据测效果，不测措辞——六条家法逐条落）

**台架自证（N0，先于一切）**：★ tick() 不含 processEconomy / processReportSignals / processMissions / processAutoBehavior / **processDefensiveAI / processPressureDirector**——全在 GameCanvas.tsx:1510-1586。bench 泵帧镜像生产序（tick→economy→reportSignals→…→missions→**enemyAI/defensiveAI/pressureDirector**→autoBehavior；defensiveAI 有前置闸 `enemyAIMode === "defensive"`，各臂如实记录该模式）。N0a：健康占领 5 秒满圈、fac.team 翻转；N0b（v2.1 改写）：各臂场景先自证**结构上表达得出本臂要测的机制段**——主臂自证 AI 行为链（漂走）真发生，副臂自证判定链（入圈→无对抗→衰减）走的是生产 economy.ts 代码而非模拟。

**T1 · main 上复现病（RED 基线，先行 commit）——v2.1 两臂制（用户+Fable 点头 07-29；Opus 七轮探路实证真剧本产不出模式③，显式脚本化优于往剧本里藏触发条件）**：
- **主臂（真剧本零脚本化）＝模式①「占完漂走→白送回去」**（探路 6/6 稳定，比原报 bug 更贵）：真剧本占领完成 → 全队被 autoBehavior 拖到离圈 7-9 格 → 200 秒不回 → 敌散兵回圈 → 断言序列 FACILITY_CONTESTED → FACILITY_LOST（刚占的点丢回去）；单位坐标 + orders 空 + idle 状态逐项断言（数人头+核坐标）。
- **副臂（脚本化，标注理由：测的是 economy.ts 确定性判定段，与 AI 行为无关）＝模式③「0.8→掉光→冻结→静默」**：摆位推进到 ≥0.8 → 敌兵入圈 → 断言 8 秒衰减轨迹、capturingTeam 归 null、任务条冻值、**180 秒内与该设施/该任务相关的事件零条**（v2 收窄口径：ECONOMY_* 每 30 秒必有 4 条，全类型零条必假）——最贴用户实机记忆的终态。
**T2 · 刀B 效果**：主臂同场景 → 断言占完单位驻守圈内（`state === "defending"` 且 `orders[0].action === "defend"` 锚点 ≤1.5——状态本身，位置旁证）、200 秒窗口 FACILITY_CONTESTED/FACILITY_LOST **零条**（模式①灭）；副臂同场景 → 脱战后单位坐标回圈、进度回升、最终 `fac.team === "player"`。
**T3 · 刀B 负对照**：注释转换分支重跑 T2 → 必须真 FAIL。
**T4 · 不误伤**：sabotage 派遣（persist、非 one-shot）与无 facilityId 的 attack_move 到达仍落 idle（与改前快照字节比对）；敌军到达路径不变；右键**破坏**菜单路径不变。
**T5 · 刀A 效果**：T1 场景断言 `CAPTURE_STALLED` 在**首次回落沿**发出（远早于 180 秒）、entityId 正确、事实字段由测试**独立重算**核对（家法⑥）；episode 内最多 2 条（复读机负对照：拉长窗口断言第 3 条不出现）；message 字符串不进断言。
**T5b · 右键路径**：不经 resolveIntent、无 mission，纯 UI 式 order（attack_move+targetFacilityId）→ 刀B 到达转驻防成立 + 刀A 停滞检测成立（证明设施键控对无任务路径生效）。
**T6 · 刀A 负对照**：摘除检测器 → T5/T5b 真 FAIL。
**T7 · 不误报**：健康占领全程零 CAPTURE_STALLED，**含完成帧 0.98→0 清零那一跳**（探路 6/6 成功臂全是此形状，无护栏必误报——单独断言）；行军途中零；路过设施圈（峰值 <0.25）零。
**闸**：八闸基线零 FAIL（emily 38 / board 37 / escalation 40 / preflight 66 / presence 68 / dispatch-scope 19 / retreat-semantics 22 + typecheck，**apps/server 一并 typecheck**）+ 新 bench。谁报的数字对方重算才作数。
**手测**：用户实机 El Alamein 各打一局说话下令占领 + 右键占领——圈掉时 ops 频道出不出话、说的是不是人话、部队回不回圈、占完驻不驻守。

**实施时打印确认清单（Opus §7 遗留，代码推断未实测项）**：createOrdersWithSpread 真实落点会不会被地形推出 1.5 圈；刀B else-if 在真实占领流程的可达性；P0 反击真实节奏（P0_COOLDOWN_SEC、行军耗时、一局几轮）；decisionReview.ts:433-443 与新事件类型的交互；selectDirectorBeat 对 CAPTURE_STALLED 的实际打分路径。

## 5. 不做什么（明写）

- 不改半径/无对抗/速率/衰减——"1.5 格太小"若是真病，实机反馈后另立提案。
- 不复活 capture-overhaul 归档任何内容。
- 不动 detectMissionStalled；不动 missions.ts（capture mission 无超时的账、中立设施任务条冻 0.80 + neutral→enemy 零事件的账，**都记 ROADMAP 不在本刀动**）。
- 不治**模式②「小队被打光→任务永远 0%」**（v2.1 探路发现，记 ROADMAP）：几人小队去夺有守军的前哨被打残（2 死 1 撤 69 格回总部），任务永远 active/0%。它不是全静默（MISSION_STALLED 在 182s 有一句"卡在 0%"），病是慢+说不出"人全没了"这个真相；刀A 判据要求进度从峰值回落、此病进度从未涨过，**天生不触发——不是漏网，是另一个病**。诚实修法＝"指派单位全灭/全撤"另一条判据，挂任务生命周期（missions.ts 禁改），另立刀。此病常见，值得早排。
- 不治"主动播报不进对话上下文"（Step C 账④）——新报告行继承此限制。
- 不做敌方占领对称反馈（FACILITY_CONTESTED 已覆盖）。
- 不动 autoBehavior 攻击单 stale-anchor（另立账）。
- 不调驻守接战方式（用户裁定 07-29）：驻守单位＝各自炮塔就地开火、射程外不追（combat.ts 现状），被远程风筝会站桩挨打——刀A 报停滞 + 玩家点名出击兜底；"几个打几个"等真玩家实感反馈再议，不预设。

## 6. 基线与流程

worktree：`git worktree add "../AI Commander-capture" -b capture-v1 b73d973`。绝不在主仓库工作区实施。
一步一测一 commit：①bench 台架（含 N0 自证）+ T1 RED 基线 + 改前到达行为快照 → ②刀B + 右键补字段 + T2/T3/T4/T5b(B半) → ③刀A + director 表 + T5/T5b(A半)/T6/T7 → ④手测修账。每步八闸全绿、只暂存该步文件、不提交重生成 lockfile。
角色：Fable 提案 → Opus 审（已毕，六条全采纳）→ Fable 重读（已毕，v2）→ 用户拍板（三条已裁）→ **Opus 实施** → **Fable 审**（重算数字 + 亲手跑 T3/T6 负对照）→ 三方讨论 → 用户手测 → 合 main + tag `capture-stall-feedback-v1-done` + 更新 ROADMAP。

## 7. 决策记录与剩余细节

**已裁定（用户 2026-07-29）**：①频道 ops/马克斯；②两刀都做，占完驻守接受（idle-only 增援跳过驻守部队已披露）；③右键占领路径一并补＝第 7 改动点；④驻守接战方式（各自炮塔/站桩挨风筝）押后等真玩家实感；⑤**T1 两臂制**（主臂真剧本模式① + 副臂显式脚本化模式③，用户+Fable 点头）——Opus 七轮探路实证真剧本产不出模式③，且撞出刀A 完成态护栏（6/6 必踩）与模式②新账，探路证据见其报告。
**v2 折入的审核结论**：终态裁定段撤销（一手现场取代）；T1 用真剧本 P0 反击；静默断言收窄；刀A 加第三原因+停止条件；director 两表补条目；刀B 整组替换 orders；闸门写入点 4 处（结论不变）。
**剩余三个小数值待实施时点头（Opus/用户任一）**：priority=2、峰值门槛 0.25、episode 预算 2 次。设计理由在 §2，不是拍脑袋数：2 卡在既有 1 与 3 之间、0.25 防路过、预算 2 防复读机——若实施中发现更好锚点可调，调了要在 commit message 里写为什么。
