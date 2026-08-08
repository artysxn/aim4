// ---------------------------------------------------------------------------
// Team Overview: the round library for the selected map.
//
// One row per named round type, both sides, showing how often this team runs
// it and how that lands. The "vs avg" column is the one to read first: it is
// this team's share of its own rounds divided by the library's share of all of
// them, so 2.0x means they call it twice as often as everyone else does, and
// the winrate next to it says whether that is working.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { roundListStats } from './roundListStats.js';

const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const fmtIndex = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : '—');

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createRoundListPanel({ escapeHtml }) {
  const el = document.createElement('section');
  el.className = 'tm-card tm-roundlist';
  el.hidden = true;

  let state = { mapCode: '', teamName: '', stats: null, scoped: false };

  /** A usage bar anchored at the library average, like the map winrate bars. */
  function indexBar(index) {
    if (!Number.isFinite(index)) return '<span class="tm-rl-bar" aria-hidden="true"></span>';
    // 1x sits on the centre line; the bar saturates at 3x either way.
    const offset = Math.max(-50, Math.min(50, (Math.min(index, 3) - 1) * 25));
    const left = offset < 0 ? 50 + offset : 50;
    return `<span class="tm-rl-bar"><span class="tm-rl-bar-track">
      <span class="tm-rl-bar-fill" style="left:${left}%;width:${Math.abs(offset)}%"></span>
    </span></span>`;
  }

  function rowHtml(t) {
    const dim = t.ours.rounds ? '' : ' is-unused';
    return `<li class="tm-rl-row${dim}" title="${escapeHtml(t.desc || '')}">
      <span class="tm-rl-name">${escapeHtml(t.label)}</span>
      <span class="tm-rl-n" title="Rounds we ran it">${t.ours.rounds || '—'}</span>
      <span class="tm-rl-wr" title="Our winrate running it">${escapeHtml(fmtPct(t.ours.winrate))}</span>
      <span class="tm-rl-share" title="Our share of rounds vs the library's">${escapeHtml(
        fmtPct(t.ours.share)
      )} / ${escapeHtml(fmtPct(t.league.share))}</span>
      <span class="tm-rl-index" title="How often we call it against the library average">${escapeHtml(
        fmtIndex(t.index)
      )}</span>
      ${indexBar(t.index)}
      <span class="tm-rl-vs" title="Rounds we faced it, and our winrate against it">${
        t.faced.rounds ? `${t.faced.rounds} · ${escapeHtml(fmtPct(t.faced.winrate))}` : '—'
      }</span>
    </li>`;
  }

  function sideHtml(side, bag) {
    if (!bag?.types.length) return '';
    const shown = bag.types.filter((t) => t.ours.rounds || t.faced.rounds || t.league.rounds);
    if (!shown.length) return '';
    return `<div class="tm-rl-side">
      <p class="an-side-title">${escapeHtml(side)} rounds <small>${bag.ourRounds} run, ${bag.facedRounds} faced</small></p>
      <div class="tm-rl-head" aria-hidden="true">
        <span></span><span>N</span><span>WIN</span><span>USE / AVG</span><span>vs avg</span><span></span><span>FACED</span>
      </div>
      <ul class="tm-rl-list">${shown.map(rowHtml).join('')}</ul>
    </div>`;
  }

  function render() {
    const { mapCode, stats, scoped } = state;
    if (!mapCode || !stats) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const mapName = MAPS[mapCode]?.name || mapCode;
    const body =
      sideHtml('T', stats.sides.T) + sideHtml('CT', stats.sides.CT) ||
      '<p class="view-empty">No tagged rounds on this map yet.</p>';
    const basis = scoped
      ? `<p class="tm-rl-note">Averages are over this team's own matches only. Open the map once more to compare against the full library.</p>`
      : '';
    el.hidden = false;
    el.innerHTML = `
      <div class="tm-card-head">
        <h3 class="tm-card-title">Round library, ${escapeHtml(mapName)}</h3>
        <span class="tm-count">${stats.ourDemos} of ${stats.demos} matches</span>
      </div>
      ${body}
      ${basis}`;
  }

  /**
   * @param {{ mapCode: string, teamName: string, payload: object|null, scoped?: boolean }} next
   */
  function update(next) {
    const mapCode = String(next?.mapCode || '').toUpperCase();
    if (!mapCode || !next?.payload) {
      state = { mapCode: '', teamName: '', stats: null, scoped: false };
      render();
      return;
    }
    state = {
      mapCode,
      teamName: next.teamName || '',
      stats: roundListStats(next.payload, { mapCode, teamName: next.teamName || '' }),
      scoped: Boolean(next.scoped)
    };
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
