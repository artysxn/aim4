// ---------------------------------------------------------------------------
// replays/shared/statsColumns.js
// Which columns of a stats index a caller actually needs.
//
// GET /stats used to ship every column of every round to every page. At 4100
// demos that is ~785 MB walked, serialized and reparsed so the Performance page
// can draw six cards. Callers now declare a column contract and the server
// projects each round row down to it.
//
// The one rule that matters: A4R substitutes league-average constants for
// missing terms (see aim4RatingBreakdown), so a payload missing `du` or `am`
// does not produce a null rating — it produces a WRONG one, silently, and every
// page sorts by it. RATING_CORE is therefore an all-or-nothing bundle:
// `resolveColumns` refuses a contract that asks for ratings without it.
// ---------------------------------------------------------------------------

/**
 * Round-row keys carried on every projection. Identity, sides, buy and timing:
 * the columns `rowPasses` filters on, so a projected payload still honours
 * every map / side / economy / date filter the UI offers.
 */
export const IDENTITY_ROW_KEYS = Object.freeze([
  'f', 'd', 'm', 'n', 'w', 's1', 's2', 'e1', 'e2', 'dur', 'pt',
  // Baseline, not an optional group: `p` is the kill/death/damage line every
  // consumer reads, and ok/od are five bytes. Making them optional would only
  // create contracts that cannot render anything.
  'p', 'ok', 'od'
]);

/** Top-level entry keys carried on every projection. */
export const IDENTITY_ENTRY_KEYS = Object.freeze([
  'id', 'v', 'key', 'map', 'mapName', 't1', 't2',
  'name1', 'name2', 'winner', 'uploadedAt', 'players'
]);

/**
 * Column groups, keyed by the round-row fields each one owns.
 * `entry` lists top-level keys the group brings with it.
 *
 * `bytes` is the measured mean cost per round on the current index format,
 * used only for the payload's size report and for tests that guard against a
 * group quietly becoming the next 2 KB column.
 */
export const COLUMN_GROUPS = Object.freeze({
  coreOpenings: { rows: ['cok', 'cod'],                bytes: 9    },
  swing:        { rows: ['sw'],                        bytes: 210  },
  prw:          { rows: ['prw1', 'prw2'],              bytes: 35   },
  kills:        { rows: ['kt', 'ev'],                  bytes: 407  },
  aim:          { rows: ['am'],                        bytes: 1996 },
  duels:        { rows: ['du'],                        bytes: 2231 },
  utility:      { rows: ['ut', 'utt'],                 bytes: 1234 },
  movement:     { rows: ['mv'],                        bytes: 301  },
  awpHold:      { rows: ['aw'],                        bytes: 81   },
  heldGun:      { rows: ['hg'],                        bytes: 72   },
  phase:        { rows: ['ph'],                        bytes: 1143 },
  roundLibrary: { rows: ['rl'],                        bytes: 81   },
  possession:   { rows: ['pos1', 'pos2'],              bytes: 34   },
  anchor:       { rows: ['aca1', 'ack1', 'aca2', 'ack2'], bytes: 4 },
  roles:        { rows: [], entry: ['roles'],          bytes: 55   }
});

export const COLUMN_GROUP_IDS = Object.freeze(Object.keys(COLUMN_GROUPS));

/** Measured cost of the baseline row keys (identity + scoreboard + openings). */
const BASELINE_BYTES = 414;

/**
 * The groups aim4RatingBreakdown reads. Asking for a subset yields a rating
 * built from league averages standing in for the missing terms — a plausible
 * number that is not this player's. All or nothing.
 */
export const RATING_CORE = Object.freeze(['swing', 'kills', 'aim', 'duels']);

/**
 * The groups A4R alone depends on — the ones aim4RatingBreakdown replaces with
 * league averages when they are missing.
 *
 * `kills` is deliberately not here. It feeds Rating 3.0, and bucketRating
 * degrades honestly without it (the neutral-economy form of the same formula,
 * not a fabricated constant), so asking for `kills` on its own is a legitimate
 * Rating-3.0 contract. The hazard is asking for *some* of these three: that
 * still renders an A4R, quietly pulled toward the mean.
 */
const A4R_ONLY = Object.freeze(['swing', 'aim', 'duels']);
const RATING_BEARING = new Set(A4R_ONLY);

/**
 * Named contracts. A page names one instead of listing columns, so "what does
 * Performance need" has one answer that moves with the page.
 */
export const COLUMN_PRESETS = Object.freeze({
  /** Performance, player profile: Rating 3.0 plus role / held-gun columns. */
  rating: [...RATING_CORE, 'coreOpenings', 'roles', 'heldGun'],
  /** Rating plus every Premium metric column the Database table adds. */
  full: [...COLUMN_GROUP_IDS],
  /** Round list, antistrat: round shapes, no player metrics at all. */
  shapes: ['phase', 'roundLibrary'],
  /**
   * Pattern Finder: round shapes, team identity, exact Rating 3.0 and utility.
   * No aim, duels, movement or AWP-hold — a third of the payload it used to
   * pull, and none of it reaches the screen. `ratingReady` stays false, so
   * nothing built from this may render A4R.
   */
  patterns: ['phase', 'roundLibrary', 'kills', 'utility'],
  /** Team tables: team-level rates, no per-player rating. */
  team: ['prw', 'possession', 'anchor', 'utility'],
  /** Match cards / listings: who played and who won. Baseline only. */
  identity: []
});

export class ColumnContractError extends Error {}

/**
 * Resolve a requested contract into the concrete key sets to keep.
 *
 * @param {string[]|string|null|undefined} requested group ids, a preset name,
 *   or null for the full set (back-compat: an old client sending no `fields`
 *   still gets everything).
 * @returns {{
 *   groups: string[],
 *   rowKeys: Set<string>,
 *   entryKeys: Set<string>,
 *   all: boolean,
 *   bytesPerRound: number
 * }}
 */
export function resolveColumns(requested) {
  if (requested == null || requested === '') {
    return {
      groups: [...COLUMN_GROUP_IDS],
      rowKeys: null,
      entryKeys: null,
      all: true,
      ratingReady: true,
      worthColumnar: false,
      bytesPerRound:
        BASELINE_BYTES + COLUMN_GROUP_IDS.reduce((n, g) => n + COLUMN_GROUPS[g].bytes, 0)
    };
  }

  const raw = Array.isArray(requested)
    ? requested
    : String(requested).split(',');
  const wanted = new Set();
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id) continue;
    if (COLUMN_PRESETS[id]) {
      for (const g of COLUMN_PRESETS[id]) wanted.add(g);
      continue;
    }
    if (!COLUMN_GROUPS[id]) {
      throw new ColumnContractError(
        `Unknown stats column group "${id}". Known groups: ${COLUMN_GROUP_IDS.join(', ')}. ` +
          `Known presets: ${Object.keys(COLUMN_PRESETS).join(', ')}.`
      );
    }
    wanted.add(id);
  }

  // The guard. Partial rating input is worse than none: the number still
  // renders, still sorts, and is quietly pulled toward the league mean.
  const bearing = [...wanted].filter((g) => RATING_BEARING.has(g));
  if (bearing.length && !RATING_CORE.every((g) => wanted.has(g))) {
    const missing = RATING_CORE.filter((g) => !wanted.has(g));
    throw new ColumnContractError(
      `Incomplete rating contract: asked for ${bearing.join(', ')} but not ${missing.join(', ')}. ` +
        `A4R substitutes league averages for missing terms, so a partial set yields a ` +
        `plausible but wrong rating instead of a null one. Request the "rating" preset, ` +
        `or drop the rating columns entirely and use "shapes".`
    );
  }

  const rowKeys = new Set(IDENTITY_ROW_KEYS);
  const entryKeys = new Set(IDENTITY_ENTRY_KEYS);
  let bytesPerRound = BASELINE_BYTES;
  for (const g of wanted) {
    const def = COLUMN_GROUPS[g];
    for (const k of def.rows) rowKeys.add(k);
    for (const k of def.entry || []) entryKeys.add(k);
    bytesPerRound += def.bytes;
  }

  const fullBytes =
    BASELINE_BYTES + COLUMN_GROUP_IDS.reduce((n, g) => n + COLUMN_GROUPS[g].bytes, 0);
  return {
    groups: [...wanted].sort(),
    rowKeys,
    entryKeys,
    all: wanted.size === COLUMN_GROUP_IDS.length,
    ratingReady: RATING_CORE.every((g) => wanted.has(g)),
    bytesPerRound,
    /**
     * Whether reading this contract column-by-column beats parsing the whole
     * index. Seeking to a block costs a read and a header parse, so a contract
     * that wants most of the file pays that overhead for nothing — measured at
     * ~0.9x for the `rating` preset (65% of the bytes) against 5.9x for
     * `patterns` (39%). Half the file is where the two cross over.
     */
    worthColumnar: bytesPerRound <= fullBytes * 0.5
  };
}

/**
 * Project one stored index down to a resolved contract.
 * Returns the entry untouched when the contract is the full set, so the common
 * admin / charts path pays nothing.
 *
 * @param {object} entry
 * @param {ReturnType<typeof resolveColumns>} contract
 */
export function projectEntry(entry, contract) {
  if (!entry || contract.all || !contract.rowKeys) return entry;
  const out = {};
  for (const k of contract.entryKeys) {
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
  out.rounds = rounds.map((row) => {
    const r = {};
    for (const k of contract.rowKeys) {
      if (row[k] !== undefined) r[k] = row[k];
    }
    return r;
  });
  // Legacy flags the aggregator still reads. Cheap, and their absence would
  // read as "geography present" on old client builds.
  out.positions = false;
  out.pz = 0;
  return out;
}

/**
 * Does a cached payload satisfy a contract? Used by the client cache so a
 * narrow page can reuse what a wide one already pulled instead of refetching.
 *
 * @param {string[]|null} held groups the cached payload carries (null = all)
 * @param {string[]} needed
 */
export function columnsSatisfy(held, needed) {
  if (held == null) return true;
  const have = new Set(held);
  return needed.every((g) => have.has(g));
}

/** True when at least one round carries the held-gun map. */
export function payloadHasHeldGun(payload) {
  for (const d of payload?.demos || []) {
    for (const r of d.rounds || []) {
      if (r && typeof r.hg === 'object' && r.hg) return true;
    }
  }
  return false;
}

/** Cached payload is usable for this contract. */
export function payloadCovers(payload, held, needed) {
  if (!columnsSatisfy(held, needed)) return false;
  if (!needed.includes('heldGun')) return true;
  // Full-library payloads name every group but do not wait for tick hold time.
  if (held == null || held.length === COLUMN_GROUP_IDS.length) return true;
  return payloadHasHeldGun(payload);
}
