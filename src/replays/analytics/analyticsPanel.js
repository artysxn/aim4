// ---------------------------------------------------------------------------
// Analytics: one player × one map × phase-window presence filters → stats + rounds.
// Layout: sticky filter sidebar + main results (stats, presence, rounds).
// ---------------------------------------------------------------------------

import { fetchStats, fetchZones } from '../api.js';
import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { attachTips } from '../stats/statsTables.js';
import {
  aggregateAnalytics,
  listPlayers,
  locationBreakdown
} from './analyticsMath.js';
import { createPresenceRadar } from './presenceRadar.js';

const tipLines = (lines) => lines.filter(Boolean).join('\n');

const PHASE_OPTS = [
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

const LOC_KINDS = [
  { key: 'pos', label: 'Position', set: 'positions' },
  { key: 'zone', label: 'Zone', set: 'zones' },
  { key: 'area', label: 'Area', set: 'areas' }
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
  let playerSearch = '';
  let playerMenuOpen = false;
  /** @type {Record<string, boolean>} */
  let locMenuOpen = { pos: false, zone: false, area: false };

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
    /** @type {Set<string>} */
    phases: new Set(),
    /** @type {Set<string>} */
    positions: new Set(),
    /** @type {Set<string>} */
    zones: new Set(),
    /** @type {Set<string>} */
    areas: new Set(),
    locSearch: { pos: '', zone: '', area: '' }
  };

  /** @type {object|null} */
  let network = null;
  let networkMap = '';
  /** @type {ReturnType<typeof createPresenceRadar> | null} */
  let radar = null;

  function selectedPlayer() {
    return players.find((p) => p.id === state.playerId) || null;
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
      phases: state.phases,
      positions: state.positions,
      zones: state.zones,
      areas: state.areas
    };
  }

  function locSet(kind) {
    if (kind === 'pos') return state.positions;
    if (kind === 'zone') return state.zones;
    return state.areas;
  }

  function nameOf(kind, id) {
    if (!id || !network) return id || '';
    const list =
      kind === 'pos' ? network.zones : kind === 'zone' ? network.sections : network.areas;
    const hit = (list || []).find((x) => x.id === id);
    return hit?.name || id;
  }

  function networkItems(kind) {
    const list =
      kind === 'pos'
        ? network?.zones || []
        : kind === 'zone'
          ? network?.sections || []
          : network?.areas || [];
    return list
      .filter((z) => z.id && (kind !== 'pos' || !z.hidden))
      .map((z) => ({ id: z.id, name: z.name || z.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function playerOptions() {
    const q = playerSearch.trim().toLowerCase();
    return players
      .filter((p) => p.id !== state.playerId)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .slice(0, 40);
  }

  function locSuggestions(kind) {
    const q = (state.locSearch[kind] || '').trim().toLowerCase();
    if (!q) return [];
    const selected = locSet(kind);
    return networkItems(kind)
      .filter((it) => !selected.has(it.id))
      .filter((it) => it.name.toLowerCase().includes(q))
      .slice(0, 12);
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

  function selectedLocChips(kind) {
    const set = locSet(kind);
    if (!set.size) return '';
    return `<div class="an-sel-chips">
      ${[...set]
        .map(
          (id) =>
            `<button type="button" class="an-sel-chip" data-loc-clear="${kind}" data-id="${escapeHtml(
              id
            )}">${escapeHtml(nameOf(kind, id))} <span aria-hidden="true">×</span></button>`
        )
        .join('')}
    </div>`;
  }

  function locTypeahead(kind, label) {
    const open = locMenuOpen[kind] && (state.locSearch[kind] || '').trim();
    const opts = open ? locSuggestions(kind) : [];
    return `
      <div class="an-field" data-loc-group="${kind}">
        <span class="an-label">${label}</span>
        <div class="rp-typeahead an-loc-typeahead" id="an-loc-${kind}">
          <input type="search" class="site-input an-loc-search" data-loc-search="${kind}"
            placeholder="Search…" spellcheck="false" autocomplete="off"
            value="${escapeHtml(state.locSearch[kind] || '')}" aria-label="Search ${label}" />
          ${
            open
              ? `<div class="rp-typeahead-menu an-loc-menu">
            ${
              opts.length
                ? opts
                    .map(
                      (it) =>
                        `<button type="button" class="rp-typeahead-option" data-loc-pick="${kind}" data-id="${escapeHtml(
                          it.id
                        )}">${escapeHtml(it.name)}</button>`
                    )
                    .join('')
                : `<p class="rp-typeahead-empty">No matches</p>`
            }
          </div>`
              : ''
          }
        </div>
        ${selectedLocChips(kind)}
      </div>`;
  }

  function refreshLocMenu(kind) {
    const wrap = sidebarEl.querySelector(`#an-loc-${kind}`);
    if (!wrap) return;
    wrap.querySelector('.rp-typeahead-menu')?.remove();
    const open = locMenuOpen[kind] && (state.locSearch[kind] || '').trim();
    if (!open) return;
    const opts = locSuggestions(kind);
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="rp-typeahead-menu an-loc-menu">
        ${
          opts.length
            ? opts
                .map(
                  (it) =>
                    `<button type="button" class="rp-typeahead-option" data-loc-pick="${kind}" data-id="${escapeHtml(
                      it.id
                    )}">${escapeHtml(it.name)}</button>`
                )
                .join('')
            : `<p class="rp-typeahead-empty">No matches</p>`
        }
      </div>`
    );
  }

  function refreshPlayerMenu() {
    const wrap = sidebarEl.querySelector('#an-player-typeahead');
    if (!wrap) return;
    wrap.classList.toggle('open', playerMenuOpen);
    wrap.querySelector('.rp-typeahead-menu')?.remove();
    if (!playerMenuOpen && !playerSearch) return;
    const opts = playerOptions();
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="rp-typeahead-menu">
        ${
          opts.length
            ? opts
                .map(
                  (p) =>
                    `<button type="button" class="rp-typeahead-option" data-pick-player="${escapeHtml(
                      p.id
                    )}">${escapeHtml(p.name)}</button>`
                )
                .join('')
            : `<p class="rp-typeahead-empty">No players</p>`
        }
      </div>`
    );
  }

  // ---- sidebar ------------------------------------------------------------

  function renderSidebar() {
    const pl = selectedPlayer();
    const maps = pl?.maps?.length
      ? pl.maps
      : [...new Set((payload?.demos || []).map((d) => d.map).filter(Boolean))].sort();
    const mapOpts = maps
      .map(
        (code) =>
          `<option value="${escapeHtml(code)}"${code === state.map ? ' selected' : ''}>${escapeHtml(
            MAPS[code]?.name || code
          )}</option>`
      )
      .join('');
    const ready = Boolean(state.playerId && state.map);
    sidebarEl.classList.toggle('an-sidebar--pick', !state.playerId);

    sidebarEl.innerHTML = `
      <div class="an-side-block">
        <h3 class="an-side-title">Subject</h3>
        <div class="an-field">
          <span class="an-label">Player</span>
          <div class="rp-typeahead" id="an-player-typeahead">
            <input type="search" class="site-input" id="an-player-search"
              placeholder="${pl ? escapeHtml(pl.name) : 'Search players'}"
              spellcheck="false" autocomplete="off" value="${escapeHtml(playerSearch)}"
              aria-label="Search players" />
          </div>
          ${
            pl
              ? `<button type="button" class="an-sel-chip" data-clear-player>${escapeHtml(
                  pl.name
                )} <span aria-hidden="true">×</span></button>`
              : ''
          }
        </div>
        <div class="an-field">
          <span class="an-label">Map</span>
          <select class="site-select an-select" id="an-map" ${pl ? '' : 'disabled'} aria-label="Map">
            <option value=""${!state.map ? ' selected' : ''}>Select map</option>
            ${mapOpts}
          </select>
        </div>
      </div>

      <div class="an-side-block" ${ready ? '' : 'hidden'}>
        <h3 class="an-side-title">Round filters</h3>
        <div class="an-field">
          <span class="an-label">Side</span>
          <div class="rp-chips">
            ${chip(state.side === 'T', 'data-an-side="T"', 'T')}
            ${chip(state.side === 'CT', 'data-an-side="CT"', 'CT')}
          </div>
        </div>
        <div class="an-field">
          <span class="an-label">Own buy</span>
          <div class="an-buy-row">${econSelect('econ', state.econ)}${awpCheck('hasAwp', state.hasAwp)}</div>
        </div>
        <div class="an-field">
          <span class="an-label">Opp buy</span>
          <div class="an-buy-row">${econSelect('oppEcon', state.oppEcon)}${awpCheck(
            'oppHasAwp',
            state.oppHasAwp
          )}</div>
        </div>
        <div class="an-field">
          <span class="an-label">Result</span>
          <div class="rp-chips">
            ${chip(state.result === 'won', 'data-an-result="won"', 'Won')}
            ${chip(state.result === 'lost', 'data-an-result="lost"', 'Lost')}
          </div>
        </div>
      </div>

      <div class="an-side-block" ${ready ? '' : 'hidden'}>
        ${LOC_KINDS.map((k) => locTypeahead(k.key, k.label)).join('')}
      </div>

      ${
        ready
          ? `<button type="button" class="btn btn-sm an-clear" data-an-clear>Clear filters</button>`
          : ''
      }`;

    if (playerMenuOpen || playerSearch) refreshPlayerMenu();
  }

  // ---- main ---------------------------------------------------------------

  function fmt(n, digits = 2) {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(digits);
  }

  function renderBreakdown(breakdown) {
    const block = (title, rows, kind) => {
      if (!rows.length) {
        return `<div class="an-break-col"><h4>${title}</h4><p class="an-muted">—</p></div>`;
      }
      return `<div class="an-break-col"><h4>${title}</h4>
        <ul class="an-break-list">
          ${rows
            .slice(0, 20)
            .map((r) => {
              const on = locSet(kind).has(r.id);
              return `<li>
                <button type="button" class="an-break-row${on ? ' active' : ''}"
                  data-loc-toggle="${kind}" data-id="${escapeHtml(r.id)}"
                  title="Filter to this ${kind === 'pos' ? 'position' : kind}">
                  <span class="an-break-name">${escapeHtml(nameOf(kind, r.id))}</span>
                  <span class="an-break-n">${r.count}</span>
                </button>
              </li>`;
            })
            .join('')}
        </ul>
      </div>`;
    };
    const phaseChips = PHASE_OPTS.map((p) =>
      chip(state.phases.has(p.key), `data-an-phase="${p.key}"`, p.label)
    ).join('');
    return `<section class="an-card an-breakdown">
      <header class="an-card-head an-break-head">
        <div>
          <h3 class="an-section-title">Where they play</h3>
          <span class="an-muted">${breakdown.samples} phase windows</span>
        </div>
        <div class="an-phase-chips">
          <span class="an-label">Phase</span>
          <div class="rp-chips">${phaseChips}</div>
        </div>
      </header>
      <div class="an-break-body">
        <div class="an-radar-wrap" id="an-radar-wrap" title="Scroll to zoom · drag to pan · double-click to reset">
          <canvas class="an-radar" id="an-radar" aria-label="Position radar"></canvas>
        </div>
        <div class="an-break-grid">
          ${block('Positions', breakdown.pos, 'pos')}
          ${block('Zones', breakdown.zone, 'zone')}
          ${block('Areas', breakdown.area, 'area')}
        </div>
      </div>
    </section>`;
  }

  function statTips(agg) {
    const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
    const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
    const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
    const n = agg.rounds || 0;
    return {
      Rating: tipLines([
        `HLTV 2.0 over ${n} matching rounds (combat only from selected phases / locations).`,
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
              `AWP hit rate: ${agg.awpShots > 0 ? pct(agg.awpAccuracy) : '—'}`
            ]
          : ['No hit data in these phase windows (older demos may lack damage events).']
      ),
      Kills: tipLines([
        `Kills in matching phase windows: ${agg.kills}`,
        `Rounds: ${n}`
      ]),
      Deaths: tipLines([
        `Deaths in matching phase windows: ${agg.deaths}`,
        `Rounds: ${n}`
      ]),
      Assists: tipLines([
        `Assists in matching phase windows: ${agg.assists}`,
        `Rounds: ${n}`
      ])
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

  function renderMain() {
    if (!state.playerId || !state.map) {
      mainEl.innerHTML = `<p class="view-empty">Select a player and a map in the sidebar.</p>`;
      return;
    }
    if (!payload) {
      mainEl.innerHTML = `<p class="view-empty">Loading…</p>`;
      return;
    }
    const filter = filterObj();
    const breakdown = locationBreakdown(payload, filter);
    const agg = aggregateAnalytics(payload, filter);
    const needsPh = (payload.demos || []).some((d) =>
      (d.rounds || []).some((r) => r.m === state.map && !r.ph)
    );
    mainEl.innerHTML = `
      ${
        needsPh
          ? `<p class="an-warn">Some rounds are still building phase data. Refresh shortly if numbers look incomplete.</p>`
          : ''
      }
      ${
        !network?.zones?.length
          ? `<p class="an-warn">No position network for this map — add one in the Position Editor to use location filters.</p>`
          : ''
      }
      ${renderStats(agg)}
      ${renderBreakdown(breakdown)}
      ${renderRounds(agg)}`;
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
      radar = createPresenceRadar({ canvas, wrap });
      radar._canvas = canvas;
    }
    return radar;
  }

  function paintRadar(breakdown) {
    const ctl = ensureRadar();
    if (!ctl || !state.map) return;
    ctl.setData(state.map, network, breakdown?.pos || [], state.positions).catch(() => {});
  }

  function render() {
    renderSidebar();
    renderMain();
    if (state.playerId && state.map && payload) {
      paintRadar(locationBreakdown(payload, filterObj()));
    }
  }

  async function ensureNetwork() {
    if (!state.map) {
      network = null;
      networkMap = '';
      return;
    }
    if (networkMap === state.map && network) return;
    try {
      network = await fetchZones(state.map);
      networkMap = state.map;
    } catch {
      network = { zones: [], sections: [], areas: [] };
      networkMap = state.map;
    }
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
      await ensureNetwork();
      if (token !== loadToken) return;
      render();
    } catch (err) {
      if (token !== loadToken) return;
      mainEl.innerHTML = `<p class="view-empty">Could not load stats. ${escapeHtml(
        err.message || String(err)
      )}</p>`;
    }
  }

  function closeLocMenus(except = '') {
    for (const k of ['pos', 'zone', 'area']) {
      if (k === except) continue;
      locMenuOpen[k] = false;
      refreshLocMenu(k);
    }
  }

  // ---- events -------------------------------------------------------------

  sidebarEl.addEventListener('input', (e) => {
    if (e.target.id === 'an-player-search') {
      playerSearch = e.target.value;
      playerMenuOpen = true;
      closeLocMenus();
      refreshPlayerMenu();
      return;
    }
    const loc = e.target.closest('[data-loc-search]');
    if (!loc) return;
    const kind = loc.dataset.locSearch;
    if (kind !== 'pos' && kind !== 'zone' && kind !== 'area') return;
    state.locSearch[kind] = loc.value;
    locMenuOpen[kind] = true;
    playerMenuOpen = false;
    refreshPlayerMenu();
    closeLocMenus(kind);
    refreshLocMenu(kind);
  });

  sidebarEl.addEventListener('focusin', (e) => {
    if (e.target.id === 'an-player-search') {
      if (!playerMenuOpen) {
        playerMenuOpen = true;
        closeLocMenus();
        refreshPlayerMenu();
      }
      return;
    }
    const loc = e.target.closest('[data-loc-search]');
    if (!loc) return;
    const kind = loc.dataset.locSearch;
    if (kind !== 'pos' && kind !== 'zone' && kind !== 'area') return;
    // Suggestions only after typing — just mark open for when text appears.
    locMenuOpen[kind] = true;
    playerMenuOpen = false;
    refreshPlayerMenu();
  });

  sidebarEl.addEventListener('click', async (e) => {
    const pickPlayer = e.target.closest('[data-pick-player]');
    if (pickPlayer) {
      state.playerId = pickPlayer.dataset.pickPlayer;
      playerSearch = '';
      playerMenuOpen = false;
      const pl = selectedPlayer();
      if (!pl?.maps.includes(state.map)) state.map = pl?.maps[0] || '';
      await ensureNetwork();
      render();
      return;
    }
    if (e.target.closest('[data-clear-player]')) {
      state.playerId = '';
      state.map = '';
      playerSearch = '';
      playerMenuOpen = false;
      render();
      return;
    }

    const locPick = e.target.closest('[data-loc-pick]');
    if (locPick) {
      const kind = locPick.dataset.locPick;
      const id = locPick.dataset.id;
      locSet(kind).add(id);
      state.locSearch[kind] = '';
      locMenuOpen[kind] = false;
      render();
      return;
    }
    const locClear = e.target.closest('[data-loc-clear]');
    if (locClear) {
      locSet(locClear.dataset.locClear).delete(locClear.dataset.id);
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
    if (e.target.closest('[data-an-clear]')) {
      state.side = '';
      state.econ = null;
      state.oppEcon = null;
      state.hasAwp = false;
      state.oppHasAwp = false;
      state.result = '';
      state.phases.clear();
      state.positions.clear();
      state.zones.clear();
      state.areas.clear();
      state.locSearch = { pos: '', zone: '', area: '' };
      locMenuOpen = { pos: false, zone: false, area: false };
      render();
    }
  });

  sidebarEl.addEventListener('change', async (e) => {
    if (e.target.id === 'an-map') {
      state.map = e.target.value || '';
      state.positions.clear();
      state.zones.clear();
      state.areas.clear();
      state.locSearch = { pos: '', zone: '', area: '' };
      await ensureNetwork();
      render();
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
    const inLoc = e.target.closest?.('.an-loc-typeahead');
    if (!inPlayer && playerMenuOpen) {
      playerMenuOpen = false;
      refreshPlayerMenu();
    }
    if (!inLoc && (locMenuOpen.pos || locMenuOpen.zone || locMenuOpen.area)) {
      closeLocMenus();
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
    const locToggle = e.target.closest('[data-loc-toggle]');
    if (locToggle) {
      const kind = locToggle.dataset.locToggle;
      const id = locToggle.dataset.id;
      const set = locSet(kind);
      if (set.has(id)) set.delete(id);
      else set.add(id);
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
      const agg = aggregateAnalytics(payload, filterObj());
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
