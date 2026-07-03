// ---------------------------------------------------------------------------
// lib/playlists.js — local playlist store + combined-score helpers.
//
// A playlist is an ordered list of training-mode configs (the same unit a
// mode config code carries). Playlists live in localStorage; their leaderboard
// is the shared cloud `scores` table under scenario='playlist' keyed by a
// stable hash of the ordered items, so anyone running the same playlist shares
// a board. The board ranks by combined score (sum across the modes).
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import { isKillLeaderboardScenario } from '../scenarios/leaderboardConfig.js';
import { encodeModeConfig, decodeModeConfig } from '../utils/ModeConfigCodes.js';

const STORAGE_KEY = 'playlists';
export const PLAYLIST_SCENARIO = 'playlist';
export const PLAYLIST_CODE_PREFIX = 'AIM4P-';

// ---- Persistence ----------------------------------------------------------

export function loadPlaylists() {
  const list = Storage.read(STORAGE_KEY, []);
  return Array.isArray(list) ? list : [];
}

function persist(list) {
  Storage.write(STORAGE_KEY, list);
}

let _idCounter = 0;
function newId() {
  // Local-only id; uniqueness within this browser is all that's needed.
  _idCounter += 1;
  return `pl-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

export function createPlaylist(name, items = []) {
  return {
    id: newId(),
    name: String(name || 'Untitled playlist').slice(0, 60),
    items: items.map(normalizeItem),
    createdAt: Date.now()
  };
}

/** Insert or replace a playlist by id; returns the saved list. */
export function savePlaylist(playlist) {
  const list = loadPlaylists();
  const idx = list.findIndex((p) => p.id === playlist.id);
  if (idx === -1) list.push(playlist);
  else list[idx] = playlist;
  persist(list);
  return list;
}

export function deletePlaylist(id) {
  const list = loadPlaylists().filter((p) => p.id !== id);
  persist(list);
  return list;
}

function normalizeItem(item) {
  return { scenario: item.scenario, config: item.config ? structuredClone(item.config) : {} };
}

// ---- Stable hashing (leaderboard config_key) ------------------------------

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit; two seeds concatenated → 16 hex chars (collision-safe here). */
function hash32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic leaderboard key from the ordered items (ignores name). */
export function playlistConfigKey(playlist) {
  const basis = (playlist?.items || []).map((it) => ({ s: it.scenario, c: it.config ?? {} }));
  const str = stableStringify(basis);
  return `pl_${hash32(str, 0x811c9dc5)}${hash32(str, 0x7fffffff)}`;
}

// ---- Share codes (whole playlist) -----------------------------------------

function b64urlEncode(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return decodeURIComponent(escape(atob(t)));
}

export function isPlaylistCode(raw) {
  return String(raw || '').trim().toUpperCase().startsWith(PLAYLIST_CODE_PREFIX);
}

/** Encode a whole playlist (name + items) as one shareable code. */
export function encodePlaylist(playlist) {
  const payload = {
    v: 1,
    n: playlist.name,
    i: (playlist.items || []).map((it) => ({ s: it.scenario, c: it.config ?? {} }))
  };
  return PLAYLIST_CODE_PREFIX + b64urlEncode(JSON.stringify(payload));
}

/** Decode a playlist code into a fresh, locally-owned playlist object. */
export function decodePlaylist(raw) {
  const code = String(raw || '').trim().replace(/\s+/g, '');
  if (!isPlaylistCode(code)) throw new Error('Not a playlist code (expected AIM4P-…)');
  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(code.slice(PLAYLIST_CODE_PREFIX.length)));
  } catch {
    throw new Error('Playlist code is corrupted');
  }
  if (!parsed || !Array.isArray(parsed.i)) throw new Error('Playlist code is missing modes');
  const items = parsed.i
    .filter((it) => it && typeof it.s === 'string')
    .map((it) => ({ scenario: it.s, config: it.c && typeof it.c === 'object' ? it.c : {} }));
  return createPlaylist(parsed.n || 'Imported playlist', items);
}

// Re-export the mode code helpers so the playlist UI has a single import.
export { encodeModeConfig, decodeModeConfig };

// ---- Combined scoring -----------------------------------------------------

/** The leaderboard-relevant value for one mode result (kills or score). */
export function primaryValue(result) {
  return isKillLeaderboardScenario(result.scenario)
    ? Math.round(result.kills || 0)
    : Math.round(result.score || 0);
}

/**
 * Fold per-mode run results into one combined playlist result, ready for
 * submitScore (scenario='playlist'). `score` is the sum of each mode's
 * leaderboard-relevant value.
 */
export function combinePlaylistResults(playlist, results) {
  let score = 0;
  let kills = 0;
  let hits = 0;
  let shots = 0;
  let timePlayed = 0;
  for (const r of results) {
    score += primaryValue(r);
    kills += Math.round(r.kills || 0);
    hits += Math.round(r.hits || 0);
    shots += Math.round(r.shots || 0);
    timePlayed += Number(r.timePlayed || 0);
  }
  return {
    scenario: PLAYLIST_SCENARIO,
    configKey: playlistConfigKey(playlist),
    score,
    accuracy: shots > 0 ? hits / shots : 0,
    critRatio: 0,
    kills,
    hits,
    shots,
    timePlayed,
    kpm: timePlayed > 0 ? kills / (timePlayed / 60) : 0,
    variant: 'playlist',
    leaderboardEligible: true
  };
}
