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
import { isReplayPackage } from './shared/replayPackage.js';
import { decodeRoundPacks } from './shared/roundPackWire.js';


const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/**
 * The API host, for the few callers that build a request themselves.
 *
 * Exported because a bare `/api/...` fetch does not fail loudly in production:
 * the site is on Vercel and the API is on another host, so that path hits the
 * SPA catch-all rewrite and comes back as 200 text/html. `res.ok` is true and
 * the JSON parse is what throws, several lines later, usually inside someone's
 * catch. Anything talking to the API goes through this.
 */
export function apiBase() {
  return API_BASE;
}

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

/**
 * A filename made safe to carry in an HTTP header. Header values must be
 * Latin-1: setRequestHeader throws outright on a Cyrillic or CJK demo name
 * ("навими-vs-фаза.dem"), and 0x80-0xFF slips through as raw bytes a proxy may
 * refuse -- either way the upload dies instantly for just those users. Percent
 * encoding keeps it pure ASCII; the server decodes it back.
 */
function headerFilename(name) {
  return encodeURIComponent(String(name || ''));
}

/**
 * Turn opaque browser network failures into something a person can act on.
 * "Failed to fetch" usually means the API host is down, blocked, or CORS-broken.
 */
export function formatApiError(err) {
  if (!err) return new Error('Request failed.');
  if (err.status) return err;
  const raw = String(err.message || err || 'Request failed.');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    const next = new Error(
      'Could not reach the server (Failed to fetch). Check that the API is running and your connection is up, then retry.'
    );
    next.cause = err;
    return next;
  }
  if (/abort(ed)?|timed?\s*out/i.test(raw)) {
    const next = new Error('The request timed out. The server may be busy — retry in a moment.');
    next.cause = err;
    return next;
  }
  return err instanceof Error ? err : new Error(raw);
}

async function safeFetch(url, init) {
  try {
    return await globalThis.fetch(url, init);
  } catch (err) {
    throw formatApiError(err);
  }
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
  const res = await safeFetch(`${API_BASE}/api/replays/consume`, {
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
  return asJson(await safeFetch(`${API_BASE}/api/replays/status`, { headers: await headers() }));
}

async function fetchSampleDemos() {
  try {
    const res = await fetch('/api/sampledemos', { credentials: 'include' });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) return [];
    const body = await res.json();
    return Array.isArray(body.demos) ? body.demos : [];
  } catch {
    return [];
  }
}

function mergeDemoLists(primary, extra) {
  const seen = new Set((primary || []).map((d) => d.id));
  const out = [...(primary || [])];
  for (const d of extra || []) {
    if (d?.id && !seen.has(d.id)) {
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

/**
 * Library listing. Pass `{ limit, offset }` for a page (used by /replays).
 * Omit them for the full list.
 *
 * `{ mine: true }` returns everything this account owns, unpaginated, which is
 * what My Uploads needs: filtering the library page client-side capped that
 * screen at the page size no matter how many demos the account actually had.
 *
 * `{ team: 'Name' }` keeps only demos whose team1/team2 display name matches
 * (case-insensitive). Used by Team Overview so it does not download the whole
 * shared library.
 *
 * Localhost also merges `sampledemos/*.aim4replay` from same-origin
 * `/api/sampledemos`, so Import round and the 2D library work without a
 * library import.
 *
 * @param {{ limit?: number, offset?: number, mine?: boolean, team?: string, map?: string }} [opts]
 */
export async function fetchDemos(opts = {}) {
  const params = new URLSearchParams();
  if (opts.mine) params.set('mine', '1');
  else {
    if (Number.isFinite(opts.limit) && opts.limit > 0) params.set('limit', String(opts.limit));
    if (Number.isFinite(opts.offset) && opts.offset > 0) params.set('offset', String(opts.offset));
  }
  if (opts.team) params.set('team', String(opts.team));
  if (opts.map) params.set('map', String(opts.map));
  const q = params.toString() ? `?${params}` : '';
  let lib;
  try {
    lib = await asJson(
      await safeFetch(`${API_BASE}/api/replays/demos${q}`, { headers: await headers() })
    );
  } catch (err) {
    if (opts.mine) throw err;
    const samples = await fetchSampleDemos();
    if (!samples.length) throw err;
    lib = {
      demos: [],
      teams: [],
      total: 0,
      offset: 0,
      limit: 0,
      hasMore: false,
      pending: 0,
      owned: 0
    };
    // Fall through so the sample merge below is the listing.
    return finishSampleMerge(lib, samples, opts);
  }
  if (opts.mine) return lib;
  return finishSampleMerge(lib, await fetchSampleDemos(), opts);
}

/**
 * Records for an explicit id list, batched.
 *
 * The demo browser used to resolve library-wide filter results with one
 * GET /demos/:id per demo — up to a couple of hundred requests funnelled
 * through the browser's six connections before a row could render.
 *
 * @param {string[]} ids
 * @returns {Promise<object[]>} the records the caller may read, any order
 */
export async function fetchDemosByIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const out = [];
  const CHUNK = 150;
  for (let i = 0; i < list.length; i += CHUNK) {
    const q = list.slice(i, i + CHUNK).join(',');
    const body = await asJson(
      await safeFetch(`${API_BASE}/api/replays/demos?ids=${encodeURIComponent(q)}`, {
        headers: await headers()
      })
    );
    out.push(...(body.demos || []));
  }
  return out;
}

function finishSampleMerge(lib, samples, opts) {
  let extra = samples;
  if (opts.team) {
    const teamQ = String(opts.team).trim().toLowerCase();
    extra = extra.filter((r) => {
      const a = String(r.team1?.name || r.team1 || '')
        .trim()
        .toLowerCase();
      const b = String(r.team2?.name || r.team2 || '')
        .trim()
        .toLowerCase();
      return a === teamQ || b === teamQ;
    });
  }
  if (opts.map) {
    const code = String(opts.map).trim().toUpperCase();
    extra = extra.filter((r) => String(r.map || '').toUpperCase() === code);
  }
  if (!extra.length) return lib;
  const demos = mergeDemoLists(lib.demos, extra);
  const added = demos.length - (lib.demos || []).length;
  return { ...lib, demos, total: (Number(lib.total) || (lib.demos || []).length) + added };
}

/**
 * 3D availability for one library demo: movement data, map pack, reparse job.
 * Bearer auth, not cookies. `credentials: 'include'` against api.aim4.io is
 * blocked when the API answers `Access-Control-Allow-Origin: *`.
 */
export async function fetchDemo3d(id, method = 'GET') {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/3d`, {
      method,
      headers: await headers()
    })
  );
}

export async function fetchDemo(id) {
  try {
    return await asJson(
      await safeFetch(`${API_BASE}/api/replays/demos/${id}`, { headers: await headers() })
    );
  } catch (err) {
    const res = await fetch(`/api/sampledemos/demos/${encodeURIComponent(id)}`, {
      credentials: 'include'
    }).catch(() => null);
    const ct = res?.headers?.get('content-type') || '';
    if (res?.ok && ct.includes('json')) return res.json();
    throw err;
  }
}

/**
 * The roster catalogue: which demos feature which players and teams.
 *
 * Small (a few hundred KB for a 4100-demo library) and cached for a minute, so
 * a scoped page resolves its demo ids from this and then asks /stats for only
 * those — instead of pulling the library to find out who is in it.
 */
export async function fetchRoster() {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/roster`, { headers: await headers() })
  );
}

/** Global VRS ladder (three regions pooled by points). Cached for the session. */
let vrsRanksCache = null;

export async function fetchVrsRanks() {
  if (vrsRanksCache) return vrsRanksCache;
  const { ranksFromApiPayload, setVrsRankTable } = await import('./shared/vrsRanks.js');
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/vrs`, { headers: await headers() })
  );
  vrsRanksCache = ranksFromApiPayload(body);
  setVrsRankTable(vrsRanksCache);
  return vrsRanksCache;
}

/**
 * Library-wide peer averages for the Performance cards. Computed server-side so
 * the page can scope itself to one player's matches without the comparison
 * quietly narrowing to that player's own lobbies.
 */
export async function fetchPeerAverages(filter = {}) {
  const params = new URLSearchParams();
  if (filter.map) params.set('map', filter.map);
  if (filter.dateFrom) params.set('from', filter.dateFrom);
  if (filter.dateTo) params.set('to', filter.dateTo);
  const q = params.toString();
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/peers${q ? `?${q}` : ''}`, {
      headers: await headers()
    })
  );
}

/**
 * Player / team tables for a filter, aggregated on the server.
 *
 * The alternative is what the Database used to do: pull every round of every
 * demo and add them up in the browser. On a four-thousand demo library that is
 * ~18 s and ~740 MB to produce a screen of rows. This returns the rows.
 *
 * @param {object} filter    same shape rowPasses takes
 * @param {{ tables?: string, limit?: number, offset?: number, demos?: string[] }} [opts]
 */
/**
 * Above this many round ids, the same query goes as a POST body.
 *
 * A URL has a practical ceiling somewhere around 8 KB and round ids are ~14
 * bytes each, so a few hundred of them is already past what a GET will carry.
 * The server reads the identical argument names either way.
 */
const AGGREGATE_POST_FILES = 200;

export async function fetchAggregate(filter = {}, opts = {}) {
  const files = Array.isArray(filter.files) ? filter.files.filter(Boolean) : [];
  if (files.length > AGGREGATE_POST_FILES) {
    return asJson(
      await safeFetch(`${API_BASE}/api/replays/aggregate`, {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          ...aggregateBody(filter, opts),
          files
        })
      })
    );
  }
  const params = new URLSearchParams();
  const maps = Array.isArray(filter.maps) ? filter.maps.filter(Boolean) : [];
  if (maps.length) params.set('maps', maps.join(','));
  if (filter.side) params.set('side', filter.side);
  if (filter.econ !== null && filter.econ !== undefined) params.set('econ', String(filter.econ));
  if (filter.oppEcon !== null && filter.oppEcon !== undefined) {
    params.set('oppEcon', String(filter.oppEcon));
  }
  if (filter.hasAwp) params.set('hasAwp', '1');
  if (filter.oppHasAwp) params.set('oppHasAwp', '1');
  const roundOwn = Array.isArray(filter.roundOwn) ? filter.roundOwn.filter(Boolean) : [];
  const roundOpp = Array.isArray(filter.roundOpp) ? filter.roundOpp.filter(Boolean) : [];
  if (roundOwn.length) params.set('roundOwn', roundOwn.join(','));
  if (roundOpp.length) params.set('roundOpp', roundOpp.join(','));
  if (Number.isFinite(filter.fromSec)) params.set('fromSec', String(filter.fromSec));
  if (Number.isFinite(filter.toSec)) params.set('toSec', String(filter.toSec));
  if (filter.result) params.set('result', filter.result);
  if (filter.advantage) params.set('advantage', filter.advantage);
  if (filter.teamName) params.set('teamName', filter.teamName);
  if (filter.role?.side && filter.role?.value) {
    params.set('role', `${filter.role.side}:${filter.role.value}`);
  }
  if (filter.roles) params.set('roles', '1');
  if (Number.isFinite(filter.minRounds) && filter.minRounds > 0) {
    params.set('minRounds', String(filter.minRounds));
  }
  if (filter.rankOwn) params.set('rankOwn', String(filter.rankOwn));
  if (filter.rankOpp) params.set('rankOpp', String(filter.rankOpp));
  if (filter.dateFrom) params.set('from', filter.dateFrom);
  if (filter.dateTo) params.set('to', filter.dateTo);
  if (Array.isArray(filter.files) && filter.files.length) params.set('files', filter.files.join(','));
  if (opts.demos?.length) params.set('demos', opts.demos.join(','));
  if (opts.tables) params.set('tables', opts.tables);
  if (Number.isFinite(opts.limit)) params.set('limit', String(opts.limit));
  if (Number.isFinite(opts.offset) && opts.offset > 0) params.set('offset', String(opts.offset));
  const q = params.toString();
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/aggregate${q ? `?${q}` : ''}`, {
      headers: await headers()
    })
  );
}

/**
 * One aggregated row per match for a single player or team.
 *
 * `demos` is required and comes from the roster catalogue: the caller already
 * knows which matches the entity played, and passing them means the server
 * never scans the library to find out.
 */
export async function fetchAggregateMatches(want, demos, filter = {}) {
  const list = [...new Set((demos || []).filter(Boolean))];
  if (!list.length) return { rows: [] };
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/aggregate/matches`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ...aggregateBody(filter, {}),
        ...(want?.kind === 'team' ? { team: want.id } : { player: want?.id }),
        demos: list
      })
    })
  );
}

/**
 * The GET params as a POST body. Same names, same meanings, no length limit.
 *
 * EVERY filter the Database can set has to appear here and in the query-string
 * builder above. A field that is quietly left out does not fail: the request
 * comes back UNFILTERED and the table repaints identical numbers under a
 * changed filter bar, which is exactly how the round-library picks read as "the
 * Database ignored my filter". aggregateFilters.test.js walks the whole filter
 * field by field to keep that from happening again.
 */
function aggregateBody(filter = {}, opts = {}) {
  const body = {};
  const maps = Array.isArray(filter.maps) ? filter.maps.filter(Boolean) : [];
  if (maps.length) body.maps = maps;
  if (filter.side) body.side = filter.side;
  if (filter.econ !== null && filter.econ !== undefined) body.econ = filter.econ;
  if (filter.oppEcon !== null && filter.oppEcon !== undefined) body.oppEcon = filter.oppEcon;
  if (filter.hasAwp) body.hasAwp = 1;
  if (filter.oppHasAwp) body.oppHasAwp = 1;
  const roundOwn = Array.isArray(filter.roundOwn) ? filter.roundOwn.filter(Boolean) : [];
  const roundOpp = Array.isArray(filter.roundOpp) ? filter.roundOpp.filter(Boolean) : [];
  if (roundOwn.length) body.roundOwn = roundOwn;
  if (roundOpp.length) body.roundOpp = roundOpp;
  if (Number.isFinite(filter.fromSec)) body.fromSec = filter.fromSec;
  if (Number.isFinite(filter.toSec)) body.toSec = filter.toSec;
  if (filter.result) body.result = filter.result;
  if (filter.advantage) body.advantage = filter.advantage;
  if (filter.teamName) body.teamName = filter.teamName;
  if (filter.role?.side && filter.role?.value) body.role = `${filter.role.side}:${filter.role.value}`;
  if (filter.roles) body.roles = 1;
  if (Number.isFinite(filter.minRounds) && filter.minRounds > 0) body.minRounds = filter.minRounds;
  if (filter.rankOwn) body.rankOwn = filter.rankOwn;
  if (filter.rankOpp) body.rankOpp = filter.rankOpp;
  if (filter.dateFrom) body.from = filter.dateFrom;
  if (filter.dateTo) body.to = filter.dateTo;
  if (opts.demos?.length) body.demos = opts.demos;
  if (opts.tables) body.tables = opts.tables;
  if (Number.isFinite(opts.limit)) body.limit = opts.limit;
  if (Number.isFinite(opts.offset) && opts.offset > 0) body.offset = opts.offset;
  return body;
}

/**
 * The same tables for an explicit set of ROUNDS, sent in a body.
 *
 * The Pattern Finder's leaderboard is "these exact rounds, the ones the search
 * matched", and a search on a busy map matches tens of thousands of them —
 * hundreds of kilobytes of round ids, far past what a URL will carry. That is
 * the whole reason this is a POST and `fetchAggregate` is not.
 *
 * The rounds themselves never leave the server: the client sends ids and gets
 * back the finished rows, which is what lets the Pattern Finder stop
 * downloading the per-round rating columns at all.
 */
export async function fetchAggregateForRounds(files, opts = {}) {
  const list = [...new Set((files || []).filter(Boolean))];
  if (!list.length) return { players: [], teams: [], playersTotal: 0, teamsTotal: 0 };
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/aggregate`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        files: list,
        tables: opts.tables || 'players,teams',
        ...(opts.demos?.length ? { demos: opts.demos } : {}),
        ...(Number.isFinite(opts.limit) ? { limit: opts.limit } : {})
      })
    })
  );
}

function isHtmlOrJsonType(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/plain');
}

/** Match package bytes for the 3D explorer. Library first, then sampledemos. */
export async function fetchDemoPackage(id) {
  const tryPackage = async (url) => {
    const res = await safeFetch(url, {
      headers: await headers()
    }).catch(() => null);
    if (!res) return { res: null, buf: null };
    if (!res.ok) return { res, buf: null };
    if (isHtmlOrJsonType(res)) return { res, buf: null };
    const buf = await res.arrayBuffer();
    if (!isReplayPackage(buf)) return { res, buf: null };
    return { res, buf };
  };

  const lib = await tryPackage(
    `${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/package`
  );
  if (lib.buf) return lib.buf;
  const sample = await tryPackage(`/api/sampledemos/demos/${encodeURIComponent(id)}/package`);
  if (sample.buf) return sample.buf;

  const errRes = lib.res && !lib.res.ok ? lib.res : sample.res && !sample.res.ok ? sample.res : null;
  if (errRes) {
    const detail = await errRes.json().catch(() => null);
    throw new Error(detail?.error || `HTTP ${errRes.status}`);
  }
  throw new Error('This game has no 3D replay data.');
}

export async function deleteDemo(id) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${id}`, { method: 'DELETE', headers: await headers() })
  );
}

export async function reparseDemo(id) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${id}/parse`, { method: 'POST', headers: await headers() })
  );
}

/** Set display names for both teams after import (ids / round files stay put). */
export async function renameDemoTeams(id, team1, team2) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/teams`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ team1, team2 })
    })
  );
}

/** Change who may browse a demo: public | unlisted | private. */
export async function setDemoVisibility(id, visibility) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/visibility`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ visibility })
    })
  );
}

// ---- voice comms ----------------------------------------------------------

/**
 * The comms attached to a demo, plus remembered speaker identities.
 * `comms` is null when nothing is attached, which is not an error.
 */
export async function fetchDemoComms(id) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/comms`, {
      headers: await headers()
    })
  );
}

/**
 * The .aim4comms container itself.
 *
 * Kept separate from the metadata call on purpose: the sidecar is a few
 * hundred bytes and answers "is anything attached", while this is the ~2 MB
 * file, and the viewer only wants it once the user is actually watching.
 */
export async function fetchDemoCommsFile(id, version = '') {
  // `version` is the sidecar's uploadedAt, and it is load-bearing rather than
  // decorative: the response is cacheable, so replacing a recording with a
  // corrected one would otherwise keep serving the old transcript from the
  // browser's cache with nothing to explain why.
  const bust = version ? `?v=${encodeURIComponent(version)}` : '';
  const res = await safeFetch(
    `${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/comms/file${bust}`,
    { headers: await headers() }
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The transcript of an attached session, without downloading the voice.
 * Utterance timing for the Communication page's talk-time analytics.
 */
export async function fetchDemoCommsManifest(id) {
  return asJson(
    await safeFetch(
      `${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/comms/manifest`,
      { headers: await headers() }
    )
  );
}

/** Library-wide TeamSpeak UID -> roster player links. */
export async function fetchCommsIdentities() {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/comms/identities`, { headers: await headers() })
  );
}

/** Link (or with an empty playerId, unlink) one TeamSpeak UID to a player. */
export async function setCommsIdentity(uid, playerId, nickname = '') {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/comms/identities`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uid, playerId, nickname })
    })
  );
}

/** Upload a recorded session against a demo. `file` is a File or Blob. */
export async function uploadDemoComms(id, file) {
  const body = await file.arrayBuffer();
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/comms`, {
      method: 'POST',
      headers: await headers({
        'Content-Type': 'application/octet-stream',
        'X-Aim4-Filename': headerFilename(file.name)
      }),
      body
    })
  );
}

/** Save the speaker mapping, resolved anchor tick, and any manual nudge. */
export async function saveDemoCommsAttachment(id, patch) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/comms/attach`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch)
    })
  );
}

/**
 * The recorder build a user should download, or null when none is published.
 *
 * Public and unauthenticated, same as the endpoint: the download has to work
 * before anyone has installed anything.
 */
export async function fetchRecorderLatest() {
  const res = await safeFetch(`${API_BASE}/api/recorder/latest`).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.latest || null;
}

/** Where the browser should send someone to get the recorder. */
export function recorderDownloadUrl(version = '') {
  return version
    ? `${API_BASE}/api/recorder/download/${encodeURIComponent(version)}`
    : `${API_BASE}/api/recorder/download`;
}

export async function deleteDemoComms(id) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/comms`, {
      method: 'DELETE',
      headers: await headers()
    })
  );
}

/** Replace a demo's tag list. Tags are free text the uploader chooses. */
export async function setDemoTags(id, tags) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/tags`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tags })
    })
  );
}

/**
 * Count one round view against a demo.
 *
 * Fire and forget: a view that fails to record is not worth telling anyone
 * about, and it must never delay the round opening.
 */
export async function countDemoView(id) {
  if (!id) return;
  try {
    await safeFetch(`${API_BASE}/api/replays/demos/${encodeURIComponent(id)}/view`, {
      method: 'POST',
      headers: await headers()
    });
  } catch {
    /* the count is a nice-to-have, never a blocker */
  }
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
        xhr.setRequestHeader('X-Aim4-Filename', headerFilename(file.name));
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
 * Ask whether this file would be taken, before sending a byte of it.
 *
 * The upload routes refuse on identity, plan cap, file type and quota before
 * they read the body, and a browser will not look at a response while it is
 * still sending the request: the refusal is written, nobody reads it, the
 * socket buffers fill and the transfer wedges. What surfaces minutes later is
 * the xhr error above -- "could not reach the backend" -- for what was really
 * "link Steam first" or "you are at three demos". Anything over a couple of
 * megabytes hits this, so every real demo does.
 *
 * The server answers the identical gate here over a few hundred bytes of JSON,
 * so the reason arrives while the file is still on disk. Refusals are thrown in
 * the same shape uploadBinary throws them, because the callers already read
 * `upgrade_required` and 409 off these errors.
 *
 * @param {File} file
 * @param {'demo' | 'import'} kind
 */
async function precheckUpload(file, kind) {
  const res = await safeFetch(`${API_BASE}/api/replays/uploads/precheck`, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kind, filename: file?.name || '', sizeBytes: file?.size || 0 })
  });
  if (res.ok) return;
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* a refusal that is not JSON is still a refusal */
  }
  const err = new Error(body.error || `Upload refused (${res.status})`);
  err.status = res.status;
  err.body = body;
  throw err;
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
  await precheckUpload(file, 'demo');
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
    await safeFetch(`${API_BASE}/api/replays/uploads/${encodeURIComponent(batchId)}`, {
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
  await precheckUpload(file, 'import');
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
    await safeFetch(`${API_BASE}/api/replays/rounds?${params}`, { headers: await headers() })
  );
}

export async function fetchRoundMeta(file) {
  try {
    const body = await asJson(
      await safeFetch(`${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}`, {
        headers: await headers()
      })
    );
    return body.round;
  } catch (err) {
    const res = await fetch(`/api/sampledemos/rounds/${encodeURIComponent(file)}`, {
      credentials: 'include'
    }).catch(() => null);
    const ct = res?.headers?.get('content-type') || '';
    if (res?.ok && ct.includes('json')) {
      const body = await res.json();
      return body.round;
    }
    throw err;
  }
}

/**
 * Batched round packs: meta + (optionally) ticks for many rounds in one
 * request, against POST /rounds/packs.
 *
 * Returns Map file → { meta, ticks }. A file the server could not serve
 * (missing, denied) maps to nulls; the caller decides whether to fall back to
 * the per-round routes for those. Throws when the endpoint itself is
 * unavailable — an older server — so the caller can fall back wholesale.
 *
 * @param {string[]} files
 * @param {{ stride?: number, ticks?: boolean }} [opts]
 * @returns {Promise<Map<string, { meta: object|null, ticks: ArrayBuffer|null }>>}
 */
export async function fetchRoundPacks(files, { stride = 100, ticks = true, meta = '' } = {}) {
  const res = await safeFetch(`${API_BASE}/api/replays/rounds/packs`, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    // meta: 'match' asks for the matching projection: what the search
    // predicates read and nothing else. See the server's packs endpoint.
    body: JSON.stringify({ files, stride, ticks, ...(meta ? { meta } : {}) })
  });
  if (!res.ok) throw new Error(`Could not load round packs (${res.status})`);
  const packs = decodeRoundPacks(await res.arrayBuffer());
  if (!packs) throw new Error('Round packs: unexpected response format.');
  const out = new Map();
  for (const p of packs) out.set(p.file, { meta: p.meta, ticks: p.ticks });
  return out;
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
    await safeFetch(`${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/note`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ notes: list })
    })
  );
}

/** @deprecated use saveRoundNotes */
export async function saveRoundNote(file, note) {
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/note`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ note: String(note ?? '').slice(0, NOTE_MAX) })
    })
  );
}

/** Demos per GET /stats page. The Database paints after the first page. */
export const STATS_LIBRARY_PAGE = 300;

/**
 * The stats database: a compact per-round index, not finished tables.
 *
 * Filtering and aggregation happen in the browser against this payload, so the
 * stats page re-sorts and re-filters with no request, and the viewer's live
 * scoreboard can re-count rounds 1..N every time the round changes.
 *
 * Uses an NDJSON progress stream by default so callers can show which demo is
 * building or rebuilding. Falls back to a single JSON body if the stream is
 * unavailable.
 *
 * @param {string[]} [demoIds] limit to these demos; omit for the whole library
 * @param {{ onProgress?: (p: object) => void, offset?: number, limit?: number }} [opts]
 */
/**
 * Above this many demo ids, the scope goes in a POST body instead of the URL.
 *
 * Node caps the request line plus headers at 16 KB and an id costs 17 bytes,
 * so ~950 ids is where a GET stops arriving at all — it comes back 431 and the
 * caller sees an empty result, not an error it can explain. A per-map Pattern
 * Finder scope on a popular map is well past that. 600 leaves room for the
 * rest of the query and for any proxy with a tighter limit than Node's.
 */
const STATS_POST_DEMOS = 600;

export async function fetchStats(demoIds = null, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const ids = demoIds?.length ? demoIds : null;
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const limit = Math.max(0, Math.floor(Number(opts.limit) || 0));
  const columns = opts.columns;
  const fields = columns
    ? Array.isArray(columns)
      ? columns.join(',')
      : String(columns)
    : null;

  const usePost = Boolean(ids && ids.length > STATS_POST_DEMOS);
  let res;
  if (usePost) {
    res = await safeFetch(`${API_BASE}/api/replays/stats`, {
      method: 'POST',
      headers: await headers({
        Accept: 'application/x-ndjson, application/json',
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({
        demos: ids,
        stream: '1',
        ...(offset ? { offset } : {}),
        ...(limit ? { limit } : {}),
        ...(fields ? { fields } : {})
      })
    });
  } else {
    const params = new URLSearchParams();
    if (ids) params.set('demos', ids.join(','));
    params.set('stream', '1');
    if (offset) params.set('offset', String(offset));
    if (limit) params.set('limit', String(limit));
    // Column contract. Omitted → the server ships every column, which is the
    // old behaviour and what the admin tools still want.
    if (fields) params.set('fields', fields);
    res = await safeFetch(`${API_BASE}/api/replays/stats?${params}`, {
      headers: await headers({ Accept: 'application/x-ndjson, application/json' })
    });
  }
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok) return asJson(res);
  if (!/ndjson/i.test(type) || !res.body || typeof res.body.getReader !== 'function') {
    return asJson(res);
  }

  const { parseJsonBuffer, parseJsonText } = await import('../lib/parseJsonOffthread.js');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  /** NDJSON header lines only (small). Body bytes stay in binary chunks. */
  let headerText = '';
  /** @type {Uint8Array[]} */
  const bodyChunks = [];
  let bodyBytes = 0;
  let payload = null;
  let streamError = null;
  /** After `{"type":"done"}`, the rest of the body is raw JSON (not NDJSON). */
  let awaitingBody = false;
  let bodyTotal = 0;
  /** Trailer fields. The JSON body can omit hasMore/total; paging still needs them. */
  let streamMeta = null;

  const handleLine = (line) => {
    const raw = String(line || '').trim();
    if (!raw) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'progress' || msg.type === 'start') {
      onProgress?.(msg);
      return;
    }
    if (msg.type === 'done') {
      streamMeta = {
        hasMore: msg.hasMore,
        libraryTotal: Number(msg.libraryTotal) || 0
      };
      // Legacy servers nested the library in the done line. New servers send
      // only a trailer, then the payload as the remainder of the response.
      if (msg.payload) {
        payload = msg.payload;
        return;
      }
      awaitingBody = true;
      bodyTotal = Number(msg.total) || 0;
      onProgress?.({
        type: 'progress',
        phase: 'receiving',
        done: bodyTotal,
        // `total` here is this page's demo count. The library size comes off the
        // trailer, so pass it through rather than leaving the consumer to guess.
        total: bodyTotal,
        offset: Number(msg.offset) || 0,
        libraryTotal: streamMeta.libraryTotal
      });
      return;
    }
    if (msg.type === 'error') {
      streamError = new Error(msg.error || 'Stats failed.');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (awaitingBody) {
      bodyChunks.push(value);
      bodyBytes += value.byteLength;
      continue;
    }
    headerText += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = headerText.indexOf('\n')) >= 0) {
      const line = headerText.slice(0, nl);
      headerText = headerText.slice(nl + 1);
      handleLine(line);
      if (awaitingBody) {
        // Bytes after the done line belong to the JSON body.
        if (headerText) {
          const enc = new TextEncoder().encode(headerText);
          bodyChunks.push(enc);
          bodyBytes += enc.byteLength;
          headerText = '';
        }
        break;
      }
    }
  }
  if (!awaitingBody && headerText.trim()) handleLine(headerText);

  if (streamError) throw formatApiError(streamError);
  if (!payload && awaitingBody) {
    if (!bodyBytes) {
      throw formatApiError(new Error('Stats stream ended without a payload.'));
    }
    onProgress?.({
      type: 'progress',
      phase: 'building-table',
      done: bodyTotal,
      total: bodyTotal
    });
    try {
      const merged = new Uint8Array(bodyBytes);
      let offset = 0;
      for (const chunk of bodyChunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      payload = await parseJsonBuffer(merged.buffer);
    } catch (err) {
      throw formatApiError(
        new Error(err?.message || 'Could not parse the stats database payload.')
      );
    }
  } else if (!payload && headerText.trim()) {
    // Fallback: whole response was a single JSON document mislabeled as NDJSON.
    // A truncated progress line is also valid JSON and must not become the payload.
    try {
      const parsed = await parseJsonText(headerText.trim());
      if (parsed && Array.isArray(parsed.demos)) payload = parsed;
    } catch {
      /* fall through */
    }
  }
  if (!payload) {
    throw formatApiError(new Error('Stats stream ended without a payload.'));
  }
  if (streamMeta) {
    if (!Object.prototype.hasOwnProperty.call(payload, 'hasMore') && streamMeta.hasMore != null) {
      payload.hasMore = streamMeta.hasMore;
    }
    if (!(Number(payload.total) > 0) && streamMeta.libraryTotal > 0) {
      payload.total = streamMeta.libraryTotal;
    }
  }
  return payload;
}

/**
 * Rebuild / enrich stats indexes that are missing or behind the current schema.
 * @param {{ force?: boolean }} [opts]
 */
export async function refreshStats(opts = {}) {
  const q = opts.force ? '?force=1' : '';
  return asJson(
    await safeFetch(`${API_BASE}/api/replays/stats/refresh${q}`, {
      method: 'POST',
      headers: await headers()
    })
  );
}

export async function fetchPlaylists() {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/playlists`, { headers: await headers() })
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
    await safeFetch(`${API_BASE}/api/replays/playlists`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(playlist)
    })
  );
  return body.playlists || [];
}

// ---- saved views ------------------------------------------------------------
//
// One store behind Charts, Pattern Finder and Database. The spec is opaque to
// the server; each page decides what its own spec means.

export async function fetchSavedViews() {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/views`, { headers: await headers() })
  );
  return body.views || [];
}

/** Create (no id) or update (with id). Returns the whole list back. */
export async function saveSavedView(view) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/views`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(view)
    })
  );
  return body.views || [];
}

export async function deleteSavedView(id) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/views/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await headers()
    })
  );
  return body.views || [];
}

/** Resolve a share link. The id is the authorisation. */
export async function fetchSharedView(shareId) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/views/share/${encodeURIComponent(shareId)}`, {
      headers: await headers()
    })
  );
  return body.view || null;
}

export async function deletePlaylist(id) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/playlists/${encodeURIComponent(id)}`, {
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
  let res = null;
  try {
    res = await safeFetch(
      `${API_BASE}/api/replays/rounds/${encodeURIComponent(file)}/ticks?${qs}`,
      { headers: await headers() }
    );
  } catch {
    res = null;
  }
  if (!res?.ok) {
    const sample = await fetch(
      `/api/sampledemos/rounds/${encodeURIComponent(file)}/ticks?stride=${stride}`,
      { credentials: 'include' }
    ).catch(() => null);
    if (sample?.ok && !isHtmlOrJsonType(sample)) res = sample;
    else if (res) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Could not load round (${res.status})`);
    } else {
      throw new Error('Could not load round');
    }
  }
  const buf = await res.arrayBuffer();
  return isPacked(buf) ? decodePacked(buf) : buf;
}

// ---- Position / zone networks (same Coolify volume as notes; not Supabase) -

export async function fetchZoneMaps() {
  const data = await asJson(
    await safeFetch(`${API_BASE}/api/replays/zones`, { headers: await headers() })
  );
  return data.maps || [];
}

/** @param {string} map  map code (MIR, INF, …) */
export async function fetchZones(map) {
  const data = await asJson(
    await safeFetch(`${API_BASE}/api/replays/zones/${encodeURIComponent(map)}`, {
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
 * Persist bombsites + vision layers + key zones + Positions/Zones/Areas.
 * @param {string} map
 * @param {object} network
 */
export async function saveZones(map, network) {
  const data = await asJson(
    await safeFetch(`${API_BASE}/api/replays/zones/${encodeURIComponent(map)}`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        visionBlocks: network.visionBlocks || [],
        elevated: network.elevated || [],
        underpasses: network.underpasses || [],
        ledges: network.ledges || [],
        bombSites: network.bombSites || { a: [], b: [] },
        keyZones: network.keyZones || { a: [], b: [] },
        positions: network.positions || [],
        zones: network.zones || [],
        areas: network.areas || []
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
    await safeFetch(`${API_BASE}/api/teams`, { headers: await headers() })
  );
  return body.teams || [];
}

export async function createTeam(name) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/teams`, {
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
    await safeFetch(`${API_BASE}/api/teams/invite/${encodeURIComponent(code)}`, {
      headers: await headers()
    })
  );
  return body;
}

export async function joinTeam(code) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/join`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code })
    })
  );
}

export async function rollTeamInvite(teamId) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/invite`, {
      method: 'POST',
      headers: await headers()
    })
  );
}

export async function leaveTeam(teamId) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/leave`, {
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
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/members`, {
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
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/autocoach`, {
      headers: await headers()
    })
  );
}

export async function markTeamAutocoachDemo(teamId, demoId, side) {
  return asJson(
    await safeFetch(
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

/** Clear Autocoach notes + registry for selected demos, or all when `{ all: true }`. */
export async function resetTeamAutocoachDemos(teamId, { demoIds, all = false } = {}) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/autocoach/reset`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(all ? { all: true } : { demoIds: demoIds || [] })
    })
  );
}

export async function setTeamPosition(teamId, memberId, side, map, position) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/positions`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ memberId, side, map, position })
    })
  );
}

export async function fetchTeamDocument(teamId, docId) {
  const body = await asJson(
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/documents/${encodeURIComponent(docId)}`,
      { headers: await headers() }
    )
  );
  return body.document || null;
}

/** Open a shared document by its link code. Works signed out. View only. */
export async function fetchSharedDocument(shareId) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/teams/sharedDoc/${encodeURIComponent(shareId)}`, {
      headers: await headers()
    })
  );
  return body.document || null;
}

/** @param {{id?: string, title?: string, html?: string}} doc */
export async function saveTeamDocument(teamId, doc) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/documents`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(doc)
    })
  );
  return body;
}

export async function deleteTeamDocument(teamId, docId) {
  return asJson(
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/documents/${encodeURIComponent(docId)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

/** @param {object} strategy */
export async function saveTeamStrategy(teamId, strategy) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/stratbook`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(strategy)
    })
  );
}

export async function deleteTeamStrategy(teamId, strategyId) {
  return asJson(
    await safeFetch(
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
    await safeFetch(`${API_BASE}/api/replays/spawns?map=${encodeURIComponent(map)}`, {
      headers: await headers()
    })
  );
  return body.spawns || [];
}

/** Index entries only: the list view never downloads a round body. */
export async function fetchStrategyRounds(teamId) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d`, {
      headers: await headers()
    })
  );
  return body.rounds || [];
}

export async function fetchStrategyRound(teamId, id) {
  return asJson(
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d/${encodeURIComponent(id)}`,
      { headers: await headers() }
    )
  );
}

/** @param {{id?: string, name?: string, round: object}} payload */
export async function saveStrategyRound(teamId, payload) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d`, {
      method: 'POST',
      headers: await headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    })
  );
}

export async function deleteStrategyRound(teamId, id) {
  return asJson(
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/replays2d/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

/** Open a shared round by its link code. Works signed out. */
export async function fetchSharedStrategyRound(shareId) {
  return asJson(
    await safeFetch(`${API_BASE}/api/teams/shared2d/${encodeURIComponent(shareId)}`, {
      headers: await headers()
    })
  );
}

// ---------------------------------------------------------------------------
// Drawing boards + utility archive
// ---------------------------------------------------------------------------

export async function listDrawingBoards(teamId, map) {
  const body = await asJson(
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/drawing-boards/${encodeURIComponent(map)}`,
      { headers: await headers() }
    )
  );
  return body.boards || [];
}

export async function fetchDrawingBoard(teamId, map, boardId) {
  const body = await asJson(
    await safeFetch(
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
    await safeFetch(
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
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/drawing-boards/${encodeURIComponent(
        map
      )}/${encodeURIComponent(boardId)}`,
      { method: 'DELETE', headers: await headers() }
    )
  );
}

/** Admin-curated basic smoke landings for Autocoach (read-only for clients). */
export async function fetchCoachSmokes(map) {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/coach-smokes/${encodeURIComponent(map)}`, {
      headers: await headers()
    })
  );
  return body.archive || null;
}

export async function fetchCoachSmokeMaps() {
  const body = await asJson(
    await safeFetch(`${API_BASE}/api/replays/coach-smokes`, {
      headers: await headers()
    })
  );
  return body.maps || [];
}

export async function fetchUtilityArchive(teamId, map) {
  const body = await asJson(
    await safeFetch(
      `${API_BASE}/api/teams/${encodeURIComponent(teamId)}/utility/${encodeURIComponent(map)}`,
      { headers: await headers() }
    )
  );
  return body.archive || null;
}

export async function saveUtilityArchive(teamId, map, archive) {
  const body = await asJson(
    await safeFetch(
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
    await safeFetch(`${API_BASE}/api/teams/${encodeURIComponent(teamId)}/utility`, {
      headers: await headers()
    })
  );
  return body.index || [];
}
