import { useRef, useEffect } from "react";
import {
  renderTerrain,
  renderMinimap,
  renderFacilities,
  renderFrontLabels,
  renderUnits,
  renderFog,
  renderCombatEffects,
  renderSelectionBox,
  renderInfoPanel,
  type Camera,
} from "./rendererCanvas";
import {
  createInputState,
  setupInputListeners,
  processKeyboardCamera,
  centerCameraOn,
  screenToTile,
  isBoxSelection,
} from "./input";
import { FRONT_CAMERA_TARGETS } from "./mapData";
import { createInitialGameState } from "./initState";
import {
  tick,
  updateFog,
  applyPlayerCommands,
  releaseManualOverride,
} from "@ai-commander/core";
import type { Unit, Order, GameState } from "@ai-commander/shared";
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from "@ai-commander/shared";
import { CommandPanel } from "./CommandPanel";
import { MessageFeed } from "./MessageFeed";

/** Distance threshold for single-click unit selection (in tiles) */
const CLICK_SELECT_RADIUS = 1.5;

/** Find all player units within a screen-space bounding box */
function findUnitsInBox(
  state: GameState,
  camera: Camera,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number[] {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);

  const ids: number[] = [];
  state.units.forEach((unit) => {
    if (unit.team !== "player" || unit.state === "dead") return;

    const screenX =
      (unit.position.x * TILE_SIZE - camera.x) * camera.zoom +
      (TILE_SIZE * camera.zoom) / 2;
    const screenY =
      (unit.position.y * TILE_SIZE - camera.y) * camera.zoom +
      (TILE_SIZE * camera.zoom) / 2;

    if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) {
      ids.push(unit.id);
    }
  });

  return ids;
}

/** Find the closest player unit to a screen position (for single click) */
function findUnitAtClick(
  state: GameState,
  camera: Camera,
  screenX: number,
  screenY: number,
): number | null {
  let closestId: number | null = null;
  let closestDist = Infinity;

  const clickTile = screenToTile(screenX, screenY, camera);

  state.units.forEach((unit) => {
    if (unit.team !== "player" || unit.state === "dead") return;

    const dx = unit.position.x - clickTile.tileX;
    const dy = unit.position.y - clickTile.tileY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < CLICK_SELECT_RADIUS && dist < closestDist) {
      closestDist = dist;
      closestId = unit.id;
    }
  });

  return closestId;
}

/** Find the closest visible enemy unit near a world position (for right-click attack) */
function findEnemyAtPosition(
  state: GameState,
  worldTileX: number,
  worldTileY: number,
): Unit | null {
  let closest: Unit | null = null;
  let closestDist = Infinity;
  const attackClickRadius = 1.5; // tiles

  state.units.forEach((unit) => {
    if (unit.team !== "enemy" || unit.state === "dead") return;

    // Must be visible
    const tx = Math.floor(unit.position.x);
    const ty = Math.floor(unit.position.y);
    if (tx < 0 || ty < 0 || tx >= MAP_WIDTH || ty >= MAP_HEIGHT) return;
    if (state.fog[ty]?.[tx] !== "visible") return;

    const dx = unit.position.x - worldTileX;
    const dy = unit.position.y - worldTileY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < attackClickRadius && dist < closestDist) {
      closestDist = dist;
      closest = unit;
    }
  });

  return closest;
}

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas to fill container
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    // Create game state (terrain + units + fog + facilities + ...)
    const state = createInitialGameState();
    stateRef.current = state;

    // Camera: center on player HQ (tile 100, 7)
    const camera: Camera = { x: 0, y: 0, zoom: 1.0 };
    centerCameraOn(camera, 100, 7, canvas.width, canvas.height);

    // Input
    const input = createInputState();
    const cleanup = setupInputListeners(canvas, camera, input);

    // Fronts array (ordered 1-5 for hotkey mapping)
    const frontIds = state.fronts.map((f) => f.id);

    // Compute initial fog so first frame shows visibility
    updateFog(state);

    // Track "Return to AI" button rect for click detection
    let returnToAIBtnRect: { x: number; y: number; w: number; h: number } | null = null;

    // Game loop
    let lastTime = performance.now();
    let animId = 0;

    const loop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05); // cap dt
      lastTime = now;

      // Process front jump hotkeys (1-5)
      if (input.frontJumpRequest !== null) {
        const idx = input.frontJumpRequest - 1;
        if (idx >= 0 && idx < frontIds.length) {
          const target = FRONT_CAMERA_TARGETS[frontIds[idx]];
          if (target) {
            centerCameraOn(
              camera,
              target.x,
              target.y,
              canvas.width,
              canvas.height,
            );
          }
        }
        input.frontJumpRequest = null;
      }

      // Process keyboard + edge scrolling
      processKeyboardCamera(input, camera, dt, canvas.width, canvas.height);

      // ── Day 5: Process selection complete ──
      if (input.selectionComplete) {
        input.selectionComplete = false;

        if (isBoxSelection(input)) {
          // Box selection: find all player units inside the box
          const ids = findUnitsInBox(
            state,
            camera,
            input.selectionStartScreenX,
            input.selectionStartScreenY,
            input.selectionEndScreenX,
            input.selectionEndScreenY,
          );
          input.selectedUnitIds = ids;
        } else {
          // Single click: check if clicked on "Return to AI" button first
          const clickX = input.selectionEndScreenX;
          const clickY = input.selectionEndScreenY;

          if (
            returnToAIBtnRect &&
            clickX >= returnToAIBtnRect.x &&
            clickX <= returnToAIBtnRect.x + returnToAIBtnRect.w &&
            clickY >= returnToAIBtnRect.y &&
            clickY <= returnToAIBtnRect.y + returnToAIBtnRect.h
          ) {
            // Clicked "Return to AI" button
            releaseManualOverride(state, input.selectedUnitIds);
            input.selectedUnitIds = [];
          } else {
            // Single click: select one unit
            const unitId = findUnitAtClick(state, camera, clickX, clickY);
            if (unitId !== null) {
              input.selectedUnitIds = [unitId];
            } else {
              // Clicked empty ground — deselect
              input.selectedUnitIds = [];
            }
          }
        }
      }

      // ── Day 5: ESC / Return to AI ──
      if (input.escPressed) {
        input.escPressed = false;
        if (input.selectedUnitIds.length > 0) {
          // Release manual override on all selected units
          releaseManualOverride(state, input.selectedUnitIds);
          input.selectedUnitIds = [];
        }
      }

      if (input.returnToAIPressed) {
        input.returnToAIPressed = false;
        releaseManualOverride(state, input.selectedUnitIds);
        input.selectedUnitIds = [];
      }

      // ── Day 5: Right-click command ──
      if (input.rightClickCommand) {
        const cmd = input.rightClickCommand;
        input.rightClickCommand = null;

        if (input.selectedUnitIds.length > 0) {
          // Check if clicking on an enemy unit
          const enemyTarget = findEnemyAtPosition(state, cmd.worldX, cmd.worldY);

          if (enemyTarget) {
            // Attack order
            const order: Order = {
              unitIds: [...input.selectedUnitIds],
              action: "attack_move",
              target: { x: enemyTarget.position.x, y: enemyTarget.position.y },
              targetUnitId: enemyTarget.id,
              priority: "high",
            };
            applyPlayerCommands(state, [order]);
          } else {
            // Move order
            const order: Order = {
              unitIds: [...input.selectedUnitIds],
              action: "attack_move",
              target: { x: cmd.worldX, y: cmd.worldY },
              priority: "medium",
            };
            applyPlayerCommands(state, [order]);
          }
        }
      }

      // --- Simulation ---
      tick(state, dt);
      updateFog(state);

      // --- Rendering ---
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 1. Terrain tiles
      renderTerrain(ctx, state.terrain, camera, canvas.width, canvas.height);

      // 2. Facilities on map
      const facArray = Array.from(state.facilities.values());
      renderFacilities(ctx, facArray, camera);

      // 3. Fog of war overlay (darkens unseen areas)
      renderFog(ctx, state.fog, camera, canvas.width, canvas.height);

      // 4. Units (enemy only visible in lit fog)
      const unitArray = Array.from(state.units.values());
      const selectedSet = new Set(input.selectedUnitIds);
      renderUnits(
        ctx,
        unitArray,
        state.fog,
        camera,
        canvas.width,
        canvas.height,
        state.time,
        selectedSet,
      );

      // 5. Combat effects (attack lines + explosions) — drawn above units
      renderCombatEffects(ctx, state.combatEffects, camera, state.fog, state.time);

      // 6. Selection box (while dragging)
      if (input.isSelecting) {
        renderSelectionBox(
          ctx,
          input.selectionStartScreenX,
          input.selectionStartScreenY,
          input.selectionEndScreenX,
          input.selectionEndScreenY,
        );
      }

      // 7. Front labels (when zoomed out)
      renderFrontLabels(ctx, state.fronts, FRONT_CAMERA_TARGETS, camera);

      // 8. Minimap (bottom-right, with facility + unit dots)
      renderMinimap(
        ctx,
        state.terrain,
        camera,
        canvas.width,
        canvas.height,
        facArray,
        unitArray,
        state.fog,
      );

      // 9. Info panel (bottom-left, when units selected)
      const selectedUnits = input.selectedUnitIds
        .map((id) => state.units.get(id))
        .filter((u): u is Unit => u !== undefined && u.state !== "dead");

      // Clean up dead units from selection
      if (selectedUnits.length !== input.selectedUnitIds.length) {
        input.selectedUnitIds = selectedUnits.map((u) => u.id);
      }

      const panelResult = renderInfoPanel(
        ctx,
        selectedUnits,
        canvas.width,
        canvas.height,
      );
      returnToAIBtnRect = panelResult.returnToAIBtnRect;

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
      cleanup();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      <CommandPanel getState={() => stateRef.current} />
      <MessageFeed />
    </div>
  );
}
