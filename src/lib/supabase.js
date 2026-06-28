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

/** Normalize email for auth lookups. */
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateUsername(username) {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) {
    return 'Username must be 3–20 characters (letters, numbers, underscore).';
  }
  return null;
}

export function validateEmail(email) {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) return 'Enter a valid email address.';
  return null;
}

export function validatePassword(password) {
  if (!password || password.length < 6) {
    return 'Password must be at least 6 characters.';
  }
  return null;
}
