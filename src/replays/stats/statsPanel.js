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
 *   onViewChange?: (state: object) => void,
 *   onDetailChange?: (detail: null | { kind: 'player'|'team', id?: string, name?: string, label: string }) => void
 * }} deps
 */
/** Default minimum rounds filter when opening Database (can still be set to 0). */
export const DEFAULT_MIN_ROUNDS = 80;

export function createStatsPanel({ escapeHtml, onViewChange, onDetailChange }) {
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
    minRounds: DEFAULT_MIN_ROUNDS,
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
      filter.minRounds = DEFAULT_MIN_ROUNDS;
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

  /** True when the user is dragging a text selection inside a name link. */
  function selectionInside(el) {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
    return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
  }

  function activateNameLink(link) {
    if (!link || selectionInside(link)) return false;
    if (link.dataset.stPlayer != null) {
      openPlayerDetail(link.dataset.stPlayer, link.textContent || '');
      return true;
    }
    if (link.dataset.stTeam != null) {
      openTeamDetail(link.dataset.stTeam, link.textContent || '');
      return true;
    }
    return false;
  }

  bodyEl.addEventListener('click', (e) => {
    const nameLink = e.target.closest('[data-st-player], [data-st-team]');
    if (nameLink && activateNameLink(nameLink)) return;
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

  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const nameLink = e.target.closest?.('[data-st-player], [data-st-team]');
    if (!nameLink || e.target !== nameLink) return;
    e.preventDefault();
    activateNameLink(nameLink);
  });

  // ---- view state (URL / share) -------------------------------------------

  function activeSort() {
    return detail ? detailSort : sort[tab] || sort.players;
  }

  function activePage() {
    return detail ? detailPage : page[tab] || 1;
  }

  /** Snapshot of filters, tab, sort, page, and player/team selection. */
  function viewState() {
    const s = activeSort();
    return {
      tab,
      maps: [...(filter.maps || [])],
      side: filter.side || '',
      result: filter.result || '',
      advantage: filter.advantage || '',
      econ: filter.econ,
      oppEcon: filter.oppEcon,
      hasAwp: Boolean(filter.hasAwp),
      oppHasAwp: Boolean(filter.oppHasAwp),
      minRounds: Math.max(0, Number(filter.minRounds) || 0),
      role: filter.role ? { side: filter.role.side, value: filter.role.value } : null,
      sortKey: s?.key || (tab === 'teams' ? 'avgRating' : 'rating'),
      sortDir: s?.dir === 'asc' ? 'asc' : 'desc',
      page: Math.max(1, Number(activePage()) || 1),
      player: detail?.kind === 'player' ? detail.id : '',
      team: detail?.kind === 'team' ? detail.name : '',
      playerLabel: detail?.kind === 'player' ? detail.label : '',
      teamLabel: detail?.kind === 'team' ? detail.label : '',
      demos: Array.isArray(scope.demos) ? [...scope.demos] : undefined,
      files: Array.isArray(scope.files) ? [...scope.files] : undefined,
      title: scope.title || '',
      teamName: lockedTeamName || ''
    };
  }

  function emitViewChange() {
    const state = viewState();
    onViewChange?.(state);
    onDetailChange?.(detail);
  }

  /**
   * Apply a shared / URL view without refetching. Unknown fields are ignored.
   * @param {object} next
   * @param {{ notify?: boolean }} [opts]
   */
  function applyViewState(next = {}, opts = {}) {
    const notify = opts.notify !== false;
    if (next.tab === 'players' || next.tab === 'teams') tab = next.tab;

    if ('maps' in next) {
      const m = next.maps;
      if (Array.isArray(m)) filter.maps = m.map(String).filter(Boolean);
      else if (typeof m === 'string' && m) filter.maps = [m];
      else if (next.map) filter.maps = [String(next.map)];
      else filter.maps = [];
    } else if (next.map) {
      filter.maps = [String(next.map)];
    }

    if ('side' in next) filter.side = next.side === 'T' || next.side === 'CT' ? next.side : '';
    if ('result' in next) {
      filter.result = next.result === 'won' || next.result === 'lost' ? next.result : '';
    }
    if ('advantage' in next || 'adv' in next) {
      const adv = next.advantage ?? next.adv ?? '';
      filter.advantage = String(adv || '');
    }
    if ('econ' in next) {
      const n = next.econ;
      filter.econ = n === null || n === '' || n === undefined ? null : Number(n);
      if (!Number.isFinite(filter.econ)) filter.econ = null;
    }
    if ('oppEcon' in next) {
      const n = next.oppEcon;
      filter.oppEcon = n === null || n === '' || n === undefined ? null : Number(n);
      if (!Number.isFinite(filter.oppEcon)) filter.oppEcon = null;
    }
    if ('hasAwp' in next || 'awp' in next) {
      filter.hasAwp = Boolean(next.hasAwp ?? next.awp);
    }
    if ('oppHasAwp' in next || 'oppAwp' in next) {
      filter.oppHasAwp = Boolean(next.oppHasAwp ?? next.oppAwp);
    }
    if ('minRounds' in next || 'minR' in next) {
      filter.minRounds = Math.max(0, Math.floor(Number(next.minRounds ?? next.minR) || 0));
    }
    if ('role' in next) {
      const r = next.role;
      if (r && typeof r === 'object' && (r.side === 'T' || r.side === 'CT') && r.value) {
        filter.role = { side: r.side, value: String(r.value) };
      } else if (typeof r === 'string' && r.includes(':')) {
        const i = r.indexOf(':');
        const side = r.slice(0, i);
        const value = r.slice(i + 1);
        filter.role =
          (side === 'T' || side === 'CT') && value ? { side, value } : null;
      } else {
        filter.role = null;
      }
    }

    const sortKey = String(next.sortKey || next.sort || '').trim();
    const sortDir = next.sortDir === 'asc' || next.dir === 'asc' ? 'asc' : 'desc';
    const pageNum = Math.max(1, Math.floor(Number(next.page) || 1));

    if (next.player) {
      detail = {
        kind: 'player',
        id: String(next.player),
        label: String(next.playerLabel || next.label || next.player)
      };
      tab = 'players';
      detailSort = { key: sortKey || 'date', dir: sortDir };
      detailPage = pageNum;
    } else if (next.team) {
      detail = {
        kind: 'team',
        name: String(next.team),
        label: String(next.teamLabel || next.label || next.team)
      };
      tab = 'teams';
      detailSort = { key: sortKey || 'date', dir: sortDir };
      detailPage = pageNum;
    } else if ('player' in next || 'team' in next) {
      detail = null;
      detailPage = 1;
      detailSort = { key: 'date', dir: 'desc' };
      if (sortKey) {
        sort[tab] = { key: sortKey, dir: sortDir };
        page[tab] = pageNum;
      }
    } else if (sortKey) {
      if (detail) {
        detailSort = { key: sortKey, dir: sortDir };
        detailPage = pageNum;
      } else {
        sort[tab] = { key: sortKey, dir: sortDir };
        page[tab] = pageNum;
      }
    } else if ('page' in next) {
      if (detail) detailPage = pageNum;
      else page[tab] = pageNum;
    }

    if ('teamName' in next && next.teamName != null) {
      lockedTeamName = String(next.teamName || '').trim();
    }
    if ('title' in next && next.title != null) scopeEl.textContent = String(next.title || '');
    if (Array.isArray(next.demos)) scope = { ...scope, demos: [...next.demos] };
    if (Array.isArray(next.files)) scope = { ...scope, files: [...next.files] };

    el.querySelectorAll('[data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    if (payload) render();
    else if (notify) emitViewChange();
  }

  function clearDetail() {
    detail = null;
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    render();
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

  /**
   * Empty row for a roster player who has no rounds under the active filter.
   * Keeps them on the team Overview table instead of disappearing.
   */
  function absentPlayerRow(base) {
    return {
      ...base,
      rounds: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      kd: null,
      adr: null,
      adrWon: null,
      adrLost: null,
      shots: 0,
      hits: 0,
      headshots: 0,
      accuracy: null,
      awpShots: 0,
      awpHits: 0,
      awpAccuracy: null,
      kast: null,
      impact: null,
      rating: null,
      ratingT: null,
      ratingCT: null,
      ratingWon: null,
      ratingLost: null,
      ratingFullVsFull: null,
      ratingFullVsFullRounds: 0,
      a4r: null,
      a4rDetail: null,
      a4or: null,
      openKills: 0,
      openDeaths: 0,
      opkd: null,
      opatt: null,
      opkRate: null,
      prwSwing: null,
      prwSwingTotal: 0,
      prwSwingRounds: 0,
      prwSwingWon: null,
      prwSwingLost: null,
      psdt: null,
      psdtTotal: 0,
      psdtRounds: 0,
      dt: null,
      dtTotal: 0,
      dtRounds: 0,
      pfw: null,
      pfo: null,
      tfw: null,
      xk: null,
      xkTotal: null,
      duels: null,
      pfoBuckets: [],
      heDmgPerNade: null,
      fireDmgPerNade: null,
      blindPerFlash: null,
      flashHitRate: null,
      utilDmgPerRound: null,
      a4aim: null,
      aimRaw: null,
      aimComponents: null,
      aimSample: null,
      absent: true
    };
  }

  /**
   * On the team page, keep every player who qualifies for the map/team scope
   * (min-rounds against that scope), even when side/result/opening filters
   * leave them with 0 matching rounds.
   */
  function pinTeamRoster(rows, players, active, demos, filtered, minR) {
    if (!lockedTeamName) {
      return minR > 0 ? filtered.filter((p) => (p.rounds || 0) >= minR) : filtered;
    }
    const rosterActive = {
      maps: active.maps,
      files: active.files,
      teamName: lockedTeamName
    };
    let roster = enrichedPlayers(rows, players, rosterActive, demos);
    if (minR > 0) roster = roster.filter((p) => (p.rounds || 0) >= minR);
    if (!roster.length) {
      return minR > 0 ? filtered.filter((p) => (p.rounds || 0) >= minR) : filtered;
    }
    const byId = new Map(filtered.map((p) => [p.id, p]));
    return roster.map((base) => byId.get(base.id) || absentPlayerRow(base));
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

  function playerLink(id, name) {
    return `<span class="st-link" role="link" tabindex="0" data-st-player="${escapeHtml(
      id
    )}">${escapeHtml(name)}</span>`;
  }

  function teamLink(name) {
    return `<span class="st-link" role="link" tabindex="0" data-st-team="${escapeHtml(
      name
    )}">${escapeHtml(name)}</span>`;
  }

  function playerNameCell(r) {
    return playerLink(r.id, r.name);
  }

  function playerTeamCell(r) {
    const teams = r.teams || [];
    if (teams.length !== 1) {
      const text = r.teamLabel || '—';
      return r.teams?.length > 1 ? `<em>${escapeHtml(text)}</em>` : escapeHtml(text);
    }
    return teamLink(teams[0].name);
  }

  function teamNameCell(r) {
    return teamLink(r.name);
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
        showAverage: true,
        opponentCell: (r) =>
          r.opponent && r.opponent !== '—' ? teamLink(r.opponent) : escapeHtml(r.opponent || '—')
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
      showAverage: true,
      opponentCell: (r) =>
        r.opponent && r.opponent !== '—' ? teamLink(r.opponent) : escapeHtml(r.opponent || '—')
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
      emitViewChange();
      return;
    }

    const mode = roleMode();
    const playerCols = mode
      ? playerColumnsWithRoles(mode)
      : { columns: PLAYER_COLUMNS, fixedCount: PLAYER_FIXED_BASE.length };

    if (tab === 'players') {
      const filtered = enrichedPlayers(rows, players, active, demos);
      const minR = Math.max(0, Number(filter.minRounds) || 0);
      let data = pinTeamRoster(rows, players, active, demos, filtered, minR);
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
    emitViewChange();
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
      const title = name || `Team ${team}`;
      return `<div class="st-board">
        <h4 class="st-board-name team${team}">${teamLink(title)}</h4>
        ${statsTableHtml(list, {
          columns,
          fixedCount,
          escapeHtml,
          sortKey: opts.sortKey,
          sortDir: opts.sortDir,
          nameCell: playerNameCell,
          teamCell: playerTeamCell
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
   *   map?: string,
   *   tab?: 'players'|'teams',
   *   player?: string,
   *   team?: string,
   *   sortKey?: string,
   *   sort?: string,
   *   sortDir?: string,
   *   dir?: string,
   *   page?: number,
   *   side?: string,
   *   result?: string,
   *   advantage?: string,
   *   adv?: string,
   *   econ?: number|null,
   *   oppEcon?: number|null,
   *   hasAwp?: boolean,
   *   oppHasAwp?: boolean,
   *   minRounds?: number,
   *   role?: object|string|null
   * }} next
   */
  async function load(next = {}) {
    const token = ++loadToken;
    scope = {
      demos: Array.isArray(next.demos) ? [...next.demos] : undefined,
      files: Array.isArray(next.files) ? [...next.files] : undefined,
      title: next.title || ''
    };
    lockedTeamName = String(next.teamName || '').trim();
    scopeEl.textContent = next.title || '';
    bodyEl.innerHTML = spinnerHtml('Loading database…');
    filtersEl.innerHTML = '';
    const cancelSlow = watchSlowLoad(bodyEl, {
      message:
        'Still loading the database after 4s. Stats indexes may be rebuilding, or the API may be unreachable (Failed to fetch).'
    });
    // Reset then overlay anything the URL / caller asked for.
    filter.maps = [];
    filter.side = '';
    filter.econ = null;
    filter.oppEcon = null;
    filter.hasAwp = false;
    filter.oppHasAwp = false;
    filter.role = null;
    filter.minRounds = DEFAULT_MIN_ROUNDS;
    filter.result = '';
    filter.advantage = '';
    tab = 'players';
    sort = { players: { key: 'rating', dir: 'desc' }, teams: { key: 'avgRating', dir: 'desc' } };
    page = { players: 1, teams: 1 };
    detail = null;
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    applyViewState(next, { notify: false });
    try {
      const res = await fetchStats(scope.demos || null);
      cancelSlow();
      if (token !== loadToken) return;
      payload = res;
      const rounds = (res.demos || []).reduce((n, d) => n + (d.rounds?.length || 0), 0);
      if (!rounds) {
        filtersEl.innerHTML = '';
        bodyEl.innerHTML =
          '<p class="view-empty">No parsed rounds to measure yet. Upload a replay first.</p>';
        emitViewChange();
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
      bodyEl.querySelector('[data-st-retry]')?.addEventListener('click', () => load({ ...scope, ...next }));
    }
  }

  /**
   * Change tab / map filter without refetching. Used by Team Overview map picks.
   * @param {{tab?: 'players'|'teams', maps?: string[]|string|null}} opts
   */
  function applyView(opts = {}) {
    applyViewState(opts);
  }

  return {
    el,
    load,
    applyView,
    applyViewState,
    viewState,
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
