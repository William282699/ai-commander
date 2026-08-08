# 撤退语义 V1 — 一页纸提案（2026-07-28）

## 0. 一句话

**撤退是 15 个动词里唯一没接上"目的地"的那个，而且撤到位就变待命、被自动接敌拉回原地。让它读目的地、到位后守住。**

## 1. 三个病灶（已逐行核实，勿重新推导）

**① 目的地被完全忽略。** `packages/core/src/tacticalPlanner.ts` 的 `planRetreat`（约 :605-690）里只有一行写死的语义：

```js
// Retreat target: move towards player HQ (dynamic lookup)
const playerBase = findPlayerHQPosition(state) ?? { x: 100, y: 10 };
// 每个单位朝 playerBase 方向走 min(25, dist*0.6)
```

**整个函数从不读 `intent.toFront` / `targetFacility` / `targetRegion`。** 实证（真模型三次，单子逐字相同）：

| 玩家说 | 参谋记的单子 | 引擎实际派往 |
|---|---|---|
| 中央前哨的部队，全部撤回到南线前哨 | `{retreat, from:front_center, toFront:front_south, qty:all}` | **(385, 98)** —— 南线前哨在 (365,155)，总部在 (430,90) |

**参谋一个字没听错，是引擎不读那一栏。** 而回执照单子复述"全员撤退至南线前哨"，所以玩家无从察觉——与 74/85 那次同形：**单子对、执行不按单子、回话按单子念**。

**② 结构根因：目的地解析没有单一真相源。** `resolveTarget(intent, state)`（:1261）是把地名翻成坐标的共用零件，进攻(:322)/设防(:545)/侦察(:730)/巡逻(:957)/另一处(:1160) **各自记得调它**；`planRetreat` 没调。**不是"列表漏了"，是每个 planner 靠自觉，总有一个会忘。** 加第 16 个动词时同样会漏——没有任何机制会发现。

**③ 撤到位就掉头回去。** 三步闭环，全部核实：

1. `sim.ts` 到达分支（:246-252）：`retreating` 既不是 `defending` 也不是 `patrolling` → **落到 `unit.state = "idle"`**
2. `combat.ts`（:234）：`idle | moving | patrolling | defending` 都会被自动接敌翻成 `attacking`（`retreating` 不在列表里——**行进途中的保护是对的，坏在到位之后**）
3. `sim.ts`（:147）：`attackTarget` 非空且状态不是 retreating → **把移动目标同步到敌人身上** → 走回去

因为撤退只退 `min(25, dist*0.6)` 格，单位经常仍在原战线的感知范围内，**刚站定就被拉回去**。

## 2. 修法（用户已拍板 2026-07-28）

1. **撤退读目的地**：与其余五个动词一致，调用现成的 `resolveTarget`。**没填目的地时保留现行行为**（朝总部方向退一截）——"快撤""撤下来"的手感一字不改。
2. **到位后守住，不落待命**：撤退到达后转入 `defending`（岗位＝落点），复用现成机制——被打会还手、打完自动回岗，不追出去。**不新增状态。**
3. **目的地 == 出发地 → 忽略**，走默认（防参谋误填导致原地不动）。

**语义澄清（写进 prompt 一行，不挂例句）**：撤退 = **脱离接触**；带目的地时 = **一边脱离接触一边转移**。它与"移动/进攻"的真实差别是：**撤退途中不被敌人勾住**（`sim.ts:149` 明写 retreating 不追锁定目标，`combat.ts:234` 不把 retreating 翻成 attacking）。这是玩家现在拿不到的动作，不是重复功能。

## 3. 允许改动清单

**允许**：`packages/core/src/tacticalPlanner.ts`（`planRetreat` 读目的地 + 同源守卫）· `packages/core/src/sim.ts`（**仅到达分支一处**）· `apps/server/src/ai.ts`（撤退语义一行）· `scripts/ab-*.ts` · `ROADMAP.md`（仅收口）。

⚠️ **本级必须碰执行链（`sim.ts`），这是与 6b「零执行牵连」红线的明确区别——用户已授权。** 但只许改到达分支那一处；`applyOrders` / `combat.ts` / `resolveIntent` 外壳一律不碰。建议实现方式：到达时把该单位的 one-shot 撤退单转成一张 `defend` 单（目标＝当前落点），**下游全部现成机制自动生效**，无需改 `combat.ts`。

**禁改**：`applyOrders` · `combat.ts` · `resolveIntent` 外壳 · `resolveTarget` 本体 · `commandPreflight` 三分口径 · 6b 三个 tag 与已收口台词 · `dispatch-scope-v1` 已收口的作用域逻辑（`:1405` 那刀不许回退）。

## 4. 验收

**★ 判据铁律**：会动兵的断言一律 `resolveIntent` 数 `assignedUnitIds.length` **并核实际落点坐标**，不许看台词。本级另加一条：**落点必须与目标地名的坐标比对**（这次的 bug 正是"数量对、落点错"）。

1. **synthetic**：
   - 撤退 + `toFront=南线` → 落点在南线区域内（与 `resolveTarget` 给的坐标比对，容差＝散开半径）
   - 撤退 + 无目的地 → **落点与改动前逐字相同**（默认行为不许漂移，用改前快照对照）
   - 撤退 + `toFront == fromFront` → 走默认
   - 到达后状态 = `defending`，且 one-shot 单已转成 defend 单
   - 其余四个动词（进攻/设防/侦察/巡逻）落点全部不变（防溅射）
2. **掉头测试（本级核心）**：撤到位 → 在落点感知范围内放一个敌军 → 泵若干帧 → 断言单位**仍在落点附近**（不再走回原战线）；同时断言它**会还击**（不是傻站着）。
3. **真模型**：「中央前哨的部队全部撤到南线前哨」「快撤」「北线的都撤回总部」各 ×3，数单位 + 核落点。
4. **六闸复跑**：emily 38 / board 37 / escalation 40 / preflight 66 / presence 68 / dispatch-scope 19 + typecheck。
5. **用户手测点头**才收口。

## 5. 记账（不在本级修）

**目的地解析没有单一真相源**：15 个 `IntentType` 里，目的地解析靠每个 planner 自觉调用 `resolveTarget`，无穷尽性保证。彻底修法＝提到 `resolveIntent` 的统一入口（那里已有一步地名规范化），让所有动词自动获得。**本级不做**（要动全部五个 planner，溅射面过大）；记为结构账，加第 16 个动词时必须先还。

## 6. 基线与流程

**基线 = `dispatch-scope-v1` 分支当前 HEAD**（派兵作用域五刀已收口）。**同分支续做**，不另开 worktree——同一份体验（撤退），用户会一起手测、最后与 6b 一起合 main。

建议：**先给派兵作用域打 tag 锚住已验证成果**（tag 只是标记，不妨碍继续提交），再做本级；两级各自 commit、各自手测，最后一次合并。

一步一测一 commit，禁打包。影响手感的改动开工前先给用户三行人话。
