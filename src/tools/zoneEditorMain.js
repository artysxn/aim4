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
  addSection,
  addZoneToSection,
  carveRectFromOthers,
  colorForName,
  deleteSection,
  deleteZone,
  displayColorForZone,
  emptyNetwork,
  overlappingZones,
  removeZoneFromSection,
  renameSection,
  renameZone,
  setSectionColor,
  setZoneColor,
  worldRectFromRadarDrag
} from '../replays/zones/zoneModel.js';
import { fetchZones, saveZones } from '../replays/zones/zoneApi.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const MIN_DRAW_PX = 8;
const UNDO_MAX = 40;

const el = {
  mapTabs: document.querySelector('#ze-maps'),
  canvas: document.querySelector('#ze-canvas'),
  list: document.querySelector('#ze-list'),
  sectionsList: document.querySelector('#ze-sections-list'),
  nameInput: document.querySelector('#ze-name'),
  sectionNameInput: document.querySelector('#ze-section-name'),
  btnSectionAdd: document.querySelector('#ze-section-add'),
  colorMode: document.querySelector('#ze-color-mode'),
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
/** @type {Array<{ zones: Array, sections: Array }>} */
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
/** Multi-select in Areas (Shift-click toggles). */
const selectedIds = new Set();
let selectedSectionId = null;
/** @type {null | { worldRect: object, name: string, hits: Array }} */
let pendingDraw = null;
/** Active HTML5 drag payload. */
let dragPayload = null;

const DRAG_MIME = 'application/x-aim4-zones';

function ensureSections() {
  if (!Array.isArray(network.sections)) network.sections = [];
  for (const s of network.sections) {
    if (!s.color) s.color = colorForName(s.name);
  }
}

function snapshotOf(net) {
  return JSON.stringify({
    zones: net.zones || [],
    sections: net.sections || [],
    colorMode: net.colorMode === 'section' ? 'section' : 'zone'
  });
}

function cloneNetworkState() {
  return JSON.parse(
    JSON.stringify({
      zones: network.zones || [],
      sections: network.sections || [],
      colorMode: network.colorMode === 'section' ? 'section' : 'zone'
    })
  );
}

function colorMode() {
  return network.colorMode === 'section' ? 'section' : 'zone';
}

function paintColor(zone) {
  return displayColorForZone(network, zone, { preferSectionId: selectedSectionId });
}

function toColorInputValue(hex) {
  const s = String(hex || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const a = s[1];
    const b = s[2];
    const c = s[3];
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  return '#5b9fd4';
}

function syncColorModeUi() {
  const mode = colorMode();
  el.colorMode?.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

/** Snapshot before a zone-creating edit so Ctrl+Z can reverse it. */
function pushCreateUndo() {
  undoStack.push(cloneNetworkState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function clearUndo() {
  undoStack = [];
}

function undoCreate() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  network.zones = prev.zones || [];
  network.sections = prev.sections || [];
  network.colorMode = prev.colorMode === 'section' ? 'section' : 'zone';
  pruneSelection();
  syncColorModeUi();
  if (selectedSectionId && !network.sections.some((s) => s.id === selectedSectionId)) {
    selectedSectionId = null;
  }
  markDirty(snapshotOf(network) !== savedSnapshot);
  renderList();
  renderSections();
  draw();
  setStatus('Undid zone');
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
    const color = paintColor(z);
    const selected = selectedIds.has(z.id);
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

function pruneSelection() {
  const alive = new Set(network.zones.map((z) => z.id));
  for (const id of [...selectedIds]) {
    if (!alive.has(id)) selectedIds.delete(id);
  }
}

function setSelection(ids, { primaryName = true } = {}) {
  selectedIds.clear();
  for (const id of ids) {
    if (network.zones.some((z) => z.id === id)) selectedIds.add(id);
  }
  if (primaryName && el.nameInput) {
    const first = network.zones.find((z) => selectedIds.has(z.id));
    if (first) el.nameInput.value = first.name;
  }
}

function syncListSelectionClasses() {
  el.list?.querySelectorAll('.ze-row').forEach((row) => {
    row.classList.toggle('selected', selectedIds.has(row.dataset.id));
  });
}

function renderList() {
  if (!network.zones.length) {
    el.list.innerHTML =
      '<p class="ze-empty">No zones yet. Drag on the radar to draw a square.</p>';
    return;
  }
  el.list.innerHTML = network.zones
    .map((z) => {
      const selected = selectedIds.has(z.id) ? ' selected' : '';
      const hex = toColorInputValue(paintColor(z));
      return `<div class="ze-row${selected}${z.hidden ? ' is-hidden' : ''}" data-id="${z.id}" draggable="true" title="Click to select · Shift-click to multi-select · Drag into a section">
        <label class="ze-swatch-wrap" title="Area color" draggable="false">
          <input type="color" class="ze-color" value="${hex}" data-act="color" draggable="false" ${
            colorMode() === 'section' ? 'disabled' : ''
          } />
        </label>
        <input class="ze-row-name" type="text" maxlength="48" value="${escapeAttr(z.name)}" draggable="false" />
        <button type="button" class="ze-icon-btn" data-act="vis" title="Toggle visibility" draggable="false">${
          z.hidden ? '○' : '◉'
        }</button>
        <button type="button" class="ze-icon-btn" data-act="del" title="Delete" draggable="false">✕</button>
      </div>`;
    })
    .join('');
}

function renderSections() {
  if (!el.sectionsList) return;
  ensureSections();
  if (!network.sections.length) {
    el.sectionsList.innerHTML =
      '<p class="ze-empty">Shift-select areas, name a section, then +. Drag areas in or out. Zones can belong to several sections.</p>';
    return;
  }
  const byId = new Map(network.zones.map((z) => [z.id, z]));
  const groupPaint = colorMode() === 'section';
  el.sectionsList.innerHTML = network.sections
    .map((s) => {
      const selected = s.id === selectedSectionId ? ' selected' : '';
      const secColor = toColorInputValue(s.color || colorForName(s.name));
      const members = (s.zoneIds || [])
        .map((id) => byId.get(id))
        .filter(Boolean);
      const memberHtml = `<ul class="ze-sec-members" data-section="${s.id}">${members
        .map((z) => {
          const swatch = groupPaint ? secColor : toColorInputValue(z.color || colorForName(z.name));
          return `<li draggable="true" data-zone="${z.id}" data-from-section="${s.id}" title="Drag out to remove, or into another section">
              <span class="ze-swatch" style="background:${swatch}"></span>
              <span>${escapeAttr(z.name)}</span>
            </li>`;
        })
        .join('')}</ul>`;
      return `<div class="ze-sec${selected}" data-section="${s.id}">
        <div class="ze-sec-top">
          <label class="ze-swatch-wrap" title="Section color" draggable="false">
            <input type="color" class="ze-color" value="${secColor}" data-sec-act="color" draggable="false" />
          </label>
          <input class="ze-row-name" type="text" maxlength="48" value="${escapeAttr(s.name)}" data-sec-act="rename" draggable="false" />
          <button type="button" class="ze-icon-btn" data-sec-act="del" title="Delete section" draggable="false">✕</button>
        </div>
        ${memberHtml}
      </div>`;
    })
    .join('');
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
    ensureSections();
    if (network.colorMode !== 'section') network.colorMode = 'zone';
  } catch (err) {
    network = emptyNetwork(mapCode);
    setStatus(err.message || 'Could not load zones', 'err');
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  selectedIds.clear();
  selectedSectionId = null;
  zoom = 1;
  panX = 0;
  panY = 0;
  syncColorModeUi();
  renderList();
  renderSections();
  draw();
}

function commitRect(worldRect, name) {
  if (worldRect.w < 8 || worldRect.h < 8) return;
  pushCreateUndo();
  const label = String(name || '').trim() || 'Zone';
  const same = network.zones.find(
    (z) => z.name.trim().toLowerCase() === label.toLowerCase()
  );
  carveRectFromOthers(network, worldRect, same?.id || null);
  addRectToNetwork(network, label, worldRect);
  const z = network.zones.find(
    (x) => x.name.trim().toLowerCase() === label.toLowerCase()
  );
  setSelection(z ? [z.id] : []);
  markDirty(true);
  renderList();
  renderSections();
  draw();
}

/** Existing zones keep the overlap: add only the non-overlapping remainder. */
function commitRectAvoiding(worldRect, name, hits) {
  pushCreateUndo();
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
  setSelection(z ? [z.id] : []);
  markDirty(true);
  renderList();
  renderSections();
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

el.colorMode?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode === 'section' ? 'section' : 'zone';
  if (colorMode() === mode) return;
  network.colorMode = mode;
  markDirty(true);
  syncColorModeUi();
  renderList();
  renderSections();
  draw();
});

el.list?.addEventListener('input', (e) => {
  const input = e.target.closest('input.ze-color[data-act="color"]');
  if (!input || input.disabled) return;
  const row = input.closest('.ze-row');
  if (!row) return;
  setZoneColor(network, row.dataset.id, input.value);
  markDirty(true);
  draw();
});

el.list?.addEventListener('click', (e) => {
  const row = e.target.closest('.ze-row');
  if (!row) return;
  const id = row.dataset.id;
  const zone = network.zones.find((z) => z.id === id);
  if (!zone) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'color') return;
  if (act === 'del') {
    deleteZone(network, id);
    selectedIds.delete(id);
    markDirty(true);
    renderList();
    renderSections();
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
  // Name field: keep focus; still update selection without rebuilding.
  if (e.target.closest('.ze-row-name')) {
    if (e.shiftKey) {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
    } else {
      setSelection([id]);
    }
    syncListSelectionClasses();
    draw();
    return;
  }
  if (e.shiftKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    if (el.nameInput) el.nameInput.value = zone.name;
  } else {
    setSelection([id]);
  }
  syncListSelectionClasses();
  draw();
});

el.list?.addEventListener('change', (e) => {
  const input = e.target.closest('.ze-row-name');
  if (!input) return;
  const row = input.closest('.ze-row');
  if (!row) return;
  renameZone(network, row.dataset.id, input.value);
  if (selectedIds.has(row.dataset.id) && el.nameInput) {
    el.nameInput.value = input.value.trim() || el.nameInput.value;
  }
  markDirty(true);
  renderList();
  renderSections();
  draw();
});

// Commit rename on Enter without waiting for blur.
el.list?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest?.('.ze-row-name');
  if (!input) return;
  e.preventDefault();
  input.blur();
});

el.btnSectionAdd?.addEventListener('click', () => {
  ensureSections();
  const name = el.sectionNameInput?.value.trim();
  if (!name) {
    el.sectionNameInput?.focus();
    setStatus('Name the section first');
    return;
  }
  if (!selectedIds.size) {
    setStatus('Shift-select areas, then +');
    return;
  }
  const section = addSection(network, name);
  for (const id of selectedIds) addZoneToSection(network, section.id, id);
  selectedSectionId = section.id;
  if (el.sectionNameInput) el.sectionNameInput.value = '';
  markDirty(true);
  setStatus('');
  renderSections();
});

el.sectionNameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.btnSectionAdd?.click();
  }
});

el.sectionsList?.addEventListener('input', (e) => {
  const input = e.target.closest('input.ze-color[data-sec-act="color"]');
  if (!input) return;
  const sec = input.closest('.ze-sec');
  if (!sec) return;
  setSectionColor(network, sec.dataset.section, input.value);
  markDirty(true);
  if (colorMode() === 'section') {
    renderList();
    renderSections();
  }
  draw();
});

el.sectionsList?.addEventListener('click', (e) => {
  const sec = e.target.closest('.ze-sec');
  if (!sec) return;
  const sectionId = sec.dataset.section;
  const act = e.target.closest('[data-sec-act]')?.dataset.secAct;
  if (act === 'color') return;
  if (act === 'del') {
    deleteSection(network, sectionId);
    if (selectedSectionId === sectionId) selectedSectionId = null;
    markDirty(true);
    renderSections();
    draw();
    return;
  }
  if (e.target.closest('input')) return;
  selectedSectionId = sectionId;
  el.sectionsList.querySelectorAll('.ze-sec').forEach((node) => {
    node.classList.toggle('selected', node.dataset.section === sectionId);
  });
  // Multi-section zones prefer the selected group's color in Groups mode.
  if (colorMode() === 'section') {
    renderList();
    draw();
  }
});

el.sectionsList?.addEventListener('change', (e) => {
  const input = e.target.closest('[data-sec-act="rename"]');
  if (!input) return;
  const sec = input.closest('.ze-sec');
  if (!sec) return;
  renameSection(network, sec.dataset.section, input.value);
  markDirty(true);
  renderSections();
});

// ---- drag zones into / out of sections ------------------------------------

function readDrag(e) {
  if (dragPayload) return dragPayload;
  try {
    const raw = e.dataTransfer?.getData(DRAG_MIME) || e.dataTransfer?.getData('text/plain');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function beginDrag(e, { zoneIds, fromSectionId = null }) {
  if (e.target.closest('input, button, .ze-row-name')) {
    e.preventDefault();
    return false;
  }
  const ids = [...new Set(zoneIds)].filter(Boolean);
  if (!ids.length) {
    e.preventDefault();
    return false;
  }
  dragPayload = { zoneIds: ids, fromSectionId: fromSectionId || null };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragPayload));
  e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload));
  e.currentTarget?.classList?.add('ze-dragging');
  return true;
}

function clearDropMarks() {
  document.querySelectorAll('.ze-drop-over').forEach((n) => n.classList.remove('ze-drop-over'));
}

function applyDragToSection(sectionId, payload) {
  if (!sectionId || !payload?.zoneIds?.length) return false;
  let changed = false;
  for (const id of payload.zoneIds) {
    const before = network.sections.find((s) => s.id === sectionId)?.zoneIds?.length || 0;
    addZoneToSection(network, sectionId, id);
    const after = network.sections.find((s) => s.id === sectionId)?.zoneIds?.length || 0;
    if (after !== before) changed = true;
    // Dropping into another section keeps membership in the source (multi-section).
  }
  if (changed) {
    selectedSectionId = sectionId;
    markDirty(true);
    renderSections();
  }
  return changed;
}

function applyDragOutOfSection(payload) {
  if (!payload?.fromSectionId || !payload.zoneIds?.length) return false;
  let changed = false;
  for (const id of payload.zoneIds) {
    const sec = network.sections.find((s) => s.id === payload.fromSectionId);
    const had = sec?.zoneIds?.includes(id);
    removeZoneFromSection(network, payload.fromSectionId, id);
    if (had) changed = true;
  }
  if (changed) {
    markDirty(true);
    renderSections();
  }
  return changed;
}

el.list?.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.ze-row');
  if (!row || !el.list.contains(row)) return;
  const id = row.dataset.id;
  const zoneIds = selectedIds.has(id) && selectedIds.size ? [...selectedIds] : [id];
  if (!beginDrag(e, { zoneIds, fromSectionId: null })) return;
  row.classList.add('ze-dragging');
});

el.list?.addEventListener('dragend', () => {
  dragPayload = null;
  clearDropMarks();
  el.list?.querySelectorAll('.ze-dragging').forEach((n) => n.classList.remove('ze-dragging'));
  el.sectionsList?.querySelectorAll('.ze-dragging').forEach((n) => n.classList.remove('ze-dragging'));
});

el.list?.addEventListener('dragover', (e) => {
  const payload = readDrag(e);
  if (!payload?.fromSectionId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  el.list.classList.add('ze-drop-over');
});

el.list?.addEventListener('dragleave', (e) => {
  if (!el.list.contains(e.relatedTarget)) el.list.classList.remove('ze-drop-over');
});

el.list?.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDropMarks();
  const payload = readDrag(e);
  applyDragOutOfSection(payload);
  dragPayload = null;
});

el.sectionsList?.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.ze-sec-members li[data-zone]');
  if (!li) return;
  beginDrag(e, {
    zoneIds: [li.dataset.zone],
    fromSectionId: li.dataset.fromSection || null
  });
});

el.sectionsList?.addEventListener('dragend', () => {
  dragPayload = null;
  clearDropMarks();
  el.sectionsList?.querySelectorAll('.ze-dragging').forEach((n) => n.classList.remove('ze-dragging'));
});

el.sectionsList?.addEventListener('dragover', (e) => {
  const sec = e.target.closest('.ze-sec');
  if (!sec || !readDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  sec.classList.add('ze-drop-over');
});

el.sectionsList?.addEventListener('dragleave', (e) => {
  const sec = e.target.closest('.ze-sec');
  if (sec && !sec.contains(e.relatedTarget)) sec.classList.remove('ze-drop-over');
});

el.sectionsList?.addEventListener('drop', (e) => {
  const sec = e.target.closest('.ze-sec');
  if (!sec) return;
  e.preventDefault();
  clearDropMarks();
  const payload = readDrag(e);
  applyDragToSection(sec.dataset.section, payload);
  dragPayload = null;
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

el.canvas.addEventListener('pointerup', () => {
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
    ensureSections();
  } catch {
    network = emptyNetwork(mapCode);
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  selectedIds.clear();
  selectedSectionId = null;
  renderList();
  renderSections();
  draw();
  setStatus('Discarded');
});

el.btnSave?.addEventListener('click', async () => {
  setStatus('Saving…');
  try {
    network = await saveZones(mapCode, network);
    ensureSections();
    savedSnapshot = snapshotOf(network);
    clearUndo();
    markDirty(false);
    setStatus('Saved', 'ok');
    renderList();
    renderSections();
  } catch (err) {
    setStatus(err.message || 'Save failed', 'err');
  }
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'z') return;
  if (e.target?.matches?.('input, textarea, select')) return;
  e.preventDefault();
  undoCreate();
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
