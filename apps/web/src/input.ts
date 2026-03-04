// ============================================================
// AI Commander — Input Handling (会丢的)
// WASD, scroll zoom, middle-click drag, minimap click,
// number keys 1-5 front jump, edge scrolling
// ============================================================

import type { Camera } from "./rendererCanvas";
import { getMinimapRect } from "./rendererCanvas";
import { TILE_SIZE, MAP_WIDTH, MAP_HEIGHT } from "@ai-commander/shared";

const SCROLL_SPEED = 400; // pixels per second
const ZOOM_SPEED = 0.1;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.0;
const EDGE_SCROLL_MARGIN = 20; // pixels from screen edge
const EDGE_SCROLL_SPEED = 300;

export interface InputState {
  keys: Set<string>;
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  cameraStartX: number;
  cameraStartY: number;
  mouseX: number; // current mouse position for edge scrolling
  mouseY: number;
  mouseInCanvas: boolean;
  frontJumpRequest: number | null; // 1-5, set on key press
}

export function createInputState(): InputState {
  return {
    keys: new Set(),
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    cameraStartX: 0,
    cameraStartY: 0,
    mouseX: -1,
    mouseY: -1,
    mouseInCanvas: false,
    frontJumpRequest: null,
  };
}

export function setupInputListeners(
  canvas: HTMLCanvasElement,
  camera: Camera,
  input: InputState,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    input.keys.add(key);

    // Number keys 1-5 for front jumping
    if (key >= "1" && key <= "5") {
      input.frontJumpRequest = parseInt(key);
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    input.keys.delete(e.key.toLowerCase());
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const oldZoom = camera.zoom;
    camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom + dir * ZOOM_SPEED));

    // Zoom toward mouse position
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    camera.x += mx / oldZoom - mx / camera.zoom;
    camera.y += my / oldZoom - my / camera.zoom;
    clampCamera(camera, canvas.width, canvas.height);
  };

  const onMouseDown = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Left click on minimap → jump
    if (e.button === 0) {
      const mm = getMinimapRect(canvas.width, canvas.height);
      if (mx >= mm.x && mx <= mm.x + mm.w && my >= mm.y && my <= mm.y + mm.h) {
        const tileX = ((mx - mm.x) / mm.w) * MAP_WIDTH;
        const tileY = ((my - mm.y) / mm.h) * MAP_HEIGHT;
        centerCameraOn(camera, tileX, tileY, canvas.width, canvas.height);
        e.preventDefault();
        return;
      }
    }

    // Middle or right click drag
    if (e.button === 1 || e.button === 2) {
      input.isDragging = true;
      input.dragStartX = e.clientX;
      input.dragStartY = e.clientY;
      input.cameraStartX = camera.x;
      input.cameraStartY = camera.y;
      e.preventDefault();
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = e.clientX - rect.left;
    input.mouseY = e.clientY - rect.top;

    if (input.isDragging) {
      const dx = (e.clientX - input.dragStartX) / camera.zoom;
      const dy = (e.clientY - input.dragStartY) / camera.zoom;
      camera.x = input.cameraStartX - dx;
      camera.y = input.cameraStartY - dy;
      clampCamera(camera, canvas.width, canvas.height);
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      input.isDragging = false;
    }
  };

  const onMouseEnter = () => { input.mouseInCanvas = true; };
  const onMouseLeave = () => { input.mouseInCanvas = false; };

  const onContextMenu = (e: Event) => e.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mouseenter", onMouseEnter);
  canvas.addEventListener("mouseleave", onMouseLeave);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    canvas.removeEventListener("mouseenter", onMouseEnter);
    canvas.removeEventListener("mouseleave", onMouseLeave);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}

/**
 * Process WASD + edge scrolling each frame.
 */
export function processKeyboardCamera(
  input: InputState,
  camera: Camera,
  dt: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const speed = SCROLL_SPEED / camera.zoom * dt;

  // WASD / Arrow keys
  if (input.keys.has("w") || input.keys.has("arrowup")) camera.y -= speed;
  if (input.keys.has("s") || input.keys.has("arrowdown")) camera.y += speed;
  if (input.keys.has("a") || input.keys.has("arrowleft")) camera.x -= speed;
  if (input.keys.has("d") || input.keys.has("arrowright")) camera.x += speed;

  // Edge scrolling (when mouse is near screen edge)
  if (input.mouseInCanvas && !input.isDragging) {
    const edgeSpeed = EDGE_SCROLL_SPEED / camera.zoom * dt;
    if (input.mouseX < EDGE_SCROLL_MARGIN) camera.x -= edgeSpeed;
    if (input.mouseX > canvasWidth - EDGE_SCROLL_MARGIN) camera.x += edgeSpeed;
    if (input.mouseY < EDGE_SCROLL_MARGIN) camera.y -= edgeSpeed;
    if (input.mouseY > canvasHeight - EDGE_SCROLL_MARGIN) camera.y += edgeSpeed;
  }

  clampCamera(camera, canvasWidth, canvasHeight);
}

/**
 * Center camera on a tile position.
 */
export function centerCameraOn(
  camera: Camera,
  tileX: number,
  tileY: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  camera.x = tileX * TILE_SIZE - canvasWidth / camera.zoom / 2;
  camera.y = tileY * TILE_SIZE - canvasHeight / camera.zoom / 2;
  clampCamera(camera, canvasWidth, canvasHeight);
}

function clampCamera(camera: Camera, canvasWidth: number, canvasHeight: number): void {
  const maxX = MAP_WIDTH * TILE_SIZE - canvasWidth / camera.zoom;
  const maxY = MAP_HEIGHT * TILE_SIZE - canvasHeight / camera.zoom;
  camera.x = Math.max(0, Math.min(maxX, camera.x));
  camera.y = Math.max(0, Math.min(maxY, camera.y));
}
