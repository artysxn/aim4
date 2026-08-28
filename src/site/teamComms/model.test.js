// Run: node src/site/teamComms/model.test.js
//
// The Communication page's math: recording-clock utterances onto demo
// rounds, oriented to one team, filtered, and binned into densities.

import {
  commsMapping,
  densitySeries,
  fmtSeconds,
  gaussianSmooth,
  roundContexts,
  roundPasses,
  speakerResolver,
  talkSegments,
  teamIndexOf
} from './model.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const RATE = 64;

/** Two rounds: freeze 3000-4000 / live to 10000, freeze 10000-11000 / live to 18000. */
const record = {
  id: 'demo-1',
  map: 'DD2',
  tickRate: RATE,
  team1: { id: 'AAA', name: 'Alpha' },
  team2: { id: 'BBB', name: 'Bravo' },
  players: [
    { id: 'p1', name: 'one', steamId: '111', team: 1, slot: 0 },
    { id: 'p6', name: 'six', steamId: '666', team: 2, slot: 5 }
  ],
  rounds: [
    {
      round: 1,
      winner: 1,
      team1Side: 'T',
      team2Side: 'CT',
      econ1: 0,
      econ2: 0,
      startTick: 3000,
      freezeEndTick: 4000,
      endTick: 9500,
      officialEndTick: 10000
    },
    {
      round: 2,
      winner: 2,
      team1Side: 'T',
      team2Side: 'CT',
      econ1: 5,
      econ2: 1,
      startTick: 10000,
      freezeEndTick: 11000,
      endTick: 17500,
      officialEndTick: 18000
    }
  ]
};

// ---- orientation ------------------------------------------------------------

{
  assert(teamIndexOf(record, 'Alpha') === 1, 'Alpha is team 1');
  assert(teamIndexOf(record, 'BRAVO') === 2, 'name compare is case-insensitive');
  assert(teamIndexOf(record, 'Charlie') === 0, 'stranger team is 0');

  const forAlpha = roundContexts(record, 'Alpha');
  assert(forAlpha.length === 2, 'both rounds contextualized');
  assert(forAlpha[0].win === true && forAlpha[1].win === false, 'wins oriented to Alpha');
  assert(forAlpha[0].side === 'T', 'side oriented to Alpha');
  assert(forAlpha[1].buy === 4, 'econ digit 5 folds into full buy bucket');

  const forBravo = roundContexts(record, 'Bravo');
  assert(forBravo[0].win === false && forBravo[1].win === true, 'wins flip for Bravo');
  assert(forBravo[1].buy === 1, 'Bravo round-2 economy is eco');
  console.log('  round contexts oriented to either team');
}

// ---- sync mapping -----------------------------------------------------------

const sidecar = {
  sync: { anchorMs: 60000 },
  anchorTick: null,
  offsetMs: 0,
  mapping: { 'uid-a': 'p1' },
  speakers: [
    { uid: 'uid-a', nickname: 'AlphaVoice', talkMs: 5000 },
    { uid: 'uid-b', nickname: 'CoachVoice', talkMs: 2000 }
  ]
};

{
  const m = commsMapping(sidecar, record);
  assert(m, 'mapping resolves');
  assert(m.anchorTick === 4000, 'anchor falls back to round 1 freeze end');
  assert(commsMapping({ sync: { anchorMs: null } }, record) === null, 'unsynced is null');
  console.log('  sync mapping with round-1 fallback anchor');
}

// ---- speaker resolution -----------------------------------------------------

{
  const resolve = speakerResolver(sidecar, { 'uid-b': { playerId: 'p6', nickname: 'CoachVoice' } });
  assert(resolve(0).key === 'p1', 'demo mapping wins');
  assert(resolve(1).key === 'p6', 'library identity fills the gap');
  const bare = speakerResolver({ ...sidecar, mapping: {} }, {});
  assert(bare(1).key === 'uid:uid-b', 'unmapped voice keeps a uid key');
  console.log('  speaker resolution: demo mapping, then identities, then uid');
}

// ---- segments ---------------------------------------------------------------

{
  // anchorMs 60000 <-> tick 4000. An utterance at recording 60000..62000 is
  // ticks 4000..4128: the first two seconds of round 1 live time.
  const manifest = {
    utterances: [
      { speaker: 0, startMs: 60000, endMs: 62000, text: 'go go' },
      // Freezetime of round 2: tick 10320 is ms 158750 (t = -10.6s).
      { speaker: 0, startMs: 158750, endMs: 160000, text: 'save up' },
      // Before every round: dropped.
      { speaker: 0, startMs: 1000, endMs: 2000, text: 'warmup' }
    ]
  };
  const m = commsMapping(sidecar, record);
  const rounds = roundContexts(record, 'Alpha');
  const resolve = speakerResolver(sidecar, {});
  const segs = talkSegments(manifest, m, rounds, resolve);
  assert(segs.length === 2, `warmup talk dropped, got ${segs.length}`);
  assert(segs[0].ctx.round === 1, 'first segment lands in round 1');
  assert(Math.abs(segs[0].t0 - 0) < 0.01 && Math.abs(segs[0].t1 - 2) < 0.01, 'seconds from freeze end');
  assert(segs[1].ctx.round === 2 && segs[1].t0 < 0, 'freezetime talk is negative seconds');
  console.log('  utterances clipped to rounds on the demo clock');
}

// ---- filters ----------------------------------------------------------------

{
  const rounds = roundContexts(record, 'Alpha');
  assert(roundPasses(rounds[0], {}), 'empty filter passes');
  assert(roundPasses(rounds[0], { result: 'win' }) && !roundPasses(rounds[1], { result: 'win' }), 'result');
  assert(roundPasses(rounds[0], { buy: 0 }) && !roundPasses(rounds[1], { buy: 0 }), 'buy bucket');
  assert(!roundPasses(rounds[0], { map: 'MRG' }), 'map');
  assert(roundPasses(rounds[1], { round: 2 }), 'round number');
  assert(roundPasses(rounds[0], { demoId: 'demo-1' }) && !roundPasses(rounds[0], { demoId: 'x' }), 'demo');
  console.log('  filters: result, buy, map, round, demo');
}

// ---- density ----------------------------------------------------------------

{
  // One player talks seconds 10..12 in each of 4 rounds: density at 10-12s
  // should approach 1.0 (talking in 100% of rounds), zero far away.
  const segs = [];
  for (let r = 0; r < 4; r++) segs.push({ ctx: {}, key: 'p1', t0: 10, t1: 12 });
  const [d] = densitySeries(segs, 4, { sigma: 0.6 });
  assert(d.key === 'p1', 'keyed by player');
  assert(Math.abs(d.talkSeconds - 8) < 0.01, `total talk 8s, got ${d.talkSeconds}`);
  const binAt = (t) => Math.floor(t - -25);
  assert(d.smooth[binAt(11)] > 0.8, `peak near 1.0, got ${d.smooth[binAt(11)]}`);
  assert(d.smooth[binAt(60)] < 0.01, 'quiet far from the talk');

  const total = (a) => a.reduce((s, v) => s + v, 0);
  const raw = new Array(50).fill(0);
  raw[25] = 1;
  const sm = gaussianSmooth(raw, 2);
  assert(Math.abs(total(sm) - 1) < 0.02, 'smoothing conserves mass');
  assert(fmtSeconds(83) === '1:23', 'fmtSeconds');
  console.log('  density: fraction-of-rounds units, mass-conserving smoothing');
}

console.log('teamComms model: all assertions passed');
