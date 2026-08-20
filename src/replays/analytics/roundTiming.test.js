// ---------------------------------------------------------------------------
// When in the round a call happened, and what it answered.
//
// A definition's marks ARE its criteria, so the last of them is the second the
// read came true. Everything here reads off that one idea: the database's
// round-clock window, the team overview's WHEN column, and the antistrat
// document's response table.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import {
  rowHasRoundTag,
  rowRoundTags,
  rowTagInWindow,
  rowPasses,
  sideTrigger,
  tagTrigger
} from '../shared/statsMath.js';
import { roundListStats } from './roundListStats.js';
import { AWP_MARK, formatFormation } from './patternDefs.js';
import { aggCtSpread, aggResponses, packPoints, pistolLean } from './antistratScan.js';

// ---------------------------------------------------------------------------
// tagTrigger
// ---------------------------------------------------------------------------

assert.equal(
  tagTrigger({ k: 'x', m: { Staged: 10, Flash: 22, Contact: 18 } }),
  22,
  'the last criterion is the moment the whole read came true'
);
assert.equal(tagTrigger({ k: 'x', m: {} }), null, 'no marks, no clock');
assert.equal(tagTrigger({ k: 'default' }), null, 'and Default carries none at all');
assert.equal(tagTrigger(null), null);
assert.equal(
  tagTrigger({ k: 'x', m: { A: 5, B: null, C: 'nope' } }),
  5,
  'unreadable marks are skipped rather than poisoning the answer'
);
assert.equal(tagTrigger({ k: 'x', m: { A: 0 } }), 0, 'a call at freeze end is still a call');

// ---------------------------------------------------------------------------
// Row-level reads
// ---------------------------------------------------------------------------

/** One stored row: tags on both sides, each with its marks. */
const mkRow = (t = [], ct = []) => ({
  s1: 'T',
  s2: 'CT',
  w: 1,
  m: 'NUK',
  rl: { v: 7, t, ct }
});
const tag = (k, at) => ({ k, m: at === null ? {} : { When: at } });

{
  const row = mkRow([tag('a-fake', 30), tag('default', null)], [tag('two-ramp', 12)]);
  assert.deepEqual(
    rowRoundTags(row, 'T').map((x) => x.k),
    ['a-fake', 'default']
  );
  assert.ok(rowHasRoundTag(row, 'T', 'a-fake'));
  assert.equal(rowHasRoundTag(row, 'CT', 'a-fake'), false, 'sides are absolute');

  assert.equal(sideTrigger(row, 'T'), 30, 'the earliest named call on the side');
  assert.equal(sideTrigger(row, 'T', 'a-fake'), 30);
  assert.equal(sideTrigger(row, 'CT'), 12);
  assert.equal(
    sideTrigger(mkRow([tag('default', null)]), 'T'),
    null,
    'Default is not a named call'
  );

  assert.ok(rowTagInWindow(row, 'T', 'a-fake', 20, 40), 'inside the window');
  assert.equal(rowTagInWindow(row, 'T', 'a-fake', 0, 20), false, 'and outside it');
  assert.ok(rowTagInWindow(row, 'T', '', 20, 40), 'no key asks about any named call');
  assert.ok(rowTagInWindow(row, 'T', 'a-fake', 20, null), 'an open end is open');
  assert.equal(
    rowTagInWindow(mkRow([tag('a-fake', null)]), 'T', 'a-fake', 0, 115),
    false,
    'an untimed call cannot answer a question about the clock'
  );
}

// ---------------------------------------------------------------------------
// rowPasses: the window as a database filter
// ---------------------------------------------------------------------------

{
  const row = mkRow([tag('a-fake', 30)], [tag('two-ramp', 12)]);
  const passes = (filter) => rowPasses(row, { side: 'T', ...filter }, 1);

  assert.ok(passes({}), 'no window is the whole round');
  assert.ok(passes({ fromSec: 20, toSec: 40 }), 'the call sits inside the window');
  assert.equal(passes({ fromSec: 0, toSec: 20 }), false, 'and outside it the round drops');
  assert.ok(passes({ fromSec: 20 }), 'an open top end still filters the bottom');
  assert.ok(passes({ toSec: 40 }), 'and the other way round');

  // With a call picked, the window is that call's clock and no other's.
  assert.ok(passes({ roundOwn: 'a-fake', fromSec: 25, toSec: 35 }));
  assert.equal(
    passes({ roundOwn: 'a-fake', fromSec: 0, toSec: 15 }),
    false,
    'the CT call at 12 does not rescue a T filter'
  );
  assert.equal(
    passes({ roundOwn: 'ramp-rush', fromSec: 0, toSec: 115 }),
    false,
    'a call they never made fails whatever the window'
  );

  // A window on a row with no library tags at all drops it, rather than
  // silently passing rounds that cannot answer.
  assert.equal(
    rowPasses({ s1: 'T', s2: 'CT', w: 1, m: 'NUK' }, { side: 'T', fromSec: 0, toSec: 115 }, 1),
    false,
    'an untagged round is not "some time in the round"'
  );
  assert.ok(
    rowPasses({ s1: 'T', s2: 'CT', w: 1, m: 'NUK' }, { side: 'T' }, 1),
    'but it passes when nobody asked about the clock'
  );
}

// ---------------------------------------------------------------------------
// roundListStats: the WHEN column
// ---------------------------------------------------------------------------

{
  const round = (s1, w, t, ct) => ({ s1, s2: s1 === 'T' ? 'CT' : 'T', w, rl: { v: 7, t, ct } });
  const stats = roundListStats(
    {
      demos: [
        {
          map: 'NUK',
          name1: 'Vitality',
          name2: 'FaZe',
          rounds: [
            round('T', 1, [tag('a-fake', 20)], [tag('two-ramp', 10)]),
            round('T', 2, [tag('a-fake', 30)], [tag('two-ramp', 14)]),
            round('T', 1, [tag('a-fake', 40)], [tag('two-ramp', 18)])
          ]
        }
      ]
    },
    { mapCode: 'NUK', teamName: 'Vitality' }
  );
  const fake = stats.sides.T.types.find((x) => x.key === 'a-fake');
  assert.equal(fake.ours.rounds, 3);
  assert.equal(fake.ours.timing.seconds, 30, 'the median of 20, 30 and 40');
  assert.equal(fake.ours.timing.clock, '1:25', 'written on the round clock');

  const unused = stats.sides.T.types.find((x) => x.key === 'ramp-rush');
  assert.equal(unused.ours.timing, null, 'a call nobody made has no clock');

  const faced = stats.sides.CT.types.find((x) => x.key === 'two-ramp');
  assert.equal(faced.faced.timing.seconds, 14, 'and the calls they face are timed too');
}

// ---------------------------------------------------------------------------
// Formations: the AWP mark
// ---------------------------------------------------------------------------

{
  // Dust2's T lanes (B, Mid, Long), in notation order.
  const plain = formatFormation('DD2', [3, 1, 1]);
  assert.equal(plain, '3-1-1', 'no AWP, no mark');
  assert.equal(
    formatFormation('DD2', [3, 1, 1], 0),
    `${AWP_MARK}3-1-1`,
    'the AWP among the three marks the three'
  );
  assert.equal(
    formatFormation('DD2', [3, 1, 1], 1),
    `3-${AWP_MARK}1-1`,
    'and as the first solo man it marks that one'
  );
  assert.equal(formatFormation('DD2', [3, 1, 1], 2), `3-1-${AWP_MARK}1`);
  assert.equal(
    formatFormation('DD2', [3, 1, 1], 5),
    '3-1-1',
    'a lane off the end of the map is no lane at all'
  );
  assert.equal(
    formatFormation('DD2', [5, 0, 0], 1),
    formatFormation('DD2', [5, 0, 0]),
    'an empty lane never takes the mark'
  );
  assert.ok(
    formatFormation('DD2', [5, 0, 0], 0).startsWith(AWP_MARK),
    'the five-stack form takes it too'
  );
}

// ---------------------------------------------------------------------------
// Heat points: what the document carries so the sliders have something to cut
// ---------------------------------------------------------------------------

{
  const pts = Array.from({ length: 10 }, (_, i) => ({
    x: i * 1.4,
    y: i * 2.6,
    t: i * 3,
    own: 4,
    opp: 3
  }));

  const all = packPoints(pts, 100);
  assert.equal(all.length, 40, 'four numbers per sample');
  assert.deepEqual(all.slice(0, 4), [0, 0, 0, 35], 'x, y, t, and the two buys packed together');
  assert.equal(Math.floor(all[3] / 8), 4, 'own buy unpacks');
  assert.equal(all[3] % 8, 3, 'and so does the opponent buy');
  assert.deepEqual(
    all.slice(4, 8),
    [1, 3, 3, 35],
    'coordinates round to the unit, which is finer than the blur anyway'
  );

  // Over the cap it strides, so the shape of a round survives at lower
  // resolution rather than the back half of it disappearing.
  const capped = packPoints(pts, 4);
  assert.equal(capped.length / 4, 4, 'down to the cap');
  assert.equal(capped[2], 0, 'starting at the first sample');
  assert.equal(capped[capped.length - 2], 27, 'and still reaching the last stretch');
  assert.deepEqual(packPoints([], 10), [], 'nothing in, nothing out');
}

// ---------------------------------------------------------------------------
// CT spread: the every-8-seconds table, averaged per buy slice
// ---------------------------------------------------------------------------

{
  const TICK = 64;
  /** A CT round whose A/B headcount is fixed for the whole round. */
  const mkRound = (a, b, alive, { own = 4, opp = 4, until = 115 } = {}) => ({
    side: 'CT',
    hasTicks: true,
    ownEcon: own,
    oppEcon: opp,
    won: true,
    t0: 0,
    tickRate: TICK,
    endTick: until * TICK,
    sampleAt: (tick) => (tick / TICK <= until ? { pts: new Array(alive).fill({}) } : null),
    towardCount: (_s, site) => (site === 'a' ? a : b)
  });

  const out = aggCtSpread([mkRound(3, 2, 5), mkRound(1, 4, 5, { own: 1 })]);
  assert.equal(out.step, 8, 'sampled every 8 seconds');
  assert.equal(out.marks[0], 0, 'from the moment the round goes live');
  assert.equal(out.marks[1], 8);
  assert.equal(out.rounds.length, 2, 'one record per round, not one averaged table');
  assert.equal(out.rounds[0].c.length, out.marks.length * 3, 'a triple per mark');
  assert.deepEqual(out.rounds[0].c.slice(0, 3), [3, 2, 5], 'toward A, toward B, alive');
  assert.equal(out.rounds[1].own, 1, 'buys ride along so the widget can filter on them');

  // A round that ended early records -1 rather than a zero, which would drag
  // every average down as the rounds run out.
  const short = aggCtSpread([mkRound(3, 2, 5, { until: 10 })]);
  assert.deepEqual(short.rounds[0].c.slice(0, 3), [3, 2, 5], 'the samples it has');
  assert.deepEqual(short.rounds[0].c.slice(6, 9), [-1, -1, -1], 'and a gap where it ended');

  assert.equal(aggCtSpread([]), null, 'no CT rounds, no table');
  assert.equal(
    aggCtSpread([{ ...mkRound(3, 2, 5), side: 'T' }]),
    null,
    'and the T side is a different question'
  );
}

// ---------------------------------------------------------------------------
// Pistol turnaround: showed one site, took the other
// ---------------------------------------------------------------------------

{
  const mkPistol = (a, b) => ({
    sampleAt: () => ({ pts: [] }),
    towardCount: (_s, site) => (site === 'a' ? a : b)
  });
  assert.equal(pistolLean(mkPistol(4, 1), 'DD2'), 'A', 'the fuller side is what they showed');
  assert.equal(pistolLean(mkPistol(1, 4), 'DD2'), 'B');
  assert.equal(pistolLean(mkPistol(2, 2), 'DD2'), '', 'an even split shows nothing');
  assert.equal(
    pistolLean({ sampleAt: () => null, towardCount: () => 0 }, 'DD2'),
    '',
    'and no snapshot is no read at all'
  );
}

// ---------------------------------------------------------------------------
// packPoints drops what it cannot read
// ---------------------------------------------------------------------------

{
  // NaN survives JSON as null, and null compares as second zero, so a sample
  // with no clock on it would sit at the start of every window. Drop it.
  const mixed = [
    { x: 1, y: 2, t: 10, own: 4, opp: 4 },
    { x: 3, y: 4, t: NaN, own: 4, opp: 4 },
    { x: NaN, y: 6, t: 20, own: 4, opp: 4 },
    { x: 7, y: 8, t: undefined, own: 4, opp: 4 }
  ];
  assert.deepEqual(packPoints(mixed, 100), [1, 2, 10, 36], 'only the readable sample survives');
}

// ---------------------------------------------------------------------------
// Responses: a habit, not a coincidence
// ---------------------------------------------------------------------------

{
  const tagged = (side, ours, theirs, won = true) => ({
    side,
    file: `r${Math.random()}`,
    won,
    tags: {
      T: side === 'T' ? ours : theirs,
      CT: side === 'T' ? theirs : ours
    }
  });
  const at = (k, sec) => ({ k, m: { When: sec } });

  // Their call at 10s, ours at 20s: a clear five seconds of lead.
  const answered = (n) =>
    Array.from({ length: n }, () => tagged('CT', [at('down-ramp', 20)], [at('fast-mid', 10)]));
  // The same two calls, but ours lands two seconds behind theirs, which is not
  // long enough to have been called off the back of it.
  const ignored = (n) =>
    Array.from({ length: n }, () => tagged('CT', [at('down-ramp', 12)], [at('fast-mid', 10)]));

  // Four of eight is the threshold on both counts.
  const hit = aggResponses([...answered(4), ...ignored(4)], 'ANC', 'CT');
  assert.ok(hit, 'four rounds out of eight is a read');
  assert.equal(hit.calls[0].rounds, 8, 'the denominator is THEIR call, not ours');
  assert.equal(hit.calls[0].to[0].rounds, 4);
  assert.equal(hit.calls[0].to[0].share, 50);

  // Same rate, too few examples.
  assert.equal(
    aggResponses([...answered(3), ...ignored(3)], 'ANC', 'CT'),
    null,
    'three out of six is the same rate on too little'
  );
  // Enough examples, too low a rate.
  assert.equal(
    aggResponses([...answered(4), ...ignored(12)], 'ANC', 'CT'),
    null,
    'four out of sixteen is just their most common round'
  );
  // The lead has to be there at all.
  assert.equal(
    aggResponses(
      Array.from({ length: 8 }, () =>
        tagged('CT', [at('down-ramp', 12)], [at('fast-mid', 10)])
      ),
      'ANC',
      'CT'
    ),
    null,
    'two seconds is not a reaction'
  );
}

// ---------------------------------------------------------------------------
// The team overview table: database chrome, one map, T/CT tint
// ---------------------------------------------------------------------------

{
  globalThis.document = globalThis.document || {
    createElement: () => ({
      className: '',
      hidden: false,
      innerHTML: '',
      remove() {},
      appendChild() {},
      replaceChildren() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      contains() { return false; }
    })
  };
  const esc = (x) =>
    String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const { createRoundListPanel } = await import('./roundListPanel.js');

  const mk = (s1, w, t, ct) => ({
    s1,
    s2: s1 === 'T' ? 'CT' : 'T',
    w,
    f: 'round.bin',
    rl: {
      v: 7,
      t: t.map((k) => ({ k, m: { When: 20 } })),
      ct: ct.map((k) => ({ k, m: { When: 15 } }))
    }
  });
  const panel = createRoundListPanel({ escapeHtml: esc });
  panel.update({
    preferredMap: 'NUK',
    teamName: 'Vitality',
    payload: {
      demos: [
        {
          map: 'NUK',
          name1: 'Vitality',
          name2: 'FaZe',
          rounds: [mk('T', 1, ['a-fake'], ['two-ramp']), mk('T', 2, ['a-fake'], ['two-ramp'])]
        },
        {
          map: 'NUK',
          name1: 'Spirit',
          name2: 'G2',
          rounds: [mk('T', 1, ['a-fake'], ['default']), mk('T', 2, ['ramp-rush'], ['default'])]
        }
      ]
    }
  });
  const html = panel.el.innerHTML;

  assert.ok(html.includes('st-table'), 'the table uses the database chrome');
  assert.ok(html.includes('data-rl-map'), 'a map picker sits next to the title');
  assert.ok(html.includes('data-sort="ran"'), 'Ran is a column');
  assert.ok(html.includes('data-sort="faced"'), 'Faced is a column');
  assert.ok(!html.includes('Grey'), 'no library-average caption');
  assert.ok(!html.includes('T rounds'), 'no T/CT section titles');
  assert.ok(html.includes('tm-rl-t'), 'T rows are tinted');
  assert.ok(html.includes('/demos?rounds='), 'Ran/Faced open those rounds in a new tab');

  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const tips = [...body.matchAll(/data-tip="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    tips.some((t) => /We ran this 2 times/.test(t)),
    'Ran hover says how many we ran'
  );
  assert.ok(
    tips.some((t) => /Won 1 of 2 rounds we ran/.test(t)),
    'Win% hover is the ran winrate'
  );
}

console.log('roundTiming.test.js ok');
