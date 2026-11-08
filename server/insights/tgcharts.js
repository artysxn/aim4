// ---------------------------------------------------------------------------
// server/insights/tgcharts.js
// Charts for the Telegram bot: Chart.js 2 configs that QuickChart renders to a
// PNG, which telegram.js uploads as a photo. Kept pure so tests can check them.
// Every line can carry a dashed least-squares trendline in the same colour.
// ---------------------------------------------------------------------------

const DAY = 86400e3;
export const dayLabel = (t) => new Date(t).toISOString().slice(5, 10);

/** Least-squares line through the values (the index is x): fitted values and the slope per step. */
export function trendline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
  const n = pts.length;
  if (n < 2) return { fit: values.map(() => null), slope: 0 };
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const slope = sxx ? pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx : 0;
  return { fit: values.map((_, i) => Math.round((my + slope * (i - mx)) * 100) / 100), slope };
}

/** The start of every UTC day from `from` to `to` (ms). */
export function dayGrid(from, to) {
  const out = [];
  for (let t = Math.floor(from / DAY) * DAY; t <= to; t += DAY) out.push(t);
  return out;
}

/** A running total [{t, v}] read at the end of each day, `start` before the first point. */
export function onDays(points, from, to, start = 0) {
  const sorted = points.slice().sort((a, b) => a.t - b.t);
  let i = 0;
  let cur = start;
  return dayGrid(from, to).map((d) => {
    while (i < sorted.length && sorted[i].t < d + DAY) cur = sorted[i++].v;
    return { t: d, v: Math.round(cur * 100) / 100 };
  });
}

/** Settled bets' profit per day over the last `n` days up to `now`. */
export function dailyPnl(bets, n, now = Date.now()) {
  const from = Math.floor(now / DAY) * DAY - (n - 1) * DAY;
  const grid = dayGrid(from, now).map((t) => ({ t, v: 0, n: 0, won: 0 }));
  for (const b of bets) {
    if (!b.settledAt || b.settledAt < from) continue;
    const g = grid[Math.floor((b.settledAt - from) / DAY)];
    if (!g) continue;
    const p = (b.payout || 0) - (b.cost || 0);
    g.v += p;
    g.n++;
    if (p > 0) g.won++;
  }
  return grid.map((g) => ({ ...g, v: Math.round(g.v * 100) / 100 }));
}

/** Running profit of settled bets, one point per bet. */
export function runningPnl(bets) {
  let run = 0;
  return bets
    .filter((b) => b.settledAt && ['won', 'lost', 'sold', 'void'].includes(b.status))
    .sort((a, b) => a.settledAt - b.settledAt)
    .map((b) => ({ t: b.settledAt, v: Math.round((run += (b.payout || 0) - (b.cost || 0)) * 100) / 100 }));
}

const COLORS = ['#2f6fdf', '#e07b25', '#2e9e5b', '#8e44ad', '#d64545', '#139bb0', '#b8920f', '#d63c8a', '#5c9e2e', '#7f8c8d', '#6c5ce7', '#00a389', '#c0392b', '#f39c12', '#16a085', '#a0522d'];
/** The real-money bot's colour, never used for another line. */
export const REAL_COLOR = '#111111';

/**
 * A line chart. series: [{ label, values, color?, trend?, width? }] on shared labels.
 * A series with trend (default on) gets a dashed trendline in its colour.
 */
export function lineChart(title, labels, series, { yLabel = '', trend = true } = {}) {
  const datasets = [];
  series.forEach((s, i) => {
    const color = s.color || COLORS[i % COLORS.length];
    datasets.push({ label: s.label, data: s.values, borderColor: color, backgroundColor: color, fill: false, pointRadius: labels.length <= 31 ? 2 : 0, lineTension: 0, borderWidth: s.width || 2 });
    if (trend && s.trend !== false) datasets.push({ label: `${s.label} · trend`, data: trendline(s.values).fit, borderColor: color, backgroundColor: color, fill: false, pointRadius: 0, lineTension: 0, borderWidth: 1, borderDash: [6, 4] });
  });
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      title: { display: true, text: title, fontSize: 16 },
      legend: { display: true, position: 'bottom', labels: { boxWidth: 12, fontSize: 11 } },
      scales: { yAxes: [{ scaleLabel: { display: Boolean(yLabel), labelString: yLabel }, gridLines: { color: '#eee' } }], xAxes: [{ ticks: { maxTicksLimit: 14 }, gridLines: { display: false } }] }
    }
  };
}

/** A bar chart, green up and red down, with an optional dashed trend line over the bars. */
export function barChart(title, labels, values, { yLabel = '$', trend = true } = {}) {
  const datasets = [{ type: 'bar', label: yLabel, data: values, backgroundColor: values.map((v) => (v >= 0 ? '#2e9e5b' : '#d64545')) }];
  if (trend) datasets.push({ type: 'line', label: 'trend', data: trendline(values).fit, borderColor: '#555', fill: false, pointRadius: 0, borderWidth: 1.5, borderDash: [6, 4] });
  return { type: 'bar', data: { labels, datasets }, options: { title: { display: true, text: title, fontSize: 16 }, legend: { display: false }, scales: { yAxes: [{ scaleLabel: { display: Boolean(yLabel), labelString: yLabel }, gridLines: { color: '#eee' } }], xAxes: [{ gridLines: { display: false } }] } } };
}

/** "+$1.23 a day" from a slope per day. */
export const perDay = (slope) => `${slope >= 0 ? '+' : '-'}$${Math.abs(slope).toFixed(2)} a day`;
