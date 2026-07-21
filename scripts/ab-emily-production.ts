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
import { createInitialGameState, buildDigest, enqueueProduction } from "@ai-commander/core";
import { generateDigestV1, UNIT_STATS } from "@ai-commander/shared";

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

  console.log(failCount === 0 ? "\nALL SYNTHETIC PASS" : `\n${failCount} FAILURES`);
  process.exit(failCount === 0 ? 0 : 1);
}

// ── Entry ──

const mode = process.argv[2];
if (mode === "--synthetic") runSynthetic();
else if (mode === "--ab") {
  console.log("--ab (real-model fixtures) lands in step 3");
  process.exit(2);
} else {
  console.log("usage: tsx scripts/ab-emily-production.ts --synthetic | --ab");
  process.exit(2);
}
