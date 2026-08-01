// ---------------------------------------------------------------------------
// site/drawingBoard.js
// Team Drawing Board: paint, place utility with player-color dots, place/rotate
// player droplets. Session editing with an explicit Save to the team.
// ---------------------------------------------------------------------------

import { RadarRenderer, SIDE_COLORS } from '../replays/viewer/radarRenderer.js';
import { radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import { fetchDrawingBoard, saveDrawingBoard } from '../replays/api.js';
import { DrawingLayer } from '../replays/viewer/drawing.js';

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

const emptyBoard = (map = '') => ({
  map,
  updatedAt: 0,
  strokes: [],
  nades: [],
  players: []
});

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
  let tool = 'paint'; // paint | erase | nade | player
  let nadeType = 'smokegrenade';
  let color = BOARD_COLORS[0].value;
  let nadeColor = '';
  let status = '';
  let statusBad = false;
  let saving = false;
  let selectedPlayer = -1;
  let dirty = false;

  const drawing = new DrawingLayer();
  drawing.setRound('board');
  drawing.onChange = () => {
    board.strokes = drawing.strokes().map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
    dirty = true;
    paint();
  };

  host.innerHTML = `
    ${headerHtml('Drawing Board')}
    <div class="db-shell">
      <aside class="db-tools" id="db-tools"></aside>
      <div class="db-stage">
        <canvas class="db-canvas" id="db-canvas"></canvas>
      </div>
    </div>`;

  const toolsEl = host.querySelector('#db-tools');
  const canvas = host.querySelector('#db-canvas');
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

  function renderTools() {
    const mapOpts = MAP_CODES.map(
      (c) =>
        `<option value="${c}"${c === map ? ' selected' : ''}>${escapeHtml(MAPS[c]?.name || c)}</option>`
    ).join('');
    toolsEl.innerHTML = `
      <div class="db-block">
        <span class="sc-label">Map</span>
        <select class="site-select" data-map>
          <option value="">Pick a map</option>${mapOpts}
        </select>
      </div>
      <div class="db-block">
        <span class="sc-label">Tool</span>
        <div class="db-tool-row">
          <button type="button" class="db-tool${tool === 'paint' ? ' active' : ''}" data-tool="paint">Paint</button>
          <button type="button" class="db-tool${tool === 'erase' ? ' active' : ''}" data-tool="erase">Erase</button>
          <button type="button" class="db-tool${tool === 'player' ? ' active' : ''}" data-tool="player">Player</button>
        </div>
      </div>
      <div class="db-block">
        <span class="sc-label">Colors</span>
        <div class="db-swatches">
          ${BOARD_COLORS.map(
            (c) =>
              `<button type="button" class="db-swatch${
                color === c.value ? ' active' : ''
              }" data-color="${c.value}" title="${escapeHtml(c.label)}" style="background:${c.value}"></button>`
          ).join('')}
        </div>
        <p class="sc-note">With a grenade selected, a color sets the player dot.</p>
      </div>
      <div class="db-block">
        <span class="sc-label">Utility</span>
        <div class="db-nade-row">
          ${NADE_TOOLS.map(
            (n) =>
              `<button type="button" class="db-nade${
                tool === 'nade' && nadeType === n.type ? ' active' : ''
              }" data-nade="${n.type}" title="${escapeHtml(n.label)}">
                <img src="${n.icon}" alt="" width="16" height="20" draggable="false" />
              </button>`
          ).join('')}
        </div>
        ${
          nadeColor
            ? `<p class="sc-note">Dot: <span class="db-dot-preview" style="background:${nadeColor}"></span></p>`
            : '<p class="sc-note">Optional: pick a color for the thrower dot.</p>'
        }
      </div>
      <div class="db-block db-actions">
        <button type="button" class="btn btn-sm" data-undo ${!board.strokes.length ? 'disabled' : ''}>Undo stroke</button>
        <button type="button" class="btn btn-sm" data-clear>Clear board</button>
        <button type="button" class="btn primary" data-save ${saving || !map ? 'disabled' : ''}>
          ${saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <p class="sc-status${statusBad ? ' bad' : ''}" id="db-status">${escapeHtml(status)}</p>
      </div>
      <p class="sc-note">Paint freehand. Place utility / players on the radar. Scroll to zoom, drag empty space to pan. With a player selected, scroll rotates it.</p>
    `;
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

  async function loadMap(code) {
    map = code || '';
    board = emptyBoard(map);
    selectedPlayer = -1;
    dirty = false;
    if (!map) {
      drawing.clear();
      paint();
      renderTools();
      return;
    }
    setStatus('Loading…');
    renderTools();
    try {
      await renderer.setMap(map);
      const saved = await fetchDrawingBoard(teamId, map);
      board = saved && saved.map ? saved : emptyBoard(map);
      syncDrawingFromBoard();
      dirty = false;
      setStatus(board.updatedAt ? 'Loaded saved board.' : 'Empty board — paint and Save.');
    } catch (err) {
      board = emptyBoard(map);
      syncDrawingFromBoard();
      setStatus(err.message || 'Could not load board.', true);
    }
    renderTools();
    paint();
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

    // Placed utility — gray ring + optional player-color center (pic 1).
    for (const n of board.nades || []) {
      const rp = worldToRadar(map, n.x, n.y, {});
      const x = rp.x * t.scale + t.ox;
      const y = rp.y * t.scale + t.oy;
      const r = 14 * renderer.dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 205, 215, 0.35)';
      ctx.fill();
      ctx.lineWidth = 1.5 * renderer.dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      if (n.playerColor) {
        ctx.beginPath();
        ctx.arc(x, y, 4.2 * renderer.dpr, 0, Math.PI * 2);
        ctx.fillStyle = n.playerColor;
        ctx.fill();
        ctx.lineWidth = 1.2 * renderer.dpr;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
      }
      ctx.restore();
    }

    // Player droplets.
    board.players.forEach((p, i) => {
      const rp = worldToRadar(map, p.x, p.y, {});
      const x = rp.x * t.scale + t.ox;
      const y = rp.y * t.scale + t.oy;
      const rad = ((-Number(p.yaw) || 0) * Math.PI) / 180;
      const r = 7.5 * renderer.dpr;
      const selected = i === selectedPlayer;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * (selected ? 1.2 : 1), 0, Math.PI * 2);
      ctx.fillStyle = p.color || SIDE_COLORS.T.base;
      ctx.fill();
      ctx.lineWidth = (selected ? 2.4 : 1.4) * renderer.dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(rad) * r * 1.8, y + Math.sin(rad) * r * 1.8);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6 * renderer.dpr;
      ctx.stroke();
      ctx.restore();
    });
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

  // ---- input --------------------------------------------------------------

  let drawingStroke = false;
  let panning = false;
  let panLast = null;
  let rotating = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (!map) return;
    if (e.button === 1 || (e.button === 0 && e.altKey) || tool === 'pan') {
      panning = true;
      panLast = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const world = worldFromEvent(e);
    if (!world) return;

    if (tool === 'player') {
      const hit = hitPlayer(world);
      if (hit >= 0 && e.shiftKey) {
        selectedPlayer = hit;
        rotating = true;
        canvas.setPointerCapture(e.pointerId);
        paint();
        return;
      }
      if (hit >= 0) {
        selectedPlayer = hit;
        paint();
        renderTools();
        return;
      }
      board.players.push({
        x: Math.round(world.x),
        y: Math.round(world.y),
        yaw: 0,
        color,
        side: color === SIDE_COLORS.CT.base ? 'CT' : color === SIDE_COLORS.T.base ? 'T' : ''
      });
      selectedPlayer = board.players.length - 1;
      dirty = true;
      paint();
      renderTools();
      return;
    }

    if (tool === 'nade') {
      board.nades.push({
        type: nadeType,
        x: Math.round(world.x),
        y: Math.round(world.y),
        playerColor: nadeColor || ''
      });
      dirty = true;
      paint();
      renderTools();
      return;
    }

    if (tool === 'erase' || e.button === 2) {
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      const { w, h } = renderer.resize();
      const t = renderer.viewTransform(w, h);
      drawing.eraseAt(radar, t.scale);
      dirty = true;
      paint();
      renderTools();
      return;
    }

    if (tool === 'paint' && e.button === 0) {
      drawing.color = color;
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      drawing.begin(radar);
      drawingStroke = true;
      canvas.setPointerCapture(e.pointerId);
      paint();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panning && panLast) {
      const dx = e.clientX - panLast.x;
      const dy = e.clientY - panLast.y;
      panLast = { x: e.clientX, y: e.clientY };
      const { w, h } = renderer.resize();
      const t = renderer.viewTransform(w, h);
      renderer.panX += dx / Math.max(t.scale, 1e-6);
      renderer.panY += dy / Math.max(t.scale, 1e-6);
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
    if (drawingStroke) {
      const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
      const { w, h } = renderer.resize();
      const t = renderer.viewTransform(w, h);
      drawing.extend(radar, t.scale);
      paint();
    }
  });

  canvas.addEventListener('pointerup', () => {
    if (drawingStroke) {
      drawing.end();
      drawingStroke = false;
      dirty = true;
      renderTools();
    }
    panning = false;
    panLast = null;
    rotating = false;
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!map) return;
      e.preventDefault();
      if (selectedPlayer >= 0 && tool === 'player' && !e.ctrlKey) {
        const p = board.players[selectedPlayer];
        p.yaw = Math.round((((p.yaw || 0) + (e.deltaY > 0 ? 12 : -12) + 540) % 360) - 180);
        dirty = true;
        paint();
        return;
      }
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      renderer.zoom = Math.max(0.5, Math.min(8, (renderer.zoom || 1) * factor));
      paint();
    },
    { passive: false }
  );

  toolsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-map]');
    if (sel) loadMap(sel.value);
  });

  toolsEl.addEventListener('click', async (e) => {
    const t = e.target;
    const toolBtn = t.closest('[data-tool]');
    if (toolBtn) {
      tool = toolBtn.dataset.tool;
      nadeColor = tool === 'nade' ? nadeColor : nadeColor;
      renderTools();
      return;
    }
    const swatch = t.closest('[data-color]');
    if (swatch) {
      color = swatch.dataset.color;
      if (tool === 'nade') nadeColor = color;
      if (selectedPlayer >= 0 && tool === 'player') {
        board.players[selectedPlayer].color = color;
        dirty = true;
        paint();
      }
      renderTools();
      return;
    }
    const nadeBtn = t.closest('[data-nade]');
    if (nadeBtn) {
      tool = 'nade';
      nadeType = nadeBtn.dataset.nade;
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
      board = emptyBoard(map);
      syncDrawingFromBoard();
      dirty = true;
      paint();
      renderTools();
      return;
    }
    if (t.closest('[data-save]')) {
      if (!map || saving) return;
      saving = true;
      renderTools();
      try {
        board.strokes = drawing.strokes().map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
        board = await saveDrawingBoard(teamId, map, board);
        dirty = false;
        setStatus('Saved.');
      } catch (err) {
        setStatus(err.message || 'Could not save.', true);
      }
      saving = false;
      renderTools();
    }
  });

  window.addEventListener('resize', paint);
  renderTools();
  paint();

  return {
    destroy() {
      window.removeEventListener('resize', paint);
      host.innerHTML = '';
    }
  };
}
