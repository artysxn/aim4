// ---------------------------------------------------------------------------
// Team Overview: winrates per round type in the round library.
//
// One row per named round type, both sides, showing how often this team runs
// it and how that lands. The "vs avg" column is the one to read first: it is
// this team's share of its own rounds divided by the library's share of all of
// them, so 2.0x means they call it twice as often as everyone else does, and
// the winrate next to it says whether that is working.
//
// With a map chip picked the panel is that map alone; with none picked it is
// every library map the team has played, so the section is there to read
// without having to pick anything first.
// ---------------------------------------------------------------------------

import { MAPS } from '../shared/roundId.js';
import { libraryMaps, roundListStats } from './roundListStats.js';

const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');
const fmtIndex = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}x` : '—');

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createRoundListPanel({ escapeHtml }) {
  const el = document.createElement('section');
  el.className = 'tm-card tm-roundlist';
  el.hidden = true;

  /** @type {{ mapCode: string, teamName: string, blocks: Array<{code: string, stats: object}>, scoped: boolean }} */
  let state = { mapCode: '', teamName: '', blocks: [], scoped: false };

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

  /** Grey is always the library: the same number for every other team. */
  const dim = (text) => `<span class="tm-rl-sub">${text}</span>`;

  function rowHtml(t, bag) {
    const ours = t.ours;
    const league = t.league;
    const cell = (title, body) => `<td class="tm-rl-num" title="${escapeHtml(title)}">${body}</td>`;

    const when = ours.timing || league.timing;
    const whenTitle = ours.timing
      ? `Median clock we call it at, over the ${ours.rounds} rounds we ran it.` +
        (league.timing ? ` Everyone else: ${league.timing.clock}.` : '')
      : league.timing
        ? `We have never run this. Everyone else calls it around ${league.timing.clock}.`
        : 'Nobody has run this on a tagged round yet.';

    const winTitle = ours.rounds
      ? `We ran it ${ours.rounds} times and won ${ours.wins} (${fmtPct(ours.winrate)}). ` +
        `Everyone else: ${league.rounds} rounds at ${fmtPct(league.winrate)}.`
      : `We have never run this. Everyone else: ${league.rounds} rounds at ${fmtPct(
          league.winrate
        )}.`;

    const useTitle =
      `${ours.rounds} of our ${bag.ourRounds} ${t.side || ''} rounds is ${fmtPct(ours.share)}. ` +
      `Everyone else: ${league.rounds} of ${bag.leagueRounds} is ${fmtPct(league.share)}.`;

    const indexTitle = Number.isFinite(t.index)
      ? `Our share divided by the library's: ${fmtPct(ours.share)} / ${fmtPct(
          league.share
        )} = ${fmtIndex(t.index)}. Above 1x means we call it more than everyone else.`
      : 'Nobody in the library has run this, so there is no average to compare against.';

    const facedTitle = t.faced.rounds
      ? `We faced it ${t.faced.rounds} times and won ${t.faced.wins} (${fmtPct(t.faced.winrate)}).`
      : 'Nobody has run this against us.';

    return `<tr${ours.rounds ? '' : ' class="is-unused"'}>
      <th scope="row" class="tm-rl-name" title="${escapeHtml(t.desc || t.label)}">${escapeHtml(
        t.label
      )}</th>
      ${cell(whenTitle, escapeHtml(when ? when.clock : '—'))}
      ${cell(
        winTitle,
        ours.rounds
          ? `${escapeHtml(fmtPct(ours.winrate))} ${dim(escapeHtml(fmtPct(league.winrate)))}`
          : `— ${dim(escapeHtml(fmtPct(league.winrate)))}`
      )}
      ${cell(useTitle, ours.rounds ? String(ours.rounds) : '—')}
      ${cell(
        useTitle,
        `${escapeHtml(fmtPct(ours.share))} ${dim(escapeHtml(fmtPct(league.share)))}`
      )}
      ${cell(indexTitle, escapeHtml(fmtIndex(t.index)))}
      <td class="tm-rl-barcell" title="${escapeHtml(indexTitle)}">${indexBar(t.index)}</td>
      ${cell(
        facedTitle,
        t.faced.rounds
          ? `${t.faced.rounds} ${dim(escapeHtml(fmtPct(t.faced.winrate)))}`
          : '—'
      )}
    </tr>`;
  }

  function sideHtml(side, bag) {
    if (!bag?.types.length) return '';
    const shown = bag.types.filter((t) => t.ours.rounds || t.faced.rounds || t.league.rounds);
    if (!shown.length) return '';
    const th = (label, title, cls = '') =>
      `<th${cls ? ` class="${cls}"` : ''} title="${escapeHtml(title)}">${escapeHtml(label)}</th>`;
    return `<div class="tm-rl-side">
      <p class="an-side-title">${escapeHtml(side)} rounds <small>${bag.ourRounds} run, ${bag.facedRounds} faced</small></p>
      <table class="tm-rl-table">
        <colgroup>
          <col class="tm-rl-c-name" />
          <col class="tm-rl-c-when" />
          <col class="tm-rl-c-win" />
          <col class="tm-rl-c-n" />
          <col class="tm-rl-c-use" />
          <col class="tm-rl-c-idx" />
          <col class="tm-rl-c-bar" />
          <col class="tm-rl-c-faced" />
        </colgroup>
        <thead>
          <tr>
            ${th('Call', 'The named round type, as the library defines it', 'tm-rl-name')}
            ${th('When', 'Median clock the call comes at')}
            ${th('Win', 'Our winrate running it, and the library average beside it')}
            ${th('N', 'Rounds we ran it')}
            ${th('Use', 'Our share of our own rounds, and the library share beside it')}
            ${th('vs avg', 'Our share divided by the library share')}
            ${th('', 'Usage against the average', 'tm-rl-barcell')}
            ${th('Faced', 'Rounds we faced it, and our winrate against it')}
          </tr>
        </thead>
        <tbody>${shown.map((t) => rowHtml({ ...t, side }, bag)).join('')}</tbody>
      </table>
    </div>`;
  }

  /** One map's two sides, with a map heading when the panel shows several. */
  function mapHtml({ code, stats }, withHeading) {
    const body = sideHtml('T', stats.sides.T) + sideHtml('CT', stats.sides.CT);
    if (!body) return '';
    const name = MAPS[code]?.name || code;
    const head = withHeading
      ? `<div class="tm-rl-map-head">
          <span class="tm-rl-map-name">${escapeHtml(name)}</span>
          <span class="tm-count">${stats.ourDemos} of ${stats.demos} matches</span>
        </div>`
      : '';
    return `<div class="tm-rl-map">${head}${body}</div>`;
  }

  function render() {
    const { mapCode, blocks, scoped } = state;
    if (!blocks.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const one = Boolean(mapCode) && blocks.length === 1;
    const title = one
      ? `Round types, ${escapeHtml(MAPS[blocks[0].code]?.name || blocks[0].code)}`
      : 'Round types';
    const count = one
      ? `<span class="tm-count">${blocks[0].stats.ourDemos} of ${blocks[0].stats.demos} matches</span>`
      : `<span class="tm-count">${blocks.length} ${blocks.length === 1 ? 'map' : 'maps'}</span>`;
    const body =
      blocks.map((b) => mapHtml(b, !one)).join('') ||
      '<p class="view-empty">No tagged rounds yet.</p>';
    // One rule for the whole table: grey is always everyone else. Without
    // saying so the second number in each cell means three different things.
    const legend =
      `<p class="tm-rl-note"><span class="tm-rl-sub">Grey</span> is the library average across every team. Hover any number for how it is worked out.</p>`;
    const basis = scoped
      ? `<p class="tm-rl-note">Those averages are over this team's own matches only. Pick a map to compare against the full library.</p>`
      : '';
    el.hidden = false;
    el.innerHTML = `
      <div class="tm-card-head">
        <h3 class="tm-card-title">${title}</h3>
        ${count}
      </div>
      ${body}
      ${legend}${basis}`;
  }

  /**
   * @param {{ mapCode: string, teamName: string, payload: object|null, scoped?: boolean }} next
   */
  function update(next) {
    const mapCode = String(next?.mapCode || '').toUpperCase();
    const teamName = next?.teamName || '';
    if (!next?.payload) {
      state = { mapCode: '', teamName: '', blocks: [], scoped: false };
      render();
      return;
    }
    const codes = mapCode ? [mapCode] : libraryMaps(next.payload, teamName);
    const blocks = [];
    for (const code of codes) {
      const stats = roundListStats(next.payload, { mapCode: code, teamName });
      // Without a map chip the panel is a summary of what this team has
      // played, so a map they have never been on is not a row of zeroes.
      if (!stats || (!mapCode && !stats.ourDemos)) continue;
      blocks.push({ code, stats });
    }
    state = { mapCode, teamName, blocks, scoped: Boolean(next.scoped) };
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
