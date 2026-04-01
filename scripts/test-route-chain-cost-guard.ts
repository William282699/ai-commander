#!/usr/bin/env npx tsx
/**
 * Regression guard for route chain cost model.
 * Invariant: totalCost must equal waypointPathCost(startPos, waypoints).
 * This catches any cost component being dropped during chain aggregation.
 *
 * Run: npx tsx scripts/test-route-chain-cost-guard.ts
 */

import { createInitialGameState, resolveRoute, resolveRouteChain } from "../packages/core/src/index";
import type { Position } from "../packages/shared/src/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

/** Ground-truth path cost: Manhattan from start to wp[0], then wp[i]→wp[i+1]. */
function waypointPathCost(start: Position, waypoints: Position[]): number {
  if (waypoints.length === 0) return 0;
  let cost = Math.abs(start.x - waypoints[0].x) + Math.abs(start.y - waypoints[0].y);
  for (let i = 1; i < waypoints.length; i++) {
    cost += Math.abs(waypoints[i].x - waypoints[i - 1].x) + Math.abs(waypoints[i].y - waypoints[i - 1].y);
  }
  return cost;
}

// Use El Alamein scenario — has 5 named routes
const state = createInitialGameState("el_alamein");
assert(state.namedRoutes.length > 0, `Scenario has ${state.namedRoutes.length} named routes`);

// ── Test 1: Single route — baseline ──
{
  const start = { x: 430, y: 88 };  // Player HQ area
  const target = { x: 280, y: 24 }; // Near Alamein Town (coastal)
  const resolved = resolveRoute(state, start, target, "via_balbia");
  assert(resolved !== null, "Single route (via_balbia) resolved");

  const actual = waypointPathCost(start, resolved!.waypoints);
  assert(
    actual === resolved!.totalCost,
    `Single route: waypointPathCost (${actual}) === totalCost (${resolved!.totalCost})`,
  );
  assert(
    resolved!.totalCost === resolved!.entryDist + resolved!.routeLen + resolved!.exitDist,
    `Single route: totalCost === entryDist + routeLen + exitDist`,
  );
}

// ── Test 2: Two-segment chain (with inter-segment gap) ──
{
  const start = { x: 430, y: 88 };  // Player HQ area
  const target = { x: 80, y: 24 };  // Far west coastal
  // Chain: desert_track (y=92) → via_balbia (y=24) — gap at the NS connecting road
  const resolved = resolveRouteChain(state, start, target, ["desert_track", "via_balbia"]);
  assert(resolved !== null, "Two-segment chain resolved");

  const actual = waypointPathCost(start, resolved!.waypoints);
  assert(
    actual === resolved!.totalCost,
    `Two-segment chain: waypointPathCost (${actual}) === totalCost (${resolved!.totalCost})`,
  );
  assert(
    resolved!.totalCost === resolved!.entryDist + resolved!.routeLen + resolved!.exitDist,
    `Two-segment chain: totalCost === entryDist + routeLen + exitDist`,
  );
}

// ── Test 3: Three-segment chain (two inter-segment gaps) ──
{
  const start = { x: 450, y: 195 }; // South-east
  const target = { x: 60, y: 24 };  // Far north-west
  // Chain: southern_pass (y=195) → axis_supply_road (x=150, N-S) → via_balbia (y=24)
  const resolved = resolveRouteChain(state, start, target, ["southern_pass", "axis_supply_road", "via_balbia"]);
  assert(resolved !== null, "Three-segment chain resolved");

  const actual = waypointPathCost(start, resolved!.waypoints);
  assert(
    actual === resolved!.totalCost,
    `Three-segment chain: waypointPathCost (${actual}) === totalCost (${resolved!.totalCost})`,
  );
  assert(
    resolved!.totalCost === resolved!.entryDist + resolved!.routeLen + resolved!.exitDist,
    `Three-segment chain: totalCost === entryDist + routeLen + exitDist`,
  );
}

console.log("\nAll route chain cost guard tests passed!");
