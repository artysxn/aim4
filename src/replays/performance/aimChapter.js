// ---------------------------------------------------------------------------
// replays/performance/aimChapter.js
// The Aim chapter: one player's aim, in the aim trainer's own vocabulary.
//
// The page has two halves because the rating does (see aimRatingV2):
//
//   Motion   the seven trainer categories, measured off the demo instead of a
//            scenario. This is the radar, and it is what the trainer's own
//            radar has always shown, so a player can put the two side by side.
//   Outcome  the six measurements the Aim rating was built from before the
//            motion half existed: placement, readiness, accuracy, first bullet
//            and the two flick-miss directions.
//
// Everything here reads the aggregated player row that `playerStats` already
// produces, so the chapter costs no extra fetch and honours every filter the
// rest of the page applies. Nothing is recomputed from rounds a second time.
// ---------------------------------------------------------------------------

import {
  AIM_V2_BASELINES,
  AIM_V2_MIN_SAMPLE,
  AIM_V2_MOTION_KEYS,
  AIM_V2_WEIGHTS
} from '../shared/aimMetrics.js';

/** The outcome half, in display order. */
export const AIM_OUTCOME_KEYS = Object.freeze([
  { key: 'readyRate', label: 'Ready' },
  { key: 'crosshairError', label: 'Placement' },
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'firstBullet', label: 'First bullet' },
  { key: 'overflick', label: 'Overflick' },
  { key: 'underflick', label: 'Underflick' }
]);

const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const f0 = (n) => (Number.isFinite(n) ? Math.round(n).toString() : '—');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const pct1 = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');

/**
 * How each motion statistic reads on screen: its unit, and what a 1.00 rating
 * would be. The baseline line is the whole reason a raw number means anything
 * to a reader who has never seen anybody else's.
 */
export const MOTION_READOUT = Object.freeze({
  precision: {
    unit: (v) => `${f1(v)}%`,
    what: 'of the gap closed per flick',
    baseline: () => '88% is a 1.00'
  },
  speed: {
    unit: (v) => `${f0(v)}°/s`,
    what: 'view travel while flicking',
    baseline: () => `${AIM_V2_BASELINES.speed}°/s is a 1.00`
  },
  flicks: {
    unit: (v) => `${f1(v)}%`,
    what: 'of flicks finish on the target',
    baseline: () => `${AIM_V2_BASELINES.flicks_hit_percent}% is a 1.00`
  },
  adjustments: {
    unit: (v) => f2(v),
    what: 'motions per target killed',
    baseline: () => `${AIM_V2_BASELINES.adjustments} is a 1.00`
  },
  reaction: {
    unit: (v) => `${f0(v)} ms`,
    what: 'to see, and to commit',
    baseline: () => `${AIM_V2_BASELINES.reaction_time_ms} ms is a 1.00`
  },
  tension: {
    unit: (v) => `${f0(v)}%`,
    what: 'longer than the direct path',
    baseline: () => `${AIM_V2_BASELINES.tension_percent}% is a 1.00`
  },
  tracking: {
    unit: (v) => pct1(v),
    what: 'of the fight on the hull',
    baseline: () => `${Math.round(AIM_V2_BASELINES.tracking * 100)}% is a 1.00`
  }
});

/** What each outcome statistic reads as. */
const OUTCOME_READOUT = Object.freeze({
  readyRate: { unit: pct1, what: 'of fights you were already aimed for' },
  crosshairError: { unit: (v) => `${f1(v)}°`, what: 'average miss when a fight starts' },
  accuracy: { unit: pct1, what: 'of shots hit, smoke shots excluded' },
  firstBullet: { unit: pct1, what: 'of first bullets hit' },
  overflick: { unit: pct1, what: 'of first bullets went past' },
  underflick: { unit: pct1, what: 'of first bullets stopped short' }
});

/**
 * The chapter's model, from an aggregated player row.
 *
 * `null` for a player with no aim data at all. `scanned: false` means the
 * motion half has not been measured for these demos yet, which is a loading
 * state and not an empty one.
 */
export function aimModel(stats) {
  if (!stats) return null;
  const components = stats.aimComponents || {};
  const raw = stats.aimRaw || {};
  const sample = stats.aimSample || {};
  const engines = stats.aimEngines || {};

  const motion = AIM_V2_MOTION_KEYS.map(({ key, label }) => ({
    key,
    label,
    score: components[key] ?? null,
    engine: engines[key] ?? null,
    raw: raw[key] ?? null,
    sample: sample[key] || 0,
    need: AIM_V2_MIN_SAMPLE[key],
    weight: AIM_V2_WEIGHTS[key],
    readout: MOTION_READOUT[key]
  }));

  const outcome = AIM_OUTCOME_KEYS.map(({ key, label }) => ({
    key,
    label,
    score: components[key] ?? null,
    raw: raw[key] ?? null,
    sample: sample[key] || 0,
    weight: AIM_V2_WEIGHTS[key],
    readout: OUTCOME_READOUT[key]
  }));

  return {
    rating: Number.isFinite(stats.a4aim) ? stats.a4aim : null,
    v1: Number.isFinite(stats.a4aimV1) ? stats.a4aimV1 : null,
    scanned: Boolean(stats.aimHasMotion),
    rounds: stats.rounds || 0,
    motion,
    outcome,
    /** Every axis that scored, for the "what is holding this back" line. */
    scored: [...motion, ...outcome].filter((c) => Number.isFinite(c.score))
  };
}

/**
 * The two axes furthest from the middle, in each direction.
 *
 * A rating out of 100 is a verdict; this is the part a player can do something
 * with, and it is why the chapter leads with it rather than with the radar.
 */
export function aimHighlights(model) {
  if (!model?.scored.length) return { best: null, worst: null };
  const sorted = [...model.scored].sort((a, b) => b.score - a.score);
  return {
    best: sorted[0] || null,
    worst: sorted[sorted.length - 1] || null
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * The radar, as inline SVG.
 *
 * Deliberately the same seven axes and the same reading direction as the
 * trainer's own radar: a player who has both open is comparing one shape
 * against another, and an axis in a different place would make that comparison
 * silently wrong.
 *
 * Axes without enough sample are drawn at the centre and labelled, rather than
 * dropped: a five-sided polygon where the reader expects seven is a harder
 * thing to understand than a spoke that says how much more data it needs.
 */
export function aimRadarSvg(model, { size = 320 } = {}) {
  const axes = model?.motion || [];
  if (!axes.length) return '';
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 46;
  const n = axes.length;
  const angleAt = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointAt = (i, t) => {
    const a = angleAt(i);
    return [cx + Math.cos(a) * r * t, cy + Math.sin(a) * r * t];
  };

  const rings = [0.25, 0.5, 0.75, 1]
    .map((t) => {
      const pts = axes
        .map((_, i) => pointAt(i, t).map((v) => v.toFixed(1)).join(','))
        .join(' ');
      return `<polygon class="pf-aim-ring${t === 1 ? ' outer' : ''}" points="${pts}" />`;
    })
    .join('');

  const spokes = axes
    .map((_, i) => {
      const [x, y] = pointAt(i, 1);
      return `<line class="pf-aim-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" />`;
    })
    .join('');

  // The baseline ring: where a 1.00 on every axis would sit. It is what turns
  // the shape from a decoration into a comparison.
  const baseT = 0.63;
  const basePts = axes
    .map((_, i) => pointAt(i, baseT).map((v) => v.toFixed(1)).join(','))
    .join(' ');

  const valueOf = (c) => (Number.isFinite(c.score) ? Math.max(0.02, c.score / 100) : 0.02);
  const shape = axes
    .map((c, i) => pointAt(i, valueOf(c)).map((v) => v.toFixed(1)).join(','))
    .join(' ');

  const dots = axes
    .map((c, i) => {
      const [x, y] = pointAt(i, valueOf(c));
      const cls = Number.isFinite(c.score) ? 'pf-aim-dot' : 'pf-aim-dot thin';
      return `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" />`;
    })
    .join('');

  const labels = axes
    .map((c, i) => {
      const [x, y] = pointAt(i, 1.2);
      const anchor = x < cx - 4 ? 'end' : x > cx + 4 ? 'start' : 'middle';
      const score = Number.isFinite(c.score) ? f0(c.score) : '';
      return `<text class="pf-aim-axis" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">
        <tspan class="pf-aim-axis-name">${c.label}</tspan>${
          score ? `<tspan class="pf-aim-axis-score" dx="6">${score}</tspan>` : ''
        }
      </text>`;
    })
    .join('');

  return `<svg class="pf-aim-radar" viewBox="0 0 ${size} ${size}" role="img"
    aria-label="Aim radar, seven categories out of 100">
    ${rings}${spokes}
    <polygon class="pf-aim-base" points="${basePts}" />
    <polygon class="pf-aim-shape" points="${shape}" />
    ${dots}${labels}
  </svg>`;
}

/**
 * One component row, used by both halves.
 *
 * The last column is the number that half is scored on, and the two halves do
 * not share one: Motion carries the trainer's own 0.00 to 2.00 rating, because
 * that is the number a player already knows from their runs, and Outcome
 * carries the 0 to 100 the Aim rating is assembled from. The bar underneath
 * both is the 0 to 100, so the shapes stay comparable however the number reads.
 */
function componentRowHtml(c, escapeHtml, { engineScale = false } = {}) {
  const enough = Number.isFinite(c.score);
  const width = enough ? Math.max(1, Math.min(100, c.score)) : 0;
  const value = c.readout && (enough || c.raw != null) ? c.readout.unit(c.raw) : '—';
  const baseline = enough && c.readout?.baseline ? ` · ${c.readout.baseline()}` : '';
  const note = enough
    ? `${c.readout?.what || ''}${baseline}`
    : `${c.sample} of ${c.need ?? c.sample} samples`;
  const score = !enough
    ? '—'
    : engineScale && Number.isFinite(c.engine)
      ? f2(c.engine)
      : f0(c.score);
  return `<tr class="pf-aim-row${enough ? '' : ' thin'}">
    <th scope="row">${escapeHtml(c.label)}</th>
    <td class="pf-aim-value">${escapeHtml(value)}</td>
    <td class="pf-aim-note">${escapeHtml(note)}</td>
    <td class="pf-aim-bar-cell">
      <span class="pf-aim-bar"><span class="pf-aim-bar-fill" style="width:${width}%"></span></span>
    </td>
    <td class="pf-aim-score">${score}</td>
  </tr>`;
}

function halfHtml(title, rows, escapeHtml, { engineScale = false, foot = '' } = {}) {
  return `<section class="pf-aim-half">
    <h3 class="pf-aim-title">${escapeHtml(title)}</h3>
    <table class="pf-aim-table">
      <thead>
        <tr>
          <th scope="col" colspan="4"><span class="pf-aim-hidden">Category</span></th>
          <th scope="col" class="pf-aim-score">${engineScale ? 'Rating' : 'Score'}</th>
        </tr>
      </thead>
      <tbody>${rows.map((c) => componentRowHtml(c, escapeHtml, { engineScale })).join('')}</tbody>
    </table>
    ${foot ? `<p class="pf-aim-foot">${escapeHtml(foot)}</p>` : ''}
  </section>`;
}

/**
 * The whole chapter body.
 *
 * @param {ReturnType<typeof aimModel>} model
 * @param {(s: string) => string} escapeHtml
 */
export function aimChapterHtml(model, escapeHtml) {
  if (!model) return '<p class="view-empty">No aim data for these matches.</p>';
  const { best, worst } = aimHighlights(model);
  const delta =
    model.scanned && Number.isFinite(model.rating) && Number.isFinite(model.v1)
      ? model.rating - model.v1
      : null;

  const hero = `<div class="pf-aim-hero">
    <div class="pf-aim-hero-main">
      <span class="pf-aim-hero-value">${Number.isFinite(model.rating) ? f1(model.rating) : '—'}</span>
      <span class="pf-aim-hero-label">Aim rating</span>
    </div>
    <dl class="pf-aim-hero-side">
      <div><dt>Strongest</dt><dd>${best ? escapeHtml(best.label) : '—'}</dd></div>
      <div><dt>Weakest</dt><dd>${worst ? escapeHtml(worst.label) : '—'}</dd></div>
      ${
        // Before the motion half exists the two ratings are the same number,
        // and showing it twice with a +0.0 beside it says nothing. Rounds is
        // what a reader wants at that point: how much this is measured over.
        model.scanned
          ? `<div><dt>Outcome only</dt><dd>${
              Number.isFinite(model.v1)
                ? `${f1(model.v1)}${delta != null ? ` <span class="pf-aim-delta">${delta >= 0 ? '+' : ''}${f1(delta)}</span>` : ''}`
                : '—'
            }</dd></div>`
          : `<div><dt>Rounds</dt><dd>${f0(model.rounds)}</dd></div>`
      }
    </dl>
  </div>`;

  const radar = `<div class="pf-aim-radar-wrap">
    ${aimRadarSvg(model)}
    <p class="pf-aim-radar-note">The inner outline is a 1.00 on every category.</p>
  </div>`;

  const motionFoot = model.scanned
    ? ''
    : 'Not measured for these matches yet.';
  const halves = `<div class="pf-aim-halves">
    ${halfHtml('Motion', model.motion, escapeHtml, { engineScale: true, foot: motionFoot })}
    ${halfHtml('Outcome', model.outcome, escapeHtml)}
  </div>`;

  return `${hero}<div class="pf-aim-grid">${radar}${halves}</div>`;
}

/**
 * The loading state, while this player's demos are being measured.
 *
 * The count is the point: a bare spinner over a queue that can be thousands of
 * demos long says nothing, and the reader's own demos are at the front of it.
 */
export function aimScanningHtml(progress, spinner) {
  // Before the first answer there is nothing honest to count. The reader is
  // told what is happening and nothing is invented; the count appears with the
  // first response, which is a fraction of a second later.
  if (!progress) {
    return `<div class="pf-aim-scanning is-loading" role="status" aria-live="polite">
      ${spinner('Checking your matches')}
    </div>`;
  }
  const total = Number(progress?.total) || 0;
  const pending = Number(progress?.pending) || 0;
  const done = Math.max(0, total - pending);
  const pctDone = total > 0 ? Math.round((done / total) * 100) : 0;
  const left = pending === 1 ? '1 match left' : `${pending} matches left`;
  return `<div class="pf-aim-scanning is-loading" role="status" aria-live="polite">
    ${spinner('Measuring your aim')}
    <p class="pf-aim-scan-count">${left}</p>
    <span class="pf-aim-scan-bar"><span style="width:${pctDone}%"></span></span>
    <p class="pf-aim-scan-note">${done} of ${total} measured. This runs once per match.</p>
  </div>`;
}
