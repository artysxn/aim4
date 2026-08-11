import assert from 'node:assert/strict';
import {
  fingerprintDemo,
  fingerprintRecord,
  fingerprintsMatch
} from './duplicates.js';

const players = Array.from({ length: 10 }, (_, i) => ({
  steamId: `7656119${10000000 + i}`,
  name: `p${i}`,
  team: i < 5 ? 2 : 3,
  slot: i
}));

const demo = {
  map: 'de_mirage',
  rounds: [
    { winner: 1, players },
    ...Array.from({ length: 12 }, () => ({ winner: 1, players: [] })),
    ...Array.from({ length: 3 }, () => ({ winner: 2, players: [] }))
  ]
};

const a = fingerprintDemo(demo, 100_000_000);
const b = fingerprintRecord({
  map: 'de_mirage',
  players,
  score: { team1: 13, team2: 3 },
  sizeBytes: 102_000_000
});
assert.ok(fingerprintsMatch(a, b), 'same map/players/score/size match');

const wrongMap = { ...b, map: 'de_inferno' };
assert.ok(!fingerprintsMatch(a, wrongMap));

const wrongSize = { ...b, sizeBytes: 200_000_000 };
assert.ok(!fingerprintsMatch(a, wrongSize));

const closeScore = { ...b, score: { team1: 12, team2: 3 } };
assert.ok(fingerprintsMatch(a, closeScore), 'score within 1 round');

const farScore = { ...b, score: { team1: 10, team2: 3 } };
assert.ok(!fingerprintsMatch(a, farScore));

console.log('duplicates.test.js OK');
