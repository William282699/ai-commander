# 试玩记录仪 V1 · 交付报告（2026-09-28，待复审）

> 按 workplan §11 的七项写。**本地完成 ≠ 线上完成**：没有合 main、没有推送、没有打 tag、没有碰 Fly。
> 数字全部来自本次运行的输出，证据目录：`~/MyProjects/_archive/playtest-recorder-v1-20260928/`（不入库）。

## 1. 分支、SHA、改动、状态

- worktree `/Users/yuqiaohuang/MyProjects/AI Commander-playtest-recorder`，分支 `playtest-recorder-v1`（新建，未占用旧名）。
- 基线 `ac237c7`（＝main＝origin/main＝内测 tag `internal-test-baseline-20260927`，未移动）。
- 三个本地 commit：`981ef8a` Step 1 记录合同与存储 → `60e24bc` Step 2 接入生产事实（含浏览器验证抓到的八处修正）→ Step 3（本报告所在 commit）工具、脚本、文档。
- 主工作区一个文件没改（`launch.json` 例外见下）；未跟踪交接文件全保留。
- **为了用预览窗口**，在主仓库 `.claude/launch.json` 末尾**追加**了三条（`recorder-api` 3041 / `recorder-web` 3040 / `recorder-prod` 3042），并新建三个 `.claude/start-recorder-*.sh`；原有条目逐字未动（改前副本在会话临时目录）。用完可直接删这三条。
- worktree 里 `apps/server/.env` 是指向主仓库 `.env` 的符号链接（与 retreat-dev 同做法，已被 gitignore/dockerignore 排除）。

改动清单（相对 `ac237c7`）：

| 位置 | 内容 |
| --- | --- |
| `packages/shared/src/recorderProtocol.ts`（新，不进 shared index） | 事件信封、白名单复制＋截断标注、服务端校验、UTF-8 计字节、上传应答类型、专门应答状态码 410 |
| `apps/server/src/recorder/*`（新） | store（按局 JSONL、fsync 后 ACK、启动重扫、去重/冲突、配额、保留期、邀请只存哈希）、summary（完整性三分）、export（ZIP＋离线报告）、zip、context（请求上下文）、routes（上传/状态/管理员）、adminPage |
| `apps/server/src/index.ts` | 挂记录仪路由；游戏关闭闸只放行记录仪路由；命令路由前的上下文中间件；SIGINT/SIGTERM 先排空再退出（4 s 上限）；生产 `[EVENT]` 只打长度 |
| `apps/server/src/traceLog.ts` | `traceWrite` 顶上一行旁观挂点 |
| `apps/server/src/ai.ts` | 四处解析失败日志生产只打长度；非流路补记 `parse_failed`/`model_error` 两行 trace |
| `apps/web/src/recorder/*`（新） | core（入口首行判开关、队列、上传状态机、快照）、queue（IndexedDB＋关页同步暂存）、uploadVerdict（三分类）、identity（★24）、boot、index（单例＋弹窗委派）、ttsTap、RecorderGate（同意框＋记录条） |
| `apps/web/src/ChatPanel.tsx` | 既有 `traceClient` 调用补“出发 state／回合来源”两个参数与关联字段；新增 `turn`、`plan_registered` 两个取数点；命令请求加记录头（唯一新名字 `recorderHeaders`）；TTS 走 ttsTap；频道/页签/静音三个只记录的 effect |
| `apps/web/src/GameCanvas.tsx` / `App.tsx` / `messageStore.ts` / `advisorTrace.ts` / `main.tsx` | 开局/重开/结局、四处手动下令、桥上挂 recorder、快照附加信息、暂停与教学推进；弹窗开合；消息三个变更点；traceClient 转交；同意框包在最外层 |
| `scripts/chainHarness.ts` | 依赖表加 `recorderHeaders: () => ({})`（同 commit） |
| `scripts/*recorder*` | 台架、对照臂、停机、样包生成、T03 核对、Docker 脚本、一把跑 |
| `.gitignore` / `.dockerignore` | 排除 `recorder-data/` 与 `playtest-*.zip` |

没碰：`tts/index.ts`（逐字节同基线，台架 P5 查）、core 全部模拟/指挥算法、prompt/schema/信封内容、fly.toml、lockfile。Dockerfile 与 GitHub workflow 在复审后经用户批准各改了一处（见 §7 第 1 条）。

## 2. 三项用户功能：做到哪一步、入口

1. **自动记录**：管理员页生成邀请链接 `/?invite=…` → 玩家打开，游戏载入前先问同意（拒绝照玩）→ 地址栏当场抹掉邀请 → 之后每局自动记录并批量上传；左下角任务条上方有一条小记录条（状态、`这里有问题`、`⋯`→`停止记录`）。没邀请的访客界面与今天完全相同（浏览器实测：零 `/api/rec` 请求、零本地存储）。
2. **问题标记**：记录条上 `这里有问题` → 可写一句 → `标记`；不暂停（浏览器实测标记期间游戏钟照走）；自动补一份关键快照、挂上最近回合。一局结束时记录条会问一句可选感受。
3. **按局查看/下载**：`/rec-admin`（凭证只放在页面内存，走 `Authorization` 头）→ 按测试者列出“第几局／场景／时长／结束方式／问题标记数／记录状态”→ `查看`（无脚本沙箱里显示时间线）/ `下载 ZIP` / 生成与作废邀请。

## 3. 记录关／开／故障时的游戏行为

`scripts/probe-recorder-arms.ts`：同一初始局（阿拉曼 85 个我方单位＋敌军）、同一串固定模型回包，走生产命令链（真 HTTP、生产服务端路由），再按 `GameCanvas.tsx:1916–1998` 的顺序每帧调 15 个 core 函数走 150 游戏秒（跳过两处 `escalateCrisisToConversation`），每臂一个进程、种子在导入 core 前装好。

| 臂 | 与 off 臂比（单位/目标/ApplyResult/屏/声/context/请求体/模型输入与次数/钱油队列/台账/150 秒后的全部单位与据点） | 这一臂记录仪实际做了什么 |
| --- | --- | --- |
| off ×2 | 两遍逐字节相同（比较本身有意义） | 零上传、服务端无局 |
| on | 全部一致 | 上传 30 次，服务端收 27 trace＋36 快照＋7 次服务端请求事实 |
| fail（上传全失败） | 全部一致 | 32 次上传全失败，队列留 65 条，状态“故障” |
| full（服务端满盘＋浏览器缓存 30 KB） | 全部一致 | 服务端 507 与“丢事实”标记，浏览器丢采样 310、关键 2 并计数 |
| throw（记录器时钟每次都抛） | 全部一致 | 一条客户端事件都没建成（全被入口 try 接住） |
| 负对照 neg_rng（记录器偷用一次 `Math.random`） | **对不上**（单位、目标、屏、钱油……） | 证明比较抓得到随机数被消耗 |

没改的核心合同：候选 key 绑定、G/M 号、人数、目的地、出发点继承、权限/复核、重复响应抑制、跨局局印、经济扣款、SSE 兜底与执行次数、prompt/schema/digest。`scripts/probe-send-chain.ts` 102、`probe-selection-chain.ts` 112、`probe-retreat-scope.ts` 311、benches 27/27、教学 97/44/39 与基线同数全过；旧断言一条没改（台架只在依赖表加了一个空名字）。

## 4. T01–T18

记号：**PASS**＝按要求验证通过；**部分**＝主体通过、写明缺哪一格；**FAIL**；**未跑**。浏览器＝预览窗格里的真实浏览器（开发构建或本地生产构建）；台架＝node 生产代码。

| # | 结果 | 依据 |
| --- | --- | --- |
| T01 | PASS | 生产构建：A、B 分两个浏览器上下文（localhost / 127.0.0.1 两个源），最终列表 A 4 局、B 6 局（含 B 同时开的第二个标签页＝另一局、B 的教学关一局）；管理员列表按人分开（`evidence/prod-browser/admin-runs-final.json`）。开发构建：A 进出教学关不重问、仍是 A；同浏览器先 A 后 B 链接 ⇒ 问 B 的同意、之后记 B；A 停止记录后重开 A 链接 ⇒ 再问。A 的积压仍用 A 凭证补传（C10）；B 写不进/读不到 A 的局（S4、P2，且玩家侧根本没有读接口） |
| T02 | 部分 | 预览窗格不支持真 `window.open` 弹窗；改用同源 iframe 加载 `?mode=panel` 并把 `opener` 指向主窗——同一套代码、独立第二个 JS 环境。开→说→关→再开→说：两句各只记一条消息、两轮都记在同一局、不产生新局（生产构建）。**真弹窗未验**，建议用户手测第 3 步顺带看 |
| T03 | PASS | 生产构建＋真模型：派两个→改去修理厂→叫回，`check-recorder-t03.ts` 只凭 ZIP：同一对 34/35、三个真实目标、回到各自起点于 21.1 s、之后停住 46 s、其余单位没接到对话令。台架 L7（写明是 `tick`＋`processAutoBehavior` 子集）同样过。负对照：同一核对器对只停了 18 s 的旧包判 FAIL |
| T04 | PASS | 台架 L1–L4：模型语义批准、数量选择、候选部队选择三条**非快捷**路径都从答复追到 pendingId/selectionId、原方案回合、实际接令单位（与游戏里真接令的逐个相等）；「对」/「算了」捷径不请求模型也留记录并连回原方案。负对照：拿掉这次补的关联字段 ⇒ 三条都追不回（L1/L2/L3-负对照） |
| T05 | 部分 | 浏览器：群聊（玩家一句＋三人回复都标 groupChat、零执行）、右键手动下令（`right_click_move`、11 个单位、目标、关键快照）、教学播报（陈的 `proactive`、教学推进 op）。**语音占位→听写的改写**只在台架验（P1 消息改写变更点）；窗格禁用麦克风，浏览器未验 |
| T06 | PASS | 台架 L5/L6：429、流内解析失败、代理拒流后非流兜底、流在单子送达前断开走兜底——每次真实到达服务端的尝试各有请求/失败/收尾，同一回合两次尝试 attempt 不同；游戏只执行一次（或零执行）；无在途未收尾 |
| T07 | PASS | C5 掉 ACK 重传只留一份；C6 断网退避、恢复补传不重复；S2 重复批次与重启后重传只一行；S13 缺序号 ⇒ “已知缺失”、不说收齐。浏览器：断网＋刷新，恢复后积压补齐 |
| T08 | PASS（台架） | C17：重开后旧局的迟到回调带旧 state 只记旧局，新局无假结束；既有跨局守卫未改（arms 全等）。浏览器未专门复现 |
| T09 | 部分 | 浏览器：断网时刷新两次，关页尾巴（收尾标记）经同步暂存保住，恢复后全部补传；正常关页记“页面卸载”（不说玩家退出）⇒ 可达“已确认完整”。浏览器存储被禁的情形只在台架验（内存降级＋如实标注），**浏览器未验** |
| T10 | PASS | S9 目录不可写 ⇒ 503 不 ACK、恢复后不重复；S7 配额/满盘 507；C13 浏览器缓存满先停采样、丢弃计数上报；C6 断网；arms fail/full 臂游戏全等 |
| T11 | PASS | C4 85 个单位全在快照（无 80 截断）；C19 500 个单位写明省略 100、3 万个中文字超单条上限后从原文收紧到 4000 字并写准被截字数；C14 中文批次每个请求体 ≤ 64 KiB |
| T12 | PASS | 未同意零请求（C12＋浏览器）；停止记录清未上传、已上传不动（C11＋浏览器）；无/错/作废凭证（S16、P2）；伪造 runId（S4、P2）；同编号不同内容冲突（S3）；邀请只存哈希（S11）；管理员凭证不进页面/URL（S17）。负对照：C12、C9、S4 |
| T13 | PASS | S12＋浏览器：玩家原话/问题描述含 `<script>`、`<img onerror>`、外链 ⇒ 报告全转义、无脚本、无外链、CSP；S17 路径穿越的 runId 400；S5 鉴权头/邀请头/音频等键名整条拒收 |
| T14 | PASS | 浏览器 tts 事件（文字、角色）、静音状态 op；P5：`tts/index.ts` 与基线逐字节相同，`setPlaybackObserver` 仍只有 ChatPanel 一处 |
| T15 | PASS（真容器，复审补跑 2026-09-28 晚） | 本机装 Colima 后按仓库 Dockerfile 建镜像跑 `scripts/probe-recorder-docker.sh`：`docker stop -t 5`（SIGTERM）与 `docker kill --signal=SIGINT` 各一次，容器都在 ~140 ms 内自己退出（退出码 0），日志 `drain done leftover=0`，40/40 请求事实＋服务端最后序号都在挂载目录；删容器、同一目录起新容器，同一局 ZIP 能下载、manifest 六个文件校验和一致。**旧 CMD（npm）在真容器里两种信号都不过**：SIGTERM 时 npm 641 ms 退出码 1、node 没排空就被收；SIGINT 时 npm 当 PID 1 干脆不理，容器 5 秒内不停。Dockerfile 已改成直接起 node（用户批准），`scripts/probe-recorder-shutdown.ts` 改为按 Dockerfile 解析 CMD 起服务、旧起法降为负对照（14/14 过）。证据 `review-fable-20260928/docker/`（旧 CMD 对照）与 `review-fable-20260928/after-fix/`（改后） |
| T16 | PASS | 见 §3；记录器源码里没有 `Math.random`（C3 逐文件查） |
| T17 | PASS | S14＋浏览器：进行中导出＝“未正常结束/完整性未知”，结束后导出＝“已确认完整”，后者是前者的严格超集，两包各自 sha256 自洽 |
| T18 | PASS | 生产构建：客户端留着未传事件时关采集 ⇒ 专门应答 410 `{recorder:"closed"}` ⇒ 清空这个凭证的队列、记录条显示“记录已由组织者关闭”、游戏照跑，档案一条未增；再关试玩 ⇒ 页面/命令 503，上传仍回专门应答，管理员凭证照样列表/下载、无凭证 401。另测：断网、429、502/503 HTML、410 HTML、门户 200、未点名的 400/413 都不清队列，只有点名的 400 删被点名那条并计数（C1/C6–C8） |

## 5. 样包、生成方法、测试命令、浏览器证据

- **合成样包**：`~/MyProjects/_archive/playtest-recorder-v1-20260928/sample/playtest-A-rvbkDndci2Gx-2026-09-29T01-41-03-328Z.zip`（17,964 字节，sha256 `0aaa85dd…8355b1`，同目录有 `.sha256` 与解开的 `unzipped/`）。七个文件，“已确认完整”，报告无脚本、问题描述里的 `<b>` 已转义；系统 `unzip` 可直接解。
- 生成：`node --import ./scripts/recorder-seed-random.mjs --import tsx scripts/make-recorder-sample.ts <输出目录>`（假模型、合成原话；node 没有 IndexedDB，用一个 Map 替身扮演持久队列，已在脚本里写明）。
- 测试命令：
  - 记录仪全部本机台架：`bash scripts/run-recorder-probes.sh [证据目录]`（store 22／client 26／chain 10／privacy 8／arms 8／shutdown 14 全过；shutdown 探针按 Dockerfile 解析 CMD 起服务，旧起法 npm／npx tsx 是负对照）
  - 既有回归（与计划 §8 一致）：`npm run build`、`node --import tsx scripts/probe-send-chain.ts`、`…probe-selection-chain.ts`、`…probe-retreat-scope.ts --knife=all --negctl`、`bash scripts/run-benches.sh <目录>`、三个教学探针——全过，完整输出在 `evidence/final-regression/`
  - 包的 T03 核对：`node --import tsx scripts/check-recorder-t03.ts <包.zip> [三句原话]`
  - Docker：`bash scripts/probe-recorder-docker.sh <目录>`（这台 Mac 用 Colima：`colima start` 后直接跑；2026-09-28 已在此跑过，ALL PASS）
- 浏览器证据：`evidence/prod-browser/`（生产构建下 A 的真模型 T03 包、关采集/关试玩后的各接口应答、管理员列表）；开发构建阶段抓到的问题见 `60e24bc` 提交说明。
- `send-chain` 的部分负对照依赖本机 `_archive`：本次在这台机器上都在、都跑了（20 条负对照全过），换机器会缺。

## 6. 配额、保存期、容量、性能、缺失显示、权限

- 上限：批次 64 KiB（UTF-8）、单条 48 KiB（超了逐级收紧再装，截在哪写进 `trunc`）、浏览器缓存 20 MiB（存储不可用退内存 4 MiB 并标注）、单局 25 MiB（采样 20 MiB）、全局 250 MiB（另留 1 MiB 给“丢了几条”这类标记）、每个测试者 200 局；保留 14 天，24 小时内有事件的局不清。三个环境变量可调：`RECORDER_GLOBAL_MAX_MB`／`RECORDER_RUN_MAX_MB`／`RECORDER_RETENTION_DAYS`。
- 实测容量：85 单位快照 ≈ 6.0 KB；每 10 秒一份 ≈ 36 KB/分钟；一次命令往返（请求、模型原文、结果、浏览器 trace、执行快照、消息/TTS）≈ 12 KB。30 分钟、约 60 句命令的一局 ≈ 2 MB（估算，非实测整局），250 MiB 约可存 120 局以上。
- 性能：node 里 3000 帧走 150 秒，开/关每帧 p50 0.93/0.92 ms、p95 1.09/1.07 ms；入口同步开销 trace ≈ 5 µs、消息 ≈ 2.8 µs、操作 ≈ 1.5 µs、请求头 ≈ 0.2 µs、85 单位快照 ≈ 6 µs，关闭时 ≈ 0。浏览器（生产构建、同一页先开后关）p50 192.1/191.8 ms、p95 226.6/233.3 ms——预览窗格本身只有约 5 帧/秒，开关无差别；**输入到上屏的延迟没在窗格里单独量**（帧太慢量不准），发送路径上记录器同步多做的事 < 20 µs。
- 缺失的显示：列表与报告里三档“已确认完整／已知缺失／未正常结束·完整性未知”，并逐条写原因（缺哪些序号、丢了几条、截断几条、尾部修复、有无在途请求、有无结束信号）。
- 权限：见 T12/T13/T18；生产控制台 `[EVENT]` 与 ai.ts 四处只打长度（P3/P4，负对照为开发环境照打原文）——代价：`fly logs` 看不到原话，改在管理员页看。

## 7. 本地完成 ≠ 线上完成：需要你另批的事

1. ~~**Dockerfile CMD**（T15 的根因）~~ **已改并在真容器验过**（用户 2026-09-28 批准）：`CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]`，另加 `ARG/ENV RECORDER_BUILD`，`.github/workflows/fly-deploy.yml` 以 `--build-arg RECORDER_BUILD=${{ github.sha }}` 传提交号（否则镜像里没有 .git 也没有 git，manifest.build 恒为 unknown）。这三个文件的改动都在分支上，随合 main 一起上线。
2. **Fly 资源**（均未碰，线上实例数/卷/密钥当前值我没有核实）：建一个持久卷并在 `fly.toml` 挂到如 `/data/recorder`；缩成单机（首次部署默认两台，两台各写各的卷会让列表不全）；配置 `RECORDER_DATA_DIR`、`RECORDER_COLLECT=on`，密钥 `RECORDER_ADMIN_TOKEN`。排空约 10 ms，不需要调大 `kill_timeout`。
3. **合 main／推送／打 tag**：push main 会自动部署并重启线上机器——有人在玩时不要推。
4. 备份与回滚：数据只在卷上；导出靠管理员页逐局下载（批量备份办法待线上核实后定，不经公开 GitHub）。回滚＝把 `RECORDER_COLLECT` 关掉（客户端收到专门应答自行清空并停），档案保留、管理员照读；不删卷。

## 附：已知取舍与未做

- 服务端事实只覆盖 `/api/command` 与 `/api/command-stream`；群聊、`/api/brief` 这类在浏览器侧按消息记录，不另记服务端原文。
- V1 不做页面内“重新开启记录”：采集被关或邀请作废后，打开着的页面停在“已关闭”，刷新才重新开始。
- 开发构建（StrictMode）每次载入会多出一个 0 秒的“重开了一局”空局；生产构建实测每次载入只一局。
- 记录条在很窄的窗口（地图区 < 330 px）里会盖住地图的一角；常见桌面宽度下贴在任务条正上方，不压任何游戏界面。
