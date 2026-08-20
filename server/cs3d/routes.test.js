// node server/cs3d/routes.test.js
//
// Localhost used to serve a leftover weapons pack forever: fillFromFallback
// only runs on a missing file, so a v3 manifest on disk hid the bucket's v4.
// Map packs must still win over the bucket (interactives.json).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-cs3d-pack-'));
process.env.CS3D_PACK_DIR = dir;
process.env.CS3D_FETCH_BASE = 'https://bucket.test';

const origFetch = globalThis.fetch;
const bucket = new Map([
  [
    'https://bucket.test/weapons/manifest.json',
    { version: 4, generated: 'new', weapons: { ak47: { file: 'ak47.glb' } } }
  ],
  ['https://bucket.test/weapons/ak47.glb', Buffer.from('v4-ak47')],
  ['https://bucket.test/dust2/interactives.json', { version: 99, doors: [] }]
]);

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://bucket.test/')) {
    const body = bucket.get(u);
    if (body == null) return new Response('missing', { status: 404 });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Response(buf, { status: 200 });
  }
  return origFetch(url, init);
};

const { handleCs3dRequest, remotePackNewer, resetCs3dFallbackState, SHARED_CS3D_PACKS } = await import(
  './routes.js'
);

assert.equal(remotePackNewer({ version: 3 }, { version: 4 }), true);
assert.equal(remotePackNewer({ version: 4 }, { version: 4 }), false);
assert.equal(remotePackNewer({ version: 5 }, { version: 4 }), false);
assert.equal(remotePackNewer(null, { version: 4 }), true);
assert.equal(remotePackNewer({ version: 3 }, {}), false);
assert.ok(SHARED_CS3D_PACKS.has('weapons'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (await handleCs3dRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function writeJson(rel, obj) {
  const file = path.join(dir, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(obj));
}

await writeJson('dust2/interactives.json', { version: 1, doors: ['local'] });
{
  const res = await fetch(`${base}/api/cs3d/dust2/interactives.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1, 'map-pack files must not be replaced by the bucket');
  assert.deepEqual(body.doors, ['local']);
}

resetCs3dFallbackState();
await writeJson('weapons/manifest.json', { version: 5, generated: 'local' });
{
  const body = await (await fetch(`${base}/api/cs3d/weapons/manifest.json`)).json();
  assert.equal(body.version, 5, 'a newer local shared pack must win');
}

resetCs3dFallbackState();
await writeJson('weapons/manifest.json', { version: 3, generated: 'old' });
await fsp.writeFile(path.join(dir, 'weapons', 'ak47.glb'), 'v3-ak47');
{
  const res = await fetch(`${base}/api/cs3d/weapons/manifest.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 4, 'a stale shared index must come from the bucket');
  assert.equal(
    fs.existsSync(path.join(dir, 'weapons', 'ak47.glb')),
    false,
    'old shared-pack files must be dropped so they cannot keep serving v3'
  );
}
{
  const res = await fetch(`${base}/api/cs3d/weapons/ak47.glb`);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'v4-ak47');
}

server.close();
globalThis.fetch = origFetch;
await fsp.rm(dir, { recursive: true, force: true });
console.log('routes.test.js OK');
