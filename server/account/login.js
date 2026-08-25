// ---------------------------------------------------------------------------
// server/account/login.js
// Password sign-in, by username or by email.
//
// Supabase authenticates on EMAIL. The site's identity is a USERNAME, and for
// an account seeded by an admin the email is an internal address nobody knows.
// So something has to turn one into the other, and where that happens matters:
//
//   · A public "what is the email for this username" lookup — an RPC, or an
//     endpoint returning the address — is an email harvester. Anyone could walk
//     the leaderboard and collect an address per player.
//   · Doing it here means the address never leaves the server. The browser
//     sends a username and a password and gets back a session, exactly as if
//     it had signed in with the email itself.
//
// The password grant runs with the ANON key, not the service role: this is a
// real credential check by Supabase, not something this box decides. A wrong
// password fails here the same way it fails in the browser.
//
// Both failure modes — no such username, wrong password — return the same
// message and the same status. Distinguishing them tells an attacker which
// usernames exist.
// ---------------------------------------------------------------------------

import { authAdmin, db } from '../entitlements/service.js';

/** Read at call time, not import time: .env and tests both set these late. */
function config() {
  return {
    url: (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
  };
}

/** What the caller is told for every credential failure, whatever the cause. */
const GENERIC_FAILURE = 'Wrong username or password.';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/**
 * Attempts allowed per window, per IP and per identifier.
 *
 * Two counters rather than one: an IP limit alone lets a botnet spread a
 * dictionary attack on one account across many addresses, and an identifier
 * limit alone lets one address walk a list of usernames. Supabase rate-limits
 * its own auth endpoints too; this is about not forwarding the flood.
 */
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** @type {Map<string, number[]>} key -> attempt timestamps inside the window */
const attempts = new Map();

function tooMany(key) {
  if (!key) return false;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

function recordAttempt(key) {
  if (!key) return;
  const list = attempts.get(key) || [];
  list.push(Date.now());
  attempts.set(key, list);
  // The map is only ever written on a FAILED sign-in, so it stays small; this
  // keeps it from growing without bound across a long-lived process.
  if (attempts.size > 5000) {
    const now = Date.now();
    for (const [k, v] of attempts) {
      if (!v.some((t) => now - t < WINDOW_MS)) attempts.delete(k);
    }
  }
}

/** Clear the counters for one identity after a success, so a typo is not sticky. */
function clearAttempts(keys) {
  for (const k of keys) if (k) attempts.delete(k);
}

/** Only for tests: drop every counter. */
export function resetLoginThrottle() {
  attempts.clear();
}

function clientIp(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.socket?.remoteAddress || '';
}

/**
 * The login email for an identifier.
 *
 * An identifier with "@" is taken as the email itself, which is what keeps
 * accounts made before username login worked signing in unchanged. Anything
 * else is a username and is resolved through profiles -> auth.users.
 *
 * @returns {Promise<string>} '' when the username matches nothing
 */
async function emailForIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (raw.includes('@')) return raw.toLowerCase();

  const username = raw.toLowerCase();
  // Reject anything that is not a legal username before touching the database:
  // a filter value is user input, and the query builder escapes it, but there
  // is no reason to run a lookup that cannot match.
  if (!USERNAME_RE.test(username)) return '';

  const profile = await db.selectOne('profiles', {
    select: 'id',
    username: `eq.${username}`
  });
  if (!profile?.id) return '';

  const user = await authAdmin.getUser(profile.id);
  return String(user?.email || '').toLowerCase();
}

/**
 * Exchange an email and password for a session, through Supabase.
 *
 * @returns {Promise<{ ok: true, session: object } | { ok: false }>}
 */
async function passwordGrant(email, password) {
  const { url, anonKey } = config();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) return { ok: false };
  return { ok: true, session: body };
}

/**
 * Sign in with a username (or email) and a password.
 *
 * @returns {Promise<{ status: number, body: object }>} ready to serialize
 */
export async function passwordLogin(req, { identifier, password }) {
  const id = String(identifier || '').trim();
  const pass = String(password || '');
  if (!id || !pass) {
    return { status: 400, body: { error: 'Enter your username and password.' } };
  }

  const { url, anonKey } = config();
  if (!url || !anonKey) {
    return { status: 503, body: { error: 'Accounts are not configured on this deployment.' } };
  }

  const ipKey = `ip:${clientIp(req)}`;
  const idKey = `id:${id.toLowerCase()}`;
  if (tooMany(ipKey) || tooMany(idKey)) {
    return {
      status: 429,
      body: { error: 'Too many sign-in attempts. Wait a few minutes and try again.' }
    };
  }

  let email = '';
  try {
    email = await emailForIdentifier(id);
  } catch (err) {
    console.warn('[login] identifier lookup failed:', err?.message || err);
    return { status: 503, body: { error: 'Sign-in is unavailable right now.' } };
  }

  // No such username. Still counted and still the generic message: the timing
  // difference is not worth leaking which names are real.
  if (!email) {
    recordAttempt(ipKey);
    recordAttempt(idKey);
    return { status: 401, body: { error: GENERIC_FAILURE } };
  }

  let grant;
  try {
    grant = await passwordGrant(email, pass);
  } catch (err) {
    console.warn('[login] password grant failed:', err?.message || err);
    return { status: 503, body: { error: 'Sign-in is unavailable right now.' } };
  }

  if (!grant.ok) {
    recordAttempt(ipKey);
    recordAttempt(idKey);
    return { status: 401, body: { error: GENERIC_FAILURE } };
  }

  clearAttempts([ipKey, idKey]);
  const s = grant.session;
  // Only what setSession() needs. The rest of the Supabase response — the user
  // object, the email, app metadata — is not the browser's business here: it
  // reads all of that back through the session it is about to install.
  return {
    status: 200,
    body: {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_in: s.expires_in ?? null,
      token_type: s.token_type || 'bearer'
    }
  };
}
