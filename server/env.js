// ---------------------------------------------------------------------------
// server/env.js
// Loads .env into process.env for the backend.
//
// Vite reads .env on its own for the browser bundle (the VITE_* half), which
// made it easy to miss that Node does not: `node server/index.js` started with
// no SUPABASE_URL, so token verification silently treated every caller as
// signed out. Import this before anything that reads process.env.
//
// Real environment variables always win, so a hosted deploy that sets them
// properly is unaffected by a stray .env file on disk.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Later files win over earlier ones, and both lose to the real environment. */
const FILES = ['.env', '.env.local'];

function parse(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes; leave inner ones alone.
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at the first ' #' comment.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnv() {
  const loaded = [];
  for (const file of FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parse(text))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}

loadEnv();
