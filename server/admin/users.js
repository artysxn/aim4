// ---------------------------------------------------------------------------
// server/admin/users.js
// Reading accounts for the admin panel.
//
// A user's state is split across two stores that do not share a database:
// Postgres knows about identity, plans, seats and aim stats; the Node side owns
// demo files, teams.json and the stratbook. The panel therefore merges two
// queries, and deliberately keeps them as separate fields with separate loading
// states rather than blocking the whole page on whichever is slower.
// ---------------------------------------------------------------------------

import { listDemos } from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';
import { teamsOf } from '../replays/teamsStore.js';
import { listGrants } from '../entitlements/grants.js';
import { listSubscriptions, seatsHeldBy } from '../entitlements/subscriptions.js';
import { loadEntitlements } from '../entitlements/load.js';
import { db } from '../entitlements/service.js';

const PAGE_SIZE = 50;

/** PostgREST `or=` needs its own escaping: a comma or paren would split the filter. */
function likeSafe(term) {
  return String(term).replace(/[,()*]/g, ' ').trim();
}

/**
 * @param {{q?: string, tier?: string, status?: string, page?: number, sort?: string}} opts
 */
export async function listUsers({ q = '', tier = '', status = '', page = 0, sort = 'created_at' } = {}) {
  const params = {
    select: '*',
    limit: PAGE_SIZE,
    offset: Math.max(0, Number(page) || 0) * PAGE_SIZE
  };

  const sortable = new Set(['created_at', 'last_sign_in_at', 'username', 'effective_tier', 'elo']);
  params.order = `${sortable.has(sort) ? sort : 'created_at'}.desc`;

  const term = likeSafe(q);
  if (term) params.or = `(username.ilike.*${term}*,email.ilike.*${term}*)`;
  if (tier) params.effective_tier = `eq.${tier}`;
  if (status) params.subscription_status = `eq.${status}`;

  const rows = await db.select('admin_user_overview', params);
  return { users: rows, page: Number(page) || 0, pageSize: PAGE_SIZE, hasMore: rows.length === PAGE_SIZE };
}

/** The Postgres half of one account. */
export async function userDetail(userId) {
  const [overview, subscriptions, seats, grants, entitlements] = await Promise.all([
    db.selectOne('admin_user_overview', { select: '*', id: `eq.${userId}` }),
    listSubscriptions(userId),
    seatsHeldBy(userId),
    listGrants(userId, { includeRevoked: true }),
    loadEntitlements(userId, { fresh: true })
  ]);
  return { overview, subscriptions, seats, grants, entitlements };
}

/**
 * The Node half: demo count and bytes, teams, and ownership. Slower than the
 * Postgres half because it walks the library, so the panel fetches it
 * separately.
 */
export async function userContent(userId) {
  const [demos, teams] = await Promise.all([
    listDemos(SHARED_LIBRARY).catch(() => []),
    teamsOf(userId).catch(() => [])
  ]);

  const mine = demos.filter((d) => d.uploaderId === userId);
  const bytes = mine.reduce((sum, d) => sum + (Number(d.sizeBytes) || 0), 0);

  return {
    demos: {
      count: mine.length,
      bytes,
      items: mine
        .slice(0, 200)
        .map((d) => ({
          id: d.id,
          name: d.name || d.filename,
          map: d.map,
          visibility: d.visibility,
          sizeBytes: d.sizeBytes,
          uploadedAt: d.uploadedAt
        }))
    },
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      isOwner: t.ownerId === userId,
      members: (t.members || []).length,
      seatCapacity: t.seatCapacity ?? null
    }))
  };
}

/** Resolve a username to an id, so the panel can be driven by @name. */
export async function findByUsername(username) {
  const row = await db.selectOne('profiles', {
    select: 'id,username',
    username: `eq.${username}`
  });
  return row || null;
}
