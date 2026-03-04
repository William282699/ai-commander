import { useRef, useEffect } from "react";
import {
  renderTerrain,
  renderMinimap,
  renderFacilities,
  renderFrontLabels,
  type Camera,
} from "./rendererCanvas";
import {
  createInputState,
  setupInputListeners,
  processKeyboardCamera,
  centerCameraOn,
} from "./input";
import { generateTerrain } from "./terrainGen";
import { FACILITIES, FRONTS, FRONT_CAMERA_TARGETS } from "./mapData";

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

    // Generate terrain
    const terrain = generateTerrain();

    // Camera: will be centered on player base after first frame
    const camera: Camera = { x: 0, y: 0, zoom: 1.0 };
    // Center on player HQ (tile 100, 7)
    centerCameraOn(camera, 100, 7, canvas.width, canvas.height);

    // Input
    const input = createInputState();
    const cleanup = setupInputListeners(canvas, camera, input);

    // Fronts array (ordered 1-5 for hotkey mapping)
    const frontIds = FRONTS.map((f) => f.id);

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
            centerCameraOn(camera, target.x, target.y, canvas.width, canvas.height);
          }
        }
        input.frontJumpRequest = null;
      }

      // Process keyboard + edge scrolling
      processKeyboardCamera(input, camera, dt, canvas.width, canvas.height);

      // Clear
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Render terrain
      renderTerrain(ctx, terrain, camera, canvas.width, canvas.height);

      // Render facilities on map
      renderFacilities(ctx, FACILITIES, camera);

      // Render front labels (when zoomed out)
      renderFrontLabels(ctx, FRONTS, FRONT_CAMERA_TARGETS, camera);

      // Render minimap (bottom-right)
      renderMinimap(ctx, terrain, camera, canvas.width, canvas.height, FACILITIES);

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
