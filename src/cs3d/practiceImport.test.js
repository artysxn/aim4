// Run: node src/cs3d/practiceImport.test.js

import { gameLabel, gameSearchText, filterGames, roundChoices } from './practiceImport.js';
import { demoFromLoadedRound } from './demoData.js';
import { writeHeader, HEADER_BYTES, TICK_BYTES } from '../replays/shared/tickFormat.js';
import { encodeReplayPackage, isReplayPackage } from '../replays/shared/replayPackage.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const faZe = {
  id: 'a',
  status: 'ready',
  map: 'ANC',
  team1: { name: 'FaZe' },
  team2: { name: 'NaVi' },
  filename: 'faze-navi-m1-ancient.dem',
  roundCount: 24,
  rounds: [{ round: 1 }]
};
const other = {
  id: 'b',
  status: 'ready',
  map: 'MIR',
  team1: { name: 'FaZe' },
  team2: { name: 'Vitality' },
  roundCount: 24,
  rounds: [{ round: 1 }]
};
const parsing = { id: 'c', status: 'parsing', map: 'ANC', team1: { name: 'FaZe' }, team2: { name: 'G2' } };

assert(gameLabel(faZe) === 'FaZe vs NaVi', 'label');
assert(gameSearchText(faZe).includes('ancient'), 'filename in search');
assert(filterGames([faZe, other, parsing], '', 'ANC').map((d) => d.id).join() === 'a', 'map + ready');
assert(filterGames([faZe], 'navi', 'ANC').length === 1, 'query hits team');
assert(filterGames([faZe], 'spirit', 'ANC').length === 0, 'query miss');
assert(filterGames([{ ...faZe, rounds: [], roundCount: 0 }], '', 'ANC').length === 0, 'skip games with no rounds');
assert(filterGames([{ ...faZe, rounds: [], roundCount: 16 }], '', 'ANC').length === 1, 'roundCount is enough');
assert(roundChoices({ rounds: [{ round: 3 }, { meta: { round: 5 } }] }).map((c) => c.label).join() === 'Round 3,Round 5', 'round labels');
assert(roundChoices({ roundCount: 2 }).map((c) => c.label).join() === 'Round 1,Round 2', 'roundCount fallback');

const ticks = new ArrayBuffer(HEADER_BYTES + TICK_BYTES);
writeHeader(new DataView(ticks), { tickCount: 1, firstTick: 100, stride: 1, tickRate: 64, playerCount: 10 });
const loaded = demoFromLoadedRound({
  name: 'NaVi vs G2',
  mapCode: 'MIR',
  stem: 'r1~abc',
  meta: { round: 7, map: 'MIR', freezeEndTick: 100 },
  ticks
});
assert(loaded.rounds.length === 1 && loaded.rounds[0].round === 7, 'one imported round');
assert(loaded.loadRound('r1~abc').header.tickCount === 1, 'ticks decode');

const pkg = encodeReplayPackage([['manifest.json', new TextEncoder().encode('{}')]]);
assert(isReplayPackage(pkg), 'package magic');
assert(!isReplayPackage(new TextEncoder().encode('<!doctype html>')), 'html is not a package');

console.log('practiceImport.test.js ok');
