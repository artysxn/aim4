// ---------------------------------------------------------------------------
// replays/stats/statsPanel.js
// The Statistics screen: two tables over one cached index.
//
// The payload is fetched once per scope and every filter, tab and sort after
// that is a re-aggregation in memory. Nothing here re-reads a round.
// ---------------------------------------------------------------------------

import { fetchStats } from '../api.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { aggregatePlayers, aggregateTeams, allRows, indexMaps } from '../shared/statsMath.js';
import { PLAYER_COLUMNS, TEAM_COLUMNS, attachTips, statsTableHtml } from './statsTables.js';

/**
 * @param {{escapeHtml: (s: string) => string}} deps
 */
export function createStatsPanel({ escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'st-panel';
  el.innerHTML = `
    <div class="st-head">
      <div class="st-tabs">
        <button type="button" class="seg-tab active" data-tab="players">Players</button>
        <button type="button" class="seg-tab" data-tab="teams">Teams</button>
      </div>
      <span class="st-scope" id="st-scope"></span>
    </div>
    <div class="st-filters" id="st-filters"></div>
    <div class="st-body" id="st-body"><p class="view-empty">Loading…</p></div>`;

  const filtersEl = el.querySelector('#st-filters');
  const bodyEl = el.querySelector('#st-body');
  const scopeEl = el.querySelector('#st-scope');

  let payload = null;
  let scope = {};
  let tab = 'players';
  let sort = { players: { key: 'rating', dir: 'desc' }, teams: { key: 'avgRating', dir: 'desc' } };
  let loadToken = 0;

  const filter = {
    maps: [],
    side: '',
    econ: null,
    oppEcon: null,
    hasAwp: false,
    oppHasAwp: false,
    files: null
  };

  const detachTips = attachTips(el);

  // ---- filters ------------------------------------------------------------

  function mapsInPayload() {
    const set = new Set();
    for (const d of payload?.demos || []) {
      for (const r of d.rounds || []) if (r.m) set.add(r.m);
    }
    return [...set].sort();
  }

  function econSelect(id, value) {
    const opts = Object.entries(ECONOMIES)
      .map(
        ([code, e]) =>
          `<option value="${code}"${Number(code) === value ? ' selected' : ''}>${escapeHtml(
            e.label || economyLabel(Number(code))
          )}</option>`
      )
      .join('');
    return `<select class="site-select" data-filter="${id}">
      <option value=""${value === null ? ' selected' : ''}>Any buy</option>${opts}</select>`;
  }

  function hasAwpCheck(id, checked) {
    return `<label class="st-awp-check">
      <input type="checkbox" data-awp="${id}" ${checked ? 'checked' : ''} />
      <span>Has AWP</span>
    </label>`;
  }

  function renderFilters() {
    const maps = mapsInPayload();
    const mapChips = maps
      .map(
        (code) =>
          `<button type="button" class="rp-chip${
            filter.maps.includes(code) ? ' active' : ''
          }" data-map="${escapeHtml(code)}">${escapeHtml(MAPS[code]?.name || code)}</button>`
      )
      .join('');

    const sideBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        filter.side === value ? ' active' : ''
      }" data-side="${value}">${label}</button>`;

    filtersEl.innerHTML = `
      <div class="st-filter-group">
        <span class="st-filter-label">Map</span>
        <div class="rp-chips">${mapChips || '<span class="st-none">—</span>'}</div>
      </div>
      <div class="st-filter-group">
        <span class="st-filter-label">Side</span>
        <div class="rp-chips">${sideBtn('T', 'T')}${sideBtn('CT', 'CT')}</div>
      </div>
      <div class="st-filter-group">
        <span class="st-filter-label">${tab === 'teams' ? 'Team buy' : 'Own buy'}</span>
        ${econSelect('econ', filter.econ)}
        ${hasAwpCheck('hasAwp', filter.hasAwp)}
      </div>
      <div class="st-filter-group">
        <span class="st-filter-label">Opponent buy</span>
        ${econSelect('oppEcon', filter.oppEcon)}
        ${hasAwpCheck('oppHasAwp', filter.oppHasAwp)}
      </div>
      <button type="button" class="btn btn-sm" data-clear>Clear</button>`;
  }

  filtersEl.addEventListener('click', (e) => {
    const map = e.target.closest('[data-map]');
    const side = e.target.closest('[data-side]');
    if (map) {
      const code = map.dataset.map;
      filter.maps = filter.maps.includes(code)
        ? filter.maps.filter((m) => m !== code)
        : [...filter.maps, code];
      render();
      return;
    }
    if (side) {
      filter.side = filter.side === side.dataset.side ? '' : side.dataset.side;
      render();
      return;
    }
    if (e.target.closest('[data-clear]')) {
      filter.maps = [];
      filter.side = '';
      filter.econ = null;
      filter.oppEcon = null;
      filter.hasAwp = false;
      filter.oppHasAwp = false;
      render();
    }
  });

  filtersEl.addEventListener('change', (e) => {
    const awp = e.target.closest('[data-awp]');
    if (awp) {
      filter[awp.dataset.awp] = Boolean(awp.checked);
      render();
      return;
    }
    const sel = e.target.closest('[data-filter]');
    if (!sel) return;
    const value = sel.value === '' ? null : Number(sel.value);
    filter[sel.dataset.filter] = value;
    render();
  });

  el.querySelector('.st-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === tab) return;
    tab = btn.dataset.tab;
    el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    render();
  });

  bodyEl.addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const s = sort[tab];
    if (s.key === th.dataset.sort) s.dir = s.dir === 'desc' ? 'asc' : 'desc';
    else {
      s.key = th.dataset.sort;
      s.dir = th.dataset.sort === 'name' ? 'asc' : 'desc';
    }
    render();
  });

  // ---- render -------------------------------------------------------------

  function render() {
    if (!payload) return;
    renderFilters();
    const { players, demos } = indexMaps(payload);
    const rows = allRows(payload);
    const active = { ...filter, files: scope.files || null };

    if (tab === 'players') {
      const data = aggregatePlayers(rows, players, active);
      const matchDemo = singleMatchDemo(payload, scope);
      if (matchDemo) {
        bodyEl.innerHTML = matchBoardsHtml(data, matchDemo, {
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir
        });
      } else {
        bodyEl.innerHTML = statsTableHtml(data, {
          columns: PLAYER_COLUMNS,
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir
        });
      }
    } else {
      const data = aggregateTeams(rows, players, demos, active);
      bodyEl.innerHTML = statsTableHtml(data, {
        columns: TEAM_COLUMNS,
        escapeHtml,
        sortKey: sort.teams.key,
        sortDir: sort.teams.dir
      });
    }
  }

  /** One-demo scope → two team boards (same layout as the live match scoreboard). */
  function singleMatchDemo(res, sc) {
    const list = res?.demos || [];
    if (list.length !== 1) return null;
    // Whole-library / multi-demo views stay as one table; only a single-demo
    // scope (match row stats, or filters that leave one demo) splits.
    if (sc?.demos?.length === 1) return list[0];
    if (!sc?.demos?.length && !sc?.files?.length && list.length === 1) return list[0];
    return null;
  }

  function matchBoardsHtml(playerRows, demo, opts) {
    const teamOf = new Map((demo.players || []).map((p) => [p.id, p.team]));
    const board = (team, name) => {
      const list = playerRows.filter((p) => teamOf.get(p.id) === team);
      return `<div class="st-board">
        <h4 class="st-board-name team${team}">${escapeHtml(name || `Team ${team}`)}</h4>
        ${statsTableHtml(list, {
          columns: PLAYER_COLUMNS,
          escapeHtml,
          sortKey: opts.sortKey,
          sortDir: opts.sortDir
        })}
      </div>`;
    };
    return `<div class="st-match-boards">
      ${board(1, demo.name1)}
      ${board(2, demo.name2)}
    </div>`;
  }

  /**
   * @param {{demos?: string[], files?: string[], title?: string}} next
   */
  async function load(next = {}) {
    const token = ++loadToken;
    scope = next;
    scopeEl.textContent = next.title || '';
    bodyEl.innerHTML = '<p class="view-empty">Loading…</p>';
    filter.maps = [];
    filter.side = '';
    filter.econ = null;
    filter.oppEcon = null;
    try {
      const res = await fetchStats(next.demos || null);
      if (token !== loadToken) return;
      payload = res;
      const rounds = (res.demos || []).reduce((n, d) => n + (d.rounds?.length || 0), 0);
      if (!rounds) {
        filtersEl.innerHTML = '';
        bodyEl.innerHTML =
          '<p class="view-empty">No parsed rounds to measure yet. Upload a replay first.</p>';
        return;
      }
      render();
    } catch (err) {
      if (token !== loadToken) return;
      filtersEl.innerHTML = '';
      bodyEl.innerHTML = `<p class="view-empty">${escapeHtml(err.message || 'Could not load stats.')}</p>`;
    }
  }

  return {
    el,
    load,
    destroy() {
      detachTips();
      el.remove();
    }
  };
}
