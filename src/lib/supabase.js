// ---------------------------------------------------------------------------
// lib/supabase.js — the browser's data client.
//
// Two implementations behind one door:
//
//   credentials present  the hosted Supabase client, unchanged
//   no credentials       the local client, which is this machine
//
// The local one is not a stub. It is a real implementation of the same surface
// (see localClient.js) so the app has no "unconfigured" branch to fall into: one
// account, no sign-in, and the leaderboards and account page work against
// localStorage instead of a database. That is the whole difference between
// running this checkout and deploying it.
//
// AIM4_LOCAL=0 in the build environment forces the unconfigured path, which is
// how you get the "no account" behaviour back without a rebuild of the source.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import { createLocalClient } from './localClient.js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const localAllowed = String(import.meta.env.VITE_LOCAL_MODE ?? '').toLowerCase() !== '0';

let client = null;

/** True when there is something to sign in to. Locally: always. */
export function supabaseConfigured() {
  return Boolean(url && anonKey) || localAllowed;
}

/** OAuth redirect target — must be whitelisted in Supabase → Auth → URL configuration. */
export function authRedirectUrl() {
  return window.location.origin;
}

/** True when this build is the single-account local one. */
export function isLocalClient() {
  return supabaseConfigured() && !(url && anonKey);
}

export function getSupabase() {
  if (!supabaseConfigured()) return null;
  if (client) return client;
  client = url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      })
    : createLocalClient();
  return client;
}

// Registration is Google-only, so validateEmail and the sign-up field checks
// that went with it are still gone. What came back is the pair sign-IN needs:
// accounts made before the switch, and accounts seeded by an admin, both hold a
// password, and the form has to tell a username apart from an email.

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function validateUsername(username) {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) {
    return 'Username must be 3-20 characters (letters, numbers, underscore).';
  }
  return null;
}

/** Normalize email for auth lookups. */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Is this sign-in identifier an email rather than a username?
 *
 * Deliberately just "has an @": usernames cannot contain one, so anything that
 * did was meant to be an email, and a stricter test here would only reject an
 * unusual-but-real address before the server ever sees it.
 */
export function looksLikeEmail(identifier) {
  return String(identifier || '').includes('@');
}
