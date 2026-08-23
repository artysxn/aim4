// ---------------------------------------------------------------------------
// server/pitchRoutes.js
// GET /api/pitch — the live wording for the deck.
//
// Public and unauthenticated on purpose: /public-pitch is meant to be sent to
// someone without an account, and it has to read the same edited text an admin
// sees. Writing is somewhere else entirely (POST /api/admin/pitch), behind the
// admin gate, so this endpoint has no way to change anything.
// ---------------------------------------------------------------------------

import { getPitchText } from './pitchStore.js';

/** Long enough to absorb a reload, short enough that an edit shows up live. */
const MAX_AGE_S = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

/**
 * @returns {Promise<boolean>} true when this request was the pitch endpoint.
 */
export async function handlePitchRequest(req, res, url) {
  if (url.pathname !== '/api/pitch') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { ...CORS, Allow: 'GET, OPTIONS' });
    res.end();
    return true;
  }

  let body;
  try {
    const record = await getPitchText();
    body = JSON.stringify({ updatedAt: record.updatedAt, text: record.text });
  } catch (err) {
    // A broken or unreadable file must not take the deck down: fall back to the
    // wording compiled into the client.
    console.error('[pitch]', err);
    body = JSON.stringify({ updatedAt: 0, text: {} });
  }

  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': `public, max-age=${MAX_AGE_S}`
  });
  res.end(body);
  return true;
}
