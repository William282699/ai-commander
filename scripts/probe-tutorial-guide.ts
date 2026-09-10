// ============================================================
// 教学关引导状态机 · 探针（probe- 前缀 ⇒ 不进 run-benches）
//
// 跑法：npx tsx scripts/probe-tutorial-guide.ts [--tripwire]
//
// 为什么值得有：引导是**台架的传统盲区**——它挂在 GameCanvas 的一个 interval 上，
// 而 `tick()` 不含那些接线（同 §R3/§S7 那族账）。所以把判定逻辑抽成纯函数
// `advanceGuide`，就是为了让它能在这里被**逐拍重放**。
//
// 判据一律测效果：
//  · 队伍数用**引擎的 `createSquad`** 真建出来，不是手写 `state.squads.push`
//  · 「催了没有」数的是真吐出来的句子，不是某个 flag
//  · 「不复读」逐字比对 say 与 nudge
// ============================================================

import { createInitialGameState } from "../packages/core/src/index";
import { createSquad } from "../packages/shared/src/squad";
import { advanceGuide, initialGuideState, openingLine, GUIDE_STEPS, NUDGE_AFTER_SEC,
  currentTargets, OUTRO_LINE, NUDGE_AFTER_SEC_SLOW, SETTLE_SEC_TALK, resolveSay,
  type GuideState, type GuideCtx } from "../apps/web/src/tutorialGuide";
import type { GameState, Unit } from "../packages/shared/src/types";

/** 台词可能是函数；断言一律先解开。ctx 给 null 时函数式台词取兜底写法。 */
/** ★按 id 找，不按下标。本轮插了「看军械」一步，所有按下标写的断言当场全错位——
 *  判据不该跟着数组顺序走。 */
const IDX = (id: string) => {
  const i = GUIDE_STEPS.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`步骤 id 不存在: ${id}`);
  return i;
};
const STEP = (id: string) => GUIDE_STEPS[IDX(id)];
/** 函数式台词要给个 ctx 才解得开——用一份干净的教学关状态当基准。 */
const SAY_OF = (id: string) => {
  // 造一份"玩家已经编过队"的状态：函数式台词要点名真队长，空状态只会给兜底句。
  const g = createInitialGameState("tutorial");
  makeSquad(g, "infantry");
  makeSquad(g, "light_tank");
  g.squads[1].parentSquadId = g.squads[0].id;      // 合并那句也需要它
  return resolveSay(STEP(id).say, ctxOf(g) as never);
};

const SAY = (i: number, c?: unknown) => resolveSay(GUIDE_STEPS[i].say, (c ?? null) as GuideCtx | null);

const TRIPWIRE = process.argv.includes("--tripwire");
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name} — ${detail}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

/** 照生产那条路真建一支队（GameCanvas 的 handleCreateSquad 最终也是调它）。 */
function talk(ch: string) { spoke.add(ch); }
/** 直接把设施翻成玩家的——判据读的就是引擎里这面旗子。 */
function capture(s: GameState, id: string) { s.facilities.get(id)!.team = "player"; }

/** 把两支队合并（拖编制树的引擎等价物）——判据读的就是 parentSquadId。 */
function placeTag(s: GameState) {
  s.tags.push({ id: `tag_${s.nextTagNum++}`, name: "战狼点", position: { x: 60, y: 40 } } as never);
}

function mergeSquads(s: GameState) {
  if (s.squads.length >= 2) s.squads[1].parentSquadId = s.squads[0].id;
}

function makeSquad(s: GameState, type: Unit["type"]) {
  const us = [...s.units.values()].filter(u => u.team === "player" && u.type === type);
  const sq = createSquad(us.map(u => u.id), us.map(u => u.type), s.nextSquadNum, "chen", "Aiden");
  s.squads.push(sq);
}

/** 跑 N 个引导拍，收集陈说出口的每一句。dt＝每拍推进的游戏秒。
 *  `from` 给了就**接着那个状态往下跑**（测"走完之后还说不说话"必须这样，
 *  重开一个新状态会让它把两步的话合法地重走一遍——第一版就栽在这）。 */
/** 玩家说过话的频道集合——由测试自己控制，模拟"他去点了艾米莉说了句话"。 */
const spoke = new Set<string>();
/** 玩家最后一次动手的游戏时间（测试自己控制）。-1 ＝ 从没动过。 */
let lastAction = -1;
let sawArsenal = false;
let busy = false;
/** 这一步跑了多久（测试自己控制）——时间步靠它走完。 */
let sinceStep = 0;
function act(s: GameState) { lastAction = s.time; }
function openArsenal() { sawArsenal = true; }
function ctxOf(s: GameState) {
  return {
    state: s,
    playerSpokeIn: (ch: string) => spoke.has(ch),
    playerActedSince: (t: number) => lastAction > t,
    playerSawArsenal: () => sawArsenal,
    advisorBusy: () => busy,
    sinceStepStart: sinceStep,
  };
}

function run(s: GameState, ticks: number, dt: number, onTick?: (i: number) => void,
             from?: GuideState) {
  let g = from ?? initialGuideState(s.time);
  const said: string[] = from ? [] : [openingLine()];
  for (let i = 0; i < ticks; i++) {
    onTick?.(i);
    s.time += dt;
    // 时间步靠这个走完；run() 里按真实的"这步开始到现在"算，别用固定值
    sinceStep = s.time - g.stepStartedAt;
    const r = advanceGuide(g, ctxOf(s) as never, s.time);
    g = r.next;
    if (r.say) said.push(r.say);
  }
  return { g, said };
}

console.log("\n── ① 台词本身 ──");
check("十一步都有话、有催促", GUIDE_STEPS.length === 11 && GUIDE_STEPS.every(x => x.say && x.nudge),
  `${GUIDE_STEPS.length} 步`);
// ★「催」不许是复读——复读零信息，且撞过「逐字复读 4→8/131」那笔账
check("催促句与原句逐字不同", GUIDE_STEPS.every((x, i) => SAY(i) !== x.nudge), "两步都不同");
// 编队两步要点名「编队」；说话两步要点名那个参谋
// ★ 用户 2026-09-08 立的规矩：**引导提到什么，什么就得自己亮**。机器版＝每一步
//   都必须至少声明一个目标，否则玩家又得满地图找。
check("每一步都有要点亮的目标（不许光说不指）",
  GUIDE_STEPS.every(x => (x.targets?.length ?? 0) > 0),
  GUIDE_STEPS.map(x => `${x.id}:${x.targets?.length ?? 0}`).join(" "));
check("台词点名了那个东西",
  SAY_OF("talk_emily").includes("艾米莉") && SAY_OF("talk_marcus").includes("马克斯")
  && SAY_OF("see_arsenal").includes("军械") && SAY_OF("merge_squads").includes("编制")
  && SAY_OF("place_tag").includes("T") && SAY_OF("take_beacon").includes("烽火台")
  && SAY_OF("take_post").includes("敌军哨站"), "都点名了");
// ★ 插旗那步必须提醒别重名——`nearestPlaceScan` 里标记绝对优先，重名会让
//   地图上出现两个同名地点，参谋说的和长官想的对不上。
// ★ 用户 09-09：上一步在看军械，点到马克斯会落在他的「计策」页 ⇒ 得指回「通讯」
check("马克斯那步指了「通讯」页签",
  STEP("talk_marcus").targets!.includes("btn:chattab") && /通讯/.test(SAY_OF("talk_marcus")),
  STEP("talk_marcus").targets!.join());
// ★ 用户 09-09：编队键只在陈的频道里有 ⇒ 第三队那步得先把玩家叫回陈那儿
check("第三队那步先叫玩家回陈的频道",
  STEP("squad_3").targets!.includes("chan:combat") && /陈军士/.test(SAY_OF("squad_3")),
  SAY_OF("squad_3").slice(0, 22) + "…");
// ★ 用户 09-09：示范台词里的将军必须是**玩家真有的**。写死 Farrell/Ellis 时
//   玩家那局的队长是 Aiden/Blake/Griffin/Carter，举的例子里一个他的人都没有，
//   照着念还会被引擎拒。名册是 namePool 按序发的，写死＝赌运气。
{
  const g2 = createInitialGameState("tutorial");
  makeSquad(g2, "infantry");            // 造一支队，队长名固定是 "Aiden"
  const ctx2 = ctxOf(g2) as never;
  const beacon = resolveSay(STEP("take_beacon").say, ctx2);
  const post = resolveSay(STEP("take_post").say, ctx2);
  const real = g2.squads[0].leaderName;
  check("烽火台示范用玩家真有的队长", beacon.includes(real), `点名了 ${real}`);
  check("打哨站示范用玩家真有的队长", post.includes(real), `点名了 ${real}`);
  check("台词里不再出现写死的 Farrell/Ellis",
    !/Farrell|Ellis/.test(beacon + post), "已清");
  // ★ 兜底：一支队都没有时不许吐出空名字或 undefined
  const g0 = createInitialGameState("tutorial");
  const b0 = resolveSay(STEP("take_beacon").say, ctxOf(g0) as never);
  const p0 = resolveSay(STEP("take_post").say, ctxOf(g0) as never);
  check("没队长时也说得出人话（不吐 undefined/空名）",
    !/undefined|「 |「」/.test(b0 + p0) && b0.length > 20 && p0.length > 20, "兜底正常");
}
// ★ 用户 09-09：顶栏与「弹出面板」一次都没介绍过。这一步**没有要做的动作**，
//   靠时间自己走完——要求玩家"点一下资源条"是硬造动作。
{
  const st = STEP("read_hud");
  check("读顶栏那步指了资源排和弹出面板",
    st.targets!.includes("hud:resources") && st.targets!.includes("btn:popout"),
    st.targets!.join());
  check("读顶栏那步讲了五个数各是什么",
    ["钱","油","弹","情报","战备"].every(k => SAY_OF("read_hud").includes(k)),
    SAY_OF("read_hud").slice(0, 26) + "…");
  const g3 = createInitialGameState("tutorial");
  const mk = (t: number) => ({ ...(ctxOf(g3) as never as object), sinceStepStart: t } as never);
  check("刚进这一步：不算完成", !st.done(mk(1)), "sinceStepStart=1");
  check("读够 12 秒：自动往下", st.done(mk(13)), "sinceStepStart=13");
  check("时间步不设催促（它自己会走完）", (st.nudgeAfterSec ?? 0) > 1000, `${st.nudgeAfterSec}s`);
}
check("插旗那步提醒了别跟已有地名重名", /重样|重名/.test(SAY_OF("place_tag")), "有提醒");
// ★ 用户 09-08：起名要给个例子，别让玩家对着空框想
check("插旗那步给了名字例子", /「[^」]+」/.test(SAY_OF("place_tag")), SAY_OF("place_tag").slice(0,28)+"…");
// ★ 文案红线：阵型词必须是引擎真认的（FormationStyle 的 wedge/column、
//   isAllFrontHint 的「全军」）。原稿写过查无出处的「全力进攻」。
const POST = SAY_OF("take_post");
check("阵型示范用的是真词", /楔形阵/.test(POST) && /长蛇阵/.test(POST)
  && /全军/.test(POST) && !/全力进攻/.test(POST), "楔形/长蛇/全军");
// ★ 台词里不许有 markdown（面板不渲染，星号会原样上屏）——本轮又犯过一次
check("八步台词零 markdown 星号", GUIDE_STEPS.every((x, i) => !/\*/.test(SAY(i) + x.nudge)), "零星号");
// ★ 死结防线：第三队必须靠生产，所以那一步的台词与催促都得把"先让艾米莉造兵"说出来
check("第三队那步说明了要先造兵（否则是死结）",
  /艾米莉/.test(SAY_OF("squad_3")) && /艾米莉/.test(STEP("squad_3").nudge),
  SAY_OF("squad_3").slice(0, 26) + "…");
// ★ 打哨站那步要讲清怎么算赢，并给"两个队长一起上"的示范
check("最后一步讲了胜负条件 + 给了双队长示范",
  /算赢|OBJECTIVES/.test(POST) && /和|一起/.test(POST), POST.slice(0, 30) + "…");
// ★ 合并那句必须点名上级是谁（用户 09-08：写「上级那个人」玩家会纳闷是谁）
check("合并那步的台词能把上级名字说出来", typeof STEP("merge_squads").say === "function",
  typeof STEP("merge_squads").say);
// ★ 用户 09-06 定的台词结构：示范 + 明说可以随便讲。两样缺一不可。
for (const id of ["talk_emily", "talk_marcus", "take_beacon", "take_post"]) {
  const line = SAY_OF(id);
  check(`${id} 给了示范台词`,
    /「[^」]+」/.test(line.replace(/「艾米莉中尉」|「马克斯上尉」|「通讯」|「军械」/g, "")),
    line.slice(0, 30) + "…");
  check(`${id} 明说了可以随便讲`, /怎么说|怎么问|随便|都行/.test(line), "有解放句");
}

console.log("\n── ② 什么都不做：该催一次，且只催一次 ──");
{
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  // 60 拍 × 1 秒 ＝ 60 游戏秒，远超 NUDGE_AFTER_SEC
  const { g, said } = run(s, 60, 1);
  const nudges = said.filter(x => x === GUIDE_STEPS[0].nudge).length;
  check(`卡住 ${NUDGE_AFTER_SEC}s 后催了（没动手）`, nudges >= 1, `催了 ${nudges} 次`);
  check("只催一次，不唠叨", nudges === 1, `${nudges} 次`);
  check("没做就不许推进", g.index === 0, `index=${g.index}`);
  check("总共只说了两句（开场＋催）", said.length === 2, `${said.length} 句：${said.length}`);
}

console.log("\n── ②b ★正在动手就不许催（用户 09-08 手测抓的噪音）──");
{
  // 病历：催促响的那一刻玩家其实正在做，五秒后就做完了 ⇒ 屏上"催一句＋紧接着
  // 下一句"两条挤一起。判据要测的是"他是不是卡住了"，不是"时间到了没有"。
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const { said } = run(s, 170, 1, (i) => { if (i % 5 === 0) act(s); });   // 一直在动手
  check("全程在动手 ⇒ 一句催促都没有",
    !said.some(x => GUIDE_STEPS.some(st => st.nudge === x)), `说了 ${said.length} 句`);
}
{
  // 反面：真的杵着不动，还是要催——不然这条闸等于把催促功能关掉了
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const { said } = run(s, 60, 1);
  check("完全不动 ⇒ 照样催一次", said.filter(x => x === GUIDE_STEPS[0].nudge).length === 1,
    `${said.filter(x => x === GUIDE_STEPS[0].nudge).length} 次`);
}
check("行军类步骤给了更长的等待",
  STEP("take_beacon").nudgeAfterSec === NUDGE_AFTER_SEC_SLOW
  && STEP("take_post").nudgeAfterSec === NUDGE_AFTER_SEC_SLOW,
  `烽火台 ${STEP("take_beacon").nudgeAfterSec}s / 哨站 ${STEP("take_post").nudgeAfterSec}s`);

console.log("\n── ②c ★做完一步先静一拍，别抢跑（用户 09-08 手测第二次抓的）──");
{
  // 病历：判松＝玩家一按发送这步就算完 ⇒ 艾米莉还在回话、兵还在造，
  // 陈已经把下一句推出来、马克斯的键已经在闪了。
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  let g: GuideState | null = initialGuideState(s.time);
  makeSquad(s, "infantry");
  s.time += 1; let r = advanceGuide(g!, ctxOf(s) as never, s.time); g = r.next;
  check("完成的那一拍不说话", r.say === null, String(r.say));
  check("静拍期间什么都不闪（不许抢跑）", currentTargets(g).length === 0,
    `[${currentTargets(g).join()}]`);
  // 静过之后才开口
  s.time += 5; r = advanceGuide(g!, ctxOf(s) as never, s.time); g = r.next;
  check("静完才说下一句", r.say === SAY(1), (r.say ?? "null").slice(0, 20));
  check("说了才开始闪", currentTargets(g).length > 0, currentTargets(g).join());
}
{
  // 跟参谋说话那两步要静更久（LLM 回话要几秒，玩家还要读）
  check("说话两步的静拍更长",
    STEP("talk_emily").settleSec === SETTLE_SEC_TALK
    && STEP("talk_marcus").settleSec === SETTLE_SEC_TALK,
    `艾米莉 ${STEP("talk_emily").settleSec}s / 马克斯 ${STEP("talk_marcus").settleSec}s`);
  // ★ 承重：静拍不许把催促计时也吃掉——催应当从**说出口**那刻起算
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const { said } = run(s, 120, 1, (i) => { if (i === 2) makeSquad(s, "infantry"); });
  check("静拍之后照样会催（计时从说出口起算）",
    said.includes(GUIDE_STEPS[1].nudge), `说了 ${said.length} 句`);
}

console.log("\n── ②d ★参谋还在回话就别推下一句（用户 09-09：马克斯话太长）──");
{
  // 与其猜一个秒数，不如等他真说完。静拍到点了但 advisorBusy 仍为真 ⇒ 继续等。
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  let g: GuideState | null = initialGuideState(s.time);
  makeSquad(s, "infantry");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;   // 完成 → 排期
  busy = true;                                                         // 参谋开始回话
  let said: string | null = null;
  for (let k = 0; k < 60; k++) { s.time += 1; const r = advanceGuide(g!, ctxOf(s) as never, s.time); g = r.next; if (r.say) said = r.say; }
  check("参谋一直在说 ⇒ 陈一直不插嘴", said === null, String(said));
  check("这期间也什么都不闪", currentTargets(g).length === 0, `[${currentTargets(g).join()}]`);
  busy = false;                                                        // 他说完了
  s.time += 1; const r2 = advanceGuide(g!, ctxOf(s) as never, s.time); g = r2.next;
  check("他一说完，陈立刻接上", r2.say === SAY(1), (r2.say ?? "null").slice(0, 18));
}

console.log("\n── ③ 真编一队：推进到第二步，并说出第二句 ──");
{
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const { g, said } = run(s, 20, 1, (i) => { if (i === 5) makeSquad(s, "infantry"); });
  check("编队后引擎里真多了一支队", s.squads.length === 1, `${s.squads.length} 支`);
  check("引导推进到第二步", g.index === 1, `index=${g.index}`);
  check("第二步的话说出口了", said.includes(SAY(1)), `说了 ${said.length} 句`);
  // 第 5 拍就编队了（< 15s）⇒ 第一步的催促不该出现
  check("提前做完就不催第一步", !said.includes(GUIDE_STEPS[0].nudge), "没催");
}

console.log("\n── ④ 两队都编完：引导走完，从此闭嘴 ──");
{
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const { g, said } = run(s, 170, 1, (i) => {
    if (i === 3) makeSquad(s, "infantry");
    if (i === 12) makeSquad(s, "light_tank");
    if (i === 24) talk("logistics");
    if (i === 40) openArsenal();
    if (i === 56) talk("ops");
    if (i === 76) makeSquad(s, "artillery");            // 第三队（模拟艾米莉造的兵）
    if (i === 92) mergeSquads(s);                       // 合并
    if (i === 106) placeTag(s);
    if (i === 120) capture(s, "tut_beacon");
    if (i === 38) capture(s, "tut_enemy_post");
  });
  check("三支队都建起来了（含艾米莉造兵那队）", s.squads.length === 3, `${s.squads.length} 支`);
  check("引导走完", g.index >= GUIDE_STEPS.length, `index=${g.index}/${GUIDE_STEPS.length}`);
  // 走完之后**接着这个状态**再跑很多拍，一句都不许再冒出来
  const before = said.length;
  const after = run(s, 30, 1, undefined, g);
  check("走完后不再说话", after.said.length === 0, `又说了 ${after.said.length} 句`);
  check("全程＝开场＋后十步＋结束语", before === 12, `${before} 句`);
  // ★ 结束语是承重的：手把手引导会把玩家训练成"等指令"，必须显式解除
  check("结束语说了", said.includes(OUTRO_LINE), OUTRO_LINE.slice(0, 20) + "…");
  check("结束语只说一次", said.filter(x => x === OUTRO_LINE).length === 1,
    `${said.filter(x => x === OUTRO_LINE).length} 次`);
  check("结束语里没有 markdown 星号（面板不渲染它）", !/\*/.test(OUTRO_LINE), "无星号");
  check("结束语明说了不用等指令", /不用等我|由您定/.test(OUTRO_LINE), "有解除语");
  check("结束语指向正式战役", /阿拉曼/.test(OUTRO_LINE), "有去处");
}

console.log("\n── ④b 倒着做：先编坦克再编步兵（实机抓出来的）──");
{
  // ★ 实机手测当场撞到：台词原本写死"南边还有三辆轻坦"，而玩家完全可以**先编坦克**
  //   ⇒ 第二句变成"叫他去做刚做完的事"。判据只能测效果：两种顺序都要能走完，
  //   且第二句里不许钉死某一坨的番号/兵种。
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const { g, said } = run(s, 170, 1, (i) => {
    if (i === 3) makeSquad(s, "light_tank");   // 反着来
    if (i === 8) makeSquad(s, "infantry");
    if (i === 24) talk("logistics");
    if (i === 40) openArsenal();
    if (i === 56) talk("ops");
    if (i === 76) makeSquad(s, "artillery");
    if (i === 92) mergeSquads(s);
    if (i === 106) placeTag(s);
    if (i === 120) capture(s, "tut_beacon");
    if (i === 136) capture(s, "tut_enemy_post");
  });
  check("倒着做也能走完", g.index >= GUIDE_STEPS.length, `index=${g.index}`);
  check("第二句不点名兵种（顺序无关）",
    !/轻坦|坦克|步兵/.test(SAY(1)), SAY(1).slice(0, 24) + "…");
  check("第二句照样说得出口", said.includes(SAY(1)), `${said.length} 句`);
}

console.log("\n── ⑤ 玩家抢跑：陈还没开口他就编好了 ──");
{
  // 真玩家完全可能没听指挥先自己编队。这时不该催他做已经做完的事。
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  makeSquad(s, "infantry");
  makeSquad(s, "light_tank");
  talk("logistics"); openArsenal(); talk("ops");
  makeSquad(s, "artillery"); mergeSquads(s); placeTag(s);
  capture(s, "tut_beacon"); capture(s, "tut_enemy_post");
  const { g, said } = run(s, 170, 1);
  check("抢跑也能直接走完", g.index >= GUIDE_STEPS.length, `index=${g.index}`);
  check("一句催促都没有", !said.some(x => GUIDE_STEPS.some(st => st.nudge === x)), "无催促");
}

console.log("\n── ⑥ 要点亮的目标：跟着步骤生灭，不常驻 ──");
{
  // 铁律照喇叭键那条先例：**绑这一步的生死**。常驻的提示等于没有提示，还烦人。
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  let g: GuideState | null = initialGuideState(s.time);
  const has = (t: string) => currentTargets(g).includes(t as never);
  // ★ 每步之间现在夹着一拍静默，所以推进要跨过它：一直跑到把话说出口为止
  const step = () => {
    for (let k = 0; k < 40; k++) {
      s.time += 1;
      sinceStep = s.time - g!.stepStartedAt;
      const r = advanceGuide(g!, ctxOf(s) as never, s.time);
      g = r.next;
      if (r.say) return;
    }
  };

  check("① 编队：兵在闪 + 编队键在闪", has("units:unsquadded") && has("btn:squad"),
    currentTargets(g).join());

  makeSquad(s, "infantry"); step();
  check("② 还是兵 + 编队键", has("units:unsquadded") && has("btn:squad"), currentTargets(g).join());

  makeSquad(s, "light_tank"); step();
  // 多了一个"读一眼顶栏"的时间步——它没有动作，靠时间走完
  check("②b 读顶栏：资源排 + 弹出面板在闪",
    has("hud:resources") && has("btn:popout"), currentTargets(g).join());

  sinceStep = 999; step();          // 读够了 ⇒ 自动往下
  // ★ 用户 09-08 要的：到艾米莉这步，打字框和麦克风都得闪，兵营也要闪
  check("③ 艾米莉：频道键 + 输入框 + 麦克风 + 兵营 四个都在",
    has("chan:logistics") && has("btn:input") && has("btn:mic") && has("fac:barracks"),
    currentTargets(g).join());

  talk("logistics"); step();
  check("③b 军械页签在闪", currentTargets(g).includes("btn:paneltab" as never), currentTargets(g).join());

  openArsenal(); step();
  check("④ 马克斯：频道键 + 输入框 + 麦克风", has("chan:ops") && has("btn:input") && has("btn:mic"),
    currentTargets(g).join());

  talk("ops"); step();
  check("⑤ 第三队：兵 + 编队键 + 兵营（新兵从那儿出来）",
    has("units:unsquadded") && has("btn:squad") && has("fac:barracks"), currentTargets(g).join());

  makeSquad(s, "artillery"); step();
  check("⑥ 合并：编制页签在闪", has("btn:paneltab"), currentTargets(g).join());

  mergeSquads(s); step();
  check("⑦ 插旗：输入框在闪", currentTargets(g).includes("btn:input" as never), currentTargets(g).join());

  placeTag(s); step();
  check("⑧ 烽火台：烽火台 + 输入框/麦克风", has("fac:beacon") && has("btn:input"),
    currentTargets(g).join());

  capture(s, "tut_beacon"); step();
  // ★ 打哨站这步要同时指着哨站和顶栏的 OBJECTIVES（胜负条件就在那儿讲）
  check("⑨ 哨站：哨站 + 顶栏 OBJECTIVES", has("fac:enemy_post") && has("hud:objectives"),
    currentTargets(g).join());

  capture(s, "tut_enemy_post"); step();
  // ★ 承重：引导走完必须全灭，否则那些东西会一直闪到关机
  check("走完：全灭", currentTargets(g).length === 0, `[${currentTargets(g).join()}]`);
  check("引导没起来时也不亮（正式局不误伤）", currentTargets(null).length === 0, "空");
}

if (TRIPWIRE) {
  console.log("\n── ⑥ 绊索自证 ──");
  // 把完成判据改成恒假 ⇒ ③ 那格必须不再推进
  spoke.clear(); lastAction = -1; sawArsenal = false; busy = false; sinceStep = 999;
  const s = createInitialGameState("tutorial");
  const realDone = GUIDE_STEPS[0].done;
  (GUIDE_STEPS[0] as { done: (s: GameState) => boolean }).done = () => false;
  const { g } = run(s, 20, 1, (i) => { if (i === 5) makeSquad(s, "infantry"); });
  (GUIDE_STEPS[0] as { done: (s: GameState) => boolean }).done = realDone;
  console.log(`  ${g.index === 0 ? "✅" : "❌"} 摘掉完成判据后不再推进 — ${g.index === 0 ? "index 停在 0（判据会红）" : "★仍推进了，判据抓不住"}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
