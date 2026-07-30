import {
  averagePrwFromMeta,
  playerSwingFromMeta
} from './prwEnrich.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** Minimal equal-buy 5v5 meta: one CT kill then round continues. */
function fixtureMeta() {
  const players = [];
  for (let i = 0; i < 5; i++) {
    players.push({ id: `t${i}`, name: `T${i}`, team: 1, slot: i });
    players.push({ id: `ct${i}`, name: `CT${i}`, team: 2, slot: 5 + i });
  }
  const stats = {};
  for (const p of players) {
    stats[p.id] = { equipValue: 4500, kills: 0, deaths: 0, assists: 0, damage: 0 };
  }
  const tickRate = 64;
  const freeze = 1000;
  const end = freeze + 40 * tickRate;
  return {
    map: 'INF',
    tickRate,
    startTick: freeze - 3 * tickRate,
    freezeEndTick: freeze,
    endTick: end,
    team1Side: 'T',
    team2Side: 'CT',
    winner: 2,
    winnerSide: 'CT',
    econ1: 4,
    econ2: 4,
    players,
    stats,
    events: {
      kills: [
        {
          tick: freeze + 10 * tickRate,
          attacker: 'ct0',
          victim: 't0',
          weapon: 'ak47',
          headshot: false
        }
      ],
      damage: [
        {
          tick: freeze + 5 * tickRate,
          attacker: 'ct0',
          victim: 't1',
          hp: 40,
          weapon: 'ak47'
        }
      ],
      grenades: [],
      bomb: []
    }
  };
}

{
  const meta = fixtureMeta();
  const { prw1, prw2, samples } = averagePrwFromMeta(meta);
  assert(samples > 0, 'PRW samples');
  assert(Number.isFinite(prw1) && Number.isFinite(prw2), 'PRW numbers');
  // After a CT opening kill, mean CT (team2) PRW should beat T (team1).
  assert(prw2 > prw1, `CT PRW ${prw2} should exceed T PRW ${prw1}`);
}

{
  const meta = fixtureMeta();
  const sw = playerSwingFromMeta(meta);
  assert(Number.isFinite(sw.ct0), 'killer has swing');
  assert(Number.isFinite(sw.t0), 'victim has swing');
  assert(sw.ct0 > 0, `killer swing should be positive, got ${sw.ct0}`);
  assert(sw.t0 < 0, `victim swing should be negative, got ${sw.t0}`);
  // Non-lethal damage also attributes something to ct0 / t1.
  assert(Number.isFinite(sw.t1), 'damage victim has swing');
}

console.log('prwEnrich.test.js: ok');
