// Run: node server/staticRoutes.test.js
//
// The two routing tables have to agree. server/static.js decides what the
// self-hosted server serves from the site shell; vercel.json decides the same
// thing for aim4.io, and nothing links them. A route added to one and not the
// other works perfectly on localhost and 404s in production — which is exactly
// how /tools/pitchdeck and /public-pitch shipped broken.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_VIEW_PATHS, SITE_VIEW_PREFIXES } from './static.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const rewrites = vercel.rewrites || [];

assert.ok(rewrites.length, 'vercel.json has rewrites');

/** Vercel matches a source against the whole path. */
const matches = (source, p) => {
  if (source === p) return true;
  try {
    return new RegExp(`^${source}$`).test(p);
  } catch {
    return false;
  }
};

/** The first rewrite that claims this path, in file order, as Vercel resolves it. */
const routeFor = (p) => rewrites.find((r) => matches(r.source, p)) || null;

// Every shell path reaches the SPA shell in production, not the trainer and not
// a 404. The catch-all sends everything unclaimed to train.html, so "matched by
// something" is not enough: the destination has to be index.html.
for (const p of SITE_VIEW_PATHS) {
  const hit = routeFor(p);
  assert.ok(hit, `vercel.json has no rewrite for ${p} — it will 404 on aim4.io`);
  assert.equal(
    hit.destination,
    '/index.html',
    `${p} resolves to ${hit.destination} on aim4.io, not the site shell`
  );
}

// The same for the shell-owned subtrees, checked with a representative child.
for (const prefix of SITE_VIEW_PREFIXES) {
  const p = `${prefix}example`;
  const hit = routeFor(p);
  assert.ok(hit, `vercel.json has no rewrite for ${prefix}* — ${p} will 404 on aim4.io`);
  assert.equal(hit.destination, '/index.html', `${p} does not reach the site shell on aim4.io`);
}

// The catch-all has to stay last, or it swallows the routes above it.
const catchAllIndex = rewrites.findIndex((r) => r.destination === '/train.html');
assert.equal(catchAllIndex, rewrites.length - 1, 'the trainer catch-all must be the last rewrite');

console.log(`staticRoutes: ${SITE_VIEW_PATHS.size} paths + ${SITE_VIEW_PREFIXES.length} subtrees routed in production`);
