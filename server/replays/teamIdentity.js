// ---------------------------------------------------------------------------
// replays/teamIdentity.js
// One team, one identity — however many names the demos gave it.
//
// The parser names a side after its clan tag when the demo carries one, and
// after WHICHEVER PLAYER happens to be first when it does not
// (laihoe.js teamNameFor). So a best-of-three between unnamed teams can put
// six different "team names" on one series, and the same organisation appears
// under every one of them. This module rebuilds identity from the two signals
// the demos cannot lie about — who played, and what the file was called — and
// produces the renames that collapse the aliases back into one team.
//
// Rules, in the order they bind:
//   1. Same roster, same team. Lineups sharing ORG_MERGE_SHARED players are
//      one identity whatever the names say — a full roster moving from SHARKS
//      to DENDELE is a rename, not a new team. Links are transitive: once the
//      move is established, earlier SHARKS lineups and later DENDELE cuts all
//      hang off the same identity.
//   2. Name variants. "Spirit" and "Team Spirit" with VARIANT_MERGE_SHARED
//      players in common are one team; the shorter form is an alias.
//   3. Filenames. "infurity-vs-thegoldenhorde-mirage" names both sides
//      without saying which is which — until the same squad shows up in
//      "eac-vs-infurity-dust2". A token that follows a squad across matchups
//      is that squad's name, and every demo it appears in then names the
//      OPPOSING side by elimination.
//
// The build is pure: records in, identity + renames out. Applying the renames
// (and keeping the site fast while doing it) is teamRescan.js's job.
// ---------------------------------------------------------------------------

/** Players two differently-named lineups must share to be one organisation. */
export const ORG_MERGE_SHARED = 5;
/** Players two name-variant lineups must share ("Spirit" / "Team Spirit"). */
export const VARIANT_MERGE_SHARED = 2;
/** Players an unnamed lineup must share with any other to inherit its identity. */
export const UNNAMED_MERGE_SHARED = 4;
/** Demos a filename token must dominate before a squad may claim it. */
export const TOKEN_CLAIM_MIN_DEMOS = 2;
/**
 * Players a lineup must share with a hand-renamed side to be the same team.
 *
 * Lower than every automatic threshold on purpose: a human typing the name has
 * looked at the match, so this rule trusts a three-man core where the unattended
 * rescan would want five. It only ever moves lineups the parser NAMED AFTER A
 * PLAYER — a side carrying a real name is somebody else's team, however many
 * players it happens to share.
 */
export const RENAME_CORE_SHARED = 3;

/** Lowercased alphanumerics only: the collision space for names and tokens. */
export function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Is this display name one the parser invented rather than one the demo knew?
 * 'Team 1' / 'Team 2', empty, or — the common case — the name of one of the
 * side's own players.
 */
export function isPlaceholderName(name, sidePlayers) {
  const n = normName(name);
  if (!n || n === 'team1' || n === 'team2') return true;
  for (const p of sidePlayers || []) {
    if (normName(p?.name) === n) return true;
  }
  return false;
}

const MAP_TOKENS = new Set([
  'mirage', 'inferno', 'nuke', 'overpass', 'vertigo', 'ancient', 'anubis',
  'dust2', 'dust', 'train', 'cache', 'cobblestone', 'cbble', 'de', 'cs'
]);

/** Junk a filename token can be: maps, map numbers, dates, times, counters. */
function isJunkToken(t) {
  const n = t.toLowerCase();
  if (!n) return true;
  if (MAP_TOKENS.has(n)) return true;
  if (/^m\d{1,2}$/.test(n)) return true;          // m1..m5
  if (/^\d+(\(\d+\))?$/.test(n)) return true;    // ids, dates, times, 2026(1)
  if (/^\(\d+\)$/.test(n)) return true;           // (1) duplicates
  if (/^(final|semifinal|quarterfinal|playoffs?|groups?|day\d*|part\d*)$/.test(n)) return true;
  return false;
}

/**
 * The two team-name tokens of a demo filename, or null.
 *
 * "762_M0kasyny-vs-TheGoldenHorde_cache_12_33_….dem" → M0kasyny / TheGoldenHorde.
 * Junk is peeled from the outside in: the left name is the last non-junk run
 * before "vs", the right name the first after it.
 */
export function filenameTeams(filename) {
  const base = String(filename || '').replace(/\.(dem|aim4replay|zip|gz)$/i, '');
  const m = base.match(/^(.*?)[-_. ]vs[-_. ](.*)$/i);
  if (!m) return null;
  // The name is whatever sits AGAINST "vs"; junk (maps, map numbers, dates,
  // upload ids) accumulates on the far side. So each half keeps its tokens
  // from the vs-edge up to the first junk token — which lets a name span
  // several tokens ("the-golden-horde") while "cache_12_33_…" falls away.
  const leftTokens = m[1].split(/[-_. ]+/).filter(Boolean);
  let start = leftTokens.length;
  while (start > 0 && !isJunkToken(leftTokens[start - 1])) start -= 1;
  const left = leftTokens.slice(start);
  const rightTokens = m[2].split(/[-_. ]+/).filter(Boolean);
  let end = 0;
  while (end < rightTokens.length && !isJunkToken(rightTokens[end])) end += 1;
  const right = rightTokens.slice(0, end);
  if (!left.length || !right.length) return null;
  const display = (tokens) => tokens.join(' ');
  const t1 = { raw: display(left), key: normName(display(left)) };
  const t2 = { raw: display(right), key: normName(display(right)) };
  if (!t1.key || !t2.key || t1.key === t2.key) return null;
  return [t1, t2];
}

/** "TheGoldenHorde" → "The Golden Horde"; "eac" → "EAC"; "m0kasyny" → "m0kasyny". */
export function displayNameForToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/[a-z][A-Z]/.test(s)) return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  if (/^[a-z0-9]+$/.test(s) && s.length <= 4 && !/\d/.test(s)) return s.toUpperCase();
  return s;
}

/** Does one normalized name contain the other as a whole ("spirit" ⊂ "teamspirit")? */
function nameVariant(a, b) {
  if (!a || !b || a === b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Every side, in the library, that a hand-rename should carry with it.
 *
 * The seed is one side of one demo: the roster the admin just put a name to.
 * Any UNNAMED side sharing `minShared` of those players is the same team under
 * a parser-invented label, so it takes the name too.
 *
 * Deliberately one hop from the seed rather than transitive. Chaining
 * three-man cores walks a roster off its own identity in a few steps — A shares
 * three with B, B shares three with C, and C has nobody the admin ever looked
 * at. Every target here shares its core with the lineup that was actually named.
 *
 * @param {object[]} records   the library
 * @param {string} seedDemoId  demo the admin renamed
 * @param {1|2} seedSide
 * @param {{ minShared?: number }} [opts]
 * @returns {Array<{ demoId: string, side: 1|2, name: string, shared: number }>}
 */
export function findRenameTargets(records, seedDemoId, seedSide, opts = {}) {
  const minShared = opts.minShared ?? RENAME_CORE_SHARED;
  const seed = (records || []).find((r) => r.id === seedDemoId);
  if (!seed) return [];
  const sideOf = (r, side) =>
    (Array.isArray(r.players) ? r.players : []).filter((p) => (p?.team === 2 ? 2 : 1) === side);
  const core = new Set(sideOf(seed, seedSide).map((p) => String(p?.id || '')).filter(Boolean));
  if (core.size < minShared) return [];

  const out = [];
  for (const r of records || []) {
    for (const side of [1, 2]) {
      if (r.id === seedDemoId && side === seedSide) continue;
      const players = sideOf(r, side);
      const name = String((side === 1 ? r.team1 : r.team2)?.name || '').trim();
      // A side the demo actually named belongs to whoever owns that name.
      if (!isPlaceholderName(name, players)) continue;
      let shared = 0;
      for (const p of players) if (core.has(String(p?.id || ''))) shared += 1;
      if (shared >= minShared) out.push({ demoId: r.id, side, name, shared });
    }
  }
  return out;
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

/**
 * Build the identity table for a library.
 *
 * @param {object[]} records  demo records: { id, filename, uploadedAt,
 *   team1: {id,name}, team2: {id,name}, players: [{id,name,team}] }
 * @param {{ onProgress?: (p: object) => void }} [opts]
 * @returns {{
 *   teams: Array<{ id, name, aliases, demos, players }>,
 *   renames: Record<string, { team1?: string, team2?: string }>,
 *   summary: { lineups, groups, namedGroups, renamedDemos }
 * }}
 */
export function buildTeamIdentity(records, opts = {}) {
  // ---- lineups --------------------------------------------------------------
  const lineups = [];
  for (const r of records || []) {
    const roster = Array.isArray(r.players) ? r.players : [];
    for (const side of [1, 2]) {
      const team = side === 1 ? r.team1 : r.team2;
      const sidePlayers = roster.filter((p) => (p?.team === 2 ? 2 : 1) === side);
      const players = new Set(sidePlayers.map((p) => String(p?.id || '')).filter(Boolean));
      const name = String(team?.name || '').trim();
      lineups.push({
        demo: r.id,
        side,
        name,
        norm: normName(name),
        placeholder: isPlaceholderName(name, sidePlayers),
        uploadedAt: Number(r.uploadedAt) || 0,
        players
      });
    }
  }

  const uf = new UnionFind(lineups.length);

  // Same proper name → same identity. Placeholders never merge by name: two
  // teams can both end up labelled after a player who changed sides.
  const byName = new Map();
  for (let i = 0; i < lineups.length; i++) {
    const l = lineups[i];
    if (l.placeholder || !l.norm) continue;
    const prev = byName.get(l.norm);
    if (prev !== undefined) uf.union(i, prev);
    else byName.set(l.norm, i);
  }

  // ---- roster overlap -------------------------------------------------------
  // Inverted index player → lineups, then shared counts for co-occurring pairs.
  const byPlayer = new Map();
  for (let i = 0; i < lineups.length; i++) {
    for (const p of lineups[i].players) {
      let list = byPlayer.get(p);
      if (!list) byPlayer.set(p, (list = []));
      list.push(i);
    }
  }
  const shared = new Map(); // "a:b" (a<b) → count
  for (const list of byPlayer.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const key = `${list[x]}:${list[y]}`;
        shared.set(key, (shared.get(key) || 0) + 1);
      }
    }
  }
  for (const [key, n] of shared) {
    const [a, b] = key.split(':').map(Number);
    const A = lineups[a];
    const B = lineups[b];
    if (n >= ORG_MERGE_SHARED) {
      // Rule 1: the roster IS the team.
      uf.union(a, b);
      continue;
    }
    if ((A.placeholder || B.placeholder) && n >= UNNAMED_MERGE_SHARED) {
      // An unnamed lineup has no name claim of its own; four shared players is
      // enough to hand it the other lineup's identity.
      uf.union(a, b);
      continue;
    }
    if (
      !A.placeholder &&
      !B.placeholder &&
      n >= VARIANT_MERGE_SHARED &&
      nameVariant(A.norm, B.norm)
    ) {
      // Rule 2: "Spirit" / "Team Spirit".
      uf.union(a, b);
    }
  }

  // ---- groups ---------------------------------------------------------------
  const groupOf = new Map(); // root → group index
  const groups = [];
  const groupIndex = new Array(lineups.length);
  for (let i = 0; i < lineups.length; i++) {
    const root = uf.find(i);
    let g = groupOf.get(root);
    if (g === undefined) {
      g = groups.length;
      groupOf.set(root, g);
      groups.push({ lineups: [], demos: new Set() });
    }
    groups[g].lineups.push(i);
    groups[g].demos.add(lineups[i].demo);
    groupIndex[i] = g;
  }

  // Proper-name votes per group: the canonical name is the most RECENT proper
  // name (an organisation's current name wins over its history), the rest
  // become aliases.
  const canon = groups.map((g) => {
    let bestName = '';
    let bestAt = -1;
    const aliases = new Map(); // norm → display
    for (const li of g.lineups) {
      const l = lineups[li];
      if (l.placeholder || !l.name) continue;
      aliases.set(l.norm, l.name);
      if (l.uploadedAt > bestAt) {
        bestAt = l.uploadedAt;
        bestName = l.name;
      }
    }
    return { name: bestName, aliases };
  });

  // ---- filename claims ------------------------------------------------------
  // token → { demos: Set, byGroup: Map(group → demo count) } over the demos
  // whose filename carries it. A token that rides with one squad across
  // matchups is that squad's name (strictly more of its demos than any other
  // group's); a pure Bo3 leaves both tokens tied and unclaimed, exactly as it
  // should until another matchup breaks the tie.
  const demoTokens = new Map(); // demoId → [t1, t2]
  const demoGroups = new Map(); // demoId → [g1, g2]
  for (const r of records || []) {
    const t = filenameTeams(r.filename);
    if (t) demoTokens.set(r.id, t);
  }
  for (let i = 0; i < lineups.length; i++) {
    const l = lineups[i];
    let pair = demoGroups.get(l.demo);
    if (!pair) demoGroups.set(l.demo, (pair = [null, null]));
    pair[l.side - 1] = groupIndex[i];
  }

  const tokenStats = new Map();
  for (const [demo, tokens] of demoTokens) {
    const pair = demoGroups.get(demo);
    if (!pair) continue;
    for (const t of tokens) {
      let st = tokenStats.get(t.key);
      if (!st) tokenStats.set(t.key, (st = { raw: t.raw, demos: new Set(), byGroup: new Map() }));
      st.demos.add(demo);
      for (const g of pair) {
        if (g === null) continue;
        st.byGroup.set(g, (st.byGroup.get(g) || 0) + 1);
      }
    }
  }

  /** group → claimed token key */
  const claimedBy = new Map(); // token key → group
  const groupToken = new Map(); // group → { key, raw }

  const claim = (tokenKey, g, raw) => {
    if (claimedBy.has(tokenKey) || groupToken.has(g)) return false;
    claimedBy.set(tokenKey, g);
    groupToken.set(g, { key: tokenKey, raw });
    return true;
  };

  // Seed 1: a token that matches a group's existing proper name (or variant).
  const properByNorm = new Map(); // norm name → group (unique holders only)
  for (let g = 0; g < groups.length; g++) {
    for (const norm of canon[g].aliases.keys()) {
      if (properByNorm.has(norm) && properByNorm.get(norm) !== g) properByNorm.set(norm, -1);
      else properByNorm.set(norm, g);
    }
  }
  for (const [key, st] of tokenStats) {
    for (const [norm, g] of properByNorm) {
      if (g < 0) continue;
      if (key === norm || nameVariant(key, norm)) {
        // Only when the demos agree: the named group actually appears there.
        if (st.byGroup.has(g)) claim(key, g, st.raw);
        break;
      }
    }
  }

  // Seed 2: dominance across matchups.
  for (const [key, st] of tokenStats) {
    if (claimedBy.has(key)) continue;
    if (st.demos.size < TOKEN_CLAIM_MIN_DEMOS) continue;
    let best = -1;
    let bestN = 0;
    let secondN = 0;
    for (const [g, n] of st.byGroup) {
      if (n > bestN) {
        secondN = bestN;
        bestN = n;
        best = g;
      } else if (n > secondN) {
        secondN = n;
      }
    }
    if (best >= 0 && bestN >= TOKEN_CLAIM_MIN_DEMOS && bestN > secondN) {
      claim(key, best, st.raw);
    }
  }

  // Elimination, to a fixed point: in a demo whose one token is claimed by one
  // side, the other token names the other side.
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const [demo, tokens] of demoTokens) {
      const pair = demoGroups.get(demo);
      if (!pair || pair[0] === null || pair[1] === null || pair[0] === pair[1]) continue;
      const owner0 = claimedBy.get(tokens[0].key);
      const owner1 = claimedBy.get(tokens[1].key);
      if (owner0 !== undefined && owner1 === undefined) {
        const other = owner0 === pair[0] ? pair[1] : owner0 === pair[1] ? pair[0] : null;
        if (other !== null && claim(tokens[1].key, other, tokens[1].raw)) moved = true;
      } else if (owner1 !== undefined && owner0 === undefined) {
        const other = owner1 === pair[0] ? pair[1] : owner1 === pair[1] ? pair[0] : null;
        if (other !== null && claim(tokens[0].key, other, tokens[0].raw)) moved = true;
      }
    }
    if (!moved) break;
  }

  // A claimed token names a group that had no proper name of its own.
  for (const [g, token] of groupToken) {
    if (!canon[g].name) canon[g].name = displayNameForToken(token.raw);
    else canon[g].aliases.set(token.key, displayNameForToken(token.raw));
  }

  // ---- output ---------------------------------------------------------------
  const renames = {};
  let renamedDemos = 0;
  for (let i = 0; i < lineups.length; i++) {
    const l = lineups[i];
    const name = canon[groupIndex[i]].name;
    if (!name || l.name === name) continue;
    // Placeholders always take the identity's name; proper names move only
    // when the group actually holds several variants (rules 1/2 linked them).
    if (!l.placeholder && canon[groupIndex[i]].aliases.size < 2) continue;
    let entry = renames[l.demo];
    if (!entry) renames[l.demo] = entry = {};
    entry[l.side === 1 ? 'team1' : 'team2'] = name;
  }
  renamedDemos = Object.keys(renames).length;

  const playerNames = new Map();
  for (const r of records || []) {
    for (const p of r.players || []) {
      if (p?.id && p?.name) playerNames.set(String(p.id), String(p.name));
    }
  }
  const teams = [];
  for (let g = 0; g < groups.length; g++) {
    const players = new Map();
    for (const li of groups[g].lineups) {
      for (const p of lineups[li].players) players.set(p, (players.get(p) || 0) + 1);
    }
    const name = canon[g].name;
    teams.push({
      id: `t${g}`,
      name: name || lineups[groups[g].lineups[0]].name || '',
      named: Boolean(name),
      aliases: [...canon[g].aliases.values()].filter((a) => a !== name),
      demos: [...groups[g].demos],
      players: [...players.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([id, games]) => ({ id, name: playerNames.get(id) || id, games }))
    });
  }

  opts.onProgress?.({ phase: 'built', groups: groups.length });
  return {
    teams,
    renames,
    summary: {
      lineups: lineups.length,
      groups: groups.length,
      namedGroups: canon.filter((c) => c.name).length,
      renamedDemos
    }
  };
}
