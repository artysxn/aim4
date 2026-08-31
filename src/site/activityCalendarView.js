// ---------------------------------------------------------------------------
// site/activityCalendarView.js
// The activity heatmap, as markup.
//
// One renderer for both pages that show it. Takes a built calendar and returns
// HTML: weekday rows, month labels, a square per day, and a summary that keeps
// demo time and trainer time as two separate numbers rather than one total.
// That split is the whole point of the panel, so it survives into the legend.
// ---------------------------------------------------------------------------

import { LEVELS, WEEKDAYS, cellTitle, formatDuration } from '../lib/activityCalendar.js';

/**
 * @param {ReturnType<import('../lib/activityCalendar.js').buildCalendar>} cal
 * @param {(s: string) => string} escapeHtml
 * @param {{ title?: string, subtitle?: string, empty?: string }} [opts]
 */
export function activityCalendarHtml(cal, escapeHtml, opts = {}) {
  const esc = escapeHtml;
  const title = opts.title || 'Recent activity';
  const subtitle = opts.subtitle || `Last ${cal.window} days`;

  const head = `<div class="ac-head">
    <h3 class="ac-title">${esc(title)}</h3>
    <span class="ac-sub">${esc(subtitle)}</span>
  </div>`;

  if (!cal.weeks.length) {
    return `<section class="ac">${head}<p class="ac-empty">${esc(opts.empty || 'No activity yet.')}</p></section>`;
  }

  // Month labels ride a grid track each, so they stay over their column at any
  // width instead of being positioned by a guessed pixel offset.
  const monthCells = [];
  let col = 0;
  for (const m of cal.months) {
    if (m.column > col) monthCells.push(`<span style="grid-column: span ${m.column - col}"></span>`);
    monthCells.push(`<span class="ac-month" style="grid-column: span 1">${esc(m.label)}</span>`);
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
              `<span class="ac-day" data-level="${cell.level}" title="${esc(cellTitle(cell))}"></span>`
          )
          .join('')}</div>`
    )
    .join('');

  const rows = WEEKDAYS.map((d) => `<span class="ac-wd">${esc(d)}</span>`).join('');

  const scale = Array.from(
    { length: LEVELS + 1 },
    (_, i) => `<span class="ac-day ac-key" data-level="${i}"></span>`
  ).join('');

  const t = cal.totals;
  const summary = [
    `${t.demoMatches} ${t.demoMatches === 1 ? 'match' : 'matches'} played`,
    `${formatDuration(t.demoSeconds)} in demos`,
    `${t.trainRuns} trainer ${t.trainRuns === 1 ? 'run' : 'runs'}`,
    `${formatDuration(t.trainSeconds)} training`
  ].join(' · ');

  return `<section class="ac">
    ${head}
    <div class="ac-grid-wrap">
      <div class="ac-months" style="grid-template-columns: repeat(${cal.weeks.length}, 1fr)">${monthCells.join('')}</div>
      <div class="ac-body">
        <div class="ac-weekdays">${rows}</div>
        <div class="ac-weeks">${columns}</div>
      </div>
    </div>
    <p class="ac-summary">${esc(summary)}</p>
    <div class="ac-legend">
      <span class="ac-sub">Less</span>${scale}<span class="ac-sub">More</span>
      <span class="ac-sub ac-legend-days">${t.activeDays} active ${t.activeDays === 1 ? 'day' : 'days'}</span>
    </div>
  </section>`;
}
