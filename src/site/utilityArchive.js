// ---------------------------------------------------------------------------
// site/utilityArchive.js
// Per-team utility database: drag grenades onto the map, click throw origins,
// Save / Cancel on the right. Zoom/pan matches the timeline viewer.
// ---------------------------------------------------------------------------

import { RadarRenderer } from '../replays/viewer/radarRenderer.js';
import { radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import { fetchUtilityArchive, saveUtilityArchive } from '../replays/api.js';
import { drawUtilityMarker, utilityRadiusUnits } from '../replays/viewer/utilityMarkers.js';

const MERGE_UNITS = 75;
const MAX_COMMENT = 100;
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

const NADE_TOOLS = [
  { type: 'smokegrenade', label: 'Smoke', icon: '/icons/equipment/smokegrenade.svg' },
  { type: 'molotov', label: 'Molotov', icon: '/icons/equipment/molotov.svg' },
  { type: 'hegrenade', label: 'HE', icon: '/icons/equipment/hegrenade.svg' },
  { type: 'flashbang', label: 'Flash', icon: '/icons/equipment/flashbang.svg' }
];

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function emptyArchive(map = '') {
  return { map, updatedAt: 0, grenades: [] };
}

function newId(used) {
  for (let i = 0; i < 40; i++) {
    let id = '';
    for (let j = 0; j < 4; j++) id += ID_ALPHABET[(Math.random() * ID_ALPHABET.length) | 0];
    if (!used.has(id)) return id;
  }
  return `x${Date.now().toString(36).slice(-3)}`;
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function cloneArchive(a) {
  return JSON.parse(JSON.stringify(a));
}

/**
 * @param {{
 *   host: HTMLElement,
 *   teamId: string,
 *   escapeHtml: (s: string) => string,
 *   headerHtml: (title: string) => string
 * }} deps
 */
export function mountUtilityArchive({ host, teamId, escapeHtml, headerHtml }) {
  let map = '';
  let archive = emptyArchive();
  /** Snapshot before an in-progress create/edit session. */
  let checkpoint = null;
  let selectedId = '';
  /** True while creating a new grenade (dragged) — clicks add throw spots. */
  let creating = false;
  let status = '';
  let statusBad = false;
  let saving = false;
  let dirty = false;

  /** @type {{ type: string }|null} */
  let dragPalette = null;
  let dragGhost = null;

  host.innerHTML = `
    ${headerHtml('')}
    <div class="ua-shell">
      <aside class="ua-tools" id="ua-tools"></aside>
      <div class="ua-stage">
        <canvas class="ua-canvas" id="ua-canvas"></canvas>
      </div>
      <aside class="ua-detail" id="ua-detail"></aside>
    </div>`;

  const toolsEl = host.querySelector('#ua-tools');
  const detailEl = host.querySelector('#ua-detail');
  const canvas = host.querySelector('#ua-canvas');
  const stageEl = host.querySelector('.ua-stage');
  const renderer = new RadarRenderer(canvas);

  function setStatus(text, bad = false) {
    status = text || '';
    statusBad = Boolean(bad);
    const node = toolsEl.querySelector('#ua-status');
    if (node) {
      node.textContent = status;
      node.classList.toggle('bad', statusBad);
    }
  }

  function selected() {
    return archive.grenades.find((g) => g.id === selectedId) || null;
  }

  /**
   * Every id in the archive: landing spots and throw spots together.
   *
   * They share one namespace because a stratbook note writes `<!abcd>` without
   * saying which kind it means.
   */
  function usedIds() {
    const out = new Set();
    for (const g of archive.grenades) {
      out.add(g.id);
      for (const t of g.throws || []) if (t.id) out.add(t.id);
    }
    return out;
  }

  /**
   * Fill in throw ids for archives written before a throw had one.
   *
   * The server does this too, on both read and write, so this only matters for
   * the seconds between loading an old archive and saving it back. Doing it
   * here as well means the ids on screen are the ids that will be stored.
   */
  function ensureThrowIds() {
    const used = usedIds();
    for (const g of archive.grenades) {
      for (const t of g.throws || []) {
        if (t.id) continue;
        t.id = newId(used);
        used.add(t.id);
      }
    }
  }

  function beginSession() {
    if (!checkpoint) checkpoint = cloneArchive(archive);
  }

  function renderTools() {
    const mapOpts = MAP_CODES.map(
      (c) =>
        `<option value="${c}"${c === map ? ' selected' : ''}>${escapeHtml(MAPS[c]?.name || c)}</option>`
    ).join('');
    toolsEl.innerHTML = `
      <div class="db-block">
        <select class="site-select" data-map>
          <option value="">Map</option>${mapOpts}
        </select>
      </div>
      <div class="db-block">
        <div class="db-nade-row">
          ${NADE_TOOLS.map(
            (n) =>
              `<button type="button" class="db-nade" data-drag-nade="${n.type}" title="${escapeHtml(
                n.label
              )}: drag onto map">
                <img src="${n.icon}" alt="" width="16" height="20" draggable="false" />
              </button>`
          ).join('')}
        </div>
        <p class="sc-note">Drag a grenade onto the map, then click to add throw spots.</p>
      </div>
      <div class="db-block">
        <p class="sc-status${statusBad ? ' bad' : ''}" id="ua-status">${escapeHtml(status)}</p>
      </div>
      <p class="sc-note">In the stratbook editor, write &lt;!1234&gt; to link setpos/setang to a utility spot.</p>
    `;
  }

  function renderDetail() {
    const g = selected();
    if (!g) {
      detailEl.innerHTML = `<div class="db-block">
        <p class="sc-note">Select a grenade on the map, or drag one from the left to create.</p>
      </div>`;
      return;
    }
    const typeLabel = NADE_TOOLS.find((n) => n.type === g.type)?.label || g.type;
    const showActions = creating || dirty;
    detailEl.innerHTML = `
      <div class="db-block">
        <code class="ua-id" title="Landing spot id">&lt;!${escapeHtml(g.id)}&gt;</code>
        <input class="site-input" data-name maxlength="80" value="${escapeHtml(g.name || '')}"
          placeholder="Grenade name" aria-label="Grenade name" />
      </div>
      <div class="db-block">
        ${
          g.throws.length
            ? `<ul class="ua-throw-list">${g.throws
                .map(
                  (t, i) => `
              <li class="ua-throw" data-throw="${i}">
                <code class="ua-id ua-throw-id" title="Link this exact throw">&lt;!${escapeHtml(
                  t.id || ''
                )}&gt;</code>
                <button type="button" class="ua-throw-copy" data-copy-throw="${i}" title="Copy setpos / setang">
                  Copy
                </button>
                <div class="ua-throw-fields">
                  <input class="site-input" data-setpos="${i}" placeholder="setpos …" value="${escapeHtml(
                    t.setpos || ''
                  )}" />
                  <input class="site-input" data-setang="${i}" placeholder="setang …" value="${escapeHtml(
                    t.setang || ''
                  )}" />
                  <input class="site-input" data-comment="${i}" maxlength="${MAX_COMMENT}"
                    placeholder="Comment (max ${MAX_COMMENT})" value="${escapeHtml(t.comment || '')}" />
                </div>
                <button type="button" class="rp-btn-icon danger" data-drop-throw="${i}" title="Remove">×</button>
              </li>`
                )
                .join('')}</ul>`
            : `<p class="sc-note">${
                creating ? 'Click the map to add throw spots.' : 'No throw spots yet.'
              }</p>`
        }
      </div>
      ${
        showActions
          ? `<div class="db-block db-actions-row">
              <button type="button" class="btn btn-sm primary" data-save-grenade ${
                saving ? 'disabled' : ''
              }>${saving ? '…' : 'Save'}</button>
              <button type="button" class="btn btn-sm" data-cancel-grenade>Cancel</button>
            </div>`
          : ''
      }
      <div class="db-block" style="margin-top:auto">
        <button type="button" class="btn btn-sm danger" data-drop-nade>Delete grenade</button>
      </div>
      <p class="sc-note" style="display:none">${escapeHtml(typeLabel)}</p>
    `;
  }

  async function loadMap(code) {
    map = code || '';
    archive = emptyArchive(map);
    selectedId = '';
    creating = false;
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
      const saved = await fetchUtilityArchive(teamId, map);
      archive = saved && saved.map ? saved : emptyArchive(map);
      ensureThrowIds();
      dirty = false;
      setStatus(
        archive.grenades.length
          ? `${archive.grenades.length} grenade${archive.grenades.length === 1 ? '' : 's'} on this map.`
          : 'Drag a grenade onto the map to start.'
      );
    } catch (err) {
      archive = emptyArchive(map);
      setStatus(err.message || 'Could not load archive.', true);
    }
    renderTools();
    renderDetail();
    paint();
  }

  function worldRadiusPx(units, t) {
    const scale = renderer.mapScale() || 5;
    return (units / scale) * t.scale;
  }

  function drawNade(ctx, t, g, active) {
    const rp = worldToRadar(map, g.detonate.x, g.detonate.y, {});
    const x = rp.x * t.scale + t.ox;
    const y = rp.y * t.scale + t.oy;
    const dpr = renderer.dpr;
    ctx.save();
    // Same renderer the timeline round viewer uses. The archive used to fade
    // its discs harder than the viewer did, so saved utility looked weaker here
    // than the throw it was copied from.
    const units = utilityRadiusUnits(g.type);
    drawUtilityMarker(ctx, {
      type: g.type,
      x,
      y,
      radius: units ? worldRadiusPx(units, t) : 0,
      dpr,
      active,
      onIconLoad: () => paint()
    });
    if (active) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${11 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(g.id, x, y);
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
    const ctx = renderer.ctx;
    const gSel = selected();

    for (const g of archive.grenades) {
      drawNade(ctx, t, g, g.id === selectedId);
    }

    if (gSel) {
      for (const th of gSel.throws) {
        const rp = worldToRadar(map, th.x, th.y, {});
        const x = rp.x * t.scale + t.ox;
        const y = rp.y * t.scale + t.oy;
        const dp = worldToRadar(map, gSel.detonate.x, gSel.detonate.y, {});
        const dx = dp.x * t.scale + t.ox;
        const dy = dp.y * t.scale + t.oy;
        ctx.save();
        ctx.strokeStyle = 'rgba(125, 255, 106, 0.65)';
        ctx.lineWidth = 1.4 * renderer.dpr;
        ctx.setLineDash([4 * renderer.dpr, 3 * renderer.dpr]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(dx, dy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 6 * renderer.dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#7dff6a';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.2 * renderer.dpr;
        ctx.stroke();
        ctx.restore();
      }
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

  function hitGrenade(world) {
    let best = null;
    let bestD = 90 * 90;
    for (const g of archive.grenades) {
      const d = dist2(g.detonate, world);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  async function copyThrow(th) {
    const text = [th.setpos, th.setang].filter(Boolean).join('\n');
    if (!text) {
      setStatus('Add setpos / setang first.', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(th.comment ? `Copied. ${th.comment}` : 'Copied setpos / setang.');
    } catch {
      setStatus('Could not copy. Select the fields manually.', true);
    }
  }

  let panning = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!map) return;
    e.preventDefault();

    if (e.button === 1) {
      panning = renderer.zoom > MIN_ZOOM;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      if (panning) stageEl.classList.add('panning');
      return;
    }

    if (e.button === 0 && renderer.zoom > MIN_ZOOM && e.altKey) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      stageEl.classList.add('panning');
      return;
    }

    if (e.button !== 0) return;
    const world = worldFromEvent(e);
    if (!world) return;

    // Creating: each click adds a throw spot on the selected grenade.
    if (creating && selectedId) {
      const g = selected();
      if (!g) return;
      // Its own id: this is a distinct lineup, not another note on the landing
      // spot, and a stratbook link has to be able to name exactly this throw.
      g.throws.push({
        id: newId(usedIds()),
        x: Math.round(world.x),
        y: Math.round(world.y),
        setpos: '',
        setang: '',
        comment: ''
      });
      dirty = true;
      paint();
      renderDetail();
      return;
    }

    // Select mode.
    const hit = hitGrenade(world);
    if (hit) {
      selectedId = hit.id;
      creating = false;
      paint();
      renderDetail();
      return;
    }
    selectedId = '';
    paint();
    renderDetail();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    renderer.panX += dx;
    renderer.panY += dy;
    paint();
  });

  const endPan = (e) => {
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
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom(renderer.zoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  // ---- palette drag -------------------------------------------------------

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
        beginSession();
        const near = archive.grenades.find(
          (g) => g.type === dragPalette.type && dist2(g.detonate, world) <= MERGE_UNITS * MERGE_UNITS
        );
        if (near) {
          selectedId = near.id;
          creating = true;
          setStatus(`Merged into ${near.id}. Click to add throw spots.`);
        } else {
          const id = newId(usedIds());
          archive.grenades.push({
            id,
            type: dragPalette.type,
            name: '',
            detonate: { x: Math.round(world.x), y: Math.round(world.y) },
            throws: []
          });
          selectedId = id;
          creating = true;
          dirty = true;
          setStatus(`Placed ${id}. Click to add throw spots.`);
        }
        paint();
        renderDetail();
        renderTools();
      }
    }
    clearDrag();
  }

  toolsEl.addEventListener('change', (e) => {
    if (e.target.closest('[data-map]')) loadMap(e.target.value);
  });

  detailEl.addEventListener('input', (e) => {
    const g = selected();
    if (!g) return;
    beginSession();
    const name = e.target.closest('[data-name]');
    if (name) {
      g.name = name.value.slice(0, 80);
      dirty = true;
      if (!detailEl.querySelector('[data-save-grenade]')) renderDetail();
      return;
    }
    const setpos = e.target.closest('[data-setpos]');
    if (setpos) {
      const i = Number(setpos.dataset.setpos);
      if (g.throws[i]) {
        g.throws[i].setpos = setpos.value;
        dirty = true;
      }
      return;
    }
    const setang = e.target.closest('[data-setang]');
    if (setang) {
      const i = Number(setang.dataset.setang);
      if (g.throws[i]) {
        g.throws[i].setang = setang.value;
        dirty = true;
      }
      return;
    }
    const comment = e.target.closest('[data-comment]');
    if (comment) {
      const i = Number(comment.dataset.comment);
      if (g.throws[i]) {
        g.throws[i].comment = comment.value.slice(0, MAX_COMMENT);
        dirty = true;
      }
    }
  });

  detailEl.addEventListener('click', async (e) => {
    const g = selected();
    if (e.target.closest('[data-save-grenade]')) {
      if (!map || saving) return;
      saving = true;
      renderDetail();
      try {
        archive = await saveUtilityArchive(teamId, map, archive);
        dirty = false;
        creating = false;
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
    if (e.target.closest('[data-cancel-grenade]')) {
      if (checkpoint) archive = checkpoint;
      checkpoint = null;
      creating = false;
      dirty = false;
      selectedId = '';
      setStatus('Cancelled.');
      paint();
      renderDetail();
      renderTools();
      return;
    }
    if (!g) return;
    const copy = e.target.closest('[data-copy-throw]');
    if (copy) {
      const i = Number(copy.dataset.copyThrow);
      if (g.throws[i]) await copyThrow(g.throws[i]);
      return;
    }
    const dropT = e.target.closest('[data-drop-throw]');
    if (dropT) {
      beginSession();
      const i = Number(dropT.dataset.dropThrow);
      g.throws.splice(i, 1);
      dirty = true;
      paint();
      renderDetail();
      return;
    }
    if (e.target.closest('[data-drop-nade]')) {
      if (!window.confirm(`Delete grenade ${g.id}?`)) return;
      beginSession();
      archive.grenades = archive.grenades.filter((x) => x.id !== g.id);
      selectedId = '';
      creating = false;
      dirty = true;
      try {
        archive = await saveUtilityArchive(teamId, map, archive);
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
