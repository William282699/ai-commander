# 三问态势板 V1a — 一页纸提案 v3（2026-07-19，按 Codex 第二轮裁决修订，待终审）

## 0. 裁决记录

- v1 未批（2026-07-19）：架构方向与爆炸半径均获认可；四阻断项 = 验收缺 Marcus-问-Aiden 与命令解析 fixtures / 未编组口径自相矛盾 / export-only 未封住群 label 组装 / "伤亡"无证据+文件清单缺两个文档。另 fog 措辞不实。
- v2 = 逐条落实第一轮最小修订清单（群 label 整层消费 V1b options、centroidOf 撤出导出清单）。
- v2 二轮裁决：架构与九文件边界**通过**；余两处一行级契约修订——守恒分母缺 `hp>0`/非 commander 两门槛；"Aiden 结构上不可能被截掉"不成立（交战行>8 条时第九条仍截）。
- v3 = 落实上述两处 + §3.1 非阻断措辞改准。Codex 已声明：完成即批，无需第三轮架构重写。

## 1. 目标与实证缺口

宪法：玩家指得出的实体，参谋必答三问——在哪/在干嘛/怎么样；三问全部引擎算好，LLM 只听懂人话、把事实说成人话。
手测实证缺口（ROADMAP 第 4 级）：
- **Aiden 案**：squad 剩 1 人正在挨打，SQUADS 行却是 `mission=idle`——引擎没算"正在交火"，Chen 只能照 idle 撒谎。
- **47 未编组案**：UNASSIGNED_UNITS 只有 `47×infantry` 裸计数，无位置无状态，"预备队在哪"三问全空。

V1a = BattleBoard 归 core，DigestV1（Chen/combat）与 BattleContextV2（Marcus/ops）**消费同一份** board 结果。不新增信道、不动任何 prompt、不动角色边界。

## 2. 架构（§5 前置逐条落实）

- 依赖流向：`core/battleBoard.ts → core/intelDigest.ts → shared/digest.ts 接收预计算行`。shared 侧只新增一个 **optional 纯字符串参数**（类型定义在 shared 本地），**禁 shared→core 反向 import** 由构造保证。
- Marcus 真实路径：`core/battleContext.ts` 内部调 `buildBattleBoard`（core→core），`buildBattleContextV2` 签名不变 ⇒ `digestHelper.ts`/`ChatPanel.tsx`/`GameCanvas.tsx` **零改动**。
- 唯一真相源分两路（Codex 阻断项 3 的封法）：
  - **未编组群行 = 整层直接消费 `buildReinforceOptions(state, null).options`**——罗盘八向、同向序号、label 唯一性组装全部留在 V1b builder 原地，battleBoard **不得重建任何群 label**；
  - **squad 行**用 export-only helpers（清单见 §3.2）对**所有存活成员**计算，不复制第二份逻辑。

## 3. Board contract（三问字段，全部沿用 V1b §3）

1. **覆盖实体**：
   - **squad 行**：`role="leader"` 且存活成员>0 的 squad，成员口径 = 该 squad **全部存活成员**（含 manualOverride——squad 行反映整个 squad 现状）。CMD 包装、commander、manual-only 单体、facility 的 board 行为**本轮非目标**；DigestV1 中已有者（MANUAL_UNITS/FACILITIES 等节）保持不动。
   - **未编组群行**：`buildReinforceOptions(state, null)` 的 options 中，去除 squad 条目（按 `leaderName(id)` 精确 label 集合剔除，非模式匹配）后的全部群条目，label/unitCount/composition/hp/task **原样消费**。front=null ⇒ 无内外过滤、etaSec 全 null，天然无 ETA。
   - **守恒分母写死**（= V1b pool 全部四道门槛，见 frontEscalationPayload.ts:354-360，非仅谓词函数）：
     ```
     hp > 0 && type !== "commander" && isDispatchablePlayerUnit(u) && !inAnySquad.has(u.id)
     ```
     **不排除 air**。这使 UNASSIGNED_UNITS 节口径从现行"非 manual-only"**收紧为"可派遣"**（manualOverride 单位不再列入）——与该节注释本意 "dispatchable unit types outside squads" 对齐，属有意口径统一，非疏漏。
2. **squad 行三问**（export-only helpers：`locationPhraseFor`、`groupTaskStatus`、`hpPctOf`、`compositionOf`）：
   - **在哪**：全静止→"X附近"（NAME_RADIUS 12）；全移动且目的地质心可解析→"向X行进中"；混合/不可解析→**省略**，禁伪造。
   - **在干嘛**：五级判定原样（交火证据时间戳>0，开局 0 值不误判 → mission id 回查 → orders → 无任务 → unknown，禁多数票）。**task=unknown 时整个 token 省略**（不确定省略不硬标）；`mission=` 原 token 保留，MISSIONS 节仍是任务详情真相源，不扩映射表。
   - **怎么样**：hpPct（分母只算存活成员）+ 现存 unitCount；morale 行内已有不重复。**board 无原始编制快照，只有当前现存值——任何"累计伤亡"口径不存在，验收与序列化均不得出现**。
3. **守恒**：Σ群 unitCount == 上述 dispatchable 未编组 pool 总数，bench 断言——分组绝不吞单位、不重复计。
4. **fog（措辞按裁决改准）**：board 不读任何敌军单位；地点命名读取的是**既有公开地点元数据**（存活设施名、战线中心），不是敌情。fog 断言限定为：**隐藏敌军单位或改动 fog 矩阵，board 输出逐字节不变**。

## 4. 改动本体（允许路径仅此 9 个：7 实现/测试 + 2 文档）

1. `BATTLEFIELD_BOARD_V1A_PROPOSAL.md`——仅本提案修订；随 worktree 分支首个 commit（Step 0）入版本控制，合 main 时带回。
2. **新增** `packages/core/src/battleBoard.ts`：纯函数 `buildBattleBoard(state)` + 两个序列化器（digest 预计算行 / FORCES 行）。
3. `packages/core/src/frontEscalationPayload.ts`：**仅加 `export` 关键字**（`locationPhraseFor`、`groupTaskStatus`、`hpPctOf`、`compositionOf` 四个；`buildReinforceOptions` 已导出）。零逻辑改动；本文件 diff 只允许 export 增量；闸 = `ab-front-escalation --synthetic` 40/40。
4. `packages/core/src/intelDigest.ts`：`buildDigest` 内建 board → 传预计算行给 `generateDigestV1`。
5. `packages/shared/src/digest.ts`：`generateDigestV1` 加 optional 第 5 参 `DigestBoardLines { squadLineSuffixById; unassignedGroupLines }`（纯字符串，类型定义在本文件）；**不传该参 = 输出逐字节不变**（bench 断言）。
6. `packages/core/src/battleContext.ts`：**仅**追加 `---FORCES---` 节；其余节一字不动。
7. `packages/core/src/index.ts`：**仅**导出 `buildBattleBoard` 与行类型。
8. **新增** `scripts/ab-battle-board.ts`：`--synthetic` + `--ab`（含命令解析 fixtures，见 §6.4）。
9. `ROADMAP.md`——**仅**全部验收通过后的收口状态/tag 更新。

其余全部禁止，尤其 `digestHelper.ts`、`ChatPanel.tsx`、`GameCanvas.tsx`、`ai.ts`、`providers.ts`、`director.ts`、`commandPreflight.ts`、parser/schema/prompt/触发/预算、两份既有 bench。

## 5. 序列化契约（append-only，保护 parser）

- **SQUADS 行**：现有 token（`leaderName(id,leader) parent:… Nunits(…) @(x,y) morale=… mission=…`）**逐字保留为前缀**，仅行尾追加 ` task=… hp=…% loc=…`（unknown/不可解析字段整个不出现）。fromSquad 解析契约（ai.ts:234）靠前缀成立——**SQUADS 保留 squad ID 红线由此守住**。
- **UNASSIGNED_UNITS 节**：节名保留；裸计数行替换为群行（label 原样来自 V1b builder），上限 `MAX_GROUP_LINES=6` + `...+N more groups (M units)` 真实计数。
- **FORCES 节**（BattleContextV2 追加，紧凑版 label/unitCount/hp/task/位置短语）：**确定性排序写死 = 交战中 → 无任务 → 守卫/巡逻 → unknown，同级按 label localeCompare**；上限 `MAX_FORCE_LINES=8` + 真实省略数。排序理由：ops 信道两端最关心交战部队与预备队。**如实声明：排序只保证交战行优先；交战行本身超过 8 条时第九条起仍按真实省略数截断，不作"永不截"的普遍保证。** Aiden 验收 fixture 必须断言其行位于前 8 且实际序列化在场（bench 断言）。
- 体积有界：全部行上限硬编码，最坏增量约 1.5KB（典型 <400 字符）。

示例（Aiden 案修后）：
```
  Aiden(I1,leader) parent:chen 1units(1×infantry) @(84,51) morale=3.2 mission=idle task=交战中 hp=8% loc=鲁韦萨特岭附近
---UNASSIGNED_UNITS---
- 大本营附近未编组群: 12units(infantry×12) hp=88% 无任务
- 北方向未编组群: 20units(infantry×18+at_gun×2) hp=95% 无任务
...+1 more groups (15 units)
```

## 6. 验收

1. typecheck 全过。
2. **三闸**：新 bench `--synthetic` 全绿；`ab-front-escalation --synthetic` 40/40；`ab-command-preflight --synthetic` 66/66。
3. **合成断言清单**（`--synthetic`）：Aiden 案（1 存活成员+近期 `lastDamagedAt`>0 → `task=交战中`；开局 0 时间戳不误判）；unknown 省略（无 `task=` token 而非 `task=unknown`）；SQUADS 现有 token 逐字前缀 + squad ID 保留；**群行与 `buildReinforceOptions(state,null)` 逐字段一致（label 零重建断言）**；未编组守恒（Σ=§3.1 分母总数，含 el_alamein 开局 74 案）；**守恒分母四边界：idle 但 hp=0 排除、非 manual-only 的 commander 排除、manualOverride 排除、air 保留**；群 label 全局唯一 + 直径 ≤ `CLUSTER_DIAMETER_CAP`；**不传 board 参 → generateDigestV1 与 pre-V1a 逐字节相同**；FORCES 与 digest 群行同源（label 集合一致）+ **FORCES 四级排序确定性 + Aiden fixture 位于前 8 且实际序列化在场 + 超限时省略数为真实计数**；fog 不变性（隐藏敌军/改 fog 矩阵 → board 逐字节不变）；确定性（同 state 两次逐字节相同）。
4. **命令解析回归 fixtures**（内嵌 `--ab`，真模型经 `/api/command`，同一战局旧/新 digest 各 ×3）：
   - `派 Aiden 去 Coastal` → `fromSquad="Aiden"`；
   - `派 I1 去 Coastal` → `fromSquad="I1"`；
   - `Aiden 那边怎么样` → consultation，**不产生任何可执行调兵 intent**。
   闸 = 新 digest 九次零错；旧 digest 同跑作对照记录。
5. **LLM A/B**（`--ab`）：同一合成战局旧/新 digest 各喂 3 次"Aiden 那边怎么样了"/"预备队都在哪"，人工判读三问齐不齐；el_alamein 开局 74 未编组案必测。
6. **手测（真实路径，各 1 次，均抓 Network 实发 payload）**：
   - Chen/combat 问"Aiden 那边怎么样了"→ 回答含**位置/交战状态/当前现存人数与 HP**（禁推断累计伤亡），无坐标（voice polish 契约）、零编造；payload 中 SQUADS 行 suffix 在场；
   - **Marcus/ops 问"Aiden 那边怎么样了"**→ 走 BattleContextV2 真实路径；payload 中 **FORCES 确有 Aiden 行**；
   - Marcus/ops 问"预备队都在哪"→ FORCES 群行落地。
   **不得**用合成脚本代替真实路径。

## 7. 步骤（worktree `AI Commander-board-v1a`，一步一测一 commit）

- Step 0：本提案 v3 入分支首个 commit。
- Step 1：battleBoard 内核 + export 复用 + bench 内核断言（闸：新 bench + 40 + typecheck）。
- Step 2：DigestV1 接入（闸：+66 + 逐字节 legacy 断言）。
- Step 3：FORCES 接入（闸：同源 + 排序确定性断言）。
- Step 4：`--ab`（含 §6.4 parser fixtures）+ 手测三条真实路径 → 收口：合 main + tag `battle-board-v1a-done` + 更新 `ROADMAP.md`（仅此时触碰）。

## 8. 非目标（本轮不做）

- 未编组群**口头调度**（"大本营附近那股给我调过去"）——需 command schema 新来源字段，归 preflight V2 提案（§5 已裁）。
- **累计伤亡/战损 delta**——需原始编制快照，board 只有当前现存值，另立提案。
- mission 类型→人话映射扩表（attack_area 等）——MISSIONS 节已是真相源，扩表是新语义决策，不夹带。
- supplyStatus 死字段修复（7c 已知）、facility/air/manual 单体行改造、Pull 模型、截图通道。

## 9. 考虑过并否决

- **battleBoard 自建未编组群行**（v1 方案）：罗盘/序号/唯一 label 组装埋在 buildReinforceOptions 内部，自建即第二份真相源——Codex 阻断，改为整层消费 options（本版）。
- **原语抽新模块** boardPrimitives.ts：对 V1b 闸文件 diff 更大且有搬移风险；export-only 最小、bench 可证零行为变化。
- **feature flag**：optional 参数已是结构性兜底，MVP 期回滚 = revert commit。
- **FORCES 用 digest 行原样**：ops 信道是压缩档，用紧凑版守 token 预算；同源性由 bench 断言保证。
