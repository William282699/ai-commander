# 战场信息压缩机制 V2 — 设计稿 v3（2026-07-18，按 Codex 第二轮裁决修订）

## 0. 裁决记录

- **产品方向（用户授权，Codex 已撤回"越界"异议）**："玩家可指代实体必须回答三问（在哪/在干嘛/怎么样）"+ 引擎先形成结构化 BattleBoard、再投影给 Chen/Marcus/escalation，为长期架构方向，**保留**。
- **本轮实施 = 仅 V1b front escalation**（已有生产事故的最短修复）。
- **V1a 延期重提，不删除**（前置条件见 §5）。"方向成立"与"当前稿可实施"分开判断。
- 顺序统一：先 V1b；V1a 完成架构修订后另行裁决。

## 1. V1b 改动本体（允许文件仅此 5 个）

1. 新增 `packages/core/src/frontEscalationPayload.ts`：纯函数 `buildFrontEscalationPayload(state, crisis)` —— **生产与 A/B 脚本唯一共用组装点**（脚本自行拼字符串 = 测复制品 = 白测）。
2. `packages/core/src/crisisResponse.ts`：**仅**导出 `estimateSquadTravelTime`。契约如实记录：对每个成员从当前位置到目标做直线地形采样估算、取最慢成员；**不是 A\* 实际路径 ETA**，payload 字段名用 `eta_est_sec` 明示估算。
3. `packages/core/src/index.ts`：**仅**导出新 builder。
4. `apps/web/src/GameCanvas.tsx`：**仅改 ~463-475 的 front escalation 分支**（改为调 builder）。proactive（`buildProactiveMiniFacts` ~338-366，含其自有 `idle_reinforcement_available` ~360）与 facility 分支（~450-462）一字不动 —— GameCanvas 只有**一个** front escalation 序列化点。
5. 新增 `scripts/ab-front-escalation.ts`：`--synthetic`（边界断言）与 `--ab`（LLM 对比）两种模式，payload 全部来自同一 builder。

## 2. Payload 契约

- `front / stake / our_committed_force_survival_sec / local_power_ratio_ours_to_visible_enemy / raw_signal` 五行**字节级原样**；唯一变化 = `idle_reinforcement_available` 一行替换为 `reinforcement_options` 块。
- **候选全集先生成 → 排序（无任务优先，其后 ETA 升序）→ 展示截 3 → 计算真实省略数。** "3"只是序列化展示预算：不参与分组、不构成候选池上限、绝不影响实际可调兵。
- 空集措辞区分两种情况："战场上无其他友军" vs "有 N 股但均交战中/更远"（F1 事故 = 混淆此二者）。
- ETA 非有限数或无法估算 → `unknown`；禁止输出 Infinity、禁止假 0 秒。
- fog：候选块只读友军（天然 fog-safe）；任何涉及敌军的判断必须显式 `state.fog === "visible"`，或改用不依赖敌军的自身证据。

## 3. 字段数据 contract（写死，禁猜）

- **候选来源**：crisis front 区域外的我方可派遣单位（区域内 = 已投入，计在 survival/power 内，不得列为增援）；排除 manual-only 与 commander。
- **编组候选** = squad（leaderName 称呼，括号保留 id）。**未编组候选**两步分桶：
  ① 明确有限半径的**确定性空间分组**（连通分量；半径为写死常数并注释理由）；
  ② 每组贴**最近命名地点仅用于命名**，不用于判定归属。
  合成测试必须覆盖：同最近地名但相距远不得合并、半径边界、单点组。
- **任务状态五级判定**（从上到下，首个命中即停）：
  1. 真实交火证据 → `交战中`。证据必须是引擎时间戳且校验非初值（如 `lastAttackTime > 0 && now - lastAttackTime < 窗口`），**开局 0 值不得误判为最近开火**；
  2. active mission：`squad.currentMission` 存的是 **mission ID** → 必须回查 `state.missions`；`defend_area` → `守卫`；查不到或无法映射 → `unknown`；
  3. order `defend`/`hold` → `守卫`；`patrol` 或 patrolTask 反查 → `巡逻`；
  4. 全部成员无 mission/order 且 idle → `无任务`；
  5. 成员状态混杂或无法解析 → `unknown`（**禁多数票猜测**）。
- **HP%**：分子 = Σ存活成员当前 hp；分母 = Σ**存活成员** maxHp（阵亡不计入分母；规模用 unit 数另行如实给出）。
- **位置命名**：静止 → 半径内最近命名地点；移动且目的地可解析 → "向 X 行进中"；不可解析 → 省略位置短语，**禁止伪造地点**。

## 4. 验收

1. **合成断言**（`--synthetic`）：分桶三案、任务状态五级、ETA unknown、截断与省略数、空集两措辞、fog 不变性 —— fog 断言**只针对新增 reinforcement_options 块**（旧 `estimateCollapseTime` 现仍读取迷雾内敌军，本轮不顺手修，不宣称整 payload 逐字节不变）。
2. **LLM A/B**（`--ab`）：合成战局（必含 el_alamein 开局 74 未编组单位案）同一 builder 出新旧两版 payload，各喂 LLM 3 次人工判读；冻结生产抓包当"改前"参照（真实时刻战局未存盘，不能严格重放，如实声明）。
3. **手测（1 次）**：等**自动 escalation** 触发，检查 Chen 主动问句与 Network 中 `/api/brief` 实发 payload。**不得**用事后聊天"有增援吗"代替 —— 那走 `/api/command-stream` 普通聊天 digest，不是本链。
4. typecheck 全过。

## 5. V1a 重提前置（本轮不实施；重提通过后文件另批）

- BattleBoard 归 **core**；依赖流向 `core/battleBoard.ts → core/intelDigest.ts → shared/digest.ts 接收预计算行`，禁 shared→core 反向依赖；
- DigestV1 与 BattleContextV2 **消费同一份** BattleBoard 结果（Marcus 走真实路径 `battleContext.ts`，只换事实输入，不动角色边界与 prompt）；
- 空间分组与地点命名两步分离、三问字段沿用 §3 contract；
- Chen、Marcus 沿**各自真实路径**分别验收。
- 未编组桶的口头调度（"大本营附近那股"）不在 V1a：需 command schema 新来源字段，归 command-preflight 提案。

## 6. 禁止清单（继续有效）

proactive 与 facility escalation 分支、`digestHelper.ts`、`ChatPanel.tsx`、`director.ts`、command/tactical parser、`ai.ts`、`providers.ts`、prompt/schema/触发/预算、冻结 worktree（battlefield-facts-v1）任何写入。
