// ---------------------------------------------------------------------------
// teamBoards.js: drawing boards and the Utility Archive, per team and map.
//
//   {AIM4_REPLAY_DIR}/teamBoards/<teamId>/drawing/<MAP>/<boardId>.json
//   Legacy single file (migrated on read): drawing/<MAP>.json
//   {AIM4_REPLAY_DIR}/teamBoards/<teamId>/utility/<MAP>.json
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './demoStore.js';
import { isMember, teamById } from './teamsStore.js';
import { MAPS } from '../../src/replays/shared/roundId.js';

const baseDir = () => path.join(ROOT, 'teamBoards');
const teamDir = (teamId) => path.join(baseDir(), safeId(teamId));

const MAP_RE = /^[A-Z0-9]{2,4}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const MERGE_UNITS = 75;
const MAX_COMMENT = 100;
const MAX_STROKES = 800;
const MAX_NADES_BOARD = 200;
const MAX_PLAYERS_BOARD = 40;
const MAX_UTILITY = 400;
const MAX_THROWS = 24;
const MAX_BOARDS_PER_MAP = 80;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

/** The only grenade kinds a board or an archive may hold. */
const NADE_TYPES = Object.freeze(['smokegrenade', 'molotov', 'hegrenade', 'flashbang']);

function safeId(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error('Bad id.');
  return s;
}

function denied(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

function assertMember(team, actor) {
  if (!team) throw new Error('That team no longer exists.');
  if (!isMember(team, actor.id) && !actor.admin) throw denied('You are not on that team.');
}

function assertMap(map) {
  const code = String(map || '').toUpperCase();
  if (!MAP_RE.test(code) || !MAPS[code]) throw new Error('Unknown map.');
  return code;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, body) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
}

function clampNum(v, lo, hi, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function newUtilityId(used) {
  for (let i = 0; i < 40; i++) {
    let id = '';
    for (let j = 0; j < 4; j++) id += ID_ALPHABET[(Math.random() * ID_ALPHABET.length) | 0];
    if (!used.has(id)) return id;
  }
  return crypto.randomBytes(3).toString('base64url').slice(0, 4);
}

// ---- Drawing boards -------------------------------------------------------

function drawingDir(teamId, map) {
  return path.join(teamDir(teamId), 'drawing', map);
}

function legacyDrawingFile(teamId, map) {
  return path.join(teamDir(teamId), 'drawing', `${map}.json`);
}

function newBoardId() {
  return crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 10);
}

function emptyBoard(map, id = '', name = '') {
  return { id, name, map, updatedAt: 0, strokes: [], nades: [], players: [] };
}

function sanitizeBoard(map, payload, id, name) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const strokes = [];
  for (const s of (src.strokes || []).slice(0, MAX_STROKES)) {
    if (!s || typeof s !== 'object') continue;
    const pts = Array.isArray(s.pts)
      ? s.pts
          .slice(0, 2000)
          .map((p) => ({
            x: clampNum(p?.x, -2000, 4000, 0),
            y: clampNum(p?.y, -2000, 4000, 0)
          }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      : [];
    if (!pts.length) continue;
    strokes.push({
      color: String(s.color || '#f0f0f0').slice(0, 32),
      width: clampNum(s.width, 0.5, 12, 2.6),
      pts
    });
  }
  const nades = [];
  for (const n of (src.nades || []).slice(0, MAX_NADES_BOARD)) {
    if (!n || typeof n !== 'object') continue;
    const type = String(n.type || '');
    if (!NADE_TYPES.includes(type)) continue;
    nades.push({
      type,
      x: clampNum(n.x, -10000, 10000, 0),
      y: clampNum(n.y, -10000, 10000, 0),
      playerColor: String(n.playerColor || '').slice(0, 32)
    });
  }
  const players = [];
  for (const p of (src.players || []).slice(0, MAX_PLAYERS_BOARD)) {
    if (!p || typeof p !== 'object') continue;
    players.push({
      x: clampNum(p.x, -10000, 10000, 0),
      y: clampNum(p.y, -10000, 10000, 0),
      yaw: clampNum(p.yaw, -180, 180, 0),
      color: String(p.color || '#e8b84a').slice(0, 32),
      side: p.side === 'CT' ? 'CT' : p.side === 'T' ? 'T' : ''
    });
  }
  const cleanName = String(name || src.name || 'Untitled').trim().slice(0, 80) || 'Untitled';
  const cleanId = BOARD_ID_RE.test(String(id || src.id || ''))
    ? String(id || src.id)
    : newBoardId();
  return {
    id: cleanId,
    name: cleanName,
    map,
    updatedAt: Date.now(),
    strokes,
    nades,
    players
  };
}

async function migrateLegacyBoard(teamId, map) {
  const legacy = legacyDrawingFile(teamId, map);
  const raw = await readJson(legacy, null);
  if (!raw) return null;
  const board = sanitizeBoard(map, raw, 'legacy', raw.name || 'Untitled');
  await writeJson(path.join(drawingDir(teamId, map), `${board.id}.json`), board);
  try {
    await fsp.unlink(legacy);
  } catch {
    /* ignore */
  }
  return board;
}

export async function listDrawingBoards(actor, teamId, map) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const code = assertMap(map);
  const dir = drawingDir(teamId, code);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    names = [];
  }
  if (!names.length) {
    const migrated = await migrateLegacyBoard(teamId, code);
    if (migrated) {
      return [{ id: migrated.id, name: migrated.name, updatedAt: migrated.updatedAt }];
    }
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const raw = await readJson(path.join(dir, f), null);
    if (!raw) continue;
    const id = String(raw.id || f.replace(/\.json$/i, ''));
    out.push({
      id,
      name: String(raw.name || 'Untitled').slice(0, 80),
      updatedAt: Number(raw.updatedAt) || 0
    });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, MAX_BOARDS_PER_MAP);
}

export async function getDrawingBoard(actor, teamId, map, boardId) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const code = assertMap(map);
  const id = String(boardId || '');
  if (!BOARD_ID_RE.test(id)) throw new Error('Unknown board.');
  const file = path.join(drawingDir(teamId, code), `${id}.json`);
  let raw = await readJson(file, null);
  if (!raw && id === 'legacy') {
    raw = await readJson(legacyDrawingFile(teamId, code), null);
  }
  if (!raw) throw Object.assign(new Error('Board not found.'), { status: 404 });
  return sanitizeBoard(code, raw, id, raw.name);
}

/** Create or overwrite a named board for a map. */
export async function saveDrawingBoard(actor, teamId, map, payload) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const code = assertMap(map);
  const incomingId = String(payload?.id || '');
  if (!BOARD_ID_RE.test(incomingId)) {
    let count = 0;
    try {
      count = (await fsp.readdir(drawingDir(teamId, code))).filter((f) => f.endsWith('.json')).length;
    } catch {
      count = 0;
    }
    if (count >= MAX_BOARDS_PER_MAP) {
      throw new Error(`At most ${MAX_BOARDS_PER_MAP} boards per map.`);
    }
  }
  const board = sanitizeBoard(code, payload, incomingId, payload?.name);
  await writeJson(path.join(drawingDir(teamId, code), `${board.id}.json`), board);
  return board;
}

export async function deleteDrawingBoard(actor, teamId, map, boardId) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const code = assertMap(map);
  const id = String(boardId || '');
  if (!BOARD_ID_RE.test(id)) throw new Error('Unknown board.');
  const file = path.join(drawingDir(teamId, code), `${id}.json`);
  try {
    await fsp.unlink(file);
  } catch {
    throw Object.assign(new Error('Board not found.'), { status: 404 });
  }
  return { ok: true };
}

// ---- Utility archive ------------------------------------------------------

function emptyUtility(map) {
  return { map, updatedAt: 0, grenades: [] };
}

/**
 * One throw spot, with its own id.
 *
 * A lineup is a landing spot AND the place it is thrown from. The id used to
 * name only the landing spot, so three different smokes onto the same window
 * shared one `<!abcd>` and a stratbook link could not say which one it meant -
 * the reader was prompted to pick. The throw carries the id now, so a different
 * setpos is a different id. Landing spots still group them for the map.
 *
 * Throws saved before this share the grenade's id namespace, so `used` is the
 * archive-wide set and a missing id is filled in here.
 *
 * `round` / `tick` / `player` are the demo this lineup was lifted from, filled
 * in when a strategy is generated from a bookmarked round. A stratbook link
 * uses them to open the round on the throw itself rather than only copying the
 * setpos. Hand-placed throws leave them empty and behave as they always did.
 */
function sanitizeThrow(t, claim) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: claim(t.id),
    x: clampNum(t.x, -10000, 10000, 0),
    y: clampNum(t.y, -10000, 10000, 0),
    setpos: String(t.setpos || '').trim().slice(0, 240),
    setang: String(t.setang || '').trim().slice(0, 240),
    comment: String(t.comment || '').trim().slice(0, MAX_COMMENT),
    round: String(t.round || '').replace(/[^A-Za-z0-9_~-]/g, '').slice(0, 200),
    tick: Math.max(0, Math.floor(clampNum(t.tick, 0, 1e9, 0))),
    player: String(t.player || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  };
}

/** A stored id, or '' when it is missing or malformed. */
function heldId(raw) {
  const id = String(raw || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
  return id.length === 4 ? id : '';
}

function sanitizeUtility(map, payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const incoming = (src.grenades || []).slice(0, MAX_UTILITY);

  // Grenades and throws share one id namespace, because a stratbook note writes
  // `<!abcd>` without saying which kind it is. Two passes keep that honest:
  //
  //   reserved  every id already on disk. Reserved before a single new id is
  //             minted, so migrating a throw cannot take an id a later grenade
  //             already holds and rename it out from under a live note.
  //   taken     ids actually handed out during this pass, which is what makes a
  //             genuine duplicate detectable.
  const reserved = new Set();
  for (const g of incoming) {
    if (!g || typeof g !== 'object') continue;
    const gid = heldId(g.id);
    if (gid) reserved.add(gid);
    for (const t of (g.throws || []).slice(0, MAX_THROWS)) {
      const tid = heldId(t?.id);
      if (tid) reserved.add(tid);
    }
  }
  const taken = new Set();
  const claim = (raw) => {
    let id = heldId(raw);
    if (!id || taken.has(id)) id = newUtilityId(reserved);
    reserved.add(id);
    taken.add(id);
    return id;
  };

  const grenades = [];
  for (const g of incoming) {
    if (!g || typeof g !== 'object') continue;
    const type = String(g.type || '');
    if (!NADE_TYPES.includes(type)) continue;
    const id = claim(g.id);
    const throws = [];
    for (const t of (g.throws || []).slice(0, MAX_THROWS)) {
      const clean = sanitizeThrow(t, claim);
      if (clean) throws.push(clean);
    }
    grenades.push({
      id,
      type,
      name: String(g.name || '').trim().slice(0, 80),
      detonate: {
        x: clampNum(g.detonate?.x, -10000, 10000, 0),
        y: clampNum(g.detonate?.y, -10000, 10000, 0)
      },
      throws
    });
  }
  return { map, updatedAt: Date.now(), grenades };
}

/**
 * How many grenades a payload would actually leave in the archive.
 *
 * The per-map entitlement (`team.utility_archive`) has to be checked before the
 * write, and it has to count the same things sanitizeUtility() keeps. Counting
 * the raw array instead would refuse saves that were about to shrink the
 * archive, because the client posts the whole archive on every edit and junk
 * entries or unknown grenade kinds are dropped on the way in. Throws are not
 * counted: the cap is on lineups, and one grenade may carry several ways of
 * throwing it.
 */
export function countUtilityGrenades(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const list = Array.isArray(src.grenades) ? src.grenades.slice(0, MAX_UTILITY) : [];
  let n = 0;
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    if (!NADE_TYPES.includes(String(g.type || ''))) continue;
    n += 1;
  }
  return n;
}

export async function getUtilityArchive(actor, teamId, map) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const code = assertMap(map);
  const file = path.join(teamDir(teamId), 'utility', `${code}.json`);
  const raw = await readJson(file, null);
  return raw ? sanitizeUtility(code, raw) : emptyUtility(code);
}

export async function saveUtilityArchive(actor, teamId, map, payload) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const code = assertMap(map);
  const archive = sanitizeUtility(code, payload);
  const file = path.join(teamDir(teamId), 'utility', `${code}.json`);
  await writeJson(file, archive);
  return archive;
}

/** Flat id → grenade lookup across every map for one team (stratbook links). */
export async function listUtilityIndex(actor, teamId) {
  const team = await teamById(teamId);
  assertMember(team, actor);
  const dir = path.join(teamDir(teamId), 'utility');
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const map = f.replace(/\.json$/i, '').toUpperCase();
    if (!MAPS[map]) continue;
    const archive = await getUtilityArchive(actor, teamId, map);
    for (const g of archive.grenades) {
      out.push({
        id: g.id,
        map,
        type: g.type,
        name: g.name || `${g.type} ${g.id}`,
        throws: g.throws
      });
    }
  }
  return out;
}

export { MERGE_UNITS, MAX_COMMENT };
