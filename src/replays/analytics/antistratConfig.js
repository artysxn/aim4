// ---------------------------------------------------------------------------
// Teams antistrat tool: the category catalogue and the document skeleton.
//
// Categories map 1:1 to sections of the generated team document. A category
// marked `wip: true` renders in the picker but stays disabled; its section
// spec is written down so wiring it later is filling in an analyzer, not
// designing a surface. The HTML builder emits only tags the docs editor's
// sanitizer keeps (see site/docsEditor.js ALLOWED), which rules out tables
// until the sanitizer learns them.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { FORMATIONS, PACE_TYPES } from './patternDefs.js';

/** Below this many matches on a map the tool warns about reliability. */
export const ANTISTRAT_MIN_MATCHES = 4;

export const ANTISTRAT_DETAIL = [
  { key: 'compact', label: 'Compact' },
  { key: 'detailed', label: 'Detailed' }
];

/**
 * @typedef {object} AntistratCategory
 * @property {string} key
 * @property {'General'|'T specific'|'CT specific'} group
 * @property {string} label
 * @property {string} desc   one line under the checkbox
 * @property {boolean} [wip] shown but not selectable yet
 */

/** @type {AntistratCategory[]} */
export const ANTISTRAT_CATEGORIES = [
  {
    key: 'pistols',
    group: 'General',
    label: 'Pistol rounds',
    desc: 'Formation, fake, pace and bombsite for every T pistol, CT formations by key zones.'
  },
  {
    key: 'positions',
    group: 'General',
    label: 'Positions on T and CT',
    desc: 'Most frequent players across recent matches and where they play.'
  },
  {
    key: 'pace',
    group: 'General',
    label: 'Pace on T',
    desc: 'Distribution of round pace across buy rounds.'
  },
  {
    key: 't-utility',
    group: 'T specific',
    label: 'T default utility',
    desc: 'Which smokes and molotovs are thrown by default, in what share of buy rounds, and when.'
  },
  {
    key: 't-formations',
    group: 'T specific',
    label: 'T formations in defaults',
    desc: 'WIP.',
    wip: true
  },
  {
    key: 't-defaults-vs-set',
    group: 'T specific',
    label: 'T defaults vs set calls percentage',
    desc: 'WIP.',
    wip: true
  },
  {
    key: 'ct-setups',
    group: 'CT specific',
    label: 'CT setups',
    desc: 'WIP.',
    wip: true
  }
];

export const ANTISTRAT_GROUPS = ['General', 'T specific', 'CT specific'];

export function antistratCategory(key) {
  return ANTISTRAT_CATEGORIES.find((c) => c.key === key) || null;
}

/**
 * @typedef {object} AntistratSpec
 * @property {string} teamName   the scouted team
 * @property {string} mapCode
 * @property {Array<{ id: string, label: string }>} matches  included matches
 * @property {string[]} categories  selected category keys
 * @property {Record<string, 'compact'|'detailed'>} detail  per-category level
 * @property {number} generatedAt  ms epoch
 */

/** esc must be the caller's HTML escaper; this module stays DOM-free. */
function section(esc, cat, detail, bodyHtml) {
  const level = detail === 'detailed' ? 'Detailed' : 'Compact';
  return `<h2>${esc(cat.label)}</h2><p><i>${esc(level)}</i></p>${bodyHtml}`;
}

/**
 * The generated document's HTML. Groundwork: every selected category gets its
 * section with the structure the analyzer will fill; until an analyzer lands
 * the body says so instead of pretending.
 *
 * @param {AntistratSpec} spec
 * @param {(s: string) => string} esc
 */
export function buildAntistratDocHtml(spec, esc) {
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const snapshot = FORMATIONS[spec.mapCode]?.snapshot || '';
  const parts = [];

  parts.push(`<h1>Antistrat: ${esc(spec.teamName)} on ${esc(mapName)}</h1>`);
  parts.push(
    `<p>${esc(String(spec.matches.length))} ${spec.matches.length === 1 ? 'match' : 'matches'} included${
      snapshot ? `, defaults read at ${esc(snapshot)}` : ''
    }.</p>`
  );
  parts.push(`<ul>${spec.matches.map((m) => `<li>${esc(m.label)}</li>`).join('')}</ul>`);
  parts.push('<hr>');

  for (const key of spec.categories) {
    const cat = antistratCategory(key);
    if (!cat || cat.wip) continue;
    const level = spec.detail?.[key] === 'detailed' ? 'detailed' : 'compact';
    parts.push(section(esc, cat, level, sectionBody(key, esc)));
  }

  return parts.join('');
}

/** Per-category skeleton bodies. Analyzers replace these pending notes. */
function sectionBody(key, esc) {
  switch (key) {
    case 'pistols':
      return (
        `<p><strong>T pistols</strong></p>` +
        `<p>${esc('Format: formation, fake if any, pace, bombsite. Example: 3-0-2 Fake A, Pop B.')}</p>` +
        `<p>${esc('Analysis pending.')}</p>` +
        `<p><strong>CT pistols</strong></p>` +
        `<p>${esc('Players counted in the key zones of each bombsite.')}</p>` +
        `<p>${esc('Analysis pending.')}</p>`
      );
    case 'positions':
      return `<p>${esc('Most frequent players in the last 75% of matches, with their T and CT positions.')}</p><p>${esc('Analysis pending.')}</p>`;
    case 'pace':
      return (
        `<p>${esc('Share of buy rounds per pace:')} ${esc(
          PACE_TYPES.map((p) => p.label).join(', ')
        )}.</p>` + `<p>${esc('Analysis pending.')}</p>`
      );
    case 't-utility':
      return `<p>${esc('Smokes and molotovs thrown by default, share of buy rounds, and early-round timing.')}</p><p>${esc('Analysis pending.')}</p>`;
    default:
      return `<p>${esc('Analysis pending.')}</p>`;
  }
}
