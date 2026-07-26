// ---------------------------------------------------------------------------
// tools/zoneEditorMain.js — Position Editor page
// Draw named positions on a CS2 radar; group into zones and areas.
// ---------------------------------------------------------------------------

import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import { RADAR_SIZE, radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { loadRadar } from '../replays/viewer/radarRenderer.js';
import {
  exteriorSegmentsFromRects,
  exteriorVerticesFromSegments,
  pieceToRing,
  rectsFromPieces,
  subtractRectFromPieces
} from '../replays/zones/zoneGeom.js';
import { positionsAtPoint } from '../replays/zones/pointInZone.js';
import {
  addArea,
  addRectToNetwork,
  addSection,
  addSectionToArea,
  addZoneToSection,
  carveRectFromOthers,
  colorForName,
  deleteArea,
  deleteSection,
  deleteZone,
  displayColorForZone,
  emptyNetwork,
  normalizeColorMode,
  overlappingZones,
  removeSectionFromArea,
  removeZoneFromSection,
  renameArea,
  renameSection,
  renameZone,
  setAreaColor,
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
  areasList: document.querySelector('#ze-areas-list'),
  nameInput: document.querySelector('#ze-name'),
  sectionNameInput: document.querySelector('#ze-section-name'),
  areaNameInput: document.querySelector('#ze-area-name'),
  btnSectionAdd: document.querySelector('#ze-section-add'),
  btnAreaAdd: document.querySelector('#ze-area-add'),
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
/** Multi-select positions (Shift-click toggles). */
const selectedIds = new Set();
/** Multi-select zones / sections. */
const selectedSectionIds = new Set();
/** Multi-select areas. */
const selectedAreaIds = new Set();
/** Last clicked section / area for paint preference. */
let preferSectionId = null;
let preferAreaId = null;
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

function ensureAreas() {
  if (!Array.isArray(network.areas)) network.areas = [];
  for (const a of network.areas) {
    if (!a.color) a.color = colorForName(a.name);
  }
}

function snapshotOf(net) {
  return JSON.stringify({
    zones: net.zones || [],
    sections: net.sections || [],
    areas: net.areas || [],
    colorMode: normalizeColorMode(net.colorMode)
  });
}

function cloneNetworkState() {
  return JSON.parse(
    JSON.stringify({
      zones: network.zones || [],
      sections: network.sections || [],
      areas: network.areas || [],
      colorMode: normalizeColorMode(network.colorMode)
    })
  );
}

function colorMode() {
  return normalizeColorMode(network.colorMode);
}

function paintColor(zone) {
  return displayColorForZone(network, zone, { preferSectionId, preferAreaId });
}

/**
 * Outline merge key: same key → one outer stroke (no internal walls).
 * Positions mode: per position. Zones/Areas mode: per membership group.
 */
function outlineGroupKey(zone) {
  const mode = colorMode();
  const sections = network.sections || [];
  const areas = network.areas || [];

  if (mode === 'area') {
    const inArea = (area) =>
      (area.sectionIds || []).some((sid) => {
        const sec = sections.find((s) => s.id === sid);
        return sec?.zoneIds?.includes(zone.id);
      });
    if (preferAreaId) {
      const pref = areas.find((a) => a.id === preferAreaId);
      if (pref && inArea(pref)) return `area:${pref.id}`;
    }
    const area = areas.find(inArea);
    if (area) return `area:${area.id}`;
  }

  if (mode === 'section') {
    if (preferSectionId) {
      const pref = sections.find((s) => s.id === preferSectionId);
      if (pref?.zoneIds?.includes(zone.id)) return `section:${pref.id}`;
    }
    const sec = sections.find((s) => s.zoneIds?.includes(zone.id));
    if (sec) return `section:${sec.id}`;
  }

  return `pos:${zone.id}`;
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

function pushUndo() {
  undoStack.push(cloneNetworkState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function clearUndo() {
  undoStack = [];
}

function pruneSelection() {
  const aliveZones = new Set(network.zones.map((z) => z.id));
  for (const id of [...selectedIds]) {
    if (!aliveZones.has(id)) selectedIds.delete(id);
  }
  const aliveSections = new Set((network.sections || []).map((s) => s.id));
  for (const id of [...selectedSectionIds]) {
    if (!aliveSections.has(id)) selectedSectionIds.delete(id);
  }
  const aliveAreas = new Set((network.areas || []).map((a) => a.id));
  for (const id of [...selectedAreaIds]) {
    if (!aliveAreas.has(id)) selectedAreaIds.delete(id);
  }
  if (preferSectionId && !aliveSections.has(preferSectionId)) preferSectionId = null;
  if (preferAreaId && !aliveAreas.has(preferAreaId)) preferAreaId = null;
}

function undoLast() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  network.zones = prev.zones || [];
  network.sections = prev.sections || [];
  network.areas = prev.areas || [];
  network.colorMode = normalizeColorMode(prev.colorMode);
  pruneSelection();
  syncColorModeUi();
  markDirty(snapshotOf(network) !== savedSnapshot);
  renderAll();
  draw();
  setStatus('Undid');
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

  // Group shapes so multi-rect positions (and zone/area unions) stroke only
  // the outer outline — shared internal edges cancel.
  const groups = new Map();
  for (const z of network.zones) {
    if (z.hidden) continue;
    const key = outlineGroupKey(z);
    if (!groups.has(key)) {
      groups.set(key, {
        color: paintColor(z),
        selected: false,
        rects: [],
        labels: []
      });
    }
    const g = groups.get(key);
    if (selectedIds.has(z.id)) g.selected = true;
    g.rects.push(...rectsFromPieces(z.pieces));
    const ring = [];
    for (const piece of z.pieces || []) {
      const pr = pieceToRing(piece);
      if (pr.length) ring.push(...pr);
    }
    if (ring.length) g.labels.push({ name: z.name, ring });
  }

  const labelsOnly = colorMode() === 'none';

  for (const g of groups.values()) {
    if (!labelsOnly) {
      const alpha = g.selected ? 0.42 : 0.28;
      for (const r of g.rects) {
        const a = worldToRadar(mapCode, r.x, r.y, {});
        const b = worldToRadar(mapCode, r.x + r.w, r.y + r.h, {});
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const rw = Math.abs(b.x - a.x);
        const rh = Math.abs(b.y - a.y);
        ctx.fillStyle = hexAlpha(g.color, alpha);
        ctx.fillRect(x, y, rw, rh);
      }
      for (const label of g.labels) {
        if (label.ring?.length >= 3 && !g.rects.length) {
          ctx.beginPath();
          for (let i = 0; i < label.ring.length; i++) {
            const rp = worldToRadar(mapCode, label.ring[i][0], label.ring[i][1], {});
            if (i === 0) ctx.moveTo(rp.x, rp.y);
            else ctx.lineTo(rp.x, rp.y);
          }
          ctx.closePath();
          ctx.fillStyle = hexAlpha(g.color, alpha);
          ctx.fill();
        }
      }

      const segs = exteriorSegmentsFromRects(g.rects);
      ctx.strokeStyle = g.selected ? '#ffffff' : g.color;
      ctx.lineWidth = (g.selected ? 2.2 : 1.4) / t.scale;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const s of segs) {
        const p0 = worldToRadar(mapCode, s.x0, s.y0, {});
        const p1 = worldToRadar(mapCode, s.x1, s.y1, {});
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
      }
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      for (const [wx, wy] of exteriorVerticesFromSegments(segs)) {
        const rp = worldToRadar(mapCode, wx, wy, {});
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, 3.2 / t.scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // One label per position (centroid of that position's corners).
    const labeled = new Set();
    ctx.font = `${12 / t.scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of g.labels) {
      if (!label.name || labeled.has(label.name)) continue;
      labeled.add(label.name);
      const ring = label.ring || [];
      if (!ring.length) continue;
      let sx = 0;
      let sy = 0;
      for (const [wx, wy] of ring) {
        const rp = worldToRadar(mapCode, wx, wy, {});
        sx += rp.x;
        sy += rp.y;
      }
      sx /= ring.length;
      sy /= ring.length;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(label.name, sx + 0.8 / t.scale, sy + 0.8 / t.scale);
      ctx.fillStyle = g.selected && labelsOnly ? '#ffffff' : '#f2f2f2';
      ctx.fillText(label.name, sx, sy);
    }
  }

  if (drawing) {
    const x0 = Math.min(drawing.r0.x, drawing.r1.x);
    const y0 = Math.min(drawing.r0.y, drawing.r1.y);
    const rw = Math.abs(drawing.r1.x - drawing.r0.x);
    const rh = Math.abs(drawing.r1.y - drawing.r0.y);
    const previewName = el.nameInput?.value.trim() || 'Position';
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

function setSelection(ids, { primaryName = true, clearParents = true } = {}) {
  if (clearParents) {
    selectedSectionIds.clear();
    selectedAreaIds.clear();
    preferSectionId = null;
    preferAreaId = null;
  }
  selectedIds.clear();
  for (const id of ids) {
    if (network.zones.some((z) => z.id === id)) selectedIds.add(id);
  }
  if (primaryName && el.nameInput) {
    const first = network.zones.find((z) => selectedIds.has(z.id));
    if (first) el.nameInput.value = first.name;
  }
}

function positionIdsForSection(sectionId) {
  const sec = network.sections?.find((s) => s.id === sectionId);
  return (sec?.zoneIds || []).filter((id) => network.zones.some((z) => z.id === id));
}

function sectionIdsForArea(areaId) {
  const area = network.areas?.find((a) => a.id === areaId);
  return (area?.sectionIds || []).filter((id) => network.sections?.some((s) => s.id === id));
}

function positionIdsForArea(areaId) {
  const ids = [];
  for (const sid of sectionIdsForArea(areaId)) {
    for (const zid of positionIdsForSection(sid)) ids.push(zid);
  }
  return [...new Set(ids)];
}

/** Sync list highlight classes after selection changes. */
function syncAllSelectionClasses() {
  syncListSelectionClasses();
  syncSectionSelectionClasses();
  syncAreaSelectionClasses();
}

/**
 * Select a zone and all of its positions (Zones pick from Positions).
 */
function selectZoneWithChildren(sectionId, { shiftKey = false, primaryName = true } = {}) {
  const posIds = positionIdsForSection(sectionId);
  if (shiftKey) {
    if (selectedSectionIds.has(sectionId)) {
      selectedSectionIds.delete(sectionId);
      for (const id of posIds) selectedIds.delete(id);
    } else {
      selectedSectionIds.add(sectionId);
      for (const id of posIds) selectedIds.add(id);
    }
  } else {
    selectedAreaIds.clear();
    preferAreaId = null;
    selectedSectionIds.clear();
    selectedSectionIds.add(sectionId);
    selectedIds.clear();
    for (const id of posIds) selectedIds.add(id);
  }
  preferSectionId = selectedSectionIds.has(sectionId) ? sectionId : [...selectedSectionIds][0] || null;
  if (primaryName && el.sectionNameInput) {
    const sec = network.sections?.find((s) => s.id === sectionId);
    if (sec) el.sectionNameInput.value = sec.name;
  }
  syncAllSelectionClasses();
}

/**
 * Select an area, all of its zones, and all underlying positions.
 */
function selectAreaWithChildren(areaId, { shiftKey = false, primaryName = true } = {}) {
  const secIds = sectionIdsForArea(areaId);
  const posIds = positionIdsForArea(areaId);
  if (shiftKey) {
    if (selectedAreaIds.has(areaId)) {
      selectedAreaIds.delete(areaId);
      for (const id of secIds) selectedSectionIds.delete(id);
      for (const id of posIds) selectedIds.delete(id);
    } else {
      selectedAreaIds.add(areaId);
      for (const id of secIds) selectedSectionIds.add(id);
      for (const id of posIds) selectedIds.add(id);
    }
  } else {
    selectedAreaIds.clear();
    selectedAreaIds.add(areaId);
    selectedSectionIds.clear();
    for (const id of secIds) selectedSectionIds.add(id);
    selectedIds.clear();
    for (const id of posIds) selectedIds.add(id);
  }
  preferAreaId = selectedAreaIds.has(areaId) ? areaId : [...selectedAreaIds][0] || null;
  preferSectionId = [...selectedSectionIds][0] || null;
  if (primaryName && el.areaNameInput) {
    const area = network.areas?.find((a) => a.id === areaId);
    if (area) el.areaNameInput.value = area.name;
  }
  syncAllSelectionClasses();
}

function syncListSelectionClasses() {
  el.list?.querySelectorAll('.ze-row').forEach((row) => {
    row.classList.toggle('selected', selectedIds.has(row.dataset.id));
  });
}

function syncSectionSelectionClasses() {
  el.sectionsList?.querySelectorAll('.ze-sec').forEach((node) => {
    node.classList.toggle('selected', selectedSectionIds.has(node.dataset.section));
  });
}

function syncAreaSelectionClasses() {
  el.areasList?.querySelectorAll('.ze-area').forEach((node) => {
    node.classList.toggle('selected', selectedAreaIds.has(node.dataset.area));
  });
}

function positionColorDisabled() {
  const m = colorMode();
  return m === 'section' || m === 'area';
}

function renderList() {
  if (!network.zones.length) {
    el.list.innerHTML =
      '<p class="ze-empty">No positions yet. Drag on the radar to draw a square, or click a position to select it.</p>';
    return;
  }
  const disablePosColor = positionColorDisabled();
  el.list.innerHTML = network.zones
    .map((z) => {
      const selected = selectedIds.has(z.id) ? ' selected' : '';
      const hex = toColorInputValue(paintColor(z));
      return `<div class="ze-row${selected}${z.hidden ? ' is-hidden' : ''}" data-id="${z.id}" draggable="true" title="Click to select · Drag into a zone · Drag to map to delete">
        <label class="ze-swatch-wrap" title="Position color" draggable="false">
          <input type="color" class="ze-color" value="${hex}" data-act="color" draggable="false" ${
            disablePosColor ? 'disabled' : ''
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
      '<p class="ze-empty">Select positions, name a zone, then +. Drag onto the map to remove from a zone.</p>';
    return;
  }
  const byId = new Map(network.zones.map((z) => [z.id, z]));
  const groupPaint = colorMode() === 'section';
  const areaPaint = colorMode() === 'area';
  el.sectionsList.innerHTML = network.sections
    .map((s) => {
      const selected = selectedSectionIds.has(s.id) ? ' selected' : '';
      const secColor = toColorInputValue(s.color || colorForName(s.name));
      const members = (s.zoneIds || [])
        .map((id) => byId.get(id))
        .filter(Boolean);
      const memberHtml = `<ul class="ze-sec-members" data-section="${s.id}">${members
        .map((z) => {
          const swatch = groupPaint || areaPaint
            ? secColor
            : toColorInputValue(z.color || colorForName(z.name));
          return `<li draggable="true" data-zone="${z.id}" data-from-section="${s.id}" title="Drag to map to remove from zone, or onto another zone">
              <span class="ze-swatch" style="background:${swatch}"></span>
              <span>${escapeAttr(z.name)}</span>
            </li>`;
        })
        .join('')}</ul>`;
      return `<div class="ze-sec${selected}" data-section="${s.id}" draggable="true" title="Click to select zone + positions · Drag into an area · Drag to map to delete">
        <div class="ze-sec-top">
          <label class="ze-swatch-wrap" title="Zone color" draggable="false">
            <input type="color" class="ze-color" value="${secColor}" data-sec-act="color" draggable="false" />
          </label>
          <input class="ze-row-name" type="text" maxlength="48" value="${escapeAttr(s.name)}" data-sec-act="rename" draggable="false" />
          <button type="button" class="ze-icon-btn" data-sec-act="del" title="Delete zone" draggable="false">✕</button>
        </div>
        ${memberHtml}
      </div>`;
    })
    .join('');
}

function renderAreas() {
  if (!el.areasList) return;
  ensureAreas();
  if (!network.areas.length) {
    el.areasList.innerHTML =
      '<p class="ze-empty">Select zones, name an area, then +. Drag onto the map to remove from an area.</p>';
    return;
  }
  const bySectionId = new Map((network.sections || []).map((s) => [s.id, s]));
  const areaPaint = colorMode() === 'area';
  el.areasList.innerHTML = network.areas
    .map((a) => {
      const selected = selectedAreaIds.has(a.id) ? ' selected' : '';
      const areaColor = toColorInputValue(a.color || colorForName(a.name));
      const members = (a.sectionIds || [])
        .map((id) => bySectionId.get(id))
        .filter(Boolean);
      const memberHtml = `<ul class="ze-area-members" data-area="${a.id}">${members
        .map((s) => {
          const secColor = toColorInputValue(s.color || colorForName(s.name));
          const swatch = areaPaint ? areaColor : secColor;
          return `<li draggable="true" data-section="${s.id}" data-from-area="${a.id}" title="Drag to map to remove from area, or onto another area">
              <span class="ze-swatch" style="background:${swatch}"></span>
              <span>${escapeAttr(s.name)}</span>
            </li>`;
        })
        .join('')}</ul>`;
      return `<div class="ze-area${selected}" data-area="${a.id}" draggable="true" title="Click to select area + zones + positions · Drag to map to delete">
        <div class="ze-area-top">
          <label class="ze-swatch-wrap" title="Area color" draggable="false">
            <input type="color" class="ze-color" value="${areaColor}" data-area-act="color" draggable="false" />
          </label>
          <input class="ze-row-name" type="text" maxlength="48" value="${escapeAttr(a.name)}" data-area-act="rename" draggable="false" />
          <button type="button" class="ze-icon-btn" data-area-act="del" title="Delete area" draggable="false">✕</button>
        </div>
        ${memberHtml}
      </div>`;
    })
    .join('');
}

function renderAll() {
  renderList();
  renderSections();
  renderAreas();
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
    // Fill missing arrays/colors in memory only — never wipe loaded polygons.
    if (!Array.isArray(network.zones)) network.zones = [];
    ensureSections();
    ensureAreas();
    network.colorMode = normalizeColorMode(network.colorMode);
  } catch (err) {
    network = emptyNetwork(mapCode);
    setStatus(err.message || 'Could not load positions', 'err');
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  selectedIds.clear();
  selectedSectionIds.clear();
  selectedAreaIds.clear();
  preferSectionId = null;
  preferAreaId = null;
  zoom = 1;
  panX = 0;
  panY = 0;
  syncColorModeUi();
  renderAll();
  draw();
}

function commitRect(worldRect, name) {
  if (worldRect.w < 8 || worldRect.h < 8) return;
  pushUndo();
  const label = String(name || '').trim() || 'Position';
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
  renderAll();
  draw();
}

function commitRectAvoiding(worldRect, name, hits) {
  pushUndo();
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
  renderAll();
  draw();
}

function sectionContainingPosition(positionId) {
  return (network.sections || []).find((s) => (s.zoneIds || []).includes(positionId)) || null;
}

function areaContainingSection(sectionId) {
  if (!sectionId) return null;
  return (
    (network.areas || []).find((a) => (a.sectionIds || []).includes(sectionId)) || null
  );
}

/** Zones selected in the list, or zones that contain any selected position. */
function selectedZonesForAreaCreate() {
  if (selectedSectionIds.size) return [...selectedSectionIds];
  const out = [];
  for (const s of network.sections || []) {
    if ((s.zoneIds || []).some((zid) => selectedIds.has(zid))) out.push(s.id);
  }
  return out;
}

function selectAtRadarPoint(radarPt, { shiftKey = false } = {}) {
  const world = radarToWorld(mapCode, radarPt.x, radarPt.y, {});
  const hits = positionsAtPoint(world.x, world.y, network);
  if (!hits.length) return false;
  const top = hits[hits.length - 1];
  const mode = colorMode();

  // In Zones/Areas view, click selects the parent group (so Area + works).
  if (mode === 'area') {
    const sec = sectionContainingPosition(top.id);
    const area = areaContainingSection(sec?.id);
    if (area) {
      selectAreaWithChildren(area.id, { shiftKey });
      renderList();
      renderSections();
      draw();
      return true;
    }
  }
  if (mode === 'section' || mode === 'area') {
    const sec = sectionContainingPosition(top.id);
    if (sec) {
      selectZoneWithChildren(sec.id, { shiftKey });
      renderList();
      renderAreas();
      draw();
      return true;
    }
  }

  if (shiftKey) {
    if (selectedIds.has(top.id)) selectedIds.delete(top.id);
    else selectedIds.add(top.id);
    if (el.nameInput) el.nameInput.value = top.name;
  } else {
    setSelection([top.id]);
  }
  syncAllSelectionClasses();
  draw();
  return true;
}

function tryFinishDraw() {
  if (!drawing) return;
  const { r0, r1, shiftKey = false } = drawing;
  drawing = null;
  const dx = Math.abs(r1.x - r0.x);
  const dy = Math.abs(r1.y - r0.y);
  if (dx < MIN_DRAW_PX && dy < MIN_DRAW_PX) {
    selectAtRadarPoint(r0, { shiftKey });
    return;
  }
  if (dx < MIN_DRAW_PX || dy < MIN_DRAW_PX) {
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
  const name = el.nameInput?.value.trim() || 'Position';
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
    <p class="ze-modal-hint">Choose which position keeps the overlapping area. The other is carved out.</p>
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

// ---- overlap modal ---------------------------------------------------------

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
  const mode = normalizeColorMode(btn.dataset.mode);
  if (colorMode() === mode) return;
  network.colorMode = mode;
  markDirty(true);
  syncColorModeUi();
  renderAll();
  draw();
});

// ---- positions list --------------------------------------------------------

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
    pushUndo();
    deleteZone(network, id);
    selectedIds.delete(id);
    markDirty(true);
    renderAll();
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
  if (e.target.closest('.ze-row-name')) {
    if (e.shiftKey) {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
    } else {
      setSelection([id]);
    }
    syncAllSelectionClasses();
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
  syncAllSelectionClasses();
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
  renderAll();
  draw();
});

el.list?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest?.('.ze-row-name');
  if (!input) return;
  e.preventDefault();
  input.blur();
});

// ---- zones -----------------------------------------------------------------

el.btnSectionAdd?.addEventListener('click', () => {
  ensureSections();
  const name = el.sectionNameInput?.value.trim();
  if (!name) {
    el.sectionNameInput?.focus();
    setStatus('Name the zone first');
    return;
  }
  if (!selectedIds.size) {
    setStatus('Select positions, then +');
    return;
  }
  const section = addSection(network, name);
  for (const id of selectedIds) addZoneToSection(network, section.id, id);
  if (el.sectionNameInput) el.sectionNameInput.value = '';
  markDirty(true);
  setStatus('');
  selectZoneWithChildren(section.id, { shiftKey: false });
  renderAll();
  draw();
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
  const m = colorMode();
  if (m === 'section' || m === 'area') {
    renderList();
    renderSections();
    renderAreas();
  }
  draw();
});

el.sectionsList?.addEventListener('click', (e) => {
  const member = e.target.closest('.ze-sec-members li[data-zone]');
  if (member) {
    const pid = member.dataset.zone;
    if (e.shiftKey) {
      if (selectedIds.has(pid)) selectedIds.delete(pid);
      else selectedIds.add(pid);
    } else {
      setSelection([pid]);
    }
    syncAllSelectionClasses();
    draw();
    return;
  }
  const sec = e.target.closest('.ze-sec');
  if (!sec) return;
  const sectionId = sec.dataset.section;
  const act = e.target.closest('[data-sec-act]')?.dataset.secAct;
  if (act === 'color') return;
  if (act === 'del') {
    pushUndo();
    deleteSection(network, sectionId);
    selectedSectionIds.delete(sectionId);
    if (preferSectionId === sectionId) preferSectionId = null;
    markDirty(true);
    renderAll();
    draw();
    return;
  }
  if (e.target.closest('input[data-sec-act="rename"]')) {
    selectZoneWithChildren(sectionId, { shiftKey: e.shiftKey, primaryName: false });
    renderList();
    draw();
    return;
  }
  selectZoneWithChildren(sectionId, { shiftKey: e.shiftKey });
  renderList();
  renderAreas();
  draw();
});

el.sectionsList?.addEventListener('change', (e) => {
  const input = e.target.closest('[data-sec-act="rename"]');
  if (!input) return;
  const sec = input.closest('.ze-sec');
  if (!sec) return;
  renameSection(network, sec.dataset.section, input.value);
  markDirty(true);
  renderSections();
  renderAreas();
});

el.sectionsList?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest?.('[data-sec-act="rename"]');
  if (!input) return;
  e.preventDefault();
  input.blur();
});

// ---- areas -----------------------------------------------------------------

el.btnAreaAdd?.addEventListener('click', () => {
  ensureAreas();
  const name = el.areaNameInput?.value.trim();
  if (!name) {
    el.areaNameInput?.focus();
    setStatus('Name the area first');
    return;
  }
  const zoneIds = selectedZonesForAreaCreate();
  if (!zoneIds.length) {
    setStatus('Select zones (or their positions), then +');
    return;
  }
  const area = addArea(network, name);
  for (const id of zoneIds) addSectionToArea(network, area.id, id);
  if (el.areaNameInput) el.areaNameInput.value = '';
  markDirty(true);
  setStatus(`Area “${area.name}” · ${zoneIds.length} zone${zoneIds.length === 1 ? '' : 's'}`);
  selectAreaWithChildren(area.id, { shiftKey: false });
  renderAll();
  draw();
});

el.areaNameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.btnAreaAdd?.click();
  }
});

el.areasList?.addEventListener('input', (e) => {
  const input = e.target.closest('input.ze-color[data-area-act="color"]');
  if (!input) return;
  const area = input.closest('.ze-area');
  if (!area) return;
  setAreaColor(network, area.dataset.area, input.value);
  markDirty(true);
  if (colorMode() === 'area') {
    renderList();
    renderAreas();
  }
  draw();
});

el.areasList?.addEventListener('click', (e) => {
  const member = e.target.closest('.ze-area-members li[data-section]');
  if (member) {
    selectZoneWithChildren(member.dataset.section, { shiftKey: e.shiftKey });
    renderList();
    renderSections();
    draw();
    return;
  }
  const area = e.target.closest('.ze-area');
  if (!area) return;
  const areaId = area.dataset.area;
  const act = e.target.closest('[data-area-act]')?.dataset.areaAct;
  if (act === 'color') return;
  if (act === 'del') {
    pushUndo();
    deleteArea(network, areaId);
    selectedAreaIds.delete(areaId);
    if (preferAreaId === areaId) preferAreaId = null;
    markDirty(true);
    renderAll();
    draw();
    return;
  }
  if (e.target.closest('input[data-area-act="rename"]')) {
    selectAreaWithChildren(areaId, { shiftKey: e.shiftKey, primaryName: false });
    renderList();
    renderSections();
    draw();
    return;
  }
  selectAreaWithChildren(areaId, { shiftKey: e.shiftKey });
  renderList();
  renderSections();
  draw();
});

el.areasList?.addEventListener('change', (e) => {
  const input = e.target.closest('[data-area-act="rename"]');
  if (!input) return;
  const area = input.closest('.ze-area');
  if (!area) return;
  renameArea(network, area.dataset.area, input.value);
  markDirty(true);
  renderAreas();
});

el.areasList?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest?.('[data-area-act="rename"]');
  if (!input) return;
  e.preventDefault();
  input.blur();
});

// ---- drag positions ↔ zones, zones ↔ areas ---------------------------------

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

function beginPositionDrag(e, { zoneIds, fromSectionId = null }) {
  if (e.target.closest('input, button, .ze-row-name')) {
    e.preventDefault();
    return false;
  }
  const ids = [...new Set(zoneIds)].filter(Boolean);
  if (!ids.length) {
    e.preventDefault();
    return false;
  }
  dragPayload = { kind: 'position', zoneIds: ids, fromSectionId: fromSectionId || null };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragPayload));
  e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload));
  e.currentTarget?.classList?.add('ze-dragging');
  return true;
}

function beginSectionDrag(e, { sectionIds, fromAreaId = null }) {
  if (e.target.closest('input, button, .ze-row-name')) {
    e.preventDefault();
    return false;
  }
  const ids = [...new Set(sectionIds)].filter(Boolean);
  if (!ids.length) {
    e.preventDefault();
    return false;
  }
  dragPayload = { kind: 'section', sectionIds: ids, fromAreaId: fromAreaId || null };
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
  if (!sectionId || payload?.kind !== 'position' || !payload.zoneIds?.length) return false;
  let changed = false;
  for (const id of payload.zoneIds) {
    const before = network.sections.find((s) => s.id === sectionId)?.zoneIds?.length || 0;
    addZoneToSection(network, sectionId, id);
    const after = network.sections.find((s) => s.id === sectionId)?.zoneIds?.length || 0;
    if (after !== before) changed = true;
  }
  if (changed) {
    selectedSectionIds.clear();
    selectedSectionIds.add(sectionId);
    preferSectionId = sectionId;
    markDirty(true);
    renderSections();
    renderAreas();
  }
  return changed;
}

function applyDragOutOfSection(payload) {
  if (payload?.kind !== 'position' || !payload.fromSectionId || !payload.zoneIds?.length) {
    return false;
  }
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
    renderAreas();
  }
  return changed;
}

function applyDragToArea(areaId, payload) {
  if (!areaId || payload?.kind !== 'section' || !payload.sectionIds?.length) return false;
  let changed = false;
  for (const id of payload.sectionIds) {
    const before = network.areas.find((a) => a.id === areaId)?.sectionIds?.length || 0;
    addSectionToArea(network, areaId, id);
    const after = network.areas.find((a) => a.id === areaId)?.sectionIds?.length || 0;
    if (after !== before) changed = true;
  }
  if (changed) {
    selectedAreaIds.clear();
    selectedAreaIds.add(areaId);
    preferAreaId = areaId;
    markDirty(true);
    renderAreas();
    if (colorMode() === 'area') {
      renderList();
      draw();
    }
  }
  return changed;
}

function applyDragOutOfArea(payload) {
  if (payload?.kind !== 'section' || !payload.fromAreaId || !payload.sectionIds?.length) {
    return false;
  }
  let changed = false;
  for (const id of payload.sectionIds) {
    const area = network.areas.find((a) => a.id === payload.fromAreaId);
    const had = area?.sectionIds?.includes(id);
    removeSectionFromArea(network, payload.fromAreaId, id);
    if (had) changed = true;
  }
  if (changed) {
    markDirty(true);
    renderAreas();
    if (colorMode() === 'area') {
      renderList();
      draw();
    }
  }
  return changed;
}

function clearAllDragging() {
  dragPayload = null;
  clearDropMarks();
  document.querySelectorAll('.ze-dragging').forEach((n) => n.classList.remove('ze-dragging'));
}

el.list?.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.ze-row');
  if (!row || !el.list.contains(row)) return;
  const id = row.dataset.id;
  const zoneIds = selectedIds.has(id) && selectedIds.size ? [...selectedIds] : [id];
  if (!beginPositionDrag(e, { zoneIds, fromSectionId: null })) return;
  row.classList.add('ze-dragging');
});

el.list?.addEventListener('dragend', clearAllDragging);

el.list?.addEventListener('dragover', (e) => {
  const payload = readDrag(e);
  if (payload?.kind !== 'position' || !payload.fromSectionId) return;
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
  applyDragOutOfSection(readDrag(e));
  dragPayload = null;
});

el.sectionsList?.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.ze-sec-members li[data-zone]');
  if (li) {
    beginPositionDrag(e, {
      zoneIds: [li.dataset.zone],
      fromSectionId: li.dataset.fromSection || null
    });
    return;
  }
  const sec = e.target.closest('.ze-sec[data-section]');
  if (!sec || e.target.closest('.ze-sec-members')) return;
  const sectionId = sec.dataset.section;
  const sectionIds =
    selectedSectionIds.has(sectionId) && selectedSectionIds.size
      ? [...selectedSectionIds]
      : [sectionId];
  if (!beginSectionDrag(e, { sectionIds, fromAreaId: null })) return;
});

el.sectionsList?.addEventListener('dragend', clearAllDragging);

el.sectionsList?.addEventListener('dragover', (e) => {
  const payload = readDrag(e);
  if (!payload) return;
  if (payload.kind === 'position') {
    const sec = e.target.closest('.ze-sec');
    if (!sec) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    sec.classList.add('ze-drop-over');
    return;
  }
  if (payload.kind === 'section' && payload.fromAreaId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    el.sectionsList.classList.add('ze-drop-over');
  }
});

el.sectionsList?.addEventListener('dragleave', (e) => {
  const sec = e.target.closest('.ze-sec');
  if (sec && !sec.contains(e.relatedTarget)) sec.classList.remove('ze-drop-over');
  if (!el.sectionsList.contains(e.relatedTarget)) {
    el.sectionsList.classList.remove('ze-drop-over');
  }
});

el.sectionsList?.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDropMarks();
  const payload = readDrag(e);
  if (payload?.kind === 'position') {
    const sec = e.target.closest('.ze-sec');
    if (sec) applyDragToSection(sec.dataset.section, payload);
  } else if (payload?.kind === 'section') {
    applyDragOutOfArea(payload);
  }
  dragPayload = null;
});

function beginAreaDrag(e, { areaIds }) {
  if (e.target.closest('input, button, .ze-row-name')) {
    e.preventDefault();
    return false;
  }
  const ids = [...new Set(areaIds)].filter(Boolean);
  if (!ids.length) {
    e.preventDefault();
    return false;
  }
  dragPayload = { kind: 'area', areaIds: ids };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragPayload));
  e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload));
  e.currentTarget?.classList?.add('ze-dragging');
  return true;
}

/** Drop on the radar: remove from group, or delete the dragged item. */
function applyCanvasDrop(payload) {
  if (!payload) return false;
  if (payload.kind === 'position' && payload.fromSectionId) {
    applyDragOutOfSection(payload);
    setStatus('Removed from zone');
    return true;
  }
  if (payload.kind === 'section' && payload.fromAreaId) {
    applyDragOutOfArea(payload);
    setStatus('Removed from area');
    return true;
  }
  if (payload.kind === 'position' && payload.zoneIds?.length) {
    pushUndo();
    for (const id of payload.zoneIds) {
      deleteZone(network, id);
      selectedIds.delete(id);
    }
    markDirty(true);
    renderAll();
    draw();
    setStatus('Deleted position');
    return true;
  }
  if (payload.kind === 'section' && payload.sectionIds?.length) {
    pushUndo();
    for (const id of payload.sectionIds) {
      deleteSection(network, id);
      selectedSectionIds.delete(id);
    }
    markDirty(true);
    renderAll();
    draw();
    setStatus('Deleted zone');
    return true;
  }
  if (payload.kind === 'area' && payload.areaIds?.length) {
    pushUndo();
    for (const id of payload.areaIds) {
      deleteArea(network, id);
      selectedAreaIds.delete(id);
    }
    markDirty(true);
    renderAll();
    draw();
    setStatus('Deleted area');
    return true;
  }
  return false;
}

el.areasList?.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.ze-area-members li[data-section]');
  if (li) {
    beginSectionDrag(e, {
      sectionIds: [li.dataset.section],
      fromAreaId: li.dataset.fromArea || null
    });
    return;
  }
  const area = e.target.closest('.ze-area[data-area]');
  if (!area || e.target.closest('.ze-area-members')) return;
  const areaId = area.dataset.area;
  const areaIds =
    selectedAreaIds.has(areaId) && selectedAreaIds.size ? [...selectedAreaIds] : [areaId];
  beginAreaDrag(e, { areaIds });
});

el.areasList?.addEventListener('dragend', clearAllDragging);

el.areasList?.addEventListener('dragover', (e) => {
  const payload = readDrag(e);
  if (payload?.kind !== 'section') return;
  const area = e.target.closest('.ze-area');
  if (!area) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  area.classList.add('ze-drop-over');
});

el.areasList?.addEventListener('dragleave', (e) => {
  const area = e.target.closest('.ze-area');
  if (area && !area.contains(e.relatedTarget)) area.classList.remove('ze-drop-over');
});

el.areasList?.addEventListener('drop', (e) => {
  const area = e.target.closest('.ze-area');
  if (!area) return;
  e.preventDefault();
  clearDropMarks();
  applyDragToArea(area.dataset.area, readDrag(e));
  dragPayload = null;
});

el.canvas.addEventListener('dragover', (e) => {
  const payload = readDrag(e);
  if (!payload) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  el.canvas.classList.add('ze-drop-target');
});

el.canvas.addEventListener('dragleave', (e) => {
  if (e.target === el.canvas) el.canvas.classList.remove('ze-drop-target');
});

el.canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  el.canvas.classList.remove('ze-drop-target');
  clearDropMarks();
  applyCanvasDrop(readDrag(e));
  dragPayload = null;
});

// ---- canvas ----------------------------------------------------------------

el.canvas.addEventListener('pointerdown', (e) => {
  if (pendingDraw) return;
  // Pan: middle/right click or Alt. Shift is reserved for multi-select on click.
  if (e.button === 1 || e.button === 2 || e.altKey) {
    panning = true;
    lastPan = { x: e.clientX, y: e.clientY };
    el.canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const r = radarFromClient(e.clientX, e.clientY);
  drawing = { r0: r, r1: { ...r }, shiftKey: e.shiftKey };
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
    ensureAreas();
    network.colorMode = normalizeColorMode(network.colorMode);
  } catch {
    network = emptyNetwork(mapCode);
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  selectedIds.clear();
  selectedSectionIds.clear();
  selectedAreaIds.clear();
  preferSectionId = null;
  preferAreaId = null;
  renderAll();
  draw();
  setStatus('Discarded');
});

el.btnSave?.addEventListener('click', async () => {
  setStatus('Saving…');
  try {
    network = await saveZones(mapCode, network);
    ensureSections();
    ensureAreas();
    network.colorMode = normalizeColorMode(network.colorMode);
    savedSnapshot = snapshotOf(network);
    clearUndo();
    markDirty(false);
    setStatus('Saved', 'ok');
    renderAll();
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
