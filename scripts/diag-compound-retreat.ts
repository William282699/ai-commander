/**
 * 诊断：玩家实测「南部战线和北部战线的部队全部撤退」北线被改成「设防」
 * 运行：npx tsx scripts/diag-compound-retreat.ts [--runs=5] [--out=<dir>]
 *
 * ★ 真模型（读 apps/server/.env 的密钥，走生产 callAdvisorStream），会花 API 调用。
 * ★ 局面是**测试夹具**：真实初始局 + 真引擎模拟（含敌方 AI），但前两条派兵命令
 *   由脚本直接下（不经模型），以便把玩家那一局的台账状态稳定复现出来。
 *
 * 逐层记录：玩家原话 → 模型原始回包 → schema/normalize 后的 intents
 *   → 待决原 option（整组歧义要求）→ 答「派出去的那批」后送执行的 intents
 *   → 实际 orders / ApplyResult（逐单位 ID）。
 */
import { config as dotenv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import * as core from "@ai-commander/core";
import type { GameState, Intent, Order, DispatchMeta, CommanderMemory } from "@ai-commander/shared";
import { tick } from "../packages/core/src/sim";
import { processEnemyAI } from "../packages/core/src/enemyAI";
import { processDefensiveAI } from "../packages/core/src/scenario/elAlamein/defensiveAI";
import { processPressureDirector } from "../packages/core/src/scenario/elAlamein/pressureDirector";
import { _ticketsForTest } from "../packages/core/src/escalationTicket";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { judgeSelectionConsumption, validateSelectionDecision, selectionVerdictRoute } from "@ai-commander/shared";

dotenv({ path: "apps/server/.env" });

const RUNS = Number((process.argv.find((a) => a.startsWith("--runs=")) ?? "--runs=5").split("=")[1]);
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "").split("=")[1] ?? "";
const LABEL = (process.argv.find((a) => a.startsWith("--label=")) ?? "--label=baseline").split("=")[1];
/** 变体（仍是夹具）：派兵后再跑多少秒真模拟；--rich 在上下文里补上玩家那局「北线没有步兵」那一轮。 */
const PUMP_AFTER = Number((process.argv.find((a) => a.startsWith("--pump=")) ?? "--pump=45").split("=")[1]);
if (!Number.isFinite(PUMP_AFTER) || !Number.isFinite(RUNS)) throw new Error("bad --pump/--runs");
const RICH = process.argv.includes("--rich");
/** 变体（夹具）：北线前哨正挂着一条陈的请示（ACTIVE_ESCALATION，问句用生产里的中性兜底句）。 */
const ESC = process.argv.includes("--esc");
/** 复现刀寅之前的台账口径（G 票派出的那批记成 pool）。 */
const LEGACY_POOL = process.argv.includes("--legacy-pool");

function pump(s: GameState, sec: number, dt = 0.5) {
  let sinceFog = 1;
  for (let t = 0; t < sec; t += dt) {
    if (sinceFog >= 1) { core.updateFog(s); sinceFog = 0; }
    tick(s, dt); processEnemyAI(s, dt); processDefensiveAI(s, dt); processPressureDirector(s, dt);
    core.processAutoBehavior(s, dt);
    sinceFog += dt;
  }
}

/** 与 ChatPanel 同形：盖 origin/dispatchMeta 后 applyOrders（前两条派兵用它）。 */
function dispatch(s: GameState, intent: Intent, meta: Pick<DispatchMeta, "sourceKind" | "sourceKey">, roster?: number[]) {
  const r = core.resolveIntent(intent, s, s.style, undefined, roster);
  if (r.degraded) throw new Error(`fixture dispatch degraded: ${r.log}`);
  const full: DispatchMeta = { group: "i0", ...meta, action: intent.type, targetName: r.destinationName };
  const res = core.applyOrders(s, r.orders.map((o) => ({ ...o, origin: "advisor" as const, dispatchMeta: full })));
  return { r, res };
}

async function main() {
  // ── 抓模型原始回包：给 fetch 套一层 tee（只记响应体，不记请求头／密钥）──
  const realFetch = globalThis.fetch;
  const captured: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await realFetch(input, init);
    res.clone().text().then((t) => captured.push(t)).catch(() => {});
    return res;
  }) as typeof fetch;
  const ai = await import("../apps/server/src/ai");

  // ── 夹具：真实初始局 ──
  core.resetEscalationTickets();
  const st = core.createInitialGameState("el_alamein");
  pump(st, 4);
  const mem: CommanderMemory = { playerIntent: "", openCommitments: [] };

  // 第 1 条：从南部战线派3个步兵去野战修理厂（生产里模型写的就是 fromFront 那一种）
  const t1 = dispatch(st, {
    type: "defend", fromFront: "front_south", unitType: "infantry", quantity: 3, targetFacility: "ea_repair_station",
  } as Intent, { sourceKind: "front", sourceKey: "front_south" });

  // 第 2 条：从北线前哨2个坦克去野战修理厂——生产里模型走了 G 票（北线前哨附近未编组群）。
  // 先像生产那样建一次信封（铸号），再按 ChatPanel 的票据路径派兵。
  buildDigestForChannel(st, "combat", mem, [], undefined, undefined, true);
  const northTicket = _ticketsForTest().find((t) => !t.burned && core.spokenNameOf(t).includes("北线前哨"));
  if (!northTicket) {
    console.log("minted:", _ticketsForTest().map((t) => `${t.gNumber}=${core.spokenNameOf(t)}(${t.unitCount})`));
    throw new Error("no 北线前哨 ticket minted in this fixture");
  }
  const look = core.resolveTicketReference(st, northTicket.gNumber, st.time);
  if (look.kind !== "dispatch") throw new Error(`ticket not dispatchable: ${look.kind}`);
  const t2Intent = { type: "defend", fromSquad: northTicket.gNumber, unitType: "armor", quantity: 2,
    targetFacility: "ea_repair_station" } as Intent;
  t2Intent.fromSquad = undefined;
  Object.assign(t2Intent, core.retargetIntentForTicket(st, t2Intent, look.ticket));
  // 生产台账口径：刀寅之前＝票据改写后只剩 pool／空串（--legacy-pool 复现）；刀寅之后＝ticket:G#。
  const t2 = dispatch(st, t2Intent,
    LEGACY_POOL ? { sourceKind: "pool", sourceKey: "" } : { sourceKind: "ticket", sourceKey: northTicket.gNumber },
    look.unitIds);
  core.burnEscalationTicket(northTicket.gNumber);

  pump(st, PUMP_AFTER);

  const ledgerBefore = st.dispatches.map((d) => ({ id: d.id, src: `${d.sourceKind}:${d.sourceKey}`, to: d.targetName,
    act: d.action, members: [...d.memberIds], alive: core.liveDispatchMembers(st, d).map((u) => u.id) }));

  // ── 第 3 条：真模型 ──
  const PLAYER = "南部战线和北部战线的部队全部撤退";
  const ANSWER = "派出去的那批";
  const ctx = [
    "[指挥官] 从南部战线派3个步兵去野战修理厂",
    `[参谋] 已下令 ${t1.res.appliedUnitIds.length} 个单位前往野战修理厂设防。`,
    ...(RICH ? ["[指挥官] 从北部战线派3个步兵去野战修理厂", "[参谋] 北部战线眼下没有步兵，只有坦克。要不要改派北线前哨那边的坦克？"] : []),
    "[指挥官] 从北线前哨2个坦克去野战修理厂",
    `[参谋] 已下令 ${t2.res.appliedUnitIds.length} 个单位前往野战修理厂设防。`,
  ];
  const styleNote = `risk=${st.style.riskTolerance.toFixed(2)} focus=${st.style.focusFireBias.toFixed(2)} obj=${st.style.objectiveBias.toFixed(2)} cas=${st.style.casualtyAversion.toFixed(2)}`;

  const runs: unknown[] = [];
  let escalationContext = "";
  if (ESC) {
    const fac = [...st.facilities.values()].find((f) => f.name === "北线前哨");
    const wt = fac ? core.buildFacilityEscalationWithTickets(st, fac.id, "facility_contested", "北线前哨遭到攻击") : null;
    escalationContext = `\n---ACTIVE_ESCALATION---\n参谋刚问:「北线前哨 出状况了，您要怎么处理？」\n指挥官下面这句是对它的回应。`
      + (wt?.promptLine ? `\n${wt.promptLine}` : "");
    console.log("escalation block:", escalationContext);
  }
  for (let k = 0; k < RUNS; k++) {
    console.log(`\n── run ${k + 1} ──`);
    const digest = buildDigestForChannel(st, "combat", mem, [], undefined, undefined, true)
      + "\n---CONTEXT---\n" + ctx.join("\n") + escalationContext;
    captured.length = 0;
    let delivered: Record<string, unknown> | null = null;
    for await (const ev of ai.callAdvisorStream(digest, PLAYER, styleNote, "combat")) {
      if (ev.type === "options") delivered = JSON.parse(JSON.stringify(ev.content));
    }
    await new Promise((r) => setTimeout(r, 50));
    // 从 SSE 原文里拼出模型写的全文
    const rawModelText = captured.join("").split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } })
      .join("");
    const opt = (delivered?.options as { intents: Intent[] }[] | undefined)?.[0];
    const intents = opt?.intents ?? [];

    // 待决原 option：整组歧义要求（与生产 handleApprove 同一个函数）
    const plan0 = intents.length
      ? core.planDispatchSelectionBatch({ state: st, allIntents: intents, persona: "chen", personaLabel: "陈军士" })
      : null;
    const requirements = plan0 && plan0.kind !== "refuse" ? plan0.requirements : [];

    // ── 答复回合（真模型，逐问作答）：与 ChatPanel 同形的 DISPATCH_SELECTION 信封，
    //    玩家每一问都答「派出去的那批」；判官/路由/整组规划全用生产函数。
    //    判不出（protocol_failure/unclear/bad_key）⇒ 生产里是零执行＋再问一次，这里照做，最多再问 2 次。
    const answerTurns: unknown[] = [];
    const sim = structuredClone(st);
    let keys: { intentIndex: number; selectionKey: string }[] = [];
    let plan = plan0;
    const asked: string[] = [];
    const ctx2 = [...ctx, `[指挥官] ${PLAYER}`, `[参谋] ${String(delivered?.brief ?? "")}`];
    let retries = 0;
    while (plan && plan.kind === "ask" && answerTurns.length < 6) {
      const q = plan.soleCandidate
        ? `现在只剩${plan.candidates[0]?.label ?? "一批"}，是这一批吗？`
        : `您说的是哪一批？${plan.candidates.map((c) => c.label).join("，还是")}？`;
      asked.push(`intent#${plan.intentIndex}: ${plan.candidates.map((c) => c.selectionKey).join(" / ")}`);
      ctx2.push(`[参谋] ${q}`);
      const selBlock = `\n---DISPATCH_SELECTION---\n你上一句问了长官"是哪一批"(id=sel-diag)，候选如下（行首那个 key 逐字抄进 dispatchSelection.candidate）：\n`
        + plan.candidates.map((c) => `${c.selectionKey}  ${c.label}`).join("\n")
        + `\n指挥官下面这句话可能是对这一问的答复。`;
      const digest2 = buildDigestForChannel(sim, "combat", mem, [], undefined, undefined, true)
        + "\n---CONTEXT---\n" + ctx2.join("\n") + escalationContext + selBlock;
      captured.length = 0;
      let delivered2: Record<string, unknown> | null = null;
      for await (const ev of ai.callAdvisorStream(digest2, ANSWER, styleNote, "combat")) {
        if (ev.type === "options") delivered2 = JSON.parse(JSON.stringify(ev.content));
      }
      await new Promise((r) => setTimeout(r, 50));
      const raw2 = captured.join("").split("\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } })
        .join("");
      const prose = raw2.split("---JSON---")[0] ?? "";
      const judged = judgeSelectionConsumption({
        requestTag: { selectionId: "sel-diag", channel: "combat", sessionId: "diag" },
        current: { id: "sel-diag", channel: "combat", sessionId: "diag", epoch: 0, expiresAt: sim.time + 60,
          candidateKeys: plan.candidates.map((c) => c.selectionKey) },
        now: sim.time, epoch: 0, decision: validateSelectionDecision(delivered2?.dispatchSelection),
      });
      answerTurns.push({ intentIndex: plan.intentIndex, question: q, answer: ANSWER, rawModelText: raw2,
        dispatchSelection: delivered2?.dispatchSelection ?? null, verdict: judged.verdict,
        proseLeaksField: /dispatchSelection|candidate|dispatch:M|stay:front/.test(prose) });
      console.log(` 答复 intent#${plan.intentIndex}: verdict=${judged.verdict} 正文漏字段=${/dispatchSelection|candidate|dispatch:M|stay:front/.test(prose)}`);
      ctx2.push(`[指挥官] ${ANSWER}`);
      if (judged.verdict === "chose" && judged.candidateKey) {
        keys = [...keys, { intentIndex: plan.intentIndex, selectionKey: judged.candidateKey }];
        retries = 0;
      } else if (judged.verdict === "unrelated" || ++retries > 2) {
        break;
      }
      plan = core.planDispatchSelectionBatch({ state: sim, allIntents: intents, selectionKeys: keys,
        requirements: plan.requirements, persona: "chen", personaLabel: "陈军士" });
    }
    let executed: unknown = null;
    if (plan && plan.kind === "ready") {
      const rosters = new Map(plan.bindings.map((b) => [b.intentIndex, b.unitIds]));
      executed = plan.intents.map((it, i) => {
        const r = core.resolveIntent(it, sim, sim.style, undefined, rosters.get(i));
        const res = core.applyOrders(sim, r.orders as Order[]);
        return { intentIndex: i, sent: { type: it.type, fromFront: it.fromFront, fromDispatch: it.fromDispatch,
          toFront: it.toFront, targetFacility: it.targetFacility, targetRegion: it.targetRegion, quantity: it.quantity },
          orderActions: [...new Set(r.orders.map((o) => o.action))], dest: r.destinationName,
          applied: res.appliedUnitIds, degraded: r.degraded ? r.log : null };
      });
    }
    const summary = {
      run: k + 1, player: PLAYER,
      rawModelText,
      afterSchema: intents.map((i) => ({ type: i.type, fromFront: i.fromFront, fromDispatch: i.fromDispatch,
        fromSquad: i.fromSquad, toFront: i.toFront, targetFacility: i.targetFacility, targetRegion: i.targetRegion,
        quantity: i.quantity })),
      responseType: delivered?.responseType, brief: delivered?.brief,
      pendingRequirements: requirements, answerTurns, asked, finalPlan: plan?.kind ?? null, executed,
    };
    runs.push(summary);
    console.log(" 模型 intents:", JSON.stringify((summary.afterSchema as unknown[])));
    console.log(" 待决要求:", JSON.stringify(requirements));
    console.log(" 问了:", asked.length ? asked.join(" | ") : "（不问）");
    console.log(" 执行:", JSON.stringify(executed));
  }
  globalThis.fetch = realFetch;

  const report = {
    label: LABEL, pumpAfter: PUMP_AFTER, rich: RICH, esc: ESC, legacyPool: LEGACY_POOL, when: new Date().toISOString(), fixture: "真实初始局＋真引擎模拟；前两条派兵由脚本直接下（非模型）",
    t1Applied: t1.res.appliedUnitIds, t2Applied: t2.res.appliedUnitIds,
    t2Ticket: { g: northTicket.gNumber, name: core.spokenNameOf(northTicket), unitCount: northTicket.unitCount, roster: northTicket.unitIds },
    timeAtCommand: st.time, ledgerBefore, runs,
  };
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    const f = `${OUT}/compound-retreat-${LABEL}.json`;
    writeFileSync(f, JSON.stringify(report, null, 2));
    console.log(`\n证据已存：${f}`);
  }
  console.log("\n台账（第 3 条之前）:", JSON.stringify(ledgerBefore));
}

main().catch((e) => { console.error(e); process.exit(1); });
