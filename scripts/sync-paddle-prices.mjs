// ---------------------------------------------------------------------------
// scripts/sync-paddle-prices.mjs
// Reconciles the Paddle catalogue with shared/entitlements/catalogue.js, and
// writes the resulting price ids into plans.provider_price_ids.
//
// catalogue.js is canonical, as it is for capabilities. This script never
// changes a price in Paddle: it reads what Paddle holds, refuses to proceed if
// the amounts disagree with the catalogue, and copies the ids across. Changing
// a live price is a decision with customer-visible consequences and belongs in
// the Paddle dashboard, not in a sync run.
//
//   node scripts/sync-paddle-prices.mjs           report the mapping
//   node scripts/sync-paddle-prices.mjs --check   verify, exit 1 on any drift
//   node scripts/sync-paddle-prices.mjs --push    write into plans
//   node scripts/sync-paddle-prices.mjs --json    print the map as JSON
//
// Env: PADDLE_API_KEY, PADDLE_ENV (sandbox|live, default sandbox).
// --push additionally needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//
// Unlike sync-plan-capabilities.mjs this generates no migration. Price ids are
// per Paddle account: the sandbox ids and the live ids for the same plan are
// different strings, so a checked-in seed would be wrong in one of the two
// environments. The database is the only sensible home for them.
// ---------------------------------------------------------------------------

import { PLAN_IDS, TERM_IDS, euros, priceForTerm } from '../shared/entitlements/catalogue.js';

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  live: 'https://api.paddle.com'
};

const ENV = process.env.PADDLE_ENV === 'live' ? 'live' : 'sandbox';
const CURRENCY = 'EUR';
const PAID_PLANS = PLAN_IDS.filter((id) => id !== 'free');

function die(message) {
  console.error(message);
  process.exit(1);
}

/** Every page of a Paddle list endpoint, flattened. */
async function paddleList(path) {
  // Same fallback the server adapter uses, so a shell that can run the server
  // can run the sync without renaming anything.
  const key =
    process.env.PADDLE_API_KEY ||
    (ENV === 'live' ? process.env.PADDLE_LIVE_API_KEY : process.env.PADDLE_SANDBOX_API_KEY) ||
    '';
  if (!key) die(`PADDLE_API_KEY (or PADDLE_${ENV.toUpperCase()}_API_KEY) is required.`);

  const out = [];
  let after = null;
  do {
    const url = new URL(`${API_BASE[ENV]}${path}`);
    url.searchParams.set('per_page', '200');
    url.searchParams.set('status', 'active');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const text = await res.text();
    if (!res.ok) die(`Paddle ${res.status} on ${path}: ${text.slice(0, 400)}`);

    const body = JSON.parse(text);
    out.push(...(body.data || []));
    after = body.meta?.pagination?.has_more ? out[out.length - 1]?.id : null;
  } while (after);
  return out;
}

/**
 * Build plan -> term -> price id from the Paddle catalogue, checking each
 * price against what the catalogue says it should cost.
 *
 * Matching is on custom_data, not on name or amount. Names are display copy
 * and change; amounts are what we are trying to verify and so cannot also be
 * the key.
 */
function reconcile(prices) {
  const map = {};
  const problems = [];
  const seen = new Set();

  for (const price of prices) {
    const planId = price.custom_data?.plan_id;
    const term = price.custom_data?.term;
    if (!planId || !term) continue;
    if (!PAID_PLANS.includes(planId) || !TERM_IDS.includes(term)) {
      problems.push(`${price.id}: custom_data names an unknown plan/term (${planId}/${term})`);
      continue;
    }

    const key = `${planId}/${term}`;
    if (seen.has(key)) {
      problems.push(`${key}: more than one active Paddle price claims this plan and term`);
      continue;
    }
    seen.add(key);

    const expected = priceForTerm(planId, term).totalCents;
    const actual = Number(price.unit_price?.amount);
    if (actual !== expected) {
      problems.push(
        `${key}: Paddle has ${euros(actual)}, catalogue says ${euros(expected)} (${price.id})`
      );
    }
    const currency = price.unit_price?.currency_code;
    if (currency !== CURRENCY) {
      problems.push(`${key}: Paddle prices this in ${currency}, expected ${CURRENCY} (${price.id})`);
    }

    (map[planId] ||= {})[term] = price.id;
  }

  for (const planId of PAID_PLANS) {
    for (const term of TERM_IDS) {
      if (!map[planId]?.[term]) problems.push(`${planId}/${term}: no active Paddle price`);
    }
  }

  return { map, problems };
}

async function push(map) {
  // Same pair service.js reads. The checked-in .env carries the VITE_ name
  // because the browser bundle needs it too.
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    die('SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required for --push');
  }

  // PATCH per plan rather than a bulk upsert: the plans rows already exist and
  // carry capabilities that sync-plan-capabilities.mjs owns. An upsert here
  // would need to resend those, and two scripts writing the same column is how
  // they end up disagreeing.
  for (const planId of PAID_PLANS) {
    const res = await fetch(`${url}/rest/v1/plans?id=eq.${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ billing_provider: 'paddle', provider_price_ids: map[planId] })
    });
    if (!res.ok) die(`Push failed for ${planId}: ${res.status} ${await res.text()}`);
  }
  console.log(`Pushed price ids for ${PAID_PLANS.length} plans to ${url} (${ENV})`);
}

// ---------------------------------------------------------------------------

const prices = await paddleList('/prices');
const { map, problems } = reconcile(prices);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(map, null, 2));
} else {
  console.log(`Paddle catalogue (${ENV}):`);
  for (const planId of PAID_PLANS) {
    for (const term of TERM_IDS) {
      const id = map[planId]?.[term];
      const expected = euros(priceForTerm(planId, term).totalCents);
      console.log(`  ${planId.padEnd(13)} ${term.padEnd(9)} ${expected.padStart(10)}  ${id || 'MISSING'}`);
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nFix these in the Paddle dashboard. This script does not write to Paddle.');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log('\nPaddle prices match the catalogue.');
} else if (process.argv.includes('--push')) {
  await push(map);
}
