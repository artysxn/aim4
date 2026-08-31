// ---------------------------------------------------------------------------
// site/activityCalendarView.js
// The activity heatmap, as markup.
//
// One renderer, one source per calendar. The two halves of practice get their
// own grid rather than sharing one, because a shared grid cannot answer either
// question: a dark square could be a long match, a long trainer session, or a
// little of both, and "did I train this week" is exactly what the panel is for.
//
// The grid is FLUID: columns are fractions of the container and a day is a
// square by aspect ratio, so the pair fits whatever column it is dropped into
// instead of overflowing or wrapping into a tall stack. A cap keeps it from
// growing into a wall on a wide one; it is a footnote on both pages it appears
// on, and a footnote that fills half the screen is not a footnote.
// ---------------------------------------------------------------------------

import { LEVELS, WEEKDAYS, formatDuration } from '../lib/activityCalendar.js';

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
 * The hover text for one square: the day, then what was done on it.
 *
 * Presentation, not model: `cellTitle` in lib/activityCalendar.js is the
 * one-line form a `title` attribute needs, and this is the two-line form the
 * panel's own tooltip shows. Same numbers, read the way the box above them
 * already reads ("12 runs · 2 h 40 min").
 */
export function cellTipText(cell, metric = 'total') {
  const d = cell.date;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const when = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  });

  const t = cell.totals;
  const lines = [];
  if (t && (metric === 'total' || metric === 'train') && t.trainSeconds > 0) {
    lines.push(`${t.trainRuns} ${t.trainRuns === 1 ? 'run' : 'runs'} · ${formatDuration(t.trainSeconds)}`);
  }
  if (t && (metric === 'total' || metric === 'demo') && t.demoSeconds > 0) {
    lines.push(
      `${t.demoMatches} ${t.demoMatches === 1 ? 'match' : 'matches'} · ${formatDuration(t.demoSeconds)}`
    );
  }
  // On the combined grid a line has to say which half it is, because two
  // numbers with no names is the exact confusion the split was made to end.
  if (metric === 'total' && lines.length === 2) {
    lines[0] = `Training ${lines[0]}`;
    lines[1] = `Demos ${lines[1]}`;
  }
  return lines.length ? `${when}\n${lines.join('\n')}` : `${when}\nNo activity`;
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

  // Month labels ride the same fractional tracks as the weeks below them, so
  // they stay over their column at any width the container happens to be.
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

  // Every column carries seven slots, the last week padded with blanks.
  //
  // Not cosmetic: a square is sized by its aspect ratio, and a column holding
  // one item shares the column's full height with it, which blows that one
  // square up to four times the size of every other and pushes it out past the
  // grid. Seven slots a column, always, and the shape cannot happen.
  const columns = cal.weeks
    .map((week) => {
      const slots = [];
      for (let i = 0; i < 7; i++) {
        const cell = week[i];
        slots.push(
          cell
            ? `<span class="ac-day" data-level="${cell.level}" data-ac-tip="${esc(cellTipText(cell, metric))}"></span>`
            : '<span class="ac-day ac-blank" aria-hidden="true"></span>'
        );
      }
      return `<div class="ac-week">${slots.join('')}</div>`;
    })
    .join('');

  const rows = WEEKDAYS.map(
    (d, i) => `<span class="ac-wd">${LABELLED_ROWS.has(i) ? esc(d) : ''}</span>`
  ).join('');

  const scale = Array.from(
    { length: LEVELS + 1 },
    (_, i) => `<span class="ac-day ac-key" data-level="${i}"></span>`
  ).join('');

  return `<div class="ac" data-metric="${esc(metric)}" style="--ac-weeks: ${cal.weeks.length}">
    ${head}
    <div class="ac-grid-wrap">
      <div class="ac-months">${monthCells.join('')}</div>
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

// ---------------------------------------------------------------------------
// Hovering a day
// ---------------------------------------------------------------------------

let tipEl = null;

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

function ensureTip() {
  if (tipEl?.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'ac-tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  // Once, with the element, not once per bind: a scroll under a pinned
  // tooltip leaves it pointing at nothing, and the aim chapter rebinds on
  // every filter change.
  window.addEventListener('scroll', hideTip, { passive: true });
  return tipEl;
}

/**
 * Hover breakdowns for every square under `root`.
 *
 * Delegated, and bound to the CONTAINER rather than to the squares, so a
 * repaint (a new player, a new window) needs no rebinding: 180 squares a page
 * would otherwise mean 360 listeners thrown away on every render. Marked on
 * the element so calling it again after a repaint is free.
 */
export function attachActivityTips(root) {
  if (!root || root.dataset.acTips === '1') return;
  root.dataset.acTips = '1';

  const hide = hideTip;

  const place = (cell) => {
    const el = ensureTip();
    // Built as nodes rather than as one string: the day is a label and the
    // numbers under it are the answer, and they should not read as one
    // paragraph. textContent per line, so nothing here can inject markup.
    const [when, ...lines] = String(cell.dataset.acTip || '').split('\n');
    el.textContent = '';
    const head = document.createElement('div');
    head.className = 'ac-tip-day';
    head.textContent = when;
    el.append(head);
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'ac-tip-line';
      row.textContent = line;
      el.append(row);
    }
    el.hidden = false;
    const r = cell.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    // Above the square, unless there is no room up there.
    let top = r.top - box.height - 8;
    if (top < 8) top = r.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  root.addEventListener('mouseover', (e) => {
    const cell = e.target.closest?.('[data-ac-tip]');
    if (!cell || !root.contains(cell)) return hide();
    place(cell);
  });
  root.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !root.contains(e.relatedTarget)) hide();
  });
  root.addEventListener('mouseleave', hide);
}
