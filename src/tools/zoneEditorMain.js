// ---------------------------------------------------------------------------
// tools/zoneEditorMain.js — Sites & Vision editor
// Bombsite A/B rectangles + vision-block / elevated paint only.
// ---------------------------------------------------------------------------

import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import { RADAR_SIZE, radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { loadRadar } from '../replays/viewer/radarRenderer.js';
import { emptyNetwork, worldRectFromRadarDrag } from '../replays/zones/zoneModel.js';
import { fetchZones, saveZones } from '../replays/zones/zoneApi.js';
import {
  DEFAULT_BRUSH_PX,
  MAX_BRUSH_PX,
  MIN_BRUSH_PX,
  bumpLayerPaintGen,
  ensureVisionLayers,
  strokeBrush
} from '../replays/zones/visionLayers.js';
import { ensureBombSites } from '../replays/zones/bombSites.js';
import {
  KEY_ZONES_MAX,
  addKeyZone,
  clearKeyZones,
  ensureKeyZones
} from '../replays/zones/keyZones.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const MIN_DRAW_PX = 8;
const UNDO_MAX = 40;
const VISION_COLOR = '#9b6cff';
const ELEVATED_COLOR = '#e8a03c';
const BOMB_A_COLOR = '#e8c040';
const BOMB_B_COLOR = '#4aa3ff';
const KEY_A_COLOR = '#c9a227';
const KEY_B_COLOR = '#3d7ab8';

const el = {
  mapTabs: document.querySelector('#ze-maps'),
  canvas: document.querySelector('#ze-canvas'),
  zoomLabel: document.querySelector('#ze-zoom'),
  brushSizeLabel: document.querySelector('#ze-brush-size'),
  brushRing: document.querySelector('#ze-brush-ring'),
  layerCounts: document.querySelector('#ze-layer-counts'),
  bombAStatus: document.querySelector('#ze-bomb-a-status'),
  bombBStatus: document.querySelector('#ze-bomb-b-status'),
  keyAStatus: document.querySelector('#ze-key-a-status'),
  keyBStatus: document.querySelector('#ze-key-b-status'),
  status: document.querySelector('#ze-status'),
  btnDiscard: document.querySelector('#ze-discard'),
  btnSave: document.querySelector('#ze-save'),
  btnZoomIn: document.querySelector('#ze-zoom-in'),
  btnZoomOut: document.querySelector('#ze-zoom-out'),
  btnReset: document.querySelector('#ze-reset'),
  toolBombA: document.querySelector('#ze-tool-bomb-a'),
  toolBombB: document.querySelector('#ze-tool-bomb-b'),
  toolKeyA: document.querySelector('#ze-tool-key-a'),
  toolKeyB: document.querySelector('#ze-tool-key-b'),
  toolVision: document.querySelector('#ze-tool-vision'),
  toolElevated: document.querySelector('#ze-tool-elevated'),
  toolErase: document.querySelector('#ze-tool-erase'),
  btnBrushDown: document.querySelector('#ze-brush-down'),
  btnBrushUp: document.querySelector('#ze-brush-up'),
  btnClearVision: document.querySelector('#ze-clear-vision'),
  btnClearElevated: document.querySelector('#ze-clear-elevated'),
  btnClearBombA: document.querySelector('#ze-clear-bomb-a'),
  btnClearBombB: document.querySelector('#ze-clear-bomb-b'),
  btnClearKeyA: document.querySelector('#ze-clear-key-a'),
  btnClearKeyB: document.querySelector('#ze-clear-key-b')
};

let mapCode = MAP_CODES.includes('INF') ? 'INF' : MAP_CODES[0];
let network = emptyNetwork(mapCode);
ensureVisionLayers(network);
ensureBombSites(network);
ensureKeyZones(network);
let savedSnapshot = '';
/** @type {Array<object>} */
let undoStack = [];
let radarImg = null;
let zoom = 1;
let panX = 0;
let panY = 0;
let dpr = 1;
let dirty = false;
let drawing = null;
let panning = false;
let lastPan = null;
/** @type {'bombA'|'bombB'|'keyA'|'keyB'|'visionBlock'|'elevated'|'erase'} */
let paintTool = 'bombA';
let eraseTarget = 'visionBlock';
let brushPx = DEFAULT_BRUSH_PX;
/** @type {null | { last: {x:number,y:number}, layer: 'visionBlock'|'elevated', erase: boolean }} */
let brushing = null;

function snapshotOf(net) {
  ensureBombSites(net);
  ensureVisionLayers(net);
  ensureKeyZones(net);
  return JSON.stringify({
    visionBlocks: net.visionBlocks || [],
    elevated: net.elevated || [],
    bombSites: net.bombSites || { a: null, b: null },
    keyZones: net.keyZones || { a: [], b: [] }
  });
}

function cloneNetworkState() {
  return JSON.parse(snapshotOf(network));
}

function isBrushTool(tool = paintTool) {
  return tool === 'visionBlock' || tool === 'elevated' || tool === 'erase';
}

function isBombTool(tool = paintTool) {
  return tool === 'bombA' || tool === 'bombB';
}

function isKeyTool(tool = paintTool) {
  return tool === 'keyA' || tool === 'keyB';
}

function isRectTool(tool = paintTool) {
  return isBombTool(tool) || isKeyTool(tool);
}

function bombSiteForTool(tool = paintTool) {
  if (tool === 'bombA') return 'a';
  if (tool === 'bombB') return 'b';
  return null;
}

function keySiteForTool(tool = paintTool) {
  if (tool === 'keyA') return 'a';
  if (tool === 'keyB') return 'b';
  return null;
}

function pushUndo() {
  undoStack.push(cloneNetworkState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function clearUndo() {
  undoStack = [];
}

function markDirty(on) {
  dirty = Boolean(on);
}

function setStatus(msg, kind = '') {
  if (!el.status) return;
  el.status.textContent = msg || '';
  el.status.dataset.kind = kind;
}

function hexAlpha(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function viewTransform(w, h) {
  const base = Math.min(w, h) / RADAR_SIZE;
  const scale = base * zoom;
  const ox = (w - RADAR_SIZE * scale) / 2 + panX;
  const oy = (h - RADAR_SIZE * scale) / 2 + panY;
  return { scale, ox, oy };
}

function radarFromClient(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const cssX = ((clientX - rect.left) / rect.width) * el.canvas.width;
  const cssY = ((clientY - rect.top) / rect.height) * el.canvas.height;
  const t = viewTransform(el.canvas.width, el.canvas.height);
  return { x: (cssX - t.ox) / t.scale, y: (cssY - t.oy) / t.scale };
}

function undoLast() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  network.visionBlocks = prev.visionBlocks || [];
  network.elevated = prev.elevated || [];
  network.bombSites = prev.bombSites || { a: null, b: null };
  network.keyZones = prev.keyZones || { a: [], b: [] };
  ensureVisionLayers(network);
  ensureBombSites(network);
  ensureKeyZones(network);
  bumpLayerPaintGen(network);
  markDirty(snapshotOf(network) !== savedSnapshot);
  syncUi();
  draw();
  setStatus('Undid');
}

function syncUi() {
  ensureVisionLayers(network);
  ensureBombSites(network);
  if (el.layerCounts) {
    const vb = network.visionBlocks.length;
    const elv = network.elevated.length;
    el.layerCounts.textContent = `${vb} vision · ${elv} elevated stamp${elv === 1 ? '' : 's'}`;
  }
  if (el.bombAStatus) el.bombAStatus.textContent = network.bombSites.a ? 'Set' : '—';
  if (el.bombBStatus) el.bombBStatus.textContent = network.bombSites.b ? 'Set' : '—';
  if (el.keyAStatus) {
    el.keyAStatus.textContent = `${network.keyZones?.a?.length || 0}/${KEY_ZONES_MAX}`;
  }
  if (el.keyBStatus) {
    el.keyBStatus.textContent = `${network.keyZones?.b?.length || 0}/${KEY_ZONES_MAX}`;
  }

  const isBrush = isBrushTool();
  el.toolBombA?.classList.toggle('active', paintTool === 'bombA');
  el.toolBombA?.classList.toggle('bomb-a', paintTool === 'bombA');
  el.toolBombB?.classList.toggle('active', paintTool === 'bombB');
  el.toolBombB?.classList.toggle('bomb-b', paintTool === 'bombB');
  el.toolKeyA?.classList.toggle('active', paintTool === 'keyA');
  el.toolKeyA?.classList.toggle('key-a', paintTool === 'keyA');
  el.toolKeyB?.classList.toggle('active', paintTool === 'keyB');
  el.toolKeyB?.classList.toggle('key-b', paintTool === 'keyB');
  el.toolVision?.classList.toggle('active', paintTool === 'visionBlock');
  el.toolVision?.classList.toggle('vision', paintTool === 'visionBlock');
  el.toolElevated?.classList.toggle('active', paintTool === 'elevated');
  el.toolElevated?.classList.toggle('elevated', paintTool === 'elevated');
  el.toolErase?.classList.toggle('active', paintTool === 'erase');
  el.canvas?.classList.toggle('ze-brush-cursor', isBrush);
  if (el.brushSizeLabel) el.brushSizeLabel.textContent = String(brushPx);
  if (!isBrush) hideBrushRing();
}

function setPaintTool(tool) {
  if (tool === 'visionBlock' || tool === 'elevated') eraseTarget = tool;
  paintTool = tool;
  brushing = null;
  drawing = null;
  syncUi();
  draw();
}

function hideBrushRing() {
  if (!el.brushRing) return;
  el.brushRing.classList.remove('on', 'vision', 'elevated', 'erase');
  el.brushRing.hidden = true;
}

function updateBrushRing(clientX, clientY) {
  if (!el.brushRing || !isBrushTool()) {
    hideBrushRing();
    return;
  }
  const stage = el.canvas.parentElement;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const t = viewTransform(el.canvas.width, el.canvas.height);
  const cssScale = (rect.width / el.canvas.width) * t.scale;
  const diam = Math.max(4, brushPx * cssScale);
  el.brushRing.hidden = false;
  el.brushRing.classList.add('on');
  el.brushRing.classList.toggle('vision', paintTool === 'visionBlock');
  el.brushRing.classList.toggle('elevated', paintTool === 'elevated');
  el.brushRing.classList.toggle('erase', paintTool === 'erase');
  el.brushRing.style.left = `${clientX - rect.left}px`;
  el.brushRing.style.top = `${clientY - rect.top}px`;
  el.brushRing.style.width = `${diam}px`;
  el.brushRing.style.height = `${diam}px`;
}

function activeBrushLayer() {
  if (paintTool === 'visionBlock') return 'visionBlock';
  if (paintTool === 'elevated') return 'elevated';
  if (paintTool === 'erase') return eraseTarget;
  return null;
}

function resize() {
  if (!el.canvas) return;
  dpr = window.devicePixelRatio || 1;
  const rect = el.canvas.getBoundingClientRect();
  el.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  el.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  draw();
}

function draw() {
  if (!el.canvas) return;
  const ctx = el.canvas.getContext('2d');
  const w = el.canvas.width;
  const h = el.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const t = viewTransform(w, h);
  ctx.setTransform(t.scale, 0, 0, t.scale, t.ox, t.oy);

  if (radarImg) ctx.drawImage(radarImg, 0, 0, RADAR_SIZE, RADAR_SIZE);
  else {
    ctx.fillStyle = '#12151a';
    ctx.fillRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  }

  ensureVisionLayers(network);
  const drawLayer = (pieces, color, alpha) => {
    if (!pieces?.length) return;
    ctx.fillStyle = hexAlpha(color, alpha);
    for (const piece of pieces) {
      if (piece.type === 'rect' || (piece.w > 0 && piece.h > 0 && !piece.ring)) {
        const a = worldToRadar(mapCode, piece.x, piece.y, {});
        const b = worldToRadar(mapCode, piece.x + piece.w, piece.y + piece.h, {});
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (piece.ring?.length >= 3) {
        ctx.beginPath();
        for (let i = 0; i < piece.ring.length; i++) {
          const rp = worldToRadar(mapCode, piece.ring[i][0], piece.ring[i][1], {});
          if (i === 0) ctx.moveTo(rp.x, rp.y);
          else ctx.lineTo(rp.x, rp.y);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  };
  drawLayer(network.visionBlocks, VISION_COLOR, 0.45);
  drawLayer(network.elevated, ELEVATED_COLOR, 0.4);

  ensureBombSites(network);
  const drawBomb = (rect, color, label) => {
    if (!rect) return;
    const a = worldToRadar(mapCode, rect.x, rect.y, {});
    const b = worldToRadar(mapCode, rect.x + rect.w, rect.y + rect.h, {});
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const rw = Math.abs(b.x - a.x);
    const rh = Math.abs(b.y - a.y);
    ctx.fillStyle = hexAlpha(color, 0.22);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / t.scale;
    ctx.setLineDash([6 / t.scale, 4 / t.scale]);
    ctx.fillRect(x, y, rw, rh);
    ctx.strokeRect(x, y, rw, rh);
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(11, 13 / t.scale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + rw / 2, y + rh / 2);
  };
  drawBomb(network.bombSites.a, BOMB_A_COLOR, 'A');
  drawBomb(network.bombSites.b, BOMB_B_COLOR, 'B');

  ensureKeyZones(network);
  const drawKeyList = (list, color, prefix) => {
    (list || []).forEach((rect, i) => {
      if (!rect) return;
      const a = worldToRadar(mapCode, rect.x, rect.y, {});
      const b = worldToRadar(mapCode, rect.x + rect.w, rect.y + rect.h, {});
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x);
      const rh = Math.abs(b.y - a.y);
      ctx.fillStyle = hexAlpha(color, 0.18);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 / t.scale;
      ctx.setLineDash([4 / t.scale, 3 / t.scale]);
      ctx.fillRect(x, y, rw, rh);
      ctx.strokeRect(x, y, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `600 ${Math.max(10, 11 / t.scale)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${prefix}${i + 1}`, x + rw / 2, y + rh / 2);
    });
  };
  drawKeyList(network.keyZones.a, KEY_A_COLOR, 'A');
  drawKeyList(network.keyZones.b, KEY_B_COLOR, 'B');

  if (drawing && isRectTool()) {
    const x0 = Math.min(drawing.r0.x, drawing.r1.x);
    const y0 = Math.min(drawing.r0.y, drawing.r1.y);
    const rw = Math.abs(drawing.r1.x - drawing.r0.x);
    const rh = Math.abs(drawing.r1.y - drawing.r0.y);
    const color =
      paintTool === 'bombA'
        ? BOMB_A_COLOR
        : paintTool === 'bombB'
          ? BOMB_B_COLOR
          : paintTool === 'keyA'
            ? KEY_A_COLOR
            : KEY_B_COLOR;
    ctx.fillStyle = hexAlpha(color, 0.25);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 / t.scale;
    ctx.setLineDash([6 / t.scale, 4 / t.scale]);
    ctx.fillRect(x0, y0, rw, rh);
    ctx.strokeRect(x0, y0, rw, rh);
    ctx.setLineDash([]);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (el.zoomLabel) el.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function renderMapTabs() {
  if (!el.mapTabs) return;
  el.mapTabs.innerHTML = MAP_CODES.map((code) => {
    const name = MAPS[code]?.name || code;
    return `<button type="button" class="ze-map-tab${code === mapCode ? ' active' : ''}" data-map="${code}">${name}</button>`;
  }).join('');
}

async function loadMap(code) {
  if (dirty && !confirm('Discard unsaved changes on this map?')) return;
  mapCode = code;
  renderMapTabs();
  setStatus('');
  try {
    radarImg = await loadRadar(mapCode);
  } catch {
    radarImg = null;
  }
  try {
    network = await fetchZones(mapCode);
    ensureVisionLayers(network);
    ensureBombSites(network);
    ensureKeyZones(network);
  } catch (err) {
    network = emptyNetwork(mapCode);
    ensureVisionLayers(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    setStatus(err.message || 'Could not load', 'err');
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  zoom = 1;
  panX = 0;
  panY = 0;
  syncUi();
  draw();
}

function commitBombSite(site, worldRect) {
  if (worldRect.w < 8 || worldRect.h < 8) return;
  pushUndo();
  ensureBombSites(network);
  network.bombSites[site] = {
    type: 'rect',
    x: worldRect.x,
    y: worldRect.y,
    w: worldRect.w,
    h: worldRect.h
  };
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Bomb site ${site.toUpperCase()} set`);
}

function clearBombSite(site) {
  ensureBombSites(network);
  if (!network.bombSites[site]) return;
  if (!confirm(`Clear bomb site ${site.toUpperCase()}?`)) return;
  pushUndo();
  network.bombSites[site] = null;
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Cleared bomb site ${site.toUpperCase()}`);
}

function commitKeyZone(site, worldRect) {
  if (worldRect.w < 8 || worldRect.h < 8) return;
  ensureKeyZones(network);
  const list = site === 'b' ? network.keyZones.b : network.keyZones.a;
  if (list.length >= KEY_ZONES_MAX) {
    setStatus(`Key ${site.toUpperCase()} already has ${KEY_ZONES_MAX} zones`, 'err');
    draw();
    return;
  }
  pushUndo();
  addKeyZone(network, site, {
    type: 'rect',
    x: worldRect.x,
    y: worldRect.y,
    w: worldRect.w,
    h: worldRect.h
  });
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Key ${site.toUpperCase()} #${list.length} added`);
}

function clearKeySite(site) {
  ensureKeyZones(network);
  const list = site === 'b' ? network.keyZones.b : network.keyZones.a;
  if (!list.length) return;
  if (!confirm(`Clear all key zones for ${site.toUpperCase()}?`)) return;
  pushUndo();
  clearKeyZones(network, site);
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Cleared key ${site.toUpperCase()}`);
}

function tryFinishDraw() {
  if (!drawing) return;
  const { r0, r1 } = drawing;
  drawing = null;
  const dx = Math.abs(r1.x - r0.x);
  const dy = Math.abs(r1.y - r0.y);
  if (dx < MIN_DRAW_PX || dy < MIN_DRAW_PX) {
    draw();
    return;
  }
  const worldRect = worldRectFromRadarDrag(mapCode, radarToWorld, r0.x, r0.y, r1.x, r1.y);
  const bombSite = bombSiteForTool();
  if (bombSite) {
    commitBombSite(bombSite, worldRect);
    return;
  }
  const keySite = keySiteForTool();
  if (keySite) {
    commitKeyZone(keySite, worldRect);
    return;
  }
  draw();
}

function applyBrushAt(from, to, layer, erase) {
  ensureVisionLayers(network);
  const pieces = layer === 'elevated' ? network.elevated : network.visionBlocks;
  const n = strokeBrush(pieces, mapCode, from, to, brushPx, { erase });
  if (n > 0) {
    bumpLayerPaintGen(network);
    markDirty(true);
    syncUi();
    draw();
  }
}

el.mapTabs?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-map]');
  if (btn) loadMap(btn.dataset.map);
});

el.canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || e.button === 2 || e.altKey) {
    panning = true;
    lastPan = { x: e.clientX, y: e.clientY };
    el.canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const r = radarFromClient(e.clientX, e.clientY);
  if (isBrushTool()) {
    const layer = activeBrushLayer() || 'visionBlock';
    pushUndo();
    const erase = paintTool === 'erase';
    brushing = { last: { ...r }, layer, erase };
    applyBrushAt(r, r, layer, erase);
    el.canvas.setPointerCapture(e.pointerId);
    updateBrushRing(e.clientX, e.clientY);
    return;
  }
  if (!isRectTool()) return;
  drawing = { r0: r, r1: { ...r } };
  el.canvas.setPointerCapture(e.pointerId);
});

el.canvas.addEventListener('pointermove', (e) => {
  if (isBrushTool()) updateBrushRing(e.clientX, e.clientY);
  if (panning && lastPan) {
    panX += e.clientX - lastPan.x;
    panY += e.clientY - lastPan.y;
    lastPan = { x: e.clientX, y: e.clientY };
    draw();
    return;
  }
  if (brushing) {
    const r = radarFromClient(e.clientX, e.clientY);
    applyBrushAt(r, brushing.last, brushing.layer, brushing.erase);
    brushing.last = r;
    return;
  }
  if (!drawing) return;
  drawing.r1 = radarFromClient(e.clientX, e.clientY);
  draw();
});

el.canvas.addEventListener('pointerup', () => {
  if (panning) {
    panning = false;
    lastPan = null;
    return;
  }
  if (brushing) {
    brushing = null;
    setStatus(
      paintTool === 'erase'
        ? 'Erased vision paint'
        : paintTool === 'elevated'
          ? 'Painted elevated'
          : 'Painted vision block'
    );
    return;
  }
  if (drawing) tryFinishDraw();
});

el.canvas.addEventListener('pointerleave', () => {
  if (!brushing) hideBrushRing();
});
el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

el.toolBombA?.addEventListener('click', () => setPaintTool('bombA'));
el.toolBombB?.addEventListener('click', () => setPaintTool('bombB'));
el.toolKeyA?.addEventListener('click', () => setPaintTool('keyA'));
el.toolKeyB?.addEventListener('click', () => setPaintTool('keyB'));
el.toolVision?.addEventListener('click', () => setPaintTool('visionBlock'));
el.toolElevated?.addEventListener('click', () => setPaintTool('elevated'));
el.toolErase?.addEventListener('click', () => setPaintTool('erase'));
el.btnClearBombA?.addEventListener('click', () => clearBombSite('a'));
el.btnClearBombB?.addEventListener('click', () => clearBombSite('b'));
el.btnClearKeyA?.addEventListener('click', () => clearKeySite('a'));
el.btnClearKeyB?.addEventListener('click', () => clearKeySite('b'));

el.btnBrushDown?.addEventListener('click', () => {
  brushPx = Math.max(MIN_BRUSH_PX, brushPx - 1);
  syncUi();
});
el.btnBrushUp?.addEventListener('click', () => {
  brushPx = Math.min(MAX_BRUSH_PX, brushPx + 1);
  syncUi();
});

el.btnClearVision?.addEventListener('click', () => {
  ensureVisionLayers(network);
  if (!network.visionBlocks.length) return;
  if (!confirm('Clear all vision block paint?')) return;
  pushUndo();
  network.visionBlocks = [];
  bumpLayerPaintGen(network);
  markDirty(true);
  syncUi();
  draw();
  setStatus('Cleared vision blocks');
});

el.btnClearElevated?.addEventListener('click', () => {
  ensureVisionLayers(network);
  if (!network.elevated.length) return;
  if (!confirm('Clear all elevated paint?')) return;
  pushUndo();
  network.elevated = [];
  bumpLayerPaintGen(network);
  markDirty(true);
  syncUi();
  draw();
  setStatus('Cleared elevated');
});

el.canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    if (zoom <= MIN_ZOOM) {
      panX = 0;
      panY = 0;
    }
    draw();
  },
  { passive: false }
);

el.btnZoomIn?.addEventListener('click', () => {
  zoom = Math.min(MAX_ZOOM, zoom * 1.2);
  draw();
});
el.btnZoomOut?.addEventListener('click', () => {
  zoom = Math.max(MIN_ZOOM, zoom / 1.2);
  if (zoom <= MIN_ZOOM) {
    panX = 0;
    panY = 0;
  }
  draw();
});
el.btnReset?.addEventListener('click', () => {
  zoom = 1;
  panX = 0;
  panY = 0;
  draw();
});

el.btnDiscard?.addEventListener('click', async () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  try {
    network = await fetchZones(mapCode);
    ensureVisionLayers(network);
    ensureBombSites(network);
    ensureKeyZones(network);
  } catch {
    network = emptyNetwork(mapCode);
    ensureVisionLayers(network);
    ensureBombSites(network);
    ensureKeyZones(network);
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  syncUi();
  draw();
  setStatus('Discarded');
});

el.btnSave?.addEventListener('click', async () => {
  ensureVisionLayers(network);
  ensureBombSites(network);
  ensureKeyZones(network);
  setStatus('Saving…');
  try {
    network = await saveZones(mapCode, network);
    ensureVisionLayers(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    savedSnapshot = snapshotOf(network);
    markDirty(false);
    clearUndo();
    syncUi();
    draw();
    setStatus('Saved', 'ok');
  } catch (err) {
    setStatus(err.message || 'Save failed', 'err');
  }
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'z') return;
  if (e.target?.matches?.('input, textarea, select')) return;
  e.preventDefault();
  undoLast();
});

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

renderMapTabs();
resize();
loadMap(mapCode);
