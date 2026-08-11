// Run: node server/replays/visibility.test.js
//
// The access rules are the whole point of demo privacy, so they get asserted
// rather than eyeballed: who sees a public / unlisted / private demo, whether
// a direct link changes the answer, and what the aggregate paths (Database,
// Pattern Finder, Charts) are allowed to read.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-vis-'));
process.env.AIM4_REPLAY_DIR = ROOT;

const {
  accessFor,
  canManage,
  canSee,
  ownerOf,
  recordForRoundFile,
  roundOwnerIndex,
  visibleDemoIds
} = await import('./visibility.js');
const { createTeam, joinTeam } = await import('./teamsStore.js');

const ropz = { id: 'u-ropz', username: 'ropz', admin: false };
const zywoo = { id: 'u-zywoo', username: 'zywoo', admin: false };
const karrigan = { id: 'u-karrigan', username: 'karrigan', admin: false };
const artysan = { id: 'u-artysan', username: 'artysan', admin: true };
const anon = { id: '', username: '', admin: false };

// ropz and zywoo share a team; karrigan is on another one.
await createTeam(ropz, 'Vitality');
const vitality = await createTeam(zywoo, 'Vitality B');
await joinTeam(ropz, vitality.invite);
await createTeam(karrigan, 'Falcons');

const demo = (id, uploader, visibility) => ({
  id,
  status: 'ready',
  uploaderId: uploader.id,
  uploaderName: uploader.username,
  visibility,
  rounds: [{ file: `${id}-r1` }, { file: `${id}-r2` }]
});

const records = [
  demo('pub', ropz, 'public'),
  demo('unl', ropz, 'unlisted'),
  demo('prv', ropz, 'private'),
  // A pre-accounts record: no uploader fields at all.
  { id: 'legacy', status: 'ready', rounds: [{ file: 'legacy-r1' }] }
];

const A = {
  ropz: await accessFor(ropz),
  zywoo: await accessFor(zywoo),
  karrigan: await accessFor(karrigan),
  artysan: await accessFor(artysan),
  anon: await accessFor(anon)
};

const byId = Object.fromEntries(records.map((r) => [r.id, r]));

// ---- unattributed uploads default to @admin ---------------------------------

{
  const owner = ownerOf(byId.legacy);
  assert(owner.username === 'admin', `unattributed uploader should be admin, got ${owner.username}`);
  assert(owner.visibility === 'public', 'legacy uploads stay public');
  console.log('  unattributed uploads read as public, by @admin');
}

// ---- public ------------------------------------------------------------------

{
  for (const [who, access] of Object.entries(A)) {
    assert(canSee(byId.pub, access), `${who} should see a public demo`);
  }
  console.log('  public demos are visible to everyone, signed in or not');
}

// ---- private -----------------------------------------------------------------

{
  assert(canSee(byId.prv, A.ropz), 'the uploader sees their own private demo');
  assert(canSee(byId.prv, A.artysan), 'admins see private demos');
  assert(!canSee(byId.prv, A.zywoo), 'a teammate does not see a private demo');
  assert(!canSee(byId.prv, A.karrigan), 'a stranger does not see a private demo');
  assert(!canSee(byId.prv, A.anon), 'signed-out visitors do not see private demos');
  // The link case is what separates private from unlisted.
  assert(
    !canSee(byId.prv, A.karrigan, { viaLink: true }),
    'a private demo stays closed even with the exact link'
  );
  console.log('  private demos stay with the uploader, link or not');
}

// ---- unlisted ----------------------------------------------------------------

{
  assert(canSee(byId.unl, A.ropz), 'the uploader sees their unlisted demo');
  assert(canSee(byId.unl, A.zywoo), 'a teammate sees an unlisted demo');
  assert(!canSee(byId.unl, A.karrigan), 'another team does not browse an unlisted demo');
  assert(
    canSee(byId.unl, A.karrigan, { viaLink: true }),
    'an unlisted demo opens for anyone holding the link'
  );
  assert(
    canSee(byId.unl, A.anon, { viaLink: true }),
    'an unlisted link works for a signed-out visitor'
  );
  console.log('  unlisted demos reach the team, and anyone with the link');
}

// ---- what the aggregate tools may read ---------------------------------------

{
  const forKarrigan = visibleDemoIds(records, A.karrigan);
  assert(forKarrigan.has('pub'), 'public demos feed the database');
  assert(!forKarrigan.has('prv'), "another team's private demo must not feed the database");
  assert(!forKarrigan.has('unl'), 'unlisted demos are not browsable by strangers');

  const forZywoo = visibleDemoIds(records, A.zywoo);
  assert(forZywoo.has('unl'), 'teammates aggregate unlisted rounds');
  assert(!forZywoo.has('prv'), 'teammates do not aggregate private rounds');

  const forAdmin = visibleDemoIds(records, A.artysan);
  assert(forAdmin.size === records.length, 'admins aggregate the whole library');
  console.log('  Database / Pattern Finder / Charts only aggregate what the caller may open');
}

// ---- round files resolve back to their demo ----------------------------------

{
  const owners = roundOwnerIndex(records);
  assert(owners.get('prv-r2')?.id === 'prv', 'a round file maps to its demo');
  assert(
    !canSee(owners.get('prv-r2'), A.karrigan, { viaLink: true }),
    'a private round is closed even when the file name is known'
  );
  console.log('  round files inherit their demo access');
}

// ---- a round resolves to its demo from the file name alone -------------------

{
  // Materialized rounds are stored as <roundId>~<demoId>, so a file that is not
  // in the record's list still resolves. Without this a round name that the
  // record had not caught up with would fall through as "unknown, allow".
  const stray = 'BFx-p41-154-NUK-02_a-b-c-d-e_f-g-h-i-j~prv';
  const found = recordForRoundFile(stray, records);
  assert(found?.id === 'prv', `file name should name its demo, got ${found?.id}`);
  assert(
    !canSee(found, A.karrigan, { viaLink: true }),
    'a private round stays closed when resolved by file name'
  );
  assert(
    recordForRoundFile('who-knows.json', records) === null,
    'an unrelated name resolves to nothing'
  );
  console.log('  round file names resolve to their demo without the record list');
}

// ---- managing ----------------------------------------------------------------

{
  assert(canManage(byId.pub, ropz), 'the uploader manages their demo');
  assert(canManage(byId.pub, artysan), 'admins manage any demo');
  assert(!canManage(byId.pub, zywoo), 'teammates do not rename or delete uploads');
  assert(canManage(byId.legacy, artysan), 'admins keep control of pre-account uploads');
  assert(!canManage(byId.legacy, karrigan), 'nobody else inherits pre-account uploads');
  console.log('  rename / delete stay with the uploader and the admins');
}

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('visibility: all assertions passed');
