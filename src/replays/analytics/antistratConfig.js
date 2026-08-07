// ---------------------------------------------------------------------------
// Teams antistrat: the category catalogue and the document renderer.
//
// Categories map 1:1 to sections of the generated team document and to the
// aggregators in antistratScan.js. The renderer emits only tags the docs
// editor's sanitizer keeps: numbers, round links (/demos?rounds=…) and
// data-URI images. No prose beyond the data.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { paceType } from './patternDefs.js';

/** Below this many matches on a map the tool warns about reliability. */
export const ANTISTRAT_MIN_MATCHES = 4;

/**
 * @typedef {object} AntistratCategory
 * @property {string} key    matches a key under scan results `sections`
 * @property {'General'|'T specific'|'CT specific'} group
 * @property {string} label
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
  { key: 'openings', group: 'General', label: 'Openings' },
  { key: 'players', group: 'General', label: 'Per player' },
  { key: 'setCalls', group: 'T specific', label: 'Set calls' },
  { key: 'tFormations', group: 'T specific', label: 'T formations in defaults' },
  { key: 'afterplants', group: 'T specific', label: 'Afterplants' },
  { key: 'tEarly', group: 'T specific', label: 'Early rounds' },
  { key: 'tMid', group: 'T specific', label: 'Midrounds' },
  { key: 'tLate', group: 'T specific', label: 'Laterounds' },
  { key: 'ctSites', group: 'CT specific', label: 'Winrate vs site hits' },
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
const LINK_FILES_MAX = 40;

function li(items) {
  return items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
}

/** Wrap a label in a timeline link over the given round files. */
function link(esc, label, files) {
  const list = (files || []).filter(Boolean).slice(0, LINK_FILES_MAX);
  if (!list.length) return label;
  const href = `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
  return `<a href="${esc(href)}">${label}</a>`;
}

const NADE_WORD = {
  smokegrenade: 'smoke',
  molotov: 'molotov',
  flashbang: 'flash',
  hegrenade: 'HE'
};

function renderPistols(esc, s) {
  const parts = [];
  if (s.t.length) {
    parts.push('<p><strong>T pistols</strong></p>');
    parts.push(
      li(
        s.t.map((r) => {
          const call = [r.formation, [paceType(r.pace)?.label, r.site].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', ');
          const util = [];
          if (r.smokes.length) util.push(`${r.smokes.join(' & ')} smoke`);
          if (r.molotovs.length) util.push(`${r.molotovs.join(' and ')} molotov`);
          const line = `${call || 'no read'}${util.length ? ` with ${util.join(', ')}` : ''}`;
          return `${link(esc, `vs ${esc(r.opponent)}`, [r.file])}: ${esc(line)}${r.won ? ' (won)' : ''}`;
        })
      )
    );
  }
  if (s.ct.length) {
    const order = s.ctOrder?.length ? s.ctOrder : ['A', 'ee', 'B'];
    parts.push(`<p><strong>CT pistols</strong> (${esc(order.join(' - '))})</p>`);
    parts.push(
      li(
        s.ct.map((r) => {
          const counts = order
            .map((slot) => (slot === 'A' ? r.a : slot === 'B' ? r.b : r.ee))
            .join('-');
          return `${link(esc, `vs ${esc(r.opponent)}`, [r.file])}: ${esc(counts)}${r.won ? ' (won)' : ''}`;
        })
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
        `<strong>${esc(p.name)}</strong>: T ${esc(p.tRole || 'unknown')}, CT ${esc(
          p.ctRole || 'unknown'
        )} (${p.matches} ${p.matches === 1 ? 'match' : 'matches'})`
    )
  );
}

function renderPace(esc, s) {
  if (!s.basis) return NONE;
  return `<p>${s.basis} T buy rounds</p>${li(
    s.rows.map((d) => {
      const label = paceType(d.pace)?.label || 'Other';
      const sites =
        d.siteA || d.siteB ? `, ${d.siteB} towards B, ${d.siteA} towards A` : '';
      return `${link(esc, esc(label), d.files)}: ${d.share}% (${d.count}${esc(sites)})`;
    })
  )}`;
}

const PHASE_LABEL = { early: 'Early round', mid: 'Midround', late: 'Late round' };

/** An interactive widget node; docEmbeds.js mounts it when the doc renders. */
function embed(esc, kind, data) {
  return `<div data-kind="${esc(kind)}" data-embed="${esc(JSON.stringify(data))}"></div>`;
}

function renderUtility(esc, s, mapCode) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const bag = s.sides[side];
    if (!bag) continue;
    parts.push(
      `<p><strong>${side}, full buy vs full buy</strong> (${link(esc, `${bag.rounds} rounds`, bag.files)})</p>`
    );
    parts.push(
      `<p>Average per round: smokes ${bag.avg.smokegrenade}, molotovs ${bag.avg.molotov}, flashes ${bag.avg.flashbang}, HE ${bag.avg.hegrenade}.</p>`
    );
    if (bag.items?.length) {
      parts.push(embed(esc, 'util-map', { map: mapCode, side, items: bag.items }));
    }
  }
  return parts.length ? parts.join('') : NONE;
}

function renderAdvantageSide(esc, s, label) {
  if (!s || !s.rounds) return '';
  const rows = [];
  if (s.site) rows.push(`Preferred bombsite: ${s.site.a}% A, ${s.site.b}% B (${s.site.basis} rounds)`);
  if (s.tempoSeconds !== null && s.tempoSeconds !== undefined) {
    rows.push(`Core forms ${s.tempoSeconds}s after the opening kill`);
  }
  for (const letter of ['a', 'b']) {
    const sc = s.siteCore?.[letter];
    if (sc) {
      rows.push(
        `Towards ${letter.toUpperCase()}: core on site after avg ${sc.seconds}s (${sc.rounds} rounds)`
      );
    }
  }
  if (s.newGround !== null && s.newGround !== undefined) {
    rows.push(`New ground entered in the next ${s.window}s: ${s.newGround} positions`);
  }
  if (s.avgDistance !== null && s.avgDistance !== undefined) {
    rows.push(`Average player spacing at the kill: ${s.avgDistance} units`);
  }
  const chart = s.spacing?.n
    ? embed(esc, 'spacing', {
        title: `Avg spacing after the opening kill, ${label} (${s.spacing.n} rounds)`,
        avg: s.spacing.avg,
        kills: s.spacing.kills,
        deaths: s.spacing.deaths,
        rounds: s.spacing.rounds
      })
    : '';
  return `<p><strong>${label}</strong> (${link(esc, `${s.rounds} rounds`, s.files)})</p>${li(rows)}${chart}`;
}

function renderAdvantage(esc, s) {
  const html = renderAdvantageSide(esc, s.T, 'T') + renderAdvantageSide(esc, s.CT, 'CT');
  return html || NONE;
}

function renderForce(esc, s) {
  const rows = [];
  if (s.T) {
    const site = s.T.site ? `${s.T.site.a}% A, ${s.T.site.b}% B` : 'no site read';
    rows.push(
      `<strong>${link(esc, 'T', s.T.files)}</strong> (${s.T.rounds} rounds): ${esc(site)}${s.T.medianClock ? `, median commit at ${esc(s.T.medianClock)}` : ''}`
    );
  }
  if (s.CT) {
    rows.push(
      `<strong>${link(esc, 'CT', s.CT.files)}</strong> (${s.CT.rounds} rounds): leans A ${s.CT.leanA}%, B ${s.CT.leanB}%${s.CT.medianClock ? `, first fight at ${esc(s.CT.medianClock)}` : ''}`
    );
  }
  return rows.length ? li(rows) : NONE;
}

function renderFirstEngagement(esc, s, heatmaps) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const bag = s[side];
    if (!bag) continue;
    const rows = [
      `Median first kill at ${esc(bag.medianClock)}${bag.avgClock ? `, average ${esc(bag.avgClock)}` : ''}`,
      `They take the opening in ${bag.wonShare}% of rounds`
    ];
    for (const k of bag.killers) {
      const zones = k.zones
        .map((z) => `${esc(z.name)} x${z.count}${z.clock ? ` usually ${esc(z.clock)}` : ''}`)
        .join(', ');
      rows.push(`${esc(k.name)} x${k.count}${zones ? ` (${zones})` : ''}`);
    }
    const img = heatmaps?.[side]
      ? `<p><img src="${heatmaps[side]}" alt="First engagements ${side}"></p>`
      : '';
    parts.push(`<p><strong>${side}</strong> (${bag.rounds} rounds)</p>${li(rows)}${img}`);
  }
  return parts.length ? parts.join('') : NONE;
}

function renderPatterns(esc, s) {
  const rows = [];
  rows.push(
    `${link(esc, '4+ players toward B early', s.bStack.files)}: ${s.bStack.share}% of T rounds (${s.bStack.count})`
  );
  rows.push(
    `${link(esc, '4+ players toward A early', s.aStack.files)}: ${s.aStack.share}% of T rounds (${s.aStack.count})`
  );
  rows.push(
    `${link(esc, 'Defaults', s.compare.defaults.files)} ${s.compare.defaults.count} rounds at ${s.compare.defaults.winrate}% winrate vs ${link(esc, 'set calls', s.compare.setCalls.files)} ${s.compare.setCalls.count} rounds at ${s.compare.setCalls.winrate}%`
  );
  rows.push(
    `${link(esc, '2v2+ fights before 1:35', s.earlyFights.files)}: ${s.earlyFights.share}% of rounds (${s.earlyFights.count})`
  );
  if (s.ctSpots.length) {
    rows.push(
      `CT spot repeats (50%+ of full buys): ${s.ctSpots
        .map((p) => `${esc(p.name)} in ${esc(p.spot)} ${p.share}%`)
        .join(', ')}`
    );
  }
  return li(rows);
}

function renderOpenings(esc, s) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const bag = s[side];
    if (!bag) continue;
    const head = side === 'CT' ? 'CT, AWP openings' : side;
    parts.push(
      `<p><strong>${esc(head)}</strong> (${link(esc, `${bag.rounds} rounds`, bag.files)})</p>`
    );
    parts.push(
      li(
        bag.groups.map((g) => {
          const from = g.from ? ` on ${esc(g.from)}` : '';
          const to = g.to ? ` on ${esc(g.to)}` : '';
          const label = `${g.count}x ${esc(g.weapon)}${from} kills enemy${to}${g.clocks ? ` at ${esc(g.clocks)}` : ''}`;
          return link(esc, label, g.files);
        })
      )
    );
  }
  return parts.length ? parts.join('') : NONE;
}

function renderSetCalls(esc, s) {
  if (!s.rounds || !s.groups.length) return NONE;
  return `<p>${link(esc, `${s.rounds} non-default rounds`, s.files)}</p>${li(
    s.groups.map((g) => {
      const call = [g.site, paceType(g.pace)?.label || 'Other'].filter(Boolean).join(' ');
      const util = g.util.length
        ? ` with ${g.util.map((u) => `${esc(u.name)} ${NADE_WORD[u.type] || ''}`.trim()).join(', ')}`
        : '';
      const spread = g.spread ? `. ${esc(g.spread)}` : '';
      const kills = g.clocks ? `, first kill ${esc(g.clocks)}` : '';
      return link(esc, `${g.count}x ${esc(call)}${util}${spread}${kills}`, g.files);
    })
  )}`;
}

function renderTFormations(esc, s) {
  if (!s.basis || !s.rows.length) return NONE;
  return `<p>${link(esc, `${s.basis} default rounds`, s.files)}</p>${li(
    s.rows.map((r) => `${link(esc, esc(r.formation), r.files)}: ${r.count} rounds (${r.share}%)`)
  )}`;
}

function renderPostplant(esc, s, word, heatmap = '') {
  const rows = [];
  for (const site of ['a', 'b']) {
    const bag = s[site];
    if (!bag) continue;
    const top = bag.top.map((t) => `${esc(t.name)} ${t.share}%`).join(', ');
    rows.push(
      `<strong>${link(esc, `${site.toUpperCase()} ${word}`, bag.files)}</strong> (${bag.rounds} rounds): ${bag.avgZones !== null ? `${bag.avgZones} zones held, ` : ''}${top || 'no zone data'}`
    );
  }
  const img = heatmap ? `<p><img src="${heatmap}" alt="Postplant positions"></p>` : '';
  return rows.length ? `${li(rows)}${img}` : NONE;
}

function renderCtSites(esc, s) {
  if (!s.rounds) return NONE;
  const rows = [];
  for (const site of ['a', 'b']) {
    const bag = s.sites[site];
    if (!bag) continue;
    const planted = bag.plantedRounds
      ? `, ${bag.plantedWinrate}% once it was planted (${bag.plantedRounds})`
      : '';
    rows.push(
      `${link(esc, `vs ${site.toUpperCase()} hits`, bag.files)}: ${bag.winrate}% won (${bag.rounds} rounds, ${bag.share}% of full buys)${esc(planted)}`
    );
  }
  if (s.unresolved) rows.push(`${s.unresolved} rounds with no readable site`);
  return `<p>${s.rounds} full buy vs full buy CT rounds</p>${li(rows)}`;
}

function renderRetakes(esc, s) {
  const rows = [];
  for (const site of ['a', 'b']) {
    const w = s.winrates[site];
    if (!w) continue;
    const top = w.top.map((t) => `${esc(t.name)} ${t.share}%`).join(', ');
    rows.push(
      `<strong>${link(esc, `${site.toUpperCase()} retakes, full buy`, w.files)}</strong> (${w.rounds} rounds): ${w.winrate}% won${top ? `, from ${top}` : ''}`
    );
  }
  const zones = renderPostplant(esc, s.zones, 'retake zones');
  return `${rows.length ? li(rows) : NONE}${zones === NONE ? '' : zones}`;
}

function renderPhaseSide(esc, s, label) {
  if (!s || !s.basis) return '';
  const rows = [
    `Utility thrown and the core follows it: ${s.utilPush} of ${s.basis} rounds`,
    `No utility and the core still moves up: ${s.dryPush} of ${s.basis} rounds`
  ];
  if (s.avgCoreSize !== null) {
    rows.push(
      `Fighting core: ${s.avgCoreSize} players${s.avgCoreDistance !== null ? `, ${s.avgCoreDistance} units apart` : ''}`
    );
  }
  if (s.util) {
    rows.push(
      `Utility per round: smokes ${s.util.smokes}, molotovs ${s.util.molotovs}, flashes ${s.util.flashes}, HE ${s.util.he}`
    );
  }
  if (s.killsFor !== null) {
    rows.push(`Kills ${s.killsFor} for, ${s.killsAgainst} against per round`);
  }
  if (s.ground.length) {
    rows.push(`Ground held: ${s.ground.map((g) => `${esc(g.name)} ${g.share}%`).join(', ')}`);
  }
  return `<p><strong>${label}</strong></p>${li(rows)}`;
}

function renderPhase(esc, s) {
  const html = renderPhaseSide(esc, s.T, 'T') + renderPhaseSide(esc, s.CT, 'CT');
  return html || NONE;
}

function renderPlayers(esc, s, images) {
  if (!s.length) return NONE;
  const parts = [];
  for (const p of s) {
    parts.push(`<h3>${esc(p.name)}</h3>`);
    parts.push(`<p>T: ${esc(p.tRole || 'unknown')}, CT: ${esc(p.ctRole || 'unknown')}</p>`);
    for (const side of ['T', 'CT']) {
      const bag = p.sides[side];
      if (!bag) continue;
      parts.push(`<p><strong>${side} side</strong> (${bag.rounds} full buys)</p>`);
      const img = images?.heat?.[p.name]?.[side];
      if (img) parts.push(`<p><img src="${img}" alt="${esc(p.name)} ${side} heatmap"></p>`);
      const nades = images?.nades?.[p.name]?.[side];
      if (nades) parts.push(`<p><img src="${nades}" alt="${esc(p.name)} ${side} utility"></p>`);
      const rows = [];
      for (const phase of ['early', 'mid', 'late']) {
        const spots = bag.phases[phase]?.spots || [];
        if (spots.length) {
          rows.push(
            `${PHASE_LABEL[phase]}: ${spots.map((z) => `${esc(z.name)} ${z.share}%`).join(', ')}`
          );
        }
      }
      if (bag.utility.length) {
        rows.push(
          `Default utility: ${bag.utility
            .map(
              (u) =>
                `Throws ${esc(u.name)} ${NADE_WORD[u.type] || ''} (${u.share}%${u.clock ? `, usually ${esc(u.clock)}` : ''})`
            )
            .join('. ')}.`
        );
      }
      if (rows.length) parts.push(li(rows));
    }
  }
  return parts.join('');
}

/**
 * @param {{
 *   teamName: string,
 *   mapCode: string,
 *   matches: Array<{ label: string }>,
 *   categories: string[],
 *   results: object,
 *   images?: {
 *     firstEngagement?: { T?: string, CT?: string },
 *     afterplants?: string,
 *     players?: {
 *       heat?: Record<string, { T?: string, CT?: string }>,
 *       nades?: Record<string, { T?: string, CT?: string }>
 *     }
 *   }
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildAntistratDocHtml(spec, esc) {
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const images = spec.images || {};
  const parts = [];
  parts.push(`<h1>Antistrat: ${esc(spec.teamName)} on ${esc(mapName)}</h1>`);
  parts.push(`<p>${esc(spec.matches.map((m) => m.label).join(', '))}</p>`);

  // One-click loads of every full buy per side, into the timeline or the
  // macro analyzer (the analyzer link carries the scouted team as focus).
  const focus = (spec.results?.focusIds || []).join(',');
  const loadLink = (files, label, analyzer) => {
    const list = (files || []).slice(0, 120);
    if (!list.length) return '';
    let href = `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
    if (analyzer) {
      href += `&mode=analyzer${focus ? `&team=${encodeURIComponent(focus)}` : ''}&name=${encodeURIComponent(spec.teamName)}`;
    }
    return `<a href="${esc(href)}"><strong>${esc(label)}</strong></a>`;
  };
  const loads = [
    loadLink(spec.results?.tFullBuy, 'View T rounds', false),
    loadLink(spec.results?.ctFullBuy, 'View CT rounds', false),
    loadLink(spec.results?.tFullBuy, 'Analyze T rounds', true),
    loadLink(spec.results?.ctFullBuy, 'Analyze CT rounds', true)
  ].filter(Boolean);
  if (loads.length) parts.push(`<p>${loads.join(' · ')}</p>`);
  parts.push('<hr>');

  const sections = spec.results?.sections || {};
  const render = {
    pistols: (s) => renderPistols(esc, s),
    positions: (s) => renderPositions(esc, s),
    pace: (s) => renderPace(esc, s),
    utility: (s) => renderUtility(esc, s, spec.mapCode),
    fiveVfour: (s) => renderAdvantage(esc, s),
    fourVfive: (s) => renderAdvantage(esc, s),
    force: (s) => renderForce(esc, s),
    firstEngagement: (s) => renderFirstEngagement(esc, s, images.firstEngagement),
    patterns: (s) => renderPatterns(esc, s),
    openings: (s) => renderOpenings(esc, s),
    setCalls: (s) => renderSetCalls(esc, s),
    players: (s) => renderPlayers(esc, s, images.players),
    tFormations: (s) => renderTFormations(esc, s),
    afterplants: (s) => renderPostplant(esc, s, 'afterplants', images.afterplants),
    ctSites: (s) => renderCtSites(esc, s),
    retakes: (s) => renderRetakes(esc, s),
    tEarly: (s) => renderPhase(esc, s),
    tMid: (s) => renderPhase(esc, s),
    tLate: (s) => renderPhase(esc, s)
  };

  for (const key of spec.categories) {
    const cat = antistratCategory(key);
    if (!cat || !render[key]) continue;
    const data = sections[key];
    parts.push(`<h2>${esc(cat.label)}</h2>`);
    parts.push(data ? render[key](data) : NONE);
  }

  return parts.join('');
}
