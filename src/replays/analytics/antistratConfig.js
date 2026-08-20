// ---------------------------------------------------------------------------
// Teams antistrat: the category catalogue and the document renderer.
//
// Categories map 1:1 to sections of the generated team document and to the
// aggregators in antistratScan.js. The renderer emits only tags the docs
// editor's sanitizer keeps: numbers, tables,
// round links (/demos?rounds=…) and inert widget divs, which docEmbeds.js
// mounts on load. No pictures, and no prose beyond the data.
//
// Chapters are Title (h1, 25px). Subchapters are Heading (h2, 19px). The
// documents outline jumps on those two types.
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
  { key: 'tells', group: 'General', label: 'Biggest tells' },
  { key: 'responses', group: 'General', label: 'Responses to their calls' },
  { key: 'fiveVfour', group: 'General', label: '5v4s' },
  { key: 'fourVfive', group: 'General', label: '4v5s' },
  { key: 'force', group: 'General', label: 'Force buys' },
  { key: 'antiBuy', group: 'General', label: 'Anti-eco and anti-force' },
  { key: 'buyContext', group: 'General', label: 'First gun round and forced buys' },
  { key: 'firstEngagement', group: 'General', label: 'First engagement timing' },
  { key: 'patterns', group: 'General', label: 'Patterns' },
  { key: 'openings', group: 'General', label: 'Openings' },
  { key: 'players', group: 'General', label: 'Per player' },
  { key: 'tRoundList', group: 'T specific', label: 'T Round list' },
  { key: 'setCalls', group: 'T specific', label: 'Set calls' },
  { key: 'tFormations', group: 'T specific', label: 'T formations in defaults' },
  { key: 'afterplants', group: 'T specific', label: 'Afterplants' },
  { key: 'tEarly', group: 'T specific', label: 'Early rounds' },
  { key: 'tMid', group: 'T specific', label: 'Midrounds' },
  { key: 'tLate', group: 'T specific', label: 'Laterounds' },
  { key: 'ctRoundList', group: 'CT specific', label: 'CT Round list' },
  { key: 'ctSites', group: 'CT specific', label: 'Winrate vs site hits' },
  { key: 'ctSpread', group: 'CT specific', label: 'Players on A and B over time' },
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

/** Docs editor Title / Heading sizes, so the outline can jump to them. */
const TITLE_STYLE = 'font-size: 25px';
const HEADING_STYLE = 'font-size: 19px';

function titleHtml(html) {
  return `<h1 style="${TITLE_STYLE}">${html}</h1>`;
}

function headingHtml(html) {
  return `<h2 style="${HEADING_STYLE}">${html}</h2>`;
}

function subheadHtml(html) {
  return `<h3>${html}</h3>`;
}

function li(items) {
  return items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
}

/**
 * A table of already-escaped cells. Head cells are strings, body rows arrays
 * of the same length. The sanitizer keeps these tags and drops every
 * attribute, so styling lives on `.doc-surface table`.
 */
function table(head, rows) {
  if (!rows.length) return '';
  const cells = (list, tag) => list.map((c) => `<${tag}>${c}</${tag}>`).join('');
  // No whitespace between the table tags: a stray text node inside a table is
  // foster-parented out by the HTML parser and lands above it.
  const body = rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('');
  return `<table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Wrap a label in a timeline link over the given round files. */
function link(esc, label, files) {
  const list = (files || []).filter(Boolean).slice(0, LINK_FILES_MAX);
  if (!list.length) return label;
  const href = `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
  return `<a href="${esc(href)}">${label}</a>`;
}

/** Grenade kinds, in the order the scan packs them. */
const NADE_KINDS = ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'];

const NADE_WORD = {
  smokegrenade: 'smoke',
  molotov: 'molotov',
  flashbang: 'flash',
  hegrenade: 'HE'
};

function renderPistols(esc, s) {
  const parts = [];
  if (s.t.length) {
    parts.push(headingHtml('T pistols'));
    parts.push(
      li(
        s.t.map((r) => {
          const call = [r.formation, [paceType(r.pace)?.label, r.site].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', ');
          const util = [];
          if (r.smokes.length) util.push(`${r.smokes.join(' & ')} smoke`);
          if (r.molotovs.length) util.push(`${r.molotovs.join(' and ')} molotov`);
          // "Showed A, went B" is the read a coach wants off a pistol.
          const turn = r.turnaround ? `, showed ${esc(r.shown)} and went ${esc(r.site)}` : '';
          const line = `${call || 'no read'}${util.length ? ` with ${util.join(', ')}` : ''}`;
          return `${link(esc, `vs ${esc(r.opponent)}`, [r.file])}: ${esc(line)}${turn}${r.won ? ' (won)' : ''}`;
        })
      )
    );
    const turn = s.turnaround;
    if (turn) {
      parts.push(
        `<p>Turnaround: ${link(esc, `${turn.turned} of ${turn.rounds}`, turn.files)} pistols show one site and take the other (${turn.share}%), winning ${turn.winrate}% of them against ${turn.heldWinrate}% when the early read holds.</p>`
      );
    }
  }
  if (s.ct.length) {
    const order = s.ctOrder?.length ? s.ctOrder : ['A', 'ee', 'B'];
    parts.push(headingHtml(`CT pistols (${esc(order.join(' - '))})`));
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
      headingHtml(
        `${side}, full buy vs full buy (${link(esc, `${bag.rounds} rounds`, bag.files)})`
      )
    );
    parts.push(
      `<p>Average per round: smokes ${bag.avg.smokegrenade}, molotovs ${bag.avg.molotov}, flashes ${bag.avg.flashbang}, HE ${bag.avg.hegrenade}.</p>`
    );
    if (bag.live) {
      parts.push(embed(esc, 'util-map', { map: mapCode, side, live: bag.live }));
    }
  }
  return parts.length ? parts.join('') : NONE;
}

/**
 * Utility that gives the round away: one grenade, one call, almost every time.
 *
 * The round column links the rounds behind the call, the total column links
 * every round the grenade appeared in, so a row can be checked both ways.
 */
function renderTells(esc, s) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const bag = s.sides?.[side];
    if (!bag?.tells.length) continue;
    const rows = bag.tells.map((t) => [
      `${esc(t.name)} ${esc(NADE_WORD[t.type] || '')}`,
      esc(t.label),
      `${t.share}%`,
      link(esc, `${t.hits} of ${t.rounds}`, t.hitFiles),
      link(esc, String(t.rounds), t.files),
      esc(t.others.map((o) => `${o.label} ${o.rounds}`).join(', ') || '—')
    ]);
    parts.push(headingHtml(side));
    parts.push(table(['Utility', 'Call', 'Rate', 'Rounds', 'Thrown', 'Otherwise'], rows));
  }
  if (!parts.length) {
    return `<p>No utility in ${s?.minRounds ?? 5}+ rounds reaches ${s?.minShare ?? 80}%.</p>`;
  }
  return parts.join('');
}

/**
 * Calls made in answer to the other side's.
 *
 * One row per call of theirs, under the call of ours it triggered, so the
 * table reads the way it gets used in a timeout: "when they do this, we do
 * that, and here is how it has gone".
 */
function renderResponses(esc, s) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const bag = s?.[side];
    if (!bag?.calls.length) continue;
    const rows = bag.calls.flatMap((call) =>
      call.to.map((reply, i) => [
        i === 0 ? `${esc(call.label)} (${call.rounds})` : '',
        esc(reply.label),
        `${reply.share}%`,
        link(esc, `${reply.rounds} of ${call.rounds}`, reply.files),
        reply.winrate === null ? '—' : `${reply.winrate}%`
      ])
    );
    parts.push(headingHtml(side));
    parts.push(
      `<p>Answering something ${bag.other} did ${bag.lead}s+ earlier, in ${bag.minShare}%+ of those rounds and at least ${bag.minRounds} times</p>`
    );
    parts.push(table(['When they', 'We answer', 'Rate', 'Rounds', 'Win'], rows));
  }
  return parts.length ? parts.join('') : NONE;
}

/**
 * Anti-eco and anti-force, split by what the OTHER side had.
 *
 * The winrate is the point of the section: the shape of the round only matters
 * once you know whether it is working.
 */
function renderAntiBuy(esc, s) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const buckets = s?.sides?.[side];
    if (!buckets?.length) continue;
    const rows = buckets.map((b) => {
      const shape =
        side === 'T'
          ? [b.formation, b.site ? `${b.site.a}% A, ${b.site.b}% B` : '']
              .filter(Boolean)
              .join(', ')
          : b.lean
            ? `leans A ${b.lean.a}%, B ${b.lean.b}%`
            : '';
      return [
        esc(b.label),
        link(esc, String(b.rounds), b.files),
        `${b.winrate}%`,
        esc(b.medianClock || '—'),
        esc(shape || '—'),
        b.calls.length
          ? b.calls
              .map((c) => `${link(esc, esc(c.label), c.files)} ${c.rounds} (${c.winrate}%)`)
              .join(', ')
          : '—'
      ];
    });
    parts.push(headingHtml(side));
    parts.push(
      table(
        ['Round', 'N', 'Win', side === 'T' ? 'Commit' : 'First fight', 'Shape', 'Calls'],
        rows
      )
    );
  }
  return parts.length ? parts.join('') : NONE;
}

/**
 * The three rounds of a half whose buy is decided for you: the first gun
 * round, the force after a lost pistol, and the force after losing to one.
 */
function renderBuyContext(esc, s) {
  const parts = [];
  for (const side of ['T', 'CT']) {
    const buckets = s?.sides?.[side];
    if (!buckets?.length) continue;
    const rows = buckets.map((b) => [
      esc(b.label),
      link(esc, String(b.rounds), b.files),
      `${b.winrate}%`,
      `${b.setShare}%`,
      `${b.defaultShare}%`,
      b.calls.length
        ? b.calls
            .map((c) => `${link(esc, esc(c.label), c.files)} ${c.rounds} (${c.winrate}%)`)
            .join(', ')
        : '—'
    ]);
    parts.push(headingHtml(side));
    parts.push(table(['Round', 'N', 'Win', 'Set call', 'Default', 'Calls'], rows));
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
  return `${headingHtml(`${label} (${link(esc, `${s.rounds} rounds`, s.files)})`)}${li(rows)}${chart}`;
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

function renderFirstEngagement(esc, s, mapCode) {
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
    const map = bag.heat?.length
      ? embed(esc, 'heat', {
          map: mapCode,
          title: `First engagements, ${side}`,
          points: bag.heat
        })
      : '';
    parts.push(headingHtml(`${side} (${bag.rounds} rounds)`));
    parts.push(`${li(rows)}${map}`);
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
      headingHtml(`${esc(head)} (${link(esc, `${bag.rounds} rounds`, bag.files)})`)
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

function renderPostplant(esc, s, word, mapCode) {
  const rows = [];
  const maps = [];
  for (const site of ['a', 'b']) {
    const bag = s[site];
    if (!bag) continue;
    const top = bag.top.map((t) => `${esc(t.name)} ${t.share}%`).join(', ');
    rows.push(
      `<strong>${link(esc, `${site.toUpperCase()} ${word}`, bag.files)}</strong> (${bag.rounds} rounds): ${bag.avgZones !== null ? `${bag.avgZones} zones held, ` : ''}${top || 'no zone data'}`
    );
    // One map per site rather than a grid, so each carries its own sliders.
    if (bag.heat?.length) {
      maps.push(
        embed(esc, 'heat', {
          map: mapCode,
          title: `${site.toUpperCase()} ${word}`,
          // Read on the bomb rather than the round clock.
          span: bag.span || { from: -5, to: 40 },
          points: bag.heat
        })
      );
    }
  }
  return rows.length ? `${li(rows)}${maps.join('')}` : NONE;
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

function renderRetakes(esc, s, mapCode) {
  const rows = [];
  for (const site of ['a', 'b']) {
    const w = s.winrates[site];
    if (!w) continue;
    const top = w.top.map((t) => `${esc(t.name)} ${t.share}%`).join(', ');
    rows.push(
      `<strong>${link(esc, `${site.toUpperCase()} retakes, full buy`, w.files)}</strong> (${w.rounds} rounds): ${w.winrate}% won${top ? `, from ${top}` : ''}`
    );
  }
  const zones = renderPostplant(esc, s.zones, 'retake zones', mapCode);
  return `${rows.length ? li(rows) : NONE}${zones === NONE ? '' : zones}`;
}

/**
 * One side's round library: every named round type, run and faced.
 *
 * Two lines per type, because that is the whole point of the section. "Ran it"
 * is the scouted team playing that side; "faced it" is the same call arriving
 * from the other end while they defended it. Timings are averages of the
 * moments that made the round match, written on the round clock.
 */

/**
 * One side's round library as a table.
 *
 * Two columns per call rather than two bullet lists: running it and facing it
 * are the same question asked from both ends, and reading them side by side is
 * the only way to see that they hold a call better than they run it. Timings
 * go in their own column instead of trailing the sentence.
 */
function renderRoundList(esc, s, teamName) {
  if (!s || !s.types.length) return NONE;
  const own = s.side === 'T' ? 'T' : 'CT';
  const other = s.side === 'T' ? 'CT' : 'T';
  const named = (n) => (Number.isFinite(n) ? `, ${n} named` : '');

  const cell = (bag) => {
    if (!bag.rounds) return '—';
    return `${link(esc, `${bag.winrate}%`, bag.files)} <small>${bag.wins}W ${bag.losses}L of ${bag.rounds}</small>`;
  };
  const marks = (bag) =>
    bag.marks.length
      ? bag.marks
          .slice(0, 3)
          .map((m) => `${esc(m.name)} ${esc(m.clock)}`)
          .join(', ')
      : '—';

  const rows = s.types.map((t) => [
    esc(t.label),
    t.for.when ? esc(t.for.when.clock) : '—',
    cell(t.for),
    t.for.rounds ? `${t.for.share}%` : '—',
    cell(t.against),
    marks(t.for.rounds ? t.for : t.against)
  ]);

  return `<p>${esc(teamName)} on ${esc(own)}: ${s.ownRounds} rounds${named(s.ownNamed)}. Facing the same calls on ${esc(other)}: ${s.facedRounds} rounds${named(s.facedNamed)}.</p>${table(
    ['Call', 'When', `Ran it (${own})`, 'Use', `Faced it (${other})`, 'Timings'],
    rows
  )}`;
}

/** What the library could not read on this map, when anything is missing. */
function renderRoundLibraryNote(esc, readiness) {
  if (!readiness) return '';
  const bits = [];
  if (readiness.missingRegions.length) {
    bits.push(`Unpainted ground: ${readiness.missingRegions.map(esc).join(', ')}`);
  }
  if (readiness.missingUtility.length) {
    bits.push(`Unnamed utility spots: ${readiness.missingUtility.map(esc).join(', ')}`);
  }
  if (readiness.untagged) {
    bits.push(`${readiness.untagged} rounds have no tags yet`);
  }
  if (!bits.length) return '';
  return `<p><em>Round types built on these cannot fire: ${bits.join('. ')}.</em></p>`;
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
  return `${headingHtml(label)}${li(rows)}`;
}

function renderPhase(esc, s) {
  const html = renderPhaseSide(esc, s.T, 'T') + renderPhaseSide(esc, s.CT, 'CT');
  return html || NONE;
}

function renderPlayers(esc, s, mapCode) {
  if (!s.length) return NONE;
  const parts = [];
  for (const p of s) {
    parts.push(headingHtml(esc(p.name)));
    parts.push(`<p>T: ${esc(p.tRole || 'unknown')}, CT: ${esc(p.ctRole || 'unknown')}</p>`);
    for (const side of ['T', 'CT']) {
      const bag = p.sides[side];
      if (!bag) continue;
      parts.push(
        subheadHtml(
          `${side} side (${bag.rounds} rounds, ${bag.fullRounds ?? bag.rounds} full buys)`
        )
      );
      if (bag.heat?.length) {
        parts.push(
          embed(esc, 'heat', {
            map: mapCode,
            title: `${p.name}, ${side}`,
            points: bag.heat
          })
        );
      }
      // The AWPer gets a second map over the rounds he actually held it: where
      // a player stands with the AWP is a different answer from where he
      // stands, and averaging the two hides both.
      if (bag.awp?.heat?.length) {
        parts.push(
          embed(esc, 'heat', {
            map: mapCode,
            title: `${p.name}, ${side}, AWP rounds (${bag.awp.rounds})`,
            points: bag.awp.heat
          })
        );
      }
      if (bag.paths?.length) {
        parts.push(
          embed(esc, 'nade-paths', {
            map: mapCode,
            title: `${p.name}, ${side}, grenades`,
            kinds: NADE_KINDS,
            paths: bag.paths
          })
        );
      }
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
 *   results: object
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildAntistratDocHtml(spec, esc) {
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const parts = [];
  parts.push(titleHtml(`Antistrat: ${esc(spec.teamName)} on ${esc(mapName)}`));
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
    tells: (s) => renderTells(esc, s),
    responses: (s) => renderResponses(esc, s),
    fiveVfour: (s) => renderAdvantage(esc, s),
    fourVfive: (s) => renderAdvantage(esc, s),
    force: (s) => renderForce(esc, s),
    antiBuy: (s) => renderAntiBuy(esc, s),
    buyContext: (s) => renderBuyContext(esc, s),
    firstEngagement: (s) => renderFirstEngagement(esc, s, spec.mapCode),
    patterns: (s) => renderPatterns(esc, s),
    openings: (s) => renderOpenings(esc, s),
    tRoundList: (s) =>
      renderRoundList(esc, s, spec.teamName) + renderRoundLibraryNote(esc, spec.results?.roundLibrary),
    ctRoundList: (s) =>
      renderRoundList(esc, s, spec.teamName) + renderRoundLibraryNote(esc, spec.results?.roundLibrary),
    setCalls: (s) => renderSetCalls(esc, s),
    players: (s) => renderPlayers(esc, s, spec.mapCode),
    tFormations: (s) => renderTFormations(esc, s),
    afterplants: (s) => renderPostplant(esc, s, 'afterplants', spec.mapCode),
    ctSites: (s) => renderCtSites(esc, s),
    ctSpread: (s) => embed(esc, 'ct-spread', s),
    retakes: (s) => renderRetakes(esc, s, spec.mapCode),
    tEarly: (s) => renderPhase(esc, s),
    tMid: (s) => renderPhase(esc, s),
    tLate: (s) => renderPhase(esc, s)
  };

  for (const key of spec.categories) {
    const cat = antistratCategory(key);
    if (!cat || !render[key]) continue;
    const data = sections[key];
    parts.push(titleHtml(esc(cat.label)));
    parts.push(data ? render[key](data) : NONE);
  }

  return parts.join('');
}
