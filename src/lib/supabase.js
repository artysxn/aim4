// ---------------------------------------------------------------------------
// lib/supabase.js — browser Supabase client (auth + Postgres via RLS)
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

/** True when Vite build has Supabase env vars configured. */
export function supabaseConfigured() {
  return Boolean(url && anonKey);
}

/** OAuth redirect target — must be whitelisted in Supabase → Auth → URL configuration. */
export function authRedirectUrl() {
  return window.location.origin;
}

let client = null;

export function getSupabase() {
  if (!supabaseConfigured()) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }
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
 * does was meant as an email, and a stricter test here would only reject an
 * unusual-but-real address before the server ever sees it.
 */
export function looksLikeEmail(identifier) {
  return String(identifier || '').includes('@');
}
