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
  payloadHasRoles,
  playerMatchesRoleFilter
} from '../roles/assignRoles.js';
import {
  CT_TACTICAL,
  T_TACTICAL,
  positionRoleOptions,
  roleHowText
} from '../roles/regionKeys.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { aggregatePlayers, aggregateTeams, allRows, indexMaps } from '../shared/statsMath.js';
import {
  PLAYER_COLUMNS,
  PLAYER_FIXED_BASE,
  TEAM_COLUMNS,
  STATS_PAGE_SIZE,
  attachTips,
  bindStatsHScroll,
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
  let page = { players: 1, teams: 1 };
  let loadToken = 0;

  const filter = {
    maps: [],
    side: '',
    econ: null,
    oppEcon: null,
    hasAwp: false,
    oppHasAwp: false,
    files: null,
    result: '',
    advantage: '',
    /** @type {{ side: 'T'|'CT', value: string } | null} */
    role: null
  };

  const detachTips = attachTips(el);

  function singleMap() {
    return filter.maps.length === 1 ? filter.maps[0] : '';
  }

  function roleMode() {
    if (!payloadHasRoles(payload)) return '';
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

  function roleSelectHtml(side) {
    const mode = roleMode();
    if (!mode) return '';
    const opts =
      mode === 'position'
        ? positionRoleOptions(side)
        : side === 'CT'
          ? CT_TACTICAL
          : T_TACTICAL;
    const selected = filter.role?.side === side ? filter.role.value : '';
    const anyLabel = mode === 'position' ? 'Any position' : 'Any role';
    const options = opts
      .map((o) => {
        const label = o.label;
        const how = o.how || roleHowText(side, label, mode);
        return `<option value="${escapeHtml(label)}" title="${escapeHtml(how)}"${
          label === selected ? ' selected' : ''
        }>${escapeHtml(label)}</option>`;
      })
      .join('');
    return `<select class="site-select st-role-select" data-role-filter="${side}" aria-label="${
      side === 'CT' ? 'CT' : 'T'
    } ${mode === 'position' ? 'position' : 'role'}">
      <option value=""${!selected ? ' selected' : ''}>${anyLabel}</option>${options}</select>`;
  }

  function renderFilters() {
    const mode = roleMode();
    const sideBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        filter.side === value ? ' active' : ''
      }" data-side="${value}">${label}</button>`;
    const resultBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        filter.result === value ? ' active' : ''
      }" data-result="${value}">${label}</button>`;
    const advBtn = (value, label) =>
      `<button type="button" class="rp-chip${
        filter.advantage === value ? ' active' : ''
      }" data-advantage="${value}">${label}</button>`;

    const roleGroups =
      mode && tab === 'players'
        ? `
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">T ${mode === 'position' ? 'pos' : 'role'}</span>
        ${roleSelectHtml('T')}
      </div>
      <div class="st-filter-group st-filter-stack">
        <span class="st-filter-label">CT ${mode === 'position' ? 'pos' : 'role'}</span>
        ${roleSelectHtml('CT')}
      </div>`
        : '';

    filtersEl.innerHTML = `
      <div class="st-filters-scroll">
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">Map</span>
          ${mapSelectHtml()}
        </div>
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">Side</span>
          <div class="rp-chips">${sideBtn('T', 'T')}${sideBtn('CT', 'CT')}</div>
        </div>
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">Result</span>
          <div class="rp-chips">${resultBtn('won', 'Won')}${resultBtn('lost', 'Lost')}</div>
        </div>
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">Opening</span>
          <div class="rp-chips">${advBtn('5v4', '5v4')}${advBtn('4v5', '4v5')}</div>
        </div>
        ${roleGroups}
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">${tab === 'teams' ? 'Team buy' : 'Own buy'}</span>
          <div class="st-filter-row">${econSelect('econ', filter.econ)}${hasAwpCheck(
            'hasAwp',
            filter.hasAwp
          )}</div>
        </div>
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">Opp buy</span>
          <div class="st-filter-row">${econSelect('oppEcon', filter.oppEcon)}${hasAwpCheck(
            'oppHasAwp',
            filter.oppHasAwp
          )}</div>
        </div>
      </div>
      <button type="button" class="btn btn-sm st-filter-clear" data-clear>Clear</button>`;
  }

  filtersEl.addEventListener('click', (e) => {
    const side = e.target.closest('[data-side]');
    if (side) {
      filter.side = filter.side === side.dataset.side ? '' : side.dataset.side;
      page[tab] = 1;
      render();
      return;
    }
    const result = e.target.closest('[data-result]');
    if (result) {
      filter.result = filter.result === result.dataset.result ? '' : result.dataset.result;
      page[tab] = 1;
      render();
      return;
    }
    const adv = e.target.closest('[data-advantage]');
    if (adv) {
      filter.advantage =
        filter.advantage === adv.dataset.advantage ? '' : adv.dataset.advantage;
      page[tab] = 1;
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
      filter.result = '';
      filter.advantage = '';
      filter.role = null;
      page[tab] = 1;
      render();
    }
  });

  filtersEl.addEventListener('change', (e) => {
    const awp = e.target.closest('[data-awp]');
    if (awp) {
      filter[awp.dataset.awp] = Boolean(awp.checked);
      awp.closest('.rp-awp-toggle')?.classList.toggle('active', awp.checked);
      page[tab] = 1;
      render();
      return;
    }
    const roleSel = e.target.closest('[data-role-filter]');
    if (roleSel) {
      const side = roleSel.dataset.roleFilter === 'CT' ? 'CT' : 'T';
      const value = roleSel.value || '';
      filter.role = value ? { side, value } : null;
      page[tab] = 1;
      render();
      return;
    }
    const sel = e.target.closest('[data-filter]');
    if (!sel) return;
    if (sel.dataset.filter === 'maps') {
      filter.maps = sel.value ? [sel.value] : [];
      filter.role = null;
      page[tab] = 1;
      render();
      return;
    }
    const value = sel.value === '' ? null : Number(sel.value);
    filter[sel.dataset.filter] = value;
    page[tab] = 1;
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
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) {
      if (pageBtn.disabled) return;
      const next = Number(pageBtn.dataset.page);
      if (!Number.isFinite(next) || next < 1) return;
      page[tab] = next;
      render();
      return;
    }
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const s = sort[tab];
    if (s.key === th.dataset.sort) s.dir = s.dir === 'desc' ? 'asc' : 'desc';
    else {
      s.key = th.dataset.sort;
      s.dir = th.dataset.sort === 'name' || th.dataset.sort === 'team' ? 'asc' : 'desc';
    }
    page[tab] = 1;
    render();
  });

  // ---- render -------------------------------------------------------------

  function enrichedPlayers(rows, players, active, demos) {
    const data = aggregatePlayers(rows, players, active, demos);
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
    const playerCols = mode
      ? playerColumnsWithRoles(mode)
      : { columns: PLAYER_COLUMNS, fixedCount: PLAYER_FIXED_BASE.length };

    if (tab === 'players') {
      const data = enrichedPlayers(rows, players, active, demos);
      const matchDemo = singleMatchDemo(payload, scope);
      if (matchDemo) {
        bodyEl.innerHTML = matchBoardsHtml(data, matchDemo, {
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir,
          columns: playerCols.columns,
          fixedCount: playerCols.fixedCount
        });
      } else {
        bodyEl.innerHTML = statsTableHtml(data, {
          columns: playerCols.columns,
          fixedCount: playerCols.fixedCount,
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir,
          page: page.players,
          pageSize: STATS_PAGE_SIZE
        });
      }
    } else {
      const data = aggregateTeams(rows, players, demos, active);
      bodyEl.innerHTML = statsTableHtml(data, {
        columns: TEAM_COLUMNS,
        fixedCount: 2,
        escapeHtml,
        sortKey: sort.teams.key,
        sortDir: sort.teams.dir,
        page: page.teams,
        pageSize: STATS_PAGE_SIZE
      });
    }
    bindStatsHScroll(bodyEl);
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
    const fixedCount = opts.fixedCount ?? PLAYER_FIXED_BASE.length;
    const board = (team, name) => {
      const list = playerRows.filter((p) => teamOf.get(p.id) === team);
      return `<div class="st-board">
        <h4 class="st-board-name team${team}">${escapeHtml(name || `Team ${team}`)}</h4>
        ${statsTableHtml(list, {
          columns,
          fixedCount,
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
    page = { players: 1, teams: 1 };
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
