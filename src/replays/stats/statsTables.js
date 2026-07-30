// ---------------------------------------------------------------------------
// replays/stats/statsTables.js
// Rendering for the two stats tables, plus the hover breakdowns.
//
// Kept apart from any one screen because three surfaces show the same numbers:
// the Statistics page, the per-demo view opened from a match row, and the live
// scoreboard inside the viewer.
// ---------------------------------------------------------------------------

import { roleHowText } from '../roles/regionKeys.js';
import { MAP_CONTROL_BASE } from '../coach/mapControlBases.js';
import { relativePossession } from '../coach/mapControlAdvantage.js';

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const int = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
const signed = (n) =>
  Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}` : '—';

/** Accuracy is blank rather than 0% when the demo predates hit counts. */
const accCell = (p) => (p.shots > 0 ? pct(p.accuracy) : '—');

const tip = (lines) => lines.filter(Boolean).join('\n');

/** Columns of the player table, in order. `get` returns the sort value. */
export const PLAYER_COLUMNS = [
  { key: 'name', label: 'Player', align: 'left', get: (p) => p.name.toLowerCase(), cell: null },
  {
    key: 'team',
    label: 'Team',
    align: 'left',
    get: (p) => (p.teamLabel || '').toLowerCase(),
    cell: (p) => p.teamLabel || '—',
    em: (p) => (p.teams?.length || 0) > 1,
    tip: (p) => {
      const teams = p.teams || [];
      if (!teams.length) return '';
      return tip(
        teams.map((t) => `${t.name}: ${t.rounds} round${t.rounds === 1 ? '' : 's'}`)
      );
    }
  },
  { key: 'rounds', label: 'Rds', get: (p) => p.rounds, cell: (p) => int(p.rounds) },
  {
    key: 'kd',
    label: 'K/D',
    get: (p) => p.kd,
    cell: (p) => f2(p.kd),
    tip: (p) => tip([`Kills: ${p.kills}`, `Assists: ${p.assists}`, `Deaths: ${p.deaths}`])
  },
  {
    key: 'adr',
    label: 'ADR',
    get: (p) => p.adr,
    cell: (p) => f1(p.adr),
    tip: (p) =>
      tip([
        `ADR in rounds won: ${f1(p.adrWon)}`,
        `ADR in rounds lost: ${f1(p.adrLost)}`,
        `Total damage: ${int(p.damage)}`
      ])
  },
  {
    key: 'accuracy',
    label: 'Acc%',
    get: (p) => (p.shots > 0 ? p.accuracy : -1),
    cell: accCell,
    tip: (p) =>
      p.shots > 0
        ? tip([
            `Shots fired: ${p.shots}`,
            `Shots hit: ${p.hits}`,
            `Headshots hit: ${p.headshots}`,
            `AWP shots fired: ${p.awpShots}`,
            `AWP shots hit: ${p.awpHits}`,
            `AWP hit rate: ${p.awpShots > 0 ? pct(p.awpAccuracy) : '—'}`,
            `AWP Acc: holds within 10° of an enemy with a clear (no smoke) path`
          ])
        : 'No hit data. Re-parse this demo to record accuracy.'
  },
  {
    key: 'rating',
    label: 'Rating',
    get: (p) => p.rating,
    cell: (p) => f2(p.rating),
    strong: true,
    tip: (p) =>
      tip([
        `Rating: ${f2(p.rating)}`,
        `On T: ${f2(p.ratingT)}`,
        `On CT: ${f2(p.ratingCT)}`,
        `In rounds won: ${f2(p.ratingWon)}`,
        `In rounds lost: ${f2(p.ratingLost)}`
      ])
  },
  {
    key: 'prwSwing',
    label: 'Swing',
    get: (p) => (Number.isFinite(p.prwSwing) ? p.prwSwing : -Infinity),
    cell: (p) => signed(p.prwSwing),
    tip: (p) =>
      Number.isFinite(p.prwSwing)
        ? tip([
            `Avg PRW swing / round: ${signed(p.prwSwing)}`,
            `Total swing: ${signed(p.prwSwingTotal)}`,
            `Rounds with swing data: ${p.prwSwingRounds || 0}`,
            `Kills / deaths / damage that move predicted win%`
          ])
        : 'No PRW swing data. Stats index will rebuild on next library load.'
  },
  {
    key: 'opkd',
    label: 'OPKD',
    get: (p) => p.opkd,
    cell: (p) => f2(p.opkd),
    tip: (p) => tip([`Opening kills: ${p.openKills}`, `Opening deaths: ${p.openDeaths}`])
  },
  { key: 'kast', label: 'KAST', get: (p) => p.kast, cell: (p) => pct(p.kast) },
  { key: 'impact', label: 'Impact', get: (p) => p.impact, cell: (p) => f2(p.impact) }
];

/**
 * Player columns with T (yellow) / CT (blue) role or position after the name.
 * @param {'position'|'tactical'|''} roleMode
 */
export function playerColumnsWithRoles(roleMode = 'tactical') {
  const tLabel = roleMode === 'position' ? 'T pos' : 'T role';
  const ctLabel = roleMode === 'position' ? 'CT pos' : 'CT role';
  const tGet = (p) =>
    (roleMode === 'position' ? p.posT || p.roleT : p.roleT || '') || '';
  const ctGet = (p) =>
    (roleMode === 'position' ? p.posCT || p.roleCT : p.roleCT || '') || '';
  const roleTip = (side, p) => {
    const label = side === 'T' ? tGet(p) : ctGet(p);
    if (!label) return '';
    const how = roleHowText(side, label, roleMode);
    const tac = side === 'T' ? p.roleT : p.roleCT;
    if (roleMode === 'position') {
      return tip([label, how, tac ? `Tactical role: ${tac}` : '']);
    }
    return tip([label, how]);
  };
  const roleCols = [
    {
      key: 'roleT',
      label: tLabel,
      align: 'left',
      get: (p) => tGet(p).toLowerCase(),
      cell: (p) => tGet(p) || '—',
      cellClass: 'st-role-t',
      tip: (p) => roleTip('T', p)
    },
    {
      key: 'roleCT',
      label: ctLabel,
      align: 'left',
      get: (p) => ctGet(p).toLowerCase(),
      cell: (p) => ctGet(p) || '—',
      cellClass: 'st-role-ct',
      tip: (p) => roleTip('CT', p)
    }
  ];
  return [PLAYER_COLUMNS[0], PLAYER_COLUMNS[1], ...roleCols, ...PLAYER_COLUMNS.slice(2)];
}

function possessionDeltaTip(t) {
  const lines = [
    `Avg possession: ${pct(t.possession)}`,
    `Rounds sampled: ${t.possessionRounds || 0}`
  ];
  const byMap = t.possessionByMap || [];
  for (const row of byMap) {
    const base = MAP_CONTROL_BASE[row.map];
    if (!base || !Number.isFinite(row.possession)) {
      lines.push(`${row.map}: ${pct(row.possession)} (${row.rounds} rds)`);
      continue;
    }
    const dCt = row.possession - base.ct;
    const dT = row.possession - base.t;
    const baseRel = relativePossession(base.ct, base.t);
    // Treat team share vs (100 - share) as a 2-side split for relative Δ.
    const curRel = relativePossession(row.possession, Math.max(0, 100 - row.possession));
    const dRel = curRel.ct - baseRel.ct;
    lines.push(
      `${row.map}: ${pct(row.possession)} · vs CT avg ${signed(dCt)} · vs T avg ${signed(dT)} · rel Δ ${signed(dRel)} (${row.rounds} rds)`
    );
  }
  if (!byMap.length && !Number.isFinite(t.possession)) {
    return 'No possession data (needs Sites & Vision zones + radar).';
  }
  return tip(lines);
}

export const TEAM_COLUMNS = [
  { key: 'name', label: 'Team', align: 'left', get: (t) => t.name.toLowerCase() },
  { key: 'rounds', label: 'Rds', get: (t) => t.rounds, cell: (t) => int(t.rounds) },
  {
    key: 'roundWinrate',
    label: 'Round WR',
    get: (t) => t.roundWinrate,
    cell: (t) => pct(t.roundWinrate),
    tip: (t) => tip([`Rounds won: ${t.roundsWon}`, `Rounds lost: ${t.roundsLost}`])
  },
  {
    key: 'avgRating',
    label: 'Avg rating',
    get: (t) => t.avgRating,
    cell: (t) => f2(t.avgRating),
    strong: true,
    tip: (t) =>
      t.members.length
        ? tip(
            t.members.map((m) => {
              const sw = Number.isFinite(m.prwSwing) ? ` · Swing ${signed(m.prwSwing)}` : '';
              return `${m.name}: ${f2(m.rating)}${sw}`;
            })
          )
        : 'No players in range.'
  },
  {
    key: 'possession',
    label: 'Poss%',
    get: (t) => (Number.isFinite(t.possession) ? t.possession : -1),
    cell: (t) => (Number.isFinite(t.possession) ? pct(t.possession) : '—'),
    tip: (t) => possessionDeltaTip(t)
  },
  {
    key: 'prw',
    label: 'PRW',
    get: (t) => (Number.isFinite(t.prw) ? t.prw : -1),
    cell: (t) => (Number.isFinite(t.prw) ? pct(t.prw) : '—'),
    tip: (t) =>
      Number.isFinite(t.prw)
        ? tip([
            `Avg predicted round win%: ${pct(t.prw)}`,
            `Rounds sampled: ${t.prwRounds || 0}`,
            `Sampled every 4s from kill-log win probability`
          ])
        : 'No PRW data yet. Stats index rebuilds on next library load.'
  },
  {
    key: 'mapWinrate',
    label: 'Win%',
    get: (t) => t.mapWinrate,
    cell: (t) => (t.maps > 0 ? pct(t.mapWinrate) : '—'),
    tip: (t) =>
      tip([
        `Map wins: ${t.mapWins}`,
        `Map losses: ${t.mapLosses}`,
        `Rounds won: ${t.roundsWon}`,
        `Rounds lost: ${t.roundsLost}`,
        `Round difference: ${t.roundDiff > 0 ? '+' : ''}${t.roundDiff}`
      ])
  },
  {
    key: 'opkRate',
    label: 'OPK rate',
    get: (t) => t.opkRate,
    cell: (t) => (t.openKills + t.openDeaths > 0 ? pct(t.opkRate) : '—'),
    tip: (t) => tip([`Opening kills: ${t.openKills}`, `Opening deaths: ${t.openDeaths}`])
  },
  {
    key: 'conv5v4',
    label: '5v4',
    get: (t) => t.conv5v4,
    cell: (t) => (t.openKills > 0 ? pct(t.conv5v4) : '—'),
    tip: (t) =>
      tip([
        `After the opening kill: ${t.conv5v4Won} won, ${t.conv5v4Lost} lost`,
        `Rounds with the opening kill: ${t.openKills}`
      ])
  },
  {
    key: 'conv4v5',
    label: '4v5',
    get: (t) => t.conv4v5,
    cell: (t) => (t.openDeaths > 0 ? pct(t.conv4v5) : '—'),
    tip: (t) =>
      tip([
        `After the opening death: ${t.conv4v5Won} won, ${t.conv4v5Lost} lost`,
        `Rounds with the opening death: ${t.openDeaths}`
      ])
  }
];

function sortRows(rows, columns, sortKey, dir) {
  const col = columns.find((c) => c.key === sortKey) || columns.find((c) => c.key === 'rating');
  if (!col) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (typeof va === 'string') return sign * va.localeCompare(vb);
    return sign * ((va || 0) - (vb || 0));
  });
}

/** Default page size for library Statistics tables. */
export const STATS_PAGE_SIZE = 100;

/**
 * @param {{ page: number, pages: number, total: number, pageSize: number }} opts
 */
function pagerHtml({ page, pages, total, pageSize }) {
  if (pages <= 1) return '';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return `<div class="st-pager">
    <span class="st-pager-meta">${from}–${to} of ${total}</span>
    <div class="st-pager-btns">
      <button type="button" class="btn btn-sm" data-page="1"${
        page <= 1 ? ' disabled' : ''
      }>First</button>
      <button type="button" class="btn btn-sm" data-page="${page - 1}"${
        page <= 1 ? ' disabled' : ''
      }>Prev</button>
      <span class="st-pager-page">Page ${page} / ${pages}</span>
      <button type="button" class="btn btn-sm" data-page="${page + 1}"${
        page >= pages ? ' disabled' : ''
      }>Next</button>
      <button type="button" class="btn btn-sm" data-page="${pages}"${
        page >= pages ? ' disabled' : ''
      }>Last</button>
    </div>
  </div>`;
}

/**
 * @param {object[]} rows
 * @param {object} opts { columns, escapeHtml, sortKey, sortDir, nameCell, compact, page, pageSize }
 */
export function statsTableHtml(rows, opts) {
  const {
    columns,
    escapeHtml,
    sortKey,
    sortDir = 'desc',
    nameCell,
    compact,
    page = 1,
    pageSize = 0
  } = opts;
  if (!rows.length) {
    return '<p class="view-empty">Nothing matches these filters.</p>';
  }
  const sorted = sortRows(rows, columns, sortKey, sortDir);
  const total = sorted.length;
  const size = pageSize > 0 ? pageSize : total;
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
  const slice =
    pageSize > 0 ? sorted.slice((safePage - 1) * size, safePage * size) : sorted;

  const head = columns
    .map((c) => {
      const active = c.key === sortKey;
      const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="${c.align === 'left' ? 'left' : ''}${active ? ' sorted' : ''}"
        data-sort="${c.key}" title="Sort by ${escapeHtml(c.label)}">${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join('');

  const body = slice
    .map((r) => {
      const cells = columns
        .map((c) => {
          if (!c.cell) {
            const label = nameCell ? nameCell(r) : escapeHtml(r.name);
            return `<td class="left name">${label}</td>`;
          }
          const text = c.cell(r);
          const t = c.tip?.(r);
          const cls = [
            c.align === 'left' ? 'left' : '',
            c.strong ? 'strong' : '',
            typeof c.cellClass === 'function' ? c.cellClass(r) : c.cellClass || '',
            t ? 'has-tip' : ''
          ]
            .filter(Boolean)
            .join(' ');
          const content = c.em?.(r) ? `<em>${escapeHtml(text)}</em>` : escapeHtml(text);
          return t
            ? `<td class="${cls}" data-tip="${escapeHtml(t)}">${content}</td>`
            : `<td class="${cls}">${content}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const table = `<table class="st-table${compact ? ' compact' : ''}">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;

  if (!(pageSize > 0) || pages <= 1) return table;
  return (
    table +
    pagerHtml({ page: safePage, pages, total, pageSize: size })
  );
}

// ---------------------------------------------------------------------------
// Hover breakdowns
// ---------------------------------------------------------------------------

let tipEl = null;

function ensureTip() {
  if (tipEl?.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'st-tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

/**
 * One delegated listener per panel drives every breakdown, so a table can be
 * re-rendered on any sort or filter change without rebinding anything.
 */
export function attachTips(root) {
  const show = (e) => {
    const cell = e.target.closest?.('[data-tip]');
    if (!cell || !root.contains(cell)) return hide();
    const el = ensureTip();
    el.textContent = cell.dataset.tip;
    el.hidden = false;
    const r = cell.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    let top = r.top - box.height - 8;
    if (top < 8) top = r.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  const hide = () => {
    if (tipEl) tipEl.hidden = true;
  };
  root.addEventListener('mouseover', show);
  root.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !root.contains(e.relatedTarget)) hide();
  });
  root.addEventListener('mouseleave', hide);
  return () => {
    root.removeEventListener('mouseover', show);
    hide();
  };
}
