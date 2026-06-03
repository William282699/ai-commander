# Step 5C-lite v2.1 — Deployment + Economy 微调提案

> **v2 → v2.1 changelog (codex round 2 review)**:
> - 修正所有 Strike Force / Panzer Group 距离描述（之前只算 dy，没算 Pythagorean 斜边）
> - 21. Panzer 坐标 (180, 165) → **(210, 185)**（原距 Himeimat 88 tile 太远，新 52 tile 符合"南部反击"intent）
> - economy 表自相矛盾修正：诚实表达"敌方产能 1.51× 玩家"，不再说"持平"
> - 加 V24 验证：前 10 分钟敌方主力目标是 3 个 forward post（不是 HQ）
>
> **v2.1 stale-ref cleanup (codex final pass)**:
> - § 0 line 13 "经济总投入持平" → "敌方有效产能 1.51×"
> - § 2.3 line 79 staging distance "10-30 tile" → "35-50 tile"（匹配 § 2.1 表 36-48 tile）
> - § 5.1 line 296 Panzer→player post distance "200-240 tile" → "158-214 tile"（精算）
> - § 8 line 371 "(180, 75/165)" → "(180, 75) / (210, 185)"
> - § 8 line 374 "总投入 ~50/side" → "玩家 ~33 / 敌方 ~50 非对称产能"
> - § 9 line 402 "(180, 75/165)" → "(180, 75) / (210, 185)"

> **目的**：在已完成的 5C-lite v1（pressureDirector + rating + codex round 1 修复）基础上，加强双方进攻部队 + 重新校准敌方经济，让 30 min 节奏更接近"前哨争夺战 + 多线压力"的设计 intent。
>
> **作者立场**：5C-lite v1 主架构 OK（pressureDirector 已上线 + drift 检测 + time-window history penalty + per-index claim 都过 typecheck/build/V19）。本提案只追加 deployment unit + 调 enemy economy 起始资源，**不改任何 logic**（pressureDirector / defensiveAI / autoBehavior / combat / sim / fog / warPhase / shared schemas / server 都 0 改动）。
>
> **要 codex 评判的核心问题**：① 增量 unit 位置 + 兵种比例是否合理（历史 doctrine + gameplay 平衡）；② 敌方有效产能 1.51× 玩家是否合理 (玩家 70% sustain 出 ~33 unit、敌方 90% sustain 出 ~50 unit, 累积流转 1.08×)；③ 有没有 logic 改动也需要跟上（我的判断是不需要）。

---

## 0. 当前 5C-lite v1 状态 snapshot

- **HEAD**: `2d281a4`（origin/main），worktree branch `worktree-step-5c-lite`，未 commit
- **已完成改动**（uncommitted, working tree dirty）:
  - `packages/shared/src/types.ts` — `scenarioWinConfig.ratingThresholds` + `GameState.gameOverRating/gameOverBreakdown` optional 字段
  - `packages/core/src/scenario/elAlamein/index.ts` — money/fuel/ammo 起始资源调整、K=3、`ratingThresholds`
  - `packages/core/src/scenario/elAlamein/deployment.ts` — air wing → ground HQ Mobile Reserve（双方）
  - `packages/core/src/warPhase.ts` — commander-death gate `if (!state.scenarioWinConfig)`、timeout → `endGameWithRating()`
  - `packages/core/src/scenario/elAlamein/pressureDirector.ts` — 新文件 610 行
  - `packages/core/src/index.ts` — `+1` export
  - `apps/web/src/GameCanvas.tsx` — tick hook + 2 reset + import + `P4_DBG` suppress + rating overlay JSX/CSS
  - `apps/web/src/styles/game-ui.css` — `.hud-gameover-title--draw` 中性灰
- **Codex round 1 修复**（已实施）:
  - P1: `P4_HISTORY_PENALTY_WINDOW_SEC = 360` 时间窗，避免 3 个 post 全进 history 后 P4 永久哑火
  - P2: `dispatchWithFormation` 改 per-index claim（按 `appliedPerOrder[i]` 单独配对）
- **Codex 自己改的 defensiveAI fallback target 选择** —— 改对应 player post (而非默认冲 HQ)。已并入。
- **Codex 改的 enemy fuel** —— `2000` (从 `5000` 降下来) 已经在 elAlamein/index.ts. **本提案会再次调整 fuel**。
- **typecheck + build**：全 PASS（4 workspaces）
- **V19 deletability**：外部 references 严格 7 行（1 export + 6 GameCanvas），删 pressureDirector + 7 行后 typecheck 全过

---

## 1. 本提案的两个改动

### 改动 A: deployment.ts 追加 5 个新群（玩家 +25 / 敌方 +14 unit）

**现有 deployment 全部不动**（60 player + 64 enemy）。只 append 5 个 `placeGroup` block。

### 改动 B: elAlamein/index.ts 敌方 economy 重新校准

money + fuel + ammo + baseIncome 全部下调。30 min 累积流转从 v1 的 168 (敌方 1.27× 玩家) 降到 128 (敌方 1.08× 玩家)。注意：**不是数学持平** — 玩家产 ~33 unit，敌方产 ~50 unit (敌方有效产能 1.51×)。详见 § 3.1。

---

## 2. 改动 A: 新增进攻部队 deployment

### 2.1 玩家 +25 unit — 3 个 Strike Force

按 Operation Lightfoot doctrine 编成（**步兵 leading + 装甲 spearhead**，步兵比例 48%）：

| 编组 | 位置 (x, y) | 兵种 | 数 | 攻击目标 |
|---|---|---|---:|---|
| **North Strike Force** | (400, 60) — coastal post (360, 33) 后方 48 tile | 4 inf + 3 lt + 2 mt | 9 | Alamein Town (280, 30) |
| **Central Strike Force** | (400, 95) — central post (360, 103) 后方 41 tile | 4 inf + 2 lt + 2 mt | 8 | Kidney Ridge (220, 55) 或 Miteirya Ridge (230, 70) |
| **South Strike Force** | (400, 145) — south post (365, 153) 后方 36 tile | 4 inf + 3 lt + 1 mt | 8 | Himeimat Heights (250, 218) |
| **合计** | | 12 inf + 8 lt + 5 mt | **25** | |

### 2.2 敌方 +14 unit — 2 个 Panzer Counter-attack Group

按 Rommel 装甲反击 doctrine（**objective 西后方 30-50 tile 蓄势 + motorized infantry 1/3 编制**，步兵比例 43%）：

| 编组 | 位置 (x, y) | 兵种 | 数 | 任务 |
|---|---|---|---:|---|
| **15. Panzer Group** (north) | (180, 75) — Kidney (220, 55) 西北方 45 tile | 3 inf + 3 lt + 2 mt | 8 | 反击北线（Alamein/Kidney/Miteirya） |
| **21. Panzer Group** (south) | (210, 185) — Himeimat (250, 218) 西北方 52 tile | 3 inf + 2 lt + 1 mt | 6 | 反击南线（Himeimat） |
| **合计** | | 6 inf + 5 lt + 3 mt | **14** | |

> **v2.1 修正**：21. Panzer 原坐标 (180, 165) 距 Himeimat 实际 **88 tile**（codex review 指出，原文档 53 是只算 dy 没算 dx 的算错）。改 (210, 185) 后是 52 tile，符合"近距离南线反击"原 intent。

### 2.3 设计考量

1. **位置历史正确**：
   - 玩家 Strike Force 在 X Corps staging area pattern（forward post 后方 35-50 tile，符合 Montgomery 1st + 10th Armoured Division 的 1942 年 10 月集结位置）
   - 敌方 Panzer Group 在 objective 西后方 30-50 tile（符合 Rommel 15./21. Panzer Division 历史反击预备位置）
2. **兵种 doctrine 正确**：
   - Strike Force 步兵 48% 接近历史 8th Army Operation Lightfoot 编组（步兵 leading 清雷、装甲 follow exploit）
   - Panzer Group 步兵 43% 接近德军 Panzer Division 编制（motorized infantry 1/3 + 装甲 1/3 + support 1/3）
3. **不在 garrison/HQ exclusion ring 内**：
   - 5 个新群距离任何 Axis objective > 15 tile，距离任何 HQ > 20 tile
   - 不会被 pressureDirector 的 `gatherPressurePool` 错误排除（gatherPressurePool 排除 GARRISON_EXCLUSION_RADIUS=15 和 HQ_EXCLUSION_RADIUS=20 ring 内的 enemy unit）
4. **gameplay 三线编制清晰**：
   - 玩家：North → Alamein、Central → Kidney/Miteirya、South → Himeimat
   - 敌方：15./21. Panzer 反击北/南线，分担 Forward Screening Force（已有 190, 50）的中间地带 raid 功能
5. **mobile pool 充实**：
   - 敌方机动可抽 = 原 29 + 新 14 = **43 unit**
   - pressureDirector P4 wave 4-12 unit + defensiveAI P1-P3 都不会哑火
   - 也不会让 wave 太膨胀（wave 上限本身由 phase × kind 决定，不受 pool 大小影响）

### 2.4 deployment.ts 完整 diff

```diff
   // ── HQ Mobile Reserve (450, 128) — 5C-lite: replaces air wing ──
   placeGroup("infantry",   "player", blockFormation(450, 120, 2, 2));
   placeGroup("light_tank", "player", lineFormation(450, 126, 2, 3));
   placeGroup("main_tank",  "player", [[450, 132]]);

+  // ── North Strike Force (400, 60) — 5C-lite v2: 北线进攻群 ──
+  // X Corps staging area pattern. Doctrine: 步兵 leading + 装甲 spearhead
+  // 任务: 推 Alamein Town (280, 30)
+  placeGroup("infantry",   "player", blockFormation(400, 56, 4, 2));
+  placeGroup("light_tank", "player", lineFormation(400, 62, 3, 3));
+  placeGroup("main_tank",  "player", [[396, 68], [404, 68]]);
+
+  // ── Central Strike Force (400, 95) — 5C-lite v2: 中线进攻群 ──
+  // 任务: 推 Kidney Ridge (220, 55) 或 Miteirya Ridge (230, 70)
+  placeGroup("infantry",   "player", blockFormation(400, 91, 4, 2));
+  placeGroup("light_tank", "player", [[396, 97], [404, 97]]);
+  placeGroup("main_tank",  "player", [[396, 103], [404, 103]]);
+
+  // ── South Strike Force (400, 145) — 5C-lite v2: 南线进攻群 ──
+  // 任务: 推 Himeimat Heights (250, 218)
+  placeGroup("infantry",   "player", blockFormation(400, 141, 4, 2));
+  placeGroup("light_tank", "player", lineFormation(400, 147, 3, 3));
+  placeGroup("main_tank",  "player", [[400, 153]]);

   // ═══════════════════════════════════════════
   // ENEMY (Afrika Korps + Italian) — West side + strongpoints
   // ═══════════════════════════════════════════
   ...

   // ── Axis Mobile Reserve (58, 128) — 5C-lite: replaces air wing ──
   placeGroup("infantry",   "enemy", blockFormation(58, 122, 2, 2));
   placeGroup("light_tank", "enemy", blockFormation(58, 128, 3, 3));
   placeGroup("main_tank",  "enemy", [[55, 134], [65, 134]]);

+  // ── 15. Panzer Counter-attack Group (180, 75) — 5C-lite v2: 北部反击装甲 ──
+  // Historical position: Rommel's 15. Panzer Division held in reserve
+  // west of Kidney Ridge / Miteirya Ridge, ready to counter-attack
+  placeGroup("infantry",   "enemy", blockFormation(180, 71, 3, 2));
+  placeGroup("light_tank", "enemy", lineFormation(180, 77, 3, 3));
+  placeGroup("main_tank",  "enemy", [[176, 83], [184, 83]]);
+
+  // ── 21. Panzer Counter-attack Group (210, 185) — 5C-lite v2: 南部反击装甲 ──
+  // Historical position: 21. Panzer Division 南部反击预备
+  // Positioned 52 tile NW of Himeimat for actual proximity to south objective
+  // (original (180, 165) was 88 tile away — too far for "南部反击" intent)
+  placeGroup("infantry",   "enemy", blockFormation(210, 181, 3, 2));
+  placeGroup("light_tank", "enemy", [[206, 187], [214, 187]]);
+  placeGroup("main_tank",  "enemy", [[210, 193]]);

   return { units, nextUnitId: uid };
 }
```

---

## 3. 改动 B: elAlamein/index.ts 敌方 economy 重新校准

### 3.1 设计目标

**v2.1 修正（codex review）**：之前 v2 写"双方 30 min 总产持平 ~50"是误导 — 数学算下来玩家 70% sustain 出 33 unit、敌方 90% sustain 出 50 unit，**敌方有效产能其实是玩家的 1.51×**。

诚实表达的设计 intent 是：
- **玩家起始拳头更强**（HP 1.40×、main_tank 1.23×）
- **敌方持续产能更强**（30 min 产能 1.51× 玩家、累积流转 1.08×）
- 玩家必须**前期 commit 抢机会**，否则被敌方补兵滚雪球

这比"完全持平"更有 design tension，也符合 RTS asymmetric balance 惯例（人类玩家起势强 + AI 持久力强）。

economy 调整目标改写为：把敌方的优势从单一"**起始资源碾压 + 经济碾压**"（v1: money 1.43× + fuel 6.67× + baseIncome 1.5× + 起始 4 unit 多 + 30 min 流转 1.27×）调整为"**起始略弱 + 生产效率优势**"（v2: 起始资源持平/略高 + baseIncome money 1.25× + 30 min 产能 1.51× + 累积流转 1.08×）。

### 3.2 资源消耗模型（Verified from code）

| 资源 | 一次性 cost | Ongoing 消耗 |
|---|---|---|
| **Money** | UNIT_STATS.cost (inf 100 / lt 250 / mt 500 / art 400) | 无 |
| **Fuel** | UNIT_STATS.fuelCost (inf 0 / lt 5 / mt 10 / art 5) | **FUEL_PER_TILE_TANK = 0.1 / tile**（mechanized only：tank/artillery/air/naval；infantry/commander/elite_guard 不烧）— 见 `economy.ts:60 fuelPerTile()` + `sim.ts:134` 燃油耗尽 abort |
| **Ammo** | 无 | **AMMO_PER_ATTACK = 0.05 / 次攻击** — 见 `combat.ts:258` + `constants.ts:126` |

### 3.3 Money 计算

**30 min 实际产能假设**（v2.1 修正）：
- 玩家 sustain rate **70%**（人类玩家留 money 给 trade / doctrine / 操作失误）
- 敌方 sustain rate **90%**（AI 死磕生产，不浪费）
- 典型 mix: 50% inf + 30% lt + 20% mt, 平均 cost = `0.5×100 + 0.3×250 + 0.2×500 = 225` money/unit

**玩家现状（不动）**:
- Total money = 3,500 + 120×60 = **10,700**
- 30 min 产能 = 10,700 × 0.7 / 225 = **~33 unit**

**敌方调整后**:
- Total money = 3,500 + 150×60 = **12,500**
- 30 min 产能 = 12,500 × 0.9 / 225 = **~50 unit**

**产能比**: 敌方 / 玩家 = 50 / 33 = **1.51×**（敌方更强）

为什么 income 150（而非完全持平玩家 120）：AI 没有人类失误 / 不会做次优 trade，给 +25% income 反映"AI 高效率使用"。但即便如此，由于 AI sustain rate 1.29× (90/70) 玩家，敌方有效产能仍高于玩家约 50%。

**注**: 如果想真正让双方 30 min 产能持平 ~33 unit/side，需要把敌方 total money 降到 33×225/0.9 = 8,250，即 baseIncome 降到 (8250-3500)/60 = 79（远低于玩家 120）。这会让 enemy 显得"经济虚弱"反而违和。**我们选择保留"AI 效率优势"的设计 tension，文档诚实记录产能 1.51× 差距，让玩家明白"前期不 commit 后期会被滚雪球"的设计 intent**。

### 3.4 Fuel 计算

**30 min fuel 总需求**（双方对称, 都 40 起始 mechanized + 25 累积补充）:
- Build fuel: 30 min 产 15 lt × 5 + 10 mt × 10 = **175 fuel**
- Movement fuel: 65 mechanized × avg 150 tile/30 min × 0.1 fuel/tile = **~975 fuel**
- **Total demand: ~1,150 fuel**
- 加 30% buffer: **~1,500 fuel**

**当前现状**:
- 玩家 fuel total = 300 + 30×60 = **2,100** → **1.4× of need** ✓ 合理（留 ~40% buffer）
- 敌方 fuel total = 2,000 + 45×60 = **4,700** → **3.1× of need** ⚠ 过剩（codex 已经从 5000 降到 2000，但还是 3× 过剩）

**敌方调整后**: 起始 400 + baseIncome 30 × 60 = **2,200** → 1.5× of need ✓ 略高玩家（敌方装甲略多 + 单位平均 movement 略高，反映 AI 倾向多次 commit / reissue）

### 3.5 Ammo 计算

**单 active unit 30 min ammo 消耗**:
- Active 时间约 50% (~900s)
- 平均 attackInterval: inf 1.5 / lt 2.25 / mt 3.0 / art 6.0 → avg ~3s
- 每 unit attack 次数: 900 / 3 = 300 attacks
- Ammo: 300 × 0.05 = **15 ammo / 30 min / unit**
- 40 active mechanized + 30 active infantry × 15 = **~1,050 ammo demand**

**当前现状**:
- 玩家: 2,025 → 1.9× of need ✓
- 敌方: 2,400 → 2.3× of need ✓

**敌方调整**: 持平玩家（225 起始 + 30×60 = 2,025）。Ammo 不是 bottleneck，对称即可。

### 3.6 elAlamein/index.ts 完整 diff

```diff
       enemy: (() => {
         const eco = makeEconomy();
-        eco.resources.money = 5000;   // 5C-lite: support P4 production boost
-        eco.resources.fuel = 2000;    // codex: 够坦克跑但不无限油
-        eco.resources.ammo = 300;
-        eco.baseIncome = { money: 180, fuel: 45, ammo: 35, intel: 10 };
+        // 5C-lite v2.1: 起始略弱玩家、AI 持续产能效率更强（30 min 产能 ~50 unit vs 玩家 ~33, 1.51×）
+        // money: 12,500 total (3500 + 150×60) — income +25% 玩家反映 AI 90% sustain vs 玩家 70% sustain
+        // fuel:  2,200 total (400 + 30×60) — 1.5× of 30-min demand (~1,150)
+        // ammo:  2,025 total (225 + 30×60) — 持平玩家, 双方都 ~2× of demand
+        eco.resources.money = 3500;
+        eco.resources.fuel = 400;
+        eco.resources.ammo = 225;
+        eco.baseIncome = { money: 150, fuel: 30, ammo: 30, intel: 10 };
         return eco;
       })(),
```

---

## 4. 改完之后的最终对比

### 4.1 起始兵力（不算 commander + elite_guard）

| 兵种 | 玩家 起始+Strike | 敌方 起始+Panzer | 比例 (玩/敌) |
|---|---:|---:|---:|
| infantry | 22 + 12 = **34** | 31 + 6 = **37** | 0.92 |
| light_tank | 10 + 8 = **18** | 17 + 5 = **22** | 0.82 |
| main_tank | 11 + 5 = **16** | 10 + 3 = **13** | 1.23 |
| artillery | 6 | 5 | 1.20 |
| **总 units** | **74** | **77** | 0.96 |
| **总 HP** | **9,060** | **8,560** | 1.06 |
| **加 commander+eg** | **85** | **78** | 1.09 |
| **总 HP 含 cmd+eg** | **11,960** | **8,560** | 1.40 |

### 4.2 30 min 总账（资源 + 产能 + 战场流转）

| | 玩家 | 敌方 | 比例 (敌/玩) |
|---|---:|---:|---:|
| money 总可用 | 10,700 | 12,500 | 1.17× |
| fuel 总可用 | 2,100 | 2,200 | 1.05× |
| ammo 总可用 | 2,025 | 2,025 | 1.00× |
| 30 min 产 unit (sustain × money / cost) | **~33** (70% sustain) | **~50** (90% sustain) | **1.51×** ⚠ |
| **战场总流转 (起始 + 产)** | 85 + 33 = **118** | 78 + 50 = **128** | **1.08×** |

**v2.1 修正**：之前写"~50/~50/1.00× 持平 ✓"是误导。实际 AI sustain rate 90% × money 1.17× = 敌方有效产能 1.51× 玩家。**敌方累积流转略多 (128 vs 118)，玩家依赖前期 HP 1.40× 优势 commit 抢机会**。

### 4.3 敌方设计 intent 转变

| 维度 | 5C-lite v1 (改动前) | 5C-lite v2 (改动后) |
|---|---|---|
| 起始 money / fuel / ammo | 5000 / 2000 / 300 | 3500 / 400 / 225 (≈ 玩家) |
| baseIncome money | 180 (1.5× 玩家) | 150 (1.25× 玩家) |
| baseIncome fuel/ammo | 45 / 35 (1.5× / 1.17×) | 30 / 30 (= 玩家) |
| 起始装甲 (lt+mt) | 27 → 35 (+ Panzer Group 后) | 35 (不变) |
| 30 min 累积产能 | ~90 unit (碾压玩家 ~33) | ~50 unit (1.51× 玩家 ~33) |
| 战场总流转 | 78 + 90 = 168 (1.27× 玩家 135) | 78 + 50 = 128 (1.08× 玩家 118) |
| 敌方优势来源 | **起始资源碾压 + 经济碾压 + 人海**（多重） | **AI 高效产能 + 战术压力 + 反击 doctrine + P4 + facility HP**（单一经济杠杆 + 多重战术） |

**核心变化**：去掉"起始资源碾压"，把"经济碾压"从 1.27× 流转优势降到 1.08× 流转优势（敌方仍有产能 1.51× 优势，但起始数量略弱 — 78 vs 玩家 85）。施压源更多来自战术（multi-line raid + Panzer counter-attack + P4 wave），少来自数字暴力。

---

## 5. 为什么 logic 不用改

### 5.1 pressureDirector — 不改

- `gatherPressurePool` 按距离排序，新 Panzer Group 在 (180, 75) / (210, 185) 距离 player forward post 158-214 tile，会自然成为 P4 wave 优先抽用对象
- `MIN_POOL_TO_FIRE = 4` — pool 43 unit 远超 4，永远不会哑火
- P4 wave size table、cooldown、history penalty、production boost、garrison exclusion radius — 全都和 unit count 无关，参数维持

### 5.2 defensiveAI — 不改

- 它自己 logic 内部按 idle/defending unit count 决定 P1/P2/P3 wave 大小
- 加 14 unit → defensiveAI 自然多派攻击群（自然行为，不需要参数调）
- codex 之前已经把 fallback target 改对应 player post（不再默认冲 HQ），那个改动保留

### 5.3 唯一 playtest 后可能要调的（**单参数 tuning，不算 logic 改动**）

- 如果 playtest 觉得敌方 raid 太猛（mobile pool +48% 之后）：`P4_BASE_COOLDOWN_EASY: 140 → 180`（1 行）
- 如果觉得太软：`140 → 100`（1 行）
- 这是 tuning，不在本提案范围内。playtest 后再决定。

---

## 6. § 0 架构铁律 check

| 文件 | 5C-lite v2 改动 | 铁律要求 |
|---|---|---|
| `defensiveAI.ts` | 0 (codex round 1 改的 fallback 保留) | ✓ 0 改动 |
| `autoBehavior.ts` | 0 | ✓ |
| `combat.ts` | 0 | ✓ |
| `sim.ts` | 0 | ✓ |
| `pathfinding.ts` | 0 | ✓ |
| `fog.ts` | 0 | ✓ |
| `enemyAI.ts` | 0 | ✓ |
| `reportSignals.ts` | 0 | ✓ |
| `advisorTrigger.ts` | 0 | ✓ |
| shared `intents.ts` / `squad.ts` / `schema.ts` | 0 | ✓ |
| `apps/server/**` | 0 | ✓ |
| `pressureDirector.ts` | 0（v2 不动它） | （v2 没改） |
| `elAlamein/deployment.ts` | +5 placeGroup blocks | ⚠ 改动文件，但 deployment.ts 不在"必须 0 改动"清单里（5C-lite Step 3 已改过） |
| `elAlamein/index.ts` | 4 行 economy 调整 | ⚠ 改动文件，同上（Step 2 已改过） |

**全部符合铁律。**

---

## 7. V1-V19 验证 checklist（5C-lite v1 已 PASS，v2 增量需 re-run）

| # | 项 | 5C-lite v2 之后预期 |
|---|---|---|
| V1 | typecheck 4 workspaces | PASS（只加 deployment + economy 常量值改动，0 类型变化） |
| V2 | `npm run build` | PASS |
| V3 | grep -c localhost:3001 dist/assets/*.js | 0 |
| V4 | HUD `OBJECTIVES 0/3 / POSTS LOST 0/3` | 不变 |
| V5 | 10 min 自跑 P4 diagnostics | 应该看到 `P4 fire` 频率不变（cooldown 没改）；pool gathered size 可能变大（pool +48%） |
| V6 | 占 Axis objective → recapture wave | 不变 |
| V7 | 撤 forward post 守军 → finish_post/raid | 不变 |
| V8 | Chen brief 频率 | 不变 |
| V9-V11.2 | timeout 5 个 rating | 不变 |
| V12 | HQ 毁 → 无 rating breakdown | 不变 |
| V13 | 3 post 丢 → "失守 3 处前哨" | 不变 |
| V14 | 占满 3 Axis objective | 不变 |
| V15 | El Alamein commander 死 → 游戏继续 | 不变 |
| V16 | dual_island commander 死 → endGame | 不变 |
| V17 | prod 模式 load + 玩 | 不变 |
| V18 | `PLAYTEST_ENABLED=false` /api/health | 不变 |
| V19 | 删 pressureDirector + 7 outside 行 → typecheck | 仍 PASS（v2 不动 pressureDirector，删除 path 不变） |

**新增 v2 验证**：
- V20 (新)：playtest 30 min 实际产能 — 玩家 ~33 unit (70% sustain) / 敌方 ~50 unit (90% sustain), 产能比 ~1.51× 敌方更强（在 dev tools 里 `state.units.size` + 历史 spawn count 估算）
- V21 (新)：playtest 30 min fuel 不耗尽（玩家或敌方），mechanized 不出现"燃油耗尽中止"日志
- V22 (新)：第一波 P4 在 90s grace 后 firing；后续 cadence 140s ± 20s (easy phase)
- V23 (新)：玩家三线进攻可行 — 至少 2 线能 commit 力量推 objective
- **V24 (新, codex round 2 加)**：前 10 分钟敌方主力进攻目标主要是 3 个 player forward post（而非冲 player HQ）。验证方式：观察敌方 attacking/moving 状态 unit 的 `u.target` 大致分布，应 cluster 在 coastal post (360, 33) / central post (360, 103) / south post (365, 153) 附近，不是 HQ (430, 88) 附近。这是 codex 之前已经改过的 defensiveAI fallback target 选择 — playtest 验证它生效。

---

## 8. 给 codex 的具体问题

1. **deployment 增量位置 + 兵种比例合理吗？**（§ 2）
   - 历史 doctrine: X Corps 后方 staging + Rommel 装甲反击 — 我的 (400, 60/95/145) 和 (180, 75) / (210, 185) 是否准确反映？
   - 兵种比例 玩家 48% 步 / 敌方 43% 步 — 是否过度偏离当前 game RTS 装甲密度（双方 ~50% 步 / ~40% 装甲）？

2. **经济校准非对称产能合理吗？玩家 ~33 / 敌方 ~50 (1.51×)、累积流转 118 vs 128 (1.08×)**（§ 3）
   - 玩家 sustain rate 70% vs 敌方 90% 假设是否合理？
   - 敌方 income +25% (150 vs 玩家 120) 反映 AI 高效率，是否过/不及？
   - fuel/ammo 持平是否符合 "去掉资源碾压" 的设计 intent？

3. **logic 真的不需要改吗？**（§ 5）
   - pressureDirector mobile pool 从 29 → 43 不会让 P4 wave 变质（size 不变）— 你认同吗？
   - defensiveAI 加 14 unit 后是否会出现行为异常（比如同时派 3-4 个攻击群）？

4. **V20-V23 playtest 验证项是否完整？**（§ 7）
   - 还有什么 v2 增量验证项要加？

5. **本提案是否破坏了 5C-lite v1 的删除路径？**（§ 6）
   - 5C-lite 删除应该是 3 步：删 pressureDirector + 删 export + 删 6 GameCanvas 行
   - v2 加的 5 个 placeGroup + 5 行 economy 改动如果要还原，是 "scenario polish" 范畴，与 pressureDirector 删除独立

---

## 9. 风险 + 回滚

### 风险

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | 玩家三线进攻太分散 → 单线打不过 garrison + 反击 | 中 | playtest 观察。如果 3 线都太弱，玩家自己会集中 2 线推 — 这是 design space，不是 bug |
| R2 | 敌方 Panzer Group 反击让玩家 Strike Force 还没到 objective 就被截 | 中 | 这正是 design intent。Strike Force 步兵 48% 提供 attrition resilience |
| R3 | 敌方 fuel 2,200 不够 → 装甲 idle 烧没 → P4 wave 哑火 | 低 | 1.5× of 30-min demand 留 50% buffer。如果出现 fuel 耗尽，加到 500 起始 |
| R4 | 玩家 money 10,700 vs 敌方 12,500 (敌方 +17%) → 玩家觉得不公平 | 低 | 反映 AI sustain rate 高的 game balance compensation，符合 RTS 惯例 |
| R5 | 玩家觉得开局 enemy 不够 aggressive（中线 Forward Screening 还在 190, 50） | 低 | 新 Panzer Group 在 (180, 75) / (210, 185) 比 Forward Screening 略远，但 pressureDirector P4 wave 仍优先抽近的 → 战场感不变 |

### 回滚

**v2 → v1 回滚**：
1. 删 `deployment.ts` 末尾 5 个 placeGroup block（玩家段后 3 个 + 敌方段后 2 个）
2. 还原 `elAlamein/index.ts` 敌方 economy 4 行（money 3500→5000, fuel 400→2000, ammo 225→300, baseIncome 150/30/30 → 180/45/35）

**v1 → 完全删除 5C-lite**（不变）：
1. 删整个 `pressureDirector.ts`
2. 删 `core/src/index.ts` 1 行 export
3. 删 `GameCanvas.tsx` 6 行（import 2 + tick 1 + reset 2 + P4_DBG 1）

---

## 10. 实施 sequence（codex 通过后）

1. `deployment.ts` 末尾追加 5 个 placeGroup block（按 § 2.4 diff）→ typecheck
2. `elAlamein/index.ts` 敌方 economy 4 行调整（按 § 3.6 diff）→ typecheck
3. `npm run build` → 验证 bundle 包含新 unit count
4. **不 commit**，交给 yuqiaohuang playtest
5. playtest 反馈 → 微调（如需要）
6. yuqiaohuang 确认 OK → 一并 commit + tag + push

---

**End of v2 workplan.**
