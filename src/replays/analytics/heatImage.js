// ---------------------------------------------------------------------------
// Antistrat images: radar heatmaps and spacing charts as data URIs.
//
// The heat pipeline is the macro analyzer's (viewer/analyzerViewer.js), fixed
// at its blur = 14 setting: black field + additive white stamps, Gaussian
// blur, gradient map (cold purple → hot yellow, black stays black), clipped
// to the playable radar, composited over the radar image with Screen. Output
// is JPEG, because these embed in team documents and size is a budget.
// ---------------------------------------------------------------------------

import { loadRadar } from '../viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';

/** The macro analyzer's blur slider value the user standardized on. */
const HEAT_BLUR = 14;
/** Stamp radius in radar (1024) pixels, as in the macro analyzer. */
const HEAT_STAMP_R = 5;
/** Internal render resolution per panel. */
const PANEL_RES = 512;

const maskByMap = new Map();

/** White mask of playable radar pixels (drops black/transparent padding). */
function playableMask(mapCode, img) {
  let mask = maskByMap.get(mapCode);
  if (mask) return mask;
  const w = img.naturalWidth || img.width || RADAR_SIZE;
  const h = img.naturalHeight || img.height || RADAR_SIZE;
  mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const ctx = mask.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] + d[i + 1] + d[i + 2];
    const on = d[i + 3] > 20 && lum > 36;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = on ? 255 : 0;
  }
  ctx.putImageData(imgData, 0, 0);
  maskByMap.set(mapCode, mask);
  return mask;
}

/** Gradient map for intensity 0..1 after blur (macro analyzer palette). */
function heatColorAt(t) {
  const stops = [
    [0, 0, 0, 0],
    [0.08, 40, 0, 70],
    [0.22, 90, 10, 140],
    [0.4, 180, 20, 160],
    [0.58, 240, 50, 90],
    [0.75, 255, 130, 30],
    [0.9, 255, 220, 50],
    [1, 255, 250, 200]
  ];
  const x = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const a = stops[i];
  const b = stops[i + 1];
  const u = (x - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const s = u * u * (3 - 2 * u);
  return [a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, a[3] + (b[3] - a[3]) * s];
}

/**
 * One heat panel (radar + heat) onto `ctx` at (dx, dy, size).
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} radar
 * @param {string} mapCode
 * @param {Array<{x: number, y: number}>} points  world coordinates
 */
function paintPanel(ctx, radar, mapCode, points, dx, dy, size) {
  ctx.drawImage(radar, dx, dy, size, size);

  if (!points?.length) return;
  const res = PANEL_RES;
  const scale = res / RADAR_SIZE;

  // 1) Black field, additive white stamps.
  const acc = document.createElement('canvas');
  acc.width = res;
  acc.height = res;
  const accCtx = acc.getContext('2d', { willReadFrequently: true });
  accCtx.fillStyle = '#000';
  accCtx.fillRect(0, 0, res, res);
  accCtx.globalCompositeOperation = 'lighter';
  const stampAlpha = Math.min(1, 0.55 + 0.35 / Math.sqrt(Math.max(1, points.length / 2)));
  accCtx.fillStyle = `rgba(255,255,255,${stampAlpha})`;
  const stampR = Math.max(2, HEAT_STAMP_R * scale);
  const pt = {};
  for (const p of points) {
    worldToRadar(mapCode, p.x, p.y, pt);
    const x = pt.x * scale;
    const y = pt.y * scale;
    if (x < -8 || y < -8 || x > res + 8 || y > res + 8) continue;
    accCtx.beginPath();
    accCtx.arc(x, y, stampR, 0, Math.PI * 2);
    accCtx.fill();
  }
  accCtx.globalCompositeOperation = 'source-over';

  // 2) Gaussian blur.
  const blurC = document.createElement('canvas');
  blurC.width = res;
  blurC.height = res;
  const blurCtx = blurC.getContext('2d', { willReadFrequently: true });
  blurCtx.fillStyle = '#000';
  blurCtx.fillRect(0, 0, res, res);
  blurCtx.filter = `blur(${Math.max(6, HEAT_BLUR * scale * 1.15)}px)`;
  blurCtx.drawImage(acc, 0, 0);
  blurCtx.filter = 'none';

  // 3) Gradient map, normalized to the hottest cell.
  const src = blurCtx.getImageData(0, 0, res, res);
  const colorC = document.createElement('canvas');
  colorC.width = res;
  colorC.height = res;
  const colorCtx = colorC.getContext('2d');
  const out = colorCtx.createImageData(res, res);
  const s = src.data;
  const d = out.data;
  let maxV = 1;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i] > maxV) maxV = s[i];
  }
  const inv = 1 / maxV;
  for (let i = 0; i < s.length; i += 4) {
    const [r, g, b] = heatColorAt(s[i] * inv);
    d[i] = r + 0.5;
    d[i + 1] = g + 0.5;
    d[i + 2] = b + 0.5;
    d[i + 3] = 255;
  }
  colorCtx.putImageData(out, 0, 0);

  // 4) Clip to the playable radar, then Screen over the map.
  const mask = playableMask(mapCode, radar);
  colorCtx.globalCompositeOperation = 'destination-in';
  colorCtx.drawImage(mask, 0, 0, res, res);
  colorCtx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(colorC, dx, dy, size, size);
  ctx.restore();
}

function panelLabel(ctx, text, dx, dy) {
  if (!text) return;
  ctx.save();
  ctx.font = '600 13px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(dx + 6, dy + 6, w, 20);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillText(text, dx + 12, dy + 20);
  ctx.restore();
}

/**
 * Single heatmap image.
 * @param {string} mapCode
 * @param {Array<{x: number, y: number}>} points
 * @param {{ size?: number, label?: string }} [opts]
 */
export async function heatDataUri(mapCode, points, { size = 480, label = '' } = {}) {
  if (!points?.length) return '';
  let radar = null;
  try {
    radar = await loadRadar(mapCode);
  } catch {
    return '';
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  paintPanel(ctx, radar, mapCode, points, 0, 0, size);
  panelLabel(ctx, label, 0, 0);
  try {
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return '';
  }
}

/**
 * 2x2 grid of heat panels in one image (per-player early / mid / late / all).
 * @param {string} mapCode
 * @param {Array<{ label: string, points: Array<{x:number,y:number}> }>} panels
 * @param {{ cell?: number }} [opts]
 */
export async function heatGridDataUri(mapCode, panels, { cell = 300 } = {}) {
  const list = (panels || []).slice(0, 4);
  if (!list.some((p) => p.points?.length)) return '';
  let radar = null;
  try {
    radar = await loadRadar(mapCode);
  } catch {
    return '';
  }
  const cols = 2;
  const rows = Math.ceil(list.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < list.length; i++) {
    const dx = (i % cols) * cell;
    const dy = Math.floor(i / cols) * cell;
    paintPanel(ctx, radar, mapCode, list[i].points, dx, dy, cell);
    panelLabel(ctx, list[i].label, dx, dy);
  }
  try {
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return '';
  }
}

/**
 * Average player spacing per second after the opening kill, with kill/death
 * markers. `spacing` is the scan's { avg, kills, deaths, n } series.
 * @param {{ avg: Array<number|null>, kills: number[], deaths: number[], n: number }} spacing
 * @param {{ width?: number, height?: number, title?: string }} [opts]
 */
export function spacingChartDataUri(spacing, { width = 440, height = 170, title = '' } = {}) {
  const avg = spacing?.avg || [];
  const secs = avg.length;
  if (!secs || !avg.some((v) => Number.isFinite(v))) return '';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const padL = 44;
  const padR = 10;
  const padT = title ? 24 : 12;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, width, height);

  const vals = avg.filter((v) => Number.isFinite(v));
  const maxY = Math.max(...vals) * 1.15 || 1;
  const xAt = (i) => padL + (i / (secs - 1)) * plotW;
  const yAt = (v) => padT + plotH - (v / maxY) * plotH;

  // Axes and gridlines.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (const frac of [0, 0.5, 1]) {
    const v = maxY * frac;
    const y = yAt(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6, y + 3);
  }
  for (let s = 0; s < secs; s += 5) {
    ctx.fillText(`${s}s`, xAt(s) - 6, height - 8);
  }

  // Kill / death markers under the plot: green their kills, red their deaths.
  for (let s = 0; s < secs; s++) {
    const k = spacing.kills?.[s] || 0;
    const dth = spacing.deaths?.[s] || 0;
    if (k) {
      ctx.fillStyle = 'rgba(88, 214, 141, 0.9)';
      ctx.fillRect(xAt(s) - 1.5, padT + plotH + 3, 3, Math.min(9, 3 + k * 2));
    }
    if (dth) {
      ctx.fillStyle = 'rgba(231, 76, 60, 0.9)';
      ctx.fillRect(xAt(s) + 2, padT + plotH + 3, 3, Math.min(9, 3 + dth * 2));
    }
  }

  // The spacing line.
  ctx.strokeStyle = '#e8b84a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (let s = 0; s < secs; s++) {
    const v = avg[s];
    if (!Number.isFinite(v)) continue;
    const x = xAt(s);
    const y = yAt(v);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  if (title) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(title, padL, 15);
  }
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}
