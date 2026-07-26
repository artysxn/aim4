// ---------------------------------------------------------------------------
// replays/stats/statsPanel.js
// The Statistics screen: two tables over one cached index.
//
// The payload is fetched once per scope and every filter, tab and sort after
// that is a re-aggregation in memory. Nothing here re-reads a round.
// ---------------------------------------------------------------------------

import { fetchStats } from '../api.js';
import {
  attachPlayerRoles,
  playerMatchesRoleFilter
} from '../roles/assignRoles.js';
import { CT_POSITIONS, CT_TACTICAL, T_POSITIONS, T_TACTICAL } from '../roles/regionKeys.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { aggregatePlayers, aggregateTeams, allRows, indexMaps } from '../shared/statsMath.js';
import {
  PLAYER_COLUMNS,
  TEAM_COLUMNS,
  attachTips,
  playerColumnsWithRoles,
  statsTableHtml
} from './statsTables.js';

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
    files: null,
    /** @type {{ side: 'T'|'CT', value: string } | null} */
    role: null
  };

  const detachTips = attachTips(el);

  function singleMap() {
    return filter.maps.length === 1 ? filter.maps[0] : '';
  }

  function payloadHasZoneRoles() {
    for (const d of payload?.demos || []) {
      for (const r of d.rounds || []) {
        if (r.z && Object.keys(r.z).length) return true;
      }
    }
    return false;
  }

  function roleMode() {
    if (!payloadHasZoneRoles()) return '';
    return singleMap() ? 'position' : 'tactical';
  }

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
    return `<label class="rp-awp-toggle${checked ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" data-awp="${id}" ${checked ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  function mapSelectHtml() {
    const maps = mapsInPayload();
    const selected = filter.maps[0] || '';
    const opts = maps
      .map(
        (code) =>
          `<option value="${escapeHtml(code)}"${code === selected ? ' selected' : ''}>${escapeHtml(
            MAPS[code]?.name || code
          )}</option>`
      )
      .join('');
    return `<select class="site-select st-map-select" data-filter="maps" aria-label="Map">
      <option value=""${!selected ? ' selected' : ''}>Any map</option>${opts}</select>`;
  }

  function roleFilterHtml() {
    const mode = roleMode();
    if (!mode || tab !== 'players') return '';

    const tOpts =
      mode === 'position'
        ? Object.values(T_POSITIONS).map((p) => p.label)
        : [...T_TACTICAL];
    const ctOpts =
      mode === 'position'
        ? Object.values(CT_POSITIONS).map((p) => p.label)
        : [...CT_TACTICAL];

    const chip = (side, value) => {
      const on = filter.role?.side === side && filter.role?.value === value;
      return `<button type="button" class="rp-chip${on ? ' active' : ''}" data-role-side="${side}" data-role-value="${escapeHtml(
        value
      )}">${escapeHtml(value)}</button>`;
    };

    const label = mode === 'position' ? 'Position' : 'Role';
    return `
      <div class="st-filter-group">
        <span class="st-filter-label">${label} (T)</span>
        <div class="rp-chips st-role-chips">${tOpts.map((v) => chip('T', v)).join('')}</div>
      </div>
      <div class="st-filter-group">
        <span class="st-filter-label">${label} (CT)</span>
        <div class="rp-chips st-role-chips">${ctOpts.map((v) => chip('CT', v)).join('')}</div>
      </div>`;
  }

  function renderFilters() {
    const sideBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        filter.side === value ? ' active' : ''
      }" data-side="${value}">${label}</button>`;

    filtersEl.innerHTML = `
      <div class="st-filter-group">
        <span class="st-filter-label">Map</span>
        ${mapSelectHtml()}
      </div>
      <div class="st-filter-group">
        <span class="st-filter-label">Side</span>
        <div class="rp-chips">${sideBtn('T', 'T')}${sideBtn('CT', 'CT')}</div>
      </div>
      ${roleFilterHtml()}
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
      <button type="button" class="btn btn-sm st-filter-clear" data-clear>Clear</button>`;
  }

  filtersEl.addEventListener('click', (e) => {
    const roleBtn = e.target.closest('[data-role-side]');
    if (roleBtn) {
      const side = roleBtn.dataset.roleSide === 'CT' ? 'CT' : 'T';
      const value = roleBtn.dataset.roleValue || '';
      if (filter.role?.side === side && filter.role?.value === value) filter.role = null;
      else filter.role = { side, value };
      render();
      return;
    }
    const side = e.target.closest('[data-side]');
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
      filter.role = null;
      render();
    }
  });

  filtersEl.addEventListener('change', (e) => {
    const awp = e.target.closest('[data-awp]');
    if (awp) {
      filter[awp.dataset.awp] = Boolean(awp.checked);
      awp.closest('.rp-awp-toggle')?.classList.toggle('active', awp.checked);
      render();
      return;
    }
    const sel = e.target.closest('[data-filter]');
    if (!sel) return;
    if (sel.dataset.filter === 'maps') {
      filter.maps = sel.value ? [sel.value] : [];
      filter.role = null;
      render();
      return;
    }
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

  function enrichedPlayers(rows, players, active) {
    const data = aggregatePlayers(rows, players, active);
    const withRoles = attachPlayerRoles(data, payload, active);
    if (!filter.role) return withRoles;
    return withRoles.filter((p) => playerMatchesRoleFilter(p, filter.role));
  }

  function render() {
    if (!payload) return;
    renderFilters();
    const { players, demos } = indexMaps(payload);
    const rows = allRows(payload);
    const active = { ...filter, files: scope.files || null };
    const mode = roleMode();
    const columns = mode ? playerColumnsWithRoles(mode) : PLAYER_COLUMNS;

    if (tab === 'players') {
      const data = enrichedPlayers(rows, players, active);
      const matchDemo = singleMatchDemo(payload, scope);
      if (matchDemo) {
        bodyEl.innerHTML = matchBoardsHtml(data, matchDemo, {
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir,
          columns
        });
      } else {
        bodyEl.innerHTML = statsTableHtml(data, {
          columns,
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
    if (sc?.demos?.length === 1) return list[0];
    if (!sc?.demos?.length && !sc?.files?.length && list.length === 1) return list[0];
    return null;
  }

  function matchBoardsHtml(playerRows, demo, opts) {
    const teamOf = new Map((demo.players || []).map((p) => [p.id, p.team]));
    const columns = opts.columns || PLAYER_COLUMNS;
    const board = (team, name) => {
      const list = playerRows.filter((p) => teamOf.get(p.id) === team);
      return `<div class="st-board">
        <h4 class="st-board-name team${team}">${escapeHtml(name || `Team ${team}`)}</h4>
        ${statsTableHtml(list, {
          columns,
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
    filter.hasAwp = false;
    filter.oppHasAwp = false;
    filter.role = null;
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
