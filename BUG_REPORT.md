# AI Commander — Bug Report (2026-03-30)

测试场景：El Alamein (`?scenario=el_alamein&nofog=1`)

---

## 已修复（defensiveAI.ts 重写，未提交）

| # | 问题 | 原因 | 修复方式 | 文件 |
|---|------|------|----------|------|
| ✅1 | AI 固定 90s 出兵，行为像脚本 | 旧版用固定计时器 | 改为条件驱动：P0 反击/P1 趁强/P2 积攒 | `defensiveAI.ts` |
| ✅2 | AI 全知全图，迷雾下不公平 | 直接读 `state.units` | 新增 `isVisibleToEnemy()` 限制 AI 视野 | `defensiveAI.ts` |
| ✅3 | P0/Trade 首次触发被冷却锁死 | `?? 0` 导致 t<60s 时冷却判定为真 | 改为 `has()` 守卫，首次无冷却 | `defensiveAI.ts` |
| ✅4 | 出击派发没做成功校验 | `applyEnemyOrders` 后直接写状态 | 检查 `dispatch.appliedPerOrder[0] > 0` | `defensiveAI.ts` |
| ✅5 | AI "进攻"自己的据点 (230,60) | `getTargetPosition` 返回 front 中心=AI 自己的阵地 | 改为先找可见玩家单位，fallback 用绕雷区 waypoints | `defensiveAI.ts` |
| ✅6 | 进攻单位到达中途 idle 被拉回防守 | `cleanupActiveAttackers` 对 idle 立刻释放 → garrison 抢走 | `attackerTargets` 记录目标，只有到达 12 tile 内才释放；`reissueAttackerOrders` 重发命令 | `defensiveAI.ts` |

**当前代码位置**：`packages/core/src/scenario/elAlamein/defensiveAI.ts`（主仓库，未提交）
**验证**：`npm run typecheck` + `npm run build` 通过

---

## 未修复 Bug

| # | 问题 | 严重性 | 复现步骤 | 原因分析 | 涉及文件 | 约束 |
|---|------|--------|----------|----------|----------|------|
| ❌1 | **寻路绕远路**：全是草地的直线距离，单位走公路绕一大圈才到 | 🔴 高 | 1. 在 HQ 附近选坦克<br>2. 下令移动到北方的 def1 tag<br>3. 观察路径：走沿海公路绕远而非直穿草地 | 已验证路径上全是 plains 零阻挡。A* 寻路的代价函数可能过度偏好道路 tile，或 route waypoint 系统强制走公路 | `packages/core/src/sim.ts`（移动逻辑）<br>可能涉及 `computeGroupPath` | H1 约束禁止改 sim.ts（需讨论是否放开） |
| ❌2 | **"all" 指令不包括 defending 状态的兵** | 🔴 高 | 1. 给 Aiden 下 defend 命令（10 个兵转入防御）<br>2. 再说 "Aiden, move ALL your team to X"<br>3. 那 10 个 defending 的兵不动 | 两层叠加：<br>① DeepSeek 没把"all"翻译成 `quantity: "all"`<br>② `resolveSourceUnits` 当 quantity ≠ "all"/"most" 时过滤掉 defending 状态的兵 | `apps/server/src/ai.ts`（DeepSeek prompt）<br>`packages/core/src/tacticalPlanner.ts`（unit 过滤） | 不在 defensiveAI 范围 |
| ❌3 | **紧急卡影响范围过大**：应只影响触发部队，实际影响全军 | 🔴 高 | 1. 派 Aiden（8 个兵）进攻敌军<br>2. Aiden 伤亡惨重，触发紧急卡<br>3. 选择"边打边退"<br>4. 系统执行"命令 **41 个单位**撤退"而非只撤 Aiden 的兵 | 紧急卡执行时没限定 scope 为触发事件的 squad/unit，而是对全军下了撤退命令 | `apps/server/src/ai.ts` 或紧急卡处理逻辑 | 不在 defensiveAI 范围 |
| ❌4 | **聊天栏对话突然清零** | 🟡 中 | 紧急卡执行后，聊天栏所有历史对话消失 | 可能是紧急卡处理时重置了 chat state | `apps/web/src/ChatPanel.tsx` 或 state 管理 | 不在 defensiveAI 范围 |
| ❌5 | **"El Alamein" 目标无法被 DeepSeek 解析** | 🟡 中 | 1. 说 "go to El Alamein and destroy the troops there"<br>2. 陈军士回复执行但单位不动 | DeepSeek 可能没正确填 `targetFacility` 字段，或填的值无法匹配 facility name | `apps/server/src/ai.ts`（DeepSeek prompt）| 不在 defensiveAI 范围 |
| ❌6 | **AI P2 出击后实际战斗效果待验证** | 🟡 中 | AI 部队 moving 状态持续，但需确认是否真的抵达玩家阵地并交战 | 可能受寻路 bug (❌1) 影响，AI 部队也绕远路 | `defensiveAI.ts` + `sim.ts` | 需寻路修复后再验证 |

---

## 地图/坐标参考

| 位置 | 坐标 | 说明 |
|------|------|------|
| Rommel HQ | (82, 98) | AI 总部 |
| Kidney Ridge | (220, 55) | AI 据点 |
| Miteirya Ridge | (230, 70) | AI 据点 |
| Alamein Town | (280, 30) | AI 据点 |
| Himeimat Heights | (250, 218) | AI 据点 |
| Player HQ | (430, 88) | 玩家总部 |
| Devil's Gardens (雷区) | bbox (248-315, 38-125) | 坦克不可通行，步兵可通行 |

---

## 优先级建议

1. **❌1 寻路** — 影响所有单位（玩家+AI），是体验最大痛点
2. **❌2 "all" 指令** — 普通兵只能语音控制，指令不生效等于不能玩
3. **❌3 紧急卡范围** — 会导致全军误操作
4. **❌4 聊天清零** — 影响体验但不致命
5. **❌5 El Alamein 解析** — DeepSeek prompt 调优
6. **❌6 AI 战斗验证** — 依赖 ❌1 修复后再测
