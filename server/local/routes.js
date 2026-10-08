// ---------------------------------------------------------------------------
// server/local/routes.js
// GET/POST /api/local/profile
//
// The one piece of state both halves need to agree on: the owner's profile. The
// browser keeps it in localStorage (src/lib/localClient.js) because that is where
// every other table lives, and /api/me reads it from here because the server
// cannot see localStorage. The browser mirrors every write, so this file is a
// mirror rather than a second source: the JSON on disk is what survives a rebuild
// wiping the browser, which is the only reason it exists.
//
// Local mode only. With AIM4_LOCAL=0 these paths are 404, because the profile
// belongs to Supabase then.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_DATA_DIR, localMode, readProfile, writeProfile, OWNER_ID } from './mode.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/** What the browser is allowed to change about itself. */
const WRITABLE = ['username', 'display_name', 'language', 'country_code', 'elo'];

async function readBody(req, maxBytes = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return null;
  }
}

/** @returns {Promise<boolean>} true when this request was a local route. */
export async function handleLocalRequest(req, res, url) {
  if (!localMode() || url.pathname !== '/api/local/profile') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  if (req.method === 'GET') {
    json(res, 200, readProfile());
    return true;
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body) {
      json(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    const patch = {};
    for (const key of WRITABLE) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    json(res, 200, writeProfile(patch));
    return true;
  }

  json(res, 405, { error: 'Method not allowed.' });
  return true;
}

/** Wipe the local database. Deliberately not wired to a route. */
export function resetLocalData() {
  const file = path.join(LOCAL_DATA_DIR, 'profile.json');
  fs.rmSync(file, { force: true });
  return { removed: file, owner: OWNER_ID };
}
