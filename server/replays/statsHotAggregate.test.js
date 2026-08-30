// The resident store must produce exactly what the shipped aggregator does.
//
// This is the whole safety argument for Phase 2: accumulation moved to typed
// arrays, but derivation still runs through statsMath, so the only thing that
// can go wrong is filling the buckets differently. That is what this checks —
// field by field, across every filter dimension rowPasses supports.
import assert from 'node:assert/strict';
import { packStore } from './statsHotStore.js';
import {
  aggregateHot,
  aggregateHotMatches,
  aggregateTeamsHot,
  attachRolesHot,
  filterRolesHot
} from './statsHotAggregate.js';
import { aggregatePlayers, aggregateTeams, teamNameKey } from '../../src/replays/shared/statsMath.js';
import { attachExpectedRatings } from '../../src/replays/shared/expectedRating.js';
import { attachPlayerRoles } from '../../src/replays/roles/assignRoles.js';
import { AIM_MOTION_FIELDS } from '../../src/replays/shared/aimMetrics.js';

const MAPS = ['de_nuke', 'de_mirage', 'de_inferno'];

// Round-library calls, so the tag columns have something to be compared over.
// Deliberately not drawn from the generator below: these have to be stable
// while the numeric fixture keeps its existing sequence.
const T_CALLS = ['t-a-fake', 't-mid-take', 't-b-split', 'default'];
const CT_CALLS = ['ct-lobby-crunch', 'ct-water', 'default'];

/**
 * The `rl` bag for one round: a timed call, sometimes a second untimed one, and
 * every seventh round with no bag at all — an index written before the library
 * covered its map, which a call filter has to exclude rather than wave through.
 */
function tagsFor(i, k) {
  if ((i + k) % 7 === 0) return null;
  const t = [{ k: T_CALLS[(i + k) % T_CALLS.length], m: { entry: 8 + ((i * 3 + k) % 40) } }];
  if (k % 3 === 0) t.push({ k: T_CALLS[(i + k + 1) % T_CALLS.length], m: {} });
  const ct = [{ k: CT_CALLS[(i + k) % CT_CALLS.length], m: { setup: 5 + ((i + k * 2) % 30) } }];
  return { v: 7, t, ct };
}

let seed = 42;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

function makeEntry(i) {
  const pids = Array.from({ length: 10 }, (_, j) => `p${(i % 3) * 10 + j}`);
  const players = pids.map((id, j) => ({ id, name: `name${j}`, team: j < 5 ? 1 : 2, slot: j }));
  const map = MAPS[i % MAPS.length];
  const rounds = Array.from({ length: 6 + rnd(6) }, (_, k) => {
    const p = {}, sw = {}, am = {}, a2 = {}, ut = {}, du = {}, mv = {}, aw = {};
    for (const id of pids) {
      p[id] = [rnd(4), rnd(2), rnd(2), rnd(140), rnd(30), rnd(14), rnd(5), rnd(6), rnd(3), rnd(2)];
      sw[id] = rnd(400) / 10 - 20;
      am[id] = { engagements: rnd(6), crosshairErrorSum: rnd(90), fightsReady: rnd(4),
        fightsUnaware: rnd(2), shots: rnd(30), hits: rnd(12), shotsInSmoke: rnd(3),
        firstBullets: rnd(6), firstBulletHits: rnd(4), overflicks: rnd(3), underflicks: rnd(2) };
      // The motion half, packed. Every third round has none, which is the
      // shape of a library the aim rescan is halfway through: the two paths
      // have to agree about a partially scanned player, not just a scanned one.
      if (k % 3 !== 2) a2[id] = AIM_MOTION_FIELDS.map(() => rnd(600) / 10);
      ut[id] = { heThrown: rnd(3), heDamage: rnd(80), fireThrown: rnd(2), fireDamage: rnd(60),
        flashesThrown: rnd(4), flashesLanded: rnd(3), enemyBlindSeconds: rnd(60) / 10 };
      if (rnd(10) > 1) {
        du[id] = { w: (rnd(30) + 1) / 10, p: rnd(100) / 100, n: rnd(3),
          b: [[rnd(11) / 10, (rnd(20) + 1) / 10, rnd(100) / 100, rnd(2)],
              [rnd(11) / 10, (rnd(20) + 1) / 10, rnd(100) / 100, rnd(2)]] };
      }
      mv[id] = { psdt: rnd(1400), dt: rnd(2600) };
      aw[id] = rnd(40);
    }
    return { f: `d${i}-r${k}`, d: `d${i}`, m: map, n: k + 1, w: (k % 2) + 1,
      s1: k < 3 ? 'T' : 'CT', s2: k < 3 ? 'CT' : 'T',
      // Digit 5 is a full buy that had an AWP. The generator below draws it
      // roughly one time in a thousand, so it was never in the fixture: place
      // it deliberately, or neither the AWP filters nor buyBucket's 5 -> 4
      // folding is exercised by any of the comparisons here.
      e1: k % 5 === 0 ? 5 : rnd(6), e2: k % 7 === 3 ? 5 : rnd(6),
      ok: pids[rnd(10)], od: pids[rnd(10)], p, sw, am, a2, ut, du, mv, aw,
      cok: rnd(2) ? [pids[rnd(10)]] : [], cod: rnd(2) ? [pids[rnd(10)]] : [],
      dur: 40 + rnd(50), pt: rnd(2) ? rnd(60) : null,
      kt: [], ev: [], ph: {}, utt: {}, rl: tagsFor(i, k),
      pos1: 0.5, pos2: 0.5, prw1: 0.5, prw2: 0.5, aca1: 0, ack1: 0, aca2: 0, ack2: 0 };
  });
  return { id: `d${i}`, v: 19, key: `19|${i}|${i}|${rounds.length}|T${i % 4}|T${(i + 1) % 4}`,
    map, mapName: map, t1: `t${i % 4}`, t2: `t${(i + 1) % 4}`,
    name1: `Team ${i % 4}`, name2: `Team ${(i + 1) % 4}`, winner: (i % 2) + 1,
    uploadedAt: Date.UTC(2026, 0, 1 + (i % 28)), players, rounds,
    roles: {
      v: 6,
      maps: {
        [map]: {
          T: Object.fromEntries(
            pids.slice(0, 5).map((id, j) => [
              id,
              { label: ['Mid', 'A Lurk', 'Street', 'AWPer', 'B Lurk'][j], tactical: j === 3 ? 'AWPer' : j % 2 ? 'Lurk' : 'Pack' }
            ])
          ),
          CT: Object.fromEntries(
            pids.slice(5).map((id, j) => [
              id,
              { label: ['Mid', 'B Cave', 'B Site', 'AWPer', 'Mid / A'][j], tactical: j === 3 ? 'AWPer' : j % 2 ? 'Anchor' : 'Rotation' }
            ])
          )
        }
      }
    },
    positions: false, pz: 0 };
}

const entries = Array.from({ length: 40 }, (_, i) => makeEntry(i));
const store = packStore(entries);

const players = new Map(), demos = new Map(), rows = [];
for (const e of entries) {
  demos.set(e.id, e);
  for (const p of e.players) players.set(`${e.id}:${p.id}`, { name: p.name, team: p.team });
  rows.push(...e.rounds);
}

const FILTERS = [
  ['no filter', {}],
  ['one map', { maps: ['de_nuke'] }],
  ['two maps', { maps: ['de_nuke', 'de_inferno'] }],
  ['unknown map', { maps: ['de_train'] }],
  ['side T', { side: 'T' }],
  ['side CT', { side: 'CT' }],
  ['econ', { econ: 4 }],
  ['oppEcon', { oppEcon: 4 }],
  ['econ + oppEcon', { econ: 4, oppEcon: 4 }],
  ['won', { result: 'won' }],
  ['lost', { result: 'lost' }],
  ['5v4', { advantage: '5v4' }],
  ['4v5', { advantage: '4v5' }],
  ['even', { advantage: 'even' }],
  ['hasAwp', { hasAwp: true }],
  ['oppHasAwp', { oppHasAwp: true }],
  ['both AWPs', { hasAwp: true, oppHasAwp: true }],
  ['hasAwp + side', { hasAwp: true, side: 'T' }],
  ['call own', { side: 'T', roundOwn: ['t-a-fake'] }],
  ['call own, no side', { roundOwn: ['t-a-fake'] }],
  ['call opp', { side: 'CT', roundOpp: ['t-a-fake'] }],
  ['two calls', { roundOwn: ['t-a-fake', 't-mid-take'] }],
  ['own and opp calls', { side: 'T', roundOwn: ['t-mid-take'], roundOpp: ['ct-water'] }],
  ['unknown call', { roundOwn: ['nope-never-tagged'] }],
  ['window', { fromSec: 10, toSec: 40 }],
  ['window, open ended', { fromSec: 30 }],
  ['call in window', { side: 'T', roundOwn: ['t-a-fake'], fromSec: 0, toSec: 30 }],
  ['default only', { roundOwn: ['default'] }],
  ['teamName', { teamName: 'Team 1' }],
  ['date window', { dateFrom: '2026-01-05', dateTo: '2026-01-20' }],
  ['combined', { maps: ['de_mirage'], side: 'CT', econ: 4, result: 'won' }],
  [
    'the reported shape',
    { maps: ['de_nuke'], side: 'T', roundOwn: ['t-mid-take'], hasAwp: true }
  ]
];

let checked = 0;
for (const [label, filter] of FILTERS) {
  const ref = aggregatePlayers(rows, players, filter, demos);
  const hot = aggregateHot(store, filter);
  assert.equal(hot.length, ref.length, `${label}: row count`);
  const byId = new Map(hot.map((r) => [r.id, r]));
  for (let i = 0; i < ref.length; i++) {
    const a = ref[i];
    const b = byId.get(a.id);
    assert.ok(b, `${label}: missing player ${a.id}`);
    // Same sort order, since derivePlayers does the sorting for both.
    assert.equal(hot[i].id, a.id, `${label}: order differs at ${i}`);
    for (const k of Object.keys(a)) {
      const x = a[k], y = b[k];
      if (typeof x === 'number' && Number.isFinite(x)) {
        assert.ok(
          Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-12),
          `${label}: ${a.name}.${k} ${x} vs ${y}`
        );
        checked++;
      } else if (typeof x === 'string') {
        assert.equal(y, x, `${label}: ${a.name}.${k}`);
        checked++;
      } else if (x === null) {
        assert.equal(y, null, `${label}: ${a.name}.${k} should be null`);
        checked++;
      }
    }
  }
}

{
  const refP = aggregatePlayers(rows, players, {}, demos);
  const hotP = aggregateHot(store, {});
  const sortGames = (g) =>
    [...(g || [])].sort((a, b) => (b.at - a.at) || String(a.key).localeCompare(String(b.key)));
  for (let i = 0; i < refP.length; i++) {
    assert.deepEqual(
      sortGames(hotP[i].clubGames),
      sortGames(refP[i].clubGames),
      `clubGames ${refP[i].name}`
    );
  }
  attachExpectedRatings(refP, aggregateTeams(rows, players, demos, {}));
  attachExpectedRatings(hotP, aggregateTeamsHot(store, {}));
  for (let i = 0; i < refP.length; i++) {
    assert.equal(hotP[i].expectedRating, refP[i].expectedRating, `${refP[i].name} expectedRating`);
    assert.equal(hotP[i].expectedRatingOp, refP[i].expectedRatingOp, `${refP[i].name} expectedRatingOp`);
    assert.equal(hotP[i].trueRating, refP[i].trueRating, `${refP[i].name} trueRating`);
    assert.equal(hotP[i].clubGames, undefined);
  }
}

// --- teams -----------------------------------------------------------------
let teamChecked = 0;
for (const [label, filter] of FILTERS) {
  const ref = aggregateTeams(rows, players, demos, filter);
  const hot = aggregateTeamsHot(store, filter);
  assert.equal(hot.length, ref.length, `teams ${label}: row count`);
  for (let i = 0; i < ref.length; i++) {
    assert.equal(hot[i].key, ref[i].key, `teams ${label}: order at ${i}`);
    const a = ref[i], b = hot[i];
    for (const k of Object.keys(a)) {
      const x = a[k], y = b[k];
      if (typeof x === 'number' && Number.isFinite(x)) {
        assert.ok(
          Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-12),
          `teams ${label}: ${a.name}.${k} ${x} vs ${y}`
        );
        teamChecked++;
      } else if (typeof x === 'string') {
        assert.equal(y, x, `teams ${label}: ${a.name}.${k}`);
        teamChecked++;
      } else if (x === null) {
        assert.equal(y, null, `teams ${label}: ${a.name}.${k} should be null`);
        teamChecked++;
      }
    }
    // Members carry the per-player numbers the hover breakdown shows.
    assert.equal(b.members.length, a.members.length, `teams ${label}: ${a.name} member count`);
    for (let m = 0; m < a.members.length; m++) {
      assert.equal(b.members[m].id, a.members[m].id, `teams ${label}: member order`);
      assert.ok(Math.abs(b.members[m].rating - a.members[m].rating) < 1e-9);
      teamChecked += 2;
    }
    // possessionByMap is an array of per-map cells.
    assert.equal(b.possessionByMap.length, a.possessionByMap.length, `teams ${label}: map cells`);
  }
}

// Passing the player table in must not change the answer.
{
  const filter = { side: 'CT' };
  const shared = aggregateHot(store, filter);
  assert.deepEqual(
    JSON.parse(JSON.stringify(aggregateTeamsHot(store, filter, shared))),
    JSON.parse(JSON.stringify(aggregateTeamsHot(store, filter))),
    'reusing the player table gives the same team rows'
  );
}

// --- visibility masking ----------------------------------------------------
// One store serves every caller, so a masked query must equal a store built
// from only the demos that caller can read. If these ever diverge, users would
// see numbers computed over demos they are not allowed to open.
{
  const visibleIds = new Set(entries.filter((_, i) => i % 3 !== 0).map((e) => e.id));
  const mask = new Uint8Array(store.demos.length);
  store.demos.forEach((d, i) => { if (visibleIds.has(d.id)) mask[i] = 1; });

  const subset = entries.filter((e) => visibleIds.has(e.id));
  const subStore = packStore(subset);
  const subRows = [], subPlayers = new Map(), subDemos = new Map();
  for (const e of subset) {
    subDemos.set(e.id, e);
    for (const p of e.players) subPlayers.set(`${e.id}:${p.id}`, { name: p.name, team: p.team });
    subRows.push(...e.rounds);
  }

  for (const [label, filter] of FILTERS) {
    const masked = aggregateHot(store, filter, mask);
    const ref = aggregatePlayers(subRows, subPlayers, filter, subDemos);
    assert.equal(masked.length, ref.length, `masked ${label}: row count`);
    for (let i = 0; i < ref.length; i++) {
      assert.equal(masked[i].id, ref[i].id, `masked ${label}: order at ${i}`);
      for (const k of Object.keys(ref[i])) {
        const x = ref[i][k], y = masked[i][k];
        if (typeof x === 'number' && Number.isFinite(x)) {
          assert.ok(
            Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-12),
            `masked ${label}: ${ref[i].name}.${k} ${x} vs ${y}`
          );
        }
      }
    }
    const maskedTeams = aggregateTeamsHot(store, filter, null, mask);
    const refTeams = aggregateTeams(subRows, subPlayers, subDemos, filter);
    assert.equal(maskedTeams.length, refTeams.length, `masked teams ${label}: row count`);
    for (let i = 0; i < refTeams.length; i++) {
      assert.equal(maskedTeams[i].key, refTeams[i].key, `masked teams ${label}: order`);
      assert.equal(maskedTeams[i].rounds, refTeams[i].rounds, `masked teams ${label}: rounds`);
      assert.ok(Math.abs(maskedTeams[i].avgRating - refTeams[i].avgRating) < 1e-9);
    }
  }

  // A mask that hides everything yields nothing, not the whole library.
  assert.deepEqual(aggregateHot(store, {}, new Uint8Array(store.demos.length)), []);
  assert.deepEqual(aggregateTeamsHot(store, {}, null, new Uint8Array(store.demos.length)), []);
  // A fully-open mask equals no mask at all.
  const openMask = new Uint8Array(store.demos.length).fill(1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(aggregateHot(store, {}, openMask))),
    JSON.parse(JSON.stringify(aggregateHot(store, {}))),
    'an all-visible mask changes nothing'
  );
}

// A filter that matches nothing returns nothing, rather than everything.
assert.deepEqual(aggregateHot(store, { maps: ['de_train'] }), []);
assert.deepEqual(aggregateHot(store, { files: ['nope'] }), []);

assert.deepEqual(aggregateTeamsHot(store, { maps: ['de_train'] }), []);


// ---------------------------------------------------------------------------
// Per-match rows must equal aggregating each demo on its own.
//
// The detail view under a name used to be built in the browser out of raw
// rounds. It is now one server query, and "one row per match" has to keep
// meaning exactly what it meant: the same aggregation, scoped to one demo.
// ---------------------------------------------------------------------------
{
  const NUM = ['rating', 'adr', 'kast', 'kd', 'rounds', 'kills', 'deaths', 'prwSwing', 'tfw', 'xk'];
  const TNUM = ['rounds', 'roundsWon', 'roundWinrate', 'avgRating', 'opkRate', 'conv5v4', 'conv4v5'];
  let matchChecks = 0;

  const somePlayer = entries[0].players[0].id;
  const playerDemos = entries.filter((e) => e.players.some((p) => p.id === somePlayer)).map((e) => e.id);
  const fromStore = aggregateHotMatches(store, playerDemos, {}, null, {
    kind: 'player',
    id: somePlayer
  });
  const byDemo = new Map(fromStore.map((r) => [r.demoId, r]));
  for (const e of entries) {
    if (!playerDemos.includes(e.id)) continue;
    const want = aggregatePlayers(e.rounds, players, {}, demos).find((p) => p.id === somePlayer);
    const got = byDemo.get(e.id);
    if (!want?.rounds) continue;
    assert.ok(got, `per-match row missing for ${e.id}`);
    for (const f of NUM) {
      assert.equal(got[f], want[f], `${e.id} ${f}`);
      matchChecks++;
    }
  }

  const teamName = entries[0].name1;
  const key = teamNameKey(teamName);
  const teamDemos = entries
    .filter((e) => teamNameKey(e.name1, e.t1) === key || teamNameKey(e.name2, e.t2) === key)
    .map((e) => e.id);
  const teamRows = aggregateHotMatches(store, teamDemos, {}, null, { kind: 'team', id: teamName });
  const teamBy = new Map(teamRows.map((r) => [r.demoId, r]));
  for (const e of entries) {
    if (!teamDemos.includes(e.id)) continue;
    const want = aggregateTeams(e.rounds, players, demos, {}).find((t) => t.key === key);
    const got = teamBy.get(e.id);
    if (!want?.rounds) continue;
    assert.ok(got, `per-match team row missing for ${e.id}`);
    for (const f of TNUM) {
      assert.equal(got[f], want[f], `${e.id} ${f}`);
      matchChecks++;
    }
    // The score is the FILTERED round record, so it must add up to the rounds
    // the same query counted.
    const [mine, theirs] = String(got.scoreLabel).split(':').map(Number);
    assert.equal(mine + theirs, got.rounds, `${e.id} score adds up to counted rounds`);
  }

  // Demos outside the requested list never appear, whatever the mask says.
  assert.deepEqual(aggregateHotMatches(store, [], {}, null, { kind: 'player', id: somePlayer }), []);
  const hidden = new Uint8Array(store.demos.length);
  assert.deepEqual(
    aggregateHotMatches(store, playerDemos, {}, hidden, { kind: 'player', id: somePlayer }),
    [],
    'a mask that hides every demo yields no match rows'
  );

  console.log(`  per-match rows: ${matchChecks} field comparisons, all exact`);
}

// ---------------------------------------------------------------------------
// Roles from the store must equal roles read the way the browser read them.
// ---------------------------------------------------------------------------
{
  const payload = { demos: entries };
  let roleChecks = 0;
  for (const filter of [{}, { maps: [MAPS[0]] }, { maps: [MAPS[1]] }]) {
    const base = aggregatePlayers(rows, players, filter, demos);
    const want = attachPlayerRoles(base, payload, filter);
    const got = attachRolesHot(store, filter, null, aggregateHot(store, filter));
    const gotBy = new Map(got.map((p) => [String(p.id), p]));
    for (const w of want) {
      const g = gotBy.get(String(w.id));
      assert.ok(g, `role row missing for ${w.id}`);
      for (const f of ['roleT', 'roleCT', 'posT', 'posCT', 'roleMode']) {
        assert.equal(g[f] || '', w[f] || '', `${w.id} ${f} under ${JSON.stringify(filter)}`);
        roleChecks++;
      }
    }
  }

  // The chip narrows rows and never invents them.
  const all = attachRolesHot(store, {}, null, aggregateHot(store, {}));
  const awpers = filterRolesHot(all, { side: 'T', value: 'AWPer' });
  assert.ok(awpers.length > 0, 'the fixture has AWPers');
  assert.ok(awpers.length < all.length, 'the chip actually excludes somebody');
  for (const p of awpers) assert.equal(p.roleT, 'AWPer');
  assert.equal(filterRolesHot(all, null).length, all.length, 'no chip changes nothing');

  console.log(`  roles: ${roleChecks} field comparisons against the browser path, all exact`);
}

// The AWP toggles have to BITE, not just agree with the reference.
//
// Every filter above is checked by comparing the two implementations, which two
// no-ops would also pass. The buy digit is where an AWP round is recorded (the
// legacy 5 = full buy that had one), and both sides read it or neither does.
{
  const roundsOf = (filter) =>
    aggregateHot(store, filter).reduce((n, p) => n + (p.rounds || 0), 0);
  const open = roundsOf({});
  const own = roundsOf({ hasAwp: true });
  const opp = roundsOf({ oppHasAwp: true });
  assert.ok(own > 0, 'the fixture has AWP rounds');
  assert.ok(own < open, 'the AWP filter excludes rounds without one');
  assert.ok(opp > 0 && opp < open, 'so does the enemy AWP filter');
  const teamRounds = (filter) =>
    aggregateTeamsHot(store, filter, aggregateHot(store, filter)).reduce(
      (n, t) => n + (t.rounds || 0),
      0
    );
  assert.ok(
    teamRounds({ hasAwp: true }) > 0 && teamRounds({ hasAwp: true }) < teamRounds({}),
    'and the Teams tab is filtered too, not only Players'
  );
}

// The call and clock filters have to BITE too, and for the same reason: two
// implementations that both ignore a filter agree with each other perfectly.
{
  const roundsOf = (filter) =>
    aggregateHot(store, filter).reduce((n, p) => n + (p.rounds || 0), 0);
  const open = roundsOf({});
  const oneCall = roundsOf({ side: 'T', roundOwn: ['t-a-fake'] });
  assert.ok(oneCall > 0, 'the fixture has rounds tagged with that call');
  assert.ok(oneCall < open, 'and picking it excludes the rounds without it');
  assert.ok(
    roundsOf({ roundOwn: ['t-a-fake', 't-mid-take'] }) > roundsOf({ roundOwn: ['t-a-fake'] }),
    'two calls are an OR, not an AND'
  );
  assert.equal(
    aggregateHot(store, { roundOwn: ['nope-never-tagged'] }).length,
    0,
    'a call no round ever made matches no round, rather than every round'
  );
  const windowed = roundsOf({ fromSec: 10, toSec: 20 });
  assert.ok(windowed > 0 && windowed < open, 'the clock window narrows too');
  assert.ok(
    roundsOf({ side: 'T', roundOwn: ['t-a-fake'], fromSec: 0, toSec: 12 }) < oneCall,
    'and it narrows the call it is asked with'
  );
  const teamRounds = (filter) =>
    aggregateTeamsHot(store, filter, aggregateHot(store, filter)).reduce(
      (n, t) => n + (t.rounds || 0),
      0
    );
  assert.ok(
    teamRounds({ side: 'T', roundOwn: ['t-a-fake'] }) > 0 &&
      teamRounds({ side: 'T', roundOwn: ['t-a-fake'] }) < teamRounds({ side: 'T' }),
    'the Teams tab is filtered by calls as well'
  );
}

console.log(
  `statsHotAggregate.test.js: ${checked.toLocaleString()} player + ` +
  `${teamChecked.toLocaleString()} team field comparisons across ${FILTERS.length} filters, all exact`
);
