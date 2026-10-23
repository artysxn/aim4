// ---------------------------------------------------------------------------
// site/stratbookCopy.js
// The stratbook as spreadsheet rows, for copying a map or the whole book at
// once and pasting it into Google Sheets or Excel.
//
// The shape is the one coaches already keep their books in: one row per
// strategy, one cell per player column. Tab-separated, and a cell holding a
// line break, a tab or a quote is quoted with its quotes doubled, which is how
// both spreadsheets read multi-line cells off the clipboard.
//
// Grenade links (<Window smoke><!ab12>) copy as their label: a sheet has no
// way to follow the id. DOM-free.
// ---------------------------------------------------------------------------

import { classifyTag } from './stratNoteLinks.js';

/** A note without its link markup: labels stay, archive ids go, a URL stays as text. */
export function notePlain(raw) {
  return String(raw || '')
    .replace(/<([^<>]+)>/g, (_, inner) => {
      const tag = classifyTag(inner);
      if (tag.kind === 'util') return '';
      // A URL right after its label reads "Guide https://…", not "Guidehttps://…".
      return tag.kind === 'url' ? ` ${tag.value}` : tag.value;
    })
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** One spreadsheet cell. */
export function tsvCell(text) {
  const s = String(text ?? '');
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells) => cells.map(tsvCell).join('\t');

/**
 * Rows for one map, T then CT, each side headed by its column titles.
 *
 * @param {object} args
 * @param {Array<object>} args.strategies   team.stratbook
 * @param {{ code: string, name: string }} args.map
 * @param {(side: 'T'|'CT', mapCode: string) => string[]} args.columns  role columns
 * @param {(side: 'T'|'CT', mapCode: string, position: string) => string} [args.columnTitle]
 * @param {(a: object, b: object, side: string) => number} [args.compare]  the page's own order
 * @returns {string[]} lines, empty when the map has no strategies
 */
export function mapRows({ strategies, map, columns, columnTitle = (s, m, p) => p, compare = () => 0 }) {
  const lines = [];
  for (const side of ['T', 'CT']) {
    const list = (strategies || []).filter((s) => s.map === map.code && s.side === side).sort((a, b) => compare(a, b, side));
    if (!list.length) continue;
    const roles = columns(side, map.code);
    if (lines.length) lines.push('');
    lines.push(row([`${map.name} ${side}`]));
    lines.push(row(['Name', 'Economy', 'Category', 'Description', ...roles.map((p) => columnTitle(side, map.code, p))]));
    for (const s of list) {
      const notes = roles.map((_, i) => notePlain(s.roleNotes?.[i] || ''));
      lines.push(row([s.name || '', s.economy || '', s.category || '', notePlain(s.description || ''), ...notes]));
    }
  }
  return lines;
}

/**
 * The whole stratbook, or the maps given, one block per map.
 *
 * @param {object} args  as mapRows, with `maps` in place of `map`
 * @returns {string}
 */
export function stratbookTsv({ maps, ...rest }) {
  const blocks = [];
  for (const map of maps) {
    const lines = mapRows({ ...rest, map });
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * One player's strategies: his note under each, map by map.
 *
 * @param {object} args
 * @param {Array<object>} args.strategies
 * @param {Array<{ code: string, name: string }>} args.maps
 * @param {(s: object) => string} args.noteOf   his note for a strategy
 * @param {(s: object) => boolean} [args.visible]
 * @param {(a: object, b: object, side: string) => number} [args.compare]
 */
export function playerStratsTsv({ strategies, maps, noteOf, visible = () => true, compare = () => 0 }) {
  const lines = [row(['Map', 'Side', 'Name', 'Economy', 'Category', 'Note'])];
  for (const map of maps) {
    for (const side of ['T', 'CT']) {
      const list = (strategies || [])
        .filter((s) => s.map === map.code && s.side === side && visible(s))
        .sort((a, b) => compare(a, b, side));
      for (const s of list) lines.push(row([map.name, side, s.name || '', s.economy || '', s.category || '', notePlain(noteOf(s))]));
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
