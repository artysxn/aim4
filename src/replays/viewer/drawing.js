// ---------------------------------------------------------------------------
// replays/viewer/drawing.js
// Freehand annotation over the radar.
//
// Strokes are stored as polylines in RADAR space (the same 0-1024 square the
// map image lives in), never in canvas pixels. That is what makes them
// vectors: zooming, panning or resizing the window re-projects the same points
// through the renderer's view transform, so a line drawn through mid stays on
// mid at any magnification.
//
// Strokes are kept per round for as long as the viewer is open and are not
// persisted; they are a talking aid, not a document.
// ---------------------------------------------------------------------------

import { SIDE_COLORS } from './radarRenderer.js';

/** The four pens, in the order they appear in the toolbar. */
export const DRAW_COLORS = [
  { id: 'gray', value: '#f0f0f0', label: 'Grey' },
  { id: 't', value: SIDE_COLORS.T.base, label: 'T' },
  { id: 'ct', value: SIDE_COLORS.CT.base, label: 'CT' },
  { id: 'red', value: '#d91616', label: 'Red' }
];

/** Screen-space stroke width. Constant with zoom, so a line stays legible. */
export const STROKE_WIDTH = 2.6;

/** How close (in screen pixels) the eraser has to pass to a line to take it. */
const ERASE_RADIUS = 9;

/**
 * Radar units are only meaningful next to a scale, so both the eraser radius
 * and the "did the pointer actually move" test are converted from screen
 * pixels at the current zoom.
 */
const MIN_STEP = 1.2;

export class DrawingLayer {
  constructor() {
    /** @type {Map<string, Array>} round file -> finished strokes */
    this.byRound = new Map();
    this.file = '';
    this.color = DRAW_COLORS[0].value;
    /** Left click draws. Right click always draws, mode or not. */
    this.enabled = false;
    this.erasing = false;
    /** The stroke being drawn right now, or null. */
    this.active = null;
    this.onChange = null;
  }

  setRound(file) {
    this.file = file || '';
    this.active = null;
  }

  /** @returns {Array} finished strokes for the active round */
  strokes() {
    if (!this.file) return [];
    let list = this.byRound.get(this.file);
    if (!list) {
      list = [];
      this.byRound.set(this.file, list);
    }
    return list;
  }

  /** Finished strokes plus the one in progress, for the renderer. */
  visible() {
    const list = this.strokes();
    return this.active ? [...list, this.active] : list;
  }

  hasAny() {
    return this.strokes().length > 0 || Boolean(this.active);
  }

  begin(pt) {
    if (!this.file) return;
    this.active = { color: this.color, width: STROKE_WIDTH, pts: [{ x: pt.x, y: pt.y }] };
    this._changed();
  }

  /** @param {number} scale radar units per screen pixel is 1/scale */
  extend(pt, scale = 1) {
    if (!this.active) return;
    const last = this.active.pts[this.active.pts.length - 1];
    // Thin the input: a pointer at 240 Hz would otherwise store hundreds of
    // points a second, all inside the same pixel.
    const step = MIN_STEP / Math.max(scale, 1e-6);
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < step) return;
    this.active.pts.push({ x: pt.x, y: pt.y });
    this._changed();
  }

  end() {
    if (!this.active) return;
    // A click with no drag is a dot, which is a legitimate mark; anything with
    // a single point still draws as a round cap.
    this.strokes().push(this.active);
    this.active = null;
    this._changed();
  }

  cancel() {
    if (!this.active) return;
    this.active = null;
    this._changed();
  }

  /**
   * Erase every stroke the eraser is currently over. Whole strokes go, not
   * segments: a half-erased line is worse than no line.
   *
   * @returns {boolean} true when something was removed
   */
  eraseAt(pt, scale = 1) {
    const list = this.strokes();
    if (!list.length) return false;
    const reach = ERASE_RADIUS / Math.max(scale, 1e-6);
    let removed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (strokeHit(list[i], pt, reach)) {
        list.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this._changed();
    return removed;
  }

  clear() {
    this.byRound.set(this.file, []);
    this.active = null;
    this._changed();
  }

  _changed() {
    this.onChange?.();
  }
}

function strokeHit(stroke, pt, reach) {
  const pts = stroke.pts;
  if (!pts.length) return false;
  if (pts.length === 1) return Math.hypot(pts[0].x - pt.x, pts[0].y - pt.y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (segmentDistance(pts[i - 1], pts[i], pt) <= reach) return true;
  }
  return false;
}

function segmentDistance(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let f = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  f = Math.max(0, Math.min(1, f));
  return Math.hypot(p.x - (a.x + dx * f), p.y - (a.y + dy * f));
}
