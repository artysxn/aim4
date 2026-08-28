import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The store builds its paths from AIM4_REPLAY_DIR at import time, so point it
// at a scratch library before anything is loaded.
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-comms-'));
process.env.AIM4_REPLAY_DIR = tmp;

const { encodeComms, FORMAT_VERSION } = await import('../../shared/comms/format.js');
const {
  deleteComms,
  readComms,
  readCommsFile,
  readIdentities,
  saveComms,
  updateCommsAttachment
} = await import('./commsStore.js');
const { usage } = await import('./demoStore.js');

const USER = 'test-user';
const DEMO = 'demo123';

const manifest = {
  version: FORMAT_VERSION,
  name: 'vs-navi-m2',
  lang: 'no',
  durationMs: 2400000,
  model: 'faster-whisper-large-v3-turbo',
  sync: { anchorMs: 13000, detected: true, confidence: 0.94 },
  speakers: [
    { uid: 'uid-a', nickname: 'playerA', talkMs: 400000 },
    { uid: 'uid-b', nickname: 'playerB', talkMs: 200000 }
  ],
  audio: {
    codec: 'opus',
    bitrate: 8000,
    tracks: [
      { speaker: 0, byteOff: 0, byteLen: 4 },
      { speaker: 1, byteOff: 4, byteLen: 4 }
    ]
  },
  utterances: [
    { speaker: 0, startMs: 20000, endMs: 22000, text: 'de pusher banana' },
    { speaker: 1, startMs: 21000, endMs: 21500, text: 'jeg tar midt' }
  ]
};

const bytes = await encodeComms(manifest, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

{
  const meta = await saveComms(USER, DEMO, bytes, { uploadedBy: 'u1', filename: 'scrim.aim4comms' });
  assert.equal(meta.demoId, DEMO);
  assert.equal(meta.name, 'vs-navi-m2');
  assert.equal(meta.lang, 'no');
  assert.equal(meta.speakers.length, 2);
  assert.equal(meta.utteranceCount, 2);
  assert.equal(meta.hasAudio, true);
  assert.equal(meta.sync.anchorMs, 13000);
  assert.deepEqual(meta.mapping, {}, 'a fresh attach has no mapping yet');

  const stored = await readCommsFile(USER, DEMO);
  assert.deepEqual([...stored], [...bytes], 'the container is stored byte for byte');
  assert.ok((await usage(USER, { fresh: true })).commsBytes > 0, 'comms count toward the storage meter');
}

{
  // Junk must be refused at the door, not discovered by the viewer later.
  await assert.rejects(
    () => saveComms(USER, 'other', Buffer.from('not a comms file at all')),
    /comms file/i
  );
  assert.equal(await readComms(USER, 'other'), null, 'a refused upload stores nothing');
}

{
  const meta = await updateCommsAttachment(USER, DEMO, {
    mapping: { 'uid-a': 'player-1', 'uid-b': 'player-2', 'uid-ghost': 'player-9' },
    offsetMs: 250
  });
  assert.deepEqual(
    meta.mapping,
    { 'uid-a': 'player-1', 'uid-b': 'player-2' },
    'speakers that are not in the file are dropped'
  );
  assert.equal(meta.offsetMs, 250);

  // A nudge is a trim; anything past a minute means the anchor itself is wrong.
  const clamped = await updateCommsAttachment(USER, DEMO, { offsetMs: 999999 });
  assert.equal(clamped.offsetMs, 60000);
}

{
  // The identity memory is what makes the second attach a no-op.
  const remembered = await readIdentities(USER);
  assert.equal(remembered['uid-a'].playerId, 'player-1');
  assert.equal(remembered['uid-a'].nickname, 'playerA');
}

{
  // Re-uploading the same session keeps the mapping the user already made.
  const replaced = await saveComms(USER, DEMO, bytes, { uploadedBy: 'u1' });
  assert.deepEqual(
    replaced.mapping,
    { 'uid-a': 'player-1', 'uid-b': 'player-2' },
    'a replaced file does not throw away the mapping'
  );
  assert.equal(replaced.offsetMs, 60000, 'nor the nudge');
}

{
  const meta = await updateCommsAttachment(USER, DEMO, { anchorTick: 4991 });
  assert.equal(meta.anchorTick, 4991);
  assert.equal(await updateCommsAttachment(USER, 'nothing-here', { offsetMs: 1 }), null);
}

{
  const before = (await usage(USER, { fresh: true })).commsBytes;
  await deleteComms(USER, DEMO);
  assert.equal(await readComms(USER, DEMO), null);
  assert.equal(await readCommsFile(USER, DEMO), null);

  const after = (await usage(USER, { fresh: true })).commsBytes;
  assert.ok(after < before, 'detaching gives the bytes back to the quota');
  // Not zero, and correctly so: the library-wide identity memory outlives any
  // one demo's comms, which is what lets the next attach pre-fill its mapping.
  assert.ok(after > 0);
  assert.ok(Object.keys(await readIdentities(USER)).length > 0, 'the memory survives');
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log('comms store tests passed');
