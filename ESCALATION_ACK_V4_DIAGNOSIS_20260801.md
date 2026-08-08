# 「参谋提议 → 玩家说可以 → 什么都没发生」诊断档（2026-08-01）

> 交接对象：Fable 5，用于商讨 v4 解决方案。
> 本文只做诊断与资产盘点，**不含实施**。基线 = main `3972bac`（= origin/main）。
> 手测现场 = worktree `AI Commander-pretest` @ `9499b1b`（localhost:3008）。
> **行号有效性**：`ChatPanel.tsx` / `frontEscalationPayload.ts` / `ai.ts` 三个文件
> 在 main 与 pretest 之间 **diff 为空**，本文行号两边通用。

---

## 0. 一句话

Chen 主动提议增援 → 玩家答「可以」→ **要么被闸毙（"请确认目标或重述"），要么执行错的东西（10 个单位的群只走了 1 个）**。
根因不是判读，是**结构缺失**：参谋嘴上报的那支部队**没有机器把手**——`ReinforceOption` 里没有 unitIds，
玩家的「可以」无处可绑。

---

## 1. 手测现场（2026-08-01，用户实录）

| 时刻 | 事件 |
|---|---|
| 01:48 | Chen 升级：「中央战线…战力比仅0.5，预计还能坚持7秒。**东北方向第一未编组群**可在68秒内抵达，是否立即调动增援？」 |
| 02:12 | 玩家：**「可以」** |
| 02:14 | → 「…立即调动，六十八秒内能到。**—— 请确认目标或重述。**」 ❌ 零执行 |
| 02:18 | Chen 再次升级（同一提议，数字更新） |
| 02:20 | 玩家：**「可以」** |
| 02:22 | → 同一句 ❌ 零执行 |
| 02:30 | 玩家：**「可以，派他们去」** |
| 02:32 | → 「您没点名部队，我按战况替您安排」+ **「执行: 1 个单位前往3. 中央战线设防」** ⚠️ 执行了，但 Chen 承诺的「十个单位、六辆主战坦克」**一个没去** |
| 02:33 | Chen：「…仅能维持一秒，战力比已达0.12」——战线丢了 |

**两次失败形状不同，正好把病灶夹在中间。**

---

## 2. 代码定位（已核）

### 2a. 「请确认目标或重述」= `invalid_intent_fields`

- 出口：[`ChatPanel.tsx:427`](apps/web/src/ChatPanel.tsx#L427) — `buildGateQuestion` 的 `invalid_intent_fields` 分支
- 触发：[`ChatPanel.tsx:303`](apps/web/src/ChatPanel.tsx#L303) `if (!isValidTarget(intent, state)) return { auto:false, reason:"invalid_intent_fields" }`
- 判据：[`ChatPanel.tsx:136-141`](apps/web/src/ChatPanel.tsx#L136)
  ```ts
  if (intent.fromSquad) {
    const isSquad = state.squads?.some(s => s.id === intent.fromSquad || s.leaderName?.toLowerCase() === fs);
    const isCommander = COMMANDERS.some(...);
    if (!isSquad && !isCommander) return false;   // ← 群 label 必死
  }
  ```

**⚠️ 待取证（本文唯一未落地的推断）**：具体是 `fromSquad` 被毙，还是 `toFront`/`targetRegion` 被毙，
没有当场抓包。推断 `fromSquad` 的理由——(1) 该 intent 的唯一新变量就是 Chen 刚报的群名；
(2) prompt [`ai.ts:242`](apps/server/src/ai.ts#L242) 明令 *Copy the reference VERBATIM*；
(3) 群 label「东北方向第一未编组群」按定义不是 squad。
**取证法**：信封截获，逐字读那一发的 intent JSON。Fable 若要动刀，建议先补这一步。

### 2b. 「1 个单位」= Bucket A 兜底

- [`ChatPanel.tsx:1496-1502`](apps/web/src/ChatPanel.tsx#L1496)
  ```ts
  const bucketA = staleRefs.length === 0 && opt0 != null &&
    (reason === "no_anchor" || (reason === "anchor_mismatch" && !gate.playerNamedSquad));
  if (bucketA) {
    addMessage("info", "您没点名部队，我按战况替您安排，要改随时说。", ...);
    setTimeout(() => handleApprove(opt0, 0, "auto", execCtx, data), 0);
  }
  ```
- 第二次 LLM 换了策略：**干脆不填 fromSquad** → 过闸 → `no_anchor` → Bucket A → 引擎自己挑人。
- 数量来自 LLM 自填的 `quantity`（prompt [`ai.ts:210`](apps/server/src/ai.ts#L210) 强制"fromSquad 或 quantity 二选一"）。
  **LLM 在猜一个数字，因为它没有别的方式表达"刚才那十个人"。**

### 2c. 根因：`ReinforceOption` 没有 unitIds

[`frontEscalationPayload.ts:70-85`](packages/core/src/frontEscalationPayload.ts#L70)
```ts
export interface ReinforceOption {
  label: string;        // "东北方向第一未编组群" —— 人话名字
  unitCount: number;    // 10 —— 只是个数字
  composition: string; hpPct: number; location: string|null;
  task: ReinforceTaskStatus; etaSec: number|null;
  // ← 没有 unitIds / memberIds。那十个人是谁，此处不留。
}
```
群 label 由 [`frontEscalationPayload.ts:404-421`](packages/core/src/frontEscalationPayload.ts#L404) 现造
（空间聚类 → 地名短语，不可解析则罗盘八分 + 第一/第二…）。**它是给人念的，不是给引擎认的。**

### 2d. 升级问句根本不登记合同

- [`messageStore.ts:330-357`](apps/web/src/messageStore.ts#L330)：`ActiveEscalation = { actionId, question, createdAt }`，
  120s 窗口。**纯字符串上下文，无提案对象。**
- 它进模型的唯一形态：[`ChatPanel.tsx:1266`](apps/web/src/ChatPanel.tsx#L1266)
  `` `---ACTIVE_ESCALATION---\n参谋刚问:「${activeEsc.question}」` ``
- [`ChatPanel.tsx:1259`](apps/web/src/ChatPanel.tsx#L1259) 原注释白纸黑字：**`6a never auto-executes`**

### 2e. 对照：真正好用的那条「说可以就办」

`pendingContractRef` 全仓**只有一处赋值**：[`ChatPanel.tsx:1514`](apps/web/src/ChatPanel.tsx#L1514)，
且在 `reason === "high_impact"` 分支内。消费在 [`ChatPanel.tsx:381-390`](apps/web/src/ChatPanel.tsx#L381)（`isConfirmReply` → `handleApprove`）。

> **系统里有两条「说可以」的路：**
> - ✅ **preflight 合同**：玩家自己下的命令被高影响闸拦下 → 引擎登记合同、钉死候选 → 「可以」直接执行。7-19 收口，一直好用。
> - ❌ **Chen 主动升级**：不登记任何合同，只塞一行 prompt 上下文 → 「可以」从头重走一遍普通命令链，**重新猜一遍派谁**。

**这就是全部差别。**

---

## 3. 修改史 / 为什么现在没有（git 硬证据）

| 日期 | 事件 |
|---|---|
| 2026-06-21 | `c5107a4` step6a 升级问句上线。「问」上线，「答了就办」**从未上线**。 |
| 2026-07-21 | 第 6 级批准合同 7 commit `5ef4bd9` 实施完：bench 49 全绿、双跑 N=30（A 臂误执行 23.3% / B 臂 0）、手测三场景过 |
| 2026-07-22 | **用户真实局手测判退**，四个 P0 → `HANDTEST_FAILURE_20260722.md` |
| 2026-07-23 | v3 / v3.1 / v3.2 再三版（共 17 实现 commit） |
| 2026-07-24 | `981f896` **整级雪藏**。执行回到第 5 级：兵只听玩家自己的命令链。 |

```
git merge-base --is-ancestor 5ef4bd9 main  → NO
git merge-base --is-ancestor f83f032 main  → NO
main × approval-contract-v1 分岔点 = 163d86e「rung 6 proposal written」
git grep executeCapturedReinforcement main → 零命中
```
**main 只拿到提案文档，一行实现都没拿到。**（20 根分支全审过，另 3 根未合的分别是：判退证据保全分支、
FROZEN 资料库快照、正在干的 pretest——均为有意。无遗漏合并。）

### 判退的四个 P0（原文摘要）

- **P0-1 会话焦点绑错**：Chen 问了句普通澄清，玩家答「对的啊要不然呢」，系统拿去授权了**后台旧升级合同** → `Aiden(T1) 10个单位已出发`。**答 A 执行 B。**
- **P0-2 权限旁路**：旧合同消费后再说「可以」，Bucket A 又独立执行一次。**同一段对话两次执行。**合同不是唯一入口。
- **P0-3 目标类型缺失**：玩家在谈"夺回中央前哨"，兵去了"3.中央战线"。提案结构只有 `targetFrontId`，无 `targetFacilityId`，无 recapture 任务类型。**非坐标误差，是类型缺失。**
- **P0-4 待批合同劫持正常咨询**：合同在场时普通问题拿不到分析，得重复一遍。

> 裁决原文：「不是文案/prompt 问题，是三个结构问题：**会话焦点、权限旁路、目标类型**。」

**注意判退的形状：不是"不动"，是"会动但动错"。** 判退后回到"不动"这个保守兜底——就是今天看到的现象。

---

## 4. 现成资产盘点（`approval-contract-v1` @ `f83f032`，main +9）

```
packages/core/src/capturedReinforcement.ts   +249   执行器
packages/core/src/frontEscalationPayload.ts    +6   ← memberIds，正是 §2c 缺的把手
packages/core/src/index.ts                     +3
apps/server/src/ai.ts                          +2
scripts/ab-approval-contract.ts              +743   bench 49 断言
apps/web/src/ChatPanel.tsx                   +246   登记 + 消费判定
apps/web/src/GameCanvas.tsx                   +95   UI 小条
apps/web/src/messageStore.ts                 +108   UI 小条
```

**★ 判退书从头到尾没有一个字批评引擎侧。四个 P0 全在 `ChatPanel.tsx` 那 246 行绑定里。**

| 可捡（判退未涉及） | 须扔/重写 |
|---|---|
| `capturedReinforcement.ts` 249 行——登记刻快照 unitIds、执行只遍历捕获 ids（*No resolveIntent, no fromSquad, no backfill*）、走 applyOrders 唯一入口、回执报真实出发数 | `ChatPanel.tsx` +246（P0-1/2/4 全在此） |
| `frontEscalationPayload.ts` +6 memberIds | `GameCanvas.tsx` +95、`messageStore.ts` +108 UI 小条——撞家法「对话是唯一界面」，砍 |
| `ab-approval-contract.ts` 743 行 bench | |

提案原文早已点名本病：
> **群候选可执行性说明**：候选若是未编组群，执行走**捕获的 unitIds**，不经 fromSquad
> ——`APPROVAL_CONTRACT_V1_PROPOSAL.md` §2

---

## 5. 建议方向（待 Fable 商讨，非定案）

**一句话：引擎侧照搬，绑定重写，范围砍到只剩这一条路径。**

1. **捡引擎侧**：`memberIds`（6 行）+ `capturedReinforcement.ts`（249 行）+ bench。判退未批评过，不重造。
2. **绑定改「最后一句话原则」**：合同**仅在它是屏幕上最后一句参谋发言时**可授权；任何新的参谋发言
   （含普通澄清问句）自动作废旧合同。直杀 P0-1。preflight 现有 `pendingContractRef` 已有
   id/channel/phase/expiresAt 四件套，只差这一个判据。
3. **P0-3 不假装能干**：据点类危机（"夺回中央前哨"）**不登记合同**，退回现行行为。今天这局是增援战线，
   不撞此条；硬做"夺回"需要新任务类型，另立一级。
4. **P0-2 建议不动**（★ 这是取舍，不是解法）：Bucket A 是第 5 级「清楚就办」的核心，砍它就是砍卡法的反面。
   v3 非要砍是因为它想让合同当**唯一**入口；最小刀不需要那个野心，只要"合同在场且是最后一句时合同先赢"。

规模估算：core 捡现成 + ChatPanel 重写 ~80 行 + bench 改判据。比 v3（17 commit / 三版本）小一个数量级。

---

## 6. 给 Fable 的讨论题

1. **「最后一句话原则」够不够杀 P0-1？** 反例：Chen 连发两条（升级 + 主动播报），合同被自己后一条作废，
   玩家点头落空 → 需不需要「静态一行角色内提示」（提案 §3 标给 Codex 的原设计点）？
2. **P0-2 不动的代价可接受吗？** 外测玩家若常撞「我明明点头了它却按自己想法派兵」，Bucket A 迟早得动。
   这该是拿真人反馈换的决定，还是现在就防？
3. **登记时机**：v3 是"危机触发即登记 top 候选"。若改成"Chen 说完那句才登记"，
   能否顺带消解 P0-4（合同劫持咨询）？代价是登记与发声之间的竞态。
4. **§2a 那一发到底毙在哪个字段** —— 要不要先补信封截获取证再动刀？（家法：判据要测效果不测措辞）
5. **排期**：这是外测第四刀，还是 pretest 三刀收口后再说？现象是"参谋提议、玩家点头、什么都没发生"，
   外测第一分钟就会撞。

---

## 7. 附：复现与取证

- 跑 `pretest-web`(3008) 或 main。等中央战线告急，Chen 主动问「是否立即调动增援？」，答「可以」。
- 取证：信封截获拿那一发的 intent JSON（`reference_pumped_frame_testing` 手法），
  对账 `assignedUnitIds` 实际数量 vs Chen 口播的 `unitCount`。
- **验收判据必须数 `assignedUnitIds`，不能只读台词**——家法 `feedback_verdict_measures_effect`：
  已栽五次同形，「字面对、执行错」只有数人头才抓得到。
