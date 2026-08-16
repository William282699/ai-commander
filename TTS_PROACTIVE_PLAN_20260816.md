# 「请示要缠人」刀 · 工程 Plan v2（2026-08-16 审后定稿）

> 输入：勘察档 v3 `TTS_PROACTIVE_WIRING_RECON_20260816.md`＋内测账第 3 笔。
> **v2＝Opus 审核「有条件通过」后修订版：八条放行条件＋P1×13＋P2 精选全落文本，
> 审核明示不必再审**。病一句话：陈主动提问零声零提示零残留，静默过期最伤司令感。
> 用户两板已拍：①喇叭默认关＋持久化＋首局陈请开电台 ②降级 silent＋文字。

## 0. 现场

| 项 | 值 |
|---|---|
| 基线 | main＝origin＝`660aec9` 干净（Fable 核过）；勘察档＋本 plan 两份未跟踪档**首 commit 一并入库** |
| worktree | 复用 `AI Commander-voice-input`，从 main 切 `tts-proactive-v1`。★两笔注意：该 worktree 现挂 ui-anim-round2（内容同 660aec9，直接切新分支即可）；`.env` 读的是 `apps/server/.env`，起 server 前先确认（UI 简化刀吃过亏） |
| dev | `frame-web`(3025)/`frame-api`(3024)；名叫 `web` 的 3003＝主仓库勿用 |
| **工装（审核 P0-1 裁定）** | headless Chromium 下 stub mp3 的 currentTime **会走**（复核 8 组配置实测），无需 autoplay flag。判据落点＝playwright＋route stub `/api/tts`；**开工前先跑 smoke 门**（§4 canary）确认工装活着再动刀。主判据尽量下沉 node（见 §4 末），浏览器只留「确实进喇叭」2-3 格 |
| 台架 | `run-benches.sh` 25/25。★新增 `scripts/ab-*.ts` **必须同步加 CHECKS 行**（run-benches.sh 纪律③：LISTED≠ONDISK 直接 exit 1，报错文案与本刀无关，先知道）。既有 ab-voice-input 源码扫描锚（S11-13）**预期不红**——红了＝应答链出声守卫被动过，先停下报审（不发"改锚不改判"通行证） |

## 1. 范围（用户拍板＋审核问原因已答）

**做**：①参谋主动台词出声——标记点**四类**：升级请示（command_ack urgent）、
proactive、retrospect、**llm_advice**（★审核问原因的回答：当初排除是把「出声」和
「渲染迁移」捆在一起，utterance 独立字段设计已化解——**只出声、不迁渲染**，渲染
迁移仍缓办立账。内测账第 3 笔全销，不留马克斯那半）②复呼 ③过期甩脸 ④头像闪烁
⑤到达提示音（**用 roger.mp3**——磁盘已有 manifest 缺行，语义比 warning 贴且不撞
MessageLevel）⑥板 1 落地 ⑦真现存 bug 卫生。
**不做**：Emily 头像（用户自理）；Reed 截断；超时自动执行（授权雷区，**本刀执行
语义零字节**：过期只说不做，兵该不动还是不动）；llm_advice 渲染迁移（缓办账）；
死代码 thread 链；主窗刷新遗留僵尸弹窗（真 close 只治「收回」路，此格缓办立账）。

## 2. 铁律（审后修订）

1. 真状态驱动；出声判据一律真播放（取材口见 §4），观察者响≠出声。
2. 纯 web 层；执行/授权语义零变更（步 5 的过期处理**只读引擎 TTL，不自建计时、
   不提前清活单**——P0-2 三缺口的总纲）。
3. 对话是唯一界面：闪烁零交互放行（hud-status-dot 同族）；提示音放行（用户点名）；
   **喇叭键脉冲必须由陈那句台词驱动**（台词在→脉冲在，答/过期→停；不许成为独立
   常驻 affordance——审核决断点④的条件）。
4. 台词家法（审核决断点①裁定，原「电报机类比」已删——那俩不进 messageStore 故
   不受此法管，复呼/甩脸都上屏，得各自过堂）：**复呼＝固定小池放行**（按人 3-5 句，
   照 VOICE_CONFIRMS 先例：NEVER EXPAND 注释＋计数断言钉死）；**甩脸＝走 LLM**
   （复用 escalation 既有生成路，120s 空窗后延迟无所谓），固定句只作兜底降级。
5. 一步一测一 commit；绊索 FAIL-first 的起算点＝「功能开着，摘掉对应那道闸」
   （P0-5 裁定，不许拿"没做功能"的基线充红）。
6. 勘察档 17 条风险逐条落防（§7 映射）；订阅回调内**禁同步判闸**——addMessage 的
   listeners 早于 setActiveEscalation 同步 fire，同步判会让闸④恒 null＝本刀的病
   换个姿势复发；出声判定一律进 useEffect/微任务。

## 3. 步序（7 步，各一 commit；原步 2/3 按审核裁定重切）

| 步 | 主题 | 内容 |
|---|---|---|
| 1 | 卫生刀＋探针四件（合并，原步1+步2 探针半）| releaseAtRef 绑回合＋超时；speechDiagRef 上报后清空；**探针真出声判据**（Edge 路挪到首个 timeupdate；★native 分支那处也要改，P1-6，否则污染换处继续）＋origin(reply\|proactive) 透传；收回面板真 close（panelWin 存 ref）。★§8 记量纲分水岭：改后 firstSoundMs 含解码起播、native 臂无 timeupdate 样本归零——旧样本作废不混算 |
| 2 | 出声地基（3a：让它出一次声） | `utterance?: { persona, kind }` 字段（kind ∈ escalation\|proactive\|retrospect\|advice\|nag\|expire，P1-13——闸④要靠它认请示）；四个发射点标记；addMessage 第 8 参数**同步改跨窗口委托＋MessageStoreShape**（P1-3：漏改＝弹窗有字无声且 typecheck 全绿）；最小 hook（闸①②③＋id+epoch 去重）；speakUtterance＝speak+flush 封装＋VOICE_CONFIG 解引用设防；降级开关（板 2，tts 模块内按 job origin 判定，落 handleEdgeFailure——审核决断点⑤） |
| 3 | 闸口（3b：不抢话） | 闸④新鲜度/escalation 存活＋闸⑤收音窗（真名三段，§4）；频道作用域＝**全频道出声**（§4 裁定）＋打底按频道分桶 |
| 4 | 仲裁（3c：不打架） | tts 加只读 `isBusy()`（P0-4）；释放条件 `!loading && !isBusy()`；模块外暂存队列＋释放重过闸④⑤＋每段 cancel 协议 |
| **4b** | **修订（用户裁定 2026-08-16，实施窗提出）** | `isBusy()` **补第四项** `\|\| !!window.speechSynthesis?.speaking`。原三项只覆盖 Edge 路：Edge 挂掉、应答走 native 朗读时 isBusy 恒 false ⇒ 主动台词照常释放、`cancel()` 把 native 那段掐断，而它自己按板 2 又不落 native ⇒ **掐了长官的回复、自己一声没出**。修向 fail-safe（错也只错在多等一拍）。判据用 initScript 假 speechSynthesis（可控 speaking 旗；不依赖 headless 真合成器——无声环境不 fire 会 flaky）。★实测起算点：摘掉第四项 ⇒ `hit+=1` 且 `nativeCancel=1`，伤害组合复现 |
| 5 | 复呼＋甩脸＋提示音 | 触发合同见 §5（P0-2/P0-3 全落）；roger.mp3 进 manifest；★ChatPanel 侧自调 `soundManager.init()`（幂等，P1-4——否则弹窗态提示音静默返 -1） |
| 6 | 闪烁＋板 1 落地 | 频道键闪烁挂 escalation-pending **状态断言本身**（C3 先例，非 class 名）；ttsEnabled localStorage 持久化（`voice.` 前缀族＋读写 try/catch——隐私模式裸调会渲染期抛错白屏，P2）；首局陈请开电台台词＋喇叭键脉冲**绑台词生命周期**（断言：无该台词时 data 属性无脉冲态）；顺手账 P1-12：isBaselineArm 弹窗丢 query 的臂标签错位，此窗顺手治 |
| 7 | 手测＋收口 | §9 清单；§10 记账；tag `tts-proactive-v1-done` |

## 4. 判据总纲（审核 P0-1/P0-5 全落）

**取材口（写死，不许退化到 playbackObserver）**：`context.addInitScript`（必须
context 级——page 级测不到弹窗；必须 initScript——要早于被测模块加载）包一层
`window.Audio`，实例推进 `window.__AUDIO_TAP__`。**src 分流**：台词只数
`src.startsWith("blob:")`，提示音只数 `src.includes("/sfx/")`，分开计数分开断言
（防提示音顶绿）。

**canary 四绊索（跑在正题前，失败打 HARNESS BROKEN，退出码区别于 FAIL）**：
①正对照：页内直接 new Audio(stub blob) 播一遍断言 currentTime>0（补丁在/mp3 解/
钟走）②stub 命中计数：该出声格 hit≥1，hit=0 归工装故障 ③补丁自证：
window.Audio !== 原生 ④kill-switch：stub 全改 500 重跑，正向格必须整组变红。

**负对照的构造（headless 恒静音，"静音环境"够不着）**：造真失败——initScript 覆写
`HTMLMediaElement.prototype.play` 返 NotAllowedError reject，或 stub 返 500；断言
探针回调零次。本组证明「解码并按真实时间播过」，不证明「耳朵听见」——听见归 §9。

**「正」条 persona 三件套**：route handler 记账 `request.postDataJSON()` 的
{text, voice}——断言 text 对＋`voice === VOICE_CONFIG.chen.edge`＋currentTime>0，
三缺一不可（currentTime 证明不了是谁的嗓子）。

**九条「反」的起算点（P0-5 逐格改：功能开着＋摘对应闸→红成什么样）**：

| 反 | 摘什么 | 期望红 |
|---|---|---|
| ①全静音探针 | 改用「造真失败」构造 | 探针回调计数 >0 即红 |
| ②T2 同人连发 | **先下毒**：route 第 1 次 fulfill 503、第 2 次给 mp3 | 无 cancel 协议时第二段走 nativeSpeak 零 POST——断言第二段有第二次 POST 且 currentTime>0 |
| ③🎤 回填复读 | ~~删~~（fail-closed 白名单下结构性死格，风险已灭，§7 映射记一笔即可——审核 P2 裁定） |
| ④换频道回灌 | 摘 id/epoch 打底 | 打底缺席→旧消息被念，tap 台词计数 >0 |
| ⑤PTT 收音窗 | 摘闸⑤ | 注入假 SpeechRecognition 造按住态（R2 先例工装，P1-11——headless 无真麦，pttPressedRef 造不出来别硬造），按住注入→tap >0 即红 |
| ⑥system 白名单 | 摘闸②，**伪造不可能态**（手造 from:"system"＋utterance 消息，注明测纵深防御） | speakUtterance 抛 TypeError 或 tap >0 |
| ⑦过期请示 | 摘闸④ | 注入超窗请示→tap >0 |
| ⑧群聊 | 摘闸③ | 群聊回复→tap >0 |
| ⑨应答链复读 | 全部 command_ack 都标 utterance 跑一遍 | 回执被念两遍（tap 台词计数=2） |

**epoch 绊索起算点（P1-8）**：第一局注入 ≥3 条（或直接断言第二局注入消息的 id
在第一局出现过），否则 id 不重叠＝绊索恒绿。

**频道作用域（P0-6 裁定）**：**全频道出声**——声音管「听得见」、闪烁管「看得见是
哪个频道」（步 6 存在理由）。hook 改读全量消息流、打底**按频道分桶**（换频道只对
新频道 id 打底，不动其它桶）。判据：站 ops 给 combat 注入→出声＋combat 键闪＋
ops 键不闪。

**闸⑤真名（P1-1，不许复制 300 这个数）**：`pttPressedRef.current ||
voiceArmRef.current?.snapshot().collecting === true || pttRecRef.current !== null`
（collecting 在尾窗内仍 true＝天然超集；pttStatus 不能用——stopPTT 在 release()
前就置 idle）。

**epoch 真相源（P1-2）**：不新增 getResetCount（第二真相源且弹窗委托早退会静默
失效）——复用 ChatPanel 既有 `gameEpochRef`，已播键＝`${epoch}:${id}`；epoch 判据
弹窗态也跑一遍。

**判据下沉（审核建议，采纳）**：闸①-④判定、id+epoch 去重与分桶打底、暂存队列
次序、复呼/甩脸时值（喂假 state.time）抽成纯谓词模块（voiceSpeech.ts 先例），
新增 `scripts/ab-tts-proactive.ts` 进 run-benches（**同步加 CHECKS 行**）作主判据；
浏览器 playwright 只留「确实进喇叭」2-3 格＋canary。

## 5. 步 5 触发合同（P0-2 三缺口＋P0-3 全落）

- **过期判定唯一真相源＝引擎 TTL**：不自数 120 秒、不新增第四份硬编码。甩脸触发
  ＝「本频道曾发过未答请示」∧ `getActiveEscalation(ch, state.time) === null`；
  clearEscalation 退化为幂等清扫。**（读时判定＋纯时间流逝不发订阅回调——所以由
  ChatPanel 既有 200ms 轮询 effect 驱动检查，不新开计时器。）**
- **钟＝getState().time（游戏钟）**：复呼 30s 同源。禁 setTimeout/performance.now
  ——教程遮罩/后台标签下墙钟会在活单期开火，清掉活单＝ticketLine/escalateId/
  anyQuestionOccupied 三条执行链全被动（P0-2②，本刀硬边界）。
- **actionId 快照（P0-3③）**：请示登记时快照 {channel, actionId}；复呼/甩脸/清
  之前先比对 `getActiveEscalation(...)?.actionId`，不匹配整条放弃（不说话不清）
  ——照 ChatPanel「Guard by id」既有形状（grep 锚 `escalateId && getActiveEscalation`）。
- **★「活着」≠「没回话」（P0-3）**：代码注释在案——澄清/NOOP 分支**有意保活**
  escalation。复呼/甩脸再加一条必要条件：**自 esc.createdAt 后该频道无新的
  from==="player" 消息**（`getLastMessageTimeBySource` 已导出）。长官反问了一句
  ＝已回话，不复呼不甩脸（否则「你答了他还骂你」，比原病更伤）。
- 复呼只一次；30s/120s 首版值可调，**做成可 URL 覆写**（`?nag=2&expire=5`，台架
  不真等两分钟；**不许碰 ESCALATION_WINDOW_SEC/TICKET_TTL_SEC**——后者 6b 禁改区）。
- 甩脸台词＝LLM（escalation 既有路）＋固定句兜底；复呼＝按人小池（铁律 4）。
- **板 2 双向判据（P1-5，同时是决断点⑤的判据）**：stub 全 503→speechSynthesis
  计数 0＋文字照常；**紧接跑一个应答回合让 Edge 失败→计数 ≥1**（应答链 native
  兜底不许被主动降级开关连累；streamEngine 是模块级单变量，做成全局开关此格必红）。

## 6. （原 §6 决断点已全落定，见 §2 铁律与各步；不再单列）

## 7. 风险映射（勘察档 17 条→落点）

T1→步4仲裁；T2→步4 cancel 协议＋§4反②下毒；T3→步1；T4→speakUtterance；
U1→闸⑤真名；U2→hook 在 ChatPanel＋步6持久化；U3→utterance fail-closed；
U4→应答链不标＋§4反⑨；U5→分桶打底＋epoch；U6→id 去重＋白名单（反③结构性灭）；
U7→闸④+kind；U8→顺手修注释；新1→epoch(gameEpochRef)；新2→步1真close（刷新
僵尸窗缓办账）；新3→步1真出声判据（含 native 分支）；新4→板2＋canary④；
新5→闸②＋设防；台架成本→条件式（预期不红，红了停下报审）。

## 8. 收口记账（§10 并入）

LEDGER：①词义钉「发声＝文字落流／出声＝TTS 进喇叭」②销内测账第 3 笔（**全销**，
含马克斯 llm_advice 半）③新账三笔＝llm_advice 渲染迁移缓办／主窗刷新僵尸弹窗
缓办／探针量纲分水岭（改前 firstSoundMs 样本作废重采）④E2 那笔审核说已是空账
（串只在过期 dist）——**标待核勿直接划**⑤「同形」序号收口前重数（复核称第六已
被占、本轮应为第七——数得清正是这条家法的立法方式）。ROADMAP 收口段照例；
tag `tts-proactive-v1-done`；用户点头合 main。

## 9. 手测清单（真麦＋真喇叭，含弹窗态）

1. **先站在别的频道**（P0-6），TTS 开：陈提问→出声＋combat 键闪＋所在频道不闪＋
   提示音；30s 不理→复呼一次；120s 不理→甩脸（LLM 句）＋闪烁停＋**兵未动＝
   甩脸前后 getState() 快照逐字节比对**（orders/目标点/assignedUnitIds，家法：
   会动兵的验收不许肉眼）。
2. 回一句**能执行的话**→应答正常、闪烁停、无复呼。
3. **回一句反问**（「什么情况？」）→不复呼、不甩脸、闪烁停（P0-3 专格）。
4. 请示到达后**切后台/停教程遮罩挂 3 分钟墙钟**再回→未被甩脸、escalation 仍活
   （P0-2 钟源专格）。
5. 应答三句还在播时注入请示→**三句播完**才轮到主动台词（P0-4 专格）。
6. 按住 PTT 说话时到达→录音期不开口，松手（未过期）补播。
7. 弹出面板→声音唯一；收回→弹窗真关（**输入框半句/频道选择/滚动位置会丢，
   消息不丢**）。
8. 重开一局→第二局请示照样出声。
9. TTS 关：闪烁＋提示音照常；首局新档→陈请开电台台词＋喇叭键脉冲（仅台词存活期），
   点开后本局及下局记住。
10. 断网/503→主动台词静默、文字闪烁提示音照常、应答回合 native 兜底仍在。

—— plan v2 完。审核八条放行条件全落（审核明示不必再审）。开工令与三行概要另发。
