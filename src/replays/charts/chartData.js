// ---------------------------------------------------------------------------
// replays/charts/chartData.js
// Turns a chart spec plus the fact tables into plottable series, with the
// sample sizes and correlation the panel prints under the canvas.
// ---------------------------------------------------------------------------

import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { factPasses, mergeFilters } from './chartFacts.js';
import {
  aggregateMetric,
  findDimension,
  findMetric,
  findSubject,
  formatValue
} from './chartFields.js';

const roundKey = (f) => `${f.file}:${f.team}`;

function factsForSource(facts, source) {
  if (source === 'player') return facts.playerFacts;
  if (source === 'kill') return facts.killFacts;
  return facts.roundFacts;
}

/** Least squares fit plus Pearson r over the plotted points. */
export function correlate(points) {
  const list = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = list.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const p of list) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of list) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  const slope = sxy / sxx;
  const r = sxy / Math.sqrt(sxx * syy);
  return { n, slope, intercept: my - slope * mx, r, r2: r * r };
}

export function correlationWords(r) {
  const a = Math.abs(r);
  const strength =
    a >= 0.7 ? 'strong' : a >= 0.5 ? 'clear' : a >= 0.3 ? 'moderate' : a >= 0.15 ? 'weak' : 'no real';
  return `${strength} ${r >= 0 ? 'positive' : 'negative'} link`;
}

/** Distinct rounds behind a group of facts, which is what min-rounds gates on. */
function roundCount(list) {
  const seen = new Set();
  for (const f of list) seen.add(roundKey(f));
  return seen.size;
}

// ---------------------------------------------------------------------------
// Scatter: one point per subject, both axes measured
// ---------------------------------------------------------------------------

function buildScatter(state, facts) {
  const subject = findSubject(state.subject);
  const source = subject.source;
  const xMetric = findMetric(source, state.x.metric);
  const yMetric = findMetric(source, state.y.metric);
  const base = state.filter;
  const xFilter = mergeFilters(base, state.x.filter);
  const yFilter = mergeFilters(base, state.y.filter);
  const seriesDim = state.series ? findDimension(source, state.series) : null;

  /** @type {Map<string, {facts: object[], x: object[], y: object[], first: object}>} */
  const groups = new Map();
  for (const f of factsForSource(facts, source)) {
    if (!factPasses(f, base)) continue;
    const id = subject.id(f);
    if (!id) continue;
    let g = groups.get(id);
    if (!g) {
      g = { facts: [], x: [], y: [], first: f };
      groups.set(id, g);
    }
    g.facts.push(f);
    if (factPasses(f, xFilter)) g.x.push(f);
    if (factPasses(f, yFilter)) g.y.push(f);
  }

  const points = [];
  const seriesSeen = new Map();
  for (const [id, g] of groups) {
    const rounds = roundCount(g.facts);
    if (rounds < (state.minRounds || 0)) continue;
    const x = aggregateMetric(xMetric, g.x);
    const y = aggregateMetric(yMetric, g.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const sKey = seriesDim ? String(seriesDim.value(g.first) ?? '') : '';
    const sLabel = seriesDim
      ? seriesDim.labelOf
        ? seriesDim.labelOf(g.first)
        : seriesDim.tick
          ? seriesDim.tick(seriesDim.value(g.first))
          : String(seriesDim.value(g.first) ?? '')
      : '';
    if (seriesDim && !seriesSeen.has(sKey)) seriesSeen.set(sKey, sLabel);
    points.push({
      id,
      name: subject.name(g.first),
      sub: subject.sub ? subject.sub(g.first) : '',
      x,
      y,
      rounds,
      xn: g.x.length,
      yn: g.y.length,
      seriesKey: sKey,
      seriesLabel: sLabel
    });
  }

  points.sort((a, b) => b.y - a.y);
  return {
    kind: 'scatter',
    points,
    seriesList: [...seriesSeen.entries()].map(([key, label]) => ({ key, label })),
    xMetric,
    yMetric,
    subject,
    xLabel: axisLabel(xMetric, state.x.filter),
    yLabel: axisLabel(yMetric, state.y.filter)
  };
}

// ---------------------------------------------------------------------------
// Line / bar / distribution: a measure across a grouping
// ---------------------------------------------------------------------------

function buildGrouped(state, facts) {
  const source = state.source;
  const yMetric = findMetric(source, state.y.metric);
  const dim = findDimension(source, state.x.dimension);
  const seriesDim = state.series ? findDimension(source, state.series) : null;
  const base = state.filter;
  const yFilter = mergeFilters(base, state.y.filter);
  const step = Number(state.binStep) > 0 ? Number(state.binStep) : dim.step || 1;

  /** @type {Map<string, {label: string, sort: number, series: Map<string, object[]>}>} */
  const bins = new Map();
  const seriesSeen = new Map();

  for (const f of factsForSource(facts, source)) {
    if (!factPasses(f, yFilter)) continue;
    const raw = dim.value(f);
    if (raw === null || raw === undefined || raw === '') continue;

    let binKey;
    let binLabel;
    let sort;
    if (dim.kind === 'bin') {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      const start = Math.floor(v / step) * step;
      binKey = String(start);
      sort = start;
      binLabel =
        step === 1
          ? dim.tick
            ? dim.tick(start)
            : `${start}`
          : `${trim(start)}-${trim(start + step)}${dim.unit === '%' ? '%' : ''}`;
    } else {
      binKey = String(raw);
      binLabel = dim.labelOf ? dim.labelOf(f) : dim.tick ? dim.tick(raw) : String(raw);
      const order = dim.order || [];
      const idx = order.findIndex((o) => String(o) === binKey);
      sort = idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
    }

    let bin = bins.get(binKey);
    if (!bin) {
      bin = { key: binKey, label: binLabel, sort, series: new Map() };
      bins.set(binKey, bin);
    }
    const sKey = seriesDim ? String(seriesDim.value(f) ?? '') : '';
    if (seriesDim && !seriesSeen.has(sKey)) {
      seriesSeen.set(
        sKey,
        seriesDim.labelOf
          ? seriesDim.labelOf(f)
          : seriesDim.tick
            ? seriesDim.tick(seriesDim.value(f))
            : String(seriesDim.value(f) ?? '')
      );
    }
    if (!bin.series.has(sKey)) bin.series.set(sKey, []);
    bin.series.get(sKey).push(f);
  }

  const ordered = [...bins.values()].sort(
    (a, b) => a.sort - b.sort || a.label.localeCompare(b.label)
  );
  // Categorical bins with no declared order sort by size, biggest first.
  if (dim.kind === 'cat' && !dim.order) {
    ordered.sort((a, b) => totalFacts(b) - totalFacts(a));
  }
  const capped = state.maxCats > 0 ? ordered.slice(0, state.maxCats) : ordered;

  const seriesKeys = seriesDim ? [...seriesSeen.keys()] : [''];
  const seriesList = seriesKeys.map((key) => ({
    key,
    label: seriesDim ? seriesSeen.get(key) : yMetric.label,
    points: []
  }));

  capped.forEach((bin, i) => {
    for (const s of seriesList) {
      const list = bin.series.get(s.key) || [];
      const value = aggregateMetric(yMetric, list);
      s.points.push({
        x: dim.kind === 'bin' ? Number(bin.key) + (step === 1 ? 0 : step / 2) : i,
        xLabel: bin.label,
        y: Number.isFinite(value) ? value : null,
        n: list.length,
        rounds: roundCount(list)
      });
    }
  });

  if (state.normalize) {
    for (const s of seriesList) {
      const total = s.points.reduce((sum, p) => sum + (p.y || 0), 0);
      if (total > 0) for (const p of s.points) p.y = p.y === null ? null : (p.y / total) * 100;
    }
  }

  return {
    kind: state.type === 'bar' ? 'bar' : state.type === 'area' ? 'area' : 'line',
    categorical: dim.kind === 'cat',
    seriesList,
    ticks: capped.map((bin, i) => ({
      x: dim.kind === 'bin' ? Number(bin.key) + (step === 1 ? 0 : step / 2) : i,
      label: bin.label
    })),
    step,
    dim,
    yMetric,
    xLabel: dim.label,
    yLabel: state.normalize ? `${axisLabel(yMetric, state.y.filter)} (share %)` : axisLabel(yMetric, state.y.filter),
    yFmt: state.normalize ? 'pct' : yMetric.fmt
  };
}

const trim = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function totalFacts(bin) {
  let n = 0;
  for (const list of bin.series.values()) n += list.length;
  return n;
}

/** Axis caption: the metric, plus a hint that the axis carries its own filter. */
function axisLabel(metric, axisFilter) {
  if (!metric) return '';
  const parts = filterWords(axisFilter);
  return parts.length ? `${metric.label} (${parts.join(', ')})` : metric.label;
}

const buyWord = (code) =>
  (ECONOMIES[code]?.label || economyLabel(Number(code))).toLowerCase();

/** Short human words for a filter, used in axis captions and the chart title. */
export function filterWords(f) {
  if (!f) return [];
  const out = [];
  if (f.sides?.length) out.push(f.sides.join('/'));
  if (f.maps?.length) out.push(f.maps.map((m) => MAPS[m]?.name || m).join('/'));
  if (f.econ?.length) out.push(f.econ.map(buyWord).join('/'));
  if (f.oppEcon?.length) out.push(`vs ${f.oppEcon.map(buyWord).join('/')}`);
  if (f.hasAwp) out.push('with AWP');
  if (f.oppHasAwp) out.push('vs AWP');
  if (f.result) out.push(f.result);
  if (f.opening) out.push(f.opening);
  if (f.half) out.push(f.half === '2' ? '2nd half' : '1st half');
  if (f.phases?.length) out.push(f.phases.join('/'));
  if (f.killKinds?.length) out.push(f.killKinds.join('/'));
  if (f.weapons?.length) out.push(f.weapons.join('/'));
  if (f.timeFrom !== null && f.timeFrom !== undefined) out.push(`from ${f.timeFrom}s`);
  if (f.timeTo !== null && f.timeTo !== undefined) out.push(`to ${f.timeTo}s`);
  if (f.roundFrom) out.push(`R${f.roundFrom}+`);
  if (f.roundTo) out.push(`to R${f.roundTo}`);
  if (f.teams?.length) out.push(`${f.teams.length} team(s)`);
  if (f.players?.length) out.push(`${f.players.length} player(s)`);
  if (f.matches?.length) out.push(`${f.matches.length} match(es)`);
  return out;
}

/**
 * @param {object} state  the chart spec held by the panel
 * @param {ReturnType<import('./chartFacts.js').buildFacts>} facts
 */
export function computeChart(state, facts) {
  const model = state.type === 'scatter' ? buildScatter(state, facts) : buildGrouped(state, facts);
  const points =
    model.kind === 'scatter'
      ? model.points
      : model.seriesList.flatMap((s) => s.points.filter((p) => p.y !== null));
  model.fit = correlate(points);
  model.count = points.length;
  model.xFmt = model.kind === 'scatter' ? model.xMetric.fmt : model.categorical ? '' : 'num1';
  model.yFmt = model.yFmt || model.yMetric.fmt;
  return model;
}

/** "12.3s" style value text for tooltips and axis ticks. */
export function fmt(value, format) {
  return formatValue(value, format);
}
