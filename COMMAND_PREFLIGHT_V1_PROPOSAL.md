# Command-Preflight V1 —— 确认对话化（提案 v2，2026-07-19，按 Codex 首轮六条修订后待二审）

## 原则（用户亲定，Codex 已确认）

确认不是机械闸门，是指挥关系的一部分——**Chen 以角色内语言指出风险，玩家用自然语言授权**。

## 实证问题（file:line 已核，Codex 首轮确认）

1. 授权 = 9 词白名单精确匹配（ChatPanel.tsx:356）：自然语言授权落空 → 回普通命令流 → 重触发 high_impact 循环；词表撞 no-keyword-enumeration 铁律。
2. 顾虑文本是静态模板（buildGateQuestion high_impact case），与本次命令真实代价无关。
3. Intent provenance / 74 单位洞**延期 V2，本轮不修也不宣称已修**。

## 三块地基（Codex 首轮裁决核心，全部为 V1 前置）

**地基一：纯预演（只算不动手）**
新增 `previewHighImpactIntent()`（`packages/core/src/commandPreflight.ts`）：
- **仅覆盖单 intent、无范围的 attack / sabotage 的 all/most**；
- 与真实 resolver **共用选兵、数量、passability 逻辑**（从 tacticalPlanner 抽取共用纯函数，正常 resolve 结果必须逐字不变）；
- **零状态变化**：不碰 formation/diagnostics/missions/mission counter；
- V1b 候选列表 ≠ 本命令执行结果，禁止混用——concern facts **只**从 preview 的最终 `assignedUnitIds` 计算：实际调动数、当前来源地点、调走前后各战线可调单位数；**仅当剩余数确为 0 才许说"该线将空"**。

**地基二：pending 状态机（合同保管箱）**
- pending 在 concern 生成**前**同步登记；唯一 `pendingId` + channel + expiry；语义响应必须匹配该 ID 才能消费（修复现状：词表外回复在 LLM 请求前就把 `pendingConfirmRef` 清空、合同丢失）。
- `pendingDecision` 全局可选；**但 pending 上下文存在时模型必须显式返回四值之一（含 null）**，字段缺失/非法 = 协议失败：
  - `authorize` → **只执行捕获的原合同**，忽略模型新生成的一切 intents；
  - `amend` → **只执行新 intents**，绝不执行旧合同；
  - `cancel` → 两边都不执行；
  - `null` → 模型明确判断为普通新命令，走现有流程；
  - **字段缺失/非法 → 禁止执行任何返回 option**（防"不行！"被误判成授权——宁可不动，绝不误动）。
- 原 9 词表保留作本地快速通道。

**地基三：独立 preflight 语音通道**
- `/api/brief` 新增 `mode:"preflight"`（不借 escalation 的危机语境 prompt）：独立一句话 prompt、问号校验、stale-request/session guard；
- LLM 失败时使用**含真实数字的引擎 fallback**（"此令将抽调 47 个单位，南部战线将空，是否继续？"）。

## 多 intent 边界（如实声明）

pending 保存整个 option，授权执行全部 intents。V1 预演只覆盖单 intent：**含 high-impact 的多 intent option 沿用现有静态顾虑，不声称精确代价**；语义授权仍针对整个已复述合同。

## 红线

不动 Order 生成 / applyOrders / missions / capture / escalation・proactive 行为 / 模型配置 / V1a / GameCanvas；不做 provenance、cap、百分比；词表不扩充。

## 允许文件（Codex 定）

`apps/web/src/ChatPanel.tsx`、`packages/core/src/commandPreflight.ts`（新）、`packages/core/src/tacticalPlanner.ts`（仅抽取纯 preview 共用逻辑，resolve 结果不变）、`packages/core/src/frontEscalationPayload.ts`（仅导出低层命名能力，V1b payload 不变）、`packages/core/src/index.ts`、`packages/shared/src/types.ts`、`packages/shared/src/schema.ts`、`apps/server/src/ai.ts`、`apps/server/src/index.ts`、`scripts/ab-command-preflight.ts`（新）。

## 验收

1. 回归 fixtures：validator/resolver 对既有命令样本**逐字一致**（不用活 LLM 验逐字；活 LLM 只做多轮 A/B 判读）；
2. 合成回归全覆盖：否定、修改、无关新命令、过期、跨频道、字段缺失、错误 authorize、多 intent；
3. 手测脚本："全军进攻X" → Chen 顶一句含**本次真实代价**的话；"没问题，相信我，平推吧" → 执行原合同 + "依令行事"；"算了" → 取消；"只派一半" → amend 走重解析；
4. typecheck 4/4。

## 实施

裁决通过后开新 worktree `preflight-v1`，一步一测一 commit。
