// node server/replays/gifStore.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim4-gifs-'));
process.env.AIM4_REPLAY_DIR = root;

const { GIF_DESCRIPTION_MAX } = await import('../../src/replays/gif/gifMeta.js');
const { addGif, gifFrameCount, gifDimensions, listGifs, gifFile, videoFile, posterFile, trimGifCache, convertSavedGifs, removeGif, updateGif, gifRecord } = await import('./gifStore.js');
const { handleGifShare, sharePageHtml } = await import('./gifShare.js');
const { gifWidthFor } = await import('./gifVideo.js');
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
assert.equal(g.title, 'A split');

// ---- a note's perspectives ----------------------------------------------------

{
  const { addPerspective, removePerspective, removeGif: remove, listGifs: list, videoFile: video } = await import('./gifStore.js');
  const { MAX_PERSPECTIVES, notePerspectives, perspectiveLabel, cleanPerspective } = await import('../../src/replays/gif/gifMeta.js');
  const note = await addGif(LIB, tinyGif(2), { ...meta, view: 'pov', label: 's1mple, first person' }, alice);
  assert.equal(notePerspectives(note).length, 1, 'a new note is its own one clip');
  assert.equal(perspectiveLabel(notePerspectives(note)[0]), 's1mple, first person');

  const two = await addPerspective(LIB, note.id, tinyGif(4), { kind: '2d', view: 'map', label: '2D map', fromTick: 1000, toTick: 1640 }, alice);
  const clips = notePerspectives(two);
  assert.equal(clips.length, 2, 'the clip joins the note');
  assert.equal(clips[1].frames, 4, 'with its own numbers');
  assert.equal(clips[1].kind, '2d');
  assert.notEqual(clips[1].id, note.id, 'and its own id');
  assert.ok(await video(LIB, clips[1].id), 'its file answers by id, like any clip');
  assert.equal((await list(LIB, alice)).filter((x) => x.id === note.id).length, 1, 'still one note on the wall');
  assert.equal((await list(LIB, alice)).filter((x) => x.id === clips[1].id).length, 0, 'a perspective is not a note of its own');

  // Only the note's owner, only real clips, only so many.
  await assert.rejects(addPerspective(LIB, note.id, tinyGif(2), {}, bob), /belongs to someone else/);
  await assert.rejects(addPerspective(LIB, note.id, tinyGif(2), {}, null), /Sign in/);
  await assert.rejects(addPerspective(LIB, note.id, Buffer.from('nope, text'), {}, alice), /not a GIF/);
  await assert.rejects(addPerspective(LIB, 'f'.repeat(16), tinyGif(2), {}, alice), /not found/);
  await assert.rejects(addPerspective(LIB, '../../etc', tinyGif(2), {}, alice), /not found/);
  await assert.rejects(removePerspective(LIB, note.id, clips[1].id, bob), /belongs to someone else/);
  assert.equal(cleanPerspective({ kind: 'webm', view: 'nope', label: 'x'.repeat(500) }).kind, '2d', 'cleaned like the rest');
  assert.equal(cleanPerspective({ view: 'nope' }).view, '');
  assert.ok(cleanPerspective({ label: 'x'.repeat(500) }).label.length <= 60);

  // The first stays with the note: its id is the share link.
  await assert.rejects(removePerspective(LIB, note.id, note.id, alice), /stays with the note/);

  const after = await removePerspective(LIB, note.id, clips[1].id, alice);
  assert.equal(notePerspectives(after).length, 1, 'an added one comes off');
  assert.equal(await video(LIB, clips[1].id), null, 'and its file goes');

  // Filling it up, then deleting takes every clip's file with it.
  let full = after;
  for (let i = notePerspectives(full).length; i < MAX_PERSPECTIVES; i++) full = await addPerspective(LIB, note.id, tinyGif(2), { kind: '3d', player: `p${i}` }, alice);
  assert.equal(notePerspectives(full).length, MAX_PERSPECTIVES);
  await assert.rejects(addPerspective(LIB, note.id, tinyGif(2), {}, alice), /holds up to/);
  const files = notePerspectives(full).map((c) => c.id);
  assert.equal(await remove(LIB, note.id, alice), true);
  for (const id of files) assert.equal(await video(LIB, id), null, 'no clip outlives its note');

  // Filters see all of a note's perspectives.
  const mixed = { id: 'a', kind: '3d', player: 'alpha', perspectives: [{ id: 'b', kind: '2d', player: 'bravo' }] };
  assert.equal(filterGifs([mixed], { kind: '2d' }).length, 1, 'a 3D note with a 2D perspective is both');
  assert.equal(filterGifs([mixed], { kind: '3d' }).length, 1);
  assert.equal(filterGifs([mixed], { q: 'bravo' }).length, 1, 'searched by any perspective');
  assert.equal(filterGifs([{ id: 'c', kind: '3d' }], { kind: '2d' }).length, 0);

  // The share page offers each of them, and All. One clip keeps the plain page.
  const page = sharePageHtml({ ...meta, id: 'a'.repeat(16), perspectives: [{ id: 'b'.repeat(16), kind: '2d', label: '2D <map>' }] }, 'https://aim4.io');
  assert.match(page, /data-clip="bbbbbbbbbbbbbbbb"/);
  assert.match(page, /data-clip="all"/);
  assert.match(page, /2D &lt;map&gt;/, 'a label is escaped');
  assert.ok(!/data-clips/.test(sharePageHtml({ ...meta, id: 'a'.repeat(16) }, 'https://aim4.io')), 'no tabs for one clip');
}

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

assert.deepEqual(fs.readFileSync(await gifFile(LIB, g.id)), bytes, 'a GIF that came as a GIF is served as it came');
assert.equal(await gifFile(LIB, '../gifs.json'), null);
assert.equal(await videoFile(LIB, '../gifs.json'), null);

// ---- filters --------------------------------------------------------------------

const all = await listGifs(LIB, { admin: true });
assert.deepEqual(filterGifs(all, { map: 'MIR' }).map((x) => x.id), [g.id]);
assert.deepEqual(filterGifs(all, { q: 'retake navi' }).map((x) => x.id), [g.id]);
assert.deepEqual(filterGifs(all, { kind: '3d', side: 'T', winner: 'CT', team: 'faze' }).map((x) => x.id), [g.id]);
assert.equal(filterGifs(all, { side: 'CT', kind: '3d' }).length, 0, 'a 3D GIF is seen from one side');
assert.equal(filterGifs(all, { buy: meta.teams[0].buy }).length, 1);

// ---- the share link -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (!(await handleGifShare(req, res, new URL(req.url, 'http://x')))) {
    res.writeHead(418);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const bytesOf = async (res) => Buffer.from(await res.arrayBuffer());

{
  const res = await fetch(`${base}/g/${g.id}.gif`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.deepEqual(await bytesOf(res), bytes);
}
{
  const res = await fetch(`${base}/g/${g.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`<meta property="og:video" content="http://127.0.0.1:\\d+/g/${g.id}.mp4"`), 'a preview plays the video');
  assert.match(html, new RegExp(`<meta property="og:image" content="http://127.0.0.1:\\d+/g/${g.id}.jpg"`), 'and no crawler makes a GIF');
  assert.match(html, new RegExp(`<video src="/g/${g.id}.mp4"[^>]* autoplay loop muted playsinline>`));
  assert.match(html, /data-copy="[^"]*\.gif" data-warm/, 'copying the image URL makes the GIF ahead of whoever opens it');
  assert.match(html, /<title>Retake B \| aim4<\/title>/);
  assert.match(html, /Mirage · Round 14 · 1:30 to 1:20 · NAVI \(T\) vs FaZe \(CT\) · FaZe won/);
  assert.doesNotMatch(html, /—/, 'no em dashes');
}
{
  assert.equal((await fetch(`${base}/g/0000000000000000.gif`)).status, 404);
  assert.equal((await fetch(`${base}/g/0000000000000000.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/g/nope`)).status, 418, 'not ours to answer');
}

// ---- a clip is kept as a video -----------------------------------------------------

const gifDir = path.join(path.dirname(await videoFile(LIB, g.id)));
const isGif = (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8');
const isMp4 = (b) => b.subarray(4, 8).toString('latin1') === 'ftyp';
assert.ok(isMp4(fs.readFileSync(await videoFile(LIB, g.id))), 'a GIF upload is turned into its MP4');
assert.equal(g.bytes, fs.statSync(await videoFile(LIB, g.id)).size, 'the record counts what is kept');
assert.deepEqual([g.width, g.height], [8, 6]);
assert.equal(g.frames, 3);
assert.equal(fs.readFileSync(await posterFile(LIB, g.id))[0], 0xff, 'its first frame as a JPEG');

// An MP4 upload: nothing but the MP4 and its poster until someone asks for the GIF.
const mp4Bytes = fs.readFileSync(await videoFile(LIB, g.id));
const clip = await addGif(LIB, mp4Bytes, { kind: '3d', map: 'de_nuke' }, alice);
assert.deepEqual(fs.readdirSync(gifDir).filter((n) => n.startsWith(clip.id)).map((n) => n.split('.').pop()).sort(), ['jpg', 'mp4']);
assert.deepEqual([clip.width, clip.height, clip.frames], [8, 6, 3]);

// What a note takes counts as storage straight away, and stops counting when it goes.
{
  const { storage, usage } = await import('./demoStore.js');
  const before = await usage(LIB);
  const extra = await addGif(LIB, mp4Bytes, { kind: '3d', map: 'de_nuke' }, alice);
  const during = await usage(LIB);
  assert.ok(during.gifBytes >= before.gifBytes + mp4Bytes.length, 'a new clip counts');
  assert.equal(during.bytes - during.gifBytes, before.bytes - before.gifBytes, 'and nothing else moved');
  assert.ok(await removeGif(LIB, extra.id, alice));
  assert.equal((await usage(LIB)).gifBytes, before.gifBytes);
  const space = await storage(LIB);
  assert.ok(space.bytesLeft <= space.maxBytes - space.bytes, 'never more than the cap leaves');
  if (space.diskFreeBytes !== null) assert.ok(space.bytesLeft <= space.diskFreeBytes, 'or than the disk has');
}

{
  const both = await Promise.all([fetch(`${base}/g/${clip.id}.gif`, { method: 'HEAD' }), fetch(`${base}/g/${clip.id}.gif`)]);
  assert.deepEqual(both.map((r) => r.status), [200, 200], 'two askers share one build');
  assert.equal(both[0].headers.get('content-type'), 'image/gif');
  const gif = await bytesOf(both[1]);
  assert.ok(isGif(gif), 'the GIF made on request');
  assert.equal(Number(both[0].headers.get('content-length')), gif.length, 'a HEAD says its real size, so it made it too');
  assert.equal(gifFrameCount(gif), 3, 'every frame');
  assert.deepEqual(gifDimensions(gif), { width: 8, height: 6 });
}
// A video seeks.
{
  const res = await fetch(`${base}/g/${clip.id}.mp4`, { headers: { range: 'bytes=0-9' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-9/${mp4Bytes.length}`);
  assert.deepEqual(await bytesOf(res), mp4Bytes.subarray(0, 10));
  const tail = await fetch(`${base}/g/${clip.id}.mp4`, { headers: { range: 'bytes=-4' } });
  assert.deepEqual(await bytesOf(tail), mp4Bytes.subarray(-4));
  assert.equal((await fetch(`${base}/g/${clip.id}.mp4`, { headers: { range: `bytes=${mp4Bytes.length}-` } })).status, 416);
  assert.equal((await fetch(`${base}/g/${clip.id}.mp4`)).headers.get('accept-ranges'), 'bytes');
}
// A GIF is cut down to stay pasteable; a short or small one keeps its size.
assert.equal(gifWidthFor({ width: 640, height: 360, frames: 30 }), 640);
{
  const w = gifWidthFor({ width: 1234, height: 682, frames: 145 });
  assert.ok(w > 800 && w < 950, `a six second 3D clip at about 900 wide, got ${w}`);
}
// Made GIFs go first when they take too much room, and can be made again. The clip stays.
{
  const before = fs.readFileSync(await gifFile(LIB, clip.id));
  await trimGifCache(LIB, 0);
  assert.ok(!fs.existsSync(path.join(gifDir, `${clip.id}.gif`)));
  assert.ok(fs.existsSync(path.join(gifDir, `${clip.id}.mp4`)));
  assert.equal(fs.readFileSync(await gifFile(LIB, clip.id)).length, before.length);
}
// A GIF from before clips were videos: converted once, its old link still working, and never lost before that.
{
  const old = '0123456789abcdef';
  fs.writeFileSync(path.join(gifDir, `${old}.gif`), tinyGif(4));
  await trimGifCache(LIB, 0);
  assert.ok(fs.existsSync(path.join(gifDir, `${old}.gif`)), 'the only copy is kept');
  const first = await convertSavedGifs(LIB);
  assert.deepEqual(first, { converted: 1, failed: 0 });
  assert.ok(isMp4(fs.readFileSync(path.join(gifDir, `${old}.mp4`))));
  assert.deepEqual(await convertSavedGifs(LIB), { converted: 0, failed: 0 }, 'nothing left to do');
  fs.rmSync(path.join(gifDir, `${old}.mp4`));
  assert.equal((await fetch(`${base}/g/${old}.mp4`)).status, 200, 'asked for before the conversion got to it');
  await removeGif(LIB, old, alice).catch(() => {});
  for (const ext of ['gif', 'mp4', 'jpg']) fs.rmSync(path.join(gifDir, `${old}.${ext}`), { force: true });
}
// What is not a clip is refused, and leaves nothing.
{
  const files = fs.readdirSync(gifDir).length;
  await assert.rejects(addGif(LIB, Buffer.from('not a video at all'), {}, alice), /not a GIF or an MP4/);
  const fake = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
  await assert.rejects(addGif(LIB, fake, {}, alice), /could not be read as a video/);
  assert.equal(fs.readdirSync(gifDir).length, files);
}
// Deleting takes all of it.
{
  assert.equal(await removeGif(LIB, clip.id, alice), true);
  assert.deepEqual(fs.readdirSync(gifDir).filter((n) => n.startsWith(clip.id)), []);
  assert.equal((await fetch(`${base}/g/${clip.id}.mp4`)).status, 404);
}
await new Promise((r) => server.close(r));
// The share page: the technical line waits for Alt, the links are named for what they do, the rest are icons.
{
  const html = sharePageHtml({ id: 'c'.repeat(16), title: 'Fast B', file: 'r~m1', mapName: 'Ancient', round: 2, width: 1000, height: 500, teams: [] }, 'https://aim4.io');
  assert.match(html, /<p class="tech">Ancient · Round 2<\/p>/);
  assert.match(html, /\.tech \{ display: none;/);
  assert.equal(html.match(/<body>[\s\S]*<\/body>/)[0].split('Ancient · Round 2').length, 2, 'only there, not under the title too');
  assert.match(html, /\* 2\.0000 \+ 32px/, 'sized by the picture and the window, not the file');
  assert.match(html, />Share<\/button>/);
  assert.match(html, />Copy image URL<\/button>/);
  assert.doesNotMatch(html, /Page link|Image link/);
  for (const name of ['Open the round', 'Download', 'aim4\\.io']) assert.match(html, new RegExp(`aria-label="${name}"><svg`));
  assert.doesNotMatch(sharePageHtml({ id: 'd'.repeat(16), title: 'x', teams: [] }, 'https://aim4.io'), /Open the round/, 'no round, no link to it');
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
assert.equal(await gifFile(LIB, g.id), null);
  assert.equal(await videoFile(LIB, g.id), null);
assert.equal(await gifRecord(LIB, g.id), null);
assert.equal(await removeGif(LIB, g.id, alice), false);
assert.equal((await listGifs(LIB, alice)).map((x) => x.id).join(), g2.id);

fs.rmSync(root, { recursive: true, force: true });
console.log('gifStore.test.js ok');
