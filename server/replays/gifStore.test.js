// node server/replays/gifStore.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim4-gifs-'));
process.env.AIM4_REPLAY_DIR = root;

const { GIF_DESCRIPTION_MAX } = await import('../../src/replays/gif/gifMeta.js');
const { addGif, gifFrameCount, gifDimensions, listGifs, readGifFile, removeGif, updateGif, gifRecord } = await import('./gifStore.js');
const { handleGifShare, sharePageHtml } = await import('./gifShare.js');
const { createGifWriter } = await import('../../src/replays/gif/gifCore.js');
const { cleanGifMeta, descriptionParts, descriptionPlain, filterGifs, gifMetaFromRound } = await import('../../src/replays/gif/gifMeta.js');

// ---- copy links in descriptions ------------------------------------------------

assert.deepEqual(descriptionParts('Smoke from <setpos 123;setang 1923> then go'), [
  { text: 'Smoke from ' },
  { text: 'setpos 123;setang 1923', copy: 'setpos 123;setang 1923' },
  { text: ' then go' }
]);
assert.deepEqual(descriptionParts('<a> and <b>').filter((p) => p.copy).map((p) => p.copy), ['a', 'b']);
assert.deepEqual(descriptionParts('2 < 3 and <> stay text'), [{ text: '2 < 3 and <> stay text' }]);
assert.deepEqual(descriptionParts('<line\nbreak>'), [{ text: '<line\nbreak>' }], 'a link stays on one line');
assert.equal(descriptionPlain('jump <setpos 1 2 3>'), 'jump setpos 1 2 3');

const { SHARED_LIBRARY: LIB } = await import('./auth.js');
const alice = { id: 'u-alice', username: 'alice' };
const bob = { id: 'u-bob', username: 'bob' };

function tinyGif(frames = 3) {
  const w = 8;
  const h = 6;
  const writer = createGifWriter({ width: w, height: h, fps: 18 });
  for (let i = 0; i < frames; i++) {
    const rgba = new Uint8Array(w * h * 4).fill(40);
    rgba.set([250, 200, 10, 255], i * 4);
    writer.addFrame(rgba);
  }
  return Buffer.from(writer.finish());
}

// ---- the metadata -------------------------------------------------------------

const roundMeta = {
  map: 'MIR',
  round: 14,
  file: 'navi-vs-faze-m1-r14~abc123',
  team1: { name: 'NAVI' },
  team2: { name: 'FaZe' },
  team1Side: 'T',
  team2Side: 'CT',
  econ1: 4,
  econ2: 3,
  winner: 2,
  winnerSide: 'CT'
};
const meta = gifMetaFromRound(roundMeta, {
  kind: '3d',
  fromTick: 1000,
  toTick: 1640,
  clockFrom: '1:30',
  clockTo: '1:20',
  side: 'T',
  player: 's1mple',
  title: '  A   split  ',
  description: 'line one\r\n\r\n\r\n\r\nline two'
});
assert.equal(meta.kind, '3d');
assert.equal(meta.mapName, 'Mirage');
assert.equal(meta.title, 'A split');
assert.equal(meta.description, 'line one\n\nline two');
assert.deepEqual(meta.teams.map((t) => [t.name, t.side]), [['NAVI', 'T'], ['FaZe', 'CT']]);
assert.ok(meta.teams.every((t) => t.buy), 'both buys named');
assert.equal(meta.winnerSide, 'CT');
assert.equal(meta.winnerTeam, 'FaZe');
assert.equal(meta.file, 'navi-vs-faze-m1-r14~abc123');
assert.equal(cleanGifMeta({ kind: 'webm', file: '../../etc/passwd', side: 'X' }).kind, '2d');
assert.equal(cleanGifMeta({ file: '../../etc/passwd' }).file, '');
assert.equal(cleanGifMeta({ side: 'X' }).side, '');

// ---- the store ------------------------------------------------------------------

const bytes = tinyGif(3);
assert.deepEqual(gifDimensions(bytes), { width: 8, height: 6 });
assert.equal(gifFrameCount(bytes), 3);
assert.equal(gifDimensions(Buffer.from('not a gif at all')), null);

const g = await addGif(LIB, bytes, meta, alice);
assert.match(g.id, /^[a-f0-9]{16}$/);
assert.equal(g.ownerId, alice.id);
assert.equal(g.frames, 3);
assert.equal(g.width, 8);
assert.equal(g.bytes, bytes.length);
assert.equal(g.title, 'A split');

await assert.rejects(addGif(LIB, Buffer.from('nope, text'), meta, alice), /not a GIF/);
await assert.rejects(addGif(LIB, bytes, meta, null), /Sign in/);

// Two at once both land: the index writes are serialized.
const [g2, g3] = await Promise.all([addGif(LIB, tinyGif(2), { kind: '2d', map: 'de_inferno' }, alice), addGif(LIB, tinyGif(1), {}, bob)]);
assert.equal((await listGifs(LIB, alice)).length, 2);
assert.deepEqual((await listGifs(LIB, bob)).map((x) => x.id), [g3.id]);
assert.equal((await listGifs(LIB, { id: 'admin', admin: true })).length, 3);
assert.equal((await listGifs(LIB, null)).length, 0);

// Only the owner edits or deletes.
await assert.rejects(updateGif(LIB, g.id, { title: 'mine now' }, bob), /someone else/);
await assert.rejects(removeGif(LIB, g.id, bob), /someone else/);
const edited = await updateGif(LIB, g.id, { title: 'Retake B', description: 'x'.repeat(GIF_DESCRIPTION_MAX + 400) }, alice);
assert.equal(edited.title, 'Retake B');
assert.equal(edited.description.length, GIF_DESCRIPTION_MAX);
assert.equal(edited.map, 'MIR', 'an edit keeps what the GIF shows');

assert.deepEqual(await readGifFile(LIB, g.id), bytes);
assert.equal(await readGifFile(LIB, '../gifs.json'), null);

// ---- filters --------------------------------------------------------------------

const all = await listGifs(LIB, { admin: true });
assert.deepEqual(filterGifs(all, { map: 'MIR' }).map((x) => x.id), [g.id]);
assert.deepEqual(filterGifs(all, { q: 'retake navi' }).map((x) => x.id), [g.id]);
assert.deepEqual(filterGifs(all, { kind: '3d', side: 'T', winner: 'CT', team: 'faze' }).map((x) => x.id), [g.id]);
assert.equal(filterGifs(all, { side: 'CT', kind: '3d' }).length, 0, 'a 3D GIF is seen from one side');
assert.equal(filterGifs(all, { buy: meta.teams[0].buy }).length, 1);

// ---- the share link -------------------------------------------------------------

function fakeRes() {
  const res = { status: 0, headers: {}, body: null };
  res.writeHead = (s, h) => {
    res.status = s;
    res.headers = h || {};
  };
  res.end = (b) => {
    res.body = b;
  };
  return res;
}
const req = (url, method = 'GET') => ({ method, url, headers: { host: 'aim4.io' } });

{
  const res = fakeRes();
  assert.equal(await handleGifShare(req(`/g/${g.id}.gif`), res, new URL(`http://x/g/${g.id}.gif`)), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/gif');
  assert.deepEqual(res.body, bytes);
}
{
  const res = fakeRes();
  await handleGifShare(req(`/g/${g.id}`), res, new URL(`http://x/g/${g.id}`));
  assert.equal(res.status, 200);
  assert.match(res.body, new RegExp(`<meta property="og:image" content="https://aim4.io/g/${g.id}.gif"`));
  assert.match(res.body, /<title>Retake B \| aim4<\/title>/);
  assert.match(res.body, /Mirage · Round 14 · 1:30 to 1:20 · NAVI \(T\) vs FaZe \(CT\) · FaZe won/);
  assert.doesNotMatch(res.body, /—/, 'no em dashes');
}
{
  const res = fakeRes();
  await handleGifShare(req('/g/0000000000000000.gif'), res, new URL('http://x/g/0000000000000000.gif'));
  assert.equal(res.status, 404);
  assert.equal(await handleGifShare(req('/g/../../x'), fakeRes(), new URL('http://x/g/nope')), false);
}
assert.match(sharePageHtml({ id: 'a'.repeat(16), title: '<script>', teams: [] }, 'https://aim4.io'), /&lt;script&gt;/);
{
  // The public page reads <...> as copy links too, and never as markup.
  const html = sharePageHtml({ id: 'b'.repeat(16), title: 'x', description: 'from <setpos 1 2 3; setang 0 90 0> and <img src=x onerror=alert(1)>', teams: [] }, 'https://aim4.io');
  assert.match(html, /<a href="#" class="cp" data-copy="setpos 1 2 3; setang 0 90 0" title="Copy">setpos 1 2 3; setang 0 90 0<\/a>/);
  assert.match(html, /data-copy="img src=x onerror=alert\(1\)"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<meta name="description" content="from setpos 1 2 3; setang 0 90 0 and img src=x onerror=alert\(1\)"/);
  assert.match(html, /class="link" data-copy="https:\/\/aim4\.io\/g\/b{16}\.gif"/, 'a button copies the direct link');
}

// ---- deleting -------------------------------------------------------------------

assert.equal(await removeGif(LIB, g.id, alice), true);
assert.equal(await readGifFile(LIB, g.id), null);
assert.equal(await gifRecord(LIB, g.id), null);
assert.equal(await removeGif(LIB, g.id, alice), false);
assert.equal((await listGifs(LIB, alice)).map((x) => x.id).join(), g2.id);

fs.rmSync(root, { recursive: true, force: true });
console.log('gifStore.test.js ok');
