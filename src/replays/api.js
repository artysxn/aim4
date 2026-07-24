// ---------------------------------------------------------------------------
// replays/api.js
// Client for /api/replays/*. Talks to the same backend as the trainer
// (VITE_API_URL in production, same origin in dev through the Vite proxy).
//
// A library is private, so requests carry the Supabase access token and the
// backend takes the account id from the verified token. The id header is only
// a local-dev convenience for a backend with no Supabase configured; a real
// backend ignores it.
// ---------------------------------------------------------------------------

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

let accountId = '';
let tokenProvider = null;

/** Called by the view whenever auth state changes. */
export function setAccount(id) {
  accountId = id || '';
}

/**
 * Register a function returning the current Supabase access token. It is
 * called per request rather than cached, so a token refreshed mid-session is
 * picked up without the page reloading.
 *
 * @param {() => Promise<string|null>} provider
 */
export function setTokenProvider(provider) {
  tokenProvider = provider;
}

async function headers(extra = {}) {
  const h = { ...extra };
  if (accountId) h['X-Aim4-User'] = accountId;
  try {
    const token = await tokenProvider?.();
    if (token) h.Authorization = `Bearer ${token}`;
  } catch {
    /* not signed in, or Supabase unreachable; the backend decides */
  }
  return h;
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    // Carried so callers can tell "sign in" apart from "backend is down".
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function fetchStatus() {
  return asJson(await fetch(`${API_BASE}/api/replays/status`, { headers: await headers() }));
}

export async function fetchDemos() {
  return asJson(await fetch(`${API_BASE}/api/replays/demos`, { headers: await headers() }));
}

export async function fetchDemo(id) {
  return asJson(await fetch(`${API_BASE}/api/replays/demos/${id}`, { headers: await headers() }));
}

export async function deleteDemo(id) {
  return asJson(
    await fetch(`${API_BASE}/api/replays/demos/${id}`, { method: 'DELETE', headers: await headers() })
  );
}

export async function reparseDemo(id) {
  return asJson(
    await fetch(`${API_BASE}/api/replays/demos/${id}/parse`, { method: 'POST', headers: await headers() })
  );
}

/**
 * Upload a .dem. XMLHttpRequest rather than fetch: a demo is hundreds of
 * megabytes and upload progress is the only honest thing to show while it
 * transfers.
 *
 * @param {File} file
 * @param {(pct: number, loaded: number, total: number) => void} [onProgress]
 */
export async function uploadDemo(file, onProgress) {
  // Resolved before the request opens: XHR headers must be set before send,
  // and a stale token here would fail the upload after the whole file moved.
  const auth = await headers();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/replays/demos`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Aim4-Filename', file.name);
    for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
      }
    });
    xhr.addEventListener('load', () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* server sent something that is not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed. Is the backend running?')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    xhr.send(file);
  });
}

/**
 * The collector. Filters run against round names on the backend, so this
 * returns quickly even over a full library.
 *
 * @param {import('./shared/roundFilter.js').RoundQuery} query
 */
export async function findRounds(query = {}, limit = 2000) {
  const params = new URLSearchParams();
  const put = (k, v) => {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  };
  put('maps', query.maps);
  put('teams', query.teams);
  put('players', query.players);
  put('playerMode', query.playerMode);
  put('wonBy', query.wonBy);
  put('economies', query.economies);
  put('teamEconomies', query.teamEconomies);
  put('teamEconomyOf', query.teamEconomyOf);
  put('roundMin', query.roundMin);
  put('roundMax', query.roundMax);
  put('search', query.search);
  put('limit', limit);
  return asJson(
    await fetch(`${API_BASE}/api/replays/rounds?${params}`, { headers: await headers() })
  );
}

export async function fetchRoundMeta(file) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}`, {
      headers: await headers()
    })
  );
  return body.round;
}

/**
 * Fetch a round's ticks. `stride` 100 is the timeline's coarse first pass;
 * stride 1 is the full-detail pass.
 */
export async function fetchRoundTicks(file, stride = 1) {
  const res = await fetch(
    `${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/ticks?stride=${stride}`,
    { headers: await headers() }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not load round (${res.status})`);
  }
  return res.arrayBuffer();
}
