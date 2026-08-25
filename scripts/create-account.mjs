// ---------------------------------------------------------------------------
// scripts/create-account.mjs
// Create an account directly, with a username and a password.
//
// Sign-up on the site is Google-only, so this is how a password account gets
// made: a test account, or a seat for someone who cannot use Google. It talks
// to the GoTrue admin API with the service-role key, which means it must run
// where that key is — the server host or a machine with it in .env, never a
// browser.
//
// The account is created with its email pre-confirmed and its username in
// user_metadata, which handle_new_user() reads to stamp the profile row. So the
// account can sign in immediately and arrives with its name already chosen.
//
// Usage:
//   node scripts/create-account.mjs --username <name> --password <pass>
//   node scripts/create-account.mjs --username <name> --password <pass> \
//     --email someone@example.com
//
// The password may also come from AIM4_NEW_ACCOUNT_PASSWORD, which keeps it out
// of your shell history:
//   AIM4_NEW_ACCOUNT_PASSWORD='...' node scripts/create-account.mjs --username x
//
// With no --email, the account gets <username>@users.aim4.io. Nothing is ever
// sent to it: it is an internal login address, and the site asks for the
// username. A real address is worth passing when the person may need a
// password reset later, since that is where the mail would go.
// ---------------------------------------------------------------------------

import '../server/env.js';
import { authAdmin, db, isConfigured } from '../server/entitlements/service.js';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
/** Login addresses for username-only accounts. Never receives mail. */
const DEFAULT_EMAIL_DOMAIN = 'users.aim4.io';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const username = arg('username').trim().toLowerCase();
const password = arg('password') || process.env.AIM4_NEW_ACCOUNT_PASSWORD || '';
const email = (arg('email') || `${username}@${DEFAULT_EMAIL_DOMAIN}`).trim().toLowerCase();

if (!username) die('Pass --username <name>.');
if (!USERNAME_RE.test(username)) {
  die('Username must be 3 to 20 characters: letters, numbers or underscore.');
}
if (!password) {
  die('Pass --password <pass>, or set AIM4_NEW_ACCOUNT_PASSWORD.');
}
if (password.length < 6) die('Password must be at least 6 characters.');

if (!isConfigured()) {
  die(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env or the\n' +
      '  environment). Run this on the server host, or copy the values locally.'
  );
}

// Claimed usernames are a unique index, and the failure that would otherwise
// surface is a constraint violation from inside a database trigger during
// account creation — after the auth user exists.
const taken = await db.selectOne('profiles', {
  select: 'id,username',
  username: `eq.${username}`
});
if (taken) die(`Username "${username}" is already taken.`);

let user;
try {
  user = await authAdmin.createUser({ email, password, username });
} catch (err) {
  const detail = err?.details?.msg || err?.details?.message || err?.message || String(err);
  die(`Could not create the account: ${detail}`);
}

if (!user?.id) die('Supabase accepted the request but returned no user.');

// The profile row is written by the on_auth_user_created trigger, not here.
// Read it back rather than assume: if the trigger is missing on this project
// the account would otherwise look fine and have no name on the leaderboard.
const profile = await db.selectOne('profiles', {
  select: 'id,username,username_chosen',
  id: `eq.${user.id}`
});

console.log(`\n  Account created.`);
console.log(`    username  ${profile?.username || '(no profile row)'}`);
console.log(`    email     ${email}`);
console.log(`    user id   ${user.id}`);
if (!profile) {
  console.log(
    '\n  WARNING: no profiles row was created. Check that the\n' +
      '  on_auth_user_created trigger from supabase/migrations/0007 is installed.'
  );
} else if (profile.username !== username) {
  console.log(
    `\n  NOTE: the trigger widened the name to "${profile.username}" to avoid a collision.`
  );
}
console.log('\n  Sign in at aim4.io with that username and the password.\n');
