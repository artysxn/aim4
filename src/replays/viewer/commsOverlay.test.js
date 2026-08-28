import assert from 'node:assert/strict';

import { commsSidebarHtml, commsSidebarKey, createCommsController } from './commsOverlay.js';
import { FORMAT_VERSION, validateManifest } from '../../../shared/comms/format.js';
import { msToTick } from '../../../shared/comms/sync.js';

// Round 1 goes live at tick 3265 on a 64-tick demo; the recorder wrote down
// that this instant was 10s into the recording.
const ANCHOR_TICK = 3265;
const ANCHOR_MS = 10000;
const TICK_RATE = 64;

const rounds = [
  { round: 1, file: 'r1~demo1', freezeEndTick: ANCHOR_TICK, tickRate: TICK_RATE },
  { round: 2, file: 'r2~demo1', freezeEndTick: 20000, tickRate: TICK_RATE }
];

const roster = [
  { id: 'p-nardes', name: 'nardes', team: 1, slot: 0 },
  { id: 'p-righi', name: 'righi', team: 1, slot: 1 }
];

const manifest = validateManifest({
  version: FORMAT_VERSION,
  name: 'scrim',
  lang: 'pt',
  sync: { anchorMs: ANCHOR_MS, detected: true, confidence: 1 },
  speakers: [
    { uid: 'uid-a', nickname: 'nardes_ts', talkMs: 5000 },
    { uid: 'uid-b', nickname: 'righi_ts', talkMs: 3000 },
    // A third voice nobody has mapped: a coach, or someone idling in channel.
    { uid: 'uid-coach', nickname: 'coach', talkMs: 1000 }
  ],
  utterances: [
    { speaker: 0, startMs: 20000, endMs: 22000, text: 'vou de meio' },
    { speaker: 1, startMs: 21000, endMs: 21500, text: 'segura o TR' },
    { speaker: 2, startMs: 30000, endMs: 31000, text: 'calma, joga junto' }
  ]
});

const mapping = { 'uid-a': 'p-nardes', 'uid-b': 'p-righi' };

/** A controller with its network calls already answered. */
function controllerWithFile() {
  const c = createCommsController({
    demoId: 'demo1',
    rounds,
    players: () => roster
  });
  c.state.meta = { mapping, offsetMs: 0, anchorTick: ANCHOR_TICK };
  c.state.file = { manifest };
  return c;
}

const tickAt = (ms) => msToTick({ anchorMs: ANCHOR_MS, anchorTick: ANCHOR_TICK, tickRate: TICK_RATE }, ms);

{
  const c = controllerWithFile();
  await c.rebuild();
  assert.ok(c.state.timeline, 'a mapped file with an anchor builds a timeline');

  // Mid-sentence for both mapped speakers.
  const lines = c.linesAt(tickAt(21200));
  assert.equal(lines.size, 2, 'both mapped speakers have a caption');
  assert.equal(lines.get('p-nardes').text, 'vou de meio');
  assert.equal(lines.get('p-nardes').speaking, true);
  assert.equal(lines.get('p-nardes').alpha, 1, 'a live caption is fully opaque');
}

{
  const c = controllerWithFile();
  await c.rebuild();

  // Just after the speaker stops, the caption is still there and still fully
  // readable. It holds through most of the two second linger and only fades at
  // the very end: starting to fade the instant someone stops talking would
  // make the last word of every call the hardest one to read.
  const justAfter = c.linesAt(tickAt(22400));
  assert.equal(justAfter.get('p-nardes').speaking, false);
  assert.equal(justAfter.get('p-nardes').alpha, 1, 'held at full opacity');

  // Near the end of the linger it is on its way out.
  const fading = c.linesAt(tickAt(23800));
  assert.ok(
    fading.get('p-nardes').alpha > 0 && fading.get('p-nardes').alpha < 1,
    `fades out at the end of the linger (alpha ${fading.get('p-nardes')?.alpha})`
  );

  // Past the linger, nothing is drawn at all.
  assert.equal(c.linesAt(tickAt(24500)), null, 'no captions means null, not an empty map');
  assert.equal(c.linesAt(tickAt(40000)), null);
}

{
  // The coach is not on the roster. Their words must never be printed above
  // someone else's droplet, so the 2D layer drops them entirely.
  const c = controllerWithFile();
  await c.rebuild();
  assert.equal(c.linesAt(tickAt(30500)), null, 'an unmapped speaker gets no droplet caption');

  // The 3D sidebar is a list of who is talking, so the coach belongs there.
  const rows = c.sidebarRows(tickAt(30500));
  assert.equal(rows.length, 3, 'every speaker gets a sidebar row');
  const coach = rows.find((r) => r.uid === 'uid-coach');
  assert.equal(coach.speaking, true);
  assert.equal(coach.text, 'calma, joga junto');
  assert.equal(coach.playerId, null);
  assert.equal(coach.name, 'coach', 'an unmapped row falls back to the TeamSpeak nickname');
}

{
  // Mapped rows take the roster's name and team, not the TeamSpeak nickname:
  // the viewer is full of the former and nobody would connect "righi_ts".
  const c = controllerWithFile();
  await c.rebuild();
  const rows = c.sidebarRows(tickAt(21200));
  const righi = rows.find((r) => r.uid === 'uid-b');
  assert.equal(righi.name, 'righi');
  assert.equal(righi.team, 1);
  assert.equal(righi.playerId, 'p-righi');
}

{
  // The sidebar keeps the last thing someone said rather than blanking, which
  // would read as "disconnected" instead of "listening".
  const c = controllerWithFile();
  await c.rebuild();
  const rows = c.sidebarRows(tickAt(60000));
  assert.equal(rows[0].speaking, false);
  assert.equal(rows[0].text, 'vou de meio', 'last line stays up');
}

{
  // Switched off, both renderers must go quiet without losing the attachment.
  const c = controllerWithFile();
  await c.rebuild();
  c.setEnabled(false);
  assert.equal(c.linesAt(tickAt(21200)), null);
  assert.equal(c.sidebarRows(tickAt(21200)), null);
  assert.equal(c.attached, true, 'disabling is not detaching');
  c.setEnabled(true);
  assert.ok(c.linesAt(tickAt(21200)), 'and it comes back');
}

{
  // A nudge shifts the captions against the demo, subtitle-style: positive is
  // later. With +1s, a line that was live at 21.2s is now live at 22.2s.
  const c = controllerWithFile();
  c.state.meta.offsetMs = 1000;
  await c.rebuild();
  assert.equal(
    c.linesAt(tickAt(22200)).get('p-nardes').speaking,
    true,
    '+1s moves the line a second later into the round'
  );
  // The line starts at 20.0s unshifted, so with +1s nothing is up at 20.5s.
  assert.equal(c.linesAt(tickAt(20500)), null, 'and it has not started a second early');
}

{
  // A file whose countdown was never found is attached and readable, but has
  // nothing to place it against. It must degrade to "no captions", not throw.
  const c = createCommsController({ demoId: 'demo1', rounds, players: () => roster });
  c.state.meta = { mapping, offsetMs: 0, anchorTick: ANCHOR_TICK };
  c.state.file = {
    manifest: validateManifest({
      ...manifest,
      sync: { anchorMs: null, detected: false, confidence: 0 }
    })
  };
  await c.rebuild();
  assert.equal(c.state.timeline, null, 'no anchor, no timeline');
  assert.equal(c.linesAt(tickAt(21200)), null);
  assert.equal(c.sidebarRows(tickAt(21200)), null);
}

{
  // Nothing attached at all: every accessor stays quiet.
  const c = createCommsController({ demoId: 'demo1', rounds, players: () => roster });
  assert.equal(c.attached, false);
  assert.equal(c.placed, false);
  assert.equal(c.needsSync, false, 'nothing attached is not the same as needing a sync point');
  assert.equal(c.linesAt(1000), null);
  assert.equal(c.sidebarRows(1000), null);
}

{
  // The three states the toolbar button has to tell apart, because a file that
  // is attached but unplaced must not look switched on while the map is silent.
  const placed = controllerWithFile();
  await placed.rebuild();
  assert.equal(placed.attached, true);
  assert.equal(placed.placed, true);
  assert.equal(placed.needsSync, false);

  const unplaced = createCommsController({ demoId: 'demo1', rounds, players: () => roster });
  unplaced.state.meta = { mapping, offsetMs: 0, anchorTick: ANCHOR_TICK };
  unplaced.state.file = {
    manifest: validateManifest({
      ...manifest,
      sync: { anchorMs: null, detected: false, confidence: 0 }
    })
  };
  await unplaced.rebuild();
  assert.equal(unplaced.attached, true);
  assert.equal(unplaced.placed, false, 'nothing to draw');
  assert.equal(unplaced.needsSync, true, 'and the button should say so');

  // Attached but still downloading is not "needs sync": nothing is wrong yet.
  const loading = createCommsController({ demoId: 'demo1', rounds, players: () => roster });
  loading.state.meta = { mapping, offsetMs: 0, anchorTick: ANCHOR_TICK };
  assert.equal(loading.needsSync, false, 'a file still loading is not a broken one');
}

{
  // Round 1 is in the loaded rounds, so the anchor tick resolves without
  // asking the server for the demo record.
  const c = createCommsController({ demoId: 'demo1', rounds, players: () => roster });
  assert.equal(await c.resolveAnchorTick(), ANCHOR_TICK);

  // A saved anchor wins over re-deriving it: someone may have picked a
  // different countdown by hand.
  const pinned = createCommsController({ demoId: 'demo1', rounds, players: () => roster });
  pinned.state.meta = { anchorTick: 999, mapping: {} };
  assert.equal(await pinned.resolveAnchorTick(), 999);
}

// ---- the 3D sidebar's markup -----------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );

{
  const c = controllerWithFile();
  await c.rebuild();
  const rows = c.sidebarRows(tickAt(21200));
  const html = commsSidebarHtml(rows, esc, { 1: 'T', 2: 'CT' });

  assert.equal((html.match(/rv-comms-row/g) || []).length, 3, 'one row per speaker');
  assert.equal((html.match(/is-live/g) || []).length, 2, 'only the two talking are lit');
  assert.ok(html.includes('>nardes<'), 'mapped rows use the roster name');
  assert.ok(!html.includes('nardes_ts'), 'not the TeamSpeak nickname');
  assert.ok(html.includes('vou de meio'));
  assert.ok(html.includes('data-side="T"'), 'team 1 rows carry their side for colouring');
}

{
  // Transcribed speech is untrusted text that goes straight into innerHTML.
  const rows = [
    { uid: 'u1', name: '<img src=x onerror=alert(1)>', team: null, text: 'x', speaking: false },
    { uid: 'u2', name: 'ok', team: null, text: '</span><script>bad()</script>', speaking: true }
  ];
  const html = commsSidebarHtml(rows, esc);
  assert.ok(!html.includes('<img'), 'a hostile nickname cannot inject markup');
  assert.ok(!html.includes('<script'), 'nor can a hostile transcript');
  assert.ok(html.includes('&lt;img'), 'it is shown as text instead');
}

{
  // Rows with no team must not emit a side attribute at all, or the CSS would
  // colour a coach as if they were on one.
  const html = commsSidebarHtml([{ uid: 'c', name: 'coach', team: null, text: 'hi', speaking: false }], esc, {
    1: 'T',
    2: 'CT'
  });
  assert.ok(!html.includes('data-side'), 'an unmapped row has no side');
}

{
  // The key is what stops the sidebar rebuilding its DOM every frame.
  const base = [{ uid: 'a', name: 'x', team: 1, text: 'hello', speaking: true }];
  assert.equal(commsSidebarKey(base), commsSidebarKey([...base]), 'same rows, same key');
  assert.notEqual(
    commsSidebarKey(base),
    commsSidebarKey([{ ...base[0], speaking: false }]),
    'the live dot going out is a change worth redrawing'
  );
  assert.notEqual(
    commsSidebarKey(base),
    commsSidebarKey([{ ...base[0], text: 'different' }]),
    'so is new speech'
  );
  assert.equal(commsSidebarKey(null), '', 'no rows, no key');
}

console.log('comms controller tests passed');
