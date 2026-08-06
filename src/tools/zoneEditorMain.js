// ---------------------------------------------------------------------------
// tools/zoneEditorMain.js — Sites & Vision editor
// Bombsites, key zones, vision-block / elevated / underpass paint, ledges.
// ---------------------------------------------------------------------------

import { MAPS, MAP_CODES, mapHasLowerRadar } from '../replays/shared/roundId.js';
import { RADAR_SIZE, radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { loadRadar } from '../replays/viewer/radarRenderer.js';
import { emptyNetwork, worldPolyFromRadarVerts, worldRectFromRadarDrag } from '../replays/zones/zoneModel.js';
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
import {
  LEDGES_MAX,
  ensureLedges,
  eraseLedgesNear,
  simplifyStrokePts,
  worldLedgeFromRadarStroke
} from '../replays/zones/ledges.js';
import {
  createArea,
  createPosition,
  createZone,
  deleteArea,
  deletePosition,
  deleteZone,
  ensureRegionHierarchy,
  renameArea,
  renamePosition,
  renameZone,
  setAreaMembers,
  setZoneMembers
} from '../replays/zones/regionHierarchy.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const MIN_DRAW_PX = 8;
const MIN_LEDGE_LEN_PX = 6;
const UNDO_MAX = 40;
const VISION_COLOR = '#9b6cff';
const ELEVATED_COLOR = '#e8a03c';
const UNDERPASS_COLOR = '#3db8a8';
const LEDGE_COLOR = '#d45a82';
const LEDGE_DROP_COLOR = '#8a2f4a';
const LEDGE_UPPER_COLOR = '#e8a0b4';
const BOMB_A_COLOR = '#e8c040';
const BOMB_B_COLOR = '#4aa3ff';
const KEY_A_COLOR = '#c9a227';
const KEY_B_COLOR = '#3d7ab8';
const POSITION_COLOR = '#5dce6e';
const POSITION_SELECTED = '#b8f0c0';

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
  toolPosition: document.querySelector('#ze-tool-position'),
  toolVision: document.querySelector('#ze-tool-vision'),
  toolElevated: document.querySelector('#ze-tool-elevated'),
  toolUnderpass: document.querySelector('#ze-tool-underpass'),
  toolLedge: document.querySelector('#ze-tool-ledge'),
  toolErase: document.querySelector('#ze-tool-erase'),
  shapeRect: document.querySelector('#ze-shape-rect'),
  shapePoly: document.querySelector('#ze-shape-poly'),
  floorSep: document.querySelector('#ze-floor-sep'),
  floorDefault: document.querySelector('#ze-floor-default'),
  floorLower: document.querySelector('#ze-floor-lower'),
  btnBrushDown: document.querySelector('#ze-brush-down'),
  btnBrushUp: document.querySelector('#ze-brush-up'),
  btnClearVision: document.querySelector('#ze-clear-vision'),
  btnClearElevated: document.querySelector('#ze-clear-elevated'),
  btnClearUnderpass: document.querySelector('#ze-clear-underpass'),
  btnClearLedges: document.querySelector('#ze-clear-ledges'),
  btnClearBombA: document.querySelector('#ze-clear-bomb-a'),
  btnClearBombB: document.querySelector('#ze-clear-bomb-b'),
  btnClearKeyA: document.querySelector('#ze-clear-key-a'),
  btnClearKeyB: document.querySelector('#ze-clear-key-b'),
  btnToggleSites: document.querySelector('#ze-toggle-sites'),
  regions: document.querySelector('#ze-regions'),
  btnMakeZone: document.querySelector('#ze-make-zone'),
  btnMakeArea: document.querySelector('#ze-make-area')
};

let mapCode = MAP_CODES.includes('INF') ? 'INF' : MAP_CODES[0];
let network = emptyNetwork(mapCode);
ensureVisionLayers(network);
ensureLedges(network);
ensureBombSites(network);
ensureKeyZones(network);
ensureRegionHierarchy(network);
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
/** @type {Array<[number, number]>} radar verts while drawing a polygon */
let polyVerts = [];
let panning = false;
let lastPan = null;
/** @type {'bombA'|'bombB'|'keyA'|'keyB'|'position'|'visionBlock'|'elevated'|'underpass'|'ledge'|'erase'} */
let paintTool = 'bombA';
/** @type {'rect'|'poly'} */
let shapeMode = 'rect';
/** @type {'visionBlock'|'elevated'|'underpass'|'ledge'} */
let eraseTarget = 'visionBlock';
let brushPx = DEFAULT_BRUSH_PX;
let showSites = true;
/** @type {'default'|'lower'} */
let radarLevel = 'default';
/** @type {Set<string>} */
let selectedPositionIds = new Set();
/** @type {Set<string>} */
let selectedZoneIds = new Set();
/** @type {string} */
let highlightPositionId = '';
/** @type {null | { last: {x:number,y:number}, layer: string, erase: boolean }} */
let brushing = null;
/** @type {null | Array<[number, number]>} radar pts while drawing a ledge streak */
let ledgeStroke = null;

function snapshotOf(net) {
  ensureBombSites(net);
  ensureVisionLayers(net);
  ensureLedges(net);
  ensureKeyZones(net);
  ensureRegionHierarchy(net);
  return JSON.stringify({
    visionBlocks: net.visionBlocks || [],
    elevated: net.elevated || [],
    underpasses: net.underpasses || [],
    ledges: net.ledges || [],
    bombSites: net.bombSites || { a: null, b: null },
    keyZones: net.keyZones || { a: [], b: [] },
    positions: net.positions || [],
    zones: net.zones || [],
    areas: net.areas || []
  });
}

function cloneNetworkState() {
  return JSON.parse(snapshotOf(network));
}

function isStampBrushTool(tool = paintTool) {
  return tool === 'visionBlock' || tool === 'elevated' || tool === 'underpass';
}

function isBrushTool(tool = paintTool) {
  return isStampBrushTool(tool) || tool === 'erase' || tool === 'ledge';
}

function piecesForLayer(layer) {
  ensureVisionLayers(network);
  if (layer === 'elevated') return network.elevated;
  if (layer === 'underpass') return network.underpasses;
  return network.visionBlocks;
}

function isBombTool(tool = paintTool) {
  return tool === 'bombA' || tool === 'bombB';
}

function isKeyTool(tool = paintTool) {
  return tool === 'keyA' || tool === 'keyB';
}

function isShapeTool(tool = paintTool) {
  return isBombTool(tool) || isKeyTool(tool) || tool === 'position';
}

function isRectTool(tool = paintTool) {
  return isShapeTool(tool) && shapeMode === 'rect';
}

function isPolyTool(tool = paintTool) {
  return isShapeTool(tool) && shapeMode === 'poly';
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
  network.underpasses = prev.underpasses || [];
  network.ledges = prev.ledges || [];
  network.bombSites = prev.bombSites || { a: null, b: null };
  network.keyZones = prev.keyZones || { a: [], b: [] };
  network.positions = prev.positions || [];
  network.zones = prev.zones || [];
  network.areas = prev.areas || [];
  ensureVisionLayers(network);
  ensureLedges(network);
  ensureBombSites(network);
  ensureKeyZones(network);
  ensureRegionHierarchy(network);
  bumpLayerPaintGen(network);
  markDirty(snapshotOf(network) !== savedSnapshot);
  syncUi();
  draw();
  setStatus('Undid');
}

function syncUi() {
  ensureVisionLayers(network);
  ensureLedges(network);
  ensureBombSites(network);
  ensureRegionHierarchy(network);
  if (el.layerCounts) {
    const vb = network.visionBlocks.length;
    const elv = network.elevated.length;
    const up = network.underpasses.length;
    const lg = network.ledges.length;
    el.layerCounts.textContent = `${vb} vision · ${elv} elevated · ${up} underpass · ${lg} ledge${lg === 1 ? '' : 's'}`;
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
  const hasLower = mapHasLowerRadar(mapCode);
  el.toolBombA?.classList.toggle('active', paintTool === 'bombA');
  el.toolBombA?.classList.toggle('bomb-a', paintTool === 'bombA');
  el.toolBombB?.classList.toggle('active', paintTool === 'bombB');
  el.toolBombB?.classList.toggle('bomb-b', paintTool === 'bombB');
  el.toolKeyA?.classList.toggle('active', paintTool === 'keyA');
  el.toolKeyA?.classList.toggle('key-a', paintTool === 'keyA');
  el.toolKeyB?.classList.toggle('active', paintTool === 'keyB');
  el.toolKeyB?.classList.toggle('key-b', paintTool === 'keyB');
  el.toolPosition?.classList.toggle('active', paintTool === 'position');
  el.toolPosition?.classList.toggle('position', paintTool === 'position');
  el.toolVision?.classList.toggle('active', paintTool === 'visionBlock');
  el.toolVision?.classList.toggle('vision', paintTool === 'visionBlock');
  el.toolElevated?.classList.toggle('active', paintTool === 'elevated');
  el.toolElevated?.classList.toggle('elevated', paintTool === 'elevated');
  el.toolUnderpass?.classList.toggle('active', paintTool === 'underpass');
  el.toolUnderpass?.classList.toggle('underpass', paintTool === 'underpass');
  el.toolLedge?.classList.toggle('active', paintTool === 'ledge');
  el.toolLedge?.classList.toggle('ledge', paintTool === 'ledge');
  el.toolErase?.classList.toggle('active', paintTool === 'erase');
  el.shapeRect?.classList.toggle('active', shapeMode === 'rect');
  el.shapePoly?.classList.toggle('active', shapeMode === 'poly');
  el.floorSep && (el.floorSep.hidden = !hasLower);
  if (el.floorDefault) {
    el.floorDefault.hidden = !hasLower;
    el.floorDefault.classList.toggle('active', radarLevel === 'default');
  }
  if (el.floorLower) {
    el.floorLower.hidden = !hasLower;
    el.floorLower.classList.toggle('active', radarLevel === 'lower');
  }
  el.canvas?.classList.toggle('ze-brush-cursor', isBrush);
  if (el.brushSizeLabel) el.brushSizeLabel.textContent = String(brushPx);
  if (el.btnToggleSites) {
    el.btnToggleSites.textContent = showSites
      ? 'Hide bombsite & key zones'
      : 'Show bombsite & key zones';
  }
  if (!isBrush) hideBrushRing();
  renderRegionsPanel();
}

function setPaintTool(tool) {
  if (
    tool === 'visionBlock' ||
    tool === 'elevated' ||
    tool === 'underpass' ||
    tool === 'ledge'
  ) {
    eraseTarget = tool;
  }
  paintTool = tool;
  if (!isShapeTool()) polyVerts = [];
  brushing = null;
  ledgeStroke = null;
  drawing = null;
  syncUi();
  draw();
  if (tool === 'ledge') {
    setStatus('Ledge: drag a streak · left of travel = drop · right = upper');
  } else if (tool === 'underpass') {
    setStatus('Underpass: paint area others can see into; you cannot see out');
  } else if (tool === 'position') {
    setStatus(
      `Position (${radarLevel === 'lower' ? 'lower' : 'upper'}): draw one footprint · no overlap on this floor`
    );
  }
}

function setShapeMode(mode) {
  shapeMode = mode === 'poly' ? 'poly' : 'rect';
  drawing = null;
  polyVerts = [];
  syncUi();
  draw();
  setStatus(
    shapeMode === 'poly'
      ? 'Polygon: click vertices · double-click or Enter to finish'
      : 'Rectangle: drag to draw'
  );
}

function hideBrushRing() {
  if (!el.brushRing) return;
  el.brushRing.classList.remove('on', 'vision', 'elevated', 'underpass', 'ledge', 'erase');
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
  el.brushRing.classList.toggle('underpass', paintTool === 'underpass');
  el.brushRing.classList.toggle('ledge', paintTool === 'ledge');
  el.brushRing.classList.toggle('erase', paintTool === 'erase');
  el.brushRing.style.left = `${clientX - rect.left}px`;
  el.brushRing.style.top = `${clientY - rect.top}px`;
  el.brushRing.style.width = `${diam}px`;
  el.brushRing.style.height = `${diam}px`;
}

function activeBrushLayer() {
  if (paintTool === 'visionBlock') return 'visionBlock';
  if (paintTool === 'elevated') return 'elevated';
  if (paintTool === 'underpass') return 'underpass';
  if (paintTool === 'ledge') return 'ledge';
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
  drawLayer(network.underpasses, UNDERPASS_COLOR, 0.4);

  ensureLedges(network);
  const halfW = Math.max(1.5, brushPx * 0.45);
  const drawLedgeStroke = (radarPts, committed) => {
    if (!radarPts || radarPts.length < 2) return;
    for (let i = 0; i < radarPts.length - 1; i++) {
      const x0 = radarPts[i][0];
      const y0 = radarPts[i][1];
      const x1 = radarPts[i + 1][0];
      const y1 = radarPts[i + 1][1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const rNx = (dy / len) * halfW;
      const rNy = (-dx / len) * halfW;
      // Right of travel = upper (open); left = drop.
      ctx.beginPath();
      ctx.moveTo(x0 - rNx, y0 - rNy);
      ctx.lineTo(x1 - rNx, y1 - rNy);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x0, y0);
      ctx.closePath();
      ctx.fillStyle = hexAlpha(LEDGE_DROP_COLOR, committed ? 0.55 : 0.4);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 + rNx, y1 + rNy);
      ctx.lineTo(x0 + rNx, y0 + rNy);
      ctx.closePath();
      ctx.fillStyle = hexAlpha(LEDGE_UPPER_COLOR, committed ? 0.5 : 0.35);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = LEDGE_COLOR;
      ctx.lineWidth = 1.25 / t.scale;
      ctx.stroke();
    }
  };
  for (const ledge of network.ledges) {
    const radarPts = [];
    for (const [wx, wy] of ledge.pts || []) {
      const rp = worldToRadar(mapCode, wx, wy, {});
      radarPts.push([rp.x, rp.y]);
    }
    drawLedgeStroke(radarPts, true);
  }
  if (ledgeStroke?.length >= 2) drawLedgeStroke(ledgeStroke, false);

  ensureBombSites(network);
  const drawPiece = (piece, color, label, lineW = 2) => {
    if (!piece) return;
    ctx.fillStyle = hexAlpha(color, 0.22);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW / t.scale;
    ctx.setLineDash([6 / t.scale, 4 / t.scale]);
    let cx;
    let cy;
    if (piece.type === 'poly' && piece.ring?.length >= 3) {
      ctx.beginPath();
      for (let i = 0; i < piece.ring.length; i++) {
        const rp = worldToRadar(mapCode, piece.ring[i][0], piece.ring[i][1], {});
        if (i === 0) ctx.moveTo(rp.x, rp.y);
        else ctx.lineTo(rp.x, rp.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      let sx = 0;
      let sy = 0;
      for (const [wx, wy] of piece.ring) {
        const rp = worldToRadar(mapCode, wx, wy, {});
        sx += rp.x;
        sy += rp.y;
      }
      cx = sx / piece.ring.length;
      cy = sy / piece.ring.length;
    } else {
      const a = worldToRadar(mapCode, piece.x, piece.y, {});
      const b = worldToRadar(mapCode, piece.x + piece.w, piece.y + piece.h, {});
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x);
      const rh = Math.abs(b.y - a.y);
      ctx.fillRect(x, y, rw, rh);
      ctx.strokeRect(x, y, rw, rh);
      cx = x + rw / 2;
      cy = y + rh / 2;
    }
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(11, 13 / t.scale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  };
  if (showSites) {
    drawPiece(network.bombSites.a, BOMB_A_COLOR, 'A', 2);
    drawPiece(network.bombSites.b, BOMB_B_COLOR, 'B', 2);

    ensureKeyZones(network);
    const drawKeyList = (list, color, prefix) => {
      (list || []).forEach((piece, i) => {
        drawPiece(piece, color, `${prefix}${i + 1}`, 1.5);
      });
    };
    drawKeyList(network.keyZones.a, KEY_A_COLOR, 'A');
    drawKeyList(network.keyZones.b, KEY_B_COLOR, 'B');
  }

  ensureRegionHierarchy(network);
  for (const pos of network.positions || []) {
    if ((pos.level || 'default') !== radarLevel) continue;
    const selected = selectedPositionIds.has(pos.id) || highlightPositionId === pos.id;
    const color = selected ? POSITION_SELECTED : POSITION_COLOR;
    for (const piece of pos.pieces || []) {
      drawPiece(piece, color, pos.name || 'Pos', selected ? 2.5 : 1.5);
    }
  }

  const draftColor =
    paintTool === 'bombA'
      ? BOMB_A_COLOR
      : paintTool === 'bombB'
        ? BOMB_B_COLOR
        : paintTool === 'keyA'
          ? KEY_A_COLOR
          : paintTool === 'keyB'
            ? KEY_B_COLOR
            : paintTool === 'position'
              ? POSITION_COLOR
              : '#88c0ff';

  if (drawing && isRectTool()) {
    const x0 = Math.min(drawing.r0.x, drawing.r1.x);
    const y0 = Math.min(drawing.r0.y, drawing.r1.y);
    const rw = Math.abs(drawing.r1.x - drawing.r0.x);
    const rh = Math.abs(drawing.r1.y - drawing.r0.y);
    ctx.fillStyle = hexAlpha(draftColor, 0.25);
    ctx.strokeStyle = draftColor;
    ctx.lineWidth = 1.5 / t.scale;
    ctx.setLineDash([6 / t.scale, 4 / t.scale]);
    ctx.fillRect(x0, y0, rw, rh);
    ctx.strokeRect(x0, y0, rw, rh);
    ctx.setLineDash([]);
  }

  if (polyVerts.length && isPolyTool()) {
    ctx.beginPath();
    polyVerts.forEach(([rx, ry], i) => {
      if (i === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    });
    ctx.strokeStyle = draftColor;
    ctx.lineWidth = 1.5 / t.scale;
    ctx.setLineDash([6 / t.scale, 4 / t.scale]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [rx, ry] of polyVerts) {
      ctx.fillStyle = draftColor;
      ctx.beginPath();
      ctx.arc(rx, ry, 3.5 / t.scale, 0, Math.PI * 2);
      ctx.fill();
    }
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

async function loadRadarForLevel() {
  try {
    radarImg = await loadRadar(mapCode, radarLevel);
  } catch {
    radarImg = null;
  }
}

async function setRadarLevel(level) {
  const next = level === 'lower' ? 'lower' : 'default';
  if (!mapHasLowerRadar(mapCode)) {
    radarLevel = 'default';
  } else {
    radarLevel = next;
  }
  await loadRadarForLevel();
  syncUi();
  draw();
}

async function loadMap(code) {
  if (dirty && !confirm('Discard unsaved changes on this map?')) return;
  mapCode = code;
  radarLevel = 'default';
  selectedPositionIds = new Set();
  selectedZoneIds = new Set();
  highlightPositionId = '';
  renderMapTabs();
  setStatus('');
  await loadRadarForLevel();
  try {
    network = await fetchZones(mapCode);
    ensureVisionLayers(network);
    ensureLedges(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    ensureRegionHierarchy(network);
  } catch (err) {
    network = emptyNetwork(mapCode);
    ensureVisionLayers(network);
    ensureLedges(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    ensureRegionHierarchy(network);
    setStatus(err.message || 'Could not load', 'err');
  }
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  zoom = 1;
  panX = 0;
  panY = 0;
  drawing = null;
  polyVerts = [];
  ledgeStroke = null;
  syncUi();
  draw();
}

function commitBombSite(site, piece) {
  const clean =
    piece?.type === 'poly'
      ? piece.ring?.length >= 3
        ? piece
        : null
      : piece && piece.w >= 8 && piece.h >= 8
        ? piece
        : null;
  if (!clean) return;
  pushUndo();
  ensureBombSites(network);
  network.bombSites[site] = clean;
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

function commitKeyZone(site, piece) {
  const clean =
    piece?.type === 'poly'
      ? piece.ring?.length >= 3
        ? piece
        : null
      : piece && piece.w >= 8 && piece.h >= 8
        ? piece
        : null;
  if (!clean) {
    draw();
    return;
  }
  ensureKeyZones(network);
  const list = site === 'b' ? network.keyZones.b : network.keyZones.a;
  if (list.length >= KEY_ZONES_MAX) {
    setStatus(`Key ${site.toUpperCase()} already has ${KEY_ZONES_MAX} zones`, 'err');
    draw();
    return;
  }
  pushUndo();
  addKeyZone(network, site, clean);
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Key ${site.toUpperCase()} #${list.length} added`);
}

function commitPosition(piece) {
  const clean =
    piece?.type === 'poly'
      ? piece.ring?.length >= 3
        ? piece
        : null
      : piece && piece.w >= 8 && piece.h >= 8
        ? piece
        : null;
  if (!clean) {
    draw();
    return;
  }
  pushUndo();
  try {
    const pos = createPosition(network, {
      name: `Pos ${(network.positions?.length || 0) + 1}`,
      level: radarLevel,
      pieces: [clean]
    });
    if (!pos) {
      undoStack.pop();
      draw();
      return;
    }
    selectedPositionIds.add(pos.id);
    highlightPositionId = pos.id;
    markDirty(true);
    syncUi();
    draw();
    setStatus(`Position "${pos.name}" added (${pos.level === 'lower' ? 'lower' : 'upper'})`);
  } catch (err) {
    undoStack.pop();
    draw();
    setStatus(err.message || 'Could not add position', 'err');
  }
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

function commitShapePiece(piece) {
  const bombSite = bombSiteForTool();
  if (bombSite) {
    commitBombSite(bombSite, piece);
    return;
  }
  const keySite = keySiteForTool();
  if (keySite) {
    commitKeyZone(keySite, piece);
    return;
  }
  if (paintTool === 'position') {
    commitPosition(piece);
    return;
  }
  draw();
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
  commitShapePiece(worldRect);
}

function finishPoly() {
  while (polyVerts.length >= 2) {
    const a = polyVerts[polyVerts.length - 1];
    const b = polyVerts[polyVerts.length - 2];
    if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 9) polyVerts.pop();
    else break;
  }
  if (polyVerts.length < 3) {
    polyVerts = [];
    draw();
    setStatus('Need at least 3 vertices', 'err');
    return;
  }
  const piece = worldPolyFromRadarVerts(mapCode, radarToWorld, polyVerts);
  polyVerts = [];
  commitShapePiece(piece);
}

function applyBrushAt(from, to, layer, erase) {
  if (layer === 'ledge') {
    if (!erase) return;
    ensureLedges(network);
    const mid = { x: (from.x + to.x) * 0.5, y: (from.y + to.y) * 0.5 };
    const w = radarToWorld(mapCode, mid.x, mid.y, {});
    const a = radarToWorld(mapCode, mid.x, mid.y, {});
    const b = radarToWorld(mapCode, mid.x + brushPx * 0.5, mid.y, {});
    const radius = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
    const n = eraseLedgesNear(network.ledges, w.x, w.y, radius);
    if (n > 0) {
      bumpLayerPaintGen(network);
      markDirty(true);
      syncUi();
      draw();
    }
    return;
  }
  ensureVisionLayers(network);
  const pieces = piecesForLayer(layer);
  const n = strokeBrush(pieces, mapCode, from, to, brushPx, { erase });
  if (n > 0) {
    bumpLayerPaintGen(network);
    markDirty(true);
    syncUi();
    draw();
  }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRegionsPanel() {
  if (!el.regions) return;
  ensureRegionHierarchy(network);
  const positions = network.positions || [];
  const zones = network.zones || [];
  const areas = network.areas || [];
  const posById = new Map(positions.map((p) => [p.id, p]));
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  const posRows = positions.length
    ? positions
        .map((p) => {
          const checked = selectedPositionIds.has(p.id) ? ' checked' : '';
          const selected = selectedPositionIds.has(p.id) ? ' is-selected' : '';
          const lvl = p.level === 'lower' ? 'lower' : 'upper';
          return `<div class="ze-item${selected}" data-pos-row="${esc(p.id)}">
            <input type="checkbox" data-sel-pos="${esc(p.id)}"${checked} />
            <input class="ze-item-name" type="text" maxlength="64" data-rename-pos="${esc(
              p.id
            )}" value="${esc(p.name)}" />
            <button type="button" class="ze-icon-btn" data-del-pos="${esc(p.id)}" title="Delete">✕</button>
            <span class="ze-item-meta"><span class="ze-level-tag">${lvl}</span> · ${esc(p.id)}</span>
          </div>`;
        })
        .join('')
    : '<p class="ze-empty">No positions yet. Use the Position tool.</p>';

  const zoneRows = zones.length
    ? zones
        .map((z) => {
          const checked = selectedZoneIds.has(z.id) ? ' checked' : '';
          const selected = selectedZoneIds.has(z.id) ? ' is-selected' : '';
          const members = (z.positionIds || [])
            .map((id) => posById.get(id)?.name || id)
            .join(', ');
          return `<div class="ze-item${selected}" data-zone-row="${esc(z.id)}">
            <input type="checkbox" data-sel-zone="${esc(z.id)}"${checked} />
            <input class="ze-item-name" type="text" maxlength="64" data-rename-zone="${esc(
              z.id
            )}" value="${esc(z.name)}" />
            <button type="button" class="ze-icon-btn" data-del-zone="${esc(z.id)}" title="Delete">✕</button>
            <span class="ze-item-members">${esc(members) || 'No positions'} ·
              <button type="button" class="btn" style="padding:2px 6px;font-size:10px" data-add-sel-pos="${esc(
                z.id
              )}">Add selected</button>
            </span>
          </div>`;
        })
        .join('')
    : '<p class="ze-empty">No zones yet. Select positions, then + Zone.</p>';

  const areaRows = areas.length
    ? areas
        .map((a) => {
          const members = (a.zoneIds || [])
            .map((id) => zoneById.get(id)?.name || id)
            .join(', ');
          return `<div class="ze-item" data-area-row="${esc(a.id)}">
            <span></span>
            <input class="ze-item-name" type="text" maxlength="64" data-rename-area="${esc(
              a.id
            )}" value="${esc(a.name)}" />
            <button type="button" class="ze-icon-btn" data-del-area="${esc(a.id)}" title="Delete">✕</button>
            <span class="ze-item-members">${esc(members) || 'No zones'} ·
              <button type="button" class="btn" style="padding:2px 6px;font-size:10px" data-add-sel-zone="${esc(
                a.id
              )}">Add selected</button>
            </span>
          </div>`;
        })
        .join('')
    : '<p class="ze-empty">No areas yet. Select zones, then + Area.</p>';

  el.regions.innerHTML = `
    <div>
      <h2 style="margin-bottom:4px">Positions <span style="font-weight:400;text-transform:none;letter-spacing:0">(${positions.length})</span></h2>
      <div class="ze-list">${posRows}</div>
    </div>
    <div>
      <h2 style="margin-bottom:4px">Zones <span style="font-weight:400;text-transform:none;letter-spacing:0">(${zones.length})</span></h2>
      <div class="ze-list">${zoneRows}</div>
    </div>
    <div>
      <h2 style="margin-bottom:4px">Areas <span style="font-weight:400;text-transform:none;letter-spacing:0">(${areas.length})</span></h2>
      <div class="ze-list">${areaRows}</div>
    </div>`;
}

function makeZoneFromSelection() {
  const ids = [...selectedPositionIds];
  if (!ids.length) {
    setStatus('Select one or more positions first', 'err');
    return;
  }
  const name = window.prompt('Zone name', `Zone ${(network.zones?.length || 0) + 1}`);
  if (name == null) return;
  pushUndo();
  const zone = createZone(network, { name, positionIds: ids });
  if (!zone) {
    undoStack.pop();
    setStatus('Could not create zone', 'err');
    return;
  }
  selectedZoneIds.add(zone.id);
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Zone "${zone.name}" created`);
}

function makeAreaFromSelection() {
  const ids = [...selectedZoneIds];
  if (!ids.length) {
    setStatus('Select one or more zones first', 'err');
    return;
  }
  const name = window.prompt('Area name', `Area ${(network.areas?.length || 0) + 1}`);
  if (name == null) return;
  pushUndo();
  const area = createArea(network, { name, zoneIds: ids });
  if (!area) {
    undoStack.pop();
    setStatus('Could not create area', 'err');
    return;
  }
  markDirty(true);
  syncUi();
  draw();
  setStatus(`Area "${area.name}" created`);
}

function finishLedgeStroke() {
  if (!ledgeStroke?.length) {
    ledgeStroke = null;
    draw();
    return;
  }
  const pts = simplifyStrokePts(ledgeStroke, 2.5);
  ledgeStroke = null;
  if (pts.length < 2) {
    draw();
    return;
  }
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  if (len < MIN_LEDGE_LEN_PX) {
    draw();
    setStatus('Ledge too short', 'err');
    return;
  }
  ensureLedges(network);
  if (network.ledges.length >= LEDGES_MAX) {
    draw();
    setStatus(`At most ${LEDGES_MAX} ledges`, 'err');
    return;
  }
  const ledge = worldLedgeFromRadarStroke(mapCode, radarToWorld, pts, 'R');
  if (!ledge) {
    draw();
    return;
  }
  pushUndo();
  network.ledges.push(ledge);
  bumpLayerPaintGen(network);
  markDirty(true);
  syncUi();
  draw();
  setStatus('Ledge added · left = drop · right = upper');
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
  if (paintTool === 'ledge') {
    ledgeStroke = [[r.x, r.y]];
    el.canvas.setPointerCapture(e.pointerId);
    updateBrushRing(e.clientX, e.clientY);
    draw();
    return;
  }
  if (isStampBrushTool() || paintTool === 'erase') {
    const layer = activeBrushLayer() || 'visionBlock';
    pushUndo();
    const erase = paintTool === 'erase';
    brushing = { last: { ...r }, layer, erase };
    applyBrushAt(r, r, layer, erase);
    el.canvas.setPointerCapture(e.pointerId);
    updateBrushRing(e.clientX, e.clientY);
    return;
  }
  if (!isShapeTool()) return;
  if (isPolyTool()) {
    polyVerts.push([r.x, r.y]);
    draw();
    return;
  }
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
  if (ledgeStroke) {
    const r = radarFromClient(e.clientX, e.clientY);
    const last = ledgeStroke[ledgeStroke.length - 1];
    if ((r.x - last[0]) ** 2 + (r.y - last[1]) ** 2 >= 1) {
      ledgeStroke.push([r.x, r.y]);
      draw();
    }
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
  if (ledgeStroke) {
    finishLedgeStroke();
    return;
  }
  if (brushing) {
    brushing = null;
    setStatus(
      paintTool === 'erase'
        ? `Erased ${eraseTarget}`
        : paintTool === 'elevated'
          ? 'Painted elevated'
          : paintTool === 'underpass'
            ? 'Painted underpass'
            : 'Painted vision block'
    );
    return;
  }
  if (drawing) tryFinishDraw();
});

el.canvas.addEventListener('pointerleave', () => {
  if (!brushing) hideBrushRing();
});
el.canvas.addEventListener('dblclick', (e) => {
  if (!isPolyTool()) return;
  e.preventDefault();
  finishPoly();
});

el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input, textarea, select')) return;
  if (isPolyTool() && polyVerts.length) {
    if (e.key === 'Escape') {
      e.preventDefault();
      polyVerts = [];
      draw();
      setStatus('Polygon cancelled');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      finishPoly();
      return;
    }
  }
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'z') return;
  e.preventDefault();
  undoLast();
});

el.toolBombA?.addEventListener('click', () => setPaintTool('bombA'));
el.toolBombB?.addEventListener('click', () => setPaintTool('bombB'));
el.toolKeyA?.addEventListener('click', () => setPaintTool('keyA'));
el.toolKeyB?.addEventListener('click', () => setPaintTool('keyB'));
el.toolPosition?.addEventListener('click', () => setPaintTool('position'));
el.toolVision?.addEventListener('click', () => setPaintTool('visionBlock'));
el.toolElevated?.addEventListener('click', () => setPaintTool('elevated'));
el.toolUnderpass?.addEventListener('click', () => setPaintTool('underpass'));
el.toolLedge?.addEventListener('click', () => setPaintTool('ledge'));
el.toolErase?.addEventListener('click', () => setPaintTool('erase'));
el.shapeRect?.addEventListener('click', () => setShapeMode('rect'));
el.shapePoly?.addEventListener('click', () => setShapeMode('poly'));
el.floorDefault?.addEventListener('click', () => setRadarLevel('default'));
el.floorLower?.addEventListener('click', () => setRadarLevel('lower'));
el.btnMakeZone?.addEventListener('click', () => makeZoneFromSelection());
el.btnMakeArea?.addEventListener('click', () => makeAreaFromSelection());
el.btnClearBombA?.addEventListener('click', () => clearBombSite('a'));
el.btnClearBombB?.addEventListener('click', () => clearBombSite('b'));
el.btnClearKeyA?.addEventListener('click', () => clearKeySite('a'));
el.btnClearKeyB?.addEventListener('click', () => clearKeySite('b'));
el.btnToggleSites?.addEventListener('click', () => {
  showSites = !showSites;
  syncUi();
  draw();
});

el.regions?.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches?.('[data-sel-pos]')) {
    const id = t.dataset.selPos;
    if (t.checked) selectedPositionIds.add(id);
    else selectedPositionIds.delete(id);
    highlightPositionId = t.checked ? id : '';
    syncUi();
    draw();
    return;
  }
  if (t.matches?.('[data-sel-zone]')) {
    const id = t.dataset.selZone;
    if (t.checked) selectedZoneIds.add(id);
    else selectedZoneIds.delete(id);
    syncUi();
    return;
  }
  if (t.matches?.('[data-rename-pos]')) {
    pushUndo();
    renamePosition(network, t.dataset.renamePos, t.value);
    markDirty(true);
    syncUi();
    draw();
    return;
  }
  if (t.matches?.('[data-rename-zone]')) {
    pushUndo();
    renameZone(network, t.dataset.renameZone, t.value);
    markDirty(true);
    syncUi();
    return;
  }
  if (t.matches?.('[data-rename-area]')) {
    pushUndo();
    renameArea(network, t.dataset.renameArea, t.value);
    markDirty(true);
    syncUi();
  }
});

el.regions?.addEventListener('click', (e) => {
  const t = e.target;
  const delPos = t.closest?.('[data-del-pos]');
  if (delPos) {
    const id = delPos.dataset.delPos;
    const pos = network.positions.find((p) => p.id === id);
    if (!confirm(`Delete position "${pos?.name || id}"?`)) return;
    pushUndo();
    deletePosition(network, id);
    selectedPositionIds.delete(id);
    if (highlightPositionId === id) highlightPositionId = '';
    markDirty(true);
    syncUi();
    draw();
    return;
  }
  const delZone = t.closest?.('[data-del-zone]');
  if (delZone) {
    const id = delZone.dataset.delZone;
    const zone = network.zones.find((z) => z.id === id);
    if (!confirm(`Delete zone "${zone?.name || id}"?`)) return;
    pushUndo();
    deleteZone(network, id);
    selectedZoneIds.delete(id);
    markDirty(true);
    syncUi();
    draw();
    return;
  }
  const delArea = t.closest?.('[data-del-area]');
  if (delArea) {
    const id = delArea.dataset.delArea;
    const area = network.areas.find((a) => a.id === id);
    if (!confirm(`Delete area "${area?.name || id}"?`)) return;
    pushUndo();
    deleteArea(network, id);
    markDirty(true);
    syncUi();
    draw();
    return;
  }
  const addPos = t.closest?.('[data-add-sel-pos]');
  if (addPos) {
    const zone = network.zones.find((z) => z.id === addPos.dataset.addSelPos);
    if (!zone) return;
    const next = new Set([...(zone.positionIds || []), ...selectedPositionIds]);
    pushUndo();
    setZoneMembers(network, zone.id, [...next]);
    markDirty(true);
    syncUi();
    draw();
    setStatus(`Updated zone "${zone.name}"`);
    return;
  }
  const addZone = t.closest?.('[data-add-sel-zone]');
  if (addZone) {
    const area = network.areas.find((a) => a.id === addZone.dataset.addSelZone);
    if (!area) return;
    const next = new Set([...(area.zoneIds || []), ...selectedZoneIds]);
    pushUndo();
    setAreaMembers(network, area.id, [...next]);
    markDirty(true);
    syncUi();
    draw();
    setStatus(`Updated area "${area.name}"`);
  }
});

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

el.btnClearUnderpass?.addEventListener('click', () => {
  ensureVisionLayers(network);
  if (!network.underpasses.length) return;
  if (!confirm('Clear all underpass paint?')) return;
  pushUndo();
  network.underpasses = [];
  bumpLayerPaintGen(network);
  markDirty(true);
  syncUi();
  draw();
  setStatus('Cleared underpass');
});

el.btnClearLedges?.addEventListener('click', () => {
  ensureLedges(network);
  if (!network.ledges.length) return;
  if (!confirm('Clear all ledges?')) return;
  pushUndo();
  network.ledges = [];
  bumpLayerPaintGen(network);
  markDirty(true);
  syncUi();
  draw();
  setStatus('Cleared ledges');
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
    ensureLedges(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    ensureRegionHierarchy(network);
  } catch {
    network = emptyNetwork(mapCode);
    ensureVisionLayers(network);
    ensureLedges(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    ensureRegionHierarchy(network);
  }
  selectedPositionIds = new Set();
  selectedZoneIds = new Set();
  highlightPositionId = '';
  savedSnapshot = snapshotOf(network);
  clearUndo();
  markDirty(false);
  syncUi();
  draw();
  setStatus('Discarded');
});

el.btnSave?.addEventListener('click', async () => {
  ensureVisionLayers(network);
  ensureLedges(network);
  ensureBombSites(network);
  ensureKeyZones(network);
  ensureRegionHierarchy(network);
  setStatus('Saving…');
  try {
    network = await saveZones(mapCode, network);
    ensureVisionLayers(network);
    ensureLedges(network);
    ensureBombSites(network);
    ensureKeyZones(network);
    ensureRegionHierarchy(network);
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

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

renderMapTabs();
resize();
loadMap(mapCode);
