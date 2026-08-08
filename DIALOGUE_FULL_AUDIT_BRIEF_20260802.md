# 对话层全量审计交接档（2026-08-02）— 给新开的 Fable 5 主审窗口 + Opus 5 联审窗口

> **用户判决原话：「说话也很傻逼，就完全拉完了」。** 对话体验整体劣化。
> 之前所有审核都是切片式（每刀各自全绿），没有人对整体负责——本次审计的死命令：
> **看完全部相关代码，理解勾稽关系。不许因为长就只看一部分——切片就是偏移的根源。**
> 先诊断后动刀；诊断期一行代码不许改（家法 no-implementation-in-main-cwd，实施必开 worktree）。

## 0. 审计任务（一句话）

回答：对话层为什么变傻了——逐条症状归因到代码行，画出"谁在说话、读的什么事实、
哪里有两个真相源、哪里措辞超过事实"的完整勾稽图，给出按疼痛排序的手术单。

## 1. 现场状态

- **main** = `668fbc2`（干净，tag `pretest-polish-v1-done` @9499b1b 在）
- **worktree `../AI Commander-approval-v4`** 分支 `approval-contract-v4`，8 commit 全部经切片审计绿：
  `eefc126` 刀1 ETA锚点 / `8ae228d` 刀2a 番号登记簿 / `2f30003` 刀2b 接线 /
  `56828da` 刀3 互射钟+P1日志 / `72e21fa` 刀2c 闸层认番号 / `18c38bf` 手测账①路线截断 /
  `5d30ed5` 手测账②删罐头话 / `18e708a` 手测账③调度权
- 背景档（是线索不是结论，**结论必须自己从代码重推**）：`APPROVAL_CONTRACT_V4_PROPOSAL.md`
  （含 §6b/6c 全部裁定史）、`ESCALATION_ACK_V4_DIAGNOSIS_20260801.md`、
  `APPROVAL_CONTRACT_V4_RED_EVIDENCE.md`、保护分支 `approval-contract-v3.2-failed-handtest`
  （HANDTEST_FAILURE_20260722.md 四 P0 原文）
- dev：approval worktree 上 web:3009 / api:3012（或用主仓库 launch.json 的 approval-web/api 配置）

## 2. 症状清单（用户两局真人手测，截图原文）

1. **增援推荐不可行动，两个子病（第二局后 Opus 复现+Fable 代码核实，归因已定）**：
   - **1a 晚到候选从态势板漏出（刀3 半漏，已定罪到行）**：诚实闸只装在合成入口
     （`escalationTicket.ts:159` filterLateCandidates 包住 payload+铸号），
     `commanderPresence.ts:101/:120` 两处**裸调** buildReinforceOptions——信封自相矛盾：
     SITUATION 说 reinforcement_options: none，态势板行还在推销 `best_help=某群(eta≈21s)`
     （存活 1-2s）。陈挑有内容的那句说 → 无号可写 → 写群名 → 撞闸出"已不在编"。
     Opus 台架复现数据：存活 1s / 候选块 none / 铸号 0 / ticketLine null / 板子仍荐 153s 群。
     **修法已备未施**（冻结给审计当基线）：板子两处同过 filterLateCandidates；断言写成
     "**所有说话面**枚举表"而非逐面各写（Opus 自省：逐面写下次还漏第三个面）。
   - **1b 来得及的候选经咨询路径仍无把手**：升级没触发时玩家问"怎么办"，陈从 best_help
     荐一支来得及的部队，"可以"依旧无号可绑（番号只在引擎提案时铸）。方向=v4.1
     best_help 铸号。**1a≠1b：晚到的该过滤掉，来得及的该给号。**
2. **stale 警告死循环**：LLM 把群名写进 fromSquad → 闸拦 → 「⚠ 这条引用的 XX 已不在编——
   确认要继续，还是另指部队？」→ 用户答"可以"→ **原句复读**。确认通道没接线；
   "已不在编"对从来不是编队的群名是误导措辞。（1a 修掉后此症状的晚到触发源消失，
   但死循环通道本身仍在，独立成账。）
3. **战况播报谎报交火**：「快顶不住了——正承受重火力」「遇袭，正在接战」在**没有交火**的
   战线上刷屏（用户实证中央战线无交火时照报）。疑似触发器量的是威胁在场（敌 DPS 进范围），
   模板措辞却断言正在挨打——需从 director beats/war-room 代码取证。
4. **LLM 台词自相矛盾**：同一分钟内「兵力比零点八一…态势正在缓和」vs「战力比仅0.01」；
   「艾登一人可增援」（1 个残兵当增援报）；「东北方向第二未编组群」下一条变「第三」。
5. **播报轰炸**：遇袭/快顶不住了/减员严重 高频复读，信息密度低，通讯频道像日志不像人。
6. **整体判决**：以上叠加 = 对话读起来机械、重复、矛盾、不可行动。单件小病，合起来拉完。

## 3. 必读代码清单（全文读，不许抽样；按勾稽顺序）

> **★读哪份代码：一律以 worktree `/Users/yuqiaohuang/MyProjects/AI Commander-approval-v4`
> 的分支 tip 为准**——全部症状发生在这个构建上；main 只作 diff 对照。诊断期零实施；
> 之后的手术也在这个 worktree 里做（它就是实施区）。
> 版本关系背景：main（668fbc2）已含 pretest-polish 全部视觉改动（tag
> `pretest-polish-v1-done` 已合并）；本 worktree 从 main 分出，故也含它们；
> **未合 main 的只有本分支的 v4 八~九个 commit**。

**说话者与事实源（core）**：
- `packages/core/src/crisisResponse.ts` — tCollapse/互射钟/battleAnchorFor，一切"撑几秒"的源头
- `packages/core/src/director.ts` — beats/升级问句触发/事实包/COLLAPSE_DANGER_SEC/播报节奏
- `packages/core/src/frontEscalationPayload.ts` — 升级候选 builder（B案核心）/诚实闸过滤
- `packages/core/src/escalationTicket.ts` — 番号登记簿/生命周期/许可行
- `packages/core/src/commandAuthority.ts` — 调度权（手测账③）
- `packages/core/src/commanderPresence.ts` — 态势板 survival/best_help/mood（谁喂 LLM 战况）
- `packages/core/src/decisionReview.ts` — 复盘口径（与 presence 共享 wrapper 的勾稽）
- `packages/core/src/battleBoard.ts` + `battleContext.ts` — 板子/Marcus FORCES（两墙禁令之二）
- `packages/core/src/tacticalPlanner.ts` — resolveIntent 全链（selectedUnitIds 硬约束/Bucket 语义）
- `packages/core/src/reportSignals.ts`、`missions.ts`、`advisorTrigger.ts`、`doctrine.ts` — 其余发声机器
- `packages/shared/src/digest.ts` — 信封的最终拼装（UNASSIGNED_UNITS 禁令墙/SQUADS 归属渲染）
- `packages/shared/src/constants.ts`、`types.ts`

**接线与模板（web/server）**：
- `apps/web/src/ChatPanel.tsx` **全文**——闸（isValidTarget/detectStaleSquadRefs）、Bucket A、
  绊索、番号翻译、stale 警告死循环（症状2 病灶）、所有 addMessage 的模板句
- `apps/web/src/GameCanvas.tsx` — 升级铸号原子块/心跳/战况播报的注入点（症状3/5 病灶带）
- `apps/web/src/messageStore.ts` — ActiveEscalation 窗口
- `apps/server/src/ai.ts` **全文**——所有 prompt。特别审：历级叠加的规则是否互相矛盾、
  是否臃肿到模型顾此失彼（症状4 的一号嫌疑：prompt 债）

## 4. 勾稽关系图（审计要验证/修正的假设骨架，不许照抄当结论）

- "撑几秒"有**三个钟**：悲观钟（内部触发）、互射钟（说话）、复盘基线——口径原则
  "对内触发用悲观钟，对人说话用互射钟"是否全链贯彻？有无第四处漏网？
- "增援候选"有**三条出口**：引擎主动提案（铸号✓）、态势板 best_help（无号✗=症状1）、
  板子 UNASSIGNED 行（禁令墙）。三处成员集是否同源？措辞是否一致？
- "说话的人"有**两族**：引擎模板（war-room 行/回执/警告）与 LLM 人格。每条模板句
  逐句对照家法「台词禁死模板」「对话是唯一界面」清算：它断言的事实触发器保真吗（症状3）？
- "可以"有**四条路**：preflight 合同/番号翻译/绊索/普通命令链。路由完备吗？
  stale 警告的"确认要继续"接到哪条路（症状2 实证：哪条都没接）？
- **★同一把尺定律（症状 1a 的教训，审计必验的系统不变量）**：任何对候选/数字做的
  诚实过滤，必须覆盖**全部说话面**——先枚举"哪些代码路径会把增援候选渲染进信封"
  （已知：升级 payload、态势板 best_help、battleBoard groups、battleContext FORCES，
  是否有第五处？），再逐面核过滤/铸号覆盖。断言写在枚举表上，不逐面散写。
  刀3 只换了板子的 tCollapse 忘了候选过滤＝这条定律的第一个实证违例。
- prompt 是否已成**规则堆积层**：历级语义原则逐条列出来数一数，找互相冲突/过时/冗余。

## 5. 家法（审计纪律）

判据测效果不测措辞（栽过五次）· 谁报的数字对方重算才作数 · 台词禁死模板 ·
对话是唯一界面 · 禁关键词枚举 · 治本先全仓 grep 找副本 · 先诊断后实施（worktree）·
每个结论给 file:line · **前会话的档案与本文件的假设都只是线索，结论必须从代码重推**。

## 6. 分工与交付

- **Fable 5 主审**：全量读码 → 勾稽图（修正 §4）→ 症状逐条归因到行 → 手术单（按疼痛排序、
  每刀标大小与风险）。
- **Opus 5 联审**：独立全量读码（不先看 Fable 结论），出自己的归因表，然后互相对账——
  分歧点逐条辩到收敛，达不成一致的列为"待用户裁"。
- 交付一份联合诊断档（含手术单）给用户拍板。**诊断期零实施。**
