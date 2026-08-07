// ---------------------------------------------------------------------------
// Teams antistrat: the category catalogue and the document renderer.
//
// Categories map 1:1 to sections of the generated team document and to the
// aggregators in antistratScan.js. The renderer emits only tags the docs
// editor's sanitizer keeps (site/docsEditor.js ALLOWED), plus data-URI images
// for the heatmap. No prose beyond the numbers.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { PACE_TYPES, paceType } from './patternDefs.js';

/** Below this many matches on a map the tool warns about reliability. */
export const ANTISTRAT_MIN_MATCHES = 4;

/**
 * @typedef {object} AntistratCategory
 * @property {string} key    matches a key under scan results `sections`
 * @property {'General'|'T specific'|'CT specific'} group
 * @property {string} label
 * @property {boolean} [wip] shown but not selectable yet
 */

/** @type {AntistratCategory[]} */
export const ANTISTRAT_CATEGORIES = [
  { key: 'pistols', group: 'General', label: 'Pistol rounds' },
  { key: 'positions', group: 'General', label: 'Positions on T and CT' },
  { key: 'pace', group: 'General', label: 'Pace on T' },
  { key: 'utility', group: 'General', label: 'Default utility' },
  { key: 'fiveVfour', group: 'General', label: '5v4s' },
  { key: 'fourVfive', group: 'General', label: '4v5s' },
  { key: 'force', group: 'General', label: 'Force buys' },
  { key: 'firstEngagement', group: 'General', label: 'First engagement timing' },
  { key: 'patterns', group: 'General', label: 'Patterns' },
  { key: 'afterplants', group: 'T specific', label: 'Afterplants' },
  { key: 'tEarly', group: 'T specific', label: 'Early rounds' },
  { key: 'tMid', group: 'T specific', label: 'Midrounds' },
  { key: 'tLate', group: 'T specific', label: 'Laterounds' },
  { key: 'tFormations', group: 'T specific', label: 'T formations in defaults', wip: true },
  { key: 'retakes', group: 'CT specific', label: 'Retakes and retake winrates' }
];

export const ANTISTRAT_GROUPS = ['General', 'T specific', 'CT specific'];

export function antistratCategory(key) {
  return ANTISTRAT_CATEGORIES.find((c) => c.key === key) || null;
}

// ---------------------------------------------------------------------------
// Document renderer
// ---------------------------------------------------------------------------

/** "7.8.2026" from a ms timestamp. */
export function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

const NONE = '<p>No matching rounds.</p>';

function li(items) {
  return items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
}

function topLine(esc, top) {
  return top
    .map((t) => `${esc(t.name)} ${t.share !== undefined ? `${t.share}%` : `x${t.count}`}${t.clock ? ` at ${esc(t.clock)}` : ''}`)
    .join(', ');
}

function renderUtility(esc, s) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const bag = s.sides[side];
    if (!bag) continue;
    parts.push(`<p><strong>${side}, full buy vs full buy</strong> (${bag.rounds} rounds)</p>`);
    const rows = [];
    for (const kind of Object.values(bag.kinds)) {
      const top = kind.top.length ? topLine(esc, kind.top) : 'none matched';
      rows.push(`<strong>${esc(kind.label)}</strong> avg ${kind.avgPerRound}/round: ${top}`);
    }
    parts.push(li(rows));
  }
  return parts.length ? parts.join('') : NONE;
}

function renderAdvantage(esc, s) {
  if (!s.rounds) return NONE;
  const rows = [];
  if (s.site) rows.push(`Preferred bombsite: ${s.site.a}% A, ${s.site.b}% B (${s.site.basis} rounds)`);
  if (s.tempoSeconds !== null) rows.push(`Core forms ${s.tempoSeconds}s after the opening kill`);
  if (s.newGround !== null) rows.push(`New ground entered in the next ${s.window}s: ${s.newGround} positions`);
  if (s.avgDistance !== null) rows.push(`Average player spacing at the kill: ${s.avgDistance} units`);
  if (s.addedDistance !== null) {
    rows.push(`Spacing ${s.addedDistance >= 0 ? 'grows' : 'shrinks'} by ${Math.abs(s.addedDistance)} units over ${s.window}s`);
  }
  if (s.towardA !== null) rows.push(`Toward A after ${s.window}s: ${s.towardA} players`);
  if (s.towardB !== null) rows.push(`Toward B after ${s.window}s: ${s.towardB} players`);
  return `<p>${s.rounds} rounds</p>${li(rows)}`;
}

function renderForce(esc, s) {
  const rows = [];
  if (s.T) {
    const site = s.T.site ? `${s.T.site.a}% A, ${s.T.site.b}% B` : 'no site read';
    rows.push(`<strong>T</strong> (${s.T.rounds} rounds): ${site}${s.T.medianClock ? `, median commit at ${esc(s.T.medianClock)}` : ''}`);
  }
  if (s.CT) {
    rows.push(`<strong>CT</strong> (${s.CT.rounds} rounds): leans A ${s.CT.leanA}%, B ${s.CT.leanB}%${s.CT.medianClock ? `, first fight at ${esc(s.CT.medianClock)}` : ''}`);
  }
  return rows.length ? li(rows) : NONE;
}

function renderFirstEngagement(esc, s, heatmap) {
  if (!s.rounds) return NONE;
  const rows = [
    `Median first kill at ${esc(s.medianClock)}${s.avgClock ? `, average ${esc(s.avgClock)}` : ''}`,
    `They take the opening in ${s.wonShare}% of rounds`
  ];
  if (s.killers.length) {
    rows.push(`Openers: ${s.killers.map((k) => `${esc(k.name)} x${k.count}`).join(', ')}`);
  }
  if (s.zones.length) {
    rows.push(`Where: ${s.zones.map((z) => `${esc(z.name)} x${z.count}`).join(', ')}`);
  }
  const img = heatmap ? `<p><img src="${heatmap}" alt="First engagements"></p>` : '';
  return `${li(rows)}${img}`;
}

function roundRefs(esc, refs, limit = 12) {
  const shown = refs.slice(0, limit).map((r) => `R${r.round}`);
  const more = refs.length > limit ? ` +${refs.length - limit} more` : '';
  return shown.length ? ` (${shown.join(', ')}${esc(more)})` : '';
}

function renderPatterns(esc, s) {
  const rows = [];
  rows.push(`4+ players toward B early: ${s.bStack.share}% of T rounds${roundRefs(esc, s.bStack.rounds)}`);
  rows.push(`4+ players toward A early: ${s.aStack.share}% of T rounds${roundRefs(esc, s.aStack.rounds)}`);
  rows.push(
    `Defaults ${s.compare.defaults.count} rounds at ${s.compare.defaults.winrate}% winrate vs set calls ${s.compare.setCalls.count} rounds at ${s.compare.setCalls.winrate}%`
  );
  rows.push(`2v2+ fights before 1:35: ${s.earlyFights.share}% of rounds${roundRefs(esc, s.earlyFights.rounds)}`);
  const spots = s.ctSpots.length ? s.ctSpots : [];
  if (spots.length) {
    rows.push(
      `CT spot repeats (50%+ of full buys): ${spots
        .map((p) => `${esc(p.name)} in ${esc(p.spot)} ${p.share}%`)
        .join(', ')}`
    );
  }
  return li(rows);
}

function renderPostplant(esc, s, word) {
  const rows = [];
  for (const site of ['a', 'b']) {
    const bag = s[site];
    if (!bag) continue;
    const top = bag.top.map((t) => `${esc(t.name)} x${t.count}`).join(', ');
    rows.push(
      `<strong>${site.toUpperCase()} ${word}</strong> (${bag.rounds} rounds): ${bag.avgZones !== null ? `${bag.avgZones} zones held, ` : ''}${top || 'no zone data'}`
    );
  }
  return rows.length ? li(rows) : NONE;
}

function renderRetakes(esc, s) {
  const rows = [];
  for (const site of ['a', 'b']) {
    const w = s.winrates[site];
    if (!w) continue;
    const top = w.top.map((t) => `${esc(t.name)} x${t.count}`).join(', ');
    rows.push(
      `<strong>${site.toUpperCase()} retakes, full buy</strong> (${w.rounds} rounds): ${w.winrate}% won${top ? `, from ${top}` : ''}`
    );
  }
  const zones = renderPostplant(esc, s.zones, 'retake zones');
  return `${rows.length ? li(rows) : NONE}${zones === NONE ? '' : zones}`;
}

function renderPhase(esc, s) {
  if (!s.basis) return NONE;
  const rows = [
    `Utility thrown and the core follows it: ${s.utilPush} of ${s.basis} rounds`,
    `No utility and the core still moves up: ${s.dryPush} of ${s.basis} rounds`
  ];
  if (s.avgCoreSize !== null) {
    rows.push(`Fighting core: ${s.avgCoreSize} players${s.avgCoreDistance !== null ? `, ${s.avgCoreDistance} units apart` : ''}`);
  }
  return li(rows);
}

function renderPace(esc, s) {
  if (!s.basis) return NONE;
  const order = [...PACE_TYPES.map((p) => p.key), 'other'];
  const rows = s.dist
    .sort((a, b) => order.indexOf(a.pace) - order.indexOf(b.pace))
    .map((d) => `${esc(paceType(d.pace)?.label || 'Other')}: ${d.share}% (${d.count})`);
  return `<p>${s.basis} T buy rounds</p>${li(rows)}`;
}

function renderPistols(esc, s) {
  const parts = [];
  if (s.t.length) {
    parts.push('<p><strong>T pistols</strong></p>');
    parts.push(
      li(
        s.t.map((r) => {
          const bits = [r.formation, paceType(r.pace)?.label || '', r.site].filter(Boolean);
          return `R${r.round}: ${esc(bits.join(', ') || 'no read')}${r.won ? ' (won)' : ''}`;
        })
      )
    );
  }
  if (s.ct.length) {
    parts.push('<p><strong>CT pistols</strong></p>');
    parts.push(
      li(
        s.ct.map(
          (r) => `R${r.round}: A ${r.a} - ee ${r.ee} - B ${r.b}${r.won ? ' (won)' : ''}`
        )
      )
    );
  }
  return parts.length ? parts.join('') : NONE;
}

function renderPositions(esc, s) {
  if (!s.length) return NONE;
  return li(
    s.map(
      (p) =>
        `<strong>${esc(p.name)}</strong>: T ${esc(p.t || 'unknown')}, CT ${esc(p.ct || 'unknown')} (${p.matches} matches)`
    )
  );
}

/**
 * @param {{
 *   teamName: string,
 *   mapCode: string,
 *   matches: Array<{ label: string }>,
 *   categories: string[],
 *   results: object,
 *   heatmap?: string
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildAntistratDocHtml(spec, esc) {
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const parts = [];
  parts.push(`<h1>Antistrat: ${esc(spec.teamName)} on ${esc(mapName)}</h1>`);
  parts.push(`<p>${esc(spec.matches.map((m) => m.label).join(', '))}</p>`);
  parts.push('<hr>');

  const sections = spec.results?.sections || {};
  const render = {
    pistols: (s) => renderPistols(esc, s),
    positions: (s) => renderPositions(esc, s),
    pace: (s) => renderPace(esc, s),
    utility: (s) => renderUtility(esc, s),
    fiveVfour: (s) => renderAdvantage(esc, s),
    fourVfive: (s) => renderAdvantage(esc, s),
    force: (s) => renderForce(esc, s),
    firstEngagement: (s) => renderFirstEngagement(esc, s, spec.heatmap || ''),
    patterns: (s) => renderPatterns(esc, s),
    afterplants: (s) => renderPostplant(esc, s, 'afterplants'),
    retakes: (s) => renderRetakes(esc, s),
    tEarly: (s) => renderPhase(esc, s),
    tMid: (s) => renderPhase(esc, s),
    tLate: (s) => renderPhase(esc, s)
  };

  for (const key of spec.categories) {
    const cat = antistratCategory(key);
    if (!cat || cat.wip || !render[key]) continue;
    const data = sections[key];
    parts.push(`<h2>${esc(cat.label)}</h2>`);
    parts.push(data ? render[key](data) : NONE);
  }

  return parts.join('');
}
