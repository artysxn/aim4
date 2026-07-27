// ---------------------------------------------------------------------------
// Analytics radar — map + drawn selection outlines + optional draw tools.
// Supports wheel zoom and drag-pan while zoomed (when not drawing).
// ---------------------------------------------------------------------------

import { RADAR_SIZE, radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';
import { loadRadar } from '../viewer/radarRenderer.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/**
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   wrap?: HTMLElement,
 *   onShapeComplete?: (geometry: object) => void
 * }} els
 */
export function createPresenceRadar(els) {
  const canvas = els.canvas;
  const wrap = els.wrap || canvas?.parentElement;
  const onShapeComplete = els.onShapeComplete || null;

  let mapCode = '';
  /** @type {Array<object>} */
  let shapes = [];
  /** @type {''|'rect'|'poly'} */
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

  /** Rect drag in radar px (image space 0..RADAR_SIZE). */
  let rectStart = null;
  let rectCur = null;
  /** @type {Array<[number, number]>} world verts while drawing poly */
  let polyVerts = [];

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
      const on = shape.enabled !== false;
      drawGeometry(
        ctx,
        shape.geometry,
        toCanvas,
        on ? 'rgba(232, 184, 74, 0.95)' : 'rgba(180, 186, 196, 0.55)',
        on ? 'rgba(232, 184, 74, 0.22)' : 'rgba(180, 186, 196, 0.1)'
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
   * @param {''|'rect'|'poly'} [nextDrawMode]
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
    if (drawMode) return;
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
    paint();
  }

  function onPointerDown(e) {
    if (drawMode === 'rect') {
      const w = canvasToWorld(e.clientX, e.clientY);
      rectStart = { x: w.x, y: w.y };
      rectCur = { x: w.x, y: w.y };
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
    if (drawMode === 'rect' && rectStart) {
      const w = canvasToWorld(e.clientX, e.clientY);
      rectCur = { x: w.x, y: w.y };
      paint();
      return;
    }
    if (!dragging) return;
    panX += e.clientX - dragLastX;
    panY += e.clientY - dragLastY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    paint();
  }

  function onPointerUp(e) {
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
    finishPoly,
    cancelDraft,
    paint,
    destroy() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
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
