# AI Commander — 8分钟 RTS Demo 实现计划

> 目标：制作一个 8 分钟可录制/可演示的完整对局，展示"用嘴指挥打仗"的核心体验。
> 基于现有 Phase 2.5 代码库，不重构架构，只做增量模块。

---

## 一、总体设计思路

### 核心原则

Demo 不是"随便玩一局然后录屏"，而是**精心编排的体验**：
- 节奏可控（脚本驱动 bot 行为）
- 零延迟紧急响应（规则引擎，不走 LLM）
- 策略对话有沉浸感（streaming + 结构化卡片两阶段）
- 玩家命令持续生效（doctrine 系统 + 任务栏追踪）

### 三层命令架构

```
┌─────────────────────────────────────────────────┐
│  Layer 1: LLM 理解层                              │
│  玩家自然语言 → 结构化意图/doctrine                   │
│  "金三角不能丢" → { must_hold, critical }           │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│  Layer 2: Doctrine / 持续命令层（新增）              │
│  存储玩家的红线、优先级、授权边界                       │
│  规则引擎在每个 tick 自动执行检查                      │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│  Layer 3: Tactical Execution 层（现有）             │
│  Intent → Order → 单位移动/攻击/防守                 │
│  tacticalPlanner.ts + sim.ts                     │
└─────────────────────────────────────────────────┘
```

---

## 二、模块拆分 & 实现清单

### 模块 A：Demo 脚本引擎

**目的**：控制 bot（敌军）的行为节奏，确保 8 分钟内剧情按设计推进。

**实现位置**：`packages/core/src/demoScript.ts`（新文件）

**数据结构**：
```typescript
interface ScriptEvent {
  time: number;          // 游戏秒数
  action: "attack" | "reinforce" | "retreat" | "produce" | "pause";
  front?: string;        // 目标战线
  intensity?: number;    // 0-1 进攻强度（控制投入兵力比例）
  units?: string;        // "armor" | "infantry" | "all"
  narrativeHint?: string; // 给 advisor trigger 的提示（可选）
}

interface DemoScript {
  name: string;
  duration: number;       // 总时长秒数
  events: ScriptEvent[];
}
```

**执行逻辑**：
```typescript
function tickDemoScript(state: GameState, script: DemoScript, dt: number): void {
  // 检查是否有到时间的脚本事件
  for (const event of script.events) {
    if (state.time >= event.time && !event.fired) {
      event.fired = true;
      executeDemoAction(state, event);  // 直接调用 enemyAI 的底层函数
    }
  }
  // 脚本事件之间仍然走正常 enemyAI tick
}
```

**与现有代码的关系**：
- `enemyAI.ts` 现有的 `executeAttack()` / `executeRetreat()` / `executeReinforce()` 直接复用
- 脚本引擎只是在特定时间点强制触发这些函数，覆盖 enemyAI 的自主决策
- 非脚本时间段 enemyAI 照常运行

**Demo 剧本（8 分钟）**：

```
[0:00-0:30]  开场 — 和平阶段
  - 玩家看到战场全貌，熟悉 UI
  - 系统自动推送 Emily: "指挥官，各单位已就位，等待您的指示。"

[0:30-1:30]  玩家部署阶段
  - 玩家下第一道命令（示范自然语言指挥）
  - 例："Chen，派 T1 和 I2 去守金三角。Marcus，侦察北部平原。"
  - 系统生成任务卡 → 任务栏出现追踪条目

[1:30-2:00]  冲突触发
  - 脚本：bot 在北线发起试探性进攻（intensity: 0.3）
  - Chen 自动报告: "北部平原发现敌军先头部队接触。"

[2:00-3:30]  第一波攻势
  - 脚本：bot 在北线加大攻势（intensity: 0.6）
  - 玩家下令应对（展示策略对话 streaming + 卡片）
  - 玩家宣战 → WAR 阶段

[3:30-4:30]  东线牵制
  - 脚本：bot 在中央城区发起牵制（intensity: 0.4）
  - Marcus 报告中央压力，展示多线作战信息流

[4:30-5:30]  ⚠️ 金三角危机（核心高潮）
  - 脚本：bot 主力转攻金三角（intensity: 0.9）
  - 触发 doctrine 系统：金三角 = must_hold
  - 紧急卡片弹出（零延迟，规则引擎生成）：
    [死守] [边打边撤] [调 Andy 和 Frank 支援 ✓]
  - 玩家快速决策 → 增援到位 → 防线稳住

[5:30-6:30]  玩家反攻
  - 玩家下达反攻命令（展示复合命令能力）
  - "东线全面反攻，中央牵制，南线迂回包抄"
  - → 系统拆成 3 条 intent，一次批准执行

[6:30-7:30]  追击 & 占领
  - 脚本：bot 开始撤退（展示胜利推进）
  - 玩家追击并占领关键设施

[7:30-8:00]  收尾
  - 战局明朗，展示战果统计
  - 结束画面
```

---

### 模块 B：双模式响应系统（紧急零延迟 + 策略 Streaming）

**目的**：紧急时刻 0 延迟规则卡片；策略时刻 streaming 对话 + JSON 卡片。

#### B1: 紧急战术卡（规则引擎，不走 LLM）

**实现位置**：`packages/core/src/crisisResponse.ts`（新文件）

**触发条件**（基于现有 `reportSignals.ts` 的事件）：
```typescript
interface CrisisTrigger {
  eventType: ReportEventType;     // UNDER_ATTACK, FRONT_CRITICAL, HQ_DAMAGED...
  condition: (state: GameState, event: ReportEvent) => boolean;
  // 例：front pressure > 0.8 且该 front 有 doctrine "must_hold"
}
```

**核心函数 — 寻找最优增援**：
```typescript
function findBestReinforcements(
  state: GameState,
  crisisRegion: Region,
  doctrine: StandingOrder
): ReinforceCandidate[] {
  return state.squads
    .filter(s => s.team === "player")
    .map(squad => {
      const units = collectUnitsUnder(state, squad.id);
      const alive = units.filter(u => u.state !== "dead");
      if (alive.length === 0) return null;

      const center = avgPosition(alive);
      const distance = euclidean(center, regionCenter(crisisRegion));

      // 当前任务优先级
      const missionPriority = squad.currentMission
        ? getMissionPriority(state, squad.currentMission)
        : 0;  // 空闲 = 最适合抽调

      // 综合打分
      const score = (1 / (distance + 1)) * 100
                  - missionPriority * 50
                  + alive.length * 10;

      return { squad, distance, score, unitCount: alive.length, missionPriority };
    })
    .filter(Boolean)
    .filter(c => c.missionPriority < doctrine.priority)  // 不抽更高优先级任务的兵
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
```

**生成紧急卡片**：
```typescript
function generateCrisisCard(
  crisis: CrisisEvent,
  candidates: ReinforceCandidate[],
  doctrine: StandingOrder
): AdvisorOption[] {
  const options: AdvisorOption[] = [
    {
      label: "A: 死守阵地",
      description: `当前守军坚守${crisis.frontName}，等待局势变化`,
      risk: 0.7, reward: 0.4,
      intents: [{ type: "defend", targetFront: crisis.frontId }]
    },
    {
      label: "B: 边打边撤",
      description: `有序后撤，保存兵力`,
      risk: 0.3, reward: 0.3,
      intents: [{ type: "retreat", targetFront: crisis.frontId }]
    }
  ];

  // 动态生成增援选项（基于实际可用兵力）
  if (candidates.length >= 2) {
    const c0 = candidates[0], c1 = candidates[1];
    options.push({
      label: `C: 调${c0.squad.leader.name}和${c1.squad.leader.name}支援`,
      description: `${c0.squad.leader.name}(${c0.unitCount}人,距${Math.round(c0.distance)}格) + ${c1.squad.leader.name}(${c1.unitCount}人,距${Math.round(c1.distance)}格)`,
      risk: 0.4, reward: 0.8,
      intents: [
        { type: "attack_move", fromSquad: c0.squad.id, targetFront: crisis.frontId },
        { type: "attack_move", fromSquad: c1.squad.id, targetFront: crisis.frontId }
      ]
    });
  } else if (candidates.length === 1) {
    options.push({
      label: `C: 调${candidates[0].squad.leader.name}支援`,
      description: `${candidates[0].unitCount}人, 距离${Math.round(candidates[0].distance)}格`,
      risk: 0.4, reward: 0.6,
      intents: [{ type: "attack_move", fromSquad: candidates[0].squad.id, targetFront: crisis.frontId }]
    });
  }

  return options;
}
```

**与现有系统的对接**：
- 复用现有 `StaffThread` UI 来显示紧急卡片（已有 amber 边框 + 按钮）
- 复用现有 `handleApprove()` 逻辑来执行选中的 intents
- 复用 `collectUnitsUnder()` / `getUnitsOnFront()` 做单位查询
- 复用 `distBetween()` 做距离计算

#### B2: 策略 Streaming 对话（LLM 两阶段返回）

**实现位置**：
- 后端：`apps/server/src/index.ts` 新增 `/api/command-stream` 端点
- 前端：`apps/web/src/ChatPanel.tsx` 新增 streaming 处理

**后端 — SSE 流式端点**：
```typescript
app.post("/api/command-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  const { digest, message, styleNote, channel } = req.body;

  // LLM prompt 要求两阶段输出：
  // 1. 先输出自然语言分析（streaming推送）
  // 2. 再输出 ---JSON--- 标记后的结构化方案
  const stream = await provider.chatStream(systemPrompt, userMessage);

  let jsonBuffer = "";
  let inJsonMode = false;

  for await (const chunk of stream) {
    if (chunk.includes("---JSON---")) {
      inJsonMode = true;
      continue;
    }
    if (inJsonMode) {
      jsonBuffer += chunk;
    } else {
      // 阶段1：逐token推送对话文本
      res.write(`data: ${JSON.stringify({ type: "text", content: chunk })}\n\n`);
    }
  }

  // 阶段2：JSON 完整后一次性推送结构化方案
  const parsed = safeParse(jsonBuffer);
  if (parsed) {
    res.write(`data: ${JSON.stringify({ type: "options", content: parsed })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});
```

**前端 — 两阶段渲染**：
```typescript
async function sendCommandStreaming(message: string) {
  setLoading(true);
  setStreamingText("");  // 新增 state

  const response = await fetch("/api/command-stream", { method: "POST", body: ... });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = JSON.parse(line.slice(6));

      if (data.type === "text") {
        // 阶段1：逐字显示在聊天气泡里
        setStreamingText(prev => prev + data.content);
      } else if (data.type === "options") {
        // 阶段2：弹出结构化卡片
        setResponse(data.content);
      }
    }
  }
  setLoading(false);
}
```

**用户体验**：
```
玩家："我想反攻东线，你怎么看？"

[0.3s] Chen: "东线目前敌军3个装甲连，我方只有2个步兵连，
[0.8s]        正面硬攻伤亡会很大。但北侧有个缺口可以迂回..."
              ← 逐字出现，有对话感

[2.5s] 📋 方案A: 北侧迂回包抄  [风险██░░] [收益████]  [批准]
       📋 方案B: 正面强攻      [风险████] [收益██░░]  [批准]
       📋 方案C: 先侦察再定    [风险█░░░] [收益███░]  [批准]
              ← JSON 解析完毕，一次性渲染卡片
```

---

### 模块 C：Doctrine 持续命令系统 + 任务栏

**目的**：玩家的红线命令（"金三角不能丢"）持续生效，不靠 LLM 重新理解。

#### C1: Doctrine 数据层

**实现位置**：`packages/shared/src/doctrine.ts`（新文件）

**数据结构**：
```typescript
interface StandingOrder {
  id: string;
  type: "must_hold" | "can_trade_space" | "preserve_force" | "no_retreat" | "delay_only";
  commander: Channel;           // "combat" | "ops" | "logistics"
  locationTag: string;          // region ID 或 front ID
  priority: "low" | "normal" | "high" | "critical";
  allowAutoReinforce: boolean;  // 是否允许系统自动抽调增援
  assignedSquads: string[];     // 被分配的 squad IDs
  createdAt: number;            // 游戏时间
  status: "active" | "completed" | "cancelled";
}
```

**LLM 提取 doctrine**：

在现有 `/api/command` 的 system prompt 中增加指令，让 LLM 在识别到持续性命令时额外返回：
```json
{
  "standingOrder": {
    "type": "must_hold",
    "locationTag": "golden_triangle",
    "priority": "critical",
    "allowAutoReinforce": true
  }
}
```

**规则引擎 — 每 tick 检查 doctrine 状态**：
```typescript
function checkDoctrines(state: GameState, doctrines: StandingOrder[]): CrisisEvent[] {
  const crises: CrisisEvent[] = [];

  for (const doctrine of doctrines.filter(d => d.status === "active")) {
    if (doctrine.type === "must_hold") {
      const front = findFrontByRegion(state, doctrine.locationTag);
      if (!front) continue;

      const pressureRatio = front.enemyPower / Math.max(front.playerPower, 1);

      if (pressureRatio > 2.5) {
        // 快顶不住了 → 触发自动增援 + 紧急卡片
        crises.push({
          type: "DOCTRINE_BREACH",
          doctrine,
          front,
          pressureRatio,
          severity: "critical"
        });
      } else if (pressureRatio > 1.5) {
        // 压力上升 → 预警
        crises.push({
          type: "DOCTRINE_WARNING",
          doctrine,
          front,
          pressureRatio,
          severity: "warning"
        });
      }
    }
  }
  return crises;
}
```

#### C2: 任务栏 UI

**实现位置**：`apps/web/src/TaskBar.tsx`（新组件）

**设计原则**：
- 自然语言是主入口，任务栏是**追踪与轻量修正层**
- 不让玩家手动创建任务，一切从命令自动生成
- 第一版只暴露最少控制项

**任务卡片字段（第一版）**：
```typescript
interface TaskCard {
  id: string;
  title: string;           // "Hold Golden Triangle"
  commander: Channel;      // "combat"
  assignedSquads: string[]; // ["Blake", "Chris"]
  status: "assigned" | "moving" | "engaged" | "holding" | "failing" | "completed";
  priority: "low" | "normal" | "high" | "critical";  // 玩家可手动调整
  constraint?: string;     // "Must Hold" / "Delay Only"
  createdAt: number;
  doctrine?: StandingOrder; // 关联的持续命令
}
```

**状态自动更新逻辑**：
```typescript
function updateTaskStatus(task: TaskCard, state: GameState): void {
  const squads = task.assignedSquads.map(id => findSquad(state, id));
  const allUnits = squads.flatMap(s => collectUnitsUnder(state, s.id));
  const alive = allUnits.filter(u => u.state !== "dead");

  if (alive.length === 0) {
    task.status = "failing";
  } else if (alive.some(u => u.state === "attacking" || u.state === "defending")) {
    task.status = "engaged";
  } else if (alive.some(u => u.state === "moving")) {
    task.status = "moving";
  } else if (alive.every(u => u.state === "idle" || u.state === "defending")) {
    task.status = "holding";
  }
}
```

**UI 布局**：
```
┌─────────────────────────────────────┐
│ 📋 Active Tasks                 3/5 │
├─────────────────────────────────────┤
│ ⬛ Hold Golden Triangle    🔴 CRIT  │
│   Chen → Blake, Chris              │
│   Status: Engaged ⚔️               │
│   [▼ Priority]                     │
├─────────────────────────────────────┤
│ ⬛ Recon North Plains      🟡 HIGH  │
│   Marcus → Delta                   │
│   Status: Moving 🚶               │
│   [▼ Priority]                     │
├─────────────────────────────────────┤
│ ⬛ Patrol Supply Line      🟢 NORM  │
│   Emily → Echo                     │
│   Status: Holding 🛡️              │
│   [▼ Priority]                     │
└─────────────────────────────────────┘
```

**玩家可交互项（仅 3 种）**：
1. **Priority** — 下拉改优先级（Low / Normal / High / Critical）
2. **Stance** — 改任务姿态（Hold / Delay / Withdraw if needed）
3. **Cancel** — 取消任务

**任务栏放置位置**：
- 地图左侧或左下角，半透明悬浮
- 默认折叠只显示 3-5 个最高优先级任务
- 点击展开看详情

---

### 模块 D：任务栏优先权系统

**目的**：任务卡片根据战场态势动态排序，紧急任务自动置顶，玩家可手动调整优先级影响资源分配。

**核心机制 — 动态优先级计算**：
```typescript
interface TaskPriority {
  base: number;          // 玩家手动设定的基础优先级 (1-4)
  urgencyBonus: number;  // 战况紧急度加成 (0-3)
  doctrineBonus: number; // doctrine 关联加成 (must_hold = +2, critical = +3)
  computed: number;      // 最终排序值 = base + urgencyBonus + doctrineBonus
}

function computeTaskPriority(task: TaskCard, state: GameState): number {
  let urgency = 0;

  // 正在交战且劣势 → 紧急度+1~2
  if (task.status === "engaged") {
    const front = findAssociatedFront(state, task);
    if (front) {
      const ratio = front.enemyPower / Math.max(front.playerPower, 1);
      if (ratio > 2.0) urgency += 2;       // 严重劣势
      else if (ratio > 1.3) urgency += 1;  // 轻微劣势
    }
  }

  // 任务关联的 squad 有大量伤亡 → 紧急度+1
  if (task.status === "failing") urgency += 3;

  // doctrine 加成
  let docBonus = 0;
  if (task.doctrine) {
    if (task.doctrine.type === "must_hold") docBonus += 2;
    if (task.doctrine.priority === "critical") docBonus += 1;
  }

  const base = priorityToNumber(task.priority); // low=1, normal=2, high=3, critical=4
  return base + urgency + docBonus;
}
```

**排序 & 置顶逻辑**：
```typescript
function sortTasks(tasks: TaskCard[], state: GameState): TaskCard[] {
  return tasks
    .map(t => ({ task: t, score: computeTaskPriority(t, state) }))
    .sort((a, b) => b.score - a.score)
    .map(t => t.task);
}
```

**优先级变化的视觉反馈**：
```
优先级上升 → 卡片边框闪烁黄色，上移动画 (0.3s ease)
优先级 critical → 卡片边框持续红色脉冲
优先级下降 → 卡片安静下移
新任务插入 → 从右侧滑入到正确位置
```

**优先级影响资源分配**：
- 当多个任务争抢增援时，高优先级任务优先获得增援
- `findBestReinforcements()` 的 `missionPriority` 过滤会参考 computed priority
- 玩家手动提升优先级 = 明确告诉系统"这个更重要"

---

### 模块 E：战情系统（BattleAwareness）

**目的**：周期性扫描战场态势，异常时触发视觉标记 + LLM 智能研判，形成"AI战情室"体验。

#### E1: Heartbeat 扫描引擎

**实现位置**：`packages/core/src/battleAwareness.ts`（新文件）

**核心循环**：
```typescript
interface HeartbeatState {
  lastScanTime: number;
  scanInterval: number;        // 默认 3s
  activeMarkers: BattleMarker[];
  recentCases: CrisisCase[];   // 最近触发的 case（用于去重）
  llmCooldown: number;         // LLM 调用冷却（最短间隔 10s）
  lastLlmCallTime: number;
}

function heartbeatTick(state: GameState, hb: HeartbeatState, dt: number): void {
  hb.lastScanTime += dt;
  if (hb.lastScanTime < hb.scanInterval) return;
  hb.lastScanTime = 0;

  // 1. 收集本轮数据
  const scanResult = scanBattlefield(state);

  // 2. 更新视觉标记（纯前端，零成本）
  updateMarkers(hb, scanResult, state.time);

  // 3. 规则引擎检测异常
  const cases = detectAnomalies(scanResult, hb.recentCases);

  // 4. 有异常且冷却结束 → 触发 LLM 研判
  if (cases.length > 0 && canCallLlm(hb, state.time)) {
    const topCase = cases.sort((a, b) => b.severity - a.severity)[0];
    triggerLlmAssessment(topCase, scanResult, hb);
  }

  // 5. 清理过期标记
  cleanExpiredMarkers(hb, state.time);
}
```

**战场扫描数据**：
```typescript
interface BattlefieldScan {
  // 死亡统计
  recentDeaths: { x: number; y: number; unitType: string; killedBy: string; time: number }[];

  // 前线状态
  fronts: { id: string; name: string; pressure: number; trend: "rising" | "stable" | "falling" }[];

  // 活跃交战区
  engagementZones: { x: number; y: number; radius: number; myUnits: number; enemyUnits: number }[];

  // 资源状态
  resources: { current: number; income: number; burnRate: number };

  // 编队状态
  squads: { id: string; name: string; alive: number; total: number; isIdle: boolean; idleDuration: number }[];
}

function scanBattlefield(state: GameState): BattlefieldScan {
  // 遍历所有 front → 计算压力比和趋势
  // 收集最近 scanInterval 内的死亡事件
  // 识别交战热区（双方单位距离 < 阈值的聚集点）
  // 统计资源和编队情况
}
```

#### E2: 战场视觉标记层

**实现位置**：渲染逻辑加入 `apps/web/src/rendererCanvas.ts`

**标记数据结构**：
```typescript
interface BattleMarker {
  id: string;
  type: "attack_zone" | "death" | "critical_front";
  x: number;
  y: number;
  radius?: number;         // attack_zone 的警圈半径
  createdAt: number;       // 游戏时间
  expiresAt?: number;      // death 标记 = createdAt + 10s
  opacity: number;         // 渐隐动画用
  pulsePhase: number;      // 脉冲动画相位
}
```

**渲染逻辑**：
```typescript
function drawBattleMarkers(ctx: CanvasRenderingContext2D, markers: BattleMarker[], gameTime: number): void {
  for (const marker of markers) {
    // 计算当前 opacity（渐隐）
    if (marker.expiresAt) {
      const remaining = marker.expiresAt - gameTime;
      const fadeDuration = 3; // 最后 3s 渐隐
      marker.opacity = Math.min(1, remaining / fadeDuration);
      if (marker.opacity <= 0) continue;
    }

    ctx.save();
    ctx.globalAlpha = marker.opacity;

    switch (marker.type) {
      case "attack_zone":
        // 红色脉冲圆圈
        const pulse = 0.8 + 0.2 * Math.sin(marker.pulsePhase);
        ctx.strokeStyle = `rgba(255, 40, 40, ${pulse})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, marker.radius! * pulse, 0, Math.PI * 2);
        ctx.stroke();
        // 半透明红色填充
        ctx.fillStyle = `rgba(255, 0, 0, ${0.08 * pulse})`;
        ctx.fill();
        marker.pulsePhase += 0.05;
        break;

      case "death":
        // 红色 ✕ 标记
        const size = 6;
        ctx.strokeStyle = `rgba(255, 60, 60, ${marker.opacity})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(marker.x - size, marker.y - size);
        ctx.lineTo(marker.x + size, marker.y + size);
        ctx.moveTo(marker.x + size, marker.y - size);
        ctx.lineTo(marker.x - size, marker.y + size);
        ctx.stroke();
        break;

      case "critical_front":
        // 前线段变红 + 呼吸动画
        const breathe = 0.6 + 0.4 * Math.sin(marker.pulsePhase);
        ctx.strokeStyle = `rgba(255, 0, 0, ${breathe})`;
        ctx.lineWidth = 4;
        // 前线段绘制由 front 几何数据驱动
        marker.pulsePhase += 0.03;
        break;
    }

    ctx.restore();
  }
}
```

**标记生命周期**：
```
attack_zone  → 首次检测到交战 → 持续到脱战后 5s → 消失
death        → 单位死亡瞬间 → 持续 10s → 最后 3s 渐隐 → 消失
critical_front → front.pressure > 2.0 → 持续到压力缓解 → 消失
```

#### E3: LLM 智能研判（异常触发）

**触发 Case 类型**：
```typescript
type CaseType =
  | "MASS_CASUALTY"      // 短时间内大量伤亡
  | "FRONT_BREACH"       // 防线被突破
  | "RESOURCE_CRISIS"    // 资源即将耗尽
  | "FLANK_DETECTED"     // 敌方侧翼攻击
  | "IDLE_FORCE"         // 大量部队闲置
  | "MOMENTUM_SHIFT";    // 战场态势突然逆转

interface CrisisCase {
  type: CaseType;
  severity: number;       // 1-5
  triggeredAt: number;
  data: Record<string, any>;  // case 相关数据
  cooldownUntil: number;  // 同类 case 冷却到此时间
}
```

**异常检测规则**：
```typescript
function detectAnomalies(scan: BattlefieldScan, recentCases: CrisisCase[]): CrisisCase[] {
  const cases: CrisisCase[] = [];

  // MASS_CASUALTY: 3s 内死亡 > 5
  if (scan.recentDeaths.length > 5) {
    if (!isOnCooldown(recentCases, "MASS_CASUALTY")) {
      cases.push({
        type: "MASS_CASUALTY",
        severity: Math.min(5, scan.recentDeaths.length - 3),
        data: { deaths: scan.recentDeaths, count: scan.recentDeaths.length }
      });
    }
  }

  // FRONT_BREACH: 前线压力 > 3.0 且趋势上升
  for (const front of scan.fronts) {
    if (front.pressure > 3.0 && front.trend === "rising") {
      if (!isOnCooldown(recentCases, "FRONT_BREACH")) {
        cases.push({
          type: "FRONT_BREACH",
          severity: 5,
          data: { frontId: front.id, frontName: front.name, pressure: front.pressure }
        });
      }
    }
  }

  // IDLE_FORCE: 编队闲置 > 15s 且有活跃战线
  const idleSquads = scan.squads.filter(s => s.isIdle && s.idleDuration > 15 && s.alive > 0);
  const hasActiveFronts = scan.fronts.some(f => f.pressure > 1.0);
  if (idleSquads.length >= 2 && hasActiveFronts) {
    if (!isOnCooldown(recentCases, "IDLE_FORCE")) {
      cases.push({
        type: "IDLE_FORCE",
        severity: 2,
        data: { squads: idleSquads }
      });
    }
  }

  // MOMENTUM_SHIFT: 交换比突然逆转（需要历史对比，从 scan 趋势推断）
  // FLANK_DETECTED: 敌方出现在非正面方向
  // RESOURCE_CRISIS: 资源 < 20% 且在持续消耗

  return cases;
}
```

**LLM 研判调用**：
```typescript
interface LlmCrisisContext {
  caseType: CaseType;
  timestamp: number;

  // 精简战场快照（控制 token 量）
  snapshot: {
    myForces: { type: string; count: number; avgHp: number }[];
    enemyForces: { type: string; count: number; nearestFront: string }[];
    frontStatus: { name: string; pressure: number; trend: string }[];
    recentDeaths: { x: number; y: number; unitType: string; killedBy: string }[];
  };

  // 避免重复警报
  recentAlerts: string[];  // 最近 3 条已发过的警报摘要
}

// LLM System Prompt
const CRISIS_ANALYST_PROMPT = `
你是 RTS 游戏的战场 AI 参谋。根据战况生成简短警报。
规则：
- 不超过 2 句话
- 必须包含具体位置和建议动作
- 不要重复最近已发过的警报
- 语气：冷静专业，像军事参谋

返回 JSON：
{
  "severity": "warning" | "critical" | "info",
  "message": "简短警报文本",
  "suggestedAction": "REINFORCE_FRONT" | "RETREAT" | "REPOSITION" | "SCOUT" | "NONE",
  "targetArea": { "x": number, "y": number }
}
`;

async function triggerLlmAssessment(
  crisis: CrisisCase,
  scan: BattlefieldScan,
  hb: HeartbeatState
): Promise<void> {
  hb.lastLlmCallTime = scan.timestamp;

  const context: LlmCrisisContext = buildContext(crisis, scan, hb.recentCases);

  // 异步调用，不阻塞 heartbeat
  const result = await callLlm(CRISIS_ANALYST_PROMPT, JSON.stringify(context));

  if (result) {
    // 同时触发三路输出
    // 1. 地图标记 → targetArea 位置加红圈
    hb.activeMarkers.push({
      type: "attack_zone",
      x: result.targetArea.x,
      y: result.targetArea.y,
      radius: 60,
      createdAt: scan.timestamp,
      opacity: 1,
      pulsePhase: 0
    });

    // 2. 危急卡片 → 推送到 UI
    pushCrisisAlert(result.message, result.severity, result.suggestedAction);

    // 3. 记录到 recentAlerts（用于去重）
    hb.recentCases.push({
      ...crisis,
      cooldownUntil: scan.timestamp + 30  // 同类 case 30s 内不重复
    });
  }
}
```

**去重与节流策略**：
```
┌──────────────────────────────────────────────┐
│ 去重策略                                      │
├──────────────────────────────────────────────┤
│ 同类 case 冷却       30s 内不重复触发同类型    │
│ LLM 调用间隔         最短 10s 一次            │
│ 最大并发 LLM 调用    1（排队制，新的替换旧的）  │
│ 历史警报对比          最近 3 条，LLM prompt 含  │
│ 离线降级             LLM 超时 5s → 用本地模板  │
└──────────────────────────────────────────────┘
```

**本地降级模板（LLM 超时时兜底）**：
```typescript
const FALLBACK_TEMPLATES: Record<CaseType, string> = {
  MASS_CASUALTY: "{frontName}方向遭受重大伤亡，{count}个单位阵亡。建议增援或撤退。",
  FRONT_BREACH: "{frontName}防线被突破！敌军压力比 {pressure}:1。紧急增援！",
  RESOURCE_CRISIS: "资源告急，当前储量 {current}，消耗率 {burnRate}/s。",
  FLANK_DETECTED: "检测到敌方侧翼机动，方向：{direction}。注意防御。",
  IDLE_FORCE: "{count}支编队处于闲置状态，建议重新部署。",
  MOMENTUM_SHIFT: "战场态势逆转，交换比从 {oldRatio} 变为 {newRatio}。"
};
```

**与现有模块的关系**：
```
reportSignals.ts (已有事件检测)
       ↓ 提供基础事件
battleAwareness.ts (新增 heartbeat 引擎)
       ↓ 输出三路
       ├── markers[] → rendererCanvas.ts (已有渲染管线，加 drawBattleMarkers 层)
       ├── crisisAlert → crisisResponse.ts (已有紧急卡片) + ChatPanel UI
       └── recentCases → 自身去重 + doctrine.ts 联动
```

---

### 模块 F：复合命令支持

**目的**：玩家一句话包含多条战术意图，系统正确拆分并执行。

**实现方式**：主要是 prompt 优化，少量代码改动。

**Prompt 改动**（`apps/server/src/ai.ts`）：

在 system prompt 中增加：
```
当玩家下达涉及多个战线或多个动作的命令时，你应该返回一个 option，
其中 intents 数组包含多条意图。例如：

玩家："东线全面反攻，中央牵制，南线迂回"
→ option.intents: [
    { type: "attack", targetFront: "front_north", unitType: "armor" },
    { type: "defend", targetFront: "front_center" },
    { type: "attack", targetFront: "front_south", unitType: "infantry" }
  ]
```

**代码改动**：
- `tacticalPlanner.ts` 的 `resolveIntent` 循环已经支持多 intent → 不需要改
- `ChatPanel.tsx` 的 `handleApprove` 已经遍历 `option.intents[]` → 不需要改
- 只需确保 `schema.ts` 的 `validateAdvisorResponse()` 允许 intents 数组长度 ≤ 5（当前限制为 3，可能需要放宽）

---

### 模块 G：Advisor 主动推送系统

**目的**：副官在特定时机主动给玩家建议，不需要玩家主动发问。

**实现位置**：`packages/core/src/advisorTrigger.ts`（新文件）

**两种触发模式**：

#### E1: 规则触发（紧急事件）
与模块 B1 合并，基于 `reportSignals.ts` 的事件：
```typescript
const CRISIS_TRIGGERS: CrisisTrigger[] = [
  {
    eventType: "UNDER_ATTACK",
    condition: (state, event) => {
      const front = getFront(state, event.frontId);
      return front.enemyPower / front.playerPower > 2.0;
    },
    responseType: "crisis_card"  // → 走规则引擎，零延迟
  },
  {
    eventType: "FACILITY_LOST",
    condition: (state, event) => event.facility.type === "hq",
    responseType: "crisis_card"
  }
];
```

#### E2: 脚本触发（Demo 编排）
在 demo 脚本中直接插入 advisor 推送事件：
```typescript
const demoScript: DemoScript = {
  events: [
    // ...bot 行为事件...
    {
      time: 30,
      action: "advisor_push",
      channel: "logistics",
      message: "指挥官，各单位已就位。建议先部署防线再宣战。"
    },
    {
      time: 270,  // 4:30 金三角危机前
      action: "advisor_push_llm",  // 提前调 LLM，缓存结果
      channel: "combat",
      precomputeFor: 300  // 为 T=300s 时的推送预计算
    }
  ]
};
```

---

## 三、现有代码复用清单

| 现有模块 | 文件 | 复用方式 |
|---------|------|---------|
| 敌军 AI 决策 | `enemyAI.ts` | 脚本引擎直接调用 `executeAttack/Retreat/Reinforce` |
| 事件检测 | `reportSignals.ts` | 紧急卡片的触发源 |
| StaffThread UI | `ChatPanel.tsx` | 紧急卡片的显示容器 |
| 单位查询 | `tacticalPlanner.ts` | `getAllAvailablePlayerUnits()`, `getUnitsOnFront()` |
| 编制遍历 | `squadHierarchy.ts` | `collectUnitsUnder()` 查询 squad 下所有单位 |
| 距离计算 | `combat.ts` | `distBetween()` 计算增援距离 |
| 意图执行 | `tacticalPlanner.ts` | `resolveIntent()` 把 intent 变成 order |
| 命令批准 | `ChatPanel.tsx` | `handleApprove()` 执行选中方案 |
| Order 系统 | `types.ts` | `Order.priority` 已有 low/medium/high |
| Front 数据 | `types.ts` | `front.playerPower/enemyPower` 已有压力比 |
| 消息推送 | `messageStore.ts` | `addMessage()` 向聊天面板推送消息 |
| 渲染管线 | `rendererCanvas.ts` | 已有攻击弹道线/爆炸光圈，加 `drawBattleMarkers()` 层 |
| 事件信号 | `reportSignals.ts` | `UNDER_ATTACK`、`SQUAD_HEAVY_LOSS` 等事件作为 heartbeat 数据源 |

---

## 四、新增文件清单

| 文件 | 位置 | 行数估算 | 说明 |
|------|------|---------|------|
| `demoScript.ts` | `packages/core/src/` | ~150 | Demo 脚本引擎 + 默认 8 分钟剧本 |
| `crisisResponse.ts` | `packages/core/src/` | ~200 | 紧急卡片生成 + 最优增援查找 |
| `doctrine.ts` | `packages/shared/src/` | ~100 | StandingOrder 类型 + doctrine 检查逻辑 |
| `advisorTrigger.ts` | `packages/core/src/` | ~120 | Advisor 主动推送触发器 |
| `TaskBar.tsx` | `apps/web/src/` | ~200 | 任务栏 UI 组件（含动态优先级排序） |
| `battleAwareness.ts` | `packages/core/src/` | ~300 | Heartbeat 扫描引擎 + 异常检测 + LLM 研判触发 |
| streaming 端点 | `apps/server/src/` | ~80 | `/api/command-stream` SSE 端点 |

**总新增代码量**：~1150 行

---

## 五、实施顺序（建议）

### Phase 1: 脚本引擎 + 紧急卡片（Demo 最小可用）
1. `demoScript.ts` — bot 行为按时间线执行
2. `crisisResponse.ts` — `findBestReinforcements()` + `generateCrisisCard()`
3. 对接现有 `StaffThread` UI 显示紧急卡片
4. 写一版 8 分钟 demo 剧本

**验收**：能跑一局节奏可控的 8 分钟对局，紧急时刻有零延迟卡片。

### Phase 2: Doctrine 层 + 任务栏（含优先权）
5. `doctrine.ts` — StandingOrder 数据结构 + `checkDoctrines()` 规则
6. LLM prompt 增加 doctrine 提取
7. `TaskBar.tsx` — 任务栏 UI + 自动状态更新 + **动态优先级排序**
8. 优先级计算引擎 — `computeTaskPriority()` 战况联动
9. Doctrine 危机 → 自动触发紧急卡片

**验收**：玩家说"金三角不能丢" → 任务栏出现 → 战况恶化时卡片自动上移变红 → 危机时自动增援建议。

### Phase 3: 战情系统（BattleAwareness）
10. `battleAwareness.ts` — Heartbeat 扫描引擎 + 战场数据采集
11. 视觉标记层 — `rendererCanvas.ts` 加 `drawBattleMarkers()`（红圈、红叉、前线变红）
12. 异常检测规则引擎 — `detectAnomalies()` 六种 case 类型
13. LLM 智能研判 — 异常触发 → context 组装 → LLM 调用 → 三路输出（标记+卡片+警报）
14. 去重/节流/降级 — 冷却策略 + 本地模板兜底

**验收**：战斗发生 → 地图红圈脉冲 → 单位阵亡红叉 10s 渐隐 → 重大异常时 LLM 推送自然语言研判。

### Phase 4: Streaming 对话 + 复合命令
15. `/api/command-stream` SSE 端点
16. `ChatPanel.tsx` 增加 streaming 文本 + 卡片两阶段渲染
17. Prompt 优化支持复合命令拆分
18. Advisor 主动推送系统

**验收**：策略对话有 streaming 文字流 → 卡片弹出；一句话可拆多条意图。

### Phase 5: 打磨 & 录制
19. 调整 demo 剧本节奏
20. 微调 LLM prompt
21. UI 视觉优化（卡片动画、任务栏过渡、标记动画）
22. 录制 demo

---

## 六、技术风险 & 缓解

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| LLM 延迟 2-5s | 策略对话等待感 | Streaming 两阶段 + demo 中可预计算 |
| LLM 返回格式不稳定 | JSON 解析失败 | 现有 `safeParse()` 已有 fallback，streaming 模式下 JSON 部分仍做完整解析 |
| 紧急卡片选项不合理 | 推荐的增援单位不对 | `findBestReinforcements` 有优先级过滤 + 距离打分，比 LLM 更可控 |
| Demo 节奏感不好 | 太平淡或太混乱 | 脚本引擎参数可快速调整（intensity/time），多次试跑 |
| 任务栏遮挡地图 | 影响操作 | 默认折叠，只显示 3 条，半透明，可关闭 |
| Heartbeat LLM 调用过多 | 成本 & 延迟 | 最短 10s 间隔 + 同类 case 30s 冷却 + 本地模板降级 |
| 视觉标记过多杂乱 | 视觉污染 | 标记有生命周期自动清理 + 同区域合并 + 最大标记数限制 |
| LLM 研判重复/无意义 | 玩家疲劳 | 最近 3 条警报传入 prompt 做去重 + severity 门槛过滤 |

---

## 七、Demo 核心卖点总结

1. **"用嘴指挥打仗"** — 自然语言下令，AI 参谋理解并执行
2. **"副官真的在帮你"** — 紧急时刻零延迟自动建议增援方案（不是 loading…）
3. **"你的命令持续生效"** — "金三角不能丢" 不是聊天记录，是持续执行的作战命令
4. **"一句话多线作战"** — "东线反攻，中央固守，南线迂回" 一次批准三条意图
5. **"像真的战情室"** — 任务栏追踪所有作战任务状态，优先级动态排序
6. **"AI 参谋主动研判"** — 不是每 3 秒重复废话，而是异常时才推送有价值的自然语言警报
7. **"战场一目了然"** — 攻击区红圈脉冲、阵亡点红叉渐隐、危急前线呼吸变红
