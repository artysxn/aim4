// ---------------------------------------------------------------------------
// server/account/register.js
// Self-serve account creation with a username and a password.
//
// The exact recipe scripts/create-account.mjs has always used, behind a public
// endpoint: the account's login email is <username>@users.aim4.io, an internal
// address that never receives mail, and handle_new_user() stamps the profile
// from user_metadata.username so the account arrives with its name chosen.
//
// What a username account CANNOT do is upload demos, until it links Google or
// Steam. Registration is deliberately cheap — no email round-trip, no captcha
// — and cheap registration plus upload rights would be an invitation to fill
// the shared library anonymously. The link requirement puts one real identity
// behind every byte written, without making watching or practising ask for
// anything at all.
//
// Rate limited per IP, more tightly than sign-in: people mistype a password
// ten times, nobody creates five accounts in an hour by accident.
// ---------------------------------------------------------------------------

import { authAdmin, db, isConfigured } from '../entitlements/service.js';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
/** Login addresses for username accounts. Never receives mail. */
const EMAIL_DOMAIN = 'users.aim4.io';

const MAX_PER_WINDOW = 5;
const WINDOW_MS = 60 * 60 * 1000;

/** @type {Map<string, number[]>} ip -> registration timestamps */
const recent = new Map();

function throttled(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.set(ip, list);
  if (recent.size > 5000) {
    for (const [k, v] of recent) {
      if (!v.some((t) => now - t < WINDOW_MS)) recent.delete(k);
    }
  }
  return list.length >= MAX_PER_WINDOW;
}

function record(ip) {
  const list = recent.get(ip) || [];
  list.push(Date.now());
  recent.set(ip, list);
}

/** Only for tests. */
export function resetRegisterThrottle() {
  recent.clear();
}

function clientIp(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.socket?.remoteAddress || '';
}

/** The one username rule, shared with the client copy of the form. */
export function validateRegistration({ username, password }) {
  const name = String(username || '').trim().toLowerCase();
  const pass = String(password || '');
  if (!USERNAME_RE.test(name)) {
    return { error: 'Username must be 3 to 20 characters: letters, numbers or underscore.' };
  }
  if (pass.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }
  // A password that IS the username is the first thing anyone tries.
  if (pass.toLowerCase() === name) {
    return { error: 'Password cannot be the username.' };
  }
  return { username: name, password: pass };
}

/**
 * Create the account and sign it in, one call.
 *
 * Returns the same token shape as passwordLogin so the client installs the
 * session with the code it already has. Registration that ends signed OUT
 * would send every new account straight back to a login form.
 *
 * @returns {Promise<{ status: number, body: object }>} ready to serialize
 */
export async function registerAccount(req, { username, password }) {
  const checked = validateRegistration({ username, password });
  if (checked.error) return { status: 400, body: { error: checked.error } };

  if (!isConfigured()) {
    return { status: 503, body: { error: 'Accounts are not configured on this deployment.' } };
  }

  const ip = clientIp(req);
  if (throttled(`ip:${ip}`)) {
    return {
      status: 429,
      body: { error: 'Too many new accounts from this address. Try again later.' }
    };
  }

  // Checked before creating, so the common case fails with a clear message.
  // The unique index on profiles.username is what actually enforces it; a
  // race between two registrations lands in the createUser error below.
  const taken = await db
    .selectOne('profiles', { select: 'id', username: `eq.${checked.username}` })
    .catch(() => null);
  if (taken) {
    return { status: 409, body: { error: 'That username is taken.' } };
  }

  const email = `${checked.username}@${EMAIL_DOMAIN}`;
  let user;
  try {
    user = await authAdmin.createUser({
      email,
      password: checked.password,
      username: checked.username
    });
  } catch (err) {
    record(`ip:${ip}`);
    const detail = String(err?.details?.msg || err?.message || '');
    // The auth user for this internal address already exists: same outcome as
    // a taken username, whoever got there first.
    if (/already|exists|registered|duplicate/i.test(detail)) {
      return { status: 409, body: { error: 'That username is taken.' } };
    }
    console.error('[register] createUser failed:', detail);
    return { status: 503, body: { error: 'Could not create the account right now.' } };
  }
  record(`ip:${ip}`);

  // Sign the fresh account in through the same anon-key password grant that
  // login uses: a real credential check, not a token minted by service role.
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  let session = null;
  if (url && anonKey) {
    try {
      const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: checked.password })
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.access_token) session = body;
    } catch {
      /* fall through: the account exists, sign-in can happen manually */
    }
  }

  return {
    status: 201,
    body: {
      username: checked.username,
      userId: user?.id || null,
      ...(session
        ? {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in ?? null,
            token_type: session.token_type || 'bearer'
          }
        : {}),
      // The client shows this once, right after the modal closes. Saying it at
      // creation beats a 403 discovered mid-upload a week later.
      note: 'Link Google or Steam in Account before uploading demos.'
    }
  };
}
