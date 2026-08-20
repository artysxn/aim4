// ---------------------------------------------------------------------------
// replays/strategy/addStrategy.js
// Turn one bookmarked round into a stratbook row.
//
// The order below is forced by how a stratbook note links a grenade. `<!abcd>`
// is an id the utility archive owns, so the archive has to be written FIRST and
// the notes written around the ids that came back. Doing it the other way round
// produces notes pointing at throws that do not exist.
//
//   1. fold every grenade the side threw into the team's archive for this map,
//      and save it — that mints the throw ids
//   2. seat the five bodies into the map's stratbook columns
//   3. write one note per column from the round's events, linking the ids
//   4. save the strategy
//
// A failure at step 1 stops the whole thing: half-written archives are worse
// than no strategy. A failure at step 4 leaves the archive richer than it was,
// which is harmless — the utility is real either way.
// ---------------------------------------------------------------------------

import {
  fetchUtilityArchive,
  saveTeamStrategy,
  saveUtilityArchive
} from '../api.js';
import { loadCoachSmokes } from '../coach/coachSmokes.js';
import { createNamer } from './regionNames.js';
import { foldRoundUtility } from './utilityImport.js';
import { buildRoundNotes } from './roundNarrative.js';
import {
  mergeRolesAcrossDemos,
  rolesCoverSide,
  rolesFromLoadedRounds,
  ROLE_SCAN_ROUNDS,
  seatPlayers
} from './roundRoles.js';
import { timingFor } from '../viewer/roundClock.js';

/** The viewer opens half a second before release, so the throw is watchable. */
const LEAD_SECONDS = 0.5;

/** Player ids on one side of a round, in roster order. */
export function sidePlayers(meta, side) {
  const side1 = meta?.team1Side === 'CT' ? 'CT' : 'T';
  const side2 =
    meta?.team2Side === 'CT' || meta?.team2Side === 'T'
      ? meta.team2Side
      : side1 === 'CT'
        ? 'T'
        : 'CT';
  const team = side === side1 ? 1 : side === side2 ? 2 : 0;
  if (!team) return [];
  return (meta?.players || [])
    .filter((p) => p.team === team)
    .sort((a, b) => a.slot - b.slot)
    .map((p) => p.id);
}

/**
 * Who plays which column, through the same ruleset the Statistics database runs.
 *
 * @param {object} args
 * @param {string} args.mapCode
 * @param {'T'|'CT'} args.side
 * @param {string[]} args.playerIds
 * @param {object|null} args.demoRoles     roles stored on THIS demo's stats entry
 * @param {() => Promise<object[]>} [args.libraryDemos]  every stats entry, lazily
 * @param {() => Promise<Array<{meta: object, track: object}>>} [args.loadRounds]
 *   up to ROLE_SCAN_ROUNDS rounds with tick data, for the last-resort local walk
 * @param {object|null} [args.network]
 * @returns {Promise<{ columns: string[], seats: string[], matched: number, source: string }>}
 */
export async function resolveSeats({
  mapCode,
  side,
  playerIds,
  demoRoles = null,
  libraryDemos = null,
  loadRounds = null,
  network = null
}) {
  if (demoRoles && rolesCoverSide(demoRoles, mapCode, side, playerIds)) {
    return { ...seatPlayers({ mapCode, side, playerIds, roles: demoRoles }), source: 'demo' };
  }

  // The demo on screen cannot answer on its own — the round may be the only one
  // in the package. Every other match with the same five on this map can.
  if (libraryDemos) {
    try {
      const demos = await libraryDemos();
      const merged = mergeRolesAcrossDemos(demos, mapCode, side, playerIds);
      if (merged && rolesCoverSide(merged, mapCode, side, playerIds)) {
        return { ...seatPlayers({ mapCode, side, playerIds, roles: merged }), source: 'library' };
      }
    } catch {
      /* fall through to the local walk */
    }
  }

  if (loadRounds) {
    try {
      const loaded = (await loadRounds()).slice(0, ROLE_SCAN_ROUNDS);
      if (loaded.length) {
        const local = rolesFromLoadedRounds(loaded, network, mapCode);
        return {
          ...seatPlayers({ mapCode, side, playerIds, roles: local }),
          source: loaded.length > 1 ? 'scan' : 'round'
        };
      }
    } catch {
      /* fall through to the coin-flip seating below */
    }
  }

  // Nothing said anything. Columns still get bodies, at random, because the
  // notes are the point and a coach can move a column's text sideways.
  return { ...seatPlayers({ mapCode, side, playerIds, roles: demoRoles }), source: 'none' };
}

/**
 * Build and save the strategy.
 *
 * @param {object} args
 * @param {string} args.teamId
 * @param {string} args.mapCode
 * @param {'T'|'CT'} args.side
 * @param {string} args.name
 * @param {string} args.category
 * @param {string} args.economy
 * @param {string} args.roundFile   round id, for the "watch this throw" link
 * @param {object} args.meta
 * @param {object} args.track
 * @param {object|null} args.network
 * @param {string[]} args.seats     player id per stratbook column
 * @param {(text: string) => void} [args.onStatus]
 * @returns {Promise<{ strategy: object, utilityAdded: number }>}
 */
export async function saveStrategyFromRound({
  teamId,
  mapCode,
  side,
  name,
  category,
  economy,
  roundFile,
  meta,
  track,
  network,
  seats,
  onStatus = () => {}
}) {
  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const slotOf = new Map((meta.players || []).map((p) => [p.id, p.slot]));
  const namer = createNamer(network, mapCode);
  const ids = new Set(seats.filter(Boolean));
  const scratch = {};

  const grenades = (meta.events?.grenades || [])
    .filter((g) => ids.has(g.player) && Number.isFinite(Number(g.throwTick)))
    .sort((a, b) => Number(a.throwTick) - Number(b.throwTick));

  /** Where the thrower stood at release — the setpos a viewer can teleport to. */
  const originOf = (g) => {
    const slot = slotOf.get(g.player);
    if (slot == null || slot < 0) return null;
    const s = track.sample(slot, Number(g.throwTick), scratch);
    if (!s || !Number.isFinite(s.x)) return null;
    return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
  };

  const viewTickOf = (g) => Math.max(timing.startTick, Number(g.throwTick) - LEAD_SECONDS * rate);

  onStatus('Reading utility…');
  const [stored, coach] = await Promise.all([
    fetchUtilityArchive(teamId, mapCode).catch(() => null),
    loadCoachSmokes(mapCode).catch(() => ({ utilities: [] }))
  ]);

  const folded = foldRoundUtility({
    archive: stored || { map: mapCode, updatedAt: 0, grenades: [] },
    grenades,
    originOf,
    namer,
    coachUtilities: coach?.utilities || [],
    strategyName: name,
    side,
    roundFile,
    viewTickOf
  });

  let links = folded.links;
  if (folded.changed) {
    onStatus('Saving utility…');
    const saved = await saveUtilityArchive(teamId, mapCode, folded.archive);
    // The server owns the id namespace and may re-mint a collision. Re-read the
    // ids off what it stored so a note never links a throw that was renamed.
    if (saved?.grenades) links = relinkAgainst(saved, folded, links);
  }

  onStatus('Reading the round…');
  const notes = buildRoundNotes({
    meta,
    track,
    network,
    mapCode,
    side,
    playerIds: seats.filter(Boolean),
    links,
    economy
  });

  onStatus('Saving strategy…');
  const body = await saveTeamStrategy(teamId, {
    map: mapCode,
    side,
    name,
    category,
    economy,
    description: '',
    roleNotes: seats.map((id) => (id ? notes.get(id) || '' : '')),
    visibleAll: true
  });

  return {
    strategy: body?.strategy || body || null,
    utilityAdded: links.length,
    // The archive is capped per map. Anything it had no room for is said out
    // loud rather than quietly missing from the notes.
    utilityDropped: folded.dropped || 0
  };
}

/**
 * Re-point links at the ids the server actually stored.
 *
 * Ids are minted here so the notes can be written in one pass, but the archive
 * is sanitized server-side and a genuine collision is re-minted there. Matching
 * back by position (the one thing sanitizing never changes) keeps the note and
 * the throw in agreement.
 */
function relinkAgainst(saved, folded, links) {
  const byId = new Map();
  for (const g of saved.grenades || []) {
    for (const t of g.throws || []) byId.set(t.id, t);
  }
  const findStored = (want) => {
    for (const g of saved.grenades || []) {
      for (const t of g.throws || []) {
        if (Math.abs(t.x - want.x) < 0.5 && Math.abs(t.y - want.y) < 0.5) return t.id;
      }
    }
    return '';
  };
  const localThrow = new Map();
  for (const g of folded.archive.grenades || []) {
    for (const t of g.throws || []) localThrow.set(t.id, t);
  }
  return links.map((l) => {
    if (byId.has(l.throwId)) return l;
    const want = localThrow.get(l.throwId);
    const id = want ? findStored(want) : '';
    return id ? { ...l, throwId: id } : { ...l, throwId: '' };
  });
}
