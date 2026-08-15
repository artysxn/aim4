// Run: node server/sim/playbookStore.test.js
//
// The store's two promises, on a file small enough to test:
//   the light scan strips paths but STAMPS their reach (pathSeconds), so the
//   matcher can price a tape's usefulness at a late join clock unhydrated
//   hydration restores the exact path bytes it cut
// The 256 MB sidecar-write gate is a storage decision, not a parsing one:
// small files run the identical scan, they just do not persist it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openPlaybookFile } from './playbookStore.js';
import { tapeEndSeconds } from '../../shared/sim/playbook.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbookStore-'));
const file = path.join(dir, 'TST.jsonl');

const shortPath = Array.from({ length: 16 * 3 }, (_, i) => i); // 16 samples @ 8 Hz = 2 s
const longPath = Array.from({ length: 240 * 3 }, (_, i) => i % 97); // 240 @ 8 Hz = 30 s

const v2 = {
  id: 'v2-round',
  map: 'TST',
  side: 'T',
  call: 'default',
  econ: 4,
  plant: null,
  firstContact: { t: 12, rel: 'front' },
  roles: [
    {
      contract: 'banana',
      steamId: 'a',
      awp: false,
      waypoints: [
        [0, 't_spawn'],
        [8, 'banana']
      ],
      utility: [],
      path: shortPath,
      pathHz: 8
    },
    {
      contract: 'mid',
      steamId: 'b',
      awp: true,
      waypoints: [
        [0, 't_spawn'],
        [8, 'mid']
      ],
      utility: [],
      path: longPath,
      pathHz: 8
    }
  ]
};
const v1 = {
  id: 'v1-round',
  map: 'TST',
  side: 'CT',
  call: 'default',
  econ: 4,
  plant: null,
  firstContact: { t: 10, rel: 'front' },
  roles: [
    {
      contract: 'arch',
      steamId: 'c',
      awp: false,
      waypoints: [
        [0, 'ct_spawn'],
        [8, 'arch']
      ],
      utility: []
    }
  ]
};

fs.writeFileSync(file, `${JSON.stringify(v2)}\n${JSON.stringify(v1)}\n`);

const { entries, hydrate, close } = await openPlaybookFile(file);
assert(entries.length === 2, `both entries indexed (${entries.length})`);
const [e2, e1] = entries;

// ---- the light half: paths stripped, reach stamped -------------------------

assert(e2.roles[0].path === null && e2.roles[1].path === null, 'paths are stripped');
assert(e2.roles[0].pathSeconds === 2, `short reach stamped (${e2.roles[0].pathSeconds})`);
assert(e2.roles[1].pathSeconds === 30, `long reach stamped (${e2.roles[1].pathSeconds})`);
assert(e1.roles[0].pathSeconds === undefined, 'a v1 role carries no stamp');

// The stamp is what makes a hold-ending tape matchable late: the schedule
// says 8 s, the path said 30 s, and the reach is the longer of the two.
assert(tapeEndSeconds(e2.roles[1]) === 30, 'tapeEndSeconds reads the stamp over the schedule');
assert(tapeEndSeconds(e1.roles[0]) === 8, 'and stays schedule-bound for v1');

// ---- hydration: the exact bytes come back ----------------------------------

hydrate(e2);
assert(Array.isArray(e2.roles[0].path), 'hydration restores the path');
assert(
  e2.roles[0].path.length === shortPath.length &&
    e2.roles[0].path.every((v, i) => v === shortPath[i]),
  'short path byte-exact'
);
assert(
  e2.roles[1].path.length === longPath.length &&
    e2.roles[1].path.every((v, i) => v === longPath[i]),
  'long path byte-exact'
);
assert(tapeEndSeconds(e2.roles[1]) === 30, 'hydrated reach agrees with the stamp');

close?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log('playbookStore: ok (light stamps + byte-exact hydration)');
