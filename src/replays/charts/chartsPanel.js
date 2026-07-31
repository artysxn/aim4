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
import { renderChart } from './chartRender.js';

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
        <div class="ch-canvas" id="ch-canvas"><p class="view-empty">Loading…</p></div>
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

    const rows = [
      scope === 'g'
        ? ''
        : group(
            'Measure',
            checkFlag(scope, 'perRound', 'Divide by played rounds', Boolean(f.perRound))
          ),
      maps.length > 1 ? group('Map', multiSelect(scope, 'maps', maps, arr('maps'))) : '',
      group(
        'Side',
        multiSelect(
          scope,
          'sides',
          SIDES.map((s) => ({ key: s, label: s })),
          arr('sides')
        )
      ),
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
          ${selectHtml(
            `data-exclusive="${scope}|result"`,
            [
              { key: 'won', label: 'Won' },
              { key: 'lost', label: 'Lost' }
            ],
            f.result || '',
            { placeholder: 'Any result' }
          )}
          ${selectHtml(
            `data-exclusive="${scope}|opening"`,
            [
              { key: '5v4', label: '5v4' },
              { key: '4v5', label: '4v5' },
              { key: 'even', label: 'Even' }
            ],
            f.opening || '',
            { placeholder: 'Any opening' }
          )}
          ${selectHtml(
            `data-exclusive="${scope}|half"`,
            [
              { key: '1', label: '1st half' },
              { key: '2', label: '2nd half' }
            ],
            f.half || '',
            { placeholder: 'Any half' }
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
        ${svg}
        <div class="ch-tip" id="ch-tip" hidden></div>
        <div class="ch-info">
          <button type="button" class="ch-info-btn" aria-label="Chart fit details">i</button>
          <div class="ch-info-pop" role="tooltip">${infoPop}</div>
        </div>
      </div>`;

    detailsEl.innerHTML = detailsHtml(model);
  }

  // ---- events -------------------------------------------------------------

  function filterFor(scope) {
    if (scope === 'x') return state.x.filter;
    if (scope === 'y') return state.y.filter;
    return state.filter;
  }

  function afterChange({ rebuildSide = true } = {}) {
    if (rebuildSide) renderSide();
    renderCanvas();
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
    if (t.matches('[data-exclusive]')) {
      const [scope, key] = t.dataset.exclusive.split('|');
      filterFor(scope)[key] = t.value || '';
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
    if (t.matches('[data-multi]')) {
      const [scope, key] = t.dataset.multi.split('|');
      const vals = [...t.selectedOptions].map((o) => o.value);
      filterFor(scope)[key] =
        key === 'econ' || key === 'oppEcon' ? vals.map(Number) : vals;
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
      document.removeEventListener('pointermove', onDocPointerMove);
      hideTip();
      el.remove();
    }
  };
}
