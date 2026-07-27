// ---------------------------------------------------------------------------
// Analytics: one player × one map × phase-window + drawn-shape filters → stats.
// Layout: sticky filter sidebar + main results (stats, radar shapes, rounds).
// ---------------------------------------------------------------------------

import { fetchStats } from '../api.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { attachTips } from '../stats/statsTables.js';
import {
  aggregateAnalyticsAsync,
  leaderboardFromFiles,
  listPlayers
} from './analyticsMath.js';
import { createPresenceRadar } from './presenceRadar.js';
import {
  SHAPE_FEATURES,
  loadShapes,
  saveShapes,
  newShapeId
} from './shapeFilters.js';

const tipLines = (lines) => lines.filter(Boolean).join('\n');

const PHASE_OPTS = [
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

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
      <div class="an-main" id="an-main"><p class="view-empty">Select a player and a map to begin.</p></div>
    </div>`;

  const sidebarEl = el.querySelector('#an-sidebar');
  const mainEl = el.querySelector('#an-main');

  let payload = null;
  /** @type {Array<{id:string,name:string,maps:string[]}>} */
  let players = [];
  let loadToken = 0;
  let renderToken = 0;
  let playerSearch = '';
  let playerMenuOpen = false;
  /** @type {Map<string, { meta: object|null, ticks: ArrayBuffer|null }>} */
  const tickCache = new Map();

  const state = {
    playerId: '',
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
    /** @type {'all'|'any'} */
    shapeMatch: 'all',
    /** @type {ShapeFeature|'player_in'} */
    drawFeature: 'player_in',
    /** @type {''|'rect'|'poly'|'lasso'} */
    drawMode: ''
  };

  /** @type {ReturnType<typeof createPresenceRadar> | null} */
  let radar = null;

  function selectedPlayer() {
    return players.find((p) => p.id === state.playerId) || null;
  }

  function persistShapes() {
    if (!state.map) return;
    saveShapes(state.map, state.shapes);
  }

  function filterObj() {
    return {
      playerId: state.playerId,
      map: state.map,
      side: state.side,
      econ: state.econ,
      oppEcon: state.oppEcon,
      hasAwp: state.hasAwp,
      oppHasAwp: state.oppHasAwp,
      result: state.result,
      opening: state.opening,
      phases: state.phases,
      shapes: state.shapes,
      shapeMatch: state.shapeMatch
    };
  }

  function featureLabel(key) {
    return SHAPE_FEATURES.find((f) => f.key === key)?.label || key;
  }

  function playerOptions() {
    const q = playerSearch.trim().toLowerCase();
    return players
      .filter((p) => p.id !== state.playerId)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .slice(0, 40);
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
    return `<select class="site-select an-select" data-an-econ="${id}">
      <option value=""${value === null ? ' selected' : ''}>Any</option>${opts}</select>`;
  }

  function awpCheck(id, checked) {
    return `<label class="rp-awp-toggle an-awp${checked ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" data-an-awp="${id}" ${checked ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  function chip(active, attrs, label) {
    return `<button type="button" class="rp-chip${active ? ' active' : ''}" ${attrs}>${label}</button>`;
  }

  function refreshPlayerMenu() {
    const menu = sidebarEl.querySelector('#an-player-menu');
    if (!menu) return;
    const opts = playerOptions();
    menu.hidden = !playerMenuOpen || !opts.length;
    menu.innerHTML = opts
      .map(
        (p) =>
          `<button type="button" class="rp-typeahead-item" data-pick-player="${escapeHtml(
            p.id
          )}">${escapeHtml(p.name)}</button>`
      )
      .join('');
  }

  function renderSidebar() {
    const pl = selectedPlayer();
    const ready = Boolean(state.playerId && state.map);
    const maps = pl?.maps || [];

    sidebarEl.classList.toggle('an-sidebar--pick', !state.playerId);
    sidebarEl.innerHTML = `
      <div class="an-field">
        <span class="an-label">Player</span>
        <div class="rp-typeahead" id="an-player-typeahead">
          ${
            pl
              ? `<div class="an-sel-chips"><button type="button" class="an-sel-chip" data-clear-player>
                  ${escapeHtml(pl.name)} <span aria-hidden="true">×</span></button></div>`
              : `<input type="search" class="site-input" id="an-player-search"
                  placeholder="Search players…" spellcheck="false" autocomplete="off"
                  value="${escapeHtml(playerSearch)}" aria-label="Search players" />
                <div class="rp-typeahead-menu" id="an-player-menu" hidden></div>`
          }
        </div>
      </div>

      <div class="an-side-block" ${pl ? '' : 'hidden'}>
        <div class="an-field">
          <span class="an-label">Map</span>
          <select class="site-select an-select" id="an-map" ${maps.length ? '' : 'disabled'}>
            <option value="">Select map…</option>
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
      </div>

      <div class="an-side-block" ${ready ? '' : 'hidden'}>
        <p class="an-side-title">Round filters</p>
        <div class="an-field">
          <span class="an-label">Side</span>
          <div class="rp-chips">
            ${chip(state.side === 'T', 'data-an-side="T"', 'T')}
            ${chip(state.side === 'CT', 'data-an-side="CT"', 'CT')}
          </div>
        </div>
        <div class="an-field">
          <span class="an-label">Result</span>
          <div class="rp-chips">
            ${chip(state.result === 'won', 'data-an-result="won"', 'Won')}
            ${chip(state.result === 'lost', 'data-an-result="lost"', 'Lost')}
          </div>
        </div>
        <div class="an-field">
          <span class="an-label">Opening</span>
          <div class="rp-chips">
            ${chip(state.opening === 'won', 'data-an-opening="won"', 'Got OK')}
            ${chip(state.opening === 'lost', 'data-an-opening="lost"', 'Got OD')}
          </div>
        </div>
        <div class="an-field an-buy-row">
          <span class="an-label">Buy</span>
          ${econSelect('econ', state.econ)}
          ${awpCheck('hasAwp', state.hasAwp)}
        </div>
        <div class="an-field an-buy-row">
          <span class="an-label">Opp buy</span>
          ${econSelect('oppEcon', state.oppEcon)}
          ${awpCheck('oppHasAwp', state.oppHasAwp)}
        </div>
        <div class="an-field">
          <span class="an-label">Phase</span>
          <div class="rp-chips">
            ${PHASE_OPTS.map((p) =>
              chip(state.phases.has(p.key), `data-an-phase="${p.key}"`, p.label)
            ).join('')}
          </div>
        </div>

        <p class="an-side-title">Map selections</p>
        <p class="an-side-hint">Draw multiple regions; matching rounds feed stats and the leaderboard.</p>
        <div class="an-field">
          <span class="an-label">Feature</span>
          <select class="site-select an-select" id="an-shape-feature">
            ${SHAPE_FEATURES.map(
              (f) =>
                `<option value="${f.key}"${f.key === state.drawFeature ? ' selected' : ''}>${escapeHtml(
                  f.label
                )}</option>`
            ).join('')}
          </select>
        </div>
        <div class="an-field">
          <span class="an-label">Match</span>
          <div class="rp-chips">
            ${chip(state.shapeMatch === 'all', 'data-an-match="all"', 'All')}
            ${chip(state.shapeMatch === 'any', 'data-an-match="any"', 'Any')}
          </div>
        </div>
        <div class="an-field">
          <span class="an-label">Draw</span>
          <div class="rp-chips">
            ${chip(state.drawMode === 'rect', 'data-an-draw="rect"', 'Rect')}
            ${chip(state.drawMode === 'poly', 'data-an-draw="poly"', 'Polygon')}
            ${chip(state.drawMode === 'lasso', 'data-an-draw="lasso"', 'Lasso')}
            ${
              state.drawMode === 'poly'
                ? `<button type="button" class="rp-chip" data-an-poly-done>Finish</button>`
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
              : `<p class="an-muted">No selections yet.</p>`
          }
        </div>

        <button type="button" class="btn btn-sm an-clear" data-an-clear>Clear filters</button>
      </div>`;

    if (playerMenuOpen || playerSearch) refreshPlayerMenu();
  }

  function fmt(n, digits = 2) {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(digits);
  }

  function statTips(agg) {
    const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
    const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
    const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
    const n = agg.rounds || 0;
    return {
      Rating: tipLines([
        `HLTV 2.0 over ${n} matching rounds (combat only from selected phases / shapes).`,
        `KPR: ${f2(agg.kpr)}  (${agg.kills} kills / ${n} rounds)`,
        `DPR: ${f2(agg.dpr)}  (${agg.deaths} deaths / ${n} rounds)`,
        `Impact: ${f2(agg.impact)}`,
        `ADR: ${f1(agg.adr)}`,
        `KAST: ${pct(agg.kast)}`
      ]),
      'K/D': tipLines([
        `Kills: ${agg.kills}`,
        `Assists: ${agg.assists}`,
        `Deaths: ${agg.deaths}`,
        `Across ${n} matching rounds (${agg.samples} phase windows)`
      ]),
      ADR: tipLines([
        `Average damage per matching round`,
        `Total damage: ${Math.round(agg.damage || 0)}`,
        `Rounds: ${n}`
      ]),
      KAST: tipLines([
        `% of matching rounds with a kill, assist, survival, or trade in a selected window`,
        `KAST: ${pct(agg.kast)}`,
        `Rounds: ${n}`
      ]),
      Impact: tipLines([
        `Impact = 2.13×KPR + 0.42×APR − 0.41`,
        `KPR: ${f2(agg.kpr)}`,
        `APR: ${f2(agg.apr)}`
      ]),
      Acc: tipLines(
        agg.shots > 0
          ? [
              `Shots fired: ${agg.shots}`,
              `Shots hit: ${agg.hits}`,
              `Headshots hit: ${agg.headshots}`,
              `AWP shots fired: ${agg.awpShots}`,
              `AWP shots hit: ${agg.awpHits}`,
              `AWP hit rate: ${agg.awpShots > 0 ? pct(agg.awpAccuracy) : '—'}`,
              `AWP Acc: holds within 10° of an enemy with a clear (no smoke) path`
            ]
          : ['No hit data in these phase windows (older demos may lack damage events).']
      ),
      Kills: tipLines([`Kills in matching phase windows: ${agg.kills}`, `Rounds: ${n}`]),
      Deaths: tipLines([`Deaths in matching phase windows: ${agg.deaths}`, `Rounds: ${n}`]),
      Assists: tipLines([`Assists in matching phase windows: ${agg.assists}`, `Rounds: ${n}`])
    };
  }

  function renderStats(agg) {
    if (!agg.samples) {
      return `<section class="an-card"><p class="view-empty">No phase windows match these filters.</p></section>`;
    }
    const tips = statTips(agg);
    const cells = [
      ['Rating', fmt(agg.rating)],
      ['K/D', fmt(agg.kd)],
      ['ADR', fmt(agg.adr, 1)],
      ['KAST', `${fmt(agg.kast, 1)}%`],
      ['Impact', fmt(agg.impact)],
      ['Acc', agg.shots > 0 ? `${fmt(agg.accuracy, 1)}%` : '—'],
      ['Kills', String(agg.kills)],
      ['Deaths', String(agg.deaths)],
      ['Assists', String(agg.assists)]
    ];
    return `<section class="an-card an-stats">
      <header class="an-card-head">
        <h3 class="an-section-title">Phase stats</h3>
        <span class="an-muted">${agg.rounds} rounds · ${agg.samples} phase windows</span>
      </header>
      <div class="an-stat-grid">
        ${cells
          .map(([label, value]) => {
            const tip = tips[label] || '';
            return `<div class="an-stat${tip ? ' has-tip' : ''}"${
              tip ? ` data-tip="${escapeHtml(tip)}"` : ''
            }><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
          })
          .join('')}
      </div>
    </section>`;
  }

  function renderRadarCard() {
    const hint =
      state.drawMode === 'rect'
        ? 'Drag a rectangle on the radar.'
        : state.drawMode === 'poly'
          ? 'Click vertices · double-click or Finish to close.'
          : state.drawMode === 'lasso'
            ? 'Drag freely to lasso a region · release to add.'
            : 'Scroll to zoom · drag to pan · draw tools in the sidebar.';
    return `<section class="an-card an-breakdown">
      <header class="an-card-head an-break-head">
        <div>
          <h3 class="an-section-title">Map selections</h3>
          <span class="an-muted">${hint}</span>
        </div>
        <div class="an-phase-chips">
          <span class="an-label">Phase</span>
          <div class="rp-chips">
            ${PHASE_OPTS.map((p) =>
              chip(state.phases.has(p.key), `data-an-phase="${p.key}"`, p.label)
            ).join('')}
          </div>
        </div>
      </header>
      <div class="an-break-body">
        <div class="an-radar-wrap" id="an-radar-wrap">
          <canvas class="an-radar" id="an-radar" aria-label="Selection radar"></canvas>
        </div>
      </div>
    </section>`;
  }

  function renderLeaderboard(rows, focusId, roundCount) {
    if (!rows.length) {
      return `<section class="an-card"><p class="view-empty">No players on matching rounds.</p></section>`;
    }
    const top = rows.slice(0, 40);
    return `<section class="an-card an-lb">
      <header class="an-card-head">
        <h3 class="an-section-title">Leaderboard <small>${roundCount} rounds</small></h3>
        <span class="an-muted">Full-round stats on rounds matching the filters above</span>
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
                const focus = p.id === focusId ? ' focus' : '';
                return `<tr class="an-lb-row${focus}">
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
    const byFile = new Map();
    for (const w of agg.windows) {
      let g = byFile.get(w.file);
      if (!g) {
        g = { file: w.file, demoId: w.demoId, round: w.round, phases: new Set() };
        byFile.set(w.file, g);
      }
      g.phases.add(w.phase);
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
          .map(
            (r) =>
              `<li class="an-round-row">
                <span class="an-round-label">R${r.round || '?'} · ${escapeHtml(
                  [...r.phases].join(', ')
                )}</span>
                <button type="button" class="btn btn-sm" data-an-play="${escapeHtml(
                  r.file
                )}">Play</button>
              </li>`
          )
          .join('')}
      </ul>
    </section>`;
  }

  function ensureRadar() {
    const canvas = mainEl.querySelector('#an-radar');
    const wrap = mainEl.querySelector('#an-radar-wrap');
    if (!canvas) {
      radar?.destroy();
      radar = null;
      return null;
    }
    if (!radar || radar._canvas !== canvas) {
      radar?.destroy();
      radar = createPresenceRadar({
        canvas,
        wrap,
        onShapeComplete: (geometry) => {
          state.shapes.push({
            id: newShapeId(),
            map: state.map,
            name: '',
            feature: state.drawFeature,
            geometry,
            enabled: true
          });
          persistShapes();
          // Keep draw mode so multiple selections can be added quickly.
          render();
        }
      });
      radar._canvas = canvas;
    }
    return radar;
  }

  function paintRadar() {
    const ctl = ensureRadar();
    if (!ctl || !state.map) return;
    ctl.setData(state.map, state.shapes, state.drawMode).catch(() => {});
  }

  async function renderMain() {
    if (!state.playerId || !state.map) {
      mainEl.innerHTML = `<p class="view-empty">Select a player and a map in the sidebar.</p>`;
      return;
    }
    if (!payload) {
      mainEl.innerHTML = `<p class="view-empty">Loading…</p>`;
      return;
    }
    const token = ++renderToken;
    const hasShapes = state.shapes.some((s) => s.enabled !== false);
    if (hasShapes) {
      mainEl.innerHTML = `<p class="view-empty">Matching selections…</p>${renderRadarCard()}`;
      paintRadar();
    }

    const filter = filterObj();
    const agg = await aggregateAnalyticsAsync(payload, filter, tickCache);
    if (token !== renderToken) return;

    const lb = leaderboardFromFiles(payload, agg.files);
    if (token !== renderToken) return;

    const needsPh = (payload.demos || []).some((d) =>
      (d.rounds || []).some((r) => r.m === state.map && !r.ph)
    );
    mainEl.innerHTML = `
      ${
        needsPh
          ? `<p class="an-warn">Some rounds are still building phase data. Refresh shortly if numbers look incomplete.</p>`
          : ''
      }
      ${renderStats(agg)}
      ${renderRadarCard()}
      ${renderLeaderboard(lb, state.playerId, agg.rounds)}
      ${renderRounds(agg)}`;
    paintRadar();
  }

  function render() {
    renderSidebar();
    renderMain();
  }

  function loadShapesForMap() {
    state.shapes = state.map ? loadShapes(state.map) : [];
    tickCache.clear();
  }

  async function load() {
    const token = ++loadToken;
    mainEl.innerHTML = `<p class="view-empty">Loading…</p>`;
    try {
      const data = await fetchStats(null);
      if (token !== loadToken) return;
      payload = data;
      players = listPlayers(payload);
      if (state.playerId && !players.some((p) => p.id === state.playerId)) {
        state.playerId = '';
        state.map = '';
      }
      loadShapesForMap();
      if (token !== loadToken) return;
      render();
    } catch (err) {
      if (token !== loadToken) return;
      mainEl.innerHTML = `<p class="view-empty">Could not load stats. ${escapeHtml(
        err.message || String(err)
      )}</p>`;
    }
  }

  sidebarEl.addEventListener('input', (e) => {
    if (e.target.id === 'an-player-search') {
      playerSearch = e.target.value;
      playerMenuOpen = true;
      refreshPlayerMenu();
    }
  });

  sidebarEl.addEventListener('focusin', (e) => {
    if (e.target.id === 'an-player-search' && !playerMenuOpen) {
      playerMenuOpen = true;
      refreshPlayerMenu();
    }
  });

  sidebarEl.addEventListener('click', (e) => {
    const pickPlayer = e.target.closest('[data-pick-player]');
    if (pickPlayer) {
      state.playerId = pickPlayer.dataset.pickPlayer;
      playerSearch = '';
      playerMenuOpen = false;
      const pl = selectedPlayer();
      if (!pl?.maps.includes(state.map)) state.map = pl?.maps[0] || '';
      loadShapesForMap();
      render();
      return;
    }
    if (e.target.closest('[data-clear-player]')) {
      state.playerId = '';
      state.map = '';
      state.shapes = [];
      playerSearch = '';
      playerMenuOpen = false;
      render();
      return;
    }

    const side = e.target.closest('[data-an-side]');
    if (side) {
      const v = side.dataset.anSide === 'CT' ? 'CT' : 'T';
      state.side = state.side === v ? '' : v;
      render();
      return;
    }
    const result = e.target.closest('[data-an-result]');
    if (result) {
      const v = result.dataset.anResult === 'lost' ? 'lost' : 'won';
      state.result = state.result === v ? '' : v;
      render();
      return;
    }
    const opening = e.target.closest('[data-an-opening]');
    if (opening) {
      const v = opening.dataset.anOpening === 'lost' ? 'lost' : 'won';
      state.opening = state.opening === v ? '' : v;
      render();
      return;
    }
    const match = e.target.closest('[data-an-match]');
    if (match) {
      state.shapeMatch = match.dataset.anMatch === 'any' ? 'any' : 'all';
      render();
      return;
    }
    const phase = e.target.closest('[data-an-phase]');
    if (phase) {
      const key = phase.dataset.anPhase;
      if (state.phases.has(key)) state.phases.delete(key);
      else state.phases.add(key);
      render();
      return;
    }
    const draw = e.target.closest('[data-an-draw]');
    if (draw) {
      const raw = draw.dataset.anDraw;
      const mode = raw === 'poly' || raw === 'lasso' ? raw : 'rect';
      state.drawMode = state.drawMode === mode ? '' : mode;
      radar?.setDrawMode(state.drawMode);
      renderSidebar();
      paintRadar();
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
      state.shapeMatch = 'all';
      state.drawMode = '';
      for (const s of state.shapes) s.enabled = false;
      persistShapes();
      render();
    }
  });

  sidebarEl.addEventListener('change', (e) => {
    if (e.target.id === 'an-map') {
      state.map = e.target.value || '';
      state.drawMode = '';
      loadShapesForMap();
      render();
      return;
    }
    if (e.target.id === 'an-shape-feature') {
      state.drawFeature = e.target.value || 'player_in';
      return;
    }
    const awp = e.target.closest('[data-an-awp]');
    if (awp) {
      state[awp.dataset.anAwp] = Boolean(awp.checked);
      render();
      return;
    }
    const econ = e.target.closest('[data-an-econ]');
    if (econ) {
      state[econ.dataset.anEcon] = econ.value === '' ? null : Number(econ.value);
      render();
    }
  });

  document.addEventListener('click', (e) => {
    const inPlayer = e.target.closest?.('#an-player-typeahead');
    if (!inPlayer && playerMenuOpen) {
      playerMenuOpen = false;
      refreshPlayerMenu();
    }
  });

  mainEl.addEventListener('click', async (e) => {
    const phase = e.target.closest('[data-an-phase]');
    if (phase) {
      const key = phase.dataset.anPhase;
      if (state.phases.has(key)) state.phases.delete(key);
      else state.phases.add(key);
      render();
      return;
    }
    const playOne = e.target.closest('[data-an-play]');
    if (playOne && onPlayRounds) {
      playOne.disabled = true;
      try {
        await onPlayRounds([playOne.dataset.anPlay], selectedPlayer()?.name || 'Analytics');
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
          `${selectedPlayer()?.name || 'Player'} · ${MAPS[state.map]?.name || state.map}`
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
