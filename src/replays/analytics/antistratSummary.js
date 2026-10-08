// ---------------------------------------------------------------------------
// replays/analytics/antistratSummary.js
// Teams antistrat, summary mode: the prep sheet a coach writes by hand.
//
// The detailed report (antistratConfig.js) prints every number the scan has.
// This one keeps what a player needs before the match and says it the way a
// coach would: "Short flash: Always B (12 of 12)", rounds as their variations
// ("2x Slow default 1-2-2 with smoke CT A into A exec from Short"), site
// rounds by the kind of hit they are, and a paragraph per player about what
// they actually do. Notes are written in green, negative findings in red,
// which is how those sheets are written.
//
// It is printed, so nothing links anywhere, and it makes no calls of its own:
// it says what the team does and how often, and the analyst writes the plan.
//
// Same scan, same rounds (antistratScan.js `extract`). The per-round reads
// (entries, lurks, boosts, which utility was a read) live in
// antistratReads.js so every section asks them the same way.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';
import { phaseAtTick } from '../coach/roundPhases.js';
import { positionsAtPoint } from '../zones/pointInZone.js';
import { FORMATIONS, paceType } from './patternDefs.js';
import { BUY_CONTEXTS, TELL_MIN_ROUNDS, classifyPace, nadeLabel, paceSite, typeLabels } from './antistratScan.js';
import { demoTimestamp, tagTrigger } from '../shared/statsMath.js';
import {
  ALONE_UNITS,
  aggressiveMovesOf,
  awpSpotOf,
  boostsOf,
  commitElapsed,
  ctStackOf,
  entryOf,
  formationOf,
  killRead,
  laneOfPos,
  leanOf,
  lurkersOf,
  median,
  oppToward,
  roundSite,
  sampleAtElapsed,
  smokeBreaksOf,
  tally,
  tellUtility,
  throwElapsed,
  utilKey
} from './antistratReads.js';
import { say } from './reportMessages.js';
import {
  capitalize,
  clockText,
  countWord,
  frequencyWord,
  joinList,
  nadeName,
  nadePlural,
  NADE_SLANG,
  paragraph,
  percent,
  plural,
  sentence
} from './reportProse.js';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** @type {Array<{ key: string, group: string, label: string }>} */
export const SUMMARY_CATEGORIES = [
  { key: 'sideT', group: 'Sides', label: 'T side' },
  { key: 'sideCT', group: 'Sides', label: 'CT side' },
  { key: 'positions', group: 'Sections', label: 'Positions' },
  { key: 'pace', group: 'Sections', label: 'Pace and calls' },
  { key: 'tells', group: 'Sections', label: 'Tells' },
  { key: 'defaults', group: 'Sections', label: 'Default utility' },
  { key: 'danger', group: 'Sections', label: 'Dangerous rounds and openings' },
  { key: 'force', group: 'Sections', label: 'Force buys' },
  { key: 'antiforce', group: 'Sections', label: 'Anti-ecos and antiforces' },
  { key: 'sites', group: 'Sections', label: 'Site rounds and retakes' },
  { key: 'pistols', group: 'Sections', label: 'Pistols' },
  { key: 'players', group: 'Sections', label: 'Players' },
  { key: 'misc', group: 'Sections', label: 'Misc statistics' }
];

export const SUMMARY_GROUPS = ['Sides', 'Sections'];

/** The analyst's notes. Reads on the dark page and on paper. */
export const NOTE_COLOR = '#6aa84f';
/** "No tells for first buy": a finding that something is missing. */
export const NEGATIVE_COLOR = '#e06666';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const FAST = ['rush', 'pop', 'contact'];
const SIDE_OF = { T: 'T', CT: 'CT' };
/** An opening this early on the clock (seconds left, 1:30) is an aggressive one. */
const AGGRESSIVE_CLOCK = 90;
/** The midround read for AWP spots and holds: 1:20 on the clock. */
const MIDROUND_ELAPSED = 35;
/**
 * Utility that lands later than 1:20 belongs to a default that turned into a
 * midround call: its timing follows what the other team showed, so the sheet
 * never prints it. Earlier than that it is a set call, and the clock is the
 * most useful thing on the line.
 */
const SET_CALL_ELAPSED = 35;

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

function top(map) {
  let best = null;
  for (const [k, v] of map) if (!best || v > best[1]) best = [k, v];
  return best;
}

function mostCommon(list, pick) {
  return tally(list, pick)[0]?.[0] || '';
}

/** Words of a call label in the case a sentence wants: "B Split" -> "B split". */
export function callWords(label) {
  return String(label || '')
    .trim()
    .split(/\s+/)
    .map((w) => (/^[A-Z][A-Z0-9]{0,3}$/.test(w) || /^\d/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/**
 * A call as a tell's answer: "All B hits" -> "B", "Mid take" -> "mid",
 * "A Pop" -> "A pop". The sheet says where the round goes, not what the
 * library calls it.
 */
export function shortCall(label) {
  const s = String(label || '').trim();
  let m = /^all ([ab]) hits$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^(.+?) take$/i.exec(s);
  if (m) return callWords(m[1]);
  if (/^default/i.test(s)) return 'default';
  return callWords(s);
}

/** "All B hits" -> "B hit", "B Split" -> "B split": a call inside a sentence. */
function callName(label) {
  const s = String(label || '').trim();
  const m = /^all ([ab]) hits$/i.exec(s);
  if (m) return `${m[1].toUpperCase()} hit`;
  return callWords(s);
}

/**
 * The lane a sheet would name: a site lane by its letter ("Con / A" -> "A",
 * "B / UG" -> "B"), anything else by its name ("Mid" -> "mid", "Long" -> "long").
 */
function laneWord(lane) {
  const short = String(lane?.short || '').trim();
  if (/^[AB]$/i.test(short)) return short.toUpperCase();
  const first = String(lane?.label || short).split('/')[0].trim();
  return /^[A-Z]$/.test(first) ? first : first.toLowerCase();
}

function zoneAt(x, y, network) {
  if (!network || !Number.isFinite(x) || !Number.isFinite(y)) return '';
  return positionsAtPoint(x, y, network).map((z) => z.name)[0] || '';
}

function siteLetter(site) {
  return site ? String(site).toUpperCase() : '';
}

/** Specific (named, not "default", not "All X hits") tags a side carried. */
function specificTags(r, side) {
  return (r.tags?.[side] || []).filter(
    (t) => t.k && t.k !== 'default' && !/^all-[ab]-hits$/.test(t.k) && !/afterplant|retake/.test(t.k)
  );
}

function namedTags(r, side) {
  return (r.tags?.[side] || []).filter((t) => t.k && t.k !== 'default');
}

/** A player's name as the sheet's header writes it: the main's own name first. */
/**
 * A line of the sheet and the rounds it was written from. The rounds only
 * show when the document is built with links on (for checking the sheet).
 */
const line = (text, rounds) => ({
  text,
  files: [...new Set((rounds || []).map((r) => (typeof r === 'string' ? r : r?.r?.file || r?.file)).filter(Boolean))]
});
const filesOf = (rounds) => line('', rounds).files;

const nameOf = (ctx, id) => ctx.mains?.find((m) => m.id === id)?.name || ctx.nameOf.get(id) || id;
const won = (list) => list.filter((x) => (x.r || x).won).length;
/** A clock worth printing: only set calls, never the midround. */
const setClock = (elapsed) =>
  Number.isFinite(elapsed) && elapsed <= SET_CALL_ELAPSED ? clockText(ROUND_SECONDS - elapsed) : '';

/** "Smoke B Doors + Window, molo Backplat + Car, 3 flashes". */
function utilitySummary(util, flashes = 0) {
  const parts = utilityParts(util.filter((u) => u.type !== 'flashbang'));
  if (flashes >= 1) parts.push(plural(Math.round(flashes), 'flash', 'flashes'));
  return parts.join(', ');
}

/** Formation counts as the sheet writes them, every lane named: "2-1-2". */
const formText = (counts) => (counts ? counts.join('-') : '');

/**
 * The formation a set of rounds shares, or '' when they do not share one:
 * a line naming one round's "0-1-4" for five rounds that all differ is wrong
 * about four of them.
 */
function sharedForm(list, pick) {
  const [form, n] = tally(list, (x) => formText(pick(x)))[0] || ['', 0];
  return form && (list.length === 1 || (n >= 2 && n * 5 >= list.length * 2)) ? form : '';
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Early ground a player lives on, as a lane label (T) or a position (CT). */
function observedRole(ctx, side, id) {
  const lanes = FORMATIONS[ctx.mapCode]?.t || [];
  const counts = new Map();
  let n = 0;
  let awp = 0;
  let full = 0;
  for (const r of ctx.rounds) {
    if (r.side !== side || !r.hasTicks || r.ownEcon < 4) continue;
    full++;
    if (r.series.some((s) => s.pts.some((p) => p.id === id && p.awp))) awp++;
    for (const s of r.series) {
      if (s.elapsed < 8 || s.tick >= r.bounds.midStartTick) continue;
      const p = s.pts.find((x) => x.id === id);
      if (!p) continue;
      n++;
      if (side === 'T') {
        const l = laneOfPos(p.pos, ctx.laneSets);
        if (l >= 0 && lanes[l]) bump(counts, lanes[l].label);
      } else if (p.pos) bump(counts, p.pos);
    }
  }
  if (awp >= 5 && percent(awp, full) >= 35) return { label: 'AWPer', share: 100 };
  const best = top(counts);
  return best ? { label: best[0], share: percent(best[1], n) } : { label: '', share: 0 };
}

const sameGround = (role, label) => {
  const a = String(role || '').toLowerCase();
  const b = String(label || '').toLowerCase();
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
};

/**
 * One role per player per side. The roles system's vote comes first; when two
 * players carry the same one, it stays with whoever actually plays there and
 * the other is named for the ground they really hold. A sheet with two "A
 * Long" players in it is wrong about one of them.
 */
export function rolesFor(ctx, side) {
  return (ctx._roles ||= {})[side] ||= (() => {
    const rows = ctx.mains.map((m) => ({
      id: m.id,
      role: ctx.rolesOf?.(m.id, side) || '',
      seen: observedRole(ctx, side, m.id)
    }));
    const out = new Map();
    const byRole = new Map();
    for (const row of rows) {
      if (!row.role) continue;
      if (!byRole.has(row.role)) byRole.set(row.role, []);
      byRole.get(row.role).push(row);
    }
    for (const row of rows) {
      if (!row.role) {
        out.set(row.id, row.seen.label || '');
        continue;
      }
      const group = byRole.get(row.role);
      if (group.length === 1) {
        out.set(row.id, row.role);
        continue;
      }
      const keeper =
        group.find((g) => sameGround(g.role, g.seen.label)) ||
        [...group].sort((a, b) => b.seen.share - a.seen.share)[0];
      out.set(row.id, row === keeper ? row.role : row.seen.label || row.role);
    }
    return out;
  })();
}

function positionsFor(ctx, side) {
  const roles = rolesFor(ctx, side);
  return ctx.mains.map((m) => ({ id: m.id, name: m.name, role: roles.get(m.id) || '' }));
}

// ---------------------------------------------------------------------------
// Pace (T) and calls (CT)
// ---------------------------------------------------------------------------

/**
 * T pace rows with the notes a coach writes beside them.
 *
 * The notes follow one thread down the fast paces: the site they never go to
 * early. "They never rush A", then "Only 1 round early A", then "Still never
 * early A" once the same gap shows a second time.
 */
function paceFor(ctx) {
  const buys = ctx.rounds.filter((r) => r.side === 'T' && r.ownEcon >= 2 && r.hasTicks);
  const keys = ['rush', 'pop', 'contact', 'full-exec', 'default', 'slow-default', 'other'];
  const byPace = new Map(keys.map((k) => [k, []]));
  for (const r of buys) {
    const p = classifyPace(r) || 'other';
    (byPace.get(p) || byPace.get('other')).push(r);
  }
  const rows = keys.map((key) => {
    const list = byPace.get(key) || [];
    let a = 0;
    let b = 0;
    for (const r of list) {
      const s = paceSite(r);
      if (s === 'a') a++;
      else if (s === 'b') b++;
    }
    return {
      pace: key,
      label: paceType(key)?.label || 'Other',
      count: list.length,
      share: percent(list.length, buys.length),
      siteA: a,
      siteB: b,
      files: list.map((r) => r.file),
      note: ''
    };
  });

  const never = new Set();
  for (const row of rows) {
    const seed = `${ctx.seed}|pace|${row.pace}`;
    if (FAST.includes(row.pace) && row.count > 0) {
      const total = row.siteA + row.siteB;
      if (total < 2) continue;
      const minority = row.siteA <= row.siteB ? 'A' : 'B';
      const n = Math.min(row.siteA, row.siteB);
      if (n === 0) {
        row.note = say(never.has(minority) ? 'pace-never-again' : 'pace-never', seed, {
          verb: row.pace === 'rush' ? 'rush' : 'go early',
          site: minority
        });
        never.add(minority);
      } else if (n === 1) {
        row.note = say('pace-once', seed, { site: minority });
      } else if (percent(n, total) <= 25) {
        row.note = say('pace-rare', seed, { site: minority, n, total });
      }
    }
    if (row.pace === 'full-exec' && row.count >= 2) {
      const total = row.siteA + row.siteB;
      const lead = row.siteA >= row.siteB ? 'A' : 'B';
      const n = Math.max(row.siteA, row.siteB);
      const freq = frequencyWord(n, total);
      if (total >= 2 && freq) row.note = say('pace-exec-site', seed, { freq, site: lead });
    }
  }
  // Defaults are only worth a note when they are rare: under 40% of buys.
  const def = rows.find((r) => r.pace === 'default');
  const slow = rows.find((r) => r.pace === 'slow-default');
  const defaults = percent((def?.count || 0) + (slow?.count || 0), buys.length);
  if (slow && buys.length && defaults < 40) {
    slow.note = say('pace-defaults', `${ctx.seed}|defaults`, { share: defaults });
  }
  return { basis: buys.length, files: filesOf(buys), rows };
}

/** The calls the round library names on CT, as a share of every CT round. */
function ctCallsFor(ctx) {
  const labels = typeLabels(ctx.mapCode, 'CT');
  const all = ctx.rounds.filter((r) => r.side === 'CT');
  const calls = new Map();
  for (const r of all) {
    for (const t of specificTags(r, 'CT')) {
      if (!calls.has(t.k)) calls.set(t.k, { rounds: [], times: [] });
      const c = calls.get(t.k);
      c.rounds.push(r);
      const at = tagTrigger(t);
      if (at !== null) c.times.push(at);
    }
  }
  const rows = [...calls.entries()]
    .map(([key, c]) => ({
      label: labels.get(key) || key,
      count: c.rounds.length,
      share: percent(c.rounds.length, all.length),
      winrate: percent(won(c.rounds), c.rounds.length),
      clock: c.times.length ? clockText(ROUND_SECONDS - median(c.times)) : '',
      files: c.rounds.map((r) => r.file)
    }))
    .filter((c) => c.count >= 2)
    .sort((x, y) => y.count - x.count)
    .slice(0, 6);
  return { calls: rows, files: filesOf(all) };
}

// ---------------------------------------------------------------------------
// Tells
// ---------------------------------------------------------------------------

/** A tell's answer has to beat how often that answer happens anyway by this. */
const TELL_MIN_LIFT = 20;
const TELL_SHARE = 75;
/** A negative tell: utility in this share of rounds or more... */
const ABSENT_USUAL = 60;
/** ...whose absence points one way at least this often. */
const ABSENT_SHARE = 75;
const TELLS_PER_OUTCOME = 3;

/**
 * What one round "went", in the words a tell answers with.
 *
 * T: the site, how it was hit (rush, pop, execute, split, the entrance), and
 * the round-library calls it carried. CT: the calls they chose, the stack, and
 * where the AWP stood at 1:35. "All B hits" on a CT round is the other team's
 * decision, so it never answers a CT tell.
 */
function roundOutcomes(r, side, labels, ctx) {
  const out = new Map();
  const add = (word, specific = true) => {
    if (!word) return;
    const prev = out.get(word);
    out.set(word, { word, specific: Boolean(prev?.specific) || specific });
  };
  const tags = side === 'CT' ? specificTags(r, side) : namedTags(r, side);
  for (const t of tags) {
    const word = shortCall(labels.get(t.k) || t.k);
    if (!word || word === 'default' || /afterplant|retake/.test(t.k)) continue;
    add(word, !/^all-[ab]-hits$/.test(t.k));
  }
  if (side === 'T') {
    const site = roundSite(r);
    if (site) {
      add(site, false);
      const pace = classifyPace(r);
      if (pace === 'rush') add(`${site} rush`);
      else if (pace === 'pop') add(`${site} pop`);
      else if (pace === 'contact') add(`early ${site}`);
      else if (pace === 'full-exec') add(`${site} execute`);
      const e = r.hasTicks ? entryOf(r, ctx.laneSets) : null;
      if (e?.site === site) {
        if (e.split) add(`${site} split`);
        else if (e.route) add(`${site} through ${e.route}`);
      }
    }
  } else {
    // "Something non-default": any of their early aggression calls, as one
    // answer. Where each call alone is too rare to read, together they are not.
    const aggressive = specificTags(r, side).filter((t) => AGGRESSION_CALL.test(labels.get(t.k) || t.k));
    if (aggressive.length) add('early aggression');
  }
  if (side === 'CT' && r.hasTicks) {
    // Where each of the five stands at 1:35: "MAHAR_- close Balc".
    const s = sampleAtElapsed(r, 20);
    for (const m of ctx.mains || []) {
      const p = s?.pts.find((x) => x.id === m.id);
      if (p?.pos) add(`${m.name} ${p.pos}`);
    }
    const stack = ctStackOf(r);
    if (stack) add(`${stack} stack`);
    const awp = awpArea(r, awpSpotOf(r, 20), ctx);
    if (awp) add(`AWP ${awp}`);
  }
  return out;
}

/**
 * A position as the part of the map it belongs to: a T lane by its word
 * ("long", "mid", "B"), else the site whose ground it is on, else the
 * position itself. Thirty AWP spots say nothing; four areas do.
 */
function areaOf(r, pos, ctx) {
  if (!pos) return '';
  const lanes = FORMATIONS[ctx.mapCode]?.t || [];
  const l = laneOfPos(pos, ctx.laneSets);
  if (l >= 0 && lanes[l]) return laneWord(lanes[l]);
  const p = r.series.flatMap((s) => s.pts).find((x) => x.pos === pos);
  const site = p ? r.siteNear(p.x, p.y) : null;
  return site ? site.toUpperCase() : pos;
}

function awpArea(r, pos, ctx) {
  return areaOf(r, pos, ctx);
}

/** CT calls that are early aggression rather than a setup. */
const AGGRESSION_CALL = /push|fight|solo|start|peek|aggress/i;

const regionWord = (region) => (region ? region.toUpperCase() : 'mid');

/** "Doors smoke", "Utility on B early", "2+ smokes on B by 1:30", "mid nade". */
function featureWords(f, side) {
  switch (f.kind) {
    case 'util':
      return nadeName(f.name, f.type);
    case 'region':
      return side === 'T'
        ? `Smoke or molo anywhere on ${regionWord(f.region)} site before the hit`
        : `Smoke or molo on ${regionWord(f.region)} site early`;
    case 'count':
      return `2+ ${nadePlural(f.type)} on ${regionWord(f.region)} by 1:30`;
    case 'typeRegion':
      return `${regionWord(f.region)} ${NADE_SLANG[f.type] || 'nade'}`;
    default:
      return '';
  }
}

const featureCache = new WeakMap();

/**
 * The tell features one round showed: each piece of read utility by name,
 * any smoke or molotov on a site's ground before the hit, two of a kind on one
 * site by 1:30, and each kind of grenade per region.
 */
function tellFeatures(r) {
  if (featureCache.has(r)) return featureCache.get(r);
  const feats = new Map();
  const add = (key, f) => {
    if (!feats.has(key)) feats.set(key, { key, ...f });
  };
  const counts = new Map();
  for (const n of tellUtility(r)) {
    const region = n.region || '';
    add(`u\0${utilKey(n)}`, { kind: 'util', name: nadeLabel(n), type: n.type, region });
    add(`t\0${region}\0${n.type}`, { kind: 'typeRegion', region, type: n.type });
    if (n.type === 'smokegrenade' || n.type === 'molotov') {
      // "If anywhere on B is molotoved, it's B": the bombsite itself.
      if (n.onSite) add(`g\0${n.onSite}`, { kind: 'region', region: n.onSite });
      if (region && throwElapsed(n) <= 25) bump(counts, `${region}\0${n.type}`);
    }
  }
  for (const [k, c] of counts) {
    if (c < 2) continue;
    const [region, type] = k.split('\0');
    add(`c\0${k}`, { kind: 'count', region, type });
  }
  featureCache.set(r, feats);
  return feats;
}

/**
 * Utility that gives the round away, read as "where does it go".
 *
 * The pool is every round's read utility (antistratReads.tellUtility): mid
 * utility before the round commits, and site utility seen well before the
 * plant with nothing dying straight after it. Each feature seen in enough
 * rounds is answered with the outcome most of its rounds share, kept when that
 * answer is reliable and beats how often it happens anyway.
 *
 * @param {object[]} set   rounds to read (one side)
 * @param {'T'|'CT'} side
 * @param {object} ctx
 * @param {{ minRounds?: number, minShare?: number, limit?: number }} [opts]
 */
export function tellsOver(
  set,
  side,
  ctx,
  { minRounds = TELL_MIN_ROUNDS, minShare = TELL_SHARE, limit = 10, siteCap = 2, outcomeCap = TELLS_PER_OUTCOME } = {}
) {
  const labels = typeLabels(ctx.mapCode, side);
  const outcomesOf = new Map(set.map((r) => [r.file, roundOutcomes(r, side, labels, ctx)]));
  const base = new Map();
  for (const o of outcomesOf.values()) for (const x of o.values()) bump(base, x.word);
  /** key -> { f, files: [] } */
  const byKey = new Map();
  for (const r of set) {
    for (const f of tellFeatures(r).values()) {
      if (f.kind === 'typeRegion') continue;
      if (!byKey.has(f.key)) byKey.set(f.key, { f, files: [] });
      byKey.get(f.key).files.push(r.file);
    }
  }
  const candidates = [];
  for (const { f, files } of byKey.values()) {
    const n = files.length;
    if (n < minRounds) continue;
    const t = new Map();
    for (const file of files) {
      for (const o of outcomesOf.get(file).values()) {
        if (!t.has(o.word)) t.set(o.word, { hits: 0, files: [], specific: o.specific });
        const bag = t.get(o.word);
        bag.hits++;
        bag.files.push(file);
      }
    }
    // The best answer that says something: reliable, and well above how often
    // it happens anyway. A call they run in 90% of rounds answers every tell
    // and so answers none.
    const best = [...t.entries()]
      .map(([word, bag]) => ({ word, bag, share: percent(bag.hits, n), lift: percent(bag.hits, n) - percent(base.get(word) || 0, set.length) }))
      .filter((x) => x.share >= minShare && x.lift >= TELL_MIN_LIFT)
      .sort((a, b) => b.share - a.share || Number(b.bag.specific) - Number(a.bag.specific) || b.lift - a.lift)[0];
    if (!best) continue;
    const share = best.share;
    candidates.push({
      utility: featureWords(f, side),
      kind: f.kind,
      region: f.region,
      name: f.name,
      type: f.type,
      outcome: best.word,
      hits: best.bag.hits,
      rounds: n,
      share,
      freq: frequencyWord(best.bag.hits, n, minShare) || 'Mostly',
      files,
      hitFiles: best.bag.files
    });
  }
  // Mid utility first: it is the read that could have gone either way. Then
  // the broad site reads, then single pieces of site utility, one per answer.
  // Site utility is ranked by how much of it there is: "Stairs smoke: Always
  // A (40 of 40)" is worth more than a 5-round flash with the same answer.
  const rank = (t) => (t.kind === 'util' && !t.region ? 0 : t.kind === 'region' || t.kind === 'count' ? 1 : 2);
  candidates.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 2 ? b.rounds - a.rounds : 0) ||
      b.share - a.share ||
      b.rounds - a.rounds ||
      a.utility.localeCompare(b.utility)
  );
  const perOutcome = new Map();
  const perSiteRead = new Map();
  const out = [];
  for (const t of candidates) {
    const used = perOutcome.get(t.outcome) || 0;
    if (used >= outcomeCap) continue;
    if (t.kind === 'util' && t.region) {
      const key = `${t.region}|${t.outcome}`;
      if ((perSiteRead.get(key) || 0) >= siteCap) continue;
      perSiteRead.set(key, (perSiteRead.get(key) || 0) + 1);
    }
    perOutcome.set(t.outcome, used + 1);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The other half of a tell: utility they throw in most rounds, and where the
 * rounds WITHOUT it go. A window smoke in 70% of rounds is nothing; the 30%
 * that skip it going A eight times in ten is.
 */
function absenceTellsOver(set, side, ctx, { limit = 4 } = {}) {
  if (set.length < 8) return [];
  const labels = typeLabels(ctx.mapCode, side);
  const outcomesOf = new Map(set.map((r) => [r.file, roundOutcomes(r, side, labels, ctx)]));
  const base = new Map();
  for (const o of outcomesOf.values()) for (const x of o.values()) bump(base, x.word);
  const usage = new Map();
  for (const r of set) {
    for (const f of tellFeatures(r).values()) {
      if (f.kind === 'region') continue;
      if (!usage.has(f.key)) usage.set(f.key, { f, n: 0 });
      usage.get(f.key).n++;
    }
  }
  const out = [];
  for (const { f, n } of usage.values()) {
    const usual = percent(n, set.length);
    if (usual < ABSENT_USUAL) continue;
    const without = set.filter((r) => !tellFeatures(r).has(f.key));
    if (without.length < 4) continue;
    const t = new Map();
    const hitFiles = new Map();
    for (const r of without) {
      for (const o of outcomesOf.get(r.file).values()) {
        bump(t, o.word);
        if (!hitFiles.has(o.word)) hitFiles.set(o.word, []);
        hitFiles.get(o.word).push(r.file);
      }
    }
    const best = [...t.entries()]
      .map(([word, hits]) => ({ word, hits, share: percent(hits, without.length) }))
      .filter((x) => x.share >= ABSENT_SHARE && x.share - percent(base.get(x.word) || 0, set.length) >= TELL_MIN_LIFT)
      .sort((a, b) => b.share - a.share || b.word.length - a.word.length)[0];
    if (!best) continue;
    const share = best.share;
    out.push({
      utility: featureWords(f, side),
      usual,
      outcome: best.word,
      hits: best.hits,
      rounds: without.length,
      share,
      freq: frequencyWord(best.hits, without.length, ABSENT_SHARE) || 'Mostly',
      files: without.map((r) => r.file),
      hitFiles: hitFiles.get(best.word) || []
    });
  }
  out.sort((a, b) => b.share - a.share || b.rounds - a.rounds);
  const seen = new Set();
  return out.filter((t) => (seen.has(t.outcome) ? false : seen.add(t.outcome))).slice(0, limit);
}

/**
 * Site utility that reads, grouped by what it reads as: "Tetris flash (21 of
 * 22), A smoke (19 of 20), Stairs smoke (12 of 13): Mostly A". One line per
 * answer instead of one per grenade, so every piece of it fits on the sheet.
 */
function siteTellGroups(list) {
  const by = new Map();
  for (const t of list) {
    if (!by.has(t.outcome)) by.set(t.outcome, []);
    by.get(t.outcome).push(t);
  }
  return [...by.entries()]
    .map(([outcome, items]) => {
      const shown = [...items].sort((a, b) => b.rounds - a.rounds || b.share - a.share).slice(0, 5);
      return {
        outcome,
        freq: shown.every((t) => t.hits === t.rounds) ? 'Always' : 'Mostly',
        items: shown,
        rounds: shown.reduce((n, t) => n + t.rounds, 0)
      };
    })
    .sort((a, b) => b.rounds - a.rounds)
    .slice(0, 4);
}

function tellsFor(ctx, side) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 2);
  const all = tellsOver(set, side, ctx, { limit: 60, siteCap: 99, outcomeCap: 99 });
  const isSite = (t) => t.kind === 'util' && t.region;
  const siteGroups = siteTellGroups(all.filter(isSite));
  const perOutcome = new Map();
  const tells = [];
  for (const t of all.filter((x) => !isSite(x))) {
    const used = perOutcome.get(t.outcome) || 0;
    if (used >= TELLS_PER_OUTCOME || tells.length >= 8) continue;
    perOutcome.set(t.outcome, used + 1);
    tells.push(t);
  }
  const absent = absenceTellsOver(set, side, ctx);
  const first = set.filter((r) => BUY_CONTEXTS[0].test(r));
  let firstBuy = null;
  if (first.length >= 2) {
    const found = tellsOver(first, side, ctx, { minRounds: 3, minShare: 100, limit: 2 });
    firstBuy = { rounds: first.length, tells: found };
  }
  return { rounds: set.length, files: filesOf(set), tells, siteGroups, absent, firstBuy };
}

// ---------------------------------------------------------------------------
// Default utility
// ---------------------------------------------------------------------------

/**
 * Utility a side throws in most full buy against full buy rounds: their
 * default. Each with how often, when (only when it is early enough to be a
 * timing) and who throws it when one player owns it.
 */
function defaultUtilityFor(ctx, side) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 4 && r.oppEcon >= 4);
  if (set.length < 6) return null;
  const rec = new Map();
  for (const r of set) {
    const seen = new Set();
    for (const n of r.nades) {
      const label = nadeLabel(n);
      if (!label) continue;
      const k = `${label}\0${n.type}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!rec.has(k)) rec.set(k, { label, type: n.type, rounds: 0, files: [], times: [], throwers: new Map() });
      const u = rec.get(k);
      u.rounds++;
      u.files.push(r.file);
      u.times.push(throwElapsed(n));
      bump(u.throwers, n.player);
    }
  }
  const rows = [...rec.values()]
    .filter((u) => percent(u.rounds, set.length) > 50)
    .map((u) => {
      const t = median(u.times);
      const who = top(u.throwers);
      return {
        key: `${u.label}\0${u.type}`,
        label: u.label,
        type: u.type,
        share: percent(u.rounds, set.length),
        clock: t !== null && t <= SET_CALL_ELAPSED ? clockText(ROUND_SECONDS - t) : '',
        thrower: who && percent(who[1], u.rounds) >= 50 ? nameOf(ctx, who[0]) : '',
        files: u.files
      };
    })
    .sort((a, b) => b.share - a.share || a.label.localeCompare(b.label));
  return { rounds: set.length, files: filesOf(set), rows };
}

/** Default utility they drop on a given set of rounds: "No Mid smoke (85% of full buys, 10% here)". */
function droppedDefaults(ctx, side, set, defaults) {
  if (!defaults?.rows?.length || set.length < 4) return [];
  const notes = [];
  for (const row of defaults.rows) {
    if (row.share < 60) continue;
    const here = set.filter((r) => r.nades.some((n) => `${nadeLabel(n)}\0${n.type}` === row.key)).length;
    const pct = percent(here, set.length);
    if (pct > 25 || row.share - pct < 40) continue;
    notes.push(`No ${nadeName(row.label, row.type)} (${row.share}% of full buys, ${pct}% here).`);
  }
  return notes.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Rounds, grouped into variations
// ---------------------------------------------------------------------------

/** Seconds before the commit that still count as the call's utility. */
const CALL_UTILITY_LEAD = 25;

/**
 * Named utility thrown in at least half of a group's rounds, in throw order.
 * Only what went in around the call: from CALL_UTILITY_LEAD seconds before it
 * commits to a few seconds after.
 */
function groupUtility(list, share = 0.5) {
  const bag = new Map();
  for (const r of list) {
    const seen = new Set();
    const commit = commitElapsed(r);
    for (const n of r.nades) {
      const label = nadeLabel(n);
      if (!label) continue;
      const t = throwElapsed(n);
      if (commit !== null && (t < commit - CALL_UTILITY_LEAD || t > commit + 5)) continue;
      const key = `${label}|${n.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!bag.has(key)) {
        bag.set(key, { label, type: n.type, region: n.region || '', rounds: 0, times: [], lands: [], throwers: new Map() });
      }
      const rec = bag.get(key);
      rec.rounds++;
      rec.times.push(t);
      rec.lands.push(n.at);
      bump(rec.throwers, n.player);
    }
  }
  const need = Math.max(1, Math.ceil(list.length * share));
  return [...bag.values()]
    .filter((u) => u.rounds >= need)
    .map((u) => ({ ...u, t: median(u.times), land: median(u.lands) }))
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

/** Flashes thrown into a hit per round, around the commit, on that site's ground when given. */
function hitFlashes(list, site = '') {
  const region = site.toLowerCase();
  const per = list.map((r) => {
    const commit = commitElapsed(r);
    return r.nades.filter((n) => {
      if (n.type !== 'flashbang') return false;
      if (region && (n.near || n.region) !== region) return false;
      const t = throwElapsed(n);
      return commit === null || (t >= commit - CALL_UTILITY_LEAD && t <= commit + 5);
    });
  });
  return { perRound: median(per.map((l) => l.length)) || 0, all: per.flat() };
}

/** Per kind, how many spots one line names before it stops being a summary. */
const UTILITY_PER_KIND = { smokegrenade: 3, molotov: 3, flashbang: 2, hegrenade: 2 };

/** "smokes Top Con and B Site, molo Yekindar + Backsite, flash B Main". */
export function utilityWords(util) {
  return joinList(utilityParts(util));
}

function utilityParts(util) {
  const byType = { smokegrenade: [], molotov: [], flashbang: [], hegrenade: [] };
  for (const u of util) {
    const list = byType[u.type];
    if (list && list.length < UTILITY_PER_KIND[u.type]) list.push(u.label);
  }
  const parts = [];
  const smokes = byType.smokegrenade;
  if (smokes.length) parts.push(`${smokes.length > 1 ? 'smokes' : 'smoke'} ${joinList(smokes, '+')}`);
  if (byType.molotov.length) parts.push(`${NADE_SLANG.molotov} ${joinList(byType.molotov, '+')}`);
  const flashes = byType.flashbang;
  if (flashes.length) parts.push(`${flashes.length > 1 ? nadePlural('flashbang') : 'flash'} ${joinList(flashes, '+')}`);
  if (byType.hegrenade.length) parts.push(`${NADE_SLANG.hegrenade} ${joinList(byType.hegrenade, '+')}`);
  return parts;
}

const paceGroup = (p) => (p === 'slow-default' ? 'default' : p || 'other');

/**
 * What a round looked like up to the moment it committed: pace, site, where
 * the players started, the utility, how it went in and when. Two rounds with
 * the same shape are the same round played twice.
 */
function shapeOf(r, ctx, side) {
  const commit = commitElapsed(r);
  const util = new Set();
  for (const n of r.nades) {
    const label = nadeLabel(n);
    if (!label || (n.type !== 'smokegrenade' && n.type !== 'molotov')) continue;
    if (commit !== null && n.at > commit + 3) continue;
    util.add(`${label}\0${n.type}`);
  }
  const pace = side === 'T' ? classifyPace(r) : '';
  return {
    r,
    pace: side === 'T' ? paceGroup(pace) : 'ct',
    slow: pace === 'slow-default',
    site: roundSite(r),
    commit,
    util,
    counts: side === 'T' ? formationOf(r, ctx.mapCode, ctx.laneSets) : null,
    entry: side === 'T' && r.hasTicks ? entryOf(r, ctx.laneSets) : null,
    lean: side === 'T' && r.hasTicks ? leanOf(r) : '',
    call: side === 'CT' ? specificTags(r, 'CT')[0]?.k || '' : '',
    stack: side === 'CT' && r.hasTicks ? ctStackOf(r) : ''
  };
}

/**
 * Same round or not. T: same pace, the same site for anything that commits
 * early, the players starting within a body of each other, the utility
 * mostly the same, and the timing within five seconds (fifteen for slower
 * rounds). CT: the same call and the same stack.
 */
function sameShape(a, b) {
  if (a.pace !== b.pace) return false;
  if (a.pace === 'ct') return a.call === b.call && a.stack === b.stack;
  const open = a.pace === 'default' || a.pace === 'other';
  if (!open && a.site !== b.site) return false;
  if (a.counts && b.counts && a.counts.length === b.counts.length) {
    let d = 0;
    for (let i = 0; i < a.counts.length; i++) d += Math.abs(a.counts[i] - b.counts[i]);
    if (d > 2) return false;
  }
  if (Number.isFinite(a.commit) && Number.isFinite(b.commit) && Math.abs(a.commit - b.commit) > (open ? 15 : 5)) {
    return false;
  }
  // A slow round is its shape and its timing; its utility follows what the
  // CTs showed. A fast one is named by the utility it brings.
  if (open) return true;
  let inter = 0;
  for (const k of a.util) if (b.util.has(k)) inter++;
  const union = a.util.size + b.util.size - inter;
  if (union >= 3 && inter / union < 0.34) return false;
  return true;
}

function clusterRounds(rounds, ctx, side) {
  const shapes = rounds.map((r) => shapeOf(r, ctx, side));
  shapes.sort((x, y) => (x.commit ?? 999) - (y.commit ?? 999));
  const clusters = [];
  for (const s of shapes) {
    const home = clusters.find((c) => sameShape(c.seed, s));
    if (home) home.members.push(s);
    else clusters.push({ seed: s, members: [s] });
  }
  return clusters.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      percent(won(b.members), b.members.length) - percent(won(a.members), a.members.length) ||
      (a.seed.commit ?? 999) - (b.seed.commit ?? 999)
  );
}

/** "1x A, 2x B" over the sites a variation ended on. */
function siteSpread(members) {
  return tally(members, (m) => m.site || 'mid')
    .map(([s, n]) => `${n}x ${s}`)
    .join(', ');
}

/** Where the fighting of a site-less fast round happened. */
function fightZone(members) {
  return mostCommon(
    members.filter((m) => m.r.firstKill),
    (m) => m.r.firstKill.victimZone || m.r.firstKill.attackerZone || ''
  );
}

/**
 * Why the odd rounds of a variation went elsewhere: something in most of them
 * that hardly ever happens in the rest. An opening kill or death somewhere,
 * a smoke or molotov from the other team, or one of ours reaching ground the
 * usual rounds never reach before the call.
 */
function branchWhy(minor, major, ctx) {
  const reasons = (s) => {
    const r = s.r;
    const commit = s.commit ?? 60;
    const out = new Set();
    const k = r.firstKill;
    if (k && ROUND_SECONDS - k.clock <= commit) {
      const zone = k.victimZone || k.attackerZone;
      if (zone) out.add(k.attackerOurs ? `after an opening kill at ${zone}` : `after losing a player at ${zone}`);
    }
    for (const n of r.enemyNades || []) {
      if (n.at > commit || (n.type !== 'smokegrenade' && n.type !== 'molotov')) continue;
      if (n.label) out.add(`after a CT ${n.type === 'molotov' ? 'molotov' : 'smoke'} on ${n.label}`);
    }
    for (const [pos, tick] of r.firstVisit || []) {
      if ((tick - r.t0) / r.tickRate <= commit - 3) out.add(`reach:${pos}`);
    }
    return out;
  };
  const minorSets = minor.map(reasons);
  const majorSets = major.map(reasons);
  let best = null;
  const keys = new Set(minorSets.flatMap((s) => [...s]));
  for (const key of keys) {
    const m = minorSets.filter((s) => s.has(key)).length / minor.length;
    const M = majorSets.length ? majorSets.filter((s) => s.has(key)).length / majorSets.length : 0;
    if (m < 0.5 || M > 0.25) continue;
    const score = m - M;
    if (!best || score > best.score) best = { key, score };
  }
  if (!best) return '';
  if (best.key.startsWith('reach:')) return `after getting to ${best.key.slice(6)} early`;
  return best.key;
}

/** One T variation in a sheet's words. */
function tVariationWords(cluster, ctx) {
  const m = cluster.members;
  const pace = cluster.seed.pace;
  // Rounds that died before reaching a site say nothing about where it went.
  const withSite = m.filter((s) => s.site);
  const [site, siteN] = tally(withSite, (s) => s.site)[0] || ['', 0];
  const hasSite = Boolean(site) && withSite.length * 2 >= m.length;
  const noHit = m.length - withSite.length;
  const hit = hasSite ? m.filter((s) => s.site === site) : [];
  const entries = hit.map((s) => s.entry).filter((e) => e && e.site === site);
  const route = mostCommon(entries, (e) => e.route);
  const split = entries.length > 0 && entries.filter((e) => e.split).length * 2 > entries.length;
  const form = sharedForm(m, (s) => s.counts);
  const clock = setClock(median(m.map((s) => s.commit)));
  const common = groupUtility(m.map((s) => s.r));
  const smokes = common.filter((u) => u.type === 'smokegrenade').slice(0, 2);
  const util = utilityWords(smokes.length ? smokes : common.filter((u) => u.type === 'molotov').slice(0, 1));
  const from = () => (split ? ' split' : route ? ` through ${route}` : '');
  let head;
  let extra = '';
  if (!hasSite && FAST.includes(pace)) {
    const zone = fightZone(m);
    head = `Early fight${zone ? ` at ${zone}` : ''}${clock ? ` around ${clock}` : ''}${form ? ` (${form})` : ''}`;
  } else {
    switch (pace) {
      case 'rush':
        head = `${site} rush${from()}${form ? ` (${form})` : ''}`;
        break;
      case 'pop':
        head = `${site} pop${from()}${clock ? ` around ${clock}` : ''}${form ? ` (${form})` : ''}`;
        break;
      case 'contact':
        head = `Contact into ${site}${from()}${clock ? ` around ${clock}` : ''}${form ? ` (${form})` : ''}`;
        break;
      case 'full-exec':
        head = `Full ${site} execute${split ? ' (split)' : route ? ` from ${route}` : ''}${clock ? ` around ${clock}` : ''}`;
        break;
      case 'default': {
        const slow = m.filter((s) => s.slow).length * 2 > m.length;
        head = `${slow ? 'Slow default' : 'Default'}${form ? ` ${form}` : ''}`;
        break;
      }
      default:
        head = form ? `Mixed ${form}` : 'Mixed round';
    }
  }
  if (util) head += ` with ${util}`;
  if (!hasSite && FAST.includes(pace)) head += ', no hit';
  if (pace === 'default' || pace === 'other') {
    if (!hasSite) {
      const zone = fightZone(m);
      head += `, no hit${zone ? ` (the fights are at ${zone})` : ''}`;
    }
    else if (siteN / withSite.length >= 0.75) {
      const lean = mostCommon(hit, (s) => s.lean);
      const exec = groupUtility(hit.map((s) => s.r)).filter((u) => u.type === 'smokegrenade').length >= 2;
      const how = split ? `${site} split` : `${site} ${exec ? 'exec' : 'hit'}${route ? ` from ${route}` : ''}`;
      head += ` into ${lean && lean !== site ? `${lean} into ` : ''}${how}`;
      const minor = withSite.filter((s) => s.site !== site);
      if (minor.length) {
        const other = mostCommon(minor, (s) => s.site);
        const why = branchWhy(minor, hit, ctx);
        const times = minor.length === 1 ? 'once' : `${minor.length} times`;
        extra = ` Adapted to ${other} ${times}${why ? `, ${why}` : ''}.`;
      }
    } else head += `. Open ended (${siteSpread(withSite)})`;
    if (hasSite && noHit) extra += ` ${noHit === 1 ? 'One round' : `${noHit} rounds`} never reached a site.`;
  }
  return `${sentence(capitalize(head))}${extra}`;
}

/** One CT variation: the call, the stack, the early fight and who takes it. */
function ctVariationWords(cluster, ctx) {
  const m = cluster.members;
  const labels = typeLabels(ctx.mapCode, 'CT');
  const call = cluster.seed.call;
  const stack = cluster.seed.stack;
  const early = m.filter(
    (s) => s.r.firstKill && s.r.firstKill.clock >= AGGRESSIVE_CLOCK && (s.r.firstKill.attackerOurs || s.r.firstKill.victimOurs)
  );
  const zone = mostCommon(early, (s) => (s.r.firstKill.attackerOurs ? s.r.firstKill.attackerZone : s.r.firstKill.victimZone) || '');
  const who = tally(early, (s) => (s.r.firstKill.attackerOurs ? s.r.firstKill.attacker : s.r.firstKill.victim))[0];
  const common = groupUtility(m.map((s) => s.r));
  const smokes = common.filter((u) => u.type === 'smokegrenade').slice(0, 2);
  const util = utilityWords(smokes.length ? smokes : common.filter((u) => u.type === 'molotov').slice(0, 1));
  let head = call ? capitalize(callName(labels.get(call) || call)) : 'Default setup';
  if (stack) head += `, ${stack} stack`;
  if (zone && early.length * 2 >= m.length) {
    const named = who && who[1] * 2 >= early.length ? ` (${nameOf(ctx, who[0])})` : '';
    head += `, early fight ${zone}${named}`;
  }
  return sentence(util ? `${head} with ${util}` : head);
}

function variationWords(cluster, ctx, side) {
  return side === 'CT' ? ctVariationWords(cluster, ctx) : tVariationWords(cluster, ctx);
}

/** A round in two or three words, for the list of the ones played once. */
function coarseWords(s, side, ctx) {
  if (side === 'CT') {
    const labels = typeLabels(ctx.mapCode, 'CT');
    const call = s.call ? capitalize(callName(labels.get(s.call) || s.call)) : 'Default setup';
    return s.stack ? `${call}, ${s.stack} stack` : call;
  }
  const site = s.site;
  switch (s.pace) {
    case 'rush':
      return site ? `${site} rush` : 'Early fight';
    case 'pop':
      return site ? `${site} pop` : 'Early fight';
    case 'contact':
      return site ? `Contact into ${site}` : 'Early fight';
    case 'full-exec':
      return site ? `${site} execute` : 'Execute, no hit';
    case 'default':
      return site ? `Default into ${site}` : 'Default, no hit';
    default:
      return site ? `Mixed into ${site}` : 'Mixed, no hit';
  }
}

/** Most this many variations by name, then the rest by what they were. */
const VARIATIONS_SHOWN = 6;

/**
 * A set of rounds as its variations: the ones played more than once, each
 * with how many times, then every round played once grouped by what it was
 * ("Others: 3x B rush (won 2), 2x Default into A (won 1)"). Most played first,
 * best won first among equals.
 */
function variationsFor(rounds, ctx, side, { min = 1 } = {}) {
  if (rounds.length < min) return null;
  const clusters = clusterRounds(rounds, ctx, side);
  // Rounds played once that are still the same kind of round (five A
  // executes with different smokes) are one variation, named as a group.
  const singles = clusters.filter((c) => c.members.length === 1).flatMap((c) => c.members);
  const byWords = new Map();
  for (const s of singles) {
    const w = coarseWords(s, side, ctx);
    if (!byWords.has(w)) byWords.set(w, []);
    byWords.get(w).push(s);
  }
  const promoted = [...byWords.values()].filter((l) => l.length >= 2).map((l) => ({ seed: l[0], members: l }));
  const rate = (c) => percent(won(c.members), c.members.length);
  const shown = [...clusters.filter((c) => c.members.length >= 2), ...promoted]
    .sort((a, b) => b.members.length - a.members.length || rate(b) - rate(a))
    .slice(0, VARIATIONS_SHOWN);
  if (!shown.length && clusters.length) shown.push(clusters[0]);
  const shownFiles = new Set(shown.flatMap((c) => c.members.map((s) => s.r.file)));
  const lines = shown.map((c) => line(`${c.members.length}x ${variationWords(c, ctx, side)}`, c.members));
  const rest = clusters.flatMap((c) => c.members).filter((s) => !shownFiles.has(s.r.file));
  if (rest.length) {
    const groups = new Map();
    for (const s of rest) {
      const w = coarseWords(s, side, ctx);
      if (!groups.has(w)) groups.set(w, []);
      groups.get(w).push(s);
    }
    const parts = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || percent(won(b[1]), b[1].length) - percent(won(a[1]), a[1].length))
      .map(([w, list]) => line(`${list.length}x ${w} (won ${won(list)})`, list));
    lines.push({ text: 'Others: ', parts, tail: '.', files: filesOf(rest) });
  }
  return { rounds: rounds.length, files: filesOf(rounds), lines, clusters: [...clusters.filter((c) => c.members.length >= 2), ...promoted, ...clusters.filter((c) => c.members.length === 1 && !promoted.some((p) => p.members.includes(c.members[0])))] };
}

// ---------------------------------------------------------------------------
// Dangerous rounds and openings
// ---------------------------------------------------------------------------

/** Our player in an opening duel, whichever end of it they were on. */
const ourDuelist = (k) => (k.attackerOurs ? k.attacker : k.victim);

/**
 * How our player in a duel was moving: pushing (covered ground just before),
 * or holding (stood still). The shooter's read comes from killRead; a victim
 * of ours is measured the same way off our own samples.
 */
function duelMove(r, k) {
  if (k.attackerOurs) {
    const read = killRead(r, k);
    return read.pushing ? 'pushing' : read.holding ? 'holding' : '';
  }
  const now = r.sampleAt(k.tick)?.pts.find((p) => p.id === k.victim);
  const before = r.sampleAt(k.tick - 2 * r.tickRate)?.pts.find((p) => p.id === k.victim);
  if (!now || !before) return '';
  const d = Math.hypot(now.x - before.x, now.y - before.y);
  return d >= 180 ? 'pushing' : d < 80 ? 'holding' : '';
}

/** "holding, flashed for him, with the AWP": what most of a set of kills share. */
function killHow(items) {
  const n = items.length;
  if (!n) return '';
  const words = [];
  const reads = items.map(({ r, k }) => ({ read: killRead(r, k), move: duelMove(r, k) }));
  const pushing = reads.filter((x) => x.move === 'pushing').length;
  const holding = reads.filter((x) => x.move === 'holding').length;
  if (pushing * 2 > n) words.push('pushing');
  else if (holding * 2 > n) words.push('holding');
  const flashed = reads.filter((x) => x.read.flashed).length;
  if (flashed * 2 >= n) words.push(`flashed for him in ${flashed}`);
  const alone = reads.filter((x) => x.read.mates === 0).length;
  if (alone * 10 >= n * 7) words.push('alone');
  else if ((n - alone) * 10 >= n * 7) words.push('with a teammate next to him');
  if (reads.filter((x) => x.read.awp).length * 2 > n) words.push('with the AWP');
  return words.join(', ');
}

/**
 * Who gets the opening kills, and how: every main with a real share of them,
 * the ground they take them on and from, when, and what they share (holding
 * or pushing, flashed for, alone, AWP).
 */
function openerLines(ctx, side, buys) {
  const mainIds = new Set(ctx.mains.map((m) => m.id));
  const opens = buys.filter((r) => r.firstKill?.attackerOurs && mainIds.has(r.firstKill.attacker));
  const byPlayer = new Map();
  for (const r of opens) {
    const id = r.firstKill.attacker;
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push({ r, k: r.firstKill });
  }
  const lines = [];
  const players = [...byPlayer.entries()].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length);
  for (const [id, list] of players) {
    // The ground that repeats by name, then what is left by part of the map
    // ("3 in long"), and only then "elsewhere".
    const minZone = Math.max(2, Math.ceil(list.length * 0.15));
    const zones = tally(list, (x) => x.k.victimZone || '').filter(([z, n]) => z && n >= minZone).slice(0, 3);
    const parts = [];
    const used = new Set();
    for (const [zone, n] of zones) {
      const at = list.filter((x) => x.k.victimZone === zone);
      at.forEach((x) => used.add(x));
      const from = mostCommon(at, (x) => x.k.attackerZone || '');
      const clock = clockText(median(at.map((x) => x.k.clock)));
      const how = killHow(at);
      parts.push(`${n} at ${zone}${from && from !== zone ? ` from ${from}` : ''} around ${clock}${how ? ` (${how})` : ''}`);
    }
    const left = list.filter((x) => !used.has(x));
    const areas = tally(left, (x) => killArea(x.r, x.k, ctx)).filter(([a, n]) => a && n >= 2).slice(0, 2);
    for (const [area, n] of areas) {
      const at = left.filter((x) => killArea(x.r, x.k, ctx) === area);
      at.forEach((x) => used.add(x));
      const clock = clockText(median(at.map((x) => x.k.clock)));
      const how = killHow(at);
      parts.push(`${n} ${/^[AB]$/.test(area) ? 'on' : 'in'} ${area} around ${clock}${how ? ` (${how})` : ''}`);
    }
    const rest = list.length - used.size;
    if (!parts.length) parts.push('spread out');
    else if (rest > 0) parts.push(`${rest} elsewhere`);
    lines.push(line(`${nameOf(ctx, id)} gets the first kill in ${list.length} rounds: ${parts.join('; ')}.`, list));
  }
  return lines;
}

/** The part of the map a kill happened in: a T lane, else a site's ground. */
function killArea(r, k, ctx) {
  const lanes = FORMATIONS[ctx.mapCode]?.t || [];
  const l = laneOfPos(k.victimZone, ctx.laneSets);
  if (l >= 0 && lanes[l]) return laneWord(lanes[l]);
  const site = k.x !== null ? r.siteNear(k.x, k.y) : null;
  return site ? site.toUpperCase() : '';
}

/** Player whose name a set of reads keeps, when one of them owns most of it. */
function owner(ctx, ids) {
  const best = tally(ids, (x) => x)[0];
  return best && best[1] * 2 >= ids.length ? nameOf(ctx, best[0]) : '';
}

function dangerFor(ctx, side) {
  const lines = [];
  const buys = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 4 && r.hasTicks);
  if (side === 'T') {
    // Fast rounds and early hits, each with what it brings and who leads it.
    const early = buys.filter((r) => {
      const pace = classifyPace(r);
      if (FAST.includes(pace)) return true;
      const c = commitElapsed(r);
      return pace === 'full-exec' && c !== null && c <= 45;
    });
    const groups = new Map();
    for (const r of early) {
      const pace = classifyPace(r);
      const site = roundSite(r);
      const e = entryOf(r, ctx.laneSets);
      // Grouped by the lane they came down, named by the route most of them
      // took: "T Outside A" and "A Ramp" are one way into A.
      const way = site && e?.site === site ? (e.split ? 'split' : e.route ? `lane:${laneOfPos(e.route, ctx.laneSets)}:${laneOfPos(e.route, ctx.laneSets) >= 0 ? '' : e.route}` : '') : '';
      const key = `${pace}|${site}|${way}`;
      if (!groups.has(key)) groups.set(key, { pace, site, split: way === 'split', rounds: [] });
      groups.get(key).rounds.push(r);
    }
    for (const g of groups.values()) {
      const route = g.split ? '' : mostCommon(g.rounds, (r) => entryOf(r, ctx.laneSets)?.route || '');
      g.how = g.split ? 'split' : route ? `through ${route}` : '';
    }
    const ranked = [...groups.values()]
      .filter((g) => g.rounds.length >= 2)
      .sort((a, b) => b.rounds.length - a.rounds.length || percent(won(b.rounds), b.rounds.length) - percent(won(a.rounds), a.rounds.length))
      .slice(0, 5);
    for (const g of ranked) {
      const n = g.rounds.length;
      const clock = setClock(median(g.rounds.map((r) => commitElapsed(r))));
      const form = sharedForm(g.rounds, (r) => formationOf(r, ctx.mapCode, ctx.laneSets));
      const word = { rush: 'rush', pop: 'pop', contact: 'contact', 'full-exec': 'execute' }[g.pace] || g.pace;
      const head = g.site
        ? `${g.site} ${word}${g.how ? ` ${g.how}` : ''}`
        : `Early fight at ${mostCommon(g.rounds, (r) => r.firstKill?.victimZone || '') || 'mid'}`;
      const util = utilitySummary(groupUtility(g.rounds), hitFlashes(g.rounds, g.site).perRound);
      const leaders = g.rounds.map((r) => entryOf(r, ctx.laneSets)?.players?.[0]?.id).filter(Boolean);
      const lead = leaders.length >= 2 ? owner(ctx, leaders) : '';
      const leadN = lead ? leaders.filter((id) => nameOf(ctx, id) === lead).length : 0;
      lines.push(
        line(
          `${capitalize(head)}${clock ? ` around ${clock}` : ''}${form ? ` (${form})` : ''}, ${n} times, won ${won(g.rounds)}.` +
            `${util ? ` ${capitalize(util)}.` : ''}${lead ? ` ${lead} first in (${leadN} of ${n}).` : ''}`,
          g.rounds
        )
      );
    }

    // Early calls the round library names: "early long" rounds and the like.
    const labels = typeLabels(ctx.mapCode, 'T');
    const calls = new Map();
    for (const r of buys) {
      for (const t of specificTags(r, 'T')) {
        const at = tagTrigger(t);
        if (at === null || at > 30 || /default/i.test(labels.get(t.k) || t.k)) continue;
        if (!calls.has(t.k)) calls.set(t.k, { rounds: [], times: [] });
        calls.get(t.k).rounds.push(r);
        calls.get(t.k).times.push(at);
      }
    }
    for (const [k, c] of [...calls.entries()].filter(([, c]) => c.rounds.length >= 3).sort((a, b) => b[1].rounds.length - a[1].rounds.length).slice(0, 3)) {
      const sites = tally(c.rounds, (r) => roundSite(r) || 'no hit');
      const where = sites.map(([s, n]) => `${n}x ${s}`).join(', ');
      lines.push(
        line(
          `${capitalize(callName(labels.get(k) || k))} around ${clockText(ROUND_SECONDS - median(c.times))}, ${c.rounds.length} times, won ${won(c.rounds)} (then ${where}).`,
          c.rounds
        )
      );
    }
  } else {
    // CT danger is aggression: early fights, who takes them and how.
    const early = buys.filter(
      (r) => r.firstKill && r.firstKill.clock >= AGGRESSIVE_CLOCK && (r.firstKill.attackerOurs || r.firstKill.victimOurs)
    );
    const byZone = new Map();
    for (const r of early) {
      const k = r.firstKill;
      const zone = k.attackerOurs ? k.attackerZone || k.victimZone : k.victimZone;
      if (!zone) continue;
      if (!byZone.has(zone)) byZone.set(zone, []);
      byZone.get(zone).push(r);
    }
    const zones = [...byZone.entries()].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length);
    for (const [zone, list] of zones.slice(0, 4)) {
      const n = list.length;
      const wonDuel = list.filter((r) => r.firstKill.attackerOurs).length;
      const clock = clockText(median(list.map((r) => r.firstKill.clock)));
      const who = tally(list, (r) => ourDuelist(r.firstKill))[0];
      const moves = list.map((r) => duelMove(r, r.firstKill));
      const pushing = moves.filter((m) => m === 'pushing').length;
      const holding = moves.filter((m) => m === 'holding').length;
      const how = pushing * 2 > n ? ', pushing' : holding * 2 > n ? ', holding' : '';
      // Utility of ours that went in just before, near the fight.
      const before = new Map();
      for (const r of list) {
        const seen = new Set();
        for (const g of r.nades) {
          if (g.tick > r.firstKill.tick || g.tick < r.firstKill.tick - 6 * r.tickRate) continue;
          const label = nadeLabel(g);
          if (!label || seen.has(label + g.type)) continue;
          seen.add(label + g.type);
          bump(before, `${label}\0${g.type}`);
        }
      }
      const util = top(before);
      const utilText =
        util && util[1] * 10 >= n * 4 ? `; ${withUtil(util[0])} first in ${util[1]} of them` : '';
      // Walking through a smoke into the fight: the break the fight comes from.
      const breaks = list.filter((r) =>
        smokeBreaksOf(r).some((b) => b.tick <= r.firstKill.tick && b.tick >= r.firstKill.tick - 5 * r.tickRate)
      ).length;
      const breakText = breaks * 10 >= n * 3 ? `; walked through the smoke into it in ${breaks}` : '';
      const whoText = who && who[1] * 10 >= n * 4 ? `: ${nameOf(ctx, who[0])} in ${who[1]}${how}` : how ? `:${how.slice(1)}` : '';
      lines.push(line(`Early fight ${zone} around ${clock}, ${n} times (won the duel ${wonDuel})${whoText}${utilText}${breakText}.`, list));
    }
    if (buys.length >= 8 && percent(early.length, buys.length) < 20) {
      lines.push(line('Passive early, the fighting comes in the midround.', buys));
    }
    // Pushes alone onto ground the Ts had taken, before 1:30.
    const pushes = new Map();
    for (const r of buys) {
      const seen = new Set();
      for (const m of aggressiveMovesOf(r)) {
        if (m.elapsed > 25 || seen.has(m.id)) continue;
        seen.add(m.id);
        const key = `${m.id}\0${m.zone}`;
        if (!pushes.has(key)) pushes.set(key, { id: m.id, zone: m.zone, rounds: [], times: [] });
        pushes.get(key).rounds.push(r);
        pushes.get(key).times.push(m.elapsed);
      }
    }
    for (const p of [...pushes.values()].filter((p) => p.rounds.length >= 4).sort((a, b) => b.rounds.length - a.rounds.length).slice(0, 2)) {
      lines.push(
        line(
          `${nameOf(ctx, p.id)} pushes ${p.zone} alone around ${clockText(ROUND_SECONDS - median(p.times))} in ${p.rounds.length} rounds (won ${won(p.rounds)}).`,
          p.rounds
        )
      );
    }
  }

  // Boosts, smokes walked through and contact searched together.
  lines.push(...boostLines(ctx, buys));
  lines.push(...smokeBreakLines(ctx, side, buys));
  if (side === 'T') lines.push(...contactLines(ctx, buys));
  lines.push(...awpEarlyLines(ctx, side, buys));
  lines.push(...openerLines(ctx, side, buys));
  return { lines, files: filesOf(buys) };
}

const withUtil = (key) => {
  const [label, type] = key.split('\0');
  return `a ${nadeName(label, type)}`;
};

function boostLines(ctx, buys) {
  const byZone = new Map();
  for (const r of buys) {
    const b = boostsOf(r)[0];
    if (!b || !b.zone) continue;
    if (!byZone.has(b.zone)) byZone.set(b.zone, []);
    byZone.get(b.zone).push({ r, b });
  }
  return [...byZone.entries()]
    .filter(([, l]) => l.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([zone, list]) => {
      const clock = clockText(ROUND_SECONDS - median(list.map((x) => x.b.elapsed)));
      const top = owner(ctx, list.map((x) => x.b.top));
      const bottom = owner(ctx, list.map((x) => x.b.bottom));
      const who = top && bottom ? ` (${top} on ${bottom})` : top ? ` (${top} on top)` : '';
      return line(`Boost at ${zone} around ${clock}${who}, ${list.length} rounds, won ${won(list)}.`, list);
    });
}

function smokeBreakLines(ctx, side, buys) {
  const byZone = new Map();
  for (const r of buys) {
    const seen = new Set();
    for (const b of smokeBreaksOf(r)) {
      if (b.elapsed > 50 || seen.has(b.zone)) continue;
      seen.add(b.zone);
      if (!byZone.has(b.zone)) byZone.set(b.zone, []);
      byZone.get(b.zone).push({ r, b });
    }
  }
  const them = side === 'T' ? 'CT' : 'T';
  return [...byZone.entries()]
    .filter(([, l]) => l.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([zone, list]) => {
      const clock = clockText(ROUND_SECONDS - median(list.map((x) => x.b.elapsed)));
      const who = owner(ctx, list.map((x) => x.b.id));
      return line(
        `Walk through the ${them} smoke on ${zone} around ${clock}${who ? ` (usually ${who})` : ''}, ${list.length} rounds, won ${won(list)}.`,
        list
      );
    });
}

/** Early fights where two or more of ours went looking together. */
function contactLines(ctx, buys) {
  const byZone = new Map();
  for (const r of buys) {
    const k = r.firstKill;
    if (!k || k.clock < AGGRESSIVE_CLOCK) continue;
    const id = ourDuelist(k);
    const s = r.sampleAt(k.tick);
    const me = s?.pts.find((p) => p.id === id) || (k.victimOurs && k.x !== null ? { x: k.x, y: k.y } : null);
    if (!me) continue;
    const near = (s?.pts || []).filter((p) => p.id !== id && Math.hypot(p.x - me.x, p.y - me.y) <= ALONE_UNITS).length;
    if (near < 1) continue;
    const zone = k.victimZone || k.attackerZone;
    if (!zone) continue;
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push({ r, near: near + 1 });
  }
  return [...byZone.entries()]
    .filter(([, l]) => l.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([zone, list]) => {
      const clock = clockText(median(list.map((x) => x.r.firstKill.clock)));
      const players = Math.round(median(list.map((x) => x.near)));
      const wonDuel = list.filter((x) => x.r.firstKill.attackerOurs).length;
      return line(
        `Search contact at ${zone} with ${players} players around ${clock}, ${list.length} rounds (won the first duel ${wonDuel}).`,
        list
      );
    });
}

/** Where the AWP takes early duels, when it does it repeatedly. */
function awpEarlyLines(ctx, side, buys) {
  const byZone = new Map();
  for (const r of buys) {
    const k = r.firstKill;
    if (!k || k.clock < AGGRESSIVE_CLOCK) continue;
    const id = ourDuelist(k);
    const me = r.sampleAt(k.tick)?.pts.find((p) => p.id === id);
    const awp = k.attackerOurs ? /awp/.test(k.weapon) : Boolean(me?.awp);
    if (!awp) continue;
    const zone = k.attackerOurs ? k.attackerZone || k.victimZone : k.victimZone;
    if (!zone) continue;
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(r);
  }
  return [...byZone.entries()]
    .filter(([, l]) => l.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([zone, list]) => {
      const clock = clockText(median(list.map((r) => r.firstKill.clock)));
      const who = owner(ctx, list.map((r) => ourDuelist(r.firstKill)));
      const wonDuel = list.filter((r) => r.firstKill.attackerOurs).length;
      return line(`AWP${who ? ` (${who})` : ''} takes the first duel at ${zone} around ${clock} in ${list.length} rounds (won ${wonDuel}).`, list);
    });
}

// ---------------------------------------------------------------------------
// Anti-ecos, antiforces, force buys and pistols
// ---------------------------------------------------------------------------

function antiforceFor(ctx, side, defaults) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 4 && r.oppEcon <= 3 && r.hasTicks);
  const out = variationsFor(set, ctx, side, { min: 2 });
  if (out) out.notes = droppedDefaults(ctx, side, set, defaults);
  return out;
}

function forceFor(ctx, side) {
  const set = ctx.rounds.filter(
    (r) => r.side === side && r.ownEcon >= 2 && r.ownEcon <= 3 && r.oppEcon >= 4 && r.hasTicks
  );
  return variationsFor(set, ctx, side, { min: 2 });
}

/**
 * Pistols as variations, then whether they ever ran the same one twice in a
 * row and which they ran last: the round a sheet most needs to be right.
 */
function pistolsFor(ctx, side) {
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon === 0 && r.oppEcon === 0 && r.hasTicks);
  const out = variationsFor(set, ctx, side, { min: 2 });
  if (!out) return null;
  const when = new Map((ctx.includedDemos || []).map(({ demo }) => [demo.id, demoTimestamp(demo)]));
  const ordered = [...set].sort(
    (a, b) => (when.get(a.demoId) || 0) - (when.get(b.demoId) || 0) || (a.round || 0) - (b.round || 0)
  );
  const clusterOf = new Map();
  out.clusters.forEach((c, i) => c.members.forEach((s) => clusterOf.set(s.r.file, i)));
  let repeats = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (clusterOf.get(ordered[i].file) === clusterOf.get(ordered[i - 1].file)) repeats++;
  }
  const notes = [];
  if (ordered.length >= 3) {
    const last = out.clusters[clusterOf.get(ordered[ordered.length - 1].file)];
    const lastWords = last ? variationWords(last, ctx, side).replace(/\.$/, '').split('. ')[0] : '';
    if (!repeats) notes.push(`They never ran the same pistol twice in a row.${lastWords ? ` Last one was: ${lastWords}.` : ''}`);
    else if (lastWords) notes.push(`Last one was: ${lastWords}.`);
  }
  return { ...out, notes };
}

// ---------------------------------------------------------------------------
// T site rounds: the kinds of hit a site player will be dealing with
// ---------------------------------------------------------------------------

/** Which kind of hit one T round onto a site was. */
function hitKind(r, ctx) {
  const pace = classifyPace(r);
  if (pace === 'rush' || pace === 'pop') return 'rush';
  const e = entryOf(r, ctx.laneSets);
  if (e?.split) return 'split';
  const smokes = groupUtility([r], 1).filter((u) => u.type === 'smokegrenade').length;
  if (pace === 'full-exec' || (smokes >= 2 && (e?.players.length || 0) >= 3)) return 'execute';
  return 'hit';
}

const HIT_WORD = { rush: 'rushes and pops', execute: 'execute', split: 'split', hit: 'smaller hits' };

/**
 * One kind of hit onto a site, as a sentence a site player can use: what is
 * smoked and molotoved, how many flashes and where, who throws what without
 * coming in, which way the bodies come and how it goes. The clock is only
 * printed for a set call (utility up before 1:20).
 */
function hitKindWords(kind, list, site, ctx) {
  const n = list.length;
  const entries = list.map((r) => entryOf(r, ctx.laneSets)).filter((e) => e && e.site === site);
  const util = groupUtility(list);
  const smokes = util.filter((u) => u.type === 'smokegrenade');
  // Molotovs and flashes on the site itself: the default's flashes in mid are
  // not part of the hit a site player has to play against. Their spots vary
  // round to round, so they are counted per round and the spots that recur
  // in a quarter of the rounds are named.
  const molos = siteUtility(list, site, 'molotov');
  const flashes = siteUtility(list, site, 'flashbang');
  const routeCounts = tally(entries.flatMap((e) => e.players.map((p) => p.from)), (x) => x);
  const perRound = (name) => Math.round(routeCounts.find(([r]) => r === name)?.[1] / Math.max(1, entries.length) || 0);
  const routes = routeCounts
    .filter(([name]) => name)
    .map(([name]) => ({ name, n: perRound(name) }))
    .filter((x) => x.n >= 1)
    .slice(0, 3);
  // A set call is utility up before 1:20; the sheet prints when it is thrown.
  const landed = median(smokes.map((u) => u.land));
  const set = smokes.length && setClock(landed) ? clockText(ROUND_SECONDS - median(smokes.map((u) => u.t))) : '';
  const sentences = [];
  const route = routes[0]?.name || '';
  const go =
    kind === 'split'
      ? `come in from ${joinList(routes.map((x) => x.name))}`
      : route
        ? `go ${entries.length && median(entries.map((e) => e.players.length)) >= 4 ? 'mass ' : ''}through ${route}`
        : 'go in';
  // Smokes whose spots vary still count: "smoke CT A + 2 more".
  const smokeCount = Math.round(
    median(
      list.map((r) => {
        const commit = commitElapsed(r);
        return r.nades.filter((g) => {
          if (g.type !== 'smokegrenade') return false;
          const t = throwElapsed(g);
          return commit === null || (t >= commit - CALL_UTILITY_LEAD && t <= commit + 5);
        }).length;
      })
    ) || 0
  );
  const named = smokes.slice(0, 3).map((u) => u.label);
  const extraSmokes = smokeCount - named.length;
  const smokeText = named.length
    ? `smoke ${joinList(named, '+')}${extraSmokes >= 1 ? ` + ${extraSmokes} more` : ''}`
    : smokeCount >= 2
      ? `throw ${smokeCount} smokes`
      : '';
  const lead = set
    ? `Have a set call ${site} ${kind === 'hit' ? 'hit' : kind === 'rush' ? 'pop' : kind}${smokeText ? ` with ${smokeText.replace(/^smoke /, '')} smoke${smokes.length > 1 ? 's' : ''} thrown around ${set}` : ''}`
    : `On ${kind === 'rush' ? `${site} rushes and pops` : kind === 'hit' ? `${site} hits with little utility` : `${site} ${kind}`}, ${smokeText ? `${smokeText} and ` : ''}${go}`;
  sentences.push(set ? `${lead}, then ${go}` : lead);
  for (const u of [molos, flashes]) {
    if (u.rounds * 100 < u.of * 35) continue;
    const word = u.type === 'molotov' ? ['molotov', 'molotovs'] : ['flash', 'flashes'];
    const count = Math.max(1, Math.round(u.perRound));
    const where = u.spots.length ? `, mostly ${joinList(u.spots)}` : '';
    sentences.push(
      u.rounds * 4 >= u.of * 3
        ? `${capitalize(plural(count, ...word))} ${count === 1 ? 'is' : 'are'} thrown${where}`
        : `${capitalize(word[1])} in ${u.rounds} of ${u.of} (usually ${count})${where}`
    );
  }
  if (molos.rounds * 5 < molos.of && flashes.rounds * 5 < flashes.of) sentences.push('No flashes or molotovs are thrown');
  // Utility thrown by someone who never comes in: the lurk's part in it.
  for (const u of smokes.slice(0, 2)) {
    const thrower = top(u.throwers);
    if (!thrower || thrower[1] * 2 < u.rounds) continue;
    const inside = entries.filter((e) => e.players.some((p) => p.id === thrower[0])).length;
    if (inside * 10 > entries.length * 3) continue;
    const role = rolesFor(ctx, 'T').get(thrower[0]);
    sentences.push(`${nameOf(ctx, thrower[0])}${role ? ` (${role})` : ''} throws the ${u.label} smoke but does not go in`);
  }
  if (routes.length) {
    sentences.push(`Usually ${joinList(routes.map((x) => `${x.n} ${x.name}`))} (${percent(won(list), n)}% won of ${plural(n, 'round')})`);
  } else {
    sentences.push(`${percent(won(list), n)}% won of ${plural(n, 'round')}`);
  }
  return paragraph(sentences, ctx.names);
}

/**
 * One kind of grenade thrown onto a site around the hit: how many a round
 * (median) and the spots that come back in a quarter of the rounds.
 */
function siteUtility(list, site, type) {
  const region = site.toLowerCase();
  const per = [];
  const spots = new Map();
  for (const r of list) {
    const commit = commitElapsed(r);
    const seen = new Set();
    let n = 0;
    for (const g of r.nades) {
      if (g.type !== type || (g.near || g.region) !== region) continue;
      const t = throwElapsed(g);
      if (commit !== null && (t < commit - CALL_UTILITY_LEAD || t > commit + 5)) continue;
      n++;
      const label = nadeLabel(g);
      if (label && !seen.has(label)) {
        seen.add(label);
        bump(spots, label);
      }
    }
    per.push(n);
  }
  const used = per.filter((n) => n > 0);
  return {
    type,
    rounds: used.length,
    of: list.length,
    // How many when they do use it, not a median dragged to zero by the
    // rounds that skip it.
    perRound: median(used) || 0,
    spots: [...spots.entries()]
      .filter(([, c]) => c * 4 >= list.length)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label]) => label)
  };
}

function tSiteFor(ctx, site) {
  const letter = site.toUpperCase();
  const full = ctx.rounds.filter((r) => r.side === 'T' && r.ownEcon >= 4 && r.hasTicks);
  const toward = full.filter((r) => paceSite(r) === site);
  const bullets = [];
  if (toward.length < 3) return { site: letter, rounds: toward.length, bullets, files: filesOf(toward) };

  const kinds = new Map();
  for (const r of toward) {
    const k = hitKind(r, ctx);
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(r);
  }
  const ranked = [...kinds.entries()]
    .filter(([, l]) => l.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  // Set calls go after the rest: "Have a set call ..." reads as the addendum.
  const setFirst = (list) => {
    const smokes = groupUtility(list).filter((u) => u.type === 'smokegrenade');
    return Boolean(smokes.length && setClock(median(smokes.map((u) => u.land))));
  };
  ranked.sort((a, b) => Number(setFirst(a[1])) - Number(setFirst(b[1])) || b[1].length - a[1].length);
  // Kinds played once are too few for a sentence of their own.
  for (const [kind, list] of ranked) bullets.push(line(hitKindWords(kind, list, letter, ctx), list));

  const late = toward.filter((r) => {
    const e = entryOf(r, ctx.laneSets);
    return e && e.site === letter && e.elapsed >= ROUND_SECONDS - 40;
  });
  if (late.length >= 2) {
    const zone = mostCommon(late, (r) => entryOf(r, ctx.laneSets).route);
    bullets.push(line(`${late.length} late round finishes${zone ? `, usually from ${zone}` : ''} (won ${won(late)}).`, late));
  }
  const wins = won(toward);
  bullets.push(line(`Win ${percent(wins, toward.length)}% of ${letter} rounds (${wins} of ${toward.length}).`, toward));
  return { site: letter, rounds: toward.length, bullets, files: filesOf(toward) };
}

// ---------------------------------------------------------------------------
// CT: against A, against B, retakes
// ---------------------------------------------------------------------------

/** Tick of the first fight on a site in a CT round, or null. */
function contactTick(r, site) {
  for (const k of r.kills) {
    if (k.x !== null && r.siteNear(k.x, k.y) === site) return k.tick;
  }
  return null;
}

function ctVsSiteFor(ctx, site) {
  const letter = site.toUpperCase();
  const set = ctx.rounds.filter(
    (r) => r.side === 'CT' && r.ownEcon >= 4 && r.oppEcon >= 4 && r.hasTicks && r.hitSite === site
  );
  const bullets = [];
  if (set.length < 3) return { site: letter, rounds: set.length, bullets, files: filesOf(set) };
  const wins = won(set);
  bullets.push(`Win ${percent(wins, set.length)}% against ${letter} hits (${wins} of ${set.length}).`);

  const there = [];
  const rotate = [];
  const rotators = [];
  const util = new Map();
  for (const r of set) {
    const tick = contactTick(r, site);
    if (tick === null) continue;
    const s = r.sampleAt(tick);
    const n = r.towardCount(s, site, 0);
    there.push(n);
    const onSite = new Set((s?.pts || []).filter((p) => r.siteNear(p.x, p.y, 0) === site).map((p) => p.id));
    for (const later of r.series) {
      if (later.tick <= tick) continue;
      const arrived = later.pts.find((p) => !onSite.has(p.id) && r.siteNear(p.x, p.y, 0) === site);
      if (arrived) {
        rotate.push((later.tick - tick) / r.tickRate);
        const from = s?.pts.find((p) => p.id === arrived.id)?.pos;
        if (from) rotators.push(from);
        break;
      }
    }
    const seen = new Set();
    for (const g of r.nades) {
      const label = nadeLabel(g);
      if (!label || seen.has(label)) continue;
      if (Math.abs(g.tick - tick) > 15 * r.tickRate) continue;
      if (r.siteNear(g.x, g.y) !== site) continue;
      seen.add(label);
      bump(util, `${label}\0${g.type}`);
    }
  }
  if (there.length >= 3) {
    const n = Math.round(median(there));
    bullets.push(`Usually ${n} on ${letter} when the hit comes.`);
  }
  if (rotate.length >= 3) {
    const from = mostCommon(rotators, (x) => x);
    bullets.push(
      `First rotator usually arrives ${Math.round(median(rotate))} seconds after the first fight${from ? `, mostly from ${from}` : ''}.`
    );
  }
  const used = [...util.entries()]
    .filter(([, c]) => percent(c, set.length) >= 40)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => {
      const [label, type] = k.split('\0');
      return { label, type };
    });
  if (used.length) bullets.push(`Usually answer it with ${utilityWords(used)}.`);
  return { site: letter, rounds: set.length, bullets: bullets.map((b) => line(b, set)), files: filesOf(set) };
}

/**
 * Retakes: how they go, how many are alive for them, and where those players
 * come from (the ground they stood on when the bomb went down).
 */
function retakesFor(ctx) {
  const set = ctx.rounds.filter((r) => r.side === 'CT' && r.ownEcon >= 2 && r.hasTicks && r.plantTick != null);
  const bullets = [];
  for (const site of ['a', 'b']) {
    const list = set.filter((r) => (r.plantSite || r.hitSite) === site);
    if (list.length < 2) continue;
    const letter = site.toUpperCase();
    const wins = won(list);
    const alive = [];
    const waits = [];
    const from = new Map();
    const saveRounds = [];
    let saves = 0;
    for (const r of list) {
      const at = r.sampleAt(r.plantTick);
      if (at) {
        alive.push(at.pts.length);
        const seen = new Set();
        for (const p of at.pts) {
          const near = r.siteNear(p.x, p.y, 0);
          if (near === site) continue;
          // The other site's ground is one place to come from, whatever corner.
          const where = near ? `${near.toUpperCase()} site` : p.pos;
          if (!where || seen.has(where)) continue;
          seen.add(where);
          bump(from, where);
        }
      }
      // The retake starts with the first fight after the plant.
      const kill = r.kills.find((k) => k.tick > r.plantTick && (k.attackerOurs || k.victimOurs));
      if (kill) waits.push((kill.tick - r.plantTick) / r.tickRate);
      else if (!r.won) {
        saves++;
        saveRounds.push(r);
      }
    }
    const parts = [`Retake ${letter}: won ${wins} of ${list.length}`];
    if (alive.length >= 2) parts.push(`usually ${Math.round(median(alive))} alive at the plant`);
    const wait = waits.length >= 2 ? Math.round(median(waits)) : 0;
    if (wait >= 2) parts.push(`first fight about ${wait} seconds after it`);
    bullets.push(line(`${parts.join(', ')}.`, list));
    const sources = [...from.entries()]
      .filter(([, n]) => n * 5 >= list.length)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([zone, n]) => `${zone} (${n} of ${list.length})`);
    if (sources.length) bullets.push(line(`The retake on ${letter} comes from ${joinList(sources)}.`, list));
    if (saves >= 2) bullets.push(line(`Saved instead of retaking ${letter} ${countWord(saves)}.`, saveRounds));
  }
  return { rounds: set.length, bullets, files: filesOf(set) };
}

/** Every opening kill one side's players made, with what a sheet says about it. */
export function openingsFor(ctx, side) {
  const mainIds = new Set(ctx.mains.map((m) => m.id));
  const rounds = ctx.rounds.filter((r) => r.side === side);
  const set = rounds.filter((r) => r.firstKill?.attackerOurs);
  const byPlayer = new Map();
  for (const r of set) {
    const k = r.firstKill;
    if (!mainIds.has(k.attacker)) continue;
    const pace = side === 'T' ? classifyPace(r) : '';
    const setCall =
      side === 'T'
        ? pace === 'rush' || pace === 'pop' || pace === 'contact' || pace === 'full-exec'
        : // Nearly every CT round carries some call, so on CT the word means nothing.
          false;
    const phase = phaseAtTick(k.tick, r.bounds);
    const site = r.siteNear(k.x, k.y) || (side === 'T' ? paceSite(r) : r.hitSite) || null;
    const roundSiteOf = side === 'T' ? paceSite(r) : r.hitSite;
    if (!byPlayer.has(k.attacker)) byPlayer.set(k.attacker, []);
    byPlayer.get(k.attacker).push({
      file: r.file,
      zone: k.victimZone || zoneAt(k.x, k.y, ctx.network),
      clock: k.clock,
      phase,
      late: phase === 'late',
      setCall,
      site,
      roundSite: roundSiteOf,
      aggressive: k.clock >= AGGRESSIVE_CLOCK
    });
  }
  const total = set.length;
  const lines = [];
  for (const [id, kills] of byPlayer) {
    const name = nameOf(ctx, id);
    const seed = `${ctx.seed}|open|${side}|${id}`;
    const zones = new Map();
    for (const k of kills) {
      if (!k.zone) continue;
      if (!zones.has(k.zone)) zones.set(k.zone, []);
      zones.get(k.zone).push(k);
    }
    // Averaged rather than the median: the detailed report's "usually" is an
    // average, and the two documents must not disagree about one clock.
    const zoneRows = [...zones.entries()]
      .map(([zone, list]) => ({
        zone,
        count: list.length,
        clock: clockText(list.reduce((n, k) => n + k.clock, 0) / list.length),
        first: Math.max(...list.map((k) => k.clock))
      }))
      .sort((a, b) => b.count - a.count || b.first - a.first || a.zone.localeCompare(b.zone));
    // `inner` goes inside the brackets after the count, `after` follows them.
    const line = { id, name, count: kills.length, files: kills.map((k) => k.file), inner: [], after: '', note: '' };
    const zoneText = (z) => `${z.zone} x${z.count} usually ${z.clock}`;

    const allLate = kills.every((k) => k.late);
    const allSet = kills.every((k) => k.setCall);
    const allLateOrSet = kills.every((k) => k.late || k.setCall);
    const aggressive = kills.filter((k) => k.aggressive);
    if (kills.length >= 3 && (allLate || allSet || allLateOrSet)) {
      line.after = say(allLate ? 'open-all-late' : allSet ? 'open-all-set' : 'open-all-late-set', seed);
    } else if (kills.length <= 3) {
      line.inner = zoneRows.map(zoneText);
    } else if (kills.length <= 5 && aggressive.length <= 1) {
      line.inner.push(
        aggressive.length
          ? say('open-only-aggressive', seed, { n: 1, zone: aggressive[0].zone || siteLetter(aggressive[0].site) })
          : say('open-no-aggressive', seed)
      );
    } else {
      // The ground that repeats, then a word on the rest. When nothing repeats
      // the first few are named as they came.
      const repeats = zoneRows.filter((z, i) => z.count >= 2 && (i === 0 || percent(z.count, kills.length) >= 25));
      const shown = repeats.length ? repeats.slice(0, 2) : zoneRows.slice(0, 3);
      line.inner = shown.map(zoneText);
      const shownZones = new Set(shown.map((z) => z.zone));
      const rest = kills.filter((k) => !shownZones.has(k.zone));
      // Ground they spend the early round on without ever opening there.
      if (kills.length >= 4) {
        const early = earlyHome(ctx, side, id);
        if (early && !kills.some((k) => k.zone === early && !k.late)) {
          line.inner.push(say('open-nothing-early', seed, { zone: early }));
        }
      }
      if (rest.length) line.inner.push(repeats.length ? restWords(rest, seed) : say('open-rest-spread', seed));
    }
    // A player carrying the openings, and carrying them towards one site.
    if (total >= 8 && percent(kills.length, total) >= 35) {
      const sites = new Map();
      for (const k of kills) bump(sites, siteLetter(k.site));
      const best = top(sites);
      if (best && best[0] && percent(best[1], kills.length) >= 55) {
        line.note = say('open-very-active', seed, { site: best[0] });
      }
    }
    lines.push(line);
  }
  lines.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, lines };
}

/** "rest Con late for B calls", or "rest spread out" when nothing ties them. */
function restWords(rest, seed) {
  const zones = new Map();
  const sites = new Map();
  let late = 0;
  let early = 0;
  for (const k of rest) {
    bump(zones, k.zone);
    bump(sites, siteLetter(k.roundSite));
    if (k.late) late++;
    else if (k.phase === 'early') early++;
  }
  const words = [];
  const z = top(zones);
  if (z && z[0] && z[1] >= 2 && percent(z[1], rest.length) >= 50) words.push(z[0]);
  if (percent(late, rest.length) >= 60) words.push('late');
  else if (percent(early, rest.length) >= 60) words.push('early');
  const s = top(sites);
  if (s && s[0] && rest.length >= 2 && percent(s[1], rest.length) >= 60) words.push(`for ${s[0]} calls`);
  if (!words.length) return say('open-rest-spread', seed);
  return say('open-rest', seed, { what: words.join(' ') });
}

/**
 * Where a player spends the early round, by named ground, once out of spawn.
 * Only an answer when one place clearly dominates.
 */
function earlyHome(ctx, side, id) {
  const counts = new Map();
  let total = 0;
  for (const r of ctx.rounds) {
    if (r.side !== side || !r.hasTicks || r.ownEcon < 4) continue;
    for (const s of r.series) {
      if (s.elapsed < 8 || s.tick >= r.bounds.midStartTick) continue;
      const p = s.pts.find((x) => x.id === id);
      if (!p?.pos) continue;
      bump(counts, p.pos);
      total++;
    }
  }
  const best = top(counts);
  return best && percent(best[1], total) >= 25 ? best[0] : '';
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** The player's sample in one 1s slice, or null. */
function sampleOf(r, id, elapsed) {
  return sampleAtElapsed(r, elapsed)?.pts.find((p) => p.id === id) || null;
}

/** Which site a lane stands for, when it stands for one ("B" -> 'b'). */
function laneSite(lane) {
  const short = String(lane?.short || '').trim();
  return /^[AB]$/i.test(short) ? short.toLowerCase() : null;
}

/**
 * One paragraph per player about what they actually do: where they play and
 * whether that changes round to round, how often they go in alone onto ground
 * the other team held, how often they lurk and what they do on it, the
 * opening duels they take, and what they throw. Every sentence is optional: a
 * fact the rounds do not support is left out rather than written vaguely. No
 * recommendations: the analyst writes those.
 */
export function playerFor(ctx, side, main, extras) {
  const id = main.id;
  const name = main.name;
  const role = (ctx.mains ? rolesFor(ctx, side).get(id) : '') || ctx.rolesOf?.(id, side) || '';
  const seed = `${ctx.seed}|player|${side}|${id}`;
  const lanes = FORMATIONS[ctx.mapCode]?.t || [];
  const rounds = ctx.rounds.filter((r) => r.side === side && r.hasTicks && r.ourIds?.includes(id));
  const full = rounds.filter((r) => r.ownEcon >= 4);
  if (!full.length) return null;
  const them = side === 'T' ? 'CTs' : 'Ts';

  // Where they are once out of spawn, by lane, and by ground in the midround.
  const laneEarly = new Map();
  const zoneMid = new Map();
  let earlyN = 0;
  let midN = 0;
  for (const r of full) {
    for (const s of r.series) {
      if (s.elapsed < 8) continue;
      const p = s.pts.find((x) => x.id === id);
      if (!p) continue;
      if (s.tick < r.bounds.midStartTick) {
        earlyN++;
        const lane = laneOfPos(p.pos, ctx.laneSets);
        if (lane >= 0) bump(laneEarly, lane);
      } else if (s.tick < r.bounds.lateStartTick) {
        midN++;
        if (p.pos) bump(zoneMid, p.pos);
      }
    }
  }
  const mainLane = side === 'T' ? top(laneEarly) : null;
  const lane = mainLane && lanes[mainLane[0]] ? lanes[mainLane[0]] : null;
  const laneName = lane ? laneWord(lane) : '';
  const laneShare = mainLane ? percent(mainLane[1], earlyN) : 0;

  const awpRounds = full.filter((r) => r.series.some((s) => s.pts.some((p) => p.id === id && p.awp)));
  // A rifler who picks up a dropped AWP five times is not the AWPer.
  const isAwper = awpRounds.length >= 5 && percent(awpRounds.length, full.length) >= 35;

  const sentences = [];
  // Where they start, and whether it changes: the spot at 1:37 round by round.
  const spots = tally(
    full.map((r) => sampleOf(r, id, 18)).filter((p) => p?.pos),
    (p) => {
      if (side !== 'T') return p.pos;
      const l = laneOfPos(p.pos, ctx.laneSets);
      return l >= 0 && lanes[l] ? laneWord(lanes[l]) : p.pos;
    }
  );
  const spotN = spots.reduce((n, [, c]) => n + c, 0);
  if (isAwper) {
    const ranked = tally(
      awpRounds.map((r) => sampleOf(r, id, MIDROUND_ELAPSED)).filter(Boolean),
      (p) => {
        const l = laneOfPos(p.pos, ctx.laneSets);
        return side === 'T' && l >= 0 && lanes[l] ? laneWord(lanes[l]) : p.pos || '';
      }
    ).filter(([k]) => k);
    const busy = ranked.filter(([, n]) => n >= 2).length;
    sentences.push(say(busy >= 3 ? 'player-awp-dynamic' : 'player-awp-static', seed));
    const shown = ranked.slice(0, 3);
    const restN = ranked.slice(3).reduce((n, [, c]) => n + c, 0);
    const parts = shown.map(([where, n]) => (n === 1 ? `once ${where}` : `${plural(n, 'round')} ${where}`));
    if (restN) parts.push(`rest (${plural(restN, 'round')}) spread out`);
    if (parts.length) sentences.push(capitalize(joinList(parts)));
  } else if (spots.length && spotN >= 6) {
    const [spot, n] = spots[0];
    const share = percent(n, spotN);
    if (share >= 65) {
      sentences.push(`Plays ${spot} almost every round (${n} of ${spotN}), always doing the same thing`);
    } else {
      const parts = spots.slice(0, 3).map(([w, c]) => `${w} ${c}`);
      sentences.push(`${share >= 45 ? `Mostly ${spot}, but moves around` : 'Dynamic, starts in different places'}: ${joinList(parts)} of ${spotN} rounds`);
    }
  } else if (side === 'T' && laneName && laneShare >= 35) {
    sentences.push(say('player-plays', seed, { where: laneName }));
  }

  // Aggression: walking alone onto ground the other team held this round.
  const aggr = [];
  for (const r of full) {
    const m = aggressiveMovesOf(r).find((x) => x.id === id && x.elapsed <= 45);
    if (m) aggr.push({ r, m });
  }
  const aggrShare = percent(aggr.length, full.length);
  if (aggr.length >= 3) {
    const zone = mostCommon(aggr, (x) => x.m.zone);
    const zoneN = aggr.filter((x) => x.m.zone === zone).length;
    const clock = clockText(ROUND_SECONDS - median(aggr.filter((x) => x.m.zone === zone).map((x) => x.m.elapsed)));
    const level = aggrShare >= 35 ? 'Aggressive' : aggrShare >= 15 ? 'Sometimes aggressive' : 'Rarely aggressive';
    sentences.push(
      `${level}: goes in alone onto ground the ${them} held in ${aggr.length} of ${full.length} rounds, ${
        zoneN >= 2 ? `mostly ${zone} around ${clock}` : 'never the same place twice'
      } (won ${won(aggr)})`
    );
  } else if (full.length >= 8) {
    sentences.push(`Hardly ever goes in alone (${aggr.length} of ${full.length} rounds)`);
  }

  // Lurks (T): away from the team when it commits, and what he does there.
  if (side === 'T') {
    const lurks = full.filter((r) => lurkersOf(r).has(id));
    if (lurks.length >= 4 && percent(lurks.length, full.length) >= 8) {
      const where = mostCommon(lurks, (r) => sampleOf(r, id, commitElapsed(r) ?? MIDROUND_ELAPSED)?.pos || '');
      const active = lurks.filter((r) => {
        const c = commitElapsed(r);
        return aggressiveMovesOf(r).some((m) => m.id === id && c !== null && Math.abs(m.elapsed - c) <= 15);
      }).length;
      const kills = lurks.filter((r) => {
        const c = commitElapsed(r);
        return r.kills.some((k) => k.attacker === id && c !== null && ROUND_SECONDS - k.clock >= c - 10 && ROUND_SECONDS - k.clock <= c + 15);
      }).length;
      sentences.push(
        `Lurks in ${lurks.length} of ${full.length} rounds${where ? `, mostly ${where}` : ''}: pushes alone while the team hits in ${active}, gets a kill around the hit in ${kills}`
      );
    }
  }

  // Opening duels: how often they are in one and how they go.
  const opens = full.filter((r) => r.firstKill && (r.firstKill.attacker === id || r.firstKill.victim === id));
  if (opens.length >= 4) {
    const winsDuel = opens.filter((r) => r.firstKill.attacker === id).length;
    const zone = mostCommon(opens, (r) => r.firstKill.victimZone || '');
    sentences.push(`Takes the first duel in ${opens.length} of ${full.length} rounds (wins ${winsDuel})${zone ? `, most often at ${zone}` : ''}`);
  }

  // When the fights come, in their lane if they have one.
  const fights = [];
  for (const r of rounds) {
    for (const k of r.kills) {
      if (k.attacker !== id && k.victim !== id) continue;
      const zone = zoneAt(k.x, k.y, ctx.network);
      fights.push({ clock: k.clock, zone, lane: laneOfPos(zone, ctx.laneSets) });
    }
  }
  const laneFights = mainLane ? fights.filter((f) => f.lane === mainLane[0]) : [];
  const inLane = laneFights.length >= 3 && Boolean(laneName);
  const fightSet = inLane ? laneFights : fights;
  if (fightSet.length >= 3) {
    const zone = mostCommon(fightSet, (f) => f.zone);
    const where = inLane ? `${laneSite(lane) ? 'on' : 'in'} ${laneName}` : zone ? `on ${zone}` : '';
    sentences.push(
      say('player-active-around', seed, { where, clock: clockText(median(fightSet.map((f) => f.clock))) }).replace(/\s+around/, ' around')
    );
  }

  // The ground they hold in the midround and how long they stay on it.
  const hold = top(zoneMid);
  if (hold && midN && percent(hold[1], midN) >= 25) {
    const holdZone = hold[0];
    const leaves = [];
    for (const r of full) {
      let last = null;
      for (const s of r.series) {
        const p = s.pts.find((x) => x.id === id);
        if (p?.pos === holdZone) last = s.elapsed;
      }
      if (last !== null) leaves.push(ROUND_SECONDS - last);
    }
    const holdClock = median(leaves);
    if (holdClock !== null && leaves.length >= 4) {
      sentences.push(say('player-holds', seed, { zone: holdZone, clock: clockText(holdClock) }));
    }
  }

  // Utility they throw round after round.
  const util = (extras?.utility || []).filter((u) => u.share >= 25);
  if (util.length) {
    sentences.push(
      say('player-utility', seed, {
        list: joinList(util.slice(0, 2).map((u) => `a ${nadeName(u.name, u.type)} at ${u.clock} (${u.share}%)`))
      })
    );
  }

  // T: do they leave their lane when the team commits to the other site?
  if (side === 'T' && lane && laneSite(lane)) {
    const home = laneSite(lane);
    const otherSite = home === 'a' ? 'b' : 'a';
    const away = full.filter((r) => paceSite(r) === otherSite);
    if (away.length >= 3) {
      let joined = 0;
      for (const r of away) {
        const at = commitElapsed(r);
        const p = at !== null ? sampleOf(r, id, at + 5) : null;
        if (p && r.siteNear(p.x, p.y) === otherSite) joined++;
      }
      const joinShare = percent(joined, away.length);
      if (joinShare >= 70) {
        sentences.push(say('player-joins', seed, { lane: otherSite.toUpperCase(), share: joinShare }));
      } else if (joinShare <= 30) {
        sentences.push(say('player-stays', seed, { zone: laneName, other: otherSite.toUpperCase() }));
      }
    }
  }

  if (!sentences.length) return null;
  return {
    id,
    name,
    role,
    text: paragraph(sentences, ctx.names),
    files: filesOf(full),
    // The analyst writes the recommendations; the sheet only states facts.
    rec: ''
  };
}

// ---------------------------------------------------------------------------
// Misc statistics
// ---------------------------------------------------------------------------

const MISC_MIN_ROUNDS = 8;

/** "about twice as much", "a bit more", "about as often". */
function ratioWords(a, b) {
  if (!a || !b) return '';
  const r = a / b;
  if (r >= 2.6) return `about ${Math.round(r)} times as much as`;
  if (r >= 1.7) return 'about twice as much as';
  if (r >= 1.25) return 'a bit more than';
  return '';
}

/**
 * What the other team did in our rounds, in the words a sheet uses: their
 * round-library calls, and on our T side their stacks and where their AWP
 * started; on our CT side how many of them went towards a site or mid.
 */
function enemyShapes(r, ctx) {
  const out = new Set();
  const them = r.side === 'T' ? 'CT' : 'T';
  const labels = typeLabels(ctx.mapCode, them);
  for (const t of specificTags(r, them)) out.add(capitalize(callWords(labels.get(t.k) || t.k)));
  if (!r.hasTicks) return out;
  if (r.side === 'T') {
    const s = sampleAtElapsed(r, 25);
    const a = oppToward(r, s, 'a', 0);
    const b = oppToward(r, s, 'b', 0);
    if (a >= 3 && a > b) out.add('Enemy A stack (3+ on A at 1:30)');
    if (b >= 3 && b > a) out.add('Enemy B stack (3+ on B at 1:30)');
    const awp = sampleAtElapsed(r, 15)?.opp?.find((p) => p.awp);
    if (awp?.pos) {
      const lanes = FORMATIONS[ctx.mapCode]?.t || [];
      const l = laneOfPos(awp.pos, ctx.laneSets);
      const site = r.siteNear(awp.x, awp.y);
      const area = site ? site.toUpperCase() : l >= 0 && lanes[l] ? laneWord(lanes[l]) : awp.pos;
      out.add(`Enemy AWP ${area} start`);
    }
  } else {
    const s = sampleAtElapsed(r, 35);
    if (oppToward(r, s, 'a') >= 3) out.add('A defaults (3+ enemy players towards A)');
    if (oppToward(r, s, 'b') >= 3) out.add('B defaults (3+ enemy players towards B)');
    const lanes = FORMATIONS[ctx.mapCode]?.t || [];
    const mid = lanes.findIndex((l) => l.key === 'mid' || /mid/i.test(l.label));
    const snap = sampleAtElapsed(r, 13);
    if (mid >= 0 && (snap?.opp || []).filter((p) => laneOfPos(p.pos, ctx.laneSets) === mid).length >= 4) {
      out.add('4 mid rounds from Ts');
    }
  }
  return out;
}

function miscFor(ctx) {
  const paragraphs = { T: [], CT: [] };
  // T side.
  {
    const set = ctx.rounds.filter((r) => r.side === 'T' && r.ownEcon >= 2);
    const a = set.filter((r) => roundSite(r) === 'A');
    const b = set.filter((r) => roundSite(r) === 'B');
    if (a.length + b.length >= 6) {
      const wa = percent(won(a), a.length);
      const wb = percent(won(b), b.length);
      const lead = Math.abs(wa - wb) < 10 ? '' : wa > wb ? 'A' : 'B';
      const pref = lead
        ? `, more successful on ${lead}`
        : ', with no indication given to which they prefer due to success';
      const more = a.length >= b.length ? ['A', a.length, b.length, 'B'] : ['B', b.length, a.length, 'A'];
      const ratio = ratioWords(more[1], more[2]);
      const amount = ratio
        ? ` In terms of amount, they go ${more[0]} ${ratio} ${more[3]}.`
        : ' In terms of amount, they go to both sites about as often.';
      paragraphs.T.push(line(`On their T side, they win ${wa}% of A rounds and ${wb}% of B rounds${pref}.${amount}`, [...a, ...b]));
    }
    const rows = faced(set, ctx);
    const bad = rows.filter((x) => x.winrate < 50).sort((x, y) => x.winrate - y.winrate);
    if (rows.length) {
      if (bad.length) {
        const items = bad
          .slice(0, 4)
          .map((x) => line(`${x.label} (${ctx.teamName} have ${x.winrate}% winrate against this, ${x.rounds} rounds)`, x.list));
        paragraphs.T.push(
          bad.length <= 3
            ? `Highlights for T include only ${bad.length} CT start${bad.length === 1 ? '' : 's'} that ${bad.length === 1 ? 'has' : 'have'} a positive winrate against them:`
            : `${bad.length} CT starts have a positive winrate against them on T. The ones that hurt them most:`
        );
        paragraphs.T.push({ list: items });
      } else {
        const worst = [...rows].sort((x, y) => x.winrate - y.winrate)[0];
        paragraphs.T.push(
          line(
            `No CT start has a positive winrate against them; the hardest for them is ${worst.label} (${worst.winrate}% won, ${worst.rounds} rounds).`,
            worst.list
          )
        );
      }
    }
  }
  // CT side.
  {
    const set = ctx.rounds.filter((r) => r.side === 'CT' && r.ownEcon >= 2);
    const a = set.filter((r) => r.hitSite === 'a');
    const b = set.filter((r) => r.hitSite === 'b');
    if (a.length + b.length >= 6) {
      paragraphs.CT.push(
        line(
          `On their CT side, they have a ${percent(won(a), a.length)}% winrate against A rounds, and a ${percent(won(b), b.length)}% winrate against B rounds.`,
          [...a, ...b]
        )
      );
    }
    const rows = faced(set, ctx);
    const good = rows.filter((x) => x.winrate >= 55).sort((x, y) => y.winrate - x.winrate).slice(0, 3);
    const weak = rows.filter((x) => x.winrate < 45).sort((x, y) => x.winrate - y.winrate).slice(0, 2);
    if (good.length) {
      paragraphs.CT.push(
        line(
          `Highlights for CT include ${joinList(good.map((x) => `a ${x.winrate}% winrate against ${x.label} (${x.rounds} rounds)`))}.`,
          good.flatMap((x) => x.list)
        )
      );
    }
    if (weak.length) {
      paragraphs.CT.push(
        line(`They struggle against ${joinList(weak.map((x) => `${x.label} (${x.winrate}% won, ${x.rounds} rounds)`))}.`, weak.flatMap((x) => x.list))
      );
    }
  }
  return paragraphs;
}

/** Our winrate against each thing the other team did, with enough rounds of it. */
function faced(set, ctx) {
  const by = new Map();
  for (const r of set) {
    for (const label of enemyShapes(r, ctx)) {
      if (!by.has(label)) by.set(label, []);
      by.get(label).push(r);
    }
  }
  return [...by.entries()]
    .filter(([, l]) => l.length >= MISC_MIN_ROUNDS)
    .map(([label, l]) => ({ label, rounds: l.length, list: l, winrate: percent(won(l), l.length) }));
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Everything the summary prints, as data.
 *
 * @param {{
 *   extract: { rounds: object[], network: object|null, laneSets: object, nameOf: Map, mains: Array, rolesOf: Function, includedDemos?: Array },
 *   sections: object,
 *   mapCode: string,
 *   teamName: string
 * }} input
 */
export function buildSummaryReport({ extract, sections, mapCode, teamName }) {
  const ctx = {
    ...extract,
    mapCode,
    teamName,
    seed: `${teamName}|${mapCode}`,
    // Handles are written as their owners write them, sentence start or not.
    names: [...new Set([...(extract.nameOf?.values?.() || []), ...(extract.mains || []).map((m) => m.name)])]
  };
  const players = sections?.players || [];
  const out = { teamName, mapCode, sides: {}, misc: miscFor(ctx) };
  for (const side of ['T', 'CT']) {
    const order = ['b', 'a'];
    const count = (s) =>
      ctx.rounds.filter((r) => r.side === side && (side === 'T' ? paceSite(r) : r.hitSite) === s).length;
    order.sort((x, y) => count(y) - count(x));
    const defaults = defaultUtilityFor(ctx, side);
    out.sides[side] = {
      positions: positionsFor(ctx, side),
      pace: side === 'T' ? paceFor(ctx) : null,
      setups: side === 'CT' ? ctCallsFor(ctx) : null,
      tells: tellsFor(ctx, side),
      defaults,
      danger: dangerFor(ctx, side),
      antiforce: antiforceFor(ctx, side, defaults),
      force: forceFor(ctx, side),
      sites: order.map((s) => (side === 'T' ? tSiteFor(ctx, s) : ctVsSiteFor(ctx, s))),
      retakes: side === 'CT' ? retakesFor(ctx) : null,
      pistols: pistolsFor(ctx, side),
      players: ctx.mains
        .map((m) => {
          const scan = players.find((p) => p.name === m.name);
          return playerFor(ctx, side, m, { utility: scan?.sides?.[side]?.utility || [] });
        })
        .filter(Boolean)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
//
// Printed, so by default nothing in it is a link: a round count is a number
// on paper. Built with `links`, every heading and line opens the rounds it was
// written from, for whoever checks that the sheet says what the rounds show.

const TITLE_STYLE = 'font-size: 25px';
const HEADING_STYLE = 'font-size: 19px';
/** Rounds one link opens: a whole section, without a URL nobody can load. */
const LINK_ROUNDS_MAX = 150;

export const note = (html) => `<span style="color: ${NOTE_COLOR}">${html}</span>`;
const negative = (html) => `<span style="color: ${NEGATIVE_COLOR}">${html}</span>`;
const li = (items) => (items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
/** The note column of a sheet, kept on the line it belongs to. */
const aside = (text, esc) => (text ? `&nbsp;&nbsp;&nbsp;${note(`*${esc(text)}`)}` : '');

/**
 * The writer the section renderers share: `esc` for text, `link` to wrap
 * already-escaped html in a timeline link over round files (or leave it as it
 * is when links are off or there are no rounds).
 */
function docWriter(esc, links) {
  const link = (html, files) => {
    const list = [...new Set(files || [])].filter(Boolean).slice(0, LINK_ROUNDS_MAX);
    if (!links || !list.length) return html;
    return `<a href="${esc(`/demos?rounds=${list.map(encodeURIComponent).join(',')}`)}">${html}</a>`;
  };
  /** A sheet line: a string, a { text, files } line, or "Others: " with parts. */
  const lineHtml = (l) => {
    if (typeof l === 'string') return esc(l);
    if (l.parts) return `${esc(l.text)}${l.parts.map((p) => link(esc(p.text), p.files)).join(', ')}${esc(l.tail || '')}`;
    return link(esc(l.text), l.files);
  };
  return { esc, link, lineHtml };
}

function positionsHtml(w, rows) {
  return li(rows.map((p) => `${w.esc(p.name)}: ${w.esc(p.role || 'Unknown')}`));
}

function paceHtml(w, pace) {
  if (!pace?.basis) return '';
  return li(
    pace.rows.map((row) => {
      const sites =
        FAST.includes(row.pace) && row.siteA + row.siteB > 0
          ? `, ${row.siteB} towards B, ${row.siteA} towards A`
          : '';
      return `${w.link(w.esc(row.label), row.files)}: ${row.share}% (${row.count}${sites})${aside(row.note, w.esc)}`;
    })
  );
}

function callsHtml(w, setups) {
  if (!setups?.calls?.length) return '';
  return li(
    setups.calls.map(
      (c) =>
        `${w.link(w.esc(c.label), c.files)}: ${c.share}% (${c.count}${c.clock ? `, usually ${w.esc(c.clock)}` : ''}, ${c.winrate}% won)`
    )
  );
}

/** "Xbox smoke: Always short pop (5 of 5)": the utility opens the rounds it was in, the answer the rounds it was right. */
function tellHtml(w, t, lead = '') {
  return `${lead}${w.link(w.esc(lead ? t.utility : capitalize(t.utility)), t.files)}: ${w.link(
    note(w.esc(`${t.freq || 'Mostly'} ${t.outcome}`)),
    t.hitFiles
  )} (${t.hits} of ${t.rounds})`;
}

function tellsHtml(w, tells) {
  const rows = tells.tells.map((t) => tellHtml(w, t));
  for (const g of tells.siteGroups || []) {
    const items = g.items.map((t, i) => `${w.link(w.esc(i ? t.utility : capitalize(t.utility)), t.files)} (${t.hits} of ${t.rounds})`);
    const hit = g.items.flatMap((t) => t.hitFiles || []);
    rows.push(`${joinList(items)}: ${w.link(note(w.esc(`${g.freq} ${g.outcome}`)), hit)}`);
  }
  for (const t of tells.absent || []) {
    rows.push(
      `${w.link(w.esc(`No ${t.utility}`), t.files)} (thrown in ${t.usual}% of rounds): ${w.link(
        note(w.esc(`${t.freq || 'Mostly'} ${t.outcome}`)),
        t.hitFiles
      )} (${t.hits} of ${t.rounds})`
    );
  }
  if (tells.firstBuy) {
    if (tells.firstBuy.tells.length) {
      for (const t of tells.firstBuy.tells) rows.push(tellHtml(w, t, 'First buy, '));
    } else {
      rows.push(negative(w.esc(say('tells-none-first-buy', 'first'))));
    }
  }
  if (!rows.length) rows.push(negative(w.esc(say('tells-none', 'none'))));
  return li(rows);
}

function defaultsHtml(w, d) {
  if (!d?.rows?.length) return '';
  return li(
    d.rows.map((u) => {
      const bits = [u.clock ? `usually ${u.clock}` : '', u.thrower].filter(Boolean).join(', ');
      return `${w.link(w.esc(capitalize(nadeName(u.label, u.type))), u.files)}: ${u.share}%${bits ? ` (${w.esc(bits)})` : ''}`;
    })
  );
}

const linesHtml = (w, lines) => li((lines || []).map((l) => w.lineHtml(l)));

function variationsHtml(w, v) {
  if (!v?.lines?.length) return '';
  return `${linesHtml(w, v.lines)}${(v.notes || []).map((n) => `<p>${note(`*${w.esc(n)}`)}</p>`).join('')}`;
}

function playersHtml(w, list) {
  return list
    .map((p) => `<h3>${w.link(`${w.esc(p.name)}${p.role ? ` (${w.esc(p.role)})` : ''}`, p.files)}</h3><p>${w.esc(p.text)}</p>`)
    .join('');
}

function miscHtml(w, misc) {
  const block = (items) =>
    items
      .map((x) => (x.list ? `<ol>${x.list.map((i) => `<li>${w.lineHtml(i)}</li>`).join('')}</ol>` : `<p>${w.lineHtml(x)}</p>`))
      .join('');
  const t = block(misc?.T || []);
  const ct = block(misc?.CT || []);
  return t || ct ? `${t}${ct}` : '';
}

/**
 * @param {{
 *   teamName: string,
 *   mapCode: string,
 *   categories: string[],
 *   report: ReturnType<typeof buildSummaryReport>,
 *   links?: boolean,
 *   results?: object
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildSummaryDocHtml(spec, esc) {
  const w = docWriter(esc, Boolean(spec.links));
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const cats = new Set(spec.categories || []);
  const parts = [`<h1 style="${TITLE_STYLE}">${esc(spec.teamName)}: ${esc(mapName)}</h1>`];
  for (const side of ['T', 'CT']) {
    if (!cats.has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    const bag = spec.report?.sides?.[side];
    if (!bag) continue;
    parts.push(`<h2 style="${HEADING_STYLE}">${esc(spec.teamName)} ${SIDE_OF[side]} SIDE</h2>`);
    /** A heading opens every round the section was written from. */
    const section = (key, title, html, files) => {
      if (!cats.has(key) || !html) return;
      parts.push(`<h3>${w.link(esc(`${side} ${title}`), files)}</h3>${html}`);
    };
    section('positions', 'Positions', positionsHtml(w, bag.positions));
    if (side === 'T') section('pace', 'Pace', paceHtml(w, bag.pace), bag.pace?.files);
    else section('pace', 'Calls', callsHtml(w, bag.setups), bag.setups?.files);
    section('tells', 'Tells', tellsHtml(w, bag.tells), bag.tells?.files);
    section('defaults', 'Default utility', defaultsHtml(w, bag.defaults), bag.defaults?.files);
    if (side === 'T') section('force', 'Force buys', variationsHtml(w, bag.force), bag.force?.files);
    section('danger', 'Dangerous rounds & openings', linesHtml(w, bag.danger?.lines), bag.danger?.files);
    section('antiforce', side === 'T' ? 'Antiforces' : 'Anti-ecos', variationsHtml(w, bag.antiforce), bag.antiforce?.files);
    if (side === 'CT') section('force', 'Force buys', variationsHtml(w, bag.force), bag.force?.files);
    for (const s of bag.sites || []) {
      section('sites', side === 'T' ? `${s.site} Rounds` : `VS ${s.site} Rounds`, linesHtml(w, s.bullets), s.files);
    }
    if (side === 'CT') section('sites', 'Retakes', linesHtml(w, bag.retakes?.bullets), bag.retakes?.files);
    section('pistols', 'Pistols', variationsHtml(w, bag.pistols), bag.pistols?.files);
    if (cats.has('players') && bag.players.length) parts.push(playersHtml(w, bag.players));
  }
  if (cats.has('misc')) {
    const html = miscHtml(w, spec.report?.misc);
    if (html) parts.push(`<h2 style="${HEADING_STYLE}">MISC STATISTICS:</h2>${html}`);
  }
  return parts.join('');
}
