// ---------------------------------------------------------------------------
// replays/performance/mapRoundTables.js
// Performance > Maps: the pair of round-type tables for one map.
//
// T on the left, CT on the right, every call in the library a row whether or
// not this player has ever seen it. The two tables are padded to the same
// height, because a map where one side has 19 calls and the other has 8 still
// reads as one block.
//
// Hovering a call's name opens the only two things a reader wants next: the
// rounds we ran it, and the rounds we faced it, straight into the timeline.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { f2, pct, signed } from './performanceMath.js';

const EMPTY = '<span class="pf-empty">––</span>';
const fmtRating = (n) => (Number.isFinite(n) ? f2(n) : EMPTY);
const fmtSwing = (n) => (Number.isFinite(n) ? signed(n) : EMPTY);
const fmtWr = (n) => (Number.isFinite(n) ? pct(n) : EMPTY);

function ratingSortKey(row) {
  if (Number.isFinite(row?.ran?.rating)) return row.ran.rating;
  if (Number.isFinite(row?.faced?.rating)) return row.faced.rating;
  return -Infinity;
}

const PLAY_ICON =
  '<svg class="pf-rt-play" viewBox="0 -960 960 960" aria-hidden="true">' +
  '<path d="M364.31-279.08v-401.84L679.39-480 364.31-279.08Z" /></svg>';

/** A timeline link over round files, or '' when the bucket is empty. */
export function roundsHref(files) {
  const list = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
  if (!list.length) return '';
  return `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
}

/** One line of the hover menu: the lane, and a play button that loads it. */
function playOptionHtml(label, cell, esc) {
  const href = roundsHref(cell?.files);
  if (!href) return `<span class="pf-rt-go is-off">${label}${PLAY_ICON}</span>`;
  const count = cell.rounds === 1 ? '1 round' : `${cell.rounds} rounds`;
  return `<a class="pf-rt-go" href="${esc(href)}" target="_blank" rel="noopener noreferrer"
    title="${esc(`${label}: ${count}`)}">${label}${PLAY_ICON}</a>`;
}

function roundNameHtml(row, esc) {
  return `<span class="pf-rt" tabindex="0">
    <span class="pf-rt-text">${esc(row.label)}</span>
    <span class="pf-rt-menu">${playOptionHtml('Ran', row.ran, esc)}${playOptionHtml('Faced', row.faced, esc)}</span>
  </span>`;
}

/** Rating / swing / winrate for one lane. The round count rides on the tip. */
function laneCellsHtml(cell, split, esc) {
  const tip = cell.rounds ? `${cell.rounds} round${cell.rounds === 1 ? '' : 's'}` : '';
  const cls = [split ? 'pf-mt-split' : '', tip ? 'has-tip' : ''].filter(Boolean).join(' ');
  const attr = tip ? ` data-tip="${esc(tip)}"` : '';
  return `<td class="${cls}"${attr}>${fmtRating(cell.rating)}</td>
    <td>${fmtSwing(cell.swing)}</td>
    <td>${fmtWr(cell.winrate)}</td>`;
}

/**
 * One side of one map.
 *
 * @param {import('./mapRoundStats.js').RoundTypeRow[]} rows
 * @param {'T'|'CT'} side
 * @param {number} height  the taller of the pair, so both tables end level
 * @param {(s: string) => string} esc
 */
export function mapRoundTableHtml(rows, side, height, esc) {
  const isCt = side === 'CT';
  const sorted = [...(rows || [])].sort(
    (a, b) => ratingSortKey(b) - ratingSortKey(a) || String(a.label || '').localeCompare(String(b.label || ''))
  );
  const body = sorted
    .map(
      (r) => `<tr>
        <td class="left pf-mt-name">${roundNameHtml(r, esc)}</td>
        ${laneCellsHtml(r.ran, false, esc)}
        ${laneCellsHtml(r.faced, true, esc)}
      </tr>`
    )
    .join('');
  const pad = Math.max(0, height - sorted.length);
  const filler = Array.from({ length: pad })
    .map(
      () =>
        '<tr class="pf-mt-pad" aria-hidden="true"><td class="left pf-mt-name">&nbsp;</td>' +
        '<td></td><td></td><td></td><td class="pf-mt-split"></td><td></td><td></td></tr>'
    )
    .join('');
  return `<div class="pf-map-col">
    <table class="st-table pf-map-table">
      <colgroup><col class="pf-mt-col-name" /><col span="6" class="pf-mt-col-num" /></colgroup>
      <thead>
        <tr class="pf-mt-group">
          <th class="left pf-mt-side ${isCt ? 'is-ct' : 'is-t'}">${isCt ? 'CT' : 'T'}</th>
          <th colspan="3">Ran</th>
          <th class="pf-mt-split" colspan="3">Faced</th>
        </tr>
        <tr>
          <th class="left">Round</th>
          <th title="Rating">Rtg</th><th title="Swing">Swg</th><th title="Team winrate">WR</th>
          <th class="pf-mt-split" title="Rating">Rtg</th>
          <th title="Swing">Swg</th><th title="Team winrate">WR</th>
        </tr>
      </thead>
      <tbody>${body}${filler}</tbody>
    </table>
  </div>`;
}

/**
 * Every map's pair, in order.
 *
 * @param {Record<string, { T: Array, CT: Array }>} byMap  from mapRoundGrid
 * @param {string[]} codes
 * @param {(s: string) => string} esc
 */
export function mapRoundBlocksHtml(byMap, codes, esc) {
  const blocks = codes
    .map((code) => {
      const pair = byMap?.[code] || { T: [], CT: [] };
      const height = Math.max(pair.T.length, pair.CT.length);
      return `<section class="pf-map-block">
        <h3 class="pf-map-title">${esc(MAPS[code]?.name || code)}</h3>
        <div class="pf-map-pair">
          ${mapRoundTableHtml(pair.T, 'T', height, esc)}
          ${mapRoundTableHtml(pair.CT, 'CT', height, esc)}
        </div>
      </section>`;
    })
    .join('');
  return `<div class="pf-maps">${blocks}</div>`;
}
