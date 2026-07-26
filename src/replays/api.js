// ---------------------------------------------------------------------------
// replays/api.js
// Client for /api/replays/*. Talks to the same backend as the trainer
// (VITE_API_URL in production, same origin in dev through the Vite proxy).
//
// The demo library is shared for every visitor. Auth headers are unused; the
// helpers below stay so older call sites keep compiling.
// ---------------------------------------------------------------------------

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/** @deprecated Library is shared; account id is ignored. */
export function setAccount(_id) {}

/** @deprecated Library is shared; tokens are not sent. */
export function setTokenProvider(_provider) {}

async function headers(extra = {}) {
  return { ...extra };
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

/** Set display names for both teams after import (ids / round files stay put). */
export async function renameDemoTeams(id, team1, team2) {
  return asJson(
    await fetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/teams`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ team1, team2 })
    })
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
function uploadBinary(url, file, onProgress) {
  // Resolved before the request opens: XHR headers must be set before send,
  // and a stale token here would fail the upload after the whole file moved.
  return headers().then(
    (auth) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
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
        // The browser gives no detail here on purpose: a blocked CORS preflight, a
        // proxy body-size limit and a dead backend all surface as the same opaque
        // event. Name the likely causes rather than guessing one.
        xhr.addEventListener('error', () =>
          reject(
            new Error(
              'Upload could not reach the backend. Check that it is running, that ' +
                'CORS allows this origin, and that any reverse proxy in front of it ' +
                'accepts large request bodies.'
            )
          )
        );
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
        xhr.send(file);
      })
  );
}

/**
 * Upload a .dem for server-side parsing. Prefer uploadImport for production:
 * parse locally and upload the .aim4replay package instead.
 *
 * @param {File} file
 * @param {(pct: number, loaded: number, total: number) => void} [onProgress]
 */
export async function uploadDemo(file, onProgress) {
  return uploadBinary(`${API_BASE}/api/replays/demos`, file, onProgress);
}

/**
 * Upload a locally-parsed .aim4replay package. Rounds land ready immediately;
 * no demoparser runs on the server.
 *
 * @param {File} file
 * @param {(pct: number, loaded: number, total: number) => void} [onProgress]
 */
export async function uploadImport(file, onProgress) {
  return uploadBinary(`${API_BASE}/api/replays/import`, file, onProgress);
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
  put('wonBy', Array.isArray(query.wonBy) ? query.wonBy : query.wonBy);
  put('wonByMode', query.wonByMode);
  put('economies', query.economies);
  put('econA', Number.isFinite(query.econA) ? query.econA : undefined);
  put('econB', Number.isFinite(query.econB) ? query.econB : undefined);
  put('hasAwpA', query.hasAwpA ? '1' : undefined);
  put('hasAwpB', query.hasAwpB ? '1' : undefined);
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

/** Longest text one note will keep; the server truncates to the same length. */
export const NOTE_MAX = 800;

/**
 * Replace a round's timestamped notes list.
 * Each note: `{ id, tick, text, updatedAt? }`. Empty array clears all notes.
 * Legacy `{ note: string }` is still accepted by the server.
 */
export async function saveRoundNotes(file, notes) {
  const list = (Array.isArray(notes) ? notes : []).map((n) => ({
    id: String(n?.id || ''),
    tick: Number(n?.tick) || 0,
    text: String(n?.text ?? '').slice(0, NOTE_MAX),
    kind: n?.kind === 'coach' ? 'coach' : 'user',
    mark: n?.mark === 'ok' || n?.mark === 'x' ? n.mark : '',
    updatedAt: Number(n?.updatedAt) || Date.now()
  }));
  return asJson(
    await fetch(`${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/note`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ notes: list })
    })
  );
}

/** @deprecated use saveRoundNotes */
export async function saveRoundNote(file, note) {
  return asJson(
    await fetch(`${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/note`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ note: String(note ?? '').slice(0, NOTE_MAX) })
    })
  );
}

/**
 * The stats database: a compact per-round index, not finished tables.
 *
 * Filtering and aggregation happen in the browser against this payload, so the
 * stats page re-sorts and re-filters with no request, and the viewer's live
 * scoreboard can re-count rounds 1..N every time the round changes.
 *
 * @param {string[]} [demoIds] limit to these demos; omit for the whole library
 */
export async function fetchStats(demoIds = null) {
  const q = demoIds?.length ? `?demos=${encodeURIComponent(demoIds.join(','))}` : '';
  return asJson(await fetch(`${API_BASE}/api/replays/stats${q}`, { headers: await headers() }));
}

export async function fetchPlaylists() {
  const body = await asJson(
    await fetch(`${API_BASE}/api/replays/playlists`, { headers: await headers() })
  );
  return body.playlists || [];
}

/**
 * Create a playlist (no id) or replace one (with an id). Returns the full
 * list back, so the caller never has to merge state by hand.
 *
 * @param {{id?: string, name?: string, rounds?: string[]}} playlist
 */
export async function savePlaylist(playlist) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/replays/playlists`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(playlist)
    })
  );
  return body.playlists || [];
}

export async function deletePlaylist(id) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/replays/playlists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await headers()
    })
  );
  return body.playlists || [];
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

// ---- Zone networks (same Coolify volume as notes; not Supabase) -----------

export async function fetchZoneMaps() {
  const data = await asJson(
    await fetch(`${API_BASE}/api/replays/zones`, { headers: await headers() })
  );
  return data.maps || [];
}

/** @param {string} map  map code (MIR, INF, …) */
export async function fetchZones(map) {
  const data = await asJson(
    await fetch(`${API_BASE}/api/replays/zones/${encodeURIComponent(map)}`, {
      headers: await headers()
    })
  );
  return data.network || { map, zones: [], sections: [], updatedAt: 0 };
}

/**
 * Persist zone polygons + names for one map. Same shared write path as
 * saveRoundNotes — JSON on AIM4_REPLAY_DIR, no auth.
 * @param {string} map
 * @param {{ zones?: Array, sections?: Array }} network
 */
export async function saveZones(map, network) {
  const data = await asJson(
    await fetch(`${API_BASE}/api/replays/zones/${encodeURIComponent(map)}`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        zones: network.zones || [],
        sections: network.sections || []
      })
    })
  );
  return data.network;
}
