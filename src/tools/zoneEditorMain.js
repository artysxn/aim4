// ---------------------------------------------------------------------------
// tools/zoneEditorMain.js — Zone Editor page
// Draw named squares on a CS2 radar; persist world-space zones for possession.
// ---------------------------------------------------------------------------

import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import { RADAR_SIZE, radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { loadRadar } from '../replays/viewer/radarRenderer.js';
import { pieceToRing, subtractRectFromPieces } from '../replays/zones/zoneGeom.js';
import {
  addRectToNetwork,
  carveRectFromOthers,
  colorForName,
  deleteZone,
  emptyNetwork,
  overlappingZones,
  renameZone,
  worldRectFromRadarDrag
} from '../replays/zones/zoneModel.js';
import { fetchZones, saveZones } from '../replays/zones/zoneApi.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const MIN_DRAW_PX = 8;

const el = {
  mapTabs: document.querySelector('#ze-maps'),
  canvas: document.querySelector('#ze-canvas'),
  list: document.querySelector('#ze-list'),
  nameInput: document.querySelector('#ze-name'),
  zoomLabel: document.querySelector('#ze-zoom'),
  status: document.querySelector('#ze-status'),
  modal: document.querySelector('#ze-overlap'),
  modalBody: document.querySelector('#ze-overlap-body'),
  btnDiscard: document.querySelector('#ze-discard'),
  btnSave: document.querySelector('#ze-save'),
  btnZoomIn: document.querySelector('#ze-zoom-in'),
  btnZoomOut: document.querySelector('#ze-zoom-out'),
  btnReset: document.querySelector('#ze-reset')
};

let mapCode = MAP_CODES.includes('INF') ? 'INF' : MAP_CODES[0];
let network = emptyNetwork(mapCode);
let savedSnapshot = '[]';
let radarImg = null;
let zoom = 1;
let panX = 0;
let panY = 0;
let dpr = 1;
let dirty = false;
let drawing = null;
let panning = false;
let lastPan = null;
let selectedId = null;
/** @type {null | { worldRect: object, name: string, hits: Array }} */
let pendingDraw = null;

function snapshotOf(net) {
  return JSON.stringify(net.zones || []);
}

function setStatus(msg, kind = '') {
  if (!el.status) return;
  el.status.textContent = msg || '';
  el.status.dataset.kind = kind;
}

function markDirty(on = true) {
  dirty = on;
  el.btnSave?.classList.toggle('is-dirty', on);
}

function viewTransform(w, h) {
  const fit = Math.min(w, h) / RADAR_SIZE;
  const scale = fit * zoom;
  const ox = (w - RADAR_SIZE * scale) / 2 + panX * dpr;
  const oy = (h - RADAR_SIZE * scale) / 2 + panY * dpr;
  return { scale, ox, oy };
}

function radarFromClient(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const w = el.canvas.width;
  const h = el.canvas.height;
  const { scale, ox, oy } = viewTransform(w, h);
  const cx = ((clientX - rect.left) / rect.width) * w;
  const cy = ((clientY - rect.top) / rect.height) * h;
  return { x: (cx - ox) / scale, y: (cy - oy) / scale };
}

function hexAlpha(hex, a) {
  const h = String(hex || '#888').replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return `rgba(120,120,120,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function resize() {
  const wrap = el.canvas.parentElement;
  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  el.canvas.width = Math.max(1, Math.round(cssW * dpr));
  el.canvas.height = Math.max(1, Math.round(cssH * dpr));
  el.canvas.style.width = `${cssW}px`;
  el.canvas.style.height = `${cssH}px`;
  draw();
}

function draw() {
  const ctx = el.canvas.getContext('2d');
  const w = el.canvas.width;
  const h = el.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, w, h);

  const t = viewTransform(w, h);
  ctx.save();
  ctx.translate(t.ox, t.oy);
  ctx.scale(t.scale, t.scale);

  if (radarImg) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(radarImg, 0, 0, RADAR_SIZE, RADAR_SIZE);
  } else {
    ctx.fillStyle = '#151820';
    ctx.fillRect(0, 0, RADAR_SIZE, RADAR_SIZE);
  }

  for (const z of network.zones) {
    if (z.hidden) continue;
    const color = z.color || colorForName(z.name);
    const selected = z.id === selectedId;
    for (const piece of z.pieces || []) {
      const ring = pieceToRing(piece);
      if (ring.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const rp = worldToRadar(mapCode, ring[i][0], ring[i][1], {});
        if (i === 0) ctx.moveTo(rp.x, rp.y);
        else ctx.lineTo(rp.x, rp.y);
      }
      ctx.closePath();
      ctx.fillStyle = hexAlpha(color, selected ? 0.42 : 0.28);
      ctx.fill();
      ctx.strokeStyle = selected ? '#ffffff' : color;
      ctx.lineWidth = (selected ? 2.2 : 1.4) / t.scale;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      for (const [wx, wy] of ring) {
        const rp = worldToRadar(mapCode, wx, wy, {});
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, 3.2 / t.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const first = z.pieces?.[0];
    if (first) {
      const ring = pieceToRing(first);
      let sx = 0;
      let sy = 0;
      for (const [wx, wy] of ring) {
        const rp = worldToRadar(mapCode, wx, wy, {});
        sx += rp.x;
        sy += rp.y;
      }
      sx /= ring.length;
      sy /= ring.length;
      ctx.font = `${12 / t.scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(z.name, sx + 0.8 / t.scale, sy + 0.8 / t.scale);
      ctx.fillStyle = '#f2f2f2';
      ctx.fillText(z.name, sx, sy);
    }
  }

  if (drawing) {
    const x0 = Math.min(drawing.r0.x, drawing.r1.x);
    const y0 = Math.min(drawing.r0.y, drawing.r1.y);
    const rw = Math.abs(drawing.r1.x - drawing.r0.x);
    const rh = Math.abs(drawing.r1.y - drawing.r0.y);
    const previewName = el.nameInput?.value.trim() || 'Zone';
    const color = colorForName(previewName);
    ctx.fillStyle = hexAlpha(color, 0.25);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 / t.scale;
    ctx.fillRect(x0, y0, rw, rh);
    ctx.strokeRect(x0, y0, rw, rh);
  }

  ctx.restore();
  if (el.zoomLabel) el.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function renderMapTabs() {
  el.mapTabs.innerHTML = MAP_CODES.map(
    (code) =>
      `<button type="button" class="ze-map-tab${code === mapCode ? ' active' : ''}" data-map="${code}">${
        MAPS[code]?.name || code
      }</button>`
  ).join('');
}

function renderList() {
  if (!network.zones.length) {
    el.list.innerHTML =
      '<p class="ze-empty">No zones yet. Drag on the radar to draw a square.</p>';
    return;
  }
  el.list.innerHTML = network.zones
    .map((z) => {
      const selected = z.id === selectedId ? ' selected' : '';
      return `<div class="ze-row${selected}${z.hidden ? ' is-hidden' : ''}" data-id="${z.id}">
        <span class="ze-swatch" style="background:${z.color || colorForName(z.name)}"></span>
        <input class="ze-row-name" type="text" maxlength="48" value="${escapeAttr(z.name)}" />
        <button type="button" class="ze-icon-btn" data-act="vis" title="Toggle visibility">${
          z.hidden ? '○' : '◉'
        }</button>
        <button type="button" class="ze-icon-btn" data-act="del" title="Delete">✕</button>
      </div>`;
    })
    .join('');
}

async function loadMap(code) {
  if (dirty && !confirm('Discard unsaved changes on this map?')) return;
  mapCode = code;
  renderMapTabs();
  setStatus('Loading…');
  try {
    radarImg = await loadRadar(mapCode);
  } catch {
    radarImg = null;
  }
  try {
    network = await fetchZones(mapCode);
  } catch (err) {
    network = emptyNetwork(mapCode);
    setStatus(err.message || 'Could not load zones', 'err');
  }
  savedSnapshot = snapshotOf(network);
  markDirty(false);
  selectedId = null;
  zoom = 1;
  panX = 0;
  panY = 0;
  renderList();
  draw();
  setStatus(`${MAPS[mapCode]?.name || mapCode} · ${network.zones.length} zones`);
}

function commitRect(worldRect, name) {
  if (worldRect.w < 8 || worldRect.h < 8) return;
  const label = String(name || '').trim() || 'Zone';
  const same = network.zones.find(
    (z) => z.name.trim().toLowerCase() === label.toLowerCase()
  );
  carveRectFromOthers(network, worldRect, same?.id || null);
  addRectToNetwork(network, label, worldRect);
  const z = network.zones.find(
    (x) => x.name.trim().toLowerCase() === label.toLowerCase()
  );
  selectedId = z?.id || null;
  markDirty(true);
  renderList();
  draw();
}

/** Existing zones keep the overlap: add only the non-overlapping remainder. */
function commitRectAvoiding(worldRect, name, hits) {
  let pieces = [{ ...worldRect, type: 'rect' }];
  for (const { zone } of hits) {
    for (const p of zone.pieces || []) {
      if (p.type === 'rect') pieces = subtractRectFromPieces(pieces, p);
    }
  }
  for (const p of pieces) {
    if (p.type === 'rect' && p.w >= 8 && p.h >= 8) addRectToNetwork(network, name, p);
  }
  const z = network.zones.find(
    (x) => x.name.trim().toLowerCase() === String(name).trim().toLowerCase()
  );
  selectedId = z?.id || null;
  markDirty(true);
  renderList();
  draw();
}

function tryFinishDraw() {
  if (!drawing) return;
  const { r0, r1 } = drawing;
  drawing = null;
  if (Math.abs(r1.x - r0.x) < MIN_DRAW_PX || Math.abs(r1.y - r0.y) < MIN_DRAW_PX) {
    draw();
    return;
  }
  const worldRect = worldRectFromRadarDrag(
    mapCode,
    radarToWorld,
    r0.x,
    r0.y,
    r1.x,
    r1.y
  );
  const name = el.nameInput?.value.trim() || 'Zone';
  const hits = overlappingZones(network, worldRect, { ignoreSameName: name });
  if (!hits.length) {
    commitRect(worldRect, name);
    return;
  }
  pendingDraw = { worldRect, name, hits };
  const other = hits[0].zone;
  el.modalBody.innerHTML = `
    <p>New square <strong>${escapeAttr(name)}</strong> overlaps
    <strong>${escapeAttr(other.name)}</strong>.</p>
    <p class="ze-modal-hint">Choose which zone keeps the overlapping area. The other is carved out.</p>
    <div class="ze-modal-actions">
      <button type="button" class="btn primary" data-keep="new">${escapeAttr(name)} keeps it</button>
      <button type="button" class="btn" data-keep="old">${escapeAttr(other.name)} keeps it</button>
      <button type="button" class="btn" data-keep="cancel">Cancel</button>
    </div>`;
  el.modal.hidden = false;
  draw();
}

function hideOverlapModal() {
  el.modal.hidden = true;
  pendingDraw = null;
}

el.modal?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-keep]');
  if (!btn || !pendingDraw) return;
  const choice = btn.dataset.keep;
  const { worldRect, name, hits } = pendingDraw;
  hideOverlapModal();
  if (choice === 'cancel') {
    draw();
    return;
  }
  if (choice === 'old') commitRectAvoiding(worldRect, name, hits);
  else commitRect(worldRect, name);
});

el.mapTabs?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-map]');
  if (btn) loadMap(btn.dataset.map);
});

el.list?.addEventListener('click', (e) => {
  const row = e.target.closest('.ze-row');
  if (!row) return;
  const id = row.dataset.id;
  const zone = network.zones.find((z) => z.id === id);
  if (!zone) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'del') {
    deleteZone(network, id);
    if (selectedId === id) selectedId = null;
    markDirty(true);
    renderList();
    draw();
    return;
  }
  if (act === 'vis') {
    zone.hidden = !zone.hidden;
    markDirty(true);
    renderList();
    draw();
    return;
  }
  selectedId = id;
  el.nameInput.value = zone.name;
  renderList();
  draw();
});

el.list?.addEventListener('change', (e) => {
  const input = e.target.closest('.ze-row-name');
  if (!input) return;
  const row = input.closest('.ze-row');
  if (!row) return;
  renameZone(network, row.dataset.id, input.value);
  markDirty(true);
  renderList();
  draw();
});

el.canvas.addEventListener('pointerdown', (e) => {
  if (pendingDraw) return;
  if (e.button === 1 || e.button === 2 || e.shiftKey || e.altKey) {
    panning = true;
    lastPan = { x: e.clientX, y: e.clientY };
    el.canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const r = radarFromClient(e.clientX, e.clientY);
  drawing = { r0: r, r1: { ...r } };
  el.canvas.setPointerCapture(e.pointerId);
});

el.canvas.addEventListener('pointermove', (e) => {
  if (panning && lastPan) {
    panX += e.clientX - lastPan.x;
    panY += e.clientY - lastPan.y;
    lastPan = { x: e.clientX, y: e.clientY };
    draw();
    return;
  }
  if (!drawing) return;
  drawing.r1 = radarFromClient(e.clientX, e.clientY);
  draw();
});

el.canvas.addEventListener('pointerup', (e) => {
  if (panning) {
    panning = false;
    lastPan = null;
    return;
  }
  if (drawing) tryFinishDraw();
});

el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

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
  } catch {
    network = emptyNetwork(mapCode);
  }
  savedSnapshot = snapshotOf(network);
  markDirty(false);
  selectedId = null;
  renderList();
  draw();
  setStatus('Discarded');
});

el.btnSave?.addEventListener('click', async () => {
  setStatus('Saving…');
  try {
    network = await saveZones(mapCode, network);
    savedSnapshot = snapshotOf(network);
    markDirty(false);
    setStatus('Saved', 'ok');
    renderList();
  } catch (err) {
    setStatus(err.message || 'Save failed', 'err');
  }
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
