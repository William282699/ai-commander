# UI 简化 V1 · 开工 Plan（Fable 出，待 Opus 审）

> 需求唯一权威＝`UI_SIMPLIFY_V1_HANDOFF_20260814.md`（下称交接档）。
> 本 plan 是对交接档七条的**文件级落点核实＋步序细化**，全部行号已亲手
> grep/读源确认（基线 `9e4f96e`）。审核请按交接档 §3 家法打回。

## 0. 基线与工作区

- main = origin = `9e4f96e`，工作区仅两份根目录文档未入 git（交接档＋本 plan）。
- worktree ＝现有 `AI Commander-voice-input` 目录（.env 已配好，ops=deepseek
  勿动），当前挂 `marcus-brain-swap-v1` @9e4f96e 工作区净（该刀已回滚不搁浅）。
  ★开工＝在该目录里 `git checkout -b ui-simplify-v1`（**不是** `git worktree add`
  新开一棵——写明防止误读"复用目录"）。
- ★worktree 两条旧坑必须踩着走：(1) packages/* 需本地 node_modules symlink
  才可见（记忆档 `reference_worktree_workspace`）；(2) 若跑过 `npm install`，
  staging 前 `git checkout main -- package-lock.json`（`feedback_no_lockfile_in_commit`）。
- 验证家伙什：`scripts/run-benches.sh` **一把跑完就是 25/25**（其第一项就是
  typecheck，不是"typecheck＋24 台架"两样凑数）。
- ★dev 服务写死条目名：**`frame-web`(3025) ＋ `frame-api`(3024)**——两个
  start-frame-*.sh 都 cd 进 voice-input worktree，frame-web 已写死
  `VITE_API_URL=3024`。**名叫 `web` 的条目是 3003、指主仓库 main**：谁顺手
  起它，截的图就是没改过的代码，整步验收作废。每步截图必须来自 3025。
- 步 0 先跑一遍基线 25/25 ＋ 停靠态/弹窗态各截一张"改前"图存档，才动第一刀。

## 1. 代码现场（全部亲核，行号按 9e4f96e）

**一个组件、两套布局**：`apps/web/src/ChatPanel.tsx`（3365 行）同时渲染
停靠态（embedded，L2788-2938）与大弹窗（`?mode=panel` → `isDetached` prop，
detached 分支 L2485-2786；App.tsx:17 解析 URL、App.tsx:143 开窗）。

> ★行号口径（Opus 审后补，步 1 已实证漂移）：本 plan 全部行号＝`9e4f96e`
> 时点快照，**只作证据定位**；每步落地后后续行号整体下漂（步 1 已 +4~+6）。
> **实施落点一律按各步写明的锚点，开工前 grep 拿当轮真值，禁止按行号下刀。**

| 触点 | 弹窗态 | 停靠态 |
|---|---|---|
| `+兵$80`/`+坦$200` | ChatPanel L2714-2727（dp-bottom-dock 内） | L2924-2925（inputContainerStyle 行内） |
| 编队键 | L2764-2772 | L2929 |
| org tree 三列 | L2686（`<OrgTree>`） | L2906（编制 tab，同一组件） |
| UNIT POOL | L2610-2627（unitCounts 建于 L2492-2499） | 无（弹窗独有） |
| 风格五条 | 共享 `chatContentFragment` 尾部 L2454-2480 | 同左（同一段代码两态共用） |
| 麦克风＋输入框 | dp-bottom-dock L2712-2783（页底全宽） | L2922-2932 |

**grep 证据（交接档 §1.3 点名要的）**：`handleProduce` 定义于
ChatPanel.tsx:809，是组件内局部 const，全仓调用方**仅上表四个按钮**
（L2716/2723/2924/2925），无其他引用。Emily 对话造兵走 intent resolver →
produce 合同（`apps/web/src/autoExecuteGate.ts:175` 只是跳过闸门——注意在
web 层不在 packages/core，不经 handleProduce），**砍按钮不断 Emily 的路**。

**OrgTree 关键机理**：三列来自 `ROOT_COMMANDERS` 数组（OrgTree.tsx:46-48）
在 L130 `.map()`；`columnStyle` 是 `flex:1`（L612-621）→ **过滤成一列后
陈自动占满全宽，零 CSS 改动**。停靠编制 tab 与弹窗 org tree 都吃这一处改动。

**风格五条现状**：是只读指示条（span 宽度条，L2461-2477），不是可拖滑杆；
本轮只挪位置＋横排，不改只读性质（如需可调另立需求）。

## 2. 步序（沿交接档 §4 建议，未改序；每步＝改→25/25→两态截图报审→commit）

### 步 1 · 砍 +兵/+坦 两键（热身，两处渲染点）
- 加模块级 `const SHOW_QUICK_BUY = false;`（一行注释注明 round 2 可开回），
  四个按钮包进 `{SHOW_QUICK_BUY && (...)}` 条件渲染。
- **`handleProduce` 保留不删**（仍被条件块引用，typecheck 干净；能力零字节动）。
- 验：弹窗 dock 与停靠输入行两键消失、输入框自然拉宽；Emily 频道说
  "造 2 个步兵" 仍走对话路（一句手测即可）。★此手测是**全 plan 唯一
  真模型调用**（花配额），且必须在 frame-web(3025) 那棵树上做。

### 步 2 · 编队键只在陈的频道（两处）
- render 内加 `const isChenChannel = !isGroupChat && selectedCommanders[0] === "chen";`
  两处 `{onCreateSquad && ...}` 改 `{onCreateSquad && isChenChannel && ...}`。
- 披露：当前在 Marcus/Emily/群聊频道按编队会把新队编给
  `selectedCommanders[0]`（即错的人或群聊首位）——隐藏后此路自然关闭，
  属需求语义内的附带收益。
- ★步序不变量（**步 2 必须在步 3 前，禁调序**）：产生 Marcus/Emily 名下
  分队的只有两条路——GameCanvas.tsx:1115（走编队键 `createSquad(..., owner)`）
  与 OrgTree 跨指挥官拖拽。步 3 藏列后他俩名下的分队将看不见摸不着；
  步 2 先关键、步 3 再关列，两刀互锁不留窗口（初始场景不造分队，
  今日存量为零）。
- 验：四个频道逐一切换看键的有无（陈=有，其余=无），两态都看。

### 步 3 · 编制陈独占（一处改动服务两面）
- OrgTree.tsx 加模块级 `const VISIBLE_ROOT_COMMANDERS: CommanderKey[] = ["chen"];`
  L130 改 `ROOT_COMMANDERS.filter(c => VISIBLE_ROOT_COMMANDERS.includes(c.key)).map(...)`。
  隐藏≠删除：数组加回两个 key 即整体恢复。
- 披露①：拖拽跨指挥官转移的目标列（Marcus/Emily）随列消失——他俩旗下
  本来永远 `(empty)`，此功能实际从未可用于他们。
- 披露②：单列时 `columnStyle.borderRight` 会在右缘多一条竖线，截图难看
  就补一行三元去掉（属步内微调，不另立步）。
- 验：停靠编制 tab ＋ 弹窗 org tree 各一张图，属下名字清晰可读为过。

### 步 4 · UNIT POOL 加 Total Units 行
- 落点按锚点：`dp-unit-pool` 容器内、`unitCounts` 的 `.map(...)` 渲染块之后
  （grep `dp-unit-pool` 拿当轮真值；勿按 L2617 硬记）。追加一行总计：
  `Array.from(unitCounts.values()).reduce((a,b)=>a+b,0)`，
  账本式底部总计行。★样式用修饰类 `dp-unit-row--total`（加粗＋自己的
  分隔线样式）——**不要**在 dp-unit-row 上再叠"顶部细线"：css:1905 的
  `.dp-unit-row + .dp-unit-row` 已自带相邻细线，再加就是双线。
  空池（size===0）时不渲染总计。
- 验：弹窗截图，总数 vs 分类行手加一遍对得上。

### 步 5 · 中栏对掉（最大步，单独 commit）
现状：输入 dock 在页底全宽（dp-bottom-dock），风格条折叠在对话流尾部
（共享 fragment）。目标：dock 上移进中栏对话正下方，风格五条去页底横排。
1. dock 整块 JSX **原样剪切**，落点写死＝**方案 (a)：`.dp-conv-pane` 内部、
   `chatContentFragment` 之后，成为 conv-pane 最后一个子节点**（贴消息流底、
   仍在 comms 边框内；`.dp-chat-scroll` 是 flex:1，dock 自然吃掉自身高度，
   滚动容器零改动）。★层级警告：真实结构是 `dp-col-center > dp-comms
   （display:flex 默认 row，css:1920）> [dp-channel-rail, dp-conv-pane]`——
   若插成 dp-conv-pane 的**同级**，dock 会变成对话右侧第三列，**禁止**。
   备选 (b)＝放 `dp-comms` 之后作 dp-col-center 直接子节点（通栏更宽）；
   若用户看步 5 截图嫌 (a) 窄，reparent 一行换 (b)。
2. ★dock 搬家范围**按锚点不按行号**（行号自步 1 起已漂；此步偏偏是
   "搬错块 --color-moved 也全绿"的一步——搬的确实原样，只是搬错了段）：
   **上界＝`{/* Bottom Dock */}` 注释行，下界＝`data-send-btn` 按钮的
   `</button>` 之后、所在 `</div>` 之前**；开工前先
   `grep -n "Bottom Dock\|data-send-btn"` 拿当轮真值。整块**含
   `SHOW_QUICK_BUY` 条件块——随 dock 一起搬、不许顺手删**：round 2
   弹窗态两键"一开就回"全靠它还活着。容器类名换新 `dp-conv-dock`（game-ui.css 新增，
   不继承 dp-bottom-dock 的 height:72/全宽渐变，按钮沿用 dp-dock-btn
   系列类）。**所有 handler/props 一字节不动**（家法 §3.5），diff 用
   `git diff --color-moved` 自证"纯搬家"。
3. 风格块（L2454-2480）加 `!isDetached` 守卫——停靠态原样保留折叠风格条。
4. 页底原 dock 位置换 `dp-style-bar`：五项（冒险/集火/目标/惜兵/侦察）
   横排一行，每项＝label＋指示条＋数值，数据仍读 `styleSnapshot`，
   无折叠按钮（常显）。`styleSnapshot` 为 null 时整条不渲染（与现状一致）。
   ★五元组抽成 `styleRows` 常量（fragment 上方定义一次），嵌入态风格块
   （L2462-2476）与 dp-style-bar **都读它**——禁抄两份，抄了必漂移。
- 披露：宣战/TTS/发送键随 dock 一起上移（它们与输入框同容器，拆开才是
  改逻辑）；dp-bottom-dock 的 CSS 类保留不删（round 2 可能复用）。
- 验：弹窗态截图（对话→输入一眼连续、页底五条横排）；停靠态截图必须
  证明**零变化**（风格条仍在、输入行仍在底部）；PTT 按住/松开、回填、
  发送各手测一次。
- ★步5 验收补丁（Opus 审定五条，08-14，工单必带）：
  ① 纯搬家自证命令＝`git diff --color-moved=zebra --color-moved-ws=allow-indentation-change`
    （dock 搬进更深层级每行缩进都变，缺 ws 参数会全显新增，逼实施者
    为绿而不敢改缩进）。
  ② 弹窗里 `window.__GAME_BRIDGE__` 是 undefined，要走
    `window.opener.__GAME_BRIDGE__`；风格字段名钉死：冒险=style.riskTolerance、
    集火=style.focusFireBias、目标=style.objectiveBias、
    惜兵=style.casualtyAversion、侦察=style.reconPriority；显示为
    `(val*100).toFixed(0)`，比对用 `Math.round(v*100)`，先读 state 再读
    DOM（styleSnapshot 1Hz 轮询，别跨刷新）。
  ③ 停靠态零变化改成会响的三格断言：▸风格 折叠按钮存在；停靠无
    `.dp-conv-dock` 也无 `.dp-style-bar`；输入框仍在原 inputContainer 内
    且其后紧跟发送键。（R2 守卫加反就藏在这，肉眼比图不会响。）
  ④ 页底新容器必须用 `.dp-style-bar`，禁复用 `.dp-bottom-dock` 当壳——
    否则与"页面已无 .dp-bottom-dock 节点"断言自相矛盾。
  ⑤ 搬家守恒格：搬前搬后 dock 内按钮集合（按 title 取、陈频道下取两次）
    完全相同——无头测不了真语音，集合守恒是最便宜的替代，挡剪切漏带
    PTT/TTS/宣战/发送任何一个。
    **⑤盲区补丁（审核 08-14 晚，验收侧执行不重发工单）**：DOM 守恒只
    覆盖取样时真渲染出来的按钮——`宣战`（canDeclareWar 常 false）与
    `SHOW_QUICK_BUY` 块（常量 false）两次取样都不在 DOM，漏带照样 PASS。
    兜底＝审核侧源码点名：搬完后在 `dp-conv-dock` JSX 块内逐个 grep 到
    七样（SHOW_QUICK_BUY 条件块／input／PTT／TTS／编队／宣战／发送）；
    守恒格 PASS **不得单独充当**"一个都没丢"的证据。同形教训＝
    feedback_verdict_measures_effect（有隐藏状态就断言状态本身）。

## 3. 风险与对策

- **R1 巨文件搬家 diff 噪音**（步 5）：只移动不改写；`--color-moved` 全绿
  为过审条件之一。
- **R2 共享 fragment 守卫加反**：会让停靠态丢风格条——所以步 5 验收硬性
  要求停靠态"零变化"截图。
- **R3 dock 样式进列内挤压对话高度**：dp-conv-dock 用 padding 自适应，
  不定死高度；截图看对话流剩余高度。
- **R4 台架红**＝溢出信号立即停手回看（家法 §3.1），不许"顺手修台架"。
- 全程禁区重申：引擎/prompt/信封零字节；ChatPanel 逻辑不重构；三个动效
  不做（round 2）。

## 3.5 落地台账（滚动更新，收口时并入 ROADMAP）

- 步1 `26a7b5e` / 步2 `9ce45b3` / 步3 `2866b5a`，三步 Opus 审核补审全过（08-14）。
- 实施拓扑实录：实施手＝本窗后台派生的 Opus agent（peer 名 ai-commander-c7），
  审核＝用户的独立 Opus 窗；报审图在实施侧 scratchpad
  `/private/tmp/claude-501/-Users-yuqiaohuang-MyProjects-AI-Commander/7af46070-0c6a-464e-9508-ca31be9f4f61/scratchpad/`，
  跨会话审核要给路径不能靠"发图"。
- 挂账：①真分队场景"树内名字看得清"（交接档 §1.4）——**已销账 08-15**：
  用户真实玩法养出 16 分队/3 级树，零叠字名字全清（步 6 修法在真场景
  站住，比台架 DEEP/WIDE 更硬的样本）；②OrgTree
  `{/* Three columns side by side */}` 旧注释失实，收口随 ROADMAP 带掉；
  ③步3 commit message 勘误入账：停靠三格断言是整页扫的（只有弹窗格圈了
  `.dp-org-container`），不误伤的真理由＝`<img>` 在 OrgTree 只有列头一处
  （`AVATAR_IMG[cmd.key]`），分队节点不产生该形状——记结构理由不记运气。
- 新账①（审核发现）：UNIT POOL `elite_guard`/`commander` 两行走了 `?? type`
  生肉兜底——裁定＝步4 顺手带但**独立 commit（步4b）**，账目不混。
- 新账②（审核白送的判据）：步4 验收断言 Total Units == **85**（外部来源＝
  派兵作用域刀的"85 单位全军"），不许自己加自己对账。
- 步4 `d5e25ad`／步4b `2b15d55` 审核过（08-14）。**防双线记账口径（审核勘误）**：
  真坑不是"两条线"（一个元素只有一条 border-top），是**特异性输掉导致加重
  静默失效**——`.dp-unit-row--total`(0,1,0) 打不过既有相邻组合 (0,2,0)；修法
  `.dp-unit-row + .dp-unit-row--total` 同 (0,2,0) 源序后胜、只改
  border-top-color。LEDGER 入账照此写。
- **全刀能力面盘点（审核，步1-4b）**：唯一实质能力损失＝org tree 跨指挥官
  拖拽转移（步3 披露①、已批）；编队错编他人 bug 路关闭（步2 披露）；造兵
  链实证活（$160 扣款）；步4/4b 纯增零外溢；unitCounts 语义＝我方存活总数，
  与交接档"全体单位总数"对得上。结论：无计划外功能破坏。

- **步5 `b25835d` 交付并 Fable 亲核（08-14 深夜）**：--color-moved(+ws) 证
  moved +77/−77、非 moved +27/−6 四类全预期；守恒格 4钮→4钮；断言 11/11
  （风格五数对引擎 state 逐项同）；七样源码点名全到（含 SHOW_QUICK_BUY
  块与宣战——⑤盲区补丁执行过）；停靠态零变化＝三格断言＋逐像素对比双证。
- **步5 判据修正（实施手发现、Fable 裁定接受）**：「停靠态 ▸风格 按钮仍在」
  这格前提不成立——stash 回基线实测停靠态**从来没有**这颗按钮。既有缺陷：
  GameCanvas.tsx:2374 `getState={() => stateRef.current}` 每 render 换引用 ×
  ChatPanel `[getState]` 依赖 → 1Hz 轮询 effect 反复重建跑不满一拍 →
  嵌入态 styleSnapshot 恒 null（弹窗走 bridge.getState 引用稳定所以正常）。
  守卫方向探针挪到弹窗侧（改前有 ▸风格/改后无，写反立红），会响性不减。
  **新账入 LEDGER：停靠态风格条自始未生效；本刀不修**（修＝停靠态凭空
  多一行，违零变化＋超范围）；将来修法＝稳定 getState 引用（useCallback
  一行），修完停靠风格条会"凭空出现"，属可见变化须过用户眼睛。

- **步6 `0678500` 交付并 Fable 亲核（08-15）**：等分改内容宽＋HorizontalBar
  换 SiblingConnector（每格自画头顶半截、首末免半、天然对齐不量宽）；
  两态两场景 overlap 2/4 对→全 0（负对照先行，DEEP 修前实测正是用户截图
  的 Farrell/Griffin 对）；字号帧率零代价（WIDE scale 与修前逐位同、
  帧测 8.3ms 持平）；端点误差 0px；台架 25/25。
- **病因链修正（实施手实测、Fable 采认）**：plan 原句"AutoScale 从不触发"
  只在 DEEP 成立；WIDE 修前 scale 已 0.71 **却照样叠 4 对**——整体等比
  缩放把重叠一起缩小而已。真正治病＝格子按内容取宽，AutoScale 只是兜底。
- 挂账（步6）：单孩子链（children.length===1）5 次未能活体造出（引擎自动
  挂父/摘孩即拆散），结构同路径但**无活体证据，据实挂账不冒充已验**。
- WIDE 一笔已裁（08-15，先不动）＋阈值化挂账：**同级平铺 ≥8 个时整树
  scale＜0.8、有效字号＜8px（11 个＝0.75/7.1px 实测）**；非步 6 引入
  （修前逐位相同）；真实玩法走嵌套编组不触发；若真游玩撞到，处置方向＝
  **横向滚动取代缩放**（改 AutoScaleColumn 行为、牵连大，单独立刀，
  不塞本刀尾巴——审核补的理由：继续缩放让每张都小，是"做了更差"）。
- 引擎事实（Fable 独立核实 08-15）：分队**深度硬上限 3 级**——
  `squadHierarchy.ts` L233-236 挂载闸（`父深度+被挂子树深度>3` 即拒）＋
  L222-226 提拔闸同规；陈的直属＝第 1 级。属引擎层（packages/shared），
  本刀铁律"引擎零字节"不许碰；要 4 级另立刀，且每多一级同级平铺数成倍涨，
  正撞上一条阈值挂账——3 级 16 分队是甜点区。

- **步7 `7ade215` 交付并 Fable 亲核（08-15）**：三件套全落（领导风格：标签／
  五色底按 index 钉死 cyan-amber-green-purple-yellow／值变闪红 1.2s 退回）；
  判据 15/15 含 **P0-⑦ 0.50→0.53 真实幅度格 PASS**（1326ms 到全红）与
  首载 4.5s 零红；绊索自证＝临时改成 identity 比较 15/15→6/15 立红、
  还原复跑 15/15；负对照 60 帧×4 条零偏离；嵌入态 fragment 逐字节未动
  （209 行 diff 全同）；帧测/台架 25/25。两针预防全兑现＋自加一手：
  `--changed` 用双类 (0,2,0) 压单类底色，**不靠源序取胜**（步 4b 特异性
  教训的正向复用）；flash timer 每条自持 ref、不挂 effect cleanup
  （挂了会被 1Hz 重跑清掉、红色不退——第二个坑）。
- 步7 记账待用户眼睛：`.dp-style-bar__val` 数字文本五条仍同色 cyan
  （本步只改 fill 底色，数字跟色超字面范围未擅动）。

## 4. 收口

五步全过用户眼睛后：tag `ui-simplify-v1-done`，问用户是否合 main＋push
（家法：合并要用户点头），ROADMAP 补收口段，LEDGER 如有新账入账。

## 5. 给用户的三行人话（Opus 过审后发）

1. 砍两个快捷购买键＋编队键只留陈频道——造兵能力不动，走 Emily 对话。
2. 编制树两边（侧栏＋大弹窗）都只剩陈一列占满，弹窗 Unit Pool 底部加总数行。
3. 大弹窗中栏对掉：输入框贴到对话正下方（宣战／朗读／发送键跟它同一排，
   一起上去），风格五条挪到页底横排；每步都有截图给你过目，看完一步
   才走下一步。

## 6. 第二轮·手测修单（步 6／步 7）——待 Opus 审（2026-08-15 追加）

基线＝分支 `ui-simplify-v1` HEAD `b25835d`（步 1-5 全过审）。同 worktree 续做，
工装沿用（frame-web 3025／scratchpad playwright／bridge 接口）。用户手测
挖出两笔，三行人话已过用户（树不叠字挤不下整体缩／排头加"领导风格："／
五条底色蓝橙绿紫黄+值变闪红退回）。步 6 先行（修 bug），步 7 随后。

### 步 6 · org tree 节点重叠修复（只动 OrgTree.tsx）

**病灶链（Fable 亲核 @b25835d）**：
- 兄弟子树 cell＝`flex:1, minWidth:0` 等分父宽（L511 内联＋
  `childrenRowStyle` L646 `width:100%`），不问各支子孙多少——Carter 那支
  两层嵌套摊到 1/5 行宽，卡片塞不下就叠字（用户截图 Farr/Drake 重叠，
  两态同病）。
- 兜底的 `AutoScaleColumn`（L184 包整列，量 scrollWidth>clientWidth 才缩）
  **从不触发**：树内宽度全是百分比，自然宽永远恰好＝容器宽，内容溢出
  发生在 cell 内部、传不到量宽处。
- **修法方向**：等分改"按内容要宽"——子树 cell 改 `flex: 0 0 auto`（或
  min-width: max-content），children 行与中间包装层的 `width:100%` 改
  max-content（最少必要处），让自然宽向上传播、AutoScale 真正量到并整体
  缩放（已有 0.3 下限）。列头（CHEN 卡）保持满宽不动。
- **已知连带**：`HorizontalBar`（L586）端点按等分假设画（halfChild%），
  改内容宽后会偏——按首/尾 cell 实际中心修正或容忍轻偏，截图裁；
  单孩子链（L495 分支）与递归层层包装是回归重点。
- **复现现场（验收核心，零配额）**：bridge 现成接口造——主窗
  `__GAME_BRIDGE__.onSelectUnits(ids)` 选兵→点编队 ×6→`onMoveSquad(child,
  parent)` 嵌套两层→复现叠字。若编队键 enable 不随 bridge 选择刷新，
  探明前置条件后汇报，勿硬闯。
- **判据（会响）**：全部节点卡两两 boundingRect 不相交（pairwise
  overlap==0）；负对照＝修前同场景 overlap>0 存档入报告；拥挤时
  AutoScale transform scale<1 读值实证；停靠＋弹窗两态都跑；台架 25/25。
- **P0-⑥ 可读性下限格（Opus 审定 08-15）**：判据能被"缩到看不清"骗过——
  scale 下限 0.3（L549）时字成马赛克、包围盒照样不相交。补格：最终渲染
  字号（font-size × 累计 scale）**≥ 8px**（或 scale ≥ 0.6），实测 scale
  写进报告。overlap==0 管"不叠"、字号下限管"看得清"（交接档 §1.4
  "属下名字要看得清楚"从步 3 挂账至今未验，勿用叠字判据冒充它）。
- **P1-⑥ 帧测**：AutoScaleColumn 的 effect 无依赖数组（L538-558 每次
  render 都跑，rAF 里写 transform 再读宽＝每次渲染强制同步重排整棵树），
  树改宽后重排更贵。要求：开弹窗量 rAF 帧间隔，修前修后各一次粗测入报告；
  明显变差停手汇报。**禁顺手给该 effect 补 deps——那是重构，另一刀。**
- 回归补点：单孩子链（L495）不走 HorizontalBar，其竖线居中也吃
  width:100%，改宽度模型后须验。

### 步 7 · 风格条三件套（弹窗侧独有；嵌入态 fragment 零字节不动）

现场 @b25835d：`dp-style-bar` JSX＝ChatPanel L2807-2816（fill 单色 cyan）；
`styleRows` L2276 单一来源（**保持共享，勿动**）。

1. **排头标签**：`dp-style-bar__title`「领导风格：」，不参与五条均分。
2. **五条底色钉死**：冒险=`--hud-accent-cyan` #00d4ff／集火=
   `--hud-accent-amber` #f0a030／目标=`--hud-accent-green` #00e070／
   惜兵=紫 #8b5cf6／侦察=黄 #fbbf24（紫黄无现成 token，新增
   `--hud-accent-purple`/`--hud-accent-yellow`，additive）。
   **红 #ff3040 不入底色——专职"刚变过"**。颜色映射另立 detached 侧
   局部表（按 key），styleRows 不动；嵌入态折叠条维持原样不碰
   （反正 styleSnapshot 恒 null＝已入账缺陷，别顺手修）。
3. **值变闪红（真状态驱动，先例＝刀C 🔴 真收音才亮）**：已有 1Hz
   styleSnapshot 轮询，加 prevRef 对比；变的 key 记 flash 到期时刻，
   该条 fill 加 `--changed` class；CSS `.dp-style-bar__fill--changed
   { background: var(--hud-accent-red) }`＋fill 常态 `transition:
   background ~0.6s`→class 移除自然退回底色；窗口 ~1.2s；
   **首拍（prev==null）不闪**；逻辑只挂 detached 渲染路径。

**判据**：(a) 五条底色 computed 逐条对表；(b) 闪红实测＝脚本直接改引擎
state（主窗 `__GAME_BRIDGE__.getState().style.riskTolerance = 0.75`），
≤2s 冒险条变红、值文本 50→75，~1.5s 退回 cyan，**其余四条全程底色不动
（负对照）**；(c) 首载 2s 内无红（首拍不闪格）；(d) 停靠态零变化三格照抄
步 5；(e) flash 重渲染期间输入框可持续打字（焦点不丢格）；台架 25/25。
- **P0-⑦ 真实幅度格（Opus 审定 08-15）**：真实变化＝±STYLE_LEARNING_RATE
  = **0.03**（constants.ts:156，handleApprove style learning 段 L2204-2213，
  砍卡后 auto 路径每条产单命令都走）——玩家真实看到的是 50→53，不是
  50→75。补格：**0.50→0.53 也必须闪**，防 epsilon/阈值实现漂过大跳格、
  在真实幅度上一次不闪（同形教训＝第一机制陷阱要对齐幅度与终点）。
  闪红的功能理由一并入档：3 个百分点的条宽肉眼不可见，闪红是它被看见的
  唯一手段，非装饰。
- 前提已核（审核 08-15）：`getState()` 返回 stateRef.current **活引用**
  （GameCanvas:1172），脚本改入真生效；全仓 style.* 唯一写入口＝
  updateStyleParam，无每 tick 覆盖，改入值不会被引擎抖掉。
- **两针预防（审核 08-15 放行时补，开工前带上）**：①颜色表**按下标
  做 key 不按中文 label**——styleRows 的 string 是显示文字，绑措辞＝
  将来改一个字颜色静默错位，且五条底色无断言能发现串位；顺序固定
  r/f/o/c/s，index 映射最稳。②**prevRef 比值不比对象**——1Hz 轮询每拍
  `setStyleSnapshot({...})` 新建对象，比 identity 每秒闪一次红；
  判据 (c)"首载 2s 无红"正是这条的绊索，那格不许省。

### 家法照旧
步 6／步 7 各一笔 commit；只动点名文件（步6=OrgTree.tsx，步7=ChatPanel.tsx
＋game-ui.css）；锚点不按行号；意外停手汇报；不 push／合 main／tag；
每步截图用户过目后走下一步。
