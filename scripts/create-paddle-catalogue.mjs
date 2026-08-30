// ---------------------------------------------------------------------------
// scripts/create-paddle-catalogue.mjs
// Creates the plan catalogue in a Paddle account from catalogue.js.
//
// The sibling, sync-paddle-prices.mjs, deliberately never writes to Paddle.
// This script is the one that does, and only ever CREATES: an existing product
// or price is matched by its custom_data (plan_id, term) and left untouched,
// so re-running is free and the script cannot change what a customer pays.
// A price whose amount disagrees with the catalogue is reported and skipped;
// changing a live price is a dashboard decision, not a sync side effect.
//
//   node scripts/create-paddle-catalogue.mjs             create in sandbox
//   PADDLE_ENV=live node scripts/create-paddle-catalogue.mjs   create in live
//   node scripts/create-paddle-catalogue.mjs --dry-run   report, write nothing
//
// Env: PADDLE_API_KEY, or PADDLE_SANDBOX_API_KEY / PADDLE_LIVE_API_KEY to
// match PADDLE_ENV. Defaults to sandbox: an accidental sandbox write is
// clutter, an accidental live write is not, so live must be asked for.
//
// After creating on a new account, run:
//   PADDLE_ENV=<env> node scripts/sync-paddle-prices.mjs --push
// to write the new price ids into plans.provider_price_ids.
// ---------------------------------------------------------------------------

import {
  PLAN_BANDS,
  PLAN_IDS,
  PLAN_NAMES,
  PLAN_RANKS,
  TERM_IDS,
  TERM_NAMES,
  euros,
  isTeamPlan,
  priceForTerm
} from '../shared/entitlements/catalogue.js';

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  live: 'https://api.paddle.com'
};

const ENV = process.env.PADDLE_ENV === 'live' ? 'live' : 'sandbox';
const DRY = process.argv.includes('--dry-run');
const PAID_PLANS = PLAN_IDS.filter((id) => id !== 'free');

/** Billing cycles per term. The year term is a real yearly cycle, not 12 months. */
const CYCLE = {
  month: { interval: 'month', frequency: 1 },
  quarter: { interval: 'month', frequency: 3 },
  halfyear: { interval: 'month', frequency: 6 },
  year: { interval: 'year', frequency: 1 }
};

function die(message) {
  console.error(message);
  process.exit(1);
}

const KEY =
  process.env.PADDLE_API_KEY ||
  (ENV === 'live' ? process.env.PADDLE_LIVE_API_KEY : process.env.PADDLE_SANDBOX_API_KEY) ||
  '';
if (!KEY) die(`PADDLE_API_KEY (or PADDLE_${ENV.toUpperCase()}_API_KEY) is required.`);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE[ENV]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = parsed?.error;
    die(`Paddle ${res.status} on ${method} ${path}: ${err?.detail || err?.code || text.slice(0, 300)}`);
  }
  return parsed?.data ?? null;
}

/** Every page of a list endpoint, active entities only. */
async function listAll(path) {
  const out = [];
  let after = null;
  do {
    const q = new URLSearchParams({ per_page: '200', status: 'active' });
    if (after) q.set('after', after);
    const res = await fetch(`${API_BASE[ENV]}${path}?${q}`, {
      headers: { Authorization: `Bearer ${KEY}` }
    });
    const body = JSON.parse(await res.text());
    if (!res.ok) die(`Paddle ${res.status} listing ${path}`);
    out.push(...(body.data || []));
    after = body.meta?.pagination?.has_more ? out[out.length - 1]?.id : null;
  } while (after);
  return out;
}

// ---------------------------------------------------------------------------

console.log(`Target: ${ENV}${DRY ? ' (dry run, nothing will be written)' : ''}`);

const existingProducts = await listAll('/products');
const existingPrices = await listAll('/prices');

const productByPlan = new Map(
  existingProducts.filter((p) => p.custom_data?.plan_id).map((p) => [p.custom_data.plan_id, p])
);
const priceByKey = new Map(
  existingPrices
    .filter((p) => p.custom_data?.plan_id && p.custom_data?.term)
    .map((p) => [`${p.custom_data.plan_id}/${p.custom_data.term}`, p])
);

let createdProducts = 0;
let createdPrices = 0;
const problems = [];

for (const planId of PAID_PLANS) {
  let product = productByPlan.get(planId);
  if (product) {
    console.log(`  ${planId.padEnd(13)} product exists  ${product.id}`);
  } else if (DRY) {
    console.log(`  ${planId.padEnd(13)} product WOULD BE CREATED`);
  } else {
    product = await api('/products', {
      method: 'POST',
      body: {
        name: `AIM4 ${PLAN_NAMES[planId]}`,
        type: 'standard',
        tax_category: 'saas',
        custom_data: {
          plan_id: planId,
          rank: PLAN_RANKS[planId],
          band: PLAN_BANDS[planId],
          ladder: isTeamPlan(planId) ? 'team' : 'solo'
        }
      }
    });
    createdProducts++;
    console.log(`  ${planId.padEnd(13)} product created ${product.id}`);
  }

  for (const term of TERM_IDS) {
    const key = `${planId}/${term}`;
    const cents = priceForTerm(planId, term).totalCents;
    const existing = priceByKey.get(key);

    if (existing) {
      const actual = Number(existing.unit_price?.amount);
      if (actual !== cents) {
        problems.push(
          `${key}: Paddle has ${euros(actual)}, catalogue says ${euros(cents)} (${existing.id}). ` +
            `Not touched; fix in the dashboard.`
        );
      }
      continue;
    }

    if (DRY) {
      console.log(`    ${key.padEnd(22)} price WOULD BE CREATED at ${euros(cents)}`);
      continue;
    }
    if (!product?.id) {
      problems.push(`${key}: no product to attach to (dry-run product?)`);
      continue;
    }

    const body = {
      product_id: product.id,
      name: TERM_NAMES[term],
      description: `${planId} / ${term} / EUR ${(cents / 100).toFixed(2)} per ${term === 'month' ? 'month' : term}`,
      type: 'standard',
      billing_cycle: CYCLE[term],
      unit_price: { amount: String(cents), currency_code: 'EUR' },
      custom_data: { plan_id: planId, term, ladder: isTeamPlan(planId) ? 'team' : 'solo' }
    };
    // A solo seat is one seat. Team seat counts are not modelled yet, so team
    // prices keep Paddle's 1-100 default. Mirrors the sandbox catalogue.
    if (!isTeamPlan(planId)) body.quantity = { minimum: 1, maximum: 1 };

    const price = await api('/prices', { method: 'POST', body });
    createdPrices++;
    console.log(`    ${key.padEnd(22)} price created ${price.id} at ${euros(cents)}`);
  }
}

console.log(
  `\n${ENV}: ${createdProducts} products and ${createdPrices} prices created, ` +
    `${productByPlan.size} products and ${priceByKey.size} prices already existed.`
);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (!DRY && (createdProducts || createdPrices)) {
  console.log(`\nNext: PADDLE_ENV=${ENV} node scripts/sync-paddle-prices.mjs --push`);
}
