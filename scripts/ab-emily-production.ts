// ============================================================
// AI Commander — Emily production-contract bench (emily-production-v1)
//
// Modes:
//   --synthetic  deterministic assertions (no LLM, no server)
//   --ab         real-model fixtures (step 3)
//
// Everything asserts FINAL STATE (queue delta + money/fuel delta + actual
// receipts), never just resolver output — the v1 proposal was blocked
// precisely for resolver-preannounced counts (fake-execution risk).
//
// Run (from the worktree root):
//   ./node_modules/.bin/tsx scripts/ab-emily-production.ts --synthetic
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInitialGameState, buildDigest, enqueueProduction, resolveIntent, applyOrders, createDefaultStyle } from "@ai-commander/core";
import { generateDigestV1, UNIT_STATS, sanitizeIntent } from "@ai-commander/shared";
import type { GameState, Intent, Order } from "@ai-commander/shared";

// ── Harness ──

let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failCount++;
}

/** Lines of one ---SECTION--- (header prefix match, up to the next header). */
function sectionLines(digest: string, header: string): string[] {
  const lines = digest.split("\n");
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("---")) break;
    if (lines[i] !== "") out.push(lines[i]);
  }
  return out;
}

/** Extract now=N for a unit type token from the PRODUCTION body. */
function nowOf(body: string[], unitType: string): number | null {
  for (const line of body) {
    const m = line.match(new RegExp(`${unitType}\\[[^\\]]*now=(\\d+)\\]`));
    if (m) return Number(m[1]);
  }
  return null;
}

// ── --synthetic ──

function runSynthetic(): void {
  console.log("== emily-production synthetic assertions ==");

  // A) Producible set: declaration-order filter cost>0 && buildTime>0 must
  //    equal the ai.ts produceType schema contract (cross-check by parsing
  //    the server source TEXT — shared can never import apps/server).
  {
    const computed = Object.entries(UNIT_STATS)
      .filter(([, s]) => s.cost > 0 && s.buildTime > 0)
      .map(([t]) => t);
    const here = dirname(fileURLToPath(import.meta.url));
    const aiSrc = readFileSync(join(here, "../apps/server/src/ai.ts"), "utf8");
    const m = aiSrc.match(/"produceType": "([a-z_|]+) \(only for type=produce\)"/);
    check("facts set: ai.ts produceType contract parsed", m !== null);
    const contract = m ? m[1].split("|") : [];
    check("facts set: identical membership AND order vs ai.ts contract",
      JSON.stringify(computed) === JSON.stringify(contract),
      `computed=${computed.join(",")} contract=${contract.join(",")}`);
    check("facts set: 11 types, no commander/elite_guard",
      computed.length === 11 && !computed.includes("commander") && !computed.includes("elite_guard"));
  }

  // B) Money-bound math on the empirical fixture: $3,850 → main_tank now=9,
  //    light_tank now=19. No Infinity/NaN anywhere in the section.
  {
    const s = createInitialGameState("el_alamein");
    s.economy.player.resources.money = 3850;
    s.economy.player.resources.fuel = 300;
    const d = buildDigest(s, [], [], []);
    const body = sectionLines(d, "---PRODUCTION---");
    check("empirical: main_tank now=9 at $3,850", nowOf(body, "main_tank") === 9, body.join(" | "));
    check("empirical: light_tank now=19 at $3,850", nowOf(body, "light_tank") === 19);
    check("no Infinity/NaN in section", !body.join(" ").includes("Infinity") && !body.join(" ").includes("NaN"));
    check("body ≤4 lines", body.length <= 4, String(body.length));
    const header = d.split("\n").find((l) => l.startsWith("---PRODUCTION---")) ?? "";
    check("header carries NOT-additive + max/order semantics",
      header.includes("NOT additive") && header.includes("max 10/order"), header);
  }

  // C) Fuel becomes the binding constraint: fuel=15 → main_tank (10fu) now=1
  //    even though money affords 9.
  {
    const s = createInitialGameState("el_alamein");
    s.economy.player.resources.money = 3850;
    s.economy.player.resources.fuel = 15;
    const body = sectionLines(buildDigest(s, [], [], []), "---PRODUCTION---");
    check("fuel-bound: main_tank now=1 at fuel=15", nowOf(body, "main_tank") === 1, body.join(" | "));
    check("fuel-bound: infantry (0fu) unaffected", nowOf(body, "infantry") === Math.floor(3850 / 80));
  }

  // D) Facility gates mirror enqueueProduction: destroyed/enemy facilities
  //    don't count. el_alamein has no player shipyard at all → honest line.
  {
    const s = createInitialGameState("el_alamein");
    const body = sectionLines(buildDigest(s, [], [], []), "---PRODUCTION---");
    check("naval: no alive player shipyard (map truth)",
      body.some((l) => l === "naval: no alive player shipyard"), body.join(" | "));
    // kill the barracks → ground line flips to honest absence
    s.facilities.forEach((f) => {
      if (f.type === "barracks" && f.team === "player") f.hp = 0;
    });
    const body2 = sectionLines(buildDigest(s, [], [], []), "---PRODUCTION---");
    check("dead barracks → ground: no alive player barracks",
      body2.some((l) => l === "ground: no alive player barracks"), body2.join(" | "));
  }

  // E) Snapshot independence + queued aggregation: enqueue debits immediately,
  //    so `now` drops and the queued line carries exact multi-type counts;
  //    empty queue → line absent.
  {
    const s = createInitialGameState("el_alamein");
    s.economy.player.resources.money = 1000;
    s.economy.player.resources.fuel = 300;
    const before = sectionLines(buildDigest(s, [], [], []), "---PRODUCTION---");
    check("queue empty → queued line absent", !before.some((l) => l.startsWith("queued:")), before.join(" | "));
    const r1 = enqueueProduction(s, "player", "main_tank");
    const r2 = enqueueProduction(s, "player", "infantry");
    check("enqueue precondition ok", r1.ok && r2.ok, JSON.stringify([r1, r2]));
    const after = sectionLines(buildDigest(s, [], [], []), "---PRODUCTION---");
    // money 1000 - 400 - 80 = 520 → main_tank now = 1
    check("snapshot: now drops after enqueue debit", nowOf(after, "main_tank") === 1, after.join(" | "));
    check("queued: exact multi-type aggregation",
      after.some((l) => l === "queued: main_tank×1 infantry×1"), after.join(" | "));
  }

  // F) Both digest paths (board & no-board) render the SAME production section.
  {
    const s = createInitialGameState("el_alamein");
    const withBoard = buildDigest(s, [], [], []);
    const noBoard = generateDigestV1(s, [], [], []);
    const sect = (d: string) => {
      const i = d.indexOf("---PRODUCTION---");
      return i === -1 ? "" : d.slice(i).split("\n---")[0];
    };
    check("PRODUCTION identical on both paths", sect(withBoard) !== "" && sect(withBoard) === sect(noBoard));
  }

  // ── Step 2: produceBudget contract — every case asserts FINAL STATE ──

  /** Fresh el_alamein state with a fixed treasury. */
  function moneyState(money: number, fuel: number): GameState {
    const s = createInitialGameState("el_alamein");
    s.economy.player.resources.money = money;
    s.economy.player.resources.fuel = fuel;
    return s;
  }
  const style = createDefaultStyle();
  const lastDiag = (s: GameState) => s.diagnostics[s.diagnostics.length - 1];
  const budgetIntent = (produceType: string, fraction: number): Intent =>
    ({ type: "produce", produceType, produceBudget: { mode: "fraction_of_money", fraction } } as Intent);

  // G) fraction=1 on the empirical fixture: ONE order, no count claim in the
  //    resolver log; settlement enqueues 9 main tanks, debits money+fuel, and
  //    the receipt reports the actual count and remaining money.
  {
    const s = moneyState(3850, 300);
    const r = resolveIntent(budgetIntent("main_tank", 1), s, style);
    check("budget resolver: exactly one Order carrying budget",
      r.orders.length === 1 && r.orders[0].produceBudget?.mode === "fraction_of_money");
    check("budget resolver: log claims no count", !/×\d/.test(r.log), r.log);
    applyOrders(s, r.orders);
    check("fraction=1: queue +9", s.productionQueue.player.length === 9, String(s.productionQueue.player.length));
    check("fraction=1: money 3850→250", s.economy.player.resources.money === 250, String(s.economy.player.resources.money));
    check("fraction=1: fuel 300→210", s.economy.player.resources.fuel === 210, String(s.economy.player.resources.fuel));
    const d = lastDiag(s);
    check("fraction=1: receipt = actual ×9 + remaining", d.code === "PRODUCE_BUDGET" && d.message.includes("main_tank ×9") && d.message.includes("$250"), d.message);
  }

  // H) fraction=0.5: floor(1925/400)=4.
  {
    const s = moneyState(3850, 300);
    applyOrders(s, resolveIntent(budgetIntent("main_tank", 0.5), s, style).orders);
    check("fraction=0.5: queue +4, money -1600",
      s.productionQueue.player.length === 4 && s.economy.player.resources.money === 3850 - 1600,
      `q=${s.productionQueue.player.length} $=${s.economy.player.resources.money}`);
  }

  // I) Fuel-binding settlement (Codex seal #3): $3850 / fuel=15 / fraction=1
  //    → exactly 1 enqueued, money −400, fuel −10.
  {
    const s = moneyState(3850, 15);
    applyOrders(s, resolveIntent(budgetIntent("main_tank", 1), s, style).orders);
    check("fuel-bound settle: queue+1, money-400, fuel-10",
      s.productionQueue.player.length === 1 && s.economy.player.resources.money === 3450 && s.economy.player.resources.fuel === 5,
      `q=${s.productionQueue.player.length} $=${s.economy.player.resources.money} fu=${s.economy.player.resources.fuel}`);
  }

  // J) fraction clamp at the schema gate: >1→1, <0→0 (Codex seal #3).
  {
    const hi = sanitizeIntent({ type: "produce", produceType: "main_tank", produceBudget: { mode: "fraction_of_money", fraction: 1.5 } });
    const lo = sanitizeIntent({ type: "produce", produceType: "main_tank", produceBudget: { mode: "fraction_of_money", fraction: -0.2 } });
    check("clamp: fraction 1.5→1", hi?.produceBudget?.fraction === 1, JSON.stringify(hi?.produceBudget));
    check("clamp: fraction -0.2→0", lo?.produceBudget?.fraction === 0, JSON.stringify(lo?.produceBudget));
  }

  // K) fraction=0: zero enqueue, honest ZERO-BUDGET reason — must not read as
  //    "insufficient money".
  {
    const s = moneyState(3850, 300);
    applyOrders(s, resolveIntent(budgetIntent("main_tank", 0), s, style).orders);
    const d = lastDiag(s);
    check("fraction=0: zero queue + zero-budget reason",
      s.productionQueue.player.length === 0 && d.message.includes("预算为零") && !d.message.includes("钱不够"),
      d.message);
    check("fraction=0: money untouched", s.economy.player.resources.money === 3850);
  }

  // L) No alive facility: zero state change, single true failure, no success claim.
  {
    const s = moneyState(3850, 300);
    s.facilities.forEach((f) => { if (f.type === "barracks" && f.team === "player") f.hp = 0; });
    applyOrders(s, resolveIntent(budgetIntent("main_tank", 1), s, style).orders);
    const d = lastDiag(s);
    check("dead facility: zero queue/resource change + PRODUCE_FAIL only",
      s.productionQueue.player.length === 0 && s.economy.player.resources.money === 3850 &&
        d.code === "PRODUCE_FAIL" && !d.message.includes("×"),
      `${d.code}: ${d.message}`);
  }

  // M) Cap: $3850 light_tank → resource-affordable 19, enqueued 10, receipt
  //    carries BOTH truths.
  {
    const s = moneyState(3850, 300);
    applyOrders(s, resolveIntent(budgetIntent("light_tank", 1), s, style).orders);
    const d = lastDiag(s);
    check("cap: queue +10 of affordable 19",
      s.productionQueue.player.length === 10 && d.message.includes("×10") && d.message.includes("可产19") && d.message.includes("上限10"),
      d.message);
    check("cap: money -2000", s.economy.player.resources.money === 3850 - 2000, String(s.economy.player.resources.money));
  }

  // N) Numeric path regression: mode absent + quantity=3 → exactly 3, no budget receipt.
  {
    const s = moneyState(3850, 300);
    const r = resolveIntent({ type: "produce", produceType: "main_tank", quantity: 3 } as Intent, s, style);
    check("numeric: three orders, no budget carried", r.orders.length === 3 && r.orders.every((o) => o.produceBudget === undefined));
    applyOrders(s, r.orders);
    check("numeric: queue +3", s.productionQueue.player.length === 3, String(s.productionQueue.player.length));
  }

  // O) Malformed budget: schema drops it (old path); a hand-built bad Order
  //    falls to a SINGLE enqueue at settlement (defense in depth), never all-in.
  {
    const dropped = sanitizeIntent({ type: "produce", produceType: "main_tank", produceBudget: { mode: "fraction_of_money" } });
    check("malformed: schema drops budget (no fraction)", dropped !== null && dropped.produceBudget === undefined,
      JSON.stringify(dropped?.produceBudget));
    const s = moneyState(3850, 300);
    applyOrders(s, [{ unitIds: [], action: "produce", target: null, produceUnitType: "main_tank",
      produceBudget: { mode: "fraction_of_money", fraction: Number.NaN }, priority: "medium" } as Order]);
    check("malformed order: settles as single enqueue", s.productionQueue.player.length === 1 && s.economy.player.resources.money === 3450,
      `q=${s.productionQueue.player.length} $=${s.economy.player.resources.money}`);
  }

  // P) Trade control: tradeBudget behavior untouched (buy_fuel, fraction=0.5).
  {
    const s = moneyState(1000, 0);
    const r = resolveIntent({ type: "trade", tradeAction: "buy_fuel", tradeBudget: { mode: "fraction_of_money", fraction: 0.5 } } as Intent, s, style);
    applyOrders(s, r.orders);
    check("trade control: money decreased, fuel increased, no production queued",
      s.economy.player.resources.money < 1000 && s.economy.player.resources.fuel > 0 && s.productionQueue.player.length === 0,
      `$=${s.economy.player.resources.money} fu=${s.economy.player.resources.fuel}`);
  }

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── --ab (real model via /api/command; server must be running) ──

interface RespLite {
  brief?: string;
  responseType?: string;
  options?: { intents?: Record<string, unknown>[]; intent?: Record<string, unknown> }[];
}

function allIntents(resp: RespLite): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const o of resp.options ?? []) {
    if (Array.isArray(o.intents)) out.push(...o.intents);
    else if (o.intent) out.push(o.intent);
  }
  return out;
}

async function runAB(): Promise<void> {
  const cmdUrl = process.env.COMMAND_URL ?? "http://localhost:3001/api/command";

  // The empirical treasury: $3,850 / fuel 300 — main_tank 9, light_tank 19.
  const s = createInitialGameState("el_alamein");
  s.economy.player.resources.money = 3850;
  s.economy.player.resources.fuel = 300;
  const digest = buildDigest(s, [], [], []);

  const ask = async (message: string): Promise<RespLite> => {
    const res = await fetch(cmdUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        digest,
        message,
        styleNote: "risk=0.50 focus=0.50 obj=0.50 cas=0.50",
        channel: "logistics",
        sessionId: "ab-emily",
      }),
    });
    return (await res.json()) as RespLite;
  };

  type Fixture = { utterance: string; judge: (r: RespLite) => { ok: boolean; detail: string } };
  const fixtures: Fixture[] = [
    {
      // budget=1 AND quantity field precisely ABSENT (Codex acceptance)
      utterance: "剩下的钱都生产主战坦克",
      judge: (r) => {
        const prod = allIntents(r).filter((it) => it.type === "produce");
        const ok = prod.length > 0 && prod.every((it) => {
          const pb = it.produceBudget as { mode?: string; fraction?: number } | undefined;
          return it.produceType === "main_tank" && pb?.mode === "fraction_of_money" && pb.fraction === 1
            && !("quantity" in it);
        });
        return { ok, detail: JSON.stringify(prod) };
      },
    },
    {
      utterance: "用一半的钱生产轻型坦克",
      judge: (r) => {
        const prod = allIntents(r).filter((it) => it.type === "produce");
        const ok = prod.length > 0 && prod.every((it) => {
          const pb = it.produceBudget as { mode?: string; fraction?: number } | undefined;
          return it.produceType === "light_tank" && pb?.mode === "fraction_of_money" && pb.fraction === 0.5
            && !("quantity" in it);
        });
        return { ok, detail: JSON.stringify(prod) };
      },
    },
    {
      // numeric regression: quantity=3 AND produceBudget precisely ABSENT
      utterance: "生产3辆主战坦克",
      judge: (r) => {
        const prod = allIntents(r).filter((it) => it.type === "produce");
        const ok = prod.length > 0 && prod.every((it) =>
          it.produceType === "main_tank" && it.quantity === 3 && !("produceBudget" in it));
        return { ok, detail: JSON.stringify(prod) };
      },
    },
    {
      // consultation: NOOP + options=[] + zero intents; numbers human-judged
      // against the ledger (9 / 19 as INDEPENDENT caps, never summed).
      utterance: "Emily，我需要更多坦克，能生产多少坦克",
      judge: (r) => {
        const ok = allIntents(r).length === 0 && (r.options ?? []).length === 0 && r.responseType === "NOOP";
        return { ok, detail: `responseType=${r.responseType} options=${(r.options ?? []).length} brief=${r.brief}` };
      },
    },
  ];

  let misses = 0;
  for (const f of fixtures) {
    console.log(`\n== "${f.utterance}" ==`);
    for (let i = 0; i < 3; i++) {
      try {
        const r = await ask(f.utterance);
        const v = f.judge(r);
        if (!v.ok) misses++;
        console.log(`${v.ok ? "PASS" : "FAIL"} #${i + 1} — ${v.detail}`);
        if (f.utterance.includes("能生产多少")) console.log(`   [brief] ${r.brief}`);
      } catch (e) {
        console.log(`FAIL #${i + 1} — FETCH: ${(e as Error).message} — server running?`);
        process.exit(1);
      }
    }
  }

  console.log(misses === 0 ? "\nAB GATE PASS (12/12)" : `\nAB GATE FAIL (misses: ${misses})`);
  process.exit(misses === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--ab") void runAB();
else {
  console.log("usage: tsx scripts/ab-emily-production.ts --synthetic | --ab");
  process.exit(2);
}
