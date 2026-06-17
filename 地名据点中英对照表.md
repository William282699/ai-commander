# Step 5C-lite v5.1 — i18n Trace Map (地名中英切换完整 trace 文档)

> **v5 → v5.1 changelog (codex static review)**:
> - 修正所有 count 引用：实际是 **43 项** = 19 facility + 12 region + 2 chokepoint + 5 front + 5 route（之前文档写 21 facility + 16 region 是 doc 起草时误计 — chokepoint 被算进了 region）
> - 修正 6 个文档名字与 mapData.ts 实际不一致项：
>   - `ea_comm_tower`: ~~泰勒艾萨通讯站~~ → **沿海雷达**（避音译 + 跟 STT 友好）
>   - `ea_observation_post`: ~~鲁韦萨特观察哨~~ → **中央雷达**（避音译）
>   - `tel_el_eisa` (region): ~~泰勒艾萨高地~~ → **北沿海高地**
>   - `ruweisat_zone` (region): ~~鲁韦萨特山脊~~ → **中部山脊**
>   - `alam_halfa_zone` (region): ~~阿拉姆哈勒法山脊~~ → **南部山脊区**
>   - `northern_coastal` (region): ~~北部沿海区~~ → **北部沿海**
> - § 1.2 region 表移除 row 13-14（minefield_gap_*）— 它们是 chokepoint，在 § 1.5 单独列
> - § 1.1 facility "剩下 13 个待改" → "剩下 11 个"
> - § 11 implementation plan Step 1/Step 2 数量同步修正
> - **加 § 4.1 渲染层视觉调整**：V5 同时包含 `apps/web/src/rendererCanvas.ts` + `apps/web/src/GameCanvas.tsx` 的战略标签可读性 fix。**最终策略**：所有 19 个 facility 永远显示 label，按 strategic (10 个: 据点/前哨/HQ, bold 14px) vs regular (9 个: 兵营/机场/油库等, 12px) 两档视觉区分。Render order 让 facility 名字不被 front label 遮挡；front label 减重成轻量 context badge。**不动数据 / LLM / 引擎逻辑**，只改地图视觉

> **目的（dual purpose）**：
>
> 1. **正向（中文化）**：把 El Alamein 战役地图所有英文 name 中文化（已完成 8 个核心 facility，扩展到全部 **19 facility + 12 region + 2 chokepoint + 5 front + 5 route = 43 项**）
> 2. **反向（英文化）**：当需要给 Discord 英文群朋友测试时，按此文档反向操作即可恢复全英文 name（**不需要做 i18n 架构**）
>
> **核心保证**: 改名字时 **LLM 链路不丢信息**。原理：
> - **数据源单点**（`packages/shared/src/scenario/elAlamein/mapData.ts`）
> - **UI / digest / messages 99% 全动态**读 `f.name` / `front.name` / `region.name` / `route.name`，改源即同步
> - **唯一手动改的是 `apps/server/src/ai.ts` 里的 STATIC examples**（但**可以不改**，详见 §3）
> - **facility tags 保留旧英文 alias** → fuzzy match resolver 仍能识别英文输入

---

## § 0. 架构层级 — 改 mapData.ts 影响哪 5 层

```
                  ┌─────────────────────────────────────────────────┐
                  │ packages/shared/src/scenario/elAlamein/         │
                  │ mapData.ts (SINGLE SOURCE OF TRUTH)             │
                  │                                                  │
                  │   - EL_ALAMEIN_REGIONS [12]                     │
                  │   - EL_ALAMEIN_CHOKEPOINTS [2]                  │
                  │   - EL_ALAMEIN_FACILITIES [19]                  │
                  │   - EL_ALAMEIN_FRONTS [5]                       │
                  │   - EL_ALAMEIN_ROUTES [5]                       │
                  └──────────────────┬──────────────────────────────┘
                                     │
        ┌──────────────────┬─────────┴──────────┬──────────────────────┐
        │                  │                    │                       │
        ▼                  ▼                    ▼                       ▼
┌──────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ § 2 LLM       │  │ § 3 LLM Prompt  │  │ § 4 UI 渲染     │  │ § 5 消息系统     │
│   digest      │  │   STATIC        │  │   (canvas)      │  │   (events)       │
│               │  │   examples      │  │                 │  │                  │
│ ✅ 100%       │  │ ⚠️ 半静态       │  │ ✅ 100%         │  │ ✅ 100%          │
│ dynamic       │  │ (可选改)        │  │ dynamic         │  │ dynamic          │
│               │  │                 │  │                 │  │                  │
│ intelDigest   │  │ apps/server/    │  │ rendererCanvas. │  │ reportSignals.ts │
│ .ts:125,139   │  │ src/ai.ts:      │  │ ts:308 (fac.    │  │ :232,240,242,263 │
│ battleContext │  │ 多处嵌入        │  │ name),803-814   │  │                  │
│ .ts:74,151    │  │ "El Alamein",   │  │ (front.name),   │  │ GameCanvas.tsx   │
│               │  │ "Coastal",      │  │ 870 (route),    │  │ :724,743 (派遣   │
│               │  │ "Kidney Ridge"  │  │ 907 (region)    │  │ 占领/破坏)       │
│               │  │ 作为 examples   │  │                 │  │                  │
└──────────────┘  └─────────────────┘  └─────────────────┘  └──────────────────┘
        │                  │                    │                       │
        └──────────────────┴───────┬────────────┴───────────────────────┘
                                   │
                                   ▼
                ┌──────────────────────────────────────────┐
                │ § 6 Fuzzy match resolver (LLM 输入端)    │
                │                                          │
                │ tacticalPlanner.ts findFacilityById:     │
                │   match f.name.toLowerCase()             │
                │   match f.tags.some(t.toLowerCase())     │
                │                                          │
                │ → tags 保留 English alias                │
                │   ("Kidney Ridge" 等)                    │
                │ → 中英双输入都 work                      │
                └──────────────────────────────────────────┘
```

---

## § 1. 数据源 — `packages/shared/src/scenario/elAlamein/mapData.ts`

**所有 5 大数据集都在这一个文件里**。改 name 只改这一个文件，不动任何其他文件。

### § 1.1 19 个 Facility（核心，玩家说出口最多）

| # | id | 当前 name | 改后中文 name (建议) | 当前 tags (改后追加项) |
|---|---|---|---|---|
| **核心 7 + 1 Rommel — V4 已改完** |||||
| 1 | `ea_player_coastal_post` | ~~Coastal Forward Post~~ → **北线前哨** | (已是中文) | 已加: 一号前哨, 北线前哨, Coastal Forward Post |
| 2 | `ea_player_central_post` | ~~Central Desert Forward Post~~ → **中央前哨** | (已是中文) | 已加: 二号前哨, 中央前哨, Central Desert Forward Post |
| 3 | `ea_player_south_post` | ~~Alam Halfa Forward Post~~ → **南线前哨** | (已是中文) | 已加: 三号前哨, 南线前哨, Alam Halfa Forward Post |
| 4 | `ea_alamein_town` | ~~El Alamein~~ → **阿拉曼镇** | (已是中文) | 已加: 敌一号, 阿拉曼, 阿拉曼镇, El Alamein |
| 5 | `ea_kidney_ridge` | ~~Kidney Ridge Strongpoint~~ → **北部山脊** | (已是中文) | 已加: 敌二号, 北部山脊, 北线山脊, Kidney Ridge |
| 6 | `ea_miteirya_ridge` | ~~Miteirya Ridge Strongpoint~~ → **中央山脊** | (已是中文) | 已加: 敌三号, 中央山脊, Miteirya Ridge |
| 7 | `ea_himeimat` | ~~Himeimat Heights~~ → **南部高地** | (已是中文) | 已加: 敌四号, 南部高地, 南线高地, Himeimat Heights |
| 8 | `ea_rommel_hq` | ~~Rommel's HQ~~ → **敌军总部** | (已是中文) | 已加: 敌军总部, 隆美尔总部, Rommel HQ |
| **剩下 11 个待改 — V5 加** |||||
| 9 | `ea_player_hq` | Montgomery's HQ | **我军总部** | `["HQ", "headquarters", "Montgomery", "command"]` 加 `"我军总部"`, `"蒙哥马利总部"`, `"Montgomery HQ"` |
| 10 | `ea_player_barracks` | 8th Army Barracks | **我军兵营** | `["barracks", "infantry", "ground production"]` 加 `"我军兵营"`, `"步兵营房"`, `"8th Army Barracks"` |
| 11 | `ea_player_airfield` | Desert Air Force Base | **我军机场** | `["airfield", "RAF", "air production"]` 加 `"我军机场"`, `"沙漠空军基地"`, `"Desert Air Force Base"` |
| 12 | `ea_repair_station` | Field Repair Depot | **野战修理厂** | `["repair", "maintenance"]` 加 `"野战修理厂"`, `"修理厂"`, `"Field Repair Depot"` |
| 13 | `ea_fuel_depot` | Forward Fuel Dump | **前线油库** | `["fuel", "oil", "supply"]` 加 `"前线油库"`, `"油库"`, `"Forward Fuel Dump"` |
| 14 | `ea_ammo_depot` | Desert Ammo Cache | **沙漠弹药库** | `["ammo", "ammunition", "supply"]` 加 `"沙漠弹药库"`, `"弹药库"`, `"Desert Ammo Cache"` |
| 15 | `ea_comm_tower` | Tel el Eisa Signal Station | **沿海雷达** | `["comm", "signal", "intel", "Tel el Eisa"]` 加 `"沿海雷达"`, `"海岸雷达"`, `"Tel el Eisa Signal Station"` |
| 16 | `ea_observation_post` | Ruweisat Observation Post | **中央雷达** | `["observation", "Ruweisat", "vision"]` 加 `"中央雷达"`, `"沙漠雷达"`, `"Ruweisat Observation Post"` |
| 17 | `ea_axis_barracks` | Afrika Korps Barracks | **敌军德军营房** | `["axis barracks", "German"]` 加 `"敌军德军营房"`, `"德军营房"`, `"Afrika Korps Barracks"` |
| 18 | `ea_axis_airfield` | Axis Airfield | **敌军机场** | `["axis airfield", "Luftwaffe"]` 加 `"敌军机场"`, `"轴心机场"`, `"Axis Airfield"` |
| 19 | `ea_axis_barracks2` | Italian Infantry Depot | **敌军意军营房** | `["Italian", "barracks"]` 加 `"敌军意军营房"`, `"意军营房"`, `"Italian Infantry Depot"` |

> **Notes**:
> - 玩家说"派步兵去野战修理厂修理"或"占领前线油库"这种 — STT 准确率高（都是常见词）
> - 每个 facility 的 tags 都保留**旧英文 name 作为最后一个 alias** → 反向时只需把 `name` 改回英文即可，tags 不动
> - **不改**: `id` / `type` / `position` / `team` / `regionId` / `strategicEffect` / 数值属性

### § 1.2 12 个 Region（地图大区域，玩家偶尔说出口）

> Chokepoint 是单独 array，见 § 1.5。**Region table 严格只列 12 个 region**。

| # | id | 当前 name | 改后中文 name |
|---|---|---|---|
| 1 | `british_hq_area` | British HQ Area | **我军总部区** |
| 2 | `northern_coastal` | Northern Coastal Zone | **北部沿海** |
| 3 | `tel_el_eisa` | Tel el Eisa Heights | **北沿海高地** |
| 4 | `kidney_ridge_zone` | Kidney Ridge | **北部山脊区** |
| 5 | `miteirya_ridge_zone` | Miteirya Ridge | **中央山脊区** |
| 6 | `minefield_zone` | Devil's Gardens (Minefield) | **魔鬼花园雷区** |
| 7 | `ruweisat_zone` | Ruweisat Ridge | **中部山脊** |
| 8 | `central_desert` | Central Desert | **中央沙漠** |
| 9 | `southern_desert` | Southern Desert | **南部沙漠** |
| 10 | `alam_halfa_zone` | Alam el Halfa Ridge | **南部山脊区** |
| 11 | `himeimat_zone` | Himeimat Heights | **南部高地区** |
| 12 | `axis_rear` | Axis Rear Area (Rommel HQ) | **轴心后方** |

> Region 不像 facility 那样有 tags，**只改 `name`**。Region name 主要用于：
> - `battleContext.ts:74,151` LLM 看到的 weak front / flank risk 描述
> - `rendererCanvas.ts:907` 地图上区域 label（如果开启 region 显示）
> - Chen brief 引用 "Kidney Ridge zone" → 改完会变 "北部山脊区"

### § 1.3 5 个 Front（屏幕上"1. Coastal Sector" 那种标签）

| # | id | 当前 name | 改后中文 name (建议) |
|---|---|---|---|
| 1 | `front_coastal` | 1. Coastal Sector | **1. 北部战线** |
| 2 | `front_ridge` | 2. Ridge Line | **2. 山脊战线** |
| 3 | `front_center` | 3. Central Desert | **3. 中央战线** |
| 4 | `front_south` | 4. Southern Sector | **4. 南部战线** |
| 5 | `front_axis_rear` | 5. Axis Rear | **5. 敌军后方** |

> **保留数字前缀 `1. 2. 3. 4. 5.`** — 这是 player 按数字键 1-5 快速跳转 camera 用的视觉锚点，跟 keypad 对应。
> 
> Front name 用于：
> - `rendererCanvas.ts:803,814` 地图上 5 个大区 label（user 截图里的 "Ridge Line"）
> - `intelDigest.ts:125,139` LLM digest ---FRONTS--- section（如 "Coastal Sector: 50/70 supply=OK"）
> - `battleContext.ts:74` weak front names
> - Chen brief 引用 "Coastal sector 撑不过 10 分钟" → 改完变 "北部战线 撑不过 10 分钟"

### § 1.4 5 个 Named Route（地图上路名）

| # | id | 当前 name | 改后中文 name (建议) |
|---|---|---|---|
| 1 | `via_balbia` | Via Balbia (Coastal Highway) | **沿海公路** |
| 2 | `desert_track` | Central Desert Track | **中央沙漠小路** |
| 3 | `southern_pass` | Southern Mountain Track | **南部山路** |
| 4 | `front_line_road` | British Front Line Road | **前线公路** |
| 5 | `axis_supply_road` | Axis Supply Road | **敌军补给路** |

> Route name 用于 `rendererCanvas.ts:870` 地图上路名 label。Chen / digest 也可能引用 routes（如 "建议走沿海公路"）。

### § 1.5 2 个 Chokepoint（小通道）

| # | id | 当前 name | 改后中文 name (建议) |
|---|---|---|---|
| 1 | `minefield_gap_north` | Northern Mine Gap | **北部雷区缺口** |
| 2 | `minefield_gap_center` | Central Mine Gap | **中央雷区缺口** |

> 跟 § 1.2 region 同名（intentional — 这些区域中心是雷区缺口）。Chokepoint 主要给引擎 pathfinding 用，玩家很少直接引用。

### § 1.6 4 个 Capture Objectives (`EL_ALAMEIN_OBJECTIVES`)

```ts
export const EL_ALAMEIN_OBJECTIVES: string[] = [
  "ea_alamein_town",
  "ea_kidney_ridge",
  "ea_miteirya_ridge",
  "ea_himeimat",
];
```

**只是 facility ID 引用，无 name 字段，不改**。改 § 1.1 facility name 自然同步。

### § 1.7 5 个 Camera Targets

```ts
export const EL_ALAMEIN_CAMERA_TARGETS: Record<string, {x,y}> = {
  front_coastal:   { x: 280, y: 35 },
  front_ridge:     { x: 230, y: 65 },
  ...
};
```

**只有坐标，无 name 字段，不改**。

---

## § 2. LLM digest 链路 ✅ 改 mapData.ts auto-sync

```ts
// packages/core/src/intelDigest.ts
line 125: lines.push(`${front.name}: ${str}/${status} supply=${front.supplyStatus}`);
line 139: risks.push(`Supply crisis: ${front.name}`);
```

```ts
// packages/core/src/battleContext.ts
line 74:  const frontNames = weakFronts.map((f) => f.name).join(", ");
line 151: risks.push(`Flank risk: ${f.name} WEAK, adjacent front under heavy contact`);
```

**结论**：digest / battleContext 100% dynamic 引用 `front.name` 和（间接通过 fronts）region name。**改 mapData.ts，LLM 看到的内容自动变中文**。

LLM 智能足够：看到 digest 里 "北部战线: 50/70 supply=OK"，会理解为某条战线状态。然后回 brief 用中文也用 "北部战线" 引用。

---

## § 3. LLM Prompt 静态 examples ⚠️ 决定改不改

`apps/server/src/ai.ts` 的 SYSTEM_PROMPT（Chen / Marcus / Emily 三个 persona）**多处嵌入了具体 facility / front name 作为 example**：

| line | 用法 | example 文本（节选） |
|---|---|---|
| 52 | Chen 禁的 acknowledgment pattern | `❌ "是，长官。Aiden攻击El Alamein"` |
| 54-56 | Chen ✅ pattern | `✅ "Aiden攻击El Alamein，3分钟到位。"` |
| 59 | Chen ❌ sitrep pattern | `❌ "...Coastal方向我方有优势..."` |
| 66,68,70,72 | UNDER_ATTACK event examples | `Event: "Coastal Sector 遭到攻击"` |
| 83 | 教 Chen 引用 digest 锚定地名 | `引用 ---FACILITIES---（如El Alamein、Kidney Ridge）` |
| 187 | toFront 解析 example | `Aiden 守住 Coastal` |
| 213-214 | formation example | `Aiden 长蛇阵进攻 El Alamein` |
| 250 | 教 LLM fuzzy match 机制 | `"El Alamein" matches facility "ea_alamein_town"` |
| 387 | Marcus advisory tone example | `正面强攻El Alamein风险高` |
| 402 | Marcus 占据 facility 列表 example | `我方目前占据5处设施：El Alamein、Kidney Ridge` |
| 413,553 | combat enforcement rules | `✅ "长官，Coastal 3辆重甲压上"` |
| 626 | Self-relief fallacy example | `Event "Coastal遭袭[战斗中: I1]"` |

### Trade-off：改 vs 不改

| 方案 | 优势 | 风险 |
|---|---|---|
| **A. 不改 prompt examples**（推荐先试） | 省时间。LLM 智能足够：prompt 里 "El Alamein" 只是 example，真实运行时 LLM 看到的是 digest 里 "阿拉曼镇"（dynamic），会自动 adapt | LLM 偶尔可能在 brief 里 mix 中英文（"敌方在 Coastal 集结"而非"敌方在北部战线集结"）。Playtest 发现混乱再回头改 |
| **B. 全部 ai.ts examples 中文化** | prompt 跟地图一致，brief 输出更稳定纯中文 | 改 ~15-20 行，且未来反向英文化时这部分**需要反向改 prompt** |

### 我的推荐

**Phase 1（这次）**: 选 **A 不改 prompt**。理由：
1. Tags 保留英文 alias → LLM 输入兜底 (玩家说 "推 Kidney Ridge" 仍能 resolve)
2. Digest dynamic → LLM 输出用 digest 里看到的 name (中文)
3. 反向英文化时 prompt 不用动，更 deletable

**Phase 2（如 playtest 发现 LLM 混乱）**: 才考虑改 prompt examples。

---

## § 4. UI 渲染 ✅ 改 mapData.ts auto-sync

`apps/web/src/rendererCanvas.ts` 全部 dynamic：

| line | 用法 | 影响 |
|---|---|---|
| 308 | `ctx.fillText(fac.name, cx, cy + iconSize / 2 + 8)` | facility label on map（user 截图 "8th Army Barracks"）|
| 803 | `ctx.measureText(front.name).width + 16` | front label 宽度计算 |
| 814 | `ctx.fillText(front.name, screenX, screenY)` | front zone label（user 截图 "Ridge Line"）|
| 870 | `ctx.fillText(route.name, 0, 0)` | route label（user 截图 "Central Desert Track"）|
| 907 | `ctx.fillText(region.name, screenX, screenY)` | region label（如果开启 region 显示）|

`apps/web/src/GameCanvas.tsx`：

| line | 用法 |
|---|---|
| 724 | `addMessage("info", "派遣单位占领 ${menu.facility.name}", ...)` |
| 743 | `addMessage("info", "派遣单位破坏 ${menu.facility.name}", ...)` |

**结论**: 全 dynamic，改 mapData.ts auto-sync。**改完 hard refresh 浏览器 + 点"再来一局"立即生效**。

### § 4.1 渲染层视觉调整（V5 附加项）

V5 改 facility 中文 name 时同步发现：中文标签在地图上的可读性比英文差（中文笔画更密、需要更高对比度）。**修了以下 5 项视觉调整**，全部在 `apps/web/src/rendererCanvas.ts` + `apps/web/src/GameCanvas.tsx`，**不动数据 / LLM / 引擎逻辑**：

| # | 改动 | 之前 | 之后 | 原因 |
|---|---|---|---|---|
| 1 | facility label 显示策略 | `zoom >= 0.8` 才显示 | **永远显示，按 strategic vs regular 分两档字体** | 玩家 zoom-out 看全局也要能看到**所有** facility name 快速下令（"派人去敌军总部" / "防御我军兵营" 等） |
| 2 | strategic facility 字体 | (跟普通同样) | **`bold Math.max(12, 14*zoom)`px + 3px stroke** | 视觉权重高，自然引导眼睛到 10 个核心目标 |
| 3 | regular facility 字体 | (跟 strategic 同样) | **`Math.max(10, 12*zoom)`px regular + 2px stroke** | 略小略淡，可读但不喧宾夺主 |
| 4 | render 顺序 swap | facility (step 2) → front/route/region label (step 7) | **front/route/region (step 1.5) → facility (step 2)** | facility 名字永远画在 front label 上面，不再被 "1. 北部战线" 等 box 遮挡 |
| 5 | front label 减重 | 14px bold + box 20h + padding 16 + alpha 0.7 | **12px bold + box 16h + padding 10 + alpha 0.45** | 让 front label 成为更轻的 "context badge"，地形/facility 透出来 |

**Strategic facility 判定（10 个）**:
```ts
const isStrategic =
  fac.type === "headquarters" ||  // 2 个: ea_player_hq (我军总部), ea_rommel_hq (敌军总部)
  fac.tags.includes("据点") ||     // 4 个: 阿拉曼镇 / 北部山脊 / 中央山脊 / 南部高地
  fac.tags.includes("前哨");       // 3 个: 北线前哨 / 中央前哨 / 南线前哨
                                    // 注: 敌军总部 ea_rommel_hq 既有 type=headquarters 又有 tag=据点, 不重复
```

= **10 个策略目标用 bold 14px 突出**（4 Axis obj + 3 player post + 2 HQ + 1 重叠 = 8 unique 据点/前哨 + 2 HQ - 1 重叠 = 9 个 unique strategic + 1 重叠在 据点 里的 Rommel HQ = 实际 9 个 unique facility）。

**Regular facility（9 个）用 12px 普通字体**:
- 玩家方: 我军兵营, 我军机场, 野战修理厂
- 敌方: 敌军德军营房, 敌军机场, 敌军意军营房
- 中间: 前线油库, 沙漠弹药库, 沿海雷达, 中央雷达

**总计 19 个 facility 全部永显**，按 strategic/regular 两档视觉区分。

**架构保证**:
- ✅ 不动 mapData.ts 数据（只是渲染时多了一个 tag 检查）
- ✅ 不动 LLM 链路（digest 仍读 `f.name`，跟视觉无关）
- ✅ 不动 fuzzy match resolver（仍按 tags + name 匹配）
- ✅ 反向英文化时这层视觉调整自动 work（strategic facility 仍按 "据点"/"前哨" tag 判定，而 tag 永远保留中英文双 alias）

**Render order 调整完整 diff**（GameCanvas.tsx）:
```diff
- // 2. Facilities on map
- renderFacilities(ctx, facArray, camera);
- ... (terrain / fog / units / combat / selection)
- // 7. Front labels
- renderFrontLabels(ctx, state.fronts, cameraTargets, camera);
- // 7.5 Route + region labels
- renderRouteLabels(...); renderRegionLabels(...);

+ // 1.5 Context labels (front/route/region) — drawn FIRST so facility names render on top
+ renderFrontLabels(ctx, state.fronts, cameraTargets, camera);
+ renderRouteLabels(...); renderRegionLabels(...);
+ // 2. Facilities (drawn AFTER context labels for readability)
+ renderFacilities(ctx, facArray, camera);
+ ... (terrain still step 1, fog/units/combat/selection unchanged)
+ // 7+7.5: moved to step 1.5 above
```

---

## § 5. 消息系统 ✅ 改 mapData.ts auto-sync

`packages/core/src/reportSignals.ts`：

```ts
line 232: emit(state, "FACILITY_LOST", `${f.name} 被摧毁！`, "critical", f.id);
line 240: emit(state, "FACILITY_CAPTURED", `夺取设施: ${f.name}`, "info", f.id);
line 242: emit(state, "FACILITY_LOST", `失去设施: ${f.name}`, "critical", f.id);
line 263: `${f.name} 正在被夺取！(${progress}%)`,
```

**结论**: 全 dynamic。改 facility.name 中文，事件消息自动用中文 name。

---

## § 6. Fuzzy Match Resolver (LLM 输入端) ✅ tags 已保留英文 alias

`packages/core/src/tacticalPlanner.ts`：

```ts
line 961:  export function findFacilityById(...) { ... }
line 973:  f.tags.some((t) => t.toLowerCase().includes(lower))   ← tag match
line 1386: function findFacilityPosition(...) { ... }
line 1398: f.tags.some((t) => t.toLowerCase().includes(lower))   ← tag match
```

resolver 做以下 fuzzy match:
- `facility.id.toLowerCase().includes(query.toLowerCase())`
- `facility.name.toLowerCase().includes(query.toLowerCase())`
- `facility.tags.some(t => t.toLowerCase().includes(query.toLowerCase()))`

### V4 已加的 tags（中文别名 + 英文 alias 兜底）

| Facility | tags 含 |
|---|---|
| ea_alamein_town | 阿拉曼, 阿拉曼镇, **El Alamein** |
| ea_kidney_ridge | 北部山脊, 北线山脊, **Kidney Ridge** |
| ea_miteirya_ridge | 中央山脊, **Miteirya Ridge** |
| ea_himeimat | 南部高地, 南线高地, **Himeimat Heights** |
| ea_rommel_hq | 敌军总部, 隆美尔总部, **Rommel HQ** |
| ea_player_coastal_post | 北线前哨, 一号前哨, **Coastal Forward Post** |
| ea_player_central_post | 中央前哨, 二号前哨, **Central Desert Forward Post** |
| ea_player_south_post | 南线前哨, 三号前哨, **Alam Halfa Forward Post** |

**双语输入都 work**：
- 玩家说 "推中央山脊" / "Push Kidney Ridge" / "Push 敌二号" → 都能 resolve 到 `ea_kidney_ridge`
- LLM 输出实体 ID 永远是 canonical English (`ea_kidney_ridge`) 给引擎用

---

## § 7. 完整 trace table — 改一个 name 需要 trace 哪些位置

| 改动 | 改这里 | 自动同步层 | 不会同步（需手动）|
|---|---|---|---|
| facility.name | mapData.ts §1.1 FACILITIES | § 4 UI map label, § 2 digest, § 5 messages, § 6 resolver fuzzy | § 3 ai.ts prompt examples (可选改) |
| front.name | mapData.ts §1.3 FRONTS | § 4 UI front label, § 2 digest, battleContext | § 3 ai.ts prompt examples (可选改) |
| region.name | mapData.ts §1.2 REGIONS | § 4 UI region label (if rendered), battleContext flank risk | — |
| route.name | mapData.ts §1.4 ROUTES | § 4 UI route label | — |
| chokepoint.name | mapData.ts §1.5 CHOKEPOINTS | (玩家几乎不见)| — |

---

## § 8. 反向英文化 procedure（中→英 给 Discord 群测试）

### Step-by-step

1. **打开** `packages/shared/src/scenario/elAlamein/mapData.ts`
2. **按 § 1.1 - § 1.5 table 反向操作**:
   - 把 `name` 字段从中文改回英文
   - **保留 tags**（中文 alias 留着也无妨，反正只是 fuzzy match 兜底）
3. **不改任何其他文件**:
   - ai.ts prompt examples 一直是英文（如果按方案 A 没改过）
   - rendererCanvas / GameCanvas / reportSignals / intelDigest 全 dynamic
4. **typecheck + build + grep verify**:
   ```bash
   npm run typecheck
   npm run build
   # 验证英文 name 在 bundle:
   grep "Kidney Ridge\|Coastal Forward Post" apps/web/dist/assets/*.js
   ```
5. **不需要重启 server**（数据是 client 端 bundle）
6. **浏览器 hard refresh** + 点 "再来一局" 重新初始化 state

### 反向 commit 模板

```bash
git add packages/shared/src/scenario/elAlamein/mapData.ts
git commit -m "i18n: revert El Alamein facility/region/front/route names to English for Discord playtest"
# 不打 tag — 这只是 playtest 临时切换
```

### 反向时间预估

- 改 mapData.ts: **5-10 分钟**（19 facility + 12 region + 2 chokepoint + 5 front + 5 route = 43 项，每个 name 一行）
- typecheck + build + verify: **2 分钟**
- 总计: **~15 分钟一次性切换**

---

## § 8.5 反向 mapping quick reference (中→英 43 项)

> **下一个 claude code 窗口反向时直接按这张表操作**。每一行 = 一个 `name` 改动：把 mapData.ts 里 `name: "当前中文 name"` 改成 `name: "反向英文 name"`。tags 不动（中英 alias 仍然 work，fuzzy match 兜底）。

### Facilities (19)

| id | 当前中文 name | 反向英文 name |
|---|---|---|
| `ea_player_coastal_post` | 北线前哨 | `Coastal Forward Post` |
| `ea_player_central_post` | 中央前哨 | `Central Desert Forward Post` |
| `ea_player_south_post` | 南线前哨 | `Alam Halfa Forward Post` |
| `ea_alamein_town` | 阿拉曼镇 | `El Alamein` |
| `ea_kidney_ridge` | 北部山脊 | `Kidney Ridge Strongpoint` |
| `ea_miteirya_ridge` | 中央山脊 | `Miteirya Ridge Strongpoint` |
| `ea_himeimat` | 南部高地 | `Himeimat Heights` |
| `ea_rommel_hq` | 敌军总部 | `Rommel's HQ` |
| `ea_player_hq` | 我军总部 | `Montgomery's HQ` |
| `ea_player_barracks` | 我军兵营 | `8th Army Barracks` |
| `ea_player_airfield` | 我军机场 | `Desert Air Force Base` |
| `ea_repair_station` | 野战修理厂 | `Field Repair Depot` |
| `ea_fuel_depot` | 前线油库 | `Forward Fuel Dump` |
| `ea_ammo_depot` | 沙漠弹药库 | `Desert Ammo Cache` |
| `ea_comm_tower` | 沿海雷达 | `Tel el Eisa Signal Station` |
| `ea_observation_post` | 中央雷达 | `Ruweisat Observation Post` |
| `ea_axis_barracks` | 敌军德军营房 | `Afrika Korps Barracks` |
| `ea_axis_airfield` | 敌军机场 | `Axis Airfield` |
| `ea_axis_barracks2` | 敌军意军营房 | `Italian Infantry Depot` |

### Regions (12)

| id | 当前中文 name | 反向英文 name |
|---|---|---|
| `british_hq_area` | 我军总部区 | `British HQ Area` |
| `northern_coastal` | 北部沿海 | `Northern Coastal Zone` |
| `tel_el_eisa` | 北沿海高地 | `Tel el Eisa Heights` |
| `kidney_ridge_zone` | 北部山脊区 | `Kidney Ridge` |
| `miteirya_ridge_zone` | 中央山脊区 | `Miteirya Ridge` |
| `minefield_zone` | 魔鬼花园雷区 | `Devil's Gardens (Minefield)` |
| `ruweisat_zone` | 中部山脊 | `Ruweisat Ridge` |
| `central_desert` | 中央沙漠 | `Central Desert` |
| `southern_desert` | 南部沙漠 | `Southern Desert` |
| `alam_halfa_zone` | 南部山脊区 | `Alam el Halfa Ridge` |
| `himeimat_zone` | 南部高地区 | `Himeimat Heights` |
| `axis_rear` | 轴心后方 | `Axis Rear Area (Rommel HQ)` |

### Chokepoints (2)

| id | 当前中文 name | 反向英文 name |
|---|---|---|
| `minefield_gap_north` | 北部雷区缺口 | `Northern Mine Gap` |
| `minefield_gap_center` | 中央雷区缺口 | `Central Mine Gap` |

### Fronts (5)

| id | 当前中文 name | 反向英文 name |
|---|---|---|
| `front_coastal` | 1. 北部战线 | `1. Coastal Sector` |
| `front_ridge` | 2. 山脊战线 | `2. Ridge Line` |
| `front_center` | 3. 中央战线 | `3. Central Desert` |
| `front_south` | 4. 南部战线 | `4. Southern Sector` |
| `front_axis_rear` | 5. 敌军后方 | `5. Axis Rear` |

> 注：保留 `1. 2. 3. 4. 5.` 数字前缀（玩家按数字键 1-5 跳转 camera 的视觉锚点）。

### Routes (5)

| id | 当前中文 name | 反向英文 name |
|---|---|---|
| `via_balbia` | 沿海公路 | `Via Balbia (Coastal Highway)` |
| `desert_track` | 中央沙漠小路 | `Central Desert Track` |
| `southern_pass` | 南部山路 | `Southern Mountain Track` |
| `front_line_road` | 前线公路 | `British Front Line Road` |
| `axis_supply_road` | 敌军补给路 | `Axis Supply Road` |

### 反向完成 checklist

操作完按 § 10 V1-V5 走一遍 verify。重点：
- [ ] `grep -c "localhost:3001" apps/web/dist/assets/*.js` = 0
- [ ] bundle 含所有 43 英文 name (`grep "Kidney Ridge\|Montgomery\|Coastal Forward Post" apps/web/dist/assets/*.js`)
- [ ] hard refresh + 再来一局后地图标签是英文
- [ ] 中文输入仍 work（tags 里仍有中文 alias）

---

## § 9. 不动的东西（**永远 canonical 不改**）

| 类型 | 例子 |
|---|---|
| 所有 ID | `ea_alamein_town` / `front_coastal` / `kidney_ridge_zone` / `via_balbia` |
| Facility schema | position / team / type / hp / strategicEffect / regionId |
| Region schema | bbox / terrainMix / passability / adjacent / facilities[] |
| Front schema | regionIds / playerPower / enemyPower / engagementIntensity / supplyStatus |
| Route schema | waypoints / passableFor / connectedRoutes |
| 引擎代码 | defensiveAI / pressureDirector / autoBehavior / combat / sim / fog / warPhase |
| Shared 类型 | types.ts / squad.ts / intents.ts / schema.ts |
| Server | apps/server/src/index.ts / providers.ts |
| LLM 配置 | LLM_PROFILE 路由 / API key |
| **scenario gate** | `state.scenarioId === "el_alamein"` 不变 |

---

## § 10. 验证 checklist

### V1 — 改完 immediate checks
- [ ] `npm run typecheck` — 4 workspaces 全过
- [ ] `npm run build` — bundle 生成
- [ ] `grep -c "localhost:3001" apps/web/dist/assets/*.js` — 应为 0
- [ ] bundle 含所有新中文 name (`grep "我军总部" apps/web/dist/assets/*.js` 应有 ≥ 1）

### V2 — Hard refresh 浏览器 + 再来一局
- [ ] 地图大区标签 (5 个 front)：北部战线 / 山脊战线 / 中央战线 / 南部战线 / 敌军后方
- [ ] 玩家区 7 个 facility 中文显示：3 前哨 + 我军总部 + 我军兵营 + 我军机场 + 野战修理厂
- [ ] 敌方区 4 个 objective 中文显示：阿拉曼镇 / 北部山脊 / 中央山脊 / 南部高地
- [ ] 后方/补给 facility：油库 / 弹药库 / 通讯站 / 观察哨 / 敌军德军营房 等
- [ ] 路名 5 个：沿海公路 / 中央沙漠小路 / 南部山路 / 前线公路 / 敌军补给路

### V3 — LLM 链路 (Chen / Marcus)
- [ ] 触发 UNDER_ATTACK 事件（强行让一个前哨被打）→ 看 Chen brief 用中文 name 描述
- [ ] 玩家说中文 "推中央山脊" → LLM 解析为 ea_miteirya_ridge → 派兵正确
- [ ] 玩家说英文 "Push Kidney Ridge" → LLM 解析为 ea_kidney_ridge → 派兵正确（验证 tags fallback）
- [ ] Marcus 引用 facility 列表时用新中文 name

### V4 — STT (中文语音) 实测
- [ ] 玩家说"推阿拉曼镇" → STT 输出"推阿拉曼镇" → resolve 正确
- [ ] 玩家说"派兵去北部山脊" → STT 输出"派兵去北部山脊" → resolve 正确
- [ ] 玩家说"守住南线前哨" → STT 输出"守住南线前哨" → resolve 正确
- [ ] 玩家说"占领野战修理厂" → STT 输出"占领野战修理厂" → resolve 正确

### V5 — 反向英文化也 work
- [ ] 按 § 8 反向操作后，hard refresh，所有 facility / front / route 显示英文
- [ ] Chen brief 用英文 name
- [ ] 中文输入仍可解析（tags 保留中文 alias）

---

## § 11. V5 实施 plan

### Step 1: 11 个 facility 中文化 + tags（§ 1.1）
**改动**: mapData.ts FACILITIES 数组，~22 行（11 个 facility × 2 行 name+tags）

### Step 2: 12 个 region 中文化（§ 1.2）
**改动**: mapData.ts REGIONS 数组，~12 行（每个 region 1 行 name）

### Step 3: 5 个 front 中文化（§ 1.3）
**改动**: mapData.ts FRONTS 数组，~5 行

### Step 4: 5 个 route 中文化（§ 1.4）
**改动**: mapData.ts ROUTES 数组，~5 行

### Step 5: 2 个 chokepoint 中文化（§ 1.5）
**改动**: mapData.ts CHOKEPOINTS 数组，~2 行

### Step 6: typecheck + build + bundle grep（§ 10 V1）
### Step 7: hard refresh playtest（§ 10 V2-V4）
### Step 8: commit + push + tag

**总改动**: ~50-60 行，**单文件 mapData.ts**。其他文件 0 改动。

---

## § 12. 总结

**这次中文化的核心保护点**：

1. ✅ **单文件改动** — 只动 `mapData.ts`，引擎 / UI 渲染 / 消息系统全部 dynamic 自动跟随
2. ✅ **tags 保留双向 alias** — 中英文输入都 work，未来反向只改 `name` 字段
3. ✅ **LLM digest dynamic** — LLM 看到的 name 自动变中文，brief 输出跟着变
4. ⚠️ **LLM prompt examples 半静态** — 选不改（推荐），运行时 LLM 看 digest，example 不影响
5. ✅ **15 分钟反向** — Discord 测试时按 § 8 mapData.ts 改回英文即可
6. ✅ **0 改架构** — 不引入 i18n framework / context / dictionary，scope 严格限于数据 name 字段

**这是真正的 MVP 最稳路线**：用现有 dynamic 渲染 + fuzzy match 架构，单文件 name 切换实现"中英双输入 + 任意 UI 语言"。等真正要做完整 i18n（多语言、菜单文字、UI button、对话 dialog 等）再上 Phase 2 / Phase 3。

---

**End of V5 trace map.**
