// ---------------------------------------------------------------------------
// Analytics: map-first filters + optional subjects (players / teams) → stats.
// Layout: sticky filter sidebar + main results (stats, radar, LB, rounds).
// ---------------------------------------------------------------------------

import { fetchStats, consumeCapability, formatApiError } from '../api.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { attachTips } from '../stats/statsTables.js';
import {
  ANALYTICS_PLAYER_MAX,
  aggregateAnalyticsAsync,
  leaderboardFromFiles,
  listMaps,
  listPlayers,
  listTeams
} from './analyticsMath.js';
import { createPresenceRadar } from './presenceRadar.js';
import {
  SHAPE_FEATURES,
  loadShapes,
  saveShapes,
  newShapeId
} from './shapeFilters.js';
import { spinnerHtml, watchSlowLoad } from '../../lib/spinner.js';
import { renderUpgradeError } from '../../site/upgradeGate.js';
import { createSavedViews } from '../savedViews.js';

const PHASE_OPTS = [
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

/** Format a finite number for leaderboard cells; `digits` = decimal places. */
function fmt(n, digits = 2) {
  return Number.isFinite(n) ? Number(n).toFixed(digits) : '—';
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
    <div class="an-layout">
      <aside class="an-sidebar" id="an-sidebar"></aside>
      <div class="an-main" id="an-main"><p class="view-empty">Select a map to begin.</p></div>
    </div>`;

  const sidebarEl = el.querySelector('#an-sidebar');
  const mainEl = el.querySelector('#an-main');

  let payload = null;
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
    /** @type {Set<string>} */
    phases: new Set(),
    /** @type {Array<object>} */
    shapes: [],
    /** @type {'all'|'any'|''} */
    shapeMatch: '',
    /** @type {ShapeFeature|''} */
    drawFeature: '',
    /** @type {''|'rect'|'poly'|'lasso'} */
    drawMode: ''
  };

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
      phases: [...state.phases],
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
      state.phases = new Set(Array.isArray(spec.phases) ? spec.phases : []);
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
      phases: state.phases,
      shapes: state.shapes,
      shapeMatch: state.shapeMatch === 'any' ? 'any' : 'all'
    };
  }

  function featureLabel(key) {
    return SHAPE_FEATURES.find((f) => f.key === key)?.label || key;
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
        <select class="site-select an-select" id="an-map" aria-label="Map">
          <option value="">Map</option>
          ${maps
            .map(
              (m) =>
                `<option value="${escapeHtml(m)}"${m === state.map ? ' selected' : ''}>${escapeHtml(
                  MAPS[m]?.name || m
                )}</option>`
            )
            .join('')}
        </select>
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
              ? `<input type="search" class="site-input" id="an-subject-search"
                  placeholder="Search teams or players…" spellcheck="false" autocomplete="off"
                  value="${escapeHtml(subjectSearch)}" aria-label="Search teams or players" />
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
                    const label =
                      s.name ||
                      `${featureLabel(s.feature)} ${s.geometry?.type === 'poly' ? 'poly' : 'rect'} ${
                        i + 1
                      }`;
                    return `<div class="an-shape-row${s.enabled === false ? ' off' : ''}">
                      <button type="button" class="an-shape-toggle" data-shape-toggle="${escapeHtml(
                        s.id
                      )}" title="Toggle">
                        ${s.enabled === false ? '○' : '●'} ${escapeHtml(label)}
                      </button>
                      <button type="button" class="an-shape-del" data-shape-del="${escapeHtml(
                        s.id
                      )}" aria-label="Remove">×</button>
                    </div>`;
                  })
                  .join('')
              : `<p class="an-muted an-shape-empty">No selections yet</p>`
          }
        </div>

        <button type="button" class="btn btn-sm an-clear" data-an-clear>Clear filters</button>
      </div>`;

    if (subjectMenuOpen || subjectSearch) refreshSubjectMenu();
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

  function renderLeaderboard(rows, focusIds, roundCount) {
    if (!rows.length) {
      return `<section class="an-card"><p class="view-empty">No players on matching rounds.</p></section>`;
    }
    const focus = new Set(focusIds || []);
    const top = rows.slice(0, 40);
    return `<section class="an-card an-lb">
      <header class="an-card-head">
        <h3 class="an-section-title">Leaderboard <small>${roundCount} rounds</small></h3>
      </header>
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
            ${top
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

  function renderRounds(agg) {
    /** @type {Map<string, { file: string, demoId: string, round: number, phases: Set<string> }>} */
    const byFile = new Map();
    if (agg.windows?.length) {
      for (const w of agg.windows) {
        let g = byFile.get(w.file);
        if (!g) {
          g = { file: w.file, demoId: w.demoId, round: w.round, phases: new Set() };
          byFile.set(w.file, g);
        }
        g.phases.add(w.phase);
      }
    } else {
      for (const file of agg.files || []) {
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
          state.shapes.push({
            id: newShapeId(),
            map: state.map,
            name: '',
            feature: state.drawFeature && state.drawFeature !== 'any' ? state.drawFeature : 'player_in',
            geometry,
            enabled: true
          });
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

  async function renderMain() {
    if (!state.map) {
      rememberRadarView();
      mainEl.innerHTML = `<p class="view-empty">Select a map in the sidebar. Subjects are optional — leave empty to search anyone.</p>`;
      return;
    }
    if (!payload) {
      rememberRadarView();
      mainEl.innerHTML = spinnerHtml();
      return;
    }
    const token = ++renderToken;
    const hasShapes = state.shapes.some((s) => s.enabled !== false);
    // Always replace the empty-map prompt as soon as a map is chosen; otherwise
    // it sticks around for the whole aggregate await (or forever on error).
    rememberRadarView();
    mainEl.innerHTML = hasShapes
      ? `<p class="view-empty">Matching selections…</p>${renderRadarCard()}`
      : `<div class="is-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading</span></div>${renderRadarCard()}`;
    paintRadar();

    try {
      const filter = filterObj();
      const agg = await aggregateAnalyticsAsync(payload, filter, tickCache);
      if (token !== renderToken) return;

      const lb = leaderboardFromFiles(payload, agg.files);
      if (token !== renderToken) return;

      const needsPh = (payload.demos || []).some((d) =>
        (d.rounds || []).some((r) => r.m === state.map && !r.ph)
      );
      const roundCount = agg.anyone ? agg.files.length : agg.rounds;
      rememberRadarView();
      mainEl.innerHTML = `
      ${
        needsPh
          ? `<p class="an-warn">Some rounds are still building phase data. Refresh shortly if numbers look incomplete.</p>`
          : ''
      }
      ${renderRadarCard()}
      ${renderLeaderboard(lb, state.playerIds, roundCount)}
      ${renderRounds(agg)}`;
      paintRadar();
    } catch (err) {
      if (token !== renderToken) return;
      rememberRadarView();
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

  function loadShapesForMap() {
    state.shapes = state.map ? loadShapes(state.map) : [];
    tickCache.clear();
  }

  async function load() {
    const token = ++loadToken;
    mainEl.innerHTML = spinnerHtml('Loading pattern finder…');
    const cancelSlow = watchSlowLoad(mainEl, {
      message:
        'Still loading after 4s. The stats API may be rebuilding or unreachable (Failed to fetch).'
    });
    try {
      await consumeCapability(CAP.ANALYTICS_PATTERN_FINDER);
      if (token !== loadToken) {
        cancelSlow();
        return;
      }
      const data = await fetchStats(null);
      cancelSlow();
      if (token !== loadToken) return;
      payload = data;
      players = listPlayers(payload);
      teams = listTeams(payload);
      maps = listMaps(payload);
      state.playerIds = state.playerIds.filter((id) => players.some((p) => p.id === id));
      if (state.map && !maps.includes(state.map)) state.map = '';
      loadShapesForMap();
      if (token !== loadToken) return;
      render();
      mountSavedViews();
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
    const del = e.target.closest('[data-shape-del]');
    if (del) {
      state.shapes = state.shapes.filter((x) => x.id !== del.dataset.shapeDel);
      persistShapes();
      render();
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
      state.phases.clear();
      state.shapeMatch = '';
      state.drawFeature = '';
      state.drawMode = '';
      for (const s of state.shapes) s.enabled = false;
      persistShapes();
      render();
    }
  });

  sidebarEl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'an-map') {
      state.map = t.value || '';
      state.drawMode = '';
      radarView = { zoom: 1, panX: 0, panY: 0 };
      loadShapesForMap();
      render();
      return;
    }
    if (t.matches('[data-an-feature]')) {
      const v = t.value;
      state.drawFeature =
        !v || v === 'any' ? (v === 'any' ? 'any' : '') : SHAPE_FEATURES.some((f) => f.key === v) ? v : '';
      return;
    }
    if (t.matches('[data-an-side]')) {
      state.side = t.value === 'CT' || t.value === 'T' || t.value === 'any' ? t.value : '';
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

  mainEl.addEventListener('click', async (e) => {
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
  });

  const detachTips = attachTips(el);

  return {
    el,
    load,
    destroy() {
      detachTips();
      radar?.destroy();
      radar = null;
      el.remove();
    }
  };
}
