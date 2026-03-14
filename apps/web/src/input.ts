// ============================================================
// AI Commander — Input Handling (会丢的)
// WASD, scroll zoom, middle-click drag, minimap click,
// number keys 1-5 front jump, edge scrolling,
// Day5: left-click selection, right-click commands, ESC
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

/** Minimum drag distance (screen px) to count as a box selection vs click */
const SELECTION_DRAG_THRESHOLD = 5;

function isTextEditingElement(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

function blurActiveTextEditor(): void {
  const active = document.activeElement;
  if (isTextEditingElement(active)) {
    active.blur();
  }
}

/** Right-click command (consumed by game loop each frame) */
export interface RightClickCommand {
  worldX: number;
  worldY: number;
}

export interface InputState {
  keys: Set<string>;
  // --- Camera drag (middle-click) ---
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  cameraStartX: number;
  cameraStartY: number;
  mouseX: number; // current mouse position for edge scrolling
  mouseY: number;
  mouseInCanvas: boolean;
  frontJumpRequest: number | null; // 1-5, set on key press

  // --- Day 5: Selection ---
  isSelecting: boolean; // left-click drag in progress
  selectionStartScreenX: number;
  selectionStartScreenY: number;
  selectionEndScreenX: number;
  selectionEndScreenY: number;
  selectedUnitIds: number[];
  selectionComplete: boolean; // true on mouseup → consumed by game loop

  // --- Day 5: Right-click command ---
  rightClickCommand: RightClickCommand | null;

  // --- Day 5: ESC & Return to AI ---
  escPressed: boolean;
  returnToAIPressed: boolean;

  // --- Day 15: Tag mode ---
  tagMode: boolean;
  pendingTag: { worldX: number; worldY: number } | null;
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

    isSelecting: false,
    selectionStartScreenX: 0,
    selectionStartScreenY: 0,
    selectionEndScreenX: 0,
    selectionEndScreenY: 0,
    selectedUnitIds: [],
    selectionComplete: false,

    rightClickCommand: null,
    escPressed: false,
    returnToAIPressed: false,

    tagMode: false,
    pendingTag: null,
  };
}

export function setupInputListeners(
  canvas: HTMLCanvasElement,
  camera: Camera,
  input: InputState,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Don't intercept keys when typing in input/textarea fields
    if (isTextEditingElement(e.target)) return;

    const key = e.key.toLowerCase();
    input.keys.add(key);

    // Number keys 1-5 for front jumping
    if (key >= "1" && key <= "5") {
      input.frontJumpRequest = parseInt(key);
    }

    // T: toggle tag mode
    if (key === "t") {
      input.tagMode = !input.tagMode;
    }

    // ESC: release selection / return to AI / exit tag mode
    if (e.key === "Escape") {
      if (input.tagMode) {
        input.tagMode = false;
        input.pendingTag = null;
      } else {
        input.escPressed = true;
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    input.keys.delete(e.key.toLowerCase());
  };

  const onWindowBlur = () => {
    // Prevent sticky movement keys when app loses focus.
    input.keys.clear();
  };

  const onFocusIn = (e: FocusEvent) => {
    // Entering a text field should always stop camera movement keys.
    if (isTextEditingElement(e.target)) {
      input.keys.clear();
    }
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

  // Track right-click drag distance for command vs pan detection
  let rightClickStartX = 0;
  let rightClickStartY = 0;
  let isRightDragging = false;

  const onMouseDown = (e: MouseEvent) => {
    // Clicking the canvas should return keyboard control to the map.
    if (isTextEditingElement(document.activeElement)) {
      blurActiveTextEditor();
      input.keys.clear();
    }

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Day 13 P2-5: Refresh mouse coords on click to prevent stale edge-scroll drift
    input.mouseX = mx;
    input.mouseY = my;

    // --- Left click ---
    if (e.button === 0) {
      // Check minimap click first
      const mm = getMinimapRect(canvas.width, canvas.height);
      if (mx >= mm.x && mx <= mm.x + mm.w && my >= mm.y && my <= mm.y + mm.h) {
        const tileX = ((mx - mm.x) / mm.w) * MAP_WIDTH;
        const tileY = ((my - mm.y) / mm.h) * MAP_HEIGHT;
        centerCameraOn(camera, tileX, tileY, canvas.width, canvas.height);
        e.preventDefault();
        return;
      }

      // Day 15: Tag mode — click to place tag
      if (input.tagMode) {
        const worldX = mx / camera.zoom + camera.x;
        const worldY = my / camera.zoom + camera.y;
        input.pendingTag = { worldX: worldX / TILE_SIZE, worldY: worldY / TILE_SIZE };
        input.tagMode = false;
        e.preventDefault();
        return;
      }

      // Start selection box
      input.isSelecting = true;
      input.selectionStartScreenX = mx;
      input.selectionStartScreenY = my;
      input.selectionEndScreenX = mx;
      input.selectionEndScreenY = my;
      input.selectionComplete = false;
      e.preventDefault();
    }

    // --- Middle click: pan camera ---
    if (e.button === 1) {
      input.isDragging = true;
      input.dragStartX = e.clientX;
      input.dragStartY = e.clientY;
      input.cameraStartX = camera.x;
      input.cameraStartY = camera.y;
      e.preventDefault();
    }

    // --- Right click: command or pan ---
    if (e.button === 2) {
      rightClickStartX = e.clientX;
      rightClickStartY = e.clientY;
      isRightDragging = true;
      // Also start pan tracking in case user drags
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

    // Update selection box end position
    if (input.isSelecting) {
      input.selectionEndScreenX = input.mouseX;
      input.selectionEndScreenY = input.mouseY;
    }

    // Camera panning (middle or right drag)
    if (input.isDragging) {
      const dx = (e.clientX - input.dragStartX) / camera.zoom;
      const dy = (e.clientY - input.dragStartY) / camera.zoom;
      camera.x = input.cameraStartX - dx;
      camera.y = input.cameraStartY - dy;
      clampCamera(camera, canvas.width, canvas.height);
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Left click release → finalize selection
    if (e.button === 0 && input.isSelecting) {
      input.isSelecting = false;
      input.selectionEndScreenX = mx;
      input.selectionEndScreenY = my;
      input.selectionComplete = true; // consumed by game loop
    }

    // Middle click release → stop pan
    if (e.button === 1) {
      input.isDragging = false;
    }

    // Right click release → command if didn't drag far, else just stop pan
    if (e.button === 2) {
      input.isDragging = false;
      if (isRightDragging) {
        isRightDragging = false;
        const dragDist = Math.sqrt(
          (e.clientX - rightClickStartX) ** 2 +
          (e.clientY - rightClickStartY) ** 2,
        );
        if (dragDist < SELECTION_DRAG_THRESHOLD) {
          // Right-click command: convert screen coords to world coords (Day 15: always emit for tag menu)
          const worldX = mx / camera.zoom + camera.x;
          const worldY = my / camera.zoom + camera.y;
          input.rightClickCommand = {
            worldX: worldX / TILE_SIZE,
            worldY: worldY / TILE_SIZE,
          };
        }
      }
    }
  };

  // Day 13 P2-5: Accept MouseEvent to refresh coords on enter (prevents stale edge-scroll)
  const onMouseEnter = (e: MouseEvent) => {
    input.mouseInCanvas = true;
    const rect = canvas.getBoundingClientRect();
    input.mouseX = e.clientX - rect.left;
    input.mouseY = e.clientY - rect.top;
  };
  const onMouseLeave = () => { input.mouseInCanvas = false; };

  const onContextMenu = (e: Event) => e.preventDefault();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focusin", onFocusIn);
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
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("focusin", onFocusIn);
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
 * Convert screen coordinates to world tile coordinates.
 */
export function screenToTile(
  screenX: number,
  screenY: number,
  camera: Camera,
): { tileX: number; tileY: number } {
  const worldX = screenX / camera.zoom + camera.x;
  const worldY = screenY / camera.zoom + camera.y;
  return {
    tileX: worldX / TILE_SIZE,
    tileY: worldY / TILE_SIZE,
  };
}

/**
 * Check if a drag was large enough to be a box selection (vs single click).
 */
export function isBoxSelection(input: InputState): boolean {
  const dx = input.selectionEndScreenX - input.selectionStartScreenX;
  const dy = input.selectionEndScreenY - input.selectionStartScreenY;
  return Math.sqrt(dx * dx + dy * dy) >= SELECTION_DRAG_THRESHOLD;
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
