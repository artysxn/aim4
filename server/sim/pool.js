// ---------------------------------------------------------------------------
// server/sim/pool.js
// 7.1: the league as three populations, on disk.
//
// shared/sim/league.js already owns the arithmetic -- PFSP weights, opponent
// sampling, the reset rule, the exploitability bar. What did not exist was a
// POOL: somewhere the three roles are written down, the win rates between
// members accumulate, and the rule that matters is enforced rather than
// remembered.
//
// That rule, from 9.12: EXPLOITERS ARE ADMITTED TO THE POOL AND NEVER SHIPPED.
// An exploiter exists to find one hole in one champion and is deliberately
// degenerate everywhere else; shipping one would be shipping a bot that only
// knows a trick. `poolEntry` already refuses to mark a non-main as shipped, and
// `shippable()` here is the read every consumer should use.
//
// Stored at `AIM4_REPLAY_DIR/sim/league/pool.json`, one file: the pool is a
// few dozen rows and a win-rate matrix, and a directory per member would make
// the common operation (read the whole pool to sample an opponent) into a
// directory walk.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from '../replays/demoStore.js';
import { ROLE, poolEntry } from '../../shared/sim/league.js';
import { markSynthetic } from '../../shared/sim/firewall.js';

const LEAGUE_DIR = path.join(ROOT, 'sim', 'league');
const POOL_FILE = path.join(LEAGUE_DIR, 'pool.json');
export const POOL_VERSION = 1;

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

/** The pool as stored, or an empty one. */
export async function readPool() {
  try {
    const json = JSON.parse(await fsp.readFile(POOL_FILE, 'utf8'));
    if (json.v !== POOL_VERSION) {
      throw new Error(`league pool: v${json.v}, this build speaks v${POOL_VERSION}`);
    }
    return { v: POOL_VERSION, members: json.members || [], results: json.results || {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { v: POOL_VERSION, members: [], results: {} };
    throw err;
  }
}

/**
 * Add or update a member.
 *
 * Idempotent by id: re-admitting a model after a second eval updates its row
 * rather than growing a duplicate, because the pool is keyed by what plays,
 * not by how many times it was judged.
 */
export async function addMember({ id, role = ROLE.MAIN, parent = null, shipped = false }) {
  const pool = await readPool();
  const entry = poolEntry({ id: safe(id), role, parent, shipped });
  const i = pool.members.findIndex((m) => m.id === entry.id);
  if (i >= 0) pool.members[i] = { ...pool.members[i], ...entry };
  else pool.members.push(entry);
  await writeAtomic(POOL_FILE, JSON.stringify(markSynthetic(pool), null, 2));
  return entry;
}

/** The head-to-head key. Sorted, so A-vs-B and B-vs-A are one cell. */
function pairKey(a, b) {
  return [safe(a), safe(b)].sort().join('|');
}

/**
 * Record a head-to-head result.
 *
 * Stored as one cell per unordered pair with the score from the alphabetically
 * first member's point of view, so a matrix read never has to reconcile two
 * half-filled directions that disagree.
 */
export async function recordResult(a, b, scoreForA, games = 1) {
  const pool = await readPool();
  const key = pairKey(a, b);
  const [first] = key.split('|');
  const score = safe(a) === first ? scoreForA : games - scoreForA;
  const cur = pool.results[key] || { score: 0, games: 0 };
  pool.results[key] = { score: cur.score + score, games: cur.games + games };
  await writeAtomic(POOL_FILE, JSON.stringify(markSynthetic(pool), null, 2));
  return pool.results[key];
}

/**
 * Win rates for one member against everyone it has played, in the shape
 * `samplePfsp` reads.
 */
export function winRatesFor(pool, id) {
  const out = {};
  for (const other of pool.members) {
    if (other.id === id) continue;
    const cell = pool.results[pairKey(id, other.id)];
    if (!cell || !cell.games) continue;
    const [first] = pairKey(id, other.id).split('|');
    const mine = id === first ? cell.score : cell.games - cell.score;
    out[other.id] = mine / cell.games;
  }
  return out;
}

/**
 * Who may be offered as a playable brain.
 *
 * The one question the rest of the app should ask about the pool. An exploiter
 * is a member, is sampled as an opponent, and is never this.
 */
export function shippable(pool) {
  return pool.members.filter((m) => m.role === ROLE.MAIN && m.shipped).map((m) => m.id);
}

/** Every member in a role, for the runner that trains that population. */
export function membersIn(pool, role) {
  return pool.members.filter((m) => m.role === role).map((m) => m.id);
}
