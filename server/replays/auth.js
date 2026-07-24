// ---------------------------------------------------------------------------
// replays/auth.js
// Who owns the library on the other end of a request.
//
// A replay library is private, so unlike the rest of this backend (share codes
// and leaderboards, which are public by design) the caller has to prove who
// they are. The client sends its Supabase access token; this verifies the
// signature locally and takes the account id from the verified `sub` claim.
// A user id sent in a plain header is never trusted when auth is configured.
//
// Configuration, in precedence order:
//   SUPABASE_JWT_SECRET   legacy projects: shared HS256 secret
//   SUPABASE_URL          modern projects: asymmetric keys via the JWKS endpoint
//   neither               local dev; falls back to the X-Aim4-User header and
//                         logs a warning once, so this can never be the quiet
//                         default in production
// ---------------------------------------------------------------------------

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { userKey } from './demoStore.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const JWKS_URL =
  process.env.SUPABASE_JWKS_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` : '');

/** Set to '0' to allow the header fallback even with Supabase configured. */
const REQUIRE_AUTH = process.env.AIM4_REPLAY_REQUIRE_AUTH !== '0';

export const authConfigured = Boolean(JWT_SECRET || JWKS_URL);

let jwks = null;
let warned = false;

function keyForVerify() {
  if (JWT_SECRET) return new TextEncoder().encode(JWT_SECRET);
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));
  return jwks;
}

function bearer(req) {
  const raw = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : '';
}

/**
 * Resolve the account for a request.
 *
 * @returns {Promise<{ok: boolean, user: string|null, error?: string, status?: number}>}
 */
export async function identify(req) {
  const token = bearer(req);

  if (!authConfigured) {
    if (!warned) {
      warned = true;
      console.warn(
        '[replays] SUPABASE_URL / SUPABASE_JWT_SECRET are unset: libraries are ' +
          'keyed by the X-Aim4-User header and are NOT access controlled. ' +
          'Set one before exposing this backend.'
      );
    }
    return { ok: true, user: userKey(req.headers['x-aim4-user']) };
  }

  if (!token) {
    if (!REQUIRE_AUTH) return { ok: true, user: userKey(req.headers['x-aim4-user']) };
    return { ok: false, user: null, status: 401, error: 'Sign in to use replays.' };
  }

  try {
    const { payload } = await jwtVerify(token, keyForVerify(), {
      // Supabase signs with the project's auth issuer. Pinning it stops a token
      // minted by some other project from being accepted here.
      issuer: SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : undefined,
      audience: 'authenticated',
      algorithms: JWT_SECRET ? ['HS256'] : ['RS256', 'ES256']
    });
    const sub = String(payload.sub || '');
    if (!sub) return { ok: false, user: null, status: 401, error: 'Token has no subject.' };
    return { ok: true, user: userKey(sub) };
  } catch (err) {
    // Expired is by far the most common case and is worth saying plainly, so
    // the client knows to refresh rather than to re-authenticate.
    const expired = /exp/i.test(err?.code || '') || /expired/i.test(err?.message || '');
    return {
      ok: false,
      user: null,
      status: 401,
      error: expired ? 'Session expired. Reload and sign in again.' : 'Invalid session token.'
    };
  }
}

export function authStatus() {
  return {
    configured: authConfigured,
    mode: JWT_SECRET ? 'shared-secret' : JWKS_URL ? 'jwks' : 'none',
    required: authConfigured && REQUIRE_AUTH
  };
}
