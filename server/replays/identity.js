// ---------------------------------------------------------------------------
// replays/identity.js
// Who is calling, verified server side.
//
// The client holds a Supabase session; every replay request carries its access
// token as a bearer header. The token is checked against Supabase itself
// (GET /auth/v1/user) rather than decoded locally: no JWT dependency, no shared
// secret on this box, and a revoked session stops working immediately. Results
// are cached briefly so a page that fires ten requests costs one round trip.
//
// A request with no token is anonymous. Anonymous callers can still read the
// public library, which is what keeps share links working for signed-out
// visitors, but they can never upload or see anything non-public.
//
// Admin is resolved from the site_admins table by auth.users.id. It used to be
// resolved from a comma-separated list of *usernames* in the environment, while
// any signed-in user could rename themselves to any unclaimed username: if a
// listed admin name was ever unregistered or freed up, whoever claimed it
// inherited site admin. UUIDs cannot be claimed.
// ---------------------------------------------------------------------------

import { readTicketHeader, verifyTicket } from '../admin/impersonation.js';
import { freeEntitlements, loadEntitlements } from '../entitlements/load.js';
import { db, isSiteAdmin } from '../entitlements/service.js';

/**
 * Read at call time rather than at import: the .env loader and the test
 * harnesses both set these after this module is first pulled in, and a value
 * captured too early is how "signed in everywhere except the server" happens.
 */
function supabase() {
  return {
    url: (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
  };
}

/** Uploads before this feature landed are credited to this account. */
export const LEGACY_UPLOADER = {
  id: process.env.AIM4_LEGACY_UPLOADER_ID || 'legacy:artysan',
  username: process.env.AIM4_LEGACY_UPLOADER_NAME || 'artysan'
};

/** Owner stamped on HLTV auto-ingest and probe imports into the library. */
export const INGEST_UPLOADER = {
  id: process.env.AIM4_INGEST_UPLOADER_ID || 'system:admin',
  username: process.env.AIM4_INGEST_UPLOADER_NAME || 'admin'
};

/** Verified users, keyed by token. */
const cache = new Map();
const CACHE_MS = 60 * 1000;

export const ANONYMOUS = Object.freeze({
  id: '',
  username: '',
  signedIn: false,
  admin: false,
  entitlements: freeEntitlements(),
  impersonating: null
});

function bearer(req) {
  const raw = String(req?.headers?.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : '';
}

/**
 * The display name shown as "by @name". Supabase keeps whatever the sign-up
 * flow set; fall back through the same fields the client's profile menu reads.
 */
function usernameOf(user) {
  const meta = user?.user_metadata || {};
  const name =
    meta.username ||
    meta.user_name ||
    meta.preferred_username ||
    meta.name ||
    (user?.email ? String(user.email).split('@')[0] : '');
  return String(name || `player_${String(user?.id || '').slice(0, 8)}`).trim();
}

export function isConfigured() {
  const { url, key } = supabase();
  return Boolean(url && key);
}

/**
 * May this account add demos to the shared library?
 *
 * Registration by username is deliberately cheap, and cheap registration plus
 * upload rights would fill the shared store anonymously. Writing demos
 * therefore requires one real identity behind the account: Google (a Supabase
 * identity) or Steam (verified OpenID link on the profile). Watching,
 * practising and share links ask for nothing.
 *
 * Pure and exported so the rule is testable without a request in hand.
 */
export function demoUploadIdentity(me) {
  if (!me?.signedIn) return { ok: false, error: 'Sign in first.' };
  const providers = me.providers || [];
  const anchored =
    me.admin ||
    me.provider === 'google' ||
    providers.includes('google') ||
    Boolean(me.steamId);
  if (anchored) return { ok: true };
  return {
    ok: false,
    error:
      'Link Google or Steam to your account before uploading demos. Open Account, then Connections.'
  };
}

/**
 * Verify the bearer token and attach admin status and entitlements. Cached by
 * token, so the three lookups happen once per minute per session rather than
 * once per request.
 */
async function resolveActor(req) {
  const token = bearer(req);
  const { url, key } = supabase();
  if (!token || !url || !key) return ANONYMOUS;

  const hit = cache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  let user = ANONYMOUS;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: key }
    });
    if (res.ok) {
      const body = await res.json();
      if (body?.id) {
        const id = String(body.id);
        const [admin, entitlements, profile] = await Promise.all([
          isSiteAdmin(id),
          loadEntitlements(id),
          // The linked Steam identity lives on the profile, not in auth.
          db.selectOne('profiles', { select: 'steam_id', id: `eq.${id}` }).catch(() => null)
        ]);
        user = Object.freeze({
          id,
          username: usernameOf(body),
          // For the account page only. Never sent anywhere except /api/me,
          // and never used to key anything: the id is the identity.
          email: String(body.email || ''),
          provider: String(body.app_metadata?.provider || ''),
          // Every identity attached to the account, which is what the upload
          // gate reads: a username account that has since linked Google keeps
          // provider 'email' but gains 'google' here.
          providers: Object.freeze(
            (Array.isArray(body.app_metadata?.providers) ? body.app_metadata.providers : [])
              .map((p) => String(p))
          ),
          steamId: String(profile?.steam_id || ''),
          createdAt: String(body.created_at || ''),
          signedIn: true,
          admin,
          entitlements,
          impersonating: null
        });
      }
    }
  } catch {
    /* Supabase unreachable: treat as signed out rather than failing the read */
  }

  cache.set(token, { user, expires: Date.now() + CACHE_MS });
  if (cache.size > 500) {
    for (const [k, v] of cache) {
      if (v.expires <= Date.now()) cache.delete(k);
    }
  }
  return user;
}

async function usernameFor(userId) {
  try {
    const row = await db.selectOne('profiles', { select: 'username', id: `eq.${userId}` });
    return row?.username || `player_${String(userId).slice(0, 8)}`;
  } catch {
    return `player_${String(userId).slice(0, 8)}`;
  }
}

/**
 * Resolve the caller. Never throws: a bad or expired token is simply anonymous,
 * which the route layer then rejects wherever sign-in is required.
 *
 * When an impersonation ticket is present the returned identity is the
 * *target's*, with `impersonating` describing who is actually driving. Both the
 * ticket and the admin's own session must check out, every request.
 *
 * @returns {Promise<{
 *   id: string, username: string, signedIn: boolean, admin: boolean,
 *   entitlements: object, impersonating: null | {
 *     actorId: string, actorUsername: string, targetId: string,
 *     readOnly: boolean, jti: string
 *   }
 * }>}
 */
export async function whoami(req) {
  const actor = await resolveActor(req);
  const ticket = readTicketHeader(req);
  if (!ticket || !actor.signedIn) return actor;

  const claims = await verifyTicket(ticket);
  if (!claims) return actor;

  // Both checks, every request. The ticket names the admin it was minted for,
  // so admin B cannot pick up admin A's ticket, and a ticket on its own is
  // worthless without a live admin session behind it.
  if (claims.actorId !== actor.id) return actor;
  if (!actor.admin) return actor;

  // Impersonating another admin would let one admin account launder actions
  // through another, which defeats the audit log.
  if (await isSiteAdmin(claims.targetId)) return actor;

  const [username, entitlements] = await Promise.all([
    usernameFor(claims.targetId),
    loadEntitlements(claims.targetId)
  ]);

  return Object.freeze({
    id: claims.targetId,
    username,
    signedIn: true,
    // Impersonation never confers admin, even from an admin session. Otherwise
    // "view as" would silently be "act as, with root".
    admin: false,
    entitlements,
    impersonating: Object.freeze({
      actorId: actor.id,
      actorUsername: actor.username,
      targetId: claims.targetId,
      readOnly: claims.readOnly,
      jti: claims.jti
    })
  });
}

/** Drop a cached identity, e.g. after an admin changes what someone can do. */
export function invalidateToken(token) {
  if (token) cache.delete(token);
  else cache.clear();
}

/**
 * Drop every cached whoami entry for a user id.
 * Needed after gifts / trials / recomputes: the 60s token cache otherwise keeps
 * serving the old free entitlements until TTL.
 */
export function invalidateUserIdentity(userId) {
  const id = String(userId || '');
  if (!id) return;
  for (const [token, entry] of cache) {
    if (entry?.user?.id === id) cache.delete(token);
  }
}

/**
 * Read-only impersonation must not be able to write. Route layers call this
 * before any mutation; it is a second gate behind the per-route permission
 * checks, not a replacement for them.
 */
export function readOnlyBlocked(req, user) {
  if (!user?.impersonating?.readOnly) return false;
  const method = String(req?.method || 'GET').toUpperCase();
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
