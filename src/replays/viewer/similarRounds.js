// ---------------------------------------------------------------------------
// replays/viewer/similarRounds.js
// The viewer's Similar Rounds panel. Desktop app only: the scan runs on the
// PC in the app's own server (server/similar), and the viewer shows its
// button only when the app's bridge is there.
//
// The question is read off the viewer when Scan is pressed: the round on
// screen, the moment on the clock, the side, and whatever is drawn on the
// map (T and CT pens name the side a stroke is about; the other pens follow
// the side picked here). Results are the closest rounds, each opening at the
// same moment in a new tab, with how much win chance its side gave up on the
// way (dominance).
// ---------------------------------------------------------------------------

import { scanSimilarRounds } from '../api.js';
import { radarToWorld } from './mapCalibration.js';
import { DRAW_COLORS } from './drawing.js';
import { clockAt, timingFor } from './roundClock.js';

const PREFS_KEY = 'aim4.similar';
const PEN_SIDE = Object.fromEntries(
  DRAW_COLORS.map((c) => [c.value, c.id === 't' ? 'T' : c.id === 'ct' ? 'CT' : ''])
);

const DOMINANCE_STEPS = [0, 50, 70, 90];
/**
 * How many of the closest rounds the list reads from. Similarity runs high
 * early in a round and low late, so "the closest 50" means the same thing at
 * any moment where a fixed percentage would not.
 */
const TOP_STEPS = [25, 50, 100, 0];

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* not remembered */
  }
}

const num = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   getContext: () => null | {
 *     file: string, meta: object, tick: number, mapCode: string,
 *     strokes: Array<{ color: string, pts: Array<{ x: number, y: number }> }>
 *   }
 * }} deps
 */
export function createSimilarRounds({ escapeHtml, getContext }) {
  const prefs = readPrefs();
  const state = {
    open: false,
    side: prefs.side === 'CT' ? 'CT' : 'T',
    both: prefs.both === true,
    mode: ['round', 'drawing', 'both'].includes(prefs.mode) ? prefs.mode : 'both',
    team: '',
    top: 50,
    minDominance: 0,
    outcome: '',
    sort: { key: 'similarity', dir: -1 },
    running: null,
    done: null
  };

  const el = document.createElement('section');
  el.className = 'rv-similar';
  el.hidden = true;
  el.innerHTML = `
    <div class="rv-wingraph-head">
      <span class="rv-sec-title">Similar rounds</span>
      <span class="rv-sec-val">
        <span class="rv-similar-at" data-sim-at title="The moment the scan compares"></span>
        <button type="button" class="rp-btn-icon" data-sim-close aria-label="Close">✕</button>
      </span>
    </div>
    <div class="rv-similar-row">
      <div class="rv-az-seg rv-similar-side" role="group" aria-label="Side">
        <button type="button" class="rv-az-seg-btn" data-sim-side="T">T</button>
        <button type="button" class="rv-az-seg-btn" data-sim-side="CT">CT</button>
      </div>
      <div class="rv-az-seg rv-similar-both">
        <button type="button" class="rv-az-seg-btn" data-sim-both aria-pressed="false"
          title="Match the other side's positions and utility too">Both sides</button>
      </div>
    </div>
    <select class="site-select rv-similar-team" data-sim-team aria-label="Team"
      title="Only rounds where this team played the side it plays here"></select>
    <div class="rv-az-seg rv-similar-mode" role="group" aria-label="Compare" data-sim-modes hidden>
      <button type="button" class="rv-az-seg-btn" data-sim-mode="round">Round</button>
      <button type="button" class="rv-az-seg-btn" data-sim-mode="drawing">Drawing</button>
      <button type="button" class="rv-az-seg-btn" data-sim-mode="both">Both</button>
    </div>
    <button type="button" class="btn primary rv-similar-go" data-sim-go>Scan</button>
    <div class="rv-similar-progress" data-sim-progress hidden>
      <div class="rv-similar-bar"><span data-sim-bar></span></div>
      <span class="rv-similar-count" data-sim-count></span>
    </div>
    <p class="rv-similar-msg" data-sim-msg hidden></p>
    <div class="rv-similar-results" data-sim-results hidden>
      <div class="rv-similar-row">
        <select class="site-select" data-sim-top aria-label="Closest rounds">
          ${TOP_STEPS.map((n) => `<option value="${n}"${n === 50 ? ' selected' : ''}>${n ? `Top ${n}` : 'All'}</option>`).join('')}
        </select>
        <select class="site-select" data-sim-outcome aria-label="Result">
          <option value="">Result</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
        <select class="site-select" data-sim-dom aria-label="Dominance">
          ${DOMINANCE_STEPS.map((d) => `<option value="${d}">${d ? `Dom ${d}+` : 'Dominance'}</option>`).join('')}
        </select>
      </div>
      <div class="rv-similar-summary" data-sim-summary></div>
      <div class="rv-similar-list" data-sim-list></div>
    </div>`;

  const $ = (sel) => el.querySelector(sel);
  const atEl = $('[data-sim-at]');
  const teamEl = $('[data-sim-team]');
  const modesEl = $('[data-sim-modes]');
  const goBtn = $('[data-sim-go]');
  const progressEl = $('[data-sim-progress]');
  const barEl = $('[data-sim-bar]');
  const countEl = $('[data-sim-count]');
  const msgEl = $('[data-sim-msg]');
  const resultsEl = $('[data-sim-results]');
  const summaryEl = $('[data-sim-summary]');
  const listEl = $('[data-sim-list]');
  const domEl = $('[data-sim-dom]');
  const outcomeEl = $('[data-sim-outcome]');
  const topEl = $('[data-sim-top]');
  let teamsKey = '';
  let pollTimer = 0;
  /** @type {((open: boolean) => void) | null} */
  let onToggle = null;

  function savePrefs() {
    writePrefs({ side: state.side, both: state.both, mode: state.mode });
  }

  function message(text) {
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
  }

  /** The round's strokes in world units, each tagged with the side its pen names. */
  function drawnStrokes(ctx) {
    const out = [];
    for (const s of ctx?.strokes || []) {
      const pts = (s.pts || []).map((p) => {
        const w = radarToWorld(ctx.mapCode, p.x, p.y);
        return [Math.round(w.x), Math.round(w.y)];
      });
      if (pts.length) out.push({ side: PEN_SIDE[s.color] || '', pts });
    }
    return out;
  }

  /** Controls that follow the round on screen: the clock, the teams, the drawing. */
  function syncContext() {
    const ctx = getContext();
    if (ctx?.meta) {
      atEl.textContent = clockAt(timingFor(ctx.meta), ctx.tick).label;
      const teams = [ctx.meta.team1, ctx.meta.team2].filter((t) => t?.id);
      const key = teams.map((t) => `${t.id}:${t.name}`).join('|');
      if (key !== teamsKey) {
        teamsKey = key;
        if (!teams.some((t) => t.id === state.team)) state.team = '';
        teamEl.innerHTML =
          '<option value="">All teams</option>' +
          teams
            .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`)
            .join('');
        teamEl.value = state.team;
      }
    } else {
      atEl.textContent = '';
    }
    modesEl.hidden = !(ctx?.strokes || []).length;
  }

  function syncControls() {
    for (const b of el.querySelectorAll('[data-sim-side]')) {
      const on = b.dataset.simSide === state.side;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const both = $('[data-sim-both]');
    both.classList.toggle('active', state.both);
    both.setAttribute('aria-pressed', state.both ? 'true' : 'false');
    for (const b of el.querySelectorAll('[data-sim-mode]')) {
      b.classList.toggle('active', b.dataset.simMode === state.mode);
    }
    goBtn.textContent = state.running ? 'Stop' : 'Scan';
    goBtn.classList.toggle('primary', !state.running);
  }

  // ---- results ----------------------------------------------------------------

  function visibleResults() {
    const done = state.done;
    if (!done) return [];
    // Results arrive closest first.
    const closest = state.top ? done.results.slice(0, state.top) : done.results;
    const rows = closest.filter((r) => {
      if (r.dominance < state.minDominance) return false;
      if (state.outcome === 'won' && !r.won) return false;
      if (state.outcome === 'lost' && r.won) return false;
      return true;
    });
    const { key, dir } = state.sort;
    rows.sort((a, b) => dir * ((a[key] ?? 0) - (b[key] ?? 0)) || b.similarity - a.similarity);
    return rows;
  }

  function rowTip(r) {
    const parts = [];
    if (r.parts.positions !== undefined) parts.push(`Positions ${r.parts.positions}%`);
    if (r.parts.utility !== undefined) parts.push(`Utility ${r.parts.utility}%`);
    if (r.parts.drawing !== undefined) parts.push(`Drawing ${r.parts.drawing}%`);
    parts.push(r.drop ? `Win chance fell ${r.drop} points in total` : 'Win chance never fell');
    return parts.join(' · ');
  }

  function renderResults() {
    const done = state.done;
    resultsEl.hidden = !done;
    if (!done) return;
    const rows = visibleResults();
    const econ = Object.values(done.econ || {}).join(' vs ');
    summaryEl.textContent = `${num(rows.length)} of ${num(done.matched)} at ${done.at}${econ ? ` · ${econ}` : ''}`;
    const sortMark = (key) => (state.sort.key === key ? (state.sort.dir < 0 ? ' ▾' : ' ▴') : '');
    const head = `
      <div class="rv-similar-item rv-similar-headrow">
        <button type="button" class="rv-similar-sort" data-sim-sort="similarity">Match${sortMark('similarity')}</button>
        <span>Round</span>
        <span class="rv-similar-res">Result</span>
        <button type="button" class="rv-similar-sort" data-sim-sort="dominance">Dom${sortMark('dominance')}</button>
      </div>`;
    const body = rows
      .slice(0, 200)
      .map((r) => {
        const href = `/demos?round=${encodeURIComponent(r.file)}&tick=${r.tick}`;
        const t = r.teams?.T || {};
        const ct = r.teams?.CT || {};
        return `
          <a class="rv-similar-item" href="${escapeHtml(href)}" target="_blank" rel="noopener"
            title="${escapeHtml(rowTip(r))}">
            <span class="rv-similar-pct" style="--sim:${Math.max(0, Math.min(100, r.similarity))}%">${Math.round(r.similarity)}%</span>
            <span class="rv-similar-match">
              <span class="t">${escapeHtml(t.name || t.id || 'T')}</span>
              <span class="rv-similar-vs">vs</span>
              <span class="ct">${escapeHtml(ct.name || ct.id || 'CT')}</span>
              <span class="rv-similar-rn">R${r.round}</span>
            </span>
            <span class="rv-similar-res ${r.won ? 'won' : 'lost'}">${r.won ? 'W' : 'L'}</span>
            <span class="rv-similar-dom">${r.dominance}</span>
          </a>`;
      })
      .join('');
    listEl.innerHTML = rows.length
      ? head + body
      : `<p class="rv-similar-empty">${done.matched ? 'No round passes these filters.' : 'No similar rounds on this map yet.'}</p>`;
  }

  // ---- scanning ---------------------------------------------------------------

  function showProgress(done, total) {
    progressEl.hidden = false;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    barEl.style.width = `${pct}%`;
    countEl.textContent = total ? `${num(done)} / ${num(total)}` : '';
  }

  async function scan() {
    if (state.running) {
      state.running.abort();
      return;
    }
    const ctx = getContext();
    if (!ctx?.file || !ctx.meta) {
      message('Open a round first.');
      return;
    }
    const strokes = drawnStrokes(ctx);
    const ask = {
      file: ctx.file,
      tick: Math.round(ctx.tick),
      side: state.side,
      both: state.both,
      mode: strokes.length ? state.mode : 'round',
      strokes,
      team: state.team
    };
    const at = clockAt(timingFor(ctx.meta), ctx.tick).label;
    const controller = new AbortController();
    state.running = controller;
    message('');
    showProgress(0, 0);
    countEl.textContent = 'Reading this round';
    syncControls();
    try {
      await scanSimilarRounds(ask, {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === 'phase') countEl.textContent = e.phase === 'list' ? 'Listing rounds' : 'Reading this round';
          else if (e.type === 'start' || e.type === 'progress') showProgress(e.done || 0, e.total);
          else if (e.type === 'done') {
            state.done = { ...e, at };
            renderResults();
          } else if (e.type === 'error') message(e.error);
        }
      });
    } catch (err) {
      if (!controller.signal.aborted) message(err?.message || 'The scan failed.');
    } finally {
      if (state.running === controller) state.running = null;
      progressEl.hidden = true;
      syncControls();
    }
  }

  // ---- events -----------------------------------------------------------------

  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-sim-close]')) {
      close();
    } else if (t.dataset.simSide) {
      state.side = t.dataset.simSide;
      savePrefs();
      syncControls();
    } else if (t.matches('[data-sim-both]')) {
      state.both = !state.both;
      savePrefs();
      syncControls();
    } else if (t.dataset.simMode) {
      state.mode = t.dataset.simMode;
      savePrefs();
      syncControls();
    } else if (t.matches('[data-sim-go]')) {
      void scan();
    } else if (t.dataset.simSort) {
      const key = t.dataset.simSort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: -1 };
      renderResults();
    }
  });
  teamEl.addEventListener('change', () => {
    state.team = teamEl.value;
  });
  domEl.addEventListener('change', () => {
    state.minDominance = Number(domEl.value) || 0;
    renderResults();
  });
  topEl.addEventListener('change', () => {
    state.top = Number(topEl.value) || 0;
    renderResults();
  });
  outcomeEl.addEventListener('change', () => {
    state.outcome = outcomeEl.value;
    renderResults();
  });

  function open() {
    if (state.open) return;
    state.open = true;
    el.hidden = false;
    syncContext();
    syncControls();
    // The clock and the drawing change under the panel while it is open.
    pollTimer = window.setInterval(syncContext, 300);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    el.hidden = true;
    clearInterval(pollTimer);
    pollTimer = 0;
    onToggle?.(false);
  }

  return {
    el,
    get isOpen() {
      return state.open;
    },
    open,
    close,
    toggle() {
      if (state.open) close();
      else open();
      return state.open;
    },
    /** Told when the panel closes itself, so the toolbar button follows. */
    onToggle(fn) {
      onToggle = fn;
    },
    destroy() {
      state.running?.abort();
      clearInterval(pollTimer);
      el.remove();
    }
  };
}
