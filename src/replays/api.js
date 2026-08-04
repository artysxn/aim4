// ---------------------------------------------------------------------------
// replays/api.js
// Client for /api/replays/*. Talks to the same backend as the trainer
// (VITE_API_URL in production, same origin in dev through the Vite proxy).
//
// The library folder is shared, but who is asking is not: every request carries
// the Supabase access token, and the backend decides from it which demos exist
// for this caller. Signed-out visitors still read the public library.
// ---------------------------------------------------------------------------

import { decodePacked, isPacked } from './shared/tickPacked.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/** @deprecated Library is shared; account id is ignored. */
export function setAccount(_id) {}

/** @deprecated Library is shared; tokens are not sent. */
export function setTokenProvider(_provider) {}

/**
 * Bearer token for the current Supabase session, or '' when signed out.
 *
 * The Supabase client is pulled in lazily rather than imported at the top:
 * this module is also loaded by the Node backend (through zoneApi), where a
 * browser-only module reading import.meta.env would throw on load.
 * getSession() refreshes a stale token, so a long-open tab never sends an
 * expired one.
 */
export async function accessToken() {
  if (typeof window === 'undefined') return '';
  try {
    const { getSupabase, supabaseConfigured } = await import('../lib/supabase.js');
    if (!supabaseConfigured()) return '';
    const sb = getSupabase();
    if (!sb) return '';
    const { data } = await sb.auth.getSession();
    return data?.session?.access_token || '';
  } catch {
    return '';
  }
}

/**
 * The "view as" ticket, when an admin is impersonating. Read from
 * sessionStorage rather than passed down, because every call site in this file
 * would otherwise have to thread it, and the one that forgot would silently
 * serve the admin's own library instead of the target's.
 */
function impersonateHeader() {
  try {
    const ticket = globalThis.sessionStorage?.getItem('aim4.impersonate');
    return ticket ? { 'X-Aim4-Impersonate': ticket } : {};
  } catch {
    return {};
  }
}

async function headers(extra = {}) {
  const token = await accessToken();
  const base = { ...extra, ...impersonateHeader() };
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `Request failed (${res.status})`);
    // Carried so callers can tell "sign in" apart from "backend is down".
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Spend one use of a quota'd capability before running it.
 *
 * Call this immediately before the work, not when a panel opens: opening the
 * charts page and looking at it should not cost one of three daily uses.
 *
 * Resolves `{ allowed: true, remaining, resetsAt }` when the use was granted.
 * Throws with `err.status === 402` and `err.body` carrying the standard upgrade
 * payload when the allowance is spent or the tier does not include it.
 *
 * @param {string} capability  a key from shared/entitlements/keys.js
 */
export async function consumeCapability(capability) {
  const res = await fetch(`${API_BASE}/api/replays/consume`, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ capability })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function fetchStatus() {
  return asJson(await fetch(`${API_BASE}/api/replays/status`, { headers: await headers() }));
}

/**
 * Library listing. Pass `{ limit, offset }` for a page (used by /replays).
 * Omit them for the full list.
 *
 * `{ mine: true }` returns everything this account owns, unpaginated, which is
 * what My Uploads needs: filtering the library page client-side capped that
 * screen at the page size no matter how many demos the account actually had.
 *
 * @param {{ limit?: number, offset?: number, mine?: boolean }} [opts]
 */
export async function fetchDemos(opts = {}) {
  const params = new URLSearchParams();
  if (opts.mine) params.set('mine', '1');
  else {
    if (Number.isFinite(opts.limit) && opts.limit > 0) params.set('limit', String(opts.limit));
    if (Number.isFinite(opts.offset) && opts.offset > 0) params.set('offset', String(opts.offset));
  }
  const q = params.toString() ? `?${params}` : '';
  return asJson(await fetch(`${API_BASE}/api/replays/demos${q}`, { headers: await headers() }));
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

/** Change who may browse a demo: public | unlisted | private. */
export async function setDemoVisibility(id, visibility) {
  return asJson(
    await fetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/visibility`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ visibility })
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
function uploadBinary(url, file, onProgress, extraHeaders = {}) {
  // Resolved before the request opens: XHR headers must be set before send,
  // and a stale token here would fail the upload after the whole file moved.
  return headers().then(
    (auth) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Aim4-Filename', file.name);
        for (const [k, v] of Object.entries(extraHeaders)) xhr.setRequestHeader(k, v);
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
 * Upload a .dem, or a .zip / .gz / .zst containing one or more, for parsing on
 * the server. Resolves as soon as the bytes have landed, with a batch id: the
 * server unpacks and parses in the background because a big archive takes long
 * enough that holding the request open is how uploads die behind a proxy.
 *
 * @param {File} file
 * @param {(pct: number, loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<{batch: object, usage: object}>}
 */
export async function uploadDemo(file, onProgress, visibility = 'public') {
  return uploadBinary(`${API_BASE}/api/replays/demos`, file, onProgress, {
    'X-Aim4-Visibility': visibility
  });
}

/**
 * Where one upload has got to: how many demos it contained, and how many are
 * unpacked, parsed and analyzed.
 *
 * @param {string} batchId
 */
export async function fetchUploadBatch(batchId) {
  return asJson(
    await fetch(`${API_BASE}/api/replays/uploads/${encodeURIComponent(batchId)}`, {
      headers: await headers()
    })
  );
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
  put('equalBuy', query.equalBuy ? '1' : undefined);
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
    playerId: String(n?.playerId || ''),
    rule: String(n?.rule || ''),
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

/**
 * Rebuild / enrich stats indexes that are missing or behind the current schema.
 * @param {{ force?: boolean }} [opts]
 */
export async function refreshStats(opts = {}) {
  const q = opts.force ? '?force=1' : '';
  return asJson(
    await fetch(`${API_BASE}/api/replays/stats/refresh${q}`, {
      method: 'POST',
      headers: await headers()
    })
  );
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
 * @param {{id?: string, name?: string, rounds?: string[], scope?: 'private'|'team'}} playlist
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
 *
 * Full detail asks for `fmt=packed`: the columnar body is about a third of the
 * gzipped rows and costs the backend nothing to serve, and the browser has
 * already inflated it by the time it gets here, so all that is left is the
 * varint unpack. Whether the body actually came back packed is decided by the
 * magic in the first four bytes rather than by a header, so a server that has
 * not shipped the format yet — or a proxy that rewrote the content type, or a
 * response still sitting in the HTTP cache from before — still decodes.
 */
export async function fetchRoundTicks(file, stride = 1) {
  const packed = stride === 1;
  const qs = `stride=${stride}${packed ? '&fmt=packed' : ''}`;
  const res = await fetch(
    `${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/ticks?${qs}`,
    { headers: await headers() }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not load round (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return isPacked(buf) ? decodePacked(buf) : buf;
}

// ---- Position / zone networks (same Coolify volume as notes; not Supabase) -

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
  const network = data?.network;
  // A missing/invalid payload must not look like "this map was never painted"
  // — SPA HTML fallthrough and empty `{}` bodies used to hit the empty fallback.
  if (!network || typeof network !== 'object' || !Array.isArray(network.visionBlocks)) {
    throw new Error(`Could not load zones for ${map}.`);
  }
  return network;
}

/**
 * Persist bombsites + vision layers + key zones for one map.
 * @param {string} map
 * @param {{ visionBlocks?: Array, elevated?: Array, underpasses?: Array, ledges?: Array, bombSites?: object, keyZones?: object }} network
 */
export async function saveZones(map, network) {
  const data = await asJson(
    await fetch(`${API_BASE}/api/replays/zones/${encodeURIComponent(map)}`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        visionBlocks: network.visionBlocks || [],
        elevated: network.elevated || [],
        underpasses: network.underpasses || [],
        ledges: network.ledges || [],
        bombSites: network.bombSites || { a: null, b: null },
        keyZones: network.keyZones || { a: [], b: [] }
      })
    })
  );
  return data.network;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Every team the signed-in account belongs to, owned team first. */
export async function fetchTeams() {
  const body = await asJson(
    await fetch(`${API_BASE}/api/teams`, { headers: await headers() })
  );
  return body.teams || [];
}

export async function createTeam(name) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/teams`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name })
    })
  );
  return body.teams || [];
}

/** Readable signed out, so /i/<code> can name the team before asking to sign in. */
export async function fetchInvite(code) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/teams/invite/${encodeURIComponent(code)}`, {
      headers: await headers()
    })
  );
  return body;
}

export async function joinTeam(code) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/join`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code })
    })
  );
}

export async function rollTeamInvite(teamId) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/invite`, {
      method: 'POST',
      headers: await headers()
    })
  );
}

export async function leaveTeam(teamId) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/leave`, {
      method: 'POST',
      headers: await headers()
    })
  );
}

/**
 * @param {'kick'|'ban'|'unban'|'role'|'transfer'|'createDummy'|'merge'} action
 * @param {{role?: string, kind?: 'player'|'coach', name?: string, username?: string, dummyId?: string}} [extra]
 */
export async function teamMemberAction(teamId, memberId, action, extra = {}) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ memberId, action, ...extra })
    })
  );
}

/** Owner: add a placeholder seat for planning positions. */
export async function createTeamDummy(teamId, name) {
  return teamMemberAction(teamId, '', 'createDummy', { name });
}

/** Admin: real member inherits a placeholder's positions/kind; placeholder goes. */
export async function mergeTeamMember(teamId, memberId, dummyId) {
  return teamMemberAction(teamId, memberId, 'merge', { dummyId });
}

/** @param {'T'|'CT'} side */
export async function fetchTeamAutocoach(teamId) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/autocoach`, {
      headers: await headers()
    })
  );
}

export async function markTeamAutocoachDemo(teamId, demoId, side) {
  return asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/autocoach/demos/${encodeURIComponent(
        demoId
      )}`,
      {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ side: side === 2 ? 2 : 1 })
      }
    )
  );
}

export async function setTeamPosition(teamId, memberId, side, map, position) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/positions`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ memberId, side, map, position })
    })
  );
}

export async function fetchTeamDocument(teamId, docId) {
  const body = await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/documents/${encodeURIComponent(docId)}`,
      { headers: await headers() }
    )
  );
  return body.document || null;
}

/** @param {{id?: string, title?: string, html?: string}} doc */
export async function saveTeamDocument(teamId, doc) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/documents`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(doc)
    })
  );
  return body;
}

export async function deleteTeamDocument(teamId, docId) {
  return asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/documents/${encodeURIComponent(docId)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

/** @param {object} strategy */
export async function saveTeamStrategy(teamId, strategy) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/stratbook`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(strategy)
    })
  );
}

export async function deleteTeamStrategy(teamId, strategyId) {
  return asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/stratbook/${encodeURIComponent(strategyId)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

// ---------------------------------------------------------------------------
// Synthetic 2D strategy rounds
// ---------------------------------------------------------------------------

/** Real spawn points for a map, sampled from demos the caller may read. */
export async function fetchSpawns(map) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/replays/spawns?map=${encodeURIComponent(map)}`, {
      headers: await headers()
    })
  );
  return body.spawns || [];
}

/** Index entries only: the list view never downloads a round body. */
export async function fetchStrategyRounds(teamId) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d`, {
      headers: await headers()
    })
  );
  return body.rounds || [];
}

export async function fetchStrategyRound(teamId, id) {
  return asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d/${encodeURIComponent(id)}`,
      { headers: await headers() }
    )
  );
}

/** @param {{id?: string, name?: string, round: object}} payload */
export async function saveStrategyRound(teamId, payload) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    })
  );
}

export async function deleteStrategyRound(teamId, id) {
  return asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

/** Open a shared round by its link code. Works signed out. */
export async function fetchSharedStrategyRound(shareId) {
  return asJson(
    await fetch(`${API_BASE}/api/teams/shared2d/${encodeURIComponent(shareId)}`, {
      headers: await headers()
    })
  );
}

// ---------------------------------------------------------------------------
// Drawing boards + utility archive
// ---------------------------------------------------------------------------

export async function listDrawingBoards(teamId, map) {
  const body = await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/drawing-boards/${encodeURIComponent(map)}`,
      { headers: await headers() }
    )
  );
  return body.boards || [];
}

export async function fetchDrawingBoard(teamId, map, boardId) {
  const body = await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/drawing-boards/${encodeURIComponent(
        map
      )}/${encodeURIComponent(boardId)}`,
      { headers: await headers() }
    )
  );
  return body.board || null;
}

export async function saveDrawingBoard(teamId, map, board) {
  const body = await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/drawing-boards/${encodeURIComponent(map)}`,
      {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(board)
      }
    )
  );
  return body.board || null;
}

export async function deleteDrawingBoard(teamId, map, boardId) {
  await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/drawing-boards/${encodeURIComponent(
        map
      )}/${encodeURIComponent(boardId)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

export async function fetchUtilityArchive(teamId, map) {
  const body = await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/utility/${encodeURIComponent(map)}`,
      { headers: await headers() }
    )
  );
  return body.archive || null;
}

export async function saveUtilityArchive(teamId, map, archive) {
  const body = await asJson(
    await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/utility/${encodeURIComponent(map)}`,
      {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(archive)
      }
    )
  );
  return body.archive || null;
}

/** Flat grenade index across all maps for stratbook `<!####>` links. */
export async function fetchUtilityIndex(teamId) {
  const body = await asJson(
    await fetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/utility`, {
      headers: await headers()
    })
  );
  return body.index || [];
}
