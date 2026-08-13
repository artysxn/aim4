// Run: node server/sim/export.test.js
//
// The export is how a training sample leaves a 10 GB library, so the two
// properties worth money are: the package round-trips byte for byte through
// the site's own container format, and a demo's package contains exactly that
// demo's files — nothing of its neighbours', because a selection tool that
// leaks other demos rebuilds the 10 GB problem one download at a time.

import {
  decodeReplayPackage,
  PACKAGE_EXT
} from '../../src/replays/shared/replayPackage.js';
import { listExportableDemos, packageDemo, packageDemos } from './export.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const enc = (s) => new TextEncoder().encode(s);

/** A two-demo library, entirely in memory. */
const FILES = {
  '/demos/abc.json': enc(JSON.stringify({ id: 'abc', map: 'INF' })),
  '/rounds/r1~abc.tickz': enc('ticks-one'),
  '/rounds/r1~abc.json.zst': enc('meta-one'),
  '/rounds/r1~abc.c100.bin': enc('coarse-one'),
  '/rounds/r2~abc.tickz': enc('ticks-two'),
  '/rounds/r2~abc.json.zst': enc('meta-two'),
  '/rounds/r2~abc.c100.bin': enc('coarse-two'),
  '/rounds/r1~other.tickz': enc('not-yours')
};

const io = {
  // team1/team2 are RECORDS with a name, not strings. Reading them as strings
  // is what put "[object Object] vs [object Object]" on every panel row, so the
  // fixture uses the real shape.
  listDemos: async () => [
    {
      id: 'abc',
      map: 'INF',
      filename: 'spirit-vs-faze.dem',
      team1: { id: 't1', name: 'Team Spirit' },
      team2: { id: 't2', name: 'FaZe' },
      score: { team1: 13, team2: 9 },
      roundCount: 2,
      uploadedAt: 123
    },
    { id: 'ghost', map: 'MIR' } // a record whose files are gone
  ],
  demosDir: () => '/demos',
  roundsDir: () => '/rounds',
  readFile: async (p) => {
    const hit = FILES[p.replace(/\\/g, '/')];
    if (!hit) throw new Error(`ENOENT ${p}`);
    return hit;
  },
  listFiles: async (dir) => {
    const prefix = `${dir.replace(/\\/g, '/')}/`;
    return Object.keys(FILES)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length));
  },
  stat: async (p) => {
    const hit = FILES[p.replace(/\\/g, '/')];
    return hit ? { size: hit.length } : null;
  }
};

// ---- listing ----------------------------------------------------------------

{
  const list = await listExportableDemos(io);
  assert(list.find((d) => d.id === 'abc'), 'every record is listed');
  assert(list.find((d) => d.id === 'ghost'), 'including a record whose files are gone');

  const abc = list.find((d) => d.id === 'abc');
  assert(abc.map === 'INF', 'with its map');
  assert(abc.teams.join(' vs ') === 'Team Spirit vs FaZe', `and its teams as names (${abc.teams})`);
  assert(abc.score.join('-') === '13-9', 'and the score');
  assert(abc.rounds === 2, 'and its round count');
  assert(abc.files === 6, 'and how many files it owns');
  const expectBytes = ['ticks-one', 'meta-one', 'coarse-one', 'ticks-two', 'meta-two', 'coarse-two']
    .reduce((a, s) => a + s.length, 0);
  assert(abc.bytes === expectBytes, `and their true size (${abc.bytes})`);

  const ghost = list.find((d) => d.id === 'ghost');
  assert(ghost.files === 0 && ghost.bytes === 0, 'a record with no files says so honestly');
  assert(Array.isArray(ghost.teams) && ghost.teams.length === 0, 'and a nameless record has no teams, not [object Object]');
  assert(ghost.score === null, 'and no score');
}

// ---- packaging --------------------------------------------------------------

{
  const pkg = await packageDemo('abc', io);
  assert(pkg, 'a known demo packages');
  assert(pkg.filename === `abc${PACKAGE_EXT}`, 'under its own name');

  // decodeReplayPackage answers {version, files: Map<name, bytes>}.
  const decoded = decodeReplayPackage(pkg.bytes).files;
  const names = [...decoded.keys()].sort();
  assert(names[0] === 'manifest.json', 'the manifest is inside');
  assert(names.length === 7, `manifest plus six round files (${names.length})`);
  assert(!names.some((n) => n.includes('other')), "and nothing of the neighbour's");

  // Byte-for-byte: the importer on the far end must land exactly what the
  // library holds, or the sample is not the library.
  const tick = decoded.get('rounds/r1~abc.tickz');
  assert(new TextDecoder().decode(tick) === 'ticks-one', 'round bytes survive untouched');
  const manifest = JSON.parse(new TextDecoder().decode(decoded.get('manifest.json')));
  assert(manifest.id === 'abc', 'and so does the manifest');
}

{
  assert((await packageDemo('nope', io)) === null, 'an unknown demo is null, not a throw');
  assert((await packageDemo('../../etc/passwd', io)) === null, 'a hostile id is sanitized to nothing');
  assert((await packageDemo('', io)) === null, 'and an empty one too');
}

{
  const extra = {
    ...FILES,
    '/demos/xyz.json': enc(JSON.stringify({ id: 'xyz', map: 'MIR' })),
    '/rounds/r1~xyz.tickz': enc('xyz-ticks')
  };
  const io2 = {
    ...io,
    readFile: async (p) => {
      const hit = extra[p.replace(/\\/g, '/')];
      if (!hit) throw new Error(`ENOENT ${p}`);
      return hit;
    },
    listFiles: async (dir) => {
      const prefix = `${dir.replace(/\\/g, '/')}/`;
      return Object.keys(extra)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    },
    stat: async (p) => {
      const hit = extra[p.replace(/\\/g, '/')];
      return hit ? { size: hit.length } : null;
    }
  };
  const one = await packageDemos(['abc'], io2);
  assert(one && one.filename === `abc${PACKAGE_EXT}`, 'one id stays a replay package');
  const many = await packageDemos(['abc', 'xyz'], io2);
  assert(many && many.filename === 'aim4-export-2.zip', 'two ids land in one zip');
  assert(many.bytes[0] === 0x50 && many.bytes[1] === 0x4b, 'with a zip magic');
  const names = Buffer.from(many.bytes).toString('latin1');
  assert(names.includes(`abc${PACKAGE_EXT}`) && names.includes(`xyz${PACKAGE_EXT}`), 'both packages inside');
  assert((await packageDemos([], io2)) === null, 'an empty selection is null');
}

// ---- empty json listing, rounds still on disk --------------------------------
//
// Production showed Database with demos and Export with none when listDemos
// pointed at an empty SHARED_LIBRARY folder while the round files lived
// next door. A selection UI that cannot see files cannot ship a sample.

{
  const orphanIo = {
    listDemos: async () => [],
    demosDir: () => '/demos',
    roundsDir: () => '/rounds',
    readFile: io.readFile,
    listFiles: io.listFiles,
    stat: io.stat
  };
  const list = await listExportableDemos(orphanIo);
  const abc = list.find((d) => d.id === 'abc');
  assert(abc, 'a demo with only round files is still listed');
  assert(abc.files === 6, 'and still owns those files');
  const pkg = await packageDemo('abc', orphanIo);
  assert(pkg, 'and still packages, with a synthesized manifest');
}

{
  const twoLibs = {
    listLibraries: async () => [
      {
        user: 'local',
        listDemos: async () => [{ id: 'aaa', map: 'INF', filename: 'a.dem' }],
        demosDir: () => '/empty-demos',
        roundsDir: () => '/empty-rounds'
      },
      {
        user: 'uuid',
        listDemos: async () => io.listDemos(),
        demosDir: () => '/demos',
        roundsDir: () => '/rounds'
      }
    ],
    readFile: io.readFile,
    listFiles: async (dir) => {
      if (String(dir).includes('empty')) return [];
      return io.listFiles(dir);
    },
    stat: io.stat
  };
  const list = await listExportableDemos(twoLibs);
  assert(list.some((d) => d.id === 'aaa'), 'the shared-library record is listed');
  assert(list.some((d) => d.id === 'abc'), 'and so is the sibling library');
}

console.log('sim export: ok');
