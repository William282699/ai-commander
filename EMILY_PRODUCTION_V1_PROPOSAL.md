# Emily 生产合同 V1 — 一页纸提案 v3（2026-07-20，终审条件批准后封口，已获准开工）

## 0. 裁决记录

- v1 未批（2026-07-20）：方向正确（双实证对症、生产账放 shared、无预演口径成立、schema 钳制/畸形回落/不动 trade 原则正确）；四阻断 = ①produceBudget 落错层（resolver 预展开 ≠ trade 真实路径，有假执行隐患）②可产类型集合未封口+除零（commander/elite cost=0）③PRODUCTION 行数与真实地图矛盾+缺两语义（now 独立不可加、max/order 明示）④文件清单缺三个必要文件、验收须测最终状态。
- v2 = 逐条落实：budget 改为 **Order 携带、applyOrders 实时一次性结算**；类型集合谓词封口；三类各一行+queued 的 4 行版式；11 路径清单；验收以 queue/资源最终状态为准。
- v2 终审（2026-07-20）：四阻断解除、架构通过，**条件批准**；三处文字/验收封口 = ①"唯一真相源"措辞（shared 不能引用 apps/server，改为 UNIT_STATS 声明顺序过滤+bench 断言与 ai.ts:129 契约一致；示例 ground→naval→air）②digest.ts 旧 JSDoc 失真须同步修正 ③补回燃油约束正数案/fraction 上下界钳制/queued 聚合与缺席三组断言。v3 = 落实即开工，无需再审。用户已 approve。

## 1. 实证与目标

V1a 收口手测（2026-07-20，用户实弹）双弹：
- **算错账**：余额 $3,850 问"能生产多少坦克"，Emily 答"2辆主战或4辆轻型"（真相 9/19）。根因 = digest 只给裸余额，无引擎算好的可产量事实，LLM 被迫心算（宪法禁止）。
- **量词静默降级**：「剩下的钱都生产主战坦克」只入队 ×1。根因 = `resolveProduce` 量词只认数字；trade 早有 7b.1 budget 合同，produce 没有。

修法双件套（引擎算数、LLM 只译话）：**PRODUCTION 事实节** + **produceBudget 合同（tradeBudget 完整移植，含 Order 层）**。

## 2. 改动本体（允许路径仅此 11 个）

1. `EMILY_PRODUCTION_V1_PROPOSAL.md` — 仅按裁决修订；Step 0 入分支。
2. `packages/shared/src/digest.ts` — **仅**新增 PRODUCTION 节（§3）+ **同步修正一处失真 JSDoc**（终审②：现注释称"无 board 与 pre-board-v1a 逐字相同"，PRODUCTION 无条件渲染后失真，改为"board-sensitive 内容保持兼容；PRODUCTION 在两条路径共同渲染"——代码契约不得留假话）。零新依赖（UNIT_STATS/PRODUCTION_FACILITY/economy/facilities 全在 shared）。
3. `packages/shared/src/intents.ts` — **仅**新增 `ProduceBudget`（镜像 TradeBudget：`{ mode: "single"|"fraction_of_money"; fraction?: number }`）+ Intent optional `produceBudget`。
4. `packages/shared/src/schema.ts` — **仅**新增 produceBudget 消毒（逐字镜像 schema.ts:131-145：合法才落、fraction 钳制 [0,1]、畸形整体丢弃→旧行为）。
5. `packages/shared/src/types.ts` — **仅** Order 加 optional `produceBudget`（对齐 types.ts:239 tradeBudget 先例）。
6. `packages/core/src/tacticalPlanner.ts` — **仅改 `resolveProduce`**：budget=fraction_of_money → 生成**一个**携带 `produceBudget` 的 produce Order，**不预算件数、不展开**；回执文案不得宣称数量（"按预算生产主战坦克"）。无 budget 路径（数字量词/默认 1）逐字不变。
7. `packages/core/src/applyOrders.ts` — **仅**新增 produce Order 的 budget 结算分支（对齐 applyOrders.ts:208 trade 先例）：**用结算时刻实时资源**算 `count = floor(money×fraction ÷ cost)` → 燃油约束 `min(count, floor(fuel÷fuelCost))`（fuelCost>0 时）→ 二次防御 `cost<=0||buildTime<=0` 拒绝 → 单次上限 10 → 逐件走 `enqueueProduction`（含设施校验+逐件扣款）→ **回执报实际入队数**（含依据：余额/单价/如触发 cap 报"可产19，本单上限10"）；0 件时只报一次真实原因（预算为零≠余额不足，设施缺失如实说），零状态变化。
8. `apps/server/src/ai.ts` — **仅两处 additive**，镜像 tradeBudget 条款（131 旁 schema 字段行 + 183 旁语义条款：「全部/尽可能多造」→fraction=1、「一半钱」→0.5，**budget 模式下不得输出 quantity**，绝不自己算件数）。语义原则式，禁同义词表。
9. `apps/web/src/GameCanvas.tsx` — **仅**把 PRODUCE_BUDGET 成功回执定级 info 并路由 logistics（逐字对齐 GameCanvas.tsx:586 trade 回执先例）。
10. **新增** `scripts/ab-emily-production.ts` — `--synthetic` + `--ab`（§6）。
11. `ROADMAP.md` — **仅**全部验收通过后收口更新。

其余全部禁止，尤其：`ChatPanel.tsx`、`economy.ts`（enqueueProduction 原样是结算的唯一真实入口）、`ab-battle-board.ts`（**原样 37 断言当闸跑，不改**——legacy 与 board 两路径同增 PRODUCTION 节，其前缀/骨架断言不受影响）、battleBoard/frontEscalationPayload/commandPreflight、trade 现行为、escalation/proactive、模型配置。

## 3. PRODUCTION 事实节 contract（写死，禁猜）

- **类型集合与顺序封口**（终审①改准：shared 不得依赖 apps/server，不引用 prompt 文件）：按 **`UNIT_STATS` 声明顺序**过滤 `cost > 0 && buildTime > 0`；当前精确结果**钉死为现行 11 型**（恰好排除 commander/elite_guard 的 cost=0/build=0，无除零）；**bench 断言该集合与 ai.ts:129 的 schema 契约清单一致**（两份真相由断言勾稽，不靠引用）。
- **版式（正文最多 4 行）**：三大类各一行（ground→naval→air，与 prompt 契约同序）+ 队列一行：
  ```
  ---PRODUCTION--- (now=independent affordability on the SAME snapshot, NOT additive; queued costs already deducted; max 10/order)
  ground: infantry[$80/0fu/5s now=48] light_tank[$200/5fu/8s now=19] main_tank[$400/10fu/12s now=9] artillery[$320/5fu/10s now=12]
  naval: no alive player shipyard
  air: no alive player airfield
  queued: main_tank×4
  ```
  某类设施缺失/被毁 → 该类一行如实报无（判定与真实入口**同一条件**：`type 匹配 && team=player && hp>0`，economy.ts:330）；queued 空则省略该行。
- **两条语义写死在节头**（Codex ③）：每个 `now` 是同一资源快照下的**独立**假设，**不可相加**；`max 10/order` 明示（防"能造19"与"全部造只入队10"的新矛盾）。
- `now = min( floor(money÷cost), fuelCost>0 ? floor(fuel÷fuelCost) : ∞ )`，与 enqueueProduction 扣款同一份 resources（入队即扣 ⇒ 天然已减在产订单，无预测）。
- 铁律沿用：只给账不给结论；不确定省略不硬标。

## 4. produceBudget 合同 contract（trade 完整解剖的逐层移植）

- 数据流写死：`Intent.produceBudget →（消毒）→ 一个 Order.produceBudget → applyOrders 实时结算`——与 trade 完全同构（tacticalPlanner.ts:836 / types.ts:239 / applyOrders.ts:208）。**resolver 不算数量**：UI 先显示 resolver 日志再执行（ChatPanel.tsx:1749），resolver 预报件数 = 假执行隐患（Codex ①），故 resolver 回执只述意图，件数只出现在 applyOrders 的事后回执里。
- LLM 只输出 `{ mode, fraction }`，budget 模式下 **quantity 必须缺席**；畸形/缺失 → 整体丢弃 → 旧路径。
- `fraction=0` → 零入队，理由=预算为零（不得误报余额不足）；设施缺失 → 零入队+真实原因，仅报一次。
- trade 的 tradeBudget 行为逐字不变（红线，bench 对照）。

## 5. 红线与勾稽

- 四闸原样全绿：board 37（**不改文件**）、V1b 40、preflight 66、typecheck。
- `resolveProduce` 无 budget 路径逐字不变；`enqueueProduction` 一行不动。
- ai.ts 仅两处 additive（git diff 复核，出现删改即打回）。
- PRODUCTION 节对全体 digest 消费者同步生效（与 V1a 同性质的已声明爆炸半径，正文 ≤4 行有界）。

## 6. 验收（synthetic 一律断言最终状态：queue 增量 + 钱/油差值 + 回执，不止 resolver 输出）

1. typecheck + 四闸全绿；新 bench `--synthetic` 全绿。
2. **合成断言**：fraction=1/0.5 → 实际 queue 增量与扣款符合公式；**燃油为实际约束的正数案（$3850/fuel=15/main_tank/fraction=1 → queue+1、money−400、fuel−10）**；**fraction 上下界钳制（>1→1、<0→0）**；无存活设施 → queue/资源零变化且无成功宣称；fraction=0 → 零入队且理由=预算为零；cap 案 → 同时断言 `可产=19` 与实际入队 10；`mode=single+quantity=3` → 恰 3；缺失/畸形 budget → 旧路径（×1 或数字）；facts 排除 commander/elite 且无 Infinity/NaN；**facts 集合与 ai.ts:129 schema 契约清单一致（勾稽断言）**；设施 team/hp 边界（敌方/被毁不计）；PRODUCTION 正文 ≤4 行；`now` 快照独立性（入队后重算下降）；**queued 多类型聚合计数准确、队列空时该行缺席**；trade 对照不变；digest 无 board 参数路径同样带 PRODUCTION 节（两路径一致）。
3. **真模型 fixtures**（`--ab` ×3 each）：「剩下的钱都生产主战坦克」→ `produceBudget={fraction_of_money,1}` 且 **`quantity` 字段精确缺席**；「用一半的钱造轻坦」→ fraction=0.5 同断言；「生产3辆主战坦克」→ `quantity=3 && produceBudget 缺席`；「能生产多少坦克」→ `NOOP + options=[] + 零 intent`，且 $3,850 fixture 下答案明确"主战9或轻坦19"（两个独立上限，**不得相加**），人工判读 3 次零心算错账。
4. **手测（真实路径，Emily/logistics，各 1 次）**：复刻用户原两句；**对账 = queue 增量 + 钱/油差值 + 实际回执**（bridge 读 state 前后快照），不只看 Network intent。

## 7. 步骤（worktree `AI Commander-emily-production`，一步一测一 commit）

- Step 0：提案 v2 入分支首 commit。
- Step 1：PRODUCTION 事实节 + bench 事实断言（闸：新 bench + 四闸 + typecheck）。
- Step 2：合同四层（intents/schema/types/Order）+ applyOrders 实时结算 + resolveProduce 薄化 + bench 最终状态断言（闸：+trade 对照）。
- Step 3：ai.ts 两处 additive + GameCanvas 回执路由 + `--ab` fixtures（闸：quantity 缺席精确断言）。
- Step 4：手测两句对账 → 收口：合 main + tag `emily-production-v1-done` + 更新 ROADMAP（仅此时）。

## 8. 非目标（本轮不做）

- 「批准」合同化（第 6 级独立提案）；兵力量词分数（preflight V2 弹药）；生产排程建议/自动补产（引擎只给账不给结论）；cap 10 调整（独立决策不夹带）；air/naval 生产链路新建（无设施如实报）。

## 9. 考虑过并否决

- **resolver 预展开 N 个 Order**（v1 方案）：非 trade 真实解剖，UI 先示后败=假执行——Codex 阻断，改 Order 携带+applyOrders 实时结算。
- **每型一行版式**（v1）：真实地图 9-12 行超预算——改三类各一行+queued，≤4 行。
- **digest 层自建可产类型清单**：与 prompt 清单两份真相——改谓词封口+顺序引用 ai.ts:129 唯一真相源。
- **改 ab-battle-board.ts**（v1 允许清单）：该 bench 断言前缀/骨架而非全文逐字，两路径同增一节不受影响——撤出允许清单，原样当闸。
