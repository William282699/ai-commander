# B3 号复用 v1 · 半页 mini-proposal（开工前报审）

> 基线 main `726ce16`（=origin）。分支 `b3-handle-reuse-v1`，worktree 复用。
> 合同五条我逐条对着机器推演过：**①③⑤ 照收，②④ 有结构性问题，见下。未动一行代码。**

## 先报现场：号为什么会换（RED 的靶子）

`mintSpokenForce` 有**两个**调用点，都在 `intelDigest` 里，而 digest **每条命令重建一次**：

| 调用点 | front | 票面 `targetFrontId` |
|---|---|---|
| 板子行 `intelDigest:89` | **null** | `""` |
| FRONT_JUDGMENT 行 `intelDigest:96` | **传 front** | `front.id` |

⇒ 每回合、每一行、都无条件 `mintOne` 一张新票，`seq++`。同一批人两回合两个号，机制就在这儿。

## ①③⑤ 照收

- **① 范围**：只动 `mintSpokenForce` 这条路，escalation 铸票零字节。同意，且我要
  **把它做成断言**（见 ⑤④ negctl）。
- **③ 不覆写冻结字段 + `printedLabels` append-only + `glued` 改判"前缀 ∈ 印过的组合"**：
  同意，这是自家打印记账不是模糊匹配。**补一条**：追加时**去重**（名字只在
  8% 的位移上才变，去重后每票最多两三条，不会长成长尾）。回执用最新印出的名。
- **⑤ 验收**：四组断言照做，RED 先行在**生产路径**（连跑两次 `buildDigestForChannel`
  比同名单的 G#）复现"同名单两号"。

## ② 有问题：谓词按字面**不能**隔开两个家族

合同 ① 要求"escalation 路零字节"，但合同 ② 的谓词是
`memberIds + targetFrontId + targetFacilityId + 未burn未过期`——
**判读行那条路 `targetFrontId = front.id`，与同一条战线的 escalation 票面完全同形**。
名单再撞上（危机线上的那支队，两边都会点到它），谓词就会让**板子复用掉一张升级票**
——正是 ① 要防的"跨案复用 → `ticketDestinationVerdict` 拿错 anchor/provenance"。

**我的修法（请裁）**：票上加一个**家族标记** `origin: "spoken" | "escalation"`，
复用**只在 `origin==="spoken"` 内部查**。这不是放宽谓词，是给它加一维；
escalation 票**永不参与复用**，① 由此变成结构保证而不是约定。

## ④ 有问题：`lastPrintedAt` 会拉断 ⇄ 120s 那条对仗

`TICKET_TTL_SEC` 注释里写死了：**它必须等于 `messageStore.ESCALATION_WINDOW_SEC`**，
理由是"票活得比问句久 ⇒ 一句『可以』落在已经不在屏上的提案上（P0-1 形状）"。
而 `lookupEscalationTicket` 是**两个家族共用的**那一个查法。
按字面把过期改成从 `lastPrintedAt` 起算，escalation 票会被**重印续命**，
那条对仗当场断。

**我的修法（请裁）**：`lastPrintedAt` 起算**只对 `origin==="spoken"` 生效**；
escalation 票仍从 `mintedAt` 起算，⇄ 对仗一字不动。
理由与合同 ④ 给的一致（"刚印给你看的号 120s 内有效"）——**但那个理由只对
一直在屏上重印的板子行成立**；升级提案的问句不会重印，它的 120s 本来就该从提问算起。

## 三条 rider（裁定 2026-08-12 追加；②④ 修正案已准）

**R1 · "escalation 逐字节 negctl" 重新定义。** escalation 票也会带上新字段
（`origin`/`printedLabels`/`lastPrintedAt`），**裸对象逐字节比对天然过不了**
——写成那样等于埋一条注定红的断言，逼将来的自己临场放宽口径。改判三件：
① `ticketPromptLine` 输出逐字节同；② lookup/burn/verdict 的**生命周期行为**同；
③ 对象**投影**（剔除声明过的那三个新字段）逐字节同。

**R2 · 复用票的回执 ETA 会陈旧（≤120s）——v1 接受，记为已知账。**
判读行的票带 `etaSec`；复用之后回执念的是**首铸时**的估算，可能与长官刚在行上
看到的数字对不上。**退路已想好**：手测若膈应，把复用收窄到**板子行**
（`targetFrontId=""`、`etaSec` 恒 null），这笔账自动消失。

**R3 · RED 必须走生产 opt-in。** 用 `buildDigestForChannel(…, mintForceHandles=true)`
连跑两次比号。那个 flag 的本意就是"台架默认不铸票"，
**RED 不开它＝在测一条不铸票的死路。**

## 施工顺序（一步一测一 commit，实现与断言分开）

1. RED：生产 opt-in 路径复现"同名单两号"（先跑红，R3）
2. `origin` + `printedLabels` + `lastPrintedAt`（纯加字段，零行为变化，全家须绿）
3. 复用谓词接进 `mintSpokenForce`（行为变化只在这一步）
4. `glued` 改判"前缀 ∈ 印过的组合"
5. 断言：⑤ 的四组 + escalation 三件式 negctl（R1）

## 我做不到 / 不打算做的

- **不承诺 8% 翻转率下降**。本刀治的是**号**，不是名字。名字仍会翻，
  只是翻了之后号不再跟着换（这正是 ③ 要 `printedLabels` 的原因）。
- **prompt 面零字节**，确认。

---
**Opus 5 · 2026-08-12 · 未动代码 · ②④ 等裁**
