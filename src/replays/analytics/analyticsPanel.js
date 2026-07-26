// ---------------------------------------------------------------------------
// Analytics: one player × one map × phase-window presence filters → stats + rounds.
// ---------------------------------------------------------------------------

import { fetchStats, fetchZones } from '../api.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import {
  aggregateAnalytics,
  listPlayers,
  locationBreakdown
} from './analyticsMath.js';

const PHASE_OPTS = [
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   onPlayRounds?: (files: string[], title: string) => void | Promise<void>
 * }} deps
 */
export function createAnalyticsPanel({ escapeHtml, onPlayRounds }) {
  const el = document.createElement('div');
  el.className = 'an-panel';
  el.innerHTML = `
    <div class="an-setup" id="an-setup"></div>
    <div class="an-filters st-filters" id="an-filters" hidden></div>
    <div class="an-body" id="an-body"><p class="view-empty">Select a player and a map to begin.</p></div>`;

  const setupEl = el.querySelector('#an-setup');
  const filtersEl = el.querySelector('#an-filters');
  const bodyEl = el.querySelector('#an-body');

  let payload = null;
  /** @type {Array<{id:string,name:string,maps:string[]}>} */
  let players = [];
  let loadToken = 0;
  let playerSearch = '';
  let playerMenuOpen = false;

  const state = {
    playerId: '',
    map: '',
    side: '',
    econ: null,
    oppEcon: null,
    hasAwp: false,
    oppHasAwp: false,
    /** @type {''|'won'|'lost'} */
    result: '',
    /** @type {Set<string>} */
    phases: new Set(),
    /** @type {Set<string>} */
    positions: new Set(),
    /** @type {Set<string>} */
    zones: new Set(),
    /** @type {Set<string>} */
    areas: new Set(),
    locSearch: { pos: '', zone: '', area: '' }
  };

  /** @type {object|null} */
  let network = null;
  let networkMap = '';

  function selectedPlayer() {
    return players.find((p) => p.id === state.playerId) || null;
  }

  function filterObj() {
    return {
      playerId: state.playerId,
      map: state.map,
      side: state.side,
      econ: state.econ,
      oppEcon: state.oppEcon,
      hasAwp: state.hasAwp,
      oppHasAwp: state.oppHasAwp,
      result: state.result,
      phases: state.phases,
      positions: state.positions,
      zones: state.zones,
      areas: state.areas
    };
  }

  function nameOf(kind, id) {
    if (!id || !network) return id || '';
    const list =
      kind === 'pos' ? network.zones : kind === 'zone' ? network.sections : network.areas;
    const hit = (list || []).find((x) => x.id === id);
    return hit?.name || id;
  }

  // ---- setup (player + map) -----------------------------------------------

  function playerOptions() {
    const q = playerSearch.trim().toLowerCase();
    return players
      .filter((p) => p.id !== state.playerId)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .slice(0, 40);
  }

  function renderSetup() {
    const pl = selectedPlayer();
    const maps = pl?.maps?.length
      ? pl.maps
      : [...new Set((payload?.demos || []).map((d) => d.map).filter(Boolean))].sort();
    const mapOpts = maps
      .map(
        (code) =>
          `<option value="${escapeHtml(code)}"${code === state.map ? ' selected' : ''}>${escapeHtml(
            MAPS[code]?.name || code
          )}</option>`
      )
      .join('');

    setupEl.innerHTML = `
      <div class="an-setup-row">
        <div class="an-setup-field">
          <span class="st-filter-label">Player</span>
          <div class="rp-typeahead an-player-typeahead${playerMenuOpen ? ' open' : ''}" id="an-player-typeahead">
            <input type="search" class="site-input" id="an-player-search"
              placeholder="${pl ? escapeHtml(pl.name) : 'Search players'}"
              spellcheck="false" autocomplete="off" value="${escapeHtml(playerSearch)}"
              aria-label="Search players" />
            ${
              playerMenuOpen || playerSearch
                ? `<div class="rp-typeahead-menu">
              ${
                playerOptions().length
                  ? playerOptions()
                      .map(
                        (p) =>
                          `<button type="button" class="rp-typeahead-option" data-pick-player="${escapeHtml(
                            p.id
                          )}">${escapeHtml(p.name)}</button>`
                      )
                      .join('')
                  : `<p class="rp-typeahead-empty">No players</p>`
              }
            </div>`
                : ''
            }
          </div>
          ${
            pl
              ? `<div class="rp-selected-chips rp-chips">
            <button type="button" class="rp-chip active" data-clear-player>${escapeHtml(
              pl.name
            )} ×</button>
          </div>`
              : ''
          }
        </div>
        <div class="an-setup-field">
          <span class="st-filter-label">Map</span>
          <select class="site-select" id="an-map" ${pl ? '' : 'disabled'} aria-label="Map">
            <option value=""${!state.map ? ' selected' : ''}>Select map</option>
            ${mapOpts}
          </select>
        </div>
      </div>`;
  }

  // ---- filters ------------------------------------------------------------

  function econSelect(id, value) {
    const opts = Object.entries(ECONOMIES)
      .map(
        ([code, e]) =>
          `<option value="${code}"${Number(code) === value ? ' selected' : ''}>${escapeHtml(
            e.label || economyLabel(Number(code))
          )}</option>`
      )
      .join('');
    return `<select class="site-select" data-an-econ="${id}">
      <option value=""${value === null ? ' selected' : ''}>Any buy</option>${opts}</select>`;
  }

  function awpCheck(id, checked) {
    return `<label class="rp-awp-toggle${checked ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" data-an-awp="${id}" ${checked ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  function locPicker(kind, label, items, selected, search) {
    const q = search.trim().toLowerCase();
    const filtered = items
      .filter((it) => !q || it.name.toLowerCase().includes(q))
      .slice(0, 60);
    const chips = [...selected]
      .map((id) => {
        const name = items.find((x) => x.id === id)?.name || id;
        return `<button type="button" class="rp-chip active" data-loc-clear="${kind}" data-id="${escapeHtml(
          id
        )}">${escapeHtml(name)} ×</button>`;
      })
      .join('');
    return `
      <div class="an-loc-group">
        <span class="st-filter-label">${label}</span>
        <input type="search" class="site-input an-loc-search" data-loc-search="${kind}"
          placeholder="Search ${label.toLowerCase()}" value="${escapeHtml(search)}"
          spellcheck="false" autocomplete="off" />
        <div class="an-loc-list">
          ${
            filtered.length
              ? filtered
                  .map(
                    (it) =>
                      `<button type="button" class="rp-chip${
                        selected.has(it.id) ? ' active' : ''
                      }" data-loc-toggle="${kind}" data-id="${escapeHtml(it.id)}">${escapeHtml(
                        it.name
                      )}</button>`
                  )
                  .join('')
              : `<p class="rp-typeahead-empty">No ${label.toLowerCase()}</p>`
          }
        </div>
        ${chips ? `<div class="rp-chips an-loc-selected">${chips}</div>` : ''}
      </div>`;
  }

  function renderFilters() {
    if (!state.playerId || !state.map) {
      filtersEl.hidden = true;
      filtersEl.innerHTML = '';
      return;
    }
    filtersEl.hidden = false;
    const positions = (network?.zones || [])
      .filter((z) => !z.hidden && z.id)
      .map((z) => ({ id: z.id, name: z.name || z.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const zones = (network?.sections || [])
      .filter((z) => z.id)
      .map((z) => ({ id: z.id, name: z.name || z.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const areas = (network?.areas || [])
      .filter((z) => z.id)
      .map((z) => ({ id: z.id, name: z.name || z.id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const sideBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        state.side === value ? ' active' : ''
      }" data-an-side="${value}">${label}</button>`;
    const resultBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        state.result === value ? ' active' : ''
      }" data-an-result="${value}">${label}</button>`;
    const phaseBtn = (key, label) =>
      `<button type="button" class="rp-chip${
        state.phases.has(key) ? ' active' : ''
      }" data-an-phase="${key}">${label}</button>`;

    filtersEl.innerHTML = `
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">Side</span>
        <div class="rp-chips">${sideBtn('T', 'T')}${sideBtn('CT', 'CT')}</div>
      </div>
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">Own buy</span>
        <div class="st-filter-row">${econSelect('econ', state.econ)}${awpCheck(
          'hasAwp',
          state.hasAwp
        )}</div>
      </div>
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">Opp buy</span>
        <div class="st-filter-row">${econSelect('oppEcon', state.oppEcon)}${awpCheck(
          'oppHasAwp',
          state.oppHasAwp
        )}</div>
      </div>
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">Result</span>
        <div class="rp-chips">${resultBtn('won', 'Won')}${resultBtn('lost', 'Lost')}</div>
      </div>
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">Phase</span>
        <div class="rp-chips">${PHASE_OPTS.map((p) => phaseBtn(p.key, p.label)).join('')}</div>
      </div>
      <button type="button" class="btn btn-sm st-filter-clear" data-an-clear>Clear</button>
      <div class="an-loc-filters">
        ${locPicker('pos', 'Positions', positions, state.positions, state.locSearch.pos)}
        ${locPicker('zone', 'Zones', zones, state.zones, state.locSearch.zone)}
        ${locPicker('area', 'Areas', areas, state.areas, state.locSearch.area)}
      </div>`;
  }

  // ---- body ---------------------------------------------------------------

  function fmt(n, digits = 2) {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(digits);
  }

  function renderBreakdown(breakdown) {
    const block = (title, rows, kind) => {
      if (!rows.length) return `<div class="an-break-col"><h4>${title}</h4><p class="view-empty">No data</p></div>`;
      return `<div class="an-break-col"><h4>${title}</h4><ul class="an-break-list">
        ${rows
          .slice(0, 12)
          .map(
            (r) =>
              `<li><button type="button" class="an-break-item${
                (kind === 'pos'
                  ? state.positions
                  : kind === 'zone'
                    ? state.zones
                    : state.areas
                ).has(r.id)
                  ? ' active'
                  : ''
              }" data-loc-toggle="${kind}" data-id="${escapeHtml(r.id)}">
                <span>${escapeHtml(nameOf(kind, r.id))}</span>
                <small>${r.count}</small>
              </button></li>`
          )
          .join('')}
      </ul></div>`;
    };
    return `<div class="an-breakdown">
      <h3 class="an-section-title">Where they play</h3>
      <p class="an-section-sub">Dominant position / zone / area per phase window (${breakdown.samples} samples)</p>
      <div class="an-break-grid">
        ${block('Positions', breakdown.pos, 'pos')}
        ${block('Zones', breakdown.zone, 'zone')}
        ${block('Areas', breakdown.area, 'area')}
      </div>
    </div>`;
  }

  function renderStats(agg) {
    if (!agg.samples) {
      return `<div class="an-stats"><p class="view-empty">No phase windows match these filters.</p></div>`;
    }
    return `<div class="an-stats">
      <h3 class="an-section-title">Phase stats</h3>
      <p class="an-section-sub">${agg.samples} windows · ${agg.rounds} rounds</p>
      <div class="an-stat-grid">
        <div class="an-stat"><span>Rating</span><strong>${fmt(agg.rating)}</strong></div>
        <div class="an-stat"><span>K/D</span><strong>${fmt(agg.kd)}</strong></div>
        <div class="an-stat"><span>ADR</span><strong>${fmt(agg.adr, 1)}</strong></div>
        <div class="an-stat"><span>KAST</span><strong>${fmt(agg.kast, 1)}%</strong></div>
        <div class="an-stat"><span>Impact</span><strong>${fmt(agg.impact)}</strong></div>
        <div class="an-stat"><span>Acc</span><strong>${fmt(agg.accuracy, 1)}%</strong></div>
        <div class="an-stat"><span>Kills</span><strong>${agg.kills}</strong></div>
        <div class="an-stat"><span>Deaths</span><strong>${agg.deaths}</strong></div>
        <div class="an-stat"><span>Assists</span><strong>${agg.assists}</strong></div>
      </div>
    </div>`;
  }

  function renderRounds(agg) {
    const byFile = new Map();
    for (const w of agg.windows) {
      let g = byFile.get(w.file);
      if (!g) {
        g = { file: w.file, demoId: w.demoId, round: w.round, phases: new Set() };
        byFile.set(w.file, g);
      }
      g.phases.add(w.phase);
    }
    const list = [...byFile.values()].sort(
      (a, b) => (b.round || 0) - (a.round || 0) || a.file.localeCompare(b.file)
    );
    if (!list.length) {
      return `<div class="an-rounds"><p class="view-empty">No rounds to play.</p></div>`;
    }
    return `<div class="an-rounds">
      <div class="an-rounds-head">
        <h3 class="an-section-title">Rounds <small>${list.length}</small></h3>
        <button type="button" class="btn primary btn-sm" id="an-play-all">Play in Timeline</button>
      </div>
      <ul class="an-round-list">
        ${list
          .map(
            (r) =>
              `<li class="an-round-row">
                <span class="an-round-label">R${r.round || '?'} · ${escapeHtml(
                  [...r.phases].join(', ')
                )}</span>
                <button type="button" class="btn btn-sm" data-an-play="${escapeHtml(
                  r.file
                )}">Play</button>
              </li>`
          )
          .join('')}
      </ul>
    </div>`;
  }

  function renderBody() {
    if (!state.playerId || !state.map) {
      bodyEl.innerHTML = `<p class="view-empty">Select a player and a map to begin.</p>`;
      return;
    }
    if (!payload) {
      bodyEl.innerHTML = `<p class="view-empty">Loading…</p>`;
      return;
    }
    const filter = filterObj();
    const breakdown = locationBreakdown(payload, filter);
    const agg = aggregateAnalytics(payload, filter);
    const needsPh = (payload.demos || []).some((d) =>
      (d.rounds || []).some((r) => r.m === state.map && !r.ph)
    );
    bodyEl.innerHTML = `
      ${
        needsPh
          ? `<p class="an-warn">Some rounds are still building phase data. Refresh shortly if numbers look incomplete.</p>`
          : ''
      }
      ${
        !network?.zones?.length
          ? `<p class="an-warn">No position network for this map — location filters need a ready zone map in the Position Editor.</p>`
          : ''
      }
      ${renderBreakdown(breakdown)}
      ${renderStats(agg)}
      ${renderRounds(agg)}`;
  }

  function render() {
    renderSetup();
    renderFilters();
    renderBody();
  }

  async function ensureNetwork() {
    if (!state.map) {
      network = null;
      networkMap = '';
      return;
    }
    if (networkMap === state.map && network) return;
    try {
      network = await fetchZones(state.map);
      networkMap = state.map;
    } catch {
      network = { zones: [], sections: [], areas: [] };
      networkMap = state.map;
    }
  }

  async function load() {
    const token = ++loadToken;
    bodyEl.innerHTML = `<p class="view-empty">Loading…</p>`;
    try {
      const data = await fetchStats(null);
      if (token !== loadToken) return;
      payload = data;
      players = listPlayers(payload);
      if (state.playerId && !players.some((p) => p.id === state.playerId)) {
        state.playerId = '';
        state.map = '';
      }
      await ensureNetwork();
      if (token !== loadToken) return;
      render();
    } catch (err) {
      if (token !== loadToken) return;
      bodyEl.innerHTML = `<p class="view-empty">Could not load stats. ${escapeHtml(
        err.message || String(err)
      )}</p>`;
    }
  }

  // ---- events -------------------------------------------------------------

  setupEl.addEventListener('input', (e) => {
    if (e.target.id === 'an-player-search') {
      playerSearch = e.target.value;
      playerMenuOpen = true;
      renderSetup();
      setupEl.querySelector('#an-player-search')?.focus();
      const input = setupEl.querySelector('#an-player-search');
      if (input) {
        input.value = playerSearch;
        input.setSelectionRange(playerSearch.length, playerSearch.length);
      }
    }
  });

  setupEl.addEventListener('focusin', (e) => {
    if (e.target.id === 'an-player-search') {
      playerMenuOpen = true;
      renderSetup();
      setupEl.querySelector('#an-player-search')?.focus();
    }
  });

  setupEl.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick-player]');
    if (pick) {
      state.playerId = pick.dataset.pickPlayer;
      playerSearch = '';
      playerMenuOpen = false;
      const pl = selectedPlayer();
      if (!pl?.maps.includes(state.map)) state.map = pl?.maps[0] || '';
      await ensureNetwork();
      render();
      return;
    }
    if (e.target.closest('[data-clear-player]')) {
      state.playerId = '';
      state.map = '';
      playerSearch = '';
      render();
    }
  });

  setupEl.addEventListener('change', async (e) => {
    if (e.target.id === 'an-map') {
      state.map = e.target.value || '';
      state.positions.clear();
      state.zones.clear();
      state.areas.clear();
      await ensureNetwork();
      render();
    }
  });

  document.addEventListener('click', (e) => {
    if (!playerMenuOpen) return;
    if (e.target.closest?.('#an-player-typeahead')) return;
    playerMenuOpen = false;
    renderSetup();
  });

  filtersEl.addEventListener('click', (e) => {
    const side = e.target.closest('[data-an-side]');
    if (side) {
      const v = side.dataset.anSide === 'CT' ? 'CT' : 'T';
      state.side = state.side === v ? '' : v;
      render();
      return;
    }
    const result = e.target.closest('[data-an-result]');
    if (result) {
      const v = result.dataset.anResult === 'lost' ? 'lost' : 'won';
      state.result = state.result === v ? '' : v;
      render();
      return;
    }
    const phase = e.target.closest('[data-an-phase]');
    if (phase) {
      const key = phase.dataset.anPhase;
      if (state.phases.has(key)) state.phases.delete(key);
      else state.phases.add(key);
      render();
      return;
    }
    if (e.target.closest('[data-an-clear]')) {
      state.side = '';
      state.econ = null;
      state.oppEcon = null;
      state.hasAwp = false;
      state.oppHasAwp = false;
      state.result = '';
      state.phases.clear();
      state.positions.clear();
      state.zones.clear();
      state.areas.clear();
      state.locSearch = { pos: '', zone: '', area: '' };
      render();
      return;
    }
    const locToggle = e.target.closest('[data-loc-toggle]');
    if (locToggle) {
      const kind = locToggle.dataset.locToggle;
      const id = locToggle.dataset.id;
      const set =
        kind === 'pos' ? state.positions : kind === 'zone' ? state.zones : state.areas;
      if (set.has(id)) set.delete(id);
      else set.add(id);
      render();
      return;
    }
    const locClear = e.target.closest('[data-loc-clear]');
    if (locClear) {
      const kind = locClear.dataset.locClear;
      const id = locClear.dataset.id;
      const set =
        kind === 'pos' ? state.positions : kind === 'zone' ? state.zones : state.areas;
      set.delete(id);
      render();
    }
  });

  filtersEl.addEventListener('change', (e) => {
    const awp = e.target.closest('[data-an-awp]');
    if (awp) {
      state[awp.dataset.anAwp] = Boolean(awp.checked);
      awp.closest('.rp-awp-toggle')?.classList.toggle('active', awp.checked);
      render();
      return;
    }
    const econ = e.target.closest('[data-an-econ]');
    if (econ) {
      state[econ.dataset.anEcon] = econ.value === '' ? null : Number(econ.value);
      render();
    }
  });

  filtersEl.addEventListener('input', (e) => {
    const search = e.target.closest('[data-loc-search]');
    if (!search) return;
    const kind = search.dataset.locSearch;
    if (kind === 'pos' || kind === 'zone' || kind === 'area') {
      state.locSearch[kind] = search.value;
      renderFilters();
      const again = filtersEl.querySelector(`[data-loc-search="${kind}"]`);
      if (again) {
        again.focus();
        again.setSelectionRange(search.value.length, search.value.length);
      }
    }
  });

  bodyEl.addEventListener('click', async (e) => {
    const locToggle = e.target.closest('[data-loc-toggle]');
    if (locToggle) {
      const kind = locToggle.dataset.locToggle;
      const id = locToggle.dataset.id;
      const set =
        kind === 'pos' ? state.positions : kind === 'zone' ? state.zones : state.areas;
      if (set.has(id)) set.delete(id);
      else set.add(id);
      render();
      return;
    }
    const playOne = e.target.closest('[data-an-play]');
    if (playOne && onPlayRounds) {
      playOne.disabled = true;
      try {
        await onPlayRounds([playOne.dataset.anPlay], selectedPlayer()?.name || 'Analytics');
      } finally {
        playOne.disabled = false;
      }
      return;
    }
    if (e.target.closest('#an-play-all') && onPlayRounds) {
      const agg = aggregateAnalytics(payload, filterObj());
      if (!agg.files.length) return;
      const btn = e.target.closest('#an-play-all');
      btn.disabled = true;
      try {
        await onPlayRounds(
          agg.files,
          `${selectedPlayer()?.name || 'Player'} · ${MAPS[state.map]?.name || state.map}`
        );
      } finally {
        btn.disabled = false;
      }
    }
  });

  return {
    el,
    load,
    destroy() {
      el.remove();
    }
  };
}
