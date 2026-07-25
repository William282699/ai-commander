# 司令感 V1（Commander Presence）— 提案 v2（2026-07-24；v1 三处断言与代码不符已修正，结构按独立收口重排为 Step A/B/C）

## 0. 背景、高度与边界

第 6 级批准流三版判退已回滚封存（worktree `AI Commander-approval-contract` @ `f83f032`，保护分支 `approval-contract-v3.2-failed-handtest`，判退全文 `HANDTEST_FAILURE_20260722.md`）。用户裁定：批准流雪藏，本级做**司令感本体**。治理规则：用户裁手感方向，Codex 只审安全底线；要求加可见确认件一律不采纳（家法：对话是唯一界面）。

**高度（防跑偏）**：司令感不是让 AI 变聪明，是让玩家不必学一套精确语法去操作机器。四层拆解=**感知**（同看一块沙盘）/**指代**（听懂"这儿"）/**判读**（共享同一套优先级、敢下判断）/**意图补全**（北极星，不是本级的债）。前三层引擎材料已备，只差接线——**引擎是将军的脑子，LLM 只是嘴**。
**信封结构澄清（勿误读为"砍全局"）**：全战场摘要**已经存在且必须保持**，第 1-5 级的家底一行不动。**两条路由**（已核 `digestHelper.ts:25`；`ENABLE_BATTLE_CONTEXT_V2 = true` @ `featureFlags.ts:9`）：
- **ops = Marcus → BattleContextV2**（6 节：FORCES/FRONT_BALANCE/KEY_RISKS/SITREP/OPEN_COMMITMENTS/PLAYER_INTENT；`packages/core/src/battleContext.ts`）。玩家问 Marcus 全局问题（"占了几个据点""北线兵力"）靠的是这一份。
- **combat/logistics + 群聊作战室 → DigestV1**（15 节：FRONTS/SQUADS/FACILITIES/PRODUCTION/UNASSIGNED_UNITS/MANUAL_UNITS/MISSIONS/DOCTRINES/ROUTES/AIR/TAGS/MARKED_TARGETS/PLAYER_SELECTED/STYLE/WIN_PROGRESS）。**真身在 `packages/shared/src/digest.ts`（520 行）；`core/intelDigest.ts` 只是 76 行转发器。** 群聊走 combat（`ChatPanel.tsx:1095`）——**用户的作战室场景吃的是 DigestV1，不是 Marcus 那份。**

本级新增的是**叠在全局摘要之上的两类增量**：判断用的并列数字列（Step A）与镜头周边的局部细节（Step C）——增量按问题的形状切片即可，**绝不用切片替换全局**；全局摘要维持旅级高度（战线/编队/群），不膨胀成逐单位流水账。**勾稽关系红线：两条路由的既有节一律不动，只许追加；改任一 builder 必须 byte 对照证明其余节逐字不变。**

**舞台已存在，是松绑不是新建**：群聊作战室已在跑——`callGroupAdvisor` 一次吐三人（ai.ts:848），`GROUP_SYSTEM_PROMPT` 明写 "This is a war room" 且允许接话/顶嘴（ai.ts:770-775）。现在他们被两道封印绑着：**句数上限**（ai.ts:774 群聊通则 + 各 persona 行自带的更严上限，散落约 8 处，清单见 Step A.2）掐死了长推演；**"禁下结论"**的旧口径让参谋不敢表态。本级 Step A 就是拆这两道封印。

**与 v4 的关系**：本级是 v4 的**前置**不是绕路——判退 P1 要的"将军汇报—提出明确方案—长官批准—唯一回执"，前半截（敢提方案）就是判断执照；参谋不敢提案，批准流永远没东西可批。**边界一句话：本级只让对话像真的（听得懂你指哪、语气随战况、敢给判断）；谈完之后部队真按这个动，是 v4 的事，不在这儿。**

**零执行牵连红线（全级通用）**：只改"说什么、怎么说"。`resolveIntent`/`applyOrders`/`tacticalPlanner`/`commandPreflight`/`schema.ts`/`types.ts` 一行不碰；判断只存在于台词（consult 走现有 NOOP 路径），零 intents 生成点。

## Step A — 判断执照 + 长度分档（先做：纯 prompt+并列数字，零新管线，当晚可听）

1. **判断执照**：保留栅栏=禁虚构精确累计数、loc= 位置铁律（07-20 口径原样）。拆除栅栏=禁下结论。新口径（收口时注记 ROADMAP 铁律 1）：*"不传结论"修订为"不传未经计算的结论；引擎已算出的比较，LLM 应当转述成明确取舍。"* prompt 语义原则一行：被问判断题（先救哪/该不该/值不值）时基于并列数字给出**明确立场+一句理由**；数字不齐就说清缺哪块，**不逃到"看您决断"**。
2. **长度按言语行为分档**：命令回报/执行确认维持短（1-3 句，秒回感）；**战略推演/判断题/被追问时允许成段说透**。改为分档语义原则（不挂例句）。三条实况（已 grep 核实，冷窗口勿重新推导）：
   - **现成范式可抄，勿自创措辞**：Chen 在 `ai.ts:76` 与 `ai.ts:676` **已经是言语行为分档**——"ORDER/执行回执 1-2 句话；CONSULTATION 时（被问比较/判断/分析）2-4 句"。本条 = 把这个已验证的模式**推广**到 Marcus 与群聊，并把 CONSULTATION 那档从"2-4 句"放宽到"推演可成段说透"。
   - **上限散落约 8 处，必须整串一起过**：`ai.ts` 的 76 / 316 / 333 / 386 / 424 / 676 / 766 / 767 / 774。⚠️ **只放宽 774 的群聊通则、却留着 persona 行里"全中文回复，1-2句话上限"（766 / 424）＝两条冲突指令，LLM 通常听更具体的那条，结果是"改了没效果"。**
   - **勿混两个 Marcus 上限**：群聊里 Marcus = **1-3 句**（767）；**1-4 句**在独立频道 `SYSTEM_PROMPT_MARCUS_V2`（333）。拿"1-4句"去群聊里找会找不着。
3. **覆盖三个 prompt**：`SYSTEM_PROMPT`、`SYSTEM_PROMPT_MARCUS_V2`、**`GROUP_SYSTEM_PROMPT`（ai.ts:770 起；用户的作战室场景全发生在群聊，漏它这级白做）**。
4. **并列数字**：危机时各战线 `survival_sec`/`power_ratio` 并列同框，判断有据。已实锤在手的材料：tCollapse/powerRatio/engagementIntensity/estimatedCollapseSeconds（已验）。**开工前勘察项（诚实标注，未验）**：Marcus 式推演还需要距离估算、预备队位置、敌军威胁评估——这三样 digest 里有没有、缺哪列，先勘察再最小补列（byte 对照证明其余节不变）。
   - ⚠️ **距离这一列不是"补个方便"，是修一个 Step A 会放大的既有偏差（已核）**：`ai.ts:80` 教参谋用**曼哈顿距离**自己心算（横纵差相加——因为 LLM 开不了平方根），但引擎实际**走直线**（`sim.ts:217` `Math.sqrt(dx²+dy²)`，燃油同源 `:285`），单位可以斜穿。曼哈顿永远 ≥ 真值，45° 斜向**高估约 41%**，再 ÷moveSpeed 得出的 ETA 系统性偏悲观——**可能把来得及的增援判成来不及**。判断执照一放开，这个偏差就会被自信地说出口（撞家法"禁虚构精确累计数"）。**正解=引擎预计算真实直线距离列，参谋读数不心算；兜底=若这一列一时补不上，参谋只许说"最多 X 分钟"（曼哈顿是上界，句句为真，不会把来得及说成来不及）。**
5. **验收（独立收口）**：真模型 fixtures——"先救哪条战线？"×3 → 明确选边+引擎数字理由，禁踢皮球；同问在健康局 → 如实说不紧急；群聊里一人长推演他人短接话的分档实测。用户手测点头才进 Step B。

## Step B — 情绪温度（一个纯函数+一行信封）

1. core 新增纯函数 `commanderMood(state)` → `{ level: "calm"|"tense"|"critical", reason: 一行引擎事实 }`。材料全部已验实锤（导演层 tCollapse/engagementIntensity/beats）。阈值常数显式声明在函数顶部（如 critical=任一战线 tCollapse≤30s 且交战中），不藏魔法数。
2. 信封加一行 `mood: tense（北部战线约30秒内承压加剧）`；三个 prompt 各加一行语义原则：语气随 mood 起伏——calm 从容简短、tense 短促带急、critical 电报式；**不挂例句**。TTS 不动。
3. **验收（独立收口）**：synthetic=三档阈值边界（含 tCollapse=Infinity/无交战→calm）；真模型=同一问题 calm vs critical 各 3 次语域可区分（人工判读记录）；用户手测：危机中听 Chen 语气变急。

## Step C — 共同视野 PLAYER_VIEW（最后做：工程量最大）

**代码事实先行（v1 的三处错误断言在此修正，冷窗口勿重新推导）**：
- ReportEvent **没有 position 字段**（types.ts:473 起的接口定义）且 `state.reportEvents` 是每 tick 排水的队列非时间窗——**"按视口过滤战报"这条路是死的**。视口内容改用 **`unitsInBox(state, bbox)` 活实体扫描**（units 恒有 position，纯 filter）。
- `camera` 是 GameCanvas 渲染 effect 里的**局部变量**（GameCanvas.tsx:1245），当前没有任何暴露——需**新增 `cameraRef` + `getViewport()` 桥接**（只读几何）。`getSelectedUnitIds` **已是 ChatPanel 的 prop**（ChatPanel.tsx:578），勿重复造桥。
- `nearestPlaceWithin` 只认设施名/战线名，**不看 `state.tags`**（frontEscalationPayload.ts:247）。新增 **`placeNameAt()`**：先认玩家自己起的 tag 名（司令旗——玩家愿意插旗是主动花的精度，懒得插就靠镜头兜底），再 fallback 到设施/战线解析。**工程红线：禁止改 `nearestPlaceWithin` 本体**——它被 escalation+preflight 共用，改它会溅到别处的目的地解析与台词。

**分层边界**：GameCanvas 只暴露 **viewport 几何**；实体扫描、地名解析全在 core 新文件 `commanderPresence.ts`（渲染层不做空间查询）。

**命门：镜头是线索，不是话题**（防 PLAYER_VIEW 帮倒忙）：
1. 信封标签必须写 **`镜头对准:`**——不许写成"你正看着"（那会让镜头冒充话题）；
2. **两个焦点并排进信封**让 LLM 判：对话焦点（现有 `---ACTIVE_ESCALATION---`，ChatPanel.tsx:1227）与镜头焦点同时在场，引擎**不做 NL 分类**（传候选不传结论——铁律 1 原样）；
3. 语义原则一行：**默认对话定话题；镜头只用来消解空间含糊**（"这边/那儿"类指代）；拿不准就问一句。

**PLAYER_VIEW 节格式**（≤5 行，宁缺勿假）：镜头对准的地名（placeNameAt 解析不出→省略行）、选中单位（空→省略）、视口内友军/可见敌军概况（unitsInBox，无→省略）。

**已有管子勿重复造（已核）**：DigestV1 里 `---PLAYER_SELECTED---` 与 `---TAGS---` 两节**已经存在**，而 ChatPanel 两处调用都只传 3 个参数（`:1095`/`:1242`），`selectedUnitIds` 默认 `[]`——**管子铺好了没通水**。"选中单位"优先走"把已存在的参数真的传进去"，不新造一行；PLAYER_VIEW 只承载 DigestV1 里没有的东西（镜头地名、视口内实体概况）。注意 ops=BattleContextV2 没有这两节，所以 PLAYER_VIEW 仍按本提案由 ChatPanel 拼接注入（对两条路由都生效）。

**验收（独立收口）**：synthetic=视口无名→省略、tag 优先于设施名、unitsInBox 边界、digest 其余节 byte 对照；真模型=镜头对准 X 问"这边怎么样"→答 X ×3、镜头在 X 但对话在谈 Y 问后续→仍答 Y（镜头不劫持话题）×3；用户手测：盯着某处问"这边怎么样"。

## 改动面（允许清单草案，Codex 完工审计可核）

允许：`apps/server/src/ai.ts`（三个 prompt 的语义原则+长度分档）· `packages/core/src/commanderPresence.ts`（新增：commanderMood/unitsInBox/placeNameAt/buildPlayerViewFacts 纯函数）· `packages/core/src/index.ts` · `apps/web/src/GameCanvas.tsx`（仅 cameraRef+getViewport 只读桥）· `apps/web/src/ChatPanel.tsx`（信封组装注入）· 视 Step A 勘察结果 `packages/shared/src/digest.ts`（**DigestV1 真身——群聊/combat/logistics 走它**）/`packages/core/src/battleContext.ts`（**Marcus 走它**）/`packages/core/src/intelDigest.ts`（转发器）——**仅追加并列列，byte 对照证明其余节逐字不变** · `scripts/ab-commander-presence.ts`（新 bench）· `ROADMAP.md`（仅收口）。
禁改：全部执行链（见 §0 红线）· escalation/proactive 调度与预算 · `nearestPlaceWithin` 本体 · 第 6 级两条冻结分支 · `scripts/ab-command-preflight.ts` 语料。

## 基线与流程

**基线=main HEAD `981f896`**（已核：`8afe599`（第 5 级最后一个代码 commit）到此只动过 `ROADMAP.md`，无代码差异——从 HEAD 开枝可避免每步收口改 ROADMAP.md 时顶掉"rung 6 shelved"那条。main 上没有第 6 级代码与 bench——五闸=emily 38/board 37/V1b 40/preflight 66/typecheck，**没有** ab-approval-contract）。新 worktree `AI Commander-presence`，分支 `commander-presence-v1`。**Step A→B→C 各自独立收口：每步全闸绿+真模型 fixtures+用户手测点头，才进下一步**——一步一测一 commit，严禁三步打包（第 6 级批次过大的教训）。

## 非目标

批准流/点头即出兵（雪藏，v4 的债——本级 Step A 是它的前置）· 执行链任何改动 · TTS 表现力 · 多模态截图（第 10 级）· 长期记忆档案 · 提问调度分诊（另立级）。
