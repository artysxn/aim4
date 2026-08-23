import assert from 'node:assert/strict';
import {
  attachExpectedRatings,
  expectedRatingFromWinrate,
  expectedRatingOverperformance,
  primaryTeamFromGames,
  trueRatingOf
} from './expectedRating.js';

assert.equal(expectedRatingFromWinrate(50), 0.45 + 1.26 * 0.5);
assert.equal(expectedRatingFromWinrate(0), 0.45);
assert.equal(expectedRatingFromWinrate(null), null);

assert.ok(Math.abs(expectedRatingOverperformance(1.14, 1) - 114) < 1e-9);
assert.equal(Math.round(expectedRatingOverperformance(1.14, 1.08) * 10) / 10, 105.6);
assert.equal(expectedRatingOverperformance(1, 0), null);

{
  const x = 1.14;
  const y = 1.08;
  const lift = Math.max(0, (x - 1.02) / 0.13);
  const want = x + 0.35 * (x - y) * Math.exp(0.35 * lift);
  assert.ok(Math.abs(trueRatingOf(x, y) - want) < 1e-12);
}
assert.equal(trueRatingOf(1, null), null);

{
  const games = [];
  for (let i = 0; i < 8; i++) games.push({ at: 100 + i, key: 'vitality', name: 'Vitality' });
  for (let i = 0; i < 2; i++) games.push({ at: i, key: 'other', name: 'Other' });
  const club = primaryTeamFromGames(games);
  assert.equal(club.key, 'vitality');
  assert.equal(club.name, 'Vitality');
}

{
  // Last 10 is 7-3 (70%). Last 12 is 9-3 (75%).
  const games = [];
  for (let i = 0; i < 3; i++) games.push({ at: 200 + i, key: 'b', name: 'B' });
  for (let i = 0; i < 9; i++) games.push({ at: 100 + i, key: 'a', name: 'A' });
  const club = primaryTeamFromGames(games);
  assert.equal(club.key, 'a');
}

{
  // Never 75%: null.
  const games = [];
  for (let i = 0; i < 6; i++) {
    games.push({ at: 10 + i, key: 'a', name: 'A' });
    games.push({ at: i, key: 'b', name: 'B' });
  }
  assert.equal(primaryTeamFromGames(games), null);
}

{
  const players = [
    {
      id: 'p1',
      rating: 1.14,
      clubGames: Array.from({ length: 10 }, (_, i) => ({
        at: i,
        key: 'vitality',
        name: 'Vitality'
      }))
    }
  ];
  const teams = [{ key: 'vitality', name: 'Vitality', roundWinrate: 50 }];
  attachExpectedRatings(players, teams);
  assert.equal(players[0].expectedRating, 1.08);
  assert.equal(players[0].clubWinrate, 50);
  assert.equal(players[0].clubName, 'Vitality');
  assert.equal(players[0].clubGames, undefined);
  assert.ok(Number.isFinite(players[0].trueRating));
  assert.ok(Math.abs(players[0].expectedRatingOp - (1.14 / 1.08) * 100) < 1e-9);
}

{
  const players = [
    {
      absent: true,
      rating: 1.14,
      clubGames: Array.from({ length: 10 }, (_, i) => ({
        at: i,
        key: 'vitality',
        name: 'Vitality'
      }))
    }
  ];
  attachExpectedRatings(players, [{ key: 'vitality', roundWinrate: 50 }]);
  assert.equal(players[0].expectedRating, null);
  assert.equal(players[0].trueRating, null);
  assert.equal(players[0].clubGames, undefined);
}

console.log('expectedRating.test.js ok');
