// Run: node src/replays/plays/plays.test.js
//
// The plays: what a round's sides did (default or play), how a guess of them
// is checked, and how a play is judged against the rounds most like it.
//
//   * hand-built rounds: an A execute from a default with a retake and a CT
//     save, a B split, a rush, a CT stack; each read as what it is
//   * a guess: right, the right idea with the wrong kind, a play that was not
//     there, two plays of one kind
//   * a review over a pool where a flash on the site decides it: the flash is
//     found, said to be missing, and is the improvement
//   * the baseline: sites from plants, labelled by the map's hint
//   * the sample demos (when present): a baseline learned, every round read,
//     a review run

import assert from 'node:assert/strict';

import { DEFINITIONS, KINDS, checkGuess, clockOf, elapsedOf, findPlays, summarize } from './findPlays.js';
import { BASELINE_VERSION, baselineJson, learnBaseline, parseBaseline, placeOf, sitesFromPlants } from './playMap.js';
import { choiceOf, reviewPlay } from './playReview.js';
import { dominanceOf } from '../similar/roundSimilarity.js';
import { roundMoves } from './roundMoves.js';
import { lessonsFor, playsReport } from './playTools.js';

// ---- hand-built rounds ----------------------------------------------------------

const RATE = 64;
const STRIDE = 100;
const ROWS = 80;
const SITES = { A: { x: 2000, y: 2000, z: 0, r: 500, plants: 10 }, B: { x: -2000, y: 2000, z: 0, r: 500, plants: 10 } };
const BASELINE = {
  v: BASELINE_VERSION,
  map: 'TST',
  rounds: 0,
  anchors: { tSpawn: [0, -3000], ctSpawn: [0, 3000], sites: SITES, sitesFrom: 'plants' },
  cells: {},
  occupancy: {},
  surprise: {},
  plays: {}
};
const rowE = (r) => (r * STRIDE) / RATE;

/** A path through [seconds, x, y] waypoints, held at both ends. */
function path(points) {
  return (e) => {
    if (e <= points[0][0]) return [points[0][1], points[0][2]];
    for (let i = 1; i < points.length; i++) {
      const [t1, x1, y1] = points[i];
      const [t0, x0, y0] = points[i - 1];
      if (e <= t1) {
        const a = (e - t0) / Math.max(1e-9, t1 - t0);
        return [x0 + (x1 - x0) * a, y0 + (y1 - y0) * a];
      }
    }
    const last = points[points.length - 1];
    return [last[1], last[2]];
  };
}

/**
 * A Similar Rounds index built by hand.
 * @param {object} o
 * @param {Array<(e: number) => [number, number]>} o.paths  ten paths, five T then five CT
 * @param {Array<{ t: number, a: number, v: number }>} [o.kills]
 */
function makeIndex({ file, paths, kills = [], nades = [], plant = null, defuse = null, winner = 'T', win = null, econ = 4 }) {
  const slots = 10;
  const px = new Int16Array(ROWS * slots);
  const py = new Int16Array(ROWS * slots);
  const pz = new Int16Array(ROWS * slots);
  const alive = new Uint8Array(ROWS * slots);
  const gun = new Uint8Array(ROWS * slots).fill(4);
  const death = new Int32Array(slots).fill(-1);
  for (const k of kills) death[k.v] = Math.round(k.t * RATE);
  for (let r = 0; r < ROWS; r++) {
    for (let s = 0; s < slots; s++) {
      const [x, y] = paths[s](rowE(r));
      const i = r * slots + s;
      px[i] = Math.round(x);
      py[i] = Math.round(y);
      alive[i] = death[s] < 0 || death[s] > r * STRIDE ? 1 : 0;
    }
  }
  const live = Math.floor((115 * RATE) / STRIDE);
  const series = win || Array.from({ length: live }, () => 50);
  return {
    v: 2,
    file,
    map: 'TST',
    round: 1,
    tickRate: RATE,
    firstTick: 0,
    stride: STRIDE,
    rows: ROWS,
    slots,
    freezeEndTick: 0,
    endTick: 115 * RATE,
    winnerSide: winner,
    teams: { T: { id: 'TTT', name: 'Attack', econ }, CT: { id: 'CCC', name: 'Defence', econ } },
    ids: Array.from({ length: slots }, (_, s) => `p${s}`),
    names: ['t0', 't1', 't2', 't3', 't4', 'ct5', 'ct6', 'ct7', 'ct8', 'ct9'],
    slotSide: Int8Array.from([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]),
    px,
    py,
    pz,
    alive,
    gun,
    death,
    kills: [...kills].sort((a, b) => a.t - b.t),
    plant,
    defuse,
    nades,
    win: Uint8Array.from([...series, winner === 'T' ? 100 : 0]),
    dominance: { T: dominanceOf([...series, winner === 'T' ? 100 : 0]), CT: dominanceOf([...series, winner === 'T' ? 100 : 0].map((v) => 100 - v)) }
  };
}

const still = (x, y) => path([[0, x, y]]);
const CT_SETUP = [still(2000, 2300), still(1900, 2400), still(0, 2000), still(-2000, 2300), still(-1900, 2400)];

/** T default (2 A side, 1 mid, 2 B side) until 0:55 in, then all onto A with three smokes, plant, retake, save. */
function executeA({ file = 'exec-a', flash = false, won = true } = {}) {
  const t = [
    path([[0, 0, -3000], [15, 1800, 600], [57, 1800, 800], [62, 2000, 2000]]),
    path([[0, 100, -3000], [15, 1900, 600], [57, 1900, 800], [63, 2050, 1950]]),
    path([[0, 0, -2900], [15, 0, -500], [50, 0, -500], [57, 1700, 800], [64, 1950, 2050]]),
    path([[0, -100, -3000], [15, -1800, 600], [50, -1800, 600], [57, 1600, 700], [65, 2000, 1900]]),
    path([[0, -200, -3000], [15, -1900, 600], [50, -1900, 600], [57, 1650, 750], [66, 2100, 2000]])
  ];
  const ct = [...CT_SETUP];
  // After the plant the two B players walk over together.
  ct[3] = path([[0, -2000, 2300], [72, -2000, 2300], [85, 1950, 2100]]);
  ct[4] = path([[0, -1900, 2400], [72, -1900, 2400], [86, 2050, 2150]]);
  const nades = [
    { kind: 1, side: 1, x: 2000, y: 2300, z: 0, t: 55, slot: 0 },
    { kind: 1, side: 1, x: 1800, y: 2200, z: 0, t: 56, slot: 1 },
    { kind: 2, side: 1, x: 2050, y: 2050, z: 0, t: 58, slot: 2 }
  ];
  if (flash) nades.push({ kind: 3, side: 1, x: 2000, y: 2100, z: 0, t: 59, slot: 3 });
  const live = Math.floor((115 * RATE) / STRIDE);
  // The T win chance: even, then up through the hit if it works, down if not.
  const win = Array.from({ length: live }, (_, i) => {
    const e = rowE(i);
    if (e < 55) return 50;
    return won ? Math.min(95, 50 + (e - 55) * 3) : Math.max(5, 50 - (e - 55) * 3);
  });
  return makeIndex({
    file,
    paths: [...t, ...ct],
    kills: won
      ? [
          { t: 63, a: 0, v: 5 },
          { t: 64, a: 1, v: 6 },
          { t: 88, a: 2, v: 8 },
          { t: 89, a: 3, v: 9 }
        ]
      : [
          { t: 63, a: 5, v: 0 },
          { t: 64, a: 6, v: 1 },
          { t: 65, a: 5, v: 2 },
          { t: 66, a: 6, v: 3 },
          { t: 67, a: 5, v: 4 }
        ],
    nades,
    plant: won ? { t: 70, site: 'A', x: 2000, y: 2000, slot: 0 } : null,
    winner: won ? 'T' : 'CT',
    win
  });
}

// ---- reading a round -------------------------------------------------------------
{
  const index = executeA();
  const { plays, plantSite } = findPlays(index, BASELINE);
  const kinds = plays.map((p) => `${p.side} ${p.kind}`);
  assert.equal(plantSite, 'A', 'the plant is on A by where it happened');
  const hit = plays.find((p) => p.kind === 'execute');
  assert.ok(hit, `an A execute: three grenades on A before the Ts stepped on it (${kinds.join(', ')})`);
  assert.equal(hit.site, 'A');
  assert.equal(hit.players.length, 5, 'all five in the wave');
  assert.equal(hit.planted_at, clockOf(70));
  assert.deepEqual(hit.utility, { smoke: 2, molotov: 1 });
  const def = plays.find((p) => p.kind === 'default');
  assert.ok(def?.default, 'the time before the commitment is a default, and marked as one');
  assert.ok(def.end <= hit.start + 0.01, 'the default ends where the hit starts');
  assert.match(def.label, /2 A, 1 mid, 2 B/, 'the default shape: two toward A, one mid, two toward B');
  const setup = plays.find((p) => p.side === 'CT' && p.kind === 'setup');
  assert.match(setup.label, /setup 2-1-2/, 'CT stood 2-1-2');
  assert.equal(setup.default, true, 'with no baseline to say otherwise, a setup is a default');
  const retake = plays.find((p) => p.kind === 'retake');
  assert.match(retake?.label || '', /retake A together/, 'two CTs onto the planted site within 5 s: a retake together');
  const save = plays.find((p) => p.side === 'CT' && p.kind === 'save');
  assert.deepEqual(save?.players, ['ct7'], 'the CT who never went to the bomb saved');
  assert.ok(plays.find((p) => p.kind === 'postplant'), 'a post-plant is read after the plant');
  const opening = plays.find((p) => p.kind === 'opening');
  assert.equal(opening.side, 'T', 'the first kill was the Ts\'');
  assert.ok(!plays.some((p) => p.kind === 'lurk'), 'nobody stayed behind: no lurk');
  // Outcomes come from the win series.
  assert.ok(hit.outcome.swing_pp > 0, 'the hit raised the T win chance');
  assert.equal(hit.outcome.round_won, true);
  // Ids in clock order per side.
  assert.deepEqual(
    plays.filter((p) => p.side === 'T').map((p) => p.id),
    plays.filter((p) => p.side === 'T').map((_, i) => `T${i + 1}`)
  );
  const text = summarize(index, plays);
  assert.match(text, /^T \(Attack\), full buy: a default until/, 'the summary starts with what T did');
  assert.match(text, /an A execute/);
  assert.match(text, /T won the round after the plant\.$/);

  // The unlabelled view names no plays.
  const moves = roundMoves(index, BASELINE);
  const flat = JSON.stringify(moves);
  assert.equal(moves.paths.length, 10, 'every player\'s path');
  for (const word of ['execute', 'default', 'retake', 'stack', 'rotate']) assert.ok(!flat.includes(word), `round_moves does not say "${word}"`);
  assert.ok(moves.utility.some((u) => /T smoke by t0 landed A site/.test(u)), 'grenades with where they landed');
  assert.match(moves.plant, /by t0 on A/);

  const report = playsReport(index, plays, { usualFrom: 'test' });
  assert.equal(report.plays.length, plays.length);
  assert.ok(!('raw' in report.plays[0]), 'the internals stay out of what the model reads');
}

// A B split: two lanes onto B together.
{
  const t = [
    path([[0, 0, -3000], [30, -2000, 900], [52, -2000, 1100], [58, -2000, 1900]]),
    path([[0, 0, -3000], [30, -1900, 900], [52, -1900, 1100], [59, -1950, 1950]]),
    path([[0, 0, -3000], [30, -3300, 1900], [52, -3100, 2000], [60, -2300, 2000]]),
    path([[0, 0, -3000], [30, -3300, 2100], [52, -3100, 2100], [61, -2350, 2050]]),
    path([[0, 0, -3000], [30, 0, -500]])
  ];
  const index = makeIndex({ file: 'split-b', paths: [...t, ...CT_SETUP], winner: 'CT' });
  const hit = findPlays(index, BASELINE).plays.find((p) => p.side === 'T' && ['split', 'execute', 'rush', 'contact'].includes(p.kind));
  assert.equal(hit?.kind, 'split', `four Ts onto B from the south and the west within 12 s is a split (${hit?.label})`);
  assert.equal(hit.lanes.length, 2, 'two lanes');
}

// A rush: on the site before 1:25.
{
  const t = Array.from({ length: 5 }, (_, i) => path([[0, i * 50, -3000], [20 + i, -2000 + i * 30, 2000]]));
  const index = makeIndex({ file: 'rush-b', paths: [...t, ...CT_SETUP] });
  const plays = findPlays(index, BASELINE).plays;
  assert.equal(plays.find((p) => p.side === 'T' && p.kind === 'rush')?.site, 'B', 'on B by 1:34: a rush');
  assert.ok(!plays.some((p) => p.kind === 'default'), 'straight into a hit: no default');
}

// A CT stack: four on A once set up.
{
  const ct = [still(2000, 2300), still(1900, 2400), still(2200, 2200), still(1700, 2100), still(-2000, 2300)];
  const t = Array.from({ length: 5 }, (_, i) => still(i * 50, -2000));
  const index = makeIndex({ file: 'stack-a', paths: [...t, ...ct], winner: 'CT' });
  const stack = findPlays(index, BASELINE).plays.find((p) => p.kind === 'stack');
  assert.equal(stack?.site, 'A', 'four CTs on A: a stack');
  assert.equal(stack.players.length, 4);
}

// ---- checking a guess --------------------------------------------------------------
{
  const plays = findPlays(executeA(), BASELINE).plays;
  const right = plays.filter((p) => p.kind !== 'opening').map((p) => ({ side: p.side, kind: p.kind, site: p.site, clock: p.clock }));
  assert.equal(checkGuess(right, plays).score, 100, 'every play, right kind, site and clock: 100');
  const hit = plays.find((p) => p.kind === 'execute');
  const contact = right.map((g) => (g.kind === 'execute' ? { ...g, kind: 'contact' } : g));
  const half = checkGuess(contact, plays);
  assert.ok(half.score < 100 && half.score > 70, 'a contact for an execute: the right idea, half the credit');
  assert.equal(half.right.find((r) => r.play === hit.id).credit, 0.5);
  const wrongSite = right.map((g) => (g.kind === 'execute' ? { ...g, site: 'B' } : g));
  assert.ok(checkGuess(wrongSite, plays).missed.some((m) => m.play === hit.id), 'the wrong site is a miss');
  const extra = checkGuess([...right, { side: 'CT', kind: 'stack', site: 'B' }], plays);
  assert.match(extra.wrong[0].why, /no CT stack on B in this round/, 'a play that was not there is named and says what CT did');
  assert.equal(checkGuess([], plays).score, 0, 'no guess, no score');
  assert.equal(elapsedOf('1:55'), 0);
  assert.equal(clockOf(elapsedOf('0:42')), '0:42');
  for (const k of KINDS) assert.ok(DEFINITIONS[k], `${k} has a definition`);
}

// ---- judging a play against similar rounds ----------------------------------------
{
  // Twelve A executes with a flash on the site, all won; twelve without, all lost.
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(executeA({ file: `with-${i}`, flash: true, won: true }));
  for (let i = 0; i < 12; i++) pool.push(executeA({ file: `without-${i}`, flash: false, won: false }));
  const source = executeA({ file: 'source', flash: false, won: false });
  const plays = findPlays(source, BASELINE).plays;
  const hit = plays.find((p) => p.kind === 'execute');
  const review = reviewPlay({ source, play: hit, pool, baseline: BASELINE });
  assert.equal(review.similar.rounds, 24, 'every round of the pool is alike at the moment');
  assert.equal(review.this_play.choice, 'execute A');
  const flash = review.what_helped.find((h) => /flash/.test(h.what));
  assert.ok(flash, `the flash on A is found (${JSON.stringify(review.what_helped)})`);
  assert.equal(flash.this_play, 'missing', 'and this play did not have it');
  assert.deepEqual([flash.with.won, flash.with.rounds, flash.without.won, flash.without.rounds], [12, 12, 0, 12]);
  assert.match(review.improve[0], /^Add a flash landing on A site/, 'the improvement is the flash');
  assert.equal(review.verdict, 'bad', 'it went worse than the same choice usually goes, and lacked what won');
  assert.equal(reviewPlay({ source, play: hit, pool, baseline: BASELINE, guess: { verdict: 'good' } }).your_guess.right, false, 'a wrong guess is checked as wrong');

  // Too few similar rounds: the autocoach's rules come in, marked as rules.
  const thin = reviewPlay({ source, play: hit, pool: pool.slice(0, 3), baseline: BASELINE, coachFlags: [{ e: hit.start + 2, player: 't0', side: 'T', rule: 'dry-peek', text: 'peeked without a flash' }] });
  assert.equal(thin.similar.trust, 'thin');
  assert.equal(thin.confidence, 'low');
  assert.equal(thin.guidelines.flags[0].rule, 'dry-peek', 'the flag in the play\'s window is attached');
  assert.match(thin.guidelines.note, /not measurements/);

  assert.equal(choiceOf(plays, 'T', 'hit', hit.start).key, 'execute A');
  assert.equal(choiceOf([], 'T', 'hit', 10).key, 'no hit');
}

// ---- the baseline ---------------------------------------------------------------------
{
  // Two clusters of plants; the hint for Dust2 says which one is A.
  const plants = [
    [1000, 2500, 0],
    [1050, 2450, 0],
    [980, 2600, 0],
    [-1550, 2550, 0],
    [-1600, 2500, 0],
    [-1500, 2600, 0]
  ];
  const sites = sitesFromPlants('DD2', plants);
  assert.ok(sites.A.x > 0 && sites.B.x < 0, 'Dust2: A is the long side');
  assert.equal(sites.from, 'plants');
  assert.match(sitesFromPlants('XYZ', plants).from, /guessed/, 'a map with no hint says its labels are guessed');
  const named = sitesFromPlants('DD2', plants, { A: { x: 1, y: 2 }, B: { x: 3, y: 4 } });
  assert.equal(named.from, 'zones', 'a zone network names the sites');
  const p = placeOf(BASELINE, 2000, 2050);
  assert.deepEqual([p.site, p.ground, p.name], ['A', 'A', 'A site']);
  assert.equal(placeOf(BASELINE, 0, -3000).spawn, 'T');

  // Learned from rounds: anchors, cells, frequencies, and a round trip through JSON.
  const rounds = [executeA({ file: 'a1' }), executeA({ file: 'a2' }), executeA({ file: 'a3', won: false })];
  const { findPlays: fp, playKeys } = await import('./findPlays.js');
  const learned = await learnBaseline('TST', { each: (fn) => rounds.forEach(fn), playsOf: playKeys });
  assert.deepEqual(learned.anchors.tSpawn, [-40, -2980], 'the T spawn is where the Ts stand at freeze end (their mean)');
  assert.ok(learned.anchors.sites.A, 'a site from the plants');
  assert.ok(learned.plays['T|full'].kinds['execute A'] >= 2, 'how often the A execute was run');
  const again = parseBaseline(baselineJson(learned));
  assert.deepEqual(fp(rounds[0], again).plays.map((x) => x.label), fp(rounds[0], learned).plays.map((x) => x.label), 'a baseline read back from JSON reads rounds the same');
  assert.ok(fp(rounds[0], learned).plays.find((x) => x.kind === 'execute').usual, 'a play says how usual it is');
}

// ---- lessons --------------------------------------------------------------------------
{
  const notes = {
    lessons: [
      { map: 'TST', kind: 'execute', weight: 3, text: 'map execute' },
      { kind: 'retake', weight: 9, text: 'general retake' },
      { map: 'OTHER', weight: 99, text: 'other map' },
      { weight: 1, text: 'general' }
    ]
  };
  assert.deepEqual(lessonsFor(notes, { map: 'TST', kinds: ['execute', 'retake'] }), ['map execute', 'general retake', 'general'], 'this map first, then by weight; other maps never');
  assert.deepEqual(lessonsFor(null, { map: 'TST' }), [], 'no notes, no lessons');
}

// ---- the sample demos -------------------------------------------------------------------
{
  const { listSampleRoundNames, getSampleRoundMeta, getSampleRoundTicks } = await import('../../../server/replays/sampleDemos.js');
  const { buildRoundIndex } = await import('../similar/roundSimilarity.js');
  const { playKeys } = await import('./findPlays.js');
  const names = (await listSampleRoundNames()).filter((n) => n.includes('-CCH-'));
  if (names.length < 20) {
    console.log('plays.test.js: sampledemos/ has no Cache rounds, sample checks skipped');
  } else {
    const indexes = [];
    for (const n of names) indexes.push(buildRoundIndex(await getSampleRoundMeta(n), await getSampleRoundTicks(n, 100), n));
    const baseline = await learnBaseline('CCH', { each: (fn) => indexes.forEach(fn), playsOf: playKeys });
    assert.ok(baseline.anchors.sites.A.y > baseline.anchors.sites.B.y, 'Cache: A is the north site');
    let hits = 0;
    for (const index of indexes) {
      const { plays } = findPlays(index, baseline);
      assert.ok(plays.length, `${index.file}: some plays`);
      for (const p of plays) assert.ok(p.outcome.win_before != null, `${p.label}: a win chance`);
      if (plays.some((p) => ['execute', 'split', 'rush', 'contact'].includes(p.kind))) hits++;
      assert.ok(summarize(index, plays).length > 40);
    }
    assert.ok(hits / indexes.length > 0.6, `most rounds have a hit (${hits} of ${indexes.length})`);
    const source = indexes.find((i) => findPlays(i, baseline).plays.some((p) => p.kind === 'execute'));
    const play = findPlays(source, baseline).plays.find((p) => p.kind === 'execute');
    const review = reviewPlay({ source, play, pool: indexes, baseline });
    assert.ok(['good', 'bad', 'mixed'].includes(review.verdict));
    assert.ok(review.similar.rounds > 0 && !review.similar.examples.some((x) => x.round === source.file), 'never the round itself');
  }
}

console.log('plays.test.js: all assertions passed');
