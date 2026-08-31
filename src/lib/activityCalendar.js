// ---------------------------------------------------------------------------
// lib/activityCalendar.js
// Days into a heatmap grid.
//
// Pure: takes per-day totals and returns the weeks, cells and legend a renderer
// draws. Two sources feed it and stay separate all the way through, because
// they are different claims: trainer seconds are MEASURED (every run reports
// the time it actually took), demo seconds are the length of matches the player
// appeared in. Summing them into one number would bury that difference, so the
// grid carries both and the renderer says which is which.
//
// Intensity is quantile-based rather than fixed. A player who trains twenty
// minutes a day and one who plays six hours should both get a readable
// calendar, and fixed thresholds would flatten one of them to a single shade.
// ---------------------------------------------------------------------------

/** How many shades a day can be, above zero. */
export const LEVELS = 4;

/** Local-time day key, `YYYY-MM-DD`. Local because a player's day is theirs. */
export function dayKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Midnight local time for a day key, as ms. */
export function dayStart(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d).getTime();
}

/**
 * Add seconds (and a count) to a day bucket.
 *
 * @param {Map<string, {demoSeconds: number, demoMatches: number,
 *   trainSeconds: number, trainRuns: number}>} into
 */
export function addToDay(into, ms, { demoSeconds = 0, demoMatches = 0, trainSeconds = 0, trainRuns = 0 } = {}) {
  const key = dayKey(ms);
  if (!key) return into;
  const cur = into.get(key) || {
    demoSeconds: 0,
    demoMatches: 0,
    trainSeconds: 0,
    trainRuns: 0
  };
  cur.demoSeconds += Number(demoSeconds) || 0;
  cur.demoMatches += Number(demoMatches) || 0;
  cur.trainSeconds += Number(trainSeconds) || 0;
  cur.trainRuns += Number(trainRuns) || 0;
  into.set(key, cur);
  return into;
}

/**
 * Thresholds that split the non-empty days into LEVELS bands.
 *
 * Quantiles of the days that HAVE activity, so an idle stretch never darkens
 * the scale, and a single monster session cannot push every ordinary day into
 * the palest shade.
 *
 * @returns {number[]} ascending, length LEVELS - 1
 */
export function levelThresholds(values) {
  const active = (values || []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!active.length) return [];
  const at = (q) => active[Math.min(active.length - 1, Math.floor(q * active.length))];
  // Deduplicated: a library where most days are identical produces repeated
  // cut points, and a repeated cut point is a band no day can ever land in.
  const cuts = [...new Set([at(0.25), at(0.5), at(0.75)])];

  // Collapsed quantiles would also cost the TOP band. Twenty identical days
  // plus one enormous session dedupes to a single cut, which caps the whole
  // calendar at level 2 and renders that session in a pale shade. Spread the
  // missing cuts up to the maximum so the darkest shade stays reachable and
  // still means "a lot, for this player".
  const max = active[active.length - 1];
  while (cuts.length < LEVELS - 1 && cuts[cuts.length - 1] < max) {
    const last = cuts[cuts.length - 1];
    const remaining = LEVELS - cuts.length;
    cuts.push(last + (max - last) / remaining);
  }
  return cuts;
}

/** Which shade a value earns. 0 means no activity at all. */
export function levelFor(value, thresholds) {
  const v = Number(value) || 0;
  if (v <= 0) return 0;
  let level = 1;
  for (const t of thresholds || []) {
    if (v > t) level += 1;
  }
  return Math.min(LEVELS, level);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Rows, Monday first, matching how a week is read. */
export const WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

/** Monday-first weekday index, 0..6. */
function weekdayIndex(date) {
  return (date.getDay() + 6) % 7;
}

/**
 * The grid.
 *
 * Columns are weeks, oldest first; rows are Monday to Sunday. The window
 * starts on the Monday on or before `days` ago, so every column is a whole
 * week and the rows line up, which is the only reason the shape reads as a
 * calendar rather than as a wall of squares.
 *
 * @param {object} args
 * @param {Map<string, object>} args.days per-day totals from addToDay
 * @param {number} [args.days_] window length in days
 * @param {number} [args.today] ms; the last day shown
 * @param {'total'|'demo'|'train'} [args.metric] which seconds decide the shade
 */
export function buildCalendar({ days, window = 90, today = Date.now(), metric = 'total' } = {}) {
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - (Math.max(1, window) - 1) * DAY_MS);
  // Back up to Monday so the first column is a full week.
  start.setDate(start.getDate() - weekdayIndex(start));

  const valueOf = (d) => {
    if (!d) return 0;
    if (metric === 'demo') return d.demoSeconds;
    if (metric === 'train') return d.trainSeconds;
    return d.demoSeconds + d.trainSeconds;
  };

  const cells = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    // Rebuilt from parts rather than added in ms, so a DST shift does not
    // slide the grid by an hour and drop or duplicate a day.
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    date.setDate(date.getDate() + cells.length);
    if (date.getTime() > end.getTime()) break;
    const key = dayKey(date.getTime());
    const totals = days?.get(key) || null;
    cells.push({ key, date, totals, value: valueOf(totals) });
  }

  const thresholds = levelThresholds(cells.map((c) => c.value));
  for (const c of cells) c.level = levelFor(c.value, thresholds);

  // Columns of seven, Monday first. The first column may start mid-week only
  // if the window did; it does not, by construction above.
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // A month label sits over the first column that contains that month's 1st,
  // or over the very first column for the month the window opens in.
  const months = [];
  let lastMonth = -1;
  weeks.forEach((week, i) => {
    const first = week[0];
    if (!first) return;
    const m = first.date.getMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      months.push({ column: i, label: MONTHS[m] });
    }
  });

  const totals = cells.reduce(
    (acc, c) => {
      if (!c.totals) return acc;
      acc.demoSeconds += c.totals.demoSeconds;
      acc.demoMatches += c.totals.demoMatches;
      acc.trainSeconds += c.totals.trainSeconds;
      acc.trainRuns += c.totals.trainRuns;
      if (c.value > 0) acc.activeDays += 1;
      return acc;
    },
    { demoSeconds: 0, demoMatches: 0, trainSeconds: 0, trainRuns: 0, activeDays: 0 }
  );

  return { weeks, months, thresholds, totals, window, metric };
}

/** "2 h 40 min", "35 min", or "none". For cell titles and the summary line. */
export function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s <= 0) return 'none';
  if (s < 60) return `${s} s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** The hover text for one cell. Says which half is which, always. */
export function cellTitle(cell) {
  const when = cell.date.toDateString();
  if (!cell.totals || cell.value <= 0) return `${when}: no activity`;
  const parts = [];
  if (cell.totals.demoSeconds > 0) {
    parts.push(
      `${formatDuration(cell.totals.demoSeconds)} in demos (${cell.totals.demoMatches} ${
        cell.totals.demoMatches === 1 ? 'match' : 'matches'
      })`
    );
  }
  if (cell.totals.trainSeconds > 0) {
    parts.push(
      `${formatDuration(cell.totals.trainSeconds)} in the trainer (${cell.totals.trainRuns} ${
        cell.totals.trainRuns === 1 ? 'run' : 'runs'
      })`
    );
  }
  return `${when}: ${parts.join(', ')}`;
}
