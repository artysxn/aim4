// ---------------------------------------------------------------------------
// replays/stats/statsPanel.js
// The Statistics screen: two tables over one cached index.
//
// The payload is fetched once per scope and every filter, tab and sort after
// that is a re-aggregation in memory. Nothing here re-reads a round.
// ---------------------------------------------------------------------------

import { fetchStats, formatApiError } from '../api.js';
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
import {
  aggregatePlayers,
  aggregateTeams,
  allRows,
  indexMaps,
  rowPasses,
  teamNameKey
} from '../shared/statsMath.js';
import {
  PLAYER_COLUMNS,
  PLAYER_FIXED_BASE,
  TEAM_COLUMNS,
  STATS_PAGE_SIZE,
  attachTips,
  bindStatsHScroll,
  playerColumnsWithRoles,
  playerMatchColumns,
  teamMatchColumns,
  statsTableHtml
} from './statsTables.js';
import { spinnerHtml, watchSlowLoad } from '../../lib/spinner.js';

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   onDetailChange?: (detail: null | { kind: 'player'|'team', id?: string, name?: string, label: string }) => void
 * }} deps
 */
export function createStatsPanel({ escapeHtml, onDetailChange }) {
  const el = document.createElement('div');
  el.className = 'st-panel';
  el.innerHTML = `
    <div class="st-head">
      <div class="st-head-main">
        <button type="button" class="btn btn-sm st-back" data-st-back hidden>Back</button>
        <div class="st-tabs">
          <button type="button" class="seg-tab active" data-tab="players">Players</button>
          <button type="button" class="seg-tab" data-tab="teams">Teams</button>
        </div>
        <span class="st-detail-label" id="st-detail-label" hidden></span>
      </div>
      <span class="st-scope" id="st-scope"></span>
    </div>
    <div class="st-filters" id="st-filters"></div>
    <div class="st-body" id="st-body"><div class="is-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading</span></div></div>`;

  const filtersEl = el.querySelector('#st-filters');
  const bodyEl = el.querySelector('#st-body');
  const scopeEl = el.querySelector('#st-scope');
  const tabsEl = el.querySelector('.st-tabs');
  const backEl = el.querySelector('[data-st-back]');
  const detailLabelEl = el.querySelector('#st-detail-label');

  let payload = null;
  let scope = {};
  /** When set, only players/rounds under this team display name are counted. */
  let lockedTeamName = '';
  let tab = 'players';
  let sort = { players: { key: 'rating', dir: 'desc' }, teams: { key: 'avgRating', dir: 'desc' } };
  let page = { players: 1, teams: 1 };
  let loadToken = 0;
  /** @type {null | { kind: 'player', id: string, label: string } | { kind: 'team', name: string, label: string }} */
  let detail = null;
  let detailSort = { key: 'date', dir: 'desc' };
  let detailPage = 1;

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
    /** Minimum rounds played to appear in the table (0 = no floor). */
    minRounds: 0,
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
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">Min rounds</span>
          <input
            class="site-input st-min-rounds"
            type="number"
            min="0"
            step="1"
            data-filter="minRounds"
            value="${filter.minRounds || 0}"
            title="Hide rows with fewer rounds than this"
            aria-label="Minimum rounds played"
          />
        </div>
      </div>
      <button type="button" class="btn btn-sm st-filter-clear" data-clear>Clear</button>`;
  }

  function resetListPage() {
    if (detail) detailPage = 1;
    else page[tab] = 1;
  }

  filtersEl.addEventListener('click', (e) => {
    const side = e.target.closest('[data-side]');
    if (side) {
      filter.side = filter.side === side.dataset.side ? '' : side.dataset.side;
      resetListPage();
      render();
      return;
    }
    const result = e.target.closest('[data-result]');
    if (result) {
      filter.result = filter.result === result.dataset.result ? '' : result.dataset.result;
      resetListPage();
      render();
      return;
    }
    const adv = e.target.closest('[data-advantage]');
    if (adv) {
      filter.advantage =
        filter.advantage === adv.dataset.advantage ? '' : adv.dataset.advantage;
      resetListPage();
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
      filter.minRounds = 0;
      resetListPage();
      render();
    }
  });

  filtersEl.addEventListener('change', (e) => {
    const awp = e.target.closest('[data-awp]');
    if (awp) {
      filter[awp.dataset.awp] = Boolean(awp.checked);
      awp.closest('.rp-awp-toggle')?.classList.toggle('active', awp.checked);
      resetListPage();
      render();
      return;
    }
    const roleSel = e.target.closest('[data-role-filter]');
    if (roleSel) {
      const side = roleSel.dataset.roleFilter === 'CT' ? 'CT' : 'T';
      const value = roleSel.value || '';
      filter.role = value ? { side, value } : null;
      resetListPage();
      render();
      return;
    }
    const sel = e.target.closest('[data-filter]');
    if (!sel) return;
    if (sel.dataset.filter === 'maps') {
      filter.maps = sel.value ? [sel.value] : [];
      filter.role = null;
      resetListPage();
      render();
      return;
    }
    if (sel.dataset.filter === 'minRounds') {
      const n = Math.max(0, Math.floor(Number(sel.value) || 0));
      filter.minRounds = n;
      sel.value = String(n);
      resetListPage();
      render();
      return;
    }
    const value = sel.value === '' ? null : Number(sel.value);
    filter[sel.dataset.filter] = value;
    resetListPage();
    render();
  });

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === tab || detail) return;
    tab = btn.dataset.tab;
    el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    render();
  });

  backEl.addEventListener('click', () => {
    clearDetail();
    render();
  });

  bodyEl.addEventListener('click', (e) => {
    const playerBtn = e.target.closest('[data-st-player]');
    if (playerBtn) {
      openPlayerDetail(playerBtn.dataset.stPlayer, playerBtn.textContent || '');
      return;
    }
    const teamBtn = e.target.closest('[data-st-team]');
    if (teamBtn) {
      openTeamDetail(teamBtn.dataset.stTeam, teamBtn.textContent || '');
      return;
    }
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) {
      if (pageBtn.disabled) return;
      const next = Number(pageBtn.dataset.page);
      if (!Number.isFinite(next) || next < 1) return;
      if (detail) detailPage = next;
      else page[tab] = next;
      render();
      return;
    }
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const s = detail ? detailSort : sort[tab];
    if (s.key === th.dataset.sort) s.dir = s.dir === 'desc' ? 'asc' : 'desc';
    else {
      s.key = th.dataset.sort;
      s.dir =
        th.dataset.sort === 'name' ||
        th.dataset.sort === 'team' ||
        th.dataset.sort === 'map' ||
        th.dataset.sort === 'opponent' ||
        th.dataset.sort === 'result'
          ? 'asc'
          : 'desc';
    }
    if (detail) detailPage = 1;
    else page[tab] = 1;
    render();
  });

  // ---- render -------------------------------------------------------------

  function notifyDetail() {
    onDetailChange?.(detail);
  }

  function clearDetail() {
    detail = null;
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    notifyDetail();
  }

  function openPlayerDetail(id, label) {
    const pid = String(id || '').trim();
    if (!pid) return;
    detail = { kind: 'player', id: pid, label: String(label || pid).trim() || pid };
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    tab = 'players';
    el.querySelectorAll('[data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === 'players')
    );
    notifyDetail();
    render();
  }

  function openTeamDetail(name, label) {
    const team = String(name || '').trim();
    if (!team || team === '—' || team === 'Multiple') return;
    detail = { kind: 'team', name: team, label: String(label || team).trim() || team };
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    tab = 'teams';
    el.querySelectorAll('[data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === 'teams')
    );
    notifyDetail();
    render();
  }

  function syncHead() {
    const inDetail = Boolean(detail);
    backEl.hidden = !inDetail;
    tabsEl.hidden = inDetail;
    detailLabelEl.hidden = !inDetail;
    if (inDetail) {
      const kind = detail.kind === 'team' ? 'Team' : 'Player';
      detailLabelEl.textContent = `${kind} · ${detail.label}`;
    } else {
      detailLabelEl.textContent = '';
    }
  }

  function enrichedPlayers(rows, players, active, demos) {
    const data = aggregatePlayers(rows, players, active, demos);
    const withRoles = attachPlayerRoles(data, payload, active);
    if (!filter.role) return withRoles;
    return withRoles.filter((p) => playerMatchesRoleFilter(p, filter.role));
  }

  function mapLabel(demo) {
    return demo.mapName || MAPS[demo.map]?.name || demo.map || '—';
  }

  function filteredScore(demo, team, active, players) {
    let mine = 0;
    let theirs = 0;
    for (const row of demo.rounds || []) {
      if (!rowPasses(row, active, team, players)) continue;
      if (row.w === team) mine++;
      else if (row.w === 1 || row.w === 2) theirs++;
    }
    return { mine, theirs, label: `${mine}:${theirs}`, sort: mine - theirs };
  }

  function buildPlayerMatchRows(playerId, active, players, demos) {
    const out = [];
    for (const demo of payload.demos || []) {
      const seat = (demo.players || []).find((p) => p.id === playerId);
      if (!seat) continue;
      const team = seat.team === 2 ? 2 : 1;
      let agg = aggregatePlayers(demo.rounds || [], players, active, demos).find(
        (p) => p.id === playerId
      );
      if (!agg || !(agg.rounds > 0)) continue;
      if (filter.role) {
        const withRoles = attachPlayerRoles([agg], { demos: [demo] }, active);
        agg = withRoles[0] || agg;
        if (!playerMatchesRoleFilter(agg, filter.role)) continue;
      }
      const score = filteredScore(demo, team, active, players);
      const opp = team === 1 ? demo.name2 : demo.name1;
      out.push({
        ...agg,
        demoId: demo.id,
        map: demo.map || '',
        mapName: mapLabel(demo),
        scoreLabel: score.label,
        scoreSort: score.sort,
        result: demo.winner === team ? 'W' : demo.winner ? 'L' : '—',
        opponent: opp || '—',
        uploadedAt: demo.uploadedAt || 0
      });
    }
    return out;
  }

  function buildTeamMatchRows(teamName, active, players, demos) {
    const key = teamNameKey(teamName);
    if (!key) return [];
    const out = [];
    for (const demo of payload.demos || []) {
      const side =
        teamNameKey(demo.name1) === key ? 1 : teamNameKey(demo.name2) === key ? 2 : 0;
      if (!side) continue;
      const agg = aggregateTeams(demo.rounds || [], players, demos, {
        ...active,
        teamName
      }).find((t) => teamNameKey(t.name) === key);
      if (!agg || !(agg.rounds > 0)) continue;
      const score = filteredScore(demo, side, active, players);
      const opp = side === 1 ? demo.name2 : demo.name1;
      out.push({
        ...agg,
        demoId: demo.id,
        map: demo.map || '',
        mapName: mapLabel(demo),
        scoreLabel: score.label,
        scoreSort: score.sort,
        result: demo.winner === side ? 'W' : demo.winner ? 'L' : '—',
        opponent: opp || '—',
        uploadedAt: demo.uploadedAt || 0
      });
    }
    return out;
  }

  function playerNameCell(r) {
    return `<button type="button" class="st-link" data-st-player="${escapeHtml(
      r.id
    )}">${escapeHtml(r.name)}</button>`;
  }

  function playerTeamCell(r) {
    const teams = r.teams || [];
    if (teams.length !== 1) {
      const text = r.teamLabel || '—';
      return r.teams?.length > 1 ? `<em>${escapeHtml(text)}</em>` : escapeHtml(text);
    }
    const name = teams[0].name;
    return `<button type="button" class="st-link" data-st-team="${escapeHtml(
      name
    )}">${escapeHtml(name)}</button>`;
  }

  function teamNameCell(r) {
    return `<button type="button" class="st-link" data-st-team="${escapeHtml(
      r.name
    )}">${escapeHtml(r.name)}</button>`;
  }

  function renderDetail(active, players, demos) {
    if (detail.kind === 'player') {
      let data = buildPlayerMatchRows(detail.id, active, players, demos);
      if (detail.label === detail.id) {
        const named = data.find((r) => r.name);
        if (named?.name) detail.label = named.name;
      }
      const cols = playerMatchColumns();
      bodyEl.innerHTML = statsTableHtml(data, {
        columns: cols.columns,
        fixedCount: cols.fixedCount,
        escapeHtml,
        sortKey: detailSort.key,
        sortDir: detailSort.dir,
        page: detailPage,
        pageSize: STATS_PAGE_SIZE,
        showAverage: true
      });
      return;
    }
    let data = buildTeamMatchRows(detail.name, active, players, demos);
    if (detail.label === detail.name) {
      const named = data.find((r) => r.name);
      if (named?.name) detail.label = named.name;
    }
    const cols = teamMatchColumns();
    bodyEl.innerHTML = statsTableHtml(data, {
      columns: cols.columns,
      fixedCount: cols.fixedCount,
      escapeHtml,
      sortKey: detailSort.key,
      sortDir: detailSort.dir,
      page: detailPage,
      pageSize: STATS_PAGE_SIZE,
      showAverage: true
    });
  }

  function render() {
    if (!payload) return;
    syncHead();
    renderFilters();
    const { players, demos } = indexMaps(payload);
    const rows = allRows(payload);
    const active = {
      ...filter,
      files: scope.files || null,
      ...(lockedTeamName ? { teamName: lockedTeamName } : {})
    };

    if (detail) {
      renderDetail(active, players, demos);
      syncHead();
      bindStatsHScroll(bodyEl);
      return;
    }

    const mode = roleMode();
    const playerCols = mode
      ? playerColumnsWithRoles(mode)
      : { columns: PLAYER_COLUMNS, fixedCount: PLAYER_FIXED_BASE.length };

    if (tab === 'players') {
      let data = enrichedPlayers(rows, players, active, demos);
      const minR = Math.max(0, Number(filter.minRounds) || 0);
      if (minR > 0) data = data.filter((p) => (p.rounds || 0) >= minR);
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
          pageSize: STATS_PAGE_SIZE,
          showAverage: true,
          nameCell: playerNameCell,
          teamCell: playerTeamCell
        });
      }
    } else {
      let data = aggregateTeams(rows, players, demos, active);
      const minR = Math.max(0, Number(filter.minRounds) || 0);
      if (minR > 0) data = data.filter((t) => (t.rounds || 0) >= minR);
      bodyEl.innerHTML = statsTableHtml(data, {
        columns: TEAM_COLUMNS,
        fixedCount: 2,
        escapeHtml,
        sortKey: sort.teams.key,
        sortDir: sort.teams.dir,
        page: page.teams,
        pageSize: STATS_PAGE_SIZE,
        showAverage: true,
        nameCell: teamNameCell
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
   * @param {{
   *   demos?: string[],
   *   files?: string[],
   *   title?: string,
   *   teamName?: string,
   *   maps?: string[],
   *   tab?: 'players'|'teams',
   *   player?: string,
   *   team?: string
   * }} next
   */
  async function load(next = {}) {
    const token = ++loadToken;
    scope = next;
    lockedTeamName = String(next.teamName || '').trim();
    scopeEl.textContent = next.title || '';
    bodyEl.innerHTML = spinnerHtml('Loading database…');
    filtersEl.innerHTML = '';
    const cancelSlow = watchSlowLoad(bodyEl, {
      message:
        'Still loading the database after 4s. Stats indexes may be rebuilding, or the API may be unreachable (Failed to fetch).'
    });
    filter.maps = Array.isArray(next.maps) ? [...next.maps] : [];
    filter.side = '';
    filter.econ = null;
    filter.oppEcon = null;
    filter.hasAwp = false;
    filter.oppHasAwp = false;
    filter.role = null;
    filter.minRounds = 0;
    filter.result = '';
    filter.advantage = '';
    if (next.tab === 'players' || next.tab === 'teams') tab = next.tab;
    el.querySelectorAll('[data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    page = { players: 1, teams: 1 };
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    if (next.player) {
      detail = {
        kind: 'player',
        id: String(next.player),
        label: String(next.playerLabel || next.player)
      };
      tab = 'players';
    } else if (next.team) {
      detail = {
        kind: 'team',
        name: String(next.team),
        label: String(next.teamLabel || next.team)
      };
      tab = 'teams';
    } else {
      detail = null;
    }
    el.querySelectorAll('[data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    notifyDetail();
    try {
      const res = await fetchStats(next.demos || null);
      cancelSlow();
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
      cancelSlow();
      if (token !== loadToken) return;
      filtersEl.innerHTML = '';
      const msg = formatApiError(err).message || 'Could not load stats.';
      bodyEl.innerHTML = `<p class="view-empty">${escapeHtml(msg)}</p>
        <button type="button" class="btn btn-sm" data-st-retry>Retry</button>`;
      bodyEl.querySelector('[data-st-retry]')?.addEventListener('click', () => load(scope));
    }
  }

  /**
   * Change tab / map filter without refetching. Used by Team Overview map picks.
   * @param {{tab?: 'players'|'teams', maps?: string[]|string|null}} opts
   */
  function applyView(opts = {}) {
    if (opts.tab === 'players' || opts.tab === 'teams') {
      tab = opts.tab;
      el.querySelectorAll('[data-tab]').forEach((b) =>
        b.classList.toggle('active', b.dataset.tab === tab)
      );
    }
    if ('maps' in opts) {
      const m = opts.maps;
      if (Array.isArray(m)) filter.maps = [...m];
      else if (typeof m === 'string' && m) filter.maps = [m];
      else filter.maps = [];
      filter.role = null;
    }
    if (detail) detailPage = 1;
    else page[tab] = 1;
    if (payload) render();
  }

  return {
    el,
    load,
    applyView,
    openPlayerDetail,
    openTeamDetail,
    clearDetail,
    getDetail: () => detail,
    destroy() {
      detachTips();
      el.remove();
    }
  };
}
