# 派兵作用域 V1 — 一页纸提案（2026-07-28）

## 0. 一句话

**`quantity` 现在能改写"从哪个池子选兵"，导致「让北线前哨的部队都撤退」实际派出 74/85 个单位。让 `quantity` 回到它本来的职责——池子里取多少——不许它决定池子。**

## 1. 病灶（已逐行核实，勿重新推导）

`packages/core/src/tacticalPlanner.ts:1405`，在 `resolveSourceUnitsRaw` 的 `if (fromHint)` 严格分支（:1397）**内部最前面**：

```js
// Day 10.5 Fix 3: quantity=all/most with fromFront → global pool
// fromFront is a hint only; user intent is "all units", not "only those in this bbox"
if (intent.quantity === "all" || intent.quantity === "most") {
  return { units: getAllAvailablePlayerUnits(state) };
}
```

**实证**（真模型六次采样，单子逐字相同）：

| 玩家说 | LLM 交给引擎的单子 | 实际派出 |
|---|---|---|
| 让北线前哨的部队**都**撤退 | `{type:"retreat", fromFront:"front_coastal", toFront:"ea_player_hq", quantity:"all"}` | **74 / 85** |

**LLM 一个字段都没填错。** 中文「X 的部队都撤退」里"都"管的是 X 那些部队，不是全军。

**同文件下游已有两道保护，但都到不了**：`:1428` 与 `:1445` 的 `// For retreat/defend: do NOT fallback to global pool — ... Global fallback caused full-army mis-retreats`。"全军误撤"这个教训被吃过一次并修好，但补丁在"该战线没兵"的分支里，而 `:1405` 排在它上游先一步 `return`。

**区分（勿误伤）**：`:1399` 的 `isAllFrontHint(fromHint)`（`fromFront` 本身写着"全军/all"）是**无病分支**，玩家真要全军走的就是它。病灶只有 `:1405` 那四行。

**职责边界证据**：`resolveQuantity`（:1639）对 `"all"` 返回 `total`——即"**池子里全部**"。`quantity` 的设计语义本来就是"取多少"，`:1405` 让它去决定"从哪个池子"，是职责越界。

## 2. 同族两条（一并解决）

**2a. `fromSquad` 填领队名 → 静默失败。** 玩家说「让 Aiden 撤回总部」，单子填 `fromSquad:"Aiden"`（真实编号 `I1`），`resolveSourceUnits` 找不到 → **0 个单位动**，参谋却回「Aiden 撤回总部，预计三分钟内抵达」。**静默失败比撤错更危险**：撤错你还能看见，这个看不见。

**2b. 预演根本不覆盖撤退。** `previewHighImpactIntent`（:484）第 :492 行：

```js
if (rawIntent.type !== "attack" && rawIntent.type !== "sabotage") return null;
```

**这就是 74 个单位的全军级动员没有触发任何确认的原因**——不是阈值问题，是 `retreat` 压根不在覆盖清单里。（本条与第 8 级 Preflight V2 provenance 相邻但不是同一刀：那一级管"intent 从哪来"，这里只管"哪些 type 进预演"。）

## 3. 修法方向（语义原则，不是关键词表）

> **作用域归 `fromFront` / `fromSquad`，数量归 `quantity`；`quantity` 永远不许扩大作用域。**
> 玩家真要全军时，`fromFront` 自己就是"全军"，走 `:1399` 那条无病分支。

**具体怎么落地由实施窗口定**，但必须满足这条原则，并且——

⚠️ **删掉四行不等于收工。** `resolveSourceUnits` 被 **8 个 planner 共用**（:322 / :524 / :593 / :670 / :746 / :893 / :993 / :1103），attack / defend / retreat / recon / hold / patrol 全走它。改它必须先想清楚每种命令的语义：

- 「北线的部队全部撤退」→ 只撤北线 ✅ 明确
- 「北线的部队全部进攻中央」→ 只派北线 ✅ 大概率对
- 「从北边全线压上」→ 模糊。**用户已拍板（2026-07-28）：一律按 `fromFront` 收窄。**
  理由：少派了玩家一句话就能补，代价是一句话；多派了代价是一局。模糊话不许扩大作用域。
  唯一的全军入口是 `fromFront` 本身为"全军/all"（`:1399` 的 `isAllFrontHint`）。

## 4. 允许改动清单

**允许**：`packages/core/src/tacticalPlanner.ts`（`resolveSourceUnitsRaw` 作用域逻辑 + `previewHighImpactIntent` 覆盖清单）· `apps/server/src/ai.ts`（若需一行语义原则教 LLM 用编号而非领队名）· `scripts/ab-*.ts`（新增/扩充 bench）· `ROADMAP.md`（仅收口）。

**禁改**：`applyOrders` · `resolveIntent` 外壳 · `commandPreflight.ts` 的三分口径 · 6b 的三个 tag 与已收口台词 · 第 6 级两条冻结分支 · `scripts/ab-command-preflight.ts` 既有语料。

## 5. 验收

**先补 bench 再动刀**——选兵逻辑四类命令共用，不测 attack/defend 就是在赌。

1. **synthetic（新增，最要紧）**：对 attack / defend / retreat / recon 各造一组 `fromFront=某线 + quantity=all`，断言**派出的单位全部来自该线**且数量 = 该线可用数。同时保留 `fromFront="全军"` 走全军的正例（防误伤 `:1399`）。
2. **★ 数单位，不看台词**：所有会动兵的断言必须跑 `resolveIntent` 数 `assignedUnitIds.length` 并核对**来源集合**。审核窗口曾因只读 `option.label` 误判「说地名 9/9 全对」，用户手测一局即证伪——**这是本级第四次被"测说了什么、病在做了什么"的判据坑到**。
3. **`fromSquad` 领队名**：断言解析失败时**明确报错**（degraded + 人话回执），不许零单位静默通过。
4. **预演覆盖**：`retreat`（及 defend 等大范围 type）纳入 `previewHighImpactIntent` 后，全军级撤退必须先出顾虑问句。
5. **真模型**：「让北线前哨的部队都撤退」「南线那些人全部后撤」各 ×3，数实际单位数。
6. **五闸复跑**：emily 38 / board 37 / escalation 40 / preflight 66 / presence 68 + typecheck。
7. **用户手测点头**才收口。

## 6. 不做什么

- 不碰 6b 已收口的任何台词与信封（撤兵这条链跟镜头、语气、判断执照都无关）
- 不做 Preflight V2 provenance（第 8 级，intent 来源分类是另一刀）
- 不顺手修另外三笔账（存活秒数不计还手 / R12 复读作废快照 / 主动播报不进上下文）——各自独立排

## 7. 基线与流程

**基线 = `commander-presence-v1` @ `c1460f5`**（6b 三步已全收口、未合 main）。新 worktree，新分支 `dispatch-scope-v1`。做完与 6b **一起合 main**——避免 main 上留一个"说撤一个前哨、撤走全军"的版本。

一步一测一 commit，禁打包。影响手感的改动开工前先给用户三行人话。
