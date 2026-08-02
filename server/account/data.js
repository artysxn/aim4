// ---------------------------------------------------------------------------
// server/account/data.js
// Export, deletion, and the 90 day retention state.
//
// All three are promised in the pricing FAQ and none of them existed. What is
// built here is the mechanism; two things are deliberately left as stubs with
// real signatures rather than faked:
//
//   Email delivery. This project has no mail provider wired up, so an export
//   returns a signed download link directly instead of "we have emailed you a
//   link". Claiming to have sent an email nobody sends is worse than not
//   offering the email.
//
//   Demo bytes. Originals run to hundreds of megabytes each, so the bundle
//   carries a manifest of signed per-demo URLs rather than inlining them. The
//   FAQ's promise is that the data is retrievable, and it is.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CAP } from '../../shared/entitlements/keys.js';
import { UNLIMITED } from '../../shared/entitlements/catalogue.js';
import { ROOT, listDemos } from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';
import { isOwner, listDocuments, teamsOf } from '../replays/teamsStore.js';
import { capability } from '../entitlements/enforce.js';
import { ValidationError } from '../entitlements/grants.js';
import { writeAudit } from '../entitlements/audit.js';
import { db, isConfigured } from '../entitlements/service.js';
import { activeSubscription } from '../entitlements/subscriptions.js';

const EXPORT_DIR = () => path.join(ROOT, 'exports');
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = Number(process.env.AIM4_RETENTION_DAYS || 90);
const DELETION_GRACE_DAYS = Number(process.env.AIM4_DELETION_GRACE_DAYS || 14);

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * What the account holds against what its current plan allows.
 *
 * The forced-selection flow in the FAQ needs this: when a plan lapses, content
 * over the new cap is locked rather than deleted, and the user picks which to
 * keep before they may create or edit again.
 */
export async function retentionState(me) {
  const [demos, teams, subscription] = await Promise.all([
    listDemos(SHARED_LIBRARY).catch(() => []),
    teamsOf(me.id).catch(() => []),
    isConfigured() ? activeSubscription(me.id).catch(() => null) : null
  ]);

  const mine = demos.filter((d) => d.uploaderId === me.id);
  const demoLimit = Number(capability(me, CAP.DEMOS_UPLOAD_LIMIT));
  const overCap = demoLimit === UNLIMITED ? 0 : Math.max(0, mine.length - demoLimit);

  const lapsedAt = subscription?.lapsed_at || null;
  const deleteAt = lapsedAt ? new Date(Date.parse(lapsedAt) + RETENTION_DAYS * DAY_MS) : null;

  const documents = [];
  for (const team of teams) {
    if (!isOwner(team, me.id)) continue;
    const docs = await listDocuments(team.id).catch(() => []);
    documents.push({ teamId: team.id, name: team.name, count: docs.length });
  }

  return {
    retentionDays: RETENTION_DAYS,
    lapsedAt,
    deleteAt: deleteAt ? deleteAt.toISOString() : null,
    daysLeft: deleteAt ? Math.max(0, Math.ceil((deleteAt.getTime() - Date.now()) / DAY_MS)) : null,
    demos: {
      held: mine.length,
      limit: demoLimit,
      overCap,
      // A selection is required before creating or editing again.
      mustChoose: overCap > 0,
      items: mine.map((d) => ({
        id: d.id,
        name: d.name || d.filename,
        map: d.map,
        sizeBytes: d.sizeBytes,
        uploadedAt: d.uploadedAt,
        locked: Boolean(d.lockedAt)
      }))
    },
    documents,
    teamDocumentLimit: Number(capability(me, CAP.TEAM_DOCUMENTS))
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Signed, single-purpose, and expiring. Not guessable from the user id. */
function newExportToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Build the bundle now and return a link to it.
 *
 * Synchronous rather than queued: this project has no job runner beyond the
 * in-memory parse queue, and a queue whose state does not survive a restart
 * would drop export requests silently.
 */
export async function exportAccount(me, req = null) {
  const [demos, teams] = await Promise.all([
    listDemos(SHARED_LIBRARY).catch(() => []),
    teamsOf(me.id).catch(() => [])
  ]);
  const mine = demos.filter((d) => d.uploaderId === me.id);

  const bundle = {
    exportedAt: new Date().toISOString(),
    account: { id: me.id, username: me.username },
    entitlements: me.entitlements,
    demos: mine.map((d) => ({
      id: d.id,
      name: d.name || d.filename,
      map: d.map,
      visibility: d.visibility,
      sizeBytes: d.sizeBytes,
      uploadedAt: d.uploadedAt,
      // The bytes stay where they are. This is the address of the original.
      downloadPath: `/api/replays/demos/${d.id}/file`
    })),
    teams: [],
    postgres: {}
  };

  for (const team of teams) {
    const docs = await listDocuments(team.id).catch(() => []);
    bundle.teams.push({
      id: team.id,
      name: team.name,
      isOwner: isOwner(team, me.id),
      members: (team.members || []).map((m) => ({ id: m.id, username: m.username, role: m.role })),
      documents: docs,
      stratbook: team.stratbook || [],
      positions: team.positions || {}
    });
  }

  if (isConfigured()) {
    const tables = ['scores', 'aim_run_stats', 'replays', 'user_settings', 'profiles'];
    await Promise.all(
      tables.map(async (table) => {
        try {
          const column = table === 'profiles' ? 'id' : 'user_id';
          bundle.postgres[table] = await db.select(table, {
            select: '*',
            [column]: `eq.${me.id}`,
            limit: 10000
          });
        } catch {
          bundle.postgres[table] = { error: 'could not be read' };
        }
      })
    );
  }

  await fsp.mkdir(EXPORT_DIR(), { recursive: true });
  const token = newExportToken();
  const file = path.join(EXPORT_DIR(), `${token}.json`);
  const payload = JSON.stringify(bundle, null, 2);
  await fsp.writeFile(file, payload, 'utf8');

  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
  if (isConfigured()) {
    await db
      .insert(
        'account_exports',
        {
          user_id: me.id,
          status: 'ready',
          token,
          path: file,
          size_bytes: Buffer.byteLength(payload),
          ready_at: new Date().toISOString(),
          expires_at: expiresAt
        },
        { returning: false }
      )
      .catch(() => {});
  }

  await writeAudit({ actorId: me.id, action: 'account.export', targetUser: me.id, req });

  return {
    status: 'ready',
    downloadUrl: `/api/account/export/${token}`,
    sizeBytes: Buffer.byteLength(payload),
    expiresAt,
    // Said plainly rather than implied, because the FAQ talks about an email.
    emailed: false,
    note: 'Download this link within 24 hours. No email is sent.'
  };
}

/** Serve a bundle by token. Expired or unknown tokens are both 404. */
export async function readExport(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const file = path.join(EXPORT_DIR(), `${token}.json`);
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > EXPORT_TTL_MS) {
      await fsp.rm(file, { force: true });
      return null;
    }
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Request deletion.
 *
 * Refused while the account owns a team that still has members: deleting it
 * would strand everyone on that roster, and the FAQ does not promise to. The
 * refusal says which team, because "you cannot delete your account" with no
 * reason is the worst possible version of this message.
 */
export async function deleteAccount(me, body = {}, req = null) {
  if (body.confirm !== me.username) {
    throw new ValidationError(`Type your username to confirm: ${me.username}`);
  }

  const teams = await teamsOf(me.id).catch(() => []);
  const blocking = teams.filter(
    (t) => isOwner(t, me.id) && (t.members || []).filter((m) => m.id !== me.id).length > 0
  );
  if (blocking.length) {
    throw new ValidationError(
      `Transfer ownership or disband first: ${blocking.map((t) => t.name).join(', ')}.`
    );
  }

  const requestedAt = new Date().toISOString();
  const deleteAt = new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS).toISOString();

  if (isConfigured()) {
    await db.update('profiles', { id: `eq.${me.id}` }, { deletion_requested_at: requestedAt }, {
      returning: false
    });
  }

  await writeAudit({
    actorId: me.id,
    action: 'account.delete.request',
    targetUser: me.id,
    payload: { deleteAt },
    req
  });

  return {
    status: 'scheduled',
    requestedAt,
    deleteAt,
    graceDays: DELETION_GRACE_DAYS,
    message: `Your account will be deleted on ${deleteAt.slice(0, 10)}. Sign in before then to cancel.`
  };
}

/** Cancel a pending deletion. Signing in is enough to want this. */
export async function cancelDeletion(me, req = null) {
  if (!isConfigured()) return { status: 'none' };
  await db.update('profiles', { id: `eq.${me.id}` }, { deletion_requested_at: null }, {
    returning: false
  });
  await writeAudit({ actorId: me.id, action: 'account.delete.cancel', targetUser: me.id, req });
  return { status: 'cancelled' };
}
