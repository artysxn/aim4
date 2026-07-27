// ---------------------------------------------------------------------------
// replays/stats/statsTables.js
// Rendering for the two stats tables, plus the hover breakdowns.
//
// Kept apart from any one screen because three surfaces show the same numbers:
// the Statistics page, the per-demo view opened from a match row, and the live
// scoreboard inside the viewer.
// ---------------------------------------------------------------------------

import { roleHowText } from '../roles/regionKeys.js';

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const int = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');

/** Accuracy is blank rather than 0% when the demo predates hit counts. */
const accCell = (p) => (p.shots > 0 ? pct(p.accuracy) : '—');

const tip = (lines) => lines.filter(Boolean).join('\n');

/** Columns of the player table, in order. `get` returns the sort value. */
export const PLAYER_COLUMNS = [
  { key: 'name', label: 'Player', align: 'left', get: (p) => p.name.toLowerCase(), cell: null },
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
  return [PLAYER_COLUMNS[0], ...roleCols, ...PLAYER_COLUMNS.slice(1)];
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
        ? tip(t.members.map((m) => `${m.name}: ${f2(m.rating)}`))
        : 'No players in range.'
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

/**
 * @param {object[]} rows
 * @param {object} opts { columns, escapeHtml, sortKey, sortDir, nameCell, compact }
 */
export function statsTableHtml(rows, opts) {
  const { columns, escapeHtml, sortKey, sortDir = 'desc', nameCell, compact } = opts;
  if (!rows.length) {
    return '<p class="view-empty">Nothing matches these filters.</p>';
  }
  const sorted = sortRows(rows, columns, sortKey, sortDir);

  const head = columns
    .map((c) => {
      const active = c.key === sortKey;
      const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="${c.align === 'left' ? 'left' : ''}${active ? ' sorted' : ''}"
        data-sort="${c.key}" title="Sort by ${escapeHtml(c.label)}">${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join('');

  const body = sorted
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
            c.cellClass || '',
            t ? 'has-tip' : ''
          ]
            .filter(Boolean)
            .join(' ');
          return t
            ? `<td class="${cls}" data-tip="${escapeHtml(t)}">${escapeHtml(text)}</td>`
            : `<td class="${cls}">${escapeHtml(text)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<table class="st-table${compact ? ' compact' : ''}">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
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
