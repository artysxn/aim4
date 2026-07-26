// ---------------------------------------------------------------------------
// Compact radar for Analytics "Where they play" — map + position outlines.
// ---------------------------------------------------------------------------

import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { loadRadar } from '../viewer/radarRenderer.js';
import { pieceBounds } from '../zones/zoneGeom.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} mapCode
 * @param {object} network
 * @param {Array<{ id: string, count: number }>} ranked  position id → count
 * @param {Set<string>} selected
 */
export async function paintPresenceRadar(canvas, mapCode, network, ranked, selected) {
  if (!canvas || !mapCode) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = Math.min(280, canvas.clientWidth || 240);
  const size = Math.max(120, css);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#0c0e12';
  ctx.fillRect(0, 0, size, size);

  let img = null;
  try {
    img = await loadRadar(mapCode);
  } catch {
    img = null;
  }
  if (img) {
    ctx.globalAlpha = 0.92;
    ctx.drawImage(img, 0, 0, size, size);
    ctx.globalAlpha = 1;
  }

  const positions = network?.zones || [];
  if (!positions.length) return;

  const maxCount = Math.max(1, ...ranked.map((r) => r.count));
  const countOf = new Map(ranked.map((r) => [r.id, r.count]));
  const scale = size / RADAR_SIZE;
  const pt = { x: 0, y: 0 };

  const toCanvas = (wx, wy) => {
    worldToRadar(mapCode, wx, wy, pt);
    return { x: pt.x * scale, y: pt.y * scale };
  };

  // Dim outlines for every position.
  for (const pos of positions) {
    if (pos.hidden || !pos.pieces?.length) continue;
    drawPosition(ctx, pos, toCanvas, 'rgba(180, 186, 196, 0.22)', 'rgba(180, 186, 196, 0.08)');
  }

  // Heat fill by presence rank.
  for (const pos of positions) {
    if (pos.hidden || !pos.pieces?.length) continue;
    const n = countOf.get(pos.id) || 0;
    if (!n) continue;
    const t = n / maxCount;
    const selectedOn = selected?.has(pos.id);
    const fill = selectedOn
      ? `rgba(232, 184, 74, ${0.25 + t * 0.45})`
      : `rgba(91, 159, 212, ${0.12 + t * 0.4})`;
    const stroke = selectedOn ? 'rgba(232, 184, 74, 0.95)' : `rgba(140, 190, 230, ${0.35 + t * 0.5})`;
    drawPosition(ctx, pos, toCanvas, stroke, fill);
  }

  // Labels for top positions (and selected).
  ctx.font = `600 ${11}px var(--font-body, system-ui, sans-serif)`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelIds = new Set([
    ...ranked.slice(0, 6).map((r) => r.id),
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
    ctx.fillRect(c.x - w / 2, c.y - 8, w, 16);
    ctx.fillStyle = selected?.has(pos.id) ? '#f5d27a' : '#e8ecf2';
    ctx.fillText(label, c.x, c.y);
  }
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
      if (!started) {
        ctx.rect(x, y, w, h);
        started = true;
      } else {
        ctx.rect(x, y, w, h);
      }
    } else if (piece.type === 'poly' && piece.ring?.length) {
      piece.ring.forEach(([wx, wy], i) => {
        const p = toCanvas(wx, wy);
        if (i === 0 && !started) ctx.moveTo(p.x, p.y);
        else if (i === 0) ctx.moveTo(p.x, p.y);
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
