# v4 刀0 取证档（RED 基线）— 2026-08-02，Fable 信封截获

> 现场：pretest worktree @9499b1b（=main），pretest-web:3008 + pretest-api:3011，
> 假时间戳泵帧至游戏 01:44 触发真实升级问句，fetch 拦截 `/api/command-stream` 全信封。
> 本局特征：玩家零编队（SQUADS 节缺席），全军皆未编组群——比用户原局（有 Blake/Aiden）更裸。

## 升级问句（引擎+LLM，01:44）

「长官，中央战线我方单位仅能支撑12秒，敌我战力比1.08。东北方向第一未编组群可在68秒内抵达，是否调动增援？」
（68s 复现＝几何中心 ETA 当场再证；digest FRONT_JUDGMENT 行同源：`best_help=东北方向第一未编组群(10units 无任务 eta≈68s)`）

## ★ 决定性事实：prompt 明令禁止群名当把手

digest 原文（两发请求皆在）：
```
---UNASSIGNED_UNITS--- (spatial groups, observation only — group labels are NOT valid fromSquad)
- 东北方向第一未编组群: 10units(main_tank×6+infantry×4) hp=100% 无任务
```
LLM 看得见群、被告知**不许引用群**、又被升级问句要求调动它——三面墙里即兴发明错法。
诊断档 §2a 推断（fromSquad=群名被闸毙）在本局两发中**均未发生**：LLM 服从了警告。

## 探针 A：裸确认「可以」（ACTIVE_ESCALATION 在场，escalateId=a3fa8be9 随请求）

LLM intent（信封逐字）：
```json
{"type":"defend","fromFront":"front_center","toFront":"front_center","quantity":6,"urgency":"critical"}
{"type":"defend","fromFront":"front_center","toFront":"front_center","unitType":"infantry","quantity":4,...}
```
**自我循环单**：从中央战线抽兵防中央战线（东北群在 68s 外，不在 front_center 池）；数量 6/4=照台词抄构成。
屏上结果：过闸 → Bucket A「您没点名部队，我按战况替您安排」→
「执行: 6 个单位前往3. 中央战线设防 (3 个已调整位置)」+「执行: 1 个单位」——**就地挪窝**；
台词同帧宣称「是，长官。调动东北方向第一未编组群增援中央战线」。

## 探针 B：带尾确认「可以，派他们去」（ACTIVE_ESCALATION 已被 A 消费，本发缺席）

LLM intent：
```json
{"type":"defend","toFront":"front_center","quantity":6,"urgency":"high"}
```
**零来源单**：无 fromSquad 无 fromFront，quantity 6/4 仍照台词抄。屏上同 Bucket A 路径，
6+1 个全局池单位；台词「明白。东北方向第一未编组群增援中央战线」。

## 三种失败形状汇总（含用户 07-31 原局）

| 形状 | 输入 | intent 病 | 结局 |
|---|---|---|---|
| 用户 02:14 | 裸确认 | （当局未抓包；表现=invalid_intent_fields） | 零执行「请确认目标或重述」 |
| 探针 A | 裸确认 | fromFront=toFront 自我循环 | 过闸执行：就地挪 6+1 兵 |
| 探针 B | 带尾确认 | 零来源+抄台词数量 | 过闸执行：全局池 6+1 兵 |

**不变量（RED 判据据此定，家法：测效果不测措辞）**：
① 东北群快照 unitIds ∩ 实际 assignedUnitIds = ∅（群永不动——结构必然，因为它没有合法把手）
② 台词恒宣称「调动东北方向第一未编组群」（因为事实包里有它）
③ 失败的 intent 形状是骰子（三局三样），字段级断言不可靠——bench 断言①②，不断言字段。

## 对 v4 的直接含义

- 刀2 番号＝把 digest 那行警告从「group labels are NOT valid fromSquad」改写成「G# IS」——
  病灶与修法在同一行 prompt 上对齐。
- `escalateId` 已随请求进服务端（probe A 实证）——刀2/刀A 的登记线索现成。
- 诊断档 §2a 推断按本档修正：invalid_intent_fields 是形状之一非恒定路径；回炉结论=RED 用效果级判据。
