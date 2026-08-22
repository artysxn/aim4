// ---------------------------------------------------------------------------
// Analytics radar — map + drawn selection outlines + optional draw tools.
// Supports wheel zoom and drag-pan while zoomed (when not drawing).
//
// Drawn selections are also editable here, on the canvas, rather than only in
// the list beside it: hovering one names it, its corners drag to reshape it,
// and a × on the shape removes it. The list stays the authority — it owns the
// clock window, the enable switch and the ordering — but "which box was that,
// and a bit further left" is a question about the map, and answering it by
// reading a row of text and deleting and redrawing was the long way round.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';
import { loadRadar } from '../viewer/radarRenderer.js';
import { pointInPiece } from '../zones/zoneGeom.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

/** Corner / vertex grab dot: drawn this big, grabbable a little wider. */
const HANDLE_R = 4;
const HANDLE_HIT = 10;
/** The × badge that removes a selection, at the top-right of its bounds. */
const CLOSE_R = 8;
/** A rectangle never resizes below this, in world units, so it stays grabbable. */
const MIN_RECT_WORLD = 48;

/**
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   wrap?: HTMLElement,
 *   onShapeComplete?: (geometry: object) => void,
 *   shapeLabel?: (shape: object, index: number)
 *     => string | Array<{ text: string, color?: string }>,
 *   onShapeEdit?: (id: string, geometry: object) => void,
 *   onShapeDelete?: (id: string) => void
 * }} els
 */
export function createPresenceRadar(els) {
  const canvas = els.canvas;
  const wrap = els.wrap || canvas?.parentElement;
  const onShapeComplete = els.onShapeComplete || null;
  const shapeLabel = els.shapeLabel || null;
  const onShapeEdit = els.onShapeEdit || null;
  const onShapeDelete = els.onShapeDelete || null;

  let mapCode = '';
  /** @type {Array<object>} */
  let shapes = [];
  /** @type {''|'rect'|'poly'|'lasso'} */
  let drawMode = '';
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let img = null;
  let imgCode = '';
  let paintToken = 0;
  let dragging = false;
  let dragLastX = 0;
  let dragLastY = 0;

  /** Rect drag in world coords. */
  let rectStart = null;
  let rectCur = null;
  /** @type {Array<[number, number]>} world verts while drawing poly */
  let polyVerts = [];
  /** @type {Array<[number, number]>} world path while lassoing */
  let lassoPath = [];
  let lassoing = false;

  /** The selection under the pointer: its id, and which part of it. */
  let hoverId = '';
  /** @type {''|'body'|'handle'|'close'} */
  let hoverKind = '';
  let hoverIndex = -1;
  /** Cursor in canvas space, for the name tag. Null when the pointer is away. */
  let cursor = null;
  /**
   * A corner being dragged: which selection, which handle, and — for a
   * rectangle — the opposite corner, held fixed for the whole drag so the box
   * does not jump when it is dragged inside out.
   * @type {{ id: string, index: number, anchor: {x: number, y: number}|null }|null}
   */
  let editing = null;

  function clampPan(viewW, viewH) {
    const world = Math.min(viewW, viewH) * zoom;
    const maxX = Math.max(0, (world - viewW) / 2);
    const maxY = Math.max(0, (world - viewH) / 2);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  function viewGeom() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const viewW = Math.max(200, wrap?.clientWidth || canvas.clientWidth || 400);
    const viewH = Math.max(220, Math.min(420, Math.round(viewW * 0.72)));
    const side = Math.min(viewW, viewH) * zoom;
    const originX = viewW / 2 - side / 2 + panX;
    const originY = viewH / 2 - side / 2 + panY;
    const scale = side / RADAR_SIZE;
    return { dpr, viewW, viewH, side, originX, originY, scale };
  }

  function canvasToRadar(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { viewW, viewH, originX, originY, scale } = viewGeom();
    // Account for CSS size vs internal — use getBoundingClientRect.
    const mx = ((clientX - rect.left) / rect.width) * viewW;
    const my = ((clientY - rect.top) / rect.height) * viewH;
    return {
      rx: (mx - originX) / scale,
      ry: (my - originY) / scale
    };
  }

  function canvasToWorld(clientX, clientY) {
    const { rx, ry } = canvasToRadar(clientX, clientY);
    return radarToWorld(mapCode, rx, ry, {});
  }

  /**
   * World → canvas, outside `paint`, so hit-testing measures against exactly
   * what was drawn.
   */
  function projector() {
    const { originX, originY, scale } = viewGeom();
    const pt = { x: 0, y: 0 };
    return (wx, wy) => {
      worldToRadar(mapCode, wx, wy, pt);
      return { x: originX + pt.x * scale, y: originY + pt.y * scale };
    };
  }

  /** Pointer in the same space `projector` returns. */
  function canvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { viewW, viewH } = viewGeom();
    return {
      x: ((clientX - rect.left) / rect.width) * viewW,
      y: ((clientY - rect.top) / rect.height) * viewH
    };
  }

  /** A rectangle's four corners in WORLD coords, clockwise from the origin. */
  function rectCorners(g) {
    return [
      { x: g.x, y: g.y },
      { x: g.x + g.w, y: g.y },
      { x: g.x + g.w, y: g.y + g.h },
      { x: g.x, y: g.y + g.h }
    ];
  }

  /** Grab points for a selection, in world coords. */
  function handleWorld(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'rect') return rectCorners(geometry);
    if (geometry.type === 'poly') return (geometry.ring || []).map(([x, y]) => ({ x, y }));
    return [];
  }

  function shapeBounds(geometry, toCanvas) {
    const pts = handleWorld(geometry).map((w) => toCanvas(w.x, w.y));
    if (!pts.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function closeBadge(geometry, toCanvas) {
    const b = shapeBounds(geometry, toCanvas);
    if (!b) return null;
    return { x: b.maxX + CLOSE_R * 0.6, y: b.minY - CLOSE_R * 0.6, r: CLOSE_R };
  }

  const near = (ax, ay, bx, by, r) => (ax - bx) ** 2 + (ay - by) ** 2 <= r * r;

  /**
   * What is under the pointer.
   *
   * The selection already hovered is asked first, and about its handles and ×
   * before its outline, because both sit outside that outline — otherwise
   * reaching for a corner would drop the hover that revealed it.
   */
  function hitTest(cx, cy, wx, wy) {
    const toCanvas = projector();
    const drawn = shapes.filter((s) => s?.geometry && s.enabled !== false);
    const active = drawn.find((s) => s.id === hoverId);
    const order = active ? [active, ...drawn.filter((s) => s !== active).reverse()] : [...drawn].reverse();
    for (const shape of order) {
      if (shape === active) {
        const badge = closeBadge(shape.geometry, toCanvas);
        if (badge && near(cx, cy, badge.x, badge.y, badge.r)) {
          return { shape, kind: 'close', index: -1 };
        }
        const pts = handleWorld(shape.geometry);
        for (let i = 0; i < pts.length; i++) {
          const p = toCanvas(pts[i].x, pts[i].y);
          if (near(cx, cy, p.x, p.y, HANDLE_HIT)) return { shape, kind: 'handle', index: i };
        }
      }
      if (pointInPiece(wx, wy, shape.geometry)) return { shape, kind: 'body', index: -1 };
    }
    return null;
  }

  /** The pointer shape for whatever is under it. */
  function cursorFor(hit, toCanvas) {
    if (!hit) return drawMode ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default';
    if (hit.kind === 'close') return 'pointer';
    if (hit.kind === 'handle') {
      const g = hit.shape.geometry;
      if (g.type !== 'rect') return 'move';
      const pts = handleWorld(g).map((w) => toCanvas(w.x, w.y));
      const cxm = pts.reduce((n, p) => n + p.x, 0) / pts.length;
      const cym = pts.reduce((n, p) => n + p.y, 0) / pts.length;
      const p = pts[hit.index];
      return (p.x - cxm) * (p.y - cym) > 0 ? 'nwse-resize' : 'nesw-resize';
    }
    return drawMode ? 'crosshair' : 'pointer';
  }

  function applyCursor(hit) {
    canvas.style.cursor = cursorFor(hit, projector());
  }

  /** Move one handle of one selection to a world point, in place. */
  function dragHandleTo(shape, index, anchor, wx, wy) {
    const g = shape.geometry;
    if (g.type === 'poly') {
      if (!g.ring?.[index]) return;
      g.ring[index] = [wx, wy];
      return;
    }
    if (g.type !== 'rect' || !anchor) return;
    // Never collapse to nothing: a zero-width box cannot be grabbed again.
    let px = wx;
    let py = wy;
    if (Math.abs(px - anchor.x) < MIN_RECT_WORLD) {
      px = anchor.x + (px < anchor.x ? -1 : 1) * MIN_RECT_WORLD;
    }
    if (Math.abs(py - anchor.y) < MIN_RECT_WORLD) {
      py = anchor.y + (py < anchor.y ? -1 : 1) * MIN_RECT_WORLD;
    }
    g.x = Math.min(px, anchor.x);
    g.y = Math.min(py, anchor.y);
    g.w = Math.abs(px - anchor.x);
    g.h = Math.abs(py - anchor.y);
  }

  /** The grab dots, the × and the name tag for whatever is hovered. */
  function paintOverlay(ctx, toCanvas, viewW, viewH) {
    const shape = shapes.find((s) => s.id === hoverId && s.enabled !== false);
    if (!shape?.geometry) return;
    const index = shapes.indexOf(shape);

    for (const w of handleWorld(shape.geometry)) {
      const p = toCanvas(w.x, w.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#0c0e12';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 226, 150, 0.98)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    const badge = closeBadge(shape.geometry, toCanvas);
    if (badge) {
      const hot = hoverKind === 'close';
      ctx.beginPath();
      ctx.arc(badge.x, badge.y, badge.r, 0, Math.PI * 2);
      ctx.fillStyle = hot ? 'rgba(214, 68, 68, 0.95)' : 'rgba(18, 20, 26, 0.9)';
      ctx.fill();
      ctx.strokeStyle = hot ? 'rgba(255, 180, 180, 0.95)' : 'rgba(232, 184, 74, 0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.strokeStyle = hot ? '#fff' : 'rgba(232, 184, 74, 0.95)';
      ctx.lineWidth = 1.6;
      const d = badge.r * 0.42;
      ctx.beginPath();
      ctx.moveTo(badge.x - d, badge.y - d);
      ctx.lineTo(badge.x + d, badge.y + d);
      ctx.moveTo(badge.x + d, badge.y - d);
      ctx.lineTo(badge.x - d, badge.y + d);
      ctx.stroke();
    }

    // A label may be a string, or lines with their own colour — a map-control
    // selection reports a T and a CT win rate under its name, and those want
    // to be the side colours rather than two identical greys.
    const raw = shapeLabel?.(shape, index);
    const lines = (Array.isArray(raw)
      ? raw
      : String(raw || '')
          .split('\n')
          .map((text) => ({ text }))
    ).filter((l) => l && l.text);
    if (!lines.length || !cursor) return;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padX = 7;
    const lineH = 15;
    const font = (i) =>
      `${i === 0 ? '600' : '500'} 11px var(--font-body, system-ui, sans-serif)`;
    let w = 0;
    for (let i = 0; i < lines.length; i++) {
      ctx.font = font(i);
      w = Math.max(w, Math.ceil(ctx.measureText(lines[i].text).width));
    }
    w += padX * 2;
    const h = 6 + lines.length * lineH;
    // Below the pointer, and inside the canvas. Below rather than above
    // because the × sits at the top-right of the selection, and on a small box
    // an above-pointer tag lands straight on top of it.
    const x = Math.min(Math.max(4, cursor.x + 12), viewW - w - 4);
    let y = cursor.y + 14;
    if (y + h > viewH - 4) y = Math.max(4, cursor.y - h - 10);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.94)';
    ctx.strokeStyle = 'rgba(232, 184, 74, 0.5)';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
    for (let i = 0; i < lines.length; i++) {
      ctx.font = font(i);
      ctx.fillStyle =
        lines[i].color || (i === 0 ? 'rgba(238, 240, 246, 0.98)' : 'rgba(206, 212, 224, 0.95)');
      ctx.fillText(lines[i].text, x + padX, y + 3 + i * lineH + lineH / 2);
    }
  }

  async function paint() {
    if (!canvas || !mapCode) return;
    const token = ++paintToken;
    const { dpr, viewW, viewH, side, originX, originY, scale } = viewGeom();
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, viewW, viewH);

    if (imgCode !== mapCode) {
      try {
        img = await loadRadar(mapCode);
        imgCode = mapCode;
      } catch {
        img = null;
        imgCode = mapCode;
      }
    }
    if (token !== paintToken) return;

    clampPan(viewW, viewH);
    const pt = { x: 0, y: 0 };
    const toCanvas = (wx, wy) => {
      worldToRadar(mapCode, wx, wy, pt);
      return { x: originX + pt.x * scale, y: originY + pt.y * scale };
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, viewW, viewH);
    ctx.clip();

    if (img) {
      ctx.globalAlpha = 0.92;
      ctx.drawImage(img, originX, originY, side, side);
      ctx.globalAlpha = 1;
    }

    for (const shape of shapes) {
      if (!shape?.geometry || shape.enabled === false) continue;
      const lit = shape.id && shape.id === hoverId;
      drawGeometry(
        ctx,
        shape.geometry,
        toCanvas,
        lit ? 'rgba(255, 226, 150, 1)' : 'rgba(232, 184, 74, 0.95)',
        lit ? 'rgba(232, 184, 74, 0.36)' : 'rgba(232, 184, 74, 0.22)'
      );
    }

    // In-progress rect
    if (rectStart && rectCur) {
      const a = toCanvas(rectStart.x, rectStart.y);
      const b = toCanvas(rectCur.x, rectCur.y);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.95)';
      ctx.fillStyle = 'rgba(120, 200, 255, 0.18)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    // In-progress poly
    if (polyVerts.length) {
      ctx.beginPath();
      polyVerts.forEach(([wx, wy], i) => {
        const p = toCanvas(wx, wy);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      for (const [wx, wy] of polyVerts) {
        const p = toCanvas(wx, wy);
        ctx.fillStyle = 'rgba(120, 200, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // In-progress lasso
    if (lassoPath.length) {
      ctx.beginPath();
      lassoPath.forEach(([wx, wy], i) => {
        const p = toCanvas(wx, wy);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (lassoPath.length >= 3) {
        const first = toCanvas(lassoPath[0][0], lassoPath[0][1]);
        ctx.lineTo(first.x, first.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(120, 200, 255, 0.14)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    paintOverlay(ctx, toCanvas, viewW, viewH);

    ctx.restore();

    if (zoom > 1.01) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(8, 8, 54, 20);
      ctx.fillStyle = 'rgba(220, 224, 232, 0.9)';
      ctx.font = '600 11px var(--font-body, system-ui, sans-serif)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${zoom.toFixed(1)}×`, 16, 18);
    }
  }

  /**
   * @param {string} nextMap
   * @param {Array<object>} nextShapes
   * @param {''|'rect'|'poly'|'lasso'} [nextDrawMode]
   */
  function setData(nextMap, nextShapes, nextDrawMode) {
    const mapChanged = nextMap !== mapCode;
    mapCode = nextMap || '';
    shapes = nextShapes || [];
    if (nextDrawMode !== undefined) drawMode = nextDrawMode;
    if (mapChanged) {
      zoom = 1;
      panX = 0;
      panY = 0;
      img = null;
      imgCode = '';
      cancelDraft();
    }
    canvas.style.cursor = drawMode ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default';
    return paint();
  }

  function setDrawMode(mode) {
    drawMode = mode || '';
    cancelDraft();
    canvas.style.cursor = drawMode ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default';
    paint();
  }

  function cancelDraft() {
    rectStart = null;
    rectCur = null;
    polyVerts = [];
    lassoPath = [];
    lassoing = false;
  }

  /** Drop near-duplicate points; keep ≤64 verts for shape storage. */
  function simplifyLasso(path) {
    if (!path?.length) return [];
    const minDist = 24;
    /** @type {Array<[number, number]>} */
    const out = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const [x, y] = path[i];
      const [lx, ly] = out[out.length - 1];
      const dx = x - lx;
      const dy = y - ly;
      if (dx * dx + dy * dy >= minDist * minDist) out.push([x, y]);
    }
    if (out.length > 64) {
      const step = Math.ceil(out.length / 64);
      const thinned = [];
      for (let i = 0; i < out.length; i += step) thinned.push(out[i]);
      if (thinned[thinned.length - 1] !== out[out.length - 1]) thinned.push(out[out.length - 1]);
      return thinned;
    }
    return out;
  }

  function finishLasso() {
    const ring = simplifyLasso(lassoPath);
    lassoPath = [];
    lassoing = false;
    if (ring.length < 3) {
      paint();
      return;
    }
    onShapeComplete?.({ type: 'poly', ring });
    paint();
  }

  function finishPoly() {
    if (polyVerts.length < 3) {
      cancelDraft();
      paint();
      return;
    }
    const geometry = { type: 'poly', ring: polyVerts.map((p) => [...p]) };
    polyVerts = [];
    onShapeComplete?.(geometry);
    paint();
  }

  function onWheel(e) {
    // Zoom always (including draw mode) so the map stays inspectable while
    // placing shapes. Pan still requires zoom > 1 and no active draw drag.
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const viewW = rect.width;
    const viewH = rect.height;
    const before = zoom;
    const factor = e.deltaY > 0 ? 0.9 : 1.12;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (zoom === before) return;
    const k = zoom / before;
    panX = (mx - viewW / 2) * (1 - k) + panX * k;
    panY = (my - viewH / 2) * (1 - k) + panY * k;
    if (zoom <= 1.001) {
      zoom = 1;
      panX = 0;
      panY = 0;
    }
    canvas.style.cursor = drawMode ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default';
    paint();
  }

  function getView() {
    return { zoom, panX, panY };
  }

  function setView(view) {
    if (!view) return;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(view.zoom) || 1));
    panX = Number(view.panX) || 0;
    panY = Number(view.panY) || 0;
    if (zoom <= 1.001) {
      zoom = 1;
      panX = 0;
      panY = 0;
    }
    canvas.style.cursor = drawMode ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default';
  }

  function onPointerDown(e) {
    // Editing an existing selection wins over starting a new one. The targets
    // are small and deliberate — a corner dot or the × — so pressing on one is
    // never an accident, and requiring the draw tool to be off first would
    // mean a trip to the sidebar to nudge a box.
    // ...unless a selection is half-drawn, in which case the next click is
    // part of that and nothing else.
    const drafting = Boolean(rectStart || lassoing || polyVerts.length);
    const c = canvasPoint(e.clientX, e.clientY);
    const w0 = canvasToWorld(e.clientX, e.clientY);
    const hit = drafting ? null : hitTest(c.x, c.y, w0.x, w0.y);
    if (hit?.kind === 'close') {
      const id = hit.shape.id;
      hoverId = '';
      hoverKind = '';
      onShapeDelete?.(id);
      return;
    }
    if (hit?.kind === 'handle') {
      const g = hit.shape.geometry;
      editing = {
        id: hit.shape.id,
        index: hit.index,
        anchor: g.type === 'rect' ? rectCorners(g)[(hit.index + 2) % 4] : null
      };
      hoverId = hit.shape.id;
      hoverKind = 'handle';
      hoverIndex = hit.index;
      canvas.setPointerCapture?.(e.pointerId);
      paint();
      return;
    }

    if (drawMode === 'rect') {
      const w = canvasToWorld(e.clientX, e.clientY);
      rectStart = { x: w.x, y: w.y };
      rectCur = { x: w.x, y: w.y };
      canvas.setPointerCapture?.(e.pointerId);
      paint();
      return;
    }
    if (drawMode === 'lasso') {
      const w = canvasToWorld(e.clientX, e.clientY);
      lassoing = true;
      lassoPath = [[w.x, w.y]];
      canvas.setPointerCapture?.(e.pointerId);
      paint();
      return;
    }
    if (drawMode === 'poly') {
      const w = canvasToWorld(e.clientX, e.clientY);
      polyVerts.push([w.x, w.y]);
      paint();
      return;
    }
    if (zoom <= 1.001) return;
    dragging = true;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.classList.add('dragging');
  }

  function onPointerMove(e) {
    cursor = canvasPoint(e.clientX, e.clientY);
    if (editing) {
      const shape = shapes.find((x) => x.id === editing.id);
      if (shape) {
        const w = canvasToWorld(e.clientX, e.clientY);
        dragHandleTo(shape, editing.index, editing.anchor, w.x, w.y);
        paint();
      }
      return;
    }
    if (drawMode === 'rect' && rectStart) {
      const w = canvasToWorld(e.clientX, e.clientY);
      rectCur = { x: w.x, y: w.y };
      paint();
      return;
    }
    if (drawMode === 'lasso' && lassoing) {
      const w = canvasToWorld(e.clientX, e.clientY);
      const last = lassoPath[lassoPath.length - 1];
      if (!last || (w.x - last[0]) ** 2 + (w.y - last[1]) ** 2 >= 12 * 12) {
        lassoPath.push([w.x, w.y]);
        paint();
      }
      return;
    }
    if (!dragging) {
      // Idle: keep the hover — and its name tag — in step with the pointer.
      const w = canvasToWorld(e.clientX, e.clientY);
      const hit = hitTest(cursor.x, cursor.y, w.x, w.y);
      const id = hit?.shape?.id || '';
      const kind = hit?.kind || '';
      const index = hit?.index ?? -1;
      const moved = id !== hoverId || kind !== hoverKind || index !== hoverIndex;
      hoverId = id;
      hoverKind = kind;
      hoverIndex = index;
      applyCursor(hit);
      // Repaint on any move while something is hovered: the tag follows.
      if (moved || id) paint();
      return;
    }
    panX += e.clientX - dragLastX;
    panY += e.clientY - dragLastY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    paint();
  }

  /** Pointer left the canvas: nothing is hovered, so nothing is labelled. */
  function onPointerLeave() {
    if (editing) return;
    cursor = null;
    if (!hoverId) return;
    hoverId = '';
    hoverKind = '';
    hoverIndex = -1;
    canvas.style.cursor = drawMode ? 'crosshair' : zoom > 1.001 ? 'grab' : 'default';
    paint();
  }

  function onPointerUp(e) {
    if (editing) {
      const shape = shapes.find((x) => x.id === editing.id);
      const done = editing;
      editing = null;
      try {
        canvas.releasePointerCapture?.(e.pointerId);
      } catch {
        /* */
      }
      // Committed once, at the end: the search re-runs on the new geometry,
      // not on every pixel of the drag.
      if (shape) onShapeEdit?.(done.id, shape.geometry);
      paint();
      return;
    }
    if (drawMode === 'lasso' && lassoing) {
      try {
        canvas.releasePointerCapture?.(e.pointerId);
      } catch {
        /* */
      }
      finishLasso();
      return;
    }
    if (drawMode === 'rect' && rectStart && rectCur) {
      const x = Math.min(rectStart.x, rectCur.x);
      const y = Math.min(rectStart.y, rectCur.y);
      const w = Math.abs(rectCur.x - rectStart.x);
      const h = Math.abs(rectCur.y - rectStart.y);
      rectStart = null;
      rectCur = null;
      try {
        canvas.releasePointerCapture?.(e.pointerId);
      } catch {
        /* */
      }
      if (w > 40 && h > 40) {
        onShapeComplete?.({ type: 'rect', x, y, w, h });
      }
      paint();
      return;
    }
    dragging = false;
    canvas.classList.remove('dragging');
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
  }

  function onDblClick(e) {
    e.preventDefault();
    if (drawMode === 'poly') {
      finishPoly();
      return;
    }
    if (drawMode) return;
    zoom = 1;
    panX = 0;
    panY = 0;
    paint();
  }

  function onKeyDown(e) {
    if (!drawMode) return;
    if (e.key === 'Escape') {
      cancelDraft();
      paint();
    } else if (e.key === 'Enter' && drawMode === 'poly') {
      finishPoly();
    }
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDblClick);
  window.addEventListener('keydown', onKeyDown);

  let resizeObs = null;
  if (typeof ResizeObserver !== 'undefined' && wrap) {
    resizeObs = new ResizeObserver(() => paint());
    resizeObs.observe(wrap);
  }

  return {
    setData,
    setDrawMode,
    getView,
    setView,
    finishPoly,
    cancelDraft,
    paint,
    destroy() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('keydown', onKeyDown);
      resizeObs?.disconnect();
    }
  };
}

function drawGeometry(ctx, geometry, toCanvas, stroke, fill) {
  ctx.beginPath();
  let started = false;
  if (geometry.type === 'rect') {
    const a = toCanvas(geometry.x, geometry.y);
    const b = toCanvas(geometry.x + geometry.w, geometry.y + geometry.h);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    ctx.rect(x, y, w, h);
    started = true;
  } else if (geometry.type === 'poly' && geometry.ring?.length) {
    geometry.ring.forEach(([wx, wy], i) => {
      const p = toCanvas(wx, wy);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
      started = true;
    });
    ctx.closePath();
  }
  if (!started) return;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
