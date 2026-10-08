// ---------------------------------------------------------------------------
// server/local/mode.js
// The single-account local deployment.
//
// This machine is the deployment. There is no Vercel, no Supabase, no bucket and
// no second user, so the questions the hosted code spends its effort answering
// have one answer each:
//
//   who is calling      always the owner, whatever token arrived (or not)
//   what may they do     everything, on the top plan
//   which database       a JSON file next to this module's data directory
//
// It is ON by default, because a checkout with no credentials still has to run.
// `AIM4_LOCAL=0` restores the hosted behaviour exactly, so the split deploy is
// still one flag away and nothing here is load-bearing for it.
//
// The client is told about it in one place, src/lib/localClient.js, which stands
// in for the Supabase client rather than pretending to be unreachable. That is
// why signing in is not a thing locally: there is nothing to sign in to.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEntitlements } from '../../shared/entitlements/resolve.js';
import { unlimitedCapabilities } from '../../shared/entitlements/catalogue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.AIM4_LOCAL_DIR || path.join(HERE, '..', 'data', 'local'));

/** The top plan. Only the displayed name comes from it; capabilities are all. */
const TOP_PLAN = 'team_tier1';

export function localMode() {
  const flag = String(process.env.AIM4_LOCAL ?? '').toLowerCase();
  return flag !== '0' && flag !== 'off' && flag !== 'false';
}

/** The one account. Its id is stable, because it keys every local file. */
export const OWNER_ID = String(process.env.AIM4_LOCAL_USER_ID || 'local:owner');
export const OWNER_NAME = String(process.env.AIM4_LOCAL_USERNAME || 'owner');

/**
 * The identity every request resolves to. Shaped like the object whoami() builds
 * from a verified Supabase session, so nothing downstream has to know.
 */
export const OWNER = Object.freeze({
  id: OWNER_ID,
  username: OWNER_NAME,
  email: '',
  provider: 'local',
  providers: Object.freeze([]),
  steamId: '',
  // The upload gate wants one real identity behind the account. Locally the
  // person at the keyboard is the proof.
  uploadAnchored: true,
  createdAt: '',
  signedIn: true,
  admin: true,
  impersonating: null
});

/** Everything unlocked, named as the top plan rather than as an admin badge. */
export function ownerEntitlements() {
  const resolved = resolveEntitlements({ isAdmin: true });
  return {
    ...resolved,
    tier: TOP_PLAN,
    source: 'local',
    capabilities: unlimitedCapabilities()
  };
}

// --- the local profile -------------------------------------------------------

const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');

const DEFAULT_PROFILE = Object.freeze({
  username: OWNER_NAME,
  display_name: '',
  language: 'en',
  elo: 1200,
  country_code: ''
});

/** Read the owner's profile row. Missing file, missing keys: defaults. */
export function readProfile() {
  try {
    return { ...DEFAULT_PROFILE, ...JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/** Patch and persist the owner's profile. Used by the account page's saves. */
export function writeProfile(patch) {
  const next = { ...readProfile(), ...patch, id: OWNER_ID };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROFILE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export { DATA_DIR as LOCAL_DATA_DIR };
