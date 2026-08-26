// ---------------------------------------------------------------------------
// site/performanceView.js
// One player: Summary (rating, cards, roles, form, matches), Guns, and Maps.
// Maps is the roles grid over again, then a T and a CT round-type table for
// every map in the library.
//
// A team gets Summary and Maps. Same chapters, different subject: its Maps
// tables carry the team's own numbers per call (round win rate, the opening
// duel, 5v4 and 4v5) instead of one player's rating, and its Summary lists the
// roster. There is no Guns chapter for a team.
// ---------------------------------------------------------------------------

import { getStatsPayload } from '../replays/statsCache.js';
import {
  fetchAggregate,
  fetchPeerAverages,
  fetchRoster,
  fetchVrsRanks,
  formatApiError
} from '../replays/api.js';
import {
  demosForPlayer,
  demosForTeam,
  rosterPlayers,
  rosterTeamPlayers,
  rosterTeams
} from '../replays/shared/rosterQuery.js';
import { ECONOMIES, MAPS, economyLabel } from '../replays/shared/roundId.js';
import { indexMaps } from '../replays/shared/statsMath.js';
import {
  CARD_METRICS,
  LAST_MATCH_OPTS,
  PERF_MAPS,
  TEAM_CARD_METRICS,
  TEAM_HERO,
  TEAM_PEER_MIN_ROUNDS,
  curvePath,
  f1,
  f2,
  findPlayerByUsername,
  matchSeries,
  pct,
  playerDemos,
  playerRows,
  playerStats,
  roleGrid,
  signed,
  smoothSeries,
  teamMatchSeries,
  teamStats
} from '../replays/performance/performanceMath.js';
import { aggregateGuns, gunMapForPlayer } from '../replays/performance/gunStats.js';
import {
  MAP_ROUND_CODES,
  mapRoundGrid,
  teamMapRoundGrid
} from '../replays/performance/mapRoundStats.js';
import {
  mapRoundBlocksHtml,
  teamMapRoundBlocksHtml
} from '../replays/performance/mapRoundTables.js';
import { DELTA_BANDS, withDeltaHtml } from '../replays/performance/deltaMark.js';
import {
  attachTips,
  bindStatsHScroll,
  playerMatchColumns,
  statsTableHtml,
  teamMatchColumns
} from '../replays/stats/statsTables.js';
import { iconImgHtml } from '../replays/viewer/equipmentIcons.js';
import { setSpinnerLabel, spinnerHtml, statsProgressLabel } from '../lib/spinner.js';
import calendarIcon from '../icons/icon_calendar.svg?url';
import { mbWrap } from '../icons/menubuttons.js';
import { placeRankMenu, rankFilterHtml, syncRankSummary } from '../replays/shared/vrsRanks.js';
import './performance.css';

const CHAPTERS = [
  { key: 'summary', label: 'Summary' },
  { key: 'guns', label: 'Guns' },
  { key: 'maps', label: 'Maps' }
];

/** A team has no held-gun table: Guns is a question about one pair of hands. */
const TEAM_CHAPTERS = CHAPTERS.filter((c) => c.key !== 'guns');

function fmtMetric(fmt, n) {
  if (fmt === 'pct') return pct(n);
  if (fmt === 'signed') return signed(n);
  if (fmt === 'num1') return f1(n);
  return f2(n);
}

function sparkline(values) {
  const pts = (values || []).filter((n) => Number.isFinite(n));
  if (pts.length < 2) return '';
  const w = 88;
  const h = 28;
  const pad = 2;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const d = pts
    .map((v, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - lo) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="pf-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${d}" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

/**
 * Match-by-match trend: the raw line plus a 5-match moving average.
 *
 * `read` picks the metric off a series point, so the same chart serves the
 * player page (rating) and the team page (round win rate) rather than each
 * growing its own copy.
 */
function trendChart(points, { read = (p) => p.rating, label = 'Rating' } = {}) {
  if (points.length < 2) return '<p class="view-empty">Not enough matches for a trend.</p>';
  const raw = points.map(read);
  const values = raw.filter((n) => Number.isFinite(n));
  if (values.length < 2) return '<p class="view-empty">Not enough matches for a trend.</p>';
  const smooth = smoothSeries(raw, 5);
  const w = Math.max(1, points.length) * 40;
  const h = 180;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const lo = Math.min(...values, ...smooth.filter((n) => Number.isFinite(n)));
  const hi = Math.max(...values, ...smooth.filter((n) => Number.isFinite(n)));
  const span = hi - lo || 0.2;
  const xAt = (i) => padL + (i / (points.length - 1)) * (w - padL - padR);
  const yAt = (v) => padT + (1 - (v - lo) / span) * (h - padT - padB);
  const line = (arr) =>
    arr
      .map((v, i) => (Number.isFinite(v) ? `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}` : ''))
      .filter(Boolean)
      .join(' ');
  const trendPts = smooth
    .map((v, i) => (Number.isFinite(v) ? { x: xAt(i), y: yAt(v) } : null))
    .filter(Boolean);
  const ticks = [];
  const step = points.length > 40 ? 10 : points.length > 20 ? 5 : 4;
  for (let i = 0; i < points.length; i += step) {
    ticks.push(
      `<text x="${xAt(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${i + 1}</text>`
    );
  }
  return `<div class="pf-chart-scroll" style="--pf-n:${points.length}">
    <svg class="pf-chart" viewBox="0 0 ${w} ${h}" role="img"
      aria-label="${label} over ${points.length} matches">
      <path d="${line(raw)}" fill="none" class="pf-chart-raw" />
      <path d="${curvePath(trendPts)}" fill="none" class="pf-chart-trend" />
      ${ticks.join('')}
    </svg>
  </div>`;
}

export function initPerformanceView({ auth, escapeHtml }) {
  const host = document.querySelector('.view[data-view="performance"] .view-pad');
  if (!host) return {};

  let payload = null;
  let loading = null;
  /** Roster catalogue: who is in which demo, without any stats index. */
  let roster = null;
  let rosterLoading = null;
  /** Demo ids the current payload was scoped to, so we refetch only on change. */
  let scopedTo = '';
  /** Server-computed library averages for the summary cards. */
  let peers = { metrics: {}, sample: 0 };
  /**
   * Library averages across TEAMS, for the team cards.
   *
   * Not the player peers endpoint and not derivable from `payload`: the payload
   * is scoped to this team's own matches, so averaging it would compare a team
   * against the handful of opponents it happened to play. The aggregate
   * endpoint already computes every team's row library-wide for the Database.
   */
  let teamPeers = { metrics: {}, sample: 0 };
  /** Filter stamp the team peers were fetched for. */
  let teamPeersFor = '';
  let playerId = '';
  let playerName = '';
  let teamKey = '';
  let chapter = 'summary';
  let calendarOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let matchSort = { key: 'date', dir: 'desc' };
  let gunSort = { key: 'used', dir: 'desc' };
  const ui = {
    last: 0,
    map: '',
    side: '',
    econ: null,
    dateFrom: '',
    dateTo: '',
    rankOwn: '',
    rankOpp: ''
  };

  const maps = () => indexMaps(payload || { demos: [] });

  /**
   * The catalogue, not the library. A few hundred KB, and it is all the search
   * box and the "which matches" question ever needed.
   */
  async function ensureRoster() {
    if (roster) return roster;
    if (!rosterLoading) {
      rosterLoading = fetchRoster()
        .then((res) => {
          roster = res;
          return res;
        })
        .finally(() => {
          rosterLoading = null;
        });
    }
    return rosterLoading;
  }

  /**
   * Stats for the selected player only.
   *
   * Was `getStatsPayload(null)` — every column of every round of all 4100
   * demos, to draw six cards for one person. The roster resolves the matches
   * first, and the `rating` contract drops the columns this page never reads.
   */
  /**
   * Cache key for the scoped payload.
   *
   * The column contract belongs in it, not just the demo ids: a team and one of
   * its players can resolve to the same matches, and reusing a payload fetched
   * under the other contract would silently leave half the page's metrics blank.
   */
  function scopeStamp(ids) {
    return `${playerId ? 'rating' : 'teamRating'}:${ids.join(',')}`;
  }

  async function ensurePayload() {
    await Promise.all([ensureRoster(), fetchVrsRanks().catch(() => {})]);
    const ids = playerId
      ? demosForPlayer(roster, playerId)
      : teamKey
        ? demosForTeam(roster, teamKey)
        : [];
    // Nothing selected yet: the search box runs off the catalogue, so there is
    // no reason to fetch a single index.
    if (!ids.length) {
      payload = { demos: [] };
      scopedTo = '';
      return payload;
    }
    const stamp = scopeStamp(ids);
    if (payload && scopedTo === stamp) return payload;
    if (!loading) {
      loading = getStatsPayload(ids, {
        // A team's page reads team rates (PRW, AC%, utility damage) that the
        // player contract does not carry; a player's page reads roles and held
        // guns that the team contract does not.
        columns: playerId ? 'rating' : 'teamRating',
        onProgress: (p) => {
          if (host) setSpinnerLabel(host, statsProgressLabel(p));
        }
      })
        .then((res) => {
          payload = res;
          scopedTo = stamp;
          return res;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  /** Library averages, computed server-side. Silent failure leaves the cards bare. */
  async function ensurePeers() {
    try {
      peers = await fetchPeerAverages({
        map: ui.map,
        dateFrom: ui.dateFrom,
        dateTo: ui.dateTo
      });
    } catch {
      peers = { metrics: {}, sample: 0 };
    }
    return peers;
  }

  /**
   * Library averages across teams, one request, cached per filter stamp.
   *
   * Only the filters the endpoint understands are sent. `last` (last-N matches)
   * is deliberately not among them: it scopes THIS team's history, and applying
   * it to the comparison line would move the baseline every time the reader
   * changed how far back they were looking.
   */
  async function ensureTeamPeers() {
    const stamp = [ui.map || '', ui.side || '', ui.dateFrom || '', ui.dateTo || ''].join('|');
    if (teamPeersFor === stamp) return false;
    try {
      const res = await fetchAggregate(
        {
          maps: ui.map ? [ui.map] : [],
          side: ui.side || '',
          dateFrom: ui.dateFrom || '',
          dateTo: ui.dateTo || ''
        },
        { tables: 'teams' }
      );
      const list = (res?.teams || []).filter((t) => (t.rounds || 0) >= TEAM_PEER_MIN_ROUNDS);
      const metrics = {};
      for (const m of [TEAM_HERO, ...TEAM_CARD_METRICS]) {
        const vals = list.map(m.read).filter((n) => Number.isFinite(n));
        metrics[m.key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
      teamPeers = { metrics, sample: list.length };
      teamPeersFor = stamp;
    } catch (err) {
      teamPeers = { metrics: {}, sample: 0 };
      // A cold statistics store heals on its own. Ask again once it should be
      // warmer, so the comparison line fills in without the reader having to
      // touch a filter. Anything else stays what it was: cards without the
      // library line, retried on the next filter change.
      const body = err?.status === 503 ? err.body : null;
      if (body?.building && !body?.disabled) {
        setTimeout(() => {
          if (!visible || !teamKey || teamPeersFor === stamp) return;
          void ensureTeamPeers().then((fetched) => {
            if (fetched && visible && teamKey) render();
          });
        }, 4000);
      }
    }
    return true;
  }

  /**
   * Re-render after a filter change, then again if the team comparison line
   * had to be refetched for the new filter. Two paints rather than one, but the
   * team's own numbers appear immediately instead of waiting on the library.
   */
  function renderAfterFilterChange() {
    render();
    if (playerId || !teamKey) return;
    const before = teamKey;
    void ensureTeamPeers().then((fetched) => {
      if (fetched && teamKey === before) render();
    });
  }

  function writeUrl() {
    const q = new URLSearchParams();
    if (playerId) q.set('player', playerId);
    if (playerName) q.set('name', playerName);
    if (teamKey && !playerId) q.set('team', teamKey);
    if (chapter && chapter !== 'summary') q.set('chapter', chapter);
    const search = q.toString() ? `?${q}` : '';
    const target = `/performance${search}`;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState({ route: 'performance' }, '', target);
    }
  }

  /**
   * Whether this page is the one on screen.
   *
   * `#page-head-actions` is a SINGLE element shared by every page, and this one
   * writes its search box into it. Several paints here are deferred — peer
   * averages landing, an auth change, the roster fetch that `show` awaits — and
   * they guarded only on the SELECTION still matching, never on the page still
   * being visible. Navigate away while one is in flight and it repainted the
   * search under somebody else's title, most visibly over the demo viewer.
   * The router and `onHide` both clear the slot; neither can help against a
   * write that arrives afterwards, so the write is what has to check.
   */
  let visible = false;

  function mountHead() {
    const slot = document.getElementById('page-head-actions');
    if (!slot || !visible) return;
    const list = playerId ? CHAPTERS : teamKey ? TEAM_CHAPTERS : null;
    const chapters = list
      ? `<nav class="an-chapters" aria-label="Performance">
        ${list
          .map(
            (c) =>
              `<button type="button" class="an-chapter-btn${c.key === chapter ? ' active' : ''}" data-pf-chapter="${c.key}">${escapeHtml(c.label)}</button>`
          )
          .join('')}
      </nav>`
      : '';
    slot.innerHTML = `
      <div class="pf-search-wrap">
        <input class="site-input pf-search" data-pf-search type="search" placeholder="Player or team"
          spellcheck="false" autocomplete="off" aria-label="Search player or team" value="${escapeHtml(searchQuery)}">
        <div class="pf-suggest rp-typeahead" data-pf-suggest hidden></div>
      </div>
      ${chapters}`;
  }

  function suggestions() {
    const needle = searchQuery.trim().toLowerCase();
    const players = rosterPlayers(roster, '', Infinity);
    const teams = rosterTeams(roster, '', Infinity);
    const out = [];
    if (!needle) {
      for (const t of teams.slice(0, 8)) {
        out.push({ kind: 'team', key: t.key, label: t.name, sub: `${t.playerIds?.length || 0}` });
      }
      return out;
    }
    for (const t of teams) {
      if (t.name.toLowerCase().includes(needle) || String(t.key).toLowerCase().includes(needle)) {
        out.push({ kind: 'team', key: t.key, label: t.name, sub: `${t.playerIds?.length || 0}` });
        if (out.filter((x) => x.kind === 'team').length >= 8) break;
      }
    }
    for (const p of players) {
      if (p.name.toLowerCase().includes(needle) || String(p.id).toLowerCase().includes(needle)) {
        out.push({ kind: 'player', key: p.id, label: p.name });
        if (out.filter((x) => x.kind === 'player').length >= 12) break;
      }
    }
    return out;
  }

  function paintSuggest() {
    const menu = document.querySelector('[data-pf-suggest]');
    if (!menu) return;
    const opts = suggestions();
    menu.hidden = !searchOpen;
    if (!searchOpen) return;
    if (!opts.length) {
      menu.innerHTML = '<p class="rp-typeahead-empty">No matches</p>';
      return;
    }
    menu.innerHTML = opts
      .map((o) => {
        const kind = o.kind === 'team' ? 'Team' : 'Player';
        const sub = o.sub ? `<span class="an-muted">${escapeHtml(o.sub)}</span>` : '';
        return `<button type="button" class="an-suggest" data-pf-pick="${o.kind}|${escapeHtml(o.key)}">
          <span class="an-suggest-kind">${kind}</span>
          <span class="an-suggest-main"><strong>${escapeHtml(o.label)}</strong>${sub}</span>
        </button>`;
      })
      .join('');
  }

  function dateRangeHtml() {
    const active = Boolean(ui.dateFrom || ui.dateTo);
    return `<div class="st-filter-group st-date-wrap${calendarOpen ? ' open' : ''}${
      active ? ' has-range' : ''
    }">
      <button type="button" class="st-date-toggle${active || calendarOpen ? ' active' : ''}" data-pf-calendar
        aria-expanded="${calendarOpen ? 'true' : 'false'}" aria-label="Date range">
        <img src="${calendarIcon}" alt="" width="18" height="18" draggable="false" />
      </button>
      <div class="st-date-popover" ${calendarOpen ? '' : 'hidden'}>
        <label class="st-date-field">
          <span>From</span>
          <input class="site-input st-date" type="date" data-pf-filter="dateFrom" value="${escapeHtml(ui.dateFrom)}" aria-label="From date">
        </label>
        <label class="st-date-field">
          <span>To</span>
          <input class="site-input st-date" type="date" data-pf-filter="dateTo" value="${escapeHtml(ui.dateTo)}" aria-label="To date">
        </label>
      </div>
    </div>`;
  }

  /**
   * @param {{ withSide?: boolean }} [opts]
   *   Maps drops the side switch: every table on that chapter already is one
   *   side, and half of each is deliberately the rounds spent on the other.
   */
  function filtersHtml({ withSide = true } = {}) {
    const mapOpts = PERF_MAPS.map(
      (m) =>
        `<option value="${escapeHtml(m.code)}"${ui.map === m.code ? ' selected' : ''}>${escapeHtml(m.name)}</option>`
    ).join('');
    const lastOpts = LAST_MATCH_OPTS.map(
      (o) =>
        `<option value="${o.value}"${Number(ui.last) === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
    ).join('');
    const econOpts = Object.entries(ECONOMIES)
      .map(
        ([code, e]) =>
          `<option value="${code}"${ui.econ != null && Number(ui.econ) === Number(code) ? ' selected' : ''}>${escapeHtml(
            e.label || economyLabel(Number(code))
          )}</option>`
      )
      .join('');
    return `<div class="st-filters pf-filters">
      ${dateRangeHtml()}
      <div class="st-filter-group">
        <select class="site-select" data-pf-filter="last" aria-label="Last matches">${lastOpts}</select>
      </div>
      <div class="st-filter-group">${mbWrap(
        'map',
        `<select class="site-select" data-pf-filter="map" aria-label="Map">
          <option value=""${!ui.map ? ' selected' : ''}>Map</option>${mapOpts}</select>`
      )}</div>
      <div class="st-filter-group">${rankFilterHtml({
        own: ui.rankOwn,
        opp: ui.rankOpp
      })}</div>
      ${
        withSide
          ? `<div class="rp-seg rp-seg-side" role="group" aria-label="Side">
        <button type="button" class="rp-seg-btn${ui.side === 'T' ? ' active' : ''}" data-pf-side="T" aria-label="T">
          <img src="/icons/icon_t.png" alt="" width="16" height="16" draggable="false" />
        </button>
        <button type="button" class="rp-seg-btn${ui.side === 'CT' ? ' active' : ''}" data-pf-side="CT" aria-label="CT">
          <img src="/icons/icon_ct.png" alt="" width="16" height="16" draggable="false" />
        </button>
      </div>`
          : ''
      }
      <div class="st-filter-group">
        <select class="site-select" data-pf-filter="econ" aria-label="Buy">
          <option value=""${ui.econ == null ? ' selected' : ''}>Buy</option>${econOpts}
        </select>
      </div>
    </div>`;
  }

  function cardsHtml(stats, series, peerMetrics) {
    return `<div class="pf-cards">
      ${CARD_METRICS.map((m) => {
        const value = m.read(stats);
        const comp = peerMetrics?.[m.key];
        const spark = sparkline(series.map((p) => p[m.key]));
        const max = Math.max(Math.abs(Number(value) || 0), Math.abs(Number(comp) || 0), 0.01) * 1.25;
        const fill = Number.isFinite(value) ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
        const notch = Number.isFinite(comp) ? Math.max(0, Math.min(100, (Math.abs(comp) / max) * 100)) : null;
        const above = Number.isFinite(value) && Number.isFinite(comp) ? value >= comp : true;
        return `<article class="pf-card">
          <div class="pf-card-top">
            <span class="pf-card-label">${escapeHtml(m.label)}</span>
            ${spark}
          </div>
          <div class="pf-card-value">${withDeltaHtml(
            fmtMetric(m.fmt, value),
            value,
            comp,
            DELTA_BANDS[m.band]
          )}</div>
          <div class="pf-bar ${above ? 'is-up' : 'is-down'}">
            <span class="pf-bar-fill" style="width:${fill.toFixed(1)}%"></span>
            ${notch != null ? `<i class="pf-bar-notch" style="left:${notch.toFixed(1)}%"></i>` : ''}
          </div>
          <div class="pf-card-comp">Comp. ${fmtMetric(m.fmt, comp)}</div>
        </article>`;
      }).join('')}
    </div>`;
  }

  function rolesHtml(grid) {
    const lib = peers?.roles || {};
    const table = (side) => {
      const roleCls = side === 'CT' ? 'st-role-ct' : 'st-role-t';
      const rows = (grid[side] || [])
        .map((r) => {
          const libPeer = r.position ? lib[r.map]?.[side]?.[r.position] : null;
          const ratingPeer = Number.isFinite(libPeer?.rating) ? libPeer.rating : r.peer;
          const swingPeer = Number.isFinite(libPeer?.swing) ? libPeer.swing : r.peerSwing;
          const ratingTip =
            Number.isFinite(r.rating) && Number.isFinite(ratingPeer)
              ? `${f2(r.rating)} vs ${f2(ratingPeer)} avg`
              : '';
          const swingTip =
            Number.isFinite(r.swing) && Number.isFinite(swingPeer)
              ? `${signed(r.swing)} vs ${signed(swingPeer)} avg`
              : '';
          return `<tr>
            <td class="left">${escapeHtml(r.mapName)}</td>
            <td class="left ${roleCls}">${escapeHtml(r.position || '—')}</td>
            <td class="${ratingTip ? 'has-tip' : ''}"${ratingTip ? ` data-tip="${escapeHtml(ratingTip)}"` : ''}>${withDeltaHtml(f2(r.rating), r.rating, ratingPeer, DELTA_BANDS.rating)}</td>
            <td class="${swingTip ? 'has-tip' : ''}"${swingTip ? ` data-tip="${escapeHtml(swingTip)}"` : ''}>${withDeltaHtml(signed(r.swing), r.swing, swingPeer, DELTA_BANDS.swing)}</td>
          </tr>`;
        })
        .join('');
      return `<div class="pf-roles-col">
        <table class="st-table pf-roles-table">
          <thead><tr><th class="left">Map</th><th class="left">Role</th><th>Rating</th><th>Swing</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    };
    return `<div class="pf-roles">${table('T')}${table('CT')}</div>`;
  }

  // ---- Maps -----------------------------------------------------------------

  function mapsStatsHtml() {
    const { players, demos } = maps();
    const codes = ui.map ? MAP_ROUND_CODES.filter((c) => c === ui.map) : MAP_ROUND_CODES;
    const keep = new Set(codes);
    const full = roleGrid(payload, playerId, ui, players, demos);
    const grid = {
      T: (full.T || []).filter((r) => keep.has(r.map)),
      CT: (full.CT || []).filter((r) => keep.has(r.map))
    };
    const byMap = mapRoundGrid(payload, playerId, ui, players, demos);
    return `${rolesHtml(grid)}${mapRoundBlocksHtml(byMap, codes, escapeHtml)}`;
  }

  function matchesHtml(series) {
    const rows = series.map((p) => ({
      ...p.stats,
      demoId: p.demoId,
      map: p.map,
      mapName: MAPS[p.map]?.name || p.map,
      opponent: p.opponent || '—',
      result: p.result || '—',
      uploadedAt: p.when,
      scoreLabel: p.scoreLabel || '',
      scoreSort: p.scoreSort ?? 0
    }));
    const cols = playerMatchColumns();
    return statsTableHtml(rows, {
      columns: cols.columns.filter((c) => c.key !== 'a4r'),
      fixedCount: cols.fixedCount,
      escapeHtml,
      sortKey: matchSort.key,
      sortDir: matchSort.dir,
      showAverage: true
    });
  }

  function gunsHtml(rows) {
    if (!rows.length) return '<p class="view-empty">No gun rounds in this selection.</p>';
    const sorted = [...rows].sort((a, b) => {
      const dir = gunSort.dir === 'asc' ? 1 : -1;
      const av = a[gunSort.key];
      const bv = b[gunSort.key];
      const an = Number.isFinite(av) ? av : gunSort.dir === 'asc' ? Infinity : -Infinity;
      const bn = Number.isFinite(bv) ? bv : gunSort.dir === 'asc' ? Infinity : -Infinity;
      if (gunSort.key === 'label') return dir * String(a.label).localeCompare(String(b.label));
      return dir * (an - bn);
    });
    const th = (key, label, cls = '') => {
      const on = gunSort.key === key;
      const arrow = on ? (gunSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="${cls}${on ? ' sorted' : ''}" data-pf-gun-sort="${key}">${escapeHtml(label)}${arrow}</th>`;
    };
    const body = sorted
      .map(
        (r) => `<tr>
          <td class="left pf-gun-name">${iconImgHtml(r.gun, 'pf-gun-icon')} ${escapeHtml(r.label)}</td>
          <td>${pct(r.used * 100)}</td>
          <td>${f2(r.rating)}</td>
          <td>${signed(r.swing)}</td>
          <td>${Number.isFinite(r.accuracy) ? pct(r.accuracy) : '—'}</td>
          <td>${f2(r.kpr)}</td>
          <td>${f2(r.xk)}</td>
          <td class="${r.openKills + r.openDeaths > 0 ? 'has-tip' : ''}"${
            r.openKills + r.openDeaths > 0
              ? ` data-tip="${escapeHtml(`${r.openKills} opening kills, ${r.openDeaths} opening deaths`)}"`
              : ''
          }>${Number.isFinite(r.opkRate) ? pct(r.opkRate) : '—'}</td>
        </tr>`
      )
      .join('');
    return `<table class="st-table pf-guns-table">
      <thead><tr>
        ${th('label', 'Weapon', 'left ')}${th('used', 'Used')}${th('rating', 'Rating')}
        ${th('swing', 'Swing')}${th('accuracy', 'Acc')}${th('kpr', 'KPR')}${th('xk', 'xK')}
        ${th('opkRate', 'OPK')}
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  /** The roster strip, kept from the old team page: every name opens that player. */
  function teamRosterHtml() {
    const people = rosterTeamPlayers(roster, teamKey);
    if (!people.length) return '';
    return `<section class="pf-team-roster">
      <h3 class="pf-section-title">Roster</h3>
      <div class="pf-team-list">
        ${people
          .map(
            (p) =>
              `<button type="button" class="pf-team-player" data-pf-pick="player|${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`
          )
          .join('')}
      </div>
    </section>`;
  }

  /**
   * Cards for a team.
   *
   * Same shape as the player cards — value, sparkline, comparison notch — over
   * a different metric list. Kept as its own function rather than a parameter
   * on cardsHtml because the two differ in what "comp" means: a player is
   * measured against other players, a team against other teams.
   */
  function teamCardsHtml(stats, series, peerMetrics) {
    return `<div class="pf-cards">
      ${TEAM_CARD_METRICS.map((m) => {
        const value = m.read(stats);
        const comp = peerMetrics?.[m.key];
        const spark = sparkline(series.map((p) => p[m.key]));
        const max = Math.max(Math.abs(Number(value) || 0), Math.abs(Number(comp) || 0), 0.01) * 1.25;
        const fill = Number.isFinite(value) ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
        const notch = Number.isFinite(comp) ? Math.max(0, Math.min(100, (Math.abs(comp) / max) * 100)) : null;
        const above = Number.isFinite(value) && Number.isFinite(comp) ? value >= comp : true;
        return `<article class="pf-card">
          <div class="pf-card-top">
            <span class="pf-card-label">${escapeHtml(m.label)}</span>
            ${spark}
          </div>
          <div class="pf-card-value">${withDeltaHtml(
            fmtMetric(m.fmt, value),
            value,
            comp,
            DELTA_BANDS[m.band]
          )}</div>
          <div class="pf-bar ${above ? 'is-up' : 'is-down'}">
            <span class="pf-bar-fill" style="width:${fill.toFixed(1)}%"></span>
            ${notch != null ? `<i class="pf-bar-notch" style="left:${notch.toFixed(1)}%"></i>` : ''}
          </div>
          <div class="pf-card-comp">Comp. ${fmtMetric(m.fmt, comp)}</div>
        </article>`;
      }).join('')}
    </div>`;
  }

  /** Per-match table for a team: the Database's team match columns. */
  function teamMatchesHtml(series) {
    const rows = series.map((p) => ({
      ...p.stats,
      demoId: p.demoId,
      map: p.map,
      mapName: MAPS[p.map]?.name || p.map,
      opponent: p.opponent || '\u2014',
      result: p.result || '\u2014',
      uploadedAt: p.when,
      scoreLabel: p.scoreLabel || '',
      scoreSort: p.scoreSort ?? 0
    }));
    const cols = teamMatchColumns();
    return statsTableHtml(rows, {
      columns: cols.columns,
      fixedCount: cols.fixedCount,
      escapeHtml,
      sortKey: matchSort.key,
      sortDir: matchSort.dir,
      showAverage: true
    });
  }

  /**
   * The team Summary chapter, without the toolbar around it.
   *
   * Its own function because a filter change repaints exactly this \u2014 see
   * refreshStats. The player summary still inlines its twin in two places;
   * that duplication is not worth copying into a third.
   */
  function teamStatsHtml() {
    const team = rosterTeams(roster, '', Infinity).find((t) => t.key === teamKey);
    if (!team) return `<p class="view-empty">That team is not in the library.</p>`;
    const { players, demos } = maps();
    const stats = teamStats(payload, teamKey, ui, players, demos);
    const series = teamMatchSeries(payload, teamKey, ui, players, demos);
    if (!stats) {
      return `
        <div class="pf-hero">
          <div class="pf-identity"><h2 class="pf-name">${escapeHtml(team.name)}</h2></div>
        </div>
        <p class="view-empty">No rounds for ${escapeHtml(team.name)} in this selection.</p>
        ${teamRosterHtml()}`;
    }
    const peerMetrics = teamPeers?.metrics || {};
    const record =
      stats.maps > 0 ? `${stats.mapWins}\u2013${stats.mapLosses} in ${stats.maps} maps` : '';
    return `
      <div class="pf-hero">
        <div class="pf-identity">
          <h2 class="pf-name">${escapeHtml(team.name)}</h2>
          ${record ? `<span class="pf-team">${escapeHtml(record)}</span>` : ''}
        </div>
        <div class="pf-hero-rating">
          <span class="pf-hero-value">${pct(TEAM_HERO.read(stats))}</span>
          <span class="pf-hero-label">${escapeHtml(TEAM_HERO.label)}</span>
        </div>
      </div>
      ${teamCardsHtml(stats, series, peerMetrics)}
      ${teamRosterHtml()}
      <div class="pf-chart-wrap">${trendChart(series, {
        read: (p) => p.roundWinrate,
        label: 'Round win rate'
      })}</div>
      <div class="pf-matches">${teamMatchesHtml(series)}</div>`;
  }

  function teamSummaryHtml() {
    return `${filtersHtml()}<div id="pf-stats">${teamStatsHtml()}</div>`;
  }

  /**
   * Maps, for a team.
   *
   * The player's version of this chapter opens with the roles grid, which is a
   * question about one person. A team's opens straight into the round-type
   * tables: its record on the map, then every call it makes or faces there with
   * the round win rate, the opening duel, and both man-advantage conversions.
   */
  function teamMapsStatsHtml() {
    const { players, demos } = maps();
    const codes = ui.map ? MAP_ROUND_CODES.filter((c) => c === ui.map) : MAP_ROUND_CODES;
    const byMap = teamMapRoundGrid(payload, teamKey, ui, players, demos);
    return teamMapRoundBlocksHtml(byMap, codes, escapeHtml);
  }

  function teamMapsBodyHtml() {
    return `${filtersHtml({ withSide: false })}<div id="pf-stats">${teamMapsStatsHtml()}</div>`;
  }

  function summaryHtml() {
    const { players, demos } = maps();
    const stats = playerStats(payload, playerId, ui, players, demos);
    const series = matchSeries(payload, playerId, ui, players, demos);
    const grid = roleGrid(payload, playerId, ui, players, demos);
    const peerMetrics = peers?.metrics || {};
    const rating = stats?.rating;
    return `
      ${filtersHtml()}
      <div id="pf-stats">
      <div class="pf-hero">
        <div class="pf-identity">
          <h2 class="pf-name">${escapeHtml(playerName || playerId)}</h2>
          ${stats?.teamLabel ? `<span class="pf-team">${escapeHtml(stats.teamLabel)}</span>` : ''}
        </div>
        <div class="pf-hero-rating">
          <span class="pf-hero-value">${f2(rating)}</span>
          <span class="pf-hero-label">Rating</span>
        </div>
      </div>
      ${cardsHtml(stats, series, peerMetrics)}
      ${rolesHtml(grid)}
      <div class="pf-chart-wrap">${trendChart(series)}</div>
      <div class="pf-matches">${matchesHtml(series)}</div>
      </div>`;
  }

  function gunsBodyHtml() {
    const { players, demos } = maps();
    const careerRows = [];
    for (const demo of playerDemos(payload, playerId, {})) {
      for (const row of demo.rounds || []) {
        if (row.p?.[playerId]) careerRows.push(row);
      }
    }
    const allIds = playerDemos(payload, playerId, {}).map((d) => d.id);
    const gunByFile = gunMapForPlayer(careerRows, playerId, allIds);
    const rows = playerRows(payload, playerId, ui, players, demos);
    const guns = aggregateGuns(rows, playerId, players, demos, gunByFile);
    return `${filtersHtml()}<div id="pf-stats">${gunsHtml(guns)}</div>`;
  }

  function mapsBodyHtml() {
    return `${filtersHtml({ withSide: false })}<div id="pf-stats">${mapsStatsHtml()}</div>`;
  }

  function bodyHtml() {
    if (!playerId && teamKey) {
      return chapter === 'maps' ? teamMapsBodyHtml() : teamSummaryHtml();
    }
    if (!playerId) {
      return '';
    }
    if (chapter === 'maps') return mapsBodyHtml();
    if (chapter === 'guns') return gunsBodyHtml();
    return summaryHtml();
  }

  function bindChrome() {
    attachTips(host);
    bindStatsHScroll(host);
    const chart = host.querySelector('.pf-chart-scroll');
    if (chart) chart.scrollLeft = chart.scrollWidth;
  }

  function refreshStats() {
    const slot = host.querySelector('#pf-stats');
    if (!slot) return;
    if (!playerId) {
      // A team. The comparison line is fetched per map / date window, and this
      // path is only reached by filters that are not in that stamp, so the
      // cards keep the peers they already have.
      if (!teamKey) return;
      slot.innerHTML = chapter === 'maps' ? teamMapsStatsHtml() : teamStatsHtml();
      bindChrome();
      return;
    }
    if (chapter === 'guns') {
      const { players, demos } = maps();
      const careerRows = [];
      for (const demo of playerDemos(payload, playerId, {})) {
        for (const row of demo.rounds || []) {
          if (row.p?.[playerId]) careerRows.push(row);
        }
      }
      const allIds = playerDemos(payload, playerId, {}).map((d) => d.id);
      const gunByFile = gunMapForPlayer(careerRows, playerId, allIds);
      const rows = playerRows(payload, playerId, ui, players, demos);
      slot.innerHTML = gunsHtml(aggregateGuns(rows, playerId, players, demos, gunByFile));
    } else if (chapter === 'maps') {
      slot.innerHTML = mapsStatsHtml();
    } else if (chapter === 'summary') {
      const { players, demos } = maps();
      const stats = playerStats(payload, playerId, ui, players, demos);
      const series = matchSeries(payload, playerId, ui, players, demos);
      const grid = roleGrid(payload, playerId, ui, players, demos);
      const peerMetrics = peers?.metrics || {};
      const rating = stats?.rating;
      slot.innerHTML = `
      <div class="pf-hero">
        <div class="pf-identity">
          <h2 class="pf-name">${escapeHtml(playerName || playerId)}</h2>
          ${stats?.teamLabel ? `<span class="pf-team">${escapeHtml(stats.teamLabel)}</span>` : ''}
        </div>
        <div class="pf-hero-rating">
          <span class="pf-hero-value">${f2(rating)}</span>
          <span class="pf-hero-label">Rating</span>
        </div>
      </div>
      ${cardsHtml(stats, series, peerMetrics)}
      ${rolesHtml(grid)}
      <div class="pf-chart-wrap">${trendChart(series)}</div>
      <div class="pf-matches">${matchesHtml(series)}</div>`;
    }
    bindChrome();
  }

  function render() {
    if (!host) return;
    mountHead();
    host.innerHTML = bodyHtml();
    bindChrome();
    paintSuggest();
    writeUrl();
    if (!playerId && !teamKey) {
      document.querySelector('[data-pf-search]')?.focus();
    }
  }

  /**
   * Paint for the current selection. The payload is scoped to whoever is
   * selected, so changing that selection is a fetch, not just a re-render.
   */
  async function renderScoped() {
    if (!host) return;
    mountHead();
    const ids = playerId
      ? demosForPlayer(roster, playerId)
      : teamKey
        ? demosForTeam(roster, teamKey)
        : [];
    if (ids.length && scopedTo !== scopeStamp(ids)) {
      host.innerHTML = `<div class="is-loading" role="status">${spinnerHtml('Loading matches…')}</div>`;
      try {
        await ensurePayload();
      } catch (err) {
        host.innerHTML = `<p class="view-empty">${escapeHtml(
          formatApiError(err).message || 'Could not load stats.'
        )}</p>`;
        return;
      }
    }
    render();
    // Peer averages land separately: the cards render immediately with the
    // player's own numbers and gain their comparison notch a moment later.
    if (playerId) {
      const before = playerId;
      ensurePeers().then(() => {
        if (playerId === before) render();
      });
    } else if (teamKey) {
      const before = teamKey;
      ensureTeamPeers().then((fetched) => {
        if (fetched && teamKey === before) render();
      });
    }
  }

  function pickPlayer(id) {
    const p = rosterPlayers(roster, '', Infinity).find((x) => x.id === id);
    playerId = id;
    playerName = p?.name || id;
    teamKey = '';
    chapter = 'summary';
    searchQuery = '';
    searchOpen = false;
    renderScoped();
  }

  function pickTeam(key) {
    teamKey = key;
    playerId = '';
    playerName = '';
    chapter = 'summary';
    searchQuery = '';
    searchOpen = false;
    renderScoped();
  }

  function resolveDefault() {
    if (playerId) {
      const p = rosterPlayers(roster, '', Infinity).find((x) => x.id === playerId);
      if (p) playerName = p.name;
      return;
    }
    if (teamKey) return;
    const uname = auth?.username || auth?.displayName || '';
    const hit = findPlayerByUsername(rosterPlayers(roster, '', Infinity), uname);
    if (hit) {
      playerId = hit.id;
      playerName = hit.name;
    }
  }

  host.addEventListener('click', (e) => {
    const chapterBtn = e.target.closest('[data-pf-chapter]');
    if (chapterBtn) {
      chapter = chapterBtn.dataset.pfChapter || 'summary';
      render();
      return;
    }
    const pick = e.target.closest('[data-pf-pick]');
    if (pick) {
      const [kind, ...rest] = String(pick.dataset.pfPick || '').split('|');
      const key = rest.join('|');
      if (kind === 'player') pickPlayer(key);
      else if (kind === 'team') pickTeam(key);
      return;
    }
    const side = e.target.closest('[data-pf-side]');
    if (side) {
      ui.side = ui.side === side.dataset.pfSide ? '' : side.dataset.pfSide;
      renderAfterFilterChange();
      return;
    }
    const cal = e.target.closest('[data-pf-calendar]');
    if (cal) {
      e.preventDefault();
      calendarOpen = !calendarOpen;
      render();
      return;
    }
    const matchTh = e.target.closest('.pf-matches [data-sort]');
    if (matchTh) {
      const key = matchTh.dataset.sort;
      if (matchSort.key === key) matchSort.dir = matchSort.dir === 'desc' ? 'asc' : 'desc';
      else {
        matchSort.key = key;
        matchSort.dir = 'desc';
      }
      render();
      return;
    }
    const gunTh = e.target.closest('[data-pf-gun-sort]');
    if (gunTh) {
      const key = gunTh.dataset.pfGunSort;
      if (gunSort.key === key) gunSort.dir = gunSort.dir === 'asc' ? 'desc' : 'asc';
      else {
        gunSort.key = key;
        gunSort.dir = key === 'label' ? 'asc' : 'desc';
      }
      render();
    }
  });

  host.addEventListener(
    'toggle',
    (e) => {
      const details = e.target;
      if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('st-rank-dd')) {
        return;
      }
      if (details.open) {
        placeRankMenu(details);
        requestAnimationFrame(() => placeRankMenu(details));
      }
    },
    true
  );

  host.addEventListener('input', (e) => {
    const rank = e.target.closest('[data-rank]');
    if (!rank) return;
    const field = String(rank.dataset.rank || '').split('|').pop();
    if (field !== 'rankOwn' && field !== 'rankOpp') return;
    ui[field] = rank.value || '';
    syncRankSummary(rank.closest('details'), ui.rankOwn, ui.rankOpp);
    refreshStats();
  });

  host.addEventListener('change', (e) => {
    const field = e.target.closest('[data-pf-filter]');
    if (!field) return;
    const key = field.dataset.pfFilter;
    if (key === 'last') ui.last = Number(field.value) || 0;
    else if (key === 'map') ui.map = field.value || '';
    else if (key === 'econ') ui.econ = field.value === '' ? null : Number(field.value);
    else if (key === 'dateFrom' || key === 'dateTo') {
      ui[key] = field.value || '';
      if (ui.dateFrom && ui.dateTo && ui.dateFrom > ui.dateTo) {
        if (key === 'dateFrom') ui.dateTo = ui.dateFrom;
        else ui.dateFrom = ui.dateTo;
      }
      calendarOpen = true;
    }
    renderAfterFilterChange();
  });

  document.getElementById('page-head-actions')?.addEventListener('input', (e) => {
    const input = e.target.closest('[data-pf-search]');
    if (!input) return;
    searchQuery = input.value;
    searchOpen = true;
    paintSuggest();
  });

  document.getElementById('page-head-actions')?.addEventListener('focusin', (e) => {
    if (e.target.closest('[data-pf-search]')) {
      searchOpen = true;
      paintSuggest();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pf-search-wrap')) {
      if (searchOpen) {
        searchOpen = false;
        paintSuggest();
      }
    }
    if (!e.target.closest('.st-date-wrap') && calendarOpen) {
      calendarOpen = false;
      const pop = host.querySelector('.st-date-popover');
      const wrap = host.querySelector('.st-date-wrap');
      if (pop) pop.hidden = true;
      wrap?.classList.remove('open');
    }
    if (!e.target.closest('details.st-rank-dd')) {
      for (const d of host.querySelectorAll('details.st-rank-dd[open]')) d.removeAttribute('open');
    }
  });

  document.getElementById('page-head-actions')?.addEventListener('click', (e) => {
    const chapterBtn = e.target.closest('[data-pf-chapter]');
    if (chapterBtn) {
      chapter = chapterBtn.dataset.pfChapter || 'summary';
      render();
      return;
    }
    const pick = e.target.closest('[data-pf-pick]');
    if (!pick) return;
    const [kind, ...rest] = String(pick.dataset.pfPick || '').split('|');
    const key = rest.join('|');
    if (kind === 'player') pickPlayer(key);
    else if (kind === 'team') pickTeam(key);
  });

  async function show(params = {}) {
    visible = true;
    host.innerHTML = `<div class="is-loading" role="status">${spinnerHtml('Loading player list…')}</div>`;
    // The catalogue first: the selection has to be known before there is
    // anything worth fetching stats for.
    try {
      await ensureRoster();
    } catch (err) {
      host.innerHTML = `<p class="view-empty">${escapeHtml(formatApiError(err).message || 'Could not load stats.')}</p>`;
      return;
    }
    playerId = String(params.player || playerId || '').trim();
    playerName = String(params.name || playerName || '').trim();
    teamKey = String(params.team || teamKey || '').trim();
    const ch = String(params.chapter || chapter || 'summary');
    const chapters = teamKey && !playerId ? TEAM_CHAPTERS : CHAPTERS;
    chapter = chapters.some((c) => c.key === ch) ? ch : 'summary';
    resolveDefault();
    await renderScoped();
  }

  auth?.onChange?.(() => {
    if (!playerId && roster) {
      resolveDefault();
      renderScoped();
    }
  });

  return {
    onShow: show,
    onHide() {
      visible = false;
      document.getElementById('page-head-actions')?.replaceChildren();
    }
  };
}
