# 第 8 级 v2 提案 · 审核（Opus 5 第二遍，2026-08-07）

> **先说一件事**：主仓库根已经有一份 `LEVEL8_V2_OPUS_REVIEW_20260807.md`（mtime 11:37，
> 自称"第三双眼睛"、同样是 Opus 5 写的）。我在动手前把它读了，所以**不能声称盲审**。
> 处理办法：凡它报过的数字，我一律自己重跑重算（家法⑥"谁报的数字另一方必须重算"），
> 下文每个数字都是我这次实跑出来的；凡我复算与它不一致、或它没查到的，单独标出。
> 结论：**它的实证部分我全部复现，无一处推翻**；本档新增 8 处它和 v2 都没有的发现，
> 其中两处会改变刀3 的验收判据。
>
> 家法遵守：主仓库工作区**零改动**（`git status` 与开工前逐项相同；探针与 harness 全在
> scratchpad，用内存改图跑真台架，一个仓库字节没动）。基线 main = `d5eb32e`。
> 材料：ROADMAP 全文 / LEDGER 全量账本 / v2 / v1（背景）/ 逐条 file:line 亲翻代码。

---

## 0. 一句话结论

**五刀的病灶诊断全部属实，引用的代码结构全部对得上（无一处需要"停下来报告"，行号有
±2 漂移，逐条列在 §6）。方向可施工。但按 v2 推荐表原样落地会当场破红线四**：
`ab-approval-v4 --synthetic` 从 **161 PASS / 0 FAIL** 变成 **151 / 10**，
且**负对照会静默掉 5 颗 ★ 牙而台架照打"NEGCTL OK"**——这一条 v2 与前一份审核都没测。

修 4 个 fixture 常数之后 --synthetic 只剩 **1 条真红（TF10）**，负对照只剩 **1 颗牙没了
（也是 TF10）**。所以刀3 的实际交付量是清楚的：**4 处重钉 + 1 条合同要重新造 fixture +
1 颗"绿着的错"的牙（T1j，两种模式都不报）**。

### 开工前必须落定的 8 件事（每件下面都有实证）

| # | 事项 | 归属 | 性质 |
|---|---|---|---|
| 1 | 推荐表仍剩 1 处跨战线重叠（miteirya × central_desert_w，[210,80,229,80]） | 刀3 | 新台架断言①提交当天即红 |
| 2 | 推荐表让 **2356 格**失去战线归属，其中 **1925 格是 x316-490×y45-55 整块**；开局玩家 2 名步兵掉出北线 | 刀3 | v2 只登记了"≤5 行薄缝"，与事实不符 |
| 3 | **负对照静默掉牙**：negctl 下 ★T1w/★T1w3/★TF10/★T2d/★T2e/★T3i 六条由真红变绿，台架仍打 "NEGCTL OK"（条数没钉死） | 刀3 | 验收判据不成立，必须改成逐条 diff |
| 4 | **T1j 的牙静默死掉**：`ab-approval-v4.ts:168` 硬编码的西头驻军 (130,90) 掉出 front_center，--synthetic 与 --negctl **都不报**——而 T1j 正是 §C"显式登记"引用的那条先例 | 刀3 | "绿着的错"，最危险的一类 |
| 5 | **TF10 不是重钉坐标能救**：切完之后 front_center **一个敌方设施都没有**（意军营房唯一归敌后），第4档合同在这条线上失去 fixture | 刀3 | 要造合成设施或换线，属刀3 交付物 |
| 6 | 设施危机的候选池：`buildReinforceOptions(state, front)` **按定义排除该战线内部全部单位**；且 `mintEscalationTickets(state, front: Front)` **不收 null、锚点写死 `battleAnchorFor`（＝该线最大交火簇）** | 刀1 | 不裁则刀1 落地后票面 ETA 仍量在别处，手测那笔账只治一半 |
| 7 | `/api/log-event` 按字段解构，新字段静默丢弃（**今天已经在丢 `stake`**）；`logEvent` 只 `console.log`，无落盘 | 刀5 | 记录仪装了也攒不到数据 |
| 8 | 刀5 的"信封 sha 逐字节不变"**没有任何台架跑得到**（13 个台架无一执行 web 层，只把它当源码文本读） | 刀5 | 验收判据不可执行，需换成纯度断言 |

---

## 1. 方法（可复算）

- **机器复算**：独立脚本读**生产** `EL_ALAMEIN_REGIONS/FRONTS/FACILITIES`，判定逐字用
  `isInsideFront`（frontDestination.ts:109-117，闭区间 `>=`/`<=`）的同一式子，重算全部两两对。
- **真台架实跑**：scratchpad 里一个 harness，把 v2 推荐表**灌进 module 级数组**再
  `import()` 真台架，仓库零改动。
  ★ 关键前提我先验过：`node_modules` 软链进 scratchpad 后，`@ai-commander/shared` 与绝对路径
  指向**同一个 module 实例**（`A === B` 实测 true），所以内存改图确实生效——先做了这一步
  `base` 对照跑（161/0，与直跑逐字节相同），再跑变体，避免"假绿"。
- **判据家法**：会动兵的数 `assignedUnitIds` + 核落点（台架自带）；front 归属、playerPower、
  frontCenterPos、nearestPlaceWithin 全部跑生产函数取数，不读注释不读措辞。

---

## 2. 刀3 · 战线矩形消重叠

### (a) 病灶 file:line 与代码是否相符 —— **完全相符**

- **13 对跨战线重叠：我的独立复算与 v2 表逐对逐坐标一致**（全表见 §7 附录）。
  v2 写成「y=55 线 x210-260」的三对，机器算出的交叠框是 `[210,55,260,55]` / `[210,80,260,80]` /
  `[200,140,370,140]`——同一件事，零对错位。
- 设施级 4 处病理全部复现：`ea_kidney_ridge`(220,55) 双认领 coastal+ridge；
  `ea_observation_post`(250,100) 双认领 ridge+center（确实同时被 3 个 region 圈住）；
  `ea_axis_barracks2`(120,140) 双认领 center+axis_rear；
  `ea_ammo_depot`(260,150) `regionId=central_desert` 而几何在 `southern_desert`（R4 属实）。
- 「生产代码零硬编码 region id」属实：全仓 grep 只命中 `defensiveAI.ts` 的 `front_axis_rear`
  （front id，不是 region id）+ 台架注释。
- R4 的机制前提属实：`director.ts:622-626` 的 `frontIdForRegion(state, f.regionId)` 正是
  FACILITY_CONTESTED / CAPTURE_STALLED / FACILITY_LOST 的归线路径。
- R2 的物理动机属实：`terrainGen.ts:112 fill(255, 42, 308, 118, "swamp")`——画出来的雷区是
  **x255-308 × y42-118**，确实纵跨三条战线的纬度。
- **双计病灶是真的（我另做的实证）**：一个玩家步兵钉在 (250,100)，`buildDigest` 后
  `front_ridge.playerPower` 与 `front_center.playerPower` 各记一次；开局全图 **7525 个整数格
  被两条以上战线认领**，**14 个敌方单位被双计**。

### (b) 修法可施工性 —— **可施工，但推荐表有三处漏，且有两份真相源没被点名**

1. **没消完**：`miteirya_ridge_zone [210,55,260,80]` × 新 `central_desert_w [181,80,229,137]`
   在 **[210,80,229,80]**（y=80 那一行，20 格）仍相交。新台架断言①提交当天就红。
2. **无主地不是"≤5 行窄条"**：整数格逐点比对，推荐表让 **2356 格**失去全部战线归属，其中
   **1925 格 = x316-490 × y45-55 的整块**（11 行 × 175 列）——北线南缘收到 44、而 x>315 没有
   任何新矩形接手。实测后果：开局玩家步兵 **#61 (399,55)、#62 (401,55)** 从 `front_coastal`
   掉进"无战线"（北线玩家单位 **10 → 8**）。这块正是 HQ 往北线增援的必经走廊。
3. **薄缝里有兵**：v2 已登记的 `x248-260 × y81-84` 缝里，开局就坐着敌军主战坦克
   **#153 (252,82)**——修后它从 `front_center` 的敌军实力里整个消失（今天是被计入的）。
   R5「允许无主薄缝」的裁定请带着这条证据复裁。
4. **中央战线开局连一个敌人都没有了**：切完之后 `front_center` 的敌方单位
   **14 → 0**、敌方设施 **1 → 0**（意军营房唯一归敌后）。中央战线开局 enemyPower=0、
   无敌方设施——这比"重叠带双计消失"是更大的语义变化，必须进登记和手测看点。
5. **第三份真相源**：`region.facilities[]` 独立于 `facility.regionId` 与几何，
   `enemyAI.frontHasFacility`（enemyAI.ts:185-195）在读它；它**今天已经陈旧 3 条**
   （三个玩家前哨 `ea_player_coastal_post/central_post/south_post` 不在任何 region 的清单里）。
   R4 改 `ea_ammo_depot` 必须两处同改，新拆三块也要定清单归属，否则本刀"收敛一处、放大一处"。
6. **第四份没被点名的承重面：`getRegionCenter`（tacticalPlanner.ts:1712-1730）在执行链上**。
   它返回 **region bbox 的中心**，被 `resolveTarget`（:1355-1358）消费：
   `intent.targetRegion` → tag → **getRegionCenter** → 落点。
   拆表后「中央沙漠」作为**目的地**从 **(245,110) 移到 (323,108.5)，东移 78 格**。
   这是**会动兵**的后果，v2 的连带面只写了 frontCenterPos 与"各梯子最后一档"，没写这一条。
   同一份 lookup 还被 tacticalPlanner:256-270 镜像用于**回执措辞**。
   而且它是 `id/name` 的 **fuzzy includes、首个命中即返回**——新区块起什么名字会直接决定
   模糊命中落到谁头上（R11 因此不是纯装饰，它在派兵路径上）。
7. **雷区的名字会和画出来的雷分家**：painted swamp 是 x255-308 × y42-118；v2 拆出的
   `minefield_zone_n [261,45,315,84]` + `minefield_zone [276,85,315,125]` 合起来盖不住
   **约 1100 格真实雷区**（x255-260 整条、x261-275×y85-118、y42-44 一条），这些格子会落进
   kidney/miteirya/ruweisat（山脊）与无主缝。**玩法无影响**（见下），但屏上地名与叙事会错位。
8. **一条"没有风险"的结论（我查过，值得写下来省得后面有人担心）**：
   `region.passability` 与 `region.terrainMix` **全仓无人读取**——移动/寻路走
   `state.terrain[][]`（movementRules.ts:29）。所以拆 region **对通行性、寻路、装甲能不能过雷区
   零影响**。
9. 其余 bbox 消费面（都随之继承，v2 只说了"17 个文件"没点名的两处）：
   `missions.tickDestroy`（missions.ts:157）用 region bbox 当歼灭任务的判定区；
   `doctrine.ts:37` 用 region id 匹配条令作用域。

**可修性已验证**：加一块 `northern_coastal_e [316,45,490,55]` 归北线 + `central_desert_w`
起始行 80→81，实测**跨战线重叠 0**、**无主格 2356 → 460**（最大一块是 y138-139 两行，
以及 x230-260×y81-84 那条 5 行缝仍在）。

### (c) 验收（含负对照）—— **"13 台架全绿"目前不成立；且负对照会静默掉牙**

我把推荐表灌进真台架跑了全部 13 个（默认/synthetic 模式），并与 base 逐字节 diff：

| 台架 | 基线 | 推荐表 |
|---|---|---|
| **ab-approval-v4 --synthetic** | 161 PASS / 0 FAIL | **151 / 10** |
| 其余 12 个 | 全绿 | **全绿，且 stdout 逐字节相同** |

10 条 FAIL 逐条（★＝上一级登记在案的合同断言，我数下来是 **6 条带 ★**，不是 5 条）：

| 断言 | 根因 | 属于 |
|---|---|---|
| T1a 前置 front_center 几何中心 ==(263,96) | 实得 (273,103) | fixture 重钉 + 登记 |
| T1w0 前置 / ★T1w-neg / ★T1w3 | `WEST_CLUSTER (130,90)` 掉出 front_center → 撤退档 fixture 塌，实测撤退**落在交火点上**（d=0.0） | 重钉 (130,90)→(185,90)；`T1j` 里写死的 `130.5` 同改 |
| **★TF10** | front_center **无任何敌方设施** | ✗ 重钉救不了，见下 |
| T2b 前置 / ★T2d / ★T2e / T2l / ★T3i | `STRADDLE_INSIDE (360,138)` 出线（新南缘 137），"同名不同成员"的坑不成立 | 重钉 (360,138)→(360,135)、(360,143)→(360,140) |

**我实跑了"实施者会做的那次重钉"**（改 4 个常数：T1a 期望值、WEST_CLUSTER、
STRADDLE_INSIDE/OUTSIDE）→ **160 PASS / 1 FAIL，只剩 TF10**。所以：
**TF10 是唯一需要合同级返工的一条**，其余是登记得清清楚楚的 fixture 重钉。

#### ★ 两条 v2 与前一份审核都没测到的

**(1) 负对照静默掉 5 颗牙。** `--negctl` 基线 **48 条 ★ 真 FAIL**；推荐表下 **47 条**。
只看条数像是"少一条"，逐条 diff 才看得见发生了什么：

- 由真红**变绿**（牙掉了）：★T1w、★T1w3、★TF10、★T2d、★T2e、★T3i —— **6 条**
- 由绿**变红**（前置/负对照塌了）：T1a、T1w-neg、T2b、T2l —— 4 条

而 `ab-approval-v4.ts:2013-2018` 的收口逻辑是 `failCount > 0 → "NEGCTL OK"`——**条数没钉死**。
也就是说实施者跑标准套件会看到"13 台架全绿 + NEGCTL OK"，**6 颗牙掉了一声不响**。
重钉之后再跑 negctl：47 条，唯一还缺的牙仍是 TF10。
⇒ **刀3 的负对照验收判据必须改成"逐条比对 ★ 断言的红/绿集合"，并把 48 这个数钉进台架**。

**(2) T1j 的牙静默死掉，两种模式都不报。** `scenarioKnife1` 里另有一处硬编码西头驻军
`ab-approval-v4.ts:168 addUnit(state, 130 + i, 90)`（注释自陈用途："Tier 2 of the fallback
must not let these drag the anchor west"）。推荐表下 (130,90)/(131,90) **掉出 front_center**
（实测归 front_axis_rear），于是 `battleAnchorFor` 只剩东头一簇——
"取最大簇"与"取全体平均"**在只有一簇时答案相同**，T1j 从此测不出任何东西。
它不红，是因为 negctl 的修复前期望 `meanOfAllX` 是**写死的常数 284.5**，而不是从 state 重算的。
**T1j 正是 §C 全表引用的"显式登记"先例**——本刀不能让它变成同义反复。
（这一条与上面的 WEST_CLUSTER 是**不同的两个坐标**：:187 会红，:168 不会。）

**(3) 一条要写死进开工令的更正**：v2 预告
`ab-retreat-semantics 五条字节快照…会漂，逐条核对并按合同刷新`——**实测五条一字未漂，
整个 stdout 与基线逐字节相同**。**谁都不许"按预期"去刷新它们**；真漂了才是回归信号。

**负对照可跑**：新台架 `--negctl`（任一新 bbox 改回旧值 → 断言①/③必红）机制上成立——
旧表下断言①必然红，因为 13 对重叠是真的（我用同一 harness 反向验证过）。

### (d) 连带面 —— v2 列了 17 个文件，**漏 5 处，其中 3 处玩家看得见**

1. **`nearestPlaceWithin` 读 `frontCenterPos`**（frontEscalationPayload.ts:218-232 扫完设施再扫
   **战线中心**）。实测：front_center 中心 (263,96)→(273,103)、front_coastal (294,38)→(294,34)；
   `nearestPlaceWithin(263,96)` 从 **"3. 中央战线" 变成 null**——**一个今天叫得出名的位置，
   修后叫不出名了**。影响面＝候选 label、SQUADS `loc=`、preflight 的"来源地"话术。
   （所以刀3 与刀4 的手测最好合并做一次。）
2. **`getRegionCenter` 在派兵路径上**（见 (b)-6，东移 78 格）。
3. **地图上会多出标签**：`renderRegionLabels`（rendererCanvas.ts:1133-1157，GameCanvas.tsx:2207
   传的是全量 regions）**给每个 region 在其 bbox 中心画名字**（zoom ≤0.9 时）。拆区后玩家会看到
   **3 个新地名标签**，"中央沙漠""魔鬼花园雷区"两个旧标签**移位**。按家法这属于"影响手感的
   可见变更，先给三行人话确认"，而且新区块**必须先起名字**（v2 的表只给了 id）。
4. `missions.tickDestroy` / `doctrine.ts:37`（见 (b)-9）。
5. `region.facilities[]`（见 (b)-5）。

---

## 3. 刀4 · tag 进就近地标

### (a) 相符（行号误差 ≤2）

`nearestPlaceWithin` frontEscalationPayload.ts:218-232 只扫设施+战线中心 ✓；
`Tag` 类型 types.ts:465-470 ✓；`placeNameAt` tag 优先 commanderPresence.ts:439-447 ✓；
`NAME_RADIUS_TILES = 12` 唯一定义在 frontEscalationPayload.ts:51 ✓；
`buildReinforceOptions` 签名 :311-321 ✓；label 拼装 :375-394 无同名去重 ✓（N1 属实，
且**只有罗盘分支**有 第一/第二 去重，地名短语分支没有）。

### (b) 可施工。两个开口

1. **tag 只按 id 解析，名字回不去**。`normalizeIntentLocations`（tacticalPlanner.ts:143）与
   `resolveTarget`（:1357）判 tag 都是 `state.tags.find(t => t.id === value)`——**只认 `tag_1`，
   不认名字**；`getRegionCenter` 的模糊 includes 只覆盖 region 与 facility，不覆盖 tag。
   刀4 让信封开始印 tag **名字**，模型把名字写回 `targetRegion` 就解析不到——
   **与刀2 自己发现的「嘴上念 G2 → `fromSquad="临时编队G2"` 解析不到」完全同形，刀2 补了闭环、
   刀4 没补**。缓解项是真的存在：`ai.ts:305` 明写 "Use targetRegion for matched tag id
   (e.g. tag_1)"，`digest.ts:205-213` 的 `---TAGS---` 同时印 `tag_1:"名字" @(x,y)`。
   所以这不是必炸，是**必须验的**：要么同刀补 id-or-name 归一（原则＝"引擎自己印出去的名字，
   引擎必须认得回来"，不是地名同义词表，红线二不违），要么留一条活体负对照证明 id 映射够用。
2. **别名等价性的措辞要收窄**。现 `placeNameAt` 取最近 tag 用严格 `<`，**并列时先入数组者赢**；
   v2 写"tie-break 按 tag id 序"是**语义变更**，而 `Tag.id` 是字符串（`tag_10 < tag_2`）。
   → 负对照③"PLAYER_VIEW 逐字节同"只在无并列 tag 时成立，要么改成"沿用现有先入者赢"，
   要么把 tie-break 变更登记进 §C。

### (c) 验收可跑。补一条**闭环断言**：tag 名进 label 之后，下一句「把制高点旁边那群调过来」
仍解析到 `tag_1` 并数得出 `assignedUnitIds`——不是只断言 label 文本对。
v2 写的三条负对照（无 tag 字节不变 / 半径外不变 / PLAYER_VIEW 别名等价）都成立且可跑。

### (d) 连带面列全了；补一句：`placeNameAt` 塌缩成别名后，**tag 名字会出现在 preflight 台词的
"来源地"里**（commandPreflight.ts 走的就是 `nearestPlaceWithin`）——是好事，但属于玩家看得见的
措辞变化，写进手测看点。

---

## 4. 刀2 · 番号印到部队名紧邻处

### (a) 相符，逐字命中

`handleOf` commanderPresence.ts:153-158（返回 ` handle=${g}`，行尾 token）✓、
:198/:204/:234/:243 四处拼装 ✓、JUDGMENT 节头 :257-264 ✓、
`groupLine` battleBoard.ts:133-136 + 铸号 :156 ✓、`ticketPromptLine` escalationTicket.ts:324-327 ✓、
`isTicketRef` :252-254（`/^G\d+$/i`）✓、`lookupEscalationTicket` :242-243（`trim().toUpperCase()`）✓、
`isKnownForceRef` :279-294（第 289 行走 `isTicketRef`）✓、
digest.ts:311「用行末的 handle=G#」✓、ai.ts:82（合同⑤）/ :275（解析器 prompt）/ :720
（CHANNEL_PERSONA.combat 合同副本）✓、TB6 ab-approval-v4.ts:1117 ✓。

### (b) 可施工。三点补充

1. **台架依赖点不止 TB6**：`ab-approval-v4` 有 **10 行**读 `handle=` 字面——
   :1117/:1118（纯度）、:1128（`match(/handle=(G\d+)/)` 取号）、:1139、:1180/:1181（正例+负对照）、
   :1187/:1188（节头文本 `includes("handle=G#")`）、:1365（板子行取号）、:1381（板子纯度）。
   另有 :829 `/^G\d+$/`、:907-908 `/G\d+/`。全部要随格式改，且**不许用"放宽断言"的方式变绿**。
2. **`ab-g-knife --sites` 会红，红在指纹不在登记表**——但比前一份审核说的更精细。
   `RULE_FINGERPRINTS.handle_addressing`（ab-g-knife.ts:1021-1026）是**四条备选**：
   `/handle=G#/`、`/group labels are NOT valid fromSquad/i`、`/LABEL is NOT a valid fromSquad/i`、
   `/a force handle — a G-number/i`。断言 C 逐面比"实测规则集合 == 登记集合"，所以：
   - `UNASSIGNED_HEADER`（digest.ts:311）与 `ai.ts:275` 各自还有**另一条备选能命中** → 不红；
   - `FRONT_JUDGMENT_HEADER`（commanderPresence.ts:263）、`ai.ts:82`、`ai.ts:720` **只靠
     `handle=G#` 命中** → 这三面的规则集合会漂 → **断言 C 红**。
   ⇒ 要改的是**指纹**（规则的新写法），登记表条目本身不用动；v2 写成"两张登记表同步"指错了地方。
   （此条是源码级推演，我没实跑——实施时改完一跑即知，成本极低。）
3. **硬约束（建议写进开工令）**：号只能进**行的拼装**，**绝不许拼进 `option.label` 或
   `ticket.label`**。实证：`ab-front-escalation` 三条断言是
   `labelC.endsWith("未编组群")`、`/第[一二三四五六七八九十]未编组群$/`、
   `/第11未编组群$/`（:337/:352/:369 一带）；且 `ticket.label` 会进回执，污染后回执里番号双打印。

### (c) 验收可跑。容错断言注意 `lookupEscalationTicket` 已 `trim().toUpperCase()`（:243），
前缀剥离要与它同源；`isKnownForceRef`（:279-294）也走 `isTicketRef`，两处同改才闭环。
番号命令走 ChatPanel 同一条路——G 刀教训已写进 v2 ✓。

### (d) 连带面基本列全。补一条登记项：**9/131 的贴错率基线是在旧措辞上量的**，本刀同时改了
线上格式与 prompt 里的格式指称，那个数字不能直接沿用作对比基线（不卡合并，登记即可）。

---

## 5. 刀1 · 危机票据带设施名

### (a) 全部相符（这一刀引用最多，逐条翻过）

`EVENT_CHANNEL_MAP` GameCanvas.tsx:110-111（两条旧裁定的注释就写在这两行上）✓、
facFacts 分支 :428-429 ✓、
**:475 `const withTickets = facFacts ? null : buildFrontEscalationWithTickets(state, crisis);`
逐字一致**——"设施族一张票都不铸"属实 ✓、log-event 先例 :501-513 ✓；
`detectFacilityContested` reportSignals.ts:263-279 且 **:265 `if (f.team !== "player") return;`**
（R1 的精度修订完全正确，行号 263→265 小漂）✓；`CAPTURE_STALLED` emit :356 ✓，检测器对**非我方
设施**才跑 → R1 说"打敌方 VP 的停滞照旧归 Marcus"是实集 ✓；
`buildFrontEscalationWithTickets` escalationTicket.ts:219-234 ✓、
`ticketDestinationVerdict` :478-512、retreat 档 :503、`injectTargetRegion` :504-506 ✓；
`resolveTarget` 里 `targetFacility` 优先级 tacticalPlanner.ts:1349-1352 ✓、
`findFacilityPosition` :1734-1748 ✓；ChatPanel `wroteDestination` :1939 ✓、注入点 :1971 ✓、
ticketLine 进 ACTIVE_ESCALATION :1332 ✓；
`facilityContestWorthAsking` director.ts:843-855（`PROGRESS_ASK_THRESHOLD = 0.34` :741）✓、
`idle_reinforcement_available` :795 ✓；
**`commandAuthority.ts:92-93` 实证**：开局 `commanderDispatchPool` **chen=74 / marcus=0 / emily=0**
——"ops 频道派单被拦死"是真的，R1 的立论成立。
模块方向不成环：`escalationTicket.ts:37` 已经 `import { frontEscalationFacts } from "./director"`，
取 `facilityEscalationFacts`（director.ts:800）/ `buildFacilityEscalationPayload`（:780）同向 ✓。

### (b) 可施工。**但有两个承重问题，第二个 v2 与前一份审核都没提**

1. **候选池按定义排除该战线内部的全部单位**（frontEscalationPayload.ts:311-321 起的
   `outsideFront` 过滤，注释写明"里面的人已经投入了，他们就是 survival/ratio 描述的对象"；
   :349 与 :364 各用一次）。这条口径对**战线危机**成立，对**设施危机不成立**：北线前哨挨打时，
   最该派的往往正是同在北部战线、但在别处闲着的那坨人——手测那局的原话就是「援兵去了战线别处」。
   照 v2 现在的写法（`front = 设施所属战线` + anchorOverride），那坨人**不会拿到号**。
2. **★ 锚点也得跟着换，而 mint 这一侧收不下**：
   `mintEscalationTickets(state, front: Front, precomputed?)`（escalationTicket.ts:113-133）
   **front 是必填非空**，且票面锚点写死 `const anchor = battleAnchorFor(state, front)`（:126），
   而 `battleAnchorFor` = `frontDestinationFor(state, front, "approach")`（crisisResponse.ts:75-77）
   ＝**"这条线上打得最凶的那处"**——正是"援兵去了战线别处"的那个点。
   v2 只说给 `buildReinforceOptions` 加 anchorOverride；**payload 的 ETA 会被修好，冻在票上的
   `ticket.anchor` / `ticket.etaSec` 仍量到别处**（`anchor` 字段的注释自陈是 ETA 的
   READ-ONLY provenance）。⇒ anchorOverride 必须**同时穿过 mint**，否则刀1 只治一半，
   而且票面与 payload 会出现两个 ETA 来源——正是 v4 刀1 当初要消灭的形状。
3. 工程陷阱：`CANDIDATE_FACES`（ab-approval-v4.ts:1664-1683）**按"文件内第 n 次出现"**登记
   候选出口（表里自陈"故意不用行号当键"）。刀1 在 `escalationTicket.ts` 新增一处
   `buildReinforceOptions(` 调用——若插在现有两处之前，`nth:1/nth:2` 的语义整体错位，
   两条 policy 注释会挂到错的调用点上。必须同 commit 更新该表并给新面标 policy。

### (c) 验收可跑（正例走生产路径、数 assignedUnitIds、核落点==设施坐标——判据是对的）。三点补：

1. **R1 通过后的频道账**：`questionBudget` 是全频道共享的（GameCanvas.tsx:217-234
   `anyQuestionOccupied` 扫三个频道），而 `escalationState.inFlight` 是**按频道**的。
   前哨问句改喊 combat 后会占住 combat 的 inFlight，可能压住同一时刻的**战线**升级问句——
   这正是 2026-07-29 旧裁定的原始担忧方向。手测看点加一条"前哨危机在场时战线升级还出不出得来"。
2. **R1 的分档只覆盖 3 个 keypoint**（`friendlyKeypoints` =
   `ea_player_coastal_post / central_post / south_post`，core/scenario/elAlamein/index.ts:150-154）。
   我军**总部/兵营/机场/修理厂**被夺时 `FACILITY_CONTESTED` 仍走 ops，同样落在"答不了『派』"的
   频道。要不要一并分档，请裁。
3. **N2 布尔与新候选行同屏打架**：`idle_reinforcement_available`（director.ts:795）是
   "全图任一 idle 即 true"，而票据行走诚实闸（可能滤空）。刀1 上线后同一条升级里可能出现
   "布尔说有、候选行说没有"。建议收口前至少加一条"两者不矛盾"的断言，或明确接受。

### (d) 连带面列全了 ✓（前线族票据/TTL/burn/receipt/§8 梯子零改动、ops 人格闸不动）。

---

## 6. 刀5 · 校准记录仪

### (a) 相符

`state.diagnostics` 50 条环 + shift：sim.ts:39-40 ✓；`diagsBefore` 与 `applyOrders` 同一同步块
ChatPanel.tsx:2040-2041、PRODUCE_FAIL/TRADE_FAIL 差集读取 :2092-2093 ✓（代码注释自陈
"Object-identity diff is robust to the ring buffer"，与 v2 的精确论证一致）；
`V4_BARE_CONFIRM_EXEC` :2080（v2 写 2078，小漂）✓；`/api/log-event` apps/server/src/index.ts:162 ✓；
GameCanvas log-event 先例 :501-513 ✓；proactive 评估节拍 :1848-1856 ✓；
`snapshotForDirector` director.ts:861（caller-owned 先例）✓；`burnEscalationTicket` :297 ✓。
**"改走 log-event 不走 diagnostics" 的判断正确。**

### (b) 两个硬开口（第一个我找到了今天就在发生的实证）

1. **服务端按字段解构，新字段静默丢弃**：
   `app.post("/api/log-event")` 是
   `const { type, actionId, channel, frontId, kind, message, sessionId } = req.body ?? {}`。
   ★ **今天已经在丢字段**：GameCanvas.tsx:501-513 的 body 里带着 `stake: logStake`，
   而解构清单里没有 `stake`——它发出去就没了。这不是理论风险，是现行行为。
   survival/ratio/eta/G号/facilityId 会走同一条路消失。必须同刀改服务端。
2. **没有"落盘"**：`logEvent` 只是 `console.log("[EVENT] " + JSON.stringify(...))`
   （index.ts:75-77），`.claude/start-*.sh` 全部 `exec npm run dev`，无重定向、无文件。
   "第 9/10 级读 JSONL"今天不成立。要么本刀加一条真持久化（追加 JSONL），要么明确写成
   "由用户捕获 stdout"，别让样本攒在一个会被关掉的终端里。

### (c) **"信封 sha 逐字节不变"这条硬线没有台架跑得到**——我核过：13 个台架里只有 4 个提到
web 层（ab-approval-v4 / ab-capture-stall / ab-front-escalation / ab-retreat-semantics），
而且**全部是 `readFileSync` 把它当源码文本读**，没有一个执行 GameCanvas/ChatPanel
（这正是 LEDGER H1 记的结构盲区）。可执行的等价硬线建议改成 **TB6 式纯度断言**：
记录仪路径**零铸号**（G 计数器前后相同）、**零 diagnostics 新增**、
`calibrationSnapshot/calibrationOutcomes` 对 state 只读。特别要防的是取"top 候选 etaSec"时
误走带 minter 的路径——那会让 G 号凭空增长，信封当场变。
其余验收（泵帧局产出配对样本、字段够算偏差倍数、双方可独立重算）可跑 ✓。

### (d) 连带面：采样频率 8 秒一次（`PROACTIVE_EVAL_INTERVAL_SEC`），延迟铁律无虞 ✓；
`burnedAt` 是内存字段，注意任何把 ticket 序列化出去的面（回执/日志）不得把它带进玩家可见文本。

---

## 7. 四条红线自查

| 红线 | 判定 |
|---|---|
| 不打补丁（收敛唯一真相源） | 刀3/刀4 方向正确 ✓；**但刀3 若不同时处理 `region.facilities[]`（第三份，今天已陈旧 3 条），等于收敛一处放大一处**——建议纳入新台架断言④ |
| 不穷举（语义原则） | ✓ 全刀无关键词表。刀2 的前缀剥离、刀4 若做 tag 名字归一，都是"引擎认得回自己印出去的东西"，不是同义词表 |
| 不套模板（禁例句） | ✓ 无新增例句；刀2 改 ai.ts 三处**只许改格式指称**这条要逐字守住 |
| 不破坏现有逻辑 | **✗ 当前不成立**：推荐表下 ab-approval-v4 红 10 条（6 条 ★），且负对照静默掉 6 颗牙、T1j 掉牙连红都不掉。把**fixture 重钉 + TF10 的合同覆盖 + T1j 的牙 + negctl 条数钉死**当成**刀3 自己的交付物**处理掉之后，才能宣称"13 台架全绿" |

工程铁律：刀5 sha 硬线判据要换（§6c）；会动兵的验收数 assignedUnitIds ✓（v2 全刀都这么写）；
fixture 走生产路径 ✓。

---

## 8. 请裁（R1-R6 之外新增；R7-R12 与前一份审核编号对齐，R13-R15 是本轮新增）

| # | 问题 | 我的推荐 |
|---|---|---|
| R7 | 北线南缘收到 44 后，x316-490 × y45-55 那 1925 格谁的？ | 补 `northern_coastal_e [316,45,490,55]` 归北线（实测：重叠仍 0，开局两名玩家步兵留在北线） |
| R8 | y=80 那一行（x210-229）归谁？ | `central_desert_w` 从 y81 起（不动上一级刚调过的山脊矩形）；代价是 x181-209 多一行无主 |
| R9 | **设施危机的候选池含不含同线内部的部队？** | 甲案：`front=null` + `anchorOverride=设施坐标`（全图按到设施的 ETA 排）——否则手测那笔账可能仍然不解 |
| R10 | 非 keypoint 的玩家设施（总部/兵营/机场/修理厂）危机要不要也改喊 combat？ | 至少总部要（同样答不了"派"）；其余维持 ops |
| R11 | 新拆三块 region 的**显示名**是什么？`region.facilities[]` 怎么分？ | 先起名——它既画在屏上，又是 `getRegionCenter` 模糊命中的匹配面（在派兵路径上）；`ea_ammo_depot` 的清单条目随 R4 搬到 southern_desert |
| R12 | x230-260 × y81-84 那条 5 行缝（里面有开局敌军主战坦克 #153）救不救？ | 建议救（由 ruweisat 上沿接手，连带调 minefield_zone_n 南缘）；不救就把"该坦克不计入任何战线"写进登记 |
| **R13** | **刀1 的票面锚点**：`mintEscalationTickets` 收不下 null front，锚写死 `battleAnchorFor`＝该线最大交火簇。设施危机的 `ticket.anchor/etaSec` 要不要也换成设施？ | **要**。anchorOverride 必须同时穿过 mint，否则 payload 的 ETA 修好了、票上冻的还是旧点，刀1 只治一半 |
| **R14** | **中央战线开局变空**（敌方单位 14→0、敌方设施 1→0）——接受吗？ | 接受并登记＋写进手测看点（几何上那些兵确实站在山脊三区里）。但 TF10 的合同 fixture 要另造，不能靠这条线 |
| **R15** | **雷区名字与画出来的雷分家**（约 1100 格 painted swamp 落到山脊/无主缝） | 与 R2 一并裁。玩法零影响（region.passability 全仓无人读），纯屏上地名与叙事口径 |

**另有两条不是裁定、是工程要求，建议直接写进开工令**：
- 刀3 的负对照验收改成**逐条比对 ★ 断言红/绿集合**，并把 negctl 的 ★ FAIL 条数（48）**钉进台架**
  （现在 `failCount > 0` 就打 "NEGCTL OK"）。
- `ab-approval-v4.ts:168` 的西头驻军与 :187 的 WEST_CLUSTER **两个坐标都要重钉**，
  且 `T1j` 的 `meanOfAllX` 应改成**从 state 重算**而不是写死 284.5。

---

## 9. 施工顺序意见

维持 v2 的 **刀3 → 刀4 → 刀2 → 刀1 → 刀5**，两点补充：

- 刀3 内部先把表定死（R2/R3/R5 + R7/R8/R11/R12/R14/R15）再动代码；
  **fixture 重钉、TF10 的合同覆盖、T1j 的牙、negctl 条数钉死，四样都属刀3 的交付物**，
  不许推给"后面某一刀"或留成挂账。
- 若刀3 因裁定暂缓，刀4/2/1 可先行（v2 的判断成立）；此时新 fixture 坐标必须避开 §10 表里那
  13 个交叠框——`ab-commander-presence.ts:126-130` 的 `y<45` 先例可直接抄。
- 刀3 与刀4 的手测建议合并做一次（两刀都改"这点叫什么"）。

---

## 10. 新账（查过 LEDGER 全量账本，均无重复；建议随本级收口并进）

| # | 账 | 一句话 | 去向 |
|---|---|---|---|
| O1 | `region.facilities[]` 第三份真相源 | 与 `facility.regionId` 各说各话，今天已陈旧 3 条（三个玩家前哨不在任何清单里）；`enemyAI.frontHasFacility` 在读它 | 并入刀3 审计断言④ |
| O2 | `CANDIDATE_FACES` 按序号登记 | 按"文件内第 n 次出现"锚定，插入新调用点会让 policy 注释静默挂错行（断言仍绿） | 刀1 施工时改成按符号/上下文锚定，或至少注明 |
| O3 | 地图 region 标签跟着 bbox 走 | `renderRegionLabels` 给每个 region 画名字，拆区＝屏上多标签+旧标签移位 | 刀3 手测看点 + R11 |
| **O4** | **negctl 条数没钉死** | `failCount > 0` 即打 "NEGCTL OK"，掉牙不报警——本轮实测 48→47 的背后是 6 掉 4 塌 | 刀3 顺手钉死；其它 ab-* 的 negctl 同病待查 |
| **O5** | **T1j 式"常数化的修复前期望"** | negctl 的 pre-fix 期望写成硬编码数（284.5）而非从 state 重算，fixture 一塌就变同义反复 | 方法资产，写进 bench 家法 |
| **O6** | **`/api/log-event` 今天就在丢 `stake`** | 客户端发、服务端解构清单里没有 → 静默消失 | 刀5 顺手修（或单独一行） |
| **O7** | **`getRegionCenter` 是第四个"地方"的定义** | region bbox 中心，在 `resolveTarget` 执行链上；与 frontCenterPos / frontDestinationFor / nearestPlaceWithin 并列 | 刀3 登记；将来收敛候选 |

---

## 11. 附录 A · 独立复算的 13 对（与 v2 表逐行一致）

```
northern_coastal    × kidney_ridge_zone    [200,45,260,55]  60×10  coastal vs ridge
northern_coastal    × miteirya_ridge_zone  [210,55,260,55]  50×0   coastal vs ridge
northern_coastal    × minefield_zone       [248,38,315,55]  67×17  coastal vs center
tel_el_eisa         × kidney_ridge_zone    [225,45,260,48]  35×3   coastal vs ridge
tel_el_eisa         × minefield_zone       [248,38,260,48]  12×10  coastal vs center
kidney_ridge_zone   × minefield_zone       [248,45,260,75]  12×30  ridge   vs center
miteirya_ridge_zone × minefield_zone       [248,55,260,80]  12×25  ridge   vs center
miteirya_ridge_zone × central_desert       [210,80,260,80]  50×0   ridge   vs center
minefield_zone      × ruweisat_zone        [248,85,275,115] 27×30  center  vs ridge
ruweisat_zone       × central_desert       [230,85,275,115] 45×30  ridge   vs center（整块包含）
central_desert      × southern_desert      [200,140,370,140] 170×0 center  vs south
central_desert      × alam_halfa_zone      [320,138,365,140] 45×2  center  vs south
central_desert      × axis_rear            [120,80,180,140] 60×60  center  vs 敌后
```

## 12. 附录 B · 本轮实跑数据（全部我自己跑的）

```
台架基线（直跑，无 harness）            13 个全绿；ab-approval-v4 --synthetic 161/0，--negctl 113/48
harness base 对照跑                     与直跑逐字节相同（证明 harness 不引入偏差）
v2 推荐表 --synthetic                   ab-approval-v4 151/10；其余 12 个 stdout 逐字节相同
v2 推荐表 --negctl                      114/47；★ 由红变绿 6 条，由绿变红 4 条，仍打 "NEGCTL OK"
v2 + 4 处 fixture 重钉 --synthetic      160/1（只剩 TF10）
v2 + 4 处 fixture 重钉 --negctl         47（唯一缺的牙＝TF10）
跨战线重叠                              旧 13 → v2 推荐表 1 → 加 R7/R8 修补 0
无战线整数格                            v2 推荐表 2356（1925=x316-490×y45-55）→ 加 R7/R8 修补 460
全图被双认领的整数格                    旧 7525 → v2 推荐表 20
开局单位归属                            玩家 front_coastal 10→8（#61/#62 掉出）；
                                        敌军 front_center 14→0；#153 (252,82) 掉进无主缝
frontCenterPos                          front_center (263,96)→(273,103)；front_coastal (294,38)→(294,34)
nearestPlaceWithin(263,96)              "3. 中央战线" → null
getRegionCenter("central_desert")       (245,110) → (323,108.5)（东移 78 格，在 resolveTarget 链上）
commanderDispatchPool（开局）           chen=74 / marcus=0 / emily=0
```

—— Opus 5 审核（第二遍）2026-08-07。探针与 harness 存本会话 scratchpad
（`harness.ts` = 内存改图跑真台架，仓库零改动，建议实施时复用为 negctl 机制）。
