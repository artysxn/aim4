// ---------------------------------------------------------------------------
// Player scout: the rounds written out as strategies.
//
// The scan says which round is the clearest example of each thing the player
// does. This turns each of those into the text an Add strategy row would carry
// for it, for him and for the four bodies around him. Grenade names stay
// plain text unless a caller asks to fold them into the team's utility
// archive (`linkUtility`). Analyze does not.
//
// When linking is on, the archive is written first so notes can cite archive
// ids, the same order addStrategy.js uses. Failure to save the archive is not
// fatal: the notes still go in with unlinked labels.
// ---------------------------------------------------------------------------

import {
  fetchRoundMeta,
  fetchRoundTicks,
  fetchUtilityArchive,
  fetchZones,
  saveUtilityArchive
} from '../api.js';
import { TickTrack } from '../tickStore.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { loadCoachSmokes } from '../coach/coachSmokes.js';
import { ensureRegionHierarchy } from '../zones/regionHierarchy.js';
import { ensureKeyZones } from '../zones/keyZones.js';
import { ensureBombSites } from '../zones/bombSites.js';
import { createNamer } from '../strategy/regionNames.js';
import { foldRoundUtility } from '../strategy/utilityImport.js';
import { buildRoundNotes } from '../strategy/roundNarrative.js';
import { relinkAgainst, sidePlayers } from '../strategy/addStrategy.js';
import { stratNoteToDocHtml } from '../../site/stratNoteLinks.js';

/** The viewer opens half a second before release, so the throw is watchable. */
const LEAD_SECONDS = 0.5;

/**
 * Write one note per body for a handful of rounds.
 *
 * @param {object} args
 * @param {string} args.mapCode
 * @param {string} args.playerId    the scouted body
 * @param {string} args.playerName  names the archive entries this run adds
 * @param {string} args.teamId      destination team, for the utility archive
 * @param {boolean} args.linkUtility  fold grenades into that team's archive
 * @param {Array<{key: string, file: string, side: 'T'|'CT'}>} args.picks
 * @param {(text: string) => void} [args.onProgress]
 * @returns {Promise<{
 *   notes: Map<string, { self: string, mates: Array<{id: string, name: string, note: string}> }>,
 *   utilityAdded: number,
 *   utilityLinked: boolean,
 *   utilityError: string
 * }>}
 */
export async function writeScoutNotes({
  mapCode,
  playerId,
  playerName = '',
  teamId = '',
  linkUtility = false,
  picks,
  onProgress = () => {}
}) {
  const notes = new Map();
  const list = (picks || []).filter((p) => p?.file);
  if (!list.length) return { notes, utilityAdded: 0, utilityLinked: false, utilityError: '' };

  let network = null;
  try {
    network = await fetchZones(mapCode);
    ensureRegionHierarchy(network);
    ensureKeyZones(network);
    ensureBombSites(network);
  } catch {
    network = null;
  }
  const namer = createNamer(network, mapCode);
  const coach = await loadCoachSmokes(mapCode).catch(() => ({ utilities: [] }));

  const wantLinks = Boolean(linkUtility && teamId);
  let archive = null;
  let utilityError = '';
  if (wantLinks) {
    onProgress('Reading utility archive…');
    try {
      archive = (await fetchUtilityArchive(teamId, mapCode)) || {
        map: mapCode,
        updatedAt: 0,
        grenades: []
      };
    } catch (err) {
      archive = null;
      utilityError = err?.message || 'Could not read the utility archive.';
    }
  }

  /** @type {Array<{pick: object, meta: object, track: object, ids: string[], links: Array}>} */
  const loaded = [];
  let changed = false;
  let dropped = 0;

  for (let i = 0; i < list.length; i++) {
    const pick = list[i];
    onProgress(`Reading round ${i + 1} of ${list.length}…`);
    let meta = null;
    let track = null;
    try {
      meta = await fetchRoundMeta(pick.file);
      track = new TickTrack(await fetchRoundTicks(pick.file, 16));
    } catch {
      continue;
    }
    if (!meta || !track) continue;

    const ids = sidePlayers(meta, pick.side);
    if (!ids.length) continue;

    const timing = timingFor(meta);
    const rate = timing.tickRate || 64;
    const slotOf = new Map((meta.players || []).map((p) => [p.id, p.slot]));
    const scratch = {};
    const originOf = (g) => {
      const slot = slotOf.get(g.player);
      if (slot == null || slot < 0) return null;
      const s = track.sample(slot, Number(g.throwTick), scratch);
      if (!s || !Number.isFinite(s.x)) return null;
      return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
    };
    const viewTickOf = (g) =>
      Math.max(timing.startTick, Number(g.throwTick) - LEAD_SECONDS * rate);

    let links = [];
    if (archive) {
      const own = new Set(ids);
      const grenades = (meta.events?.grenades || [])
        .filter((g) => own.has(g.player) && Number.isFinite(Number(g.throwTick)))
        .sort((a, b) => Number(a.throwTick) - Number(b.throwTick));
      const folded = foldRoundUtility({
        archive,
        grenades,
        originOf,
        namer,
        coachUtilities: coach?.utilities || [],
        strategyName: playerName,
        side: pick.side,
        roundFile: pick.file,
        viewTickOf
      });
      archive = folded.archive;
      links = folded.links;
      changed = changed || folded.changed;
      dropped += folded.dropped || 0;
    }

    loaded.push({ pick, meta, track, ids, links });
  }

  let utilityLinked = false;
  if (archive && changed) {
    onProgress('Saving utility…');
    try {
      const saved = await saveUtilityArchive(teamId, mapCode, archive);
      if (saved?.grenades) {
        for (const entry of loaded) {
          entry.links = relinkAgainst(saved, { archive }, entry.links);
        }
      }
      utilityLinked = true;
    } catch (err) {
      utilityError = err?.message || 'Could not save the utility archive.';
      for (const entry of loaded) entry.links = [];
    }
  } else if (archive) {
    // Nothing new to store: every throw already had an entry, and the ids
    // those links carry are the stored ones.
    utilityLinked = loaded.some((e) => e.links.length > 0);
  }

  let utilityAdded = 0;
  for (const entry of loaded) {
    onProgress('Writing strategies…');
    const built = buildRoundNotes({
      meta: entry.meta,
      track: entry.track,
      network,
      mapCode,
      side: entry.pick.side,
      playerIds: entry.ids,
      links: entry.links,
      economy: '',
      windowFrom: 0,
      windowTo: ROUND_SECONDS
    });
    utilityAdded += entry.links.length;
    const nameOf = new Map((entry.meta.players || []).map((p) => [p.id, p.name || p.id]));
    const toHtml = (id) => {
      const raw = stripLeadingName(built.get(id) || '', nameOf.get(id) || '');
      return raw ? stratNoteToDocHtml(raw, { escapeHtml: escapeForDoc, mapCode }) : '';
    };
    notes.set(entry.pick.key, {
      self: toHtml(playerId),
      mates: entry.ids
        .filter((id) => id && id !== playerId)
        .map((id) => ({ id, name: nameOf.get(id) || id, note: toHtml(id) }))
        .filter((m) => m.note)
    });
  }

  return { notes, utilityAdded, utilityLinked, utilityError, utilityDropped: dropped };
}

/**
 * Drop the "ropz: " a stratbook note opens with.
 *
 * The note names its own player because a stratbook column has no other label
 * on it. In the document every line is already headed by the name and the role,
 * so the prefix would read "ropz (A Lurk): ropz: Go T A".
 */
function stripLeadingName(raw, name) {
  const s = String(raw || '');
  if (!name || !s.startsWith(`${name}: `)) return s;
  return s.slice(name.length + 2);
}

/**
 * The documents renderer escapes on its own, but the note walker needs one
 * here: it is building the anchors, so the text inside them is escaped as it
 * goes rather than escaped twice afterwards.
 */
function escapeForDoc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
