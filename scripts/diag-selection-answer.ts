/**
 * 诊断：「是哪一批」待答时，长官一句应答词怎么判（真模型）。
 * 运行：npx tsx scripts/diag-selection-answer.ts [--runs=10] [--out=dir]
 *
 *   A 只剩一批、问的是「是这一批吗？」→ 答「是的」：应当选定它（chose 那唯一的 key）
 *   B 两批里挑、问的是「哪一批？」    → 答「好的」：不许替长官选（unclear）
 * 信封用生产的 selectionEnvelope（与 ChatPanel 同一份实现），判定用生产的 validate + judge。
 * ★ 局面：真实初始局 + 夹具台账（南线派出一批 M1 到修理厂），不跑模型派兵。
 */
import { config as dotenv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import * as core from "@ai-commander/core";
import type { Intent, DispatchMeta } from "@ai-commander/shared";
import { judgeSelectionConsumption, validateSelectionDecision } from "@ai-commander/shared";
import { buildDigestForChannel } from "../apps/web/src/digestHelper";
import { selectionEnvelope } from "../apps/web/src/selectionOption";

dotenv({ path: "apps/server/.env" });
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const RUNS = Number(arg("runs", "10"));
const OUT = arg("out", "");

(async () => {
  const ai = await import("../apps/server/src/ai");
  core.resetEscalationTickets();
  const st = core.createInitialGameState("el_alamein");
  const r = core.resolveIntent({ type: "defend", fromFront: "front_south", quantity: 3, targetFacility: "ea_repair_station" } as Intent, st, st.style);
  const meta: DispatchMeta = { group: "i0", sourceKind: "front", sourceKey: "front_south", action: "defend", targetName: r.destinationName };
  core.applyOrders(st, r.orders.map((o) => ({ ...o, origin: "advisor" as const, dispatchMeta: meta })));
  for (const o of r.orders) for (const id of o.unitIds) st.units.get(id)!.position = { x: 400, y: 90 }; // 夹具：已到修理厂
  const cands = core.enumerateDispatchCandidates(st, { type: "retreat", fromFront: "front_south", quantity: "all" } as Intent);
  const mem = { playerIntent: "", openCommitments: [] };
  const style = "risk=0.50 focus=0.50 obj=0.50 cas=0.50";
  const results: Record<string, unknown[]> = { A_sole_yes: [], B_two_ok: [] };
  const cases = [
    { key: "A_sole_yes", cands: cands.filter((c) => c.kind === "dispatch"), answer: "是的" },
    { key: "B_two_ok", cands, answer: "好的" },
  ];
  for (const c of cases) {
    const q = c.cands.length === 1
      ? `现在只剩${c.cands[0].label}，是这一批吗？`
      : `您说的是哪一批？${c.cands.map((x) => x.label).join("，还是")}？`;
    const sel = { id: "sel-diag", candidates: c.cands.map(({ selectionKey, label }) => ({ selectionKey, label })) };
    for (let k = 0; k < RUNS; k++) {
      const digest = buildDigestForChannel(st, "combat", mem, [], undefined, undefined, true)
        + "\n---CONTEXT---\n[指挥官] 南部战线的部队全部撤退\n[参谋] " + q + selectionEnvelope(sel);
      let delivered: Record<string, unknown> | null = null;
      for await (const ev of ai.callAdvisorStream(digest, c.answer, style, "combat")) if (ev.type === "options") delivered = ev.content;
      const judged = judgeSelectionConsumption({
        requestTag: { selectionId: "sel-diag", channel: "combat", sessionId: "d" },
        current: { id: "sel-diag", channel: "combat", sessionId: "d", epoch: 0, expiresAt: st.time + 60, candidateKeys: sel.candidates.map((x) => x.selectionKey) },
        now: st.time, epoch: 0, decision: validateSelectionDecision(JSON.parse(JSON.stringify(delivered?.dispatchSelection ?? null))),
      });
      results[c.key].push({ verdict: judged.verdict, key: judged.candidateKey, raw: delivered?.dispatchSelection ?? null });
    }
    const tally: Record<string, number> = {};
    for (const x of results[c.key] as { verdict: string }[]) tally[x.verdict] = (tally[x.verdict] ?? 0) + 1;
    console.log(`${c.key}（问：${q.slice(0, 40)}… 答：${c.answer}）→ ${JSON.stringify(tally)}`);
  }
  if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/selection-answer.json`, JSON.stringify({ when: new Date().toISOString(), results }, null, 2)); }
})().catch((e) => { console.error(e); process.exit(1); });
