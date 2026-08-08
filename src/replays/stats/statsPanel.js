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
  demoPassesDate,
  indexMaps,
  rowPasses,
  teamNameKey
} from '../shared/statsMath.js';
import { hasRoundLibrary, roundTypeRows } from '../analytics/roundLibrary.js';
import { clockAt, secondsAtClock } from '../analytics/roundFacts.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';
import {
  PLAYER_COLUMNS,
  PLAYER_FIXED_BASE,
  TEAM_COLUMNS,
  TEAM_MAP_COLUMNS,
  STATS_PAGE_SIZE,
  attachTips,
  bindStatsHScroll,
  playerColumnsWithRoles,
  playerMatchColumns,
  teamMatchColumns,
  statsTableHtml
} from './statsTables.js';
import { spinnerHtml, watchSlowLoad } from '../../lib/spinner.js';
import { createSavedViews } from '../savedViews.js';
import { POSITION_MAPS } from '../roles/teamPositions.js';

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   onViewChange?: (state: object) => void,
 *   onDetailChange?: (detail: null | { kind: 'player'|'team', id?: string, name?: string, label: string }) => void,
 *   onBack?: () => boolean
 * }} deps
 */
/** Default minimum rounds when opening the unfiltered Database (can still be set to 0). */
export const DEFAULT_MIN_ROUNDS = 80;

/** Floor once a specific map is picked in the clean Database. */
export const MAP_MIN_ROUNDS = 5;

/** True when the panel is scoped to a match, selection, or team — not the full library. */
export function isStatsScopeFiltered(scope = {}) {
  return (
    (Array.isArray(scope.demos) && scope.demos.length > 0) ||
    (Array.isArray(scope.files) && scope.files.length > 0) ||
    Boolean(String(scope.teamName || '').trim())
  );
}

/** True when the view names at least one map. */
function scopeHasMap(scope = {}) {
  if (Array.isArray(scope.maps) && scope.maps.length > 0) return true;
  return Boolean(scope.map);
}

/**
 * Min-rounds default for a load / map change.
 * Unfiltered Database → 80, or 5 when a map is selected.
 * Match / team / selection scopes → 0.
 */
export function defaultMinRounds(scope = {}) {
  if (isStatsScopeFiltered(scope)) return 0;
  return scopeHasMap(scope) ? MAP_MIN_ROUNDS : DEFAULT_MIN_ROUNDS;
}

export function createStatsPanel({ escapeHtml, onViewChange, onDetailChange, onBack }) {
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
      <span class="st-saved" id="st-saved"></span>
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
    /** Inclusive upload/parse day bounds (YYYY-MM-DD), or ''. */
    dateFrom: '',
    dateTo: '',
    /** @type {{ side: 'T'|'CT', value: string } | null} */
    role: null,
    /** Round-library key the subject side must have run (requires map + side). */
    roundOwn: '',
    /** Round-library key the opposing side must have run (requires map + side). */
    roundOpp: '',
    /**
     * When in the round the call came, in seconds since it went live. Null at
     * both ends is the whole round, which is the default: a window is a claim
     * about a clock, and most questions are not.
     */
    fromSec: null,
    toSec: null
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
        ? positionRoleOptions(side, singleMap())
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

  /** Round-library select for the subject's side or the opposing side. */
  function roundSelectHtml(which) {
    const map = singleMap();
    const side = filter.side;
    if (!map || (side !== 'T' && side !== 'CT') || !hasRoundLibrary(map)) return '';
    const ownSide = side;
    const oppSide = side === 'T' ? 'CT' : 'T';
    const forSide = which === 'opp' ? oppSide : ownSide;
    const selected = which === 'opp' ? filter.roundOpp : filter.roundOwn;
    const rows = roundTypeRows(map, forSide);
    if (!rows.length) return '';
    const label =
      which === 'opp' ? `vs ${oppSide} round` : `${ownSide} round`;
    const opts = rows
      .map(
        (r) =>
          `<option value="${escapeHtml(r.key)}" title="${escapeHtml(r.desc || '')}"${
            r.key === selected ? ' selected' : ''
          }>${escapeHtml(r.label)}</option>`
      )
      .join('');
    return `<div class="st-filter-group st-filter-stack">
      <span class="st-filter-label">${escapeHtml(label)}</span>
      <select class="site-select st-round-select" data-filter="${
        which === 'opp' ? 'roundOpp' : 'roundOwn'
      }" aria-label="${escapeHtml(label)}">
        <option value=""${!selected ? ' selected' : ''}>Any</option>${opts}
      </select>
    </div>`;
  }

  /**
   * The round clock, as two clock inputs.
   *
   * Typed as a clock because that is how a coach reads a round, and stored as
   * seconds because that is how the tags do. Blank at either end means open at
   * that end, so blank at both is the whole round.
   */
  function roundWindowHtml() {
    const box = (which, secs, label) => `<input
      class="site-input st-clock"
      type="text"
      inputmode="numeric"
      placeholder="${which === 'fromSec' ? '1:55' : '0:00'}"
      data-filter="${which}"
      value="${escapeHtml(Number.isFinite(secs) ? clockAt(secs) : '')}"
      title="${escapeHtml(label)}"
      aria-label="${escapeHtml(label)}"
    />`;
    return `<div class="st-filter-group st-filter-stack">
      <span class="st-filter-label">In round</span>
      <div class="st-filter-row st-clock-row">
        ${box('fromSec', filter.fromSec, 'Calls from this point in the round')}
        ${box('toSec', filter.toSec, 'Calls up to this point in the round')}
      </div>
    </div>`;
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

    // Round-library picks need one map and a side so "our call" / "their call"
    // resolve against absolute T/CT tags on each row.
    const roundGroups = `${roundSelectHtml('own')}${roundSelectHtml('opp')}`;

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
        ${roundGroups}
        ${roundWindowHtml()}
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
          <span class="st-filter-label">From</span>
          <input
            class="site-input st-date"
            type="date"
            data-filter="dateFrom"
            value="${escapeHtml(filter.dateFrom || '')}"
            title="Games from this day (upload / parse date)"
            aria-label="From date"
          />
        </div>
        <div class="st-filter-group st-filter-stack">
          <span class="st-filter-label">To</span>
          <input
            class="site-input st-date"
            type="date"
            data-filter="dateTo"
            value="${escapeHtml(filter.dateTo || '')}"
            title="Games through this day (upload / parse date)"
            aria-label="To date"
          />
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

  function scopeForMinRounds(maps = filter.maps) {
    return {
      demos: scope.demos,
      files: scope.files,
      teamName: lockedTeamName,
      maps
    };
  }

  function resetListPage() {
    if (detail) detailPage = 1;
    else page[tab] = 1;
  }

  filtersEl.addEventListener('click', (e) => {
    const side = e.target.closest('[data-side]');
    if (side) {
      filter.side = filter.side === side.dataset.side ? '' : side.dataset.side;
      // Round-library picks are side-relative; drop them when side clears/changes.
      filter.roundOwn = '';
      filter.roundOpp = '';
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
      filter.roundOwn = '';
      filter.roundOpp = '';
      filter.fromSec = null;
      filter.toSec = null;
      filter.dateFrom = '';
      filter.dateTo = '';
      filter.minRounds = defaultMinRounds(scopeForMinRounds([]));
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
      const prevDefault = defaultMinRounds(scopeForMinRounds(filter.maps));
      const wasDefault = filter.minRounds === prevDefault;
      filter.maps = sel.value ? [sel.value] : [];
      filter.role = null;
      filter.roundOwn = '';
      filter.roundOpp = '';
      // Clean Database: Any map → 80, a specific map → 5. Keep a manual floor
      // only when the user already moved off the previous auto default.
      if (wasDefault) filter.minRounds = defaultMinRounds(scopeForMinRounds(filter.maps));
      resetListPage();
      render();
      return;
    }
    if (sel.dataset.filter === 'roundOwn' || sel.dataset.filter === 'roundOpp') {
      filter[sel.dataset.filter] = String(sel.value || '').trim();
      resetListPage();
      render();
      return;
    }
    if (sel.dataset.filter === 'fromSec' || sel.dataset.filter === 'toSec') {
      const key = sel.dataset.filter;
      const raw = String(sel.value || '').trim();
      // A bare number is seconds elapsed; anything with a colon is a clock.
      const secs = raw === '' ? null : raw.includes(':') ? secondsAtClock(raw) : Number(raw);
      filter[key] = Number.isFinite(secs) ? Math.max(0, Math.min(ROUND_SECONDS, secs)) : null;
      // The round counts down, so "from 1:55 to 1:20" is 0s to 35s elapsed.
      if (Number.isFinite(filter.fromSec) && Number.isFinite(filter.toSec)) {
        if (filter.fromSec > filter.toSec) {
          if (key === 'fromSec') filter.toSec = filter.fromSec;
          else filter.fromSec = filter.toSec;
        }
      }
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
    if (sel.dataset.filter === 'dateFrom' || sel.dataset.filter === 'dateTo') {
      const key = sel.dataset.filter;
      let next = String(sel.value || '').trim();
      if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) next = '';
      filter[key] = next;
      // Keep From ≤ To when both are set.
      if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
        if (key === 'dateFrom') filter.dateTo = filter.dateFrom;
        else filter.dateFrom = filter.dateTo;
      }
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
    // Prefer popping the detail history entry (opened via pushState). Pushing a
    // third "list" URL made browser Back return to the player/team view.
    if (typeof onBack === 'function' && onBack()) return;
    clearDetail();
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
      dateFrom: filter.dateFrom || '',
      dateTo: filter.dateTo || '',
      role: filter.role ? { side: filter.role.side, value: filter.role.value } : null,
      roundOwn: filter.roundOwn || '',
      roundOpp: filter.roundOpp || '',
      fromSec: Number.isFinite(filter.fromSec) ? filter.fromSec : null,
      toSec: Number.isFinite(filter.toSec) ? filter.toSec : null,
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
    savedViews.touch();
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
      if (filter.maps.length !== 1) {
        filter.roundOwn = '';
        filter.roundOpp = '';
      }
    } else if (next.map) {
      filter.maps = [String(next.map)];
    }

    if ('side' in next) {
      filter.side = next.side === 'T' || next.side === 'CT' ? next.side : '';
      if (!filter.side) {
        filter.roundOwn = '';
        filter.roundOpp = '';
      }
    }
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
    for (const key of ['fromSec', 'toSec']) {
      if (!(key in next)) continue;
      const raw = next[key];
      const secs = typeof raw === 'string' && raw.includes(':') ? secondsAtClock(raw) : Number(raw);
      filter[key] =
        raw === null || raw === '' || !Number.isFinite(secs)
          ? null
          : Math.max(0, Math.min(ROUND_SECONDS, secs));
    }
    if (Number.isFinite(filter.fromSec) && Number.isFinite(filter.toSec) && filter.fromSec > filter.toSec) {
      const swap = filter.fromSec;
      filter.fromSec = filter.toSec;
      filter.toSec = swap;
    }
    if ('dateFrom' in next || 'from' in next) {
      const raw = String(next.dateFrom ?? next.from ?? '').trim();
      filter.dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
    }
    if ('dateTo' in next || 'to' in next) {
      const raw = String(next.dateTo ?? next.to ?? '').trim();
      filter.dateTo = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
    }
    if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) {
      const swap = filter.dateFrom;
      filter.dateFrom = filter.dateTo;
      filter.dateTo = swap;
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
    if ('roundOwn' in next || 'round' in next) {
      filter.roundOwn = String(next.roundOwn ?? next.round ?? '').trim();
    }
    if ('roundOpp' in next || 'vsRound' in next) {
      filter.roundOpp = String(next.roundOpp ?? next.vsRound ?? '').trim();
    }
    if (!filter.side || filter.maps.length !== 1) {
      filter.roundOwn = '';
      filter.roundOpp = '';
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

  // ---- saved views --------------------------------------------------------
  //
  // The Database already had a view state, because filters and sort have to
  // survive Back and a shared URL. Saving one is that same object under a name,
  // so this is the shortest of the three wirings.

  const savedViews = createSavedViews({
    page: 'database',
    escapeHtml,
    read: () => viewState(),
    apply(spec) {
      applyViewState(spec || {});
    }
  });
  el.querySelector('#st-saved')?.appendChild(savedViews.el);

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
      mk5: 0,
      mk4: 0,
      mk3: 0,
      mk2: 0,
      mk1: 0,
      mk0: 0,
      akpr: null,
      akprKills: 0,
      akprRounds: 0,
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

  function filteredScore(demo, team, active, players, demos) {
    let mine = 0;
    let theirs = 0;
    for (const row of demo.rounds || []) {
      if (!rowPasses(row, active, team, players, demos)) continue;
      if (row.w === team) mine++;
      else if (row.w === 1 || row.w === 2) theirs++;
    }
    return { mine, theirs, label: `${mine}:${theirs}`, sort: mine - theirs };
  }

  function buildPlayerMatchRows(playerId, active, players, demos) {
    const out = [];
    for (const demo of payload.demos || []) {
      if (!demoPassesDate(demo, active)) continue;
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
      const score = filteredScore(demo, team, active, players, demos);
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
      if (!demoPassesDate(demo, active)) continue;
      const side =
        teamNameKey(demo.name1) === key ? 1 : teamNameKey(demo.name2) === key ? 2 : 0;
      if (!side) continue;
      const agg = aggregateTeams(demo.rounds || [], players, demos, {
        ...active,
        teamName
      }).find((t) => teamNameKey(t.name) === key);
      if (!agg || !(agg.rounds > 0)) continue;
      const score = filteredScore(demo, side, active, players, demos);
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
    if (r.mapRow) return escapeHtml(r.name);
    const link = teamLink(r.name);
    if (r.compareRole === 'us') return `<strong class="st-us-name">${link}</strong>`;
    return link;
  }

  /**
   * One row per map the locked team has played (Any map on Overview Teams).
   */
  function lockedTeamPerMapRows(rows, players, demos, active) {
    const want = teamNameKey(lockedTeamName);
    if (!want) return [];
    const played = new Set();
    for (const d of payload?.demos || []) {
      if (teamNameKey(d.name1) === want || teamNameKey(d.name2) === want) {
        if (d.map) played.add(String(d.map).toUpperCase());
      }
    }
    for (const row of rows) {
      const demo = demos.get(row.d);
      if (!demo) continue;
      if (teamNameKey(demo.name1) !== want && teamNameKey(demo.name2) !== want) continue;
      if (row.m) played.add(String(row.m).toUpperCase());
    }
    const order = POSITION_MAPS.map((m) => m.code);
    const codes = [...played].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    const out = [];
    for (const code of codes) {
      const list = aggregateTeams(rows, players, demos, {
        ...active,
        maps: [code],
        teamName: lockedTeamName
      });
      const row = list[0];
      if (!row || !(row.rounds > 0)) continue;
      out.push({
        ...row,
        name: MAPS[code]?.name || POSITION_MAPS.find((m) => m.code === code)?.name || code,
        mapCode: code,
        mapRow: true,
        key: `${row.key}|${code}`
      });
    }
    return out;
  }

  /**
   * On one map: worst / best / middle / us by Round WR, with DB average over all
   * teams that played that map.
   */
  function lockedTeamMapCompare(rows, players, demos, active, mapCode, minR) {
    const { teamName: _lock, ...base } = active;
    let all = aggregateTeams(rows, players, demos, {
      ...base,
      maps: [mapCode]
    });
    if (minR > 0) all = all.filter((t) => (t.rounds || 0) >= minR);
    else all = all.filter((t) => (t.rounds || 0) > 0);
    const byWr = [...all].sort(
      (a, b) =>
        (b.roundWinrate || 0) - (a.roundWinrate || 0) ||
        String(a.name).localeCompare(String(b.name))
    );
    if (!byWr.length) return { rows: [], averageRows: [] };

    const want = teamNameKey(lockedTeamName);
    const best = byWr[0];
    const worst = byWr[byWr.length - 1];
    const mid = byWr[Math.floor((byWr.length - 1) / 2)];
    const us =
      byWr.find((t) => teamNameKey(t.name) === want) ||
      aggregateTeams(rows, players, demos, {
        ...base,
        maps: [mapCode],
        teamName: lockedTeamName
      })[0] ||
      null;

    const display = [];
    const seen = new Set();
    const push = (row, role) => {
      if (!row) return;
      const k = row.key || teamNameKey(row.name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      display.push({ ...row, compareRole: role });
    };
    // Worst → best → middle → us (skip duplicates).
    push(worst, 'worst');
    push(best, 'best');
    push(mid, 'mid');
    push(us, 'us');

    return { rows: display, averageRows: byWr };
  }

  function renderDetail(active, players, demos) {
    if (detail.kind === 'player') {
      let data = buildPlayerMatchRows(detail.id, active, players, demos);
      if (detail.label === detail.id) {
        const named = data.find((r) => r.name);
        if (named?.name) detail.label = named.name;
      }
      const cols = playerMatchColumns();
      // The per-match table is one view of a player; the profile is the whole
      // of them. Linked from here because this is where someone already is
      // when they start asking about a person rather than a match.
      const profileLink = `<p class="st-profile-link">
        <a href="/player/${encodeURIComponent(detail.id)}?name=${encodeURIComponent(
          detail.label || detail.id
        )}">Open player profile</a>
      </p>`;
      bodyEl.innerHTML = profileLink + statsTableHtml(data, {
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
      const minR = Math.max(0, Number(filter.minRounds) || 0);
      const maps = Array.isArray(active.maps) ? active.maps.filter(Boolean) : [];
      const oneMap = maps.length === 1 ? String(maps[0]) : '';

      if (lockedTeamName && !oneMap) {
        // Any map: one row per map for the locked team.
        const data = lockedTeamPerMapRows(rows, players, demos, active);
        bodyEl.innerHTML = statsTableHtml(data, {
          columns: TEAM_MAP_COLUMNS,
          fixedCount: 2,
          escapeHtml,
          preserveOrder: true,
          showAverage: true,
          nameCell: teamNameCell
        });
      } else if (lockedTeamName && oneMap) {
        // One map: us vs best / mid / worst on that map; footer = all-team average.
        const { rows: data, averageRows } = lockedTeamMapCompare(
          rows,
          players,
          demos,
          active,
          oneMap,
          minR
        );
        bodyEl.innerHTML = statsTableHtml(data, {
          columns: TEAM_COLUMNS,
          fixedCount: 2,
          escapeHtml,
          preserveOrder: true,
          showAverage: true,
          averageRows,
          nameCell: teamNameCell
        });
      } else {
        let data = aggregateTeams(rows, players, demos, active);
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
    filter.dateFrom = '';
    filter.dateTo = '';
    // Full Database: 80 with Any map, 5 once a map is selected.
    // Match / team / selection scopes stay at 0.
    filter.minRounds = defaultMinRounds(next);
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
      void savedViews.refresh();
      void savedViews.applyShareParam(
        Object.fromEntries(new URLSearchParams(window.location.search))
      );
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

  /**
   * Expand a team-scoped payload to the full library once (for map compare).
   * No-op when already unscoped. Preserves filters / locked team name.
   */
  async function ensureLibraryPayload() {
    if (!scope.demos?.length && !scope.files?.length) return false;
    const snap = viewState();
    await load({
      title: scope.title || '',
      teamName: lockedTeamName || '',
      tab: snap.tab || tab,
      maps: snap.maps,
      side: snap.side,
      result: snap.result,
      advantage: snap.advantage,
      econ: snap.econ,
      oppEcon: snap.oppEcon,
      hasAwp: snap.hasAwp,
      oppHasAwp: snap.oppHasAwp,
      minRounds: snap.minRounds,
      dateFrom: snap.dateFrom,
      dateTo: snap.dateTo,
      role: snap.role
    });
    return true;
  }

  return {
    el,
    load,
    applyView,
    applyViewState,
    ensureLibraryPayload,
    /** The loaded payload, so panels beside this one can reuse the fetch. */
    getPayload: () => payload,
    /** False while the payload is still narrowed to a team or a selection. */
    isLibraryScope: () => !scope.demos?.length && !scope.files?.length,
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
