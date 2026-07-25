// ---------------------------------------------------------------------------
// replays/auth.js
// Who owns the library on the other end of a request.
//
// Replays are open to anyone: signed-out visitors share the "local" library
// (or whatever X-Aim4-User names). When a Supabase access token is present it
// is verified and the account id comes from the `sub` claim, so each signed-in
// user gets their own library. Set AIM4_REPLAY_REQUIRE_AUTH=1 to restore the
// old sign-in gate.
//
// Configuration, in precedence order:
//   SUPABASE_JWT_SECRET   legacy projects: shared HS256 secret
//   SUPABASE_URL          modern projects: asymmetric keys via the JWKS endpoint
//   neither               header / "local" only (no JWT verification)
// ---------------------------------------------------------------------------

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { userKey } from './demoStore.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const JWKS_URL =
  process.env.SUPABASE_JWKS_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` : '');

/** Opt in to require a valid session; default is open (anyone can use replays). */
const REQUIRE_AUTH = process.env.AIM4_REPLAY_REQUIRE_AUTH === '1';

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

function guestUser(req) {
  return userKey(req.headers['x-aim4-user']);
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
    return { ok: true, user: guestUser(req) };
  }

  if (!token) {
    if (REQUIRE_AUTH) {
      return { ok: false, user: null, status: 401, error: 'Sign in to use replays.' };
    }
    return { ok: true, user: guestUser(req) };
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
    if (!REQUIRE_AUTH) {
      // Bad/expired token: still let them use the guest library rather than
      // locking the whole page behind a reload.
      return { ok: true, user: guestUser(req) };
    }
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
