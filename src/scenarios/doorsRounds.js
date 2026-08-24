// ---------------------------------------------------------------------------
// doorsRounds.js
// Which real rounds the Doors gamemode plays back, and which CTs are drawn.
//
// Two ways to fill the playlist, both from the replay library:
//
//   no team typed   every VRS top-10 team that has a Dust2 game in the
//                   library contributes 3 random rounds from its MOST RECENT
//                   one — full buy + AWP against full buy + AWP, that team on
//                   the CT side. Ten teams on form is ~30 rounds.
//   a team typed    that team's Dust2 games are scanned for full buy against
//                   full buy rounds with the team on CT, preferring the ones
//                   where they actually had an AWP, and 30 are drawn at
//                   random across all of their games.
//
// Role picking is per round, from that round's own opening. The stored role
// assigner (src/replays/roles) is match-level and needs the painted zone
// networks; a round here already carries its own ticks, and "who is the B
// anchor THIS round" is a property of this round's setup, not of the match
// average. So: the AWPer is whoever holds the AWP at freeze end, and of the
// rest the two who set up closest to the B/mid half of the map (against the
// A/long half) are the B rotation and the B anchor. The A long anchor and the
// A short player — the two who lean hardest toward the A half — are exactly
// the ones the mode never draws.
// ---------------------------------------------------------------------------

import { bareWeapon } from '../replays/viewer/equipmentIcons.js';
import { weaponInfo } from '../replays/shared/weaponTable.js';
import { rankNameKey } from '../replays/shared/vrsRanks.js';
import { econHasAwp } from '../replays/shared/roundId.js';

/** How many rounds each top-10 team contributes, and the team-mode total. */
export const TOP10_PER_TEAM = 3;
export const TEAM_MODE_ROUNDS = 30;
export const VRS_TOP_N = 10;

/**
 * Dust2 landmarks (Source x, y), read off the library's own rounds: the two
 * bomb plant clusters, the CT spawn box, and the fixed geometry between them.
 * The classifier only ever compares distances against the two SETS, so a
 * landmark a few metres off does not move anyone across the A/B line.
 */
export const DD2_A_LANDMARKS = [
  [990, 2530], // A site
  [1250, 1000], // long, between the doors and the pit
  [450, 2050] // short / top of catwalk
];
export const DD2_B_LANDMARKS = [
  [-1600, 2540], // B site
  [-1050, 2300], // B doors / window
  [-280, 1400], // mid doors
  [130, 2350] // CT spawn (the B rotator's first seconds)
];

/** Opening window the roles are read from: skip the spawn cluster, stop
 *  before the round's rotations rewrite the setup. Seconds after freeze end. */
const ROLE_WINDOW_START = 5;
const ROLE_WINDOW_END = 30;
const ROLE_SAMPLE_STEP = 32; // ticks between samples

function distToNearest(x, y, landmarks) {
  let best = Infinity;
  for (const [lx, ly] of landmarks) {
    const d = Math.hypot(x - lx, y - ly);
    if (d < best) best = d;
  }
  return best;
}

/** The CT half of a round's players, with their tick slots. */
export function ctPlayersOf(meta) {
  const ctTeam = meta.team1Side === 'CT' ? 1 : 2;
  return (meta.players || []).filter((p) => p.team === ctTeam);
}

/** 'T' | 'CT' | '' for a team id in this round. */
export function sideOfTeam(meta, teamId) {
  if (meta.team1?.id === teamId || meta.team1 === teamId) return meta.team1Side || '';
  if (meta.team2?.id === teamId || meta.team2 === teamId) return meta.team2Side || '';
  return '';
}

function loadoutOf(meta, id) {
  return meta.stats?.[id]?.loadout || [];
}

/** The freeze-end AWP holder among the CTs, or null. */
export function awperOf(meta, ctPlayers) {
  for (const p of ctPlayers) {
    if (loadoutOf(meta, p.id).some((w) => bareWeapon(w) === 'awp')) return p;
  }
  return null;
}

/** The weapon model a drawn bot holds: AWP for the AWPer, else their primary. */
export function heldWeaponOf(meta, player, role) {
  if (role === 'awper') return 'awp';
  const items = loadoutOf(meta, player.id);
  let secondary = null;
  for (const w of items) {
    const stem = bareWeapon(w);
    const cat = weaponInfo(stem)?.category;
    if (cat === 'rifle' || cat === 'smg' || cat === 'sniper' || cat === 'shotgun' || cat === 'lmg') {
      return stem;
    }
    if (!secondary && cat === 'pistol') secondary = stem;
  }
  return secondary || 'm4a1_silencer';
}

/**
 * Average opening position per CT, from the round's own ticks.
 *
 * @param {object} meta
 * @param {{ rowFor(tick: number): number, state(row: number, slot: number): object, header: object }} ticks
 *   a RoundTicks (doorsPlayback.js), or anything with its reading shape
 */
export function openingPositions(meta, ticks, ctPlayers) {
  const rate = ticks.header.tickRate || 64;
  const from = meta.freezeEndTick + ROLE_WINDOW_START * rate;
  const to = Math.min(meta.freezeEndTick + ROLE_WINDOW_END * rate, meta.endTick || Infinity);
  const out = new Map();
  for (const p of ctPlayers) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let t = from; t <= to; t += ROLE_SAMPLE_STEP) {
      const s = ticks.state(ticks.rowFor(t), p.slot);
      if (!s.alive) break;
      sx += s.x;
      sy += s.y;
      n++;
    }
    if (!n) {
      // Died inside the skip window: their spawn still says which way they went.
      const s = ticks.state(ticks.rowFor(meta.freezeEndTick), p.slot);
      sx = s.x;
      sy = s.y;
      n = 1;
    }
    out.set(p.id, { x: sx / n, y: sy / n });
  }
  return out;
}

/**
 * The three CTs the mode draws: the AWPer, the B rotation and the B anchor.
 *
 * @returns {Array<{slot: number, id: string, name: string, role: string, weapon: string}>}
 */
export function pickDoorsCts(meta, ticks) {
  const ct = ctPlayersOf(meta);
  if (!ct.length) return [];
  const awper = awperOf(meta, ct);
  const rest = ct.filter((p) => p !== awper);
  const pos = openingPositions(meta, ticks, rest);

  // Negative = set up on the B/mid half; positive = the A/long half.
  const affinity = (p) => {
    const at = pos.get(p.id);
    if (!at) return 0;
    return distToNearest(at.x, at.y, DD2_B_LANDMARKS) - distToNearest(at.x, at.y, DD2_A_LANDMARKS);
  };
  const ordered = [...rest].sort((a, b) => affinity(a) - affinity(b));
  const bSide = ordered.slice(0, awper ? 2 : 3);

  // Label the pair for the HUD and the held weapon: the one who set up deeper
  // toward B site is the anchor, the other is the rotation.
  const bDist = (p) => {
    const at = pos.get(p.id);
    return at ? distToNearest(at.x, at.y, [DD2_B_LANDMARKS[0]]) : Infinity;
  };
  bSide.sort((a, b) => bDist(a) - bDist(b));

  const drawn = [];
  if (awper) drawn.push({ slot: awper.slot, id: awper.id, name: awper.name, role: 'awper' });
  bSide.forEach((p, i) => {
    drawn.push({ slot: p.slot, id: p.id, name: p.name, role: i === 0 ? 'bAnchor' : 'bMid' });
  });
  for (const d of drawn) {
    const player = ct.find((p) => p.id === d.id);
    d.weapon = heldWeaponOf(meta, player, d.role);
  }
  return drawn;
}

// ---- playlist selection -----------------------------------------------------

function shuffled(list, rand = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** newest first, by when the library got the demo. */
function byNewest(a, b) {
  return (b.uploadedAt || 0) - (a.uploadedAt || 0);
}

function teamSeatOf(demo, key) {
  if (rankNameKey(demo.team1?.name) === key) return { id: demo.team1?.id, name: demo.team1?.name };
  if (rankNameKey(demo.team2?.name) === key) return { id: demo.team2?.id, name: demo.team2?.name };
  return null;
}

function opponentOf(meta, teamId) {
  return meta.team1?.id === teamId ? meta.team2?.name : meta.team1?.name;
}

/** Fetch round metas a few at a time; a round whose meta fails is skipped. */
async function fetchMetas(api, rounds, limit = 6) {
  const out = [];
  let at = 0;
  const worker = async () => {
    while (at < rounds.length) {
      const r = rounds[at++];
      try {
        const meta = await api.fetchRoundMeta(r.file);
        if (meta) out.push({ round: r, meta });
      } catch {
        /* gone or unreadable; the playlist just gets one fewer candidate */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, rounds.length) }, worker));
  return out;
}

/** The stored econ digit of the given team's side in a round summary. */
function teamEconDigit(summary, meta, teamId) {
  const side1 = meta.team1?.id === teamId;
  return side1 ? summary.econ1 : summary.econ2;
}

/**
 * Build the playlist.
 *
 * @param {object} o
 * @param {string} [o.team]  free-text team name; empty = VRS top 10 mode
 * @param {object} o.api     { fetchVrsRanks, fetchDemos, findRounds, fetchRoundMeta }
 * @param {() => number} [o.rand]
 * @returns {Promise<{label: string, rounds: Array<{file: string, meta: object, teamId: string, teamName: string, opponent: string}>, problem?: string}>}
 */
export async function selectDoorsRounds({ team = '', api, rand = Math.random }) {
  const lib = await api.fetchDemos({ map: 'DD2', limit: 500 });
  const demos = (lib.demos || []).filter((d) => d.map === 'DD2').sort(byNewest);
  if (!demos.length) return { label: '', rounds: [], problem: 'no Dust2 games in the library' };

  const wanted = String(team || '').trim();
  return wanted
    ? selectForTeam({ wanted, demos, api, rand })
    : selectTop10({ demos, api, rand });
}

async function selectTop10({ demos, api, rand }) {
  let ranks;
  try {
    ranks = await api.fetchVrsRanks();
  } catch {
    return { label: 'VRS top 10', rounds: [], problem: 'VRS standings unavailable' };
  }
  const top = (ranks?.list || []).filter((r) => r.rank >= 1 && r.rank <= VRS_TOP_N);
  if (!top.length) return { label: 'VRS top 10', rounds: [], problem: 'VRS standings unavailable' };

  // One pass over the round index; each team slices its own game out of it.
  const found = await api.findRounds(
    { maps: ['DD2'], econA: 4, econB: 4, hasAwpA: true, hasAwpB: true },
    2000
  );
  const summaries = found?.rounds || [];

  const picks = [];
  for (const teamRow of top) {
    const key = rankNameKey(teamRow.name);
    if (!key) continue;
    const demo = demos.find((d) => teamSeatOf(d, key));
    if (!demo) continue; // has not played dust2 (that the library knows of)
    const seat = teamSeatOf(demo, key);
    const cands = summaries.filter(
      (r) => r.demoId === demo.id && (r.team1 === seat.id || r.team2 === seat.id)
    );
    if (!cands.length) continue;
    const withMeta = await fetchMetas(api, cands);
    const onCt = withMeta.filter(({ meta }) => sideOfTeam(meta, seat.id) === 'CT');
    for (const { round, meta } of shuffled(onCt, rand).slice(0, TOP10_PER_TEAM)) {
      picks.push({
        file: round.file,
        meta,
        teamId: seat.id,
        teamName: seat.name || teamRow.name,
        opponent: opponentOf(meta, seat.id) || ''
      });
    }
  }
  return {
    label: 'VRS top 10',
    rounds: shuffled(picks, rand),
    problem: picks.length ? undefined : 'no matching rounds for the VRS top 10'
  };
}

/** Resolve typed text to one library team: exact name first, then a prefix,
 *  then a substring — always preferring the most recent game. */
export function resolveTeamQuery(wanted, demos) {
  const q = rankNameKey(wanted);
  if (!q) return null;
  const seats = [];
  for (const d of demos) {
    for (const seat of [d.team1, d.team2]) {
      if (!seat?.id || !seat?.name) continue;
      seats.push({ id: seat.id, name: seat.name, key: rankNameKey(seat.name) });
    }
  }
  const exact = seats.find((s) => s.key === q);
  if (exact) return exact;
  const prefix = seats.find((s) => s.key.startsWith(q));
  if (prefix) return prefix;
  return seats.find((s) => s.key.includes(q)) || null;
}

async function selectForTeam({ wanted, demos, api, rand }) {
  const seat = resolveTeamQuery(wanted, demos);
  if (!seat) {
    return { label: wanted, rounds: [], problem: `no Dust2 games for "${wanted}"` };
  }
  const theirDemos = new Set(
    demos.filter((d) => d.team1?.id === seat.id || d.team2?.id === seat.id).map((d) => d.id)
  );
  const found = await api.findRounds(
    { maps: ['DD2'], teams: [seat.id], econA: 4, econB: 4 },
    2000
  );
  const cands = (found?.rounds || []).filter((r) => theirDemos.has(r.demoId));
  const withMeta = await fetchMetas(api, cands);
  const onCt = withMeta.filter(({ meta }) => sideOfTeam(meta, seat.id) === 'CT');

  // An AWPer has to exist to be drawn, so rounds where the team's stored econ
  // digit says "full buy + AWP" fill the playlist first.
  const withAwp = [];
  const without = [];
  for (const c of onCt) {
    (econHasAwp(teamEconDigit(c.round, c.meta, seat.id)) ? withAwp : without).push(c);
  }
  const chosen = [...shuffled(withAwp, rand), ...shuffled(without, rand)].slice(0, TEAM_MODE_ROUNDS);

  return {
    label: seat.name,
    rounds: shuffled(chosen, rand).map(({ round, meta }) => ({
      file: round.file,
      meta,
      teamId: seat.id,
      teamName: seat.name,
      opponent: opponentOf(meta, seat.id) || ''
    })),
    problem: chosen.length ? undefined : `no full buy CT rounds for ${seat.name} on Dust2`
  };
}
