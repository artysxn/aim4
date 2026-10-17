// ---------------------------------------------------------------------------
// replays/training/roundStory.js
// The training bot describing one round, the way someone watching it would.
//
// Rule-based: every sentence comes from a read the antistrat summary already
// trusts (antistratReads.js), asked once of each side of the round. The output
// is a list of beats, each pinned to the tick it describes so the training page
// can light it up as the round plays, plus the same beats as one paragraph.
//
//   start      who is playing what buy
//   shape      where the Ts spread out and where the CTs stand at 1:35
//   utility    the opening smokes and molotovs of both sides
//   kill       every kill: who, whom, from where, with what
//   core       the first time the T core shows itself in a fight
//   lurk       a lurker settling in, and what he does with it
//   hit        the Ts committing onto a site: pace, way in, utility
//   rotate     CTs arriving on the hit site after it
//   plant      the bomb going down
//   end        who won and how
//
// It says what happened and nothing about what anyone should have done: what
// the admin is judging is whether the description is right.
// ---------------------------------------------------------------------------

import { MAPS, ECONOMIES, buyBucket } from '../shared/roundId.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { FORMATIONS } from '../analytics/patternDefs.js';
import { classifyPace, nadeLabel, roundFeatures } from '../analytics/antistratScan.js';
import {
  areaAt,
  coreShowOf,
  entryOf,
  formationOf,
  lurkPlaysOf,
  roundSite,
  sampleAtElapsed,
  tally,
  throwElapsed
} from '../analytics/antistratReads.js';
import { clockText, joinList, plural } from '../analytics/reportProse.js';

/** Generator name stored with every label, so the data says which rules spoke. */
export const STORY_ENGINE = 'rules-1';

const PACE_WORDS = {
  rush: 'rush',
  pop: 'pop',
  contact: 'contact play',
  'full-exec': 'full execute',
  default: 'default',
  'slow-default': 'slow default',
  other: 'mixed round'
};

/** A weapon worth naming in a kill line. Rifles and SMGs are the default and go unsaid. */
function weaponWord(weapon) {
  const w = String(weapon || '').toLowerCase();
  if (w === 'awp') return 'AWP';
  if (w === 'ssg08') return 'Scout';
  if (w === 'deagle') return 'Deagle';
  if (w.startsWith('knife') || w === 'bayonet') return 'knife';
  if (w === 'hegrenade') return 'HE';
  if (w === 'inferno' || w === 'molotov' || w === 'incgrenade') return 'fire';
  return '';
}

const areaWords = (area) => (area === 'A' || area === 'B' ? `the ${area} side` : area === 'mid' ? 'mid' : area);

/** "smoke Window + Top mid, molo Jungle" for a list of grenades. */
function nadeWords(nades) {
  const by = { smokegrenade: [], molotov: [] };
  for (const n of nades) {
    const label = nadeLabel(n);
    if (label && by[n.type] && !by[n.type].includes(label)) by[n.type].push(label);
  }
  const parts = [];
  if (by.smokegrenade.length) parts.push(`${by.smokegrenade.length > 1 ? 'smokes' : 'smoke'} ${by.smokegrenade.slice(0, 4).join(' + ')}`);
  if (by.molotov.length) parts.push(`${by.molotov.length > 1 ? 'molos' : 'molo'} ${by.molotov.slice(0, 4).join(' + ')}`);
  return parts.join(', ');
}

/**
 * Describe one round.
 *
 * @param {{
 *   meta: object,          the round's full meta (fetchRoundMeta)
 *   track: object,         its TickTrack (any stride)
 *   network: object|null,  the map's zone network (loadMapContext)
 *   utilDb: object,
 *   laneSets: object,
 *   file?: string
 * }} input
 * @returns {null | { text: string, beats: Array<{ tick: number, clock: string, kind: string, text: string }>, facts: object }}
 */
export function describeRound({ meta, track, network, utilDb, laneSets, file = '' }) {
  if (!meta?.players?.length) return null;
  const mapCode = meta.map || '';
  const row = { f: file || meta.file || '', d: meta.demoId || '', n: meta.round, e1: meta.econ1, e2: meta.econ2, w: meta.winner };
  const sideOf = { 1: meta.team1Side === 'CT' ? 'CT' : 'T', 2: meta.team2Side === 'CT' ? 'CT' : 'T' };
  const tIdx = sideOf[1] === 'T' ? 1 : 2;
  const ctIdx = tIdx === 1 ? 2 : 1;
  const feats = (teamIdx) =>
    roundFeatures({ meta, track, row, teamIdx, opponent: '', context: null, network, utilDb, mapCode });
  const T = feats(tIdx);
  const CT = feats(ctIdx);
  if (!T || !CT) return null;

  const team = (idx) => (idx === 1 ? meta.team1 : meta.team2)?.name || `Team ${idx}`;
  const names = new Map(meta.players.map((p) => [p.id, p.name || p.id]));
  const name = (id) => names.get(id) || id;
  const tick = (elapsed) => Math.round(T.t0 + elapsed * T.tickRate);
  const plantElapsed = T.plantTick != null ? (T.plantTick - T.t0) / T.tickRate : null;
  /** The round clock, or time since the plant once the bomb is down. */
  const clockAt = (elapsed) =>
    plantElapsed !== null && elapsed > plantElapsed
      ? `plant +${Math.round(elapsed - plantElapsed)}s`
      : clockText(ROUND_SECONDS - elapsed);
  const beats = [];
  const beat = (elapsed, kind, text) => {
    if (!Number.isFinite(elapsed) || !text) return;
    beats.push({ tick: tick(elapsed), elapsed, clock: clockAt(Math.max(0, elapsed)), kind, text });
  };

  // ---- start -------------------------------------------------------------
  const econ = (idx) => ECONOMIES[buyBucket(idx === 1 ? meta.econ1 : meta.econ2)]?.label?.toLowerCase() || 'unknown buy';
  const mapName = MAPS[mapCode]?.name || mapCode;
  beat(
    0,
    'start',
    `Round ${meta.round} on ${mapName}: ${team(tIdx)} on T (${econ(tIdx)}) against ${team(ctIdx)} on CT (${econ(ctIdx)}).`
  );

  // ---- shape ---------------------------------------------------------------
  const lanes = FORMATIONS[mapCode]?.t || [];
  const form = formationOf(T, mapCode, laneSets);
  if (form && lanes.length === form.length) {
    const spread = form.map((c, i) => `${c} ${String(lanes[i].short || lanes[i].label).toLowerCase() === 'mid' ? 'mid' : lanes[i].short || lanes[i].label}`);
    beat(13, 'shape', `The Ts spread out ${form.join('-')} (${joinList(spread.filter((x) => !x.startsWith('0 ')))}).`);
  }
  const ctAt = sampleAtElapsed(CT, 20);
  if (ctAt?.pts.length) {
    const byArea = tally(ctAt.pts, (p) => areaAt(CT, p.x, p.y, p.pos, mapCode, laneSets) || 'elsewhere');
    const awp = ctAt.pts.find((p) => p.awp);
    beat(
      20,
      'shape',
      `CTs at 1:35: ${joinList(byArea.map(([a, n]) => `${n} ${a === 'A' || a === 'B' ? `on ${a}` : a === 'mid' ? 'mid' : a}`))}${
        awp ? `, AWP with ${name(awp.id)}${awp.pos ? ` at ${awp.pos}` : ''}` : ''
      }.`
    );
  }

  // ---- opening utility ---------------------------------------------------------
  const opening = (r, by) => r.nades.filter((n) => (n.type === 'smokegrenade' || n.type === 'molotov') && throwElapsed(n) <= by);
  const tOpen = nadeWords(opening(T, 15));
  if (tOpen) beat(Math.max(1, Math.min(...opening(T, 15).map(throwElapsed))), 'utility', `Ts open with ${tOpen}.`);
  const ctOpen = nadeWords(opening(CT, 20));
  if (ctOpen) beat(Math.max(1, Math.min(...opening(CT, 20).map(throwElapsed))), 'utility', `CTs put out ${ctOpen} early.`);

  // ---- kills ---------------------------------------------------------------
  for (const k of T.kills) {
    const killerSide = k.attackerOurs ? 'T' : 'CT';
    const victimSide = k.victimOurs ? 'T' : 'CT';
    const from = k.attackerZone && k.attackerZone !== k.victimZone ? ` from ${k.attackerZone}` : '';
    const w = weaponWord(k.weapon);
    const extras = [w, k.throughSmoke ? 'through smoke' : '', k.attackerBlind ? 'while blind' : ''].filter(Boolean);
    beat(
      ROUND_SECONDS - k.clock,
      'kill',
      `${name(k.attacker)} (${killerSide}) kills ${name(k.victim)} (${victimSide})${k.victimZone ? ` at ${k.victimZone}` : ''}${from}${
        extras.length ? `, ${extras.join(', ')}` : ''
      }.`
    );
  }

  // ---- the T core, lurks and the hit ---------------------------------------------
  const core = coreShowOf(T, mapCode, laneSets);
  if (core) {
    beat(
      core.elapsed,
      'core',
      `The T core shows itself on ${areaWords(core.area)}: ${core.ids.length} together${core.pos ? `, first fight at ${core.pos}` : ''}.`
    );
  }
  for (const l of lurkPlaysOf(T, mapCode, laneSets)) {
    beat(l.from, 'lurk', `${name(l.id)} lurks alone on ${areaWords(l.area)}${l.pos ? ` (${l.pos})` : ''}.`);
    if (l.does === 'push') beat(l.at, 'lurk', `${name(l.id)} goes at the site from his lurk${l.where ? `, onto ${l.where}` : ''}.`);
    else if (l.does === 'rotate') beat(l.at, 'lurk', `${name(l.id)} leaves his lurk to join the hit.`);
  }

  const pace = classifyPace(T);
  const site = roundSite(T);
  const entry = entryOf(T, laneSets);
    if (entry && site) {
    const way = entry.split
      ? ` split from ${joinList([...entry.routes.keys()].filter(Boolean).slice(0, 3))}`
      : entry.route
        ? ` through ${entry.route}`
        : '';
    const util = nadeWords(T.nades.filter((n) => throwElapsed(n) >= entry.elapsed - 25 && throwElapsed(n) <= entry.elapsed + 3));
    beat(
      entry.elapsed,
      'hit',
      `Ts ${PACE_WORDS[pace] || 'go'} onto ${site}${way} with ${plural(entry.players.length, 'player')}${util ? `, using ${util}` : ''}.`
    );
    // How the CTs answer: who was already there, and who comes after.
    const on = (s) => (s?.pts || []).filter((p) => CT.siteNear(p.x, p.y, 0) === site.toLowerCase()).length;
    const there = on(sampleAtElapsed(CT, entry.elapsed));
    const later = on(sampleAtElapsed(CT, entry.elapsed + 10));
    beat(
      entry.elapsed + 1,
      'rotate',
      `${there ? plural(there, 'CT') : 'No CT'} on ${site} when the Ts arrive${later > there ? `, ${later - there} more within 10 seconds` : ''}.`
    );
  } else {
    // A round that ended before two Ts stood on a site: it was decided elsewhere.
    const last = T.kills.length ? ROUND_SECONDS - T.kills[T.kills.length - 1].clock : (T.endTick - T.t0) / T.tickRate;
    beat(Math.min(ROUND_SECONDS, last), 'hit', 'The Ts never get onto a site.');
  }

  if (plantElapsed !== null) {
    beat(plantElapsed, 'plant', `Bomb planted on ${String(T.plantSite || site || '').toUpperCase() || 'a site'}.`);
  }

  // ---- end -------------------------------------------------------------------
  const bomb = (type) => (meta.events?.bomb || []).find((b) => b?.type === type);
  const winnerSide = meta.winnerSide || (meta.winner === tIdx ? 'T' : meta.winner === ctIdx ? 'CT' : '');
  const dead = new Set(T.kills.map((k) => k.victim));
  const alive = (idx) => meta.players.filter((p) => p.team === idx && !dead.has(p.id)).length;
  let how = '';
  if (bomb('exploded')) how = 'the bomb explodes';
  else if (bomb('defused')) how = 'the bomb is defused';
  else if (winnerSide === 'CT' && plantElapsed === null && alive(tIdx) > 0) how = 'time runs out';
  else if (winnerSide) how = `the ${winnerSide === 'T' ? 'CTs' : 'Ts'} are all dead`;
  const endTick = meta.endTick ?? T.endTick;
  const endElapsed = (endTick - T.t0) / T.tickRate;
  if (winnerSide) {
    beat(
      endElapsed,
      'end',
      `${team(winnerSide === 'T' ? tIdx : ctIdx)} win on ${winnerSide}: ${how}, ${alive(tIdx)} T and ${alive(ctIdx)} CT alive at the end.`
    );
  }

  beats.sort((a, b) => a.tick - b.tick || order(a.kind) - order(b.kind));
  // The paragraph keeps the story and the first kill, not every frag.
  const firstKill = beats.find((b) => b.kind === 'kill');
  const story = beats.filter((b) => b.kind !== 'kill' || b === firstKill);
  const text = story.map((b) => `${b.clock} ${b.text}`).join(' ');
  return {
    text,
    beats: beats.map(({ tick: t, clock, kind, text: words }) => ({ tick: t, clock, kind, text: words })),
    facts: {
      map: mapCode,
      round: meta.round,
      tTeam: team(tIdx),
      ctTeam: team(ctIdx),
      pace,
      site,
      formation: form,
      winnerSide,
      how,
      kills: T.kills.length,
      planted: plantElapsed !== null
    }
  };
}

const KIND_ORDER = ['start', 'shape', 'utility', 'core', 'lurk', 'hit', 'rotate', 'kill', 'plant', 'end'];
const order = (kind) => KIND_ORDER.indexOf(kind);
