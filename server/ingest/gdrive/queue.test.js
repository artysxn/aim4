// Run: node server/ingest/gdrive/queue.test.js
//
// The queue's lifecycle against a fake Drive: add a folder, watch it walk
// subfolders, download, "parse" (a stub — the real parser has its own tests),
// import, and remember what it did so the re-scan skips it. The re-scan is
// the property this feature exists for: pasting the same tournament folder
// next week must import only what is new.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'gdrive-queue-'));
process.env.AIM4_INGEST_STATE_DIR = path.join(ROOT, 'state');
process.env.AIM4_INGEST_WORK_DIR = path.join(ROOT, 'work');

const { acceptsName, addJob, clearSeen, queueState, removeJob, _resetQueueState } = await import(
  './queue.js'
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function waitForIdle(timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const st = await queueState();
    if (!st.running) return st;
    if (Date.now() - t0 > timeoutMs) throw new Error('queue never went idle');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---- what counts as a demo file ---------------------------------------------
{
  assert(acceptsName('final-map1.dem'), '.dem');
  assert(acceptsName('Match.RAR'), 'case-blind .rar');
  assert(acceptsName('demos.tar.gz'), '.tar.gz');
  assert(!acceptsName('rules.pdf'), 'not a pdf');
  assert(!acceptsName('scores.xlsx'), 'not a spreadsheet');
  assert(!acceptsName(''), 'not nothing');
}

// ---- a link that is not Drive is refused before anything runs ----------------
{
  const res = await addJob('https://example.com/folder/123');
  assert(res.invalid, 'not a Drive link');
}

// ---- the fake Drive ----------------------------------------------------------
// root: [Group A/ -> one .dem, one .pdf], [one .dem at top level]
const FILES = {
  'root-folder-0001': [
    { id: 'sub-folder-00001', name: 'Group A', mimeType: 'application/vnd.google-apps.folder' },
    { id: 'file-top-000001', name: 'showmatch.dem', mimeType: 'application/octet-stream', sizeBytes: 64 }
  ],
  'sub-folder-00001': [
    { id: 'file-sub-000001', name: 'final-map1.dem', mimeType: 'application/octet-stream', sizeBytes: 64 },
    { id: 'file-sub-000002', name: 'rules.pdf', mimeType: 'application/pdf', sizeBytes: 10 }
  ]
};

function fakeDrive(log = []) {
  return {
    transport: 'fake',
    async describe(id) {
      return { id, name: 'Small Cup', mimeType: 'application/vnd.google-apps.folder', isFolder: true };
    },
    async listFolder(id) {
      log.push(`list:${id}`);
      return (FILES[id] || []).map((f) => ({
        ...f,
        isFolder: f.mimeType === 'application/vnd.google-apps.folder',
        sizeBytes: f.sizeBytes || 0,
        md5: ''
      }));
    },
    async download(file, dest) {
      log.push(`download:${file.id}`);
      // Real demo magic, so the byte sniff takes the .dem path.
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from('PBDEMS2\0' + 'x'.repeat(56), 'latin1'));
      return { path: dest, bytes: 64 };
    }
  };
}

const imported = [];
const hooks = {
  driveClient: fakeDrive(),
  packageDemo: async (demoFile, outPath) => {
    await fsp.writeFile(outPath, 'package-bytes');
    return { mapName: 'de_dust2', score: { team1: 13, team2: 7 }, team1: 'alpha', team2: 'beta', roundCount: 20, packageBytes: 13 };
  },
  importPackage: async (buf, filename) => {
    imported.push(filename);
  }
};

// ---- first run: everything demo-shaped lands ---------------------------------
{
  const res = await addJob('https://drive.google.com/drive/folders/root-folder-0001?usp=drive_link', hooks);
  assert(res.added, 'queued');
  const st = await waitForIdle();
  const job = st.jobs[0];
  assert(job.status === 'done', `done (got ${job.status}: ${job.error})`);
  assert(job.name === 'Small Cup', 'named after the folder');
  assert(job.counts.folders === 2, `walked both folders (got ${job.counts.folders})`);
  assert(job.counts.matched === 2, 'two demo files matched, the pdf did not');
  assert(job.counts.imported === 2, 'both imported');
  assert(imported.length === 2, 'the import hook saw both');
  assert(
    imported.some((n) => n.startsWith('Group A - ')),
    `the folder path rides in the name: ${imported.join(', ')}`
  );
  assert(st.seenCount === 2, 'both files remembered');

  // Scratch is gone: the work dir holds nothing for this job.
  const leftovers = await fsp.readdir(path.join(ROOT, 'work')).catch(() => []);
  assert(!leftovers.some((n) => n === job.id), 'work dir cleaned up');
}

// ---- the re-scan: nothing new, nothing re-imported ---------------------------
{
  imported.length = 0;
  const res = await addJob('https://drive.google.com/drive/folders/root-folder-0001', hooks);
  assert(res.added, 're-queued');
  const st = await waitForIdle();
  const job = st.jobs[1];
  assert(job.status === 'done', 'done again');
  assert(job.counts.skippedSeen === 2, `both skipped as known (got ${job.counts.skippedSeen})`);
  assert(job.counts.imported === 0 && imported.length === 0, 'and nothing imported twice');
}

// ---- new file appears in the folder: only it is taken ------------------------
{
  FILES['sub-folder-00001'].push({
    id: 'file-sub-000003',
    name: 'final-map2.dem',
    mimeType: 'application/octet-stream',
    sizeBytes: 64
  });
  await addJob('https://drive.google.com/drive/folders/root-folder-0001', hooks);
  const st = await waitForIdle();
  const job = st.jobs[2];
  assert(job.counts.imported === 1, 'exactly the new demo');
  assert(job.counts.skippedSeen === 2, 'the old two stayed skipped');
}

// ---- duplicates in the queue are refused -------------------------------------
{
  // Two adds of a folder that never runs (no pump hooks -> real drive would
  // run; give it hooks with a never-resolving list? Simpler: the running
  // check needs a queued job, so test against a fresh id with hooks whose
  // listFolder blocks until we let go).
  let release;
  const gate = new Promise((r) => (release = r));
  const slowHooks = {
    ...hooks,
    driveClient: {
      ...fakeDrive(),
      async listFolder(id) {
        await gate;
        return [];
      }
    }
  };
  const first = await addJob('https://drive.google.com/drive/folders/slow-folder-0001', slowHooks);
  assert(first.added, 'first add queued');
  const second = await addJob('https://drive.google.com/drive/folders/slow-folder-0001', slowHooks);
  assert(second.duplicate, 'the same folder cannot be queued twice while pending');
  release();
  await waitForIdle();
}

// ---- remove and forget -------------------------------------------------------
{
  let st = await queueState();
  const doneJob = st.jobs.find((j) => j.status === 'done');
  const removed = await removeJob(doneJob.id);
  assert(removed.removed, 'a finished job can be removed');

  const forgot = await clearSeen();
  assert(forgot.cleared === 3, `forgetting clears the seen set (got ${forgot.cleared})`);
  st = await queueState();
  assert(st.seenCount === 0, 'and the count says so');
}

// ---- state survives a "restart" ---------------------------------------------
{
  _resetQueueState();
  const st = await queueState();
  assert(st.jobs.length >= 3, 'jobs came back from disk');
  assert(!st.running, 'and nothing resumes on its own');
}

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('gdrive/queue: all assertions passed');
