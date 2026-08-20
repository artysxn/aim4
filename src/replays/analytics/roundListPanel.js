// ---------------------------------------------------------------------------
// Team Overview: winrates per round type in the round library.
//
// One database-style table for the selected map. T rows are dark red, CT rows
// dark blue. Ran / Faced are relative usage vs the library (1.5x means more
// often than everyone else) and open those rounds in a new timeline tab.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { libraryMaps, roundListStats } from './roundListStats.js';
import { attachTips, bindStatsHScroll, statsTableHtml } from '../stats/statsTables.js';

const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const fmtIndex = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : '—');

/** Overpass is out of the overview pool. */
const HIDDEN_MAPS = new Set(['OVP']);

function roundsHref(files) {
  const list = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
  if (!list.length) return '';
  return `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
}

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createRoundListPanel({ escapeHtml }) {
  const el = document.createElement('section');
  el.className = 'tm-card tm-roundlist';
  el.hidden = true;

  /** @type {{ payload: object|null, teamName: string, maps: string[], mapCode: string, preferredMap: string }} */
  let state = { payload: null, teamName: '', maps: [], mapCode: '', preferredMap: '' };
  let sort = { key: 'ran', dir: 'desc' };

  function roundsLink(files, label) {
    const text = escapeHtml(label);
    const href = roundsHref(files);
    if (!href) return text;
    return `<a class="st-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }

  const COLUMNS = [
    {
      key: 'name',
      label: 'Name',
      align: 'left',
      noAvg: true,
      get: (r) => String(r.name || '').toLowerCase()
    },
    {
      key: 'ran',
      label: 'Ran',
      get: (r) => (Number.isFinite(r.ran) ? r.ran : -1),
      cell: (r) => (r.ranRounds ? fmtIndex(r.ran) : '—'),
      html: (r) =>
        r.ranRounds ? roundsLink(r.ranFiles, fmtIndex(r.ran)) : escapeHtml('—'),
      tip: (r) =>
        r.ranRounds
          ? `We ran this ${r.ranRounds} times. ${fmtIndex(r.ran)} vs the library share.`
          : 'We have not run this.'
    },
    {
      key: 'ranWin',
      label: 'Win%',
      get: (r) => (Number.isFinite(r.ranWin) ? r.ranWin : -1),
      cell: (r) => fmtPct(r.ranWin),
      tip: (r) =>
        r.ranRounds
          ? `Won ${r.ranWins} of ${r.ranRounds} rounds we ran.`
          : 'We have not run this.'
    },
    {
      key: 'faced',
      label: 'Faced',
      get: (r) => (Number.isFinite(r.faced) ? r.faced : -1),
      cell: (r) => (r.facedRounds ? fmtIndex(r.faced) : '—'),
      html: (r) =>
        r.facedRounds ? roundsLink(r.facedFiles, fmtIndex(r.faced)) : escapeHtml('—'),
      tip: (r) =>
        r.facedRounds
          ? `We faced this ${r.facedRounds} times. ${fmtIndex(r.faced)} vs the library share.`
          : 'Nobody has run this against us.'
    },
    {
      key: 'facedWin',
      label: 'Win%',
      get: (r) => (Number.isFinite(r.facedWin) ? r.facedWin : -1),
      cell: (r) => fmtPct(r.facedWin),
      tip: (r) =>
        r.facedRounds
          ? `Won ${r.facedWins} of ${r.facedRounds} rounds we faced.`
          : 'Nobody has run this against us.'
    },
    {
      key: 'when',
      label: 'When',
      noAvg: true,
      get: (r) => (Number.isFinite(r.whenSec) ? r.whenSec : -1),
      cell: (r) => r.when || '—',
      tip: (r) => (r.when ? `Median clock: ${r.when}.` : 'No tagged timing yet.')
    }
  ];

  function rowFromType(t, side) {
    const when = t.ours.timing || t.faced.timing;
    return {
      name: t.label,
      desc: t.desc,
      side,
      ran: t.index,
      ranWin: t.ours.winrate,
      ranRounds: t.ours.rounds,
      ranWins: t.ours.wins,
      ranFiles: t.ours.files || [],
      faced: t.facedIndex,
      facedWin: t.faced.winrate,
      facedRounds: t.faced.rounds,
      facedWins: t.faced.wins,
      facedFiles: t.faced.files || [],
      when: when?.clock || '',
      whenSec: Number.isFinite(when?.seconds) ? when.seconds : -1
    };
  }

  function mapSelectHtml(maps, selected) {
    const opts = maps
      .map((code) => {
        const name = MAPS[code]?.name || code;
        const on = code === selected ? ' selected' : '';
        return `<option value="${escapeHtml(code)}"${on}>${escapeHtml(name)}</option>`;
      })
      .join('');
    return `<select class="site-select tm-rl-map" data-rl-map aria-label="Map">${opts}</select>`;
  }

  function render() {
    const { maps, mapCode, payload, teamName } = state;
    if (!maps.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const stats = payload ? roundListStats(payload, { mapCode, teamName }) : null;
    const rows = [];
    for (const side of ['T', 'CT']) {
      const bag = stats?.sides?.[side];
      if (!bag?.types) continue;
      for (const t of bag.types) {
        if (!t.ours.rounds && !t.faced.rounds) continue;
        rows.push(rowFromType(t, side));
      }
    }
    const table = rows.length
      ? statsTableHtml(rows, {
          columns: COLUMNS,
          fixedCount: 1,
          escapeHtml,
          sortKey: sort.key,
          sortDir: sort.dir,
          rowClass: (r) => (r.side === 'CT' ? 'tm-rl-ct' : 'tm-rl-t')
        })
      : '<p class="view-empty">No tagged rounds on this map yet.</p>';
    el.hidden = false;
    el.innerHTML = `
      <div class="tm-card-head">
        <h3 class="tm-card-title">Round types</h3>
        ${mapSelectHtml(maps, mapCode)}
      </div>
      ${table}`;
    bindStatsHScroll(el);
  }

  el.addEventListener('change', (e) => {
    const sel = e.target.closest?.('[data-rl-map]');
    if (!sel || sel.value === state.mapCode) return;
    state = { ...state, mapCode: String(sel.value || '').toUpperCase() };
    render();
  });

  el.addEventListener('click', (e) => {
    const th = e.target.closest?.('[data-sort]');
    if (!th || !el.contains(th)) return;
    const key = th.getAttribute('data-sort') || '';
    if (!key) return;
    if (sort.key === key) sort = { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' };
    else sort = { key, dir: 'desc' };
    render();
  });
  attachTips(el);

  /**
   * @param {{ teamName: string, payload: object|null, preferredMap?: string }} next
   */
  function update(next) {
    const teamName = next?.teamName || '';
    const payload = next?.payload || null;
    const preferred = String(next?.preferredMap || '').toUpperCase();
    const maps = libraryMaps(payload, teamName).filter((code) => !HIDDEN_MAPS.has(code));
    let mapCode = state.mapCode;
    if (preferred && preferred !== state.preferredMap && maps.includes(preferred)) {
      mapCode = preferred;
    } else if (!maps.includes(mapCode)) {
      mapCode = maps[0] || '';
    }
    state = { payload, teamName, maps, mapCode, preferredMap: preferred };
    render();
  }

  return {
    el,
    update,
    destroy() {
      el.remove();
    }
  };
}
