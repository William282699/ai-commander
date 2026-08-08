# Enemy Pressure V1 — 开局敌军压力（诊断 + workplan，2026-07-05）

> **状态：** 诊断完成，未写代码。当前 worktree `step-7e-decision-retrospect`，HEAD = main = origin/main = `3825205`。
> **目标：** el_alamein 开局敌军主动推进/试探/压前哨——纯 deterministic engine/scenario 改动，零 LLM、零 prompt、零命门。
> **哲学：** 不加新系统。现有 defensiveAI(P0-P3) + pressureDirector(P4) 结构是好的，问题全在**时序常数、出发距离、波次规模**三个 tunable 维度。改常数 + 挪部署，不写新代码路径。

---

## 1. 诊断：为什么开局没压力（源码级，全部已核实）

el_alamein 敌军只有两个大脑（`enemyAI.ts:64` 对 defensive mode 直接 return，不参与）：
- **defensiveAI**（5s tick）：P0 反击（玩家碰 objective 才触发）/ P1 机会进攻 / P2 集团攻势 / P3 试探 —— P1/P2/P3 的 grace 全部由 `PHASE_STRATEGY` 查表；
- **pressureDirector**（5s tick）：P4 压哨波 —— 打分选一个玩家前哨/失地，按冷却发波。

**开局时间线（现状）：**

| 时间 | 敌军主动行为 | 原因（锚点） |
|---|---|---|
| 0–90s | **零** | `PHASE_STRATEGY.observation`(0-180s) 把 P1/P2/P3 全禁（grace=9999, p3MaxUnits=0）；P4 有 `P4_GRACE_PERIOD_SEC=90` |
| 90s | P4 第一波才**出发**（probe 档 4-5 单位） | pressureDirector.ts:140 |
| 90–180s | 只有这一波在路上 | easy 冷却 140s±20 → 第二波 ~230s |
| 180s+ | P3 试探解锁（60s±20 一次，3-4 单位）；P1 解锁但需要**看见**玩家弱点（fog-gated，开局看不见→静默） | PHASE_STRATEGY.multi_line |
| 720s+ | P2 集团攻势才解锁 | p2Grace=720（5C-lite 治 armor-flood 的刻意设计，**不动**） |

**三个叠加根因：**

1. **时序闸太晚**：0-90s 结构性零主动；90-180s 只有一波 4-5 人。
2. **物理距离吃掉时间**：敌军可抽兵力全在西侧（最东的 Forward Screening 在 x=190），玩家三个前哨在 x≈360-365——**170+ tiles 行军**。就算 t=0 出发也要 2-3 分钟才接敌。这是任何纯时序调整都翻不过去的墙。
3. **波次规模打不动驻军**：前哨驻军 8-9 单位满血（5C-prep 特意前置的），P4 easy raid 只有 4-5 单位——冲上去被磨死，post hp 不掉、history 惩罚 -25 还让 P4 更沉默。「挂机 3-5 分钟有真实丢点风险」在数值上不成立。

**结论：三个维度各拧一颗小螺丝（时序 / 出发点 / 规模），互相配合才能达到目标体验；只拧一颗都不够。**

## 2. 目标体验 → 机制映射（修改后预测时间线）

| 用户目标 | 修改后预测 | 靠什么 |
|---|---|---|
| 0-60s 开始推进/试探 | t≈15s P4 首波出发（前置先锋），t≈45s P3 试探沿走廊出发 | V1a 时序 + V1b 前置 |
| 60-180s 压 1-2 个前哨 | t≈60-100s 首波接敌一个 post；t≈105-125s P4 第二波（history 惩罚自动换目标）压第二个 post | V1a 冷却 90s + 现有 history 轮换机制（零新代码） |
| 挂机 3-5 分钟真实丢点风险 | 首波 6-8 打 8-9 驻军互耗 → post 受损/守军减员后 finish_post 加分豁免 history → 第二波跟进同一目标 → 失守 | V1c 规模 + 现有 finish_post 机制 |
| 玩家调兵明显改变结果 | 波次 ≈ 驻军×1.2-1.5，玩家增援 5-8 单位即可反转 | V1c 规模上限守住这个比例 |
| war-room 层自然读到 | UNDER_ATTACK/FACILITY_CONTESTED/POSITION_CRITICAL → escalation 问句；engagementIntensity → director beats → proactive；玩家增援决策 → 7e 复盘 | **零改动**，信号链全部现成，7b/7d 问句预算防刷屏也现成 |

## 3. 改动方案（三个子步，每步独立 bench + commit）

### EP-V1a — 时序解锁（纯常数，1 文件）｜风险：极低
`pressureDirector.ts`：
| 常数 | 现值 | 改为 | 理由 |
|---|---|---|---|
| `P4_GRACE_PERIOD_SEC` | 90 | **15** | 首波 t≈15s 出发 |
| `P4_BASE_COOLDOWN_EASY` | 140 | **90** | 180s 内能压到第二个方向 |
| `getCurrentStrategicPhase` observation 窗口 | t<180 | **t<90** | multi_line 提前 |
| `PHASE_STRATEGY.observation.p3Grace` | 9999 | **45** | 45s 起小股试探 |
| `PHASE_STRATEGY.observation.p3MaxUnits` | 0 | **4** | 同上 |
| `PHASE_STRATEGY.multi_line.p3Grace` | 120 | **45** | 否则 90-120s 出现试探真空带（grace 是绝对时间） |

**不动**：P2 全部（p2Grace=720 是 armor-flood 教训）；P1 grace 180（它靠视野自然渐进）；mid/hard 冷却；HQ_ASSAULT 门槛 1200s；`defensiveAI.ts` 整个文件零改动（它只查表）。

### EP-V1b — 前置先锋（deployment.ts 位置调整，总兵力零变化）｜风险：低
把两组现有敌军**东移**到中场（不新增单位，不破坏总量平衡）：
- Forward Screening Force：(190,50) 8步兵+2轻坦 → **(272,42)** 一带（北中路，威胁 coastal/central post，距离 ~90-110 tiles）；
- Southern Reserve：(150,180) 6步兵+2轻坦 → **(265,185)** 一带（南路，威胁 south post）。

P4/P3 的 pool 按 closest-to-target 抽人 → 先锋自然成为首波兵源，行军时间从 ~170s 降到 ~60-90s。位置是 tunable，bench 按「首波接敌时间落在 60-100s」校准。注意避开 Devil's Gardens 雷区带（走廊坐标 x≈300 有绕行点，先锋放走廊西入口附近）。

### EP-V1c — 波次规模（P4_WAVE_SIZE easy 档）｜风险：低-中（平衡敏感）
| 档位 | 现值 | 改为 | 理由 |
|---|---|---|---|
| easy.raid | [4,5] | **[6,8]** | 8-9 驻军打得动，但增援可守 |
| easy.finish_post | [4,6] | **[6,8]** | 跟进波真能收掉伤残 post |
| easy.probe / recapture | 不动 | 不动 | 试探保持小股；夺回本来就大 |

mid/hard 档全部不动（后期节奏已被 playtest 校准过）。

## 4. 绝不碰

`enemyAI.ts`（defensive 短路保持）、`autoBehavior.ts`、`warPhase.ts`、`reportSignals.ts`、`director.ts`、`decisionReview.ts`、命门（ai.ts SYSTEM_PROMPT/RULES/DOCTRINE）、`schema.ts`、`tacticalPlanner.ts`、玩家 command path（ChatPanel/GameCanvas 零改动）、6b 不开、参谋不自动调兵、dual_island（走 legacy 表，零影响）。

**不瞬移/不作弊**：全部走 applyEnemyOrders 正常行军+A*；fog 规则不动；不加兵（V1b 只挪位置）；HQ 冲脸门槛不动 → 不存在无解开局（败条件是丢 3 前哨，开局压强最多威胁 1-2 个，玩家有 30 分钟局面）。

## 5. Bench 标准（?nofog=1 观察 + 正常 fog 各一局）

- **B1 节奏**：t≈15-30s 首波出发可见；t≈45-70s 试探队出发；**t≤100s 第一次真实交火**（UNDER_ATTACK 战报）；t≤180s 两个不同前哨方向都出现过敌军压力。
- **B2 挂机局**（不下任何命令 6 分钟）：至少一个前哨进入 FACILITY_CONTESTED 且**真实失守**（POSTS LOST ≥1）；但 10 分钟内 lost ≤2（不无解崩盘）。
- **B3 干预局**：同样开局，60-120s 内下令增援被压前哨 → post 守住 → ~90s 后 7e 复盘出现（「顶住了」）。玩家操作可逆转 = 核心判据。
- **B4 war-room 联动**：escalation 问句因真实压力出现（不刷屏，7d 预算生效）；Chen/Marcus proactive 有内容可说；报告道不被淹没。
- **B5 回归**：dual_island 行为不变（legacy 表）；玩家命令解析/延迟不变；P2 在 12 分钟前绝不出现（armor-flood 不回归）；敌军 fuel 不提前见底（观察 P4 diag 无连续 hold）。

## 6. 风险与对策

1. **压强过头劝退新手**（最大）：三步全是集中常数，V1c 单独可回退；丢 1 点≠输（3 点才败），丢点本身就是 escalation/复盘的戏剧原料。bench B2 的 "10min lost ≤2" 是护栏。
2. **P0+P3+P4 同 post 叠加过强**：现有 MAX_ACTIVE_ATTACKERS=24 软帽在管；bench 观察，超了再调，不预调。
3. **行军时间估算不准**（unit speed 未核到 tile/s 精度）：V1b 位置是 tunable，bench 用 B1 校准，起始值给的是保守偏近。
4. **敌军早期油耗上升**：敌方 fuel 3300 总量 vs ~1150 需求（scenario 注释），余量 2.9×，风险低；bench 顺带看。
5. **先锋暴露在玩家首波打击下**（玩家开局就推中场）：那是玩家主动进攻换来的正常交换，P0 反击会响应——不是 bug 是对局。

## 7. 执行顺序

V1a（常数）→ typecheck → bench B1 部分 → commit+tag `ep-v1a-timing` → V1b（部署）→ bench B1 完整 → commit+tag `ep-v1b-vanguard` → V1c（规模）→ bench B2/B3/B4/B5 全套 → commit+tag `ep-v1c-wave-size`。每步只暂存该步文件；lockfile 不动；不 add .github/。
