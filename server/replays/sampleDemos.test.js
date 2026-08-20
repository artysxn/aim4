// Run: node server/replays/sampleDemos.test.js

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { encodeReplayPackage } from '../../src/replays/shared/replayPackage.js';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-sampledemos-'));
process.env.AIM4_SAMPLE_DIR = dir;
process.env.AIM4_SAMPLE_DEMOS = '1';

const {
  resetSampleDemoCache,
  listSampleRecords,
  getSampleRecord,
  getSamplePackageBytes,
  getSampleRoundMeta,
  handleSampleDemoRequest,
  sampleLibraryOverlayEnabled
} = await import('./sampleDemos.js');

const manifest = {
  id: 'sampletest01',
  status: 'ready',
  filename: 'fixture.dem',
  map: 'CCH',
  mapName: 'Cache',
  team1: { id: 'aaa', name: 'Alpha' },
  team2: { id: 'bbb', name: 'Bravo' },
  roundCount: 1,
  rounds: [
    {
      id: 'aaa-bbb-200-CCH-01_nJw-wUa-0VB-dPW-kz7_sJ6-xq4-lT8-0qT-PQP',
      file: 'aaa-bbb-200-CCH-01_nJw-wUa-0VB-dPW-kz7_sJ6-xq4-lT8-0qT-PQP~sampletest01',
      round: 1
    }
  ]
};

const bytes = encodeReplayPackage([
  ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))]
]);
await fsp.writeFile(path.join(dir, 'fixture.aim4replay'), bytes);
resetSampleDemoCache();

const listed = await listSampleRecords();
assert.equal(listed.length, 1, 'lists the fixture package');
assert.equal(listed[0].id, 'sampletest01');
assert.equal(listed[0].map, 'CCH');
assert.equal(listed[0].visibility, 'public');
assert.equal((await getSampleRecord('sampletest01'))?.team1?.name, 'Alpha');
assert.ok(await getSamplePackageBytes('sampletest01'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleSampleDemoRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const listRes = await fetch(`${base}/api/sampledemos`);
assert.equal(listRes.status, 200);
const listBody = await listRes.json();
assert.equal(listBody.demos[0].id, 'sampletest01');

const demoRes = await fetch(`${base}/api/sampledemos/demos/sampletest01`);
assert.equal(demoRes.status, 200);
assert.equal((await demoRes.json()).demo.map, 'CCH');

const pkgRes = await fetch(`${base}/api/sampledemos/demos/sampletest01/package`);
assert.equal(pkgRes.status, 200);
assert.equal((await pkgRes.arrayBuffer()).byteLength, bytes.byteLength);

assert.equal(sampleLibraryOverlayEnabled(), true, 'AIM4_SAMPLE_DEMOS=1 turns overlay on');

server.close();
await fsp.rm(dir, { recursive: true, force: true });

delete process.env.AIM4_SAMPLE_DIR;
resetSampleDemoCache();
const real = await listSampleRecords();
if (real.length) {
  assert.ok(real.every((r) => r.id && r.map), 'repo sampledemos have id+map');
  const rec = real.find((r) => r.map === 'CCH');
  assert.ok(rec, 'Cache sample is present');
  const meta = await getSampleRoundMeta(rec.rounds[0].file);
  assert.ok(meta?.map || meta?.round, 'sample round meta decodes');
}

console.log('sampleDemos.test.js ok');
