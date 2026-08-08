# 第 8 级提案 v2：信封与地名精度 + 校准记录仪（2026-08-07, Fable 5 主审重推）

> **与 v1 的关系**：v1（`LEVEL8_ENVELOPE_PRECISION_PROPOSAL_20260806.md`）是起点不是结论。
> 本档是把五刀代码链逐文件亲手读完之后的完整改动思路——每刀给病灶 file:line、修法、
> 验收（含负对照）、连带面。**凡 v2 与 v1 冲突，以 v2 为准**，冲突处均注明重推依据。
> 实施者（Opus 5 新窗口）从 §0 读起，争议回 Fable 裁定，用户拍板与手测。
>
> 主要重推结论（v1 没写到或写偏的）：
> 1. **刀1 的病比 v1 深一层**：设施家族的危机（FACILITY_CONTESTED / CAPTURE_STALLED）
>    根本**不铸票**（GameCanvas.tsx:475 `withTickets = facFacts ? null : …`），不是"票据
>    少带一个字段"而是"这一族没有票据机器"。同时设施名只存在于这一族——前线家族
>    （UNDER_ATTACK 按战线聚合 reportSignals.ts:206-213 / POSITION_CRITICAL / doctrine
>    breach）从头到尾不知道设施，给它们注入设施名只能靠推断，红线不许。
> 2. **刀3 的重叠不是一对，是十三对**（含一处整块包含、一处 60×60），另有三个设施被
>    双前线认领、一个设施 regionId 与坐标不符。机器复算脚本与全表见 §刀3；
>    复核方（v1 起草人）独立重算 13 对逐行逐坐标一致（2026-08-07）。
> 3. **雷区矩形的跨纬度重叠有物理动机**（terrainGen.ts:112 沼泽带 y42-118 真实横跨三条
>    战线的纬度）——怎么切是地图语义裁定，列入 §R 待拍板。
> 4. 刀5 不走 `state.diagnostics`（50 条环形缓冲会把 PRODUCE_FAIL 挤掉，ChatPanel:2091-2095
>    在消费它）——改走已有的 `/api/log-event` 落盘通道（GameCanvas.tsx:501 先例）。
>
> **★ v2.1（2026-08-07）：Opus R2 审核（`LEVEL8_V2_OPUS_REVIEW_R2_20260807.md`）后的全部
> 修正与裁定集中在文末 §O——凡与正文冲突，以 §O 为准。刀3 的矩形表以 §O 的 v2.1 表为准。**

---

## §0 现场与总则

- main = `d5eb32e`（= origin/main，第 7 级收口后）。**开新 worktree**（家法：main cwd 零实施）。
- 一刀一 commit：typecheck 4 包 + 全部台架（13 个 ab-*.ts）+ negctl 真红 + 相应快照；
  不带 lockfile、不 add .github/。
- 每刀先盘点（file:line 落到实处；实际结构与本档不符 → 停下来报告，不许猜）。
- 判据家法全套：会动兵的数 assignedUnitIds + 核落点坐标；负对照必做；fixture 走生产路径。
- 四红线：不打补丁（收敛唯一真相源）／不穷举（语义原则）／不套模板（禁例句）／
  不破坏现有逻辑（台架全绿是硬线，凡有意行为变化照 T1j 先例显式登记，见 §C 总表）。
- **施工顺序（推荐）**：刀3 → 刀4 → 刀2 → 刀1 → 刀5。
  理由：地图是地基，先切完别的刀的 fixture 才不用二次钉坐标；命名其次；印法第三；
  票据机器第四（骑在新印法上）；记录仪最后（采的是终态语义的样本）。
  若 §R 裁定未齐导致刀3 暂缓，刀4/2/1 可先行——fixture 坐标须选在重叠带之外
  （先例：ab-commander-presence.ts:127 特意选 y<45 避开重叠带）。

---

## §R 开工前需用户拍板的裁定

> **★ 已拍板（用户 2026-08-07）：R1-R15 全按推荐。** 用户口径原话="都按推荐的话，按你说的做"
> ——技术细节托付双主审，**手感终审保留在收口手测**（手测不过，任何裁定可翻案，不合 main）。
> 下表与 §O-1 从"待拍板"转为"已定案"，Opus 可开工。

| # | 问题 | 推荐 | 不采纳推荐时的替代 |
|---|---|---|---|
| R1（刀1） | **玩家前哨被夺，问句该谁喊？** 现状 FACILITY_CONTESTED / CAPTURE_STALLED 一律走 ops/Marcus（GameCanvas.tsx:110-111），而 ops 频道所有派单都被人格闸拦死（commandAuthority.ts:92-93，Marcus 名下无兵）。前哨危机问句落在一个**永远无法直接答"派"的频道**。**精度（复核修订 2026-08-07）**：CONTESTED 检测器只对玩家设施触发（reportSignals.ts:263 `f.team !== "player"` return），"敌方/中立维持 ops"对它是空集；真实分档=keypoint vs 非 keypoint。 | 两事件按 **friendlyKeypoints 的 id 归属**分档（不按当前 team 算）：id ∈ keypoints → combat/Chen；其余维持 ops（对 CAPTURE_STALLED 这一半是实集：打敌方 VP 的占领停滞照旧归 Marcus）。按 id 算把"前哨已丢转敌、我们回头夺"也接住——夺回前哨的停滞归陈。**本裁定修订两条旧裁定**：7c.1-stab A3（CONTESTED→ops）与 2026-07-29（STALLED→ops，当时理由=怕淹 combat）；修订依据=新证据（问句落在永远答不了「派」的频道）+ keypoint 事件稀疏（全图 3 前哨、30/60s 冷却）不会淹 combat。旧裁定对非 keypoint 事件继续有效。 | 不改频道：刀1 照做（票据机器就位），但北线前哨手测场景仍需玩家换到陈的频道重新下完整命令——刀1 的活体收益大打折扣。 |
| R2（刀3） | **雷区带（魔鬼花园）纵跨三条战线纬度，仗算谁的？** | 按纬度三段切：y≤44 归北线、y45-84 段 x≤260 归山脊（既有 kidney/miteirya 矩形）、雷区自留 [261,45,315,84]+[276,85,315,125] 归中央（详表见刀3）。 | 整条归中央（现状语义）——则北线/山脊与雷区的四对重叠只能靠把雷区西/北边大幅内收，北缺口通道（terrainGen x268-275 步兵走廊）上半段会变无主地，交战在走廊里会从战线判读中消失（mood/JUDGMENT 静默——Step B 教训同形，不推荐）。 |
| R3（刀3） | **coastal/ridge 缝钉在哪？** 北部山脊 VP (220,55) 正压在北线南缘 y=55 上，现状被两条战线同时认领。 | 北线南缘 55→44（tel_el_eisa 同步 48→44）。y44/45 与 terrainGen 的地形笔触几乎逐行吻合（tel 高地画到 y44、kidney 山丘从 y45/48 起），VP 唯一归山脊。 | 缝钉 y49 等其它纬度——任何 >44 的选择都会把 kidney 北坡切给北线，与地形画法脱节。 |
| R4（刀3） | **沙漠弹药库 (260,150) regionId 写着 central_desert，坐标却只在 southern_desert 里**——事件归线（director.ts:624-627 走 regionId）与几何扫描（一切 bbox 循环）对同一设施给出两条战线，帧标签病同形。 | regionId 改 southern_desert（事实跟几何走；登记：该设施的 FACILITY_CONTESTED 类事件从此归南线）。 | 挪设施坐标进中央矩形——动的是物理地图，连带更大，不推荐。 |
| R5（刀3） | **切缝后允许留"无主薄缝"吗？**（切法产生的 1-5 行宽窄条，不属任何战线） | 允许。地图今天本就有大片无战线区（x180-200 整条竖带、y>232 等），薄缝不是新语义；宁留无主缝不留双主重叠。 | 不允许——则需再造 2-3 个填缝 region，纯增复杂度，不推荐。 |
| R6（刀2） | **编号措辞对"分队子集"候选也用「临时编队」吗？** 升级候选可以是编制分队的一个子集（如 Aiden(I1) 在前线外的 5 人，B 案裁定 2026-08-02：板 10 人 vs 案 5 人）。 | 统一用「临时编队G#」：冻结的那批本来就不是编制分队本身，自描述反而更准。措辞手感留用户盲读后再议。 | 分队候选印「G#」不带前缀——两种印法并存，规则多一条，不推荐。 |

---

## 刀3 战线矩形消重叠（施工第 1 位；连带面最广，先落地基）

### 病灶（机器复算，脚本存 scratchpad/overlap-audit.ts，实施时移入台架）

**跨战线重叠 13 对**（bbox 含边界，同 isInsideFront 的判定 frontDestination.ts:109-117；
双方独立复算一致）：

| 重叠对 | 交叠区 | 战线 |
|---|---|---|
| northern_coastal × kidney_ridge_zone | [200,45,260,55] 60×10 | 北 vs 山脊 |
| northern_coastal × miteirya_ridge_zone | y=55 线 x210-260 | 北 vs 山脊 |
| northern_coastal × minefield_zone | [248,38,315,55] 67×17 | 北 vs 中央 |
| tel_el_eisa × kidney_ridge_zone | [225,45,260,48] 35×3 | 北 vs 山脊 |
| tel_el_eisa × minefield_zone | [248,38,260,48] 12×10 | 北 vs 中央 |
| kidney_ridge_zone × minefield_zone | [248,45,260,75] 12×30 | 山脊 vs 中央 |
| miteirya_ridge_zone × minefield_zone | [248,55,260,80] 12×25 | 山脊 vs 中央 |
| miteirya_ridge_zone × central_desert | y=80 线 x210-260 | 山脊 vs 中央 |
| **minefield_zone × ruweisat_zone** | [248,85,275,115] 27×30 | 中央 vs 山脊 |
| **ruweisat_zone × central_desert** | [230,85,275,115] 45×30 **整块包含** | 山脊 vs 中央（账本 A3 那一对） |
| central_desert × southern_desert | y=140 线 | 中央 vs 南 |
| central_desert × alam_halfa_zone | [320,138,365,140] 45×2 | 中央 vs 南 |
| **central_desert × axis_rear** | [120,80,180,140] **60×60** | 中央 vs 敌后 |

**设施级病理 4 处**：北部山脊 VP (220,55) 双认领（北+山脊）；中央雷达 (250,100) 双认领
（中央+山脊，三个 region 同时圈它——刀F 那场仗的现场）；敌军意军营房 (120,140) 双认领
（中央+敌后）；沙漠弹药库 regionId 说谎（见 R4）。

**非病理，登记不修**：british_hq_area 不属任何战线，它与 central/southern 的重叠不违反
"一点至多一条战线"；tel⊂coastal、kidney∩miteirya、minefield∩central 等**同战线**区重叠是
地理嵌套，front 级不变量不管它们（不变量特意定在 front 级，理由就在这）。

### 修法（纯数据 + 一个新台架；生产代码零改动）

生产代码没有任何硬编码 region id（已全仓 grep：defensiveAI 只认 `front_axis_rear` 这个
front id，其余命中全是台架注释）——所以是 mapData.ts 局部手术，所有 17 个 bbox 消费文件
自动继承。

**推荐新表**（依 R2/R3/R4/R5 推荐裁定；实施时逐格重核）：

| region | 旧 bbox | 新 bbox | 说明 |
|---|---|---|---|
| northern_coastal | [200,22,490,55] | **[200,22,490,44]** | R3 |
| tel_el_eisa | [225,26,260,48] | **[225,26,260,44]** | R3；与地形 fill(232,28,252,44) 吻合 |
| kidney_ridge_zone | [200,45,260,75] | 不动 | |
| miteirya_ridge_zone | [210,55,260,80] | 不动 | 与 kidney 交叠为同战线，合法 |
| ruweisat_zone | [230,85,275,115] | 不动 | |
| minefield_zone | [248,38,315,125] | **拆二**：minefield_zone [276,85,315,125] + 新 minefield_zone_n [261,45,315,84] | 原 id 留给含前线油库(310,100)的南块，regionId 免改；x248-260 让给 kidney/miteirya（已覆盖），y≤44 让给北线 |
| central_desert | [120,80,370,140] | **拆三**：central_desert [276,80,370,137] + 新 central_desert_w [181,80,229,137] + 新 central_desert_s [230,116,275,137] | 原 id 留给含中央前哨(360,105)的东块，regionId 免改；西缘 120→181 解 60×60（意军营房唯一归敌后）；南缘 140→137 解 alam_halfa 2 行重叠 |
| southern_desert | [200,140,400,225] | 不动（可选：东缘 400→369 消 british_hq 区域级嵌套，front 级无影响，随 R5 一并裁） | |
| alam_halfa / himeimat / axis_rear / british_hq_area | 不动 | | |

**随表同改**：front_center.regionIds → 5 个 region（v2.1 表；正文旧稿笔误写过 6，
Opus 刀3 commit 的 5 为准）；front_coastal → 3 个；两处 adjacent 表补新 id；
ea_ammo_depot regionId → southern_desert（R4）。
**（v2.1 更正：本段原稿"无主缝均 ≤5 行宽"与事实不符——原推荐表实测产生 2356 无主格，
其中 1925 格是 x316-490×y45-55 整块、开局两名玩家步兵在里面。修正表见 §O，
修正后无主格 ≈340，且不再有兵坐在缝里。）**

**新台架 `ab-mapdata-audit.ts`**（本刀交付物的一半）：
1. 全图两两对：**任何一点至多属于一条战线**（front 级；用生产 front.regionIds+bbox 判定，
   不自造成员判定——dispatch-scope 的 fuzzy front 烧手教训）；
2. 每个设施：declared regionId 的 bbox 必须含其坐标；
3. 每个设施：几何认领的战线集合去掉 (none) 后 ≤1，且与 regionId 推出的战线一致；
4. 负对照：临时把任一新 bbox 改回旧值 → 断言 1/3 必须真红（negctl 模式）。

### 验收（含负对照）

- typecheck 4 包 + 13 台架全跑。**预期会响的台架逐条核对并登记**（见 §C）：
  - ab-approval-v4.ts:768 `STRADDLE_INSIDE (360,138)`——注释写明"inside central_desert
    [120,80,370,140]"，新南缘 137 后该点出线，坐标须重钉（如 (360,135)），归类 fixture
    重钉不是行为回归；同文件 :186/:399/:400/:1400 的坐标逐个核（现值均仍在新矩形内，预期不响）；
  - ab-retreat-semantics 五条字节快照：front_center 的 frontCenterPos（frontDestination.ts:122
    五 region 平均）会移动 → 凡走到"最后一档"的快照会漂，逐条核对新落点、快照按合同刷新
    并在 commit message 注明（T1j 先例；attack 项上一级刚刷过一次，有现成格式）；
  - ab-commander-presence / ab-g-knife / ab-dispatch-scope 的 fixture 坐标全部复核（多数
    特意避开了重叠带，预期绿）。
- **效果级正例**：把一个单位钉在原重叠带内（如 (250,100) 中央雷达旁交战）→ 修前
  updateFrontPower / buildFrontJudgmentLines / commanderMood 两条战线同时计入（数字断言
  双计），修后仅山脊计入；再取 (150,110)（原 60×60 带）→ 修后仅敌后计入。
- **负对照**：ab-mapdata-audit --negctl 真红（见上）；无单位在缝隙带的对局，digest 字节
  与修前**不同是预期**（front_center 中心移动），凡 diff 逐行核对且全部可归因于登记项。

### 连带面（如实列全）

front 成员判定的 17 个消费文件全部继承（frontDestination / frontEscalationPayload /
intelDigest / commanderPresence / director / battleAwareness / enemyAI / defensiveAI /
commandPreflight / decisionReview / missions / reportSignals / autoBehavior / digest /
tacticalPlanner / rendererCanvas 区域描边 / sim 间接）——**行为变化只有一类**：原重叠带与
新薄缝里的单位/设施换了归属；重叠带上的双计消失（战力、mood、判读、危机触发都会跟着
准起来，这正是本刀目的）。frontCenterPos(front_center/front_coastal) 移动，只影响各梯子
"最后一档"（有兵有设施时根本走不到）。敌 AI（enemyAI/defensiveAI）读 front 成员，重叠带
内目标选择会微调——手测留意，不预设结论。

---

## 刀4 tag 进就近地标（施工第 2 位；最小刀）

### 病灶

`nearestPlaceWithin`（frontEscalationPayload.ts:218-233）只扫设施与战线中心，不认玩家
tag（`state.tags`，types.ts:465-470，玩家插的公开标记，零雾风险）。闲兵停在标记点旁只能
叫"东北方向群"。Step C 时立过"禁改 nearestPlaceWithin 本体"——那是当级的爆炸半径管控，
本刀的目的恰是改它，显式解禁并登记（§C）。

### 修法（收敛唯一真相源）

- `nearestPlaceWithin` 本体加 tag 扫描，**tag 优先**语义与 placeNameAt 完全一致
  （commanderPresence.ts:439-447：半径内有 tag 则 tag 赢，哪怕设施更近——玩家花的精度
  优先；同一 NAME_RADIUS_TILES=12，不新设常量）；tie-break 按 tag id 序，确定性。
- `placeNameAt` 本体随之塌缩成 `nearestPlaceWithin` 的别名（保留 export，Step C 调用面
  零改动）——两份"这点叫什么"合成一份，这是本刀的治根部分。
- 命名效果自动落到全部消费面：候选 label（"标记点1附近未编组群"）、SQUADS loc=、
  preflight 台词（commandPreflight.ts:91）、PLAYER_VIEW（行为不变，只是换了实现路径）。

### 验收（含负对照）

- 正例：tag 半径内的未编组群 label 带标记名（生产路径 buildReinforceOptions 断言，不
  自拼 label）；tag 与更近设施并存 → tag 赢（placeNameAt 语义移植的直接断言）。
- 负对照：①无 tag 对局 → 全信封字节不变（`state.tags` 空数组，循环零命中）；
  ②tag 在半径外（13 格）→ 字节不变；③PLAYER_VIEW 输出与修前逐字节同（别名等价性）。
- 已知非目标：两个空间群贴同一地标会同名——**今天设施命名就有此病**（label 拼装
  frontEscalationPayload.ts:383 无同名去重），tag 不新增病类，登账不在本刀修（§N1）。

---

## 刀2 番号印到部队名紧邻处（施工第 3 位）

### 病灶

`handle=G#` 是行尾独立 token，行的主语却是战线：commanderPresence.ts:154-157（handleOf
拼接）、:198/:204/:234/:243（`best_help=<label>(<facts>)<handle>`——号挂在右括号外面）、
battleBoard.ts:156（群行行尾）。模型把号绑给行首的名字（「北部战线 Aiden G2」，G 刀后
9/131）。**根因是语法位置，不是措辞**。

### 修法（用户已裁：自描述「临时编队G#」贴部队名）

**一条规则统一所有印号面：号永远紧跟在部队名后的方括号里，形如 `名[临时编队G#]`；
行尾独立 token 废除。**

| 面 | file:line | 旧 | 新 |
|---|---|---|---|
| 判读行 best_help | commanderPresence.ts:198/234 | `best_help=Aiden(I1)(3units 无任务 eta≈14s) handle=G2` | `best_help=Aiden(I1)[临时编队G2](3units 无任务 eta≈14s)` |
| 判读行 none 披露 | commanderPresence.ts:204/243（describeNoHelp named） | `…都赶不到) handle=G3` | 披露句内被点名的那支后贴 `[临时编队G3]` |
| 板子群行 | battleBoard.ts:156 + groupLine:133-136 | `- 东北方向未编组群: 6units(…) 无任务 handle=G4` | `- 东北方向未编组群[临时编队G4]: 6units(…) 无任务` |
| 候选编号行 | escalationTicket.ts:326-327 ticketPromptLine | `G1=大本营附近未编组群(5units)` | `临时编队G1=大本营附近未编组群(5units)` |
| 分队子集候选 | 同上各面 | — | 统一同格式（R6 推荐） |

**格式引用行随印法同步（登记为合同变更，不是新增说话规则）**——纯引擎刀的口径在此处
有一个显式豁免：以下几行**描述的是线上格式**，线变了它们必须跟着变，否则模型按旧格式
找 token 会扑空：digest.ts:311（UNASSIGNED 节头"用行末的 handle=G#…"）、
commanderPresence.ts:257-264（JUDGMENT 节头）、ai.ts:275（解析器 prompt 的 handle 段）、
ai.ts:82 与 :720 合同⑤里的 "handle=G#" 字样。**只许改格式指称，一条语义规则不加不删、
不添例句**（红线三）；改完跑 `ab-g-knife --sites` 与 `--emily-guard` 两道防护，
SPEECH_RULE_SITES（scripts/ab-g-knife.ts）/ CANDIDATE_FACES（scripts/ab-approval-v4.ts）
两张登记表同步。

**容错必须同刀落地（重推新增，v1 没有）**：嘴上念「临时编队G2」，模型就可能把
`fromSquad="临时编队G2"` 原样写进单子——现 `isTicketRef`（escalationTicket.ts:252-254
`/^G\d+$/`）会判非票据 → 掉进分队闸报「找不到分队」。`isTicketRef` 与 lookup 的 key
归一化接受**我们自己印的这一个前缀**（剥掉可选的"临时编队"再判 G\d+）。这是对自家
打印格式的解析闭环，不是同义词表（红线二不违）。

### 验收（含负对照）

- 信封格式断言：凡铸号行，号与部队名满足 `名[临时编队G\d+]` 相邻式；全信封 grep 无
  ` handle=` 残留。
- 纯度断言沿用并更新：无铸号器路径字节不变、无新标记（ab-approval-v4.ts:1117 TB6 的
  `handle=` 检查换成新标记）。
- 容错：`resolveTicketReference("临时编队G2")` == `("G2")` 派同一批；负对照
  `"临时编队2"`/`"G2X"`/`"编队G2"` 拒绝（fail-closed 不变）。
- 番号命令走 ChatPanel 同一条解析路（G 刀教训：否则正确命令被数成零执行）。
- 贴错率的活体改善由用户后续对局盲读记录，不设本刀阻塞线（v1 原样保留）。

---

## 刀1 危机票据带设施名（施工第 4 位）

### 病灶（重推后的完整链）

设施名在引擎里只活在设施家族事件上：FACILITY_CONTESTED（reportSignals.ts:262-276，
entityId=设施 id，actionRequired=true，仅对玩家设施触发）与 CAPTURE_STALLED（:356）。
这一族升级时走 facFacts 分支（GameCanvas.tsx:428-429），**一张票都不铸**
（:475 `withTickets = facFacts ? null : buildFrontEscalationWithTickets(…)`）——
玩家在前哨危机语境下说「派他们去」，模型没有任何 G 号可绑，退化成普通单子；目的地
要么靠模型转写（不可靠），要么全丢。前线家族（UNDER_ATTACK 按战线聚合
reportSignals.ts:206-213、POSITION_CRITICAL、doctrine breach）铸票但**结构上不知道设施**，
票只带 targetFrontId（escalationTicket.ts:66），消费时 ticketDestinationVerdict 分支 3
注入战线（:504-506）→ §8 梯子 → 落在战线现存友军簇，前哨没人管。
「精确目的地压过分档」的优先级确实已在（tacticalPlanner.ts:1349-1352，targetFacility
仅次于 _targetPos；findFacilityPosition:1734 按 id 精确解析）——缺的只是把名字送到那个字段。

### 修法（给设施家族装上完整票据机器；前线家族一个字节不动）

1. `EscalationTicket` 增 `targetFacilityId?: string`（escalationTicket.ts:56-87），铸票冻结。
   前线家族恒不带 → 该族票据字节不变。
2. 新核心入口 `buildFacilityEscalationWithTickets(state, facilityId, situationType,
   rawSignal)`（镜像 :219 buildFrontEscalationWithTickets）：
   - 候选 = `buildReinforceOptions(state, 设施所属战线, anchorOverride=设施坐标)`——
     给 buildReinforceOptions 加可选 anchor 参数（frontEscalationPayload.ts:311-321，
     ETA 量到设施而非 battleAnchorFor；不传时全部既有调用方字节不变）；
   - 诚实闸口径：设施危机无互射钟 → clock=null → 不滤（engaged-unknown 行先例，
     commanderPresence.ts:186-194 注释里的同一原则：缺席的数不许当判决）；
   - **payload 字节不变**（buildFacilityEscalationPayload 原样；ab-capture-stall 全绿是
     硬线）——号只走 ticketPromptLine 进 ---ACTIVE_ESCALATION---（ChatPanel.tsx:1328-1332
     既有管道，零新接线）。v1 里"分支 3 注入顺序改"保留，"payload 加候选块"不做：
     `idle_reinforcement_available` 布尔与候选块并存会造成两个真相源，而只上票据行
     不动 payload 既给了机器把手又不碰面上合同（布尔本身是 F1 家族旧病，登账 §N2）。
3. `ticketDestinationVerdict`（escalationTicket.ts:478-512）分支 3 插一档，位置在
   retreat 档**之后**、targetFrontId 档之前：
   `票据带 targetFacilityId 且该设施活着且 team==="player"` →
   `{ execute, injectTargetFacility: id }`；设施已丢（转敌）→ 跳过走战线档（v1 原文：
   夺回是 attack 语义，另说）。retreat 档在前保证撤退默认落点字节不动
   （ab-retreat-semantics 快照硬线）。verdict 类型加 `injectTargetFacility?: string`。
4. ChatPanel.tsx:1971 旁边一行：`if (verdict.injectTargetFacility)
   intent.targetFacility = verdict.injectTargetFacility;`——镜像 injectTargetRegion 既有
   模式（引擎自己的 id，与该模式同样不过 isValidTarget，合法性在 verdict 档内判）。
5. GameCanvas.tsx:475-499：facFacts 分支改调新入口，`ticketLine` 两族统一携带。
6. R1 若裁定通过：EVENT_CHANNEL_MAP 的 FACILITY_CONTESTED/CAPTURE_STALLED 按
   `是否玩家 keypoint` 分档路由 combat/ops（一处判定，登记合同变更）。若不通过，
   1-5 照做，channel 不动。

### 验收（含负对照；会动兵的全部数 assignedUnitIds + 核坐标）

- **正例（端到端，生产路径）**：造前哨被夺现场（capturingTeam=enemy、progress>0.34 过
  worthiness 闸 director.ts:849-853）+ 同战线别处一坨友军簇 + 线外候选 → 升级 → 断言
  票据带 targetFacilityId；回单 `fromSquad=G#`、无目的地 → resolveIntent → 断言
  assignedUnitIds ⊆ 冻结名单 且 每张 Order 落点 == 设施坐标（不是友军簇坐标——这条是
  对手测病灶的直接负别名）。
- **负对照**：
  ①前线家族危机（POSITION_CRITICAL）→ 票据无 facilityId、verdict 走战线档，修前修后
  行为逐字节同（先钉快照再动刀）；
  ②消费前设施转敌 → 设施档跳过、注入战线（或票据过期语义照旧）；
  ③玩家自己写了目的地 → wroteDestination 路径原样赢（:1939 快照在先）；
  ④defend/hold → in_place 档原样；retreat → 默认落点字节同快照；
  ⑤无铸号路径（bench/心跳）零铸票（TB6 纯度先例）；
  ⑥ab-capture-stall 全绿（payload 字节没动的证明）。
- R1 通过时加：combat 频道上该问句可直接「派」，ops 权限闸行为不变的对照各一条。

### 连带面

设施家族升级从"只能听"变"可点名可派"（这是目的，登记）；ops 频道人格闸拦派单的
现状**不动**（那是 D1/B4 族的账）；前线家族票据、TTL/burn/receipt 机器、§8 各梯子
零改动。已知不闭合的残余：前线家族危机里引擎真不知道设施，票据 mint→consume 之间
战况漂移可致落点从"接火簇"滑到"站桩簇"——登账 §N3，吃刀5 的数据再议。

---

## 刀5 校准记录仪（施工第 5 位；纯仪表，零行为变化）

### 病灶（第 9/10 级要治的，本刀只攒证据）

C1 崩溃钟假崩溃 / C2 战力比四定义 / H5：报"撑1-6秒"实撑30秒+、ETA 偏大 3 倍。
校准要"报的数 vs 实际"配对样本，现在 n=2-3。

### 修法（重推后改道：不走 diagnostics，走 /api/log-event）

v1 说"落一行 diagnostics"——**否决**：`state.diagnostics` 是 50 条环形缓冲
（sim.ts:39-40 等 6 处 push+shift）。精确论证（复核修订 2026-08-07）：PRODUCE_FAIL /
TRADE_FAIL 挤不掉——ChatPanel.tsx:2040 的 diagsBefore 差集读取与 applyOrders 在同一
同步块（:2041-2095），无 tick 可插；**会被挤的是慢消费诊断行**——V4_BARE_CONFIRM_EXEC
（ChatPanel.tsx:2078）这类靠事后导出清点的行，高频仪表进 50 格环即必然驱逐它们。
结论不变：环形缓冲是给稀疏事件的，高频仪表走落盘。改走已有落盘通道
`/api/log-event`（服务端 apps/server/src/index.ts:162；GameCanvas.tsx:501-513 escalate
事件先例，带 SESSION_ID）。

- **预测侧**：核心加纯函数 `calibrationSnapshot(state)`：逐战线读**同一批生产估计器**
  （assessCrisisEscalation 的 exchange.spokenSeconds、freshFrontPowerRatio、top 候选
  etaSec——零新估算，只是结构化转出）。web 侧两处取样：
  ①GameCanvas 升级问句 postQuestion 时（说出口的那一刻，样本最值钱——扩展 :504 已有
  log-event body，加 survival/ratio/eta/G号/facilityId 字段）；
  ②proactiveDirectorState 评估节拍处（GameCanvas.tsx:1848-1855）每拍一行常规样本。
- **结果侧**：核心纯函数 `calibrationOutcomes(state, prevSnapshot)`（先例：
  snapshotForDirector 的 caller-owned snapshot 模式，director.ts:861-868）检测三类事件：
  战线交战段开始/结束、我方投入部队清零时刻（"实际失守"代理）、设施易主时刻；
  票据兑现侧：`burnEscalationTicket` 加盖 `burnedAt` 戳（内存字段，信封不可见），
  每拍对已烧票据查"存活名单半数进入目的地 NAME_RADIUS 内"→ 实际到达时刻，与票面
  etaSec 配对；**顺带记 mint 时 anchor 与 dispatch 实际落点的距离**（给 §N3 攒数）。
- 配对离线做（第 9/10 级读 JSONL），本刀不出任何结论、不动任何公式。

### 验收（含负对照）

- **信封 sha 硬线**：泵帧同一局，记录仪开/关两跑，DigestV1 与 BattleContextV2 全程
  逐字节相同（这是本刀的 T1 断言）。
- 泵帧脚本局（进攻至一线失守）产出：≥1 行带有限 survival 的预测、1 行实际失守时刻、
  ≥1 对票据 eta/实际到达——字段够第 9 级直接算偏差倍数。
- 负对照：记录仪关闭 → 零新 log-event；13 台架全绿（记录仪活在 web 接线 + 两个纯函数，
  台架不经过它）。
- 家法自查：记录的数字与"实际"两侧都可独立重算（谁报的数字另一方必须能重算）。

---

## §N 本次审计新记的账（新账，查过总账本无重复；随收口并进 LEDGER）

| # | 账 | 一句话 | 去向 |
|---|---|---|---|
| N1 | 同名群标签 | 两个空间群贴同一地标/设施会同名（frontEscalationPayload.ts:383 无去重）；tag 落地后更易撞 | 观察账，撞了再立刀 |
| N2 | 设施升级面的说谎布尔 | `idle_reinforcement_available`（director.ts:795）正是第 1 级在前线面上换掉的那类布尔（F1 家族）——"anywhere 有闲兵"≠"这事有可用候选" | 刀1 收口后若手测撞到，按 V1b 先例换候选块，单独立刀 |
| N3 | 前线族票据落点漂移 | mint 时 anchor=接火簇、consume 时重解析可滑到站桩簇（§8"靠构造一致"在时间维上不成立）；疑即本次手测北线场景的另一半机制 | 吃刀5 的 anchor-vs-落点距离数据，第 9/10 级裁 |

（弹药库 regionId 说谎并入刀3 审计交付，不单立账。）

---

## §C 合同变更登记总表（实施时逐条抄进对应 commit message，T1j 先例）

1. 刀3：region 表重切（新表见刀3）；front_center 五 region；frontCenterPos(中央/北线)
   移动；ea_ammo_depot 事件归线改南；原跨战线重叠带/新薄缝内单位归属变化。
2. 刀3：ab-retreat-semantics 受影响快照按合同刷新（逐条注明新旧落点与原因）；
   ab-approval-v4 STRADDLE_INSIDE 等 fixture 坐标重钉。
3. 刀4：nearestPlaceWithin 语义扩（+tag，tag 优先）；Step C 的"禁改本体"就地解禁；
   placeNameAt 塌缩为别名；preflight/候选 label/loc= 全面可出现标记名。
4. 刀2：铸号行格式改 `名[临时编队G#]`、行尾 handle= 废除；digest/JUDGMENT 节头、
   ai.ts 三处格式指称同步；SPEECH_RULE_SITES / CANDIDATE_FACES 登记表同步；
   isTicketRef 接受「临时编队」前缀。
5. 刀1：设施家族升级开始铸票（ticketLine 上线）；verdict 分支 3 增设施档；
   （R1 通过时）keypoint-id 的 FACILITY_CONTESTED/CAPTURE_STALLED 改喊 combat。
   **R1 修订两条旧用户裁定并在此登记**：7c.1-stab A3（CONTESTED→ops，GameCanvas.tsx:110
   注释）与 2026-07-29（STALLED→ops，GameCanvas.tsx:111 注释）；修订依据=新证据
   （ops 人格闸使问句永远答不了「派」）+ keypoint 事件稀疏不淹 combat；
   旧裁定对非 keypoint 事件继续有效。
6. 刀5：新增 log-event 两类记录（calibration_predict / calibration_outcome）；
   EscalationTicket 增 burnedAt 内存字段。零信封、零行为。

---

## 收口路径

五刀各自绿 → 用户手测（看点：①前哨危机跟进单落前哨——盯回执与实际落点不盯台词；
②号贴对人、嘴里念得出「临时编队G#」且引擎认；③中央战线战报与目视一致、原重叠带
交战不再两边认领；④标记点旁的群叫得出名；⑤玩起来无任何新异样，特别是敌 AI 手感）
→ 合 main + tag `envelope-precision-v1-done` + ROADMAP 收口段 + LEDGER 划账 + push。

---

# §O v2.1 增补（Opus R2 审后，Fable 复核裁定 2026-08-07；与正文冲突以本节为准）

Opus R2（`LEVEL8_V2_OPUS_REVIEW_R2_20260807.md`）实证部分 Fable 已抽查承重件复核属实
（服务端丢 `stake`、negctl `failCount>0` 即 OK、:168 西头驻军与 :187 WEST_CLUSTER 是两个
坐标、T1j 期望值来自 fixture 常数、指纹表四条备选、`frontHasFacility` 只认 enemy 设施）。
本节把 R2 的发现折成可施工条款。

## O-1 裁定表 R7-R15（Fable 裁定，待用户随 R1-R6 一并拍板）

| # | 裁定 | 定案 |
|---|---|---|
| R7 | 1925 格归谁 | **补 `northern_coastal_e [316,45,490,55]` 归北线**（Opus 实测：重叠仍 0，开局步兵 #61/#62 留在北线） |
| R8 | y=80 行归谁 | **`central_desert_w` 从 y81 起**；x181-209×y80 一行无主，接受 |
| R9 | 设施危机候选池 | **乙案**：`front=null` + `anchorOverride=设施坐标` + **新增 `excludeNear(设施, FACILITY_GATE.NEAR_RADIUS)` 排除圈**（三参数全可选、默认关、既有调用方字节不变）。比 Opus 甲案多一个排除圈的理由：不排则设施旁正在挨打的守军自己会进候选（自我增援谬误，prompt 规则 [D] 只覆盖 UNDER_ATTACK 消息面不覆盖此面）；排除半径与 payload 的 `nearby_forces_ours` 同一常量＝同一把尺 |
| R10 | 非 keypoint 玩家设施危机频道 | **原则一句：丢了会输的设施归 combat**——即 friendlyKeypoints ∪ headquarters；兵营/机场/修理厂维持 ops。不写设施清单，写判定式 |
| R11 | 新 region 显示名 | 东块留名「中央沙漠」（id `central_desert`，**数组序放在诸新块之前**，保 getRegionCenter 模糊命中确定性）；`central_desert_w`「中央沙漠西段」、`central_desert_s`「中央沙漠南缘」、`minefield_zone_n`「魔鬼花园雷区北段」（南块留原 id+原名）、`northern_coastal_e`「北部沿海东段」。`region.facilities[]` 随断言④重建（见 O-2） |
| R12 | 5 行缝里的敌坦克 #153 | **救**：`ruweisat_zone` 上沿 85→81 接手 + `minefield_zone_n` 南沿 84→80（x276-315×y81-84 由中央东块既有覆盖）。#153 (252,82) 从中央改隶山脊，登记 |
| R13 | 票面锚点 | **要**：anchorOverride 必须同时穿过 mint（`mintEscalationTickets` 接受 null front + 锚点参数；设施票 anchor/etaSec 一律量到设施坐标），否则 payload 与票面两个 ETA 来源——正是 v4 刀1 消灭过的形状 |
| R14 | 中央战线开局变空（敌 14→0、敌设施 1→0） | **接受并登记 + 手测看点**；TF10 的第4档合同 fixture 在测试态内造一个中央线内的敌方非 VP 设施（走生产设施构造路径），不许删牙、不许换弱断言 |
| R15 | 雷区名与画出的雷分家（约 1100 格） | **接受并登记**（`region.passability`/`terrainMix` 全仓无人读，Opus 已证玩法零影响；纯屏上地名与叙事口径） |

## O-2 刀3 修正表（v2.1，取代正文表）与交付物扩充

**最终矩形表**（其余 region 不动）：

| region | v2.1 bbox | 显示名 |
|---|---|---|
| northern_coastal | [200,22,490,44] | 北部沿海 |
| **northern_coastal_e（新）** | [316,45,490,55] | 北部沿海东段 |
| tel_el_eisa | [225,26,260,44] | 北沿海高地 |
| ruweisat_zone | **[230,81,275,115]** | 中部山脊 |
| **minefield_zone_n（新）** | **[261,45,315,80]** | 魔鬼花园雷区北段 |
| minefield_zone | [276,85,315,125] | 魔鬼花园雷区 |
| **central_desert_w（新）** | **[181,81,229,137]** | 中央沙漠西段 |
| central_desert（东块留 id） | [276,80,370,137] | 中央沙漠 |
| **central_desert_s（新）** | [230,116,275,137] | 中央沙漠南缘 |

front_coastal += northern_coastal_e；front_ridge 三区不增不减（ruweisat 扩到 y81）；
front_center = {central_desert, central_desert_w, central_desert_s, minefield_zone,
minefield_zone_n}。实施时先跑重叠脚本证 **跨战线 0 对**、无主格实数登记（预期 ≈340，
最大块 y138-139 两行）。

**刀3 交付物在正文四件之上扩充（全部属刀3，不许推给后面的刀）**：
1. **fixture 重钉清单**（Opus 实测出的全部四处）：T1a 期望 (263,96)→从生产函数重算、
   `WEST_CLUSTER (130,90)`→(185,90)、**:168 西头驻军 (130,90) 同步重钉**（与 WEST_CLUSTER
   是两个坐标，都要动）、`STRADDLE_INSIDE/OUTSIDE (360,138)/(360,143)`→(360,135)/(360,140)；
2. **T1j 的牙重铸**：`meanOfAllX` 不许再写死（现 = 284.5 由 fixture 常数推出）——改为
   **从 state 经生产 front 成员判定重算**，fixture 一塌即红；
3. **negctl 判据钉死**：`ab-approval-v4` 收口从 `failCount>0` 改为**逐条比对 ★ 断言的
   红/绿集合 + 总数 48 钉进台架**（Opus 实测：原推荐表下 6 颗 ★ 牙静默变绿、4 条前置变红，
   台架照打 NEGCTL OK）；
4. **断言④ region.facilities[] 重建**：从 `facility.regionId` 单向派生（唯一真相源），
   台架断言两者一致；今天已陈旧 3 条（三个玩家前哨不在任何清单）。**已证对 enemyAI 零行为
   变化**：唯一消费者 `frontHasFacility`（enemyAI.ts:185-193）只认 enemy 设施，而本刀没有
   任何 enemy 设施换清单（弹药库是 neutral）。
5. **更正一条正文预告**：`ab-retreat-semantics` 五条字节快照 Opus 实测**一字未漂**
   （stdout 与基线逐字节同）——正文与 §C 里"预期会漂、按合同刷新"作废；
   **谁都不许按预期去刷新快照，真漂了才是回归信号**。
   **【已裁 2026-08-07 实施期】**：刀3 落地后 defend/recon/patrol 三条真漂 y76→75，Opus
   按规矩停手上报；Fable 重算证实=R12（ruweisat 85→81）致 front_ridge 中心 75.83→75.17
   的直接算术后果，机制/幅度/波及面三重对齐（只有走到最后一档的三条动，attack/retreat
   提前出梯零字节动）。裁定：**三条按合同刷新（逐条注明旧新落点+R12 因果），R12 不重议；
   attack/retreat 仍逐字节钉死**。R2"零漂"测的是未含 R12 的表，两报告皆对、时序所致。
   本条规矩对后续继续有效：漂了先查因，单因可归+主审签字才许刷。

## O-3 刀1 增补

- R13 落地：mint 侧收 null front 与锚点覆盖；设施票 `targetFrontId` 仍记设施所属战线
  （可为 ""），destination 判档不受影响（设施档在前）。
- R9 落地：候选池 = 全图（front=null）− 设施 NEAR_RADIUS 排除圈；ETA 全部量到设施。
- `CANDIDATE_FACES`（ab-approval-v4.ts:1664-1683，按"文件内第 n 次出现"锚定）：刀1 在
  escalationTicket.ts 新增 `buildReinforceOptions(` 调用会使 nth 键整体错位——同 commit
  更新该表并给新面标 policy（顺手改成按符号/上下文锚定更好，量力）。
- N2 布尔与票据行同屏：收口前加一条"`idle_reinforcement_available` 与候选行不矛盾"的
  断言，或显式登记接受矛盾面。
- 手测看点 +1（Opus (c)1）：前哨问句改喊 combat 后占 combat 的 inFlight/questionBudget
  （全频道共享，GameCanvas:217-234）——**前哨危机在场时战线升级问句还出不出得来**。

## O-4 刀2 增补

- 指纹先于登记表：`RULE_FINGERPRINTS.handle_addressing`（ab-g-knife.ts:1021-1026）四条
  备选里，FRONT_JUDGMENT 节头 / ai.ts:82 / ai.ts:720 三面**只靠 `/handle=G#/` 命中**——
  格式改后断言 C 红在**指纹**，登记表条目本身不动；补新格式指纹（如 /临时编队G#/）。
- `ab-approval-v4` 依赖 `handle=` 字面的**全部 10 行**随格式改（:1117/:1118/:1128/:1139/
  :1180/:1181/:1187/:1188/:1365/:1381，另 :829/:907-908 的 G\d+ 正则复核），
  **不许用放宽断言的方式变绿**。
- **硬约束**：号只进行的拼装，**绝不许拼进 `option.label` / `ticket.label`**
  （ab-front-escalation 的 `endsWith("未编组群")` 三断言在守；label 进回执，污染即双打印）。
- 前缀归一化三处同源：`isTicketRef` / `lookupEscalationTicket`（已 trim+upper）/
  `isKnownForceRef` 用同一个 normalizer，不写三份。
- 登记：9/131 贴错率基线在旧措辞上量的，本刀后作废，重新起点计数。

## O-5 刀4 增补

- **名字回得来（闭环，镜像刀2 前缀条款）**：resolveTarget（tacticalPlanner.ts:1355-1357）
  与 normalizeIntentLocations（:143-146）判 tag 只认 `t.id`——刀4 让信封印 tag **名字**后，
  同刀补 id-or-name 归一（原则一句：**引擎自己印出去的名字，引擎必须认得回来**；数据驱动
  匹配 state.tags，非同义词表）。闭环断言：label 带标记名之后，「把标记点旁边那群调过来」
  解析到 tag 并数得出 assignedUnitIds——不是只断言 label 文本。
- tie-break 更正：**沿用现有"先入者赢"**（strict `<`），不改成 id 序（`tag_10 < tag_2`
  字符串序是坑，且改了就破坏"PLAYER_VIEW 逐字节同"的负对照③）。
- 手测看点：preflight 台词的"来源地"开始出现标记名（好事，但属可见措辞变化）。

## O-6 刀5 增补

- **服务端同刀两修**（Opus 实证今天就在丢 `stake`）：`/api/log-event`（index.ts:162）
  改为透传整个 body 进 `logEvent`（或至少补齐字段清单）；`logEvent`（:75-77）在
  console.log 之外**追加 JSONL 落盘**（按 sessionId 分文件），否则"第 9/10 级读 JSONL"
  不成立。登记：这是服务端可观测性修缮，零游戏行为。
- **sha 硬线换成可执行判据**（Opus 证 13 个台架无一执行 web 层）：核心缝 TB6 式纯度断言
  ——build 双 digest → 跑 `calibrationSnapshot`+`calibrationOutcomes` → 重 build，
  断言逐字节同 + **G 计数器不动**（严禁记录仪路径走带 minter 的 buildDigest）+
  diagnostics 长度不动；浏览器泵帧 sha 对照降为手测步骤。
- `burnedAt` 不得进任何玩家可见文本（回执/日志面检查一遍）。

## O-7 新账并入（随收口进 LEDGER；已查无重复）

| # | 账 | 一句话 |
|---|---|---|
| O4 | 其它 ab-* 的 negctl 同病待查 | `failCount>0` 即 OK 的收口不止一家？逐台架盘 |
| O5 | 常数化的修复前期望（方法资产） | negctl 期望值必须从 state 经生产判定重算，fixture 一塌要红不许同义反复——写进 bench 家法 |
| O7 | getRegionCenter 是第四个"地方"定义 | 与 frontCenterPos / frontDestinationFor / nearestPlaceWithin 并列，且在 resolveTarget 执行链上；将来收敛候选 |

（O1 并入刀3 断言④、O2 并入刀1 施工、O3 并入 R11+手测、O6 并入刀5。）

## O-8 登记补充（进 §C 总表）

**刀3 实施期追加（2026-08-07 裁定）**：ab-retreat-semantics defend/recon/patrol 三快照
y76→75 按合同刷新（R12 因果，见 O-2 第 5 条裁定）；**front_coastal 几何中心东移 36 格
(294,38)→(330,39)**（R7 新块进平均，批 R7 时无人算过——nearestPlaceWithin 的"北部战线"
名点随移，进手测看点）；T1a 按"钉字面值+T1a2 定义级复算"落地（§O-2 字面写法会同义反复，
偏离追认；钉值当场抓到未含 R12 的旧值 273,103→实测 273,102，牙已验真）；
新台架 negctl 红集合=[①③⑤⑥] 四条（⑤缝隙预算对矩形敏感，理应在内）。

getRegionCenter「中央沙漠」目的地随名归东块（旧几何中心东移 78 格，会动兵，登记）；
中央战线开局零敌军零敌设施（R14）；#153 改隶山脊（R12）；屏上多 4 个 region 标签、
2 个旧标签移位（R11+手测）；retreat 快照零漂更正（O-2 第 5 条）；刀2 贴错率基线作废；
region.facilities[] 重建（enemyAI 零行为变化已证）。

---

# §P MVP 提速裁定（用户 2026-08-07 晚；投资人 demo 优先，能跑 > 优雅）

**新次序：fix A/B → 改名刀 → 刀2 → 刀1 → 用户手测 → 合 main + tag。**

**fix B 范围收窄（Fable 裁定 2026-08-07，选项 c）**：只保留 digest ---TAGS--- 名字前置；
ai.ts 那行 tag 指称**回退不改**——emily-guard 抓出它在陈块外的共享面上，且 Opus 证明
该行并未因新印法过时（targetRegion 填 tag_1 的值格式未变，说明书句句属实）——
格式指称 carve-out 的适用前提（"线变了、指称过时"）不成立，无权触碰共享面。
**emily-guard 保持硬线，零例外**；陈嘴不念 tag_1 现押在名字前置的显著性上，收口手测验证，
仍漏则 MVP 后走 D 族正规流程。绊线抓的是主审越界批的一行——记为它的功劳。

**★ 手测 fix 轮（Fable 裁定 2026-08-08，据 LEVEL8_HANDTEST_REPORT_20260808 四笔账）**：
四幕设计目标全达成；合 main 前修三笔——
**H1 粘连引用**（修）：normalizeForceRef 加一档——剥尾号后前缀逐字==那张票自己的 label
才认（覆盖 `名[临时编队G#]` 与 `名G#` 两种粘连形；断言含"前缀对不上的 G 号拒绝"+摘刀）；
**H4 编制队不称临时**（修，**R6 修订 v2**）：判定式——冻结名单==某支活着编制队的**全员**
⇒ 各面印它自己的名与号（Aiden(I1)），任何面不得称「临时编队」；子集/空间群/跨队照 R6
原样；escalation「可以」执行链 T 系合同必须全绿；rider：describeNoHelp「N股」→「N支」+
点名跟随同一身份规则（既有账顺手收，登记）；
**H3 ratio 方向**（修）：三个印 ratio 的面（JUDGMENT 节头/mood 行/reportSignals 百分行）
各补一句方向说明——是定义指称不是说话规则；三面若数字定义不同**只如实标注不归一**
（C2 仍排第 9/10 级）。
**H2 维持 B3 排队**（账面已补执行代价）；§4「附近」嫁接立观察账 D5；
「已不在编」措辞立小账 F6。R6 修订属用户已授权的"措辞手感留盲读后再议"条款兑现。

**★ 绊线两次触发的对照判例（2026-08-07/08，carve-out 的操作定义，后人照此裁）**：
fix B 触发 → 裁 (c) 回退——旧行说的是"值"（tag_1 仍在括号里，句句属实）→ 线变了旧行仍真
→ **不碰**；刀2 触发 → 裁 (a) 授权——旧行说的是"token 的形"（`handle=G#` 全仓绝迹，
字面为假，给模型的指令指向不存在之物）→ **必须随印法更新**。条件：只换形的指称、不加规则
不加例句、commit 逐字引用旧新行、guard 存档追加裁定记录。绊线的职责是逼停待裁，
两次都停对了——这不是例外，是机制在工作。

**缓办（登记不是取消）**：**刀5 记录仪**（对 demo 零可见，本就是为第 9 级攒数据的仪表；
其服务端丢字段修缮 O6 随它缓）；**刀6 地名一致性闸**（跨战线才拦，spec 在对话与 D4 账里，
等改名+刀1 落地后看 D4 还犯不犯再裁）。两者进 LEDGER 排队，收口段如实写"五刀落四缓一"。

**新增 · 改名刀（D4 的 MVP 治法；定名经用户二轮拍板——音译名被否，
改用语音识别友好的常用词，2026-08-07）**：
| 实体 | 旧显示名 | 新显示名 |
|---|---|---|
| ea_miteirya_ridge（敌三号 VP） | 中央山脊 | **驼峰山脊** |
| ea_observation_post（中立雷达） | 中央雷达 | **烽火台** |
| ruweisat_zone（region 名） | 中部山脊 | **乱石岭** |

规矩：**只改显示名，不动任何 id**；旧名全部**追加**进该设施 tags[] 别名表（I2 家法：
加不减，玩家旧习惯与 STT 照旧解析）；玩家侧「中央前哨/中央战线/中央沙漠」不动
（混淆源是敌方侧）；全仓扫台架 fixture 字符串引用旧名处随改（不许放宽断言）；
登记为合同变更（信封各面——SQUADS loc= / 板子 label / VP 名 / 升级 payload——
开始出现新名）。目的：拆掉「中央」命名空间里最贵的两个抓错邻居（D4 2/2 实证）。证据：五刀代码链逐文件
亲读（file:line 已注）、overlap-audit 机器复算、Opus R2 实跑数据（Fable 抽查承重件复核）、
ROADMAP 第 6/7 级收口段、LEDGER_ALL_KNOWN_ACCOUNTS_20260806、v1 提案原文。
