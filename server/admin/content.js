// ---------------------------------------------------------------------------
// server/admin/content.js
// Audited edits to a user's content, across both stores.
//
// One endpoint per store with a hard-coded allowlist of operations, rather than
// a bespoke endpoint per object type. The important word is hard-coded: no
// dynamic table names, no dynamic SQL, no pass-through of arbitrary column
// names. A generic admin mutation endpoint that accepts a table and a patch is
// how an admin panel quietly becomes remote code execution.
// ---------------------------------------------------------------------------

import {
  deleteDemo,
  listDemos,
  readRecord,
  setDemoVisibility,
  writeRecord
} from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';
import {
  removeMember,
  setTeamSeatCapacity,
  teamById,
  transferOwnership
} from '../replays/teamsStore.js';
import { writeAudit } from '../entitlements/audit.js';
import { recomputeUser } from '../entitlements/recompute.js';
import { ValidationError } from '../entitlements/grants.js';
import { db } from '../entitlements/service.js';

/**
 * The allowlist. Keys are the only `store` and `op` values the router will ever
 * dispatch; anything else 400s before touching a store.
 */
const OPS = {
  demos: {
    async delete({ demoId }) {
      if (!demoId) throw new ValidationError('demoId is required.');
      const record = await readRecord(SHARED_LIBRARY, demoId);
      if (!record) throw new ValidationError('That demo does not exist.');
      await deleteDemo(SHARED_LIBRARY, demoId);
      return { deleted: demoId, was: { name: record.name, uploaderId: record.uploaderId } };
    },

    async visibility({ demoId, visibility }) {
      if (!demoId) throw new ValidationError('demoId is required.');
      if (!['public', 'team', 'private'].includes(visibility)) {
        throw new ValidationError('visibility must be public, team or private.');
      }
      const record = await setDemoVisibility(SHARED_LIBRARY, demoId, visibility);
      return { demo: record };
    },

    /** Re-credit an upload, e.g. a demo that landed under the legacy uploader. */
    async reassign({ demoId, userId, username }) {
      if (!demoId || !userId) throw new ValidationError('demoId and userId are required.');
      const record = await readRecord(SHARED_LIBRARY, demoId);
      if (!record) throw new ValidationError('That demo does not exist.');
      const before = { uploaderId: record.uploaderId, uploaderName: record.uploaderName };
      record.uploaderId = userId;
      if (username) record.uploaderName = String(username).slice(0, 64);
      await writeRecord(SHARED_LIBRARY, record);
      return { demo: record, before };
    },

    async list({ userId }) {
      const demos = await listDemos(SHARED_LIBRARY);
      return { demos: userId ? demos.filter((d) => d.uploaderId === userId) : demos };
    }
  },

  teams: {
    async removeMember({ teamId, memberId, actor }) {
      if (!teamId || !memberId) throw new ValidationError('teamId and memberId are required.');
      const team = await teamById(teamId);
      if (!team) throw new ValidationError('That team does not exist.');
      // Act as the owner: the store's own permission checks stay in force
      // rather than being bypassed, so an admin cannot do something the model
      // considers impossible, like removing the owner.
      const result = await removeMember({ id: team.ownerId, admin: true }, teamId, memberId);
      await recomputeUser(memberId);
      return { team: result, actor };
    },

    async transferOwnership({ teamId, memberId }) {
      if (!teamId || !memberId) throw new ValidationError('teamId and memberId are required.');
      const team = await teamById(teamId);
      if (!team) throw new ValidationError('That team does not exist.');
      const result = await transferOwnership({ id: team.ownerId, admin: true }, teamId, memberId);
      await Promise.all([recomputeUser(team.ownerId), recomputeUser(memberId)]);
      return { team: result };
    },

    /** Raise a team's seats without changing the owner's plan. Support escape hatch. */
    async setCapacity({ teamId, capacity }) {
      if (!teamId) throw new ValidationError('teamId is required.');
      const value = Number(capacity);
      if (!Number.isFinite(value) || (value < 1 && value !== -1)) {
        throw new ValidationError('capacity must be a positive number, or -1 for unlimited.');
      }
      const team = await setTeamSeatCapacity(teamId, value);
      return { team };
    }
  },

  profile: {
    async rename({ userId, username }) {
      if (!userId || !username) throw new ValidationError('userId and username are required.');
      const clean = String(username).trim().replace(/^@+/, '').slice(0, 32);
      if (!/^[A-Za-z0-9_]{3,32}$/.test(clean)) {
        throw new ValidationError('Usernames are 3 to 32 letters, numbers or underscores.');
      }
      const [row] = await db.update('profiles', { id: `eq.${userId}` }, { username: clean });
      return { profile: row };
    },

    async setCountry({ userId, countryCode }) {
      if (!userId) throw new ValidationError('userId is required.');
      const code = String(countryCode || '').toUpperCase();
      if (code && !/^[A-Z]{2}$/.test(code)) throw new ValidationError('countryCode must be ISO alpha-2.');
      const [row] = await db.update('profiles', { id: `eq.${userId}` }, { country_code: code || null });
      return { profile: row };
    },

    /**
     * Attach a Google identity to an existing account, for a password user who
     * cannot link it themselves. Deliberately not implemented as an automatic
     * email match: identity linking is the one operation where a wrong match
     * hands someone else's account away, so it stays a documented manual step.
     */
    async linkGoogleNote({ userId, note }) {
      if (!userId) throw new ValidationError('userId is required.');
      return {
        ok: true,
        manual: true,
        message:
          'Identity linking is a manual step in the Supabase dashboard. This records the request only.',
        note: String(note || '').slice(0, 500)
      };
    }
  },

  aim: {
    async deleteRuns({ userId, scenario }) {
      if (!userId) throw new ValidationError('userId is required.');
      const params = { user_id: `eq.${userId}` };
      if (scenario) params.scenario = `eq.${scenario}`;
      await db.remove('aim_run_stats', params);
      return { ok: true, userId, scenario: scenario || 'all' };
    },

    async resetElo({ userId, elo = 1000 }) {
      if (!userId) throw new ValidationError('userId is required.');
      const value = Number(elo);
      if (!Number.isFinite(value)) throw new ValidationError('elo must be a number.');
      const [row] = await db.update('profiles', { id: `eq.${userId}` }, { elo: value });
      return { profile: row };
    },

    async deleteScores({ userId, scenario }) {
      if (!userId) throw new ValidationError('userId is required.');
      const params = { user_id: `eq.${userId}` };
      if (scenario) params.scenario = `eq.${scenario}`;
      await db.remove('scores', params);
      return { ok: true, userId, scenario: scenario || 'all' };
    }
  }
};

/** What the panel renders as available actions. */
export function contentOps() {
  const out = {};
  for (const [store, ops] of Object.entries(OPS)) out[store] = Object.keys(ops);
  return out;
}

/**
 * @param {{store: string, op: string, payload: object, actorId: string, req?: object}} input
 */
export async function applyContentOp({ store, op, payload = {}, actorId, req = null }) {
  const group = Object.prototype.hasOwnProperty.call(OPS, store) ? OPS[store] : null;
  if (!group) throw new ValidationError(`Unknown store: ${store}`);
  const handler = Object.prototype.hasOwnProperty.call(group, op) ? group[op] : null;
  if (typeof handler !== 'function') throw new ValidationError(`Unknown operation: ${store}.${op}`);

  const result = await handler({ ...payload, actor: actorId });

  await writeAudit({
    actorId,
    action: `content.${store}.${op}`,
    targetUser: payload.userId || null,
    payload: { request: payload, result },
    req
  });
  return result;
}
