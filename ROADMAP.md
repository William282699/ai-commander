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

### ▶ 第 5 级 — Emily 生产合同（V1a 手测实证插队，2026-07-20）【当前：一页纸已写待裁决】
实证双弹：①$3,850 问"能生产多少坦克"，Emily 答"2辆主战或4辆轻型"（真相 9/19——digest 只给裸余额，LLM 被迫心算=违宪）；②"剩下的钱都生产主战坦克"被静默降级成 ×1（`resolveProduce` 量词只认数字，"all" 直接掉兜底）。修法双件套：digest 引擎算好的 PRODUCTION 可产量事实节 + produce 移植 **7b.1 tradeBudget fraction_of_money 成熟合同**（该模式本就长在 Emily 的 trade 上）。提案 `EMILY_PRODUCTION_V1_PROPOSAL.md`。

### ⏭ 第 6 级 — 批准合同化（同场实证插队）
escalation 问句只是软上下文非合同：实测"批准"撞上连环升级绑错对象且**误执行**（8 单位被派往未批方向）。修法 = pendingDecision 合同机制扩到 escalation 提案（问句登记具体提案，authorize 逐字执行被捕获案）；ChatPanel 代码注释早已标 `Deterministic resolve of a confirm is Tier 2, deferred`。写提案时论证是否并入 Preflight V2。

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
