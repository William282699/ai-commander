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
挂账（V2 弹药）：quantity 无分数概念（"一半"被译成 4 个——需 fraction 量词+复诵回执）；负例偶发 MISSING；确认应答人格语域（"那就算了"）；静态降级模板人话化。

### ▶ 第 4 级 — V1a：三问态势板（"Aiden 那边怎么样了"）【当前：一页纸待写】
玩家指得出的实体，参谋答得出三问：在哪/在干嘛/怎么样。BattleBoard 归 core，DigestV1 与 BattleContextV2 消费同一份（Marcus 走真实路径）；两步分桶；Chen/Marcus 分别沿真实路径验收。
重提前置（Codex 已定）写在 `BATTLEFIELD_INFO_V2_DESIGN.md` §5。手测实证缺口：Aiden 剩 1 人显示 mission=idle、47 未编组单位裸计数无位置。

### ⏭ 第 5 级 — Capture 停滞反馈
实证 bug：占领圈 80% 静默卡死（半径 1.5 格+无对抗判定，战后单位散圈外，零反馈）。修法=停滞时 Chen 报一句+战后归位。Capture 雷区：必须一页纸提案先行（2026-07 大修撤回教训，归档 `~/MyProjects/_archive/capture-overhaul-20260717`）。

### 🔭 第 6 级 — Preflight V2：provenance
Intent 字段分 playerCommand / unspecified / advisorProposal，根治 74 单位洞（该 bug 目前**有意放回**，手测撞到不是新 bug）。

### 🔭 第 7 级 — Pull 模型（给 Chen 装手）
LLM 主动查询引擎（工具调用）。**触发条件**：V1a 验证发现 Chen 频繁答不上追问，或地图大到一屏摘要装不下。届时工具的返回值 = 现有 board 行/预演函数，前面的活不白干。

### 🔭 第 8 级 — Visual Consult（截图给 LLM）
空间直觉题（"是否被包抄"）文字表达不好，图一眼懂。需新图片通道。排在 V1a 验证"文字够不够"之后。

### 🔭 第 9 级 — 同局分叉实验
（用户+Codex 保留项，待展开成提案。）

### 🔭 第 10 级 — 培养自己的 AI Commanders ／ 不可重演的战争电影
护城河方向：不同玩家养出的 Chen 顶的话不一样（最小落地=preflight 顾虑随 style 参数变化）；跨局记忆与档案见北极星愿景。

## 归档与资产

- 冻结资料库：worktree `AI Commander-battlefield-facts-v1` @ `4298505`（生产抓包 fixtures 不可再生 + 事实层研究）。
- Capture 大修归档：`~/MyProjects/_archive/capture-overhaul-20260717/`（patch+commandGate+guard 用例，preflight V2 可复用其语义表）。
- bench：`scripts/ab-front-escalation.ts`（--synthetic 40 断言 / --ab 真 LLM 对比）。
