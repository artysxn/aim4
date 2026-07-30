// ---------------------------------------------------------------------------
// replays/charts/chartsPanel.js
// The Charts screen: a graph builder over the stats index.
//
// Left side is the spec (chart type, what a point is, both axes with their own
// filters, series split, options, library-wide filters). Right side is the
// vector canvas plus the fit and a details table. Every change re-aggregates
// the cached facts in memory; nothing here refetches.
// ---------------------------------------------------------------------------

import { fetchStats } from '../api.js';
import { ECONOMIES, MAPS } from '../shared/roundId.js';
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
import { computeChart, correlationWords, filterWords } from './chartData.js';
import { legendHtml, renderChart } from './chartRender.js';

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

/** The examples the builder ships with, so a new user has somewhere to start. */
const PRESETS = [
  {
    key: 'firstKillTiming',
    label: 'When first kills happen',
    apply: (s) => {
      s.type = 'area';
      s.source = 'kill';
      s.x.dimension = 'time';
      s.y.metric = 'killCount';
      s.binStep = 5;
      s.normalize = true;
      s.series = 'side';
      s.trendline = false;
      s.filter = { ...emptyFilter(), killKinds: ['opening'] };
      s.x.filter = {};
      s.y.filter = {};
    }
  },
  {
    key: 'eakVsSwing',
    label: 'T-side EAK vs round swing',
    apply: (s) => {
      s.type = 'scatter';
      s.subject = 'players';
      s.x.metric = 'eak';
      s.x.filter = { sides: ['T'] };
      s.y.metric = 'swing';
      s.y.filter = { econ: [4] };
      s.series = 'team';
      s.minRounds = 10;
      s.trendline = true;
      s.filter = emptyFilter();
    }
  },
  {
    key: 'prwVsPossession',
    label: 'Team winrate vs possession',
    apply: (s) => {
      s.type = 'scatter';
      s.subject = 'teams';
      s.x.metric = 'possession';
      s.y.metric = 'prw';
      s.x.filter = {};
      s.y.filter = {};
      s.series = '';
      s.minRounds = 8;
      s.trendline = true;
      s.filter = { ...emptyFilter(), econ: [4] };
    }
  },
  {
    key: 'killsByPhase',
    label: 'Kills by phase and side',
    apply: (s) => {
      s.type = 'bar';
      s.source = 'kill';
      s.x.dimension = 'phase';
      s.y.metric = 'killCount';
      s.series = 'side';
      s.normalize = true;
      s.trendline = false;
      s.filter = emptyFilter();
      s.x.filter = {};
      s.y.filter = {};
    }
  },
  {
    key: 'ratingByRound',
    label: 'Rating through the map',
    apply: (s) => {
      s.type = 'line';
      s.source = 'player';
      s.x.dimension = 'roundNo';
      s.y.metric = 'rating';
      s.binStep = 3;
      s.series = 'side';
      s.normalize = false;
      s.filter = emptyFilter();
      s.x.filter = {};
      s.y.filter = {};
    }
  },
  {
    key: 'openDuelEconomy',
    label: 'Opening duels by enemy buy',
    apply: (s) => {
      s.type = 'bar';
      s.source = 'round';
      s.x.dimension = 'oppEcon';
      s.y.metric = 'openKillPct';
      s.series = 'side';
      s.normalize = false;
      s.filter = emptyFilter();
      s.x.filter = {};
      s.y.filter = {};
    }
  }
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
        <div class="ch-canvas" id="ch-canvas"><p class="view-empty">Loading…</p></div>
        <div class="ch-readout" id="ch-readout"></div>
        <div class="ch-details" id="ch-details"></div>
      </div>
    </div>`;

  const sideEl = el.querySelector('#ch-side');
  const canvasEl = el.querySelector('#ch-canvas');
  const readoutEl = el.querySelector('#ch-readout');
  const detailsEl = el.querySelector('#ch-details');

  let facts = null;
  let loadToken = 0;
  /** @type {object[]} hover payloads, indexed by the mark's data-i */
  let hoverPoints = [];
  let lastModel = null;

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
    filter: emptyFilter()
  };

  const isScatter = () => state.type === 'scatter';
  const source = () => (isScatter() ? findSubject(state.subject).source : state.source);

  // ---- small html helpers -------------------------------------------------

  const chip = (scope, key, value, label, on) =>
    `<button type="button" class="rp-chip${on ? ' active' : ''}" data-chip="${scope}|${key}|${value}">${escapeHtml(
      label
    )}</button>`;

  const flag = (scope, key, label, on) =>
    `<button type="button" class="rp-chip${on ? ' active' : ''}" data-flag="${scope}|${key}">${escapeHtml(
      label
    )}</button>`;

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

  function multiSelect(scope, key, options, selected) {
    const size = Math.min(6, Math.max(3, options.length));
    return `<select class="site-select ch-multi" multiple size="${size}" data-multi="${scope}|${key}">${options
      .map(
        (o) =>
          `<option value="${escapeHtml(o.key)}"${
            selected.map(String).includes(String(o.key)) ? ' selected' : ''
          }>${escapeHtml(o.label)}</option>`
      )
      .join('')}</select>`;
  }

  const group = (label, body, extra = '') =>
    `<div class="ch-group${extra ? ` ${extra}` : ''}"><span class="ch-label">${escapeHtml(
      label
    )}</span>${body}</div>`;

  // ---- filter editor ------------------------------------------------------

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
    const has = (key, v) => arr(key).map(String).includes(String(v));

    const rows = [
      maps.length > 1
        ? group('Map', `<div class="rp-chips">${maps
            .map((m) => chip(scope, 'maps', m.key, m.label, has('maps', m.key)))
            .join('')}</div>`)
        : '',
      group(
        'Side',
        `<div class="rp-chips">${SIDES.map((s) => chip(scope, 'sides', s, s, has('sides', s))).join(
          ''
        )}</div>`
      ),
      group(
        'Own buy',
        `<div class="rp-chips">${econOpts
          .map((o) => chip(scope, 'econ', o.key, o.label, has('econ', o.key)))
          .join('')}${flag(scope, 'hasAwp', 'AWP', Boolean(f.hasAwp))}</div>`
      ),
      group(
        'Enemy buy',
        `<div class="rp-chips">${econOpts
          .map((o) => chip(scope, 'oppEcon', o.key, o.label, has('oppEcon', o.key)))
          .join('')}${flag(scope, 'oppHasAwp', 'AWP', Boolean(f.oppHasAwp))}</div>`
      ),
      group(
        'Round',
        `<div class="rp-chips">${chip(scope, 'result', 'won', 'Won', f.result === 'won')}${chip(
          scope,
          'result',
          'lost',
          'Lost',
          f.result === 'lost'
        )}${chip(scope, 'opening', '5v4', '5v4', f.opening === '5v4')}${chip(
          scope,
          'opening',
          '4v5',
          '4v5',
          f.opening === '4v5'
        )}${chip(scope, 'opening', 'even', 'Even', f.opening === 'even')}${chip(
          scope,
          'half',
          '1',
          '1st half',
          f.half === '1'
        )}${chip(scope, 'half', '2', '2nd half', f.half === '2')}</div>`
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
        ? group(
            'Kill type',
            `<div class="rp-chips">${KILL_KINDS.map((k) =>
              chip(scope, 'killKinds', k.key, k.label, has('killKinds', k.key))
            ).join('')}</div>`
          )
        : '',
      killable
        ? group(
            'Phase',
            `<div class="rp-chips">${PHASES.map((p) =>
              chip(scope, 'phases', p.key, p.label, has('phases', p.key))
            ).join('')}</div>`
          )
        : '',
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
      facts?.teams?.length
        ? group(
            'Teams',
            multiSelect(
              scope,
              'teams',
              facts.teams.map((t) => ({ key: t.key, label: `${t.name} (${t.rounds})` })),
              arr('teams')
            )
          )
        : '',
      facts?.players?.length
        ? group(
            'Players',
            multiSelect(
              scope,
              'players',
              facts.players.map((p) => ({ key: p.id, label: `${p.name} (${p.rounds})` })),
              arr('players')
            )
          )
        : '',
      facts?.matches?.length > 1
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

  function renderSide() {
    const src = source();
    const seriesOpts = seriesFor(src).map((d) => ({ key: d.key, label: d.label }));
    const dim = isScatter() ? null : findDimension(src, state.x.dimension);
    const stepOpts = (dim?.steps || []).map((s) => ({ key: String(s), label: `${s}${dim.unit || ''}` }));

    sideEl.innerHTML = `
      <div class="ch-block">
        <span class="ch-label">Presets</span>
        <div class="rp-chips">${PRESETS.map(
          (p) => `<button type="button" class="rp-chip" data-preset="${p.key}">${escapeHtml(p.label)}</button>`
        ).join('')}</div>
      </div>

      <div class="ch-block">
        <span class="ch-label">Chart</span>
        <div class="rp-chips">${CHART_TYPES.map(
          (t) =>
            `<button type="button" class="rp-chip${
              state.type === t.key ? ' active' : ''
            }" data-type="${t.key}" title="${escapeHtml(t.tip)}">${escapeHtml(t.label)}</button>`
        ).join('')}</div>
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

      <div class="ch-block">
        <span class="ch-label">Split into series</span>
        ${selectHtml('data-series', seriesOpts, state.series, { placeholder: 'No split' })}
      </div>

      <div class="ch-block">
        <span class="ch-label">Options</span>
        <div class="rp-chips">
          <button type="button" class="rp-chip${
            state.trendline ? ' active' : ''
          }" data-toggle="trendline">Trendline</button>
          ${
            isScatter()
              ? ''
              : `<button type="button" class="rp-chip${
                  state.normalize ? ' active' : ''
                }" data-toggle="normalize">As share %</button>`
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
  }

  // ---- canvas -------------------------------------------------------------

  function chartTitle(model) {
    if (model.kind === 'scatter') {
      return `${model.yLabel} vs ${model.xLabel} by ${findSubject(state.subject).label.toLowerCase()}`;
    }
    return `${model.yLabel} by ${model.xLabel}`;
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
    let model;
    try {
      model = computeChart(state, facts);
    } catch (err) {
      canvasEl.innerHTML = `<p class="view-empty">${escapeHtml(err.message || 'Could not build that chart.')}</p>`;
      readoutEl.innerHTML = '';
      detailsEl.innerHTML = '';
      return;
    }
    lastModel = model;

    const { svg, points } = renderChart(model, { trendline: state.trendline });
    hoverPoints = points;
    if (!svg) {
      canvasEl.innerHTML =
        '<p class="view-empty">Nothing matches those filters. Loosen a filter or lower Min rounds.</p>';
      readoutEl.innerHTML = '';
      detailsEl.innerHTML = '';
      return;
    }

    canvasEl.innerHTML = `
      <div class="ch-head">
        <h3 class="ch-title">${escapeHtml(chartTitle(model))}</h3>
        <button type="button" class="btn btn-sm" data-save>Save SVG</button>
      </div>
      ${legendHtml(model)}
      <div class="ch-plot" id="ch-plot">${svg}<div class="ch-tip" id="ch-tip" hidden></div></div>`;

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
    readoutEl.innerHTML = bits.map((b) => `<span>${escapeHtml(b)}</span>`).join('');
    detailsEl.innerHTML = detailsHtml(model);
  }

  // ---- events -------------------------------------------------------------

  function filterFor(scope) {
    if (scope === 'x') return state.x.filter;
    if (scope === 'y') return state.y.filter;
    return state.filter;
  }

  function toggleIn(scope, key, value) {
    const f = filterFor(scope);
    const single = key === 'result' || key === 'opening' || key === 'half';
    if (single) {
      f[key] = f[key] === value ? '' : value;
      return;
    }
    const list = (f[key] || []).map(String);
    const v = String(value);
    const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    // Buy buckets are numbers on the facts, so keep them numeric here.
    f[key] = key === 'econ' || key === 'oppEcon' ? next.map(Number) : next;
  }

  function afterChange({ rebuildSide = true } = {}) {
    if (rebuildSide) renderSide();
    renderCanvas();
  }

  sideEl.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const p = PRESETS.find((x) => x.key === preset.dataset.preset);
      if (p) {
        p.apply(state);
        afterChange();
      }
      return;
    }
    const type = e.target.closest('[data-type]');
    if (type) {
      state.type = type.dataset.type;
      const src = source();
      // Keep the axes valid for whatever fact table the new type reads.
      state.y.metric = findMetric(src, state.y.metric).key;
      state.x.metric = findMetric(src, state.x.metric).key;
      const dim = findDimension(src, state.x.dimension);
      state.x.dimension = dim?.key || '';
      state.binStep = dim?.step || 1;
      if (state.series && !seriesFor(src).some((d) => d.key === state.series)) state.series = '';
      afterChange();
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      state[toggle.dataset.toggle] = !state[toggle.dataset.toggle];
      afterChange();
      return;
    }
    const c = e.target.closest('[data-chip]');
    if (c) {
      const [scope, key, value] = c.dataset.chip.split('|');
      toggleIn(scope, key, value);
      afterChange();
      return;
    }
    const fl = e.target.closest('[data-flag]');
    if (fl) {
      const [scope, key] = fl.dataset.flag.split('|');
      const f = filterFor(scope);
      f[key] = !f[key];
      afterChange();
      return;
    }
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      const scope = clear.dataset.clear;
      if (scope === 'g') state.filter = emptyFilter();
      else if (scope === 'x') state.x.filter = {};
      else state.y.filter = {};
      afterChange();
    }
  });

  sideEl.addEventListener('change', (e) => {
    const t = e.target;
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
    if (t.matches('[data-multi]')) {
      const [scope, key] = t.dataset.multi.split('|');
      filterFor(scope)[key] = [...t.selectedOptions].map((o) => o.value);
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

  canvasEl.addEventListener('pointerover', (e) => {
    const mark = e.target.closest('[data-i]');
    if (mark) {
      mark.classList.add('hot');
      showTip(mark);
    }
  });

  canvasEl.addEventListener('pointerout', (e) => {
    const mark = e.target.closest('[data-i]');
    if (!mark) return;
    mark.classList.remove('hot');
    const tip = canvasEl.querySelector('#ch-tip');
    if (tip) tip.hidden = true;
  });

  detailsEl.addEventListener('pointerover', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const mark = canvasEl.querySelector(`[data-i="${row.dataset.row}"]`);
    if (mark) {
      mark.classList.add('hot');
      showTip(mark);
    }
  });

  detailsEl.addEventListener('pointerout', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    canvasEl.querySelector(`[data-i="${row.dataset.row}"]`)?.classList.remove('hot');
    const tip = canvasEl.querySelector('#ch-tip');
    if (tip) tip.hidden = true;
  });

  // ---- load ---------------------------------------------------------------

  async function load(scope = {}) {
    const token = ++loadToken;
    canvasEl.innerHTML = '<p class="view-empty">Loading…</p>';
    try {
      const payload = await fetchStats(scope.demos || null);
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
    } catch (err) {
      if (token !== loadToken) return;
      sideEl.innerHTML = '';
      canvasEl.innerHTML = `<p class="view-empty">${escapeHtml(
        err.message || 'Could not load stats.'
      )}</p>`;
    }
  }

  return {
    el,
    load,
    destroy() {
      el.remove();
    }
  };
}
