// ---------------------------------------------------------------------------
// replays/eye/roundTypes.js
// What kind of hit a T round was: an execute, a split, a rush, a contact play,
// or no hit at all, and which of a kind were played best.
//
// The pace classes (antistratScan classifyPace) say how fast a round was, not
// how the site was attacked: a tool labelled a round "B execute" because four
// Ts stood near B at 1:00, and a B main hit with two players holding mid was
// called a split because someone was elsewhere. Both are about geometry over
// time, so this reads it:
//
// - The target is the planted site, else the first site two players entered.
// - The wave is the first group of players to step onto that site within
//   WAVE_SECONDS of each other. Players who arrive later are joiners (a lurk
//   or a rotation catching up), never a lane of the hit.
// - Each player's lane is where he came from: the zone of the last named
//   position he held before stepping on the site, skipping the site's own zone
//   (it reaches past the bombsite outline). A zone with two doors onto a site
//   is split by DOORS (Mirage palace and ramp share a zone); distance cannot
//   do it, since ramp and palace are 700 units apart and banana is 1,000 long.
// - Split: the wave came from 2+ lanes with 3+ players, each lane on the site
//   within WAVE_SECONDS of the first. Execute: one lane, 3+ grenades onto the
//   site just before the wave. Rush: the pace was rush or pop. Contact: one
//   lane, little utility. Fake: 2+ grenades at the other site first.
//
// Input is one antistratScan roundFeatures record and the map's zone network.
// ---------------------------------------------------------------------------

import { classifyPace, paceSite } from '../analytics/antistratScan.js';
import { pointInPiece } from '../zones/zoneGeom.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { clockText, placeIndex } from './roundStory.js';

/** Players reaching the site this close together are one wave. */
export const WAVE_SECONDS = 12;
/** Positions that are their own door in a zone that has two (map -> position -> lane). */
const DOORS = {
  MIR: { 'A Ramp': 'Ramp', 'T Outside A': 'Ramp', 'A Palace': 'Palace', 'T Palace': 'Palace' }
};
/** How far back a player's lane is looked for before he stepped on the site. */
const LANE_LOOKBACK = 12;
/** Grenades onto the target site in this window before the wave count as its execute utility. */
const UTIL_BEFORE = 15;
const UTIL_AFTER = 5;

export const ROUND_KINDS = ['execute', 'split', 'rush', 'contact', 'no-hit'];

const onSite = (p, pieces) => (pieces || []).some((piece) => pointInPiece(p.x, p.y, piece));

/**
 * One T round's kind of hit.
 *
 * @param {object} r  roundFeatures
 * @param {object} network  zone network of the map
 * @param {{ nameOf?: Map<string, string> }} [opts]
 */
export function classifyRound(r, network, { nameOf = new Map(), mapCode = '' } = {}) {
  if (r.side !== 'T') return null;
  const place = placeIndex(network);
  const doors = DOORS[String(mapCode).toUpperCase()] || {};
  const zoneOf = (pos) => place.get(pos)?.zone || pos;
  const laneOf = (pos) => doors[pos] || zoneOf(pos);
  const name = (id) => nameOf.get(id) || id;
  const pace = classifyPace(r);
  const site = paceSite(r);
  const base = { score: 0, pace, won: r.won, plantSite: r.plantSite ? r.plantSite.toUpperCase() : null, plantClock: r.plantClock != null ? clockText(r.plantClock) : null };
  if (!site || !r.series?.length) return { ...base, kind: 'no-hit', site: null, label: 'No hit', lanes: [], wave: [], joiners: [], utility: 0, fake: false };
  const pieces = r.sitePieces?.[site] || [];

  // When each player first stood on the target site, and where he came from.
  const entries = [];
  for (const id of r.ourIds || []) {
    for (let i = 0; i < r.series.length; i++) {
      const p = r.series[i].pts.find((x) => x.id === id);
      if (!p || !onSite(p, pieces)) continue;
      const siteZone = p.pos ? zoneOf(p.pos) : '';
      let from = null;
      for (let k = i - 1; k >= 0 && r.series[i].elapsed - r.series[k].elapsed <= LANE_LOOKBACK; k--) {
        const q = r.series[k].pts.find((x) => x.id === id);
        // A spawn is where every lane starts, never a lane: a player who ran through apartments
        // between two samples would otherwise "come from T Spawn" and make a split of a rush.
        if (q?.pos && !onSite(q, pieces) && zoneOf(q.pos) !== siteZone) {
          if (/spawn/i.test(zoneOf(q.pos))) break;
          from = q;
          break;
        }
      }
      entries.push({ id, t: r.series[i].elapsed, pos: from?.pos || '', zone: from?.pos ? laneOf(from.pos) : '' });
      break;
    }
  }
  entries.sort((a, b) => a.t - b.t);

  // The wave: the first player on the site who is joined by another within WAVE_SECONDS.
  let start = -1;
  for (let i = 0; i + 1 < entries.length; i++) {
    if (entries[i + 1].t - entries[i].t <= WAVE_SECONDS) {
      start = i;
      break;
    }
  }
  const waveStart = start >= 0 ? entries[start].t : entries[0]?.t ?? null;
  const wave = start >= 0 ? entries.filter((e) => e.t >= waveStart && e.t <= waveStart + WAVE_SECONDS) : entries.slice(0, 1);
  const joiners = entries.filter((e) => !wave.includes(e));

  // Lanes: where each came from. A player whose lane could not be read joins the biggest one.
  const lanes = [];
  for (const e of wave.filter((x) => x.zone)) {
    const lane = lanes.find((l) => l.zone === e.zone);
    if (lane) lane.players.push(e);
    else lanes.push({ zone: e.zone, players: [e] });
  }
  for (const e of wave.filter((x) => !x.zone)) {
    if (lanes.length) lanes.sort((a, b) => b.players.length - a.players.length)[0].players.push(e);
    else lanes.push({ zone: '', players: [e] });
  }
  lanes.sort((a, b) => a.players[0].t - b.players[0].t);

  const other = site === 'a' ? 'b' : 'a';
  const t0 = waveStart ?? ROUND_SECONDS;
  const utility = r.nades.filter((n) => n.near === site && n.throwAt >= t0 - UTIL_BEFORE && n.throwAt <= t0 + UTIL_AFTER).length;
  // A fake puts utility on the other bombsite itself; map control near it (a mid smoke) is not one.
  const fakeNades = r.nades.filter((n) => n.onSite === other && n.throwAt >= t0 - 35 && n.throwAt <= t0 - 5);
  const fake = fakeNades.length >= 2;

  let kind;
  if (lanes.length >= 2 && wave.length >= 3) kind = 'split';
  else if (pace === 'rush' || pace === 'pop') kind = 'rush';
  else if (utility >= 3 && wave.length >= 2) kind = 'execute';
  else if (wave.length >= 2) kind = 'contact';
  else kind = 'no-hit';

  const S = site.toUpperCase();
  const laneText = lanes.map((l) => l.zone || 'unknown').join(' + ');
  const label =
    kind === 'no-hit'
      ? 'No hit'
      : `${S} ${kind}${kind === 'split' ? ` (${laneText})` : ''}${fake ? ` after a fake ${other.toUpperCase()}` : ''}${pace === 'default' || pace === 'slow-default' ? ' from a default' : ''}`;

  // How cleanly it went: won first, then planted, then players kept and kills taken by the plant, then speed.
  const plantT = r.plantClock != null ? ROUND_SECONDS - r.plantClock : null;
  const until = plantT ?? (waveStart != null ? waveStart + 15 : ROUND_SECONDS);
  const lost = r.kills.filter((k) => k.victimOurs && ROUND_SECONDS - k.clock <= until).length;
  const took = r.kills.filter((k) => k.attackerOurs && ROUND_SECONDS - k.clock <= until).length;
  const score =
    (r.won ? 100 : 0) +
    (r.plantSite ? 20 : 0) +
    (5 - lost) * 5 +
    took * 4 +
    (r.ownEcon === 4 && r.oppEcon === 4 ? 5 : 0) -
    (plantT != null && waveStart != null ? Math.min(20, Math.max(0, plantT - waveStart)) / 2 : 10);

  return {
    ...base,
    kind,
    site: S,
    label,
    wave_at: waveStart != null ? clockText(ROUND_SECONDS - waveStart) : null,
    lanes: lanes.map((l) => ({ from: l.zone || 'unknown', players: l.players.map((e) => name(e.id)), on_site_at: clockText(ROUND_SECONDS - l.players[0].t) })),
    joiners: joiners.map((e) => ({ player: name(e.id), from: e.zone || 'unknown', at: clockText(ROUND_SECONDS - e.t) })),
    utility,
    fake,
    lost_before_plant: lost,
    kills_before_plant: took,
    score: Math.round(score)
  };
}
