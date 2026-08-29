// ---------------------------------------------------------------------------
// server/account/steamAuth.js
// Signing IN through Steam, as opposed to linking Steam to an account you
// already have (steam.js).
//
// Same OpenID 2.0 assertion, verified the same way — the difference is what
// happens once Steam has vouched for the SteamID64:
//
//   · a profile already carries that steam_id  -> sign that account in
//   · nothing does                             -> create an account, then sign in
//
// Two things make this more than a variation on the link flow.
//
// A session, without a password. Steam is not a Supabase provider, so no OAuth
// callback mints a session here; and a returning user has no password this box
// knows. GoTrue's admin generate_link issues a single-use token hash for an
// account, /auth/v1/verify redeems it for a real session, and that is the whole
// of it. The service-role key never leaves this process and no token is emailed.
//
// Handing that session to the browser. Steam redirects a top-level navigation,
// so the session has to survive one hop back to the site. It is NOT put in the
// URL: a refresh token is long-lived, and URLs land in history, in proxy logs
// and in Referer headers. Instead the session is parked here under a one-time
// code, the code travels in the URL, and the site POSTs it straight back to be
// exchanged. A stolen code is worth one redemption inside two minutes; a stolen
// refresh token is worth the account.
//
// State is signed with a purpose of 'signin', in a shape link states cannot
// parse and which cannot parse a link state. A flow that could be swapped for
// the other one would let a link assertion mint a session, or a sign-in
// assertion write somebody else's profile.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

import { authAdmin, db } from '../entitlements/service.js';
import { invalidateUserIdentity } from '../replays/identity.js';
import { safeNext, siteOrigin, steamIdFromClaim, verifyAssertion } from './steam.js';

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

/** The login address for a Steam account. Internal, never receives mail. */
const EMAIL_DOMAIN = 'users.aim4.io';

/** How long a started sign-in stays valid. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** How long the browser has to redeem its code, and how many times. */
const CODE_TTL_MS = 2 * 60 * 1000;

function secret() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.AIM4_STEAM_STATE_SECRET || '';
}

function hmac(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function anon() {
  return {
    url: (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
  };
}

export function steamApiKey() {
  return String(process.env.STEAM_API_KEY || '').trim();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Signed, expiring "a sign-in started here, and it wanted to end at <next>".
 *
 * Three fields where a link state has two, and the leading literal is what
 * keeps the two kinds apart: readState() in steam.js reads field 0 as a user id
 * and field 1 as an expiry, so it rejects this, and readSigninState rejects a
 * link state for want of the prefix.
 */
export function makeSigninState(next = '/', now = Date.now()) {
  const nonce = crypto.randomBytes(9).toString('base64url');
  const body = `signin.${nonce}.${now + STATE_TTL_MS}.${safeNext(next)}`;
  return `${Buffer.from(body).toString('base64url')}.${hmac(body)}`;
}

/** @returns {{ ok: boolean, next: string }} */
export function readSigninState(state, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return { ok: false, next: '/' };
  let body;
  try {
    body = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return { ok: false, next: '/' };
  }
  const expected = hmac(body);
  const given = parts[1] || '';
  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))
  ) {
    return { ok: false, next: '/' };
  }
  // The path may itself contain dots, so it is everything after field 2.
  const [purpose, , expires, ...rest] = body.split('.');
  if (purpose !== 'signin') return { ok: false, next: '/' };
  if (!Number(expires) || Number(expires) < now) return { ok: false, next: '/' };
  return { ok: true, next: safeNext(rest.join('.')) };
}

/** Where to send the browser to begin a Steam sign-in. */
export function signinUrl(req, next = '/') {
  const origin = siteOrigin(req);
  if (!origin || !secret()) return '';
  const returnTo = `${origin}/api/auth/steam/callback?state=${encodeURIComponent(makeSigninState(next))}`;
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': origin,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT
  });
  return `${STEAM_OPENID}?${params}`;
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, { session: object, persona: string, expires: number }>}
 *
 * In memory, like the login throttles and the identity cache: this process is
 * the only one serving the API. A second instance would need this in Postgres
 * or Redis, and the symptom would be sign-ins failing on the hop back roughly
 * half the time.
 */
const codes = new Map();

/** Park a session under a fresh code. Exported as the pair to redeemCode. */
export function issueCode(payload) {
  const code = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const [key, entry] of codes) if (entry.expires <= now) codes.delete(key);
  codes.set(code, { ...payload, expires: now + CODE_TTL_MS });
  return code;
}

/** Redeem a code. Single use: a replay of the same code finds nothing. */
export function redeemCode(code, now = Date.now()) {
  const key = String(code || '');
  const entry = codes.get(key);
  if (!entry) return null;
  codes.delete(key);
  if (entry.expires <= now) return null;
  return entry;
}

/** Only for tests. */
export function resetCodes() {
  codes.clear();
}

// ---------------------------------------------------------------------------
// Steam profile
// ---------------------------------------------------------------------------

/**
 * The player's persona name and avatar, for prefilling the username picker.
 *
 * Best effort by design: this is the one part of the flow that needs the Web
 * API key, and a sign-in must not fail because Steam's API is busy or the key
 * is missing. Identity came from the OpenID assertion, which is already done.
 */
export async function fetchPlayerSummary(steamId, fetchImpl = fetch) {
  const key = steamApiKey();
  if (!key || !steamId) return null;
  try {
    const url =
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/' +
      `?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = await res.json();
    const player = body?.response?.players?.[0];
    if (!player) return null;
    return {
      persona: String(player.personaname || ''),
      avatar: String(player.avatarfull || player.avatar || ''),
      profileUrl: String(player.profileurl || '')
    };
  } catch {
    return null;
  }
}

/**
 * A Steam persona reduced to something the username rules accept, or '' when
 * nothing usable survives — plenty of personas are entirely non-Latin or
 * emoji. Only ever a SUGGESTION the picker prefills: the account is created
 * with no username at all, so handle_new_user() marks it unchosen and the
 * client blocks on the picker exactly as it does after a Google sign-in.
 */
export function usernameSuggestion(persona) {
  const cleaned = String(persona || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return cleaned.length >= 3 ? cleaned : '';
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Mint a session for an account, no password involved.
 *
 * @returns {Promise<object|null>} the GoTrue session, or null
 */
async function mintSession(email, fetchImpl = fetch) {
  const { url, key } = anon();
  if (!url || !key) return null;
  const tokenHash = await authAdmin.generateLink({ email, type: 'magiclink' });
  if (!tokenHash) return null;
  const res = await fetchImpl(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) return null;
  return body;
}

/**
 * The whole return leg: state, assertion, claim, account, session, code.
 *
 * @param {URLSearchParams} query the query string Steam redirected with
 * @returns {Promise<{ ok: boolean, code?: string, next: string, error?: string }>}
 */
export async function completeSignin(query, { fetchImpl = fetch, now = Date.now() } = {}) {
  const state = readSigninState(query.get('state'), now);
  if (!state.ok) return { ok: false, next: '/', error: 'expired' };
  const next = state.next;

  if (query.get('openid.mode') !== 'id_res') return { ok: false, next, error: 'cancelled' };

  const steamId = steamIdFromClaim(query.get('openid.claimed_id'));
  if (!steamId) return { ok: false, next, error: 'invalid' };

  let valid = false;
  try {
    valid = await verifyAssertion(query, fetchImpl);
  } catch {
    return { ok: false, next, error: 'unreachable' };
  }
  if (!valid) return { ok: false, next, error: 'invalid' };

  const summary = await fetchPlayerSummary(steamId, fetchImpl);

  let account;
  try {
    account = await resolveAccount(steamId, summary?.persona || '');
  } catch (err) {
    console.error('[steam-signin] account resolution failed:', err?.message || err);
    return { ok: false, next, error: 'unavailable' };
  }

  let session;
  try {
    session = await mintSession(account.email, fetchImpl);
  } catch (err) {
    console.error('[steam-signin] session mint failed:', err?.message || err);
    return { ok: false, next, error: 'unavailable' };
  }
  if (!session) return { ok: false, next, error: 'unavailable' };

  // The account id comes back ON the session rather than from a lookup by
  // email: GoTrue's admin user search has changed shape across versions, and
  // the session is authoritative about who it belongs to.
  const userId = String(session?.user?.id || '');
  if (userId) {
    try {
      // Idempotent, and the reason a Steam sign-in can upload straight away:
      // this column is what the upload gate reads for an anchored identity.
      await db.update('profiles', { id: `eq.${userId}` }, { steam_id: steamId });
      // This session is new, but the same account may be signed in elsewhere
      // with a whoami cached before the link existed.
      invalidateUserIdentity(userId);
    } catch (err) {
      if (/duplicate|unique|conflict|23505/i.test(String(err?.message || err))) {
        return { ok: false, next, error: 'in_use' };
      }
      // Every exit from here is a redirect back to the site, so nothing throws
      // past this point: an exception would surface as the API's own JSON 500,
      // on the API's own origin, which is not a page anyone can act on.
      console.error('[steam-signin] steam_id write failed:', err?.message || err);
      return { ok: false, next, error: 'unavailable' };
    }
  }

  const code = issueCode({ session, persona: usernameSuggestion(summary?.persona), steamId });
  return { ok: true, code, next, created: account.created };
}

/**
 * The login address for this SteamID64, creating the account the first time.
 *
 * The steam_id itself is stamped by the caller, once the session names the
 * account: doing it here would need the new user's id, and reading that back
 * by email is the part of the GoTrue admin API least stable across versions.
 *
 * @returns {Promise<{ email: string, created: boolean }>}
 */
async function resolveAccount(steamId, persona = '') {
  const existing = await db.selectOne('profiles', { select: 'id', steam_id: `eq.${steamId}` });
  if (existing?.id) {
    const user = await authAdmin.getUser(existing.id);
    const email = String(user?.email || '');
    if (email) return { email, created: false };
    // A profile whose auth user no longer exists cannot be signed in as, and
    // its steam_id would collide with the account about to be created.
    await db.update('profiles', { id: `eq.${existing.id}` }, { steam_id: null });
  }

  const email = `steam_${steamId}@${EMAIL_DOMAIN}`;
  // No username in the metadata, so handle_new_user() assigns a random @ tag
  // the account can keep and change -- the same first run every OAuth sign-in
  // gets. The Steam persona rides along as the display name.
  try {
    await authAdmin.createUser({
      email,
      password: crypto.randomBytes(32).toString('base64url'),
      fullName: persona,
      emailConfirm: true
    });
    return { email, created: true };
  } catch (err) {
    const detail = String(err?.details?.msg || err?.message || '');
    // The auth user is already there with no profile pointing at it: an
    // earlier attempt that died between creating and stamping. Sign in as it.
    if (/already|exists|registered|duplicate/i.test(detail)) return { email, created: false };
    throw err;
  }
}

/** Human copy for each failure, shown on the site after the redirect. */
export const SIGNIN_ERRORS = Object.freeze({
  expired: 'That Steam sign-in expired. Try again.',
  cancelled: 'Steam sign-in was cancelled.',
  invalid: 'Steam did not confirm that sign-in.',
  unreachable: 'Steam could not be reached. Try again in a minute.',
  unavailable: 'Sign-in is unavailable right now. Try again in a minute.',
  in_use: 'That Steam account is already linked to a different aim4 account.'
});
