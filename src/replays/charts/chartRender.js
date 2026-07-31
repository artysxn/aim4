// ---------------------------------------------------------------------------
// replays/charts/chartRender.js
// Vector rendering for the chart builder. Everything is plain SVG in a fixed
// user-space viewBox scaled to the container width, so a chart stays sharp at
// any size and every mark can carry its own hover target.
// ---------------------------------------------------------------------------

import { formatValue } from './chartFields.js';

export const SERIES_COLORS = [
  '#5ac8fa',
  '#ff9f43',
  '#4cd964',
  '#ff6b81',
  '#b388ff',
  '#ffd93d',
  '#2ec4b6',
  '#f78fb3'
];

const VIEW = { w: 1000, h: 560 };
const PAD = { top: 28, right: 28, bottom: 64, left: 78 };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Ticks on round numbers that cover [min, max]. */
function niceTicks(min, max, target = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
  if (min === max) {
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const stepMul = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
  const step = stepMul * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, min: start, max: end, step };
}

function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return [0, 1];
  return [min, max];
}

/**
 * @param {object} model  from computeChart
 * @param {{title?: string, trendline?: boolean, showZero?: boolean}} opts
 * @returns {{svg: string, points: object[]}} points are indexed by data-i
 */
export function renderChart(model, opts = {}) {
  const plotW = VIEW.w - PAD.left - PAD.right;
  const plotH = VIEW.h - PAD.top - PAD.bottom;
  const hover = [];

  const isScatter = model.kind === 'scatter';
  const isBar = model.kind === 'bar';
  const categorical = !isScatter && model.categorical;

  const allPoints = isScatter
    ? model.points
    : model.seriesList.flatMap((s) => s.points.filter((p) => p.y !== null));
  if (!allPoints.length) {
    return { svg: '', points: [] };
  }

  // ---- scales -------------------------------------------------------------
  const yVals = allPoints.map((p) => p.y);
  if (isBar || model.kind === 'area') yVals.push(0);
  const [yMin, yMax] = extent(yVals);
  const yScaleInfo = niceTicks(yMin, yMax, 6);

  let xTicks;
  let xMin;
  let xMax;
  if (categorical) {
    xMin = -0.5;
    xMax = model.ticks.length - 0.5;
    xTicks = model.ticks.map((t) => ({ value: t.x, label: t.label }));
  } else {
    const [rawMin, rawMax] = extent(allPoints.map((p) => p.x));
    const info = niceTicks(rawMin, rawMax, 7);
    xMin = isScatter ? info.min : Math.min(info.min, rawMin);
    xMax = isScatter ? info.max : Math.max(info.max, rawMax);
    xTicks = info.ticks
      .filter((v) => v >= xMin - 1e-9 && v <= xMax + 1e-9)
      .map((v) => ({ value: v, label: formatValue(v, model.xFmt || 'num1') }));
  }
  if (xMax === xMin) xMax = xMin + 1;

  const sx = (v) => PAD.left + ((v - xMin) / (xMax - xMin)) * plotW;
  const sy = (v) =>
    PAD.top + plotH - ((v - yScaleInfo.min) / (yScaleInfo.max - yScaleInfo.min)) * plotH;

  // ---- frame --------------------------------------------------------------
  const parts = [];
  parts.push(
    `<rect class="ch-bg" x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${plotH}" rx="6" />`
  );

  for (const t of yScaleInfo.ticks) {
    const y = sy(t);
    if (y < PAD.top - 1 || y > PAD.top + plotH + 1) continue;
    parts.push(
      `<line class="ch-grid" x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${(PAD.left + plotW).toFixed(
        1
      )}" y2="${y.toFixed(1)}" />`,
      `<text class="ch-tick ch-tick-y" x="${PAD.left - 10}" y="${(y + 4).toFixed(1)}">${esc(
        formatValue(t, model.yFmt)
      )}</text>`
    );
  }

  const tickSkip = xTicks.length > 16 ? Math.ceil(xTicks.length / 16) : 1;
  xTicks.forEach((t, i) => {
    const x = sx(t.value);
    if (x < PAD.left - 1 || x > PAD.left + plotW + 1) return;
    parts.push(
      `<line class="ch-grid ch-grid-v" x1="${x.toFixed(1)}" y1="${PAD.top}" x2="${x.toFixed(
        1
      )}" y2="${PAD.top + plotH}" />`
    );
    if (i % tickSkip) return;
    const long = String(t.label).length > 8;
    parts.push(
      long
        ? `<text class="ch-tick ch-tick-x" transform="translate(${x.toFixed(1)},${
            PAD.top + plotH + 14
          }) rotate(-32)" text-anchor="end">${esc(t.label)}</text>`
        : `<text class="ch-tick ch-tick-x" x="${x.toFixed(1)}" y="${
            PAD.top + plotH + 20
          }" text-anchor="middle">${esc(t.label)}</text>`
    );
  });

  if (yScaleInfo.min < 0 && yScaleInfo.max > 0) {
    parts.push(
      `<line class="ch-zero" x1="${PAD.left}" y1="${sy(0).toFixed(1)}" x2="${(
        PAD.left + plotW
      ).toFixed(1)}" y2="${sy(0).toFixed(1)}" />`
    );
  }

  // ---- marks --------------------------------------------------------------
  const colorOf = (i) => SERIES_COLORS[i % SERIES_COLORS.length];

  if (isScatter) {
    const keys = model.seriesList.length ? model.seriesList.map((s) => s.key) : [''];
    model.points.forEach((p) => {
      const ci = Math.max(0, keys.indexOf(p.seriesKey));
      const i = hover.length;
      hover.push({
        title: p.name,
        sub: p.sub,
        series: p.seriesLabel,
        rows: [
          [model.xLabel, formatValue(p.x, model.xFmt)],
          [model.yLabel, formatValue(p.y, model.yFmt)],
          ['Rounds', String(p.rounds)]
        ]
      });
      parts.push(
        `<circle class="ch-pt" data-i="${i}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(
          1
        )}" r="6" fill="${colorOf(ci)}" />`
      );
    });
  } else {
    model.seriesList.forEach((s, si) => {
      const color = colorOf(si);
      const live = s.points.filter((p) => p.y !== null);
      if (!live.length) return;

      if (isBar) {
        const groupW = categorical
          ? plotW / Math.max(1, model.ticks.length)
          : (plotW / Math.max(1, model.ticks.length)) * 0.92;
        const barW = Math.max(2, (groupW * 0.72) / model.seriesList.length);
        const base = sy(Math.max(0, yScaleInfo.min));
        s.points.forEach((p) => {
          if (p.y === null) return;
          const cx =
            sx(p.x) - (barW * model.seriesList.length) / 2 + barW * si + barW / 2;
          const y = sy(p.y);
          const top = Math.min(y, base);
          const h = Math.max(1, Math.abs(base - y));
          const i = hover.length;
          hover.push({
            title: p.xLabel,
            sub: s.label,
            series: s.label,
            rows: [
              [model.yLabel, formatValue(p.y, model.yFmt)],
              ['Sample', `${p.n} (${p.rounds} rounds)`]
            ]
          });
          parts.push(
            `<rect class="ch-bar" data-i="${i}" x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(
              1
            )}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" />`
          );
        });
      } else {
        // Line and distribution share the path; distribution fills to baseline.
        const segs = [];
        let cur = [];
        for (const p of s.points) {
          if (p.y === null) {
            if (cur.length) segs.push(cur);
            cur = [];
            continue;
          }
          cur.push(p);
        }
        if (cur.length) segs.push(cur);

        for (const seg of segs) {
          const d = seg
            .map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
            .join(' ');
          if (model.kind === 'area') {
            const base = sy(Math.max(0, yScaleInfo.min));
            parts.push(
              `<path class="ch-area" d="${d} L${sx(seg[seg.length - 1].x).toFixed(
                1
              )} ${base.toFixed(1)} L${sx(seg[0].x).toFixed(1)} ${base.toFixed(
                1
              )} Z" fill="${color}" />`
            );
          }
          parts.push(`<path class="ch-line" d="${d}" stroke="${color}" />`);
        }
        for (const p of live) {
          const i = hover.length;
          hover.push({
            title: p.xLabel,
            sub: s.label,
            series: s.label,
            rows: [
              [model.yLabel, formatValue(p.y, model.yFmt)],
              ['Sample', `${p.n} (${p.rounds} rounds)`]
            ]
          });
          parts.push(
            `<circle class="ch-dot" data-i="${i}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(
              1
            )}" r="5" fill="${color}" />`
          );
        }
      }
    });
  }

  // ---- trendline ----------------------------------------------------------
  if (opts.trendline && model.fit && !categorical) {
    const { slope, intercept } = model.fit;
    const y1 = intercept + slope * xMin;
    const y2 = intercept + slope * xMax;
    const clamp = (v) => Math.min(yScaleInfo.max, Math.max(yScaleInfo.min, v));
    parts.push(
      `<line class="ch-trend" x1="${sx(xMin).toFixed(1)}" y1="${sy(clamp(y1)).toFixed(
        1
      )}" x2="${sx(xMax).toFixed(1)}" y2="${sy(clamp(y2)).toFixed(1)}" />`
    );
  }

  // ---- axis captions ------------------------------------------------------
  parts.push(
    `<text class="ch-axis" x="${(PAD.left + plotW / 2).toFixed(1)}" y="${
      VIEW.h - 14
    }" text-anchor="middle">${esc(model.xLabel)}</text>`,
    `<text class="ch-axis" transform="translate(18,${(PAD.top + plotH / 2).toFixed(
      1
    )}) rotate(-90)" text-anchor="middle">${esc(model.yLabel)}</text>`
  );

  const svg =
    `<svg class="ch-svg" viewBox="0 0 ${VIEW.w} ${VIEW.h}" role="img" ` +
    `preserveAspectRatio="xMidYMid meet" aria-label="${esc(
      `${model.yLabel} against ${model.xLabel}`
    )}">${parts.join('')}</svg>`;

  return { svg, points: hover };
}
