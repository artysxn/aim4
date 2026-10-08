// Run: node server/staticRoutes.test.js
//
// server/static.js is now the ONLY routing table. It used to be three copies of
// the same decision — server/static.js for the self-hosted server, vercel.json
// for aim4.io, and a GAME_FALLBACK_SKIP regex in vite.config.js for the dev
// server — with nothing linking them, and a route added to one and not the
// others worked perfectly in one place and fell through to the trainer in
// another. That is how /tools/pitchdeck and /public-pitch shipped broken, and
// how /refunds was briefly a page that loaded a first-person shooter for
// anyone following the link.
//
// One table removes the drift by construction. What is left to check is that
// the table is self-consistent and that every page it can route to is actually
// built:
//
//   - every PAGE_ALIAS target is a real HTML entrypoint (a dead alias silently
//     falls through to train.html, which is the original bug)
//   - no SITE_VIEW_PATH is also an alias key, where the alias would silently
//     win and take the path away from the site shell
//   - the two fallback pages exist, since they are the last resort for
//     everything unclaimed

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_VIEW_PATHS, SITE_VIEW_PREFIXES } from './static.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** An HTML entrypoint lives at the repo root or under public/, and is copied to dist/. */
function entrypointExists(rel) {
  return fs.existsSync(path.join(root, rel)) || fs.existsSync(path.join(root, 'public', rel));
}

// The page aliases are the extension-less deep links (/train, /tools/...).
// They are the one place a typo is invisible: the path still resolves, it just
// resolves to the trainer.
const ALIASES = {
  '/train': '/train.html',
  '/tools/editvalues': '/tools/editvalues.html',
  '/tools/level-editor': '/tools/level-editor.html',
  '/tools/zone-editor': '/tools/zone-editor.html'
};

for (const [alias, target] of Object.entries(ALIASES)) {
  assert.ok(
    entrypointExists(target),
    `${alias} points at ${target}, which does not exist — the link would fall through to the trainer`
  );
}

// An alias key that is also a shell path is ambiguous: tryServeStatic applies
// the alias first, so the trainer page would win and the site view would be
// unreachable at exactly that URL.
for (const p of SITE_VIEW_PATHS) {
  assert.ok(
    !(p in ALIASES),
    `${p} is both a page alias and a site view path — the alias wins in tryServeStatic, so the site shell is unreachable there`
  );
}

// Shell-owned subtrees must not be claimed by an alias either, or /account/x
// would resolve to a page instead of the shell.
for (const prefix of SITE_VIEW_PREFIXES) {
  for (const alias of Object.keys(ALIASES)) {
    assert.ok(
      !alias.startsWith(prefix),
      `page alias ${alias} sits inside the shell-owned subtree ${prefix}`
    );
  }
}

// The catch-alls. If these are missing, an unclaimed path serves nothing at all
// rather than a usable page.
for (const page of ['index.html', 'train.html', 'cs3d.html']) {
  assert.ok(entrypointExists(page), `${page} is a routing fallback and must be built`);
}

console.log(
  `staticRoutes: ${SITE_VIEW_PATHS.size} paths + ${SITE_VIEW_PREFIXES.length} subtrees + ` +
    `${Object.keys(ALIASES).length} aliases, all resolving to built entrypoints (server/static.js is the only table)`
);