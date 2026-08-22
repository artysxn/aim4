// ---------------------------------------------------------------------------
// Team Overview: winrates per round type in the round library.
//
// One database-style table for the selected map and side. T rows are dark red,
// CT rows dark blue. Ran / Faced are raw counts; the relative usage (vs the
// library) and share of our rounds sit on hover. Rating is Rating 3.0, the
// team's average player rating over those rounds, sorted highest first. Empty
// cells are gray dashes. Counts open those rounds in a new timeline tab.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { libraryMaps, roundListStats } from './roundListStats.js';
import { attachTips, bindStatsHScroll, statsTableHtml } from '../stats/statsTables.js';
import { DELTA_BANDS, withDeltaHtml } from '../performance/deltaMark.js';

const EMPTY = '<span class="pf-empty">––</span>';
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : EMPTY);
const fmtIndex = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : EMPTY);
const fmtRating = (n) => (Number.isFinite(n) ? n.toFixed(2) : EMPTY);
const fmtCount = (n) => (n > 0 ? String(n) : EMPTY);
const ratingCell = (n) =>
  Number.isFinite(n)
    ? withDeltaHtml(n.toFixed(2), n, 1, DELTA_BANDS.rating)
    : withDeltaHtml('––', null, null, null);

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

  /** @type {{ payload: object|null, teamName: string, maps: string[], mapCode: string, preferredMap: string, side: 'T'|'CT' }} */
  let state = { payload: null, teamName: '', maps: [], mapCode: '', preferredMap: '', side: 'T' };
  let sort = { key: 'ranRating', dir: 'desc' };
  /** Avoid walking the library again on a sort or side click. */
  let statsCache = { payload: null, teamName: '', mapCode: '', stats: null };

  function roundsLink(files, label) {
    const text = escapeHtml(label);
    const href = roundsHref(files);
    if (!href) return text;
    return `<a class="st-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }

  function usageTip({ rounds, index, share, empty, ofWhat }) {
    if (!rounds) return empty;
    const parts = [];
    if (Number.isFinite(index)) parts.push(`${fmtIndex(index)} vs average`);
    if (Number.isFinite(share)) parts.push(`${fmtPct(share)} of ${ofWhat}`);
    return parts.join('. ') + (parts.length ? '.' : '');
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
      get: (r) => r.ranRounds || 0,
      cell: (r) => fmtCount(r.ranRounds),
      html: (r) =>
        r.ranRounds ? roundsLink(r.ranFiles, fmtCount(r.ranRounds)) : EMPTY,
      tip: (r) =>
        usageTip({
          rounds: r.ranRounds,
          index: r.ranIndex,
          share: r.ranShare,
          empty: 'We have not run this.',
          ofWhat: 'our rounds'
        })
    },
    {
      key: 'ranRating',
      label: 'Rating',
      get: (r) => (Number.isFinite(r.ranRating) ? r.ranRating : -1),
      cell: (r) => fmtRating(r.ranRating),
      html: (r) => ratingCell(r.ranRating),
      strong: true,
      tip: (r) =>
        Number.isFinite(r.ranRating)
          ? `Rating ${fmtRating(r.ranRating)} over ${r.ranRounds} rounds.`
          : 'No rating over these rounds.'
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
      get: (r) => r.facedRounds || 0,
      cell: (r) => fmtCount(r.facedRounds),
      html: (r) =>
        r.facedRounds ? roundsLink(r.facedFiles, fmtCount(r.facedRounds)) : EMPTY,
      tip: (r) =>
        usageTip({
          rounds: r.facedRounds,
          index: r.facedIndex,
          share: r.facedShare,
          empty: 'Nobody has run this against us.',
          ofWhat: 'rounds we faced'
        })
    },
    {
      key: 'facedRating',
      label: 'Rating',
      get: (r) => (Number.isFinite(r.facedRating) ? r.facedRating : -1),
      cell: (r) => fmtRating(r.facedRating),
      html: (r) => ratingCell(r.facedRating),
      strong: true,
      tip: (r) =>
        Number.isFinite(r.facedRating)
          ? `Rating ${fmtRating(r.facedRating)} over ${r.facedRounds} rounds.`
          : 'No rating over these rounds.'
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
      cell: (r) => r.when || EMPTY,
      tip: (r) => (r.when ? `Median clock: ${r.when}.` : 'No tagged timing yet.')
    }
  ];

  function rowFromType(t, side) {
    const when = t.ours.timing || t.faced.timing;
    return {
      name: t.label,
      desc: t.desc,
      side,
      ranIndex: t.index,
      ranShare: t.ours.share,
      ranWin: t.ours.winrate,
      ranRounds: t.ours.rounds,
      ranWins: t.ours.wins,
      ranFiles: t.ours.files || [],
      ranRating: t.ours.rating,
      facedIndex: t.facedIndex,
      facedShare: t.faced.share,
      facedWin: t.faced.winrate,
      facedRounds: t.faced.rounds,
      facedWins: t.faced.wins,
      facedFiles: t.faced.files || [],
      facedRating: t.faced.rating,
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

  function sideSwitchHtml(side) {
    const tOn = side === 'T' ? ' active' : '';
    const ctOn = side === 'CT' ? ' active' : '';
    return `<div class="rp-seg rp-seg-side" role="group" aria-label="Side">
      <button type="button" class="rp-seg-btn${tOn}" data-rl-side="T" aria-pressed="${side === 'T' ? 'true' : 'false'}" aria-label="T" title="T">
        <img src="/icons/icon_t.png" alt="" width="16" height="16" draggable="false" />
      </button>
      <button type="button" class="rp-seg-btn${ctOn}" data-rl-side="CT" aria-pressed="${side === 'CT' ? 'true' : 'false'}" aria-label="CT" title="CT">
        <img src="/icons/icon_ct.png" alt="" width="16" height="16" draggable="false" />
      </button>
    </div>`;
  }

  function statsFor() {
    const { payload, teamName, mapCode } = state;
    if (
      statsCache.payload === payload &&
      statsCache.teamName === teamName &&
      statsCache.mapCode === mapCode
    ) {
      return statsCache.stats;
    }
    const stats = payload ? roundListStats(payload, { mapCode, teamName }) : null;
    statsCache = { payload, teamName, mapCode, stats };
    return stats;
  }

  function render() {
    const { maps, mapCode, side } = state;
    if (!maps.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const stats = statsFor();
    const rows = [];
    const bag = stats?.sides?.[side];
    if (bag?.types) {
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
        <div class="tm-rl-tools">
          ${sideSwitchHtml(side)}
          ${mapSelectHtml(maps, mapCode)}
        </div>
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
    const sideBtn = e.target.closest?.('[data-rl-side]');
    if (sideBtn && el.contains(sideBtn)) {
      const next = sideBtn.getAttribute('data-rl-side') === 'CT' ? 'CT' : 'T';
      if (next === state.side) return;
      state = { ...state, side: next };
      render();
      return;
    }
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
    state = { ...state, payload, teamName, maps, mapCode, preferredMap: preferred };
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
