// ---------------------------------------------------------------------------
// replays/stats/statsPanel.js
// The Statistics screen: two tables over one cached index.
//
// The payload is fetched once per scope and every filter, tab and sort after
// that is a re-aggregation in memory. Nothing here re-reads a round.
// ---------------------------------------------------------------------------

import { formatApiError } from '../api.js';
import { getStatsPayload } from '../statsCache.js';
import { fetchAggregate, fetchAggregateMatches, fetchRoster, fetchVrsRanks } from '../api.js';
import { scheduleUiJob } from '../../lib/frameBudget.js';
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
import { listPlayers, listTeams } from '../analytics/analyticsMath.js';
import {
  demosForPlayer,
  demosForTeam,
  rosterPlayers,
  rosterTeamPlayers,
  rosterTeams
} from '../shared/rosterQuery.js';
import { attachExpectedRatings } from '../shared/expectedRating.js';
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
  omitPlayerTeamColumn,
  statsTableHtml
} from './statsTables.js';
import {
  etaLabel,
  setSpinnerLabel,
  spinnerHtml,
  statsProgressLabel,
  watchSlowLoad
} from '../../lib/spinner.js';
import { createSavedViews } from '../savedViews.js';
import { upgradePrompt } from '../../site/upgradeGate.js';
import { POSITION_MAPS } from '../roles/teamPositions.js';
import filtersIcon from '../../icons/icon_filters.svg?url';
import calendarIcon from '../../icons/icon_calendar.svg?url';
import { MENU_BTN, mbIcon, mbSummary, mbWrap } from '../../icons/menubuttons.js';
import { placeRankMenu, rankFilterHtml, syncRankSummary } from '../shared/vrsRanks.js';

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   onViewChange?: (state: object) => void,
 *   onDetailChange?: (detail: null | { kind: 'player'|'team', id?: string, name?: string, label: string }) => void,
 *   onPlayRounds?: (files: string[], title: string) => void | Promise<void>
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

export function createStatsPanel({
  escapeHtml,
  onViewChange,
  onDetailChange,
  onPlayRounds,
  /** Put Players / Teams / Filters in the site page-head next to DATABASE. */
  usePageHead = false,
  /** Overview: every row is already this team, so hide the Team column. */
  omitTeamColumn = false,
  /** Mirror filters into `/database?…`. Off when this panel is embedded elsewhere. */
  syncUrl = true
}) {
  const el = document.createElement('div');
  el.className = 'st-panel';
  el.innerHTML = `
    <div class="st-head">
      <div class="st-head-main">
        ${
          usePageHead
            ? ''
            : `<div class="st-tabs-row">
          <span class="st-library-load" data-st-library-load hidden role="status" aria-live="polite" aria-label="Loading more demos">
            <span class="spinner spinner-sm" aria-hidden="true"></span>
          </span>
          <button type="button" class="btn btn-sm" data-st-library-retry hidden>Retry</button>
          <button type="button" class="head-search-pill" data-st-search-toggle aria-expanded="false" aria-controls="st-search">
            <img src="${MENU_BTN.search}" alt="" width="14" height="14" draggable="false" />
            <span>Search…</span>
          </button>
          <button type="button" class="head-icon-btn" data-st-filters-toggle aria-expanded="false" aria-controls="st-filters" title="Filters" aria-label="Filters">
            <img src="${filtersIcon}" alt="" width="16" height="16" draggable="false" />
          </button>
          <div class="st-tabs">
          <button type="button" class="seg-tab active" data-tab="players">Players</button>
          <button type="button" class="seg-tab" data-tab="teams">Teams</button>
        </div>
        </div>`
        }
        <span class="st-detail-label" id="st-detail-label" hidden></span>
      </div>
      <span class="st-scope" id="st-scope"></span>
      <div class="st-head-actions">
        <span class="st-saved" id="st-saved"></span>
      </div>
    </div>
    <div class="st-filters" id="st-filters" hidden></div>
    <div class="st-search" id="st-search" hidden></div>
    <div class="st-body" id="st-body"><div class="is-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading</span></div></div>`;

  /** @type {HTMLElement | null} */
  let pageHeadEl = null;
  if (usePageHead) {
    pageHeadEl = document.createElement('div');
    pageHeadEl.className = 'st-page-actions';
    pageHeadEl.innerHTML = `
      <span class="st-library-load" data-st-library-load hidden role="status" aria-live="polite" aria-label="Loading more demos">
        <span class="spinner spinner-sm" aria-hidden="true"></span>
      </span>
      <button type="button" class="btn btn-sm" data-st-library-retry hidden>Retry</button>
      <button type="button" class="head-search-pill" data-st-search-toggle aria-expanded="false" aria-controls="st-search">
        <img src="${MENU_BTN.search}" alt="" width="14" height="14" draggable="false" />
        <span>Search…</span>
      </button>
      <button type="button" class="head-icon-btn" data-st-filters-toggle aria-expanded="false" aria-controls="st-filters" title="Filters" aria-label="Filters">
        <img src="${filtersIcon}" alt="" width="16" height="16" draggable="false" />
      </button>
      <div class="st-tabs">
        <button type="button" class="seg-tab active" data-tab="players">Players</button>
        <button type="button" class="seg-tab" data-tab="teams">Teams</button>
      </div>`;
  }

  const filtersEl = el.querySelector('#st-filters');
  const searchEl = el.querySelector('#st-search');
  const filtersToggleEl =
    pageHeadEl?.querySelector('[data-st-filters-toggle]') ||
    el.querySelector('[data-st-filters-toggle]');
  const searchToggleEl =
    pageHeadEl?.querySelector('[data-st-search-toggle]') ||
    el.querySelector('[data-st-search-toggle]');
  const bodyEl = el.querySelector('#st-body');
  const scopeEl = el.querySelector('#st-scope');
  const tabsEl = pageHeadEl?.querySelector('.st-tabs') || el.querySelector('.st-tabs');
  const detailLabelEl = el.querySelector('#st-detail-label');

  function mountPageHead() {
    if (!usePageHead || !pageHeadEl) return;
    document.getElementById('page-head-actions')?.replaceChildren(pageHeadEl);
    syncTabButtons();
    syncSearchToggle();
    paintLoadRing();
    filtersToggleEl?.classList.toggle('active', filtersOpen);
    filtersToggleEl?.setAttribute('aria-expanded', filtersOpen ? 'true' : 'false');
  }

  function syncTabButtons() {
    const root = pageHeadEl || el;
    root.querySelectorAll('[data-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
  }

  /**
   * How much of the library has arrived. The table paints after the first page
   * and keeps growing, so "is it still going, and how far along" is a real
   * question the turning ring alone cannot answer.
   *
   * @type {{ loaded: number, total: number }}
   */
  let libraryProgress = { loaded: 0, total: 0 };
  /** Library pages still arriving. */
  let libraryStreaming = false;

  const countFmt = new Intl.NumberFormat();

  /**
   * Recomputes in flight.
   *
   * A filter change re-queries the library or re-aggregates every round in the
   * browser, and until it lands the table sits there showing the old numbers —
   * which reads as "the click did nothing". Counted rather than a flag, because
   * a library load and a render can overlap and the first to finish must not
   * clear the other's mark.
   */
  let busyCount = 0;

  /**
   * What the one ring is currently saying.
   *
   * There used to be two: a library-progress ring by the tabs and a second
   * "recalculating" ring by the Filters button. Two spinners for one wait is a
   * puzzle, not a status — the reader has to work out which is which and why
   * one of them is not moving. Both reasons now live on this ring, and the tip
   * says which applies.
   */
  function loadRingText() {
    const { loaded, total } = libraryProgress;
    if (libraryStreaming && total) {
      const shown = Math.min(loaded, total);
      return (
        `${countFmt.format(shown)} of ${countFmt.format(total)} matches loaded\n` +
        (busyCount > 0
          ? 'Updating the tables with what has arrived.'
          : 'Tables update as the rest arrive.')
      );
    }
    if (libraryStreaming) return 'Loading matches…';
    if (busyCount > 0) return 'Updating the tables for these filters.';
    if (serverRefreshing) {
      const total = Number(serverRefreshing.total) || 0;
      const done = Math.min(Number(serverRefreshing.done) || 0, total);
      // A rebuild replaces the whole statistics store; the tables shown are
      // the previous numbers until it lands. An append is a demo or two.
      if (serverRefreshing.mode === 'rebuild') {
        return (
          `Statistics are being refreshed (${countFmt.format(done)}/${countFmt.format(total)})\n` +
          'The tables show the previous numbers meanwhile.'
        );
      }
      return total === 1
        ? '1 new demo is being processed\nThe tables update as soon as it lands.'
        : `${countFmt.format(total)} new demos are being processed\nThe tables update as soon as they land.`;
    }
    return 'Updating the tables for these filters.';
  }

  /** One line, no UI hints, for assistive tech. */
  function loadRingLabel() {
    const { loaded, total } = libraryProgress;
    if (libraryStreaming && total) {
      return `Loading matches, ${Math.min(loaded, total)} of ${total} loaded`;
    }
    if (libraryStreaming) return 'Loading more matches';
    if (busyCount === 0 && serverRefreshing) {
      const total = Number(serverRefreshing.total) || 0;
      return serverRefreshing.mode === 'rebuild'
        ? 'Refreshing statistics'
        : `Processing ${total} new demo${total === 1 ? '' : 's'}`;
    }
    return 'Updating the tables';
  }

  /** Visibility and text of every copy of the ring. */
  function paintLoadRing() {
    const on = libraryStreaming || busyCount > 0 || Boolean(serverRefreshing);
    const text = loadRingText();
    const label = loadRingLabel();
    const roots = [el, pageHeadEl].filter(Boolean);
    for (const root of roots) {
      root.querySelectorAll('[data-st-library-load]').forEach((mark) => {
        mark.hidden = !on;
        mark.dataset.tip = text;
        mark.setAttribute('aria-label', label);
      });
    }
  }

  /**
   * Record progress from either signal: `onProgress` ticks demo by demo inside
   * the page being fetched, `onBatch` lands when a whole page has merged.
   * Taking the max keeps the count monotonic when both fire.
   */
  function noteLibraryProgress({ loaded, total }) {
    // The library only ever grows during one load, so a smaller total is a
    // miscounted event rather than news. Re-scoping goes through
    // resetLibraryProgress, which is the only way the total comes down.
    const stated = Number(total) || 0;
    const nextTotal = Math.max(libraryProgress.total, stated);
    const nextLoaded = Math.max(0, Number(loaded) || 0);
    libraryProgress = {
      loaded: Math.min(Math.max(libraryProgress.loaded, nextLoaded), nextTotal || nextLoaded),
      total: nextTotal
    };
    paintLoadRing();
  }

  function resetLibraryProgress() {
    libraryProgress = { loaded: 0, total: 0 };
    paintLoadRing();
  }

  function setLibraryLoading(on) {
    libraryStreaming = Boolean(on);
    if (libraryStreaming) setLibraryRetry(false);
    paintLoadRing();
  }

  function setLibraryRetry(on) {
    const root = pageHeadEl || el;
    root.querySelectorAll('[data-st-library-retry]').forEach((btn) => {
      btn.hidden = !on;
    });
  }

  /**
   * Hold the ring up for as long as `job` runs. Returns `job` itself, so
   * callers keep the promise (and its rejection) they already had.
   */
  function trackBusy(job) {
    busyCount += 1;
    paintLoadRing();
    const done = () => {
      busyCount = Math.max(0, busyCount - 1);
      paintLoadRing();
    };
    if (job && typeof job.then === 'function') job.then(done, done);
    else done();
    return job;
  }

  function bindLibraryRetry() {
    const roots = [el, pageHeadEl].filter(Boolean);
    for (const root of roots) {
      root.querySelectorAll('[data-st-library-retry]').forEach((btn) => {
        btn.addEventListener('click', () => {
          void resumeLibrary();
        });
      });
    }
  }
  bindLibraryRetry();

  /** Filters bar is closed by default so the table owns the viewport. */
  let filtersOpen = false;
  /** Search bar is closed by default; selections still filter when closed. */
  let searchOpen = false;
  let searchQuery = '';
  let searchMenuOpen = false;
  /** @type {{ players: { id: string, name: string }[], teams: { key: string, name: string }[] }} */
  let entityPick = { players: [], teams: [] };
  /** Date-range popover under the calendar icon. */
  let calendarOpen = false;

  let payload = null;
  /**
   * The roster catalogue: who played in which demo, without any stats index.
   *
   * The Search box used to read its suggestions off `payload`, which meant
   * picking a name required the whole library in the browser first — a ~0.9 GB
   * download to answer "show me this player". The catalogue answers the same
   * question in one small request, and the picked demos then scope the server
   * aggregate, so Search never touches a round.
   */
  let roster = null;
  let rosterLoading = null;
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
    /** Round-library keys the subject side must have run (any; requires map + side). */
    roundOwn: [],
    /** Round-library keys the opposing side must have run (any; requires map + side). */
    roundOpp: [],
    /**
     * When in the round the call came, in seconds since it went live. Null at
     * both ends is the whole round, which is the default: a window is a claim
     * about a clock, and most questions are not.
     */
    fromSec: null,
    toSec: null,
    rankOwn: '',
    rankOpp: ''
  };

  const detachTips = attachTips(el);
  // The library spinner sits in the page head, which is a separate subtree from
  // the panel — without this its tooltip would never fire.
  const detachHeadTips = pageHeadEl ? attachTips(pageHeadEl) : () => {};

  function singleMap() {
    return filter.maps.length === 1 ? filter.maps[0] : '';
  }

  function roleMode() {
    // Server mode has no payload to inspect; the rows themselves say whether
    // the library has roles, because the endpoint only attaches them when it
    // found a role table to read.
    const has = payload
      ? payloadHasRoles(payload)
      : (serverTables?.players || []).some((p) => p.roleT || p.roleCT || p.posT || p.posCT);
    if (!has) return '';
    return singleMap() ? 'position' : 'tactical';
  }

  // ---- filters ------------------------------------------------------------

  function mapsInPayload() {
    // In server mode there is no payload to scan; the endpoint reports the
    // library's maps so the filter bar is fully usable without one.
    if (!payload && serverTables?.maps) return [...serverTables.maps];
    const set = new Set();
    for (const d of payload?.demos || []) {
      for (const r of d.rounds || []) if (r.m) set.add(r.m);
    }
    return [...set].sort();
  }

  function econSelect(id, value, placeholder = 'Any buy') {
    const opts = Object.entries(ECONOMIES)
      .map(
        ([code, e]) =>
          `<option value="${code}"${Number(code) === value ? ' selected' : ''}>${escapeHtml(
            e.label || economyLabel(Number(code))
          )}</option>`
      )
      .join('');
    return `<select class="site-select st-econ-select" data-filter="${id}" aria-label="${escapeHtml(
      placeholder
    )}">
      <option value=""${value === null ? ' selected' : ''}>${escapeHtml(placeholder)}</option>${opts}</select>`;
  }

  function hasAwpCheck(id, checked) {
    return `<label class="rp-awp-toggle st-awp-toggle${checked ? ' active' : ''}" title="Has AWP">
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
    return mbWrap(
      'map',
      `<select class="site-select st-map-select" data-filter="maps" aria-label="Map">
      <option value=""${!selected ? ' selected' : ''}>Any map</option>${opts}</select>`
    );
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
    const anyLabel = side === 'CT' ? 'CT Role' : 'T Role';
    const options = opts
      .map((o) => {
        const label = o.label;
        const how = o.how || roleHowText(side, label, mode);
        return `<option value="${escapeHtml(label)}" title="${escapeHtml(how)}"${
          label === selected ? ' selected' : ''
        }>${escapeHtml(label)}</option>`;
      })
      .join('');
    return `<select class="site-select st-role-select" data-role-filter="${side}" aria-label="${escapeHtml(
      anyLabel
    )}">
      <option value=""${!selected ? ' selected' : ''}>${escapeHtml(anyLabel)}</option>${options}</select>`;
  }

  function roundKeysOf(which) {
    const raw = which === 'opp' ? filter.roundOpp : filter.roundOwn;
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  }

  function roundSummaryLabel(rows, selected, emptyLabel) {
    if (!selected.length) return emptyLabel;
    if (selected.length === 1) {
      return rows.find((r) => r.key === selected[0])?.label || selected[0];
    }
    return `${selected.length} selected`;
  }

  /** Round-library multi-select for the subject's side or the opposing side. */
  function roundSelectHtml(which) {
    const map = singleMap();
    const side = filter.side;
    if (!map || (side !== 'T' && side !== 'CT') || !hasRoundLibrary(map)) return '';
    const ownSide = side;
    const oppSide = side === 'T' ? 'CT' : 'T';
    const forSide = which === 'opp' ? oppSide : ownSide;
    const selected = roundKeysOf(which);
    const selectedSet = new Set(selected);
    const rows = roundTypeRows(map, forSide);
    if (!rows.length) return '';
    const emptyLabel = which === 'opp' ? 'Facing' : 'Running';
    const ariaLabel = which === 'opp' ? `vs ${oppSide} round` : `${ownSide} round`;
    const field = which === 'opp' ? 'roundOpp' : 'roundOwn';
    const summary = roundSummaryLabel(rows, selected, emptyLabel);
    const checks = [
      `<label class="st-round-opt">
        <input type="checkbox" data-round-filter="${field}" value="" ${
          selected.length ? '' : 'checked'
        } />
        <span>${escapeHtml(emptyLabel)}</span>
      </label>`,
      ...rows.map(
        (r) => `<label class="st-round-opt" title="${escapeHtml(r.desc || '')}">
          <input type="checkbox" data-round-filter="${field}" value="${escapeHtml(r.key)}" ${
            selectedSet.has(r.key) ? 'checked' : ''
          } />
          <span>${escapeHtml(r.label)}</span>
        </label>`
      )
    ].join('');
    return `<div class="st-filter-group">
      <details class="st-round-multi" data-round-menu="${field}">
        <summary class="site-select st-round-select" aria-label="${escapeHtml(ariaLabel)}">${mbSummary(
          'menu',
          escapeHtml(summary)
        )}</summary>
        <div class="st-round-menu" role="group" aria-label="${escapeHtml(ariaLabel)}">${checks}</div>
      </details>
    </div>`;
  }

  function placeRoundMenu(details) {
    const menu = details?.querySelector?.('.st-round-menu');
    const summary = details?.querySelector?.('summary');
    if (!menu || !summary) return;
    const r = summary.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.minWidth = `${Math.round(Math.max(r.width, 180))}px`;
  }

  function closeRoundMenus(except = null) {
    for (const d of filtersEl.querySelectorAll('details.st-round-multi[open], details.st-rank-dd[open]')) {
      if (except && d === except) continue;
      d.removeAttribute('open');
    }
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
    return `<div class="st-filter-group">
      <div class="st-filter-row st-clock-row">
        ${box('fromSec', filter.fromSec, 'Calls from this point in the round')}
        ${box('toSec', filter.toSec, 'Calls up to this point in the round')}
      </div>
    </div>`;
  }

  function setFiltersOpen(open) {
    filtersOpen = Boolean(open);
    filtersEl.hidden = !filtersOpen;
    filtersToggleEl?.classList.toggle('active', filtersOpen);
    filtersToggleEl?.setAttribute('aria-expanded', filtersOpen ? 'true' : 'false');
    if (!filtersOpen) calendarOpen = false;
  }

  function hasEntityPick() {
    return entityPick.players.length > 0 || entityPick.teams.length > 0;
  }

  function syncSearchToggle() {
    const on = searchOpen || hasEntityPick();
    searchToggleEl?.classList.toggle('active', on);
    searchToggleEl?.setAttribute('aria-expanded', searchOpen ? 'true' : 'false');
  }

  function setSearchOpen(open) {
    searchOpen = Boolean(open);
    searchEl.hidden = !searchOpen;
    if (searchOpen) {
      renderSearch();
      // Suggestions come from the catalogue; fetch it on the way in rather
      // than on the first keystroke so the menu is populated when it opens.
      void ensureRoster().then(() => {
        if (searchOpen) refreshSearchMenu();
      });
      searchEl.querySelector('#st-entity-search')?.focus?.();
    } else {
      searchMenuOpen = false;
      searchQuery = '';
    }
    syncSearchToggle();
  }

  /** Load the catalogue once. A failure leaves suggestions on the payload path. */
  function ensureRoster() {
    if (roster) return Promise.resolve(roster);
    if (!rosterLoading) {
      rosterLoading = fetchRoster()
        .then((res) => {
          roster = res;
          return res;
        })
        .catch(() => null)
        .finally(() => {
          rosterLoading = null;
        });
    }
    return rosterLoading;
  }

  function entitySuggestions(q) {
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const selectedPlayers = new Set(entityPick.players.map((p) => String(p.id)));
    const selectedTeams = new Set(entityPick.teams.map((t) => String(t.key)));
    /** @type {{ kind: 'team'|'player', key: string, label: string, sub?: string }[]} */
    const out = [];
    // Catalogue first; the payload is only a fallback for a roster that failed
    // to load, and both expose the same { key/id, name } shape.
    const teams = roster
      ? rosterTeams(roster, '', Infinity).map((t) => ({
          key: t.key,
          name: t.name,
          playerIds: null
        }))
      : payload
        ? listTeams(payload)
        : [];
    const players = roster
      ? rosterPlayers(roster, '', Infinity)
      : payload
        ? listPlayers(payload)
        : [];

    const teamHits = teams
      .filter((t) => !selectedTeams.has(String(t.key)))
      .filter(
        (t) =>
          !needle ||
          t.name.toLowerCase().includes(needle) ||
          String(t.key).toLowerCase().includes(needle)
      )
      .slice(0, needle ? 8 : 12);
    for (const t of teamHits) {
      const n = t.playerIds?.length ?? (roster ? rosterTeamPlayers(roster, t.key).length : 0);
      out.push({
        kind: 'team',
        key: t.key,
        label: t.name,
        sub: n ? `${n} player${n === 1 ? '' : 's'}` : ''
      });
    }

    if (needle.length >= 1) {
      const playerHits = players
        .filter((p) => !selectedPlayers.has(String(p.id)))
        .filter(
          (p) =>
            p.name.toLowerCase().includes(needle) || String(p.id).toLowerCase().includes(needle)
        )
        .slice(0, 20);
      for (const p of playerHits) {
        out.push({ kind: 'player', key: p.id, label: p.name });
      }
    }
    return out;
  }

  function searchSuggestMenuHtml(opts) {
    if (!opts.length) {
      return `<p class="rp-typeahead-empty">No matches</p>`;
    }
    const teamsHtml = opts
      .filter((o) => o.kind === 'team')
      .map(
        (o) => `<button type="button" class="an-suggest" data-st-entity-pick="team|${escapeHtml(
          o.key
        )}">
          <span class="an-suggest-kind">Team</span>
          <span class="an-suggest-main">
            <strong>${escapeHtml(o.label)}</strong>
            ${o.sub ? `<span class="an-muted">${escapeHtml(o.sub)}</span>` : ''}
          </span>
        </button>`
      )
      .join('');
    const playersHtml = opts
      .filter((o) => o.kind === 'player')
      .map(
        (o) => `<button type="button" class="an-suggest" data-st-entity-pick="player|${escapeHtml(
          o.key
        )}">
          <span class="an-suggest-kind">Player</span>
          <span class="an-suggest-main"><strong>${escapeHtml(o.label)}</strong></span>
        </button>`
      )
      .join('');
    return `
      ${teamsHtml ? `<div class="an-suggest-group"><span class="an-suggest-group-label">Teams</span>${teamsHtml}</div>` : ''}
      ${playersHtml ? `<div class="an-suggest-group"><span class="an-suggest-group-label">Players</span>${playersHtml}</div>` : ''}`;
  }

  function refreshSearchMenu() {
    const menu = searchEl.querySelector('#st-entity-menu');
    if (!menu) return;
    const q = searchQuery;
    const opts = entitySuggestions(q);
    const show = searchMenuOpen && (opts.length || q.trim().length >= 1);
    menu.hidden = !show;
    if (!show) return;
    menu.innerHTML = opts.length
      ? searchSuggestMenuHtml(opts)
      : `<p class="rp-typeahead-empty">${q.trim() ? 'No matches' : 'Type a name, or pick a team'}</p>`;
  }

  function renderSearch() {
    const chips = [
      ...entityPick.teams.map(
        (t) => `<button type="button" class="an-sel-chip" data-st-entity-remove="team|${escapeHtml(
          t.key
        )}" title="Remove">${escapeHtml(t.name)} <span aria-hidden="true">×</span></button>`
      ),
      ...entityPick.players.map(
        (p) => `<button type="button" class="an-sel-chip" data-st-entity-remove="player|${escapeHtml(
          p.id
        )}" title="Remove">${escapeHtml(p.name)} <span aria-hidden="true">×</span></button>`
      )
    ].join('');

    searchEl.innerHTML = `
      <div class="st-search-typeahead rp-typeahead" id="st-search-typeahead">
        ${chips ? `<div class="an-sel-chips">${chips}</div>` : ''}
        ${mbWrap(
          'search',
          `<input type="search" class="site-input" id="st-entity-search"
          placeholder="Search teams or players…" spellcheck="false" autocomplete="off"
          value="${escapeHtml(searchQuery)}" aria-label="Search teams or players" />`
        )}
        <div class="rp-typeahead-menu an-subject-menu" id="st-entity-menu" hidden></div>
      </div>
      <button type="button" class="btn btn-sm st-filter-clear" data-st-search-clear${
        hasEntityPick() ? '' : ' disabled'
      }>Clear</button>`;
    searchEl.hidden = !searchOpen;
    syncSearchToggle();
    refreshSearchMenu();
  }

  function pickEntity(kind, key) {
    const id = String(key || '').trim();
    // Either source can name the entity. This used to require `payload`, from
    // when a pick could not be resolved without the whole library in memory —
    // with suggestions now coming from the catalogue, that guard silently
    // swallowed every click.
    if (!id || (!payload && !roster)) return;
    if (kind === 'team') {
      if (entityPick.teams.some((t) => t.key === id)) return;
      const hit = roster
        ? rosterTeams(roster, '', Infinity).find((t) => String(t.key) === id)
        : payload
          ? listTeams(payload).find((t) => t.key === id)
          : null;
      entityPick.teams.push({ key: id, name: hit?.name || id });
      if (tab !== 'teams' && !entityPick.players.length) {
        tab = 'teams';
        syncTabButtons();
      }
    } else if (kind === 'player') {
      if (entityPick.players.some((p) => p.id === id)) return;
      const hit = roster
        ? rosterPlayers(roster, '', Infinity).find((p) => String(p.id) === id)
        : payload
          ? listPlayers(payload).find((p) => p.id === id)
          : null;
      entityPick.players.push({ id, name: hit?.name || id });
      if (tab !== 'players' && !entityPick.teams.length) {
        tab = 'players';
        syncTabButtons();
      }
    } else {
      return;
    }
    searchQuery = '';
    searchMenuOpen = false;
    resetListPage();
    renderSearch();
    scheduleRender({ rebuildFilters: false });
  }

  function removeEntity(kind, key) {
    const id = String(key || '').trim();
    if (!id) return;
    if (kind === 'team') {
      entityPick.teams = entityPick.teams.filter((t) => t.key !== id);
    } else if (kind === 'player') {
      entityPick.players = entityPick.players.filter((p) => p.id !== id);
    } else {
      return;
    }
    resetListPage();
    renderSearch();
    scheduleRender({ rebuildFilters: false });
  }

  function clearEntityPick() {
    if (!hasEntityPick() && !searchQuery) return;
    entityPick = { players: [], teams: [] };
    searchQuery = '';
    searchMenuOpen = false;
    resetListPage();
    renderSearch();
    scheduleRender({ rebuildFilters: false });
  }

  /** Player ids allowed by the current search picks, or null when unrestricted. */
  function allowedPlayerIds() {
    if (!hasEntityPick()) return null;
    const ids = new Set(entityPick.players.map((p) => String(p.id)));
    if (entityPick.teams.length) {
      for (const pick of entityPick.teams) {
        if (roster) {
          for (const p of rosterTeamPlayers(roster, pick.key)) ids.add(String(p.id));
          continue;
        }
        if (!payload) continue;
        const hit = listTeams(payload).find((t) => String(t.key) === String(pick.key));
        for (const id of hit?.playerIds || []) ids.add(String(id));
      }
    }
    return ids;
  }

  /** Team keys allowed by the current search picks, or null when unrestricted. */
  function allowedTeamKeys() {
    if (!hasEntityPick()) return null;
    const keys = new Set(entityPick.teams.map((t) => String(t.key)));
    if (entityPick.players.length) {
      const playerIds = new Set(entityPick.players.map((p) => String(p.id)));
      const teams = roster
        ? rosterTeams(roster, '', Infinity).map((t) => ({
            key: t.key,
            playerIds: rosterTeamPlayers(roster, t.key).map((p) => p.id)
          }))
        : payload
          ? listTeams(payload)
          : [];
      for (const t of teams) {
        if ((t.playerIds || []).some((id) => playerIds.has(String(id)))) {
          keys.add(String(t.key));
        }
      }
    }
    return keys;
  }

  /**
   * Demo ids the current search picks cover, or null when unrestricted.
   *
   * This is what turns a pick from a library download into a scoped query: a
   * player only has rounds in their own matches, so aggregating over just those
   * demos gives the identical row the whole-library pass would have given.
   */
  function entityDemoIds() {
    if (!hasEntityPick() || !roster) return null;
    const ids = new Set();
    for (const p of entityPick.players) for (const id of demosForPlayer(roster, p.id)) ids.add(id);
    for (const t of entityPick.teams) for (const id of demosForTeam(roster, t.key)) ids.add(id);
    return ids.size ? [...ids] : null;
  }

  /**
   * Demos the server aggregate should be restricted to: an explicit caller
   * scope wins, then the search picks, then the whole library.
   */
  function serverDemoScope() {
    if (scope.demos?.length) return scope.demos;
    return entityDemoIds() || undefined;
  }

  function applyEntityPickPlayers(data) {
    const ids = allowedPlayerIds();
    if (!ids) return data;
    return data.filter((p) => ids.has(String(p.id)));
  }

  function applyEntityPickTeams(data) {
    const keys = allowedTeamKeys();
    if (!keys) return data;
    return data.filter((t) => {
      const k = String(t.key || '');
      if (keys.has(k)) return true;
      // Locked-team per-map rows use `${teamKey}|${mapCode}`.
      const pipe = k.indexOf('|');
      if (pipe > 0 && keys.has(k.slice(0, pipe))) return true;
      return keys.has(teamNameKey(t.name));
    });
  }

  function dateRangeHtml() {
    const active = Boolean(filter.dateFrom || filter.dateTo);
    return `<div class="st-filter-group st-date-wrap${calendarOpen ? ' open' : ''}${
      active ? ' has-range' : ''
    }">
      <button type="button" class="st-date-toggle${active ? ' active' : ''}" data-st-calendar
        aria-expanded="${calendarOpen ? 'true' : 'false'}" aria-label="Date range"
        title="Date range">
        <img src="${calendarIcon}" alt="" width="18" height="18" draggable="false" />
      </button>
      <div class="st-date-popover" ${calendarOpen ? '' : 'hidden'}>
        <label class="st-date-field">
          <span>From</span>
          <input
            class="site-input st-date"
            type="date"
            data-filter="dateFrom"
            value="${escapeHtml(filter.dateFrom || '')}"
            title="Games from this day (upload / parse date)"
            aria-label="From date"
          />
        </label>
        <label class="st-date-field">
          <span>To</span>
          <input
            class="site-input st-date"
            type="date"
            data-filter="dateTo"
            value="${escapeHtml(filter.dateTo || '')}"
            title="Games through this day (upload / parse date)"
            aria-label="To date"
          />
        </label>
      </div>
    </div>`;
  }

  function renderFilters() {
    const mode = roleMode();
    const sideSeg = `<div class="rp-seg rp-seg-side st-side-seg" role="group" aria-label="Side">
      <button type="button" class="rp-seg-btn${
        filter.side === 'T' ? ' active' : ''
      }" data-side="T" aria-label="T" title="T">
        <img src="/icons/icon_t.png" alt="" width="16" height="16" draggable="false" />
      </button>
      <button type="button" class="rp-seg-btn${
        filter.side === 'CT' ? ' active' : ''
      }" data-side="CT" aria-label="CT" title="CT">
        <img src="/icons/icon_ct.png" alt="" width="16" height="16" draggable="false" />
      </button>
    </div>`;
    const resultSeg = `<div class="rp-seg st-result-seg" role="group" aria-label="Result">
      <button type="button" class="rp-seg-btn${
        filter.result === 'won' ? ' active' : ''
      }" data-result="won" aria-label="Won" title="Won">W</button>
      <button type="button" class="rp-seg-btn${
        filter.result === 'lost' ? ' active' : ''
      }" data-result="lost" aria-label="Lost" title="Lost">L</button>
    </div>`;
    const openingSeg = `<div class="rp-seg st-opening-seg" role="group" aria-label="Opening">
      <button type="button" class="rp-seg-btn${
        filter.advantage === '5v4' ? ' active' : ''
      }" data-advantage="5v4" title="5v4">5v4</button>
      <button type="button" class="rp-seg-btn${
        filter.advantage === '4v5' ? ' active' : ''
      }" data-advantage="4v5" title="4v5">4v5</button>
    </div>`;

    const roleGroups =
      mode && tab === 'players'
        ? `
      <div class="st-filter-group">${roleSelectHtml('T')}</div>
      <div class="st-filter-group">${roleSelectHtml('CT')}</div>`
        : '';

    // Round-library picks need one map and a side so "our call" / "their call"
    // resolve against absolute T/CT tags on each row.
    const roundGroups = `${roundSelectHtml('own')}${roundSelectHtml('opp')}`;
    const ownBuyLabel = tab === 'teams' ? 'Team buy' : 'Own buy';

    filtersEl.innerHTML = `
      <div class="st-filters-scroll">
        <div class="st-filter-group">${mapSelectHtml()}</div>
        <div class="st-filter-group">${rankFilterHtml({
          own: filter.rankOwn,
          opp: filter.rankOpp
        })}</div>
        <div class="st-filter-group">${sideSeg}</div>
        ${roundGroups}
        ${roundWindowHtml()}
        <div class="st-filter-group">${resultSeg}</div>
        <div class="st-filter-group">${openingSeg}</div>
        ${roleGroups}
        <div class="st-filter-group">
          <div class="st-filter-row">${econSelect('econ', filter.econ, ownBuyLabel)}${hasAwpCheck(
            'hasAwp',
            filter.hasAwp
          )}</div>
        </div>
        <div class="st-filter-group">
          <div class="st-filter-row">${econSelect(
            'oppEcon',
            filter.oppEcon,
            'Enemy buy'
          )}${hasAwpCheck('oppHasAwp', filter.oppHasAwp)}</div>
        </div>
      </div>
      <div class="st-filters-end">
        ${dateRangeHtml()}
        <div class="st-filter-group">
          <input
            class="site-input st-min-rounds"
            type="number"
            min="0"
            step="1"
            data-filter="minRounds"
            value="${filter.minRounds || 0}"
            title="Minimum rounds played"
            aria-label="Minimum rounds played"
            placeholder="Min"
          />
        </div>
        <button type="button" class="btn btn-sm st-filter-clear" data-clear>Clear</button>
      </div>`;
    setFiltersOpen(filtersOpen);
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

  filtersToggleEl?.addEventListener('click', () => {
    setFiltersOpen(!filtersOpen);
  });

  searchToggleEl?.addEventListener('click', () => {
    setSearchOpen(!searchOpen);
  });

  searchEl.addEventListener('input', (e) => {
    if (e.target?.id !== 'st-entity-search') return;
    searchQuery = e.target.value || '';
    searchMenuOpen = true;
    refreshSearchMenu();
  });

  searchEl.addEventListener('focusin', (e) => {
    if (e.target?.id !== 'st-entity-search') return;
    searchMenuOpen = true;
    refreshSearchMenu();
  });

  searchEl.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-st-search-clear]');
    if (clear) {
      e.preventDefault();
      clearEntityPick();
      return;
    }
    const remove = e.target.closest('[data-st-entity-remove]');
    if (remove) {
      e.preventDefault();
      const [kind, ...rest] = String(remove.dataset.stEntityRemove || '').split('|');
      removeEntity(kind, rest.join('|'));
      return;
    }
    const pick = e.target.closest('[data-st-entity-pick]');
    if (pick) {
      e.preventDefault();
      const [kind, ...rest] = String(pick.dataset.stEntityPick || '').split('|');
      pickEntity(kind, rest.join('|'));
    }
  });

  searchEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (searchMenuOpen) {
      searchMenuOpen = false;
      refreshSearchMenu();
      return;
    }
    setSearchOpen(false);
  });

  // `toggle` does not bubble; capture so we can pin the fixed menu under the control.
  filtersEl.addEventListener(
    'toggle',
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      if (!details.classList.contains('st-round-multi') && !details.classList.contains('st-rank-dd')) {
        return;
      }
      if (details.open) {
        closeRoundMenus(details);
        if (details.classList.contains('st-rank-dd')) {
          placeRankMenu(details);
          requestAnimationFrame(() => placeRankMenu(details));
        } else {
          placeRoundMenu(details);
          requestAnimationFrame(() => placeRoundMenu(details));
        }
      }
    },
    true
  );

  function setCalendarOpen(open) {
    calendarOpen = Boolean(open);
    const wrap = filtersEl.querySelector('.st-date-wrap');
    if (!wrap) return;
    wrap.classList.toggle('open', calendarOpen);
    wrap.classList.toggle('has-range', Boolean(filter.dateFrom || filter.dateTo));
    const btn = wrap.querySelector('[data-st-calendar]');
    btn?.setAttribute('aria-expanded', calendarOpen ? 'true' : 'false');
    btn?.classList.toggle('active', calendarOpen || Boolean(filter.dateFrom || filter.dateTo));
    const pop = wrap.querySelector('.st-date-popover');
    if (pop) pop.hidden = !calendarOpen;
  }

  filtersEl.addEventListener('pointerdown', (e) => {
    const cal = e.target.closest('[data-st-calendar]');
    if (!cal) return;
    e.preventDefault();
    e.stopPropagation();
    closeRoundMenus();
    setCalendarOpen(!calendarOpen);
  });

  filtersEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-st-calendar]')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const side = e.target.closest('[data-side]');
    if (side) {
      filter.side = filter.side === side.dataset.side ? '' : side.dataset.side;
      // Round-library picks are side-relative; drop them when side clears/changes.
      filter.roundOwn = [];
      filter.roundOpp = [];
      resetListPage();
      // Side change rebuilds round menus; other segs only need class sync.
      scheduleRender({ rebuildFilters: true });
      return;
    }
    const result = e.target.closest('[data-result]');
    if (result) {
      filter.result = filter.result === result.dataset.result ? '' : result.dataset.result;
      resetListPage();
      scheduleRender({ rebuildFilters: false });
      return;
    }
    const adv = e.target.closest('[data-advantage]');
    if (adv) {
      filter.advantage =
        filter.advantage === adv.dataset.advantage ? '' : adv.dataset.advantage;
      resetListPage();
      scheduleRender({ rebuildFilters: false });
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
      filter.roundOwn = [];
      filter.roundOpp = [];
      filter.fromSec = null;
      filter.toSec = null;
      filter.rankOwn = '';
      filter.rankOpp = '';
      filter.dateFrom = '';
      filter.dateTo = '';
      filter.minRounds = defaultMinRounds(scopeForMinRounds([]));
      resetListPage();
      scheduleRender({ rebuildFilters: true });
    }
  });

  filtersEl.addEventListener('input', (e) => {
    const rank = e.target.closest('[data-rank]');
    if (!rank) return;
    const field = String(rank.dataset.rank || '').split('|').pop();
    if (field !== 'rankOwn' && field !== 'rankOpp') return;
    filter[field] = rank.value || '';
    syncRankSummary(rank.closest('details'), filter.rankOwn, filter.rankOpp);
    resetListPage();
    scheduleRender({ rebuildFilters: false });
  });

  filtersEl.addEventListener('change', (e) => {
    const awp = e.target.closest('[data-awp]');
    if (awp) {
      filter[awp.dataset.awp] = Boolean(awp.checked);
      awp.closest('.rp-awp-toggle')?.classList.toggle('active', awp.checked);
      resetListPage();
      scheduleRender({ rebuildFilters: false });
      return;
    }
    const roundBox = e.target.closest('[data-round-filter]');
    if (roundBox) {
      const field = roundBox.dataset.roundFilter === 'roundOpp' ? 'roundOpp' : 'roundOwn';
      const key = String(roundBox.value || '').trim();
      if (!key) {
        filter[field] = [];
      } else {
        const set = new Set(roundKeysOf(field === 'roundOpp' ? 'opp' : 'own'));
        if (roundBox.checked) set.add(key);
        else set.delete(key);
        filter[field] = [...set];
      }
      const keepOpen = field;
      resetListPage();
      void scheduleRender({ rebuildFilters: true }).then(() => {
        const kept = filtersEl.querySelector(`details[data-round-menu="${keepOpen}"]`);
        if (kept) {
          kept.setAttribute('open', '');
          placeRoundMenu(kept);
        }
      });
      return;
    }
    const roleSel = e.target.closest('[data-role-filter]');
    if (roleSel) {
      const side = roleSel.dataset.roleFilter === 'CT' ? 'CT' : 'T';
      const value = roleSel.value || '';
      filter.role = value ? { side, value } : null;
      resetListPage();
      scheduleRender({ rebuildFilters: false });
      return;
    }
    const sel = e.target.closest('[data-filter]');
    if (!sel) return;
    if (sel.dataset.filter === 'maps') {
      const prevDefault = defaultMinRounds(scopeForMinRounds(filter.maps));
      const wasDefault = filter.minRounds === prevDefault;
      filter.maps = sel.value ? [sel.value] : [];
      filter.role = null;
      filter.roundOwn = [];
      filter.roundOpp = [];
      // Clean Database: Any map → 80, a specific map → 5. Keep a manual floor
      // only when the user already moved off the previous auto default.
      if (wasDefault) filter.minRounds = defaultMinRounds(scopeForMinRounds(filter.maps));
      resetListPage();
      scheduleRender({ rebuildFilters: true });
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
      scheduleRender({ rebuildFilters: false });
      return;
    }
    if (sel.dataset.filter === 'minRounds') {
      const n = Math.max(0, Math.floor(Number(sel.value) || 0));
      filter.minRounds = n;
      sel.value = String(n);
      resetListPage();
      scheduleRender({ rebuildFilters: false });
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
      calendarOpen = true;
      resetListPage();
      scheduleRender({ rebuildFilters: false });
      return;
    }
    const value = sel.value === '' ? null : Number(sel.value);
    filter[sel.dataset.filter] = value;
    resetListPage();
    scheduleRender({ rebuildFilters: false });
  });

  tabsEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === tab || detail) return;
    tab = btn.dataset.tab;
    syncTabButtons();
    scheduleRender({ rebuildFilters: false });
  });

  document.addEventListener('pointerdown', (e) => {
    const inRoundMenu = e.target.closest?.('details.st-round-multi, details.st-rank-dd');
    if (!inRoundMenu) closeRoundMenus();

    if (searchMenuOpen && !e.target.closest?.('#st-search-typeahead')) {
      searchMenuOpen = false;
      refreshSearchMenu();
    }

    if (!calendarOpen) return;
    if (e.target.closest?.('.st-date-wrap')) return;
    setCalendarOpen(false);
  });

  window.addEventListener(
    'scroll',
    () => {
      for (const d of filtersEl.querySelectorAll('details.st-round-multi[open]')) {
        placeRoundMenu(d);
      }
      for (const d of filtersEl.querySelectorAll('details.st-rank-dd[open]')) {
        placeRankMenu(d);
      }
    },
    true
  );

  /** True when the user is dragging a text selection inside a name link. */
  function selectionInside(el) {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
    return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
  }

  /** Aggregation key for a team row (strip per-map suffix used in locked-team map lists). */
  function teamAggKey(r) {
    if (r?.mapRow && r.mapCode) {
      const suffix = `|${r.mapCode}`;
      const k = String(r.key || '');
      if (k.endsWith(suffix)) return k.slice(0, -suffix.length);
    }
    return r?.key || teamNameKey(r?.name);
  }

  /** Current list filters applied when collecting a team's Round WR rounds. */
  function roundsFilterForTeam(teamRow) {
    const maps = teamRow?.mapCode
      ? [teamRow.mapCode]
      : Array.isArray(filter.maps)
        ? filter.maps.filter(Boolean)
        : [];
    return {
      maps,
      side: filter.side || '',
      econ: filter.econ,
      oppEcon: filter.oppEcon,
      hasAwp: Boolean(filter.hasAwp),
      oppHasAwp: Boolean(filter.oppHasAwp),
      files: scope.files || null,
      result: filter.result || '',
      advantage: filter.advantage || '',
      dateFrom: filter.dateFrom || '',
      dateTo: filter.dateTo || '',
      roundOwn: [...roundKeysOf('own')],
      roundOpp: [...roundKeysOf('opp')],
      fromSec: Number.isFinite(filter.fromSec) ? filter.fromSec : null,
      toSec: Number.isFinite(filter.toSec) ? filter.toSec : null
    };
  }

  function collectTeamRoundFiles(teamRow) {
    if (!payload || !teamRow) return [];
    const want = teamAggKey(teamRow);
    if (!want) return [];
    const { players, demos } = indexMaps(payload);
    const active = roundsFilterForTeam(teamRow);
    const files = [];
    const seen = new Set();
    for (const row of allRows(payload)) {
      const demo = demos.get(row.d);
      if (!demo) continue;
      for (const team of [1, 2]) {
        const shortId = team === 1 ? demo.t1 : demo.t2;
        const displayName = team === 1 ? demo.name1 : demo.name2;
        const key = teamNameKey(displayName, shortId);
        if (key !== want) continue;
        if (!rowPasses(row, active, team, players, demos)) continue;
        const file = String(row.f || '').trim();
        if (!file || seen.has(file)) continue;
        seen.add(file);
        files.push(file);
      }
    }
    return files;
  }

  function teamRoundsTitle(teamRow) {
    const parts = [teamRow?.name || 'Team'];
    const mapCode = teamRow?.mapCode || singleMap();
    if (mapCode) parts.push(MAPS[mapCode]?.name || mapCode);
    if (filter.side === 'T' || filter.side === 'CT') parts.push(filter.side);
    if (mapCode && (filter.side === 'T' || filter.side === 'CT')) {
      const own = roundKeysOf('own');
      if (own.length) {
        parts.push(roundSummaryLabel(roundTypeRows(mapCode, filter.side), own));
      }
      const opp = roundKeysOf('opp');
      if (opp.length) {
        const oppSide = filter.side === 'T' ? 'CT' : 'T';
        parts.push(`vs ${roundSummaryLabel(roundTypeRows(mapCode, oppSide), opp)}`);
      }
    }
    return parts.join(' · ');
  }

  async function openTeamRounds(link) {
    if (!onPlayRounds || !link || selectionInside(link)) return;
    const key = String(link.dataset.stTeamRounds || '').trim();
    if (!key) return;
    const name = String(link.dataset.stTeamRoundsName || key).trim() || key;
    const mapCode = String(link.dataset.stTeamRoundsMap || '').trim();
    const teamRow = {
      key,
      name,
      mapCode: mapCode || undefined,
      mapRow: Boolean(mapCode)
    };
    // Server mode paints this table straight from the aggregate endpoint and
    // holds no rounds, so `collectTeamRoundFiles` had nothing to walk and the
    // click was a silent no-op on the default (unscoped) Database view. Pull
    // the payload the same way every other rounds-needing interaction does.
    if (!payload) {
      if (link.classList.contains('is-busy')) return;
      link.classList.add('is-busy');
      const wasBusy = bodyEl.getAttribute('aria-busy');
      try {
        await ensurePayload();
      } catch {
        return;
      } finally {
        link.classList.remove('is-busy');
        // ensurePayload marks the body busy for its own spinner; this path
        // never repaints the table, so put the flag back where it was.
        if (wasBusy === null) bodyEl.removeAttribute('aria-busy');
        else bodyEl.setAttribute('aria-busy', wasBusy);
      }
      if (!payload) return;
    }
    const files = collectTeamRoundFiles(teamRow);
    if (!files.length) return;
    await onPlayRounds(files, teamRoundsTitle(teamRow));
  }

  // ---- player rounds -> the timeline ---------------------------------------

  /**
   * The rounds behind one player's R count, as demo files.
   *
   * Deliberately the same walk `accumulatePlayers` does (shared/statsMath.js):
   * a round counts for a player when they appear in `row.p`, their seat resolves
   * to a team, and `rowPasses` accepts the round for THAT team. Anything looser
   * opens rounds the number never counted, which is worse than not linking at
   * all, because the count on screen stops being the thing you clicked.
   */
  function collectPlayerRoundFiles(playerRow) {
    if (!payload || !playerRow?.id) return [];
    const want = String(playerRow.id);
    const { players, demos } = indexMaps(payload);
    const active = roundsFilterForPlayer();
    const files = [];
    const seen = new Set();
    for (const row of allRows(payload)) {
      if (!row.p || !row.p[want]) continue;
      const team = players.get(`${row.d}:${want}`)?.team;
      if (!team) continue;
      if (!rowPasses(row, active, team, players, demos)) continue;
      if (lockedTeamName) {
        const demo = demos.get(row.d);
        if (!demo) continue;
        const displayName = team === 1 ? demo.name1 : demo.name2;
        if (teamNameKey(displayName) !== teamNameKey(lockedTeamName)) continue;
      }
      const file = String(row.f || '').trim();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
    return files;
  }

  /** The list filters, as the player walk wants them. */
  function roundsFilterForPlayer() {
    return {
      ...roundsFilterForTeam(null),
      ...(lockedTeamName ? { teamName: lockedTeamName } : {})
    };
  }

  function playerRoundsTitle(playerRow) {
    const parts = [playerRow?.name || 'Player'];
    const mapCode = singleMap();
    if (mapCode) parts.push(MAPS[mapCode]?.name || mapCode);
    if (filter.side === 'T' || filter.side === 'CT') parts.push(filter.side);
    return parts.join(' \u00b7 ');
  }

  /**
   * Whether the R count is worth making clickable.
   *
   * Gated on ONE map and ONE side, which is what makes the resulting set
   * coherent to watch: rounds from several maps, or both halves at once, open
   * as a pile with no shared geometry or shared sense of who was attacking.
   */
  function canOpenPlayerRounds() {
    if (!onPlayRounds) return false;
    if (!singleMap()) return false;
    return filter.side === 'T' || filter.side === 'CT';
  }

  function playerRoundsCell(p) {
    const col = PLAYER_COLUMNS.find((c) => c.key === 'rounds');
    const text = col ? col.cell(p) : String(p.rounds ?? '');
    if (!canOpenPlayerRounds() || !(p.rounds > 0) || !p.id) return escapeHtml(text);
    return `<span class="st-link st-rounds-open" role="link" tabindex="0" data-st-player-rounds="${escapeHtml(
      String(p.id)
    )}" data-st-player-rounds-name="${escapeHtml(p.name || '')}" title="Open these rounds in the timeline">${escapeHtml(
      text
    )}</span>`;
  }

  async function openPlayerRounds(link) {
    if (!onPlayRounds || !link || selectionInside(link)) return;
    const id = String(link.dataset.stPlayerRounds || '').trim();
    if (!id) return;
    const name = String(link.dataset.stPlayerRoundsName || id).trim() || id;
    // Server mode paints from the aggregate endpoint and holds no rounds, so
    // the walk above has nothing to read. Same on-demand pull the team link uses.
    if (!payload) {
      if (link.classList.contains('is-busy')) return;
      link.classList.add('is-busy');
      const wasBusy = bodyEl.getAttribute('aria-busy');
      try {
        await ensurePayload();
      } catch {
        return;
      } finally {
        link.classList.remove('is-busy');
        if (wasBusy === null) bodyEl.removeAttribute('aria-busy');
        else bodyEl.setAttribute('aria-busy', wasBusy);
      }
      if (!payload) return;
    }
    const files = collectPlayerRoundFiles({ id, name });
    if (!files.length) return;
    await onPlayRounds(files, playerRoundsTitle({ id, name }));
  }

  function teamRoundWrCell(r) {
    const col = TEAM_COLUMNS.find((c) => c.key === 'roundWinrate');
    const text = col ? col.cell(r) : '—';
    if (!onPlayRounds || !(r.rounds > 0)) return escapeHtml(text);
    const key = teamAggKey(r);
    if (!key) return escapeHtml(text);
    const mapAttr = r.mapCode
      ? ` data-st-team-rounds-map="${escapeHtml(r.mapCode)}"`
      : '';
    return `<span class="st-link st-round-wr" role="link" tabindex="0" data-st-team-rounds="${escapeHtml(
      key
    )}" data-st-team-rounds-name="${escapeHtml(r.name || '')}"${mapAttr} title="Open these rounds in the timeline">${escapeHtml(
      text
    )}</span>`;
  }

  bodyEl.addEventListener('click', (e) => {
    const wrLink = e.target.closest('[data-st-team-rounds]');
    if (wrLink && onPlayRounds) {
      e.preventDefault();
      void openTeamRounds(wrLink);
      return;
    }
    const rLink = e.target.closest('[data-st-player-rounds]');
    if (rLink && onPlayRounds) {
      e.preventDefault();
      void openPlayerRounds(rLink);
      return;
    }
    // Names are plain links; the browser (and site.js) owns them. The one
    // thing to catch is a drag that selected text inside one — that is a
    // selection, not a click on the link.
    const nameLink = e.target.closest('a.st-link');
    if (nameLink) {
      if (selectionInside(nameLink)) e.preventDefault();
      return;
    }
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) {
      if (pageBtn.disabled) return;
      const next = Number(pageBtn.dataset.page);
      if (!Number.isFinite(next) || next < 1) return;
      goToPage(next);
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
    // Reordering rows we already have. No recompute, no request.
    if (repaintTable()) return;
    scheduleRender({ rebuildFilters: false });
  });

  function goToPage(next) {
    const n = Math.floor(Number(next));
    if (!Number.isFinite(n) || n < 1) return;
    if (detail) {
      if (detailPage === n) return;
      detailPage = n;
    } else {
      if (page[tab] === n) return;
      page[tab] = n;
    }
    if (repaintTable()) return;
    scheduleRender({ rebuildFilters: false });
  }

  function commitPageInput(input) {
    if (!(input instanceof HTMLInputElement)) return;
    const max = Math.max(1, Math.floor(Number(input.dataset.stPageMax) || 1));
    const raw = Math.floor(Number(input.value));
    const next = Number.isFinite(raw) ? Math.min(max, Math.max(1, raw)) : 1;
    input.value = String(next);
    goToPage(next);
  }

  bodyEl.addEventListener('change', (e) => {
    const input = e.target.closest?.('[data-st-page-input]');
    if (!input) return;
    commitPageInput(input);
  });

  bodyEl.addEventListener('keydown', (e) => {
    const pageInput = e.target.closest?.('[data-st-page-input]');
    if (pageInput) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitPageInput(pageInput);
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const wrLink = e.target.closest?.('[data-st-team-rounds]');
    if (wrLink && e.target === wrLink && onPlayRounds) {
      e.preventDefault();
      void openTeamRounds(wrLink);
      return;
    }
    const rLink = e.target.closest?.('[data-st-player-rounds]');
    if (rLink && e.target === rLink && onPlayRounds) {
      e.preventDefault();
      void openPlayerRounds(rLink);
    }
    // Name links are anchors: Enter already activates them.
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
      roundOwn: [...roundKeysOf('own')],
      roundOpp: [...roundKeysOf('opp')],
      fromSec: Number.isFinite(filter.fromSec) ? filter.fromSec : null,
      toSec: Number.isFinite(filter.toSec) ? filter.toSec : null,
      rankOwn: filter.rankOwn || '',
      rankOpp: filter.rankOpp || '',
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
      teamName: lockedTeamName || '',
      searchPlayers: entityPick.players.map((p) => ({ id: p.id, name: p.name })),
      searchTeams: entityPick.teams.map((t) => ({ key: t.key, name: t.name }))
    };
  }

  function emitViewChange() {
    const state = viewState();
    if (syncUrl) {
      onViewChange?.(state);
      savedViews.touch();
    }
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
      if (filter.maps.length !== 1) {
        filter.roundOwn = [];
        filter.roundOpp = [];
      }
    } else if (next.map) {
      filter.maps = [String(next.map)];
    }

    if ('side' in next) {
      filter.side = next.side === 'T' || next.side === 'CT' ? next.side : '';
      if (!filter.side) {
        filter.roundOwn = [];
        filter.roundOpp = [];
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
    if ('rankOwn' in next) filter.rankOwn = String(next.rankOwn || '');
    if ('rankOpp' in next) filter.rankOpp = String(next.rankOpp || '');
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
    const asRoundKeys = (raw) => {
      if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
      const s = String(raw || '').trim();
      return s ? [s] : [];
    };
    if ('roundOwn' in next || 'round' in next) {
      filter.roundOwn = asRoundKeys(next.roundOwn ?? next.round);
    }
    if ('roundOpp' in next || 'vsRound' in next) {
      filter.roundOpp = asRoundKeys(next.roundOpp ?? next.vsRound);
    }
    if (!filter.side || filter.maps.length !== 1) {
      filter.roundOwn = [];
      filter.roundOpp = [];
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

    if ('searchPlayers' in next || 'searchTeams' in next) {
      const players = Array.isArray(next.searchPlayers) ? next.searchPlayers : [];
      const teams = Array.isArray(next.searchTeams) ? next.searchTeams : [];
      entityPick = {
        players: players
          .map((p) => ({
            id: String(p?.id || '').trim(),
            name: String(p?.name || p?.id || '').trim()
          }))
          .filter((p) => p.id),
        teams: teams
          .map((t) => ({
            key: String(t?.key || '').trim(),
            name: String(t?.name || t?.key || '').trim()
          }))
          .filter((t) => t.key)
      };
      if (searchOpen) renderSearch();
      else syncSearchToggle();
    }

    syncTabButtons();
    if (payload) scheduleRender({ rebuildFilters: true });
    else if (notify) emitViewChange();
  }

  function clearDetail() {
    detail = null;
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    scheduleRender({ rebuildFilters: false });
  }

  function openPlayerDetail(id, label) {
    const pid = String(id || '').trim();
    if (!pid) return;
    detail = { kind: 'player', id: pid, label: String(label || pid).trim() || pid };
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    tab = 'players';
    syncTabButtons();
    scheduleRender({ rebuildFilters: false });
  }

  function openTeamDetail(name, label) {
    const team = String(name || '').trim();
    if (!team || team === '—' || team === 'Multiple') return;
    detail = { kind: 'team', name: team, label: String(label || team).trim() || team };
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    tab = 'teams';
    syncTabButtons();
    scheduleRender({ rebuildFilters: false });
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
  if (syncUrl) el.querySelector('#st-saved')?.appendChild(savedViews.el);

  function syncHead() {
    const inDetail = Boolean(detail);
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
      expectedRating: null,
      expectedRatingOp: null,
      trueRating: null,
      clubKey: '',
      clubName: '',
      clubWinrate: null,
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
      coreOpenKills: 0,
      coreOpenDeaths: 0,
      copatt: null,
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

  /**
   * Names are addresses, not drill-downs.
   *
   * A name in the table is the point where someone stops asking about the
   * library and starts asking about a person or a team, and Performance is the
   * page that answers that. Real `<a href>`s, so the browser gives them
   * middle-click, copy-link and the back button; site.js routes them in place.
   */
  function performanceHref(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
    return `/performance?${q}`;
  }

  function playerLink(id, name) {
    const href = performanceHref({ player: id, name: name && name !== id ? name : '' });
    return `<a class="st-link" href="${escapeHtml(href)}">${escapeHtml(name)}</a>`;
  }

  function teamLink(name) {
    return `<a class="st-link" href="${escapeHtml(
      performanceHref({ team: name })
    )}">${escapeHtml(name)}</a>`;
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
      setBodyHtml(profileLink + statsTableHtml(data, {
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
      }));
      return;
    }
    let data = buildTeamMatchRows(detail.name, active, players, demos);
    if (detail.label === detail.name) {
      const named = data.find((r) => r.name);
      if (named?.name) detail.label = named.name;
    }
    const cols = teamMatchColumns();
    setBodyHtml(statsTableHtml(data, {
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
    }));
  }

  /** @type {{ current: number }} */
  const renderTokenRef = { current: 0 };

  /** Sync seg/toggle active classes without rebuilding the filter DOM. */
  function syncFilterChrome() {
    for (const btn of filtersEl.querySelectorAll('[data-side]')) {
      btn.classList.toggle('active', btn.dataset.side === filter.side);
    }
    for (const btn of filtersEl.querySelectorAll('[data-result]')) {
      btn.classList.toggle('active', btn.dataset.result === filter.result);
    }
    for (const btn of filtersEl.querySelectorAll('[data-advantage]')) {
      btn.classList.toggle('active', btn.dataset.advantage === filter.advantage);
    }
    for (const awp of filtersEl.querySelectorAll('[data-awp]')) {
      const on = Boolean(filter[awp.dataset.awp]);
      if (awp instanceof HTMLInputElement) awp.checked = on;
      awp.closest('.rp-awp-toggle')?.classList.toggle('active', on);
    }
    const mapSel = filtersEl.querySelector('[data-filter="maps"]');
    if (mapSel instanceof HTMLSelectElement) {
      mapSel.value = filter.maps?.[0] || '';
    }
    for (const key of ['econ', 'oppEcon', 'minRounds', 'fromSec', 'toSec', 'dateFrom', 'dateTo']) {
      const el = filtersEl.querySelector(`[data-filter="${key}"]`);
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
      const v = filter[key];
      if (key === 'fromSec' || key === 'toSec') {
        el.value = Number.isFinite(v) ? String(v) : '';
      } else if (key === 'econ' || key === 'oppEcon') {
        el.value = v === null || v === undefined ? '' : String(v);
      } else {
        el.value = v == null ? '' : String(v);
      }
    }
  }

  /**
   * Paint chrome, show a body spinner, then rebuild after a frame so the
   * sidebar stays clickable during aggregates.
   * @param {{ rebuildFilters?: boolean }} [opts]
   */
  /**
   * The rows behind whatever the table last painted.
   *
   * Sorting and paging are pure presentation — `statsTableHtml` does both from
   * the rows it is handed. They used to go through scheduleRender, which
   * re-derived the whole table: on the payload path that is aggregatePlayers
   * over every round in the library, and on the server path a fresh request.
   * Either way a click on a column header cost seconds to reorder rows that
   * were already computed and sitting in memory.
   * @type {{ data: any[], opts: object, prefix?: string } | null}
   */
  let lastTable = null;

  /**
   * Replace the table, keeping the columns the reader had scrolled to.
   *
   * Every repaint builds a fresh scroller, and a fresh scroller starts at the
   * far left. Sorting on a metric you had to scroll right to reach used to
   * snap the table back to the name columns and take the header you just
   * clicked off screen — the sort worked, but the click looked like it did
   * nothing. Same for paging and for a filter answered from the server.
   */
  function setBodyHtml(html) {
    const keep = bodyEl.querySelector('[data-st-hscroll-body]')?.scrollLeft || 0;
    bodyEl.innerHTML = html;
    if (!keep) return;
    const apply = () => {
      const scroller = bodyEl.querySelector('[data-st-hscroll-body]');
      if (!scroller) return;
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollLeft = Math.min(keep, max);
      const bar = bodyEl.querySelector('[data-st-hscroll-bar]');
      if (bar) bar.scrollLeft = scroller.scrollLeft;
    };
    apply();
    // Sticky column widths are measured a frame later (bindStatsHScroll), and
    // the scrollable width only settles once they are written.
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  /** Paint a table and remember what it was painted from. */
  function paintTable(data, opts, prefix = '') {
    lastTable = { data, opts, prefix };
    setBodyHtml(prefix + statsTableHtml(data, opts));
  }

  /**
   * Re-render the current table under a new sort or page, with no recompute.
   * Returns false when there is nothing cached and the caller must fall back.
   */
  function repaintTable() {
    if (!lastTable) return false;
    const s = detail ? detailSort : sort[tab];
    const opts = {
      ...lastTable.opts,
      sortKey: s.key,
      sortDir: s.dir,
      page: detail ? detailPage : page[tab]
    };
    // A table painted with preserveOrder is a fixed list (locked-team map rows,
    // compare rows); re-sorting it is not meaningful and its own path owns it.
    if (lastTable.opts.preserveOrder) return false;
    lastTable = { ...lastTable, opts };
    setBodyHtml((lastTable.prefix || '') + statsTableHtml(lastTable.data, opts));
    bindStatsHScroll(bodyEl);
    attachTips(bodyEl);
    emitViewChange();
    return true;
  }

  /** Every re-render the panel schedules, with the busy ring around it. */
  function scheduleRender(opts = {}) {
    return trackBusy(runScheduledRender(opts));
  }

  function runScheduledRender(opts = {}) {
    const rebuildFilters = opts.rebuildFilters !== false;
    if (!payload) {
      // Server mode. An interaction that needs rounds pulls them once and then
      // behaves exactly as it always did; everything else re-queries.
      if (needsRawRounds()) {
        // Move the bar before the rounds land: pulling them can take a while,
        // and a control that stays put reads as a dropped click.
        if (rebuildFilters) renderFilters();
        else syncFilterChrome();
        return ensurePayload()
          .then(() => {
            if (payload) render({ rebuildFilters });
          })
          // Without this the spinner runs forever on a failed page and the
          // rejection lands in the console instead of on screen.
          .catch(() => renderServerUnavailable());
      }
      if (rebuildFilters) renderFilters();
      else syncFilterChrome();
      bodyEl.setAttribute('aria-busy', 'true');
      // The table stays on screen while the query runs (it answers in
      // milliseconds), so a query that does NOT answer has to say so: the bar
      // has already moved, and leaving the old rows there is the one outcome
      // worse than an error — numbers that look current and are not.
      const onFail = renderServerUnavailable;
      if (detail) return refreshServerDetail({ onFail });
      if (lockedTeamName) return refreshServerLocked({ onFail });
      return refreshServerTables({ onFail, timeoutMs: FILTER_TIMEOUT_MS });
    }
    if (rebuildFilters) {
      // Structural filter changes still need a full filter bar rebuild, but do
      // it after the spinner paints so nav clicks can interrupt.
    } else {
      syncFilterChrome();
    }
    bodyEl.setAttribute('aria-busy', 'true');
    bodyEl.innerHTML = spinnerHtml('Updating…');
    return scheduleUiJob({
      tokenRef: renderTokenRef,
      work(token) {
        if (renderTokenRef.current !== token || !payload) return;
        render({ rebuildFilters });
      }
    });
  }

  /**
   * Tables computed on the server, used while no payload is loaded.
   *
   * The Database's default view — a filtered player or team table over the
   * whole library — is exactly what the aggregate endpoint returns, and it does
   * not need a single round in the browser. Everything else the panel can do
   * (per-demo detail, match boards, locked-team map compares, role columns,
   * roster pinning) does need rounds, so those pull the payload on demand.
   * @type {{ players: any[], teams: any[]|null, playersTotal: number } | null}
   */
  let serverTables = null;
  let serverToken = 0;
  /** Per-match rows for the open detail, from the server. `{ key, rows }`. */
  let serverDetail = null;
  let detailToken = 0;
  /**
   * Server rows for the locked-team (Team Overview) views: the pinned player
   * roster, the per-map team rows, and the one-map comparison. Each piece is a
   * scoped aggregate query, so the overview never downloads its team's rounds.
   */
  let serverLocked = null;
  let lockedToken = 0;

  /** Interactions that cannot be answered from the aggregate endpoint. */
  /**
   * Interactions that cannot be answered from the aggregate endpoint.
   *
   * Search picks used to be on this list. They are not any more: the catalogue
   * resolves a pick to demo ids and the aggregate is scoped to them, so the
   * answer arrives in one request instead of the whole library. A pick made
   * before the catalogue landed still falls back here, because without it there
   * is no way to turn a name into a demo list.
   *
   * A `files` scope is off the list too. `aggregateHot` has always honoured
   * `filter.files`, and the endpoint has always accepted a round-id list — the
   * Pattern Finder sends tens of thousands of them — so "the Database for these
   * selected rounds" was downloading the library to compute something the
   * server was already able to answer. fetchAggregate switches to POST once the
   * list outgrows a URL.
   *
   * So is the Role filter. Roles were never computed in the browser — the stats
   * index writes them per (map, side, player) and the browser only read that
   * table — so the store can carry them and the server can hand back rows that
   * already know their role.
   */
  function needsRawRounds() {
    return Boolean(
      (detail && !roster) ||
      (lockedTeamName && !roster) ||
      (hasEntityPick() && !roster) ||
      (scope.demos?.length && scope.demos.length <= 1)
    );
  }

  /**
   * Pull the library payload, once, for an interaction that needs rounds.
   * Everything after this point behaves exactly as it did before.
   */
  async function ensurePayload() {
    if (payload) return payload;
    const token = loadToken;
    bodyEl.setAttribute('aria-busy', 'true');
    setSpinnerLabel(bodyEl, 'Loading rounds…');
    try {
      const res = await getStatsPayload(scope.demos || null, {
        onProgress: (p) => {
          if (token !== loadToken) return;
          noteLibraryProgress({ loaded: p?.libraryLoaded, total: p?.libraryTotal });
        },
        onBatch: (batch) => {
          if (token !== loadToken) return;
          payload = batch.payload;
          noteLibraryProgress({ loaded: batch.loaded, total: batch.total });
          setLibraryLoading(Boolean(batch.hasMore));
        }
      });
      if (token !== loadToken) return null;
      payload = res;
      setLibraryLoading(false);
      return payload;
    } catch (err) {
      // A page that fails mid-stream used to leave the ring turning for the
      // rest of the session: nothing below the await ran, so the "still
      // loading" mark was never cleared and the count froze wherever it had
      // got to. Stop the ring, offer Retry (resumeLibrary picks up from the
      // last merged page), and let the caller see the failure.
      if (token === loadToken) {
        setLibraryLoading(false);
        setLibraryRetry(true);
      }
      throw err;
    }
  }

  /**
   * Which metric columns the caller's plan withholds, per table.
   *
   * The server strips the values and stamps `entitlements` on the response;
   * these mark the matching columns as locked so a free user sees a padlock
   * and the plan that includes the metric, not a column of dashes that looks
   * like a parse failure.
   */
  function lockedColsFor(table) {
    const ent = serverTables?.entitlements || payload?.entitlements;
    if (!ent) return null;
    if (table === 'players' && ent.playerMetricsFull === false) {
      return { keys: new Set(['dt', 'psdt', 'accuracy']), plan: 'Premium' };
    }
    if (table === 'teams' && ent.teamMetricsFull === false) {
      return { keys: new Set(['prw', 'possession']), plan: 'Team Elite' };
    }
    return null;
  }

  /** Render the two tables straight from server rows. */
  function renderFromServer() {
    if (!serverTables) return;
    lastTable = null;
    syncHead();
    syncFilterChrome();
    const searching = hasEntityPick();
    const minR = searching ? 0 : Math.max(0, Number(filter.minRounds) || 0);
    if (tab === 'players') {
      let data = serverTables.players || [];
      if (minR > 0) data = data.filter((p) => (p.rounds || 0) >= minR);
      // Scoping the query to the picked demos also returns everyone else who
      // played in them; the pick still decides which rows are shown.
      data = applyEntityPickPlayers(data);
      const mode = roleMode();
      let cols = mode
        ? playerColumnsWithRoles(mode)
        : { columns: PLAYER_COLUMNS, fixedCount: PLAYER_FIXED_BASE.length };
      if (omitTeamColumn) cols = omitPlayerTeamColumn(cols);
      paintTable(data, {
        columns: cols.columns,
        fixedCount: cols.fixedCount,
        escapeHtml,
        sortKey: sort.players.key,
        sortDir: sort.players.dir,
        page: page.players,
        pageSize: STATS_PAGE_SIZE,
        showAverage: true,
        nameCell: playerNameCell,
        teamCell: playerTeamCell,
        roundsCell: playerRoundsCell,
        lockedCols: lockedColsFor('players')
      });
    } else {
      // Team statistics are withheld entirely below Team Premium: the server
      // sends no teams table at all. Without this branch the tab said
      // "Nothing matches these filters", which is a lie — the data exists,
      // the plan does not include it. Locked, never hidden.
      const ent = serverTables.entitlements;
      if (ent && ent.teamStatistics === false && !Array.isArray(serverTables.teams)) {
        bodyEl.innerHTML = '';
        bodyEl.appendChild(
          upgradePrompt({
            message: 'Team statistics are available on Team Premium.',
            requiredTier: 'team_premium'
          })
        );
        bodyEl.removeAttribute('aria-busy');
        emitViewChange();
        return;
      }
      let data = serverTables.teams || [];
      if (minR > 0) data = data.filter((t) => (t.rounds || 0) >= minR);
      data = applyEntityPickTeams(data);
      paintTable(data, {
        columns: TEAM_COLUMNS,
        fixedCount: 2,
        escapeHtml,
        sortKey: sort.teams.key,
        sortDir: sort.teams.dir,
        page: page.teams,
        pageSize: STATS_PAGE_SIZE,
        showAverage: true,
        nameCell: teamNameCell,
        roundWrCell: teamRoundWrCell,
        lockedCols: lockedColsFor('teams')
      });
    }
    bodyEl.removeAttribute('aria-busy');
    bindStatsHScroll(bodyEl);
    attachTips(bodyEl);
    emitViewChange();
  }

  /** Demos the open detail covers, from the catalogue. */
  function detailDemoIds() {
    if (!detail || !roster) return null;
    return detail.kind === 'team'
      ? demosForTeam(roster, detail.name)
      : demosForPlayer(roster, detail.id);
  }

  /**
   * Pull the open detail's per-match rows from the server.
   *
   * The rows come back already aggregated per match, so the browser holds one
   * row per game instead of every round of every game the entity played.
   */
  async function refreshServerDetail(opts = {}) {
    const token = ++detailToken;
    const ids = detailDemoIds();
    if (!ids?.length) {
      serverDetail = { key: detailKey(), rows: [] };
      renderServerDetail();
      return true;
    }
    const active = { ...filter, files: scope.files || null };
    try {
      const res = await fetchAggregateMatches(
        detail.kind === 'team' ? { kind: 'team', id: detail.name } : { kind: 'player', id: detail.id },
        ids,
        active
      );
      if (token !== detailToken) return false;
      serverDetail = { key: detailKey(), rows: res?.rows || res?.players || [] };
      renderServerDetail();
      return true;
    } catch {
      if (token === detailToken) opts.onFail?.();
      return false;
    }
  }

  /** Map codes the locked team has played, read off the roster catalogue. */
  function lockedTeamMaps() {
    if (!roster || !lockedTeamName) return [];
    const inScope = scope.demos?.length ? new Set(scope.demos) : null;
    const want = teamNameKey(lockedTeamName);
    const played = new Set();
    for (const d of roster.demos || []) {
      if (inScope && !inScope.has(d.id)) continue;
      if (teamNameKey(d.n1, d.t1) !== want && teamNameKey(d.n2, d.t2) !== want) continue;
      if (d.m) played.add(String(d.m).toUpperCase());
    }
    const order = POSITION_MAPS.map((m) => m.code);
    return [...played].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  }

  /**
   * Fetch everything the locked-team views paint, as scoped aggregates.
   *
   * Three shapes, all queries the endpoint already answers:
   *  - players, twice: once under the active filters and once under only
   *    map/file scope, so the roster pin can show a player the filter zeroed
   *    out as dashes instead of dropping them;
   *  - teams once per played map (the Any-map per-map table);
   *  - on a single map, the library-wide teams table for the comparison.
   */
  async function refreshServerLocked(opts = {}) {
    const token = ++lockedToken;
    const demos = serverDemoScope();
    const maps = Array.isArray(filter.maps) ? filter.maps.filter(Boolean) : [];
    const oneMap = maps.length === 1 ? String(maps[0]) : '';
    // minRounds stays client-side here: the roster pin shows the locked
    // team's players regardless of the bar, which a server-side cut would
    // silently break.
    const active = {
      ...filter,
      files: scope.files || null,
      teamName: lockedTeamName,
      roles: true,
      minRounds: 0
    };
    const rosterActive = {
      maps: filter.maps,
      files: scope.files || null,
      teamName: lockedTeamName,
      roles: true
    };
    try {
      const jobs = {
        players: fetchAggregate(active, { tables: 'players,teams', demos }),
        rosterPlayers: fetchAggregate(rosterActive, { tables: 'players,teams', demos }),
        mapRows: oneMap
          ? Promise.resolve([])
          : Promise.all(
              lockedTeamMaps().map(async (code) => {
                const res = await fetchAggregate(
                  { ...active, maps: [code] },
                  { tables: 'teams', demos }
                );
                const row = (res?.teams || [])[0];
                if (!row || !(row.rounds > 0)) return null;
                return {
                  ...row,
                  name: MAPS[code]?.name || POSITION_MAPS.find((m) => m.code === code)?.name || code,
                  mapCode: code,
                  mapRow: true,
                  key: `${row.key}|${code}`
                };
              })
            ),
        libraryTeams: oneMap
          ? fetchAggregate({ ...filter, teamName: '', files: null, maps: [oneMap] }, { tables: 'teams' })
          : Promise.resolve(null),
        usRow: oneMap
          ? fetchAggregate({ ...active, maps: [oneMap] }, { tables: 'teams', demos })
          : Promise.resolve(null)
      };
      const [players, rosterPlayers, mapRows, libraryTeams, usRow] = await Promise.all([
        jobs.players,
        jobs.rosterPlayers,
        jobs.mapRows,
        jobs.libraryTeams,
        jobs.usRow
      ]);
      if (token !== lockedToken) return false;
      serverLocked = {
        players: players?.players || [],
        rosterPlayers: rosterPlayers?.players || [],
        mapRows: (mapRows || []).filter(Boolean),
        libraryTeams: libraryTeams?.teams || null,
        usRow: (usRow?.teams || [])[0] || null,
        oneMap
      };
      renderServerLocked();
      return true;
    } catch {
      if (token === lockedToken) opts.onFail?.();
      return false;
    }
  }

  /** Paint the locked-team views from the fetched aggregate rows. */
  function renderServerLocked() {
    if (!lockedTeamName || !serverLocked) return;
    syncHead();
    syncFilterChrome();
    const searching = hasEntityPick();
    const minR = searching ? 0 : Math.max(0, Number(filter.minRounds) || 0);

    if (tab === 'players') {
      // Pin exactly the way the payload path pins: the roster query decides
      // which players appear (and their order), the filtered query supplies
      // the numbers, and a filtered-out player shows as dashes.
      let rosterRows = serverLocked.rosterPlayers;
      if (minR > 0) rosterRows = rosterRows.filter((p) => (p.rounds || 0) >= minR);
      const byId = new Map(serverLocked.players.map((p) => [p.id, p]));
      let data = rosterRows.length
        ? rosterRows.map((base) => byId.get(base.id) || absentPlayerRow(base))
        : minR > 0
          ? serverLocked.players.filter((p) => (p.rounds || 0) >= minR)
          : serverLocked.players;
      data = applyEntityPickPlayers(data);
      const mode = roleModeOf(data);
      let cols = mode
        ? playerColumnsWithRoles(mode)
        : { columns: PLAYER_COLUMNS, fixedCount: PLAYER_FIXED_BASE.length };
      if (omitTeamColumn) cols = omitPlayerTeamColumn(cols);
      paintTable(data, {
        columns: cols.columns,
        fixedCount: cols.fixedCount,
        escapeHtml,
        sortKey: sort.players.key,
        sortDir: sort.players.dir,
        page: page.players,
        pageSize: STATS_PAGE_SIZE,
        showAverage: true,
        nameCell: playerNameCell,
        teamCell: playerTeamCell,
        roundsCell: playerRoundsCell
      });
    } else if (!serverLocked.oneMap) {
      let data = applyEntityPickTeams(serverLocked.mapRows);
      setBodyHtml(statsTableHtml(data, {
        columns: TEAM_MAP_COLUMNS,
        fixedCount: 2,
        escapeHtml,
        preserveOrder: true,
        showAverage: true,
        nameCell: teamNameCell,
        roundWrCell: teamRoundWrCell
      }));
    } else {
      // One map: worst / best / middle / us, footer averaged over every team
      // that played the map — the same selection lockedTeamMapCompare made,
      // over rows the library-wide aggregate already computed.
      let all = serverLocked.libraryTeams || [];
      all = minR > 0 ? all.filter((t) => (t.rounds || 0) >= minR) : all.filter((t) => (t.rounds || 0) > 0);
      const byWr = [...all].sort(
        (a, b) =>
          (b.roundWinrate || 0) - (a.roundWinrate || 0) ||
          String(a.name).localeCompare(String(b.name))
      );
      const want = teamNameKey(lockedTeamName);
      const us = byWr.find((t) => teamNameKey(t.name) === want) || serverLocked.usRow || null;
      const display = [];
      const seen = new Set();
      const push = (row, role) => {
        if (!row) return;
        const k = row.key || teamNameKey(row.name);
        if (!k || seen.has(k)) return;
        seen.add(k);
        display.push({ ...row, compareRole: role });
      };
      if (byWr.length) {
        push(byWr[byWr.length - 1], 'worst');
        push(byWr[0], 'best');
        push(byWr[Math.floor((byWr.length - 1) / 2)], 'mid');
      }
      push(us, 'us');
      const data = applyEntityPickTeams(display);
      setBodyHtml(statsTableHtml(data, {
        columns: TEAM_COLUMNS,
        fixedCount: 2,
        escapeHtml,
        preserveOrder: true,
        showAverage: true,
        averageRows: searching ? undefined : byWr,
        nameCell: teamNameCell,
        roundWrCell: teamRoundWrCell
      }));
    }
    bodyEl.removeAttribute('aria-busy');
    bindStatsHScroll(bodyEl);
    attachTips(bodyEl);
    emitViewChange();
  }

  /** Role column mode for rows that came back from the server. */
  function roleModeOf(rows) {
    const has = (rows || []).some((p) => p.roleT || p.roleCT || p.posT || p.posCT);
    if (!has) return '';
    return singleMap() ? 'position' : 'tactical';
  }

  /** Identity of the detail a cached row set belongs to. */
  function detailKey() {
    if (!detail) return '';
    return `${detail.kind}:${detail.kind === 'team' ? detail.name : detail.id}`;
  }

  /**
   * Paint per-match rows that came from the server.
   *
   * The identity columns — score, result, opponent — are derived here rather
   * than server-side because they depend on which side the entity was on, and
   * the row already carries the demo's two team names and winner.
   */
  function renderServerDetail() {
    if (!detail || !serverDetail) return;
    syncHead();
    syncFilterChrome();
    // `side`, `scoreLabel` and `scoreSort` are stamped server-side: the score
    // has to be the FILTERED round record, and only the query that applied the
    // filter knows it.
    const data = serverDetail.rows.map((row) => ({
      ...row,
      mapName: MAPS[row.map]?.name || row.map || '—',
      opponent: (row.side === 2 ? row.name1 : row.name2) || '—',
      result: row.winner === row.side ? 'W' : row.winner ? 'L' : '—',
      scoreLabel: row.scoreLabel || '',
      scoreSort: row.scoreSort ?? 0,
      uploadedAt: row.uploadedAt || 0
    }));
    if (detail.label === (detail.id || detail.name)) {
      const named = data.find((r) => r.name);
      if (named?.name) detail.label = named.name;
    }
    const cols = detail.kind === 'team' ? teamMatchColumns() : playerMatchColumns();
    const profileLink =
      detail.kind === 'player'
        ? `<p class="st-profile-link">
        <a href="/performance?player=${encodeURIComponent(detail.id)}&name=${encodeURIComponent(
          detail.label || detail.id
        )}">Open player profile</a>
      </p>`
        : '';
    paintTable(
      data,
      {
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
      },
      profileLink
    );
    bodyEl.removeAttribute('aria-busy');
    bindStatsHScroll(bodyEl);
    attachTips(bodyEl);
    syncHead();
    emitViewChange();
  }

  /**
   * Re-query the server for the current filter. Used when the panel is in
   * server mode and a filter, tab or sort changes.
   */
  /**
   * How long the aggregate endpoint gets before the panel stops waiting on it.
   *
   * Warm, it answers in milliseconds. Cold, it has to build the resident store
   * from every stats index in the library, and while that runs it answers
   * nothing at all — every caller is parked on the same in-flight build. The
   * page used to wait on that for as long as it took, showing a spinner and
   * then "No response from the server yet", which reads as "the site is down".
   *
   * Giving up here does not lose the work: the build carries on server-side and
   * the next load gets it warm. What it buys is the fallback below, which pages
   * the library in and paints as each page lands, so there is always something
   * on screen.
   */
  const AGGREGATE_TIMEOUT_MS = 8_000;

  /** Last "store still building" progress a 503 carried, for the spinner. */
  let serverBuilding = null;

  /**
   * What the server said its store is catching up on, from the last 200:
   * `{ mode: 'append'|'rebuild', done, total }` or null when current.
   *
   * The tables on screen are real numbers either way — this is the footnote
   * that says a demo or two (or, during a rebuild, the whole store) is being
   * folded in behind them. The load ring shows it, and a light poll below
   * repaints the tables once the server reports it has caught up.
   */
  let serverRefreshing = null;
  let refreshPollTimer = null;
  let refreshPollCount = 0;
  /** Between polls. A heal lands in seconds; a rebuild within a few minutes. */
  const REFRESH_POLL_MS = 5_000;
  /** Give up badging after ~5 minutes of "still refreshing". */
  const REFRESH_POLL_MAX = 60;

  function setServerRefreshing(next) {
    serverRefreshing = next && Number(next.total) > 0 ? next : null;
    if (!serverRefreshing) refreshPollCount = 0;
    paintLoadRing();
    if (serverRefreshing) scheduleRefreshPoll();
  }

  function clearRefreshPoll() {
    clearTimeout(refreshPollTimer);
    refreshPollTimer = null;
    refreshPollCount = 0;
    serverRefreshing = null;
  }

  function scheduleRefreshPoll() {
    if (refreshPollTimer) return;
    const token = loadToken;
    refreshPollTimer = setTimeout(() => {
      refreshPollTimer = null;
      void pollServerRefreshing(token);
    }, REFRESH_POLL_MS);
  }

  /**
   * Ask only "are you still refreshing?", then repaint once the answer is no.
   *
   * The poll is not refreshServerTables: repainting a table every few seconds
   * under someone reading it is worse than the staleness it fixes. So the
   * cheapest aggregate the endpoint will answer — a min-rounds bar no player
   * clears — carries the state over, and the one real repaint happens on the
   * transition to "caught up".
   */
  async function pollServerRefreshing(token) {
    if (token !== loadToken || !serverRefreshing) return;
    // Rounds in the browser, a detail view, or a locked team: the main tables
    // are not on screen, so there is nothing for the badge to promise.
    if (payload || detail || lockedTeamName) {
      setServerRefreshing(null);
      return;
    }
    refreshPollCount += 1;
    if (refreshPollCount > REFRESH_POLL_MAX) {
      setServerRefreshing(null);
      return;
    }
    let state = null;
    try {
      const res = await fetchAggregate(
        { minRounds: 1_000_000 },
        { tables: 'players', limit: 1, demos: serverDemoScope() }
      );
      state = res?.refreshing || null;
    } catch {
      // A 503 means the store went cold under us; anything else means the
      // poll could not ask. Either way the badge has nothing true to say.
      if (token === loadToken) setServerRefreshing(null);
      return;
    }
    if (token !== loadToken) return;
    if (state && Number(state.total) > 0) {
      serverRefreshing = state;
      paintLoadRing();
      scheduleRefreshPoll();
      return;
    }
    // Caught up: one repaint with the fresh numbers, through the same query
    // the tables were painted with (which also re-reads `refreshing`, so a
    // drip that started meanwhile re-badges rather than being missed).
    setServerRefreshing(null);
    await trackBusy(refreshServerTables({ timeoutMs: FILTER_TIMEOUT_MS }));
  }

  async function refreshServerTables(opts = {}) {
    const token = ++serverToken;
    serverBuilding = null;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : AGGREGATE_TIMEOUT_MS;
    // `roles: true` asks for the role columns even with no role chip set: the
    // table shows a Role column whenever the library has roles at all.
    // min-rounds is applied on the server: the bar hides most of a big
    // library's players, and shipping tens of thousands of rows to discard
    // them in the browser was most of the response. A search pick must not be
    // hidden under it, so a pick re-queries without the bar — the same rule
    // renderFromServer applies to whatever rows it holds.
    const active = {
      ...filter,
      files: scope.files || null,
      roles: true,
      minRounds: hasEntityPick() ? 0 : Math.max(0, Number(filter.minRounds) || 0)
    };
    try {
      const TIMED_OUT = Symbol('aggregate-timeout');
      let timer = null;
      const res = await Promise.race([
        fetchAggregate(active, { tables: 'players,teams', demos: serverDemoScope() }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        })
      ]);
      clearTimeout(timer);
      if (res === TIMED_OUT) {
        // Retire this token so the response, if it ever lands, does not paint
        // over whatever the fallback has put on screen by then.
        serverToken += 1;
        setServerRefreshing(null);
        opts.onFail?.();
        return false;
      }
      if (token !== serverToken) return false;
      serverTables = res;
      setServerRefreshing(res?.refreshing || null);
      renderFromServer();
      return true;
    } catch (err) {
      // A 503 while the statistics store builds carries where the build is.
      // The whole body is kept: `building`/`disabled`/`progress` are what let
      // the caller tell "wait for it" apart from "it is not coming".
      if (err?.status === 503 && err?.body?.building) {
        serverBuilding = err.body;
      }
      // Only the query that is still the current one may paint an error over
      // the table; a superseded one is about to be answered by its successor.
      if (token === serverToken) {
        // No served tables means nothing for the refresh badge to annotate.
        setServerRefreshing(null);
        opts.onFail?.();
      }
      return false;
    }
  }

  /**
   * Ceiling on a filter change's aggregate query.
   *
   * Much longer than AGGREGATE_TIMEOUT_MS, which exists so the FIRST load can
   * give up on a cold store and fall back to streaming rounds. A filter change
   * has no such fallback to race towards: the outcomes are the answer or an
   * honest failure, and abandoning a slow-but-coming answer at eight seconds
   * only produced the second one sooner.
   */
  const FILTER_TIMEOUT_MS = 45_000;

  /**
   * A filter change the server could not answer.
   *
   * Keeps the filter bar (it says what was asked for) and replaces the rows,
   * because the rows are the PREVIOUS filter's. When the 503 carried a build
   * position, say where it is: "still preparing" and "failed" want different
   * patience from the reader.
   */
  function renderServerUnavailable() {
    const p =
      serverBuilding?.building && !serverBuilding?.disabled ? serverBuilding.progress : null;
    const total = Number(p?.total) || 0;
    const label = total
      ? `Server is still preparing statistics, ${Number(p.done) || 0} of ${total} demos.`
      : 'The table could not be updated for these filters.';
    bodyEl.innerHTML = `<p class="view-empty">${escapeHtml(label)}</p>
      <button type="button" class="btn btn-sm" data-st-refilter>Retry</button>`;
    bodyEl.removeAttribute('aria-busy');
    bodyEl.querySelector('[data-st-refilter]')?.addEventListener('click', () => {
      void scheduleRender({ rebuildFilters: false });
    });
  }

  function render(opts = {}) {
    // A full render replaces whatever the table was showing.
    lastTable = null;
    if (!payload) {
      // Server mode: no rounds in the browser, so paint from the endpoint.
      if (detail) {
        if (serverDetail) renderServerDetail();
        return;
      }
      if (lockedTeamName) {
        if (serverLocked) renderServerLocked();
        return;
      }
      if (serverTables) renderFromServer();
      return;
    }
    const rebuildFilters = opts.rebuildFilters !== false;
    syncHead();
    if (rebuildFilters) renderFilters();
    else syncFilterChrome();
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
      bodyEl.removeAttribute('aria-busy');
      bindStatsHScroll(bodyEl);
      emitViewChange();
      return;
    }

    const mode = roleMode();
    let playerCols = mode
      ? playerColumnsWithRoles(mode)
      : { columns: PLAYER_COLUMNS, fixedCount: PLAYER_FIXED_BASE.length };
    if (omitTeamColumn) playerCols = omitPlayerTeamColumn(playerCols);

    // Entity search means "show these rows"; do not also hide them under min-rounds.
    const searching = hasEntityPick();
    const minR = searching ? 0 : Math.max(0, Number(filter.minRounds) || 0);

    if (tab === 'players') {
      const filtered = enrichedPlayers(rows, players, active, demos);
      let data = pinTeamRoster(rows, players, active, demos, filtered, minR);
      data = applyEntityPickPlayers(data);
      attachExpectedRatings(data, aggregateTeams(rows, players, demos, active));
      const matchDemo = singleMatchDemo(payload, scope);
      if (matchDemo) {
        setBodyHtml(matchBoardsHtml(data, matchDemo, {
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir,
          columns: playerCols.columns,
          fixedCount: playerCols.fixedCount
        }));
      } else {
        paintTable(data, {
          columns: playerCols.columns,
          fixedCount: playerCols.fixedCount,
          escapeHtml,
          sortKey: sort.players.key,
          sortDir: sort.players.dir,
          page: page.players,
          pageSize: STATS_PAGE_SIZE,
          showAverage: true,
          nameCell: playerNameCell,
          teamCell: playerTeamCell,
          roundsCell: playerRoundsCell
        });
      }
    } else {
      const maps = Array.isArray(active.maps) ? active.maps.filter(Boolean) : [];
      const oneMap = maps.length === 1 ? String(maps[0]) : '';

      if (lockedTeamName && !oneMap) {
        // Any map: one row per map for the locked team.
        let data = lockedTeamPerMapRows(rows, players, demos, active);
        data = applyEntityPickTeams(data);
        setBodyHtml(statsTableHtml(data, {
          columns: TEAM_MAP_COLUMNS,
          fixedCount: 2,
          escapeHtml,
          preserveOrder: true,
          showAverage: true,
          nameCell: teamNameCell,
          roundWrCell: teamRoundWrCell
        }));
      } else if (lockedTeamName && oneMap) {
        // One map: us vs best / mid / worst on that map; footer = all-team average.
        const compared = lockedTeamMapCompare(
          rows,
          players,
          demos,
          active,
          oneMap,
          minR
        );
        const data = applyEntityPickTeams(compared.rows);
        setBodyHtml(statsTableHtml(data, {
          columns: TEAM_COLUMNS,
          fixedCount: 2,
          escapeHtml,
          preserveOrder: true,
          showAverage: true,
          averageRows: searching ? undefined : compared.averageRows,
          nameCell: teamNameCell,
          roundWrCell: teamRoundWrCell
        }));
      } else {
        let data = aggregateTeams(rows, players, demos, active);
        if (minR > 0) data = data.filter((t) => (t.rounds || 0) >= minR);
        data = applyEntityPickTeams(data);
        paintTable(data, {
          columns: TEAM_COLUMNS,
          fixedCount: 2,
          escapeHtml,
          sortKey: sort.teams.key,
          sortDir: sort.teams.dir,
          page: page.teams,
          pageSize: STATS_PAGE_SIZE,
          showAverage: true,
          nameCell: teamNameCell,
          roundWrCell: teamRoundWrCell
        });
      }
    }
    bodyEl.removeAttribute('aria-busy');
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
  function load(next = {}) {
    return trackBusy(loadLibrary(next));
  }

  async function loadLibrary(next = {}) {
    const token = ++loadToken;
    scope = {
      demos: Array.isArray(next.demos) ? [...next.demos] : undefined,
      files: Array.isArray(next.files) ? [...next.files] : undefined,
      title: next.title || ''
    };
    lockedTeamName = String(next.teamName || '').trim();
    scopeEl.textContent = next.title || '';
    payload = null;
    serverTables = null;
    serverDetail = null;
    serverLocked = null;
    // Start the catalogue now; it is awaited below, before the panel decides
    // whether it needs raw rounds.
    const rosterReady = ensureRoster();
    // A re-scoped load counts from zero against a different total.
    resetLibraryProgress();
    setLibraryLoading(false);
    setLibraryRetry(false);
    clearRefreshPoll();
    bodyEl.innerHTML = spinnerHtml('Loading database…');
    filtersEl.innerHTML = '';
    const cancelSlow = watchSlowLoad(bodyEl, {
      // Longer than AGGREGATE_TIMEOUT_MS on purpose. A cold statistics store
      // legitimately takes several seconds to answer, and telling someone the
      // API might be down while it is simply working is worse than saying
      // nothing: the old 4s default fired on every cold load and read as an
      // outage. Past this point the fallback should have painted something, so
      // an empty view really does mean something is wrong.
      delayMs: 15_000,
      message:
        'Still waiting on the server. If this does not clear, check that the API is running and your connection is up.'
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
    filter.rankOwn = '';
    filter.rankOpp = '';
    entityPick = { players: [], teams: [] };
    searchQuery = '';
    searchMenuOpen = false;
    tab = 'players';
    sort = { players: { key: 'rating', dir: 'desc' }, teams: { key: 'avgRating', dir: 'desc' } };
    page = { players: 1, teams: 1 };
    detail = null;
    detailPage = 1;
    detailSort = { key: 'date', dir: 'desc' };
    applyViewState(next, { notify: false });
    syncSearchToggle();
    if (searchOpen) renderSearch();

    // One clock for the WHOLE load, not per phase.
    //
    // Every stage here can stall — the ranks, the catalogue, the aggregate, the
    // paged fallback — and each one used to own its own label. When a stage
    // reported nothing, the spinner simply froze on whatever text it was left
    // with and the page was indistinguishable from a dead one. So the seconds
    // tick regardless, and whatever the current stage knows is prepended to
    // them: `Loading stats 41/300 · <demo> · 12s` when there is real progress,
    // `Loading database… · 12s` when there is not. Something always moves.
    let waited = 0;
    let phaseLabel = 'Loading database…';
    const showProgress = (label) => {
      if (label) phaseLabel = label;
      if (token !== loadToken) return;
      setSpinnerLabel(bodyEl, waited ? `${phaseLabel} · ${waited}s` : phaseLabel);
    };
    // Rate → ETA, measured between this load's own progress events so a warm
    // cache start does not flatter the estimate. Needs a few seconds and a few
    // demos before it says anything: a promise made after one data point is a
    // number pulled out of thin air.
    let etaBase = null;
    const etaFor = (done, total) => {
      if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return undefined;
      if (!etaBase) {
        etaBase = { atWaited: waited, done };
        return undefined;
      }
      const dt = waited - etaBase.atWaited;
      const dd = done - etaBase.done;
      if (dt < 3 || dd < 3 || done >= total) return undefined;
      return (dt / dd) * (total - done);
    };
    const clock = setInterval(() => {
      if (token !== loadToken) {
        clearInterval(clock);
        return;
      }
      waited += 1;
      showProgress();
    }, 1000);
    const stopClock = () => clearInterval(clock);

    // The default table view needs neither the catalogue nor the ranks to be
    // answered — only detail views, locked teams, picks and tiny scopes do.
    // Start the aggregate query NOW so the slow half (a cold aggregate store
    // after a deploy) overlaps the roster/ranks fetches instead of queueing
    // behind them; the re-render in the served branch below picks up ranks
    // once they land.
    const canServeEarly =
      !detail &&
      !lockedTeamName &&
      !hasEntityPick() &&
      !(scope.demos?.length && scope.demos.length <= 1);
    const earlyTables = canServeEarly ? refreshServerTables().catch(() => false) : null;
    // The catalogue decides whether a detail view or a search pick can be
    // answered by the server. It is ~14 KB and arrives in tens of milliseconds;
    // deciding without it means defaulting to a library download, which is the
    // thing it exists to avoid. Both requests are already in flight.
    await Promise.all([fetchVrsRanks().catch(() => {}), rosterReady]);
    if (token !== loadToken) return;

    // Server mode. The default view is a filtered table over the library, which
    // the aggregate endpoint answers in milliseconds — so ask for that first,
    // with the filters this load resolved to, and only pull rounds when the
    // view actually needs them.
    if (!needsRawRounds()) {
      // A detail view opened straight from a URL asks the matches endpoint,
      // a locked team (Team Overview) its aggregate pieces; all paint without
      // a round reaching the browser.
      let served = detail
        ? await refreshServerDetail()
        : lockedTeamName
          ? await refreshServerLocked()
          : earlyTables
            ? await earlyTables
            : await refreshServerTables();
      if (token !== loadToken) {
        stopClock();
        return;
      }
      // The store is building and says where it is: WAIT for it, visibly,
      // instead of falling back. The fallback for the library view is the
      // whole library over the wire — hundreds of MB on a real deployment —
      // and it competes with the build for the same disk and CPU, so taking
      // it here made both slower. Polling costs a request every few seconds
      // and lands on tables the moment the store is warm. The fallback below
      // still runs the moment the 503 stops carrying progress: a failed or
      // disabled store must degrade to the paged path, not to a spinner.
      if (!served && !detail && !lockedTeamName) {
        for (let polls = 0; polls < 240; polls++) {
          const b = serverBuilding;
          if (!b?.building || b.disabled || !b.progress) break;
          const p = b.progress;
          const eta = etaLabel(p.etaSeconds);
          showProgress(
            `Server preparing statistics ${Number(p.done) || 0}/${Number(p.total) || 0}` +
              `${eta ? ` · ${eta}` : ''}`
          );
          await new Promise((r) => setTimeout(r, 2500));
          if (token !== loadToken) {
            stopClock();
            return;
          }
          served = await refreshServerTables();
          if (token !== loadToken) {
            stopClock();
            return;
          }
          if (served) break;
        }
      }
      if (served) {
        stopClock();
        cancelSlow();
        renderFilters();
        if (detail) renderServerDetail();
        else if (lockedTeamName) renderServerLocked();
        else renderFromServer();
        return;
      }
      // The aggregate could not answer: an older server, an error, or a store
      // still building. The payload path below is the whole feature either way,
      // and it paints page by page. Re-rendering the spinner drops the label
      // the clock has been writing, so hand it straight back — with the
      // server's own build position when the 503 carried one.
      const bp = serverBuilding?.progress;
      const buildingLabel =
        bp && Number(bp.total) > 0
          ? `Server preparing statistics ${Number(bp.done) || 0}/${Number(bp.total)}${
              etaLabel(bp.etaSeconds) ? ` · ${etaLabel(bp.etaSeconds)}` : ''
            } · loading rounds meanwhile`
          : 'Loading rounds…';
      bodyEl.innerHTML = spinnerHtml(buildingLabel);
      showProgress(buildingLabel);
    }

    try {
      let painted = false;
      const res = await getStatsPayload(scope.demos || null, {
        onProgress: (p) => {
          if (token !== loadToken) return;
          // Demo-by-demo inside the page in flight, so the hover count moves
          // continuously instead of jumping a page at a time. statsCache stamps
          // these as library-wide figures; the raw event is per-page.
          noteLibraryProgress({ loaded: p?.libraryLoaded, total: p?.libraryTotal });
          if (painted) return;
          // Through the clock, so the elapsed seconds ride along and a phase
          // that goes quiet does not leave a frozen label behind it. The ETA
          // comes from this load's own rate over the library-wide counts.
          const done = Number(p?.libraryLoaded ?? p?.done);
          const total = Number(p?.libraryTotal ?? p?.total);
          showProgress(statsProgressLabel({ ...p, etaSeconds: etaFor(done, total) }));
        },
        onBatch: (batch) => {
          if (token !== loadToken) return;
          payload = batch.payload;
          noteLibraryProgress({ loaded: batch.loaded, total: batch.total });
          setLibraryLoading(Boolean(batch.hasMore));
          const rounds = (payload.demos || []).reduce((n, d) => n + (d.rounds?.length || 0), 0);
          if (!rounds) {
            if (!batch.hasMore) {
              cancelSlow();
              filtersEl.innerHTML = '';
              bodyEl.innerHTML =
                '<p class="view-empty">No parsed rounds to measure yet. Upload a replay first.</p>';
            }
            return;
          }
          cancelSlow();
          // Rows are on screen from here on; the spinner they belonged to is
          // gone, so the clock has nothing left to write to.
          stopClock();
          const rebuildFilters = !painted;
          painted = true;
          void scheduleUiJob({
            tokenRef: renderTokenRef,
            isCurrent: () => token === loadToken,
            work() {
              if (token !== loadToken) return;
              render({ rebuildFilters });
            }
          });
        }
      });
      cancelSlow();
      if (token !== loadToken) return;
      payload = res;
      setLibraryLoading(false);
      setLibraryRetry(false);
      const rounds = (res.demos || []).reduce((n, d) => n + (d.rounds?.length || 0), 0);
      if (!rounds) {
        filtersEl.innerHTML = '';
        bodyEl.innerHTML =
          '<p class="view-empty">No parsed rounds to measure yet. Upload a replay first.</p>';
        emitViewChange();
        return;
      }
      if (!painted) {
        setSpinnerLabel(bodyEl, statsProgressLabel({ phase: 'building-table' }));
        if (searchOpen) renderSearch();
        else syncSearchToggle();
      }
      await scheduleUiJob({
        tokenRef: renderTokenRef,
        isCurrent: () => token === loadToken,
        work() {
          if (token !== loadToken) return;
          render({ rebuildFilters: !painted });
        }
      });
      if (token !== loadToken) return;
      void savedViews.refresh();
      void savedViews.applyShareParam(
        Object.fromEntries(new URLSearchParams(window.location.search))
      );
    } catch (err) {
      cancelSlow();
      setLibraryLoading(false);
      if (token !== loadToken) return;
      if (payload?.demos?.some((d) => d.rounds?.length)) {
        setLibraryRetry(true);
        void scheduleUiJob({
          tokenRef: renderTokenRef,
          isCurrent: () => token === loadToken,
          work() {
            if (token !== loadToken) return;
            render({ rebuildFilters: !painted });
          }
        });
        return;
      }
      filtersEl.innerHTML = '';
      const msg = formatApiError(err).message || 'Could not load stats.';
      bodyEl.innerHTML = `<p class="view-empty">${escapeHtml(msg)}</p>
        <button type="button" class="btn btn-sm" data-st-retry>Retry</button>`;
      bodyEl.querySelector('[data-st-retry]')?.addEventListener('click', () => load({ ...scope, ...next }));
    } finally {
      // Every path out of here: painted, empty, failed, superseded. A stray
      // interval would keep writing seconds onto whatever replaced the spinner.
      stopClock();
    }
  }

  async function resumeLibrary() {
    const token = loadToken;
    setLibraryRetry(false);
    setLibraryLoading(true);
    try {
      const res = await getStatsPayload(scope.demos || null, {
        onProgress: (p) => {
          if (token !== loadToken) return;
          noteLibraryProgress({ loaded: p?.libraryLoaded, total: p?.libraryTotal });
        },
        onBatch: (batch) => {
          if (token !== loadToken) return;
          payload = batch.payload;
          noteLibraryProgress({ loaded: batch.loaded, total: batch.total });
          setLibraryLoading(Boolean(batch.hasMore));
          void scheduleUiJob({
            tokenRef: renderTokenRef,
            isCurrent: () => token === loadToken,
            work() {
              if (token !== loadToken) return;
              render({ rebuildFilters: false });
            }
          });
        }
      });
      if (token !== loadToken) return;
      payload = res;
      setLibraryLoading(false);
      setLibraryRetry(false);
      render({ rebuildFilters: false });
    } catch {
      if (token !== loadToken) return;
      setLibraryLoading(false);
      setLibraryRetry(true);
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
    mountPageHead,
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
      setLibraryLoading(false);
      setLibraryRetry(false);
      if (usePageHead && pageHeadEl) {
        const slot = document.getElementById('page-head-actions');
        if (slot?.contains(pageHeadEl)) slot.replaceChildren();
      }
      detachTips();
      detachHeadTips();
      el.remove();
    }
  };
}
