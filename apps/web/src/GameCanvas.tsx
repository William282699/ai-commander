import { useRef, useEffect } from "react";
import {
  renderTerrain,
  renderMinimap,
  renderFacilities,
  renderFrontLabels,
  renderUnits,
  renderFog,
  renderCombatEffects,
  type Camera,
} from "./rendererCanvas";
import {
  createInputState,
  setupInputListeners,
  processKeyboardCamera,
  centerCameraOn,
} from "./input";
import { FRONT_CAMERA_TARGETS } from "./mapData";
import { createInitialGameState } from "./initState";
import { tick, updateFog } from "@ai-commander/core";

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      renderUnits(
        ctx,
        unitArray,
        state.fog,
        camera,
        canvas.width,
        canvas.height,
        state.time,
      );

      // 5. Combat effects (attack lines + explosions) — drawn above units
      renderCombatEffects(ctx, state.combatEffects, camera, state.fog, state.time);

      // 6. Front labels (when zoomed out)
      renderFrontLabels(ctx, state.fronts, FRONT_CAMERA_TARGETS, camera);

      // 7. Minimap (bottom-right, with facility + unit dots)
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
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
