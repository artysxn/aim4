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
//
// Two optional extras, so a test account is one command rather than three:
//
//   --plan <id>   open-ended admin subscription on that plan (no period end,
//                 so the nightly sweep leaves it alone). Same call the admin
//                 panel makes, so it is audited and recomputed like any other.
//   --anchor      set profiles.upload_anchored, which lets the account upload
//                 demos with no Google or Steam link (see migration 0021).
//
// Both are privileges. Neither is the default, and --anchor in particular is
// the thing standing between a free username and the shared library, so it
// belongs on accounts you can name and not on a batch.
// ---------------------------------------------------------------------------

import '../server/env.js';
import { PLAN_IDS } from '../shared/entitlements/catalogue.js';
import { authAdmin, db, isConfigured } from '../server/entitlements/service.js';
import { createSubscription } from '../server/entitlements/subscriptions.js';

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

function flag(name) {
  return process.argv.includes(`--${name}`);
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

const plan = arg('plan').trim();
const anchor = flag('anchor');
// Checked before the account is made rather than after. A typo'd plan id would
// otherwise leave a real account behind on a run that reported failure.
if (plan && !PLAN_IDS.includes(plan)) {
  die(`Unknown plan "${plan}". One of: ${PLAN_IDS.join(', ')}`);
}

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

// Privileges after the account exists, each reported on its own line so a
// half-applied run is visible rather than implied by a missing message.
let planNote = '';
if (plan) {
  // periodEnd null is "never expires": the sweep skips it instead of expiring
  // it every night, which is what an open-ended internal account wants.
  await createSubscription({
    userId: user.id,
    planId: plan,
    term: 'month',
    periodEnd: null,
    source: 'admin',
    notes: `Created by scripts/create-account.mjs for ${username}.`
  }).catch((err) => die(`Account ${username} exists, but the plan failed: ${err.message}`));
  planNote = plan;
}

let anchorNote = '';
if (anchor) {
  await db
    .update('profiles', { id: `eq.${user.id}` }, { upload_anchored: true }, { returning: false })
    .catch((err) =>
      die(
        `Account ${username} exists, but the upload anchor failed: ${err.message}\n` +
          '  Has supabase/migrations/0021_upload_anchor.sql been applied?'
      )
    );
  anchorNote = 'yes';
}

console.log(`\n  Account created.`);
console.log(`    username  ${profile?.username || '(no profile row)'}`);
console.log(`    email     ${email}`);
console.log(`    user id   ${user.id}`);
if (planNote) console.log(`    plan      ${planNote} (admin, no expiry)`);
if (anchorNote) console.log(`    uploads   anchored without Google or Steam`);
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
