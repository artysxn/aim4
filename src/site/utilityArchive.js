// ---------------------------------------------------------------------------
// site/utilityArchive.js
// Per-team utility database: detonation spots, throw origins, setpos/setang.
// ---------------------------------------------------------------------------

import { RadarRenderer } from '../replays/viewer/radarRenderer.js';
import { radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { MAPS, MAP_CODES } from '../replays/shared/roundId.js';
import { fetchUtilityArchive, saveUtilityArchive } from '../replays/api.js';

const MERGE_UNITS = 75;
const MAX_COMMENT = 100;

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
  let nadeType = 'smokegrenade';
  /** @type {'place-detonate'|'place-throw'|''} */
  let mode = 'place-detonate';
  let selectedId = '';
  let status = '';
  let statusBad = false;
  let saving = false;
  let dirty = false;

  host.innerHTML = `
    ${headerHtml('Utility Archive')}
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

  function usedIds() {
    return new Set(archive.grenades.map((g) => g.id));
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
        <span class="sc-label">Grenade</span>
        <div class="db-nade-row">
          ${NADE_TOOLS.map(
            (n) =>
              `<button type="button" class="db-nade${
                nadeType === n.type ? ' active' : ''
              }" data-nade="${n.type}" title="${escapeHtml(n.label)}">
                <img src="${n.icon}" alt="" width="16" height="20" draggable="false" />
              </button>`
          ).join('')}
        </div>
      </div>
      <div class="db-block">
        <span class="sc-label">Mode</span>
        <div class="db-tool-row">
          <button type="button" class="db-tool${
            mode === 'place-detonate' ? ' active' : ''
          }" data-mode="place-detonate">Detonate</button>
          <button type="button" class="db-tool${
            mode === 'place-throw' ? ' active' : ''
          }" data-mode="place-throw" ${selectedId ? '' : 'disabled'}>Throw spot</button>
        </div>
        <p class="sc-note">Detonate places/merges the land point. Throw spot adds an origin on the selected grenade.</p>
      </div>
      <div class="db-block db-actions">
        <button type="button" class="btn primary" data-save ${saving || !map ? 'disabled' : ''}>
          ${saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <p class="sc-status${statusBad ? ' bad' : ''}" id="ua-status">${escapeHtml(status)}</p>
      </div>
      <p class="sc-note">Stratbook: type &lt;!####&gt; with the grenade’s 4-character ID.</p>
    `;
  }

  function renderDetail() {
    const g = selected();
    if (!g) {
      detailEl.innerHTML = `<div class="db-block">
        <span class="sc-label">Selected</span>
        <p class="sc-note">Click a detonation on the map.</p>
      </div>`;
      return;
    }
    const typeLabel = NADE_TOOLS.find((n) => n.type === g.type)?.label || g.type;
    detailEl.innerHTML = `
      <div class="db-block">
        <span class="sc-label">Grenade <code class="ua-id">&lt;!${escapeHtml(g.id)}&gt;</code></span>
        <label class="ua-field">Name
          <input class="site-input" data-name maxlength="80" value="${escapeHtml(g.name || '')}"
            placeholder="${escapeHtml(typeLabel)}" />
        </label>
        <p class="sc-note">${typeLabel} · ${g.throws.length} throw spot${g.throws.length === 1 ? '' : 's'}</p>
        <button type="button" class="btn btn-sm danger" data-drop-nade>Delete grenade</button>
      </div>
      <div class="db-block">
        <span class="sc-label">Throw spots</span>
        ${
          g.throws.length
            ? `<ul class="ua-throw-list">${g.throws
                .map(
                  (t, i) => `
              <li class="ua-throw" data-throw="${i}">
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
            : '<p class="sc-note">Switch to Throw spot and click the map.</p>'
        }
      </div>`;
  }

  async function loadMap(code) {
    map = code || '';
    archive = emptyArchive(map);
    selectedId = '';
    dirty = false;
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
      dirty = false;
      setStatus(
        archive.grenades.length
          ? `${archive.grenades.length} grenade${archive.grenades.length === 1 ? '' : 's'} on this map.`
          : 'No utility yet — place a detonation.'
      );
    } catch (err) {
      archive = emptyArchive(map);
      setStatus(err.message || 'Could not load archive.', true);
    }
    renderTools();
    renderDetail();
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
    const gSel = selected();

    for (const g of archive.grenades) {
      const rp = worldToRadar(map, g.detonate.x, g.detonate.y, {});
      const x = rp.x * t.scale + t.ox;
      const y = rp.y * t.scale + t.oy;
      const active = g.id === selectedId;
      const r = (active ? 16 : 13) * renderer.dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(255, 255, 255, 0.28)' : 'rgba(200, 205, 215, 0.22)';
      ctx.fill();
      ctx.lineWidth = (active ? 2.2 : 1.4) * renderer.dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${11 * renderer.dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(g.id, x, y);
      ctx.restore();
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
  }

  function worldFromEvent(e) {
    if (!map) return null;
    const radar = renderer.radarFromClient(e.clientX, e.clientY, {});
    if (!Number.isFinite(radar.x) || !Number.isFinite(radar.y)) return null;
    return radarToWorld(map, radar.x, radar.y, {});
  }

  function hitGrenade(world) {
    let best = null;
    let bestD = 55 * 55;
    for (const g of archive.grenades) {
      const d = dist2(g.detonate, world);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  function hitThrow(world) {
    const g = selected();
    if (!g) return -1;
    let best = -1;
    let bestD = 45 * 45;
    g.throws.forEach((th, i) => {
      const d = dist2(th, world);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
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
      setStatus('Could not copy — select the fields manually.', true);
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!map || e.button !== 0) return;
    const world = worldFromEvent(e);
    if (!world) return;

    if (mode === 'place-throw' && selectedId) {
      const g = selected();
      if (!g) return;
      g.throws.push({
        x: Math.round(world.x),
        y: Math.round(world.y),
        setpos: '',
        setang: '',
        comment: ''
      });
      dirty = true;
      paint();
      renderDetail();
      renderTools();
      return;
    }

    // Select existing or place/merge detonation.
    const hit = hitGrenade(world);
    if (hit && mode !== 'place-detonate') {
      selectedId = hit.id;
      paint();
      renderDetail();
      renderTools();
      return;
    }

    if (mode === 'place-detonate') {
      const near = archive.grenades.find(
        (g) => g.type === nadeType && dist2(g.detonate, world) <= MERGE_UNITS * MERGE_UNITS
      );
      if (near) {
        selectedId = near.id;
        setStatus(`Merged into ${near.id} (within ${MERGE_UNITS}u).`);
      } else {
        const id = newId(usedIds());
        archive.grenades.push({
          id,
          type: nadeType,
          name: '',
          detonate: { x: Math.round(world.x), y: Math.round(world.y) },
          throws: []
        });
        selectedId = id;
        dirty = true;
        setStatus(`Added ${id}.`);
      }
      mode = 'place-throw';
      paint();
      renderDetail();
      renderTools();
      return;
    }

    const th = hitThrow(world);
    if (th >= 0) {
      copyThrow(selected().throws[th]);
      return;
    }

    if (hit) {
      selectedId = hit.id;
      paint();
      renderDetail();
      renderTools();
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!map) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      renderer.zoom = Math.max(0.5, Math.min(8, (renderer.zoom || 1) * factor));
      paint();
    },
    { passive: false }
  );

  let panLast = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      panLast = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!panLast) return;
    const dx = e.clientX - panLast.x;
    const dy = e.clientY - panLast.y;
    panLast = { x: e.clientX, y: e.clientY };
    const { w, h } = renderer.resize();
    const t = renderer.viewTransform(w, h);
    renderer.panX += dx / Math.max(t.scale, 1e-6);
    renderer.panY += dy / Math.max(t.scale, 1e-6);
    paint();
  });
  canvas.addEventListener('pointerup', () => {
    panLast = null;
  });

  toolsEl.addEventListener('change', (e) => {
    if (e.target.closest('[data-map]')) loadMap(e.target.value);
  });

  toolsEl.addEventListener('click', async (e) => {
    const t = e.target;
    const nadeBtn = t.closest('[data-nade]');
    if (nadeBtn) {
      nadeType = nadeBtn.dataset.nade;
      mode = 'place-detonate';
      renderTools();
      return;
    }
    const modeBtn = t.closest('[data-mode]');
    if (modeBtn) {
      mode = modeBtn.dataset.mode;
      renderTools();
      return;
    }
    if (t.closest('[data-save]')) {
      if (!map || saving) return;
      saving = true;
      renderTools();
      try {
        archive = await saveUtilityArchive(teamId, map, archive);
        dirty = false;
        setStatus('Saved.');
      } catch (err) {
        setStatus(err.message || 'Could not save.', true);
      }
      saving = false;
      renderTools();
      renderDetail();
    }
  });

  detailEl.addEventListener('input', (e) => {
    const g = selected();
    if (!g) return;
    const name = e.target.closest('[data-name]');
    if (name) {
      g.name = name.value.slice(0, 80);
      dirty = true;
      renderTools();
      return;
    }
    const setpos = e.target.closest('[data-setpos]');
    if (setpos) {
      const i = Number(setpos.dataset.setpos);
      if (g.throws[i]) {
        g.throws[i].setpos = setpos.value;
        dirty = true;
        renderTools();
      }
      return;
    }
    const setang = e.target.closest('[data-setang]');
    if (setang) {
      const i = Number(setang.dataset.setang);
      if (g.throws[i]) {
        g.throws[i].setang = setang.value;
        dirty = true;
        renderTools();
      }
      return;
    }
    const comment = e.target.closest('[data-comment]');
    if (comment) {
      const i = Number(comment.dataset.comment);
      if (g.throws[i]) {
        g.throws[i].comment = comment.value.slice(0, MAX_COMMENT);
        dirty = true;
        renderTools();
      }
    }
  });

  detailEl.addEventListener('click', async (e) => {
    const g = selected();
    if (!g) return;
    const copy = e.target.closest('[data-copy-throw]');
    if (copy) {
      const i = Number(copy.dataset.copyThrow);
      if (g.throws[i]) await copyThrow(g.throws[i]);
      return;
    }
    const dropT = e.target.closest('[data-drop-throw]');
    if (dropT) {
      const i = Number(dropT.dataset.dropThrow);
      g.throws.splice(i, 1);
      dirty = true;
      paint();
      renderDetail();
      renderTools();
      return;
    }
    if (e.target.closest('[data-drop-nade]')) {
      if (!window.confirm(`Delete grenade ${g.id}?`)) return;
      archive.grenades = archive.grenades.filter((x) => x.id !== g.id);
      selectedId = '';
      dirty = true;
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
      host.innerHTML = '';
    }
  };
}
