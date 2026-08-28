// ---------------------------------------------------------------------------
// replays/stats/columnCatalog.js
// What every Database column IS, and what it costs to download.
//
// Two jobs, deliberately in one file so they cannot drift apart:
//
//  1. The Columns picker: each entry carries a plain-language description, so
//     someone who has never seen "PSDT" learns what it measures before
//     deciding whether to keep it.
//  2. The wire contract: each entry names the column groups (statsColumns.js)
//     its numbers are computed from. The Database's raw-library fallback asks
//     the server for exactly the groups the ENABLED columns need, so turning
//     a column off genuinely shrinks the download, not just the table.
//
// The mapping mirrors what statsMath.js actually reads per column (verified
// against aggregatePlayers/aggregateTeams). An empty `groups` list means the
// column is computed from the baseline row (identity, the per-player
// scoreboard line, opening kill/death) that every payload carries.
// ---------------------------------------------------------------------------

import { COLUMN_GROUP_IDS, RATING_CORE } from '../shared/statsColumns.js';

/**
 * Groups the Database asks for regardless of column choices. `roundLibrary`
 * feeds the round-call and round-window filters; `roles` feeds the role
 * filter. Both are ~1% of the payload, and losing a filter because a column
 * was hidden would read as a bug.
 */
export const STATS_ALWAYS_GROUPS = Object.freeze(['roundLibrary', 'roles']);

/**
 * Groups no Database column or filter reads at all. `phase` exists for the
 * Pattern Finder and `heldGun` for the gun pages; before this catalogue the
 * Database downloaded both with every round.
 */
export const STATS_UNUSED_GROUPS = Object.freeze(['phase', 'heldGun']);

/**
 * One picker entry.
 * @typedef {{
 *   key: string,
 *   keys?: string[],
 *   label: string,
 *   about: string,
 *   groups: string[]
 * }} ColumnInfo
 * `key` is the entry's identity in saved preferences. `keys` lists the table
 * column keys it controls when one entry covers several columns (multi-kills);
 * absent means the entry controls the column with its own key.
 */

const RATING_GROUPS = [...RATING_CORE, 'coreOpenings'];

/** @type {ColumnInfo[]} */
export const PLAYER_COLUMN_INFO = [
  {
    key: 'roleT',
    label: 'T role',
    about:
      'The tactical role the player most often takes on the T side, judged from where they play and what they do. With one map selected this becomes their position on that map.',
    groups: ['roles']
  },
  {
    key: 'roleCT',
    label: 'CT role',
    about:
      'The tactical role the player most often takes on the CT side. With one map selected this becomes their position on that map.',
    groups: ['roles']
  },
  {
    key: 'rating',
    label: 'Rating',
    about:
      'Aim4 Rating 3.0, the headline per-round performance number. Kills, deaths, damage, trades, clutch play and round swing weighed together. 1.00 is league average.',
    groups: RATING_GROUPS
  },
  {
    key: 'expectedRating',
    label: 'xRtg',
    about:
      'Expected rating. What the rating model expects from this player given the level of their team in recent games. Empty when no team accounts for a clear majority of their recent games.',
    groups: RATING_GROUPS
  },
  {
    key: 'expectedRatingOp',
    label: 'xRtg%',
    about:
      'Expected rating overperformance. How far the player sits above or below their expected rating, in percent.',
    groups: RATING_GROUPS
  },
  {
    key: 'trueRating',
    label: 'True',
    about:
      'True rating. Rating and expected rating combined into one number, so a player beating strong expectations ranks above one coasting on weak ones.',
    groups: RATING_GROUPS
  },
  {
    key: 'a4r',
    label: 'A4R',
    about:
      'Aim4 Round rating. A second rating built from twelve per-round terms, including swing in won and lost rounds, openings and a core duel score, with a small bonus for rounds played.',
    groups: RATING_GROUPS
  },
  {
    key: 'prwSwing',
    label: 'Swing',
    about:
      'Average predicted-win swing per round. How much the player’s kills, deaths and damage moved their team’s predicted chance of winning each round.',
    groups: ['swing']
  },
  {
    key: 'kd',
    label: 'KD',
    about: 'Kills divided by deaths.',
    groups: []
  },
  {
    key: 'xk',
    label: 'xK',
    about:
      'Expected kills per round. The duel model sums its win chance across every fight the player took, so a 50/50 fight adds 0.50. Compare with actual kills to see who wins more than their fights predict.',
    groups: ['duels']
  },
  {
    key: 'tfw',
    label: 'Duel Win%',
    about: 'Total fight winrate. Kills as a share of kills plus deaths.',
    groups: []
  },
  {
    key: 'adr',
    label: 'ADR',
    about: 'Average damage per round.',
    groups: []
  },
  {
    key: 'kast',
    label: 'KAST',
    about:
      'Share of rounds with a kill, an assist, surviving the round, or a death a teammate traded.',
    groups: []
  },
  {
    key: 'opkd',
    label: 'OPKD',
    about:
      'Opening kill/death difference. Rounds where the player took the first kill minus rounds where they died first.',
    groups: []
  },
  {
    key: 'impact',
    label: 'Impact',
    about: 'Kills and assists per round weighed into one output number.',
    groups: []
  },
  {
    key: 'a4or',
    label: 'A4OR',
    about:
      'Aim4 opening rating. 1.00 plus the opening kill/death difference, swing and opening attempts weighed together: how dangerous the player is in the first fight of a round.',
    groups: ['swing']
  },
  {
    key: 'opatt',
    label: 'Opatt',
    about:
      'Opening attempts per round. How often the player is in the round’s first fight at all, on either end of it.',
    groups: []
  },
  {
    key: 'copatt',
    label: 'Copatt',
    about:
      'Core opening attempts per round. Like Opatt, but only counting openings after 1:30, once the round has settled into its real attack.',
    groups: ['coreOpenings']
  },
  {
    key: 'opkRate',
    label: 'OR',
    about:
      'Opening success rate. Of the round-opening fights the player was in, the share they won.',
    groups: []
  },
  {
    key: 'pfw',
    label: 'PFW',
    about:
      'Predicted fight winrate. The duel model’s average win chance across the player’s fights. It measures how hard their fights were, not how they did in them.',
    groups: ['duels']
  },
  {
    key: 'pfo',
    label: 'PFO',
    about:
      'Predicted fight overperformance. Actual duel winrate minus what the model predicted, in points, already adjusted for how difficult the fights were.',
    groups: ['duels']
  },
  {
    key: 'a4aim',
    label: 'Aim',
    about:
      'Aim rating out of 100, combining crosshair placement, readiness, accuracy, first-bullet hits and flick control.',
    groups: ['aim']
  },
  {
    key: 'accuracy',
    label: 'Acc',
    about:
      'Accuracy. Hits as a share of shots fired, with headshot share and AWP accuracy in the tooltip.',
    groups: []
  },
  {
    key: 'aimCrosshair',
    label: 'C°',
    about:
      'Crosshair placement. Mean horizontal error, in degrees, between the crosshair and the enemy when a fight starts. Shown negative because lower error is better. Around -30° is average.',
    groups: ['aim']
  },
  {
    key: 'aimReady',
    label: 'R%',
    about:
      'Readiness. Share of fights where the crosshair was already inside the engagement cone when the enemy appeared. A typical band is 60 to 70%.',
    groups: ['aim']
  },
  {
    key: 'aimAcc',
    label: 'AA%',
    about:
      'Aim accuracy. Hits as a share of shots during engagements, with shots through smoke excluded. Typical range is 15 to 40%.',
    groups: ['aim']
  },
  {
    key: 'aimFirst',
    label: '1st%',
    about:
      'First bullet. Share of fights where the very first bullet hit while the enemy was in the cone. Typical range is 15 to 50%.',
    groups: ['aim']
  },
  {
    key: 'aimOverflick',
    label: 'O%',
    about:
      'Overflick. First-bullet misses that swung past the enemy, judged from the yaw at the shot against the yaw a moment earlier.',
    groups: ['aim']
  },
  {
    key: 'aimUnderflick',
    label: 'U%',
    about: 'Underflick. First-bullet misses that stopped short of the enemy.',
    groups: ['aim']
  },
  {
    key: 'dt',
    label: 'DT',
    about:
      'Distance travelled. Average units moved per round, as raw path length that resets on death. Counts every step, including in-place strafing jitter.',
    groups: ['movement']
  },
  {
    key: 'psdt',
    label: 'PSDT',
    about:
      'Pulled-string distance travelled. An upgraded distance travelled that aims to measure rotations rather than how much a player taps any movement key at any time: the path is smoothed with a 125-unit brush, so in-place jitter is filtered out and real map movement remains.',
    groups: ['movement']
  },
  {
    key: 'heDmg',
    label: 'HE dmg',
    about: 'Average damage per HE grenade thrown. Enemy damage only.',
    groups: ['utility']
  },
  {
    key: 'blind',
    label: 'Blind/flash',
    about:
      'Average enemy blind time each flashbang causes. Flashes that blinded nobody still count in the average.',
    groups: ['utility']
  },
  {
    key: 'utilDmg',
    label: 'Util dmg',
    about:
      'All grenade damage per round: HE, molotov and incendiary. Enemy damage only.',
    groups: ['utility']
  },
  {
    key: 'multikills',
    keys: ['mk5', 'mk4', 'mk3', 'mk2', 'mk1', 'mk0'],
    label: '5k … 0k',
    about:
      'Multi-kill rounds. The share of rounds with exactly five, four, three, two, one or zero kills, one column per count.',
    groups: []
  },
  {
    key: 'akpr',
    label: 'aKPR',
    about:
      'AWP kills per round, counting only rounds where the player held the AWP as their primary weapon for at least 10 seconds.',
    groups: ['awpHold']
  }
];

/** @type {ColumnInfo[]} */
export const TEAM_COLUMN_INFO = [
  {
    key: 'roundWinrate',
    label: 'Round WR',
    about: 'Share of rounds won.',
    groups: []
  },
  {
    key: 'avgRating',
    label: 'Avg rating',
    about: 'The side’s players’ Rating 3.0 averaged over the rounds in range.',
    groups: RATING_GROUPS
  },
  {
    key: 'teamPfw',
    label: 'PFW',
    about:
      'Team predicted fight winrate. The five players’ PFW averaged: how hard the side’s duels were.',
    groups: ['duels']
  },
  {
    key: 'teamPfo',
    label: 'PFO',
    about:
      'Team predicted fight overperformance. How far the side beat the odds its fights carried, in points.',
    groups: ['duels']
  },
  {
    key: 'teamXk',
    label: 'xK',
    about: 'Team expected kills. The five players’ expected kills per round averaged.',
    groups: ['duels']
  },
  {
    key: 'possession',
    label: 'Poss%',
    about:
      'Possession. Share of the map’s ground the side held, sampled through the round. The tooltip compares against each map’s CT and T baselines.',
    groups: ['possession']
  },
  {
    key: 'prw',
    label: 'PRW',
    about:
      'Predicted round winrate. The win probability model’s average view of the side’s rounds, sampled every 4 seconds from the kill log.',
    groups: ['prw']
  },
  {
    key: 'ac',
    label: 'AC%',
    about:
      'Advantage conversion. Of the moments the model rated the side above 51% to win the round, the share where its chance never later fell below 50%. Not tied to the actual round winner.',
    groups: ['anchor']
  },
  {
    key: 'mapWinrate',
    label: 'Win%',
    about: 'Share of maps won.',
    groups: []
  },
  {
    key: 'opkRate',
    label: 'OPK rate',
    about: 'Opening kill rate. The share of rounds where the side took the first kill.',
    groups: []
  },
  {
    key: 'conv5v4',
    label: '5v4',
    about: 'Of rounds where the side took the opening kill, the share it went on to win.',
    groups: []
  },
  {
    key: 'conv4v5',
    label: '4v5',
    about: 'Of rounds where the side gave up the opening kill, the share it still won.',
    groups: []
  },
  {
    key: 'utilDmg',
    label: 'Util dmg',
    about: 'The side’s average grenade damage per round. Enemy damage only.',
    groups: ['utility']
  }
];

const ENTRY_INDEX = (() => {
  const map = new Map();
  for (const info of PLAYER_COLUMN_INFO) map.set(`players:${info.key}`, info);
  for (const info of TEAM_COLUMN_INFO) map.set(`teams:${info.key}`, info);
  return map;
})();

/**
 * Preference ids are `players:<key>` / `teams:<key>` so a key both tables use
 * (utilDmg, opkRate) can be toggled per table.
 */
export function columnPrefId(table, key) {
  return `${table}:${key}`;
}

/** Drop unknown ids so a stale saved preference cannot wedge the picker. */
export function normalizeDisabledColumns(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    const clean = String(id || '').trim();
    if (ENTRY_INDEX.has(clean) && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * Table column keys to hide, per table, for a disabled-entry list.
 * @returns {{ players: Set<string>, teams: Set<string> }}
 */
export function hiddenColumnKeys(disabled) {
  const players = new Set();
  const teams = new Set();
  for (const id of normalizeDisabledColumns(disabled)) {
    const info = ENTRY_INDEX.get(id);
    const into = id.startsWith('teams:') ? teams : players;
    for (const k of info.keys || [info.key]) into.add(k);
  }
  return { players, teams };
}

/**
 * Remove hidden columns from a `{ columns, fixedCount }` pair, keeping the
 * sticky boundary right when a hidden column sat inside it (the role columns
 * do). Identity columns are not in the catalogue and can never be hidden.
 */
export function dropHiddenColumns({ columns, fixedCount }, hiddenKeys) {
  if (!hiddenKeys || !hiddenKeys.size) return { columns, fixedCount };
  let fixed = fixedCount;
  const kept = [];
  columns.forEach((c, i) => {
    if (hiddenKeys.has(c.key)) {
      if (i < fixedCount) fixed -= 1;
      return;
    }
    kept.push(c);
  });
  return { columns: kept, fixedCount: Math.max(1, fixed) };
}

/**
 * The wire contract for the Database's raw-library download: the groups the
 * ENABLED columns need, plus the always-on filter groups. Asking for any part
 * of the rating input set pulls in all of RATING_CORE, because the server
 * refuses partial rating contracts (a partial set yields a plausible but
 * wrong rating, see statsColumns.js).
 *
 * @param {string[]} disabled disabled entry ids (`players:psdt`, ...)
 * @returns {string[]} sorted group ids
 */
export function databaseColumnGroups(disabled) {
  const off = new Set(normalizeDisabledColumns(disabled));
  const wanted = new Set(STATS_ALWAYS_GROUPS);
  for (const [id, info] of ENTRY_INDEX) {
    if (off.has(id)) continue;
    for (const g of info.groups) wanted.add(g);
  }
  const core = new Set(RATING_CORE);
  for (const g of wanted) {
    if (core.has(g)) {
      for (const c of RATING_CORE) wanted.add(c);
      break;
    }
  }
  // Stable order, and only known groups (belt and braces for the request).
  return COLUMN_GROUP_IDS.filter((g) => wanted.has(g));
}
