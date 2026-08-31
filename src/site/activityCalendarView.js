// ---------------------------------------------------------------------------
// site/activityCalendarView.js
// The activity heatmap, as markup.
//
// One renderer, one source per calendar. The two halves of practice get their
// own grid rather than sharing one, because a shared grid cannot answer either
// question: a dark square could be a long match, a long trainer session, or a
// little of both, and "did I train this week" is exactly what the panel is for.
//
// Compact by construction. The squares are a fixed small size rather than
// stretching to the container, so two calendars sit side by side and neither
// dominates the page it is a footnote on.
// ---------------------------------------------------------------------------

import { LEVELS, WEEKDAYS, cellTitle, formatDuration } from '../lib/activityCalendar.js';

/** Weekday labels are noise at this size; only these three anchor the rows. */
const LABELLED_ROWS = new Set([0, 2, 4]);

/** The summary line for one source. Never a combined total. */
function summaryFor(totals, metric) {
  if (metric === 'demo') {
    const n = totals.demoMatches;
    return `${n} ${n === 1 ? 'match' : 'matches'} · ${formatDuration(totals.demoSeconds)}`;
  }
  if (metric === 'train') {
    const n = totals.trainRuns;
    return `${n} ${n === 1 ? 'run' : 'runs'} · ${formatDuration(totals.trainSeconds)}`;
  }
  return `${formatDuration(totals.demoSeconds)} in demos · ${formatDuration(totals.trainSeconds)} training`;
}

/**
 * @param {ReturnType<import('../lib/activityCalendar.js').buildCalendar>} cal
 * @param {(s: string) => string} escapeHtml
 * @param {{ title?: string, empty?: string }} [opts]
 */
export function activityCalendarHtml(cal, escapeHtml, opts = {}) {
  const esc = escapeHtml;
  const metric = cal.metric || 'total';
  const title = opts.title || 'Activity';

  const head = `<div class="ac-head">
    <h4 class="ac-title">${esc(title)}</h4>
    <span class="ac-sub">${esc(summaryFor(cal.totals, metric))}</span>
  </div>`;

  if (!cal.weeks.length) {
    return `<div class="ac">${head}<p class="ac-empty">${esc(opts.empty || 'Nothing yet.')}</p></div>`;
  }

  // Month labels ride grid tracks so they stay over their column at any width.
  const monthCells = [];
  let col = 0;
  for (const m of cal.months) {
    if (m.column > col) monthCells.push(`<span style="grid-column: span ${m.column - col}"></span>`);
    monthCells.push(`<span class="ac-month">${esc(m.label)}</span>`);
    col = m.column + 1;
  }
  if (col < cal.weeks.length) {
    monthCells.push(`<span style="grid-column: span ${cal.weeks.length - col}"></span>`);
  }

  const columns = cal.weeks
    .map(
      (week) =>
        `<div class="ac-week">${week
          .map(
            (cell) =>
              `<span class="ac-day" data-level="${cell.level}" title="${esc(cellTitle(cell, metric))}"></span>`
          )
          .join('')}</div>`
    )
    .join('');

  const rows = WEEKDAYS.map(
    (d, i) => `<span class="ac-wd">${LABELLED_ROWS.has(i) ? esc(d) : ''}</span>`
  ).join('');

  const scale = Array.from(
    { length: LEVELS + 1 },
    (_, i) => `<span class="ac-day ac-key" data-level="${i}"></span>`
  ).join('');

  return `<div class="ac" data-metric="${esc(metric)}">
    ${head}
    <div class="ac-grid-wrap">
      <div class="ac-months" style="grid-template-columns: repeat(${cal.weeks.length}, var(--ac-cell))">${monthCells.join('')}</div>
      <div class="ac-body">
        <div class="ac-weekdays">${rows}</div>
        <div class="ac-weeks">${columns}</div>
      </div>
    </div>
    <div class="ac-legend">
      <span class="ac-sub">${cal.totals.activeDays} active ${cal.totals.activeDays === 1 ? 'day' : 'days'}</span>
      <span class="ac-scale">${scale}</span>
    </div>
  </div>`;
}

/**
 * Both halves, side by side: mechanics on the left, demos on the right.
 *
 * Each is built from the SAME day map with a different metric, so the two
 * grids always describe the same window and the same days.
 *
 * @param {Map<string, object>} days
 * @param {(cal: object) => object} build  a buildCalendar bound to the window
 */
export function activityPairHtml(days, build, escapeHtml, opts = {}) {
  const train = build({ days, metric: 'train' });
  const demo = build({ days, metric: 'demo' });
  const heading = opts.heading || 'Recent activity';
  const window = train.window;
  return `<section class="ac-pair-wrap">
    <div class="ac-pair-head">
      <h3 class="ac-pair-title">${escapeHtml(heading)}</h3>
      <span class="ac-sub">Last ${window} days</span>
    </div>
    <div class="ac-pair">
      ${activityCalendarHtml(train, escapeHtml, {
        title: 'Training mechanics',
        empty: 'No trainer runs yet.'
      })}
      ${activityCalendarHtml(demo, escapeHtml, {
        title: 'Demos',
        empty: 'No demos yet.'
      })}
    </div>
  </section>`;
}
