// ---------------------------------------------------------------------------
// replays/roundId.js
// The round naming scheme. Every parsed round is stored under a filename that
// encodes everything the library filters on, so listing a directory is enough
// to answer a query — no round file ever has to be opened to be filtered out.
//
// Shape (three underscore-separated groups):
//
//   T1-T2-WEE-MAP-RR_a1-a2-a3-a4-a5_b1-b2-b3-b4-b5
//
//   T1   team 1 id            3 chars [A-Za-z0-9]
//   T2   team 2 id            3 chars [A-Za-z0-9]
//   WEE  winner + economies   3 digits: winner (1|2), team 1 econ, team 2 econ
//   MAP  map code             3 chars, one of MAP_CODES
//   RR   round number         2 digits, 01-99
//   a*   team 1 player ids    5 x 3 chars
//   b*   team 2 player ids    5 x 3 chars
//
// Example:
//   BFx-p41-154-ANC-02_2aF-XWf-kK0-15d-lkc_Ab1-92d-FfR-k20-FNf
//   -> Vitality (BFx) beat FNATIC (p41) on Ancient, round 2. Vitality ran a
//      full buy with an AWP (5), FNATIC a full buy without (4).
//
// This module is pure data: it is imported by the browser bundle and by the
// Node backend, so it must never touch `window`, `document` or `fs`.
// ---------------------------------------------------------------------------

/** Map code -> canonical CS2 map name / radar image basename. */
export const MAPS = {
  ANC: { name: 'Ancient', file: 'de_ancient' },
  DD2: { name: 'Dust2', file: 'de_dust2' },
  INF: { name: 'Inferno', file: 'de_inferno' },
  CCH: { name: 'Cache', file: 'de_cache' },
  MIR: { name: 'Mirage', file: 'de_mirage' },
  NUK: { name: 'Nuke', file: 'de_nuke' },
  ANU: { name: 'Anubis', file: 'de_anubis' }
};

export const MAP_CODES = Object.keys(MAPS);

/** Reverse lookup for parser output ("de_dust2" -> "DD2"). */
const FILE_TO_CODE = Object.fromEntries(
  Object.entries(MAPS).map(([code, m]) => [m.file, code])
);

/**
 * Economy buckets. The digit is stored verbatim in the WEE group, one per
 * team. 5 outranks 4: it means a full buy that also has an AWP on the server.
 */
export const ECONOMIES = {
  0: { key: 'pistol', label: 'Pistol' },
  1: { key: 'eco', label: 'Eco' },
  2: { key: 'half', label: 'Half buy' },
  3: { key: 'force', label: 'Force buy' },
  4: { key: 'full', label: 'Full buy' },
  5: { key: 'awp', label: 'Full buy + AWP' }
};

export const ECONOMY_CODES = Object.keys(ECONOMIES).map(Number);

const ID_RE = /^[A-Za-z0-9]{3}$/;
const TOKEN = '[A-Za-z0-9]{3}';
const ROUND_ID_RE = new RegExp(
  `^(${TOKEN})-(${TOKEN})-([12])([0-5])([0-5])-(${TOKEN})-(\\d{2})` +
    `_((?:${TOKEN}-){4}${TOKEN})_((?:${TOKEN}-){4}${TOKEN})$`
);

export function isValidShortId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Deterministic 3-char id for a name (team or player). Used when the source
 * demo has no stable id of its own: the same name always folds to the same
 * token, which is what makes filenames comparable across demos.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function shortIdFor(name) {
  const s = String(name ?? '').trim() || 'unknown';
  // FNV-1a, 32 bit. Small, stable, and dependency-free on both runtimes.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 3; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length) + i * 7919;
  }
  return out;
}

export function mapCodeFromName(mapName) {
  const raw = String(mapName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (MAPS[upper]) return upper;
  const file = raw.toLowerCase();
  if (FILE_TO_CODE[file]) return FILE_TO_CODE[file];
  // "Dust2", "dust 2", "de_dust2_ve" and friends.
  const squashed = file.replace(/[^a-z0-9]/g, '');
  for (const [code, m] of Object.entries(MAPS)) {
    const bare = m.file.replace('de_', '');
    if (squashed === bare || squashed === m.file || squashed.startsWith(m.file)) return code;
    if (squashed === m.name.toLowerCase()) return code;
  }
  return null;
}

export function padRound(n) {
  const r = Math.max(1, Math.min(99, Math.round(Number(n) || 1)));
  return String(r).padStart(2, '0');
}

/**
 * Build a round filename stem.
 *
 * @param {object} r
 * @param {string} r.team1        3-char id
 * @param {string} r.team2        3-char id
 * @param {1|2}    r.winner       which team won
 * @param {number} r.econ1        0-5
 * @param {number} r.econ2        0-5
 * @param {string} r.map          map code (ANC, DD2, ...)
 * @param {number} r.round        1-99
 * @param {string[]} r.players1   5 x 3-char ids
 * @param {string[]} r.players2   5 x 3-char ids
 */
export function buildRoundId(r) {
  const fail = (msg) => {
    throw new Error(`buildRoundId: ${msg}`);
  };
  if (!isValidShortId(r.team1) || !isValidShortId(r.team2)) fail('team ids must be 3 alphanumeric chars');
  if (r.winner !== 1 && r.winner !== 2) fail('winner must be 1 or 2');
  if (!(r.econ1 >= 0 && r.econ1 <= 5)) fail('econ1 must be 0-5');
  if (!(r.econ2 >= 0 && r.econ2 <= 5)) fail('econ2 must be 0-5');
  if (!MAPS[r.map]) fail(`unknown map code "${r.map}"`);
  const players1 = r.players1 || [];
  const players2 = r.players2 || [];
  if (players1.length !== 5 || players2.length !== 5) fail('each side needs exactly 5 player ids');
  for (const p of [...players1, ...players2]) {
    if (!isValidShortId(p)) fail(`bad player id "${p}"`);
  }
  const wee = `${r.winner}${r.econ1}${r.econ2}`;
  return (
    `${r.team1}-${r.team2}-${wee}-${r.map}-${padRound(r.round)}` +
    `_${players1.join('-')}_${players2.join('-')}`
  );
}

/**
 * Parse a round filename stem back into its fields. Returns null when the
 * name does not match the scheme, which is how unrelated files in a round
 * directory get skipped.
 */
export function parseRoundId(id) {
  const m = ROUND_ID_RE.exec(String(id ?? '').trim());
  if (!m) return null;
  const [, team1, team2, winner, econ1, econ2, map, round, group1, group2] = m;
  if (!MAPS[map]) return null;
  return {
    id: m[0],
    team1,
    team2,
    winner: Number(winner),
    econ1: Number(econ1),
    econ2: Number(econ2),
    map,
    mapName: MAPS[map].name,
    round: Number(round),
    players1: group1.split('-'),
    players2: group2.split('-'),
    players: [...group1.split('-'), ...group2.split('-')]
  };
}

export function isRoundId(id) {
  return parseRoundId(id) !== null;
}

/** True when either team ran the given economy bucket. */
export function roundHasEconomy(meta, econ) {
  return meta.econ1 === econ || meta.econ2 === econ;
}

/** Winner side as a team id, not an index. */
export function winnerTeamId(meta) {
  return meta.winner === 1 ? meta.team1 : meta.team2;
}

export function loserTeamId(meta) {
  return meta.winner === 1 ? meta.team2 : meta.team1;
}

export function economyLabel(code) {
  return ECONOMIES[code]?.label ?? String(code);
}

/**
 * Which side won a round for UI coloring (T / CT).
 * Matches the parser's half split: team 1 starts T for rounds 1-12, CT after.
 *
 * @param {{ winner: 1|2, round: number }} r
 * @returns {'T'|'CT'}
 */
export function winningSide(r) {
  const round = Number(r?.round) || 1;
  const team1IsT = round <= 12;
  if (r?.winner === 1) return team1IsT ? 'T' : 'CT';
  return team1IsT ? 'CT' : 'T';
}

export function radarImage(mapCode) {
  const m = MAPS[mapCode];
  return m ? `/maps/radar/${m.file}.png` : null;
}
