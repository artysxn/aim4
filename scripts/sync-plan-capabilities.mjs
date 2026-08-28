// ---------------------------------------------------------------------------
// scripts/sync-plan-capabilities.mjs
// Generates supabase/migrations/0003_seed_plans.sql from the JS catalogue.
//
// shared/entitlements/catalogue.js is canonical. The `capabilities` jsonb in
// the plans table is a copy of it that the database keeps so RLS and SQL
// reporting can read tier values without a round trip through Node. Two copies
// of the same truth drift, so this is the only thing allowed to write the
// second one, and --check fails a build when they disagree.
//
//   node scripts/sync-plan-capabilities.mjs           regenerate the migration
//   node scripts/sync-plan-capabilities.mjs --check   verify, exit 1 on drift
//   node scripts/sync-plan-capabilities.mjs --push    upsert straight into the DB
//
// --push needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and is what a deploy
// runs; the generated migration is what a fresh project runs.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLAN_CAPACITY,
  PLAN_IDS,
  PLAN_NAMES,
  PLAN_RANKS,
  capabilitiesForPlan,
  priceForTerm
} from '../shared/entitlements/catalogue.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'supabase', 'migrations', '0003_seed_plans.sql');

/** Single-quote escaping for a SQL string literal. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function planRows() {
  return PLAN_IDS.map((id) => ({
    id,
    name: PLAN_NAMES[id],
    rank: PLAN_RANKS[id],
    seat_capacity: PLAN_CAPACITY[id].seat_capacity,
    team_capacity: PLAN_CAPACITY[id].team_capacity,
    // The total charged for one term, in cents, discounts already applied.
    // Copied here so SQL reporting and any provider-side price sync read the
    // same numbers the pricing page renders.
    price_month_cents: priceForTerm(id, 'month').totalCents,
    price_quarter_cents: priceForTerm(id, 'quarter').totalCents,
    price_halfyear_cents: priceForTerm(id, 'halfyear').totalCents,
    price_year_cents: priceForTerm(id, 'year').totalCents,
    capabilities: capabilitiesForPlan(id)
  }));
}

function render() {
  const rows = planRows()
    .map((row) => {
      const caps = JSON.stringify(row.capabilities, null, 2)
        .split('\n')
        .map((line, i) => (i === 0 ? line : `    ${line}`))
        .join('\n');
      return [
        `  (${sqlString(row.id)}, ${sqlString(row.name)}, ${row.rank},`,
        `   ${row.seat_capacity}, ${row.team_capacity},`,
        `   ${row.price_month_cents}, ${row.price_quarter_cents},`,
        `   ${row.price_halfyear_cents}, ${row.price_year_cents},`,
        `   ${sqlString(caps)}::jsonb)`
      ].join('\n');
    })
    .join(',\n');

  return `-- ===========================================================================
-- 0003_seed_plans.sql
--
-- GENERATED FILE. Do not edit by hand.
-- Source: shared/entitlements/catalogue.js
-- Regenerate: node scripts/sync-plan-capabilities.mjs
--
-- Prices are the TOTAL charged for one term, in cents, with both the term
-- discount and the per-plan long-term bonus already applied. Enforcement never
-- reads them; they are here so SQL reporting and a future provider price sync
-- share one source with the pricing page.
-- ===========================================================================

-- The six-month term postdates 0002, and this file runs before the migration
-- that adds it on a fresh project. Idempotent, so re-running is free.
alter table public.plans add column if not exists price_halfyear_cents int;

insert into public.plans (
  id, name, rank, seat_capacity, team_capacity,
  price_month_cents, price_quarter_cents, price_halfyear_cents, price_year_cents,
  capabilities
)
values
${rows}
on conflict (id) do update set
  name                 = excluded.name,
  rank                 = excluded.rank,
  seat_capacity        = excluded.seat_capacity,
  team_capacity        = excluded.team_capacity,
  price_month_cents    = excluded.price_month_cents,
  price_quarter_cents  = excluded.price_quarter_cents,
  price_halfyear_cents = excluded.price_halfyear_cents,
  price_year_cents     = excluded.price_year_cents,
  capabilities         = excluded.capabilities;
`;
}

async function push() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --push');
    process.exit(1);
  }
  const res = await fetch(`${url}/rest/v1/plans?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(planRows())
  });
  if (!res.ok) {
    console.error(`Push failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Pushed ${PLAN_IDS.length} plans to ${url}`);
}

const sql = render();

if (process.argv.includes('--push')) {
  await push();
} else if (process.argv.includes('--check')) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (current !== sql) {
    console.error('0003_seed_plans.sql is out of date with catalogue.js.');
    console.error('Run: node scripts/sync-plan-capabilities.mjs');
    process.exit(1);
  }
  console.log('plan capabilities are in sync');
} else {
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, sql);
  console.log(`Wrote ${path.relative(ROOT, TARGET)}`);
}
