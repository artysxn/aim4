// ---------------------------------------------------------------------------
// replays/charts/chartsPanel.js
// The Charts screen: a graph builder over the stats index.
//
// Left side is the spec (chart type, what a point is, both axes with their own
// filters, series split, options, library-wide filters). Right side is the
// vector canvas plus the fit and a details table. Every change re-aggregates
// the cached facts in memory; nothing here refetches.
// ---------------------------------------------------------------------------

import { fetchStats, consumeCapability, formatApiError } from '../api.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { ECONOMIES, MAPS } from '../shared/roundId.js';
import {
  CT_TACTICAL,
  T_TACTICAL,
  positionRoleOptions
} from '../roles/regionKeys.js';
import { buildFacts, emptyFilter } from './chartFacts.js';
import {
  CHART_TYPES,
  SUBJECTS,
  dimensionsFor,
  findDimension,
  findMetric,
  findSubject,
  formatValue,
  metricsFor,
  seriesFor
} from './chartFields.js';
import {
  computeChart,
  correlationWords,
  filterWords,
  normalizeCompareSlot
} from './chartData.js';
import { renderChart } from './chartRender.js';
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

const SOURCES = [
  { key: 'kill', label: 'Kills' },
  { key: 'player', label: 'Player rounds' },
  { key: 'round', label: 'Team rounds' }
];

const SIDES = ['T', 'CT'];
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

  let facts = null;
  let loadToken = 0;
  /** @type {object[]} hover payloads, indexed by the mark's data-i */
  let hoverPoints = [];
  /** @type {Element | null} */
  let hotMark = null;
  let lastModel = null;

  let plotZoom = 1;
  let plotPanX = 0;
  let plotPanY = 0;
  let panning = false;
  let panBtn = -1;
  let lastPanX = 0;
  let lastPanY = 0;

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
      a: { kind: '', id: '', maps: [], matches: [] },
      b: { kind: '', id: '', maps: [], matches: [] }
    }
  };

  let compareSearch = { a: '', b: '' };
  let compareMenuOpen = { a: false, b: false };
  /** @type {Record<string, string>} */
  let filterEntitySearch = { g: '', x: '', y: '' };
  /** @type {Record<string, boolean>} */
  let filterEntityMenuOpen = { g: false, x: false, y: false };

  function emptyCompareSlot() {
    return { kind: '', id: '', maps: [], matches: [] };
  }

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

    const label = hasTeams && hasPlayers ? 'Teams & players' : hasTeams ? 'Teams' : 'Players';

    return group(
      label,
      `<div class="ch-entity-typeahead rp-typeahead" id="ch-entity-typeahead-${scope}">
        ${chips ? `<div class="an-sel-chips">${chips}</div>` : ''}
        <input type="search" class="site-input" data-entity-search="${scope}"
          placeholder="Search teams or players…" spellcheck="false" autocomplete="off"
          value="${escapeHtml(filterEntitySearch[scope] || '')}" aria-label="Search teams or players" />
        <div class="rp-typeahead-menu an-subject-menu" id="ch-entity-menu-${scope}" hidden></div>
      </div>`
    );
  }

  const isScatter = () => state.type === 'scatter';
  const source = () => (isScatter() ? findSubject(state.subject).source : state.source);

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

  function metricSelect(scope, value) {
    const list = metricsFor(source());
    const groups = [...new Set(list.map((m) => m.group))];
    const body = groups
      .map(
        (g) =>
          `<optgroup label="${escapeHtml(g)}">${list
            .filter((m) => m.group === g)
            .map(
              (m) =>
                `<option value="${escapeHtml(m.key)}"${m.key === value ? ' selected' : ''} title="${escapeHtml(
                  m.tip || ''
                )}">${escapeHtml(m.label)}</option>`
            )
            .join('')}</optgroup>`
      )
      .join('');
    return `<select class="site-select" data-metric="${scope}">${body}</select>`;
  }

  function dimensionSelect(value) {
    const list = dimensionsFor(source());
    return selectHtml(
      'data-dimension="x"',
      list.map((d) => ({ key: d.key, label: d.label })),
      list.some((d) => d.key === value) ? value : list[0]?.key
    );
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

  /** Single-choice chips: click selects, click the active one clears to Any. */
  function exclusiveChips(scope, key, options, value) {
    return `<div class="ch-chips" role="group">${options
      .map((o) => {
        const on = String(value || '') === String(o.key);
        return `<button type="button" class="ch-chip${on ? ' on' : ''}" data-exclusive-chip="${scope}|${key}" data-value="${escapeHtml(
          String(o.key)
        )}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(o.label)}</button>`;
      })
      .join('')}</div>`;
  }

  const group = (label, body, extra = '') =>
    `<div class="ch-group${extra ? ` ${extra}` : ''}"><span class="ch-label">${escapeHtml(
      label
    )}</span>${body}</div>`;

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
        : group(
            'Measure',
            checkFlag(scope, 'perRound', 'Divide by played rounds', Boolean(f.perRound))
          ),
      maps.length > 1 && !(scope === 'g' && state.compare?.on)
        ? group('Map', multiSelect(scope, 'maps', maps, arr('maps')))
        : '',
      group(
        'Side',
        multiSelect(
          scope,
          'sides',
          SIDES.map((s) => ({ key: s, label: s })),
          arr('sides')
        )
      ),
      src === 'player' || src === 'kill'
        ? group('Role', multiSelect(scope, 'roles', roleFilterOptions(f), arr('roles')))
        : '',
      group(
        'Own buy',
        `${multiSelect(scope, 'econ', econOpts, arr('econ'))}${checkFlag(
          scope,
          'hasAwp',
          'Has AWP',
          Boolean(f.hasAwp)
        )}`
      ),
      group(
        'Enemy buy',
        `${multiSelect(scope, 'oppEcon', econOpts, arr('oppEcon'))}${checkFlag(
          scope,
          'oppHasAwp',
          'Has AWP',
          Boolean(f.oppHasAwp)
        )}`
      ),
      group(
        'Round',
        `<div class="ch-select-stack">
          ${exclusiveChips(
            scope,
            'result',
            [
              { key: 'won', label: 'Won' },
              { key: 'lost', label: 'Lost' }
            ],
            f.result || ''
          )}
          ${exclusiveChips(
            scope,
            'opening',
            [
              { key: '5v4', label: '5v4' },
              { key: '4v5', label: '4v5' },
              { key: 'even', label: 'Even' }
            ],
            f.opening || ''
          )}
          ${exclusiveChips(
            scope,
            'half',
            [
              { key: '1', label: '1st half' },
              { key: '2', label: '2nd half' }
            ],
            f.half || ''
          )}
        </div>`
      ),
      group(
        'Round number',
        `<div class="ch-range"><input class="site-input" type="number" min="1" max="99" placeholder="from" value="${
          f.roundFrom ?? ''
        }" data-num="${scope}|roundFrom" /><input class="site-input" type="number" min="1" max="99" placeholder="to" value="${
          f.roundTo ?? ''
        }" data-num="${scope}|roundTo" /></div>`
      ),
      killable
        ? group('Kill type', multiSelect(scope, 'killKinds', KILL_KINDS, arr('killKinds')))
        : '',
      killable ? group('Phase', multiSelect(scope, 'phases', PHASES, arr('phases'))) : '',
      killable
        ? group(
            'Time in round',
            `<div class="ch-range"><input class="site-input" type="number" step="1" placeholder="from s" value="${
              f.timeFrom ?? ''
            }" data-num="${scope}|timeFrom" /><input class="site-input" type="number" step="1" placeholder="to s" value="${
              f.timeTo ?? ''
            }" data-num="${scope}|timeTo" /></div>`
          )
        : '',
      facts?.teams?.length || (facts?.players?.length && !(scope === 'g' && state.compare?.on))
        ? entityFilterHtml(scope, f)
        : '',
      facts?.matches?.length > 1 && !(scope === 'g' && state.compare?.on)
        ? group(
            'Matches',
            multiSelect(
              scope,
              'matches',
              facts.matches.map((m) => ({ key: m.id, label: m.label })),
              arr('matches')
            )
          )
        : '',
      killable && facts?.weapons?.length
        ? group(
            'Weapons',
            multiSelect(
              scope,
              'weapons',
              facts.weapons.slice(0, 40).map((w) => ({ key: w, label: w })),
              arr('weapons')
            )
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

  function compareSlotHtml(slot) {
    const s = state.compare[slot] || emptyCompareSlot();
    const maps = (facts?.maps || []).map((m) => ({ key: m, label: MAPS[m]?.name || m }));
    const selMaps = new Set((s.maps || []).map(String));
    const matchOpts = matchesForCompareSlot(s);
    const selMatches = new Set((s.matches || []).map(String));
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
            ? `<div class="ch-compare-games">
                <span class="ch-label">Games${selMatches.size ? ` (${selMatches.size})` : ''}</span>
                <div class="ch-chips ch-compare-match-chips" role="group" title="Optional: limit this side to specific games. None selected means all.">
                  ${matchOpts
                    .map((m) => {
                      const on = selMatches.has(String(m.id));
                      return `<button type="button" class="ch-chip${on ? ' on' : ''}" data-compare-match="${slot}" data-value="${escapeHtml(
                        String(m.id)
                      )}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(m.label)}</button>`;
                    })
                    .join('')}
                </div>
              </div>`
            : entity
              ? `<p class="ch-hint">No games for this selection with the current maps.</p>`
              : ''
        }
      </div>`;
  }

  function compareHtml() {
    const on = Boolean(state.compare?.on);
    return `
      <div class="ch-block">
        <span class="ch-label">Compare</span>
        <label class="ch-check">
          <input type="checkbox" data-compare-on${on ? ' checked' : ''} />
          A vs B
        </label>
        ${
          on
            ? `<div class="ch-compare-slots">
                ${compareSlotHtml('a')}
                ${compareSlotHtml('b')}
              </div>`
            : ''
        }
      </div>`;
  }

  function renderSide() {
    const src = source();
    const seriesOpts = seriesFor(src).map((d) => ({ key: d.key, label: d.label }));
    const dim = isScatter() ? null : findDimension(src, state.x.dimension);
    const stepOpts = (dim?.steps || []).map((s) => ({ key: String(s), label: `${s}${dim.unit || ''}` }));
    const comparing = Boolean(state.compare?.on);

    sideEl.innerHTML = `
      <div class="ch-block ch-saved" id="ch-saved"></div>
      <div class="ch-block">
        <span class="ch-label">Chart</span>
        ${selectHtml(
          'data-type-select',
          CHART_TYPES.map((t) => ({ key: t.key, label: t.label })),
          state.type
        )}
        ${
          isScatter()
            ? group(
                'One point is',
                selectHtml(
                  'data-subject',
                  SUBJECTS.map((s) => ({ key: s.key, label: s.label })),
                  state.subject
                )
              )
            : group(
                'Measured over',
                selectHtml(
                  'data-source',
                  SOURCES.map((s) => ({ key: s.key, label: s.label })),
                  state.source
                )
              )
        }
      </div>

      ${compareHtml()}

      <div class="ch-block">
        <span class="ch-label">Y axis</span>
        ${metricSelect('y', state.y.metric)}
        <details class="ch-axis-filter"${filterWords(state.y.filter).length ? ' open' : ''}>
          <summary>Y filters${
            filterWords(state.y.filter).length ? ` (${escapeHtml(filterWords(state.y.filter).join(', '))})` : ''
          }</summary>
          ${filterHtml('y', state.y.filter)}
        </details>
      </div>

      <div class="ch-block">
        <span class="ch-label">X axis</span>
        ${isScatter() ? metricSelect('x', state.x.metric) : dimensionSelect(state.x.dimension)}
        ${
          !isScatter() && stepOpts.length > 1
            ? group('Bin width', selectHtml('data-step', stepOpts, String(state.binStep)))
            : ''
        }
        ${
          isScatter()
            ? `<details class="ch-axis-filter"${
                filterWords(state.x.filter).length ? ' open' : ''
              }><summary>X filters${
                filterWords(state.x.filter).length
                  ? ` (${escapeHtml(filterWords(state.x.filter).join(', '))})`
                  : ''
              }</summary>${filterHtml('x', state.x.filter)}</details>`
            : ''
        }
      </div>

      <div class="ch-block"${comparing ? ' hidden' : ''}>
        <span class="ch-label">Split into series</span>
        ${selectHtml('data-series', seriesOpts, state.series, { placeholder: 'No split' })}
      </div>

      <div class="ch-block">
        <span class="ch-label">Options</span>
        <div class="ch-select-stack">
          <label class="ch-check"><input type="checkbox" data-toggle="trendline"${
            state.trendline ? ' checked' : ''
          } /> Trendline</label>
          ${
            isScatter()
              ? ''
              : `<label class="ch-check"><input type="checkbox" data-toggle="normalize"${
                  state.normalize ? ' checked' : ''
                } /> As share %</label>`
          }
        </div>
        <div class="ch-range">
          <label class="ch-mini">Min rounds<input class="site-input" type="number" min="0" value="${
            state.minRounds
          }" data-opt="minRounds" /></label>
          ${
            isScatter()
              ? ''
              : `<label class="ch-mini">Max groups<input class="site-input" type="number" min="2" value="${state.maxCats}" data-opt="maxCats" /></label>`
          }
        </div>
      </div>

      <div class="ch-block">
        <span class="ch-label">Filters for the whole chart</span>
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

  function detailsHtml(model) {
    if (model.kind === 'scatter') {
      const rows = model.points
        .slice(0, 40)
        .map(
          (p, i) =>
            `<tr data-row="${i}"><td class="ch-name">${escapeHtml(p.name)}</td><td>${escapeHtml(
              p.sub || p.seriesLabel || ''
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
    hotMark = null;
    let model;
    try {
      model = computeChart(state, facts);
    } catch (err) {
      canvasEl.innerHTML = `<p class="view-empty">${escapeHtml(err.message || 'Could not build that chart.')}</p>`;
      detailsEl.innerHTML = '';
      return;
    }
    lastModel = model;

    const { svg, points } = renderChart(model, { trendline: state.trendline });
    hoverPoints = points;
    if (!svg) {
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
      <div class="ch-head">
        <h3 class="ch-title">${escapeHtml(chartTitle(model))}</h3>
        <button type="button" class="btn btn-sm" data-save>Save SVG</button>
      </div>
      <div class="ch-plot" id="ch-plot">
        <div class="ch-plot-viewport">
          <div class="ch-plot-stage">${svg}</div>
        </div>
        <div class="ch-tip" id="ch-tip" hidden></div>
        <div class="ch-info">
          <button type="button" class="ch-info-btn" aria-label="Chart fit details">i</button>
          <div class="ch-info-pop" role="tooltip">${infoPop}</div>
        </div>
      </div>`;

    resetPlotView();
    applyPlotTransform();

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

  function applyPlotTransform() {
    const stage = plotStage();
    const plot = plotRoot();
    if (!stage || !plot) return;
    stage.style.transform = `translate(${plotPanX}px, ${plotPanY}px) scale(${plotZoom})`;
    plot.classList.toggle('can-pan', plotZoom > MIN_ZOOM);
    plot.classList.toggle('panning', panning);
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
      if (e.target.closest('.ch-info, .ch-head, button')) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setPlotZoom(plotZoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  canvasEl.addEventListener('pointerdown', (e) => {
    const plot = plotRoot();
    if (!plot || !plot.contains(e.target)) return;
    if (e.target.closest('.ch-info, button, .ch-head')) return;
    const isPanBtn = e.button === 0 || e.button === 1;
    if (!isPanBtn || plotZoom <= MIN_ZOOM) return;
    panning = true;
    panBtn = e.button;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    setHotMark(null);
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

  function afterChange({ rebuildSide = true } = {}) {
    if (rebuildSide) renderSide();
    renderCanvas();
    savedViews.touch();
  }

  function applyChartType(type) {
    state.type = type;
    const src = source();
    state.y.metric = findMetric(src, state.y.metric).key;
    state.x.metric = findMetric(src, state.x.metric).key;
    const dim = findDimension(src, state.x.dimension);
    state.x.dimension = dim?.key || '';
    state.binStep = dim?.step || 1;
    if (state.series && !seriesFor(src).some((d) => d.key === state.series)) state.series = '';
    afterChange();
  }

  sideEl.addEventListener('click', (e) => {
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
      const allowed = new Set(matchesForCompareSlot(slot).map((m) => String(m.id)));
      slot.matches = (slot.matches || []).map(String).filter((id) => allowed.has(id));
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
      // Map chips reshape the Role list; rebuild so options stay in sync.
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

  sideEl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-compare-on]')) {
      state.compare.on = Boolean(t.checked);
      afterChange();
      return;
    }
    if (t.matches('[data-type-select]')) {
      applyChartType(t.value);
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
    if (t.matches('[data-source]')) {
      state.source = t.value;
      const src = source();
      state.y.metric = findMetric(src, state.y.metric).key;
      const dim = findDimension(src, state.x.dimension);
      state.x.dimension = dim?.key || '';
      state.binStep = dim?.step || 1;
      if (state.series && !seriesFor(src).some((d) => d.key === state.series)) state.series = '';
      afterChange();
      return;
    }
    if (t.matches('[data-metric]')) {
      const scope = t.dataset.metric;
      state[scope].metric = t.value;
      afterChange();
      return;
    }
    if (t.matches('[data-dimension]')) {
      state.x.dimension = t.value;
      const dim = findDimension(source(), t.value);
      state.binStep = dim?.step || 1;
      afterChange();
      return;
    }
    if (t.matches('[data-step]')) {
      state.binStep = Number(t.value) || 1;
      afterChange({ rebuildSide: false });
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
  });

  // ---- hover / save -------------------------------------------------------

  canvasEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-save]') || !lastModel) return;
    const svg = canvasEl.querySelector('svg');
    if (!svg) return;
    const blob = new Blob(
      [`<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`],
      { type: 'image/svg+xml' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aim4-chart.svg';
    a.click();
    URL.revokeObjectURL(url);
  });

  function hideTip() {
    hotMark?.classList.remove('hot');
    hotMark = null;
    const tip = canvasEl.querySelector('#ch-tip');
    if (tip) tip.hidden = true;
  }

  function showTip(mark) {
    const tip = canvasEl.querySelector('#ch-tip');
    const plot = canvasEl.querySelector('#ch-plot');
    if (!tip || !plot) return;
    const data = hoverPoints[Number(mark.dataset.i)];
    if (!data) return;
    tip.innerHTML = `<strong>${escapeHtml(data.title)}</strong>${
      data.sub ? `<span class="ch-tip-sub">${escapeHtml(data.sub)}</span>` : ''
    }${data.rows
      .map(
        ([k, v]) =>
          `<span class="ch-tip-row"><em>${escapeHtml(k)}</em><b>${escapeHtml(v)}</b></span>`
      )
      .join('')}`;
    tip.hidden = false;
    const box = mark.getBoundingClientRect();
    const host = plot.getBoundingClientRect();
    const x = box.left - host.left + box.width / 2;
    const y = box.top - host.top;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    tip.classList.toggle('flip', x > host.width * 0.6);
  }

  function setHotMark(mark) {
    if (hotMark === mark) {
      if (mark) showTip(mark);
      return;
    }
    hotMark?.classList.remove('hot');
    hotMark = mark;
    if (!mark) {
      hideTip();
      return;
    }
    mark.classList.add('hot');
    showTip(mark);
  }

  canvasEl.addEventListener('pointermove', (e) => {
    if (panning) return;
    const plot = canvasEl.querySelector('#ch-plot');
    if (!plot || !plot.contains(e.target)) {
      setHotMark(null);
      return;
    }
    const mark = e.target.closest('[data-i]');
    setHotMark(mark && plot.contains(mark) ? mark : null);
  });

  canvasEl.addEventListener('pointerleave', () => setHotMark(null));

  // Mirror macro viewer: kill sticky tips when the pointer leaves the plot
  // into side panels / chrome / another window.
  const onDocPointerMove = (e) => {
    if (!canvasEl.isConnected || !hotMark) return;
    const plot = canvasEl.querySelector('#ch-plot');
    if (!plot) return;
    if (plot.contains(e.target)) return;
    setHotMark(null);
  };
  document.addEventListener('pointermove', onDocPointerMove);

  detailsEl.addEventListener('pointerover', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const mark = canvasEl.querySelector(`[data-i="${row.dataset.row}"]`);
    if (mark) setHotMark(mark);
  });

  detailsEl.addEventListener('pointerleave', () => setHotMark(null));

  // ---- load ---------------------------------------------------------------

  async function load(scope = {}) {
    const token = ++loadToken;
    canvasEl.innerHTML = spinnerHtml('Loading charts…');
    const cancelSlow = watchSlowLoad(canvasEl);
    try {
      // Spending happens when the chart actually loads data, not when the route
      // opens. Free gets three of these per rolling day.
      await consumeCapability(CAP.ANALYTICS_CHARTS);
      if (token !== loadToken) {
        cancelSlow();
        return;
      }
      const payload = await fetchStats(scope.demos || null, {
        onProgress: (p) => {
          if (token !== loadToken) return;
          setSpinnerLabel(canvasEl, statsProgressLabel(p));
        }
      });
      cancelSlow();
      if (token !== loadToken) return;
      facts = buildFacts(payload);
      if (!facts.playerFacts.length) {
        sideEl.innerHTML = '';
        canvasEl.innerHTML =
          '<p class="view-empty">No parsed rounds to chart yet. Upload a replay first.</p>';
        return;
      }
      if (!facts.hasKillTimes) {
        // Pre-v10 indexes have no kill clock, so start on a chart that works.
        state.type = 'scatter';
      }
      renderSide();
      renderCanvas();
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
    destroy() {
      document.removeEventListener('pointermove', onDocPointerMove);
      hideTip();
      el.remove();
    }
  };
}
