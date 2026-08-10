// ---------------------------------------------------------------------------
// replays/charts/chartsPanel.js
// The Charts screen: a graph builder over the stats index.
//
// Left side is the spec (chart type, what a point is, both axes with their own
// filters, series split, options, library-wide filters). Right side is the
// vector canvas plus the fit and a details table. Every change re-aggregates
// the cached facts in memory; nothing here refetches.
// ---------------------------------------------------------------------------

import { consumeCapability, formatApiError } from '../api.js';
import { getStatsPayload, statsCacheGeneration, statsCacheKey } from '../statsCache.js';
import { scheduleUiJob } from '../../lib/frameBudget.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { ECONOMIES, MAPS } from '../shared/roundId.js';
import {
  CT_TACTICAL,
  T_TACTICAL,
  positionRoleOptions
} from '../roles/regionKeys.js';
import { buildFacts, emptyFilter } from './chartFacts.js';
import {
  SUBJECTS,
  findMetric,
  findSubject,
  formatValue,
  metricsFor,
  seriesFor
} from './chartFields.js';
import settingsIcon from '../../icons/icon_settings.svg?url';
import calendarIcon from '../../icons/icon_calendar.svg?url';
import {
  computeChart,
  correlationWords,
  filterWords,
  normalizeCompareSlot
} from './chartData.js';
import { marksToSvgCircles, renderChart } from './chartRender.js';
import {
  setSpinnerLabel,
  spinnerHtml,
  statsProgressLabel,
  watchSlowLoad
} from '../../lib/spinner.js';
import { createSavedViews } from '../savedViews.js';
import { renderUpgradeError } from '../../site/upgradeGate.js';

/** Match radar viewer: wheel zoom + left/middle drag pan when zoomed in. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

const KILL_KINDS = [
  { key: 'opening', label: 'First kill' },
  { key: 'gun', label: 'Gun' },
  { key: 'hs', label: 'Headshot' },
  { key: 'awp', label: 'AWP' },
  { key: 'postplant', label: 'Post-plant' },
  { key: 'preplant', label: 'Pre-plant' }
];
const PHASES = [
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

/**
 * @param {{escapeHtml: (s: string) => string}} deps
 */
export function createChartsPanel({ escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'ch-panel';
  el.innerHTML = `
    <div class="ch-layout">
      <aside class="ch-side" id="ch-side"></aside>
      <div class="ch-main">
        <div class="ch-canvas" id="ch-canvas"><div class="is-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading</span></div></div>
        <div class="ch-details" id="ch-details"></div>
      </div>
    </div>`;

  const sideEl = el.querySelector('#ch-side');
  const canvasEl = el.querySelector('#ch-canvas');
  const detailsEl = el.querySelector('#ch-details');

  const pageHeadEl = document.createElement('div');
  pageHeadEl.className = 'ch-page-actions';
  pageHeadEl.innerHTML = `
    <div class="ch-mode-tabs" role="tablist" aria-label="Charts mode">
      <button type="button" class="seg-tab active" data-ch-mode="graph" role="tab" aria-selected="true">Graph</button>
      <button type="button" class="seg-tab" data-ch-mode="compare" role="tab" aria-selected="false">Compare</button>
    </div>`;

  let facts = null;
  /** Cache key of the facts currently in memory (`library` or demos:…). */
  let factsKey = '';
  /** Matches `statsCacheGeneration()` when facts were built. */
  let factsGeneration = -1;
  let loadToken = 0;
  /** @type {object[]} hover payloads, indexed by the mark's data-i */
  let hoverPoints = [];
  /** @type {{x:number,y:number,color:string}[]} viewBox-space scatter marks */
  let plotMarks = [];
  /** @type {{w:number,h:number}} */
  let plotView = { w: 1000, h: 560 };
  /** @type {number} hot mark index, or -1 */
  let hotMark = -1;
  let lastModel = null;
  /** @type {ResizeObserver | null} */
  let marksResizeObs = null;

  let plotZoom = 1;
  let plotPanX = 0;
  let plotPanY = 0;
  let panning = false;
  let panBtn = -1;
  let lastPanX = 0;
  let lastPanY = 0;
  const MARK_R = 6;
  const MARK_R_HOT = 9;
  let marksDrawPending = 0;

  const state = {
    type: 'scatter',
    subject: 'players',
    source: 'kill',
    x: { metric: 'adr', dimension: 'time', filter: {} },
    y: { metric: 'rating', dimension: '', filter: {} },
    series: 'team',
    binStep: 5,
    normalize: false,
    trendline: true,
    minRounds: 5,
    maxCats: 24,
    filter: emptyFilter(),
    /** Two sides (A/B), each a player or team, optionally narrowed to maps or games. */
    compare: {
      on: false,
      a: { kind: '', id: '', maps: [], matches: [], dateFrom: '', dateTo: '' },
      b: { kind: '', id: '', maps: [], matches: [], dateFrom: '', dateTo: '' }
    }
  };

  let compareSearch = { a: '', b: '' };
  let compareMenuOpen = { a: false, b: false };
  /** @type {Record<string, string>} */
  let filterEntitySearch = { g: '', x: '', y: '' };
  /** @type {Record<string, boolean>} */
  let filterEntityMenuOpen = { g: false, x: false, y: false };
  /** Gear-opened advanced filters for each axis. */
  let axisFilterOpen = { x: false, y: false };

  function emptyCompareSlot() {
    return { kind: '', id: '', maps: [], matches: [], dateFrom: '', dateTo: '' };
  }

  /** @type {Record<'a'|'b', boolean>} */
  let compareCalendarOpen = { a: false, b: false };

  function compareSlotEntity(s) {
    const slot = normalizeCompareSlot(s || {});
    if (!slot.kind || !slot.id) return null;
    return slot;
  }

  function entityLabel(kind, id) {
    if (kind === 'team') {
      const row = (facts?.teams || []).find((t) => String(t.key) === String(id));
      return row?.name || String(id);
    }
    const row = (facts?.players || []).find((p) => String(p.id) === String(id));
    return row?.name || String(id);
  }

  /** @returns {Map<string, Set<string>>} */
  function teamPlayerIndex() {
    /** @type {Map<string, Set<string>>} */
    const byTeam = new Map();
    for (const f of facts?.playerFacts || []) {
      const tk = String(f.teamKey || '');
      const pid = String(f.playerId || '');
      if (!tk || !pid) continue;
      if (!byTeam.has(tk)) byTeam.set(tk, new Set());
      byTeam.get(tk).add(pid);
    }
    return byTeam;
  }

  /**
   * @param {string} q
   * @param {{ teams?: boolean, players?: boolean, selectedTeamKeys?: Set<string>, selectedPlayerIds?: Set<string> }} opts
   */
  function entitySuggestions(q, opts = {}) {
    const {
      teams: allowTeams = true,
      players: allowPlayers = true,
      selectedTeamKeys = new Set(),
      selectedPlayerIds = new Set()
    } = opts;
    const needle = q.trim().toLowerCase();
    const teamPlayers = teamPlayerIndex();
    /** @type {{ kind: 'team'|'player', key: string, label: string, sub?: string }[]} */
    const out = [];

    if (allowTeams) {
      const teamHits = (facts?.teams || [])
        .filter((t) => !selectedTeamKeys.has(String(t.key)))
        .filter((t) => !needle || t.name.toLowerCase().includes(needle) || String(t.key).includes(needle))
        .slice(0, needle ? 8 : 12);
      for (const t of teamHits) {
        const n = teamPlayers.get(t.key)?.size || 0;
        out.push({
          kind: 'team',
          key: t.key,
          label: t.name,
          sub: n ? `${n} player${n === 1 ? '' : 's'}` : ''
        });
      }
    }

    if (allowPlayers && needle.length >= 1) {
      const playerHits = (facts?.players || [])
        .filter((p) => !selectedPlayerIds.has(String(p.id)))
        .filter(
          (p) => p.name.toLowerCase().includes(needle) || String(p.id).toLowerCase().includes(needle)
        )
        .slice(0, 20);
      for (const p of playerHits) {
        out.push({ kind: 'player', key: p.id, label: p.name });
      }
    }

    return out;
  }

  function entitySuggestMenuHtml(opts, pickAttr, pickScope = '') {
    if (!opts.length) {
      return `<p class="rp-typeahead-empty">No matches</p>`;
    }
    const pickVal = (o) =>
      pickScope ? `${pickScope}|${o.kind}|${o.key}` : `${o.kind}|${o.key}`;
    const teamsHtml = opts
      .filter((o) => o.kind === 'team')
      .map(
        (o) => `<button type="button" class="an-suggest" ${pickAttr}="${escapeHtml(pickVal(o))}">
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
        (o) => `<button type="button" class="an-suggest" ${pickAttr}="${escapeHtml(pickVal(o))}">
          <span class="an-suggest-kind">Player</span>
          <span class="an-suggest-main"><strong>${escapeHtml(o.label)}</strong></span>
        </button>`
      )
      .join('');
    return `
      ${teamsHtml ? `<div class="an-suggest-group"><span class="an-suggest-group-label">Teams</span>${teamsHtml}</div>` : ''}
      ${playersHtml ? `<div class="an-suggest-group"><span class="an-suggest-group-label">Players</span>${playersHtml}</div>` : ''}`;
  }

  function refreshCompareMenu(slot) {
    const menu = sideEl.querySelector(`#ch-compare-menu-${slot}`);
    if (!menu) return;
    const q = compareSearch[slot] || '';
    const opts = entitySuggestions(q, { players: q.length >= 1 });
    const show = compareMenuOpen[slot] && (opts.length || q.length >= 1);
    menu.hidden = !show;
    if (!show) return;
    menu.innerHTML = opts.length
      ? entitySuggestMenuHtml(opts, 'data-compare-pick')
      : `<p class="rp-typeahead-empty">${q ? 'No matches' : 'Type a name, or pick a team'}</p>`;
  }

  function refreshFilterEntityMenu(scope) {
    const menu = sideEl.querySelector(`#ch-entity-menu-${scope}`);
    if (!menu) return;
    const f = filterFor(scope);
    const hidePlayers = scope === 'g' && state.compare?.on;
    const selectedTeamKeys = new Set((f.teams || []).map(String));
    const selectedPlayerIds = new Set((f.players || []).map(String));
    const q = filterEntitySearch[scope] || '';
    const opts = entitySuggestions(q, {
      teams: Boolean(facts?.teams?.length),
      players: Boolean(facts?.players?.length) && !hidePlayers,
      selectedTeamKeys,
      selectedPlayerIds
    });
    const show = filterEntityMenuOpen[scope] && (opts.length || q.length >= 1);
    menu.hidden = !show;
    if (!show) return;
    menu.innerHTML = opts.length
      ? entitySuggestMenuHtml(opts, 'data-entity-pick', scope)
      : `<p class="rp-typeahead-empty">${q ? 'No matches' : 'Type a name, or pick a team'}</p>`;
  }

  function entityFilterHtml(scope, f) {
    const hidePlayers = scope === 'g' && state.compare?.on;
    const hasTeams = Boolean(facts?.teams?.length);
    const hasPlayers = Boolean(facts?.players?.length) && !hidePlayers;
    if (!hasTeams && !hasPlayers) return '';

    const teamKeys = (f.teams || []).map(String);
    const playerIds = (f.players || []).map(String);
    const chips = [
      ...teamKeys.map(
        (key) => `<button type="button" class="an-sel-chip" data-entity-remove="${scope}|team|${escapeHtml(
          key
        )}" title="Remove">${escapeHtml(entityLabel('team', key))} <span aria-hidden="true">×</span></button>`
      ),
      ...playerIds.map(
        (id) => `<button type="button" class="an-sel-chip" data-entity-remove="${scope}|player|${escapeHtml(
          id
        )}" title="Remove">${escapeHtml(entityLabel('player', id))} <span aria-hidden="true">×</span></button>`
      )
    ].join('');

    return `<div class="ch-entity-typeahead rp-typeahead" id="ch-entity-typeahead-${scope}">
        ${chips ? `<div class="an-sel-chips">${chips}</div>` : ''}
        <input type="search" class="site-input" data-entity-search="${scope}"
          placeholder="Search teams or players…" spellcheck="false" autocomplete="off"
          value="${escapeHtml(filterEntitySearch[scope] || '')}" aria-label="Search teams or players" />
        <div class="rp-typeahead-menu an-subject-menu" id="ch-entity-menu-${scope}" hidden></div>
      </div>`;
  }

  /** Charts are scatter-only; Compare is a mode on top of the same graph. */
  const isScatter = () => true;
  const source = () => findSubject(state.subject).source;

  function syncModeTabs() {
    const comparing = Boolean(state.compare?.on);
    pageHeadEl.querySelectorAll('[data-ch-mode]').forEach((btn) => {
      const on = comparing ? btn.dataset.chMode === 'compare' : btn.dataset.chMode === 'graph';
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function mountPageHead() {
    document.getElementById('page-head-actions')?.replaceChildren(pageHeadEl);
    syncModeTabs();
  }

  // ---- saved views --------------------------------------------------------
  //
  // The whole builder state IS the spec, so save and load are a copy in each
  // direction. Everything is plain data; nothing here holds a DOM reference.

  const savedViews = createSavedViews({
    page: 'charts',
    escapeHtml,
    read: () => JSON.parse(JSON.stringify(state)),
    apply(spec) {
      if (!spec || typeof spec !== 'object') return;
      // Assigned key by key so a spec saved by an older build cannot delete
      // fields this one needs.
      for (const [key, value] of Object.entries(spec)) {
        if (!(key in state)) continue;
        if (key === 'compare' && value && typeof value === 'object') {
          const legacySlots = Array.isArray(value.slots) ? value.slots : null;
          state.compare = {
            on: Boolean(value.on),
            a: normalizeCompareSlot(value.a || legacySlots?.[0]),
            b: normalizeCompareSlot(value.b || legacySlots?.[1])
          };
          continue;
        }
        state[key] = value;
      }
      state.type = 'scatter';
      syncModeTabs();
      renderSide();
      renderCanvas();
      mountSavedViews();
      savedViews.touch();
    }
  });

  /** renderSide() rewrites the sidebar, so the strip is re-attached after it. */
  function mountSavedViews() {
    const slot = el.querySelector('#ch-saved');
    if (slot && !slot.contains(savedViews.el)) slot.replaceChildren(savedViews.el);
  }

  // ---- small html helpers -------------------------------------------------

  const checkFlag = (scope, key, label, on) =>
    `<label class="ch-check"><input type="checkbox" data-flag="${scope}|${key}"${
      on ? ' checked' : ''
    } /> ${escapeHtml(label)}</label>`;

  /** Full-width on/off switch (axis measure toggles). */
  const switchFlag = (scope, key, label, on) =>
    `<label class="ch-switch-btn${on ? ' active' : ''}">
      <input type="checkbox" data-flag="${scope}|${key}"${on ? ' checked' : ''} />
      <span>${escapeHtml(label)}</span>
    </label>`;

  function selectHtml(attr, options, value, { placeholder = '', cls = 'site-select' } = {}) {
    const opts = options
      .map(
        (o) =>
          `<option value="${escapeHtml(o.key)}"${String(o.key) === String(value) ? ' selected' : ''}>${escapeHtml(
            o.label
          )}</option>`
      )
      .join('');
    const head = placeholder
      ? `<option value=""${!value ? ' selected' : ''}>${escapeHtml(placeholder)}</option>`
      : '';
    return `<select class="${cls}" ${attr}>${head}${opts}</select>`;
  }

  function metricSelect(scope, value, axisLabel) {
    const list = metricsFor(source());
    const groups = [...new Set(list.map((m) => m.group))];
    const body = groups
      .map((g) => {
        const opts = list
          .filter((m) => m.group === g)
          .map(
            (m) => `<label class="ch-dd-opt" title="${escapeHtml(m.tip || '')}">
            <input type="radio" name="ch-metric-${scope}" data-metric-pick="${scope}" value="${escapeHtml(
              m.key
            )}" ${m.key === value ? 'checked' : ''} />
            <span>${escapeHtml(m.label)}</span>
          </label>`
          )
          .join('');
        return `<div class="ch-dd-group"><span class="ch-dd-group-label">${escapeHtml(g)}</span>${opts}</div>`;
      })
      .join('');
    return `<details class="ch-dd ch-metric-dd" data-ch-metric="${scope}">
      <summary class="site-select ch-dd-summary ch-axis-select" aria-label="${escapeHtml(
        axisLabel
      )}">${escapeHtml(axisLabel)}</summary>
      <div class="ch-dd-menu" role="listbox" aria-label="${escapeHtml(axisLabel)}">${body}</div>
    </details>`;
  }

  function summaryLabel(options, selected, emptyLabel) {
    const sel = (selected || []).map(String).filter(Boolean);
    if (!sel.length) return emptyLabel;
    if (sel.length === 1) {
      return options.find((o) => String(o.key) === sel[0])?.label || sel[0];
    }
    return `${sel.length} selected`;
  }

  /** Multi-select dropdown (Map / Role / buys) with placeholder text in the closed control. */
  function multiDropdown(scope, key, options, selected, emptyLabel) {
    if (!options.length) return '';
    const sel = (selected || []).map(String);
    const selSet = new Set(sel);
    const checks = options
      .map(
        (o) => `<label class="ch-dd-opt">
        <input type="checkbox" data-chip-check="${scope}|${key}" value="${escapeHtml(String(o.key))}" ${
          selSet.has(String(o.key)) ? 'checked' : ''
        } />
        <span>${escapeHtml(o.label)}</span>
      </label>`
      )
      .join('');
    return `<details class="ch-dd" data-ch-dd="${scope}|${key}">
      <summary class="site-select ch-dd-summary" aria-label="${escapeHtml(emptyLabel)}">${escapeHtml(
        summaryLabel(options, sel, emptyLabel)
      )}</summary>
      <div class="ch-dd-menu" role="group" aria-label="${escapeHtml(emptyLabel)}">${checks}</div>
    </details>`;
  }

  function sideSegHtml(scope, f) {
    const sides = new Set((f.sides || []).map(String));
    const active =
      sides.has('T') && !sides.has('CT') ? 'T' : sides.has('CT') && !sides.has('T') ? 'CT' : '';
    return `<div class="rp-seg rp-seg-side ch-side-seg" role="group" aria-label="Side">
      <button type="button" class="rp-seg-btn${active === 'T' ? ' active' : ''}" data-side-seg="${scope}" data-value="T" aria-label="T" title="T">
        <img src="/icons/icon_t.png" alt="" width="16" height="16" draggable="false" />
      </button>
      <button type="button" class="rp-seg-btn${active === 'CT' ? ' active' : ''}" data-side-seg="${scope}" data-value="CT" aria-label="CT" title="CT">
        <img src="/icons/icon_ct.png" alt="" width="16" height="16" draggable="false" />
      </button>
    </div>`;
  }

  function awpToggle(scope, key, on) {
    return `<label class="rp-awp-toggle ch-awp-toggle${on ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" data-flag="${scope}|${key}" ${on ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  function exclusiveSeg(scope, key, options, value, extraClass = '') {
    return `<div class="rp-seg ${extraClass}" role="group">
      ${options
        .map((o) => {
          const on = String(value || '') === String(o.key);
          return `<button type="button" class="rp-seg-btn${on ? ' active' : ''}" data-exclusive-chip="${scope}|${key}" data-value="${escapeHtml(
            String(o.key)
          )}" aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(o.label)}">${escapeHtml(
            o.short || o.label
          )}</button>`;
        })
        .join('')}
    </div>`;
  }

  function axisGear(scope) {
    const open = Boolean(axisFilterOpen[scope]);
    const active = filterWords(state[scope].filter).length > 0 || open;
    return `<button type="button" class="ch-gear${active ? ' active' : ''}" data-axis-gear="${scope}" aria-expanded="${
      open ? 'true' : 'false'
    }" aria-label="${scope === 'y' ? 'Y' : 'X'} filters" title="Filters">
      <img src="${settingsIcon}" alt="" width="16" height="16" draggable="false" />
    </button>`;
  }

  /** Clickable chips: click selects, click again clears (no Ctrl needed). */
  function multiSelect(scope, key, options, selected) {
    const sel = new Set((selected || []).map(String));
    return `<div class="ch-chips" role="group">${options
      .map((o) => {
        const on = sel.has(String(o.key));
        return `<button type="button" class="ch-chip${on ? ' on' : ''}" data-chip="${scope}|${key}" data-value="${escapeHtml(
          String(o.key)
        )}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(o.label)}</button>`;
      })
      .join('')}</div>`;
  }

  // ---- filter editor ------------------------------------------------------

  /** Role / position options — A/B labels only when a single map is selected. */
  function roleFilterOptions(f) {
    const selectedMaps = f.maps?.length ? f.maps : [];
    const single =
      selectedMaps.length === 1 ||
      (!selectedMaps.length && (facts?.maps || []).length === 1);
    if (single) {
      const mapCode =
        selectedMaps.length === 1
          ? selectedMaps[0]
          : (facts?.maps || []).length === 1
            ? facts.maps[0]
            : '';
      const seen = new Set();
      const out = [];
      for (const side of ['T', 'CT']) {
        for (const o of positionRoleOptions(side, mapCode)) {
          if (seen.has(o.label)) continue;
          seen.add(o.label);
          out.push({ key: o.label, label: o.label });
        }
      }
      return out;
    }
    const out = [];
    const seen = new Set();
    for (const o of [...T_TACTICAL, ...CT_TACTICAL]) {
      if (seen.has(o.label)) continue;
      seen.add(o.label);
      out.push({ key: o.label, label: o.label });
    }
    return out;
  }

  /**
   * @param {'g'|'x'|'y'} scope
   * @param {object} f  the filter object this scope edits
   */
  function filterHtml(scope, f) {
    const src = source();
    const killable = src === 'kill';
    const maps = (facts?.maps || []).map((m) => ({ key: m, label: MAPS[m]?.name || m }));
    const econOpts = Object.entries(ECONOMIES).map(([code, e]) => ({ key: code, label: e.label }));
    const arr = (key) => f[key] || [];

    const rows = [
      scope === 'g'
        ? ''
        : switchFlag(scope, 'perRound', 'Divide by played rounds', Boolean(f.perRound)),
      maps.length > 1 && !(scope === 'g' && state.compare?.on)
        ? multiDropdown(scope, 'maps', maps, arr('maps'), 'Map')
        : '',
      sideSegHtml(scope, f),
      src === 'player' || src === 'kill'
        ? multiDropdown(scope, 'roles', roleFilterOptions(f), arr('roles'), 'Role')
        : '',
      `<div class="ch-filter-row">${multiDropdown(
        scope,
        'econ',
        econOpts,
        arr('econ'),
        'Own buy'
      )}${awpToggle(scope, 'hasAwp', Boolean(f.hasAwp))}</div>`,
      `<div class="ch-filter-row">${multiDropdown(
        scope,
        'oppEcon',
        econOpts,
        arr('oppEcon'),
        'Enemy buy'
      )}${awpToggle(scope, 'oppHasAwp', Boolean(f.oppHasAwp))}</div>`,
      `<div class="ch-round-segs">
        ${exclusiveSeg(
          scope,
          'result',
          [
            { key: 'won', label: 'Won', short: 'W' },
            { key: 'lost', label: 'Lost', short: 'L' }
          ],
          f.result || ''
        )}
        ${exclusiveSeg(
          scope,
          'opening',
          [
            { key: '5v4', label: '5v4', short: '5v4' },
            { key: '4v5', label: '4v5', short: '4v5' }
          ],
          f.opening || ''
        )}
        ${exclusiveSeg(
          scope,
          'half',
          [
            { key: '1', label: '1st half', short: '1. half' },
            { key: '2', label: '2nd half', short: '2. half' }
          ],
          f.half || ''
        )}
      </div>`,
      `<div class="ch-range ch-range-fill">
        <input class="site-input" type="number" min="1" max="99" placeholder="from" value="${
          f.roundFrom ?? ''
        }" data-num="${scope}|roundFrom" aria-label="Round from" />
        <input class="site-input" type="number" min="1" max="99" placeholder="to" value="${
          f.roundTo ?? ''
        }" data-num="${scope}|roundTo" aria-label="Round to" />
      </div>`,
      killable ? multiDropdown(scope, 'killKinds', KILL_KINDS, arr('killKinds'), 'Kill type') : '',
      killable ? multiDropdown(scope, 'phases', PHASES, arr('phases'), 'Phase') : '',
      killable
        ? `<div class="ch-range ch-range-fill">
            <input class="site-input" type="number" step="1" placeholder="from s" value="${
              f.timeFrom ?? ''
            }" data-num="${scope}|timeFrom" aria-label="Time from" />
            <input class="site-input" type="number" step="1" placeholder="to s" value="${
              f.timeTo ?? ''
            }" data-num="${scope}|timeTo" aria-label="Time to" />
          </div>`
        : '',
      facts?.teams?.length || (facts?.players?.length && !(scope === 'g' && state.compare?.on))
        ? entityFilterHtml(scope, f)
        : '',
      killable && facts?.weapons?.length
        ? multiDropdown(
            scope,
            'weapons',
            facts.weapons.slice(0, 40).map((w) => ({ key: w, label: w })),
            arr('weapons'),
            'Weapons'
          )
        : ''
    ];

    return `<div class="ch-filter">${rows.filter(Boolean).join('')}
      <button type="button" class="btn btn-sm" data-clear="${scope}">Clear</button>
    </div>`;
  }

  // ---- builder ------------------------------------------------------------

  /** Games this compare slot can include, given entity + optional map chips. */
  function matchesForCompareSlot(s) {
    const entity = compareSlotEntity(s);
    if (!entity || !facts) return [];
    const maps = new Set((s.maps || []).map(String).filter(Boolean));
    const ids = new Set();
    if (entity.kind === 'team') {
      for (const f of facts.roundFacts || []) {
        if (String(f.teamKey || '') !== entity.id) continue;
        if (maps.size && !maps.has(String(f.map || ''))) continue;
        if (f.demoId) ids.add(String(f.demoId));
      }
    } else {
      for (const f of facts.playerFacts || []) {
        if (String(f.playerId || '') !== entity.id) continue;
        if (maps.size && !maps.has(String(f.map || ''))) continue;
        if (f.demoId) ids.add(String(f.demoId));
      }
    }
    return (facts.matches || []).filter((m) => ids.has(String(m.id)));
  }

  function compareEntityHtml(slot, s) {
    const entity = compareSlotEntity(s);
    if (entity) {
      return `<button type="button" class="an-sel-chip" data-compare-clear="${slot}" title="Change">${escapeHtml(
        entityLabel(entity.kind, entity.id)
      )} <span aria-hidden="true">×</span></button>`;
    }
    return `<input type="search" class="site-input" data-compare-search="${slot}"
      placeholder="Search teams or players…" spellcheck="false" autocomplete="off"
      value="${escapeHtml(compareSearch[slot] || '')}" aria-label="Search teams or players" />
    <div class="rp-typeahead-menu an-subject-menu" id="ch-compare-menu-${slot}" hidden></div>`;
  }

  function dayStartMs(iso) {
    if (!iso) return null;
    const t = Date.parse(`${iso}T00:00:00`);
    return Number.isFinite(t) ? t : null;
  }

  function dayEndMs(iso) {
    if (!iso) return null;
    const t = Date.parse(`${iso}T23:59:59.999`);
    return Number.isFinite(t) ? t : null;
  }

  /** Select compare-slot games whose upload date falls in the slot's date range. */
  function applyCompareDateRange(slotKey) {
    const slot = state.compare[slotKey];
    if (!slot) return;
    const from = dayStartMs(slot.dateFrom);
    const to = dayEndMs(slot.dateTo);
    if (from == null && to == null) {
      slot.matches = [];
      return;
    }
    const opts = matchesForCompareSlot(slot);
    slot.matches = opts
      .filter((m) => {
        const t = Number(m.uploadedAt) || 0;
        if (!t) return false;
        if (from != null && t < from) return false;
        if (to != null && t > to) return false;
        return true;
      })
      .map((m) => String(m.id));
  }

  function compareGamesDropdown(slot, matchOpts, selected) {
    const sel = (selected || []).map(String);
    const selSet = new Set(sel);
    const checks = matchOpts
      .map(
        (m) => `<label class="ch-dd-opt">
        <input type="checkbox" data-compare-match-check="${slot}" value="${escapeHtml(String(m.id))}" ${
          selSet.has(String(m.id)) ? 'checked' : ''
        } />
        <span>${escapeHtml(m.label)}</span>
      </label>`
      )
      .join('');
    const empty = 'Games';
    const summary = !sel.length
      ? empty
      : sel.length === 1
        ? matchOpts.find((m) => String(m.id) === sel[0])?.label || sel[0]
        : `${sel.length} games`;
    return `<details class="ch-dd ch-compare-games-dd" data-ch-dd="compare|${slot}">
      <summary class="site-select ch-dd-summary" aria-label="Games">${escapeHtml(summary)}</summary>
      <div class="ch-dd-menu" role="group" aria-label="Games">${checks}</div>
    </details>`;
  }

  function compareCalendarHtml(slot, s) {
    const open = Boolean(compareCalendarOpen[slot]);
    const active = Boolean(s.dateFrom || s.dateTo);
    return `<div class="ch-date-wrap${open ? ' open' : ''}${active ? ' has-range' : ''}">
      <button type="button" class="ch-date-toggle${active ? ' active' : ''}" data-compare-calendar="${slot}"
        aria-expanded="${open ? 'true' : 'false'}" aria-label="Date range" title="Date range">
        <img src="${calendarIcon}" alt="" width="18" height="18" draggable="false" />
      </button>
      <div class="ch-date-popover" ${open ? '' : 'hidden'}>
        <label class="ch-date-field">
          <span>From</span>
          <input class="site-input" type="date" data-compare-date="${slot}|from"
            value="${escapeHtml(s.dateFrom || '')}" aria-label="From date" />
        </label>
        <label class="ch-date-field">
          <span>To</span>
          <input class="site-input" type="date" data-compare-date="${slot}|to"
            value="${escapeHtml(s.dateTo || '')}" aria-label="To date" />
        </label>
      </div>
    </div>`;
  }

  function compareSlotHtml(slot) {
    const s = state.compare[slot] || emptyCompareSlot();
    const maps = (facts?.maps || []).map((m) => ({ key: m, label: MAPS[m]?.name || m }));
    const selMaps = new Set((s.maps || []).map(String));
    const matchOpts = matchesForCompareSlot(s);
    const selMatches = (s.matches || []).map(String);
    const entity = compareSlotEntity(s);
    return `
      <div class="ch-compare-slot" data-compare-slot="${slot}">
        <span class="ch-label">${slot === 'a' ? 'A' : 'B'}</span>
        <div class="ch-entity-typeahead rp-typeahead" id="ch-compare-typeahead-${slot}">
          ${compareEntityHtml(slot, s)}
        </div>
        ${
          maps.length
            ? `<div class="ch-chips" role="group" title="Optional: limit this side to maps">
                ${maps
                  .map((m) => {
                    const on = selMaps.has(String(m.key));
                    return `<button type="button" class="ch-chip${on ? ' on' : ''}" data-compare-map="${slot}" data-value="${escapeHtml(
                      String(m.key)
                    )}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(m.label)}</button>`;
                  })
                  .join('')}
              </div>`
            : ''
        }
        ${
          matchOpts.length
            ? `<div class="ch-compare-games-row">
                ${compareGamesDropdown(slot, matchOpts, selMatches)}
                ${compareCalendarHtml(slot, s)}
              </div>`
            : entity
              ? `<p class="ch-hint">No games for this selection with the current maps.</p>`
              : ''
        }
      </div>`;
  }

  function compareSlotsBlock() {
    if (!state.compare?.on) return '';
    return `<div class="ch-compare-slots">
      ${compareSlotHtml('a')}
      ${compareSlotHtml('b')}
    </div>`;
  }

  function renderSide() {
    const src = source();
    const seriesOpts = seriesFor(src).map((d) => ({ key: d.key, label: d.label }));
    const comparing = Boolean(state.compare?.on);

    sideEl.innerHTML = `
      <div class="ch-block ch-saved ch-no-rule" id="ch-saved"></div>
      <div class="ch-block ch-no-rule">
        <div class="ch-subject-row">
          ${selectHtml(
            'data-subject',
            SUBJECTS.map((s) => ({ key: s.key, label: s.label })),
            state.subject,
            { cls: 'site-select ch-subject-select' }
          )}
          <input class="site-input ch-min-rounds" type="number" min="0" value="${
            state.minRounds
          }" data-opt="minRounds" aria-label="Min rounds" title="Min rounds" />
        </div>
        ${compareSlotsBlock()}
      </div>

      <div class="ch-block ch-no-rule">
        <div class="ch-axis-row">
          ${metricSelect('y', state.y.metric, 'Y Axis')}
          ${axisGear('y')}
        </div>
        <div class="ch-axis-panel"${axisFilterOpen.y ? '' : ' hidden'}>
          ${filterHtml('y', state.y.filter)}
        </div>
      </div>

      <div class="ch-block ch-no-rule">
        <div class="ch-axis-row">
          ${metricSelect('x', state.x.metric, 'X Axis')}
          ${axisGear('x')}
        </div>
        <div class="ch-axis-panel"${axisFilterOpen.x ? '' : ' hidden'}>
          ${filterHtml('x', state.x.filter)}
        </div>
      </div>

      <div class="ch-block ch-after-series"${comparing ? ' hidden' : ''}>
        ${selectHtml('data-series', seriesOpts, state.series, { placeholder: 'Color by' })}
      </div>

      <div class="ch-block ch-no-rule ch-general-filters">
        <span class="ch-section-label">General filters</span>
        ${filterHtml('g', state.filter)}
      </div>`;
    for (const slot of ['a', 'b']) refreshCompareMenu(slot);
    for (const scope of ['g', 'x', 'y']) refreshFilterEntityMenu(scope);
  }

  // ---- canvas -------------------------------------------------------------

  function chartTitle(model) {
    const cmp = state.compare?.on
      ? compareSlotsLabel()
      : '';
    if (model.kind === 'scatter') {
      const base = `${model.yLabel} vs ${model.xLabel} by ${findSubject(state.subject).label.toLowerCase()}`;
      return cmp ? `${base} · ${cmp}` : base;
    }
    const base = `${model.yLabel} by ${model.xLabel}`;
    return cmp ? `${base} · ${cmp}` : base;
  }

  function compareSlotsLabel() {
    const a = compareSlotEntity(state.compare?.a);
    const b = compareSlotEntity(state.compare?.b);
    if (!a && !b) return 'compare';
    const name = (entity) => entityLabel(entity.kind, entity.id);
    if (a && b) return `${name(a)} vs ${name(b)}`;
    return a ? name(a) : name(b);
  }

  function dbPlayerHref(id, label) {
    const q = new URLSearchParams();
    q.set('player', String(id));
    if (label && label !== id) q.set('label', String(label));
    return `/database?${q.toString()}`;
  }

  function dbTeamHref(name, label = name) {
    const q = new URLSearchParams();
    q.set('team', String(name));
    if (label && label !== name) q.set('label', String(label));
    return `/database?${q.toString()}`;
  }

  function subjectCellHtml(p) {
    const subj = findSubject(state.subject);
    const name = p.name || '';
    if (!name) return '';
    if (subj.source === 'player') {
      const playerId = String(p.id || '').split(':')[0];
      if (!playerId) return escapeHtml(name);
      return `<a class="ch-link" href="${escapeHtml(dbPlayerHref(playerId, name))}">${escapeHtml(name)}</a>`;
    }
    if (subj.source === 'round') {
      return `<a class="ch-link" href="${escapeHtml(dbTeamHref(name))}">${escapeHtml(name)}</a>`;
    }
    return escapeHtml(name);
  }

  function subCellHtml(p) {
    const text = p.sub || p.seriesLabel || '';
    if (!text) return '';
    const subj = findSubject(state.subject);
    // Player rows carry the team name in `sub`.
    if (subj.source === 'player' && p.sub) {
      return `<a class="ch-link" href="${escapeHtml(dbTeamHref(p.sub))}">${escapeHtml(p.sub)}</a>`;
    }
    return escapeHtml(text);
  }

  function detailsHtml(model) {
    if (model.kind === 'scatter') {
      const rows = model.points
        .slice(0, 40)
        .map(
          (p, i) =>
            `<tr data-row="${i}"><td class="ch-name">${subjectCellHtml(p)}</td><td>${subCellHtml(
              p
            )}</td><td>${escapeHtml(formatValue(p.x, model.xFmt))}</td><td>${escapeHtml(
              formatValue(p.y, model.yFmt)
            )}</td><td>${p.rounds}</td></tr>`
        )
        .join('');
      return `<table class="ch-table"><thead><tr><th>Subject</th><th></th><th>${escapeHtml(
        model.xLabel
      )}</th><th>${escapeHtml(model.yLabel)}</th><th>Rounds</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const rows = model.seriesList
      .flatMap((s) =>
        s.points
          .filter((p) => p.y !== null)
          .map(
            (p) =>
              `<tr><td class="ch-name">${escapeHtml(p.xLabel)}</td><td>${escapeHtml(
                s.label || ''
              )}</td><td>${escapeHtml(formatValue(p.y, model.yFmt))}</td><td>${p.n}</td><td>${
                p.rounds
              }</td></tr>`
          )
      )
      .slice(0, 60)
      .join('');
    return `<table class="ch-table"><thead><tr><th>${escapeHtml(
      model.xLabel
    )}</th><th>Series</th><th>${escapeHtml(
      model.yLabel
    )}</th><th>Sample</th><th>Rounds</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderCanvas() {
    if (!facts) return;
    hotMark = -1;
    let model;
    try {
      model = computeChart(state, facts);
    } catch (err) {
      canvasEl.innerHTML = `<p class="view-empty">${escapeHtml(err.message || 'Could not build that chart.')}</p>`;
      detailsEl.innerHTML = '';
      return;
    }
    lastModel = model;

    const { svg, points, marks, view } = renderChart(model, { trendline: state.trendline });
    hoverPoints = points;
    plotMarks = marks || [];
    plotView = view || { w: 1000, h: 560 };
    hotMark = -1;
    if (!svg) {
      marksResizeObs?.disconnect();
      marksResizeObs = null;
      canvasEl.innerHTML =
        '<p class="view-empty">Nothing matches those filters. Loosen a filter or lower Min rounds.</p>';
      detailsEl.innerHTML = '';
      return;
    }

    const fit = model.fit;
    const bits = [`${model.count} point${model.count === 1 ? '' : 's'} plotted`];
    if (fit) {
      bits.push(
        `r = ${fit.r.toFixed(3)}`,
        `R² = ${fit.r2.toFixed(3)}`,
        `${correlationWords(fit.r)} (n = ${fit.n})`
      );
    } else {
      bits.push('too few points for a fit');
    }
    const words = filterWords(state.filter);
    if (words.length) bits.push(`filters: ${words.join(', ')}`);
    const infoPop = bits.map((b) => `<div>${escapeHtml(b)}</div>`).join('');

    canvasEl.innerHTML = `
      <div class="ch-plot" id="ch-plot">
        <div class="ch-plot-chrome">
          <h3 class="ch-title">${escapeHtml(chartTitle(model))}</h3>
          <div class="ch-plot-actions">
            <label class="ch-check ch-trendline"><input type="checkbox" data-toggle="trendline"${
              state.trendline ? ' checked' : ''
            } /> Trendline</label>
            <button type="button" class="btn btn-sm" data-save>Save SVG</button>
            <div class="ch-info">
              <button type="button" class="ch-info-btn" aria-label="Chart fit details">i</button>
              <div class="ch-info-pop" role="tooltip">${infoPop}</div>
            </div>
          </div>
        </div>
        <div class="ch-plot-viewport">
          <div class="ch-plot-stage">${svg}</div>
          <canvas class="ch-marks" id="ch-marks" aria-hidden="true"></canvas>
        </div>
        <div class="ch-tip" id="ch-tip" hidden></div>
      </div>`;

    resetPlotView();
    applyPlotTransform();
    bindMarksResize();
    scheduleDrawMarks();

    detailsEl.innerHTML = detailsHtml(model);
  }

  // ---- plot zoom / pan (same controls as radar canvases) ------------------

  function plotRoot() {
    return canvasEl.querySelector('#ch-plot');
  }

  function plotViewport() {
    return canvasEl.querySelector('.ch-plot-viewport');
  }

  function plotStage() {
    return canvasEl.querySelector('.ch-plot-stage');
  }

  function resetPlotView() {
    plotZoom = MIN_ZOOM;
    plotPanX = 0;
    plotPanY = 0;
    panning = false;
    panBtn = -1;
  }

  function marksCanvas() {
    return canvasEl.querySelector('#ch-marks');
  }

  function bindMarksResize() {
    marksResizeObs?.disconnect();
    const viewport = plotViewport();
    if (!viewport || typeof ResizeObserver !== 'function') return;
    marksResizeObs = new ResizeObserver(() => scheduleDrawMarks());
    marksResizeObs.observe(viewport);
  }

  /** Map viewBox → CSS pixels inside the untransformed SVG box. */
  function viewBoxToBase(vx, vy) {
    const stage = plotStage();
    const svg = stage?.querySelector('svg');
    if (!svg) return { x: 0, y: 0 };
    const baseW = svg.clientWidth || 0;
    const baseH = svg.clientHeight || 0;
    const s = Math.min(baseW / plotView.w, baseH / plotView.h);
    const ox = (baseW - plotView.w * s) / 2;
    const oy = (baseH - plotView.h * s) / 2;
    return { x: ox + vx * s, y: oy + vy * s };
  }

  function markScreenPos(m) {
    const base = viewBoxToBase(m.x, m.y);
    return {
      x: plotPanX + plotZoom * base.x,
      y: plotPanY + plotZoom * base.y
    };
  }

  function scheduleDrawMarks() {
    if (marksDrawPending) return;
    marksDrawPending = requestAnimationFrame(() => {
      marksDrawPending = 0;
      drawMarks();
    });
  }

  function drawMarks() {
    const canvas = marksCanvas();
    const viewport = plotViewport();
    if (!canvas || !viewport) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w < 2 || h < 2) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < plotMarks.length; i++) {
      const m = plotMarks[i];
      const { x, y } = markScreenPos(m);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      const hot = i === hotMark;
      const r = hot ? MARK_R_HOT : MARK_R;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.globalAlpha = hot ? 1 : 0.82;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hot ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,20,0.9)';
      ctx.stroke();
    }
  }

  function hitTestMark(clientX, clientY) {
    const viewport = plotViewport();
    if (!viewport || !plotMarks.length) return -1;
    const rect = viewport.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const hitR = MARK_R_HOT + 2;
    const hitR2 = hitR * hitR;
    let best = -1;
    let bestD = hitR2;
    for (let i = 0; i < plotMarks.length; i++) {
      const { x, y } = markScreenPos(plotMarks[i]);
      const dx = x - mx;
      const dy = y - my;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function applyPlotTransform() {
    const stage = plotStage();
    const plot = plotRoot();
    if (!stage || !plot) return;
    stage.style.transform = `translate(${plotPanX}px, ${plotPanY}px) scale(${plotZoom})`;
    plot.classList.toggle('can-pan', plotZoom > MIN_ZOOM);
    plot.classList.toggle('panning', panning);
    scheduleDrawMarks();
  }

  function setPlotZoom(next, clientX, clientY) {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    const viewport = plotViewport();
    if (!viewport) {
      plotZoom = z;
      if (z <= MIN_ZOOM) {
        plotPanX = 0;
        plotPanY = 0;
      }
      applyPlotTransform();
      return;
    }
    if (z === plotZoom) {
      if (z <= MIN_ZOOM) {
        plotPanX = 0;
        plotPanY = 0;
        applyPlotTransform();
      }
      return;
    }
    if (z <= MIN_ZOOM) {
      plotZoom = MIN_ZOOM;
      plotPanX = 0;
      plotPanY = 0;
    } else if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const rect = viewport.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const contentX = (mx - plotPanX) / plotZoom;
      const contentY = (my - plotPanY) / plotZoom;
      plotZoom = z;
      plotPanX = mx - contentX * plotZoom;
      plotPanY = my - contentY * plotZoom;
    } else {
      plotZoom = z;
    }
    applyPlotTransform();
  }

  canvasEl.addEventListener(
    'wheel',
    (e) => {
      const plot = plotRoot();
      if (!plot || !plot.contains(e.target)) return;
      if (e.target.closest('.ch-info, .ch-plot-chrome, button, label')) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setPlotZoom(plotZoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  canvasEl.addEventListener('pointerdown', (e) => {
    const plot = plotRoot();
    if (!plot || !plot.contains(e.target)) return;
    if (e.target.closest('.ch-info, button, label, .ch-plot-chrome')) return;
    const isPanBtn = e.button === 0 || e.button === 1;
    if (!isPanBtn || plotZoom <= MIN_ZOOM) return;
    panning = true;
    panBtn = e.button;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    setHotIndex(-1);
    plot.classList.add('panning');
    plot.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvasEl.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const dx = e.clientX - lastPanX;
    const dy = e.clientY - lastPanY;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    plotPanX += dx;
    plotPanY += dy;
    applyPlotTransform();
  });

  const endPlotPan = (e) => {
    if (!panning) return;
    if (e.button !== undefined && e.button !== panBtn && e.type === 'pointerup') return;
    panning = false;
    panBtn = -1;
    plotRoot()?.classList.remove('panning');
    try {
      plotRoot()?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  canvasEl.addEventListener('pointerup', endPlotPan);
  canvasEl.addEventListener('pointercancel', endPlotPan);
  canvasEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  // ---- events (filters / options) ----------------------------------------

  function filterFor(scope) {
    if (scope === 'x') return state.x.filter;
    if (scope === 'y') return state.y.filter;
    return state.filter;
  }

  /** @type {{ current: number }} */
  const changeTokenRef = { current: 0 };

  function afterChange({ rebuildSide = true } = {}) {
    syncModeTabs();
    // Keep the side chrome when only the plot changes; always yield so a
    // sidebar click can interrupt mid-recompute.
    if (rebuildSide) {
      canvasEl.setAttribute('aria-busy', 'true');
      canvasEl.innerHTML = spinnerHtml('Updating…');
    } else {
      canvasEl.setAttribute('aria-busy', 'true');
    }
    void scheduleUiJob({
      tokenRef: changeTokenRef,
      work(token) {
        if (changeTokenRef.current !== token) return;
        if (rebuildSide) renderSide();
        renderCanvas();
        canvasEl.removeAttribute('aria-busy');
        savedViews.touch();
      }
    });
  }

  function placeDdMenu(details) {
    const menu = details?.querySelector?.('.ch-dd-menu');
    const summary = details?.querySelector?.('summary');
    if (!menu || !summary) return;
    const r = summary.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.minWidth = `${Math.round(Math.max(r.width, 180))}px`;
  }

  function closeDdMenus(except = null) {
    for (const d of sideEl.querySelectorAll('details.ch-dd[open]')) {
      if (except && d === except) continue;
      d.removeAttribute('open');
    }
  }

  function setCompareMode(on) {
    state.compare.on = Boolean(on);
    state.type = 'scatter';
    syncModeTabs();
    afterChange();
  }

  pageHeadEl.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-ch-mode]')?.dataset?.chMode;
    if (mode === 'graph') setCompareMode(false);
    else if (mode === 'compare') setCompareMode(true);
  });

  sideEl.addEventListener('toggle', (e) => {
    const details = e.target.closest?.('details.ch-dd');
    if (!details || e.target !== details) return;
    if (details.open) {
      closeDdMenus(details);
      placeDdMenu(details);
    }
  }, true);

  sideEl.addEventListener('click', (e) => {
    const gear = e.target.closest('[data-axis-gear]');
    if (gear) {
      const scope = gear.dataset.axisGear;
      if (scope === 'x' || scope === 'y') {
        axisFilterOpen[scope] = !axisFilterOpen[scope];
        afterChange();
      }
      return;
    }
    const sideBtn = e.target.closest('[data-side-seg]');
    if (sideBtn) {
      const scope = sideBtn.dataset.sideSeg;
      const val = String(sideBtn.dataset.value || '');
      const f = filterFor(scope);
      const cur = String((f.sides || [])[0] || '');
      f.sides = cur === val ? [] : [val];
      afterChange();
      return;
    }
    const comparePick = e.target.closest('[data-compare-pick]');
    if (comparePick) {
      const [kind, id] = String(comparePick.dataset.comparePick || '').split('|');
      const slotEl = comparePick.closest('[data-compare-slot]');
      const slot = slotEl?.dataset.compareSlot === 'b' ? 'b' : 'a';
      if ((kind === 'team' || kind === 'player') && id) {
        if (!state.compare[slot]) state.compare[slot] = emptyCompareSlot();
        state.compare[slot] = { ...state.compare[slot], kind, id, matches: [] };
        compareSearch[slot] = '';
        compareMenuOpen[slot] = false;
        afterChange();
      }
      return;
    }
    const compareClear = e.target.closest('[data-compare-clear]');
    if (compareClear) {
      const slot = compareClear.dataset.compareClear === 'b' ? 'b' : 'a';
      if (!state.compare[slot]) state.compare[slot] = emptyCompareSlot();
      state.compare[slot] = emptyCompareSlot();
      compareSearch[slot] = '';
      compareMenuOpen[slot] = false;
      afterChange();
      return;
    }
    const entityPick = e.target.closest('[data-entity-pick]');
    if (entityPick) {
      const [scope, kind, id] = String(entityPick.dataset.entityPick || '').split('|');
      if ((scope === 'g' || scope === 'x' || scope === 'y') && (kind === 'team' || kind === 'player') && id) {
        const f = filterFor(scope);
        if (kind === 'team') {
          const cur = [...(f.teams || [])].map(String);
          if (!cur.includes(id)) cur.push(id);
          f.teams = cur;
        } else {
          const cur = [...(f.players || [])].map(String);
          if (!cur.includes(id)) cur.push(id);
          f.players = cur;
        }
        filterEntitySearch[scope] = '';
        filterEntityMenuOpen[scope] = false;
        afterChange();
      }
      return;
    }
    const entityRemove = e.target.closest('[data-entity-remove]');
    if (entityRemove) {
      const [scope, kind, id] = String(entityRemove.dataset.entityRemove || '').split('|');
      if ((scope === 'g' || scope === 'x' || scope === 'y') && id) {
        const f = filterFor(scope);
        if (kind === 'team') f.teams = (f.teams || []).map(String).filter((x) => x !== id);
        else f.players = (f.players || []).map(String).filter((x) => x !== id);
        afterChange();
      }
      return;
    }
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      const scope = clear.dataset.clear;
      if (scope === 'g') state.filter = emptyFilter();
      else if (scope === 'x') state.x.filter = {};
      else state.y.filter = {};
      afterChange();
      return;
    }
    const compareMap = e.target.closest('[data-compare-map]');
    if (compareMap) {
      const slotKey = compareMap.dataset.compareMap === 'b' ? 'b' : 'a';
      if (!state.compare[slotKey]) state.compare[slotKey] = emptyCompareSlot();
      const slot = state.compare[slotKey];
      const val = String(compareMap.dataset.value || '');
      const cur = [...(slot.maps || [])].map(String);
      const at = cur.indexOf(val);
      if (at >= 0) cur.splice(at, 1);
      else cur.push(val);
      slot.maps = cur;
      if (slot.dateFrom || slot.dateTo) applyCompareDateRange(slotKey);
      else {
        const allowed = new Set(matchesForCompareSlot(slot).map((m) => String(m.id)));
        slot.matches = (slot.matches || []).map(String).filter((id) => allowed.has(id));
      }
      afterChange();
      return;
    }
    const compareCal = e.target.closest('[data-compare-calendar]');
    if (compareCal) {
      const slotKey = compareCal.dataset.compareCalendar === 'b' ? 'b' : 'a';
      compareCalendarOpen[slotKey] = !compareCalendarOpen[slotKey];
      const other = slotKey === 'a' ? 'b' : 'a';
      compareCalendarOpen[other] = false;
      afterChange();
      return;
    }
    const compareMatch = e.target.closest('[data-compare-match]');
    if (compareMatch) {
      const slotKey = compareMatch.dataset.compareMatch === 'b' ? 'b' : 'a';
      if (!state.compare[slotKey]) state.compare[slotKey] = emptyCompareSlot();
      const slot = state.compare[slotKey];
      const val = String(compareMatch.dataset.value || '');
      const cur = [...(slot.matches || [])].map(String);
      const at = cur.indexOf(val);
      if (at >= 0) cur.splice(at, 1);
      else cur.push(val);
      slot.matches = cur;
      afterChange();
      return;
    }
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const [scope, key] = chip.dataset.chip.split('|');
      const val = chip.dataset.value;
      const f = filterFor(scope);
      const cur = [...(f[key] || [])].map(String);
      const at = cur.indexOf(String(val));
      if (at >= 0) cur.splice(at, 1);
      else cur.push(String(val));
      f[key] = key === 'econ' || key === 'oppEcon' ? cur.map(Number) : cur;
      if (key === 'maps') {
        afterChange();
        return;
      }
      chip.classList.toggle('on', at < 0);
      chip.setAttribute('aria-pressed', at < 0 ? 'true' : 'false');
      afterChange({ rebuildSide: false });
      return;
    }
    const exclusive = e.target.closest('[data-exclusive-chip]');
    if (exclusive) {
      const [scope, key] = exclusive.dataset.exclusiveChip.split('|');
      const val = exclusive.dataset.value;
      const f = filterFor(scope);
      f[key] = String(f[key] || '') === String(val) ? '' : String(val);
      afterChange();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!sideEl.contains(e.target)) {
      closeDdMenus();
      if (compareCalendarOpen.a || compareCalendarOpen.b) {
        compareCalendarOpen = { a: false, b: false };
        afterChange();
      }
      return;
    }
    if (!e.target.closest?.('.ch-date-wrap')) {
      if (compareCalendarOpen.a || compareCalendarOpen.b) {
        compareCalendarOpen = { a: false, b: false };
        afterChange();
      }
    }
  });
  window.addEventListener(
    'scroll',
    () => {
      for (const d of sideEl.querySelectorAll('details.ch-dd[open]')) placeDdMenu(d);
    },
    true
  );

  sideEl.addEventListener('input', (e) => {
    const slot = e.target.dataset?.compareSearch;
    if (slot === 'a' || slot === 'b') {
      compareSearch[slot] = e.target.value;
      compareMenuOpen[slot] = true;
      refreshCompareMenu(slot);
      return;
    }
    const scope = e.target.dataset?.entitySearch;
    if (scope === 'g' || scope === 'x' || scope === 'y') {
      filterEntitySearch[scope] = e.target.value;
      filterEntityMenuOpen[scope] = true;
      refreshFilterEntityMenu(scope);
    }
  });

  sideEl.addEventListener('focusin', (e) => {
    const slot = e.target.dataset?.compareSearch;
    if (slot === 'a' || slot === 'b') {
      compareMenuOpen[slot] = true;
      refreshCompareMenu(slot);
      return;
    }
    const scope = e.target.dataset?.entitySearch;
    if (scope === 'g' || scope === 'x' || scope === 'y') {
      filterEntityMenuOpen[scope] = true;
      refreshFilterEntityMenu(scope);
    }
  });

  document.addEventListener('click', (e) => {
    if (!sideEl.contains(e.target)) {
      let changed = false;
      for (const slot of ['a', 'b']) {
        if (compareMenuOpen[slot]) {
          compareMenuOpen[slot] = false;
          refreshCompareMenu(slot);
          changed = true;
        }
      }
      for (const scope of ['g', 'x', 'y']) {
        if (filterEntityMenuOpen[scope]) {
          filterEntityMenuOpen[scope] = false;
          refreshFilterEntityMenu(scope);
          changed = true;
        }
      }
      return;
    }
    const inCompare = e.target.closest?.('[id^="ch-compare-typeahead-"]');
    if (!inCompare) {
      for (const slot of ['a', 'b']) {
        if (compareMenuOpen[slot]) {
          compareMenuOpen[slot] = false;
          refreshCompareMenu(slot);
        }
      }
    }
    const inFilter = e.target.closest?.('[id^="ch-entity-typeahead-"]');
    if (!inFilter) {
      for (const scope of ['g', 'x', 'y']) {
        if (filterEntityMenuOpen[scope]) {
          filterEntityMenuOpen[scope] = false;
          refreshFilterEntityMenu(scope);
        }
      }
    }
  });

  function onBuilderChange(e) {
    const t = e.target;
    if (t.matches('[data-compare-match-check]')) {
      const slotKey = t.dataset.compareMatchCheck === 'b' ? 'b' : 'a';
      if (!state.compare[slotKey]) state.compare[slotKey] = emptyCompareSlot();
      const boxes = [
        ...sideEl.querySelectorAll(`input[type="checkbox"][data-compare-match-check="${slotKey}"]`)
      ];
      state.compare[slotKey].matches = boxes.filter((b) => b.checked).map((b) => b.value);
      const details = t.closest('details.ch-dd');
      const summary = details?.querySelector('summary');
      if (summary) {
        const n = state.compare[slotKey].matches.length;
        summary.textContent =
          n === 0
            ? 'Games'
            : n === 1
              ? boxes.find((b) => b.checked)?.parentElement?.querySelector('span')?.textContent ||
                '1 game'
              : `${n} games`;
      }
      afterChange({ rebuildSide: false });
      return;
    }
    if (t.matches('[data-compare-date]')) {
      const [slotKey, which] = String(t.dataset.compareDate || '').split('|');
      if (slotKey !== 'a' && slotKey !== 'b') return;
      if (!state.compare[slotKey]) state.compare[slotKey] = emptyCompareSlot();
      if (which === 'from') state.compare[slotKey].dateFrom = t.value || '';
      if (which === 'to') state.compare[slotKey].dateTo = t.value || '';
      applyCompareDateRange(slotKey);
      afterChange();
      return;
    }
    if (t.matches('[data-chip-check]')) {
      const [scope, key] = t.dataset.chipCheck.split('|');
      const f = filterFor(scope);
      const boxes = [
        ...sideEl.querySelectorAll(`input[type="checkbox"][data-chip-check="${scope}|${key}"]`)
      ];
      const cur = boxes.filter((b) => b.checked).map((b) => b.value);
      f[key] = key === 'econ' || key === 'oppEcon' ? cur.map(Number) : cur;
      const details = t.closest('details.ch-dd');
      const summary = details?.querySelector('summary');
      if (summary) {
        const opts = boxes.map((b) => ({
          key: b.value,
          label: b.parentElement?.querySelector('span')?.textContent || b.value
        }));
        const emptyLabels = {
          maps: 'Map',
          roles: 'Role',
          econ: 'Own buy',
          oppEcon: 'Enemy buy',
          killKinds: 'Kill type',
          phases: 'Phase',
          weapons: 'Weapons'
        };
        summary.textContent = summaryLabel(opts, cur, emptyLabels[key] || 'Selected');
      }
      afterChange({ rebuildSide: key === 'maps' });
      return;
    }
    if (t.matches('[data-toggle]')) {
      state[t.dataset.toggle] = Boolean(t.checked);
      afterChange({ rebuildSide: false });
      return;
    }
    if (t.matches('[data-flag]')) {
      const [scope, key] = t.dataset.flag.split('|');
      filterFor(scope)[key] = Boolean(t.checked);
      t.closest?.('.rp-awp-toggle')?.classList.toggle('active', t.checked);
      t.closest?.('.ch-switch-btn')?.classList.toggle('active', t.checked);
      afterChange({ rebuildSide: false });
      return;
    }
    if (t.matches('[data-subject]')) {
      state.subject = t.value;
      const src = source();
      state.y.metric = findMetric(src, state.y.metric).key;
      state.x.metric = findMetric(src, state.x.metric).key;
      if (state.series && !seriesFor(src).some((d) => d.key === state.series)) state.series = '';
      afterChange();
      return;
    }
    if (t.matches('[data-metric-pick]')) {
      const scope = t.dataset.metricPick;
      if ((scope === 'x' || scope === 'y') && t.value) {
        state[scope].metric = t.value;
        closeDdMenus();
        afterChange();
      }
      return;
    }
    if (t.matches('[data-series]')) {
      state.series = t.value;
      afterChange({ rebuildSide: false });
      return;
    }
    if (t.matches('[data-opt]')) {
      state[t.dataset.opt] = Math.max(0, Number(t.value) || 0);
      afterChange({ rebuildSide: false });
      return;
    }
    if (t.matches('[data-num]')) {
      const [scope, key] = t.dataset.num.split('|');
      const raw = t.value === '' ? null : Number(t.value);
      filterFor(scope)[key] = raw === null || Number.isNaN(raw) ? null : raw;
      afterChange({ rebuildSide: false });
    }
  }

  sideEl.addEventListener('change', onBuilderChange);
  canvasEl.addEventListener('change', onBuilderChange);

  // ---- hover / save -------------------------------------------------------

  canvasEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-save]') || !lastModel) return;
    const svg = canvasEl.querySelector('svg');
    if (!svg) return;
    let markup = svg.outerHTML;
    // Scatter marks live on the canvas; bake them into the export.
    if (plotMarks.length) {
      markup = markup.replace(
        /<\/svg>\s*$/i,
        `${marksToSvgCircles(plotMarks, MARK_R)}</svg>`
      );
    }
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], {
      type: 'image/svg+xml'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aim4-chart.svg';
    a.click();
    URL.revokeObjectURL(url);
  });

  function hideTip() {
    hotMark = -1;
    const tip = canvasEl.querySelector('#ch-tip');
    if (tip) tip.hidden = true;
    scheduleDrawMarks();
  }

  function showTipAtIndex(i) {
    const tip = canvasEl.querySelector('#ch-tip');
    const plot = canvasEl.querySelector('#ch-plot');
    const viewport = plotViewport();
    if (!tip || !plot || !viewport || i < 0) return;
    const data = hoverPoints[i];
    const mark = plotMarks[i];
    if (!data || !mark) return;
    tip.innerHTML = `<strong>${escapeHtml(data.title)}</strong>${
      data.sub ? `<span class="ch-tip-sub">${escapeHtml(data.sub)}</span>` : ''
    }${data.rows
      .map(
        ([k, v]) =>
          `<span class="ch-tip-row"><em>${escapeHtml(k)}</em><b>${escapeHtml(v)}</b></span>`
      )
      .join('')}`;
    tip.hidden = false;
    const { x: sx, y: sy } = markScreenPos(mark);
    const vRect = viewport.getBoundingClientRect();
    const host = plot.getBoundingClientRect();
    const x = vRect.left - host.left + sx;
    const y = vRect.top - host.top + sy;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    tip.classList.toggle('flip', x > host.width * 0.6);
  }

  function setHotIndex(i) {
    const next = Number.isFinite(i) ? i : -1;
    if (hotMark === next) {
      if (next >= 0) showTipAtIndex(next);
      return;
    }
    hotMark = next;
    if (next < 0) {
      const tip = canvasEl.querySelector('#ch-tip');
      if (tip) tip.hidden = true;
      scheduleDrawMarks();
      return;
    }
    scheduleDrawMarks();
    showTipAtIndex(next);
  }

  canvasEl.addEventListener('pointermove', (e) => {
    if (panning) return;
    const plot = canvasEl.querySelector('#ch-plot');
    if (!plot || !plot.contains(e.target)) {
      setHotIndex(-1);
      return;
    }
    if (e.target.closest('.ch-plot-chrome, .ch-info, button, label')) {
      setHotIndex(-1);
      return;
    }
    setHotIndex(hitTestMark(e.clientX, e.clientY));
  });

  canvasEl.addEventListener('pointerleave', () => setHotIndex(-1));

  // Mirror macro viewer: kill sticky tips when the pointer leaves the plot
  // into side panels / chrome / another window.
  const onDocPointerMove = (e) => {
    if (!canvasEl.isConnected || hotMark < 0) return;
    const plot = canvasEl.querySelector('#ch-plot');
    if (!plot) return;
    if (plot.contains(e.target)) return;
    setHotIndex(-1);
  };
  document.addEventListener('pointermove', onDocPointerMove);

  detailsEl.addEventListener('pointerover', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const i = Number(row.dataset.row);
    if (Number.isFinite(i)) setHotIndex(i);
  });

  detailsEl.addEventListener('pointerleave', () => setHotIndex(-1));

  // ---- load ---------------------------------------------------------------

  async function load(scope = {}) {
    const token = ++loadToken;
    const key = statsCacheKey(scope.demos || null);
    // Warm revisit: keep the builder, skip another fetch/spend/buildFacts.
    if (
      facts?.playerFacts?.length &&
      factsKey === key &&
      factsGeneration === statsCacheGeneration()
    ) {
      mountPageHead();
      renderSide();
      renderCanvas();
      canvasEl.removeAttribute('aria-busy');
      mountSavedViews();
      void savedViews.applyShareParam(scope.params || {}).then((hit) => {
        if (!hit) savedViews.touch();
      });
      return;
    }
    canvasEl.innerHTML = spinnerHtml('Loading charts…');
    const cancelSlow = watchSlowLoad(canvasEl);
    try {
      // Spending happens when Charts first builds facts for this session scope.
      // Warm revisits return earlier; a Database cache hit still spends once.
      await consumeCapability(CAP.ANALYTICS_CHARTS);
      if (token !== loadToken) {
        cancelSlow();
        return;
      }
      const payload = await getStatsPayload(scope.demos || null, {
        onProgress: (p) => {
          if (token !== loadToken) return;
          setSpinnerLabel(canvasEl, statsProgressLabel(p));
        }
      });
      cancelSlow();
      if (token !== loadToken) return;
      setSpinnerLabel(canvasEl, statsProgressLabel({ phase: 'building-table' }));
      await scheduleUiJob({
        tokenRef: changeTokenRef,
        isCurrent: () => token === loadToken,
        work() {
          if (token !== loadToken) return;
          facts = buildFacts(payload);
          factsKey = key;
          factsGeneration = statsCacheGeneration();
        }
      });
      if (token !== loadToken) return;
      if (!facts?.playerFacts?.length) {
        sideEl.innerHTML = '';
        canvasEl.innerHTML =
          '<p class="view-empty">No parsed rounds to chart yet. Upload a replay first.</p>';
        return;
      }
      state.type = 'scatter';
      mountPageHead();
      renderSide();
      renderCanvas();
      canvasEl.removeAttribute('aria-busy');
      mountSavedViews();
      void savedViews.refresh().then(mountSavedViews);
      // A share link wins over whatever the builder was left on.
      void savedViews.applyShareParam(scope.params || {}).then((hit) => {
        if (!hit) savedViews.touch();
      });
    } catch (err) {
      cancelSlow();
      if (token !== loadToken) return;
      sideEl.innerHTML = '';
      // Spent allowance gets the upgrade prompt with its button, not a
      // dead-end sentence.
      const prompt = err.status === 402 ? renderUpgradeError(err.body) : null;
      canvasEl.innerHTML = '';
      if (prompt) {
        canvasEl.appendChild(prompt);
      } else {
        const msg = formatApiError(err).message || 'Could not load stats.';
        canvasEl.innerHTML = `<p class="view-empty">${escapeHtml(msg)}</p>
          <button type="button" class="btn btn-sm" data-ch-retry>Retry</button>`;
        canvasEl.querySelector('[data-ch-retry]')?.addEventListener('click', () => load(scope));
      }
    }
  }

  return {
    el,
    load,
    mountPageHead,
    destroy() {
      document.removeEventListener('pointermove', onDocPointerMove);
      marksResizeObs?.disconnect();
      marksResizeObs = null;
      if (marksDrawPending) cancelAnimationFrame(marksDrawPending);
      hideTip();
      if (pageHeadEl.isConnected) pageHeadEl.remove();
      el.remove();
    }
  };
}
