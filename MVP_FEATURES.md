# AI Commander — MVP 功能总表

> 最后更新：2026-03-17 | Phase 2.5 完成
> 技术栈：React 18 + Canvas 渲染 + TypeScript + Vite + DeepSeek LLM

---

## 一、项目定位

**AI Commander** 是一款实时战术指挥游戏。玩家不直接操控单位，而是通过**自然语言**向三位 AI 参谋下达命令（"T1 去攻占中央城区"），由系统自动解析为战术意图并分配兵力执行。核心体验：**用嘴指挥打仗。**

---

## 二、核心功能一览

### 🎮 游戏循环 & 战争阶段

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 4 阶段战争推进 | PEACE → CONFLICT → WAR → ENDGAME 自动推进 | warPhase.ts |
| 战争宣言按钮 | 玩家可手动触发 CONFLICT→WAR | ChatPanel.tsx |
| ENDGAME 机制 | 900s 后进入终局：30% 收入衰减 + 全员 0.1HP/s 消耗 + 300s 倒计时 | warPhase.ts |
| 5 种结束条件 | HQ 被毁、后勤崩溃、ENDGAME 超时、得分判定、投降 | warPhase.ts |
| 重开系统 | 游戏结束后一键重置所有状态 | GameCanvas.tsx |

### ⚔️ 单位 & 战斗系统

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 11 种单位类型 | 步兵、轻坦、主坦、火炮、巡逻艇、驱逐舰、巡洋舰、航母、战斗机、轰炸机、侦察机 | types.ts |
| 克制矩阵 | 单位间伤害倍率（如轻坦打步兵 1.5x，打主坦 0.5x） | combat.ts |
| 地形防御加成 | 城市/森林/高地提供 20-50% 减伤 | combat.ts |
| 正面装甲 | 主坦额外 25% 减伤 | combat.ts |
| 弹药耗尽惩罚 | 弹药=0 时射击效率降低 80% | combat.ts |
| 自动锁敌 & 射线判定 | 射程内自动瞄准，视线遮挡检测 | combat.ts |
| 战斗视觉效果 | 攻击连线（紫色弹道）+ 爆炸光圈 | rendererCanvas.ts |
| 单位状态机 | idle / moving / attacking / defending / retreating / patrolling / dead | sim.ts |

### 🗺️ 地图 & 战场

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 200×150 瓦片地图 | 10 种地形：平原/丘陵/森林/沼泽/公路/浅水/深水/桥/城区/山地 | mapData.ts |
| ~35 个命名区域 | 每个区域有边界、地形分布、通行性、相邻关系 | mapData.ts |
| 5 条战线 | 北部平原 / 中央城区 / 海峡 / 南部丘陵 / 远南 | mapData.ts |
| 15+ 设施 | HQ、兵营、船厂、机场、燃料库、弹药库、雷达、通讯塔等 | mapData.ts |
| 三层战雾 | 未知（黑）→ 已探索（半透明）→ 可见（清晰） | fog.ts |
| 设施视野 | HQ 10格、雷达 20格、其他 6格 | fog.ts |
| 小地图 | 右下角缩略图，显示地形/单位/设施/视野框 | rendererCanvas.ts |

### 💬 AI 参谋 & 自然语言指挥（核心卖点）

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 3 个参谋频道 | 陈（战斗⚔️）/ Marcus（作战🎖️）/ Emily（后勤📦），各有独立人格 | ai.ts, ChatPanel.tsx |
| 自然语言输入 | 玩家用中文/英文自由下达命令，LLM 解析为意图 | ChatPanel.tsx |
| 9 种战术意图 | attack / defend / retreat / recon / hold / produce / trade / patrol / sabotage | intents.ts |
| 多方案推荐 | 参谋返回 A/B/C 三个方案，标注风险/收益，推荐最优 | schema.ts |
| 智能执行门控 | 简单命令自动执行，复杂/多意图命令需玩家确认 | ChatPanel.tsx |
| 战场摘要压缩 | 游戏状态压缩为 ~300 token 的 digest 送给 LLM | digest.ts |
| 风格学习 | 6 维偏好（冒险度/集火/目标/伤亡容忍/侦察/节奏） | types.ts |
| 前线别名映射 | "北边"/"north"/"front_north" 等中英文模糊匹配 | tacticalPlanner.ts |
| 兵力自动分配 | 意图 → 自动匹配最近可用部队，按 squad/前线/全局三级查找 | tacticalPlanner.ts |
| 降级容错 | 不支持的意图不会崩溃，返回 degraded 状态 | tacticalPlanner.ts |

### 🏗️ 编制系统（Phase 2 + 2.5）

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 树形编制结构 | 最多 3 层：根指挥官 → 指挥官(commander) → 班长(leader) | squadHierarchy.ts |
| 3 根指挥官 | Chen（战斗）、Marcus（作战）、Emily（后勤） | OrgTree.tsx |
| 初始自动编队 | 开局按兵种自动生成 ~7 个 leader 分队（I1-I3, T1-T2, A1, N1） | createInitialGameState.ts |
| 35 人名池 | 自动分配军事风格英文名（Aiden, Blake, Carter…），不重复 | namePool.ts |
| OrgTree 可视化 | 编制 tab 中展示完整树形结构，带状态颜色/图标/人数 | OrgTree.tsx |
| 拖拽重组 | 拖动 squad 节点到新父节点，实时重组编制 | OrgTree.tsx |
| 自动晋升 | leader 拖到 leader 上 → 目标自动晋升为 commander | squadHierarchy.ts |
| 自动降级 | 子节点脱离后 commander 只剩 1 个下属 → 自动降回 leader | squadHierarchy.ts |
| 编队抽调 | 可从已有分队中抽取单位创建新分队，空分队自动解散 | GameCanvas.tsx |
| 安全校验 | 深度≤3 / 禁止循环 / 禁止跨指挥官 / commander.unitIds 恒空 | squadHierarchy.ts |
| 节点交互 | 点击=选中单位 / 右键=脱离父节点 / 双击=改名 | OrgTree.tsx |
| Hover 提示 | 悬浮显示名字/角色/人数/士气/任务/父子关系 | OrgTree.tsx |
| 晋升/降级动画 | 角色变化时 400ms 金色边框闪烁 | OrgTree.tsx |
| 紫色晋升预览 | 拖拽时目标为 leader → 紫色高亮 + ⬆CMD 标记 | OrgTree.tsx |
| Info Panel 编队色块 | 选中单位后左上面板显示所属分队（稳定颜色 + 人数） | rendererCanvas.ts |

### 🎯 任务系统

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 5 种任务类型 | 破坏(Sabotage) / 歼灭(Destroy) / 占领(Capture) / 防守(Defend) / 切断补给(Cut Supply) | missions.ts |
| 任务进度追踪 | 每帧检测完成条件，计算进度百分比 | missions.ts |
| 威胁评估 | 实时统计任务区域附近敌军数量 | missions.ts |
| ETA 估算 | 根据当前进度预测剩余时间 | missions.ts |
| 自动失败 | 分队士气≤0.1 或全灭 → 任务自动失败 | missions.ts |
| 分队关联 | 任务绑定到 squad.currentMission | missions.ts |

### 💰 经济 & 生产

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 4 种资源 | 金钱($) / 燃料(Fu) / 弹药(Am) / 情报(In) | economy.ts |
| 30s 收入间隔 | 基础收入 $100 + 燃料 20 + 弹药 20 + 情报 10 | economy.ts |
| 设施加成 | 燃料库+30 / 弹药库+25 / 通讯塔+20 / 铁路枢纽+25 | economy.ts |
| 生产队列 | 通过 LLM 命令生产新单位（兵营→地面，船厂→海军，机场→空军） | economy.ts |
| 贸易系统 | 买卖燃料/弹药/情报，含冷却时间 | economy.ts |
| 设施占领 | 步兵在无敌人设施旁 5s 即可占领（HQ/兵营等不可占） | economy.ts |
| 战备度 | 综合资源/兵力/设施计算的战备值，影响阶段推进 | economy.ts |

### 🤖 AI 行为系统

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 敌军 AI | 5s 周期决策：按前线兵力比判断攻/守/巡逻 | enemyAI.ts |
| 敌军生产 AI | <15 人产步兵，15-25 混合，>25 产主坦 | enemyAI.ts |
| 单位自主行为 | 2s 周期：手动锁定 → 低血量撤退 → 执行命令 → 自动接敌 → 巡逻 | autoBehavior.ts |
| 巡逻任务系统 | 指定中心+半径，自动搜索并接敌，3 次无目标自动暂停 | autoBehavior.ts |
| 移动系统 | 路径点移动 + 8 方向局部避障 | sim.ts |
| 燃料消耗 | 坦克 0.1/格，舰艇 0.2/格，飞机 2.0/架次 | sim.ts |
| 地形通行限制 | 坦克不能进森林/沼泽/水域；步兵不能进深水/山地 | sim.ts |

### 📡 自动战报系统

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| 10 种事件类型 | 遭受攻击 / 补给不足 / 设施占领&失守 / 任务完成&失败 / HQ 受损 / 分队重创 / 阵地危急 / 任务停滞 / 经济盈余 | reportSignals.ts |
| 智能路由 | 事件自动发送到对应频道（战斗/作战/后勤） | reportSignals.ts |
| 冷却去重 | 相同事件有 30-120s 冷却，避免刷屏 | reportSignals.ts |
| 参谋主动询问 | 危急事件触发参谋自动提出 3 选项决策建议 | reportSignals.ts |

### 🖥️ 用户界面

| 功能 | 说明 | 实现文件 |
|------|------|----------|
| Canvas 实时渲染 | 地形/单位/设施/战雾/战斗特效/小地图 全部 Canvas 绘制 | rendererCanvas.ts |
| 框选 & 点选 | 拖动框选多个单位 / 点击选中单个 | input.ts |
| WASD 平移 | 键盘控制相机移动 | input.ts |
| 鼠标滚轮缩放 | 0.5x ~ 2.0x 缩放 | input.ts |
| 屏幕边缘滚动 | 鼠标靠近边缘自动平移 | input.ts |
| 选中信息面板 | 左上角显示选中单位数/类型/HP/所属编队 | rendererCanvas.ts |
| 聊天/编制双 Tab | 聊天💬 和 编制🏗️ 一键切换 | ChatPanel.tsx |
| 资源状态栏 | 顶部显示金钱/燃料/弹药/情报/战备度/时间 | GameCanvas.tsx |
| 快捷购买按钮 | +兵$100 / +坦$250 快速生产 | ChatPanel.tsx |

---

## 三、技术架构

```
apps/
  web/         → React 前端（Canvas + ChatPanel + OrgTree）
  server/      → Express + LLM 桥接（DeepSeek API）
packages/
  shared/      → 类型定义、编制逻辑、地图数据、摘要生成
  core/        → 游戏引擎（战斗/经济/AI/任务/阶段/战报）
```

| 特性 | 实现方式 |
|------|---------|
| 状态管理 | 纯函数式 tick(state, dt)，引用修改 |
| 渲染 | 原生 Canvas 2D（无游戏框架） |
| LLM 接入 | Provider 无关层，当前用 DeepSeek |
| 包管理 | npm workspaces monorepo |
| 构建 | Vite |
| 类型安全 | TypeScript strict mode |

---

## 四、尚未实现 / 后续规划

| 功能 | 优先级 | 说明 |
|------|--------|------|
| A* 全局寻路 | P1 | 当前是局部避障，大地图远距离移动效率低 |
| 护航任务解析 | P2 | intent 类型已定义，resolver 未实现 |
| 空中支援机制 | P2 | intent 存在但无具体游戏逻辑 |
| 条件命令执行 | P2 | 数据结构就绪，未接入游戏循环 |
| 风格自适应 | P3 | 6 维偏好值存在但 AI 未读取 |
| 存档/读档 | P3 | 无持久化 |
| 多人对战 | P3 | 当前仅单人 vs AI |
| 音效/BGM | P3 | 无音频 |
