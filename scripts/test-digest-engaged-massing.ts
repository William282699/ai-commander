// Self-test for EnemyEngaged / EnemyMassing split.
// Builds a fresh el_alamein state, disables fog, and runs two scenarios:
//   A) Default deployment — player + enemy units far apart → all enemies "massing"
//   B) Move one player squad next to a cluster of enemies → that cluster "engaged",
//      the rest of the bbox stays "massing".
// Logs the FRONTS section so we can eyeball the new fields.

import { createInitialGameState, buildDigest } from "@ai-commander/core";

function frontsSection(digest: string): string {
  const lines = digest.split("\n");
  const out: string[] = [];
  let inFronts = false;
  for (const line of lines) {
    if (line.startsWith("---FRONTS---")) { inFronts = true; out.push(line); continue; }
    if (inFronts && line.startsWith("---")) break;
    if (inFronts) out.push(line);
  }
  return out.join("\n");
}

function clearFog(state: ReturnType<typeof createInitialGameState>): void {
  for (let y = 0; y < state.fog.length; y++) {
    for (let x = 0; x < state.fog[y].length; x++) {
      state.fog[y][x] = "visible";
    }
  }
}

// ── Scenario A: default el_alamein deployment ──
{
  console.log("=== Scenario A: default deployment, all fog cleared ===");
  const state = createInitialGameState("el_alamein");
  clearFog(state);
  const digest = buildDigest(state, [], [], []);
  console.log(frontsSection(digest));
  console.log();
}

// ── Scenario B: move 1 player infantry next to an enemy cluster ──
{
  console.log("=== Scenario B: 1 player unit moved adjacent to nearest enemy ===");
  const state = createInitialGameState("el_alamein");
  clearFog(state);

  // Find first player infantry and first enemy
  let playerInfantry: ReturnType<typeof state.units.get> | undefined;
  let enemyAny: ReturnType<typeof state.units.get> | undefined;
  state.units.forEach((u) => {
    if (!playerInfantry && u.team === "player" && u.type === "infantry") playerInfantry = u;
    if (!enemyAny && u.team === "enemy") enemyAny = u;
  });

  if (playerInfantry && enemyAny) {
    // Park the player infantry 3 tiles from the enemy (well inside ENGAGED_RADIUS=10).
    playerInfantry.position = { x: enemyAny.position.x + 3, y: enemyAny.position.y };
    console.log(
      `Moved player infantry #${playerInfantry.id} to (${playerInfantry.position.x},${playerInfantry.position.y}); ` +
      `nearest enemy ${enemyAny.type}#${enemyAny.id} at (${enemyAny.position.x},${enemyAny.position.y}).`,
    );
  } else {
    console.log("(could not find both a player infantry and an enemy unit — skipping move)");
  }

  const digest = buildDigest(state, [], [], []);
  console.log(frontsSection(digest));
}
