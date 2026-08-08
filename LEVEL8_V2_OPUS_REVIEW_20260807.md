# 第 8 级 v2 提案 · 第三双眼睛审核（Opus 5，2026-08-07）

> 角色：Fable 5 主审+裁定 / Opus 5 实施者，本轮只审核不实施。
> 家法遵守：主仓库工作区**零改动**（`git status` 与开工前逐项相同；所有探针脚本
> 用完即移出仓库，存 `scratchpad/audit-scripts/`）。
> 材料：ROADMAP 全文 / LEDGER 全量账本 / v2 提案 / v1 提案 / 逐条 file:line 亲翻代码。
> 基线：main = `d5eb32e`（= origin/main）。

## 0. 一句话结论

**五刀的病灶诊断全部属实，file:line 全部对得上（无一处需要"停下来报告"）；修法方向可
施工；但推荐的 region 新表按原样落地会当场破坏现有逻辑——`ab-approval-v4 --synthetic`
从 161 PASS/0 FAIL 变成 151 PASS/**10 FAIL**（其中 5 条是上一级登记在案的 ★ 合同断言），
且推荐表自己还剩一处跨战线重叠、并制造了一块 v2 没登记的 1925 格无主地。**
这不是"提案错了"，是"表还差几个数字 + 三条 fixture 属于本刀的交付物而不是别人的账"。
另有刀1 一个承重语义问题（候选池按定义排除同线部队）与刀5 两个硬开口（服务端丢字段、
无落盘）必须在开工前裁掉。

**开工前必须解决的 6 件事**（每件都有下面的实证）：

| # | 事项 | 归属 | 性质 |
|---|---|---|---|
| 1 | 推荐表仍剩 1 处跨战线重叠（miteirya × central_desert_w，y=80 x210-229） | 刀3 | 新台架断言①提交当天即红 |
| 2 | 北线南缘 55→44 造成 **x316-490 × y45-55 = 1925 格无主**，开局玩家 2 名步兵掉出战线 | 刀3 | v2 只登记了"≤5 行薄缝"，与事实不符 |
| 3 | ab-approval-v4 10 条 FAIL（含 TF10：修后 front_center 再无敌方设施，第4档合同**失去 fixture**，不是重钉坐标能救） | 刀3 | 硬线"13 台架全绿"未达成 |
| 4 | 设施危机的候选池：`buildReinforceOptions(state, front)` **按定义排除该战线内所有单位** | 刀1 | 不裁则刀1 落地后仍可能点不到该点的人 |
| 5 | `/api/log-event` handler 按字段解构，新字段**静默丢弃**；且 `logEvent` 只 `console.log`，无文件落盘 | 刀5 | 记录仪装了也攒不到数据 |
| 6 | 刀5 的"信封 sha 硬线"没有台架跑得到（记录仪活在 GameCanvas 接线上） | 刀5 | 验收判据不可执行，需换成纯度断言 |

---

## 1. 方法（可复算）

- **机器复算**：独立脚本读**生产** `EL_ALAMEIN_REGIONS/FRONTS/FACILITIES`，用与
  `isInsideFront`（frontDestination.ts:109-117，闭区间 `>=`/`<=`）同一判定重算全部两两对。
- **真台架实跑**：写了一个内存改图 harness（`scratchpad/audit-scripts/_tmp-harness.ts`），
  在**不动仓库一个字节**的前提下把 v2 推荐表灌进 module 级数组，然后 `import()` 真台架跑。
  ★ 第一版 harness 用绝对路径 import 导致**两份 module 实例**、台架全绿是假绿——已证伪后
  改走 `@ai-commander/shared` 包说明符才生效。建议实施时把这个机制直接改造成 negctl。
- **判据家法**：本审核所有"会变"的断言都跑生产函数取数（front 归属、playerPower、
  assignedUnitIds 由台架自身负责），不读注释、不读措辞。

---

## 2. 刀3 · 战线矩形消重叠

### (a) 病灶 file:line 与代码是否相符 —— **完全相符**

- 13 对跨战线重叠：**逐对逐坐标与 v2 表一致**（我的独立复算输出见附录 A）。v2 用
  「y=55 线 x210-260」这类写法的三对，机器算出的交叠框分别是 [210,55,260,55]（50×0）、
  [210,80,260,80]、[200,140,370,140]——同一件事。
- 设施级 4 处病理全部复现：`ea_kidney_ridge`(220,55) 双认领 coastal+ridge、
  `ea_observation_post`(250,100) 双认领 ridge+center（且确实被 3 个 region 同时圈住）、
  `ea_axis_barracks2`(120,140) 双认领 center+axis_rear、`ea_ammo_depot`(260,150) 的
  `regionId=central_desert` 与坐标不符（几何在 southern_desert）。
- 「生产代码零硬编码 region id」属实：全仓 grep 只命中 `defensiveAI.ts` 的
  `front_axis_rear`（front id，不是 region id）+ 台架注释。
- **额外实证（v2 没做，但支持它的立论）**：把 1 个玩家步兵钉在 (250,100)，
  `buildDigest` 后 `front_ridge.playerPower=40` **且** `front_center.playerPower=40`——
  一个兵被两条战线各记一次；换成推荐表后只剩 ridge=40。双计病灶是真的。

### (b) 修法可施工性 —— **可施工，但推荐表本身有三处漏，且有第三份真相源没被点名**

1. **推荐表没消完重叠**：`miteirya_ridge_zone [210,55,260,80]` 与新
   `central_desert_w [181,80,229,137]` 在 **y=80、x210-229** 仍相交（20 格）。
   新台架的断言①（任何一点至多一条战线）在提交当天就会红。
2. **无主地不是"≤5 行窄条"**：整数格逐点比对，推荐表让 **2356 格**失去全部战线归属，
   其中 **1925 格是 x316-490 × y45-55 的整块（11 行 × 175 列）**——北线南缘从 55 收到 44、
   而 x>315 没有任何新矩形接手。实测后果：开局玩家步兵 **#61 (399,55)、#62 (401,55)**
   从 `front_coastal` 掉进"无战线"（北线玩家单位 10 → 8）。这块地正是 HQ 往北线增援
   的必经走廊，"北线的部队都撤退"之类的作用域会在行军途中漏人。
3. **薄缝里有兵**：`x248-260 × y81-84` 这条 v2 已登记的缝里，开局就坐着敌军主战坦克
   `#153 (252,82)`——修后它从 `front_center` 的敌军实力里**整个消失**（今天它是被计入的）。
   R5「允许无主薄缝」的裁定是在"缝里没东西"的印象下给的，请带着这条证据复裁。
4. **第三份真相源没被点名**：`region.facilities[]`（mapData 里每个 region 自带的设施清单）
   是独立于 `facility.regionId` 与几何的第三份，`enemyAI.frontHasFacility` 在读它；
   它今天已经陈旧 3 条（三个玩家前哨不在任何 region 的清单里）。R4 改 `ea_ammo_depot`
   必须同时改这两处清单，新拆出的三块也要定清单归属，否则本刀在收敛一处的同时放大另一处。

**可修性已验证**：只加一块 `northern_coastal_e [316,45,490,55]` + 把 `central_desert_w`
起始行 80 改 81，跨战线重叠 **0**、无主格 **2356 → 460**（全部 ≤2 行，除 x230-260×y80-84
那条 5 行缝仍在——若也要救，可改由 ruweisat 上沿接手，但那要连带动 minefield_zone_n 的
南缘，属地图语义，留给裁定）。

### (c) 验收（含负对照）—— **负对照可跑；但"13 台架全绿"目前不成立，且 v2 对哪些会响判断偏了**

我把推荐表灌进真台架实跑了全部 13 个（synthetic/negctl 之外的默认模式）：

| 台架 | 基线 | 推荐表 |
|---|---|---|
| **ab-approval-v4** | 161 PASS / 0 FAIL | **151 PASS / 10 FAIL** |
| 其余 12 个（battle-board / capture-stall / command-preflight / commander-presence / dispatch-scope / emily-production / front-escalation / g-knife --selftest+--sites / handtest-authority / handtest-route / pretest-polish / **retreat-semantics**） | 全绿 | **全绿** |

10 条 FAIL 逐条（★ = 上一级登记在案的合同断言）：

| 断言 | 根因 | 属于 |
|---|---|---|
| T1a 前置 front_center 几何中心 ==(263,96) | 实得 (273,103) | fixture 重钉 + 登记 |
| T1w0 前置 / T1w-neg 负对照 / **★T1w3 端到端数兵核坐标** | `WEST_CLUSTER (130,90)` 掉出 front_center → 撤退档 fixture 塌了，实测撤退**落在交火点上**（d=0.0） | fixture 重钉（(130,90)→ 新 front_center 内，如 (185,90)；`T1j` 里写死的 `130.5` 也要跟着改） |
| **★TF10 次序：敌方非VP设施压过我方设施** | 修后 front_center **一个敌方设施都没有**（意军营房归了敌后） | ✗ 不是重钉坐标能救：这条合同在这条线上**失去 fixture**，要么换一条线，要么台架注入一个合成设施 |
| T2b 前置 / **★T2d** / **★T2e** / T2l / **★T3i** | `STRADDLE_INSIDE (360,138)` 出线（新南缘 137），"同名不同成员"的坑不成立 | v2 已预告的那一处重钉，但下游是 5 条断言、3 条带 ★ |

另外两处 v2 的预判需要修正：

- v2 说 `:186/:399/:400/:1400 现值均仍在新矩形内，预期不响`——**漏了同一文件的 :187
  `WEST_CLUSTER (130,90)` 与 :168 的西头驻军**，那才是塌掉 4 条断言的那个坐标；
  :452/:453（刀F fixture）归属也变（双认领→单认领，恰好不影响结论）。
- v2 说 `ab-retreat-semantics 五条字节快照…会漂，逐条核对并按合同刷新`——**实测五条一字未
  漂，全绿**。这条要写死在开工令里：**谁都不许"按预期"去刷新它们**；真漂了才是回归信号。

**负对照**：新台架 `--negctl`（把任一新 bbox 改回旧值 → 断言①/③ 必红）机制上成立，
我用同一 harness 反向验证过（旧表下断言①必然红，因为 13 对重叠是真的）。

### (d) 连带面 —— **v2 列了 17 个消费文件，漏两处，且漏的那两处会被用户看见**

1. **`nearestPlaceWithin` 读 `frontCenterPos`**（frontEscalationPayload.ts:218-233 里
   扫完设施再扫**战线中心**）。front_center 中心 (263,96)→(273,103)、front_coastal
   (294,38)→(294,34)，凡落在这两点 12 格内的位置短语会**改名或从有名变无名**。
   影响面＝候选 label、SQUADS `loc=`、preflight 的"来源地"话术——不只是 v2 说的
   "各梯子最后一档"。（也正因如此，刀3 与刀4 的手测最好合并做一次。）
2. **地图上会多出标签**：`renderRegionLabels`（rendererCanvas.ts:1133-1160，
   GameCanvas.tsx:2207 传的是 `state.regions` 全量）**给每个 region 在其 bbox 中心画名字**
   （zoom ≤0.9 时）。拆区后玩家会看到 **3 个新地名标签**、并且"中央沙漠""魔鬼花园雷区"
   两个旧标签**移位**。这属于"影响手感的可见变更"，按家法要先给用户三行人话确认，
   而且新区块**必须先起名字**（v2 的表只给了 id）。

---

## 3. 刀4 · tag 进就近地标

### (a) 相符（行号误差 ≤2 行）

`nearestPlaceWithin` frontEscalationPayload.ts:218-233 只扫设施+战线中心 ✓；
`Tag` 类型 types.ts:463-470 ✓；`placeNameAt` 的 tag 优先语义 commanderPresence.ts:437-447 ✓；
`NAME_RADIUS_TILES = 12` 唯一定义在 frontEscalationPayload.ts:51 ✓；
`buildReinforceOptions` 签名 :311-321、anchor 在 :321 ✓；label 拼装无同名去重 :375-392 ✓
（N1 账属实，且**只有罗盘分支**有序号去重，地名短语分支没有）。

### (b) 可施工。一个开口：**tag 只按 id 解析，名字回不去**

`normalizeIntentLocations`（tacticalPlanner.ts:143）与 `resolveTarget`（:1355）判 tag 都是
`state.tags.find(t => t.id === value)`——**只认 `tag_1` 这种 id，不认名字**；
`getRegionCenter` 的模糊 includes 只覆盖 region，不覆盖 tag。
刀4 让信封开始印 tag **名字**（「制高点附近未编组群」），模型把名字写回 `targetRegion`
就解析不到——**与刀2 自己发现的「嘴上念 G2 → `fromSquad="临时编队G2"` 解析不到」完全同形**，
刀2 补了闭环，刀4 没补。缓解项是 ai.ts:304 已经教了 id 映射、digest 的 `---TAGS---`
（digest.ts:204-213）同时印 `tag_1:"名字" @(x,y)`，所以这不是必炸，是**必须验的**：
要么同刀补 id-or-name 归一（原则是"引擎自己印出去的名字，引擎必须认得回来"，
不是地名同义词表，红线二不违），要么留一条活体负对照证明 id 映射够用。

### (c) 验收可跑。补一条：**闭环断言**（tag 名进 label 后，下一句「把制高点旁边那群调过来」
仍解析到 `tag_1` 并数得出 assignedUnitIds），而不是只断言 label 文本对。
v2 写的三条负对照（无 tag 字节不变 / 半径外不变 / PLAYER_VIEW 别名等价）都成立且可跑。

### (d) 连带面列全了；补一句：`placeNameAt` 塌缩成别名后，**tag 名字会出现在 preflight
台词的"来源地"里**（commandPreflight.ts:91 走的就是 `nearestPlaceWithin`）——这是好事，
但属于玩家看得见的措辞变化，写进手测看点。

---

## 4. 刀2 · 番号印到部队名紧邻处

### (a) 相符，**8 处逐字命中**

`handleOf` commanderPresence.ts:152-157（返回 ` handle=${g}`，行尾 token）✓、
:198/:204/:234/:243 四处拼装 ✓、JUDGMENT 节头 :257-264 ✓、
`groupLine` battleBoard.ts:133-136 + 铸号 :156 ✓、
`ticketPromptLine` escalationTicket.ts:326-327 ✓、`isTicketRef` :251-253（`/^G\d+$/i`）✓、
digest.ts:311 UNASSIGNED 节头「用行末的 handle=G#」✓、
ai.ts:82（合同⑤）/ :275（解析器 prompt）/ :720（CHANNEL_PERSONA.combat 的合同副本）✓、
TB6 ab-approval-v4.ts:1117 ✓。

### (b) 可施工。三点补充

1. **台架依赖点不止 TB6**：`ab-approval-v4` 有 **8 处**读 `handle=` 字面——
   :1117/:1118（纯度）、:1128（`match(/handle=(G\d+)/)` 取号）、:1139、:1180/:1181
   （正例+负对照）、:1187/:1188（节头文本 `includes("handle=G#")`）、:1365（板子行取号）、
   :1381（板子纯度）。全部要随格式改，且**不许用"放宽断言"的方式让它变绿**。
2. **`ab-g-knife --sites` 会红，红在指纹不在登记表**：`RULE_FINGERPRINTS.handle_addressing`
   （scripts/ab-g-knife.ts:1021-1027）用字面 `/handle=G#/` 认规则。号一改印法，
   `SYSTEM_PROMPT` / `CHANNEL_PERSONA.combat` / `UNASSIGNED_HEADER` / `FRONT_JUDGMENT_HEADER`
   四个面的规则集合就测不出 `handle_addressing` → 断言 C 红。要改的是**指纹**
   （规则的新写法），登记表条目本身不用动——v2 写成"两张登记表同步"，指错了地方。
3. **硬约束（建议写进开工令）**：号只能进**行的拼装**，**绝不许拼进 `option.label` 或
   `ticket.label`**。理由有二：`ab-front-escalation` 有三条断言 `label.endsWith("未编组群")`
   / `/第[一二三四五六七八九十]未编组群$/`（:338/:351/:368）；`ticket.label` 会进回执，
   污染后回执里番号双打印。

### (c) 验收可跑。容错断言注意 `lookupEscalationTicket` 已经 `raw.trim().toUpperCase()`
（escalationTicket.ts:242），前缀剥离要与它同源；`isKnownForceRef`（:279-294）也走
`isTicketRef`，两处同改才闭环。番号命令走 ChatPanel 同一条路——G 刀教训已写进 v2 ✓。

### (d) 连带面基本列全。补一条登记项：**9/131 的贴错率基线是在现有措辞上量的**，
本刀同时改了线上格式与 prompt 里的格式指称，那个数字不能直接沿用作对比基线
（不卡合并，登记即可；v2 已说贴错率由用户盲读，方向正确）。

---

## 5. 刀1 · 危机票据带设施名

### (a) 全部相符（这一刀的引用最多，逐条翻过）

`EVENT_CHANNEL_MAP` GameCanvas.tsx:110-111（两条旧裁定的注释就写在这两行上）✓、
facFacts 分支 :428-429 ✓、**`:475 const withTickets = facFacts ? null : buildFrontEscalationWithTickets(...)`
逐字一致**——"设施族一张票都不铸"属实 ✓、log-event 先例 :501-513 ✓；
`detectFacilityContested` reportSignals.ts:262-276 且 **:263 `if (f.team !== "player") return;`**
（R1 的精度修订完全正确）✓、`CAPTURE_STALLED` :356 且检测器对**非我方设施**才跑
（`f.team === "player"` 直接 delete 返回）→ R1 说"打敌方 VP 的停滞照旧归 Marcus"是实集 ✓；
`buildFrontEscalationWithTickets` escalationTicket.ts:219 ✓、
`ticketDestinationVerdict` :478-512、retreat 档 :503、`injectTargetRegion` :504-506 ✓；
`resolveTarget` 里 `targetFacility` 优先级 tacticalPlanner.ts:1349-1352 ✓、
`findFacilityPosition` :1733-1740 ✓；ChatPanel `wroteDestination` :1939 ✓、
`injectTargetRegion` 注入点 :1971 ✓、ticketLine 进 ACTIVE_ESCALATION :1328-1332 ✓；
`facilityContestWorthAsking` director.ts:843-855（`PROGRESS_ASK_THRESHOLD = 0.34` :741）✓、
`idle_reinforcement_available` :795 ✓；
**commandAuthority.ts:91-93 实证**：开局 `commanderDispatchPool` chen=74 / marcus=0 / emily=0
——"ops 频道派单被拦死"是真的，R1 的立论成立。

### (b) 可施工。模块方向不成环（`escalationTicket` 已经 `import { frontEscalationFacts } from "./director"`，
再取 `facilityEscalationFacts` / `buildFacilityEscalationPayload` 同向）。**但有一个承重语义问题**：

**`buildReinforceOptions(state, front)` 的候选池按定义排除该战线内部的全部单位**
（frontEscalationPayload.ts:311-321 起：`outsideFront(p)` 过滤，注释写明"里面的人已经投入了，
他们就是 survival/ratio 描述的对象"）。这条口径对**战线危机**成立，对**设施危机不成立**：
北线前哨挨打时，最该派的往往正是同在北部战线、但在别处闲着的那坨人——手测那局的原话
就是「援兵去了战线别处」。照 v2 现在的写法（`front = 设施所属战线` + anchorOverride），
那坨人**不会拿到号**，长官照样点不到他们。
两条出路，请裁：**(甲)** 设施危机传 `front=null` + `anchorOverride=设施坐标`（全图按到设施的
ETA 排，最贴近"谁能最快到这个点"）；**(乙)** 显式裁定"设施危机也只从线外找人"，
并接受同线内部的闲兵没有号。**不裁这一条，刀1 落地了也可能没解决手测那笔账。**

第二点（工程陷阱）：`CANDIDATE_FACES`（ab-approval-v4.ts:1664-1683）是**按"文件内第 n 次出现"**
登记候选出口的。刀1 在 `escalationTicket.ts` 新增一处 `buildReinforceOptions(` 调用——
若插在现有两处之前，`nth:1/nth:2` 的语义整体错位：TA1/TA2 仍会绿，但两条 policy 注释
会挂到错的调用点上（"绿着的错"）。必须同 commit 更新该表并给新面标 policy。

### (c) 验收可跑（正例走生产路径、数 assignedUnitIds、核落点==设施坐标——判据是对的）。三点补：

1. **R1 通过后的频道账**：`questionBudget` 是全频道共享的（GameCanvas.tsx:218-234
   `anyQuestionOccupied` 扫三个频道），但 `escalationState.inFlight` 是**按频道**的
   （:423）。前哨问句改喊 combat 后，会占住 combat 的 inFlight，可能压住同一时刻的**战线**
   升级问句——这正是 2026-07-29 旧裁定的原始担忧方向。手测看点里加一条"前哨危机在场时
   战线升级还出不出得来"。
2. **R1 的分档只覆盖 3 个 keypoint**（`friendlyKeypoints` = 三个前哨，
   core/scenario/elAlamein/index.ts:150-154）。我军**总部/兵营/机场/修理厂**被夺时，
   `FACILITY_CONTESTED` 仍走 ops——同样落在"答不了『派』"的频道。要不要一并按
   "玩家设施且派兵有意义"分档，请裁（见 R10）。
3. **N2 布尔与新候选行同屏打架**：`idle_reinforcement_available`（director.ts:795）是
   "全图任一 idle 即 true"，而票据行走的是诚实闸（可能滤空）。刀1 上线后同一条升级里
   可能出现"布尔说有、候选行说没有"。建议收口前至少加一条"两者不矛盾"的断言，或明确接受
   （v2 已把它记进 N2，方向对，只是没说同屏冲突这一层）。

### (d) 连带面列全了 ✓（前线族票据/TTL/burn/receipt/§8 梯子零改动、ops 人格闸不动）。

---

## 6. 刀5 · 校准记录仪

### (a) 相符

`state.diagnostics` 50 条环 + shift：sim.ts:39-40 及另外 7 处 push 点 ✓；
`diagsBefore` 与 `applyOrders` 同一同步块 ChatPanel.tsx:2040-2041、PRODUCE_FAIL/TRADE_FAIL
差集读取 :2091-2095 ✓（代码注释自己写着"Object-identity diff is robust to the ring buffer"，
v2 的精确论证与之一致）；`V4_BARE_CONFIRM_EXEC` :2078 ✓；`/api/log-event`
apps/server/src/index.ts:162 ✓；GameCanvas log-event 先例 :501-513 ✓、
proactive 评估节拍 :1848-1855（`PROACTIVE_EVAL_INTERVAL_SEC = 8`）✓；
`snapshotForDirector` director.ts:861-868（caller-owned 先例）✓；
`burnEscalationTicket` escalationTicket.ts:297 ✓。**"改走 log-event 不走 diagnostics" 的判断正确。**

### (b) 两个硬开口

1. **服务端会丢字段**：`app.post("/api/log-event")` 是
   `const { type, actionId, channel, frontId, kind, message, sessionId } = req.body`，
   然后只把这几个交给 `logEvent`。survival/ratio/eta/G号/facilityId **发出去即消失**。
   必须同刀改服务端（透传整个 body 或显式加字段）。
2. **没有"落盘"**：`logEvent` 只是 `console.log("[EVENT] " + JSON.stringify(...))`
   （index.ts:75-77），`.claude/start-*.sh` 全部 `exec npm run dev`，**无重定向、无文件**。
   "第 9/10 级读 JSONL"今天不成立。要么本刀加一条真持久化（追加 JSONL 文件），
   要么明确写成"由用户捕获 stdout"，别让样本攒在一个会被关掉的终端里。

### (c) **"信封 sha 逐字节不变"这条硬线没有台架跑得到**——记录仪活在 GameCanvas 接线上，
13 个台架一个都不经过它（这正是 LEDGER H1 记的结构盲区）。可执行的等价硬线建议改成
**TB6 式纯度断言**：记录仪路径**零铸号**（G 计数器前后相同）、**零 diagnostics 新增**、
`calibrationSnapshot/calibrationOutcomes` 对 state 只读。特别要防的是取
"top 候选 etaSec" 时误走带 minter 的路径——那会让 G 号凭空增长，信封当场变。
其余验收（泵帧局产出配对样本、字段够算偏差倍数、双方可独立重算）可跑 ✓。

### (d) 连带面：采样频率 8 秒一次，延迟铁律无虞 ✓；`burnedAt` 是内存字段，
注意任何把 ticket 序列化出去的面（回执/日志）不得把它带进玩家可见文本。

---

## 7. 四条红线自查

| 红线 | 判定 |
|---|---|
| 不打补丁（收敛唯一真相源） | 刀3/刀4 方向正确 ✓；**但刀3 若不同时处理 `region.facilities[]`，等于在收敛一处的同时放大另一处**（那是第三份真相源，今天已陈旧 3 条）——建议纳入新台架断言④ |
| 不穷举（语义原则） | ✓ 全刀无关键词表。刀2 的前缀剥离与刀4 若做 tag 名字归一，都是"引擎认得回自己印出去的东西"，不是同义词表 |
| 不套模板（禁例句） | ✓ 无新增例句；刀2 改 ai.ts 三处**只许改格式指称**这条要逐字守住 |
| 不破坏现有逻辑 | **✗ 当前不成立**：推荐表下 ab-approval-v4 红 10 条（5 条 ★）。把 fixture 重钉与 TF10 的合同覆盖当成**刀3 自己的交付物**处理掉之后才能宣称"13 台架全绿" |

工程铁律：刀5 sha 硬线见 §6(c)（判据要换）；会动兵的验收数 assignedUnitIds ✓（v2 全刀都这么写的）；
fixture 走生产路径 ✓。

---

## 8. 请裁（在 R1-R6 之外新增，均一句话可裁）

| # | 问题 | 我的推荐 |
|---|---|---|
| R7 | 北线南缘收到 44 之后，x316-490 × y45-55 那 1925 格谁的？ | 补一块 `northern_coastal_e [316,45,490,55]` 归北线（实测：重叠仍为 0，开局两名玩家步兵留在北线） |
| R8 | y=80 那一行（x210-229）归谁？ | `central_desert_w` 从 y81 起（不动上一级刚调过的山脊矩形）；代价是 x181-209 多一行无主 |
| R9 | **设施危机的候选池含不含同线内部的部队？** | 甲案：`front=null` + `anchorOverride=设施坐标`（全图按到设施 ETA 排）——否则手测那笔账可能仍然不解 |
| R10 | 非 keypoint 的玩家设施（总部/兵营/机场/修理厂）危机要不要也改喊 combat？ | 至少总部要（同样答不了"派"）；其余维持 ops |
| R11 | 新拆三块 region 的**显示名**是什么？`region.facilities[]` 怎么分？ | 地图会把 region 名画在屏上，请先起名；`ea_ammo_depot` 的清单条目随 R4 一起搬到 southern_desert |
| R12 | x230-260 × y81-84 这条 5 行缝（里面有开局敌军主战坦克）要不要救？ | 建议救（由 ruweisat 上沿接手，连带调 minefield_zone_n 南缘）；不救就把"敌军主战坦克不计入任何战线"写进登记 |

---

## 9. 施工顺序意见

维持 v2 的 **刀3 → 刀4 → 刀2 → 刀1 → 刀5**，两点补充：

- 刀3 内部先把表定死（R2/R3/R5 + R7/R8/R11/R12）再动代码；**fixture 重钉与 TF10 的合同
  覆盖属于刀3 的交付物**，不许推给"后面某一刀"或留成挂账。
- 若刀3 因裁定暂缓，刀4/2/1 可先行（v2 的判断成立）；此时新 fixture 坐标必须避开
  §2 表里那 13 个交叠框——`ab-commander-presence.ts:127` 的 `y<45` 先例可直接抄。

## 10. 新账（查过 LEDGER 全量账本，均无重复；建议随本级收口并进）

| # | 账 | 一句话 | 去向 |
|---|---|---|---|
| O1 | `region.facilities[]` 第三份真相源 | 与 `facility.regionId` 各说各话，今天已陈旧 3 条（三个玩家前哨不在任何清单里）；`enemyAI.frontHasFacility` 在读它 | 并入刀3 审计断言④ |
| O2 | `CANDIDATE_FACES` 按序号登记 | 按"文件内第 n 次出现"锚定，插入新调用点会让 policy 注释静默挂错行（断言仍绿） | 刀1 施工时顺手改成按符号/上下文锚定，或至少注明 |
| O3 | 地图 region 标签跟着 bbox 走 | `renderRegionLabels` 给每个 region 画名字，拆区＝屏上多标签+旧标签移位 | 刀3 手测看点 + R11 |

---

## 附录 A · 独立复算的 13 对（与 v2 表逐行一致）

```
northern_coastal    × kidney_ridge_zone    [200,45,260,55]  60×10  coastal vs ridge
northern_coastal    × miteirya_ridge_zone  [210,55,260,55]  50×0   coastal vs ridge
northern_coastal    × minefield_zone       [248,38,315,55]  67×17  coastal vs center
tel_el_eisa         × kidney_ridge_zone    [225,45,260,48]  35×3   coastal vs ridge
tel_el_eisa         × minefield_zone       [248,38,260,48]  12×10  coastal vs center
kidney_ridge_zone   × minefield_zone       [248,45,260,75]  12×30  ridge vs center
miteirya_ridge_zone × minefield_zone       [248,55,260,80]  12×25  ridge vs center
miteirya_ridge_zone × central_desert       [210,80,260,80]  50×0   ridge vs center
minefield_zone      × ruweisat_zone        [248,85,275,115] 27×30  center vs ridge
ruweisat_zone       × central_desert       [230,85,275,115] 45×30  ridge vs center（整块包含）
central_desert      × southern_desert      [200,140,370,140] 170×0 center vs south
central_desert      × alam_halfa_zone      [320,138,365,140] 45×2  center vs south
central_desert      × axis_rear            [120,80,180,140] 60×60  center vs 敌后
```
开局单位归属（生产 `isInsideFront` 实测）：现状 **14 个敌方单位被双计**；推荐表下双计 0，
但玩家单位 `front_coastal` 10→8、敌方 `front_center` 归零并多出 1 个无战线单位。

—— Opus 5 审核 2026-08-07。探针与 harness 存 `scratchpad/audit-scripts/`
（`_tmp-harness.ts` = 内存改图跑真台架，零仓库改动，建议实施时复用为 negctl 机制）。
