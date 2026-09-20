# 教学关 V1 · 步 1 代码审核任务书（2026-09-03）

> 给审核窗：本档自含，不需要上一个会话的上下文。
> 你要审的是**一个 commit**（步 1），不是整把刀——后面五步还没做。

---

## 0. 一句话：这是什么，为什么开

用户拍板做一个**独立的新手引导关**：玩家进正式战役（el_alamein）之前，先在一张
小地图上被手把手教一遍——圈队 / 编队选将军 / 跟艾米莉说生产 / 问马克斯状态 /
指挥陈打下敌方据点 / 弹窗问要不要进正式局。

**背景（决定了什么是"重要"）**：这个游戏的产品命题是「你是司令不是操作员，
军队不听鼠标只听参谋」。首次外部试玩三个人**没有一个真正跟参谋说过话**——
注意力全被基本操作吃掉了。所以引导关的唯一使命是**把玩家送到"跟参谋说话"那一步**。
凡是妨碍这件事的都是 P0，其余都不是。

## 1. 现在做到哪儿（只做了步 1）

| 步 | 内容 | 状态 |
|---|---|---|
| **1** | **小地图本身**（地形/据点/兵营/地名/摆兵） | ✅ 本次要审的 |
| 2 | 入口：开场那张卡改成「进入教学 / 跳过直接玩」 | 未做 |
| 3 | 引导步骤机 + 圈队编队选将军 ×2 | 未做 |
| 4 | 跟艾米莉说生产 / 问马克斯状态 | 未做 |
| 5 | 指挥陈打下敌军哨站 + 结束弹窗 | 未做 |
| 6 | 手测修单 | 未做 |

**所以：不要审"引导流程做得对不对"——它还不存在。只审这张图与它的接线。**

## 2. 环境

```
worktree : /Users/yuqiaohuang/MyProjects/AI Commander-squad-personality
分支     : tutorial-map-v1
基线     : 293a14d（= main，纯文档 commit）
要审的   : add6eb4  教学关 步1: 小地图本身
```

`node_modules` 与 `apps/server/.env` 都齐，不用 `npm install`。

```bash
cd "/Users/yuqiaohuang/MyProjects/AI Commander-squad-personality"
git show --stat add6eb4
git diff 293a14d..add6eb4
```

**跑判据**（三样都该绿）：

```bash
npm run typecheck                          # 四包
bash scripts/run-benches.sh                # 应 27/27
npx tsx scripts/probe-tutorial-map.ts      # 应 16/16
```

**实机**（用 preview_start，别用 Bash 起服务）：`.claude/launch.json` 里的
`squadp-api`(3026) / `squadp-web`(3027)，然后开
`http://localhost:3027/?scenario=tutorial`。
⚠ 起完核一眼工作目录（本项目踩过"端口跑的其实是主仓库"）：
`lsof -nP -iTCP:3027 -sTCP:LISTEN | awk 'NR>1{print $2}' | head -1 | xargs -I{} sh -c 'lsof -a -p {} -d cwd -Fn | grep ^n'`

## 3. 改了什么（大白话）

- **新场景 `tutorial`**，120×80。西边我军营地（指挥部 + 兵营 + 我方哨站）→
  中央谷地 → 东岭（敌军哨站＝过关目标 + 敌军指挥部）。过关＝打下敌军哨站一个目标。
- **玩家的兵刻意摆成上下两坨**（4 步兵 / 3 轻坦，纵向隔 22.5 格），
  因为教学第 1、2 步要"圈一队"再"圈另一队"——摆一起就一框全进去了。
- **敌人不主动动**：不给 `enemyAIMode` ⇒ El Alamein 那套防御 AI 整个不跑。
- 新文件：`packages/shared/src/scenario/tutorial/*`、`packages/core/src/scenario/tutorial/*`、
  `scripts/probe-tutorial-map.ts`。
- 改到的老文件只有四个：`shared/scenario/index.ts`（加一行导出）、
  `shared/types.ts`（`ScenarioId` 加第三个值）、`core/scenario/createInitialGameState.ts`
  （加分支 + `createUnit` 加 export）、`apps/web/src/GameCanvas.tsx`（URL 解析收敛 + 镜头）。

## 4. ★ 审核重点，按风险排序

### P0-①　教学关会不会教一套跟正式局不一样的规则（**实施窗自己挖出来的，尚未修**）

全仓有三处 `scenarioId === "el_alamein"` 的**二选一**分支，教学图会静默掉进
"其他场景"那一侧：

| 位置 | el_alamein | 其他场景（教学图现在走这条） |
|---|---|---|
| `packages/core/src/economy.ts:134` `countCaptureContenders` | **所有地面单位**能占点 | **只有步兵**能占点 |
| `packages/core/src/tacticalPlanner.ts:1272` | 派兵占点用全部地面单位 | 优先只挑步兵 |
| `packages/core/src/fog.ts:32,39` | 一套调过的视野表 | `unit.visionRange` 默认值 |

**后果**：教学第 5 步"指挥陈打下敌军哨站"，玩家要是派那 3 辆轻坦，
**永远打不下来**；而在正式局里坦克是能占的。

**请独立复核，然后给修法意见**（实施窗有倾向但没动手，等你的判断）：

- (a) 三处各加 `|| scenarioId === "tutorial"` —— 直白，但是枚举
- (b) 反过来把 `dual_island` 当遗留特例（`!== "dual_island"`）—— 一处一改，但改动波及正式局
- (c) 抽一个谓词（如 `usesGroundCaptureRules(state)`）收敛成唯一真相源 —— 最治本，改动最大

★ 顺带核一句**文案红线**：项目账本里「只有步兵能占点」被记作**假话**，
那是对 el_alamein 说的；在默认分支它是**真的**。教学关将来写台词时别踩反。

### P0-②　`ScenarioId` 加了第三个值，还有没有别处漏网

实施窗查到的二选一清单在上表 + `apps/web/src/App.tsx:21`
（`!== "dual_island"` ⇒ 教学图**也会**弹那 12 张卡——步 2 会改，本步有意不动）。
**请自己重新 grep 一遍**，别只信这份清单。重点看有没有基于场景的穷举 switch、
或者假设地图很大（120×80 比 el_alamein 的 500×300 小很多）的地方：
镜头 `clampCamera`/`getMinZoom`、小地图、迷雾初始化。

### P1-③　实施窗自己宣称过、你该重算的数

家法：**谁报的数字，另一方必须重算一遍才作数。**

1. 「`processDefensiveAI` 的闸不看 scenarioId，`GameCanvas.tsx:1740` 那句
   `no-op for other scenarios` 的注释是错的」——请自己读那两个函数确认。
2. 「过关目标必须是可占类型；`barracks`/`headquarters` 在 `NON_CAPTURABLE` 黑名单里」。
3. 「信封里**分区名 1/16 进、设施名 19/19 进**」——这条是改判据的依据，值得重跑。
4. 「探针 16/16、run-benches 27/27、typecheck 四包」。
5. 「`createUnit` 两份拷贝逐字节相同」（`createInitialGameState.ts` 与
   `elAlamein/deployment.ts:10`）——本刀只加 export 没抄第三份，也没动 elAlamein 那份。

### P1-④　绊索自证是否成立

家法：新判据必须先证明它咬得住病。实施窗做过一次——把 `enemyAIMode` 临时设成
`"defensive"`，探针的两条断言变红，且实测敌军 200 秒内真的被推动。
**请自己复现一次**，并看看探针里**其余断言有没有恒真的**
（尤其"两坨间距 ≥20 格"和"信封指得到地方"这两条）。

### P2-⑤　设计合理性（给意见即可，不必动手）

- 东边整片是迷雾，玩家看不见敌军哨站。用户还没定：(a) 维持（逼玩家问陈）/
  (b) 教学关开局照亮 / (c) 陈在第 5 步主动报。实施窗倾向 (c)。
- `maxFriendlyKeypointsLost=2` 而我方只有 1 个据点 ⇒ 失守那条永不触发。
  但**这不等于"输不了"**（档头已改准）：`warPhase.ts:179` 总部被摧毁、
  `:147` 到点结算两条场景无关的路仍通着。请确认这个说法现在是准确的。

## 5. 明确**不在**范围内（别提）

- 引导流程本身（步 2-6 还没做）
- 生产级工程建议：测试覆盖率、CI、性能优化、重构 el_alamein
- `elAlamein/deployment.ts:10` 那份 `createUnit` 旧拷贝（承重文件，已就地记账）
- 教学关的美术/地形好不好看
- 项目处于 MVP 验证期：**此刻的敌人不是"代码不够好"，是"还没验证玩家爱不爱玩"**。
  建议先过一遍滤网：「这直接影响玩家能不能被送到'跟参谋说话'那一步吗？」否 → 一句话带过或不提。

## 6. 家法（审核窗也要守）

- **P0（阻碍当前目标的）详细说；通用最佳实践偏离一句话带过，不展开。**
- 只审被要求的范围；发现周边问题，**报告但不动手**。
- 有疑问先问「这个取舍的原因」，别默认它是错的——文档没覆盖的取舍大概率是有意的。
- **判据要测效果不测措辞**：会动兵的断言要数 `assignedUnitIds` 并核实际落点坐标，
  不看回执台词。
- **台架有盲区**：`processAutoBehavior` 与导演都不在 `tick()` 里（只有 `GameCanvas.tsx` 调），
  27/27 绿**不代表**这两块验过。
- 不许在主仓库 `/Users/yuqiaohuang/MyProjects/AI Commander` 动工，那里只读。

## 7. 交回什么

1. P0-① 的独立复核结论 + 你推荐哪个修法（a/b/c 或第四种），一句话理由
2. P0-② 你自己 grep 出来的漏网清单（如果有）
3. P1-③ 五条数字，哪些复算对了、哪些对不上
4. P1-④ 绊索复现结果 + 有没有恒真断言
5. 其余按「P0 详述 / 其他一句话」输出
