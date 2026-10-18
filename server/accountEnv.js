// ---------------------------------------------------------------------------
// server/accountEnv.js
// The settings for running aim4 on this machine with real accounts: local mode
// off, signing in through the site's own Supabase project, so the person at the
// keyboard is whoever they sign in as rather than the local owner.
//
// They live in `.env.account` at the repo root (KEY=VALUE lines, gitignored like
// every .env file). server/run-account.js and build/build-account.mjs both read
// it, so the server and the client it serves always agree on where accounts are.
// Values already in the environment win, so one can be overridden per run.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACCOUNT_ENV_FILE = path.join(ROOT, '.env.account');

/** The build of the client the signed-in server serves. */
export const ACCOUNT_DIST_DIR = 'dist-account';

/** Parse KEY=VALUE lines; blank lines and # comments are skipped, surrounding quotes dropped. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Load `.env.account` into process.env and switch local mode off.
 * Throws when the file or the Supabase settings are missing, because a
 * signed-in host without them would fall back to nobody being able to sign in.
 */
export function loadAccountEnv() {
  if (!fs.existsSync(ACCOUNT_ENV_FILE)) {
    throw new Error(`${ACCOUNT_ENV_FILE} is missing: it holds the Supabase settings real sign-in needs.`);
  }
  const vars = parseEnv(fs.readFileSync(ACCOUNT_ENV_FILE, 'utf8'));
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env.AIM4_LOCAL = '0';
  process.env.VITE_LOCAL_MODE = '0';
  process.env.AIM4_DIST_DIR ||= ACCOUNT_DIST_DIR;
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`.env.account is missing ${missing.join(', ')}.`);
}
