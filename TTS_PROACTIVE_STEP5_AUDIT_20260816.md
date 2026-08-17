# 步 5 对审发现档（Fable 三路对审，2026-08-16）

> 对象＝`d96cebc`（步 5 收口态）＋对审期间磁盘上的步 6 WIP。
> 三路：触发合同四条／执行语义零变更／判据非恒真。**三路全判 issues_found。**
> 结论：**步 5 的行为骨架成立（硬边界没破），但两处真伤＋一处 WIP 新病必须先修；
> 判据侧有一格是本刀最承重的恒真格。** 建议：步 5b 补丁刀（P0 三笔）→ 续步 6。

## P0（必修，且其中一笔正在发生）

### P0-A ★「执行语义零变更」那格是恒真的——本刀最硬的边界，判据是空的

`assert-step5.mjs` 的前后快照读的是 `u.task / u.x / u.y / u.targetX / u.targetY`。
**Unit 上这五个字段一个都不存在**：真实形状（`packages/shared/src/types.ts` 的
`interface Unit`）是 `position:{x,y}` / `target` / `state` / `orders` / `waypoints`；
全仓 `targetX` 零命中。实测同一行序列化出来是 `[[7,null,null,null,null,null]]`
——快照实际只是**单位 id 名单**，任务/坐标/目标点全是常量 null。

后果：甩脸路径就算把所有单位 orders 清空、把兵瞬移到地图另一头，这格照样绿；
连阵亡都动不了它（死兵不出 Map）。**判据恒真第七次同形，且栽在最承重那格。**

修法：①快照改真实字段（`position.x/y`、`target`、`state`、`orders` 内容）；
②加前置断言证明甩脸真触发了（现在只靠兄弟格兜着，单看这格甩脸没发生也绿）；
③补一格观测**对的对象**——本刀的敞口在 `_escalations`（模块态）不在 `state.units`：
断言「复呼之后活单还在」「甩脸之后引擎账本未被本刀动过」（assert-step5 现在
零处读 escalation 状态）。

### P0-B ★ escWatchRef 跨局泄漏＝重开局第一拍就甩上一局的脸

`escWatchRef`（步 5 新引入）**不随重开局清账**。出声 effect 那边 epoch 处理得
很干净（`spokenRef.clear()` / `stashRef.length = 0`），轮询里也有既有的时钟回拨
清账惯例（`channelContextRef` 重置），**唯独漏了这个 ref**。

复现链：上一局 combat 有未答请示 → `handleRestart` → `clearMessages()` 把
`_escalations` 三格置 null、消息清空，而 ChatPanel 无 key 不重挂 ⇒ ref 存活 →
新局第一拍：`live=null`、`w=上一局快照`、`lastPlayerMsgTime=null` ⇒ 判 `expire`
⇒ **上屏且出声，还把上一局的问句逐字送进 LLM 请求**（digest 里
「你刚才问过长官：「…」」）。`kind:"expire"` 不查活单、age≈0 过新鲜度，两道闸
都拦不住。台架够不到（node 只喂纯函数，ref 生命周期无断言）。

修法：escWatchRef 随 epoch 清（与 spokenRef/stashRef 同处理）；补 node 断言。

### P0-C ★ 步 6 WIP 里的新病：闪烁灯 5Hz 撒谎（未提交，现在就在磁盘上）

对审读到磁盘上未提交的步 6 代码：`nextPending[ch]` 读的是**同一拍 mutate 之后**
的 `escWatchRef`，撞上步 5 的 drop↔track 5Hz 振荡（长官已回话但活单仍在——
NOOP/澄清有意保活——drop 拍 `wNow=null` → pending=true，track 拍 → false）。
后果：频道键以 5Hz 真闪、**灯半数时间在撒谎**，且面板每 200ms 重渲染。
撞 C3「灯不许撒谎」家法。

修法：pending 判定不读被同拍改写的 ref，改读稳定源（live 活单 ∧ 未回话），
或把判定移到 mutate 之前取快照。

## P1（收口前必修）

| # | 事 | 要点 |
|---|---|---|
| B1 | fireExpire 异步回包无 epoch 守卫 | 6s abort 窗内重开 → 上一局甩脸投进新局；且 `postFollowup` 落地时**重取 `s.time` 盖新时间戳**，正好废掉为异步迟到写的 age 闸。同文件应答链有现成守卫形状（`if (getState() !== state) return`）可抄 |
| B2 | 甩脸走的是**战报 prompt**不是主动台词 mode | `fireExpire` 不传 `mode` ⇒ 服务端落 `briefMode="brief"` ⇒ 用 `CHANNEL_PROMPTS` 那条战报提示词（**明禁首字 acknowledgment**，而甩脸正是一句交代）。三个兄弟主动路径都显式传 mode。web 侧唯一守卫是问号检测 ⇒ **一句合格战报（无问号）会原样当甩脸念出去**。commit message 称「同 proactive/retrospect」与实际不符 |
| B3 | 弹窗二次挂载重放复呼 | 新 ChatPanel 实例 `escWatchRef` 全 null ⇒ 重新 track、`nagged` 复位 ⇒ 同一张单第二次复呼；收回面板 → 第三次。另一条洗号路径：drop 把 watch 置 null 后下一拍 track 回来 |
| B4 | 群聊回话不消账 | 玩家消息只落 `primaryChannel`（ALL 模式只有首位那人的频道）⇒ 长官刚在群里说完话，另两个频道的活单照样复呼/甩脸＝**本刀立案时最怕的「你答了他还骂你」** |
| B5 | nagPoolFrozen 只锁基数不锁内容 | 三句改成任意内容（甚至三句全同）照绿；且**没有一格断言复呼台词属于该 persona 的池**——串池 bug（陈说了 Emily 那句）抓不到 |
| B6 | negctl 硬线是 `failCount > 0` 不是 `=== 15` | 15 把刀里 14 把失效仍打 `NEGCTL OK` 并 exit 0；数量只存在于 commit message 的人工抄写里，机器不认。注释声称的覆盖面超出代码 |

## P2（记账／小修）

1. `?expire=N` 只改 followup 判定、不动引擎 TTL ⇒ 甩脸说「不等了」，而单子在引擎侧
   还能被执行 115 秒＝**嘴与账本对不上**的新形态（硬边界仍成立，但要记账）；
   且该参数从 `window.location.search` 读、**随生产包发布不在 dev 闸后**。
2. 真·引擎 TTL 触发**没有端到端格**（浏览器 expire 格走 `?expire=` 捷径），
   只有源码阅读＋node 合成 `live:null` 覆盖。
3. 生产按钮点击不算「回话」（`source="command_ack"`）⇒ Emily 频道有活单时长官
   连点生产按钮，复呼照常。
4. 「弹窗态嗓子仍是陈」用 `every()` ⇒ **空数组返回 true**，一发 TTS 没打出去也绿
   （正是委托第 8 参漏抄那个坑的表现），需前置断言。
5. 设计取舍（非缺陷，记账）：只要长官在该频道说过**任何**一句话，这张单就永不
   甩脸 ⇒「说了别的 → 单静默过期 → 屏上仍无交代」这一支本刀没覆盖。
6. `playerRepliedSince` 用严格 `>`，同刻边界（`lastPlayerMsgTime === createdAt`）
   两侧无测试。
7. 浏览器那 13 格**没有常驻负对照**（摘第 8 参是一次性手动动作，没落成可重跑的
   negctl 臂）。
8. 出声 effect 新增了 `syncGameEpoch` 第四个调用点（有副作用：bump epoch＋清
   `pendingContractRef`）——判为无语义变更（既有两处已在同条件下调），但属于把
   动授权侧 ref 接进出声链的耦合，需知道。

## 硬边界复核（好消息）

- 全刀 `apps/server` 与 `packages` **零字节**（`git diff --name-only` 空）。
- 步 5 新增路径**零副作用调用**：只有 `addMessage`、一处 `fetch(/api/brief)`、
  `panelWin.close()`；`clearEscalation` 三个调用点全是既有的，一个没碰。
- `/api/brief` 经服务端源码核实是**纯生成**：零 IO、零状态写、连 logEvent 都不走
  （路由注释逐字写着不记日志）；返回只取 `brief`。
- **`utterance` 字段不泄漏进 LLM 输入**：digest 由 GameState 造，`packages/core`
  从不 import messageStore；信封六段无一读 feed（结构性隔离，非约定）。
- nag/expire 消息进 feed 后**不会被当成新指令/新承诺**：不进 CONTEXT、不进
  commitment、不进 ACTIVE_ESCALATION；其 `source="command_ack"` 也匹配不上
  `getLastMessageTimeBySource(ch,"player")`，不自噬。
- 游戏钟合同（C2）**完全成立**：判定路径每个时间读取点都是游戏钟，无新计时器；
  唯一墙钟是 LLM fetch 的 6s abort，不参与触发判定。
- actionId 快照在**决策时刻**确实挡住 A/B 竞态（有 node 断言）——缝在异步发话
  时刻（B1）。
- negctl 实跑复现：`--synthetic` 52/0、`--negctl` 37/15，15 条与源码 15 处
  `checkKnife(` 一一对应，步 5 新增三把刀逐条核过均承重。

—— 三路对审（42 万 token）笔录。P0 三笔建议做成「步 5b」补丁刀，P1 六笔收口前清，
P2 进 LEDGER。
