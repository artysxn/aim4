// ---------------------------------------------------------------------------
// Player scout: the category catalogue and the document renderer.
//
// Same contract as the team report (antistratConfig.js): categories map 1:1 to
// sections, and the renderer emits only what the documents sanitizer keeps —
// headings, lists, tables, same-origin links and inert widget divs.
//
// The document is split by side. T is a chapter and CT is a chapter, each
// carrying the same sections, because a player is two different players across
// the half and a report that averaged them would describe neither.
//
// Chapters are Title (h1, 25px), sections are Heading (h2, 19px) and one
// variation is a Subheading (h3). The documents outline jumps on the first two.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { roundTypeRows } from './roundLibrary.js';
import {
  OPENING_CLOCK,
  RECURRING_MIN_SHARE,
  TIMING_TOLERANCE_SECONDS
} from './playerScoutScan.js';

/** Below this many matches on a map the tool warns about reliability. */
export const PLAYER_MIN_MATCHES = 4;

/**
 * @typedef {object} PlayerCategory
 * @property {string} key   matches a section the renderer knows
 * @property {'General'|'Defaults'|'Non-defaults'} group
 * @property {string} label
 */

/** @type {PlayerCategory[]} */
export const PLAYER_CATEGORIES = [
  { key: 'overview', group: 'General', label: 'Rounds and buys' },
  { key: 'maps', group: 'General', label: 'Heatmap and grenades' },
  { key: 'defaultUtility', group: 'Defaults', label: 'Default utility' },
  { key: 'defaultMoves', group: 'Defaults', label: 'Default moves' },
  { key: 'defaultRound', group: 'Defaults', label: 'Default rounds, written out' },
  { key: 'callUtility', group: 'General', label: 'Utility on each call' },
  { key: 'variations', group: 'Non-defaults', label: 'Non-default rounds' },
  { key: 'teamContext', group: 'Non-defaults', label: 'What the team does on them' }
];

export const PLAYER_GROUPS = ['General', 'Defaults', 'Non-defaults'];

export function playerCategory(key) {
  return PLAYER_CATEGORIES.find((c) => c.key === key) || null;
}

/** Which rounds the notes pass has to read, and under what key they come back. */
export function defaultNoteKey(side, index) {
  return `default|${side}|${index}`;
}

export function variationNoteKey(side, index) {
  return `var|${side}|${index}`;
}

/**
 * Every round the report wants written out as a strategy.
 * @param {object} results  scan output
 */
export function notePicks(results) {
  const picks = [];
  for (const side of ['T', 'CT']) {
    const bag = results?.sides?.[side];
    if (!bag) continue;
    (bag.defaults?.patterns || []).forEach((d, i) => {
      if (d.example) picks.push({ key: defaultNoteKey(side, i), file: d.example, side });
    });
    (bag.variations || []).forEach((v, i) => {
      if (v.example) picks.push({ key: variationNoteKey(side, i), file: v.example, side });
    });
  }
  return picks;
}

/** "7.8.2026" from a ms timestamp. */
export function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Document renderer
// ---------------------------------------------------------------------------

const NONE = '<p>No matching rounds.</p>';
const LINK_FILES_MAX = 40;

const TITLE_STYLE = 'font-size: 25px';
const HEADING_STYLE = 'font-size: 19px';

const titleHtml = (html) => `<h1 style="${TITLE_STYLE}">${html}</h1>`;
const headingHtml = (html) => `<h2 style="${HEADING_STYLE}">${html}</h2>`;
const subheadHtml = (html) => `<h3>${html}</h3>`;

function li(items) {
  return items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
}

/** A table of already-escaped cells. */
function table(head, rows) {
  if (!rows.length) return '';
  const cells = (list, tag) => list.map((c) => `<${tag}>${c}</${tag}>`).join('');
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

/** An interactive widget node; docEmbeds.js mounts it when the doc renders. */
function embed(esc, kind, data) {
  return `<div data-kind="${esc(kind)}" data-embed="${esc(JSON.stringify(data))}"></div>`;
}

const NADE_KINDS = ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'];

function renderOverview(esc, bag, spec, side) {
  const role = spec.roles?.[side] || '';
  const rows = [
    `${link(esc, `${bag.rounds} rounds`, bag.files)} on ${esc(side)}, ${bag.winrate}% won`,
    `${bag.fullRounds} of them full buy vs full buy, which is what the sections below read`
  ];
  if (role) rows.unshift(`Role: ${esc(role)}`);
  if (bag.unread) {
    rows.push(`${bag.unread} rounds had nothing readable in the opening and are left out`);
  }
  const n = bag.defaults.patterns.length;
  rows.push(
    `${n} default${n === 1 ? '' : 's'}: ${link(esc, `${bag.defaults.count} rounds`, bag.defaults.files)} (${bag.defaults.share}%, ${bag.defaults.winrate}% won) against ${link(
      esc,
      `${bag.nonDefaults.count} non-default`,
      bag.nonDefaults.files
    )} (${bag.nonDefaults.share}%, ${bag.nonDefaults.winrate}% won)`
  );
  return li(rows);
}

function renderDefaultUtility(esc, bag) {
  if (!bag.utility.length) {
    return `<p>Nothing he throws lands in the same place at the same moment in more than ${Math.round(
      RECURRING_MIN_SHARE * 100
    )}% of these rounds.</p>`;
  }
  const rows = bag.utility.map((u) => [
    esc(u.label),
    esc(u.clock),
    `${u.share}%`,
    link(esc, String(u.rounds), u.files),
    u.spread ? `${esc(String(u.spread))}s` : '0s'
  ]);
  return table(['Utility', 'Usually at', 'Rate', 'Rounds', 'Spread'], rows);
}

function renderDefaultMoves(esc, bag) {
  if (!bag.moves.length) return `<p>No ground he takes at the same moment often enough.</p>`;
  const rows = bag.moves.map((m) => [
    esc(m.label),
    esc(m.clock),
    `${m.share}%`,
    link(esc, String(m.rounds), m.files),
    m.spread ? `${esc(String(m.spread))}s` : '0s'
  ]);
  return table(['Move', 'Usually at', 'Rate', 'Rounds', 'Spread'], rows);
}

/**
 * One round written the way the stratbook writes one.
 *
 * `note` arrives already escaped and already linked, because the grenade
 * anchors are built while the note is parsed. It is inserted, not escaped
 * again.
 */
function noteBlock(esc, who, note) {
  if (!note) return '';
  return `<p><strong>${esc(who)}</strong>: ${note}</p>`;
}

/** "goes A 80%, B 20%", when the rounds went anywhere in particular. */
function siteWords(site) {
  if (!site) return '';
  return `goes A ${site.a}%, B ${site.b}%`;
}

function groupHead(esc, g, name) {
  const words = [
    `${g.count} ${g.count === 1 ? 'round' : 'rounds'}`,
    `${g.share}% of his openings`,
    `${g.winrate}% won`,
    siteWords(g.site)
  ].filter(Boolean);
  const title = [name, g.label || 'Unnamed'].filter(Boolean).join(': ');
  return subheadHtml(`${link(esc, esc(title), g.files)}, ${esc(words.join(', '))}`);
}

/**
 * His defaults, each written out as a strategy.
 *
 * A side has more than one: a team runs an A default and a B default in
 * tandem, and both are his default.
 */
function renderDefaultRound(esc, bag, spec, side) {
  const patterns = bag.defaults.patterns || [];
  if (!patterns.length) {
    return `<p>No opening he runs in more than ${Math.round(
      RECURRING_MIN_SHARE * 100
    )}% of these rounds.</p>`;
  }
  const parts = [];
  patterns.forEach((d, i) => {
    const entry = spec.notes?.get?.(defaultNoteKey(side, i));
    parts.push(groupHead(esc, d, d.name));
    if (d.opponents?.length) parts.push(`<p>Against ${esc(d.opponents.join(', '))}.</p>`);
    if (entry?.self) parts.push(noteBlock(esc, spec.playerName, entry.self));
    else {
      parts.push(
        `<p>${link(esc, 'Watch the rounds', d.files)}. The example round could not be read back.</p>`
      );
    }
    if ((spec.categories || []).includes('callUtility')) {
      parts.push(utilityBlock(esc, d, spec, side));
    }
    if ((spec.categories || []).includes('teamContext')) {
      parts.push(teamBlock(esc, d, entry, spec, side));
    }
  });
  if (bag.defaults.hidden > 0) {
    parts.push(
      `<p>${bag.defaults.hidden} rarer ${
        bag.defaults.hidden === 1 ? 'default' : 'defaults'
      } are not written out.</p>`
    );
  }
  return parts.join('');
}

/**
 * What all five throw on one call.
 *
 * Grouped by body rather than by clock, because the question this answers is
 * "what does each of them do here". The scouted player comes first; the rest
 * follow in the order of how much utility the call asks of them.
 */
function utilityBlock(esc, group, spec, side) {
  const bag = group.utility;
  if (!bag?.rows?.length) return '';
  const order = new Map();
  for (const row of bag.rows) {
    order.set(row.player, Math.max(order.get(row.player) ?? 0, row.share));
  }
  const players = [...order.keys()].sort((a, b) => {
    if (a === spec.playerId) return -1;
    if (b === spec.playerId) return 1;
    return order.get(b) - order.get(a);
  });

  const rows = [];
  for (const id of players) {
    const who = spec.mates?.[id];
    const role = who?.[side] || '';
    const name = who?.name || (id === spec.playerId ? spec.playerName : id);
    const mine = bag.rows.filter((r) => r.player === id);
    mine.forEach((r, i) => {
      rows.push([
        i === 0 ? esc(role ? `${name} (${role})` : name) : '',
        esc(r.label),
        esc(r.clock),
        `${r.share}%`,
        link(esc, `${r.rounds} of ${group.count}`, r.files)
      ]);
    });
  }
  const cut = bag.hidden
    ? `<p>${bag.hidden} rarer ${bag.hidden === 1 ? 'throw' : 'throws'} are not listed.</p>`
    : '';
  return `${table(['Player', 'Utility', 'Usually at', 'Rate', 'Rounds'], rows)}${cut}`;
}

/** What the other four did in the same round, under the roles they play. */
function teamBlock(esc, group, entry, spec, side) {
  const labels = callLabels(spec.mapCode, side);
  const calls = group.teamCalls
    .map((c) => `${esc(labels.get(c.key) || c.key)} x${c.count}`)
    .join(', ');
  const parts = [
    `<p><strong>Team call</strong>: ${calls || 'nothing the round library names'}.</p>`
  ];
  for (const mate of entry?.mates || []) {
    const role = spec.mates?.[mate.id]?.[side] || '';
    parts.push(noteBlock(esc, role ? `${mate.name} (${role})` : mate.name, mate.note));
  }
  return parts.join('');
}

function callLabels(mapCode, side) {
  const map = new Map();
  for (const row of roundTypeRows(mapCode, side)) map.set(row.key, row.label);
  return map;
}

function renderVariations(esc, bag, spec, side) {
  if (!bag.variations.length && !bag.moreVariations.length) {
    return `<p>Every round he plays here is one of his defaults.</p>`;
  }
  const withTeam = (spec.categories || []).includes('teamContext');
  const withUtility = (spec.categories || []).includes('callUtility');
  const parts = [
    `<p>${link(esc, `${bag.nonDefaults.count} rounds`, bag.nonDefaults.files)} where his opening was not one of his defaults, grouped by what he did instead.</p>`
  ];
  bag.variations.forEach((v, i) => {
    const entry = spec.notes?.get?.(variationNoteKey(side, i));
    parts.push(groupHead(esc, v, ''));
    if (v.opponents.length) parts.push(`<p>Against ${esc(v.opponents.join(', '))}.</p>`);
    if (entry?.self) parts.push(noteBlock(esc, spec.playerName, entry.self));
    else {
      parts.push(
        `<p>${link(esc, 'Watch the rounds', v.files)}. The example round could not be read back.</p>`
      );
    }
    if (withUtility) parts.push(utilityBlock(esc, v, spec, side));
    if (withTeam) parts.push(teamBlock(esc, v, entry, spec, side));
  });
  if (bag.moreVariations.length) {
    // Not written out as strategies, but every one of them is still here with
    // its rounds behind the link.
    parts.push(subheadHtml('The rest'));
    parts.push(
      table(
        ['Opening', 'N', 'Win', 'Sites', 'Rounds'],
        bag.moreVariations.map((v) => [
          esc(v.label || 'Unnamed'),
          String(v.count),
          `${v.winrate}%`,
          esc(siteWords(v.site) || '—'),
          link(esc, 'watch', v.files)
        ])
      )
    );
  }
  return parts.join('');
}

function renderMaps(esc, bag, spec, side) {
  const parts = [];
  if (bag.heat?.length) {
    parts.push(
      embed(esc, 'heat', {
        map: spec.mapCode,
        title: `${spec.playerName}, ${side}`,
        points: bag.heat
      })
    );
  }
  if (bag.paths?.length) {
    parts.push(
      embed(esc, 'nade-paths', {
        map: spec.mapCode,
        title: `${spec.playerName}, ${side}, grenades`,
        kinds: NADE_KINDS,
        paths: bag.paths
      })
    );
  }
  return parts.length ? parts.join('') : NONE;
}

const RENDER = {
  overview: renderOverview,
  maps: renderMaps,
  defaultUtility: (esc, bag) => renderDefaultUtility(esc, bag),
  defaultMoves: (esc, bag) => renderDefaultMoves(esc, bag),
  defaultRound: renderDefaultRound,
  variations: renderVariations
};

/**
 * @param {{
 *   playerName: string,
 *   playerId?: string,
 *   teamName?: string,
 *   mapCode: string,
 *   roles?: { T?: string, CT?: string },
 *   mates?: Record<string, { name: string, T: string, CT: string }>,
 *   matches: Array<{ label: string }>,
 *   categories: string[],
 *   results: object,
 *   notes?: Map<string, { self: string, mates: Array }>,
 *   utilityNote?: string
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildPlayerDocHtml(spec, esc) {
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const parts = [];
  parts.push(titleHtml(`Player: ${esc(spec.playerName)} on ${esc(mapName)}`));
  const who = [
    spec.teamName ? esc(spec.teamName) : '',
    spec.roles?.T ? `T ${esc(spec.roles.T)}` : '',
    spec.roles?.CT ? `CT ${esc(spec.roles.CT)}` : ''
  ].filter(Boolean);
  if (who.length) parts.push(`<p>${who.join(', ')}</p>`);
  parts.push(`<p>${esc(spec.matches.map((m) => m.label).join(', '))}</p>`);

  const focus = (spec.results?.focusIds || []).join(',');
  const loadLink = (files, label, analyzer) => {
    const list = (files || []).slice(0, 120);
    if (!list.length) return '';
    let href = `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
    if (analyzer) {
      href += `&mode=analyzer${focus ? `&team=${encodeURIComponent(focus)}` : ''}&name=${encodeURIComponent(
        spec.playerName
      )}`;
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

  parts.push(
    `<p><em>Rounds are grouped by their opening, read from the start of the round to ${OPENING_CLOCK} and matched within ${TIMING_TOLERANCE_SECONDS}s. An opening he runs in over ${Math.round(
      RECURRING_MIN_SHARE * 100
    )}% of his full buy vs full buy rounds on that side is one of his defaults; a side usually has more than one. Every other opening is a variation.</em></p>`
  );
  if (spec.utilityNote) parts.push(`<p><em>${esc(spec.utilityNote)}</em></p>`);
  parts.push('<hr>');

  for (const side of ['T', 'CT']) {
    const bag = spec.results?.sides?.[side];
    parts.push(titleHtml(`${esc(side)} side`));
    if (!bag) {
      parts.push(NONE);
      continue;
    }
    for (const key of spec.categories) {
      const cat = playerCategory(key);
      const fn = RENDER[key];
      if (!cat || !fn) continue;
      parts.push(headingHtml(esc(cat.label)));
      parts.push(fn(esc, bag, spec, side));
    }
  }

  return parts.join('');
}
