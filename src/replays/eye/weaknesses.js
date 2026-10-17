// ---------------------------------------------------------------------------
// replays/eye/weaknesses.js
// Where a team loses, measured: the part of "find their weaknesses" that must
// not be left to the model's judgement.
//
// Everything is a comparison inside the team's own rounds on one map and one
// side (full buys against full buys unless it is about buys): a kind of round
// they lose more than their usual, a spot where they lose more fights than
// they win, a place their opening deaths pile up. A weakness needs enough
// rounds to be more than noise and a real gap to the team's own baseline; it
// is ranked by the gap weighted by how many rounds show it.
//
// Situations (retakes, post-plants, anti-ecos, forces) are listed with their
// numbers but not ranked against the baseline, because a retake is always
// below a team's average and saying so tells a coach nothing.
// ---------------------------------------------------------------------------

import { runRoundQuery } from './roundQuery.js';

/** Fewest rounds a weakness can rest on. */
export const MIN_ROUNDS = 5;
/** Smallest gap to the team's own win rate that counts (0.15 = 15 points). */
export const MIN_GAP = 0.15;
const MIN_FIGHTS = 6;
const MAX_FILES = 40;
const MAX_PER_KIND = 4;

const rate = (won, n) => (n ? won / n : 0);
const pct = (x) => Math.round(x * 100);

/**
 * @param {object[]} rounds   antistratScan `extract.rounds`
 * @param {object} network    the map's zone network
 * @param {{ side: 'T'|'CT' }} opts
 */
export function findWeaknesses(rounds, network, { side }) {
  const full = { side, buy: 'full', vs_buy: 'full' };
  const base = runRoundQuery(rounds, network, full);
  const baseRate = rate(base.won, base.matched);
  const out = [];
  const situations = [];

  const consider = (kind, text, q) => {
    if (q.matched < MIN_ROUNDS) return;
    const r = rate(q.won, q.matched);
    const gap = baseRate - r;
    if (gap < MIN_GAP) return;
    out.push({
      kind,
      text: `${text}: won ${q.won} of ${q.matched} (${pct(r)}%) against ${pct(baseRate)}% in all their full buys.`,
      rounds: q.matched,
      won: q.won,
      score: Math.round(gap * Math.sqrt(q.matched) * 100) / 100,
      files: q.files.slice(0, MAX_FILES)
    });
  };

  // Kinds of round: a site, and on T a pace, they lose more than usual.
  const site = runRoundQuery(rounds, network, { ...full, group_by: 'site' });
  for (const g of site.groups) {
    if (g.key === 'no site') continue;
    const q = runRoundQuery(rounds, network, { ...full, where: [{ site: g.key }] });
    consider('site', side === 'T' ? `When they hit ${g.key}` : `When ${g.key} is hit`, q);
  }
  if (side === 'T') {
    const paces = runRoundQuery(rounds, network, { ...full, group_by: 'pace' });
    for (const g of paces.groups) {
      if (g.key === 'other') continue;
      consider('pace', `Their ${g.key} rounds`, runRoundQuery(rounds, network, { ...full, where: [{ pace: g.key }] }));
    }
  }

  // Spots where they lose their fights, and where their opening deaths pile up.
  const pool = rounds.filter((r) => r.hasTicks && r.side === side && r.ownEcon === 4 && r.oppEcon === 4);
  const fights = new Map();
  const tally = (zone, key, file) => {
    if (!zone) return;
    if (!fights.has(zone)) fights.set(zone, { kills: 0, deaths: 0, openingDeaths: 0, files: new Set() });
    const f = fights.get(zone);
    f[key]++;
    f.files.add(file);
  };
  let openingDeaths = 0;
  for (const r of pool) {
    for (const k of r.kills || []) {
      if (k.attackerOurs) tally(k.attackerZone, 'kills', r.file);
      else tally(k.victimZone, 'deaths', r.file);
    }
    const fk = r.firstKill;
    if (fk && !fk.attackerOurs) {
      openingDeaths++;
      tally(fk.victimZone, 'openingDeaths', r.file);
    }
  }
  for (const [zone, f] of fights) {
    const n = f.kills + f.deaths;
    if (n >= MIN_FIGHTS && f.deaths / n >= 0.65) {
      out.push({
        kind: 'fights',
        text: `They lose their fights at ${zone}: ${f.kills} kills, ${f.deaths} deaths there.`,
        rounds: f.files.size,
        score: Math.round((f.deaths / n - 0.5) * Math.sqrt(n) * 100) / 100,
        files: [...f.files].slice(0, MAX_FILES)
      });
    }
    if (f.openingDeaths >= 4 && f.openingDeaths / Math.max(1, openingDeaths) >= 0.3) {
      out.push({
        kind: 'opening',
        text: `${f.openingDeaths} of their ${openingDeaths} opening deaths are at ${zone}.`,
        rounds: f.openingDeaths,
        score: Math.round((f.openingDeaths / openingDeaths) * Math.sqrt(f.openingDeaths) * 100) / 100,
        files: [...f.files].slice(0, MAX_FILES)
      });
    }
  }

  // Situations: numbers to read, not to rank.
  const situation = (label, q) => {
    if (q.matched) situations.push({ text: `${label}: won ${q.won} of ${q.matched} (${pct(rate(q.won, q.matched))}%).`, rounds: q.matched, files: q.files.slice(0, MAX_FILES) });
  };
  if (side === 'T') situation('After planting', runRoundQuery(rounds, network, { ...full, where: [{ plant: true }] }));
  else situation('Retakes (the bomb was planted)', runRoundQuery(rounds, network, { ...full, where: [{ plant: true }] }));
  situation('After losing the opening duel', runRoundQuery(rounds, network, { ...full, where: [{ first_kill: { by: 'opponent' } }] }));
  situation('Full buy against an eco, half or force', antiEco(rounds, network, side));
  situation('Force buy against a full buy', runRoundQuery(rounds, network, { side, buy: 'force', vs_buy: 'full' }));

  out.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  // Fights are many and noisy; a few of them, so a lost site or pace is not buried.
  const perKind = {};
  const ranked = out.filter((x) => (perKind[x.kind] = (perKind[x.kind] || 0) + 1) <= MAX_PER_KIND);
  return {
    side,
    baseline: { rounds: base.matched, won: base.won, text: `Full buys against full buys: won ${base.won} of ${base.matched} (${pct(baseRate)}%).` },
    weaknesses: ranked,
    situations
  };
}

/** Full buys against anything less, as one pool. */
function antiEco(rounds, network, side) {
  const parts = ['eco', 'half', 'force'].map((b) => runRoundQuery(rounds, network, { side, buy: 'full', vs_buy: b }));
  return {
    matched: parts.reduce((n, p) => n + p.matched, 0),
    won: parts.reduce((n, p) => n + p.won, 0),
    files: parts.flatMap((p) => p.files)
  };
}
