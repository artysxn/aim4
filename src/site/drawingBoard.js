// ---------------------------------------------------------------------------
// site/drawingBoard.js
// Team Drawing Board: paint, drag-place utility/players, named save/load.
// Zoom/pan matches the timeline viewer.
// ---------------------------------------------------------------------------

import { RadarRenderer, SIDE_COLORS } from '../replays/viewer/radarRenderer.js';
import { radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import {
  deleteDrawingBoard,
  fetchDrawingBoard,
  listDrawingBoards,
  saveDrawingBoard
} from '../replays/api.js';
import { DrawingLayer } from '../replays/viewer/drawing.js';
import { drawUtilityMarker, utilityRadiusUnits } from '../replays/viewer/utilityMarkers.js';

export const BOARD_COLORS = [
  { id: 'white', value: '#f0f0f0', label: 'White' },
  { id: 't', value: SIDE_COLORS.T.base, label: 'T' },
  { id: 'ct', value: SIDE_COLORS.CT.base, label: 'CT' },
  { id: 'red', value: '#d91616', label: 'Red' },
  { id: 'cyan', value: '#4eb3e6', label: 'Cyan' },
  { id: 'orange', value: '#ed6d28', label: 'Orange' },
  { id: 'neon', value: '#f7ef4f', label: 'Neon' },
  { id: 'purple', value: '#8b49e3', label: 'Purple' },
  { id: 'green', value: '#45c73e', label: 'Green' }
];

const NADE_TOOLS = [
  { type: 'smokegrenade', label: 'Smoke', icon: '/icons/equipment/smokegrenade.svg' },
  { type: 'molotov', label: 'Molotov', icon: '/icons/equipment/molotov.svg' },
  { type: 'hegrenade', label: 'HE', icon: '/icons/equipment/hegrenade.svg' },
  { type: 'flashbang', label: 'Flash', icon: '/icons/equipment/flashbang.svg' }
];

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

const emptyBoard = (map = '', id = '', name = '') => ({
  id,
  name,
  map,
  updatedAt: 0,
  strokes: [],
  nades: [],
  players: []
});

function pathDroplet(ctx, tip, bot, halfW) {
  const mid = (tip + bot) * 0.35;
  ctx.beginPath();
  ctx.moveTo(0, tip);
  ctx.bezierCurveTo(halfW * 0.55, tip + (bot - tip) * 0.28, halfW, mid, halfW * 0.92, bot * 0.35);
  ctx.quadraticCurveTo(halfW * 0.75, bot, 0, bot);
  ctx.quadraticCurveTo(-halfW * 0.75, bot, -halfW * 0.92, bot * 0.35);
  ctx.bezierCurveTo(-halfW, mid, -halfW * 0.55, tip + (bot - tip) * 0.28, 0, tip);
  ctx.closePath();
}

/**
 * @param {{
 *   host: HTMLElement,
 *   teamId: string,
 *   escapeHtml: (s: string) => string,
 *   headerHtml: (title: string) => string
 * }} deps
 */
export function mountDrawingBoard({ host, teamId, escapeHtml, headerHtml }) {
  let map = '';
  let board = emptyBoard();
  /** @type {{ id: string, name: string, updatedAt: number }[]} */
  let boardList = [];
  let tool = 'paint'; // paint | erase
  let color = BOARD_COLORS[0].value;
  let nadeColor = '';
  let status = '';
  let statusBad = false;
  let saving = false;
  let selectedPlayer = -1;
  let dirty = false;
  let saveName = '';

  /** @type {{ kind: 'nade'|'player', type?: string, color?: string }|null} */
  let dragPalette = null;
  let dragGhost = null;

  const drawing = new DrawingLayer();
  drawing.setRound('board');
  drawing.onChange = () => {
    board.strokes = drawing.strokes().map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
    dirty = true;
    paint();
  };

  host.innerHTML = `
    ${headerHtml('')}
    <div class="db-shell">
      <aside class="db-tools" id="db-tools"></aside>
      <div class="db-stage">
        <canvas class="db-canvas" id="db-canvas"></canvas>
      </div>
      <aside class="db-library" id="db-library"></aside>
    </div>`;

  const toolsEl = host.querySelector('#db-tools');
  const libraryEl = host.querySelector('#db-library');
  const canvas = host.querySelector('#db-canvas');
  const stageEl = host.querySelector('.db-stage');
  const renderer = new RadarRenderer(canvas);

  function setStatus(text, bad = false) {
    status = text || '';
    statusBad = Boolean(bad);
    const node = toolsEl.querySelector('#db-status');
    if (node) {
      node.textContent = status;
      node.classList.toggle('bad', statusBad);
    }
  }

  function syncDrawingFromBoard() {
    const incoming = (board.strokes || []).map((s) => ({
      ...s,
      pts: (s.pts || []).map((p) => ({ ...p }))
    }));
    const prev = drawing.onChange;
    drawing.onChange = null;
    drawing.clear();
    const list = drawing.strokes();
    for (const s of incoming) list.push(s);
    drawing.onChange = prev;
  }

  function renderTools() {
    const mapOpts = MAP_CODES.map(
      (c) =>
        `<option value="${c}"${c === map ? ' selected' : ''}>${escapeHtml(MAPS[c]?.name || c)}</option>`
    ).join('');
    toolsEl.innerHTML = `
      <div class="db-block">
        <select class="site-select" data-map>
          <option value="">Pick a map</option>${mapOpts}
        </select>
      </div>
      <div class="db-block">
        <div class="db-tool-row">
          <button type="button" class="db-tool${tool === 'paint' ? ' active' : ''}" data-tool="paint">Paint</button>
          <button type="button" class="db-tool${tool === 'erase' ? ' active' : ''}" data-tool="erase">Erase</button>
        </div>
      </div>
      <div class="db-block">
        <div class="db-swatches">
          ${BOARD_COLORS.map(
            (c) =>
              `<button type="button" class="db-swatch${
                color === c.value ? ' active' : ''
              }" data-color="${c.value}" title="${escapeHtml(c.label)}" style="background:${c.value}"></button>`
          ).join('')}
        </div>
      </div>
      <div class="db-block">
        <div class="db-nade-row">
          ${NADE_TOOLS.map(
            (n) =>
              `<button type="button" class="db-nade" data-drag-nade="${n.type}" title="${escapeHtml(
                n.label
              )} — drag onto map">
                <img src="${n.icon}" alt="" width="16" height="20" draggable="false" />
              </button>`
          ).join('')}
          <button type="button" class="db-nade db-player-chip" data-drag-player title="Player — drag onto map">
            <span class="db-player-dot" style="background:${color}"></span>
          </button>
        </div>
      </div>
      <div class="db-block">
        <label class="ua-field">Board name
          <input class="site-input" data-save-name maxlength="80" value="${escapeHtml(
            saveName || board.name || ''
          )}" placeholder="Untitled" ${map ? '' : 'disabled'} />
        </label>
        <div class="db-actions-row">
          <button type="button" class="btn btn-sm" data-clear ${!map ? 'disabled' : ''}>Clear</button>
          <button type="button" class="btn btn-sm" data-undo ${!board.strokes.length ? 'disabled' : ''}>Undo</button>
          <button type="button" class="btn btn-sm primary" data-save ${saving || !map ? 'disabled' : ''}>
            ${saving ? '…' : 'Save'}
          </button>
        </div>
        <p class="sc-status${statusBad ? ' bad' : ''}" id="db-status">${escapeHtml(status)}</p>
      </div>
    `;
  }

  function renderLibrary() {
    if (!map) {
      libraryEl.innerHTML = `<div class="db-block"><p class="sc-note">Pick a map to load saved boards.</p></div>`;
      return;
    }
    libraryEl.innerHTML = `
      <div class="db-block">
        <span class="sc-label">Saved boards</span>
        <button type="button" class="btn btn-sm" data-new-board>New blank</button>
      </div>
      <ul class="db-board-list">
        ${
          boardList.length
            ? boardList
                .map(
                  (b) => `
            <li class="db-board-item${b.id === board.id ? ' active' : ''}">
              <button type="button" class="db-board-load" data-load-board="${escapeHtml(b.id)}">
                <span class="db-board-name">${escapeHtml(b.name || 'Untitled')}</span>
              </button>
              <button type="button" class="rp-btn-icon danger" data-del-board="${escapeHtml(
                b.id
              )}" title="Delete">×</button>
            </li>`
                )
                .join('')
            : '<li class="sc-note">No saved boards yet.</li>'
        }
      </ul>`;
  }

  async function refreshBoardList() {
    if (!map) {
      boardList = [];
      renderLibrary();
      return;
    }
    try {
      boardList = await listDrawingBoards(teamId, map);
    } catch {
      boardList = [];
    }
    renderLibrary();
  }

  async function loadMap(code) {
    map = code || '';
    board = emptyBoard(map);
    saveName = '';
    selectedPlayer = -1;
    dirty = false;
    renderer.zoom = MIN_ZOOM;
    renderer.panX = 0;
    renderer.panY = 0;
    if (!map) {
      drawing.clear();
      boardList = [];
      paint();
      renderTools();
      renderLibrary();
      return;
    }
    setStatus('Loading…');
    renderTools();
    try {
      await renderer.setMap(map);
      await refreshBoardList();
      if (boardList[0]) await loadBoard(boardList[0].id);
      else {
        board = emptyBoard(map);
        syncDrawingFromBoard();
        setStatus('Empty board — drag utility or paint, then Save.');
      }
    } catch (err) {
      board = emptyBoard(map);
      syncDrawingFromBoard();
      setStatus(err.message || 'Could not load map.', true);
    }
    dirty = false;
    renderTools();
    renderLibrary();
    paint();
  }

  async function loadBoard(id) {
    if (!map || !id) return;
    try {
      const saved = await fetchDrawingBoard(teamId, map, id);
      board = saved && saved.map ? saved : emptyBoard(map, id);
      saveName = board.name || '';
      syncDrawingFromBoard();
      dirty = false;
      selectedPlayer = -1;
      setStatus(`Loaded “${board.name || 'Untitled'}”.`);
    } catch (err) {
      setStatus(err.message || 'Could not load board.', true);
    }
    renderTools();
    renderLibrary();
    paint();
  }

  function worldRadiusPx(units, t) {
    const scale = renderer.mapScale() || 5;
    return (units / scale) * t.scale;
  }

  function drawNadeMarker(ctx, t, n) {
    const rp = worldToRadar(map, n.x, n.y, {});
    const x = rp.x * t.scale + t.ox;
    const y = rp.y * t.scale + t.oy;
    const dpr = renderer.dpr;
    ctx.save();
    // Same renderer the timeline round viewer uses, so a smoke placed here
    // matches the smoke you saw in the demo you copied it from.
    const units = utilityRadiusUnits(n.type);
    drawUtilityMarker(ctx, {
      type: n.type,
      x,
      y,
      radius: units ? worldRadiusPx(units, t) : 0,
      dpr,
      onIconLoad: () => paint()
    });
    if (n.playerColor) {
      ctx.beginPath();
      ctx.arc(x, y, 3.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = n.playerColor;
      ctx.fill();
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlayerDroplet(ctx, t, p, selected) {
    const rp = worldToRadar(map, p.x, p.y, {});
    const x = rp.x * t.scale + t.ox;
    const y = rp.y * t.scale + t.oy;
    const r = 7.5 * renderer.dpr;
    const yaw = ((-Number(p.yaw) || 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(yaw + Math.PI / 2);
    const tip = -r * 1.55;
    const bot = r * 1.05;
    const halfW = r * 0.95;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 3 * renderer.dpr;
    ctx.shadowOffsetY = 2 * renderer.dpr;
    pathDroplet(ctx, tip, bot, halfW);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (selected) {
      pathDroplet(ctx, tip, bot, halfW);
      ctx.lineWidth = Math.max(1, 1.5 * renderer.dpr);
      ctx.strokeStyle = '#ffd66b';
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, bot * 0.1, r * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = p.color || SIDE_COLORS.T.base;
    ctx.fill();
    ctx.restore();
  }

  function paint() {
    if (!map) {
      const { w, h } = renderer.resize();
      renderer.ctx.fillStyle = '#050505';
      renderer.ctx.fillRect(0, 0, w, h);
      return;
    }
    const { w, h } = renderer.paintMapBase();
    const t = renderer.viewTransform(w, h);
    const ctx = renderer.ctx;
    const strokes = drawing.visible();
    if (strokes.length) renderer.drawStrokes(ctx, t, strokes);
    for (const n of board.nades || []) drawNadeMarker(ctx, t, n);
    board.players.forEach((p, i) => drawPlayerDroplet(ctx, t, p, i === selectedPlayer));
    stageEl.classList.toggle('can-pan', renderer.zoom > MIN_ZOOM && tool === 'paint');
  }

  function setZoom(next, anchorX, anchorY) {
    const prev = renderer.zoom;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (z === prev) {
      if (z <= MIN_ZOOM) {
        renderer.panX = 0;
        renderer.panY = 0;
      }
      return;
    }
    if (z <= MIN_ZOOM) {
      renderer.zoom = MIN_ZOOM;
      renderer.panX = 0;
      renderer.panY = 0;
    } else if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
      const rect = canvas.getBoundingClientRect();
      const { w, h } = renderer.resize();
      const t0 = renderer.viewTransform(w, h);
      const cx = ((anchorX - rect.left) / rect.width) * w;
      const cy = ((anchorY - rect.top) / rect.height) * h;
      const worldX = (cx - t0.ox) / t0.scale;
      const worldY = (cy - t0.oy) / t0.scale;
      renderer.zoom = z;
      const t1 = renderer.viewTransform(w, h);
      renderer.panX += (cx - (worldX * t1.scale + t1.ox)) / renderer.dpr;
      renderer.panY += (cy - (worldY * t1.scale + t1.oy)) / renderer.dpr;
    } else {
      renderer.zoom = z;
    }
    paint();
  }

  function worldFromEvent(e) {
    if (!map) return null;
    const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
    if (!Number.isFinite(radar.x) || !Number.isFinite(radar.y)) return null;
    return radarToWorld(map, radar.x, radar.y, {});
  }

  function hitPlayer(world) {
    let best = -1;
    let bestD = 40 * 40;
    board.players.forEach((p, i) => {
      const d = (p.x - world.x) ** 2 + (p.y - world.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  function placeNade(world, type) {
    board.nades.push({
      type,
      x: Math.round(world.x),
      y: Math.round(world.y),
      playerColor: nadeColor || ''
    });
    dirty = true;
  }

  function placePlayer(world) {
    board.players.push({
      x: Math.round(world.x),
      y: Math.round(world.y),
      yaw: 0,
      color,
      side: color === SIDE_COLORS.CT.base ? 'CT' : color === SIDE_COLORS.T.base ? 'T' : ''
    });
    selectedPlayer = board.players.length - 1;
    dirty = true;
  }

  function ensureGhost() {
    if (dragGhost) return dragGhost;
    dragGhost = document.createElement('div');
    dragGhost.className = 'db-drag-ghost';
    document.body.appendChild(dragGhost);
    return dragGhost;
  }

  function clearDrag() {
    dragPalette = null;
    if (dragGhost) {
      dragGhost.remove();
      dragGhost = null;
    }
  }

  // ---- canvas input (viewer-style zoom / pan) -----------------------------

  let drawingStroke = false;
  let erasingStroke = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let rotating = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (!map) return;
    e.preventDefault();

    // Middle-click pans (when zoomed) and always captures so the page does not scroll.
    if (e.button === 1) {
      panning = renderer.zoom > MIN_ZOOM;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      if (panning) stageEl.classList.add('panning');
      return;
    }

    const world = worldFromEvent(e);
    if (!world) return;

    if (e.button === 0 && selectedPlayer >= 0 && e.shiftKey) {
      rotating = true;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 0 && tool === 'paint') {
      const hit = hitPlayer(world);
      if (hit >= 0) {
        selectedPlayer = hit;
        paint();
        return;
      }
      drawing.color = color;
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      drawing.begin(radar);
      drawingStroke = true;
      canvas.setPointerCapture(e.pointerId);
      paint();
      return;
    }

    if (tool === 'erase' || e.button === 2) {
      // `radar.scale` is CSS pixels per radar unit; `viewTransform().scale` is
      // device pixels. Passing the latter shrank the eraser's reach by the
      // device pixel ratio, so on a retina screen you had to land within about
      // 4px of a line to take it. Erasing also only fired on pointerdown, so
      // dragging the eraser across a drawing did nothing.
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      erasingStroke = true;
      canvas.setPointerCapture(e.pointerId);
      if (drawing.eraseAt(radar, radar.scale)) dirty = true;
      paint();
      renderTools();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panning) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.panX += dx;
      renderer.panY += dy;
      paint();
      return;
    }
    if (rotating && selectedPlayer >= 0) {
      const world = worldFromEvent(e);
      const p = board.players[selectedPlayer];
      if (world && p) {
        p.yaw = Math.round((Math.atan2(world.y - p.y, world.x - p.x) * 180) / Math.PI);
        dirty = true;
        paint();
      }
      return;
    }
    if (erasingStroke) {
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      if (drawing.eraseAt(radar, radar.scale)) {
        dirty = true;
        paint();
        renderTools();
      }
      return;
    }
    if (drawingStroke) {
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      drawing.extend(radar, radar.scale);
      paint();
    }
  });

  const endPointer = (e) => {
    if (drawingStroke) {
      drawing.end();
      drawingStroke = false;
      dirty = true;
      renderTools();
    }
    erasingStroke = false;
    if (panning) {
      panning = false;
      stageEl.classList.remove('panning');
    }
    rotating = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Block browser autoscroll / page wheel while interacting with the radar.
  canvas.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 1) e.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!map) return;
      e.preventDefault();
      if (selectedPlayer >= 0 && e.shiftKey) {
        const p = board.players[selectedPlayer];
        p.yaw = Math.round((((p.yaw || 0) + (e.deltaY > 0 ? 12 : -12) + 540) % 360) - 180);
        dirty = true;
        paint();
        return;
      }
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom(renderer.zoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  // ---- palette drag -------------------------------------------------------

  toolsEl.addEventListener('pointerdown', (e) => {
    const nadeBtn = e.target.closest('[data-drag-nade]');
    const playerBtn = e.target.closest('[data-drag-player]');
    if (!nadeBtn && !playerBtn) return;
    if (!map) {
      setStatus('Pick a map first.', true);
      return;
    }
    e.preventDefault();
    if (nadeBtn) {
      dragPalette = { kind: 'nade', type: nadeBtn.dataset.dragNade };
      const ghost = ensureGhost();
      ghost.innerHTML = nadeBtn.innerHTML;
    } else {
      dragPalette = { kind: 'player', color };
      const ghost = ensureGhost();
      ghost.innerHTML = `<span class="db-player-dot" style="background:${color}"></span>`;
    }
    nadeBtn?.setPointerCapture?.(e.pointerId);
    playerBtn?.setPointerCapture?.(e.pointerId);
    const ghost = ensureGhost();
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
  });

  window.addEventListener('pointermove', onWinMove);
  window.addEventListener('pointerup', onWinUp);

  function onWinMove(e) {
    if (!dragPalette || !dragGhost) return;
    dragGhost.style.left = `${e.clientX}px`;
    dragGhost.style.top = `${e.clientY}px`;
  }

  function onWinUp(e) {
    if (!dragPalette) return;
    const rect = canvas.getBoundingClientRect();
    const over =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (over && map) {
      const world = worldFromEvent(e);
      if (world) {
        if (dragPalette.kind === 'nade') placeNade(world, dragPalette.type);
        else placePlayer(world);
        paint();
        renderTools();
      }
    }
    clearDrag();
  }

  toolsEl.addEventListener('change', (e) => {
    if (e.target.closest('[data-map]')) loadMap(e.target.value);
  });

  toolsEl.addEventListener('input', (e) => {
    const name = e.target.closest('[data-save-name]');
    if (name) saveName = name.value;
  });

  toolsEl.addEventListener('click', async (e) => {
    const t = e.target;
    const toolBtn = t.closest('[data-tool]');
    if (toolBtn) {
      tool = toolBtn.dataset.tool;
      renderTools();
      paint();
      return;
    }
    const swatch = t.closest('[data-color]');
    if (swatch) {
      color = swatch.dataset.color;
      nadeColor = color;
      if (selectedPlayer >= 0) {
        board.players[selectedPlayer].color = color;
        dirty = true;
        paint();
      }
      renderTools();
      return;
    }
    if (t.closest('[data-undo]')) {
      const list = drawing.strokes();
      list.pop();
      board.strokes = list.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
      dirty = true;
      paint();
      renderTools();
      return;
    }
    if (t.closest('[data-clear]')) {
      if (!window.confirm('Clear this board?')) return;
      const keep = { id: board.id, name: board.name || saveName };
      board = emptyBoard(map, keep.id, keep.name);
      syncDrawingFromBoard();
      dirty = true;
      paint();
      renderTools();
      return;
    }
    if (t.closest('[data-save]')) {
      if (!map || saving) return;
      const name = (saveName || board.name || 'Untitled').trim() || 'Untitled';
      saving = true;
      renderTools();
      try {
        board.strokes = drawing.strokes().map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
        board.name = name;
        board = await saveDrawingBoard(teamId, map, board);
        saveName = board.name;
        dirty = false;
        setStatus(`Saved “${board.name}”.`);
        await refreshBoardList();
      } catch (err) {
        setStatus(err.message || 'Could not save.', true);
      }
      saving = false;
      renderTools();
      renderLibrary();
    }
  });

  libraryEl.addEventListener('click', async (e) => {
    const loadBtn = e.target.closest('[data-load-board]');
    if (loadBtn) {
      if (dirty && !window.confirm('Discard unsaved changes?')) return;
      await loadBoard(loadBtn.dataset.loadBoard);
      return;
    }
    if (e.target.closest('[data-new-board]')) {
      if (dirty && !window.confirm('Discard unsaved changes?')) return;
      board = emptyBoard(map);
      saveName = '';
      syncDrawingFromBoard();
      dirty = false;
      selectedPlayer = -1;
      setStatus('New blank board.');
      renderTools();
      renderLibrary();
      paint();
      return;
    }
    const del = e.target.closest('[data-del-board]');
    if (del) {
      const id = del.dataset.delBoard;
      if (!window.confirm('Delete this board?')) return;
      try {
        await deleteDrawingBoard(teamId, map, id);
        if (board.id === id) {
          board = emptyBoard(map);
          saveName = '';
          syncDrawingFromBoard();
          dirty = false;
        }
        await refreshBoardList();
        setStatus('Deleted.');
        renderTools();
        paint();
      } catch (err) {
        setStatus(err.message || 'Could not delete.', true);
      }
    }
  });

  window.addEventListener('resize', paint);
  renderTools();
  renderLibrary();
  paint();

  return {
    destroy() {
      window.removeEventListener('resize', paint);
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      clearDrag();
      host.innerHTML = '';
    }
  };
}
