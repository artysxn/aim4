// ---------------------------------------------------------------------------
// server/ingest/faceit/spool.js
// The handoff between the API server and the ingester.
//
// FACEIT posts a webhook the moment a demo is uploaded. The API server must
// answer that POST in milliseconds (a slow or failing endpoint just earns
// retries), and it must not touch the ledger, because the ingester is the only
// writer and two writers would race. So the receiver's entire job is to drop
// the raw envelope in a directory and reply 200; the ingester picks it up on
// its next pass.
//
// A directory of files rather than an in-process queue, for the same reason the
// ledger is a file: either side restarts independently, and a webhook that
// arrived while the ingester was down must still be there when it comes back.
//
// Filenames key on the MATCH, not the delivery. FACEIT retries deliveries and
// sends several events per match, and every one of them means the same thing to
// us: "go read GET /matches/{id}". Keying on match id makes a redelivery
// overwrite rather than accumulate, so a match that FACEIT retried six times is
// one unit of work instead of six.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Events worth spooling. Anything else is dropped at the door. */
export const HANDLED_EVENTS = new Set([
  // The one that matters: the demo exists and can be exchanged for a download.
  'match_demo_ready',
  // Match over, demo usually not up yet. Opens an awaiting_demo row so the gap
  // between "finished" and "demo arrived" is visible instead of silent.
  'match_status_finished',
  // Close a pending row rather than re-checking it for 48 hours.
  'match_status_aborted',
  'match_status_cancelled'
]);

/** Filesystem-safe, collision-free, and still readable in an `ls`. */
function spoolName(event, matchId) {
  const safe = String(matchId).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${event}~${safe}.json`;
}

/**
 * Persist one webhook envelope for the ingester.
 *
 * Write-and-rename: a reader scanning the directory must never see a half
 * written file, and it cannot hold a lock against a writer in another process.
 *
 * @param {string} dir      spool directory
 * @param {string} event    envelope `event`
 * @param {string} matchId  envelope `payload.id`
 * @param {Buffer|string} raw  the exact bytes FACEIT sent
 */
export async function writeSpoolFile(dir, event, matchId, raw) {
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, spoolName(event, matchId));
  // The temp name carries the pid so two processes cannot collide on it, which
  // matters the moment this runs anywhere with more than one instance.
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, raw);
  await fsp.rename(tmp, target);
  return target;
}

/**
 * Every spooled envelope, oldest first.
 *
 * Oldest first because a match that finished an hour ago should be ingested
 * before one that finished a minute ago; the library fills in the order things
 * actually happened.
 */
export async function readSpool(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('.tmp')) continue;
    const full = path.join(dir, name);
    const [raw, stat] = await Promise.all([
      fsp.readFile(full, 'utf8').catch(() => null),
      fsp.stat(full).catch(() => null)
    ]);
    if (!raw || !stat) continue;
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      // Unparseable means it will never parse. Leaving it would make the
      // ingester re-read it forever, so it is renamed aside for a human.
      await fsp.rename(full, `${full}.bad`).catch(() => {});
      continue;
    }
    rows.push({ file: full, receivedAt: stat.mtimeMs, envelope });
  }
  return rows.sort((a, b) => a.receivedAt - b.receivedAt);
}

/** Done with it. Only ever called after the ledger write has landed. */
export async function removeSpoolFile(file) {
  await fsp.rm(file, { force: true }).catch(() => {});
}
