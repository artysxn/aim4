// ---------------------------------------------------------------------------
// How far a number sits from its peer average, as a 0 / 1x / 2x mark.
//
// Bands are |delta| thresholds: below `none` is flat, below `mid` is one
// chevron, `mid` and up is two. Sign follows value − peer.
//
// Icons are <img> data-URIs of the files in src/icons/icon_*x{up,down}.svg,
// with fill baked in (autocoach green / T red). currentColor on inline SVG
// was collapsing next to the 28px card type.
// ---------------------------------------------------------------------------

/** |delta| < none → 0, none ≤ |delta| < mid → ±1, |delta| ≥ mid → ±2 */
export const DELTA_BANDS = {
  rating: { none: 0.05, mid: 0.17 },
  swing: { none: 1.0, mid: 2.3 },
  kd: { none: 0.05, mid: 0.17 },
  kpr: { none: 0.04, mid: 0.12 },
  xk: { none: 0.04, mid: 0.12 },
  pct: { none: 1.6, mid: 4.1 },
  winrate: { none: 2.1, mid: 8 }
};

const UP = '#6fcf97';
const DOWN = '#e60611';

const PATH = {
  '1up': 'm480-555.69-184 184L267.69-400 480-612.31 692.31-400 664-371.69l-184-184Z',
  '2up':
    'M296-251.69 267.69-280 480-492.31 692.31-280 664-251.69 480-435.46 296-251.69Zm0-240L267.69-520 480-732.31 692.31-520 664-491.69 480-675.46 296-491.69Z',
  '1down': 'M480-371.69 267.69-584 296-612.31l184 184 184-184L692.31-584 480-371.69Z',
  '2down':
    'M480-229.23 267.69-441.54 296-469.85l184 183.77 184-183.77 28.31 28.31L480-229.23Zm0-238.46L267.69-680 296-708.31l184 183.77 184-183.77L692.31-680 480-467.69Z'
};

function svgUrl(pathD, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="${color}"><path d="${pathD}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const SRC = {
  '1up': svgUrl(PATH['1up'], UP),
  '2up': svgUrl(PATH['2up'], UP),
  '1down': svgUrl(PATH['1down'], DOWN),
  '2down': svgUrl(PATH['2down'], DOWN)
};

/**
 * @param {number|null|undefined} value
 * @param {number|null|undefined} peer
 * @param {{ none: number, mid: number }} bands
 * @returns {-2|-1|0|1|2}
 */
export function deltaLevel(value, peer, bands) {
  const v = Number(value);
  const p = Number(peer);
  if (!Number.isFinite(v) || !Number.isFinite(p) || !bands) return 0;
  const d = v - p;
  const mag = Math.round(Math.abs(d) * 100) / 100;
  if (mag < bands.none) return 0;
  const sign = d > 0 ? 1 : -1;
  if (mag < bands.mid) return sign;
  return /** @type {-2|2} */ (sign * 2);
}

/**
 * Markup for a 1x/2x chevron, or '' when the value is on the average.
 * @param {-2|-1|0|1|2} level
 */
export function deltaMarkHtml(level) {
  const n = Number(level) || 0;
  if (!n) return '';
  const key = n > 0 ? (n >= 2 ? '2up' : '1up') : n <= -2 ? '2down' : '1down';
  const dir = n > 0 ? 'up' : 'down';
  const src = SRC[key];
  return `<span class="pf-delta is-${dir}" aria-hidden="true"><img class="pf-delta-icon" src="${src}" alt="" width="18" height="18" draggable="false" /></span>`;
}

/** Number HTML plus the mark, when both value and peer are finite. */
export function withDeltaHtml(text, value, peer, bands) {
  const mark = deltaMarkHtml(deltaLevel(value, peer, bands));
  if (!mark) return text;
  return `<span class="pf-num">${text}${mark}</span>`;
}
