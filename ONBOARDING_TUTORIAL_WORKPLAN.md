# 新手教程（Onboarding Tutorial）— 工程 Workplan（v5，已纳入 codex 第 1+2 轮 review + 用户口径修订 + 建议采纳）

> **给审核者（codex）的说明**：本文档是待实现功能的工程方案，供冷读审核。
> 目标：给 AI Commander 的 El Alamein 局加一个**进图后弹出、可跳过、计时未开始**的
> 讲解式新手教程。所有机制断言附 `文件:行号` 证据。
> **v2→v3 纳入 codex 第 2 轮：修正 loop 守卫边界(P0) + transient-input cleanup 位置(P1) + 可选全局 handler 守卫**，详见 **§10**。
> **v3→v4 纳入用户口径：Marcus 只分析局势/给建议，不教执行/JSON；编制树可合并分队 / 建上下级；阵型教学更显式**，详见 **§11**。
> **v4→v5 采纳用户建议：步 6/7 对调（先编队、再编制树）；术语 troop→分队、commander 栏→参谋栏；修正重编号 stale**，详见 **§12**。
> 通过后实现者按 **§6** 在本 worktree（`worktree-onboarding-tutorial`，base=main `8f90920`）上逐步改代码。

---

## 背景与范围

- **项目**：chat-driven RTS，玩家主要通过 Chen 执行战斗命令、Emily 执行后勤/生产命令；Marcus 用来分析局势、给建议。
- **唯一目标场景**：`el_alamein`（沙漠地面战，30 分钟限时）。
- **本次范围**：一个**讲解式**（show-&-tell）教程 overlay —— 进图后盖在冻结地图上，分屏讲 12 件事，每屏「跳过 / 上一步 / 下一步」，最后「开始作战」才启动模拟与计时。
- **明确不做**：❌独立教学关卡 ❌动手式（不检测玩家真操作）❌LLM 实时 brief ❌碰引擎/schema/server（见 §0）。

### 为什么是讲解式 overlay
最初方案 A（advisorTrigger 加定时 LLM brief）+ B（静态 IntroScreen）被废，pivot 成单一讲解 overlay：
**`advisorTrigger.ts` 完全不碰**，core/shared/server 零改动，只动 `apps/web/src` 3 文件。

---

## §0 铁律（HARD CONSTRAINTS）

### 0 改动
| 对象 | 原因 |
|---|---|
| `packages/core/**`（含 advisorTrigger / sim / combat / fog / economy / defensiveAI / pressureDirector / autoBehavior / enemyAI / reportSignals / warPhase / tacticalPlanner / formation） | 引擎 + 5C-lite baseline，讲解式不需要任何 core 改动 |
| `packages/shared/**`（types/schema/squad/constants/scenario） | schema 不扩、地名/胜负/部署不改 |
| `apps/server/**`（SYSTEM_PROMPT / /api/brief） | LLM 链路全不动 |

### 只允许改 3 个文件（全在 `apps/web/src`）
1. **新建** `TutorialOverlay.tsx`
2. `App.tsx`（scenario gate + 传 `paused` + 条件渲染 overlay）
3. `GameCanvas.tsx`（加 `paused` prop + `pausedRef` 同步/清理 effect + loop 守卫）

### 其他
- **scenario 隔离**：教程仅 `?scenario=el_alamein` 弹；其他场景 `tutorialActive=false`、0 感知。
- panel 模式（`?mode=panel`）由 App 现有 early-return（`App.tsx:64`）天然隔离，panel 不弹教程。
- 不引新依赖、不改 build/deploy。
- **🔒 非破坏保证（用户强调"不破坏现有链路/结构"）**：`paused` 默认 `false`；为 false 时 loop / 全局 handler 行为与现状**逐字节一致**。非 el_alamein 从不暂停。unpause cleanup 只重置**瞬时 UI 输入**（InputState），**不碰 GameState / 引擎链路 / LLM**。
- **删除铁律**：移除教程 = ①删 `TutorialOverlay.tsx` ②删 App gate ③删 GameCanvas 的 `paused`/`pausedRef`/守卫。3 步、不影响其他系统。

---

## §1 架构（数据流 + 关键实现约束）

```
App.tsx（main，非 panel）
  scenarioId = URLSearchParams.get("scenario")==="el_alamein" ? "el_alamein" : "dual_island"   // 复用 GameCanvas 同款判定
  const [tutorialActive, setTutorialActive] = useState(scenarioId === "el_alamein")
    ├─ <GameCanvas paused={tutorialActive} ... />
    └─ {tutorialActive && <TutorialOverlay onStart={() => setTutorialActive(false)} />}
  「开始作战」/「跳过」→ setTutorialActive(false)
     → GameCanvas 检测 paused 转 false：清 transient input（§1 P1）+ tick 启动、time 从 0 累加
```

### 🔴 P0-1：`paused` 守卫边界（v2→v3 修正）
GameCanvas 的 rAF loop（`useEffect([],...)`）实测结构（证据 `GameCanvas.tsx`）：
- **非渲染逻辑 :878 → :1417**：front-jump 热键(:878-895)、pendingTag→命名框(:964)、rightClickCommand→`applyPlayerCommands`(:971-1058)、`tick`(:1062，**唯一推进 state.time**)、`processEconomy/Report/BattleMarkers`(:1065-1071)、`processAdvisorTriggers`+**/api/brief**(:1077-1140)、`checkDoctrines/updateGamePhase`(:1143-1168)、**heartbeat /api/brief**(:1370-1417)。
- **渲染段 `// --- Rendering ---` :1419 → :1535**：清屏+地形(:1420-1424)、front/route/region 标签(:1432-1438)、设施(:1444)、迷雾(:1448)、tag(:1452)、单位(:1455-1466)、战斗特效(:1469)、battleMarkers(:1472)、选择框(:1475-1483)、小地图(:1489-1500)、info panel(:1502-1533)、`raf(loop)`(:1535)。

**守卫**：`if (!pausedRef.current) { …:878 → :1417 整段… }`；**整个渲染段 :1419 → :1535 + raf 留在守卫外**。
⚠️ v2 误写成 878→1440（把 :1419-1440 的清屏/地形/标签划进守卫）→ 教程首帧黑屏/半帧。**v3 改为闭合在 :1417、render 从 :1419 起全部在外**。
两处 `/api/brief`（:1127 advisor、:1377 heartbeat）都在守卫内。冻结态 render 现有 state 即可（battleMarkers/combatEffects 不更新也能画静帧）。

### 🔴 P0-2：用 `pausedRef`，不要让 loop 闭包读 prop
loop 在 `useEffect([],…)` 里，闭包**读不到**后续 prop 变化；直接读 `paused` 会导致 true→false 后**永远暂停**。
`lastTime = now`(:876) **每帧都执行（含暂停帧）**，配合 dt cap 0.05(:875)，避免 unpause 后首帧吃大 dt。

### 🔴 P0-3：overlay z-index
现有层级：ChatPanel `zIndex:100`（`ChatPanel.tsx:2137`）、context menu `150`、dialog/gameover `200`（`game-ui.css:1224/1271`）。
教程层 **`position:fixed; inset:0; zIndex:1000`**（≥300，盖住一切），半透明 dim + 居中内容卡；overlay 捕获全部鼠标/滚轮 → 教程期相机/选择/下令天然冻结（与 P0-1 双保险）。

### 🟡 P1：unpause 清 transient input（在 GameCanvas 内部，App 拿不到 inputRef）
`pausedRef` 同步 effect 顺便在 `paused` 转 false 时清 `inputRef.current` 的瞬时输入，避免教程期残留键/选择/标记在开局首 tick 被消费（codex 二轮 P1）：
```
const pausedRef = useRef(paused);
useEffect(() => {
  pausedRef.current = paused;
  if (!paused) {                 // 仅 true→false（开始作战）；非 el_alamein 挂载即清=空操作无害
    const i = inputRef.current;
    i.keys.clear();
    i.selectedUnitIds = []; i.isSelecting = false; i.selectionComplete = false;
    i.pendingTag = null; i.rightClickCommand = null; i.frontJumpRequest = null;
    i.tagMode = false; i.escPressed = false; i.returnToAIPressed = false;
  }
}, [paused]);
```
以上 10 字段均为现存 InputState（`input.ts:52,62,65,70,71,74,77,78,81,82`）。**cleanup 写在 GameCanvas，不扩 App↔GameCanvas 接口**。

### ⚪ 可选：教程期"零副作用"的全局 handler
以下 handler 是独立 keydown listener、不在 loop 守卫内，可在顶部加 `if (pausedRef.current) return;`：
- **Shift+D**（`GameCanvas.tsx:497-538`，注入 synthetic DOCTRINE_BREACH）→ **建议加守卫**（否则教程期可能污染消息/危机流）。
- **M 静音**(`:551-558`)、**ambient 首次手势**(`:540-543`)：纯音效、无战局副作用，加不加随意（默认也加，求干净）。

---

## §2 State / 持久化
- `tutorialActive`：App `useState`，初值 = `scenarioId==="el_alamein"`。
- **不引入 localStorage `firstGameSeen`**（v1）：每次加载 El Alamein 都弹 + 顶部「跳过」覆盖重玩。"再来一局重弹教程"先不做（避免跨组件回调，codex polish）。
- 不新增任何 GameState/schema 字段。

---

## §3 文件改动清单
| 文件 | 改动 | 估行 |
|---|---|---|
| **NEW** `TutorialOverlay.tsx` | overlay（fixed 全屏 z1000 dim + 卡片）+ 12 步内容 + 跳过/上一步/下一步/开始作战 + 进度点 | ~210 |
| `App.tsx` | scenario URL 判定 + `tutorialActive` + `<GameCanvas paused=.../>` + 条件渲染 overlay + `onStart={()=>setTutorialActive(false)}` | ~18 |
| `GameCanvas.tsx` | 加 `paused?:boolean` prop + `pausedRef` 同步 effect（含 unpause 清 10 个 transient 字段）+ loop 守卫（:878→:1417，render :1419→:1535 在外）+（可选）Shift+D 等 handler 守卫；默认 false → 行为与现状逐字节一致 | ~15 |

样式复用现有 HUD class（`hud-dialog`/`hud-btn` 等），不新增全局 CSS。

---

## §4 已核实机制证据（教程据此而写）
| 教学点 | 真实机制 | 证据 |
|---|---|---|
| 胜负 | 30min；夺 4 个轴心据点中 3 个胜；3 前哨全丢败；6 档评分 | `scenario/elAlamein/index.ts:146-159` |
| 顶栏 | MONEY/FUEL/AMMO/INTEL/READINESS + OBJECTIVES/POSTS LOST/TIME LEFT | `App.tsx:163-236` |
| 地图操作 | WASD / 边缘滚动 / 滚轮缩放 / 中键拖动 / 数字键 1-5 跳战线 / 小地图点击跳转 | `input.ts:3-4,133-135,172-182,238-242,208`；`GameCanvas.tsx:878-895`；minimap 渲染 `:1489`、`rendererCanvas.ts:695` |
| 弹出面板 | 「弹出面板 ↗」/「收回面板」 | `App.tsx:130-143,203-210` |
| 3 参谋 | Chen=combat(红)=战斗执行；Marcus=ops(蓝)=**分析局势/给建议，不教执行/JSON**；Emily=logistics(绿)=后勤/生产 | `messageStore.ts:19-21`、`ChatPanel.tsx:50-52`；Marcus 口径为用户确认的教程/产品约束 |
| 将军树 | **右侧面板「编制 🏗️」tab**（`activeTab:"chat"\|"org"`），**非左侧**；拖一个分队到另一个分队上=当下级（`onMoveSquad`）；拖到某参谋栏=转移/脱离上级（`onTransferSquad`/`onRemoveFromParent`）；跨 commander 先 transfer 再挂下级 | `ChatPanel.tsx:453,2077,2085`；`OrgTree.tsx:135-146,420-431`；`squadHierarchy.ts`；`types.ts` |
| 编队 | 框选未编队单位 → 点「编队」按钮（归当前参谋），`canCreateSquad` 轮询启用 | `ChatPanel.tsx:1948-1955,618-624` |
| tag 加 | 按 `T` 切模式 → 点地图 → **弹命名框，输入名 +Enter** 才建（非自动 tag_1）；ESC 退出 | `input.ts:138-141,218-223`；`GameCanvas.tsx:964,1603-1632`（Enter :1620） |
| tag 删 | 右键旗 → 菜单「删除」 | `GameCanvas.tsx:1679-1692` |
| 下命令-文字 | 对话框输入 | `ChatPanel.tsx:2110` |
| 下命令-语音 | **按住 🎤 按钮说话、松开发送**（PTT，onPointerDown/Up） | `ChatPanel.tsx:2111`（"按住说话"/"松开结束录音并发送"） |
| TTS | 🔊/🔇 朗读开关（参谋回复读出来） | `ChatPanel.tsx:2112,1945-1946` |
| 阵法(4) | line横队/wedge楔形/column长蛇/encircle合围 | `formation.ts:9` |
| 命令动词 | move/attack/hold/patrol/escort/recon/sabotage/produce/trade | `schema.ts:14-21` |
| **生产落点** | 全为地面兵 → 在 **「我军兵营」**（`ea_player_barracks`，后方(410,75)）旁可通行地砖产出（半径80）；不是到前线 | `economy.ts:248-278`；`constants.ts:165-168`(ground→barracks)；`mapData.ts:211-216` |
| 敌我 | 我方蓝(东) British；敌方红(西) Rommel；西侧 4 objective | `deployment.ts:116-255` |
| 兵种(本局实际) | 步兵/轻坦/主战坦克/火炮（+elite_guard/commander）。**无海军空军** | `deployment.ts` 全文 |
| 战争迷雾 | fog(5A)，视野有限；`recon`/派部队揭图 | `index.ts:67` |

---

## §5 教程内容（12 步，定稿 · 简洁傻瓜语言）
> 每屏底部「跳过教程 / 上一步 / 下一步」；末屏「下一步」→「**开始作战**」。

**1 ｜ 欢迎 + 你的目标**
长官，欢迎来到阿拉曼前线。**30 分钟内，从敌人手里夺下 4 个据点中的 3 个**就赢；你的 3 个前哨全被打下来就输。先花一分钟认认战场。

**2 ｜ 顶上这排数字 = 你的家底**
💰钱 造兵 ｜ ⛽油 坦克要跑 ｜ 🔫弹 打仗要用 ｜ 🛰情报 看得更远 ｜ ⚡战备 部队状态。右上角随时看：夺了几个据点、丢了几个前哨、还剩多少时间。

**3 ｜ 怎么看战场、怎么动镜头**
移动视角：**WASD** 或鼠标移到屏幕边缘 ｜ 缩放：**滚轮** ｜ 平移：**按住鼠标中键拖** ｜ 跳到某条战线：**数字键 1-5** ｜ 总览全局：点**右下角小地图**任意位置直接跳过去。

**4 ｜ 嫌挤？把对讲面板拉出去**
右上角「弹出面板 ↗」把跟参谋对话的窗口单独拉出来放另一个屏幕；不要了点「收回面板」。

**5 ｜ 你手下有 3 个参谋**
三个参谋分工不一样：
🔴 **Chen（战斗）**负责执行打仗、进攻、防守 ｜ 🔵 **Marcus（参谋）**只帮你分析局势、给建议，不负责直接派兵执行 ｜ 🟢 **Emily（后勤）**负责补给、造兵、油弹

**6 ｜ 把零散的兵编成一队（分队）**
地图上框选一批兵 → 点「编队」按钮，他们就成一支**分队**，归当前参谋。编了队，一句话指挥一整队，不用一个个点。

**7 ｜ 编制树：合并分队、安排上下级**
点**右边面板的「编制 🏗️」标签**，能看到你所有部队归谁管。你可以把一个**分队**拖到另一个**分队**上，让它当下级/下手；也可以拖回某个参谋那一栏里拆开。简单说：这里是整理部队结构的地方。

**8 ｜ 在地图上插旗做记号（tag）**
想让部队去某个具体位置，先做记号：**按 `T` → 在地图上点一下 → 弹出命名框，打个名字（比如 tag_1）按 Enter**。之后就能跟参谋说「派一队去 tag_1」「守住 tag_1」。不要了：**右键那面旗 → 删除**。（Esc 退出插旗模式）

**9 ｜ 给参谋下命令 + 阵型怎么说 + 造的兵在哪**
**打字**：对话框输入。**语音**：按住 🎤 按钮说话、松开发送。想让参谋回复被读出来，点 🔊 开关。
大白话说你想干嘛：「Chen 带主力打中路据点」「Marcus 帮我判断先打北线还是中线」「Emily 造 5 个步兵」「派一队去西边侦察」。
还能指定**阵型**：**楔形阵**适合冲锋突破；**长蛇阵**适合沿路走/穿窄路；**横队**适合铺开防守或正面推进；**合围**适合包住敌人打。
⚠️ **造的新兵在哪**：让 Emily 生产后，新部队在你后方的「**我军兵营**」旁边出现（不是凭空到前线），记得把他们调上去。

**10 ｜ 哪些是敌人、哪些是我的**
🔵 蓝色=你的（东边）｜🔴 红色=敌人（西边，Rommel 的部队）。西边那 **4 个带标记的据点**就是目标，抢到 3 个就赢。

**11 ｜ 你有哪几种兵**
**步兵** 便宜灵活、占点守点 ｜ **轻型坦克** 跑得快、侦察抄侧翼 ｜ **主战坦克** 皮厚火力猛、正面硬刚 ｜ **火炮** 打得远、躲后面、怕近身。

**12 ｜（可选）看不见的地方要侦察**
地图灰蒙蒙的是你看不到的（战争迷雾）。派部队过去、或下「侦察」命令，就能揭开看清敌情。

**结尾**：就这些，打起来就懂了。点「**开始作战**」，计时开始 —— 祝你好运，长官。

---

## §6 实现顺序（iterative，一步一测一停，遵守 feedback_iterative）
> 每步：改 → `typecheck`+`build` 必过 → 手测 → **停，不 commit/push/tag**，等用户 OK。

- **Step 0（环境）**：本 worktree 缺 `node_modules`。按 `reference_worktree_workspace.md` 装/建 symlink；若 `npm install`，stage 前 `git checkout main -- package-lock.json`（`feedback_no_lockfile_in_commit`）。
- **Step 1（合并，codex 建议）**：GameCanvas `paused`+`pausedRef`(同步+unpause cleanup)+守卫(:878→:1417) **同时** App scenario gate + 极简 overlay 骨架（dim + 「跳过 / 开始作战」）。
  手测：① el_alamein → 进图地图可见、时钟不动、点击/滚轮无效；点「开始作战」→ sim 跑、计时从 0 起、无残留选择/tag。② dual_island → 不弹教程、正常开打（验非破坏）。
- **Step 2**：填 §5 全部 12 步文案 + 样式 + 上一步/下一步/进度点。手测：完整走一遍、文字正确、可前后翻、跳过有效。
- **Step 3**：polish —— （可选）Shift+D/M/ambient handler 加 `pausedRef` 守卫；最终回归。

---

## §7 风险 / 验证
- **render 与 sim 解耦**：守卫闭合在 :1417、render 段 :1419→:1535 全在守卫外（否则黑屏/半帧）——Step 1 手测兜底。
- **两处 /api/brief 都在守卫内**（:1127 / :1377）——教程期零 LLM 调用。
- **transient input 清理**：在 **GameCanvas 的 `[paused]` effect**（非 App）于 unpause 时清 keys/selectedUnitIds/isSelecting/selectionComplete/pendingTag/rightClickCommand/frontJumpRequest/tagMode/escPressed/returnToAIPressed（codex 二轮 P1）。
- **全局 handler 副作用**：Shift+D 可注入危机（建议守卫）；M/ambient 无战局影响（§1 可选）。
- **scenario 隔离**：dual_island 必跑一局验 0 感知。
- **panel 模式**：App `?mode=panel` early-return（:64）在 gate 之前，panel 不受影响——Step 1 顺手验。
- **相机冻结**：MVP 教程期完全冻结交互（overlay 捕获全部输入 + 守卫），只展示静态地图。
- **非破坏**：`paused=false` 时 loop/handler 与现状逐字节一致（§0 非破坏保证）。

---

## §8 决策（已定）
| # | 决策 | 现方案 | 备注 |
|---|---|---|---|
| 1 | tag 位置 | 单独步 8（编队/编制树后、下命令前） | 用户原放 topic4，逻辑挪此更顺 |
| 2 | 第二局自动跳过 | **不做**（每次弹+跳过键） | codex polish 同意 |
| 3 | 高亮保真度 | **纯文字卡**（dim+卡片） | spotlight=未来项 |
| 4 | 相机/交互 | 教程期**完全冻结**，只看地图 | codex polish |
| 5 | 步 3 地图操作 / 步 9 生产落点 | **已加入** | codex P1 + 用户补充 |
| 6 | 步 12 迷雾 | 标"可选"，默认含 | 可砍 |

---

## §9 修订记录 —— codex 第 1 轮 review 纳入
| codex 项 | 处置 | 落在 |
|---|---|---|
| P0-1 守卫要包输入/命令/模拟/报告/LLM | ✅（边界 v3 再修正） | §1 P0-1 |
| P0-2 prop 闭包陈旧 → ref + 每帧 lastTime | ✅ | §1 P0-2 |
| P0-3 overlay fixed 全屏 z>300 | ✅ z1000 | §1 P0-3 |
| P1 App 复用 `?scenario=` 判定 | ✅ | §1/§3 |
| P1 缺地图/小地图操作 | ✅ 新增步 3 | §5-3/§4 |
| P1 "左边将军树"→右侧「编制」tab | ✅ | §5-7/§4 |
| P1 tag 实为命名框+Enter | ✅ | §5-8/§4 |
| P1 语音=按住🎤、🔊/🔇 朗读 | ✅ | §5-9/§4 |
| P1 Step1/2 合并 | ✅ | §6 |
| polish 清 transient / 相机冻结 / 不加 localStorage | ✅ | §1/§2/§7 |
| 用户补充 生产落点 | ✅ | §5-9/§4 |

## §10 修订记录 —— codex 第 2 轮 review 纳入
| codex 项 | 处置 | 落在 |
|---|---|---|
| **P0** 守卫边界写错（render 从 :1419 起，v2 的 878→1440 切进 render → 黑屏/半帧）| ✅ 守卫闭合 **:1417**；render **:1419→:1535** 全在外 | §1 P0-1 |
| **P1** App 拿不到 inputRef，cleanup 应在 GameCanvas | ✅ 移到 GameCanvas `[paused]` effect，unpause 清 10 个 InputState 字段 | §1 P1 / §3 / §7 |
| 可选 全局 handler（Shift+D/M/ambient）不在守卫内 | ✅ 列为可选；建议 Shift+D 加 `pausedRef` 守卫（防危机流污染），M/ambient 随意 | §1 可选 / §7 |
| 用户：不破坏现有链路/结构 | ✅ 新增"非破坏保证"（paused=false 逐字节一致） | §0 |

---

## §11 修订记录 —— 用户口径修订纳入
| 用户口径 | 处置 | 落在 |
|---|---|---|
| Marcus 不管调度，只分析局势、提供建议；不教玩家把 Marcus 当 JSON/执行通道 | ✅ 第 5 步改为"Marcus（参谋）只分析/建议，不直接派兵执行"；第 9 步示例改为"Marcus 帮我判断..." | §4 / §5-5 / §5-9 |
| 将军树可以合并分队、指派下手 | ✅ 第 7 步「编制树：合并分队、安排上下级」，拖一个分队到另一个分队上当下级/下手 | §4 / §5-7 |
| 阵法教学要明确 | ✅ 第 9 步显式列出楔形阵、长蛇阵、横队、合围各自用途 | §5-9 |

---

## §12 修订记录 —— 用户建议采纳（v4→v5）
| 建议 | 处置 | 落在 |
|---|---|---|
| 步 6/7 顺序：先编队(创建分队)、再编制树(整理) | ✅ 6↔7 对调：步6=编队、步7=编制树 | §5-6 / §5-7 |
| 术语 "troop"→"分队"、"commander 栏"→"参谋栏"（与「编队」按钮口径一致） | ✅ 步6/7 + §4 + §11 全改 | §5 / §4 / §11 |
| 修正重编号 stale | ✅ §8 tag 步7→步8；§9 编制 tab §5-6→§5-7、tag §5-7→§5-8 | §8 / §9 |

---

## 附：核实命令（可复跑）
```
sed -n '146,159p' packages/core/src/scenario/elAlamein/index.ts        # 胜负
sed -n '875,896p' apps/web/src/GameCanvas.tsx                          # dt/lastTime/front-jump
sed -n '1417,1421p' apps/web/src/GameCanvas.tsx                        # 守卫闭合点 :1417 / render 起点 :1419
sed -n '1452,1456p' apps/web/src/GameCanvas.tsx                        # renderTags/renderUnits 在 render 段
sed -n '1603,1635p' apps/web/src/GameCanvas.tsx                        # tag 命名框
sed -n '52,82p' apps/web/src/input.ts                                  # InputState transient 字段
sed -n '497,558p' apps/web/src/GameCanvas.tsx                          # Shift+D / M / ambient 全局 handler
sed -n '2077,2090p' apps/web/src/ChatPanel.tsx                         # 编制 tab
sed -n '2111,2112p' apps/web/src/ChatPanel.tsx                         # PTT + TTS
sed -n '248,278p' packages/core/src/economy.ts                        # 生产落点
sed -n '211,216p' packages/shared/src/scenario/elAlamein/mapData.ts   # 我军兵营
```
