// ---------------------------------------------------------------------------
// replays/performance/mapRoundTables.js
// Performance > Maps: the pair of round-type tables for one map.
//
// T on the left, CT on the right, every call in the library a row whether or
// not this player has ever seen it. The two tables are padded to the same
// height, because a map where one side has 19 calls and the other has 8 still
// reads as one block.
//
// One renderer, two column sets. A player's row answers "how did I play in
// these rounds" (rating, swing, opening duels, the team's winrate); a team's
// answers "what happened in them" (winrate, the opening duel, and the two
// man-advantage conversions). Everything else about the block — the Ran / Faced
// split, the padding, the hover menu into the timeline — is the same question
// asked of a different subject, so it is the same code.
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

/**
 * One player's four numbers over a bucket of rounds.
 *
 * Their own three first (rating, swing, opening duels), the team's last: WR is
 * the one column on the row that is not about the person reading it.
 */
export const PLAYER_COLS = [
  { key: 'rating', label: 'Rtg', title: 'Rating', fmt: fmtRating },
  { key: 'swing', label: 'Swg', title: 'Swing', fmt: fmtSwing },
  { key: 'opkRate', label: 'OPK', title: 'Opening duel win rate', fmt: fmtWr },
  { key: 'winrate', label: 'WR', title: 'Team winrate', fmt: fmtWr }
];

/** One team's four. Sorted by how often it runs the call, not by how well. */
export const TEAM_COLS = [
  { key: 'winrate', label: 'WR', title: 'Round win rate', fmt: fmtWr },
  { key: 'opkRate', label: 'OPK', title: 'Opening duel win rate', fmt: fmtWr },
  { key: '5v4', label: '5v4', title: 'Round win rate after the opening kill', fmt: fmtWr, read: (c) => c?.conv5v4 },
  { key: '4v5', label: '4v5', title: 'Round win rate after the opening death', fmt: fmtWr, read: (c) => c?.conv4v5 }
];

const readCell = (col, cell) => (col.read ? col.read(cell) : cell?.[col.key]);

/** Best rating on the row, so the calls a player is good at come first. */
function ratingSortKey(row) {
  if (Number.isFinite(row?.ran?.rating)) return row.ran.rating;
  if (Number.isFinite(row?.faced?.rating)) return row.faced.rating;
  return -Infinity;
}

const byLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''));

const PLAYER_TABLE = {
  cols: PLAYER_COLS,
  cmp: (a, b) => ratingSortKey(b) - ratingSortKey(a) || byLabel(a, b)
};

/**
 * A team's table leads with the calls it actually makes, not the ones it is
 * best at: "we run this 40 times and win 38% of them" is the finding, and it
 * only reads as one when the row is at the top.
 */
const TEAM_TABLE = {
  cols: TEAM_COLS,
  cmp: (a, b) =>
    (b.ran?.rounds || 0) - (a.ran?.rounds || 0) ||
    (b.faced?.rounds || 0) - (a.faced?.rounds || 0) ||
    byLabel(a, b)
};

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

/** One lane's numbers. The round count rides on the tip of the first cell. */
function laneCellsHtml(cell, cols, split, esc) {
  const tip = cell?.rounds ? `${cell.rounds} round${cell.rounds === 1 ? '' : 's'}` : '';
  const cls = [split ? 'pf-mt-split' : '', tip ? 'has-tip' : ''].filter(Boolean).join(' ');
  const attr = tip ? ` data-tip="${esc(tip)}"` : '';
  return cols
    .map((col, i) => {
      const value = col.fmt(readCell(col, cell));
      if (i === 0) return `<td class="${cls}"${attr}>${value}</td>`;
      return `<td>${value}</td>`;
    })
    .join('');
}

/**
 * One side of one map.
 *
 * @param {import('./mapRoundStats.js').RoundTypeRow[]} rows
 * @param {'T'|'CT'} side
 * @param {number} height  the taller of the pair, so both tables end level
 * @param {(s: string) => string} esc
 * @param {{ cols: object[], cmp: (a: object, b: object) => number }} [table]
 */
export function mapRoundTableHtml(rows, side, height, esc, table = PLAYER_TABLE) {
  const { cols, cmp } = table;
  const isCt = side === 'CT';
  const sorted = [...(rows || [])].sort(cmp);
  const body = sorted
    .map(
      (r) => `<tr>
        <td class="left pf-mt-name">${roundNameHtml(r, esc)}</td>
        ${laneCellsHtml(r.ran, cols, false, esc)}
        ${laneCellsHtml(r.faced, cols, true, esc)}
      </tr>`
    )
    .join('');
  const padCells = cols.map(() => '<td></td>').join('');
  const padFaced = cols
    .map((_, i) => (i === 0 ? '<td class="pf-mt-split"></td>' : '<td></td>'))
    .join('');
  const pad = Math.max(0, height - sorted.length);
  const filler = Array.from({ length: pad })
    .map(
      () =>
        '<tr class="pf-mt-pad" aria-hidden="true"><td class="left pf-mt-name">&nbsp;</td>' +
        padCells +
        padFaced +
        '</tr>'
    )
    .join('');
  const head = (lane) =>
    cols
      .map(
        (col, i) =>
          `<th${lane === 'faced' && i === 0 ? ' class="pf-mt-split"' : ''} title="${esc(col.title)}">${esc(col.label)}</th>`
      )
      .join('');
  return `<div class="pf-map-col">
    <table class="st-table pf-map-table">
      <colgroup><col class="pf-mt-col-name" /><col span="${cols.length * 2}" class="pf-mt-col-num" /></colgroup>
      <thead>
        <tr class="pf-mt-group">
          <th class="left pf-mt-side ${isCt ? 'is-ct' : 'is-t'}">${isCt ? 'CT' : 'T'}</th>
          <th colspan="${cols.length}">Ran</th>
          <th class="pf-mt-split" colspan="${cols.length}">Faced</th>
        </tr>
        <tr>
          <th class="left">Round</th>
          ${head('ran')}
          ${head('faced')}
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

/** The map's own record, on the title line. Empty when the map is unplayed. */
export function teamMapTotalHtml(total, esc) {
  if (!total?.rounds) return '';
  const cells = [
    { label: 'Rounds', value: String(total.rounds) },
    ...TEAM_COLS.map((col) => ({ label: col.label, value: fmtWr(readCell(col, total)) }))
  ];
  return `<div class="pf-map-sum">${cells
    .map(
      (c) =>
        `<span class="pf-map-sum-item"><b>${esc(c.value)}</b> ${esc(c.label)}</span>`
    )
    .join('')}</div>`;
}

/**
 * Every map's pair for a team, with the map's own record beside its name.
 *
 * @param {Record<string, { T: Array, CT: Array, total: object }>} byMap
 *   from teamMapRoundGrid
 * @param {string[]} codes
 * @param {(s: string) => string} esc
 */
export function teamMapRoundBlocksHtml(byMap, codes, esc) {
  const blocks = codes
    .map((code) => {
      const pair = byMap?.[code] || { T: [], CT: [], total: null };
      const height = Math.max(pair.T.length, pair.CT.length);
      return `<section class="pf-map-block">
        <div class="pf-map-head">
          <h3 class="pf-map-title">${esc(MAPS[code]?.name || code)}</h3>
          ${teamMapTotalHtml(pair.total, esc)}
        </div>
        <div class="pf-map-pair">
          ${mapRoundTableHtml(pair.T, 'T', height, esc, TEAM_TABLE)}
          ${mapRoundTableHtml(pair.CT, 'CT', height, esc, TEAM_TABLE)}
        </div>
      </section>`;
    })
    .join('');
  return `<div class="pf-maps">${blocks}</div>`;
}
