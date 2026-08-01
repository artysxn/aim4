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
// ---------------------------------------------------------------------------

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(
  /\/$/,
  ''
);
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

/** Accounts that bypass every limit: unlimited uploads, full read, full delete. */
export const ADMIN_USERNAMES = new Set(
  String(process.env.AIM4_ADMIN_USERNAMES || 'artysan,player_73b35f71')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/** Uploads before this feature landed are credited to this account. */
export const LEGACY_UPLOADER = {
  id: process.env.AIM4_LEGACY_UPLOADER_ID || 'legacy:artysan',
  username: process.env.AIM4_LEGACY_UPLOADER_NAME || 'artysan'
};

/** Verified users, keyed by token. */
const cache = new Map();
const CACHE_MS = 60 * 1000;

export const ANONYMOUS = Object.freeze({
  id: '',
  username: '',
  signedIn: false,
  admin: false
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
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Resolve the caller. Never throws: a bad or expired token is simply anonymous,
 * which the route layer then rejects wherever sign-in is required.
 *
 * @returns {Promise<{id: string, username: string, signedIn: boolean, admin: boolean}>}
 */
export async function whoami(req) {
  const token = bearer(req);
  if (!token || !isConfigured()) return ANONYMOUS;

  const hit = cache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  let user = ANONYMOUS;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
    });
    if (res.ok) {
      const body = await res.json();
      if (body?.id) {
        const username = usernameOf(body);
        user = Object.freeze({
          id: String(body.id),
          username,
          signedIn: true,
          admin: ADMIN_USERNAMES.has(username.toLowerCase())
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
