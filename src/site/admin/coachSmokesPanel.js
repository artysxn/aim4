// ---------------------------------------------------------------------------
// src/site/admin/coachSmokesPanel.js
// Admin editor for private Autocoach utility landing spots.
// Ids: mapname_side_name_utilitytype (e.g. ancient_t_window_smoke).
// Landing position only — no throw / setpos.
// ---------------------------------------------------------------------------

import { RadarRenderer } from '../../replays/viewer/radarRenderer.js';
import { radarToWorld, worldToRadar } from '../../replays/viewer/mapCalibration.js';
import { MAPS, MAP_CODES } from '../../replays/shared/roundId.js';
import { drawUtilityMarker, utilityRadiusUnits } from '../../replays/viewer/utilityMarkers.js';
import {
  COACH_SIDES,
  COACH_UTIL_TOOLS,
  coachUtilityId,
  uniqueCoachUtilityId
} from '../../replays/coach/coachUtilityIds.js';
import { adminApi } from './adminApi.js';
import { el } from './dom.js';

const MERGE_UNITS = 75;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

function emptyArchive(map = '') {
  return { map, updatedAt: 0, utilities: [], smokes: [] };
}

function listOf(archive) {
  if (Array.isArray(archive?.utilities)) return archive.utilities;
  if (Array.isArray(archive?.smokes)) return archive.smokes;
  return [];
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function cloneArchive(a) {
  return JSON.parse(JSON.stringify(a));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function refreshId(entry, mapCode, usedExceptSelf) {
  const used = new Set(usedExceptSelf);
  const base = coachUtilityId(mapCode, entry.side, entry.name || 'unnamed', entry.type);
  entry.id = uniqueCoachUtilityId(base, used);
  return entry.id;
}

/** @returns {HTMLElement} */
export function coachSmokesPanel() {
  const root = el('div', 'admin-panel admin-coach-smokes');
  const host = el('div', 'admin-coach-smokes-host');
  root.appendChild(
    el(
      'p',
      'admin-note',
      'Private Autocoach utilities. Drag a nade onto the map, set side + name, Save. Id becomes map_side_name_type (e.g. ancient_t_window_smoke). Landing only.'
    )
  );
  root.appendChild(host);

  let map = '';
  let archive = emptyArchive();
  let checkpoint = null;
  let selectedId = '';
  let status = '';
  let statusBad = false;
  let saving = false;
  let dirty = false;
  /** @type {{ type: string }|null} */
  let dragPalette = null;
  let dragGhost = null;
  /** Dragging an existing landing to reposition. */
  let movingId = '';

  host.innerHTML = `
    <div class="ua-shell">
      <aside class="ua-tools" id="cs-tools"></aside>
      <div class="ua-stage">
        <canvas class="ua-canvas" id="cs-canvas"></canvas>
      </div>
      <aside class="ua-detail" id="cs-detail"></aside>
    </div>`;

  const toolsEl = host.querySelector('#cs-tools');
  const detailEl = host.querySelector('#cs-detail');
  const canvas = host.querySelector('#cs-canvas');
  const stageEl = host.querySelector('.ua-stage');
  const renderer = new RadarRenderer(canvas);

  function entries() {
    return listOf(archive);
  }

  function setStatus(text, bad = false) {
    status = text || '';
    statusBad = Boolean(bad);
    const node = toolsEl.querySelector('#cs-status');
    if (node) {
      node.textContent = status;
      node.classList.toggle('bad', statusBad);
    }
  }

  function selected() {
    return entries().find((g) => g.id === selectedId) || null;
  }

  function usedIds(exceptId = '') {
    return new Set(entries().filter((g) => g.id !== exceptId).map((g) => g.id));
  }

  function beginSession() {
    if (!checkpoint) checkpoint = cloneArchive(archive);
  }

  function syncListAlias() {
    archive.utilities = entries();
    archive.smokes = archive.utilities;
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
        <div class="db-nade-row">
          ${COACH_UTIL_TOOLS.map(
            (n) =>
              `<button type="button" class="db-nade" data-drag-nade="${n.type}" title="${escapeHtml(
                n.label
              )} — drag onto map">
                <img src="${n.icon}" alt="" width="16" height="20" draggable="false" />
              </button>`
          ).join('')}
        </div>
        <p class="sc-note">Drag onto the map to place a landing spot. Drag a placed nade to move it.</p>
      </div>
      <div class="db-block">
        <p class="sc-status${statusBad ? ' bad' : ''}" id="cs-status">${escapeHtml(status)}</p>
      </div>
    `;
  }

  function renderDetail() {
    const g = selected();
    if (!g) {
      detailEl.innerHTML = `<div class="db-block">
        <p class="sc-note">Select a utility on the map, or drag one from the left to create.</p>
      </div>`;
      return;
    }
    const sideOpts = COACH_SIDES.map(
      (s) =>
        `<option value="${s.value}"${g.side === s.value ? ' selected' : ''}>${escapeHtml(
          s.label
        )}</option>`
    ).join('');
    const typeOpts = COACH_UTIL_TOOLS.map(
      (t) =>
        `<option value="${t.type}"${g.type === t.type ? ' selected' : ''}>${escapeHtml(
          t.label
        )}</option>`
    ).join('');
    const showActions = dirty;
    detailEl.innerHTML = `
      <div class="db-block">
        <span class="sc-label">Id</span>
        <code class="ua-id" style="display:block;word-break:break-all;margin-top:4px">${escapeHtml(
          g.id
        )}</code>
      </div>
      <div class="db-block">
        <label class="ua-field">
          <span class="sc-label">Name</span>
          <input class="site-input" data-name maxlength="80" value="${escapeHtml(g.name || '')}"
            placeholder="window, heaven, …" />
        </label>
      </div>
      <div class="db-block">
        <label class="ua-field">
          <span class="sc-label">Side</span>
          <select class="site-select" data-side>${sideOpts}</select>
        </label>
      </div>
      <div class="db-block">
        <label class="ua-field">
          <span class="sc-label">Type</span>
          <select class="site-select" data-type>${typeOpts}</select>
        </label>
      </div>
      ${
        showActions
          ? `<div class="db-block db-actions-row">
              <button type="button" class="btn btn-sm primary" data-save ${
                saving ? 'disabled' : ''
              }>${saving ? '…' : 'Save'}</button>
              <button type="button" class="btn btn-sm" data-cancel>Cancel</button>
            </div>`
          : ''
      }
      <div class="db-block" style="margin-top:auto">
        <button type="button" class="btn btn-sm danger" data-drop>Delete</button>
      </div>
    `;
  }

  function rekeySelected() {
    const g = selected();
    if (!g || !map) return;
    const next = refreshId(g, map, usedIds(g.id));
    selectedId = next;
    syncListAlias();
  }

  async function loadMap(code) {
    map = code || '';
    archive = emptyArchive(map);
    selectedId = '';
    checkpoint = null;
    dirty = false;
    renderer.zoom = MIN_ZOOM;
    renderer.panX = 0;
    renderer.panY = 0;
    if (!map) {
      paint();
      renderTools();
      renderDetail();
      return;
    }
    setStatus('Loading…');
    renderTools();
    try {
      await renderer.setMap(map);
      const saved = await adminApi.coachSmokes(map);
      archive = saved && saved.map ? saved : emptyArchive(map);
      if (!Array.isArray(archive.utilities)) {
        archive.utilities = Array.isArray(archive.smokes) ? archive.smokes : [];
      }
      syncListAlias();
      dirty = false;
      const n = entries().length;
      setStatus(n ? `${n} utilit${n === 1 ? 'y' : 'ies'} on this map.` : 'Drag a nade onto the map to start.');
    } catch (err) {
      archive = emptyArchive(map);
      setStatus(err.message || 'Could not load.', true);
    }
    renderTools();
    renderDetail();
    paint();
  }

  function worldRadiusPx(units, t) {
    const scale = renderer.mapScale() || 5;
    return (units / scale) * t.scale;
  }

  function drawEntry(ctx, t, g, active) {
    const rp = worldToRadar(map, g.detonate.x, g.detonate.y, {});
    const x = rp.x * t.scale + t.ox;
    const y = rp.y * t.scale + t.oy;
    const dpr = renderer.dpr;
    const type = g.type || 'smokegrenade';
    ctx.save();
    const units = utilityRadiusUnits(type);
    drawUtilityMarker(ctx, {
      type,
      x,
      y,
      radius: units ? worldRadiusPx(units, t) : 0,
      dpr,
      active,
      onIconLoad: () => paint()
    });
    const label = g.name || g.id;
    if (active || label) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${11 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, y + 10 * dpr);
    }
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
    for (const g of entries()) {
      drawEntry(renderer.ctx, t, g, g.id === selectedId);
    }
    stageEl.classList.toggle('can-pan', renderer.zoom > MIN_ZOOM);
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

  function hitEntry(world) {
    let best = null;
    let bestD = 90 * 90;
    for (const g of entries()) {
      const d = dist2(g.detonate, world);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  let panning = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!map) return;
    e.preventDefault();

    if (e.button === 1 || (e.button === 0 && renderer.zoom > MIN_ZOOM && e.altKey)) {
      panning = renderer.zoom > MIN_ZOOM;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      if (panning) stageEl.classList.add('panning');
      return;
    }

    if (e.button !== 0) return;
    const world = worldFromEvent(e);
    if (!world) return;
    const hit = hitEntry(world);
    selectedId = hit?.id || '';
    if (hit) {
      movingId = hit.id;
      canvas.setPointerCapture(e.pointerId);
    }
    paint();
    renderDetail();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (movingId) {
      const world = worldFromEvent(e);
      const g = entries().find((x) => x.id === movingId);
      if (world && g) {
        beginSession();
        g.detonate = { x: Math.round(world.x), y: Math.round(world.y) };
        dirty = true;
        if (!detailEl.querySelector('[data-save]')) renderDetail();
        paint();
      }
      return;
    }
    if (!panning) return;
    renderer.panX += e.clientX - lastX;
    renderer.panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    paint();
  });

  const endPan = (e) => {
    if (movingId) {
      movingId = '';
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      renderDetail();
      return;
    }
    if (!panning) return;
    panning = false;
    stageEl.classList.remove('panning');
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 1) e.preventDefault();
    },
    { passive: false }
  );
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!map) return;
      e.preventDefault();
      setZoom(renderer.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
    },
    { passive: false }
  );

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

  toolsEl.addEventListener('pointerdown', (e) => {
    const nadeBtn = e.target.closest('[data-drag-nade]');
    if (!nadeBtn) return;
    if (!map) {
      setStatus('Pick a map first.', true);
      return;
    }
    e.preventDefault();
    dragPalette = { type: nadeBtn.dataset.dragNade };
    const ghost = ensureGhost();
    ghost.innerHTML = nadeBtn.innerHTML;
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    nadeBtn.setPointerCapture(e.pointerId);
  });

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
        beginSession();
        const near = entries().find(
          (g) =>
            g.type === dragPalette.type && dist2(g.detonate, world) <= MERGE_UNITS * MERGE_UNITS
        );
        if (near) {
          selectedId = near.id;
          setStatus(`Selected ${near.name || near.id}.`);
        } else {
          const entry = {
            id: '',
            name: '',
            side: 'both',
            type: dragPalette.type,
            detonate: { x: Math.round(world.x), y: Math.round(world.y) }
          };
          entry.id = refreshId(entry, map, usedIds());
          archive.utilities = [...entries(), entry];
          syncListAlias();
          selectedId = entry.id;
          dirty = true;
          setStatus(`Placed ${entry.id}. Set name/side and Save.`);
        }
        paint();
        renderDetail();
        renderTools();
      }
    }
    clearDrag();
  }

  window.addEventListener('pointermove', onWinMove);
  window.addEventListener('pointerup', onWinUp);

  toolsEl.addEventListener('change', (e) => {
    if (e.target.closest('[data-map]')) loadMap(e.target.value);
  });

  detailEl.addEventListener('input', (e) => {
    const g = selected();
    if (!g) return;
    const name = e.target.closest('[data-name]');
    if (!name) return;
    beginSession();
    g.name = name.value.slice(0, 80);
    rekeySelected();
    dirty = true;
    const idNode = detailEl.querySelector('.ua-id');
    if (idNode) idNode.textContent = g.id;
    else renderDetail();
  });

  detailEl.addEventListener('change', (e) => {
    const g = selected();
    if (!g) return;
    const side = e.target.closest('[data-side]');
    const type = e.target.closest('[data-type]');
    if (!side && !type) return;
    beginSession();
    if (side) g.side = side.value;
    if (type) g.type = type.value;
    rekeySelected();
    dirty = true;
    paint();
    renderDetail();
  });

  detailEl.addEventListener('click', async (e) => {
    const g = selected();
    if (e.target.closest('[data-save]')) {
      if (!map || saving) return;
      const missing = entries().filter((u) => !String(u.name || '').trim());
      if (missing.length) {
        setStatus('Every utility needs a name before Save.', true);
        return;
      }
      saving = true;
      renderDetail();
      try {
        syncListAlias();
        archive = await adminApi.saveCoachSmokes(map, archive);
        if (!Array.isArray(archive.utilities)) {
          archive.utilities = Array.isArray(archive.smokes) ? archive.smokes : [];
        }
        syncListAlias();
        // Keep selection after server rekeys.
        if (selectedId && !entries().some((u) => u.id === selectedId)) {
          selectedId = entries()[0]?.id || '';
        }
        dirty = false;
        checkpoint = null;
        setStatus('Saved.');
      } catch (err) {
        setStatus(err.message || 'Could not save.', true);
      }
      saving = false;
      renderDetail();
      renderTools();
      paint();
      return;
    }
    if (e.target.closest('[data-cancel]')) {
      if (checkpoint) archive = checkpoint;
      checkpoint = null;
      dirty = false;
      selectedId = '';
      setStatus('Cancelled.');
      paint();
      renderDetail();
      renderTools();
      return;
    }
    if (!g) return;
    if (e.target.closest('[data-drop]')) {
      if (!window.confirm(`Delete ${g.name || g.id}?`)) return;
      beginSession();
      archive.utilities = entries().filter((x) => x.id !== g.id);
      syncListAlias();
      selectedId = '';
      dirty = true;
      try {
        archive = await adminApi.saveCoachSmokes(map, archive);
        if (!Array.isArray(archive.utilities)) {
          archive.utilities = Array.isArray(archive.smokes) ? archive.smokes : [];
        }
        syncListAlias();
        dirty = false;
        checkpoint = null;
        setStatus('Deleted.');
      } catch (err) {
        setStatus(err.message || 'Could not delete.', true);
      }
      paint();
      renderDetail();
      renderTools();
    }
  });

  window.addEventListener('resize', paint);
  renderTools();
  renderDetail();
  paint();

  root._stopPolling = () => {
    window.removeEventListener('resize', paint);
    window.removeEventListener('pointermove', onWinMove);
    window.removeEventListener('pointerup', onWinUp);
    clearDrag();
  };

  return root;
}
