// ============================================================
// AI Commander — Marcus 换脑对照台架（DeepSeek ↔ Gemini）
//
// Modes:
//   --synthetic  判据自证（不调模型）。默认，进全家扫描。
//   --live [N]   真模型跑 Q1-Q4 各 N 轮，量三笔旧病 + 首字延迟。花配额，不进扫描。
//
// Run（worktree 根）：
//   npx tsx scripts/ab-marcus-brain.ts --synthetic
//   npx tsx scripts/ab-marcus-brain.ts --live 12
//
// ★次序铁律：**换脑之前必须先跑一遍存底**——换完就没有"改前"了。
//   `.env` 的 LLM_PROFILE_OPS 是唯一变量；台架不改它，只如实印出当前解析到的脑子。
//
// ★为什么有 --synthetic：B3 立的方法资产——**一条判据自己也得被证明会响**。
//   四条判据各喂一对"该红的/该绿的"手钉样本，判据失灵当场暴露；
//   否则换脑之后一片绿，分不清是"没病"还是"判据瞎了"。
//
// 家法：本刀的"效果"就是他嘴里说出来的东西，所以判据落在**可核对的事实**上
// （数字有没有出处、第一句有没有交付选择），不落在措辞好不好听。
// ============================================================

import { createInitialGameState } from "@ai-commander/core";
import type { GameState } from "@ai-commander/shared";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";

const MODE = process.argv[2] ?? "--synthetic";
const N = Number(process.argv[3] ?? 12);
const ONLY = process.argv[4] ?? "";  // 只跑某一题（如 "Q2"），改判据后补测用

/** 开局 11 秒——Q1「编造时长」那笔旧病的现场（实测他说过"开战九分钟"）。 */
function scene(): GameState {
  const s = createInitialGameState("el_alamein");
  s.time = 11;
  return s;
}

const CANON = scene();
const DIGEST = buildDigestForChannel(CANON, "ops", undefined, [], undefined, undefined, true);

const CN_NUM: Record<string, string> = {
  零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5",
  六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
};
function toDigits(s: string): string | null {
  if (/^\d+$/.test(s)) return s;
  if (s.length === 1 && CN_NUM[s]) return CN_NUM[s];
  if (s.length === 2 && s[0] === "十" && CN_NUM[s[1]]) return String(10 + Number(CN_NUM[s[1]]));
  if (s.length === 2 && CN_NUM[s[0]] && s[1] === "十") return String(Number(CN_NUM[s[0]]) * 10);
  return null;
}

/**
 * 「这个数在信封里有出处吗」——★**这条查法偏宽**，如实标注（沿用 J7 口径）。
 * 信封里到处是数字（战力值/坐标/资源），"数字出现过"不等于"这句话是真的"。
 * 方向是保守的：宽查法只会把编造误放进"有出处"，不会反过来冤枉模型。
 * ⇒ **报 1 例必是真编造；报 0 例不等于没编造。**
 */
function unsourced(prose: string, units: string, digest = DIGEST): string[] {
  const re = new RegExp(`([0-9]+|[零一二三四五六七八九十两]+)\\s*(${units})`, "g");
  const out: string[] = [];
  for (const m of prose.matchAll(re)) {
    const d = toDigits(m[1]);
    if (d === null) continue;
    if (!new RegExp(`\\b${d}\\b`).test(digest)) out.push(m[0]);
  }
  return out;
}

/** 这份 ops 信封里**真实存在**的兵力数：Reserves 总数 + 各群 units 数 + 折叠行的余量。
 *  Q3 的真值集合——报了不在这里面的数，就是编的。 */
const TROOP_COUNTS: Set<number> = (() => {
  const out = new Set<number>();
  for (const m of DIGEST.matchAll(/Reserves=(\d+)/g)) out.add(Number(m[1]));
  for (const m of DIGEST.matchAll(/(\d+)units/g)) out.add(Number(m[1]));
  for (const m of DIGEST.matchAll(/\((\d+) units\)/g)) out.add(Number(m[1]));
  return out;
})();

/** 回复里跟着兵力量词的数字，凡不在真值集合里的都列出来。
 *  量词不含「营」——信封里有"我军兵营"，会把地名吃成编制。 */
function notInTroopCounts(prose: string): string[] {
  const out: string[] = [];
  for (const m of prose.matchAll(/([0-9]+|[零一二三四五六七八九十两]+)\s*(个|辆|名|支|排|连|人)/g)) {
    const d = toDigits(m[1]);
    if (d === null) continue;
    if (!TROOP_COUNTS.has(Number(d))) out.push(m[0]);
  }
  return out;
}

const FRONT_NAMES = ["北部战线", "山脊战线", "中央战线", "南部战线", "敌军后方"];

interface Probe {
  id: string;
  q: string;
  /** Q2 专用：问句里摆出来的候选，判据只认这几个词（见 Q2 注释）。 */
  choices?: string[];
  /** null=过；字符串=红（内容是红的理由）。 */
  judge: (prose: string) => string | null;
  /** 判据自证：该红的样本 / 该绿的样本。 */
  selftest: { red: string; green: string };
}

const PROBES: Probe[] = [
  {
    id: "Q1 编造时长",
    q: "现在什么情况？",
    // ★判据第二版：首版用「数字在信封里出现过吗」，被 DeepSeek 基线的原话当场证伪
    //   ——他说「开局**11分钟**」，而 T=00:11 是 **11 秒**。数字 11 信封里当然有，
    //   于是判据放绿。**数字有出处、单位是编的**，正是 J7 那条宽查法的洞。
    //   改成绑单位：本现场信封里**一个"分钟"量级的数都没有**（已断言），
    //   所以任何分钟/小时口径的时间量都是编的。
    judge: (p) => {
      const bad = [...p.matchAll(/([0-9]+|[零一二三四五六七八九十两]+)\s*(分钟|小时)/g)].map((m) => m[0]);
      return bad.length ? `编造的时间量：${bad.join("/")}（真值 T=00:11 ＝ 11 秒，信封里无分钟量级数）` : null;
    },
    // 旧病两种形状：编个时长（九分钟），或把秒当成分钟（11秒→11分钟，实测抓到）
    selftest: { red: "长官，开局11分钟，敌我均未亮牌。", green: "长官，各线暂无接触。" },
  },
  {
    id: "Q2 征询句要表态",
    // ★问法第二版（2026-08-13）：首版「北线和中央，先救哪个？」有**混淆项**——
    //   开局态全线 QUIET，压根没有"要救"这回事，这时候回"为时尚早"说不定是对的，
    //   反倒硬选一个才可疑。那样测的是"有没有危机"不是"敢不敢背判断"。
    //   改成**由问句本身构造出选择**（只能选一个），两臂都用新问法重测。
    q: "我只能先增援一条线：北线还是中央？给我一个，别跟我说情况。",
    choices: ["北线", "中央"],
    // 判断执照：第一句必须交付一个选择。操作化＝**首句恰好命中问句摆出的一个候选**。
    //
    // ★首版用 FRONT_NAMES 全称判，deepseek 基线当场 12/12 假红——他答的是
    //   「长官，先救中央」，人话里没人说"中央战线"四个字。**判据比模型严，
    //   红的是判据不是模型。** 自证当时没抓到，因为我的绿样本用了全称。
    //   改成**拿问句自己的词当候选**（问「北线和中央」就认这两个），
    //   既不是同义词表、也不会再比说话人还端着。
    judge: (p) => {
      const first = p.split(/[。！？\n]/).filter((x) => x.trim())[0] ?? "";
      const cand = ["北线", "中央"];
      const hit = cand.filter((f) => first.includes(f));
      if (hit.length === 1) return null;
      return hit.length === 0
        ? `首句没交付选择：「${first.slice(0, 40)}」`
        : `首句同时点了 ${hit.join("+")}，不是选择：「${first.slice(0, 40)}」`;
    },
    selftest: {
      red: "长官，两线都吃紧，暂无需决断。",
      green: "长官，先救中央。北线还能撑，中央丢了防线断成两截。",
    },
  },
  {
    id: "Q3 残留编造",
    q: "我们还有多少预备队？",
    // ★首版判据是瞎的，自证当场抓出来（留痕）：原来用「数字在信封里出现过吗」，
    //   而"两个排"的 2 在 3KB 信封里当然找得到 ⇒ 编造被判成有出处。
    //   改成**真值集合**：ops 信封自己写着 `Reserves=74(STRONG)` 与各群 `Nunits`，
    //   合法兵力数就这么几个，报别的就是编的。窄且可核，不再吃宽查法的亏。
    //   （另：「营」不能当编制词判——信封里有"我军兵**营**"，会假阳性。）
    judge: (p) => {
      const bad = notInTroopCounts(p);
      return bad.length ? `信封里没有这个兵力数：${bad.join("/")}（合法值 ${[...TROOP_COUNTS].sort((a,b)=>a-b).join("/")}）` : null;
    },
    selftest: { red: "长官，后方还有两个排可用。", green: "长官，后方无成建制预备队。" },
  },
  {
    id: "Q4 寒暄不话痨",
    q: "在吗",
    // 对照组：防"换脑变话痨"。纯寒暄不该主动 sitrep。
    judge: (p) => {
      const fronts = FRONT_NAMES.filter((f) => p.includes(f));
      if (fronts.length) return `纯寒暄却主动报战线：${fronts.join("/")}`;
      return p.length > 40 ? `纯寒暄回了 ${p.length} 字` : null;
    },
    selftest: {
      red: "长官。当前北部战线我方七步兵三轻坦，中央战线四主坦，南部战线态势稳定，敌军动向不明。",
      green: "长官。",
    },
  },
];

// ── 判据自证 ──

function runSynthetic(): void {
  let bad = 0;
  const check = (label: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
    if (!ok) bad++;
  };

  console.log("\n── 判据自证：四条判据各喂一对手钉样本，证明它会响也会不响 ──");
  console.log("   （B3 方法资产：一条判据自己也得被证明会响，否则换脑后一片绿，");
  console.log("     分不清是没病还是判据瞎了）\n");
  for (const p of PROBES) {
    const red = p.judge(p.selftest.red);
    const green = p.judge(p.selftest.green);
    check(`${p.id} · 该红的样本判红`, red !== null, red ?? "★没响——判据是瞎的");
    check(`${p.id} · 该绿的样本判绿`, green === null, green ?? "");
  }

  console.log("\n── 现场自证：信封确实是 ops 频道的、T 确实是 11 秒 ──");
  check("现场 T=00:11（Q1 的前提）", /T=00:11/.test(DIGEST), DIGEST.slice(0, 24));
  // ★首版写的是 ">1KB"，而 ops 信封只有 629B——**Marcus 拿的本来就是战略摘要
  //   不是全board**（combat 才 3.4KB）。断言写错不是现场错，改成判形状不判大小。
  check("信封是 ops 的形状（战略摘要，非 combat 全板）",
    DIGEST.includes("---FRONT_BALANCE---") && DIGEST.includes("---FORCES---") &&
    !DIGEST.includes("---PRODUCTION---"), `${DIGEST.length}B`);
  check("Q1 判据的前提：本现场信封里没有任何「分钟」量级的数",
    !DIGEST.includes("分钟"), "有的话这条判据就不成立");
  check("Q3 的真值集合非空（Reserves 与各群 units 都读到了）",
    TROOP_COUNTS.size >= 3, `合法兵力数 ${[...TROOP_COUNTS].sort((a, b) => a - b).join("/")}`);

  console.log(bad === 0 ? "\nALL SYNTHETIC PASS" : `\n${bad} 条不过`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── 活体对照 ──

async function runLive(): Promise<void> {
  const { config } = await import("dotenv");
  config({ path: "apps/server/.env" });
  const { callAdvisorStream } = await import("../apps/server/src/ai");
  const { getProviderConfig } = await import("../apps/server/src/providers");

  const cfg = getProviderConfig("ops");
  console.log(`\n== Marcus 换脑对照 · ops 频道 ==`);
  console.log(`   ★当前脑子：LLM_PROFILE_OPS → provider=${cfg.provider} model=${cfg.model}`);
  console.log(`   现场：T=00:11 开局态，信封 ${DIGEST.length}B，每题 N=${N}\n`);

  const rows: { id: string; ok: boolean; ms: number; prose: string }[] = [];
  for (const p of PROBES.filter((x) => !ONLY || x.id.startsWith(ONLY))) {
    for (let i = 0; i < N; i++) {
      let prose = "";
      const t0 = Date.now();
      let firstMs = -1;
      try {
        for await (const ev of callAdvisorStream(DIGEST, p.q, "risk=0.50 focus=0.50 obj=0.50 cas=0.50", "ops")) {
          if (ev.type === "text") {
            if (firstMs < 0) firstMs = Date.now() - t0;
            prose += ev.content;
          }
        }
      } catch (e) {
        console.log(`  ${p.id} #${i} 调用失败 ${String(e).slice(0, 70)}`);
        continue;
      }
      const why = p.judge(prose);
      rows.push({ id: p.id, ok: why === null, ms: firstMs, prose });
      if (why) console.log(`  ★${p.id} #${i} 红：${why}`);
    }
    const mine = rows.filter((r) => r.id === p.id);
    const lat = mine.map((r) => r.ms).filter((m) => m > 0).sort((a, b) => a - b);
    console.log(`  ${p.id}: 红 ${mine.filter((r) => !r.ok).length}/${mine.length}   ` +
      `首字延迟中位 ${lat.length ? lat[Math.floor(lat.length / 2)] : "n/a"}ms`);
  }

  console.log(`\n── 汇总（${cfg.provider}/${cfg.model}）──`);
  for (const p of PROBES) {
    const mine = rows.filter((r) => r.id === p.id);
    console.log(`  ${p.id.padEnd(16)} 红 ${mine.filter((r) => !r.ok).length}/${mine.length}`);
  }
  const allLat = rows.map((r) => r.ms).filter((m) => m > 0).sort((a, b) => a - b);
  const med = allLat.length ? allLat[Math.floor(allLat.length / 2)] : -1;
  const p90 = allLat.length ? allLat[Math.floor(allLat.length * 0.9)] : -1;
  console.log(`  首字延迟：中位 ${med}ms ｜ p90 ${p90}ms ｜ n=${allLat.length}`);
  console.log(`\n★ 数量判据偏宽（沿用 J7）：报 1 例必是真编造，报 0 例不等于没编造。`);

  console.log(`\n── 各题一条原话（人眼复核用）──`);
  for (const p of PROBES) {
    const one = rows.find((r) => r.id === p.id);
    console.log(`  ${p.id}: ${(one?.prose ?? "").replace(/\n/g, " ").slice(0, 160)}`);
  }
  process.exit(0);
}

if (MODE === "--live") void runLive();
else runSynthetic();
