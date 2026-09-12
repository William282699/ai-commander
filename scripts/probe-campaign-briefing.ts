// ============================================================
// 正式战役开场简报 · 探针（probe- 前缀 ⇒ 不进 run-benches）
//
// 跑法：npx tsx scripts/probe-campaign-briefing.ts [--tripwire]
//
// 判据的核心不是"这几句话写得对"，而是**它们是算出来的、不是抄下来的**：
// 把 `scenarioWinConfig` 的数字改掉，台词必须跟着变。写死的台词在这里会当场露馅——
// 而写死的代价是下一个调平衡的人不会记得回来改台词，屏上从此挂着一句假话。
// ============================================================

import { createInitialGameState } from "../packages/core/src/index";
import { campaignBriefing } from "../apps/web/src/campaignBriefing";
import type { GameState } from "../packages/shared/src/types";

const TRIPWIRE = process.argv.includes("--tripwire");
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name} — ${detail}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

const s = createInitialGameState("el_alamein");
const lines = campaignBriefing(s);
const all = lines.map(l => l.text).join("\n");
const cfg = s.scenarioWinConfig!;

console.log("\n── ① 说了该说的四件事 ──");
check("四句都在", lines.length === 4, `${lines.length} 句`);
check("① 让他看地图 + 说了颜色", /蓝的是咱们/.test(all) && /红的是敌人/.test(all),
  lines[0]?.text.slice(0, 26) + "…");
check("② 说了赢法", /就赢了/.test(all) && /OBJECTIVES/.test(all), "有赢法");
check("③ 说了输法 + 时限", /算输/.test(all) && /分钟/.test(all), "有输法");
check("④ 说了兵营在哪", /兵营/.test(all) && /艾米莉/.test(all), "有兵营");
// ★ 收口段 §4.3：正式局不许再手把手。这几句的最后一句必须把话语权交回去
check("最后一句把话语权交回玩家", /不用等我|您定|随时/.test(lines[lines.length - 1].text),
  lines[lines.length - 1].text.slice(-22));
check("排期是递增的（不会四句一起糊上来）",
  lines.every((l, i) => i === 0 || l.atSec > lines[i - 1].atSec),
  lines.map(l => l.atSec + "s").join(" → "));
check("没有 markdown 星号（面板不渲染它）", !/\*/.test(all), "无星号");

console.log("\n── ② ★数字与地名是算出来的，不是抄的 ──");
const objNames = (s.captureObjectives ?? []).map(id => s.facilities.get(id)!.name);
const keepNames = (cfg.friendlyKeypoints ?? []).map(id => s.facilities.get(id)!.name);
check("四个目标逐个点了名", objNames.every(n => all.includes(n)),
  objNames.join("、"));
check("三个前哨逐个点了名", keepNames.every(n => all.includes(n)),
  keepNames.join("、"));
check("要占几个＝配置里的那个数", all.includes(`占下其中${cfg.requiredCapturedObjectives}个`),
  `K=${cfg.requiredCapturedObjectives}`);
check("时限＝配置里的那个数", all.includes(`全场${Math.round(cfg.timeLimitSec / 60)}分钟`),
  `${cfg.timeLimitSec}s`);
// ★ 别把"丢满 N 个才输"说成"一个都不能丢"。说满了玩家会死守前哨放弃进攻，
//   而结算是 2×占领 − 丢失——进攻才是分的大头。
check("输法没说满（丢满才输，不是一个都不能丢）",
  cfg.maxFriendlyKeypointsLost >= keepNames.length
    ? all.includes("全丢光才算输") : all.includes(`丢满${cfg.maxFriendlyKeypointsLost}个`),
  `maxLost=${cfg.maxFriendlyKeypointsLost} / 前哨${keepNames.length}个`);
const barracks = [...s.facilities.values()].find(f => f.team === "player" && f.type === "barracks")!;
check("兵营名＝地图上真有的那个", all.includes(barracks.name), barracks.name);
// ★ 指路的原点得是玩家**认得**的那个地方。实测最近的设施是"野战修理厂"——
//   拿一个他同样没听说过的地方当原点等于没说（循环指路）。所以地标优先总部。
{
  const hq = [...s.facilities.values()].find(f => f.team === "player" && f.type === "headquarters")!;
  check("兵营指路的原点是我军总部（不是玩家没听过的那个）",
    all.includes(`挨着${hq.name}`), hq.name);
}

console.log("\n── ②b 说到哪几个点，那几个点就得闪（用户 09-12）──");
{
  const objIds = s.captureObjectives ?? [];
  const keepIds = cfg.friendlyKeypoints ?? [];
  const byText = (kw: string) => lines.find(l => l.text.includes(kw))!;
  const lObj = byText("插红旗"), lKeep = byText("蓝旗"), lBar = byText("艾米莉");

  check("讲敌军据点那句 ⇒ 四面红旗全在闪名单里",
    JSON.stringify(lObj.facilityIds) === JSON.stringify(objIds),
    (lObj.facilityIds ?? []).join());
  check("讲我方前哨那句 ⇒ 三面蓝旗全在闪名单里",
    JSON.stringify(lKeep.facilityIds) === JSON.stringify(keepIds),
    (lKeep.facilityIds ?? []).join());
  check("讲兵营那句 ⇒ 闪的正是那个兵营",
    JSON.stringify(lBar.facilityIds) === JSON.stringify([barracks.id]), barracks.id);
  check("开场那句不点亮任何东西（那句说的是整张图）",
    !(lines[0].facilityIds?.length), String(lines[0].facilityIds));
  // ★ 闪的必须是**地图上真有的**设施——名单写错了屏上什么都不会亮，且悄无声息
  check("要闪的 id 在设施表里都查得到",
    lines.every(l => (l.facilityIds ?? []).every(id => s.facilities.has(id))),
    "全部命中");
  // ★ 台词得说"旗"和"闪"——不然玩家不知道该看哪儿、看的是什么
  check("台词点出了红旗/蓝旗（旗是真画的，不是修辞）",
    lObj.text.includes("红旗") && lKeep.text.includes("蓝旗"), "都点了");
  check("台词点出了「闪」，玩家才知道去看地图",
    [lObj, lKeep, lBar].every(l => /闪/.test(l.text)), "三句都说了");
}

console.log("\n── ③ 换个配置，台词得跟着变（写死的在这儿露馅）──");
{
  const g = createInitialGameState("el_alamein");
  g.scenarioWinConfig!.requiredCapturedObjectives = 2;
  g.scenarioWinConfig!.timeLimitSec = 600;
  const t = campaignBriefing(g).map(l => l.text).join("\n");
  check("K 改成 2 ⇒ 台词说 2", t.includes("占下其中2个") && !t.includes("占下其中3个"), "跟着变了");
  check("时限改成 10 分钟 ⇒ 台词说 10", t.includes("全场10分钟"), "跟着变了");
}
{
  // 地名也一样：改掉设施名，台词必须用新名字
  const g = createInitialGameState("el_alamein");
  const first = g.facilities.get((g.captureObjectives ?? [])[0])!;
  first.name = "某某高地";
  const t = campaignBriefing(g).map(l => l.text).join("\n");
  check("改掉据点名 ⇒ 台词用新名字", t.includes("某某高地"), "跟着变了");
}
{
  // 前哨少一个（比如改平衡砍掉一个）⇒ 数量与列举都得跟着走
  const g = createInitialGameState("el_alamein");
  g.scenarioWinConfig!.friendlyKeypoints = g.scenarioWinConfig!.friendlyKeypoints.slice(0, 2);
  g.scenarioWinConfig!.maxFriendlyKeypointsLost = 2;
  const t = campaignBriefing(g).map(l => l.text).join("\n");
  check("前哨砍成 2 个 ⇒ 台词说 2 个", t.includes("这2个闪着的蓝旗"), "跟着变了");
}

console.log("\n── ④ 没有胜负配置的图：不许硬说 ──");
{
  // dual_island 没有 scenarioWinConfig——那张图根本没有"占几个算赢"这回事
  const g = createInitialGameState("dual_island");
  const l2 = campaignBriefing(g);
  check("dual_island 一句都不说", l2.length === 0,
    l2.length === 0 ? "空数组" : `★编了 ${l2.length} 句`);
}

console.log("\n── ⑤ 教学关不走这条路（两套开场不许打架）──");
{
  const g = createInitialGameState("tutorial");
  const l3 = campaignBriefing(g);
  // 教学关**有** winConfig（victoryLabel 就在里面），所以这里不是靠"没配置"挡住的，
  // 挡住它的是 GameCanvas 里 `scenarioFromUrl() === "tutorial"` 那道闸。
  check("教学关自己也有胜负配置（所以闸必须在调用处）", !!g.scenarioWinConfig,
    `K=${g.scenarioWinConfig?.requiredCapturedObjectives}`);
  check("真调了也生成得出话（说明闸不在这儿）", l3.length > 0, `${l3.length} 句`);
}

if (TRIPWIRE) {
  console.log("\n── ⑥ 绊索：台词要是写死的，这条当场红 ──");
  const g = createInitialGameState("el_alamein");
  const real = campaignBriefing(g).map(l => l.text).join("\n");
  g.scenarioWinConfig!.requiredCapturedObjectives = 2;
  const changed = campaignBriefing(g).map(l => l.text).join("\n");
  check("同一份状态、只改 K ⇒ 两份台词必须不同", real !== changed,
    real === changed ? "★一模一样——台词是写死的" : "变了");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
