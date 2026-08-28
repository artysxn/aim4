// ---------------------------------------------------------------------------
// Pattern finder, three chapters:
//   Search   map-first filters + optional subjects → drawn-selection rules
//            (each with its own feature and clock window), the matching
//            rounds on the left under the filters, stats on the right with a
//            players / teams switch. Chapter key stays `players` so old
//            links and saved views keep resolving.
//   Teams    scout a library team, write a team document (antistratPanel).
//            Chapter key stays `antistrat` for the same reason.
//   Players  the same, for one body: what he repeats and what he does
//            instead (playerScoutPanel).
//   Charts   scatter builder over the stats index (chartsPanel).
// ---------------------------------------------------------------------------

import { consumeCapability, fetchVrsRanks, formatApiError } from '../api.js';
import { getStatsPayload, peekStatsCache, statsCacheGeneration } from '../statsCache.js';
import { fetchRoster, fetchAggregateForRounds, fetchZones } from '../api.js';
import { TickTrack } from '../tickStore.js';
import { loadRadar } from '../viewer/radarRenderer.js';
import { hasControlField, prepareControlField } from '../zones/zoneOverlay.js';
import {
  MAP_CONTROL_MAX_SECONDS,
  cellsInShape,
  controlOfCells,
  controlShapes,
  controlTeamRows,
  controlWindow,
  controlWinrates
} from './zoneControl.js';
import { demosForMap, rosterMaps } from '../shared/rosterQuery.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { attachTips } from '../stats/statsTables.js';
import {
  ANALYTICS_PLAYER_MAX,
  aggregateAnalyticsAsync,
  leaderboardFromFiles,
  listMaps,
  listPlayers,
  listTeams,
  teamLeaderboardFromFiles
} from './analyticsMath.js';
import { createPresenceRadar } from './presenceRadar.js';
import {
  SHAPE_FEATURES,
  SHAPE_WINDOW_MAX_SECONDS,
  UTIL_KEYS,
  loadShapes,
  saveShapes,
  newShapeId,
  sanitizeTimeWindow,
  shapeUtilityKeys
} from './shapeFilters.js';
import { createRangeSlider } from '../../lib/rangeSlider.js';
import { iconImgHtml } from '../viewer/equipmentIcons.js';
import { hasRoundLibrary, roundTypeRows } from './roundLibrary.js';
import { mbIcon, mbSummary, mbWrap } from '../../icons/menubuttons.js';
import {
  etaLabel,
  setSpinnerLabel,
  spinnerHtml,
  statsProgressLabel,
  watchSlowLoad
} from '../../lib/spinner.js';
import { renderUpgradeError } from '../../site/upgradeGate.js';
import { createSavedViews } from '../savedViews.js';
import { createAntistratPanel } from './antistratPanel.js';
import { createPlayerScoutPanel } from './playerScoutPanel.js';
import { createChartsPanel } from '../charts/chartsPanel.js';
import { placeRankMenu, rankFilterHtml, syncRankSummary } from '../shared/vrsRanks.js';
import sideCharts from '../../icons/sideicons/sideicon_charts.svg?raw';

const PHASE_OPTS = [
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

const UTIL_ICONS = [
  { key: 'smoke', weapon: 'smokegrenade', title: 'Smokes', label: 'Smoke' },
  { key: 'molotov', weapon: 'molotov', title: 'Molotovs', label: 'Molotov' },
  { key: 'flash', weapon: 'flashbang', title: 'Flashes', label: 'Flash' },
  { key: 'he', weapon: 'hegrenade', title: 'HE', label: 'HE' }
];

function defaultUtility() {
  return { smoke: true, molotov: true, flash: true, he: true };
}

function defaultTimeWindow() {
  return { from: 0, to: SHAPE_WINDOW_MAX_SECONDS };
}

/** Chapters. Keys are load-bearing (URLs, saved views); labels are not. */
const CHAPTERS = [
  { key: 'players', label: 'Search' },
  { key: 'antistrat', label: 'Teams' },
  { key: 'scout', label: 'Players' },
  { key: 'charts', label: 'Charts', icon: sideCharts }
];

/** Format a finite number for leaderboard cells; `digits` = decimal places. */
function fmt(n, digits = 2) {
  return Number.isFinite(n) ? Number(n).toFixed(digits) : '—';
}

/** Elapsed seconds → the round clock counting down from 1:55. */
function clockLeft(elapsed) {
  const left = Math.max(0, SHAPE_WINDOW_MAX_SECONDS - Math.round(elapsed));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** A shape's clock window as words: "1:55 to 1:20", or '' for whole round. */
function windowLabel(shape) {
  if (!shape?.window) return '';
  return `${clockLeft(shape.window.from)} to ${clockLeft(shape.window.to)}`;
}

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
    <div class="an-chapter" data-chapter="players">
      <div class="an-layout">
        <aside class="an-sidebar" id="an-sidebar"></aside>
        <div class="an-main" id="an-main"><p class="view-empty">Select a map to begin.</p></div>
      </div>
    </div>
    <div class="an-chapter" data-chapter="antistrat" hidden></div>
    <div class="an-chapter" data-chapter="scout" hidden></div>
    <div class="an-chapter" data-chapter="charts" hidden></div>`;

  const sidebarEl = el.querySelector('#an-sidebar');
  const mainEl = el.querySelector('#an-main');
  // The chapter tabs live in the page title row, not inside the panel; the
  // slot is cleared on every route change, so load() re-mounts them.
  const chaptersEl = document.createElement('nav');
  chaptersEl.className = 'an-chapters';
  chaptersEl.setAttribute('aria-label', 'Pattern finder chapters');

  function mountChapterNav() {
    document.getElementById('page-head-actions')?.replaceChildren(chaptersEl);
  }

  let chapter = 'players';
  /** @type {ReturnType<typeof createAntistratPanel> | null} */
  let antistrat = null;
  /** @type {ReturnType<typeof createPlayerScoutPanel> | null} */
  let scout = null;
  /** @type {ReturnType<typeof createChartsPanel> | null} */
  let charts = null;

  function chapterEl(key) {
    return el.querySelector(`.an-chapter[data-chapter="${key}"]`);
  }

  function renderChapterNav() {
    // Text only: the underline tab style carries no icons, and the Charts
    // icon in particular was asked off by name.
    chaptersEl.innerHTML = CHAPTERS.map(
      (c) => `<button type="button" class="an-chapter-btn${c.key === chapter ? ' active' : ''}"
        data-an-chapter="${c.key}">${escapeHtml(c.label)}</button>`
    ).join('');
  }

  function shareParams() {
    return Object.fromEntries(new URLSearchParams(window.location.search));
  }

  function applyChapterChrome({ resetShare = false } = {}) {
    for (const c of CHAPTERS) {
      const host = chapterEl(c.key);
      if (host) host.hidden = c.key !== chapter;
    }
    renderChapterNav();

    // Sidebar sub-links and the URL mirror the active chapter.
    document.querySelectorAll('[data-pf-chapter]').forEach((a) => {
      a.classList.toggle('active', a.dataset.pfChapter === chapter);
    });
    if (window.location.pathname.replace(/\/+$/, '') === '/patterns') {
      const params = new URLSearchParams(window.location.search);
      if (resetShare) {
        params.delete('v');
        params.delete('view');
      }
      if (chapter === 'players') params.delete('chapter');
      else params.set('chapter', chapter);
      const q = params.toString();
      window.history.replaceState(
        window.history.state,
        '',
        `/patterns${q ? `?${q}` : ''}`
      );
    }
  }

  function ensureCharts() {
    const host = chapterEl('charts');
    if (!charts && host) {
      charts = createChartsPanel({ escapeHtml });
      host.appendChild(charts.el);
    }
  }

  function ensureAntistrat() {
    const host = chapterEl('antistrat');
    if (!antistrat && host) {
      antistrat = createAntistratPanel({ escapeHtml });
      host.appendChild(antistrat.el);
    }
  }

  function ensureScout() {
    const host = chapterEl('scout');
    if (!scout && host) {
      scout = createPlayerScoutPanel({ escapeHtml });
      host.appendChild(scout.el);
    }
  }

  function loadCharts() {
    ensureCharts();
    charts?.load({ params: shareParams() });
  }

  function setChapter(next) {
    if (!CHAPTERS.some((c) => c.key === next)) return;
    const switching = chapter !== next;
    chapter = next;
    applyChapterChrome({ resetShare: switching });

    if (chapter === 'charts') {
      loadCharts();
      return;
    }
    if (chapter === 'antistrat') {
      // Antistrat fetches for itself. It picks a team and then a map, so its
      // team list has to span the library — handing it Pattern Finder's payload
      // would quietly limit it to whatever map that panel is showing.
      ensureAntistrat();
      // Prefer the shared payload; if it is not ready yet, antistrat self-fetches
      // so a failed / skipped Players spend cannot leave "Loading teams…" forever.
      antistrat?.load();
      return;
    }
    if (chapter === 'scout') {
      // Same reasoning: its player list spans the library, not one map.
      ensureScout();
      scout?.load();
      return;
    }
    if (payload) {
      render();
      mountSavedViews();
    } else if (switching) {
      void load();
    }
  }

  renderChapterNav();
  chaptersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-an-chapter]');
    if (btn) setChapter(btn.dataset.anChapter);
  });

  let payload = null;
  /** Matches `statsCacheGeneration()` when `payload` was taken from the cache. */
  let payloadGeneration = -1;
  /** @type {Array<{id:string,name:string,maps:string[],teamKeys:string[]}>} */
  let players = [];
  /** @type {Array<{key:string,name:string,playerIds:string[],maps:string[]}>} */
  let teams = [];
  /** @type {string[]} */
  let maps = [];
  let loadToken = 0;
  let renderToken = 0;
  let subjectSearch = '';
  let subjectMenuOpen = false;
  /** @type {Map<string, { meta: object|null, ticks: ArrayBuffer|null }>} */
  const tickCache = new Map();

  const state = {
    /** @type {string[]} */
    playerIds: [],
    map: '',
    side: '',
    econ: null,
    oppEcon: null,
    hasAwp: false,
    oppHasAwp: false,
    /** @type {''|'won'|'lost'} */
    result: '',
    /** @type {''|'won'|'lost'} */
    opening: '',
    /** Round-library keys the subject side ran (For). */
    roundOwn: /** @type {string[]} */ ([]),
    /** Round-library keys the opposing side ran (Against). */
    roundOpp: /** @type {string[]} */ ([]),
    /** @type {Set<string>} */
    phases: new Set(),
    /** Utility types included when searching grenades (analyzer util bar). */
    utilityVisible: defaultUtility(),
    /**
     * Map-control drill-down. `controlSide` is the bucket whose teams the
     * leaderboard is showing ('' = the ordinary leaderboard); `controlTeam` is
     * one team inside it, which narrows the rounds list. Both are cleared
     * whenever the search itself changes, because they name a slice of a
     * result that no longer exists.
     */
    controlSide: '',
    controlTeam: '',
    /** Global round-clock window for when the searched thing happens. */
    timeWindow: defaultTimeWindow(),
    rankOwn: '',
    rankOpp: '',
    /** @type {Array<object>} */
    shapes: [],
    /** @type {'all'|'any'|''} */
    shapeMatch: '',
    /** @type {ShapeFeature|''} */
    drawFeature: '',
    /** @type {''|'rect'|'poly'|'lasso'} */
    drawMode: '',
    /** @type {'players'|'teams'} which leaderboard the stats card shows */
    lbMode: 'players'
  };

  /** Shape id whose clock-window slider is open in the sidebar, or ''. */
  let editingWindow = '';

  /** @type {ReturnType<typeof createPresenceRadar> | null} */
  let radar = null;
  /** Survive main re-renders so wheel-zoom is not wiped every aggregate. */
  let radarView = { zoom: 1, panX: 0, panY: 0 };

  function playerById(id) {
    return players.find((p) => p.id === id) || null;
  }

  function subjectLabel() {
    if (!state.playerIds.length) return 'Anyone';
    return state.playerIds
      .map((id) => playerById(id)?.name || id)
      .join(', ');
  }

  function persistShapes() {
    if (!state.map) return;
    saveShapes(state.map, state.shapes);
  }

  // ---- saved views --------------------------------------------------------
  //
  // A pattern query is a finding waiting to be written down. Saving it keeps
  // the map, the subjects, the filters and the drawn shapes together, which is
  // the only form in which any of them mean anything.
  //
  // `phases` is a Set, so it crosses JSON as an array and comes back as a Set.

  const savedViews = createSavedViews({
    page: 'patterns',
    escapeHtml,
    read: () => ({
      playerIds: [...state.playerIds],
      map: state.map,
      side: state.side,
      econ: state.econ,
      oppEcon: state.oppEcon,
      hasAwp: state.hasAwp,
      oppHasAwp: state.oppHasAwp,
      result: state.result,
      opening: state.opening,
      roundOwn: [...state.roundOwn],
      roundOpp: [...state.roundOpp],
      phases: [...state.phases],
      utility: { ...state.utilityVisible },
      timeWindow: sanitizeTimeWindow(state.timeWindow),
      rankOwn: state.rankOwn || '',
      rankOpp: state.rankOpp || '',
      shapes: JSON.parse(JSON.stringify(state.shapes || [])),
      shapeMatch: state.shapeMatch
    }),
    apply(spec) {
      if (!spec || typeof spec !== 'object') return;
      state.playerIds = Array.isArray(spec.playerIds) ? [...spec.playerIds] : [];
      state.map = String(spec.map || '');
      state.side = spec.side === 'T' || spec.side === 'CT' ? spec.side : '';
      state.econ = typeof spec.econ === 'number' ? spec.econ : null;
      state.oppEcon = typeof spec.oppEcon === 'number' ? spec.oppEcon : null;
      state.hasAwp = Boolean(spec.hasAwp);
      state.oppHasAwp = Boolean(spec.oppHasAwp);
      state.result = spec.result === 'won' || spec.result === 'lost' ? spec.result : '';
      state.opening = spec.opening === 'won' || spec.opening === 'lost' ? spec.opening : '';
      state.roundOwn = asRoundKeys(spec.roundOwn);
      state.roundOpp = asRoundKeys(spec.roundOpp);
      state.phases = new Set(Array.isArray(spec.phases) ? spec.phases : []);
      state.utilityVisible = defaultUtility();
      if (spec.utility && typeof spec.utility === 'object') {
        for (const k of UTIL_KEYS) {
          if (typeof spec.utility[k] === 'boolean') state.utilityVisible[k] = spec.utility[k];
        }
      }
      const tw = sanitizeTimeWindow(spec.timeWindow);
      state.timeWindow = tw || defaultTimeWindow();
      state.rankOwn = String(spec.rankOwn || '');
      state.rankOpp = String(spec.rankOpp || '');
      state.shapes = Array.isArray(spec.shapes) ? spec.shapes : [];
      state.shapeMatch = spec.shapeMatch === 'any' ? 'any' : 'all';
      render();
      mountSavedViews();
    }
  });

  /** renderSidebar() rewrites the aside, so the strip is re-attached after it. */
  function mountSavedViews() {
    const slot = el.querySelector('#an-saved');
    if (slot && !slot.contains(savedViews.el)) slot.replaceChildren(savedViews.el);
  }

  function asRoundKeys(raw) {
    if (Array.isArray(raw)) return raw.map((k) => String(k || '').trim()).filter(Boolean);
    const s = String(raw || '').trim();
    return s ? [s] : [];
  }

  function filterObj() {
    return {
      playerIds: [...state.playerIds],
      map: state.map,
      side: state.side === 'T' || state.side === 'CT' ? state.side : '',
      econ: typeof state.econ === 'number' ? state.econ : null,
      oppEcon: typeof state.oppEcon === 'number' ? state.oppEcon : null,
      hasAwp: state.hasAwp,
      oppHasAwp: state.oppHasAwp,
      result: state.result === 'won' || state.result === 'lost' ? state.result : '',
      opening: state.opening === 'won' || state.opening === 'lost' ? state.opening : '',
      roundOwn: [...state.roundOwn],
      roundOpp: [...state.roundOpp],
      phases: state.phases,
      utility: { ...state.utilityVisible },
      timeWindow: sanitizeTimeWindow(state.timeWindow),
      rankOwn: state.rankOwn || '',
      rankOpp: state.rankOpp || '',
      shapes: state.shapes,
      shapeMatch: state.shapeMatch === 'any' ? 'any' : 'all'
    };
  }

  function roundSummaryLabel(rows, selected, emptyLabel) {
    if (!selected.length) return emptyLabel;
    if (selected.length === 1) {
      return rows.find((r) => r.key === selected[0])?.label || selected[0];
    }
    return `${selected.length} selected`;
  }

  /** Round-library multi-select: For = our call, Against = theirs. Needs map + side. */
  function roundSelectHtml(which) {
    const map = state.map;
    const side = state.side === 'T' || state.side === 'CT' ? state.side : '';
    if (!map || !side || !hasRoundLibrary(map)) return '';
    const oppSide = side === 'T' ? 'CT' : 'T';
    const forSide = which === 'opp' ? oppSide : side;
    const selected = which === 'opp' ? state.roundOpp : state.roundOwn;
    const selectedSet = new Set(selected);
    const rows = roundTypeRows(map, forSide);
    if (!rows.length) return '';
    const emptyLabel = which === 'opp' ? 'Against' : 'For';
    const ariaLabel = which === 'opp' ? 'Round against' : 'Round for';
    const field = which === 'opp' ? 'roundOpp' : 'roundOwn';
    const summary = roundSummaryLabel(rows, selected, emptyLabel);
    const checks = [
      `<label class="st-round-opt">
        <input type="checkbox" data-an-round="${field}" value="" ${
          selected.length ? '' : 'checked'
        } />
        <span>${escapeHtml(emptyLabel)}</span>
      </label>`,
      ...rows.map(
        (r) => `<label class="st-round-opt" title="${escapeHtml(r.desc || '')}">
          <input type="checkbox" data-an-round="${field}" value="${escapeHtml(r.key)}" ${
            selectedSet.has(r.key) ? 'checked' : ''
          } />
          <span>${escapeHtml(r.label)}</span>
        </label>`
      )
    ].join('');
    return `<div class="an-field">
      <details class="st-round-multi an-round-multi" data-an-round-menu="${field}">
        <summary class="site-select an-select st-round-select" aria-label="${escapeHtml(
          ariaLabel
        )}">${mbSummary('menu', escapeHtml(summary))}</summary>
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
    for (const d of sidebarEl.querySelectorAll('details.an-round-multi[open], details.st-rank-dd[open]')) {
      if (except && d === except) continue;
      d.removeAttribute('open');
    }
  }

  function featureLabel(key) {
    return SHAPE_FEATURES.find((f) => f.key === key)?.label || key;
  }

  /**
   * What a drawn selection is called in the list.
   *
   * A grenade selection carries the utility types it was drawn with, so it
   * says which — "Smoke in rect 1", "Molotov + HE in rect 2" — rather than the
   * generic "Grenade in", which was the only honest name back when all of them
   * read the same global switches.
   */
  function shapeLabel(s, i) {
    const keys = s.feature === 'grenade_in' ? shapeUtilityKeys(s) : null;
    const what = keys
      ? `${keys.map((k) => UTIL_ICONS.find((u) => u.key === k)?.label || k).join(' + ')} in`
      : featureLabel(s.feature);
    return `${what} ${s.geometry?.type === 'poly' ? 'poly' : 'rect'} ${i + 1}`;
  }

  function slotsLeft() {
    return Math.max(0, ANALYTICS_PLAYER_MAX - state.playerIds.length);
  }

  function addPlayers(ids) {
    const next = [...state.playerIds];
    for (const id of ids) {
      if (!id || next.includes(id)) continue;
      if (next.length >= ANALYTICS_PLAYER_MAX) break;
      next.push(id);
    }
    state.playerIds = next;
  }

  function removePlayer(id) {
    state.playerIds = state.playerIds.filter((x) => x !== id);
  }

  /** @returns {{ kind: 'team'|'player', key: string, label: string, sub?: string, ids: string[] }[]} */
  function subjectSuggestions() {
    const q = subjectSearch.trim().toLowerCase();
    const selected = new Set(state.playerIds);
    const left = slotsLeft();
    /** @type {{ kind: 'team'|'player', key: string, label: string, sub?: string, ids: string[] }[]} */
    const out = [];

    if (!left) return out;

    const teamHits = teams
      .filter((t) => {
        if (!q) return true;
        return t.name.toLowerCase().includes(q) || t.key.includes(q);
      })
      .filter((t) => t.playerIds.some((id) => !selected.has(id)))
      .slice(0, q ? 8 : 12);

    for (const t of teamHits) {
      const fresh = t.playerIds.filter((id) => !selected.has(id));
      const take = fresh.slice(0, left);
      out.push({
        kind: 'team',
        key: t.key,
        label: t.name,
        sub: `${take.length} of ${t.playerIds.length} players`,
        ids: take
      });
    }

    if (q.length >= 1) {
      const playerHits = players
        .filter((p) => !selected.has(p.id))
        .filter(
          (p) =>
            p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
        )
        .slice(0, 20);
      for (const p of playerHits) {
        out.push({
          kind: 'player',
          key: p.id,
          label: p.name,
          sub: p.teamKeys?.length ? `Player` : 'Player',
          ids: [p.id]
        });
      }
    }

    return out;
  }

  function econSelect(id, value, placeholder = 'Any') {
    const blank = value === null || value === undefined || value === '';
    const isAny = value === 'any';
    const opts = Object.entries(ECONOMIES)
      .map(
        ([code, e]) =>
          `<option value="${code}"${Number(code) === value ? ' selected' : ''}>${escapeHtml(
            e.label || economyLabel(Number(code))
          )}</option>`
      )
      .join('');
    return `<select class="site-select an-select" data-an-econ="${id}">
      <option value=""${blank ? ' selected' : ''}>${escapeHtml(placeholder)}</option>
      <option value="any"${isAny ? ' selected' : ''}>Any</option>${opts}</select>`;
  }

  function awpCheck(id, checked) {
    return `<label class="rp-awp-toggle an-awp${checked ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" data-an-awp="${id}" ${checked ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  /**
   * @param {string} attr  e.g. data-an-side
   * @param {{ key: string, label: string }[]} options
   * @param {string} value
   * @param {{ placeholder?: string | null }} [opts]
   */
  function menuSelect(attr, options, value, { placeholder = 'Any' } = {}) {
    const head =
      placeholder === null
        ? ''
        : `<option value=""${!value ? ' selected' : ''}>${escapeHtml(placeholder)}</option>`;
    const body = options
      .map(
        (o) =>
          `<option value="${escapeHtml(o.key)}"${String(o.key) === String(value) ? ' selected' : ''}>${escapeHtml(
            o.label
          )}</option>`
      )
      .join('');
    return `<select class="site-select an-select" ${attr}>${head}${body}</select>`;
  }

  function phaseSelectValue() {
    if (state.phases.size === 1) return [...state.phases][0];
    return '';
  }

  function refreshSubjectMenu() {
    const menu = sidebarEl.querySelector('#an-subject-menu');
    if (!menu) return;
    const opts = subjectSuggestions();
    const q = subjectSearch.trim();
    const show = subjectMenuOpen && (opts.length || q.length >= 1 || !state.playerIds.length);
    menu.hidden = !show;

    if (!opts.length) {
      menu.innerHTML = `<p class="rp-typeahead-empty">${
        !slotsLeft()
          ? `Limit ${ANALYTICS_PLAYER_MAX} players`
          : q
            ? 'No matches'
            : 'Type a player name, or pick a team'
      }</p>`;
      return;
    }

    const teamsHtml = opts
      .filter((o) => o.kind === 'team')
      .map(
        (o) => `<button type="button" class="an-suggest" data-pick-ids="${escapeHtml(
          o.ids.join(',')
        )}">
          <span class="an-suggest-kind">Team</span>
          <span class="an-suggest-main">
            <strong>${escapeHtml(o.label)}</strong>
            <span class="an-muted">${escapeHtml(o.sub || '')}</span>
          </span>
        </button>`
      )
      .join('');

    const playersHtml = opts
      .filter((o) => o.kind === 'player')
      .map(
        (o) => `<button type="button" class="an-suggest" data-pick-ids="${escapeHtml(
          o.ids.join(',')
        )}">
          <span class="an-suggest-kind">Player</span>
          <span class="an-suggest-main">
            <strong>${escapeHtml(o.label)}</strong>
          </span>
        </button>`
      )
      .join('');

    menu.innerHTML = `
      ${teamsHtml ? `<div class="an-suggest-group"><span class="an-suggest-group-label">Teams</span>${teamsHtml}</div>` : ''}
      ${playersHtml ? `<div class="an-suggest-group"><span class="an-suggest-group-label">Players</span>${playersHtml}</div>` : ''}`;
  }

  function renderSidebar() {
    const ready = Boolean(state.map);
    const left = slotsLeft();

    sidebarEl.classList.toggle('an-sidebar--pick', !state.map);
    sidebarEl.innerHTML = `
      <div class="an-field an-saved" id="an-saved"></div>
      <div class="an-field">
        ${mbWrap(
          'map',
          `<select class="site-select an-select" id="an-map" aria-label="Map">
          <option value="">Map</option>
          ${maps
            .map(
              (m) =>
                `<option value="${escapeHtml(m)}"${m === state.map ? ' selected' : ''}>${escapeHtml(
                  MAPS[m]?.name || m
                )}</option>`
            )
            .join('')}
        </select>`
        )}
      </div>

      <div class="an-field">
        ${rankFilterHtml({
          own: state.rankOwn,
          opp: state.rankOpp,
          summaryClass: 'site-select an-select st-rank-summary'
        })}
      </div>

      <div class="an-field">
        <div class="an-subject" id="an-subject-typeahead">
          ${
            state.playerIds.length
              ? `<div class="an-sel-chips">
                  ${state.playerIds
                    .map((id) => {
                      const name = playerById(id)?.name || id;
                      return `<button type="button" class="an-sel-chip" data-remove-player="${escapeHtml(
                        id
                      )}" title="Remove">${escapeHtml(name)} <span aria-hidden="true">×</span></button>`;
                    })
                    .join('')}
                </div>`
              : `<p class="an-anyone">Everyone</p>`
          }
          ${
            left
              ? `${mbWrap(
                  'search',
                  `<input type="search" class="site-input" id="an-subject-search"
                  placeholder="Search teams or players…" spellcheck="false" autocomplete="off"
                  value="${escapeHtml(subjectSearch)}" aria-label="Search teams or players" />`
                )}
                <div class="rp-typeahead-menu an-subject-menu" id="an-subject-menu" hidden></div>`
              : ''
          }
        </div>
      </div>

      <div class="an-side-block" ${ready ? '' : 'hidden'}>
        <div class="an-field">
          ${menuSelect(
            'data-an-side',
            [
              { key: 'any', label: 'Any' },
              { key: 'T', label: 'T' },
              { key: 'CT', label: 'CT' }
            ],
            state.side,
            { placeholder: 'Side' }
          )}
        </div>
        ${roundSelectHtml('own')}
        ${roundSelectHtml('opp')}
        <div class="an-field">
          ${menuSelect(
            'data-an-result',
            [
              { key: 'any', label: 'Any' },
              { key: 'won', label: 'Won' },
              { key: 'lost', label: 'Lost' }
            ],
            state.result,
            { placeholder: 'Result' }
          )}
        </div>
        <div class="an-field">
          ${menuSelect(
            'data-an-opening',
            [
              { key: 'any', label: 'Any' },
              { key: 'won', label: '5v4' },
              { key: 'lost', label: '4v5' }
            ],
            state.opening,
            { placeholder: 'Opening' }
          )}
        </div>
        <div class="an-field">
          <div class="an-buy-controls">
            ${econSelect('econ', state.econ, "Team's buy")}
            ${awpCheck('hasAwp', state.hasAwp)}
          </div>
        </div>
        <div class="an-field">
          <div class="an-buy-controls">
            ${econSelect('oppEcon', state.oppEcon, "Enemy's buy")}
            ${awpCheck('oppHasAwp', state.oppHasAwp)}
          </div>
        </div>
        <div class="an-field">
          ${menuSelect(
            'data-an-phase',
            [{ key: 'any', label: 'Any' }, ...PHASE_OPTS],
            phaseSelectValue(),
            { placeholder: 'Phase' }
          )}
        </div>
        <div class="an-field an-time-window">
          <div id="an-time-range"></div>
          <p class="rv-az-nade-read" id="an-time-read"></p>
        </div>
        <div class="an-field">
          <div class="rv-az-util-bar" role="group" aria-label="Utility">
            ${UTIL_ICONS.map(
              (u) => `
            <button type="button" class="rv-az-util-btn${
              state.utilityVisible[u.key] ? ' active' : ''
            }" data-an-util="${u.key}" title="${u.title}" aria-pressed="${
                state.utilityVisible[u.key] ? 'true' : 'false'
              }">${iconImgHtml(u.weapon, 'rv-az-util-icon')}</button>`
            ).join('')}
          </div>
        </div>

        <p class="an-side-title">Map selections</p>
        <div class="an-field">
          ${menuSelect(
            'data-an-feature',
            [{ key: 'any', label: 'Any' }, ...SHAPE_FEATURES.map((f) => ({ key: f.key, label: f.label }))],
            state.drawFeature,
            { placeholder: 'Feature' }
          )}
        </div>
        <div class="an-field">
          ${menuSelect(
            'data-an-match',
            [
              { key: 'any', label: 'Any' },
              { key: 'all', label: 'All' }
            ],
            state.shapeMatch,
            { placeholder: 'Match' }
          )}
        </div>
        <div class="an-field">
          <div class="an-buy-controls">
            ${menuSelect(
              'data-an-draw',
              [
                { key: 'any', label: 'Any' },
                { key: 'rect', label: 'Rectangle' },
                { key: 'poly', label: 'Polygon' },
                { key: 'lasso', label: 'Lasso' }
              ],
              state.drawMode,
              { placeholder: 'Draw' }
            )}
            ${
              state.drawMode === 'poly'
                ? `<button type="button" class="btn btn-sm" data-an-poly-done>Finish</button>`
                : ''
            }
          </div>
        </div>
        <div class="an-shape-list">
          ${
            state.shapes.length
              ? state.shapes
                  .map((s, i) => {
                    const label = s.name || shapeLabel(s, i);
                    const win = windowLabel(s);
                    const editing = editingWindow === s.id;
                    return `<div class="an-shape-row${s.enabled === false ? ' off' : ''}">
                      <button type="button" class="an-shape-toggle" data-shape-toggle="${escapeHtml(
                        s.id
                      )}" title="Toggle">
                        ${s.enabled === false ? '○' : '●'} ${escapeHtml(label)}
                      </button>
                      <button type="button" class="an-shape-clock${win ? ' set' : ''}" data-shape-clock="${escapeHtml(
                        s.id
                      )}" title="${win ? `Only between ${escapeHtml(win)} on the round clock` : 'Limit this rule to a stretch of the round clock'}">${
                        win ? escapeHtml(win) : '🕒'
                      }</button>
                      <button type="button" class="an-shape-del" data-shape-del="${escapeHtml(
                        s.id
                      )}" aria-label="Remove">×</button>
                    </div>${
                      editing
                        ? `<div class="an-shape-window" data-shape-window="${escapeHtml(s.id)}">
                            <div class="an-shape-window-slider"></div>
                            <div class="an-shape-window-row">
                              <span class="an-shape-window-label"></span>
                              <button type="button" class="btn btn-sm" data-shape-window-clear="${escapeHtml(
                                s.id
                              )}">Whole round</button>
                            </div>
                          </div>`
                        : ''
                    }`;
                  })
                  .join('')
              : `<p class="an-muted an-shape-empty">No selections yet. Every drawn selection is its own rule; give each one a feature and, with the clock button, its own stretch of the round.</p>`
          }
        </div>

        <button type="button" class="btn btn-sm an-clear" data-an-clear>Clear filters</button>
      </div>

      <div class="an-side-rounds" id="an-side-rounds" ${ready ? '' : 'hidden'}></div>`;

    if (subjectMenuOpen || subjectSearch) refreshSubjectMenu();
    mountWindowSlider();
    mountTimeRange();
  }

  function paintTimeRead() {
    const read = sidebarEl.querySelector('#an-time-read');
    if (!read) return;
    const { from, to } = state.timeWindow;
    read.textContent =
      from <= 0 && to >= SHAPE_WINDOW_MAX_SECONDS
        ? 'Whole round'
        : `${clockLeft(from)} to ${clockLeft(to)}`;
  }

  /** Global two-notch round clock (analyzer grenade viewer style). */
  function mountTimeRange() {
    const slot = sidebarEl.querySelector('#an-time-range');
    if (!slot) return;
    const slider = createRangeSlider({
      min: 0,
      max: SHAPE_WINDOW_MAX_SECONDS,
      from: state.timeWindow.from,
      to: state.timeWindow.to,
      step: 1,
      label: 'Point in the round',
      onChange: (from, to) => {
        state.timeWindow = { from, to };
        paintTimeRead();
        scheduleWindowRerender();
      }
    });
    slot.replaceChildren(slider.el);
    paintTimeRead();
  }

  /**
   * The window a freshly drawn control selection gets: the global clock window
   * when it is already short enough to be a moment, otherwise its last twenty
   * seconds, otherwise the 1:20–1:00 stretch most calls are judged on.
   */
  function defaultControlWindow() {
    const g = sanitizeTimeWindow(state.timeWindow);
    if (g && g.to - g.from <= MAP_CONTROL_MAX_SECONDS) return { from: g.from, to: g.to };
    if (g) return { from: g.to - MAP_CONTROL_MAX_SECONDS, to: g.to };
    const to = SHAPE_WINDOW_MAX_SECONDS - 60;
    return { from: to - MAP_CONTROL_MAX_SECONDS, to };
  }

  /** Mount the two-handle clock slider for the shape being edited, if any. */
  function mountWindowSlider() {
    const host = sidebarEl.querySelector('.an-shape-window');
    if (!host) return;
    const shape = state.shapes.find((s) => s.id === host.dataset.shapeWindow);
    const slot = host.querySelector('.an-shape-window-slider');
    const label = host.querySelector('.an-shape-window-label');
    if (!shape || !slot) return;
    const paintLabel = (from, to) => {
      if (label) label.textContent = `${clockLeft(from)} to ${clockLeft(to)}`;
    };
    /** Which handle moved, deduced by comparing against the last report. */
    let lastSpan = {
      from: shape.window?.from ?? 0,
      to: shape.window?.to ?? SHAPE_WINDOW_MAX_SECONDS
    };
    const slider = createRangeSlider({
      min: 0,
      max: SHAPE_WINDOW_MAX_SECONDS,
      from: shape.window?.from ?? 0,
      to: shape.window?.to ?? SHAPE_WINDOW_MAX_SECONDS,
      step: 1,
      label: 'Round clock window',
      onChange: (from, to) => {
        // A control selection may not span more than twenty seconds: the
        // handles are held apart rather than allowed into a state the search
        // then refuses. The handle that moved keeps its place; the other is
        // pulled along.
        if (shape.feature === 'map_control' && to - from > MAP_CONTROL_MAX_SECONDS) {
          if (from !== lastSpan.from) to = from + MAP_CONTROL_MAX_SECONDS;
          else from = to - MAP_CONTROL_MAX_SECONDS;
          from = Math.max(0, from);
          to = Math.min(SHAPE_WINDOW_MAX_SECONDS, to);
          slider.set(from, to);
        }
        lastSpan = { from, to };
        paintLabel(from, to);
        // Full span means "no window": the stored shape stays clean and the
        // chip goes back to the plain clock. Control always keeps one.
        if (shape.feature !== 'map_control' && from <= 0 && to >= SHAPE_WINDOW_MAX_SECONDS) {
          delete shape.window;
        } else {
          shape.window = { from, to };
        }
        persistShapes();
        scheduleWindowRerender();
      }
    });
    slot.replaceChildren(slider.el);
    paintLabel(shape.window?.from ?? 0, shape.window?.to ?? SHAPE_WINDOW_MAX_SECONDS);
  }

  /** Re-run the search a beat after the slider stops moving, not per pixel. */
  let windowRerenderTimer = 0;
  function scheduleWindowRerender() {
    clearTimeout(windowRerenderTimer);
    windowRerenderTimer = setTimeout(() => {
      renderMain();
      savedViews.touch();
    }, 350);
  }

  function renderRadarCard() {
    return `<section class="an-card an-breakdown">
      <header class="an-card-head an-break-head">
        <h3 class="an-section-title">Map selections</h3>
        <span class="an-radar-hint">Scroll to zoom · drag to pan · double-click to reset</span>
      </header>
      <div class="an-break-body">
        <div class="an-radar-wrap" id="an-radar-wrap">
          <canvas class="an-radar" id="an-radar" aria-label="Selection radar"></canvas>
        </div>
      </div>
    </section>`;
  }

  /** The Players | Teams switch in the statistics card head. */
  function lbModeSwitchHtml() {
    const btn = (key, label, icon) =>
      `<button type="button" class="seg-tab${
        state.lbMode === key ? ' active' : ''
      }" data-an-lb-mode="${key}">${mbIcon(icon)}${label}</button>`;
    return `<div class="st-tabs an-lb-tabs">${btn('players', 'Players', 'player')}${btn(
      'teams',
      'Teams',
      'team'
    )}</div>`;
  }

  /**
   * The whole leaderboard, not a window onto it.
   *
   * Both tables used to be sliced to the first 40 rows. There was no marker of
   * any kind — the table simply stopped, inside a scroller, which reads as the
   * end of the data rather than the end of the page. On a library with
   * thousands of players that is the top 40 by rating being presented as the
   * league. The card scrolls; the rows are the answer to the search; show them.
   */
  function renderLeaderboard(rows, teamRows, focusIds, roundCount) {
    const n = state.lbMode === 'teams' ? teamRows.length : rows.length;
    const what = state.lbMode === 'teams' ? 'team' : 'player';
    const head = `<header class="an-card-head an-lb-head">
        <h3 class="an-section-title">Statistics <small>${roundCount.toLocaleString()} rounds${
          n ? ` · ${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}` : ''
        }</small></h3>
        ${lbModeSwitchHtml()}
      </header>`;

    if (state.lbMode === 'teams') {
      if (!teamRows.length) {
        return `<section class="an-card an-lb">${head}<p class="view-empty">No teams on matching rounds.</p></section>`;
      }
      return `<section class="an-card an-lb">
        ${head}
        <div class="an-lb-scroll">
          <table class="an-lb-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>R</th>
                <th>W</th>
                <th>Round WR</th>
                <th>Avg rating</th>
              </tr>
            </thead>
            <tbody>
              ${teamRows
                .map(
                  (t, i) => `<tr class="an-lb-row">
                    <td>${i + 1}</td>
                    <td class="an-lb-name">${escapeHtml(t.name || t.key)}</td>
                    <td>${t.rounds}</td>
                    <td>${t.roundsWon}</td>
                    <td>${fmt(t.roundWinrate, 1)}%</td>
                    <td>${fmt(t.avgRating)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>`;
    }

    if (!rows.length) {
      return `<section class="an-card an-lb">${head}<p class="view-empty">No players on matching rounds.</p></section>`;
    }
    const focus = new Set(focusIds || []);
    return `<section class="an-card an-lb">
      ${head}
      <div class="an-lb-scroll">
        <table class="an-lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>R</th>
              <th>Rating</th>
              <th>K/D</th>
              <th>ADR</th>
              <th>KAST</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((p, i) => {
                const on = focus.has(p.id) ? ' focus' : '';
                return `<tr class="an-lb-row${on}">
                  <td>${i + 1}</td>
                  <td class="an-lb-name">${escapeHtml(p.name || p.id)}</td>
                  <td>${p.rounds}</td>
                  <td>${fmt(p.rating)}</td>
                  <td>${fmt(p.kd)}</td>
                  <td>${fmt(p.adr, 1)}</td>
                  <td>${fmt(p.kast, 1)}%</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  /**
   * @param {object} agg
   * @param {Set<string>|null} [only]  map-control drill-down, when one is open
   */
  function renderRounds(agg, only = null) {
    /** @type {Map<string, { file: string, demoId: string, round: number, phases: Set<string> }>} */
    const byFile = new Map();
    if (agg.windows?.length) {
      for (const w of agg.windows) {
        if (only && !only.has(w.file)) continue;
        let g = byFile.get(w.file);
        if (!g) {
          g = { file: w.file, demoId: w.demoId, round: w.round, phases: new Set() };
          byFile.set(w.file, g);
        }
        g.phases.add(w.phase);
      }
    } else {
      for (const file of agg.files || []) {
        if (only && !only.has(file)) continue;
        byFile.set(file, { file, demoId: '', round: 0, phases: new Set() });
      }
      // Enrich round numbers from payload when anyone-mode has no windows.
      if (payload) {
        for (const demo of payload.demos || []) {
          for (const row of demo.rounds || []) {
            const g = byFile.get(row.f);
            if (!g) continue;
            g.demoId = row.d;
            g.round = row.n;
          }
        }
      }
    }
    const list = [...byFile.values()].sort(
      (a, b) => (b.round || 0) - (a.round || 0) || a.file.localeCompare(b.file)
    );
    if (!list.length) {
      return `<section class="an-card"><p class="view-empty">No rounds to play.</p></section>`;
    }
    return `<section class="an-card an-rounds">
      <header class="an-card-head">
        <h3 class="an-section-title">Rounds <small>${list.length}</small></h3>
        <button type="button" class="btn primary btn-sm" id="an-play-all">Play in Timeline</button>
      </header>
      <ul class="an-round-list">
        ${list
          .map((r) => {
            const phases = [...r.phases];
            const label = r.round
              ? `R${r.round}${phases.length ? ` · ${phases.join(', ')}` : ''}`
              : r.file;
            return `<li class="an-round-row">
                <span class="an-round-label">${escapeHtml(label)}</span>
                <button type="button" class="btn btn-sm" data-an-play="${escapeHtml(
                  r.file
                )}">Play</button>
              </li>`;
          })
          .join('')}
      </ul>
    </section>`;
  }

  function rememberRadarView() {
    if (radar?.getView) radarView = radar.getView();
  }

  function ensureRadar() {
    const canvas = mainEl.querySelector('#an-radar');
    const wrap = mainEl.querySelector('#an-radar-wrap');
    if (!canvas) {
      rememberRadarView();
      radar?.destroy();
      radar = null;
      return null;
    }
    if (!radar || radar._canvas !== canvas) {
      rememberRadarView();
      radar?.destroy();
      radar = createPresenceRadar({
        canvas,
        wrap,
        onShapeComplete: (geometry) => {
          rememberRadarView();
          const feature =
            state.drawFeature && state.drawFeature !== 'any' ? state.drawFeature : 'player_in';
          state.shapes.push({
            id: newShapeId(),
            map: state.map,
            name: '',
            feature,
            geometry,
            // The utility buttons are what you arm the next selection with, not
            // a global switch every grenade selection re-reads at search time.
            // Taking the copy here is what lets "molotov in A, smoke in B" be
            // one search instead of two contradictory ones.
            ...(feature === 'grenade_in' ? { utility: { ...state.utilityVisible } } : {}),
            // Control has to be asked about a moment, so it is born with one
            // rather than drawn and then rejected. The global clock if it is
            // already short enough, otherwise its last 20 seconds.
            ...(feature === 'map_control' ? { window: defaultControlWindow() } : {}),
            enabled: true
          });
          persistShapes();
          render();
        },
        // What the canvas needs from the panel to make a selection editable in
        // place: its name, and somewhere to put the two edits.
        shapeLabel: (s, i) => {
          const base = s.name || shapeLabel(s, i);
          const win = windowLabel(s);
          const head = win ? `${base} · ${win}` : base;
          // A control selection reads out its answer where the question was
          // asked: hover the ground and see what holding it is worth.
          const sum = s.feature === 'map_control' ? lastResults?.controlSummary : null;
          if (!sum) return head;
          const line = (side) => ({
            text: sum[side].rounds
              ? `${side} control: ${fmt(sum[side].winrate, 1)}% winrate (${sum[
                  side
                ].rounds.toLocaleString()} rounds)`
              : `${side} control: no rounds`,
            color: sideColor(side)
          });
          return [{ text: head }, line('T'), line('CT')];
        },
        onShapeEdit: (id, geometry) => {
          const s = state.shapes.find((x) => x.id === id);
          if (!s) return;
          s.geometry = geometry;
          rememberRadarView();
          persistShapes();
          // A reshaped selection is a different question, so the search re-runs
          // — once, on pointer-up, not per pixel of the drag.
          render();
        },
        onShapeDelete: (id) => {
          if (editingWindow === id) editingWindow = '';
          state.shapes = state.shapes.filter((x) => x.id !== id);
          rememberRadarView();
          persistShapes();
          render();
        }
      });
      radar._canvas = canvas;
      radar.setView?.(radarView);
    }
    return radar;
  }

  function paintRadar() {
    const ctl = ensureRadar();
    if (!ctl || !state.map) return;
    ctl.setData(state.map, state.shapes, state.drawMode).catch(() => {});
  }

  /**
   * The side colours, read off the stylesheet rather than restated here: T red
   * and CT blue are already what the killfeed, the duel feed and the round list
   * use, and a second copy in JS is a second thing to forget to change.
   */
  function sideColor(side) {
    const name = side === 'CT' ? '--rv-ct' : '--rv-t';
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || (side === 'CT' ? '#5b9fd4' : '#e60611');
  }

  // ---- map control ---------------------------------------------------------
  //
  // Possession needs two things the rest of the finder does not: the map's zone
  // network and its radar image, from which the walkable cell lattice is baked.
  // Both are per-map and cached, so a search pays for them once.

  /** @type {object | null} */
  let controlNetwork = null;
  let controlNetworkMap = '';
  /** @type {Promise<object|null> | null} */
  let controlNetworkLoad = null;

  async function ensureControlField(map) {
    if (!map) return null;
    if (controlNetworkMap === map && controlNetworkLoad) return controlNetworkLoad;
    controlNetworkMap = map;
    controlNetwork = null;
    controlNetworkLoad = (async () => {
      try {
        const [network, image] = await Promise.all([fetchZones(map), loadRadar(map)]);
        prepareControlField(network, map, image);
        controlNetwork = hasControlField(network) ? network : null;
      } catch {
        controlNetwork = null;
      }
      return controlNetwork;
    })();
    return controlNetworkLoad;
  }

  /**
   * What each enabled control selection asks, ready to run per round: the cells
   * it covers and the stretch of clock it covers them over.
   *
   * With more than one, a side has to hold ALL of them to count as holding the
   * ground — "T control" of two boxes means the Ts had both, which is the only
   * reading under which the win rate beside it means anything.
   */
  function controlPlanFor(network, shapes) {
    const geom = network?._fieldGeom;
    if (!geom) return [];
    return controlShapes(shapes)
      .map((shape) => ({
        shape,
        window: controlWindow(shape),
        cells: cellsInShape(geom, shape.geometry)
      }))
      .filter((p) => p.window && p.cells.length);
  }

  /** The side holding every selection in the plan, for one round. */
  function controlSideForPack(plan, network, pack) {
    if (!pack?.meta || !pack?.ticks) return '';
    let track;
    try {
      track = new TickTrack(pack.ticks);
    } catch {
      return '';
    }
    let side = '';
    for (const p of plan) {
      const got = controlOfCells({
        meta: pack.meta,
        track,
        network,
        cells: p.cells,
        window: p.window
      });
      if (!got.side) return '';
      if (!side) side = got.side;
      else if (side !== got.side) return '';
    }
    return side;
  }

  /** Round rows for a set of files, and the demo each one came from. */
  function rowsForFiles(files) {
    const want = new Set(files || []);
    const rows = new Map();
    const demos = new Map();
    for (const demo of payload?.demos || []) {
      for (const row of demo.rounds || []) {
        if (!row?.f || !want.has(row.f) || rows.has(row.f)) continue;
        rows.set(row.f, row);
        demos.set(row.f, demo);
      }
    }
    return { rows, demos };
  }

  /**
   * The control read-out: how the matched rounds split by who held the ground,
   * and what each side's win rate was while holding it.
   *
   * Both rows are buttons. Reading "Ts win 60% here" is the first question;
   * "which teams" is always the second, and it is one click rather than a new
   * search.
   */
  function renderControlCard() {
    const res = lastResults;
    const sum = res?.controlSummary;
    if (!sum) return '';
    const plan = res.controlPlan || [];
    const names = plan
      .map((pl) => {
        const i = state.shapes.indexOf(pl.shape);
        const win = windowLabel(pl.shape);
        return `${pl.shape.name || shapeLabel(pl.shape, i)}${win ? ` · ${win}` : ''}`;
      })
      .join(' + ');

    const row = (side) => {
      const b = sum[side];
      const on = state.controlSide === side;
      const pct = b.rounds ? `${fmt(b.winrate, 1)}%` : '—';
      return `<button type="button" class="an-ctl-row${on ? ' active' : ''}" data-an-ctl-side="${side}"${
        b.rounds ? '' : ' disabled'
      }>
        <span class="an-ctl-side">${side} control</span>
        <span class="an-ctl-pct">${pct}</span>
        <span class="an-ctl-sub">${b.wins.toLocaleString()} of ${b.rounds.toLocaleString()} rounds won</span>
      </button>`;
    };

    return `<section class="an-card an-ctl">
      <header class="an-card-head">
        <h3 class="an-section-title">Map control <small>${escapeHtml(names)}</small></h3>
        ${
          state.controlSide
            ? `<button type="button" class="btn btn-sm" data-an-ctl-side="">Clear</button>`
            : ''
        }
      </header>
      <div class="an-ctl-rows">${row('T')}${row('CT')}</div>
      <p class="an-muted an-ctl-foot">${
        sum.neither
          ? `${sum.neither.toLocaleString()} of ${sum.total.toLocaleString()} rounds went to neither side.`
          : `${sum.total.toLocaleString()} rounds.`
      } Win rate is the holding side's own.</p>
    </section>`;
  }

  /**
   * Teams inside one control bucket. Players are not offered: the question
   * "who wins when they hold this" is about a side, and a side is a team.
   */
  function renderControlTeams() {
    const res = lastResults;
    const rows = res?.controlTeams || [];
    const side = state.controlSide;
    const head = `<header class="an-card-head an-lb-head">
        <h3 class="an-section-title">Teams holding it as <span class="an-ctl-side" style="--ctl: ${
          side === 'CT' ? 'var(--rv-ct)' : 'var(--rv-t)'
        }">${escapeHtml(side)}</span>
          <small>${rows.length.toLocaleString()} team${rows.length === 1 ? '' : 's'}</small></h3>
      </header>`;
    if (!rows.length) {
      return `<section class="an-card an-lb">${head}<p class="view-empty">No teams held it on that side.</p></section>`;
    }
    return `<section class="an-card an-lb">
      ${head}
      <div class="an-lb-scroll">
        <table class="an-lb-table">
          <thead>
            <tr><th>#</th><th>Team</th><th>R</th><th>W</th><th>Round WR</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (t, i) => `<tr class="an-lb-row an-ctl-team${
                  state.controlTeam === t.key ? ' focus' : ''
                }" data-an-ctl-team="${escapeHtml(t.key)}">
                  <td>${i + 1}</td>
                  <td class="an-lb-name">${escapeHtml(t.name)}</td>
                  <td>${t.rounds}</td>
                  <td>${t.wins}</td>
                  <td>${fmt(t.winrate, 1)}%</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  /** Files the rounds list should show once a control bucket is open. */
  function controlOnlyFiles() {
    const res = lastResults;
    if (!res?.control || !state.controlSide) return null;
    if (state.controlTeam) {
      const team = (res.controlTeams || []).find((t) => t.key === state.controlTeam);
      return new Set(team?.files || []);
    }
    const out = new Set();
    for (const [file, side] of res.control) {
      if (side === state.controlSide) out.add(file);
    }
    return out;
  }

  /** Last computed results, so the Players | Teams switch repaints for free. */
  let lastResults = null;

  function sideRoundsEl() {
    return sidebarEl.querySelector('#an-side-rounds');
  }

  /** Paint the right card and the rounds list under the left filters. */
  function paintResults() {
    if (!lastResults) return;
    const { agg, lb, teamLb, roundCount, needsPh, lbError, controlNote } = lastResults;
    // The team table for the open bucket, recomputed here rather than in the
    // search: picking a side is a question about a result already in hand.
    lastResults.controlTeams = state.controlSide
      ? controlTeamRows(
          lastResults.control,
          lastResults.controlRows,
          lastResults.controlDemos,
          state.controlSide
        )
      : [];
    rememberRadarView();
    mainEl.innerHTML = `
      ${
        needsPh
          ? `<p class="an-warn">Some rounds are still building phase data. Refresh shortly if numbers look incomplete.</p>`
          : ''
      }
      ${lbError ? `<p class="an-warn">Could not build the leaderboard: ${escapeHtml(lbError)}</p>` : ''}
      ${controlNote ? `<p class="an-warn">${escapeHtml(controlNote)}</p>` : ''}
      ${renderRadarCard()}
      ${renderControlCard()}
      ${
        state.controlSide
          ? renderControlTeams()
          : renderLeaderboard(lb, teamLb, state.playerIds, roundCount)
      }`;
    const slot = sideRoundsEl();
    if (slot) slot.innerHTML = renderRounds(agg, controlOnlyFiles());
    paintRadar();
  }

  /**
   * What the antistrat chapter reads: round tags and the round's own identity.
   *
   * Its own contract rather than the Pattern Finder's, because the two used to
   * share `patterns` and no longer want the same thing — antistratScan.js reads
   * `row.rl` and the baseline fields, and the finder does not fetch `rl` at all
   * any more.
   */
  const ANTISTRAT_COLUMNS = 'shapes';

  /** Write the in-progress line, if this render is still the current one. */
  function setMatchingLabel(token, text) {
    if (token !== renderToken) return;
    const el = mainEl.querySelector('#an-matching');
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
  }

  async function renderMain() {
    if (!state.map) {
      rememberRadarView();
      lastResults = null;
      mainEl.innerHTML = `<p class="view-empty">Select a map in the sidebar. Subjects are optional — leave empty to search anyone.</p>`;
      return;
    }
    if (!payload) {
      rememberRadarView();
      mainEl.innerHTML = spinnerHtml('Loading rounds…');
      return;
    }
    const token = ++renderToken;
    // A drill-down names a slice of a result that is about to be replaced.
    state.controlSide = '';
    state.controlTeam = '';
    const hasShapes = state.shapes.some((s) => s.enabled !== false);
    // Always replace the empty-map prompt as soon as a map is chosen; otherwise
    // it sticks around for the whole aggregate await (or forever on error).
    rememberRadarView();
    // Both branches carry the counter: a clock or utility filter with no shape
    // drawn still walks every round off the network, and used to show a bare
    // spinner while it did.
    mainEl.innerHTML = hasShapes
      ? `<p class="view-empty" id="an-matching">Matching selections…</p>${renderRadarCard()}`
      : `<div class="is-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading</span></div><p class="view-empty" id="an-matching" hidden></p>${renderRadarCard()}`;
    paintRadar();

    try {
      const filter = filterObj();

      // Map control, if any selection asks for it. It filters nothing — it
      // rides along on the packs the match is already opening and records who
      // held the ground in each round, which is read out afterwards.
      const wanted = controlShapes(state.shapes);
      let controlNote = '';
      let controlPlan = [];
      /** @type {Map<string, string> | null} file → 'T' | 'CT' | '' */
      let control = null;
      if (wanted.length) {
        const unwindowed = wanted.filter((sh) => !controlWindow(sh));
        if (unwindowed.length) {
          controlNote =
            `Map control needs a stretch of the round clock of ${MAP_CONTROL_MAX_SECONDS} ` +
            `seconds or less. Set one with the clock button on ` +
            `${unwindowed.map((sh) => shapeLabel(sh, state.shapes.indexOf(sh))).join(', ')}.`;
        } else {
          setMatchingLabel(token, 'Loading map control…');
          const network = await ensureControlField(state.map);
          if (token !== renderToken) return;
          controlPlan = controlPlanFor(network, state.shapes);
          if (!network) {
            controlNote =
              'Map control needs this map’s zones and radar, and they could not be loaded.';
          } else if (!controlPlan.length) {
            controlNote = 'That selection covers no walkable ground, so nobody can hold it.';
          } else {
            control = new Map();
          }
        }
      }
      const network = controlNetwork;

      // The match walks every round the subjects appear in and pulls each one's
      // meta (and, for the shapes that need a position, its ticks) off the
      // network. That is the whole cost of this phase, and it is countable —
      // so count it, rather than leaving a sentence on screen for a minute.
      const agg = await aggregateAnalyticsAsync(payload, filter, tickCache, {
        onProgress: ({ done, total }) => {
          if (token !== renderToken || !total) return;
          setMatchingLabel(
            token,
            `Matching selections… ${done.toLocaleString()}/${total.toLocaleString()} rounds`
          );
        },
        onPack: control
          ? (file, pack) => control.set(file, controlSideForPack(controlPlan, network, pack))
          : null
      });
      if (token !== renderToken) return;

      // The leaderboard is computed on the server, over the rounds the search
      // just matched.
      //
      // It used to be computed here, which is why this page downloaded the
      // per-round rating inputs for the whole map: `aim` and `duels` alone are
      // 4,227 bytes a round and exist for nothing else, 55% of a payload the
      // search itself never reads. Sending the matched round ids and getting
      // the finished rows back is the same numbers — the server runs the same
      // `derivePlayers` / `deriveTeams` this file used to — for a request
      // instead of a download.
      //
      // If it fails, the card says so rather than showing a table quietly
      // aggregated from columns that are no longer fetched.
      let lb = [];
      let teamLb = [];
      let lbError = null;
      if (agg.files.length) {
        // How many rounds are being added up, and a clock, because the server
        // answers this in one shot: there is no honest fraction to show, but
        // "7,005 rounds, 4s" is the size of the job and proof it is alive —
        // which is what a bare "Building the leaderboard…" left the reader to
        // guess at while a cold aggregate store built itself.
        const scanned = agg.files.length.toLocaleString();
        const startedAt = Date.now();
        // While the statistics store is cold the server answers 503 with the
        // build's position; `prep` carries that into the ticking label so the
        // reader watches the build move instead of reading a failure.
        let prep = null;
        const tick = () => {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          if (prep) {
            const n = Number(prep.total)
              ? ` ${(Number(prep.done) || 0).toLocaleString()}/${Number(prep.total).toLocaleString()}`
              : '…';
            const eta = etaLabel(prep.etaSeconds);
            setMatchingLabel(
              token,
              `Server preparing statistics${n}${eta ? ` · ${eta}` : ''}${secs >= 1 ? ` · ${secs}s` : ''}`
            );
            return;
          }
          setMatchingLabel(
            token,
            `Building the leaderboard… ${scanned} rounds${secs >= 1 ? ` · ${secs}s` : ''}`
          );
        };
        tick();
        const timer = setInterval(tick, 1000);
        try {
          // A cold store is a WAIT, not a failure: it heals by itself and says
          // where it is. Retry until it is warm. Only errors that will not
          // heal on their own — the store switched off, anything else — reach
          // the card as text.
          for (;;) {
            try {
              const tables = await fetchAggregateForRounds(agg.files, { tables: 'players,teams' });
              lb = tables.players || [];
              teamLb = tables.teams || [];
              break;
            } catch (err) {
              const body = err?.status === 503 ? err.body : null;
              if (!body?.building || body?.disabled) throw err;
              prep = body.progress || {};
              tick();
              await new Promise((r) => setTimeout(r, 3000));
              if (token !== renderToken) return;
            }
          }
        } catch (err) {
          lbError = err?.message || String(err);
        } finally {
          clearInterval(timer);
        }
      }
      if (token !== renderToken) return;

      const needsPh = (payload.demos || []).some((d) =>
        (d.rounds || []).some((r) => r.m === state.map && !r.ph)
      );
      const roundCount = agg.anyone ? agg.files.length : agg.rounds;
      const { rows: controlRows, demos: controlDemos } = control
        ? rowsForFiles(agg.files)
        : { rows: null, demos: null };
      lastResults = {
        agg,
        lb,
        teamLb,
        roundCount,
        needsPh,
        lbError,
        controlNote,
        controlPlan,
        control,
        controlRows,
        controlDemos,
        controlSummary: control ? controlWinrates(control, controlRows) : null,
        controlTeams: []
      };
      paintResults();
    } catch (err) {
      if (token !== renderToken) return;
      rememberRadarView();
      lastResults = null;
      const slot = sideRoundsEl();
      if (slot) slot.innerHTML = '';
      mainEl.innerHTML = `<p class="view-empty">Could not run filters. ${escapeHtml(
        err?.message || String(err)
      )}</p>${renderRadarCard()}`;
      paintRadar();
    }
  }

  function render() {
    renderSidebar();
    renderMain();
    savedViews.touch();
  }

  /** Redraw the sidebar without losing the rounds list already computed. */
  function repaintSidebar() {
    renderSidebar();
    const slot = sideRoundsEl();
    if (slot && lastResults) slot.innerHTML = renderRounds(lastResults.agg);
  }

  /**
   * The catalogue: which demos are on which map. A few hundred KB, and it is
   * what lets this panel ask for one map instead of the whole library.
   */
  let roster = null;
  /** Demo ids the current payload covers, so revisiting a map is free. */
  let payloadScope = '';

  async function ensureRoster() {
    if (!roster) roster = await fetchRoster();
    return roster;
  }

  /**
   * Demo ids to fetch shapes for.
   *
   * Pattern Finder draws nothing until a map is picked, and then only ever
   * works on that map — so the other six sevenths of the library were being
   * downloaded to be ignored. Without a map yet, nothing is fetched at all.
   */
  function scopeDemos() {
    if (!state.map || !roster) return null;
    return demosForMap(roster, state.map);
  }

  function loadShapesForMap() {
    state.shapes = state.map ? loadShapes(state.map) : [];
    tickCache.clear();
  }

  /**
   * Fetch this map's rounds, if they are not already what we hold.
   *
   * Changing map is now a fetch rather than a filter over data already in
   * memory — which is the trade that makes the first load a seventh of the size.
   * The statsCache keys on the demo set, so going back to a map visited earlier
   * in the session is served from memory.
   */
  async function loadMapPayload(token) {
    const scoped = scopeDemos();
    if (!scoped?.length) {
      payload = { demos: [] };
      players = [];
      teams = [];
      return;
    }
    const stamp = scoped.join(',');
    if (payload && payloadScope === stamp && payloadGeneration === statsCacheGeneration()) return;
    setSpinnerLabel(mainEl, 'Loading map…');
    const data = await getStatsPayload(scoped, {
      columns: 'patterns',
      onProgress: (p) => {
        if (token !== loadToken) return;
        setSpinnerLabel(mainEl, statsProgressLabel(p));
      }
    });
    if (token !== loadToken) return;
    payload = data;
    payloadScope = stamp;
    payloadGeneration = statsCacheGeneration();
    players = listPlayers(payload);
    teams = listTeams(payload);
    state.playerIds = state.playerIds.filter((id) => players.some((p) => p.id === id));
  }

  async function load() {
    const token = ++loadToken;
    const fromUrl = new URLSearchParams(window.location.search).get('chapter');
    chapter = CHAPTERS.some((c) => c.key === fromUrl) ? fromUrl : 'players';
    mountChapterNav();
    applyChapterChrome();
    if (chapter !== 'charts') void fetchVrsRanks().catch(() => {});

    // Charts spends its own quota; skip the pattern-finder fetch.
    if (chapter === 'charts') {
      loadCharts();
      return;
    }

    // The document chapters need the stats library, not a pattern-finder spend.
    // Fetch the shared payload without consuming, and hand it to the chapter.
    const cacheFresh = () => payloadGeneration === statsCacheGeneration();

    if (chapter === 'antistrat' || chapter === 'scout') {
      // Both write a document off the library and pick their subject from the
      // roster catalogue, so they boot the same way.
      if (chapter === 'antistrat') ensureAntistrat();
      else ensureScout();
      const loadChapter = () =>
        chapter === 'antistrat' ? antistrat?.load() : scout?.load();
      const adopt = (data) => {
        payload = data;
        payloadGeneration = statsCacheGeneration();
        players = listPlayers(payload);
        teams = listTeams(payload);
        maps = listMaps(payload);
      };
      if (payload && cacheFresh()) {
        loadChapter();
        return;
      }
      const cached = peekStatsCache(null, ANTISTRAT_COLUMNS);
      if (cached) {
        adopt(cached);
        loadChapter();
        return;
      }
      mainEl.innerHTML = spinnerHtml('Loading stats…');
      try {
        const data = await getStatsPayload(null, {
          columns: ANTISTRAT_COLUMNS,
          onProgress: (p) => {
            if (token !== loadToken) return;
            setSpinnerLabel(mainEl, statsProgressLabel(p));
          }
        });
        if (token !== loadToken) return;
        adopt(data);
        loadChapter();
      } catch (err) {
        if (token !== loadToken) return;
        // The chapter's own self-fetch surfaces the same error (or succeeds if
        // this was a transient failure). Calling load() without a payload keeps
        // the chapter off an orphan spinner when the parent fetch failed.
        loadChapter();
      }
      return;
    }

    // Revisit: reuse the shared library payload without another fetch/spend.
    if (payload && cacheFresh()) {
      render();
      mountSavedViews();
      antistrat?.load();
      return;
    }
    const cached = peekStatsCache(null, ANTISTRAT_COLUMNS);
    if (cached) {
      payload = cached;
      payloadGeneration = statsCacheGeneration();
      players = listPlayers(payload);
      teams = listTeams(payload);
      maps = listMaps(payload);
      state.playerIds = state.playerIds.filter((id) => players.some((p) => p.id === id));
      if (state.map && !maps.includes(state.map)) state.map = '';
      loadShapesForMap();
      render();
      mountSavedViews();
      antistrat?.load();
      void savedViews.refresh().then(mountSavedViews);
      void savedViews
        .applyShareParam(Object.fromEntries(new URLSearchParams(window.location.search)))
        .then((hit) => {
          if (!hit) savedViews.touch();
        });
      return;
    }

    mainEl.innerHTML = spinnerHtml('Loading pattern finder…');
    const cancelSlow = watchSlowLoad(mainEl);
    try {
      await consumeCapability(CAP.ANALYTICS_PATTERN_FINDER);
      if (token !== loadToken) {
        cancelSlow();
        return;
      }
      // The map list comes from the catalogue, so the map picker works before a
      // single round has been fetched.
      await ensureRoster();
      if (token !== loadToken) {
        cancelSlow();
        return;
      }
      maps = rosterMaps(roster);
      if (state.map && !maps.includes(state.map)) state.map = '';

      await loadMapPayload(token);
      cancelSlow();
      if (token !== loadToken) return;
      loadShapesForMap();
      if (token !== loadToken) return;
      render();
      mountSavedViews();
      antistrat?.load();
      void savedViews.refresh().then(mountSavedViews);
      void savedViews
        .applyShareParam(Object.fromEntries(new URLSearchParams(window.location.search)))
        .then((hit) => {
          if (!hit) savedViews.touch();
        });
    } catch (err) {
      cancelSlow();
      if (token !== loadToken) return;
      // A spent allowance gets the real upgrade prompt, with a button. Telling
      // someone they are out of uses and giving them nothing to click is the
      // one moment where an Upgrade button is actually wanted.
      const prompt = err.status === 402 ? renderUpgradeError(err.body) : null;
      mainEl.innerHTML = '';
      if (prompt) {
        mainEl.appendChild(prompt);
      } else {
        const msg = formatApiError(err).message || String(err);
        mainEl.innerHTML = `<p class="view-empty">${escapeHtml(msg)}</p>
          <button type="button" class="btn btn-sm" data-an-retry>Retry</button>`;
        mainEl.querySelector('[data-an-retry]')?.addEventListener('click', () => load());
      }
    }
  }

  sidebarEl.addEventListener('input', (e) => {
    if (e.target.id === 'an-subject-search') {
      subjectSearch = e.target.value;
      subjectMenuOpen = true;
      refreshSubjectMenu();
    }
  });

  sidebarEl.addEventListener('focusin', (e) => {
    if (e.target.id === 'an-subject-search') {
      subjectMenuOpen = true;
      refreshSubjectMenu();
    }
  });

  sidebarEl.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick-ids]');
    if (pick) {
      const ids = String(pick.dataset.pickIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      addPlayers(ids);
      subjectSearch = '';
      subjectMenuOpen = false;
      render();
      return;
    }
    const remove = e.target.closest('[data-remove-player]');
    if (remove) {
      removePlayer(remove.dataset.removePlayer);
      render();
      return;
    }

    if (e.target.closest('[data-an-poly-done]')) {
      radar?.finishPoly();
      return;
    }
    const toggle = e.target.closest('[data-shape-toggle]');
    if (toggle) {
      const s = state.shapes.find((x) => x.id === toggle.dataset.shapeToggle);
      if (s) {
        s.enabled = !(s.enabled !== false);
        persistShapes();
        render();
      }
      return;
    }
    const clock = e.target.closest('[data-shape-clock]');
    if (clock) {
      const id = clock.dataset.shapeClock;
      editingWindow = editingWindow === id ? '' : id;
      repaintSidebar();
      return;
    }
    const winClear = e.target.closest('[data-shape-window-clear]');
    if (winClear) {
      const s = state.shapes.find((x) => x.id === winClear.dataset.shapeWindowClear);
      if (s) {
        delete s.window;
        persistShapes();
        render();
      }
      return;
    }
    const del = e.target.closest('[data-shape-del]');
    if (del) {
      if (editingWindow === del.dataset.shapeDel) editingWindow = '';
      state.shapes = state.shapes.filter((x) => x.id !== del.dataset.shapeDel);
      persistShapes();
      render();
      return;
    }
    const utilBtn = e.target.closest('[data-an-util]');
    if (utilBtn) {
      const key = utilBtn.dataset.anUtil;
      if (key in state.utilityVisible) {
        state.utilityVisible[key] = !state.utilityVisible[key];
        render();
      }
      return;
    }
    if (e.target.closest('[data-an-clear]')) {
      state.side = '';
      state.econ = null;
      state.oppEcon = null;
      state.hasAwp = false;
      state.oppHasAwp = false;
      state.result = '';
      state.opening = '';
      state.roundOwn = [];
      state.roundOpp = [];
      state.phases.clear();
      state.utilityVisible = defaultUtility();
      state.timeWindow = defaultTimeWindow();
      state.rankOwn = '';
      state.rankOpp = '';
      state.shapeMatch = '';
      state.drawFeature = '';
      state.drawMode = '';
      for (const s of state.shapes) s.enabled = false;
      persistShapes();
      render();
    }
  });

  // Fixed menus under the summary (same pattern as Database).
  sidebarEl.addEventListener(
    'toggle',
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      if (!details.classList.contains('an-round-multi') && !details.classList.contains('st-rank-dd')) {
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

  let rankRerenderTimer = 0;
  sidebarEl.addEventListener('input', (e) => {
    const rank = e.target.closest('[data-rank]');
    if (!rank) return;
    const field = String(rank.dataset.rank || '').split('|').pop();
    if (field !== 'rankOwn' && field !== 'rankOpp') return;
    state[field] = rank.value || '';
    syncRankSummary(rank.closest('details'), state.rankOwn, state.rankOpp);
    clearTimeout(rankRerenderTimer);
    rankRerenderTimer = setTimeout(() => {
      renderMain();
      savedViews.touch();
    }, 250);
  });

  window.addEventListener(
    'scroll',
    () => {
      for (const d of sidebarEl.querySelectorAll('details.an-round-multi[open]')) {
        placeRoundMenu(d);
      }
      for (const d of sidebarEl.querySelectorAll('details.st-rank-dd[open]')) {
        placeRankMenu(d);
      }
    },
    true
  );

  sidebarEl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'an-map') {
      state.map = t.value || '';
      state.drawMode = '';
      state.roundOwn = [];
      state.roundOpp = [];
      radarView = { zoom: 1, panX: 0, panY: 0 };
      loadShapesForMap();
      // The rounds for this map may not be loaded yet.
      const token = loadToken;
      mainEl.innerHTML = spinnerHtml('Loading map…');
      void loadMapPayload(token)
        .then(() => {
          if (token === loadToken) render();
        })
        .catch(() => {
          if (token === loadToken) render();
        });
      return;
    }
    const roundBox = t.closest?.('[data-an-round]');
    if (roundBox) {
      const field = roundBox.dataset.anRound === 'roundOpp' ? 'roundOpp' : 'roundOwn';
      const key = String(roundBox.value || '').trim();
      if (!key) {
        state[field] = [];
      } else {
        const set = new Set(state[field]);
        if (roundBox.checked) set.add(key);
        else set.delete(key);
        state[field] = [...set];
      }
      const keepOpen = field;
      render();
      const kept = sidebarEl.querySelector(`details[data-an-round-menu="${keepOpen}"]`);
      if (kept) {
        kept.setAttribute('open', '');
        placeRoundMenu(kept);
      }
      return;
    }
    if (t.matches('[data-an-feature]')) {
      const v = t.value;
      state.drawFeature =
        !v || v === 'any' ? (v === 'any' ? 'any' : '') : SHAPE_FEATURES.some((f) => f.key === v) ? v : '';
      return;
    }
    if (t.matches('[data-an-side]')) {
      const next = t.value === 'CT' || t.value === 'T' || t.value === 'any' ? t.value : '';
      if (next !== state.side) {
        state.roundOwn = [];
        state.roundOpp = [];
      }
      state.side = next;
      render();
      return;
    }
    if (t.matches('[data-an-result]')) {
      state.result = t.value === 'won' || t.value === 'lost' || t.value === 'any' ? t.value : '';
      render();
      return;
    }
    if (t.matches('[data-an-opening]')) {
      state.opening = t.value === 'won' || t.value === 'lost' || t.value === 'any' ? t.value : '';
      render();
      return;
    }
    if (t.matches('[data-an-match]')) {
      state.shapeMatch = t.value === 'any' || t.value === 'all' ? t.value : '';
      render();
      return;
    }
    if (t.matches('[data-an-phase]')) {
      state.phases.clear();
      if (t.value && t.value !== 'any') state.phases.add(t.value);
      render();
      return;
    }
    if (t.matches('[data-an-draw]')) {
      const raw = t.value;
      state.drawMode = raw === 'poly' || raw === 'lasso' || raw === 'rect' ? raw : '';
      radar?.setDrawMode(state.drawMode);
      renderSidebar();
      paintRadar();
      return;
    }
    const awp = t.closest('[data-an-awp]');
    if (awp) {
      state[awp.dataset.anAwp] = Boolean(awp.checked);
      render();
      return;
    }
    const econ = t.closest('[data-an-econ]');
    if (econ) {
      const raw = econ.value;
      const key = econ.dataset.anEcon;
      state[key] = raw === '' ? null : raw === 'any' ? 'any' : Number(raw);
      render();
    }
  });

  document.addEventListener('click', (e) => {
    const inSubject = e.target.closest?.('#an-subject-typeahead');
    if (!inSubject && subjectMenuOpen) {
      subjectMenuOpen = false;
      refreshSubjectMenu();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('details.an-round-multi, details.st-rank-dd')) closeRoundMenus();
  });

  // Play buttons live in the rounds list, which sits in the SIDEBAR now; the
  // statistics card keeps its own clicks (the Players | Teams switch). One
  // handler serves both so the buttons work wherever the list is mounted.
  async function handleResultClicks(e) {
    const mode = e.target.closest('[data-an-lb-mode]');
    if (mode) {
      const next = mode.dataset.anLbMode === 'teams' ? 'teams' : 'players';
      if (next !== state.lbMode) {
        state.lbMode = next;
        paintResults();
      }
      return;
    }
    const ctlSide = e.target.closest('[data-an-ctl-side]');
    if (ctlSide) {
      const next = ctlSide.dataset.anCtlSide || '';
      // Clicking the open side again closes it, so the ordinary leaderboard is
      // always one click away.
      state.controlSide = next === state.controlSide ? '' : next;
      state.controlTeam = '';
      paintResults();
      return;
    }
    const ctlTeam = e.target.closest('[data-an-ctl-team]');
    if (ctlTeam) {
      const key = ctlTeam.dataset.anCtlTeam || '';
      state.controlTeam = key === state.controlTeam ? '' : key;
      paintResults();
      return;
    }
    const playOne = e.target.closest('[data-an-play]');
    if (playOne && onPlayRounds) {
      playOne.disabled = true;
      try {
        await onPlayRounds([playOne.dataset.anPlay], subjectLabel());
      } finally {
        playOne.disabled = false;
      }
      return;
    }
    if (e.target.closest('#an-play-all') && onPlayRounds) {
      const agg = await aggregateAnalyticsAsync(payload, filterObj(), tickCache);
      if (!agg.files.length) return;
      const btn = e.target.closest('#an-play-all');
      btn.disabled = true;
      try {
        await onPlayRounds(
          agg.files,
          `${subjectLabel()} · ${MAPS[state.map]?.name || state.map}`
        );
      } finally {
        btn.disabled = false;
      }
    }
  }
  mainEl.addEventListener('click', handleResultClicks);
  sidebarEl.addEventListener('click', handleResultClicks);

  const detachTips = attachTips(el);

  return {
    el,
    load,
    setChapter,
    destroy() {
      detachTips();
      radar?.destroy();
      radar = null;
      antistrat?.destroy();
      antistrat = null;
      charts?.destroy();
      charts = null;
      chaptersEl.remove();
      el.remove();
    }
  };
}
