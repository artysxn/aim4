// Run: node server/replays/dupeScan.test.js
//
// The duplicate-match detector against synthetic matches built with the real
// tick writer. A "duplicate" is the same GAME twice, so the fixtures are
// pairs of matches whose positions either coincide (same game, re-imported)
// or diverge (an honest rematch with the same score) — the metadata screens
// alone cannot tell those apart, which is exactly the trap the position
// check exists for.

import {
  PLAYER_SLOTS,
  totalBytes,
  writeHeader,
  writeRecord
} from '../../src/replays/shared/tickFormat.js';
import {
  chooseLoser,
  duplicateUploadMessage,
  findIdenticalMatch,
  matchPlayers,
  roundIdentityFraction,
  screenPair,
  verifyPair
} from './dupeScan.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const RATE = 16; // low tick rate keeps the fixtures small; nothing here cares
const ROUND_S = 56;
const ROUNDS = 20;

const players = (withSteam = true) =>
  Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
    id: `p${slot}`,
    name: `player${slot}`,
    steamId: withSteam ? `7656119800000${slot}` : '',
    team: slot < 5 ? 1 : 2,
    slot
  }));

/** Where a player stands: deterministic from the game seed, drifts over the
 *  round so two different games never happen to coincide for long. */
const posX = (seed, round, slot, second) => 100 * slot + 10 * seed + round + 3 * second;
const posY = (seed, round, slot, second) => -50 * slot + 7 * seed + 2 * second;

function buildRound(seed, round) {
  const rows = ROUND_S * RATE;
  const buf = new ArrayBuffer(totalBytes(rows));
  const view = new DataView(buf);
  writeHeader(view, {
    tickCount: rows,
    firstTick: 0,
    stride: 1,
    tickRate: RATE,
    playerCount: PLAYER_SLOTS
  });
  for (let row = 0; row < rows; row++) {
    const second = Math.floor(row / RATE);
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      writeRecord(view, row, slot, {
        x: posX(seed, round, slot, second),
        y: posY(seed, round, slot, second),
        z: 0,
        yaw: 0,
        pitch: 0,
        health: 100,
        armor: 0,
        weapon: 0,
        flags: 1,
        flash: 0,
        side: slot < 5 ? 2 : 3
      });
    }
  }
  return buf;
}

/** Rounds 1..N alternate winners except a fixed team-1 streak, so two games
 *  with the same script share every winner and honest edits can flip some. */
const winnerOf = (round) => (round <= 4 || round % 2 ? 1 : 2);

/**
 * One synthetic match: the record the library would hold, plus the round
 * metas and tick buffers verifyPair will ask for, keyed by file name.
 */
function buildMatch({
  id,
  seed,
  revision = 4,
  parsedAt = 1000,
  swapTeams = false,
  withSteam = true,
  flipWinners = [],
  scoreShift = 0
}) {
  const roster = players(withSteam);
  const metas = {};
  const bufs = {};
  const rounds = [];
  let s1 = 0;
  let s2 = 0;
  for (let n = 1; n <= ROUNDS; n++) {
    const winner = flipWinners.includes(n) ? 3 - winnerOf(n) : winnerOf(n);
    if (winner === 1) s1++;
    else s2++;
    const file = `${id}-r${n}`;
    rounds.push({ round: n, winner: swapTeams ? 3 - winner : winner, file });
    metas[file] = {
      round: n,
      winner,
      players: roster,
      tickRate: RATE,
      startTick: 0,
      freezeEndTick: 0,
      endTick: (ROUND_S - 1) * RATE
    };
    bufs[file] = buildRound(seed, n);
  }
  const team1 = { id: 'AAA', name: 'Alpha' };
  const team2 = { id: 'BBB', name: 'Bravo' };
  const record = {
    id,
    status: 'ready',
    map: 'DD2',
    mapName: 'Dust2',
    team1: swapTeams ? team2 : team1,
    team2: swapTeams ? team1 : team2,
    players: roster,
    parser: { name: 'test', version: '0', revision },
    parsedAt,
    uploadedAt: parsedAt,
    score: swapTeams
      ? { team1: s2 + scoreShift, team2: s1 }
      : { team1: s1 + scoreShift, team2: s2 },
    roundCount: ROUNDS,
    rounds
  };
  return { record, metas, bufs };
}

const ioFor = (...matches) => {
  const metas = Object.assign({}, ...matches.map((m) => m.metas));
  const bufs = Object.assign({}, ...matches.map((m) => m.bufs));
  return {
    readRoundMeta: async (_u, f) => metas[f] || null,
    readRoundTicks: async (_u, f) => bufs[f] || null
  };
};

// ---- matchPlayers -----------------------------------------------------------

{
  assert(matchPlayers(players(true), players(true))?.length === 10, 'steamid rosters match');
  // One side has no steamids at all: names carry the match.
  assert(matchPlayers(players(true), players(false))?.length === 10, 'name fallback matches');
  const other = players(true);
  other[3] = { ...other[3], steamId: '765611980009999', name: 'ringer' };
  assert(matchPlayers(players(true), other) === null, 'one substituted player breaks identity');
  console.log('  player identity: steamids, name fallback, substitute rejected');
}

// ---- the metadata screens ---------------------------------------------------

const original = buildMatch({ id: 'demo-a', seed: 1, revision: 4, parsedAt: 2000 });

{
  // The same game re-imported with teams stored in the other order.
  const dupe = buildMatch({ id: 'demo-b', seed: 1, revision: 2, parsedAt: 1000, swapTeams: true });
  const screen = screenPair(original.record, dupe.record);
  assert(screen, 'true duplicate passes every screen');
  assert(screen.orient === -1, `swapped teams detected, got orient ${screen.orient}`);
  assert(screen.agreement === 1, `winners agree fully, got ${screen.agreement}`);

  // Score three rounds apart cannot be the same game.
  const far = buildMatch({ id: 'demo-c', seed: 1, scoreShift: 3 });
  assert(screenPair(original.record, far.record) === null, 'score +3 is screened out');

  // Six flipped winners of twenty = 70% agreement, under the 80% bar.
  const flipped = buildMatch({ id: 'demo-d', seed: 1, flipWinners: [5, 7, 9, 11, 13, 15] });
  assert(screenPair(original.record, flipped.record) === null, '70% winner agreement rejected');

  // Two flipped winners = 90%: passes the screen (positions decide it).
  const close = buildMatch({ id: 'demo-e', seed: 1, flipWinners: [5, 7] });
  assert(screenPair(original.record, close.record), '90% winner agreement passes');
  console.log('  screens: orientation, ±2 score, 80% winner agreement');
}

// ---- position identity ------------------------------------------------------

{
  const dupe = buildMatch({ id: 'demo-b2', seed: 1 });
  const same = roundIdentityFraction(
    original.metas['demo-a-r3'],
    original.bufs['demo-a-r3'],
    dupe.metas['demo-b2-r3'],
    dupe.bufs['demo-b2-r3']
  );
  assert(same === 1, `same game, same positions: expected 1, got ${same}`);

  const rematch = buildMatch({ id: 'demo-f', seed: 9 });
  const diff = roundIdentityFraction(
    original.metas['demo-a-r3'],
    original.bufs['demo-a-r3'],
    rematch.metas['demo-f-r3'],
    rematch.bufs['demo-f-r3']
  );
  assert(diff !== null && diff < 0.9, `different game scores under 0.9, got ${diff}`);
  console.log(`  positions: duplicate ${same}, honest rematch ${diff}`);
}

// ---- verifyPair end to end --------------------------------------------------

{
  const dupe = buildMatch({ id: 'demo-b3', seed: 1, revision: 2, parsedAt: 1000 });
  const screen = screenPair(original.record, dupe.record);
  const verdict = await verifyPair(ioFor(original, dupe), 'local', original.record, dupe.record, screen);
  assert(verdict.duplicate, 'true duplicate confirmed by positions');
  assert(verdict.identical >= 2, `needs 2 identical rounds, found ${verdict.identical}`);

  // The trap: an honest rematch that ends 13:7 twice with a similar story.
  // Every screen passes; only the positions say these are different games.
  const rematch = buildMatch({ id: 'demo-g', seed: 9 });
  const screen2 = screenPair(original.record, rematch.record);
  assert(screen2, 'honest rematch passes the metadata screens (by design)');
  const verdict2 = await verifyPair(
    ioFor(original, rematch),
    'local',
    original.record,
    rematch.record,
    screen2
  );
  assert(!verdict2.duplicate, 'honest rematch is NOT marked duplicate');
  console.log('  verify: duplicate confirmed, identical-score rematch spared');
}

// ---- which copy dies --------------------------------------------------------

{
  const newer = { id: 'x', parser: { revision: 4 }, parsedAt: 1000 };
  const older = { id: 'y', parser: { revision: 2 }, parsedAt: 9999 };
  assert(chooseLoser(newer, older).remove.id === 'y', 'lower revision loses even when newer');
  const early = { id: 'x', parser: { revision: 4 }, parsedAt: 1000 };
  const late = { id: 'y', parser: { revision: 4 }, parsedAt: 2000 };
  assert(chooseLoser(early, late).remove.id === 'x', 'equal revisions: older parse loses');
  const t1 = chooseLoser({ id: 'a', parsedAt: 5 }, { id: 'b', parsedAt: 5 });
  const t2 = chooseLoser({ id: 'b', parsedAt: 5 }, { id: 'a', parsedAt: 5 });
  assert(t1.remove.id === t2.remove.id, 'ties resolve the same in either order');
  console.log('  loser choice: revision first, then age, deterministic ties');
}

// ---- upload-time: incoming copy always loses --------------------------------

{
  const dupe = buildMatch({ id: 'upload-dupe', seed: 1, filename: 'dust2.dem' });
  dupe.record.filename = 'dust2.dem';
  const rematch = buildMatch({ id: 'upload-new', seed: 9, filename: 'mirage.dem' });
  rematch.record.filename = 'other.dem';
  const io = ioFor(original, dupe, rematch);

  const hit = await findIdenticalMatch(io, 'local', dupe.record, [original.record]);
  assert(hit && hit.id === original.record.id, 'identical upload matches the stored copy');
  const msg = duplicateUploadMessage(dupe.record.filename, hit);
  assert(msg.includes('dust2.dem'), `message names the file, got ${msg}`);
  assert(msg.includes('already exists'), `message says it exists, got ${msg}`);
  assert(!msg.includes('—'), 'no em dash in the notice');

  const spared = await findIdenticalMatch(io, 'local', rematch.record, [original.record]);
  assert(spared === null, 'a different game is not cancelled');

  // Mixed batch, independent per file: one duplicate does not abort siblings.
  // Mirrors parse order (one demo at a time, library grows as unique files land).
  const uniqueA = buildMatch({ id: 'batch-a', seed: 3 });
  uniqueA.record.filename = 'a.dem';
  const uniqueB = buildMatch({ id: 'batch-b', seed: 5 });
  uniqueB.record.filename = 'b.dem';
  const batchIo = ioFor(original, uniqueA, dupe, uniqueB);
  const library = [original.record];
  const incoming = [uniqueA.record, dupe.record, uniqueB.record];
  const cancelled = [];
  const kept = [];
  for (const demo of incoming) {
    const existing = await findIdenticalMatch(batchIo, 'local', demo, library);
    if (existing) cancelled.push(demo.id);
    else {
      kept.push(demo.id);
      library.push(demo);
    }
  }
  assert(cancelled.length === 1 && cancelled[0] === dupe.record.id, `only the duplicate cancelled, got ${cancelled}`);
  assert(kept.join(',') === `${uniqueA.record.id},${uniqueB.record.id}`, `siblings kept, got ${kept}`);

  // Parsing records have no identity yet and must not cancel an upload.
  const parsing = { ...original.record, id: 'still-parsing', status: 'parsing' };
  assert(
    (await findIdenticalMatch(io, 'local', dupe.record, [parsing])) === null,
    'unready library rows are not identity'
  );
  console.log('  upload: identical cancelled, mixed batch keeps non-dupes');
}

console.log('dupeScan: all assertions passed');
