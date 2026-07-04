// ---------------------------------------------------------------------------
// canvasWall.js — shared placement math for the stationary "canvas" modes
// (Gridshot / Stars / Pasu / Sequence / Turn / Box / Circle / …).
//
// The player floats at the canvas centre: the canvas extends equally above and
// below the base view line, and the whole board is lifted so it never dips
// into the floor. The canvas plane is sized EXACTLY to the dot spawn/travel
// area so it reads as "everything on the board is in play".
// ---------------------------------------------------------------------------

import { EYE_HEIGHT } from '../core/Engine.js';

/** Minimum clearance between the canvas' bottom edge and the floor (m). */
export const CANVAS_FLOOR_CLEARANCE = 0.5;

/**
 * Vertical centre for a canvas of height `boundsH`: the eye line when the
 * canvas fits at ground level, else lifted so the bottom edge stays clear.
 */
export function canvasCenterY(boundsH) {
  return Math.max(EYE_HEIGHT, boundsH / 2 + CANVAS_FLOOR_CLEARANCE);
}
