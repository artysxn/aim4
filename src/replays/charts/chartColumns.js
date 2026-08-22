// ---------------------------------------------------------------------------
// replays/charts/chartColumns.js
// Which stats columns a chart actually needs.
//
// Charts used to pull every column of every round whatever you plotted: 8.3 KB
// a round, ~740 MB over a 4100-demo library, to draw a line of kill times. What
// a chart reads is decided by its metric, dimension, series and subject, and
// those are all known before the fetch.
//
// The mapping is explicit rather than inferred, and unknown keys fall back to
// the full set. That ordering matters: a missed mapping should cost a slow
// chart, never a wrong one. `chartColumns.test.js` asserts every registered
// metric and dimension is listed here, so adding one without deciding its
// columns fails the suite instead of silently plotting from absent data.
//
// NOT WIRED YET, and the reason is worth recording. `buildFacts` is
// metric-agnostic: it builds the player, round and kill fact tables from every
// row in one pass, whatever the chart happens to be showing. Fetching a narrow
// contract therefore does not narrow the work — it starves it, and the facts
// for every unfetched column come out empty. Wiring this up first requires
// buildFacts to know which metrics it is being asked for and to skip the rest.
// The mapping below is the input that refactor needs, and the test keeps it
// honest against the metric registry until then.
// ---------------------------------------------------------------------------

import { DIMENSIONS, METRICS } from './chartFields.js';
import { RATING_CORE } from '../shared/statsColumns.js';

/** Groups whose presence pulls in the whole A4R input set. See statsColumns. */
const A4R_TRIGGERS = new Set(['swing', 'aim', 'duels']);

/**
 * Metric key → column groups. Anything reachable from the baseline columns
 * (`p`, `ok`, `od`, sides, economy, timing) maps to an empty list.
 */
export const METRIC_COLUMNS = Object.freeze({
  // ---- player ----
  rounds: [], kills: [], deaths: [], assists: [], damage: [],
  multiKillPct: [], tripleKillPct: [],
  rating: ['kills'], a4r: [...RATING_CORE], a4or: ['swing'],
  impact: [], kpr: [], dpr: [], apr: [], adr: [], kd: [], kast: [], opatt: [],
  psdt: ['movement'], dt: ['movement'], survivalPct: [],
  hsPct: [], accuracy: [], awpAcc: [], shots: [], awpShots: [],
  openKills: [], openDeaths: [], openKillRate: [], openWinPct: [], opkd: [],
  pfw: ['duels'], pfo: ['duels'], tfw: [], xk: ['duels'],
  firstKillTime: ['kills'], deathTime: ['kills'],
  killsEarly: ['kills'], killsMid: ['kills'], killsLate: ['kills'],
  swing: ['swing'], swingTotal: ['swing'], winPct: [], teamPrw: ['prw'],
  teamPossession: ['possession'],
  equip: [], oppEquip: [], eak: [], eadPer1k: [],

  // ---- round ----
  roundsWon: [],
  teamRating: ['kills'], teamKills: [], teamDeaths: [], teamAdr: [],
  teamKd: [], teamKast: [],
  teamHsPct: [], teamAccuracy: [], teamAwpAcc: [],
  prw: ['prw'], prwEdge: ['prw'], teamSwing: ['swing'],
  possession: ['possession'], possessionEdge: ['possession'],
  openKillPct: [], conv5v4: [], conv4v5: [],
  teamPfw: ['duels'], teamPfo: ['duels'], teamXk: ['duels'],
  openingKillTime: ['kills'], roundDuration: [], plantTime: [], plantRate: [],
  teamKillsEarly: ['kills'], teamKillsMid: ['kills'], teamKillsLate: ['kills'],
  teamEquip: [], teamOppEquip: [], equipEdge: [], teamEak: [],

  // ---- kill ----
  // Every kill-source metric reads the round's kill list.
  killCount: ['kills'], openingCount: ['kills'], hsCount: ['kills'],
  killTime: ['kills'], killTimePct: ['kills'], killOrder: ['kills'],
  killHsPct: ['kills'], killGunPct: ['kills'],
  killPostPlantPct: ['kills'], killWinPct: ['kills'],
  victimEquip: ['kills'], attackerEquip: ['kills']
});

/** Dimension key → column groups. */
export const DIMENSION_COLUMNS = Object.freeze({
  time: ['kills'], timePct: ['kills'], killOrder: ['kills'],
  weapon: ['kills'], victim: ['kills'],
  phase: ['phase'],
  roundNo: [], map: [], side: [], econ: [], oppEcon: [], result: [],
  opening: [], half: [], team: [], player: [], match: [], buyEdge: []
});

/**
 * Column contract for one chart configuration.
 *
 * @param {{ metric?: string, dimension?: string, series?: string, subject?: string,
 *           source?: string, extras?: string[] }} config
 * @returns {string[]|null} group ids, or null meaning "everything" — returned
 *   whenever any part of the configuration is unrecognised.
 */
export function columnsForChart(config = {}) {
  const wanted = new Set();
  const keys = [config.metric, ...(config.extras || [])].filter(Boolean);
  for (const key of keys) {
    const cols = METRIC_COLUMNS[key];
    if (!cols) return null;
    for (const c of cols) wanted.add(c);
  }
  for (const key of [config.dimension, config.series, config.subject].filter(Boolean)) {
    const cols = DIMENSION_COLUMNS[key];
    // Series and subject may name a dimension or something else entirely
    // (a saved view, a free-text pick). Unknown means fall back.
    if (!cols) return null;
    for (const c of cols) wanted.add(c);
  }
  // A kill-source chart always walks the kill list, whatever it plots.
  if (config.source === 'kill') wanted.add('kills');

  // Asking for part of the A4R input set is refused by resolveColumns, on
  // purpose. A chart that needs any of those gets all of them: marginally more
  // data, and no chance of a rating built from league averages.
  for (const g of wanted) {
    if (A4R_TRIGGERS.has(g)) {
      for (const c of RATING_CORE) wanted.add(c);
      break;
    }
  }
  return [...wanted].sort();
}

/** Every metric key the registry knows, across all sources. */
export function allMetricKeys() {
  return Object.values(METRICS).flat().map((m) => m.key);
}

/** Every dimension key. */
export function allDimensionKeys() {
  return DIMENSIONS.map((d) => d.key);
}
