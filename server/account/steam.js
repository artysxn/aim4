// ---------------------------------------------------------------------------
// server/account/steam.js
// Linking a Steam identity to an aim4 account, via Steam's OpenID 2.0 login.
//
// Steam is not an OAuth provider Supabase knows, so the link is done here and
// stored on the profile (0010_steam_identity.sql). The flow is the standard
// OpenID checkid_setup dance:
//
//   1. /api/account/steam/start  — signed state carrying the user id, then a
//      302 to steamcommunity.com/openid/login.
//   2. Steam sends the browser back to /api/account/steam/return with an
//      assertion naming the SteamID64.
//   3. The assertion is replayed to Steam with mode=check_authentication —
//      Steam answers is_valid:true only for an assertion it really signed and
//      has not seen verified before. Nothing from the query string is trusted
//      until that answer.
//   4. profiles.steam_id is written through the service role, and the browser
//      lands back on /account.
//
// No API key involved: verification is part of OpenID itself. The state token
// is HMAC-signed with the service-role key because that key already exists on
// exactly the machines allowed to write the column; a second secret would be
// one more thing to rotate for no isolation gained.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

import { db } from '../entitlements/service.js';

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

/** How long a started link flow stays valid. Steam's page is quick. */
const STATE_TTL_MS = 10 * 60 * 1000;

function secret() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.AIM4_STEAM_STATE_SECRET || '';
}

function hmac(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * The public origin of THIS deployment, for return_to and realm.
 *
 * From the forwarded proto/host because the server sits behind Coolify's
 * proxy. A forged Host header only misdirects the forger's own link flow:
 * the state token still names the signed-in user, and the assertion is
 * verified with Steam either way.
 */
export function siteOrigin(req) {
  const configured = String(process.env.AIM4_PUBLIC_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

/**
 * Where the SITE lives, as opposed to this API.
 *
 * They are different hosts in production (www.aim4.io and api.aim4.io), and
 * Steam necessarily returns the browser to the API, because the API is what
 * verifies the assertion. So the last hop has to be an absolute URL back to the
 * site: a relative `/account` redirect lands on api.aim4.io/account, which
 * serves the API's 404 and leaves the user staring at {"error":"Not found"}
 * with no idea whether the link worked.
 */
export function siteUrl(req) {
  const configured = String(process.env.AIM4_SITE_URL || '').replace(/\/+$/, '');
  return configured || siteOrigin(req);
}

/**
 * A path on the site to come back to, from untrusted input.
 *
 * Only a rooted, single-slash path: `//evil.com` and `https://evil.com` are
 * both absolute in a browser, so accepting them would make this an open
 * redirect hanging off a login flow.
 */
export function safeNext(next, fallback = '/') {
  const raw = String(next || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  return raw;
}

/** Signed, expiring proof of "this link flow belongs to user X". */
export function makeState(userId, now = Date.now()) {
  const body = `${userId}.${now + STATE_TTL_MS}`;
  return `${Buffer.from(body).toString('base64url')}.${hmac(body)}`;
}

/** @returns {string} the user id, or '' when invalid or expired */
export function readState(state, now = Date.now()) {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return '';
  let body;
  try {
    body = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return '';
  }
  const expected = hmac(body);
  const given = parts[1] || '';
  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))
  ) {
    return '';
  }
  const [userId, expires] = body.split('.');
  if (!userId || !Number(expires) || Number(expires) < now) return '';
  return userId;
}

/** Where to send the browser to begin the Steam login. */
export function startUrl(req, userId) {
  const origin = siteOrigin(req);
  if (!origin || !secret()) return '';
  const returnTo = `${origin}/api/account/steam/return?state=${encodeURIComponent(makeState(userId))}`;
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

/** SteamID64 out of the claimed id, or '' for anything unexpected. */
export function steamIdFromClaim(claimedId) {
  const m = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{10,20})$/.exec(
    String(claimedId || '')
  );
  return m ? m[1] : '';
}

/**
 * Replay the assertion to Steam. True only when Steam vouches for it.
 * Split out so tests can exercise the flow without steamcommunity.com.
 */
export async function verifyAssertion(query, fetchImpl = fetch) {
  const params = new URLSearchParams();
  for (const [key, value] of query.entries()) {
    if (key.startsWith('openid.')) params.set(key, value);
  }
  params.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(STEAM_OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const text = await res.text();
  return /is_valid\s*:\s*true/.test(text);
}

/**
 * The whole return leg: state, assertion, claim, write.
 *
 * @param {URLSearchParams} query  the query string Steam redirected with
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function completeLink(query, { fetchImpl = fetch, now = Date.now() } = {}) {
  const userId = readState(query.get('state'), now);
  if (!userId) return { ok: false, error: 'expired' };

  if (query.get('openid.mode') !== 'id_res') return { ok: false, error: 'cancelled' };

  const steamId = steamIdFromClaim(query.get('openid.claimed_id'));
  if (!steamId) return { ok: false, error: 'invalid' };

  let valid = false;
  try {
    valid = await verifyAssertion(query, fetchImpl);
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!valid) return { ok: false, error: 'invalid' };

  try {
    await db.update('profiles', { id: `eq.${userId}` }, { steam_id: steamId });
  } catch (err) {
    // The partial unique index: this Steam account already anchors another
    // aim4 account. One identity vouches for one account, that is the point.
    if (/duplicate|unique|conflict|23505/i.test(String(err?.message || err))) {
      return { ok: false, error: 'in_use' };
    }
    throw err;
  }
  return { ok: true };
}

/** Human copy for each failure, shown on /account after the redirect. */
export const LINK_ERRORS = Object.freeze({
  expired: 'The Steam link expired. Start it again from your account page.',
  cancelled: 'Steam sign-in was cancelled.',
  invalid: 'Steam did not confirm that sign-in.',
  unreachable: 'Steam could not be reached. Try again in a minute.',
  in_use: 'That Steam account is already linked to a different aim4 account.'
});
