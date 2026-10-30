// ---------------------------------------------------------------------------
// replays/eye/roundDescribe.js
// What one side did in a round, the way a coach writes it on the round:
//
//   T   "Slow default into full 5B execute from Tunnels: smokes Doors + CT, molotov Window; 1 Long lurk"
//   CT  "2 A, 1 mid, 2 B: smokes Long box + Upper, molotov Tunnels; rotate 2 to A, retake A"
//
// Asked to note rounds, the model got every grenade and a shape every ten
// seconds, and wrote lists back ("2 A mid, 1 A, 1 B, 1 con: molotovs A Main,
// Bridge and B Water, smokes A Main and B Water, late mid + Camera smoke, hold
// A"), with kills and results it was told to leave out. A coach's note names the
// call: the kind of hit, the lane, the utility that made it, the player left
// away from it. This works that line out from the measurements, so the model
// starts from something true and short and only rewords it.
//
// The input is one antistratScan roundFeatures record and the map's zone network.
// DOM-free: nothing here fetches.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { classifyRound } from './roundTypes.js';
import { clockText, placeIndex } from './roundStory.js';

/** Seconds around the first step on the site whose utility is the hit's: the rest was map control. */
const HIT_UTIL_BEFORE = 20;
const HIT_UTIL_AFTER = 5;
/** A hit this close to the end of the clock is late (0:35). */
const LATE_CLOCK = 35;
/** Players on the site's ground this long after the first step went with it. */
const JOIN_SECONDS = 12;
/** The CTs' setup is read this far in (1:30): out of spawn, and most rounds have not had a fight yet. */
const SETUP_AT = 25;
/** CT forward moves count until this far in (1:05), held at least this long. */
const PUSH_UNTIL = 50;
const PUSH_HOLD = 3;
/** Forward is this much nearer the T spawn than the CT spawn. */
const PUSH_RATIO = 0.7;
/** CTs on one site for a stack. */
const STACK_MIN = 4;
/** A hit stopped short: this many on a site's ground, and two of them dead within this long. */
const STOPPED_MIN = 3;
const STOPPED_SECONDS = 15;

const WORDS = {
  smokegrenade: ['smoke', 'smokes'],
  molotov: ['molotov', 'molotovs'],
  flashbang: ['flash', 'flashes'],
  hegrenade: ['HE', 'HEs']
};
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

/**
 * The grenades that matter, in a coach's words: "smokes Doors + CT, molotov Window, 2 flashes".
 * Smokes and molotovs by where they landed, flashes as a count, and HEs only when there is nothing else.
 */
export function utilityWords(nades, { maxNamed = 2, flashes = true } = {}) {
  const parts = [];
  for (const type of ['smokegrenade', 'molotov']) {
    const list = nades.filter((n) => n.type === type);
    if (!list.length) continue;
    const counts = new Map();
    for (const n of list) {
      const name = String(n.label || n.zone || '').trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
    const names = [...counts.keys()].slice(0, maxNamed);
    if (!names.length) {
      parts.push(plural(list.length, WORDS[type]));
      continue;
    }
    const left = list.length - names.reduce((n, name) => n + counts.get(name), 0);
    const said = names.map((name) => (counts.get(name) > 1 ? `${counts.get(name)} ${name}` : name)).join(' + ');
    parts.push(`${WORDS[type][list.length === 1 ? 0 : 1]} ${said}${left > 0 ? ` +${left}` : ''}`);
  }
  const flashCount = nades.filter((n) => n.type === 'flashbang').length;
  if (flashCount && flashes) parts.push(plural(flashCount, WORDS.flashbang));
  const heCount = nades.filter((n) => n.type === 'hegrenade').length;
  if (heCount && !parts.length) parts.push(plural(heCount, WORDS.hegrenade));
  if (flashCount && !flashes && !parts.length) parts.push(plural(flashCount, WORDS.flashbang));
  return parts.join(', ');
}

/** "B Tunnels" on a B hit reads "Tunnels"; anything else keeps its whole name. */
const laneName = (zone, site) => String(zone || '').replace(new RegExp(`^${site} `), '');

/** Lists of people and places in a note: "1 Long + 1 Mid". */
const countsWord = (counts) => [...counts].map(([name, n]) => `${n} ${name}`).join(' + ');

const sampleAtElapsed = (r, elapsed) => r.series?.[Math.max(0, Math.min(r.series.length - 1, Math.round(elapsed)))] || null;
const elapsedOfClock = (clock) => ROUND_SECONDS - clock;

/** "0:39" -> seconds since the round went live. */
function elapsedOfText(text) {
  const [m, s] = String(text).split(':').map(Number);
  return ROUND_SECONDS - (m * 60 + s);
}

/**
 * A hit that never got onto the site: 3+ Ts on one site's ground together, 2+ of them dead soon after.
 *
 * @returns {{ site: string, at: number } | null}
 */
function stoppedHit(r) {
  const deaths = (r.kills || []).filter((k) => k.victimOurs).map((k) => ({ id: k.victim, at: elapsedOfClock(k.clock) }));
  for (const s of r.series || []) {
    if (s.elapsed < 8) continue;
    for (const site of ['a', 'b']) {
      const on = s.pts.filter((p) => r.siteNear?.(p.x, p.y) === site);
      if (on.length < STOPPED_MIN) continue;
      const ids = new Set(on.map((p) => p.id));
      if (deaths.filter((d) => ids.has(d.id) && d.at >= s.elapsed && d.at <= s.elapsed + STOPPED_SECONDS).length >= 2) return { site, at: s.elapsed };
    }
  }
  return null;
}

/** Who went: on the site's ground from just before the first step to JOIN_SECONDS after it. */
function goersOf(r, site, at) {
  const ids = new Set();
  for (const s of r.series || []) {
    if (s.elapsed < at - 2 || s.elapsed > at + JOIN_SECONDS) continue;
    for (const p of s.pts) if (r.siteNear?.(p.x, p.y) === site) ids.add(p.id);
  }
  return ids;
}

function describeT(r, network, { mapCode, nameOf, zoneOf }) {
  const c = classifyRound(r, network, { nameOf, mapCode });
  const pace = c?.pace || '';
  const opening = pace === 'slow-default' ? 'Slow default' : pace === 'default' ? 'Default' : '';
  const stopped = !c || c.kind === 'no-hit' ? stoppedHit(r) : null;
  const facts = {
    kind: stopped ? 'stopped' : c?.kind || 'no-hit',
    pace: pace || 'other',
    site: stopped ? stopped.site.toUpperCase() : c?.site || null,
    ...(c?.wave_at && c.kind !== 'no-hit' ? { on_site: c.wave_at } : {}),
    ...(r.plantClock != null ? { plant: clockText(r.plantClock) } : {})
  };

  if ((!c || c.kind === 'no-hit') && !stopped) {
    // The shape before the first fight, while most are alive.
    const firstDeath = (r.kills || []).find((k) => k.victimOurs);
    const shapeAt = sampleAtElapsed(r, Math.max(8, Math.min(40, firstDeath ? elapsedOfClock(firstDeath.clock) - 1 : 40)));
    const groups = new Map();
    for (const p of shapeAt?.pts || []) {
      const z = zoneOf(p);
      if (z) groups.set(z, (groups.get(z) || 0) + 1);
    }
    const shape = [...groups].sort((a, b) => b[1] - a[1]).map(([z, n]) => `${n} ${z}`).join(', ');
    const fast = pace === 'rush' || pace === 'pop';
    const lead = opening || (fast ? 'Fast fights' : 'Fights');
    const utility = utilityWords(r.nades);
    return { ...facts, note: `${lead}${shape ? ` (${shape})` : ''}, no site hit${utility ? `: ${utility}` : ''}`, utility };
  }

  const S = stopped ? stopped.site.toUpperCase() : c.site;
  const s = S.toLowerCase();
  const onSiteAt = stopped ? stopped.at : c.wave_at ? elapsedOfText(c.wave_at) : r.plantClock != null ? elapsedOfClock(r.plantClock) : 0;
  const goers = goersOf(r, s, onSiteAt);
  for (const l of c?.lanes || []) for (const name of l.players) for (const [id, who] of nameOf) if (who === name) goers.add(id);
  const n = Math.max(goers.size, 1);
  const size = n >= 5 ? `full 5${S}` : `${n}${S}`;
  const from = (c?.lanes || []).map((l) => laneName(l.from, S)).filter((x) => x && x !== 'unknown');
  let hit;
  if (stopped) hit = `${size} take, stopped before the site`;
  else if (c.kind === 'split') hit = `${size} split from ${from.join(' + ')}`;
  else if (c.kind === 'execute') hit = `${size} execute${from.length ? ` from ${from[0]}` : ''}`;
  else if (c.kind === 'rush') hit = `${size} ${pace === 'pop' ? 'pop' : 'rush'}${from.length ? ` through ${from[0]}` : ''}`;
  else hit = `${size} take${from.length ? ` through ${from[0]}` : ''}`;
  if (c?.fake) hit += ` after a fake ${S === 'A' ? 'B' : 'A'}`;
  if (ROUND_SECONDS - onSiteAt <= LATE_CLOCK) hit = `late ${hit}`;
  const head = opening ? `${opening} into ${hit}` : `${hit[0].toUpperCase()}${hit.slice(1)}`;

  const inWindow = r.nades.filter((g) => g.throwAt >= onSiteAt - HIT_UTIL_BEFORE && g.throwAt <= onSiteAt + HIT_UTIL_AFTER);
  const utility = utilityWords(inWindow);
  const early = r.nades.filter((g) => g.throwAt < onSiteAt - HIT_UTIL_BEFORE).length;

  // Who was not in it: alive when it went in and never on the site's ground around it.
  const away = new Map();
  for (const p of sampleAtElapsed(r, onSiteAt)?.pts || []) {
    if (goers.has(p.id)) continue;
    const where = p.pos || zoneOf(p);
    if (where) away.set(where, (away.get(where) || 0) + 1);
  }
  const awayCount = [...away.values()].reduce((a, b) => a + b, 0);
  const lurk = awayCount && awayCount <= 2 ? `${countsWord(away)} lurk` : '';

  const note = `${head}${utility ? `: ${utility}` : ', no utility'}${lurk ? `; ${lurk}` : ''}`;
  return { ...facts, note, utility, ...(early ? { utility_before_the_hit: early } : {}), ...(lurk ? { lurk } : {}) };
}

/** The middle of where a list of players stands. */
function centre(pts) {
  if (!pts?.length) return null;
  return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
}

function describeCT(r, _network, { zoneOf }) {
  const firstKill = r.kills?.[0];
  const firstAt = firstKill ? elapsedOfClock(firstKill.clock) : Infinity;
  // Before the first fight if it came early: a stand is not a setup once it has been shot at.
  const setupAt = Math.max(10, Math.min(SETUP_AT, firstAt - 1));
  const pts = sampleAtElapsed(r, setupAt)?.pts || [];
  const siteOf = (p) => r.siteNear?.(p.x, p.y) || null;
  const ground = { a: 0, mid: 0, b: 0 };
  for (const p of pts) ground[siteOf(p) || 'mid']++;
  const stack = ground.a >= STACK_MIN ? 'A' : ground.b >= STACK_MIN ? 'B' : '';
  const shape = [ground.a && `${ground.a} A`, ground.mid && `${ground.mid} mid`, ground.b && `${ground.b} B`].filter(Boolean).join(', ');
  const rest = stack ? shape.split(', ').filter((part) => !part.endsWith(` ${stack}`)).join(', ') : '';
  const setup = stack ? `${ground[stack.toLowerCase()]}${stack} stack${rest ? `, ${rest}` : ''}` : shape;

  // Forward: well into the T side's half early, and staying there a moment.
  const tSpawn = centre(r.series?.[0]?.opp);
  const ctSpawn = centre(r.series?.[0]?.pts);
  const pushed = new Map();
  const held = new Map();
  if (tSpawn && ctSpawn) {
    for (const s of r.series) {
      if (s.elapsed < 8 || s.elapsed > PUSH_UNTIL) continue;
      for (const p of s.pts) {
        const forward = Math.hypot(p.x - tSpawn.x, p.y - tSpawn.y) < PUSH_RATIO * Math.hypot(p.x - ctSpawn.x, p.y - ctSpawn.y);
        held.set(p.id, forward ? (held.get(p.id) || 0) + 1 : 0);
        if (forward && held.get(p.id) >= PUSH_HOLD && !pushed.has(p.id)) pushed.set(p.id, p.pos || zoneOf(p) || 'forward');
      }
    }
  }
  const pushZones = new Map();
  for (const where of pushed.values()) pushZones.set(where, (pushZones.get(where) || 0) + 1);
  const push = [...pushZones].map(([where, n]) => `${n} push ${where}`).join(', ');

  // Rotation: a CT whose site at the setup was one, later on the other's ground, before the plant.
  const home = new Map(pts.filter((p) => siteOf(p)).map((p) => [p.id, siteOf(p)]));
  const until = r.plantClock != null ? elapsedOfClock(r.plantClock) + 5 : Infinity;
  const moved = { a: 0, b: 0 };
  for (const s of r.series || []) {
    if (s.elapsed <= setupAt || s.elapsed > until) continue;
    for (const p of s.pts) {
      const h = home.get(p.id);
      const now = siteOf(p);
      if (!h || !now || now === h) continue;
      home.delete(p.id);
      moved[now]++;
    }
  }
  const rotate = moved.a >= 2 ? `rotate ${moved.a} to A` : moved.b >= 2 ? `rotate ${moved.b} to B` : '';

  // After the plant: who walks onto the planted site.
  let after = '';
  if (r.plantClock != null && r.plantSite) {
    const site = r.plantSite.toUpperCase();
    const plantAt = elapsedOfClock(r.plantClock);
    const there = new Set();
    let retook = false;
    for (const s of r.series || []) {
      for (const p of s.pts) {
        if (zoneOf(p) !== `${site} Site`) continue;
        if (s.elapsed <= plantAt) there.add(p.id);
        else if (!there.has(p.id)) retook = true;
      }
    }
    after = retook ? `retake ${site}` : !r.won && r.series?.at(-1)?.pts?.length ? 'save' : '';
  }

  // The utility of the setup: what went out before the plant.
  const utility = utilityWords(r.nades.filter((g) => r.plantClock == null || g.clock >= r.plantClock), { flashes: false });
  const moves = [push, rotate, after].filter(Boolean).join(', ');
  const note = `${setup || 'Setup not read'}${utility ? `: ${utility}` : ', no utility'}${moves ? `; ${moves}` : ''}`;
  return {
    kind: stack ? 'stack' : 'setup',
    setup: shape,
    ...(stack ? { stack } : {}),
    site: r.hitSite ? r.hitSite.toUpperCase() : null,
    ...(r.plantClock != null ? { plant: clockText(r.plantClock) } : {}),
    note,
    utility,
    ...(push ? { push } : {}),
    ...(rotate ? { rotate } : {}),
    ...(after ? { after_plant: after } : {})
  };
}

/**
 * One side's round as a coach's line and the facts behind it.
 *
 * @param {object} r  antistratScan roundFeatures (the side to describe is r.side)
 * @param {object} network  the map's zone network
 * @param {{ mapCode?: string, nameOf?: Map<string, string> }} [opts]
 * @returns {{ note: string, kind: string, utility: string, site: string|null }}
 */
export function describeRound(r, network, { mapCode = '', nameOf = new Map() } = {}) {
  if (!r.series?.length) return { note: '', kind: 'unread', utility: utilityWords(r.nades || []), site: null };
  const places = placeIndex(network);
  const zoneOf = (p) => (p.pos ? places.get(p.pos)?.zone || p.pos : '');
  return r.side === 'T' ? describeT(r, network, { mapCode, nameOf, zoneOf }) : describeCT(r, network, { zoneOf });
}
