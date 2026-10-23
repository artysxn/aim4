// Run: node src/replays/eye/eyePlaylists.test.js
//
// The playlist tools against a fake playlists API: create, edit (rename, add,
// remove, replace, share), delete, a teammate's playlist left alone, the
// user saying no, and add_from "last_result" with nothing before it.

import assert from 'node:assert/strict';
import { resetTurnFacts, runTool } from './eyeTools.js';

let store = [
  { id: 'p1', name: 'HAVU B executes', rounds: ['A~m1', 'B~m1'], scope: 'private', mine: true, updatedAt: 2 },
  { id: 'p2', name: 'Anchor reviews', rounds: ['C~m2'], scope: 'team', mine: false, ownerName: 'coach', updatedAt: 1 }
];
let seq = 0;
const deleted = [];
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url), 'http://x').pathname;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path === '/api/replays/playlists' && !init.method) return json({ playlists: store });
  if (path === '/api/replays/playlists' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    const old = store.find((p) => p.id === body.id);
    if (old) Object.assign(old, { ...(body.name ? { name: body.name } : {}), ...(body.rounds ? { rounds: body.rounds } : {}), ...(body.scope ? { scope: body.scope } : {}) });
    else store = [{ id: `n${++seq}`, name: body.name, rounds: body.rounds || [], scope: body.scope || 'private', mine: true, updatedAt: 9 }, ...store];
    return json({ playlists: store });
  }
  const del = /^\/api\/replays\/playlists\/(\w+)$/.exec(path);
  if (del && init.method === 'DELETE') {
    deleted.push(del[1]);
    store = store.filter((p) => p.id !== del[1]);
    return json({ playlists: store });
  }
  return new Response('{}', { status: 404 });
};

resetTurnFacts();

// The list.
let r = JSON.parse((await runTool('list_playlists', {})).content);
assert.equal(r.total, 2);
assert.deepEqual(r.playlists.map((p) => [p.name, p.rounds, p.scope]), [['HAVU B executes', 2, 'private'], ['Anchor reviews', 1, 'team']]);
assert.equal(r.playlists[1].yours, false);

// Create.
let out = await runTool('save_playlist', { name: 'Nexus A lurks', add: [{ round: 'D~m3' }, { round: 'E~m3' }], scope: 'team' });
assert.match(out.content, /^Created the playlist "Nexus A lurks" \(id n1\): 2 rounds, shared with the team\./);
assert.deepEqual(store.find((p) => p.id === 'n1').rounds, ['D~m3', 'E~m3']);
assert.match(out.link, /^\/demos\?rounds=D~m3,E~m3$/);

// A new playlist needs a name and rounds.
assert.match((await runTool('save_playlist', { add: [{ round: 'X~m9' }] })).content, /^Error: Give the new playlist a name/);
assert.match((await runTool('save_playlist', { name: 'Empty' })).content, /^Error: A new playlist needs rounds/);
assert.match((await runTool('save_playlist', { name: 'From nothing', add_from: 'last_result' })).content, /^Error: No earlier tool answer this turn matched/);

// Edit: add one, remove one, rename. Its name alone finds it too.
out = await runTool('save_playlist', { id: 'p1', name: 'HAVU B executes, Dust2', add: [{ round: 'F~m1' }], remove: [{ round: 'A~m1' }] });
assert.match(out.content, /^Updated the playlist "HAVU B executes, Dust2" \(id p1\): 2 rounds \(1 added, 1 removed\), private\./);
assert.deepEqual(store.find((p) => p.id === 'p1').rounds, ['B~m1', 'F~m1']);
out = await runTool('save_playlist', { name: 'HAVU B executes, Dust2', add: [{ round: 'B~m1' }, { round: 'G~m1' }] });
assert.match(out.content, /1 added, 0 removed/, 'a round already in it is not added twice');

// Replace.
await runTool('save_playlist', { id: 'p1', add: [{ round: 'Z~m1' }], replace: true });
assert.deepEqual(store.find((p) => p.id === 'p1').rounds, ['Z~m1']);

// A teammate's playlist is theirs.
assert.match((await runTool('save_playlist', { id: 'p2', add: [{ round: 'Q~m2' }] })).content, /^Error: "Anchor reviews" belongs to coach/);
assert.match((await runTool('delete_playlist', { id: 'p2' })).content, /^Error: "Anchor reviews" belongs to coach/);

// One playlist's rounds.
r = JSON.parse((await runTool('list_playlists', { name: 'nexus' })).content);
assert.equal(r.name, 'Nexus A lurks');
assert.equal(r.shown, 2);

// The user says no: nothing changes.
const before = JSON.stringify(store);
out = await runTool('delete_playlist', { name: 'Nexus A lurks' }, { confirm: async () => false });
assert.match(out.content, /declined/);
assert.equal(JSON.stringify(store), before);

// Delete.
out = await runTool('delete_playlist', { name: 'Nexus A lurks' }, { confirm: async (q) => /Delete the playlist "Nexus A lurks" \(2 rounds\)/.test(q) });
assert.match(out.content, /^Deleted the playlist "Nexus A lurks"/);
assert.deepEqual(deleted, ['n1']);
assert.match((await runTool('delete_playlist', { id: 'n1' })).content, /^Error: No playlist with id "n1"/);

console.log('eyePlaylists.test.js ok');
