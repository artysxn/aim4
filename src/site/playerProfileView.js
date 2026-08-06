// ---------------------------------------------------------------------------
// site/playerProfileView.js
// One player, everything the library knows about them.
//
// The Database can already show a player's per-match rows, but only from inside
// a table, behind a filter, with no address of their own. A player is the unit
// people actually talk about ("look at what he does on Mirage as CT"), so they
// get a page: one URL, one identity, and the splits that answer that sentence.
//
// Everything here is aggregation over the stats index the Database already
// fetches. Nothing new is computed server-side and nothing re-reads a round.
// ---------------------------------------------------------------------------

import { fetchStats, formatApiError } from '../replays/api.js';
import { MAPS } from '../replays/shared/roundId.js';
import { aggregatePlayers, allRows, indexMaps } from '../replays/shared/statsMath.js';
import { spinnerHtml } from '../lib/spinner.js';

/** Below this a split is noise, so it is shown as a dash rather than a number. */
const MIN_SPLIT_ROUNDS = 20;

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '—');

/**
 * A rating as a 0..1 position on a bar.
 *
 * 0.60 to 1.40 covers everyone who is not a statistical accident, and clamping
 * outside it keeps one 3.00 rating from flattening the whole column.
 */
function ratingFill(rating) {
  if (!Number.isFinite(rating)) return 0;
  return Math.max(0, Math.min(1, (rating - 0.6) / 0.8));
}

/** Rating over time as a bare polyline. One demo per point, oldest first. */
function sparklineHtml(points) {
  if (points.length < 2) return '';
  const w = 260;
  const h = 44;
  const pad = 3;
  const values = points.map((p) => p.rating);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p.rating - lo) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="pp-spark" viewBox="0 0 ${w} ${h}" role="img"
    aria-label="Rating over the last ${points.length} matches">
    <polyline points="${coords.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

export function initPlayerProfileView({ escapeHtml }) {
  const host = document.querySelector('.view[data-view="player"] .view-pad');

  /** The whole readable library, fetched once and reused across profiles. */
  let payload = null;
  let loading = null;
  let currentId = '';

  async function ensurePayload() {
    if (payload) return payload;
    if (!loading) {
      loading = fetchStats()
        .then((res) => {
          payload = res;
          return res;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  /**
   * Aggregate one player under a filter.
   * Returns null when the filter leaves them with no rounds.
   */
  function statsFor(rows, players, demos, id, filter = {}) {
    const list = aggregatePlayers(rows, players, filter, demos);
    return list.find((p) => p.id === id) || null;
  }

  function headerHtml(p, id) {
    const name = p?.name || id;
    return `
      <header class="pp-head">
        <div class="pp-identity">
          <h2 class="pp-name">${escapeHtml(name)}</h2>
          ${p?.teamLabel ? `<span class="pp-team">${escapeHtml(p.teamLabel)}</span>` : ''}
        </div>
        <div class="pp-headline">
          <div class="pp-stat">
            <span class="pp-stat-value">${f2(p?.a4r ?? p?.rating)}</span>
            <span class="pp-stat-label">Rating</span>
          </div>
          <div class="pp-stat">
            <span class="pp-stat-value">${f2(p?.kd)}</span>
            <span class="pp-stat-label">K/D</span>
          </div>
          <div class="pp-stat">
            <span class="pp-stat-value">${f1(p?.adr)}</span>
            <span class="pp-stat-label">ADR</span>
          </div>
          <div class="pp-stat">
            <span class="pp-stat-value">${pct(p?.kast)}</span>
            <span class="pp-stat-label">KAST</span>
          </div>
          <div class="pp-stat">
            <span class="pp-stat-value">${p?.rounds ?? 0}</span>
            <span class="pp-stat-label">Rounds</span>
          </div>
        </div>
      </header>`;
  }

  /**
   * Form: the player's rating in each match, oldest first.
   *
   * Per demo rather than per round, because one round's rating is a coin flip
   * and nobody reads a trend out of it.
   */
  function formHtml(rows, players, demos, id) {
    const byDemo = new Map();
    for (const r of rows) {
      if (!byDemo.has(r.d)) byDemo.set(r.d, []);
      byDemo.get(r.d).push(r);
    }
    const points = [];
    for (const [demoId, demoRows] of byDemo) {
      const p = statsFor(demoRows, players, demos, id);
      if (!p || !p.rounds) continue;
      points.push({
        demoId,
        rating: p.a4r ?? p.rating,
        when: demos?.get?.(demoId)?.uploadedAt || 0
      });
    }
    points.sort((a, b) => a.when - b.when);
    if (!points.length) return '';
    const recent = points.slice(-10);
    const avg = (list) => list.reduce((s, x) => s + x.rating, 0) / list.length;
    const last5 = recent.slice(-5);
    const delta = points.length > 5 ? avg(last5) - avg(points) : null;
    return `
      <section class="pp-card pp-form">
        <h3 class="pp-card-title">Form</h3>
        <div class="pp-form-body">
          ${sparklineHtml(recent)}
          <div class="pp-form-facts">
            <span class="pp-form-value">${f2(avg(last5))}</span>
            <span class="pp-form-label">last ${last5.length} matches</span>
            ${
              Number.isFinite(delta)
                ? `<span class="pp-delta ${delta >= 0 ? 'up' : 'down'}">${
                    delta >= 0 ? '+' : ''
                  }${delta.toFixed(2)} vs career</span>`
                : ''
            }
          </div>
        </div>
      </section>`;
  }

  /** T and CT side by side. Same columns, so the difference is the point. */
  function sidesHtml(rows, players, demos, id) {
    const sides = [
      { key: 'T', label: 'T' },
      { key: 'CT', label: 'CT' }
    ].map((s) => ({ ...s, p: statsFor(rows, players, demos, id, { side: s.key }) }));
    if (!sides.some((s) => s.p?.rounds)) return '';
    return `
      <section class="pp-card">
        <h3 class="pp-card-title">By side</h3>
        <div class="pp-sides">
          ${sides
            .map(
              (s) => `
            <div class="pp-side" data-side="${s.key}">
              <span class="pp-side-label">${s.label}</span>
              <span class="pp-side-rating">${f2(s.p?.a4r ?? s.p?.rating)}</span>
              <div class="pp-bar"><span style="width:${(
                ratingFill(s.p?.a4r ?? s.p?.rating) * 100
              ).toFixed(0)}%"></span></div>
              <span class="pp-side-meta">${s.p?.rounds || 0} rounds · ${f1(
                s.p?.adr
              )} ADR · ${f2(s.p?.kd)} K/D</span>
            </div>`
            )
            .join('')}
        </div>
      </section>`;
  }

  /** Per map, ordered by how much the player has actually played it. */
  function mapsHtml(rows, players, demos, id) {
    const codes = [...new Set(rows.map((r) => r.m).filter(Boolean))];
    const list = [];
    for (const code of codes) {
      const p = statsFor(rows, players, demos, id, { maps: [code] });
      if (!p?.rounds) continue;
      const t = statsFor(rows, players, demos, id, { maps: [code], side: 'T' });
      const ct = statsFor(rows, players, demos, id, { maps: [code], side: 'CT' });
      list.push({ code, p, t, ct });
    }
    if (!list.length) return '';
    list.sort((a, b) => b.p.rounds - a.p.rounds);
    const split = (s) =>
      s && s.rounds >= MIN_SPLIT_ROUNDS ? f2(s.a4r ?? s.rating) : '—';
    return `
      <section class="pp-card">
        <h3 class="pp-card-title">By map</h3>
        <table class="pp-table">
          <thead><tr>
            <th>Map</th><th>Rounds</th><th>Rating</th><th>T</th><th>CT</th><th>ADR</th><th>K/D</th>
          </tr></thead>
          <tbody>
            ${list
              .map(
                (m) => `<tr>
              <td>${escapeHtml(MAPS[m.code]?.name || m.code)}</td>
              <td>${m.p.rounds}</td>
              <td class="pp-num-strong">${f2(m.p.a4r ?? m.p.rating)}</td>
              <td>${split(m.t)}</td>
              <td>${split(m.ct)}</td>
              <td>${f1(m.p.adr)}</td>
              <td>${f2(m.p.kd)}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </section>`;
  }

  /**
   * The duel profile: what the model expected, and what actually happened.
   *
   * xK is expected kills per round from the duel model. Putting it next to the
   * kills that landed is the one comparison that separates "wins the fights he
   * should" from "takes fights he should not".
   */
  function duelsHtml(p) {
    const kpr = p?.rounds ? p.kills / p.rounds : null;
    const over = Number.isFinite(p?.xk) && Number.isFinite(kpr) ? kpr - p.xk : null;
    if (!Number.isFinite(p?.xk) && !Number.isFinite(p?.opatt)) return '';
    return `
      <section class="pp-card">
        <h3 class="pp-card-title">Duels</h3>
        <div class="pp-grid">
          <div class="pp-cell">
            <span class="pp-cell-value">${f2(p?.xk)}</span>
            <span class="pp-cell-label">xK per round</span>
          </div>
          <div class="pp-cell">
            <span class="pp-cell-value">${f2(kpr)}</span>
            <span class="pp-cell-label">Kills per round</span>
          </div>
          <div class="pp-cell">
            <span class="pp-cell-value ${
              Number.isFinite(over) ? (over >= 0 ? 'up' : 'down') : ''
            }">${Number.isFinite(over) ? `${over >= 0 ? '+' : ''}${over.toFixed(2)}` : '—'}</span>
            <span class="pp-cell-label">Conversion</span>
          </div>
          <div class="pp-cell">
            <span class="pp-cell-value">${pct(p?.tfw)}</span>
            <span class="pp-cell-label">Duel win</span>
          </div>
          <div class="pp-cell">
            <span class="pp-cell-value">${f2(p?.opatt)}</span>
            <span class="pp-cell-label">Opening attempts / r</span>
          </div>
          <div class="pp-cell">
            <span class="pp-cell-value">${pct(p?.opkRate)}</span>
            <span class="pp-cell-label">Opening win</span>
          </div>
        </div>
      </section>`;
  }

  function renderProfile(id, fallbackName) {
    const { players, demos } = indexMaps(payload);
    const rows = allRows(payload);
    const all = statsFor(rows, players, demos, id);
    if (!all) {
      host.innerHTML = `
        <div class="pp-shell">
          ${headerHtml({ name: fallbackName || id }, id)}
          <p class="view-empty">No rounds for this player in the demos you can open.</p>
        </div>`;
      return;
    }
    // Only the demos this player is actually in, so per-map and form work
    // do not walk the whole library twice.
    const mine = rows.filter((r) => players.get(`${r.d}:${id}`));
    host.innerHTML = `
      <div class="pp-shell">
        ${headerHtml(all, id)}
        ${formHtml(mine, players, demos, id)}
        <div class="pp-columns">
          ${sidesHtml(mine, players, demos, id)}
          ${duelsHtml(all)}
        </div>
        ${mapsHtml(mine, players, demos, id)}
      </div>`;
  }

  return {
    async onShow(params = {}) {
      if (!host) return;
      const id = String(params.id || '').trim();
      const name = String(params.name || '').trim();
      if (!id) {
        host.innerHTML = '<p class="view-empty">No player selected.</p>';
        return;
      }
      currentId = id;
      host.innerHTML = spinnerHtml('Loading player…');
      try {
        await ensurePayload();
      } catch (err) {
        host.innerHTML = `<p class="view-empty">${escapeHtml(formatApiError(err))}</p>`;
        return;
      }
      // A second navigation while this one was loading wins.
      if (currentId !== id) return;
      renderProfile(id, name);
    },
    onHide() {}
  };
}
