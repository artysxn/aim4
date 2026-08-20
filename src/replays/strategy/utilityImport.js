// ---------------------------------------------------------------------------
// replays/strategy/utilityImport.js
// Every grenade one side threw in a round, folded into the team's utility
// archive so the strategy can link to it.
//
// A stratbook note links a throw by writing `<!abcd>` next to its label, and
// `abcd` only exists once the throw is IN the archive. So the order is fixed:
// build the archive additions first, mint the ids, then write the notes around
// the ids that came back. That is what this module produces — a patched
// archive to POST, plus one link record per grenade for the note builder.
//
// What gets folded, rather than appended:
//
//   landing spot   Same grenade type detonating within MERGE_UNITS of a spot
//                  already on the map IS that spot. The archive's own drag-drop
//                  editor merges on the same distance, so an imported round and
//                  a hand-placed lineup end up as one entry with two throws
//                  instead of two entries a coach has to reconcile.
//   throw spot     Same again for the origin. Re-importing the same round twice
//                  must not double every lineup, and a lineup somebody already
//                  typed a comment on keeps its id, its comment, and its
//                  hand-checked setpos — the import never overwrites those.
//
// Names come from the private Autocoach utility database when the landing
// matches one ("a1 smoke"), because that is the name the coaching side already
// uses. Otherwise the closest painted POSITION names it, which is the spec's
// fallback and reads the way a call does: Car, Window, Top Mid.
// ---------------------------------------------------------------------------

import { matchCoachSmoke } from '../coach/coachSmokes.js';

/** Distance at which two landings (or two origins) are the same spot. */
export const MERGE_UNITS = 75;
/** How close a detonation has to be to a stored Autocoach spot to take its name. */
export const COACH_MATCH_UNITS = 250;

/** Same alphabet and shape the archive editor mints ids with. */
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Archive-storable grenade types. Decoys have no archive entry and are skipped. */
const ARCHIVE_TYPES = new Set(['smokegrenade', 'molotov', 'hegrenade', 'flashbang']);

/**
 * The server's own caps, mirrored so nothing is added that the save would then
 * drop. A truncated entry would leave a note linking a throw that is not there.
 */
const MAX_SPOTS = 400;
const MAX_THROWS = 24;

/** How a type is spelled in a note. Incendiaries and molotovs are both "Molo". */
export const TYPE_WORDS = {
  smokegrenade: 'Smoke',
  molotov: 'Molo',
  hegrenade: 'Nade',
  flashbang: 'Flash'
};

/** Timeline marks: HE, flash, smoke, molotov. */
export const NADE_MARK_COLORS = {
  hegrenade: '#1f7a32',
  flashbang: '#8fd4f0',
  smokegrenade: '#c8c8c8',
  molotov: '#ffb020'
};

export function nadeMarkColor(type) {
  return NADE_MARK_COLORS[normalizeNadeType(type)] || '';
}

export function normalizeNadeType(type) {
  const t = String(type || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (t === 'incgrenade' || t === 'firebomb' || t === 'inferno' || t === 'molotov') return 'molotov';
  if (t === 'smokegrenade' || t === 'hegrenade' || t === 'flashbang') return t;
  return t;
}

function newId(used) {
  for (let i = 0; i < 60; i++) {
    let id = '';
    for (let j = 0; j < 4; j++) id += ID_ALPHABET[(Math.random() * ID_ALPHABET.length) | 0];
    if (!used.has(id)) return id;
  }
  return `x${Date.now().toString(36).slice(-3)}`;
}

/** Landing and throw ids share one namespace: a note writes `<!abcd>` blind. */
function usedIds(archive) {
  const out = new Set();
  for (const g of archive.grenades || []) {
    if (g.id) out.add(g.id);
    for (const t of g.throws || []) if (t.id) out.add(t.id);
  }
  return out;
}

function near(ax, ay, bx, by, units) {
  return (ax - bx) ** 2 + (ay - by) ** 2 <= units * units;
}

const fmtCoord = (n) => (Math.round(Number(n) * 1e6) / 1e6).toFixed(6);

/**
 * Fold one round's grenades into an archive.
 *
 * @param {object} args
 * @param {object} args.archive      the team's archive for this map (mutated copy in, out)
 * @param {Array} args.grenades      grenade events thrown by the side, in throw order
 * @param {(g: object) => ({ x: number, y: number, z: number, yaw: number, pitch: number }|null)} args.originOf
 *   Where the thrower stood at release, from the tick buffer. `null` skips the
 *   setpos (the throw is still recorded, it just cannot be teleported to).
 * @param {{ positionName: (x: number, y: number, z?: number) => string }} args.namer
 * @param {Array} args.coachUtilities   the private Autocoach spots for this map
 * @param {string} args.strategyName
 * @param {'T'|'CT'} args.side
 * @param {string} args.roundFile       round id the viewer opens for this throw
 * @param {number} args.viewTickOf      (g) => tick the viewer should open at
 * @returns {{ archive: object, links: Array, changed: boolean }}
 *   `links[i]` = { grenade, type, word, spot, throwId, player }, plus `dropped`
 *   for throws the archive was too full to take.
 */
export function foldRoundUtility({
  archive,
  grenades,
  originOf,
  namer,
  coachUtilities = [],
  strategyName = '',
  side = 'T',
  roundFile = '',
  viewTickOf = () => 0
}) {
  const out = {
    map: archive?.map || '',
    updatedAt: archive?.updatedAt || 0,
    grenades: (archive?.grenades || []).map((g) => ({
      ...g,
      detonate: { ...g.detonate },
      throws: (g.throws || []).map((t) => ({ ...t }))
    }))
  };
  const used = usedIds(out);
  const links = [];
  let changed = false;
  /** Throws the archive had no room for. Reported, never silent. */
  let dropped = 0;

  for (const g of grenades || []) {
    const type = normalizeNadeType(g.type);
    if (!ARCHIVE_TYPES.has(type)) continue;
    const x = Number(g.at?.x);
    const y = Number(g.at?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const z = Number(g.at?.z) || 0;

    // Name the landing: the coaching database first, the painted map second.
    const known = coachUtilities?.length
      ? matchCoachSmoke(coachUtilities, x, y, COACH_MATCH_UNITS, type)
      : null;
    const spot = (known?.name || namer.positionName(x, y, z) || '').trim();
    const word = TYPE_WORDS[type] || 'Nade';

    let entry = out.grenades.find(
      (e) => e.type === type && near(e.detonate.x, e.detonate.y, x, y, MERGE_UNITS)
    );
    if (!entry) {
      if (out.grenades.length >= MAX_SPOTS) {
        dropped += 1;
        continue;
      }
      entry = {
        id: newId(used),
        type,
        // "T FaZe Car Smoke" — side, the call this came from, where it lands.
        name: [side, strategyName, spot, word].map((s) => String(s || '').trim()).filter(Boolean).join(' ').slice(0, 80),
        detonate: { x, y },
        throws: []
      };
      used.add(entry.id);
      out.grenades.push(entry);
      changed = true;
    }

    const origin = originOf(g) || null;
    const ox = Number.isFinite(origin?.x) ? origin.x : Number(g.from?.x);
    const oy = Number.isFinite(origin?.y) ? origin.y : Number(g.from?.y);
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue;

    let th = entry.throws.find((t) => near(t.x, t.y, ox, oy, MERGE_UNITS));
    if (!th && entry.throws.length >= MAX_THROWS) {
      dropped += 1;
      continue;
    }
    if (!th) {
      th = {
        id: newId(used),
        x: ox,
        y: oy,
        setpos: origin
          ? `setpos ${fmtCoord(origin.x)} ${fmtCoord(origin.y)} ${fmtCoord(origin.z)}`
          : '',
        setang: origin ? `setang ${fmtCoord(origin.pitch)} ${fmtCoord(origin.yaw)} 0` : '',
        comment: '',
        round: roundFile,
        tick: Math.max(0, Math.round(viewTickOf(g) || 0)),
        player: String(g.player || '')
      };
      used.add(th.id);
      entry.throws.push(th);
      changed = true;
    } else if (!th.round && roundFile) {
      // An existing hand-placed lineup keeps its setpos and its comment, but
      // gains the demo it can now be watched in.
      th.round = roundFile;
      th.tick = Math.max(0, Math.round(viewTickOf(g) || 0));
      th.player = String(g.player || '');
      changed = true;
    }

    links.push({
      grenade: g,
      type,
      word,
      spot,
      throwId: th.id,
      player: String(g.player || '')
    });
  }

  return { archive: out, links, changed, dropped };
}
