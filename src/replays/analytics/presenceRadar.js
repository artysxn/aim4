// ---------------------------------------------------------------------------
// Analytics "Where they play" radar — full-width map + position outlines.
// Supports wheel zoom and drag-pan while zoomed.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { loadRadar } from '../viewer/radarRenderer.js';
import { pieceBounds } from '../zones/zoneGeom.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/**
 * Create a zoomable presence radar bound to a canvas + wrap element.
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   wrap?: HTMLElement,
 * }} els
 */
export function createPresenceRadar(els) {
  const canvas = els.canvas;
  const wrap = els.wrap || canvas?.parentElement;
  let mapCode = '';
  let network = null;
  /** @type {Array<{ id: string, count: number }>} */
  let ranked = [];
  /** @type {Set<string>} */
  let selected = new Set();
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let img = null;
  let imgCode = '';
  let paintToken = 0;
  let dragging = false;
  let dragLastX = 0;
  let dragLastY = 0;

  function clampPan(viewW, viewH) {
    const world = Math.min(viewW, viewH) * zoom;
    const maxX = Math.max(0, (world - viewW) / 2);
    const maxY = Math.max(0, (world - viewH) / 2);
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  async function paint() {
    if (!canvas || !mapCode) return;
    const token = ++paintToken;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const viewW = Math.max(200, wrap?.clientWidth || canvas.clientWidth || 400);
    // Wide frame; keep a comfortable height (square-ish up to 420).
    const viewH = Math.max(220, Math.min(420, Math.round(viewW * 0.72)));
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
    const side = Math.min(viewW, viewH) * zoom;
    const originX = viewW / 2 - side / 2 + panX;
    const originY = viewH / 2 - side / 2 + panY;
    const scale = side / RADAR_SIZE;
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

    const positions = network?.zones || [];
    if (positions.length) {
      const maxCount = Math.max(1, ...ranked.map((r) => r.count));
      const countOf = new Map(ranked.map((r) => [r.id, r.count]));

      for (const pos of positions) {
        if (pos.hidden || !pos.pieces?.length) continue;
        drawPosition(ctx, pos, toCanvas, 'rgba(180, 186, 196, 0.22)', 'rgba(180, 186, 196, 0.08)');
      }

      for (const pos of positions) {
        if (pos.hidden || !pos.pieces?.length) continue;
        const n = countOf.get(pos.id) || 0;
        if (!n) continue;
        const t = n / maxCount;
        const selectedOn = selected?.has(pos.id);
        const fill = selectedOn
          ? `rgba(232, 184, 74, ${0.25 + t * 0.45})`
          : `rgba(91, 159, 212, ${0.12 + t * 0.4})`;
        const stroke = selectedOn
          ? 'rgba(232, 184, 74, 0.95)'
          : `rgba(140, 190, 230, ${0.35 + t * 0.5})`;
        drawPosition(ctx, pos, toCanvas, stroke, fill);
      }

      const labelPx = Math.max(10, Math.min(13, 11 * Math.sqrt(zoom)));
      ctx.font = `600 ${labelPx}px var(--font-body, system-ui, sans-serif)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelIds = new Set([
        ...ranked.slice(0, 8).map((r) => r.id),
        ...[...(selected || [])]
      ]);
      for (const pos of positions) {
        if (!labelIds.has(pos.id) || !pos.pieces?.length) continue;
        const c = centroid(pos, toCanvas);
        if (!c) continue;
        const label = String(pos.name || '').trim();
        if (!label) continue;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        const w = ctx.measureText(label).width + 8;
        ctx.fillRect(c.x - w / 2, c.y - labelPx * 0.7, w, labelPx * 1.4);
        ctx.fillStyle = selected?.has(pos.id) ? '#f5d27a' : '#e8ecf2';
        ctx.fillText(label, c.x, c.y);
      }
    }
    ctx.restore();

    // Zoom hint chip
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
   * @param {object|null} nextNetwork
   * @param {Array<{ id: string, count: number }>} nextRanked
   * @param {Set<string>} nextSelected
   */
  function setData(nextMap, nextNetwork, nextRanked, nextSelected) {
    const mapChanged = nextMap !== mapCode;
    mapCode = nextMap || '';
    network = nextNetwork;
    ranked = nextRanked || [];
    selected = nextSelected || new Set();
    if (mapChanged) {
      zoom = 1;
      panX = 0;
      panY = 0;
      img = null;
      imgCode = '';
    }
    return paint();
  }

  function onWheel(e) {
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
    // Zoom toward cursor
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
    if (zoom <= 1.001) return;
    dragging = true;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.classList.add('dragging');
  }

  function onPointerMove(e) {
    if (!dragging) return;
    panX += e.clientX - dragLastX;
    panY += e.clientY - dragLastY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    paint();
  }

  function onPointerUp(e) {
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
    zoom = 1;
    panX = 0;
    panY = 0;
    paint();
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);

  let resizeObs = null;
  if (typeof ResizeObserver !== 'undefined' && wrap) {
    resizeObs = new ResizeObserver(() => paint());
    resizeObs.observe(wrap);
  }

  return {
    setData,
    paint,
    destroy() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      resizeObs?.disconnect();
    }
  };
}

function drawPosition(ctx, pos, toCanvas, stroke, fill) {
  ctx.beginPath();
  let started = false;
  for (const piece of pos.pieces || []) {
    if (piece.type === 'rect') {
      const a = toCanvas(piece.x, piece.y);
      const b = toCanvas(piece.x + piece.w, piece.y + piece.h);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.rect(x, y, w, h);
      started = true;
    } else if (piece.type === 'poly' && piece.ring?.length) {
      piece.ring.forEach(([wx, wy], i) => {
        const p = toCanvas(wx, wy);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        started = true;
      });
      ctx.closePath();
    }
  }
  if (!started) return;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.25;
  ctx.stroke();
}

function centroid(pos, toCanvas) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const piece of pos.pieces || []) {
    const b = pieceBounds(piece);
    if (!Number.isFinite(b.minX)) continue;
    const a = toCanvas(b.minX, b.minY);
    const c = toCanvas(b.maxX, b.maxY);
    minX = Math.min(minX, a.x, c.x);
    minY = Math.min(minY, a.y, c.y);
    maxX = Math.max(maxX, a.x, c.x);
    maxY = Math.max(maxY, a.y, c.y);
    any = true;
  }
  if (!any) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}
