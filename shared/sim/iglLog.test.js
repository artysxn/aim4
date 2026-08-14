// Run: node shared/sim/iglLog.test.js

import { PICTURE_FIELDS } from './prw.js';
import {
  HOLDOUT_FRACTION,
  IGL_EVENT,
  IGL_LOG_VERSION,
  createIglLog,
  hashString,
  ledgerRows,
  splitMatches,
  stratumOf,
  toJsonl,
  trainableRows
} from './iglLog.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const picture = (over = {}) => ({
  side: 'T',
  alive: 5,
  enemyAlive: 5,
  clock: 0,
  secondsLeft: 115,
  planted: false,
  hasKit: false,
  contactRel: null,
  siteExpectedTarget: 0,
  siteExpectedOther: 0,
  packAtTarget: 0,
  ...over
});

// ---- one row per decision, not per tick ----------------------------------

{
  const log = createIglLog({ side: 'T', map: 'INF', econ: 4, matchId: 'm1' });
  log.log({ tick: 0, event: IGL_EVENT.FREEZE, picture: picture(), call: 'a-exec', entry: { id: 't1', call: 'a-exec' }, decision: 'commit', pWinBelief: 0.5 });
  log.log({ tick: 640, event: IGL_EVENT.RECALL, picture: picture({ clock: 20 }), decision: 'turnaround', recalled: true, pWinBelief: 0.4 });
  assert(log.size() === 2, 'a freeze and a recall are two rows');
  const rows = log.rows();
  assert(rows[0].event === IGL_EVENT.FREEZE && rows[1].recalled === true, 'and they say which is which');
  assert(rows.every((r) => r.v === IGL_LOG_VERSION), 'versioned');
  assert(rows.every((r) => r.pWin_true === null && r.won === null), 'nothing from the future is in a live row');
}

// ---- no positions, ever --------------------------------------------------

{
  const log = createIglLog({ side: 'CT', map: 'INF' });
  log.log({
    tick: 10,
    picture: { ...picture({ side: 'CT' }), x: 1200, y: -450, enemyPositions: [{ x: 1, y: 2 }], anchor: 'site_a' }
  });
  const [row] = log.rows();
  const keys = Object.keys(row.picture);
  assert(!keys.includes('x') && !keys.includes('y'), 'coordinates do not reach the dataset');
  assert(!keys.includes('enemyPositions') && !keys.includes('anchor'), 'nor anything object-shaped or named');
  assert(keys.every((k) => PICTURE_FIELDS.includes(k)), 'the allowlist is the allowlist');
}

// ---- the seal: outcome, attribution, and the true price ------------------

{
  const log = createIglLog({ side: 'T', map: 'INF', econ: 4, matchId: 'm1' });
  log.log({ tick: 0, event: IGL_EVENT.FREEZE, picture: picture(), pWinBelief: 0.5 });
  log.log({ tick: 500, event: IGL_EVENT.RECALL, picture: picture(), pWinBelief: 0.7, recalled: true });
  assert(log.isSealed() === false, 'not sealed yet');

  const prwRows = [
    { tick: 0, pWin_true: 0.5, pWin_belief: 0.5 },
    { tick: 480, pWin_true: 0.3, pWin_belief: 0.7 },
    { tick: 900, pWin_true: 0.1, pWin_belief: 0.6 }
  ];
  const sealed = log.seal({ won: false, attrib: 'perc', prwRows });
  assert(log.isSealed() === true, 'sealed');
  assert(sealed.every((r) => r.won === false && r.attrib === 'perc'), 'the round is on every decision in it');
  assert(sealed[0].pWin_true === 0.5, 'the freeze took the row at its own tick');
  assert(sealed[1].pWin_true === 0.3, 'the recall took the last graded row AT OR BEFORE it, not the next one');
  assert(Math.abs(sealed[1].residual - (0.3 - 0.7)) < 1e-9, 'residual is truth minus belief');
}

{
  // A row before any graded PRW row keeps a null truth rather than guessing.
  const log = createIglLog({ side: 'T', map: 'INF' });
  log.log({ tick: 5, picture: picture(), pWinBelief: 0.5 });
  const sealed = log.seal({ won: true, attrib: 'call', prwRows: [{ tick: 900, pWin_true: 0.8 }] });
  assert(sealed[0].pWin_true === null, 'no truth is better than the wrong truth');
  assert(sealed[0].won === true, 'the outcome still lands');
}

// ---- only `call` rows may move a situation's value -----------------------

{
  const rows = [
    { attrib: 'call' },
    { attrib: 'exec' },
    { attrib: 'perc' },
    { attrib: null }
  ];
  const trainable = trainableRows(rows);
  assert(trainable.length === 2, 'call rows and unlabelled rows train');
  assert(!trainable.some((r) => r.attrib === 'exec' || r.attrib === 'perc'), 'exec and perc do not');
  assert(ledgerRows(rows).length === 2, 'and those two go to the ledger instead');
}

// ---- holdout is by match, stratified, and deterministic ------------------

{
  const rows = [];
  for (let m = 0; m < 10; m += 1) {
    for (let r = 0; r < 6; r += 1) {
      rows.push({ matchId: `m${m}`, map: 'INF', side: 'T', call: 'a-exec', econ: 4000, round: r });
    }
  }
  const { train, val, holdout } = splitMatches(rows, { fraction: HOLDOUT_FRACTION, salt: 's' });
  assert(train.length + val.length === rows.length, 'every row lands somewhere');
  assert(val.length > 0, 'and the holdout is not empty');
  // The unit is the match: no match may appear on both sides of the split.
  const trainMatches = new Set(train.map((r) => r.matchId));
  for (const id of holdout) {
    assert(!trainMatches.has(id), `${id} leaked across the split`);
  }
  const again = splitMatches(rows, { fraction: HOLDOUT_FRACTION, salt: 's' });
  assert([...again.holdout].join() === [...holdout].join(), 'the same salt gives the same split');
  const other = splitMatches(rows, { fraction: HOLDOUT_FRACTION, salt: 'different' });
  assert([...other.holdout].join() !== [...holdout].join(), 'a different salt does not');
}

{
  // Stratified: an under-represented call still contributes a val match
  // instead of being swallowed by the majority stratum.
  const rows = [];
  for (let m = 0; m < 8; m += 1) {
    rows.push({ matchId: `common${m}`, map: 'INF', side: 'T', call: 'a-exec', econ: 4000 });
  }
  for (let m = 0; m < 4; m += 1) {
    rows.push({ matchId: `rare${m}`, map: 'INF', side: 'T', call: 'b-rush', econ: 4000 });
  }
  const { holdout, strata } = splitMatches(rows, { fraction: 0.25, salt: 's' });
  assert(strata === 2, 'two strata');
  assert([...holdout].some((id) => id.startsWith('rare')), 'the rare call is represented in val');
  assert([...holdout].some((id) => id.startsWith('common')), 'so is the common one');
}

{
  const a = stratumOf({ map: 'INF', side: 'T', call: 'a-exec', econ: 4100 });
  const b = stratumOf({ map: 'INF', side: 'T', call: 'a-exec', econ: 4300 });
  assert(a === b, 'econ is bucketed: $4,100 and $4,300 are one stratum');
  const c = stratumOf({ map: 'INF', side: 'CT', call: 'a-exec', econ: 4100 });
  assert(a !== c, 'but the sides are not');
  assert(hashString('x') === hashString('x'), 'the hash is stable');
  assert(hashString('x') !== hashString('y'), 'and discriminates');
}

// ---- JSONL is JSONL ------------------------------------------------------

{
  const text = toJsonl([{ a: 1 }, { b: 2 }]);
  const lines = text.split('\n');
  assert(lines.length === 2, 'one row per line');
  assert(JSON.parse(lines[0]).a === 1 && JSON.parse(lines[1]).b === 2, 'and each parses alone');
}

{
  const log = createIglLog({ side: 'T', map: 'INF' });
  log.log({ tick: 1, picture: picture() });
  assert(log.drain().length === 1, 'drain returns the rows');
  assert(log.size() === 0, 'and empties the log');
}

console.log('iglLog: ok');
