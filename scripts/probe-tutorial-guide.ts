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
  currentHint, OUTRO_LINE, type GuideState } from "../apps/web/src/tutorialGuide";
import type { GameState, Unit } from "../packages/shared/src/types";

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
function ctxOf(s: GameState) {
  return { state: s, playerSpokeIn: (ch: string) => spoke.has(ch) };
}

function run(s: GameState, ticks: number, dt: number, onTick?: (i: number) => void,
             from?: GuideState) {
  let g = from ?? initialGuideState(s.time);
  const said: string[] = from ? [] : [openingLine()];
  for (let i = 0; i < ticks; i++) {
    onTick?.(i);
    s.time += dt;
    const r = advanceGuide(g, ctxOf(s) as never, s.time);
    g = r.next;
    if (r.say) said.push(r.say);
  }
  return { g, said };
}

console.log("\n── ① 台词本身 ──");
check("六步都有话、有催促", GUIDE_STEPS.length === 6 && GUIDE_STEPS.every(x => x.say && x.nudge),
  `${GUIDE_STEPS.length} 步`);
// ★「催」不许是复读——复读零信息，且撞过「逐字复读 4→8/131」那笔账
check("催促句与原句逐字不同", GUIDE_STEPS.every(x => x.say !== x.nudge), "两步都不同");
// 编队两步要点名「编队」；说话两步要点名那个参谋
check("每一步都点名了要点的东西",
  GUIDE_STEPS.slice(0,2).every(x => x.say.includes("编队"))
  && GUIDE_STEPS[2].say.includes("艾米莉") && GUIDE_STEPS[3].say.includes("马克斯")
  && GUIDE_STEPS[4].say.includes("烽火台") && GUIDE_STEPS[5].say.includes("敌军哨站"), "六步都点名了");
// ★ 用户 09-06 定的台词结构：示范 + 明说可以随便讲。两样缺一不可。
for (const i of [2, 3]) {
  const st = GUIDE_STEPS[i];
  check(`第${i+1}步给了示范台词`, /「[^」]+」/.test(st.say.replace(/「艾米莉中尉」|「马克斯上尉」/g, "")),
    st.say.slice(0, 30) + "…");
  check(`第${i+1}步明说了可以随便讲`, /怎么说|怎么问|随便/.test(st.say), "有解放句");
}

console.log("\n── ② 什么都不做：该催一次，且只催一次 ──");
{
  spoke.clear();
  const s = createInitialGameState("tutorial");
  // 60 拍 × 1 秒 ＝ 60 游戏秒，远超 NUDGE_AFTER_SEC
  const { g, said } = run(s, 60, 1);
  const nudges = said.filter(x => x === GUIDE_STEPS[0].nudge).length;
  check(`卡住 ${NUDGE_AFTER_SEC}s 后催了`, nudges >= 1, `催了 ${nudges} 次`);
  check("只催一次，不唠叨", nudges === 1, `${nudges} 次`);
  check("没做就不许推进", g.index === 0, `index=${g.index}`);
  check("总共只说了两句（开场＋催）", said.length === 2, `${said.length} 句：${said.length}`);
}

console.log("\n── ③ 真编一队：推进到第二步，并说出第二句 ──");
{
  spoke.clear();
  const s = createInitialGameState("tutorial");
  const { g, said } = run(s, 20, 1, (i) => { if (i === 5) makeSquad(s, "infantry"); });
  check("编队后引擎里真多了一支队", s.squads.length === 1, `${s.squads.length} 支`);
  check("引导推进到第二步", g.index === 1, `index=${g.index}`);
  check("第二步的话说出口了", said.includes(GUIDE_STEPS[1].say), `说了 ${said.length} 句`);
  // 第 5 拍就编队了（< 15s）⇒ 第一步的催促不该出现
  check("提前做完就不催第一步", !said.includes(GUIDE_STEPS[0].nudge), "没催");
}

console.log("\n── ④ 两队都编完：引导走完，从此闭嘴 ──");
{
  spoke.clear();
  const s = createInitialGameState("tutorial");
  const { g, said } = run(s, 40, 1, (i) => {
    if (i === 3) makeSquad(s, "infantry");
    if (i === 8) makeSquad(s, "light_tank");
    if (i === 13) talk("logistics");
    if (i === 18) talk("ops");
    if (i === 23) capture(s, "tut_beacon");
    if (i === 28) capture(s, "tut_enemy_post");
  });
  check("两支队都建起来了", s.squads.length === 2, `${s.squads.length} 支`);
  check("引导走完", g.index >= GUIDE_STEPS.length, `index=${g.index}/${GUIDE_STEPS.length}`);
  // 走完之后**接着这个状态**再跑很多拍，一句都不许再冒出来
  const before = said.length;
  const after = run(s, 30, 1, undefined, g);
  check("走完后不再说话", after.said.length === 0, `又说了 ${after.said.length} 句`);
  check("全程＝开场＋后五步＋结束语", before === 7, `${before} 句`);
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
  spoke.clear();
  const s = createInitialGameState("tutorial");
  const { g, said } = run(s, 40, 1, (i) => {
    if (i === 3) makeSquad(s, "light_tank");   // 反着来
    if (i === 8) makeSquad(s, "infantry");
    if (i === 13) talk("logistics");
    if (i === 18) talk("ops");
    if (i === 23) capture(s, "tut_beacon");
    if (i === 28) capture(s, "tut_enemy_post");
  });
  check("倒着做也能走完", g.index >= GUIDE_STEPS.length, `index=${g.index}`);
  check("第二句不点名兵种（顺序无关）",
    !/轻坦|坦克|步兵/.test(GUIDE_STEPS[1].say), GUIDE_STEPS[1].say.slice(0, 24) + "…");
  check("第二句照样说得出口", said.includes(GUIDE_STEPS[1].say), `${said.length} 句`);
}

console.log("\n── ⑤ 玩家抢跑：陈还没开口他就编好了 ──");
{
  // 真玩家完全可能没听指挥先自己编队。这时不该催他做已经做完的事。
  spoke.clear();
  const s = createInitialGameState("tutorial");
  makeSquad(s, "infantry");
  makeSquad(s, "light_tank");
  talk("logistics"); talk("ops");
  capture(s, "tut_beacon"); capture(s, "tut_enemy_post");
  const { g, said } = run(s, 60, 1);
  check("抢跑也能直接走完", g.index >= GUIDE_STEPS.length, `index=${g.index}`);
  check("一句催促都没有", !said.some(x => GUIDE_STEPS.some(st => st.nudge === x)), "无催促");
}

console.log("\n── ⑥ 该点哪个键的脉冲：跟着步骤生灭，不常驻 ──");
{
  // 铁律照喇叭键那条先例：**绑这一步的生死**。常驻的提示等于没有提示，还烦人。
  spoke.clear();
  const s = createInitialGameState("tutorial");
  let g: GuideState | null = initialGuideState(s.time);
  check("第一步：提示点「编队」", currentHint(g) === "squad", String(currentHint(g)));

  makeSquad(s, "infantry");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;
  check("第二步：还是「编队」", currentHint(g) === "squad", String(currentHint(g)));

  makeSquad(s, "light_tank");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;
  check("第三步：提示点艾米莉的频道键", currentHint(g) === "channel:logistics", String(currentHint(g)));

  talk("logistics");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;
  check("第四步：提示点马克斯的频道键", currentHint(g) === "channel:ops", String(currentHint(g)));

  talk("ops");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;
  // 第五步是地图上的动作（去占烽火台），没有键要点 ⇒ 不该乱亮
  check("第五步：没有键要点，不乱亮", currentHint(g) === null, String(currentHint(g)));

  capture(s, "tut_beacon");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;
  capture(s, "tut_enemy_post");
  s.time += 1; g = advanceGuide(g!, ctxOf(s) as never, s.time).next;
  // ★ 这条是承重的：引导走完脉冲必须灭，否则那个键会一直闪到关机
  check("引导走完：脉冲灭", currentHint(g) === null, String(currentHint(g)));
  check("引导没起来时也不亮（正式局不误伤）", currentHint(null) === null, String(currentHint(null)));
}

if (TRIPWIRE) {
  console.log("\n── ⑥ 绊索自证 ──");
  // 把完成判据改成恒假 ⇒ ③ 那格必须不再推进
  spoke.clear();
  const s = createInitialGameState("tutorial");
  const realDone = GUIDE_STEPS[0].done;
  (GUIDE_STEPS[0] as { done: (s: GameState) => boolean }).done = () => false;
  const { g } = run(s, 20, 1, (i) => { if (i === 5) makeSquad(s, "infantry"); });
  (GUIDE_STEPS[0] as { done: (s: GameState) => boolean }).done = realDone;
  console.log(`  ${g.index === 0 ? "✅" : "❌"} 摘掉完成判据后不再推进 — ${g.index === 0 ? "index 停在 0（判据会红）" : "★仍推进了，判据抓不住"}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
