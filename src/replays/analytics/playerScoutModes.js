// ---------------------------------------------------------------------------
// replays/analytics/playerScoutModes.js
// Player scout, summary and internal modes.
//
// The detailed player report (playerScoutConfig.js) lists every default and
// every variation. These two say less:
//
//   summary   the sheet a coach keeps on one opponent: a paragraph on how they
//             play each side with a recommendation under it, their openings,
//             the utility they repeat and what it gives away, their defaults.
//   internal  a review of one of our own players: their rating on every call
//             against the team's, the mistakes the autocoach keeps flagging on
//             them, the rounds they had no impact in, and what to work on.
//
// Both are built from the same rounds as the team reports (the player scan
// hands them over in the team report's shape), so a player's paragraph here
// and in a team summary are the same paragraph.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { aggregatePlayers, indexMaps } from '../shared/statsMath.js';
import { mapRoundGrid } from '../performance/mapRoundStats.js';
import { COACH_CATEGORY } from '../coach/coachMessages.js';
import { NEGATIVE_COLOR, note, openingsFor, playerFor, tellsOver } from './antistratSummary.js';
import { namesIn, ratingColor, readRound, roundTitle, zoneAt } from './antistratInternal.js';
import { say } from './reportMessages.js';
import { capitalize, clockText, joinList, paragraph, plural, sentence } from './reportProse.js';

export const PLAYER_SUMMARY_CATEGORIES = [
  { key: 'sideT', group: 'Sides', label: 'T side' },
  { key: 'sideCT', group: 'Sides', label: 'CT side' },
  { key: 'profile', group: 'Sections', label: 'How they play' },
  { key: 'openings', group: 'Sections', label: 'Openings' },
  { key: 'utility', group: 'Sections', label: 'Utility and tells' },
  { key: 'defaults', group: 'Sections', label: 'Defaults' }
];

export const PLAYER_INTERNAL_CATEGORIES = [
  { key: 'sideT', group: 'Sides', label: 'T side' },
  { key: 'sideCT', group: 'Sides', label: 'CT side' },
  { key: 'ratings', group: 'Sections', label: 'Ratings by round type' },
  { key: 'mistakes', group: 'Sections', label: 'Mistakes' },
  { key: 'impact', group: 'Sections', label: 'Rounds without impact' },
  { key: 'conclusion', group: 'Sections', label: 'Conclusion' }
];

export const PLAYER_MODE_GROUPS = ['Sides', 'Sections'];

const FULL_VS_FULL = { econ: 4, oppEcon: 4 };
const TRADE_SECONDS = 3;
const IMPACT_ROUNDS_MAX = 7;
const LINK_FILES_MAX = 40;

const LINK_STYLE = 'color: inherit; text-decoration: underline dotted';

/** The summary is printed: a count is just a count. */
// eslint-disable-next-line no-unused-vars
function plain(esc, label, files) {
  return label;
}

function link(esc, label, files) {
  const list = (files || []).filter(Boolean).slice(0, LINK_FILES_MAX);
  if (!list.length) return label;
  // In the text's own colour with a dotted line: these documents read like a
  // coach's sheet, and a page of accent-coloured numbers does not.
  return `<a href="${esc(`/demos?rounds=${list.map(encodeURIComponent).join(',')}`)}" style="${LINK_STYLE}">${label}</a>`;
}

const li = (items) => (items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
const colored = (html, color) => (color ? `<span style="color: ${color}">${html}</span>` : html);
const rating = (v) => (Number.isFinite(v) ? colored(v.toFixed(2), ratingColor(v)) : '––');

function contextOf(results, mapCode) {
  const ex = results.extract;
  return {
    ...ex,
    mapCode,
    teamName: results.teamName || '',
    seed: `${results.playerName}|${mapCode}|player`,
    names: [...(ex.nameOf?.values?.() || [])]
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** The rounds as if only this player had thrown anything: what their utility gives away. */
function onlyTheirUtility(rounds, id) {
  return rounds.map((r) => ({ ...r, nades: r.nades.filter((n) => n.player === id) }));
}

/** "Dies first x6 (Long x3 usually 1:45, ...)": the other half of the opening duel. */
function openingDeaths(ctx, side, id) {
  const set = ctx.rounds.filter((r) => r.side === side && r.firstKill?.victim === id);
  if (!set.length) return null;
  const zones = new Map();
  for (const r of set) {
    const z = r.firstKill.victimZone || '';
    if (!z) continue;
    if (!zones.has(z)) zones.set(z, []);
    zones.get(z).push(r.firstKill.clock);
  }
  const top = [...zones.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([z, clocks]) => `${z} x${clocks.length} usually ${clockText(clocks.reduce((a, b) => a + b, 0) / clocks.length)}`);
  return { count: set.length, files: set.map((r) => r.file), zones: top };
}

/**
 * @param {{ results: object, mapCode: string }} input  results from runPlayerScan({ keepRounds: true })
 */
export function buildPlayerSummaryReport({ results, mapCode }) {
  const ctx = contextOf(results, mapCode);
  const main = ctx.mains[0];
  const out = { name: main.name, teamName: ctx.teamName, roles: results.roles || {}, sides: {} };
  for (const side of ['T', 'CT']) {
    const bag = results.sides?.[side];
    const rounds = ctx.rounds.filter((r) => r.side === side);
    if (!bag || !rounds.length) continue;
    const utility = (bag.utility || []).map((u) => ({ name: u.spot, type: u.type, clock: u.clock, share: u.share }));
    const opening = openingsFor(ctx, side).lines.find((l) => l.id === main.id) || null;
    const tells = tellsOver(onlyTheirUtility(rounds, main.id), side, ctx, { minRounds: 4, limit: 4 });
    out.sides[side] = {
      profile: playerFor(ctx, side, main, { utility }),
      opening,
      deaths: openingDeaths(ctx, side, main.id),
      utility: (bag.utility || []).slice(0, 6),
      tells,
      defaults: (bag.defaults?.patterns || []).slice(0, 4),
      variations: (bag.variations || []).slice(0, 3)
    };
  }
  return out;
}

export function buildPlayerSummaryDocHtml(spec, esc) {
  const report = spec.report;
  const cats = new Set(spec.categories || []);
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const parts = [`<h1 style="font-size: 25px">${esc(report.name)}: ${esc(mapName)}</h1>`];
  const who = [
    report.teamName ? esc(report.teamName) : '',
    report.roles?.T ? `T ${esc(report.roles.T)}` : '',
    report.roles?.CT ? `CT ${esc(report.roles.CT)}` : ''
  ].filter(Boolean);
  if (who.length) parts.push(`<p>${who.join(', ')}</p>`);
  for (const side of ['T', 'CT']) {
    if (!cats.has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    const bag = report.sides[side];
    if (!bag) continue;
    parts.push(`<h2 style="font-size: 19px">${esc(report.name)} ${side} SIDE</h2>`);
    if (cats.has('profile') && bag.profile) {
      const p = bag.profile;
      parts.push(`<h3>${esc(p.name)}${p.role ? ` (${esc(p.role)})` : ''}</h3><p>${esc(p.text)}</p>`);
      if (p.rec) parts.push(`<p>${note(esc(p.rec))}</p>`);
    }
    if (cats.has('openings') && (bag.opening || bag.deaths)) {
      const rows = [];
      if (bag.opening) {
        const l = bag.opening;
        const inner = l.inner.length ? ` (${esc(l.inner.join(', '))})` : '';
        const after = l.after ? ` ${esc(l.after)}` : '';
        rows.push(`Opening kills ${plain(esc, `x${l.count}`, l.files)}${inner}${after}${l.note ? ` ${note(`*${esc(l.note)}`)}` : ''}`);
      }
      if (bag.deaths) {
        const inner = bag.deaths.zones.length ? ` (${esc(bag.deaths.zones.join(', '))})` : '';
        rows.push(`Dies first ${plain(esc, `x${bag.deaths.count}`, bag.deaths.files)}${inner}`);
      }
      parts.push(`<h3>${side} Openings</h3>${li(rows)}`);
    }
    if (cats.has('utility') && (bag.utility.length || bag.tells.length)) {
      const rows = bag.utility.map(
        (u) => `${plain(esc, esc(u.label), u.files)} at ${esc(u.clock)} (${u.share}%)`
      );
      for (const t of bag.tells) {
        rows.push(
          `${esc(capitalize(t.utility))}: ${note(esc(`${t.freq} ${t.outcome}`))} (${plain(esc, `${t.hits} of ${t.rounds}`, t.hitFiles)})`
        );
      }
      if (!bag.tells.length) rows.push(colored(esc(say('tells-none', 'player')), NEGATIVE_COLOR));
      parts.push(`<h3>${side} Utility</h3>${li(rows)}`);
    }
    if (cats.has('defaults') && (bag.defaults.length || bag.variations.length)) {
      const rows = bag.defaults.map(
        (d) =>
          `${esc(d.name || 'Default')}: ${plain(esc, esc(d.label || 'unnamed'), d.files)} (${plural(d.count, 'round')}, ${d.share}% of openings, ${d.winrate}% won)`
      );
      for (const v of bag.variations) {
        rows.push(`Otherwise: ${plain(esc, esc(v.label || 'unnamed'), v.files)} (${plural(v.count, 'round')}, ${v.winrate}% won)`);
      }
      parts.push(`<h3>${side} Defaults</h3>${li(rows)}`);
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** One call's row: the player's rating, the team's average, rounds and winrate. */
function callRows(grids, idx, tableSide, lane) {
  const mine = grids[idx];
  const rows = [];
  for (const row of mine?.[tableSide] || []) {
    const cell = row[lane];
    if (!cell?.rounds || !Number.isFinite(cell.rating)) continue;
    // Their teammates only: a comparison that includes the player is partly
    // a comparison with themselves.
    const others = grids
      .filter((_, i) => i !== idx)
      .map((g) => (g?.[tableSide] || []).find((x) => x.key === row.key)?.[lane]?.rating)
      .filter(Number.isFinite);
    rows.push({
      key: row.key,
      label: row.label,
      rounds: cell.rounds,
      rating: cell.rating,
      team: others.length ? others.reduce((a, b) => a + b, 0) / others.length : null,
      winrate: cell.winrate,
      files: cell.files
    });
  }
  return rows.sort((a, b) => b.rounds - a.rounds || a.label.localeCompare(b.label));
}

/**
 * @param {{
 *   results: object,          runPlayerScan({ keepRounds: true })
 *   payload: object,          stats payload, INTERNAL_COLUMNS
 *   coached: Map<string, object>,
 *   mapCode: string
 * }} input
 */
export function buildPlayerInternalReport({ results, payload, coached, mapCode }) {
  const ctx = contextOf(results, mapCode);
  const main = ctx.mains[0];
  const id = main.id;
  const name = main.name;
  const maps = indexMaps(payload || { demos: [] });
  const mateIds = Object.keys(results.mates || {});
  const seed = `${ctx.seed}|internal`;
  const mapName = MAPS[mapCode]?.name || mapCode;
  const rows = [];
  for (const demo of payload?.demos || []) {
    for (const row of demo.rounds || []) if (row.m === mapCode) rows.push(row);
  }
  // Everyone who played beside them, so "the team's rating on this call" means
  // the people actually in those rounds. The player is first.
  const order = [id, ...mateIds.filter((m) => m !== id)].slice(0, 5);
  const grids = order.map((pid) => mapRoundGrid(payload, pid, FULL_VS_FULL, maps.players, maps.demos)[mapCode]);

  const out = { name, teamName: ctx.teamName, roles: results.roles || {}, sides: {}, conclusion: [] };
  for (const side of ['T', 'CT']) {
    const other = side === 'T' ? 'CT' : 'T';
    const stats = aggregatePlayers(rows, maps.players, { side }, maps.demos);
    const me = stats.find((p) => p.id === id);
    if (!me) continue;
    const mates = stats.filter((p) => p.id !== id && order.includes(p.id));
    const teamRating = mates.length ? mates.reduce((n, p) => n + p.rating, 0) / mates.length : null;

    const own = callRows(grids, 0, side, 'ran');
    const faced = callRows(grids, 0, other, 'faced');
    const all = [...own, ...faced].filter((r) => r.rounds >= 4 && Number.isFinite(r.team));
    const weakest = [...all].filter((r) => r.rating <= r.team - 0.2).sort((a, b) => a.rating - a.team - (b.rating - b.team)).slice(0, 3);
    const strongest = [...all].filter((r) => r.rating >= r.team + 0.2).sort((a, b) => b.rating - b.team - (a.rating - a.team)).slice(0, 2);

    // What the autocoach keeps flagging on them on this side.
    const sideRounds = ctx.rounds.filter((r) => r.side === side && coached.has(r.file));
    const byCat = new Map();
    for (const r of sideRounds) {
      for (const f of coached.get(r.file).flags) {
        if (f.playerId !== id || f.category === COACH_CATEGORY.PRAISE) continue;
        if (!byCat.has(f.category)) byCat.set(f.category, { n: 0, rules: new Map(), files: new Set() });
        const bag = byCat.get(f.category);
        bag.n++;
        bag.files.add(r.file);
        bag.rules.set(f.rule, (bag.rules.get(f.rule) || 0) + 1);
      }
    }
    const mistakes = [...byCat.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([cat, bag]) => ({
        category: cat,
        count: bag.n,
        rounds: bag.files.size,
        files: [...bag.files],
        rules: [...bag.rules.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([rule, n]) => ({ label: say(`rule-${rule}`, rule) || rule, n }))
      }));

    // Lost full buys where they died having done little, across opponents.
    const byDemo = new Map();
    for (const r of ctx.rounds) {
      if (r.side !== side || r.won || r.ownEcon < 4) continue;
      const mine = r.kills.filter((k) => k.attacker === id).length;
      if (!r.kills.some((k) => k.victim === id) || mine >= 2) continue;
      if (!byDemo.has(r.demoId)) byDemo.set(r.demoId, []);
      byDemo.get(r.demoId).push(r);
    }
    const queues = [...byDemo.values()].map((l) => l.sort((a, b) => a.round - b.round));
    const picked = [];
    while (picked.length < IMPACT_ROUNDS_MAX && queues.some((q) => q.length)) {
      for (const q of queues) if (q.length && picked.length < IMPACT_ROUNDS_MAX) picked.push(q.shift());
    }
    picked.sort((a, b) => a.demoId.localeCompare(b.demoId) || a.round - b.round);
    let kills = 0;
    let deaths = 0;
    const impact = picked.map((r) => {
      const coach = coached.get(r.file);
      const read = readRound(r, coach, ctx);
      const death = r.kills.find((k) => k.victim === id);
      const before = r.kills.filter((k) => k.attacker === id && k.tick < death.tick);
      kills += r.kills.filter((k) => k.attacker === id).length;
      deaths += 1;
      const zone = zoneAt(death.x, death.y, ctx.network);
      const last = before[before.length - 1];
      let clause;
      if (last && (death.tick - last.tick) / r.tickRate <= TRADE_SECONDS) {
        clause = say('pl-worst-kill-refragged', r.file, { p: name });
      } else if (before.length) {
        clause = say('pl-worst-one-then-dies', r.file, { p: name, enemy: read.names(death.attacker), zone: zone ? ` on ${zone}` : '' });
      } else {
        clause = say('pl-worst-no-kill', r.file, { p: name, enemy: read.names(death.attacker), zone: zone ? ` on ${zone}` : '' });
      }
      const flag = read.weighted.find((w) => w.f.playerId === id && Math.abs(w.f.tick - death.tick) <= 2);
      const why = flag ? say(`why-${flag.f.rule}`, r.file) : '';
      if (why) clause = `${clause}, ${why}`;
      return {
        file: r.file,
        title: roundTitle(r),
        note: `${sentence(clause, namesIn(coach, ctx)).replace(/\.$/, '')} (${kills}-${deaths}).`
      };
    });

    const summary = say('pi-summary', `${seed}|${side}`, {
      name,
      side,
      rating: me.rating.toFixed(2),
      rounds: me.rounds,
      kd: me.kd.toFixed(2),
      kast: me.kast.toFixed(1),
      adr: Math.round(me.adr),
      team: Number.isFinite(teamRating) ? teamRating.toFixed(2) : '––'
    });

    // The conclusion for this side: where the rating comes from and where it goes.
    const topCats = mistakes.slice(0, 2).map((m) => say(`focus-${m.category}`, seed)).filter(Boolean);
    const concl = [];
    if (Number.isFinite(teamRating)) {
      concl.push(
        say(me.rating >= teamRating ? 'pi-above-team' : 'pi-below-team', `${seed}|${side}|team`, {
          name,
          side,
          map: mapName,
          gap: Math.abs(me.rating - teamRating).toFixed(2)
        })
      );
    }
    if (weakest.length) {
      concl.push(say('pi-weak-calls', `${seed}|${side}|weak`, { list: joinList(weakest.map((w) => w.label)) }));
    }
    if (strongest.length) {
      concl.push(say('pi-strong-calls', `${seed}|${side}|strong`, { list: joinList(strongest.map((w) => w.label)) }));
    }
    if (topCats.length) {
      concl.push(say('pi-focus', `${seed}|${side}|focus`, { focus: topCats.length > 1 ? `${topCats[0]}, as well as ${topCats[1]}` : topCats[0] }));
    }

    out.sides[side] = {
      summary,
      rating: me.rating,
      teamRating,
      own,
      faced,
      weakest,
      strongest,
      mistakes,
      impact,
      conclusion: paragraph(concl, ctx.names)
    };
  }
  return out;
}

export function buildPlayerInternalDocHtml(spec, esc) {
  const report = spec.report;
  const cats = new Set(spec.categories || []);
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const parts = [`<h1 style="font-size: 25px">${esc(`${report.name}: ${mapName}`.toUpperCase())}</h1>`];
  const who = [
    report.teamName ? esc(report.teamName) : '',
    report.roles?.T ? `T ${esc(report.roles.T)}` : '',
    report.roles?.CT ? `CT ${esc(report.roles.CT)}` : ''
  ].filter(Boolean);
  if (who.length) parts.push(`<p>${who.join(', ')}</p>`);
  const sideColor = { T: '#e06666', CT: '#5ea3f2' };
  const table = (title, side, rows) => {
    if (!rows.length) return '';
    const head = [title, report.name, 'Teammates', 'Rounds', 'WR'].map((h) => `<th>${colored(esc(h), sideColor[side])}</th>`).join('');
    const body = rows
      .map(
        (r) =>
          `<tr><td>${link(esc, esc(r.label), r.files)}</td><td>${rating(r.rating)}</td><td>${rating(r.team)}</td><td>${r.rounds}</td><td>${
            Number.isFinite(r.winrate) ? `${Math.round(r.winrate)}%` : '––'
          }</td></tr>`
      )
      .join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  };
  for (const side of ['T', 'CT']) {
    if (!cats.has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    const bag = report.sides[side];
    if (!bag) continue;
    parts.push(`<h1 style="font-size: 25px">${side} SIDE</h1>`);
    parts.push(`<p>${esc(bag.summary)}</p>`);
    if (cats.has('ratings')) {
      parts.push(`<h2 style="font-size: 19px">${side} RATINGS BY ROUND TYPE</h2>`);
      parts.push(table(`Own strategies ${side}`, side, bag.own));
      parts.push(table(side === 'T' ? 'Facing (x) setup' : 'Facing (x) round', side, bag.faced));
      if (bag.weakest.length) {
        parts.push(
          `<p><strong>Weakest:</strong><br>${bag.weakest
            .map((w) => link(esc, esc(`${w.label} (${w.rating.toFixed(2)} against the team's ${w.team.toFixed(2)})`), w.files))
            .join('<br>')}</p>`
        );
      }
      if (bag.strongest.length) {
        parts.push(
          `<p><strong>Strongest:</strong><br>${bag.strongest
            .map((w) => link(esc, esc(`${w.label} (${w.rating.toFixed(2)} against the team's ${w.team.toFixed(2)})`), w.files))
            .join('<br>')}</p>`
        );
      }
    }
    if (cats.has('mistakes') && bag.mistakes.length) {
      parts.push(`<h2 style="font-size: 19px">${side} MISTAKES</h2>`);
      parts.push(
        li(
          bag.mistakes.map(
            (m) =>
              `<strong>${esc(say(`cat-${m.category}`, m.category) || m.category)}</strong> ${link(esc, `x${m.count}`, m.files)}: ${esc(
                m.rules.map((r) => `${r.label} (${r.n})`).join(', ')
              )}`
          )
        )
      );
    }
    if (cats.has('impact') && bag.impact.length) {
      parts.push(`<h2 style="font-size: 19px">${side} ROUNDS WITHOUT IMPACT</h2>`);
      parts.push(li(bag.impact.map((r) => `${link(esc, `<strong>${esc(r.title)}:</strong>`, [r.file])} ${esc(r.note)}`)));
    }
  }
  if (cats.has('conclusion')) {
    const paras = ['T', 'CT']
      .filter((s) => cats.has(s === 'T' ? 'sideT' : 'sideCT') && report.sides[s]?.conclusion)
      .map((s) => `<p><strong>${s}:</strong> ${esc(report.sides[s].conclusion)}</p>`);
    if (paras.length) parts.push(`<h1 style="font-size: 25px">Conclusion</h1>${paras.join('')}`);
  }
  return parts.join('');
}

/** Every round file the player internal report may write about. */
export function playerCoachFiles(results) {
  return (results.extract?.rounds || []).filter((r) => r.ownEcon >= 4).map((r) => r.file);
}

