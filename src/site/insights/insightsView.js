// ---------------------------------------------------------------------------
// site/insights/insightsView.js
// Insights: the owner's Polymarket CS2 tracker. Seven sub pages on one shell:
//
//   Overview   mode, wallet, live and next matches, latest signals
//   Matches    every tracked match; a drawer with its price track and trades
//   Whales     wallets that made flagged bets, with their records; follow/ignore
//   Signals    every flagged trade and what the engine did with it
//   Bets       our paper or real bets, P&L
//   Stats      team underdog table, calibration, does the score predict
//   Settings   mode, lists, thresholds, staking, the PC executor, history
//
// The mode (Off / Simulation / Real money) is on top of every sub page, in its
// own colour, so paper and real money can never be confused.
// ---------------------------------------------------------------------------

import './insights.css';
import { accessToken } from '../../replays/api.js';

const API = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

export const INSIGHTS_PAGES = [
  { page: 'ins-overview', route: 'insights', label: 'Overview' },
  { page: 'ins-matches', route: 'insights-matches', label: 'Matches' },
  { page: 'ins-whales', route: 'insights-whales', label: 'Whales' },
  { page: 'ins-signals', route: 'insights-signals', label: 'Signals' },
  { page: 'ins-decisions', route: 'insights-decisions', label: 'Decisions' },
  { page: 'ins-bets', route: 'insights-bets', label: 'Bets' },
  { page: 'ins-brain', route: 'insights-brain', label: 'Brain' },
  { page: 'ins-stats', route: 'insights-stats', label: 'Stats' },
  { page: 'ins-settings', route: 'insights-settings', label: 'Settings' }
];

async function headers(extra = {}) {
  const token = await accessToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers: await headers(opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** The executor's settings live on this PC's own server, never on aim4.io. */
async function local(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: await headers(opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** True for the owner. Cached per session; the sidebar asks once. */
let accessCache = null;
export async function insightsAccess(force = false) {
  if (accessCache && !force) return accessCache;
  accessCache = (async () => {
    try {
      await api('/api/insights/access');
      return true;
    } catch {
      return false;
    }
  })();
  return accessCache;
}

// ---- formatting -------------------------------------------------------------

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function usd(v, signed = false) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  const abs = Math.abs(n);
  const body = abs >= 10000 ? nf0.format(abs) : nf2.format(abs);
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
  return `${sign}$${body}`;
}
function pct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return '-';
  return `${(Number(p) * 100).toFixed(digits)}%`;
}
function cents(p) {
  if (!Number.isFinite(Number(p))) return '-';
  return `${(Number(p) * 100).toFixed(1).replace(/\.0$/, '')}c`;
}
function ago(ts) {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return inTime(ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
function inTime(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}
function dayTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
/** A profile name, unless it is just the address spelled out again. */
const nameOf = (name, addr) => (name && !/^0x[0-9a-f]{16,}/i.test(name) ? name : short(addr));
const band = (s) => (s >= 80 ? 4 : s >= 60 ? 3 : s >= 40 ? 2 : 1);
const signCls = (v) => (v > 0.0049 ? 'ins-pos' : v < -0.0049 ? 'ins-neg' : '');

const ICON_REFRESH = '<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>';

// ---- the view ---------------------------------------------------------------

export function initInsightsView({ escapeHtml, openRoute }) {
  const esc = (s) => escapeHtml(String(s ?? ''));
  const view = document.querySelector('.view[data-view="insights"]');
  const pad = view.querySelector('.view-pad');
  const root = document.createElement('div');
  root.className = 'ins';
  pad.replaceChildren(root);

  const ui = {
    page: 'ins-overview',
    visible: false,
    timer: null,
    overview: null,
    matchesScope: 'live',
    matchesQuery: '',
    whalesSort: 'edge',
    whalesFilter: 'all',
    whalesQuery: '',
    signalKind: 'entry',
    signalAction: '',
    signalMin: 0,
    signalSource: 'live',
    betsMode: null,
    betsStatus: 'open',
    statsLine: 0.3,
    statsMin: 1,
    statsCal: 'pre',
    statsQuery: '',
    teamSort: 'dips',
    settings: null,
    localExec: undefined,
    renderSeq: 0,
    decStrategy: '',
    decAction: 'taken',
    openDecision: null,
    brainPhase: 'live',
    btKind: 'history',
    btStrategy: 'swing',
    btVariant: '',
    btDays: 30,
    backtest: null,
    betsVariant: ''
  };

  const banner = document.createElement('div');
  const tabs = document.createElement('div');
  tabs.className = 'ins-seg ins-tabs';
  tabs.innerHTML = INSIGHTS_PAGES.map((p) => `<button type="button" class="ins-seg-btn" data-tab="${p.route}" data-page="${p.page}">${p.label}</button>`).join('');
  const body = document.createElement('div');
  body.className = 'ins';
  body.style.gap = '16px';
  root.append(banner, tabs, body);

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) openRoute(b.dataset.tab);
  });

  function toast(msg, err = false) {
    const t = document.createElement('div');
    t.className = `ins-toast${err ? ' err' : ''}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), err ? 5000 : 1800);
  }

  // ---- shared bits ------------------------------------------------------------

  function rankChip(rank, listed) {
    if (listed) return `<span class="ins-rank listed" title="On your list (${esc(listed)})">${rank ? `#${rank}` : 'list'}</span>`;
    return `<span class="ins-rank" title="Global VRS rank">${rank ? `#${rank}` : 'NR'}</span>`;
  }

  function priceBar(prices, line, winner = null) {
    if (!prices) return '<span class="ins-dim">-</span>';
    const [a, b] = prices;
    const cls = (p, i) => (winner === i ? 'ins-pos' : p <= line ? 'dog' : '');
    return `<div class="ins-pbar"><div class="ins-pbar-nums"><span class="${cls(a, 0)}">${pct(a)}</span><span class="${cls(b, 1)}">${pct(b)}</span></div><div class="ins-pbar-track"><i style="width:${(a * 100).toFixed(1)}%"></i><i style="width:${(b * 100).toFixed(1)}%"></i></div></div>`;
  }

  function whenCell(m) {
    if (m.live) return `<div class="ins-when"><span class="ins-live">LIVE</span><small>${esc(scoreText(m.score))}</small></div>`;
    if (m.settledAt) return `<div class="ins-when"><span>${esc(new Date(m.start).toLocaleDateString([], { day: 'numeric', month: 'short' }))}</span><small>${esc(scoreText(m.score) || 'Final')}</small></div>`;
    return `<div class="ins-when"><span>${esc(dayTime(m.start))}</span><small>${esc(m.start > Date.now() ? inTime(m.start) : 'starting')}</small></div>`;
  }

  /** "4-9|1-0|Bo3" -> "1-0 (4-9)". Polymarket pads an unstarted map as "000-000". */
  function scoreText(score) {
    const parts = String(score || '').split('|');
    const pair = (s) => {
      const m = String(s || '').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const maps = pair(parts[1]);
    const rounds = pair(parts[0]);
    const out = [];
    if (maps) out.push(`${maps[0]}-${maps[1]}`);
    if (rounds && rounds[0] + rounds[1] > 0) out.push(`(${rounds[0]}-${rounds[1]})`);
    return out.join(' ');
  }

  function teamsCell(m) {
    return `<div class="ins-teams">${m.teams
      .map((t, i) => `<div class="ins-team${m.winner === i ? ' won' : ''}">${rankChip(m.vrs?.[i], m.listed?.[i])}<span class="ins-team-name">${esc(t)}</span></div>`)
      .join('')}<div class="ins-league">${esc([m.league, m.stage, m.format].filter(Boolean).join(' · '))}</div></div>`;
  }

  function matchRow(m) {
    return `<div class="ins-match" data-match="${esc(m.id)}">${whenCell(m)}${teamsCell(m)}${priceBar(m.prices, ui.settings?.maxPrice ?? 0.3, m.winner)}<div class="ins-chips">${m.signals ? `<span class="ins-score" data-band="${band(m.topScore)}" title="${m.signals} flagged bets, top score ${m.topScore}">${m.signals}</span>` : ''}${m.bets ? '<span class="ins-tag copied" title="We bet on this match">bet</span>' : ''}</div></div>`;
  }

  function reasonsHtml(reasons) {
    return `<div class="ins-reasons">${(reasons || []).map((r) => `<span class="ins-reason${r.pts < 0 ? ' neg' : ''}">${esc(r.label)}<b>${r.pts > 0 ? '+' : ''}${r.pts}</b></span>`).join('')}</div>`;
  }

  function actionTag(f) {
    const map = { copied: ['copied', 'Copied'], queued: ['queued', 'Order sent'], skip: ['', 'Skipped'], mirrored: ['copied', 'Exit mirrored'], history: ['', 'History'], none: ['', ''] };
    const [cls, label] = map[f.action] || ['', f.action];
    return label ? `<span class="ins-tag ${cls}">${label}</span>` : '';
  }

  function signalRow(f, opts = {}) {
    const kind = f.kind === 'entry' ? 'Bet' : f.kind === 'exit' ? 'Exit' : 'Dump';
    const who = nameOf(f.walletName, f.wallet);
    const match = f.title && opts.showMatch !== false ? `<span class="ins-title ins-link" data-match="${esc(f.eventId)}">${esc(f.teams ? f.teams.join(' vs ') : f.title)}</span>` : '';
    return `<div class="ins-sig"><span class="ins-score" data-band="${band(f.score)}">${f.score}</span><div class="ins-sig-main"><div class="ins-sig-line"><span class="ins-tag ${f.side === 'BUY' ? 'buy' : 'sell'}">${kind}</span><b>${esc(f.outcome)}</b><span class="ins-num">${usd(f.cash)}</span>${f.stackCash > f.cash ? `<span class="ins-dim" title="${f.stackFills} fills in 15 minutes">of ${usd(f.stackCash)}</span>` : ''}<span class="ins-dim">at</span><span class="ins-num">${pct(f.price, 1)}</span>${f.market === 'map' ? `<span class="ins-tag">${esc(f.marketLabel)}</span>` : ''}${f.live ? '<span class="ins-live">LIVE</span>' : ''}</div><div class="ins-sig-line"><span class="ins-link" data-wallet="${esc(f.wallet)}">${esc(who)}</span>${f.walletFollow ? '<span class="ins-tag copied">Following</span>' : ''}${match}</div>${opts.reasons === false ? '' : reasonsHtml(f.reasons)}</div><div class="ins-sig-side"><span class="ins-dim">${esc(ago(f.at))}</span>${actionTag(f)}${f.actionReason && f.action !== 'history' ? `<small>${esc(f.actionReason)}</small>` : ''}</div></div>`;
  }

  // ---- charts -------------------------------------------------------------------

  /** Team A's chance over time, with the bets that were flagged on it. */
  function priceChart(series, marks, teamA, line) {
    if (!series || series.length < 2) return '<div class="ins-empty">No price history yet</div>';
    const W = 680;
    const H = 180;
    const L = 34;
    const R = 8;
    const T = 8;
    const B = 22;
    const t0 = series[0][0];
    const t1 = Math.max(series[series.length - 1][0], ...marks.map((m) => m.t));
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (p) => T + (1 - p) * (H - T - B);
    const path = series.map(([t, p], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join('');
    const grid = [0, 0.25, 0.5, 0.75, 1].map((p) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text class="axis" x="${L - 6}" y="${y(p) + 3}" text-anchor="end">${p * 100}%</text>`).join('');
    const refs = [line, 1 - line].map((p) => `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/>`).join('');
    const ticks = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${esc(dayTime(t))}</text>`).join('');
    const dots = marks
      .filter((m) => m.t >= t0)
      .map((m, i) => `<circle class="mark${m.exit ? ' exit' : ''}" cx="${x(m.t).toFixed(1)}" cy="${y(m.p).toFixed(1)}" r="${Math.min(9, 4 + Math.log10(Math.max(1, m.cash / 50)) * 3).toFixed(1)}" data-i="${i}"/>`)
      .join('');
    const id = `c${Math.random().toString(36).slice(2, 8)}`;
    setTimeout(() => bindLineHover(id, series, marks.filter((m) => m.t >= t0), { x, y, L, R, W, H, T, B, t0, t1, label: teamA, fmt: (v) => pct(v, 1) }), 0);
    return `<div class="ins-chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${grid}${refs}${ticks}<path class="line" d="${path}"/>${dots}<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><circle class="dot" r="4" style="display:none"/></svg><div class="ins-tip" style="display:none"></div></div><div class="ins-legend"><span><i class="line" style="background:var(--ins-line)"></i>${esc(teamA)} chance</span><span><i style="background:var(--ins-whale)"></i>Flagged bet (either team)</span><span><i style="background:var(--ins-card);border:2px solid #9c9ca2"></i>Exit or dump</span><span class="ins-dim">Dashed: ${pct(line)} and ${pct(1 - line)}</span></div>`;
  }

  function bindLineHover(id, series, marks, g) {
    const host = document.getElementById(id);
    if (!host) return;
    const svg = host.querySelector('svg');
    const cross = svg.querySelector('.cross');
    const dot = svg.querySelector('.dot');
    const tip = host.querySelector('.ins-tip');
    const toLocal = (e) => {
      const r = svg.getBoundingClientRect();
      return { sx: ((e.clientX - r.left) / r.width) * g.W, px: e.clientX - r.left, py: e.clientY - r.top, r };
    };
    svg.addEventListener('mousemove', (e) => {
      const { sx, px, r } = toLocal(e);
      const mark = e.target.closest?.('.mark');
      if (mark) {
        const m = marks[Number(mark.dataset.i)];
        if (m) {
          cross.style.display = 'none';
          dot.style.display = 'none';
          tip.style.display = '';
          tip.style.left = `${px}px`;
          tip.style.top = `${(Number(mark.getAttribute('cy')) / g.H) * r.height}px`;
          tip.innerHTML = `${esc(m.label)}<small>${esc(dayTime(m.t))}</small>`;
          return;
        }
      }
      const t = g.t0 + ((sx - g.L) / (g.W - g.L - g.R)) * (g.t1 - g.t0);
      let best = series[0];
      for (const p of series) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      const cx = g.x(best[0]);
      const cy = g.y(best[1]);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.style.display = '';
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.style.display = '';
      tip.style.display = '';
      tip.style.left = `${(cx / g.W) * r.width}px`;
      tip.style.top = `${(cy / g.H) * r.height}px`;
      tip.innerHTML = `${esc(g.label)} ${esc(g.fmt(best[1]))}<small>${esc(dayTime(best[0]))}</small>`;
    });
    svg.addEventListener('mouseleave', () => {
      cross.style.display = 'none';
      dot.style.display = 'none';
      tip.style.display = 'none';
    });
  }

  /** Running realized P&L. One series, so the title names it and there is no legend box. */
  function pnlChart(curve) {
    if (!curve || curve.length < 2) return '<div class="ins-empty">P&L appears once two bets have settled</div>';
    const W = 680;
    const H = 160;
    const L = 46;
    const R = 8;
    const T = 8;
    const B = 22;
    const vals = curve.map((c) => c[1]);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const span = hi - lo || 1;
    const t0 = curve[0][0];
    const t1 = curve[curve.length - 1][0];
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / span) * (H - T - B);
    const path = curve.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const grid = [lo, (lo + hi) / 2, hi].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${esc(usd(v))}</text>`).join('');
    const zero = `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    const ticks = [t0, t1].map((t, i) => `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${esc(dayTime(t))}</text>`).join('');
    const id = `p${Math.random().toString(36).slice(2, 8)}`;
    setTimeout(() => bindLineHover(id, curve, [], { x, y, L, R, W, H, T, B, t0, t1, label: 'P&L', fmt: (v) => usd(v, true) }), 0);
    return `<div class="ins-chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${grid}${zero}${ticks}<path class="line" d="${path}"/><line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><circle class="dot" r="4" style="display:none"/></svg><div class="ins-tip" style="display:none"></div></div>`;
  }

  /** Realized win rate per price bucket (bars) against the price paid (ticks). */
  function calibrationChart(rows) {
    const W = 680;
    const H = 190;
    const L = 34;
    const R = 8;
    const T = 8;
    const B = 34;
    const n = rows.length;
    const bw = (W - L - R) / n;
    const y = (p) => T + (1 - p) * (H - T - B);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((p) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text class="axis" x="${L - 6}" y="${y(p) + 3}" text-anchor="end">${p * 100}%</text>`).join('');
    const bars = rows
      .map((r, i) => {
        const x0 = L + i * bw + 3;
        const w = bw - 6;
        const label = `<text class="axis" x="${x0 + w / 2}" y="${H - 18}" text-anchor="middle">${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}</text><text class="axis" x="${x0 + w / 2}" y="${H - 6}" text-anchor="middle">n=${r.n}</text>`;
        if (!r.n) return label;
        const top = y(r.rate);
        const bar = `<path class="bar" d="M${x0},${y(0)}V${top + 4}Q${x0},${top} ${x0 + 4},${top}H${x0 + w - 4}Q${x0 + w},${top} ${x0 + w},${top + 4}V${y(0)}Z"><title>${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%: won ${r.wins} of ${r.n} (${pct(r.rate)}), priced ${pct(r.implied)}</title></path>`;
        const tick = `<line class="tick" x1="${x0 - 2}" x2="${x0 + w + 2}" y1="${y(r.implied)}" y2="${y(r.implied)}"><title>Priced ${pct(r.implied)}</title></line>`;
        return bar + tick + label;
      })
      .join('');
    return `<div class="ins-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${grid}${bars}</svg></div><div class="ins-legend"><span><i style="background:var(--ins-line);border-radius:2px"></i>Won</span><span><i class="line" style="background:#c8c8cc"></i>Priced</span><span class="ins-dim">Bucket = team price, n = teams</span></div>`;
  }

  // ---- drawer -------------------------------------------------------------------

  let drawer = null;
  function closeDrawer() {
    drawer?.back.remove();
    drawer?.panel.remove();
    drawer = null;
  }
  function openDrawer(title, html, extraHead = '') {
    closeDrawer();
    const back = document.createElement('div');
    back.className = 'ins-drawer-back';
    const panel = document.createElement('aside');
    panel.className = 'ins-drawer ins';
    panel.innerHTML = `<div class="ins-drawer-h"><h2>${title}</h2>${extraHead}<button type="button" class="ins-btn ins-btn-icon" data-close aria-label="Close">${ICON_CLOSE}</button></div><div class="ins-drawer-b">${html}</div>`;
    back.addEventListener('click', closeDrawer);
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeDrawer();
      handleCommonClick(e);
    });
    document.body.append(back, panel);
    drawer = { back, panel };
    return panel;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer) closeDrawer();
  });

  async function showMatch(id) {
    const panel = openDrawer('Loading', '<div class="ins-empty">Loading</div>');
    try {
      const d = await api(`/api/insights/matches/${encodeURIComponent(id)}`);
      if (!drawer || drawer.panel !== panel) return;
      const m = d.match;
      const line = ui.settings?.maxPrice ?? 0.3;
      const status = m.live ? `<span class="ins-live">LIVE</span> ${esc(scoreText(m.score))}` : m.settledAt ? `Final ${esc(scoreText(m.score))}` : `${esc(dayTime(m.start))} · ${esc(m.start > Date.now() ? inTime(m.start) : 'starting')}`;
      const facts = `<div class="ins-kpis">${m.teams
        .map((t, i) => `<div class="ins-kpi"><span class="ins-kpi-l">${esc(t)} ${rankChip(m.vrs?.[i], m.listed?.[i])}</span><span class="ins-kpi-v${m.winner === i ? ' ins-pos' : ''}">${m.prices ? pct(m.prices[i]) : '-'}</span><span class="ins-kpi-s">Low ${m.min ? pct(m.min[i]) : '-'} · start ${m.pre ? pct(m.pre[i]) : '-'}</span></div>`)
        .join('')}<div class="ins-kpi"><span class="ins-kpi-l">Status</span><span class="ins-kpi-v" style="font-size:15px">${status}</span><span class="ins-kpi-s">${esc([m.league, m.stage, m.format].filter(Boolean).join(' · '))}</span></div><div class="ins-kpi"><span class="ins-kpi-l">Volume</span><span class="ins-kpi-v">${usd(m.volume)}</span><span class="ins-kpi-s">${m.signals} flagged · ${m.exits} exits</span></div></div>`;
      const why = `<div class="ins-reasons">${(m.reasons || []).map((r) => `<span class="ins-reason">${esc(r.replace(/^list:/, 'List: ').replace(/^vrs:/, 'VRS: ').replace(/^unranked:/, 'Unranked: ').replace(/^event:/, 'Event: '))}</span>`).join('')}</div>`;
      const markets = d.markets
        .filter((mk) => mk.kind === 'match' || d.flags.some((f) => f.conditionId === mk.conditionId))
        .map((mk) => {
          const flags = d.flags.filter((f) => f.conditionId === mk.conditionId);
          const marks = flags.map((f) => ({ t: f.at, p: f.outcomeIndex === 0 ? f.price : 1 - f.price, cash: f.cash, exit: f.kind !== 'entry', label: `${f.kind === 'entry' ? 'Bet' : f.kind === 'exit' ? 'Exit' : 'Dump'} ${usd(f.cash)} on ${f.outcome} at ${pct(f.price, 1)} · ${nameOf(f.walletName, f.wallet)}` }));
          return `<div class="ins-card"><div class="ins-card-h"><h3>${esc(mk.kind === 'match' ? 'Match winner' : mk.label)}</h3><span class="ins-muted ins-num">${mk.outcomes.map((o, i) => `${esc(o)} ${mk.track?.last ? pct(mk.track.last[i]) : mk.prices ? pct(mk.prices[i]) : '-'}`).join(' · ')}</span></div>${priceChart(mk.track?.series, marks, mk.outcomes[0], line)}</div>`;
        })
        .join('');
      const flags = d.flags.length ? `<div class="ins-card"><div class="ins-card-h"><h3>Flagged trades</h3><span class="ins-dim">${d.flags.length}</span></div><div class="ins-feed">${d.flags.slice(0, 80).map((f) => signalRow(f, { showMatch: false })).join('')}</div></div>` : '';
      const bets = d.bets.length ? `<div class="ins-card"><div class="ins-card-h"><h3>Our bets</h3></div>${betsTable(d.bets, false)}</div>` : '';
      const head = `${esc(m.teams.join(' vs '))}`;
      const link = m.slug ? `<a class="ins-btn" href="https://polymarket.com/event/${encodeURIComponent(m.slug)}" target="_blank" rel="noopener noreferrer">Polymarket</a>` : '';
      panel.querySelector('.ins-drawer-h h2').innerHTML = head;
      if (link) panel.querySelector('.ins-drawer-h [data-close]').insertAdjacentHTML('beforebegin', link);
      panel.querySelector('.ins-drawer-b').innerHTML = facts + why + markets + flags + bets;
    } catch (err) {
      panel.querySelector('.ins-drawer-b').innerHTML = `<div class="ins-empty">${esc(err.message)}</div>`;
    }
  }

  async function showWallet(addr) {
    const panel = openDrawer('Loading', '<div class="ins-empty">Loading</div>');
    try {
      const d = await api(`/api/insights/whales/${encodeURIComponent(addr)}`);
      if (!drawer || drawer.panel !== panel) return;
      renderWalletDrawer(panel, d);
    } catch (err) {
      panel.querySelector('.ins-drawer-b').innerHTML = `<div class="ins-empty">${esc(err.message)}</div>`;
    }
  }

  function renderWalletDrawer(panel, d) {
    const w = d.whale;
    panel.querySelector('.ins-drawer-h h2').innerHTML = `${esc(nameOf(w.name, w.addr))} <span class="ins-addr">${esc(short(w.addr))}</span>`;
    const head = panel.querySelector('.ins-drawer-h');
    head.querySelectorAll('[data-follow],[data-ignore],a.ins-btn').forEach((n) => n.remove());
    head.querySelector('[data-close]').insertAdjacentHTML(
      'beforebegin',
      `<button type="button" class="ins-btn${w.follow ? ' on' : ''}" data-follow="${esc(w.addr)}">${w.follow ? 'Following' : 'Follow'}</button><button type="button" class="ins-btn${w.ignore ? ' on' : ''}" data-ignore="${esc(w.addr)}">${w.ignore ? 'Ignored' : 'Ignore'}</button><a class="ins-btn" href="https://polymarket.com/profile/${encodeURIComponent(w.addr)}" target="_blank" rel="noopener noreferrer">Polymarket</a>`
    );
    const age = w.joinedAt ? `${Math.max(0, Math.round((Date.now() - w.joinedAt) / 86400e3))}d` : '-';
    const kpis = `<div class="ins-kpis">
      <div class="ins-kpi"><span class="ins-kpi-l">Underdog bets</span><span class="ins-kpi-v">${w.bets}</span><span class="ins-kpi-s">${w.open} open · ${w.sold} sold early</span></div>
      <div class="ins-kpi"><span class="ins-kpi-l">Won</span><span class="ins-kpi-v">${w.wins}/${w.resolved}</span><span class="ins-kpi-s">${pct(w.winRate)} won · paid ${pct(w.avgPrice)}</span></div>
      <div class="ins-kpi"><span class="ins-kpi-l" title="Settled underdog win rate, shrunk toward the price paid, minus that price. In percentage points.">Edge</span><span class="ins-kpi-v ${signCls(w.edge ?? 0)}">${w.edge === null ? '-' : `${w.edge > 0 ? '+' : ''}${(w.edge * 100).toFixed(1)}`}</span><span class="ins-kpi-s">${w.resolved} settled</span></div>
      <div class="ins-kpi"><span class="ins-kpi-l">P&L on these</span><span class="ins-kpi-v ${signCls(w.pnl)}">${usd(w.pnl, true)}</span><span class="ins-kpi-s">ROI ${pct(w.roi)} on ${usd(w.staked)}</span></div>
      <div class="ins-kpi"><span class="ins-kpi-l">Wallet</span><span class="ins-kpi-v">${age}</span><span class="ins-kpi-s">${w.markets ?? '-'} markets · ${w.cs2Share === null || w.cs2Share === undefined ? '-' : pct(w.cs2Share)} CS2 · ${usd(w.value)}</span></div>
    </div>`;
    const rows = d.entries
      .map((e) => {
        const res = e.result === 'won' ? '<span class="ins-tag won">Won</span>' : e.result === 'lost' ? '<span class="ins-tag lost">Lost</span>' : e.result === 'void' ? '<span class="ins-tag">Void</span>' : '<span class="ins-tag open">Open</span>';
        const sold = e.exitShares ? `<span class="ins-dim"> sold ${pct(e.exitShares / e.shares)}</span>` : '';
        return `<tr data-open data-match="${esc(e.eventId)}"><td>${esc(dayTime(e.at))}</td><td class="wrap">${esc(e.teams ? e.teams.join(' vs ') : e.title || '')}</td><td>${esc(e.outcome)}${e.market === 'map' ? ' <span class="ins-tag">map</span>' : ''}</td><td class="r">${pct(e.price, 1)}</td><td class="r">${usd(e.cash)}</td><td class="r"><span class="ins-score" data-band="${band(e.score || 0)}">${e.score || 0}</span></td><td>${res}${sold}</td></tr>`;
      })
      .join('');
    panel.querySelector('.ins-drawer-b').innerHTML = `${kpis}<div class="ins-table-wrap"><table class="ins-table"><thead><tr><th>When</th><th>Match</th><th>Pick</th><th class="r">Price</th><th class="r">Size</th><th class="r">Score</th><th>Result</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="ins-empty">No bets</td></tr>'}</tbody></table></div>`;
  }

  async function setWallet(addr, patch) {
    try {
      await api(`/api/insights/whales/${encodeURIComponent(addr)}`, { method: 'PATCH', body: patch });
      if (drawer) {
        const d = await api(`/api/insights/whales/${encodeURIComponent(addr)}`);
        if (drawer) renderWalletDrawer(drawer.panel, d);
      }
      if (ui.page === 'ins-whales') renderPage();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /** Links inside the page and the drawers: matches, wallets, follow/ignore. */
  function handleCommonClick(e) {
    const f = e.target.closest('[data-follow]');
    if (f) {
      e.stopPropagation();
      setWallet(f.dataset.follow, { follow: !f.classList.contains('on') });
      return true;
    }
    const ig = e.target.closest('[data-ignore]');
    if (ig) {
      e.stopPropagation();
      setWallet(ig.dataset.ignore, { ignore: !ig.classList.contains('on') });
      return true;
    }
    const w = e.target.closest('[data-wallet]');
    if (w) {
      showWallet(w.dataset.wallet);
      return true;
    }
    const m = e.target.closest('[data-match]');
    if (m && m.dataset.match) {
      showMatch(m.dataset.match);
      return true;
    }
    return false;
  }
  body.addEventListener('click', (e) => handleCommonClick(e));

  // ---- banner -------------------------------------------------------------------

  function renderBanner(o) {
    if (!o) {
      banner.innerHTML = '';
      return;
    }
    const mode = o.mode;
    const armed = o.executor?.armed;
    const dev = o.executor?.online;
    let facts = '';
    let label = '';
    if (mode === 'sim') {
      label = 'Simulation · paper money';
      facts = `<div class="ins-mode-fact"><b>${usd(o.sim.equity)}</b><span>Paper wallet</span></div><div class="ins-mode-fact"><b class="${signCls(o.sim.today)}">${usd(o.sim.today, true)}</b><span>Today</span></div><div class="ins-mode-fact"><b>${o.sim.totals.open} · ${usd(o.sim.openCost)}</b><span>Open</span></div><div class="ins-mode-fact"><b class="${signCls(o.sim.realized)}">${usd(o.sim.realized, true)}</b><span>Settled P&L</span></div>`;
    } else if (mode === 'real') {
      label = armed ? 'Real money · armed' : 'Real money · not armed';
      facts = `<div class="ins-mode-fact"><b>${o.real.cash === null ? '-' : usd(o.real.cash)}</b><span>Polymarket balance</span></div><div class="ins-mode-fact"><b>${dev ? 'Online' : 'Offline'}</b><span>PC executor${dev?.info?.geo ? ` · ${esc(dev.info.geo.country)}${dev.info.geo.blocked ? ' blocked' : ''}` : ''}</span></div><div class="ins-mode-fact"><b>${usd(o.real.todayStaked)} / ${usd(o.limits.realDailyCap)}</b><span>Staked today</span></div><div class="ins-mode-fact"><b class="${signCls(o.real.realized)}">${usd(o.real.realized, true)}</b><span>Settled P&L</span></div>`;
    } else {
      label = 'Off · nothing is copied';
      facts = `<div class="ins-mode-fact"><b>${o.tracking ? 'Tracking' : 'Paused'}</b><span>Signals</span></div>`;
    }
    const actions = `${mode === 'real' && armed ? '<button type="button" class="ins-btn ins-btn-danger" data-disarm>Disarm</button>' : ''}<button type="button" class="ins-btn ins-btn-icon" data-refresh title="Scan now" aria-label="Scan now">${ICON_REFRESH}</button>`;
    banner.className = 'ins-mode';
    banner.dataset.mode = mode;
    banner.dataset.armed = armed ? '1' : '0';
    banner.innerHTML = `<span class="ins-mode-badge">${label}</span><div class="ins-mode-facts">${facts}</div><div class="ins-mode-actions">${actions}</div>`;
  }

  banner.addEventListener('click', async (e) => {
    if (e.target.closest('[data-disarm]')) {
      try {
        await api('/api/insights/real/disarm', { method: 'POST' });
        toast('Real trading disarmed');
        await loadOverview();
        renderPage();
      } catch (err) {
        toast(err.message, true);
      }
    }
    if (e.target.closest('[data-refresh]')) {
      const b = e.target.closest('[data-refresh]');
      b.disabled = true;
      try {
        await api('/api/insights/refresh', { method: 'POST' });
        await loadOverview();
        renderPage();
      } catch (err) {
        toast(err.message, true);
      } finally {
        b.disabled = false;
      }
    }
  });

  async function loadOverview() {
    ui.overview = await api('/api/insights/overview');
    renderBanner(ui.overview);
    return ui.overview;
  }

  // ---- pages --------------------------------------------------------------------

  function kpi(label, value, sub = '', cls = '') {
    return `<div class="ins-kpi"><span class="ins-kpi-l">${label}</span><span class="ins-kpi-v ${cls}">${value}</span>${sub ? `<span class="ins-kpi-s">${sub}</span>` : ''}</div>`;
  }

  async function pageOverview() {
    const o = ui.overview || (await loadOverview());
    const w = o.mode === 'real' ? o.real : o.sim;
    const t = w.totals;
    const settled = t.won + t.lost;
    const st = o.status;
    const kpis = `<div class="ins-kpis">
      ${kpi(o.mode === 'real' ? 'Balance' : 'Paper wallet', o.mode === 'real' ? (w.cash === null ? '-' : usd(w.cash)) : usd(w.equity), o.mode === 'real' ? (o.executor?.online ? 'Executor online' : 'Executor offline') : `Started ${usd(ui.settings?.simBankroll ?? null)}`)}
      ${kpi('Today', usd(w.today, true), `${o.today.signals} signals · ${o.today.copied} copied`, signCls(w.today))}
      ${kpi('Open', `${t.open}`, `${usd(t.openCost)} in · marked ${usd(t.openMark)}`)}
      ${kpi('Settled P&L', usd(w.realized, true), `${t.won} won · ${t.lost} lost${t.sold ? ` · ${t.sold} sold` : ''}`, signCls(w.realized))}
      ${kpi('Hit rate', settled ? pct(t.won / settled) : '-', `${settled} settled`)}
      ${kpi('Tracked', `${st.tracked}`, `${st.live} live · ${st.hot} polled`)}
    </div>`;
    const live = o.live.length ? `<div class="ins-matches">${o.live.map(matchRow).join('')}</div>` : '<div class="ins-empty">No tracked match is live</div>';
    const next = o.next.length ? `<div class="ins-matches">${o.next.map(matchRow).join('')}</div>` : '<div class="ins-empty">Nothing scheduled</div>';
    const sigs = o.latest.length ? `<div class="ins-feed">${o.latest.slice(0, 12).map((f) => signalRow(f, { reasons: false })).join('')}</div>` : '<div class="ins-empty">No flagged bets yet</div>';
    const whales = o.topWallets.length
      ? `<div class="ins-table-wrap" style="border:0;background:none"><table class="ins-table"><thead><tr><th>Wallet</th><th class="r">Won</th><th class="r">Paid</th><th class="r">Edge</th><th class="r">P&L</th></tr></thead><tbody>${o.topWallets
          .map((w2) => `<tr data-open data-wallet="${esc(w2.addr)}"><td>${esc(nameOf(w2.name, w2.addr))}${w2.follow ? ' <span class="ins-tag copied">F</span>' : ''}</td><td class="r">${w2.wins}/${w2.resolved}</td><td class="r">${pct(w2.avgPrice)}</td><td class="r ${signCls(w2.edge)}">${w2.edge === null ? '-' : (w2.edge * 100).toFixed(1)}</td><td class="r ${signCls(w2.pnl)}">${usd(w2.pnl, true)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<div class="ins-empty">Wallets need settled bets first. Run a backfill in Settings.</div>';
    const statusLine = `<div class="ins-hint">Scan ${ago(st.lastDiscover)} ago · trades ${ago(st.lastWatch)} ago · ${nf0.format(st.requests.total)} requests${st.requests.throttled ? ` · ${st.requests.throttled} throttled` : ''}${st.lastError ? ` · <span class="ins-neg">${esc(st.lastError)}</span>` : ''}</div>`;
    return `${kpis}<div class="ins-grid2"><div class="ins-card"><div class="ins-card-h"><h3>Live</h3><span class="ins-dim">${o.live.length}</span></div>${live}</div><div class="ins-card"><div class="ins-card-h"><h3>Next</h3><button type="button" class="ins-btn ins-btn-sm" data-go="insights-matches">All matches</button></div>${next}</div></div><div class="ins-grid2"><div class="ins-card"><div class="ins-card-h"><h3>Latest signals</h3><button type="button" class="ins-btn ins-btn-sm" data-go="insights-signals">All signals</button></div>${sigs}</div><div class="ins-card"><div class="ins-card-h"><h3>Best wallets</h3><button type="button" class="ins-btn ins-btn-sm" data-go="insights-whales">All wallets</button></div>${whales}</div></div>${statusLine}`;
  }

  function seg(name, options, current) {
    return `<div class="ins-seg" data-seg="${name}">${options.map(([v, label]) => `<button type="button" class="ins-seg-btn${String(v) === String(current) ? ' on' : ''}" data-v="${esc(v)}">${label}</button>`).join('')}</div>`;
  }

  async function pageMatches() {
    const d = await api(`/api/insights/matches?scope=${ui.matchesScope}`);
    const q = ui.matchesQuery.trim().toLowerCase();
    const list = q ? d.matches.filter((m) => `${m.teams.join(' ')} ${m.league}`.toLowerCase().includes(q)) : d.matches;
    const line = ui.settings?.maxPrice ?? 0.3;
    const rows = list
      .map((m) => {
        const low = m.min ? m.min.map((p) => (p <= line ? `<span style="color:var(--ins-warn)">${pct(p)}</span>` : pct(p))).join(' / ') : '-';
        return `<tr data-open data-match="${esc(m.id)}"><td>${whenCell(m)}</td><td>${teamsCell(m)}</td><td style="min-width:140px">${priceBar(m.prices, line, m.winner)}</td><td class="r">${low}</td><td class="r">${m.signals ? `<span class="ins-score" data-band="${band(m.topScore)}">${m.signals}</span>` : '<span class="ins-dim">0</span>'}</td><td class="r">${m.bigCash ? usd(m.bigCash) : '-'}</td><td class="r">${usd(m.volume)}</td><td>${m.bets ? '<span class="ins-tag copied">bet</span>' : ''}</td></tr>`;
      })
      .join('');
    return `<div class="ins-bar">${seg('matchesScope', [['live', 'Live'], ['upcoming', 'Upcoming'], ['finished', 'Finished'], ['all', 'All']], ui.matchesScope)}<span class="ins-grow"></span><input class="ins-field" type="search" placeholder="Team or league" data-input="matchesQuery" value="${esc(ui.matchesQuery)}" style="width:220px"></div><div class="ins-table-wrap"><table class="ins-table"><thead><tr><th>When</th><th>Match</th><th>Now</th><th class="r">Low</th><th class="r">Flagged</th><th class="r">Biggest</th><th class="r">Volume</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="ins-empty">${ui.matchesScope === 'live' ? 'No tracked match is live' : 'No matches'}</td></tr>`}</tbody></table></div>`;
  }

  async function pageWhales() {
    const d = await api(`/api/insights/whales?sort=${ui.whalesSort}`);
    const q = ui.whalesQuery.trim().toLowerCase();
    let list = d.whales;
    if (ui.whalesFilter === 'follow') list = list.filter((w) => w.follow);
    if (ui.whalesFilter === 'ignore') list = list.filter((w) => w.ignore);
    if (ui.whalesFilter === 'proven') list = list.filter((w) => w.resolved >= 3 && (w.edge ?? 0) > 0);
    if (q) list = list.filter((w) => `${w.name} ${w.addr}`.toLowerCase().includes(q));
    const rows = list
      .slice(0, 400)
      .map((w) => {
        const age = w.joinedAt ? `${Math.max(0, Math.round((Date.now() - w.joinedAt) / 86400e3))}d` : '-';
        return `<tr data-open data-wallet="${esc(w.addr)}"><td><span class="ins-link">${esc(nameOf(w.name, w.addr))}</span>${nameOf(w.name, w.addr) !== short(w.addr) ? ` <span class="ins-addr">${esc(short(w.addr))}</span>` : ''}</td><td class="r">${w.bets}</td><td class="r">${w.wins}-${w.losses}${w.open ? ` <span class="ins-dim">+${w.open}</span>` : ''}</td><td class="r">${w.resolved ? pct(w.winRate) : '-'}</td><td class="r">${w.resolved ? pct(w.avgPrice) : '-'}</td><td class="r ${signCls(w.edge ?? 0)}">${w.edge === null ? '-' : `${w.edge > 0 ? '+' : ''}${(w.edge * 100).toFixed(1)}`}</td><td class="r ${signCls(w.pnl)}">${usd(w.pnl, true)}</td><td class="r">${w.resolved ? pct(w.roi) : '-'}</td><td class="r">${usd(w.staked)}</td><td class="r"><span class="ins-score" data-band="${band(w.avgScore)}">${Math.round(w.avgScore)}</span></td><td class="r">${age}</td><td class="r">${ago(w.lastAt)}</td><td><button type="button" class="ins-btn ins-btn-sm${w.follow ? ' on' : ''}" data-follow="${esc(w.addr)}">${w.follow ? 'Following' : 'Follow'}</button> <button type="button" class="ins-btn ins-btn-sm${w.ignore ? ' on' : ''}" data-ignore="${esc(w.addr)}">${w.ignore ? 'Ignored' : 'Ignore'}</button></td></tr>`;
      })
      .join('');
    return `<div class="ins-bar">${seg('whalesSort', [['edge', 'Edge'], ['pnl', 'P&L'], ['recent', 'Recent'], ['staked', 'Size'], ['bets', 'Bets'], ['score', 'Score']], ui.whalesSort)}${seg('whalesFilter', [['all', 'All'], ['proven', 'Proven'], ['follow', 'Following'], ['ignore', 'Ignored']], ui.whalesFilter)}<span class="ins-grow"></span><input class="ins-field" type="search" placeholder="Name or address" data-input="whalesQuery" value="${esc(ui.whalesQuery)}" style="width:220px"></div><div class="ins-table-wrap"><table class="ins-table"><thead><tr><th>Wallet</th><th class="r">Bets</th><th class="r">W-L</th><th class="r">Won</th><th class="r">Paid</th><th class="r" title="Settled underdog win rate, shrunk toward the price paid, minus that price. Positive: the wallet wins more often than the market thought.">Edge</th><th class="r">P&L</th><th class="r">ROI</th><th class="r">Size</th><th class="r">Score</th><th class="r">Age</th><th class="r">Last</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="13" class="ins-empty">No wallets yet</td></tr>'}</tbody></table></div>`;
  }

  async function pageSignals() {
    const q = new URLSearchParams({ kind: ui.signalKind, min: String(ui.signalMin), source: ui.signalSource });
    if (ui.signalAction) q.set('action', ui.signalAction);
    const d = await api(`/api/insights/signals?${q}`);
    const list = d.signals.length ? `<div class="ins-card"><div class="ins-feed">${d.signals.map((f) => signalRow(f)).join('')}</div></div>` : '<div class="ins-card"><div class="ins-empty">Nothing matches</div></div>';
    return `<div class="ins-bar">${seg('signalKind', [['entry', 'Bets'], ['exit', 'Exits'], ['dump', 'Dumps'], ['', 'All']], ui.signalKind)}${seg('signalAction', [['', 'Any action'], ['copied', 'Copied'], ['queued', 'Sent'], ['skip', 'Skipped']], ui.signalAction)}${seg('signalSource', [['live', 'Live'], ['backfill', 'History'], ['all', 'Both']], ui.signalSource)}<span class="ins-grow"></span><select class="ins-select" data-select="signalMin">${[0, 40, 60, 80].map((v) => `<option value="${v}"${ui.signalMin === v ? ' selected' : ''}>${v ? `Score ${v}+` : 'Any score'}</option>`).join('')}</select></div>${list}`;
  }

  function betsTable(bets, withMatch = true) {
    const rows = bets
      .map((b) => {
        const pnl = b.status === 'open' ? (b.shares || 0) * (b.mark ?? b.price ?? 0) + (b.exitProceeds || 0) - (b.cost || 0) : b.payout !== undefined ? (b.payout || 0) - (b.cost || 0) : null;
        const statusLabel = { open: 'Open', won: 'Won', lost: 'Lost', void: 'Void', sold: 'Sold', pending: 'Sending', failed: 'Failed', missed: 'Missed' }[b.status] || b.status;
        return `<tr${withMatch ? ` data-open data-match="${esc(b.eventId)}"` : ''}><td><span class="ins-tag ${b.mode}">${b.mode === 'real' ? 'Real' : 'Sim'}</span></td><td>${esc(dayTime(b.placedAt))}</td>${withMatch ? `<td class="wrap">${esc(b.title)}</td>` : ''}<td>${esc(b.outcome)}${b.market === 'map' ? ` <span class="ins-tag">${esc(b.marketLabel)}</span>` : ''}</td><td class="r">${b.price ? pct(b.price, 1) : '-'} <span class="ins-dim">/ ${pct(b.whalePrice, 1)}</span></td><td class="r">${usd(b.cost ?? b.amount)}</td><td class="r">${b.shares ? nf0.format(b.shares) : '-'}</td><td class="r">${b.status === 'open' && Number.isFinite(b.mark) ? pct(b.mark) : '-'}</td><td class="r ${signCls(pnl ?? 0)}">${pnl === null ? '-' : usd(pnl, true)}</td><td><span class="ins-link" data-wallet="${esc(b.sourceWallet)}">${esc(short(b.sourceWallet))}</span></td><td><span class="ins-tag ${b.status}" title="${esc(b.error || b.exitReason || '')}">${statusLabel}</span></td></tr>`;
      })
      .join('');
    return `<div class="ins-table-wrap"><table class="ins-table"><thead><tr><th></th><th>Placed</th>${withMatch ? '<th>Match</th>' : ''}<th>Pick</th><th class="r">Ours / whale</th><th class="r">Stake</th><th class="r">Shares</th><th class="r">Now</th><th class="r">P&L</th><th>From</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="11" class="ins-empty">No bets</td></tr>`}</tbody></table></div>`;
  }

  async function pageBets() {
    if (!ui.betsMode) ui.betsMode = ui.overview?.mode === 'real' ? 'real' : 'sim';
    if (ui.betsMode === 'shadow' && !ui.betsVariant) ui.betsVariant = 's-maker3';
    const d = await api(`/api/insights/bets?mode=${ui.betsMode}${ui.betsMode === 'shadow' ? `&variant=${encodeURIComponent(ui.betsVariant)}` : ''}`);
    let bets = d.bets;
    if (ui.betsStatus === 'open') bets = bets.filter((b) => b.status === 'open' || b.status === 'pending');
    if (ui.betsStatus === 'settled') bets = bets.filter((b) => !['open', 'pending'].includes(b.status));
    const t = d.totals;
    const w = d.wallet;
    const settled = t.won + t.lost;
    const kpis = `<div class="ins-kpis">${kpi(ui.betsMode === 'real' ? 'Balance' : ui.betsMode === 'shadow' ? `Shadow wallet ${esc(ui.betsVariant)}` : 'Paper wallet', ui.betsMode === 'real' ? (w.cash === null ? '-' : usd(w.cash)) : usd(w.equity))}${kpi('Settled P&L', usd(w.realized, true), `${t.won} won · ${t.lost} lost · ${t.voided} void · ${t.sold} sold`, signCls(w.realized))}${kpi('Open', `${t.open}`, `${usd(t.openCost)} in · marked ${usd(t.openMark)}`)}${kpi('Hit rate', settled ? pct(t.won / settled) : '-', `${settled} settled`)}${kpi('Staked', usd(t.staked), `${t.count} bets`)}</div>`;
    const reset = ui.betsMode === 'sim' ? '<button type="button" class="ins-btn" data-reset-sim>Reset paper wallet</button>' : '';
    const variantIds = ['w-score', 'w-edge', 'w-proven', 's-maker3', 's-taker5', 's-score', 'm-tight', 'm-wide'];
    const modeSeg = `<div class="ins-seg ins-modeswitch" data-seg="betsMode"><button type="button" class="ins-seg-btn${ui.betsMode === 'sim' ? ' on' : ''}" data-v="sim">Simulation</button><button type="button" class="ins-seg-btn${ui.betsMode === 'real' ? ' on' : ''}" data-v="real">Real money</button><button type="button" class="ins-seg-btn${ui.betsMode === 'shadow' ? ' on' : ''}" data-v="shadow">Shadow</button></div>${ui.betsMode === 'shadow' ? `<select class="ins-select" data-bets-variant>${variantIds.map((v) => `<option${v === ui.betsVariant ? ' selected' : ''}>${v}</option>`).join('')}</select>` : ''}`;
    return `<div class="ins-bar">${modeSeg}${seg('betsStatus', [['open', 'Open'], ['settled', 'Settled'], ['all', 'All']], ui.betsStatus)}<span class="ins-grow"></span>${reset}</div>${kpis}<div class="ins-card"><div class="ins-card-h"><h3>Settled P&L over time</h3></div>${pnlChart(d.curve)}</div>${betsTable(bets)}`;
  }

  async function pageStats() {
    const d = await api(`/api/insights/stats?line=${ui.statsLine}&min=${ui.statsMin}`);
    const s = d.summary;
    const sc = d.score;
    const back = ui.settings?.backfillDays || 30;
    const prog = ui.overview?.status?.backfill;
    const running = prog?.running;
    const kpis = `<div class="ins-kpis">${kpi('Matches recorded', nf0.format(d.matches))}${kpi(`Started at ${pct(d.line)} or less`, s.dogs ? pct(s.dogWins / s.dogs) : '-', `won ${s.dogWins} of ${s.dogs} · priced ${pct(s.dogImplied)}`)}${kpi(`Fell to ${pct(d.line)} or less`, s.dips ? pct(s.dipWins / s.dips) : '-', `came back ${s.dipWins} of ${s.dips}`)}${kpi('Settled whale bets', nf0.format(sc.settled), sc.thresholds[0].n ? `won ${pct(sc.thresholds[0].rate)} · paid ${pct(sc.thresholds[0].implied)}` : '')}</div>`;
    const cal = d[ui.statsCal === 'min' ? 'calibrationMin' : 'calibrationPre'];
    const scoreRows = sc.thresholds.map((r) => `<tr><td>${r.min ? `${r.min}+` : 'All'}</td><td class="r">${r.n}</td><td class="r">${r.rate === null ? '-' : pct(r.rate)}</td><td class="r">${r.implied === null ? '-' : pct(r.implied)}</td><td class="r ${signCls(r.roi ?? 0)}">${r.roi === null ? '-' : pct(r.roi)}</td></tr>`).join('');
    const reasonRows = sc.reasons.map((r) => `<tr><td>${esc(r.key)}</td><td class="r">${r.n}</td><td class="r">${pct(r.rate)}</td><td class="r">${pct(r.implied)}</td><td class="r ${signCls((r.rate ?? 0) - (r.implied ?? 0))}">${r.rate === null ? '-' : `${((r.rate - r.implied) * 100).toFixed(1)}`}</td></tr>`).join('');
    const q = ui.statsQuery.trim().toLowerCase();
    const sortKey = { dips: (t) => t.dips, comeback: (t) => t.dipWinRate ?? -1, dogs: (t) => t.dogs, upset: (t) => t.dogWinRate ?? -1, matches: (t) => t.matches }[ui.teamSort];
    const teams = d.teams.filter((t) => !q || t.name.toLowerCase().includes(q)).sort((a, b) => sortKey(b) - sortKey(a));
    const th = (k, label) => `<th class="r${ui.teamSort === k ? ' sorted' : ''}" data-sort="${k}">${label}</th>`;
    const teamRows = teams
      .slice(0, 400)
      .map((t) => `<tr><td>${esc(t.name)}</td><td class="r">${t.matches}</td><td class="r">${pct(t.winRate)}</td><td class="r">${t.avgPre === null ? '-' : pct(t.avgPre)}</td><td class="r">${t.dogs}</td><td class="r">${t.dogWins}</td><td class="r">${t.dogWinRate === null ? '-' : pct(t.dogWinRate)}</td><td class="r">${t.dips}</td><td class="r">${t.dipWins}</td><td class="r">${t.dipWinRate === null ? '-' : pct(t.dipWinRate)}</td><td class="r">${t.avgDipMin === null ? '-' : pct(t.avgDipMin)}</td></tr>`)
      .join('');
    const backfill = running ? `<span class="ins-muted">History ${prog.done}/${prog.matches || '?'}</span>` : `<button type="button" class="ins-btn" data-backfill>Load ${back} days of history</button>`;
    return `<div class="ins-bar">${seg('statsLine', [[0.2, '20%'], [0.25, '25%'], [0.3, '30%'], [0.35, '35%'], [0.4, '40%']], ui.statsLine)}<select class="ins-select" data-select="statsMin">${[1, 3, 5, 10].map((v) => `<option value="${v}"${ui.statsMin === v ? ' selected' : ''}>${v === 1 ? 'Any team' : `${v}+ matches`}</option>`).join('')}</select><span class="ins-grow"></span>${backfill}</div>${kpis}<div class="ins-grid2"><div class="ins-card"><div class="ins-card-h"><h3>Price vs result</h3>${seg('statsCal', [['pre', 'At start'], ['min', 'Lowest']], ui.statsCal)}</div>${calibrationChart(cal)}</div><div class="ins-card"><div class="ins-card-h"><h3>Does the score predict</h3></div><div class="ins-table-wrap" style="border:0;background:none"><table class="ins-table"><thead><tr><th>Score</th><th class="r">Bets</th><th class="r">Won</th><th class="r">Paid</th><th class="r" title="Return of a flat $1 on every settled whale bet at this score or higher">ROI</th></tr></thead><tbody>${scoreRows}</tbody></table></div>${reasonRows ? `<div class="ins-table-wrap" style="border:0;background:none"><table class="ins-table"><thead><tr><th>Reason</th><th class="r">Bets</th><th class="r">Won</th><th class="r">Paid</th><th class="r">Edge</th></tr></thead><tbody>${reasonRows}</tbody></table></div>` : ''}</div></div><div class="ins-bar"><input class="ins-field" type="search" placeholder="Team" data-input="statsQuery" value="${esc(ui.statsQuery)}" style="width:220px"></div><div class="ins-table-wrap"><table class="ins-table"><thead><tr><th>Team</th>${th('matches', 'Matches')}<th class="r">Won</th><th class="r">Avg start</th>${th('dogs', `Start ≤${Math.round(d.line * 100)}%`)}<th class="r">Upsets</th>${th('upset', 'Upset rate')}${th('dips', `Fell ≤${Math.round(d.line * 100)}%`)}<th class="r">Came back</th>${th('comeback', 'Comeback rate')}<th class="r">Avg low</th></tr></thead><tbody>${teamRows || '<tr><td colspan="11" class="ins-empty">No finished matches yet. Load history to fill this in.</td></tr>'}</tbody></table></div>`;
  }

  // ---- settings -----------------------------------------------------------------

  function chipEditor(key, list, placeholder) {
    return `<div class="ins-chiplist" data-chips="${key}">${list.map((v) => `<span class="ins-chip">${esc(v)}<button type="button" data-chip-del="${esc(v)}" aria-label="Remove ${esc(v)}">×</button></span>`).join('')}<input class="ins-field" placeholder="${placeholder}" data-chip-add="${key}"></div>`;
  }
  const toggle = (key, on) => `<div class="ins-seg" data-toggle="${key}"><button type="button" class="ins-seg-btn${on ? ' on' : ''}" data-v="1">On</button><button type="button" class="ins-seg-btn${!on ? ' on' : ''}" data-v="0">Off</button></div>`;
  const numberField = (key, value, unit = '', scale = 1, step = 'any') => `<span class="ins-unit">${unit === '$' ? '$' : ''}<input class="ins-field" type="number" step="${step}" data-num="${key}" data-scale="${scale}" value="${Number((value * scale).toFixed(4))}">${unit && unit !== '$' ? unit : ''}</span>`;
  const row = (label, ctl) => `<div class="ins-row"><span>${label}</span><div class="ins-row-ctl">${ctl}</div></div>`;

  async function pageSettings() {
    const d = await api('/api/insights/settings');
    ui.settings = d.settings;
    const s = d.settings;
    if (ui.localExec === undefined) {
      ui.localExec = await local('/api/insights-local/status').catch(() => null);
    }
    const exec = d.executor;
    const realPanel =
      s.mode === 'real'
        ? `<div class="ins-arm">${
            exec.armed
              ? `<div class="ins-bar"><b>Armed.</b><span class="ins-muted">Qualifying signals now place real orders from your PC.</span><span class="ins-grow"></span><button type="button" class="ins-btn ins-btn-danger" data-disarm-real>Disarm</button></div>`
              : `<div class="ins-bar"><input class="ins-field" placeholder="Type REAL" data-arm-input style="width:140px"><button type="button" class="ins-btn ins-btn-danger" data-arm>Arm real trading</button><span class="ins-muted">${exec.online ? `Executor online${exec.online.info?.balance !== null && exec.online.info?.balance !== undefined ? ` · ${usd(exec.online.info.balance)}` : ''}` : 'No executor online'}</span></div>`
          }</div>`
        : '';
    const devices = exec.devices.length
      ? exec.devices
          .map((dev) => {
            const i = dev.info || {};
            return `<div class="ins-device"><div><b>${esc(dev.name)}</b> <span class="ins-tag ${dev.online ? 'copied' : ''}">${dev.online ? 'Online' : `Seen ${dev.lastSeen ? ago(dev.lastSeen) + ' ago' : 'never'}`}</span><div class="ins-device-facts"><span>Balance ${i.balance === null || i.balance === undefined ? '-' : usd(i.balance)}</span><span>Wallet ${esc(short(i.wallet) || '-')}</span><span>Signer ${esc(short(i.signer) || '-')}</span><span>${i.geo ? `${esc(i.geo.country)} ${i.geo.blocked ? '<span class="ins-neg">blocked</span>' : 'allowed'}` : 'Location -'}</span>${i.error ? `<span class="ins-neg">${esc(i.error)}</span>` : ''}</div></div><button type="button" class="ins-btn ins-btn-sm" data-unlink="${esc(dev.id)}">Unlink</button></div>`;
          })
          .join('')
      : '<div class="ins-empty">No PC linked</div>';
    const le = ui.localExec;
    const thisPc = le
      ? `<div class="ins-card"><div class="ins-card-h"><h3>This PC</h3><span class="ins-dim">${le.linked ? `Linked as ${esc(le.deviceName || 'PC')}` : 'Not linked'}</span></div><div class="ins-set">
          ${row('Link', `<button type="button" class="ins-btn" data-link-pc>${le.linked ? 'Link again' : 'Link this PC'}</button>`)}
          ${row('Polymarket wallet', `<input class="ins-field" style="width:340px" placeholder="0x... (profile menu on polymarket.com)" data-local-wallet value="${esc(le.wallet)}">`)}
          ${row('Signer key', `<input class="ins-field" style="width:340px" type="password" autocomplete="off" placeholder="${le.hasKey ? `Saved · signer ${esc(short(le.signer))}` : 'Private key or session key'}" data-local-key>`)}
          ${row('', `<button type="button" class="ins-btn" data-local-save>Save on this PC</button><button type="button" class="ins-btn" data-local-test>Test</button>${le.hasKey || le.linked ? '<button type="button" class="ins-btn ins-btn-danger" data-local-forget>Forget</button>' : ''}`)}
          ${row('Status', `<span class="ins-muted">${le.running ? `Polling ${ago(le.lastOk)} ago` : 'Idle'}${le.balance !== null && le.balance !== undefined ? ` · ${usd(le.balance)}` : ''}${le.geo ? ` · ${esc(le.geo.country || '')} ${le.geo.blocked ? '<span class="ins-neg">blocked</span>' : 'allowed'}` : ''}${le.lastError ? ` · <span class="ins-neg">${esc(le.lastError)}</span>` : ''}${le.sdk && le.sdk !== 'ok' ? ` · <span class="ins-neg">${esc(le.sdk)}</span>` : ''}</span>`)}
        </div><div class="ins-hint">The key is stored only on this PC (${esc(le.file)}) and never sent to aim4.io. A session key or a dedicated wallet with a small balance limits what a leaked key could do.</div></div>`
      : `<div class="ins-hint">Real orders are placed by the aim4 desktop app on your PC: Polymarket blocks trading from the aim4.io server's location. Open Insights in the desktop app to link it.</div>`;
    const bf = d.status.backfill;
    const bfLine = bf ? (bf.running ? `<div class="ins-progress"><i style="width:${bf.matches ? Math.round((bf.done / bf.matches) * 100) : 5}%"></i></div><span class="ins-muted">${bf.done}/${bf.matches || '?'} matches · ${bf.flagged} flagged</span>` : `<span class="ins-muted">Last run ${ago(bf.finishedAt)} ago: ${bf.matches} matches, ${bf.flagged} flagged${bf.error ? ` · <span class="ins-neg">${esc(bf.error)}</span>` : ''}</span>`) : '';
    const log = d.log.map((l) => `<div class="${l.level}">${esc(dayTime(l.at))} ${esc(l.msg)}</div>`).join('');
    return `
      <div class="ins-card"><div class="ins-card-h"><h3>Mode</h3></div>
        <div class="ins-bar"><div class="ins-seg ins-modeswitch" data-mode-switch><button type="button" class="ins-seg-btn${s.mode === 'off' ? ' on' : ''}" data-v="off">Off</button><button type="button" class="ins-seg-btn${s.mode === 'sim' ? ' on' : ''}" data-v="sim">Simulation</button><button type="button" class="ins-seg-btn${s.mode === 'real' ? ' on' : ''}" data-v="real">Real money</button></div><span class="ins-grow"></span><span class="ins-muted">Tracking</span>${toggle('tracking', s.tracking)}</div>
        ${realPanel}
      </div>
      <div class="ins-card"><div class="ins-card-h"><h3>Matches</h3><span class="ins-muted" data-preview>Tracking ${d.preview.tracked} of ${d.preview.of} open matches</span></div><div class="ins-set">
        ${row('Teams', toggle('useTeams', s.useTeams))}
        ${chipEditor('teams', s.teams, 'Add a team, Enter')}
        ${row(`VRS rank worse than`, `${numberField('vrsBelow', s.vrsBelow, '', 1, 1)}${toggle('useVrs', s.useVrs)}`)}
        ${row('Unranked teams count', toggle('vrsUnranked', s.vrsUnranked))}
        ${row('Tournaments', toggle('useTournaments', s.useTournaments))}
        ${chipEditor('tournaments', s.tournaments, 'Add a tournament keyword, Enter')}
        ${row('Never track', '')}
        ${chipEditor('excludeTeams', s.excludeTeams, 'Add a team to exclude, Enter')}
        ${row('Map winner markets', toggle('mapMarkets', s.mapMarkets))}
        ${row('Watch before start', numberField('prematchHours', s.prematchHours, 'h', 1, 1))}
      </div><div class="ins-hint">VRS: ${d.vrs.teams} ranked teams${d.vrs.snapshot ? ` · ${esc(Object.values(d.vrs.snapshot).filter(Boolean).join(', '))}` : ''}</div></div>
      <div class="ins-card"><div class="ins-card-h"><h3>Unusual bets</h3></div><div class="ins-set">
        ${row('Bet of at least', numberField('minCash', s.minCash, '$', 1, 1))}
        ${row('On a team priced at most', numberField('maxPrice', s.maxPrice, '%', 100, 1))}
        ${row('Flag sales too', toggle('watchSells', s.watchSells))}
      </div></div>
      <div class="ins-card"><div class="ins-card-h"><h3>Copying</h3></div><div class="ins-set">
        ${row('Copy from score', numberField('minScore', s.minScore, '', 1, 1))}
        ${row('Stake per match', numberField('stakePct', s.stakePct, '% of wallet', 1, 0.1))}
        ${row('Max per match', numberField('maxStake', s.maxStake, '$', 1, 1))}
        ${row('Min stake', numberField('minStake', s.minStake, '$', 1, 1))}
        ${row('Pay up to whale price plus', numberField('maxSlippage', s.maxSlippage, 'c', 100, 0.5))}
        ${row('Never buy above', numberField('maxEntry', s.maxEntry, '%', 100, 1))}
        ${row('All open bets at most', numberField('maxOpenPct', s.maxOpenPct, '% of wallet', 1, 1))}
        ${row('Stop for the day after losing', numberField('dailyLossPct', s.dailyLossPct, '% of wallet', 1, 1))}
        ${row('Copy live bets', toggle('copyLive', s.copyLive))}
        ${row('Copy pre-match bets', toggle('copyPrematch', s.copyPrematch))}
        ${row('Copy map winner bets', toggle('copyMaps', s.copyMaps))}
        ${row('Skip wallets with a losing record', `${toggle('skipLosers', s.skipLosers)}<span class="ins-unit">after${numberField('loserMinResolved', s.loserMinResolved, '', 1, 1)}settled</span>`)}
        ${row('Sell when the whale sells', toggle('mirrorExits', s.mirrorExits))}
      </div><div class="ins-hint">Followed wallets are copied whatever their score. Ignored wallets never are.</div></div>
      <div class="ins-card"><div class="ins-card-h"><h3>Strategies and risk</h3><button type="button" class="ins-btn ins-btn-sm" data-go="insights-brain">Brain</button></div><div class="ins-set">
        ${row('Swing stake', numberField('swingStakePct', s.swingStakePct, '% of wallet', 1, 0.1))}
        ${row('Everything on one match at most', numberField('matchCapPct', s.matchCapPct, '% of wallet', 1, 0.5))}
        ${row('Everything on one team at most', numberField('teamCapPct', s.teamCapPct, '% of wallet', 1, 0.5))}
        ${row('Worst case on one match at most', numberField('worstCasePct', s.worstCasePct, '% of wallet', 1, 0.5))}
        ${row('No entries into a spread over', numberField('maxSpread', s.maxSpread, 'c', 100, 0.5))}
        ${row('AI review before pre-match bets', toggle('reviewer', s.reviewer))}
        ${row('Review bets from', numberField('reviewMinStake', s.reviewMinStake, '$', 1, 1))}
        ${row('Record every tick', toggle('recordTicks', s.recordTicks))}
        ${row('Promote better challengers on paper', toggle('autoPromote', s.autoPromote))}
        ${row('Promote them for real money too', toggle('autoPromoteReal', s.autoPromoteReal))}
      </div></div>
      <div class="ins-card"><div class="ins-card-h"><h3>Paper wallet</h3></div><div class="ins-set">
        ${row('Starting balance', numberField('simBankroll', s.simBankroll, '$', 1, 1))}
        ${row('', '<button type="button" class="ins-btn" data-reset-sim>Reset paper wallet</button>')}
      </div></div>
      <div class="ins-card"><div class="ins-card-h"><h3>Real money</h3></div><div class="ins-set">
        ${row('Daily cap', numberField('realDailyCap', s.realDailyCap, '$', 1, 1))}
      </div>${devices}</div>
      ${thisPc}
      <div class="ins-card"><div class="ins-card-h"><h3>History</h3></div><div class="ins-set">
        ${row('Days', `${numberField('backfillDays', s.backfillDays, '', 1, 1)}<button type="button" class="ins-btn" data-backfill${bf?.running ? ' disabled' : ''}>Load history</button>`)}
      </div>${bfLine}</div>
      <div class="ins-card"><div class="ins-card-h"><h3>Log</h3><span class="ins-dim">${d.status.requests.total} requests · ${d.status.requests.failed} failed</span></div><div class="ins-log">${log || 'Empty'}</div></div>`;
  }

  let saveTimer = null;
  let pending = {};
  function saveSoon(patch, delay = 450) {
    Object.assign(pending, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const p = pending;
      pending = {};
      try {
        const out = await api('/api/insights/settings', { method: 'PUT', body: p });
        ui.settings = out.settings;
        toast('Saved');
        const prev = await api('/api/insights/preview', { method: 'POST', body: {} }).catch(() => null);
        const el = body.querySelector('[data-preview]');
        if (prev && el) el.textContent = `Tracking ${prev.tracked} of ${prev.of} open matches`;
        loadOverview().catch(() => {});
      } catch (err) {
        toast(err.message, true);
      }
    }, delay);
  }

  // Settings and filter controls (delegated, so re-renders keep working).
  body.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) return openRoute(go.dataset.go);

    const decH = e.target.closest('[data-dec]');
    if (decH && !e.target.closest('[data-wallet],[data-match]')) {
      ui.openDecision = ui.openDecision === decH.dataset.dec ? null : decH.dataset.dec;
      return renderPage();
    }
    const bt = e.target.closest('[data-btoggle] .ins-seg-btn');
    if (bt) {
      const [, strategy, field] = bt.closest('[data-btoggle]').dataset.btoggle.split(':');
      const on = bt.dataset.v === '1';
      const body2 = { strategy, [field]: on };
      if (field === 'realAllowed' && on) {
        const typed = window.prompt('Let this strategy trade real money when Real mode is armed? Type REAL to confirm.');
        if (typed !== 'REAL') return;
        body2.confirm = 'REAL';
      }
      try {
        await api('/api/insights/brain/strategy', { method: 'POST', body: body2 });
        return renderPage();
      } catch (err) {
        return toast(err.message, true);
      }
    }
    const champ = e.target.closest('[data-champion]');
    if (champ) {
      if (!window.confirm(`Make ${champ.dataset.champion} the champion of ${champ.dataset.strategy}?`)) return;
      await api('/api/insights/brain/strategy', { method: 'POST', body: { strategy: champ.dataset.strategy, champion: champ.dataset.champion } }).catch((err) => toast(err.message, true));
      return renderPage();
    }
    const appr = e.target.closest('[data-approve]');
    if (appr) {
      if (!window.confirm('Promote this variant to champion, including real money?')) return;
      await api('/api/insights/brain/promote', { method: 'POST', body: { strategy: appr.dataset.approve } }).catch((err) => toast(err.message, true));
      return renderPage();
    }
    const sh = e.target.closest('[data-shadow]');
    if (sh) {
      ui.betsMode = 'shadow';
      ui.betsVariant = sh.dataset.shadow;
      ui.betsStatus = 'all';
      return openRoute('insights-bets');
    }
    if (e.target.closest('[data-train]')) {
      await api('/api/insights/train', { method: 'POST' }).catch((err) => toast(err.message, true));
      toast('Training in the background');
      setTimeout(() => renderPage(), 1500);
      return;
    }
    const runBt = e.target.closest('[data-run-bt]');
    if (runBt) {
      runBt.disabled = true;
      runBt.textContent = 'Running';
      const variant = body.querySelector('[data-bt-variant]')?.value;
      const days = Number(body.querySelector('[data-bt-days]')?.value) || 30;
      ui.btVariant = variant;
      ui.btDays = days;
      try {
        ui.backtest = await api('/api/insights/backtest', { method: 'POST', body: { kind: ui.btKind, strategy: ui.btStrategy, variant, days } });
      } catch (err) {
        ui.backtest = { error: err.message };
      }
      return renderPage();
    }

    const segBtn = e.target.closest('[data-seg] .ins-seg-btn');
    if (segBtn) {
      const key = segBtn.closest('[data-seg]').dataset.seg;
      const raw = segBtn.dataset.v;
      ui[key] = ['statsLine'].includes(key) ? Number(raw) : raw;
      if (key === 'btKind' && raw === 'history') ui.btStrategy = 'swing';
      if (key === 'betsMode' && raw !== 'shadow') ui.betsVariant = '';
      return renderPage();
    }
    const sortTh = e.target.closest('th[data-sort]');
    if (sortTh) {
      ui.teamSort = sortTh.dataset.sort;
      return renderPage();
    }
    const tog = e.target.closest('[data-toggle] .ins-seg-btn');
    if (tog) {
      const key = tog.closest('[data-toggle]').dataset.toggle;
      tog.parentElement.querySelectorAll('.ins-seg-btn').forEach((b) => b.classList.toggle('on', b === tog));
      return saveSoon({ [key]: tog.dataset.v === '1' }, 0);
    }
    const modeBtn = e.target.closest('[data-mode-switch] .ins-seg-btn');
    if (modeBtn) {
      const mode = modeBtn.dataset.v;
      if (mode === ui.settings?.mode) return;
      if (mode === 'real' && !window.confirm('Switch to REAL MONEY mode?\n\nNothing is placed until you also arm it, and only through your linked PC.')) return;
      try {
        await api('/api/insights/settings', { method: 'PUT', body: { mode } });
        toast(mode === 'real' ? 'Real money mode (not armed)' : mode === 'sim' ? 'Simulation mode' : 'Off');
        await loadOverview();
        return renderPage();
      } catch (err) {
        return toast(err.message, true);
      }
    }
    const del = e.target.closest('[data-chip-del]');
    if (del) {
      const key = del.closest('[data-chips]').dataset.chips;
      const list = (ui.settings[key] || []).filter((v) => v !== del.dataset.chipDel);
      ui.settings[key] = list;
      del.closest('.ins-chip').remove();
      return saveSoon({ [key]: list }, 0);
    }
    if (e.target.closest('[data-arm]')) {
      const input = body.querySelector('[data-arm-input]');
      try {
        await api('/api/insights/real/arm', { method: 'POST', body: { confirm: input?.value.trim() } });
        toast('Real trading ARMED');
        await loadOverview();
        return renderPage();
      } catch (err) {
        return toast(err.message, true);
      }
    }
    if (e.target.closest('[data-disarm-real]')) {
      await api('/api/insights/real/disarm', { method: 'POST' }).catch((err) => toast(err.message, true));
      await loadOverview();
      return renderPage();
    }
    if (e.target.closest('[data-reset-sim]')) {
      if (!window.confirm('Start a fresh paper wallet? Earlier paper bets are kept in history but no longer count.')) return;
      await api('/api/insights/sim/reset', { method: 'POST' }).catch((err) => toast(err.message, true));
      await loadOverview();
      return renderPage();
    }
    const bfBtn = e.target.closest('[data-backfill]');
    if (bfBtn) {
      bfBtn.disabled = true;
      try {
        await api('/api/insights/backfill', { method: 'POST', body: { days: ui.settings?.backfillDays } });
        toast('Loading history in the background');
        setTimeout(() => loadOverview().then(renderPage).catch(() => {}), 1500);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    const unlink = e.target.closest('[data-unlink]');
    if (unlink) {
      if (!window.confirm('Unlink this device? It stops receiving orders.')) return;
      await api(`/api/insights/executor/devices/${encodeURIComponent(unlink.dataset.unlink)}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
      return renderPage();
    }
    if (e.target.closest('[data-link-pc]')) {
      try {
        const name = window.prompt('Name for this PC', ui.localExec?.deviceName || 'My PC');
        if (!name) return;
        const linked = await api('/api/insights/executor/link', { method: 'POST', body: { name } });
        ui.localExec = await local('/api/insights-local/config', { method: 'POST', body: { token: linked.token, name } });
        toast('PC linked');
        return renderPage();
      } catch (err) {
        return toast(err.message, true);
      }
    }
    if (e.target.closest('[data-local-save]')) {
      const wallet = body.querySelector('[data-local-wallet]')?.value.trim() || '';
      const key = body.querySelector('[data-local-key]')?.value.trim() || '';
      try {
        ui.localExec = await local('/api/insights-local/config', { method: 'POST', body: key ? { wallet, privateKey: key } : { wallet } });
        toast('Saved on this PC');
        return renderPage();
      } catch (err) {
        return toast(err.message, true);
      }
    }
    if (e.target.closest('[data-local-test]')) {
      try {
        const r = await local('/api/insights-local/test', { method: 'POST' });
        ui.localExec = r.status;
        toast(r.error ? r.error : `Balance ${usd(r.balance)} · ${r.geo?.country || ''} ${r.geo?.blocked ? 'BLOCKED' : 'allowed'}`, Boolean(r.error) || Boolean(r.geo?.blocked));
        return renderPage();
      } catch (err) {
        return toast(err.message, true);
      }
    }
    if (e.target.closest('[data-local-forget]')) {
      if (!window.confirm('Forget the key and the link on this PC?')) return;
      ui.localExec = await local('/api/insights-local/config', { method: 'DELETE' }).catch(() => ui.localExec);
      return renderPage();
    }
  });

  body.addEventListener('keydown', (e) => {
    const add = e.target.closest?.('[data-chip-add]');
    if (add && e.key === 'Enter') {
      e.preventDefault();
      const key = add.dataset.chipAdd;
      const val = add.value.trim();
      if (!val) return;
      const list = [...(ui.settings[key] || [])];
      if (!list.some((v) => v.toLowerCase() === val.toLowerCase())) list.push(val);
      ui.settings[key] = list;
      add.value = '';
      add.insertAdjacentHTML('beforebegin', `<span class="ins-chip">${esc(val)}<button type="button" data-chip-del="${esc(val)}" aria-label="Remove ${esc(val)}">×</button></span>`);
      saveSoon({ [key]: list }, 0);
    }
  });

  body.addEventListener('input', (e) => {
    const inp = e.target.closest?.('[data-input]');
    if (inp) {
      ui[inp.dataset.input] = inp.value;
      clearTimeout(ui.inputTimer);
      ui.inputTimer = setTimeout(() => renderPage({ keepFocus: inp.dataset.input }), 250);
      return;
    }
    const num = e.target.closest?.('[data-num]');
    if (num) {
      const v = Number(num.value);
      if (!Number.isFinite(v)) return;
      saveSoon({ [num.dataset.num]: v / Number(num.dataset.scale || 1) });
    }
  });

  body.addEventListener('change', (e) => {
    const bv = e.target.closest?.('[data-bets-variant]');
    if (bv) {
      ui.betsVariant = bv.value;
      renderPage();
      return;
    }
    const sel = e.target.closest?.('[data-select]');
    if (sel) {
      ui[sel.dataset.select] = Number(sel.value);
      renderPage();
    }
  });

  // ---- decisions ------------------------------------------------------------------

  const ACTION_TAGS = { entered: ['copied', 'Entered'], queued: ['queued', 'Order sent'], skipped: ['', 'Skipped'], vetoed: ['lost', 'Vetoed'], review: ['open', 'In review'], exited: ['', 'Exited'] };
  const modeTag = (m) => `<span class="ins-tag ${m === 'real' ? 'real' : m === 'sim' ? 'sim' : ''}">${m === 'real' ? 'Real' : m === 'sim' ? 'Sim' : 'Shadow'}</span>`;
  const signedC = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}c` : '-');

  function analystRows(list) {
    return (list || [])
      .map((a) => {
        const w = Math.min(50, (Math.abs(a.shift || 0) / 0.05) * 50);
        const bar = a.key === 'market' || a.key === 'context' ? '' : `<span class="ins-shift"><i class="${a.shift >= 0 ? 'up' : 'down'}" style="width:${w.toFixed(1)}%;${a.shift >= 0 ? 'left:50%' : `right:50%`}"></i></span>`;
        return `<div class="ins-an"><span class="ins-an-l">${esc(a.label)}</span>${bar || '<span></span>'}<span class="ins-num ins-an-v">${a.key === 'market' || a.key === 'context' ? '' : signedC(a.shift)}</span><span class="ins-num ins-dim">${a.key === 'context' ? '' : `${Math.round((a.conf || 0) * 100)}%`}</span><span class="ins-an-d">${esc(a.detail || '')}</span></div>`;
      })
      .join('');
  }

  function decisionCard(d) {
    const open = ui.openDecision === d.id;
    const [cls, label] = ACTION_TAGS[d.action] || ['', d.action];
    const c = d.combined || {};
    const head = `<div class="ins-dec-h" data-dec="${esc(d.id)}"><span class="ins-dim ins-num">${esc(dayTime(d.at))}</span><span class="ins-tag">${esc(d.strategy)}·${esc(d.variant)}</span>${modeTag(d.mode)}<span class="ins-dec-t">${esc(d.title || '')}${d.market && d.market !== 'Match' ? ` · ${esc(d.market)}` : ''}</span><b>${esc(d.outcome || '')}</b><span class="ins-num">${d.price ? pct(d.price, 1) : '-'}</span><span class="ins-num">${d.stake ? usd(d.stake) : ''}</span><span class="ins-tag ${cls}">${label}</span><span class="ins-dec-r">${esc(d.reason || '')}</span></div>`;
    if (!open) return `<div class="ins-dec">${head}</div>`;
    const sum = `<div class="ins-dec-sum ins-num">Market ${d.p_market !== null && d.p_market !== undefined ? pct(d.p_market, 1) : '-'} → expected ${d.p_final !== null && d.p_final !== undefined ? pct(d.p_final, 1) : '-'}${c.sd ? ` ±${(c.sd * 100).toFixed(1)}c` : ''} in ${c.horizon || 30} min · edge ${signedC(d.edge)}${d.live ? ' · live' : ''}</div>`;
    const checks = d.risk?.checks?.length ? `<div class="ins-checks">${d.risk.checks.map((k) => `<span class="ins-check ${k.ok ? 'ok' : 'no'}" title="${esc(k.detail)}">${k.ok ? '✓' : '✗'} ${esc(k.key)}</span>`).join('')}</div>` : '';
    const rv = d.review ? `<div class="ins-review ${d.review.verdict}"><b>AI review: ${esc(d.review.verdict)}</b>${d.review.flags?.length ? ` <span class="ins-dim">${esc(d.review.flags.join(' · '))}</span>` : ''}<div>${esc(d.review.rationale || '')}</div></div>` : '';
    const fu = (lab, v, base) => `<span><span class="ins-dim">${lab}</span> ${Number.isFinite(v) ? `${pct(v, 1)} <span class="${signCls(v - base)}">${signedC(v - base)}</span>` : '-'}</span>`;
    const follow = `<div class="ins-follow ins-num">${fu('+5 min', d.m5, d.price)}${fu('+30 min', d.m30, d.price)}${d.live ? '' : fu('At start', d.close, d.price)}<span><span class="ins-dim">Result</span> ${d.result === null || d.result === undefined ? '-' : d.result === 1 ? '<span class="ins-tag won">Won</span>' : d.result === 0 ? '<span class="ins-tag lost">Lost</span>' : 'Void'}${Number.isFinite(d.pnl) ? ` <span class="${signCls(d.pnl)}">${pct(d.pnl)} per $</span>` : ''}</span></div>`;
    const plan = d.plan && !d.plan.hold ? `<div class="ins-dim ins-num">Plan: target ${pct(d.plan.target, 1)}, stop ${pct(d.plan.stop, 1)}, time limit ${esc(dayTime(d.plan.timeStop))}</div>` : d.plan?.hold ? '<div class="ins-dim">Plan: hold to the result, sell if the whale sells</div>' : '';
    return `<div class="ins-dec open">${head}<div class="ins-dec-b">${sum}<div class="ins-ans">${analystRows(d.analysts)}</div>${checks}${rv}${plan}${follow}</div></div>`;
  }

  async function pageDecisions() {
    const q = new URLSearchParams({ strategy: ui.decStrategy, action: ui.decAction, limit: '150' });
    const d = await api(`/api/insights/decisions?${q}`);
    const list = d.decisions.length ? d.decisions.map(decisionCard).join('') : '<div class="ins-empty">No decisions yet</div>';
    return `<div class="ins-bar">${seg('decStrategy', [['', 'All'], ['whale', 'Whale'], ['swing', 'Swing'], ['mm', 'Market making']], ui.decStrategy)}${seg('decAction', [['taken', 'Taken'], ['skipped', 'Skipped'], ['', 'All']], ui.decAction)}<span class="ins-grow"></span><span class="ins-muted ins-num">${nf0.format(d.counts.decisions)} recorded · ${nf0.format(d.counts.taken)} taken · ${nf0.format(d.counts.followed)} with 30-min follow-up</span></div><div class="ins-card ins-decs">${list}</div>`;
  }

  // ---- brain ----------------------------------------------------------------------

  function strategyCard(st) {
    const rows = st.variants
      .map((v) => {
        const t = v.totals;
        const settled = t.won + t.lost;
        return `<tr><td>${v.champion ? '<span class="ins-tag copied">Champion</span>' : '<span class="ins-tag">Challenger</span>'}</td><td>${esc(v.label)} <span class="ins-dim">${esc(v.id)}</span></td><td class="r">${t.count}</td><td class="r">${t.open}</td><td class="r">${t.won}-${t.lost}${t.sold ? ` <span class="ins-dim">+${t.sold} sold</span>` : ''}</td><td class="r">${settled ? pct(t.won / settled) : '-'}</td><td class="r ${signCls(t.realized)}">${usd(t.realized, true)}</td><td class="r ${signCls(v.roi ?? 0)}">${v.roi === null ? '-' : pct(v.roi, 1)}</td><td class="r ${signCls(v.clv ?? 0)}" title="Average start price minus our entry, ${v.nClose} bets">${v.clv === null ? '-' : signedC(v.clv)}</td><td class="r ${signCls(v.move30 ?? 0)}" title="Average move 30 minutes after entry, ${v.n30} bets">${v.move30 === null ? '-' : signedC(v.move30)}</td><td><a class="ins-btn ins-btn-sm" data-shadow="${esc(v.id)}" data-strategy="${esc(st.key)}">Bets</a>${v.champion ? '' : ` <button type="button" class="ins-btn ins-btn-sm" data-champion="${esc(v.id)}" data-strategy="${esc(st.key)}">Make champion</button>`}</td></tr>`;
      })
      .join('');
    const pending = st.pendingPromotion ? `<div class="ins-arm"><div class="ins-bar"><b>${esc(st.pendingPromotion.variant)} beat the champion</b><span class="ins-muted">${pct(st.pendingPromotion.pBetter)} likely better over ${st.pendingPromotion.n} bets</span><span class="ins-grow"></span><button type="button" class="ins-btn ins-btn-danger" data-approve="${esc(st.key)}">Approve for real money</button></div></div>` : '';
    const hist = st.history?.length ? `<div class="ins-hint">${st.history.map((h) => `${esc(dayTime(h.at))}: ${esc(h.from)} → ${esc(h.to)}${h.manual ? ' (manual)' : h.approved ? ' (approved)' : h.pBetter ? ` (${pct(h.pBetter)})` : ''}`).join(' · ')}</div>` : '';
    return `<div class="ins-card"><div class="ins-card-h"><h3>${esc(st.label)}</h3><div class="ins-bar"><span class="ins-muted">Stake share ${pct(st.allocation)}</span><span class="ins-alloc"><i style="width:${Math.round((st.allocation || 0) * 100)}%"></i></span><span class="ins-muted">On</span>${toggleFor(`strategy:${st.key}:enabled`, st.enabled)}<span class="ins-muted">Real money</span>${toggleFor(`strategy:${st.key}:realAllowed`, st.realAllowed)}</div></div>${pending}<div class="ins-table-wrap" style="border:0;background:none"><table class="ins-table"><thead><tr><th></th><th>Variant</th><th class="r">Bets</th><th class="r">Open</th><th class="r">W-L</th><th class="r">Won</th><th class="r">P&L</th><th class="r">ROI</th><th class="r" title="Average start price minus our entry">vs start</th><th class="r" title="Average move 30 minutes after entry">30 min</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${hist}</div>`;
  }

  const toggleFor = (key, on) => `<div class="ins-seg" data-btoggle="${key}"><button type="button" class="ins-seg-btn${on ? ' on' : ''}" data-v="1">On</button><button type="button" class="ins-seg-btn${!on ? ' on' : ''}" data-v="0">Off</button></div>`;

  function reactionGrid(r) {
    const phase = ui.brainPhase;
    const levels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
    const head = `<tr><th>Price</th>${r.labels.map((l) => `<th class="r">${esc(l)}</th>`).join('')}</tr>`;
    const body = levels
      .map((lv, i) => `<tr><td>${lv}</td>${r.labels
        .map((_, j) => {
          const cell = r.table?.[`${phase}|${i}|${j}`]?.[2];
          if (!cell || !cell.n) return '<td class="r ins-dim">-</td>';
          const v = cell.shrunk;
          const a = Math.min(0.35, Math.abs(v) * 8);
          return `<td class="r" style="background:${v >= 0 ? `rgba(57,135,229,${a})` : `rgba(217,89,38,${a})`}" title="${cell.n} cases, raw mean ${signedC(cell.mean)}">${signedC(v)} <span class="ins-dim">${cell.n}</span></td>`;
        })
        .join('')}</tr>`)
      .join('');
    return `<table class="ins-table">${head}${body}</table>`;
  }

  async function pageBrain() {
    const d = await api('/api/insights/brain');
    ui.brainData = d;
    const L = d.learn;
    const rep = L.lastReport || {};
    const wf = rep.reaction?.walkForward;
    const kpis = `<div class="ins-kpis">
      ${kpi('Decisions', nf0.format(d.decisions.decisions), `${nf0.format(d.decisions.taken)} taken · ${nf0.format(d.decisions.followed)} followed up`)}
      ${kpi('Live feeds', d.feeds.market === 'open' && d.feeds.sports === 'open' ? 'Open' : esc(`${d.feeds.market} / ${d.feeds.sports}`), `${d.feeds.subscribed} tokens · ${d.feeds.scores} live scores`)}
      ${kpi('Tick recorder', d.recorder.running ? 'On' : 'Off', `${nf0.format(d.recorder.lines)} lines · ${(d.recorder.disk / 1e6).toFixed(1)} MB`)}
      ${kpi('AI review', d.review.configured ? 'Ready' : 'No key', `${d.review.calls} reviews · ${d.review.vetoes} vetoes`)}
      ${kpi('Last training', L.running ? esc(L.step || 'Running') : L.lastRun ? `${ago(L.lastRun)} ago` : 'Never', L.error ? `<span class="ins-neg">${esc(L.error)}</span>` : 'Nightly at 04:00 UTC')}
    </div>`;
    const learnCard = `<div class="ins-card"><div class="ins-card-h"><h3>What it learned</h3><button type="button" class="ins-btn" data-train${L.running ? ' disabled' : ''}>${L.running ? 'Training' : 'Train now'}</button></div><div class="ins-kpis">
      ${kpi('Reaction table', `${d.reaction.cells} cells`, rep.histories ? `${rep.histories.matches} matches` : '')}
      ${kpi('On later matches', wf?.corr === null || wf?.corr === undefined ? '-' : `corr ${wf.corr.toFixed(3)}`, wf ? `${wf.trades} trades · ${wf.winRate === null ? '-' : pct(wf.winRate)} won · ${wf.avgPnl === null ? '-' : signedC(wf.avgPnl)} each after ${signedC(wf.cost).replace('+', '')} costs` : '')}
      ${kpi('Score jumps that hold', d.reaction.scoreReaction?.n ? pct(d.reaction.scoreReaction.beta) : '-', `${d.reaction.scoreReaction?.n || 0} recorded score changes`)}
      ${kpi('Analyst weights', rep.weights?.adopted ? 'Updated' : 'Kept', esc(rep.weights?.reason || 'Not trained yet'))}
    </div><div class="ins-grid2"><div><div class="ins-hint">Analyst weights</div><table class="ins-table">${Object.entries(d.weights).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r ins-num">${Number(v).toFixed(2)}</td></tr>`).join('')}</table></div><div><div class="ins-hint">Learned whale-reason points</div><table class="ins-table">${Object.keys(d.reasonPoints).length ? Object.entries(d.reasonPoints).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r ins-num ${signCls(v)}">${v > 0 ? '+' : ''}${v}</td></tr>`).join('') : '<tr><td class="ins-dim">Defaults until 40 settled bets per reason hold up on later bets</td></tr>'}</table></div></div></div>`;
    const grid = `<div class="ins-card"><div class="ins-card-h"><h3>How these markets react</h3>${seg('brainPhase', [['pre', 'Before start'], ['live', 'Live']], ui.brainPhase)}</div><div class="ins-hint">Average move over the next 30 minutes after the move in each column, shrunk toward zero when there are few cases.</div><div class="ins-table-wrap" style="border:0;background:none">${reactionGrid(d.reaction)}</div></div>`;
    const variants = Object.fromEntries(d.strategies.map((s2) => [s2.key, s2.variants.map((v) => v.id)]));
    const bt = ui.backtest;
    const btVariant = variants[ui.btStrategy]?.includes(ui.btVariant) ? ui.btVariant : variants[ui.btStrategy]?.[0];
    const btResult = bt ? (bt.error ? `<div class="ins-neg">${esc(bt.error)}</div>` : `<div class="ins-kpis">${kpi('Trades', nf0.format(bt.trades), bt.kind === 'history' ? `${bt.testMatches} later matches` : `${bt.recordings} recordings`)}${kpi('Won', bt.winRate === null ? '-' : pct(bt.winRate))}${kpi('Avg return', bt.avgReturn === null ? '-' : pct(bt.avgReturn, 1), 'per $ staked, after costs', signCls(bt.avgReturn ?? 0))}${kpi('Total', `${bt.totalPerDollar >= 0 ? '+' : ''}${bt.totalPerDollar.toFixed(2)}`, '$ per $1 bet each time', signCls(bt.totalPerDollar))}${kpi('Worst run', bt.maxDrawdown.toFixed(2), '$ per $1, peak to trough')}</div>`) : '';
    const backtestCard = `<div class="ins-card"><div class="ins-card-h"><h3>Backtest</h3></div><div class="ins-bar">${seg('btKind', [['history', '5-min history'], ['ticks', 'Recorded ticks']], ui.btKind)}${seg('btStrategy', ui.btKind === 'history' ? [['swing', 'Swing']] : [['swing', 'Swing'], ['mm', 'Market making']], ui.btStrategy)}<select class="ins-select" data-bt-variant>${(variants[ui.btStrategy] || []).map((v) => `<option${v === btVariant ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select><span class="ins-unit"><input class="ins-field" type="number" data-bt-days value="${ui.btDays}" style="width:70px">days</span><button type="button" class="ins-btn" data-run-bt>Run</button></div>${btResult}</div>`;
    const models = d.models.length ? `<div class="ins-card"><div class="ins-card-h"><h3>Model history</h3></div><table class="ins-table">${d.models.map((m2) => `<tr><td>${esc(dayTime(m2.at))}</td><td>${esc(m2.kind)}</td><td>${m2.adopted ? '<span class="ins-tag copied">In use</span>' : '<span class="ins-tag">Kept old</span>'}</td><td class="ins-dim">${esc(m2.reason || '')}</td></tr>`).join('')}</table></div>` : '';
    return `${kpis}${d.strategies.map(strategyCard).join('')}${learnCard}${grid}${backtestCard}${models}`;
  }

  // ---- render loop -------------------------------------------------------------

  const PAGES = {
    'ins-overview': pageOverview,
    'ins-matches': pageMatches,
    'ins-whales': pageWhales,
    'ins-signals': pageSignals,
    'ins-decisions': pageDecisions,
    'ins-bets': pageBets,
    'ins-brain': pageBrain,
    'ins-stats': pageStats,
    'ins-settings': pageSettings
  };

  async function renderPage(opts = {}) {
    const seq = ++ui.renderSeq;
    tabs.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === ui.page));
    try {
      if (!ui.settings) {
        const s = await api('/api/insights/settings').catch(() => null);
        if (s) ui.settings = s.settings;
      }
      const html = await PAGES[ui.page]();
      if (seq !== ui.renderSeq) return;
      const focusKey = opts.keepFocus;
      const caret = focusKey ? body.querySelector(`[data-input="${focusKey}"]`)?.selectionStart : null;
      body.innerHTML = html;
      if (focusKey) {
        const el = body.querySelector(`[data-input="${focusKey}"]`);
        if (el) {
          el.focus();
          if (caret !== null) el.setSelectionRange(caret, caret);
        }
      }
    } catch (err) {
      if (seq !== ui.renderSeq) return;
      body.innerHTML = err.status === 404 ? '<div class="ins-card"><div class="ins-empty">Not found</div></div>' : `<div class="ins-card"><div class="ins-empty">${esc(err.message)}</div></div>`;
    }
  }

  /** Live pages refresh on their own; Settings never does (it would eat typing). */
  function schedule() {
    clearTimeout(ui.timer);
    if (!ui.visible) return;
    ui.timer = setTimeout(async () => {
      if (!ui.visible) return;
      const busy = document.activeElement && body.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if (ui.page !== 'ins-settings' && !busy && !drawer) {
        await loadOverview().catch(() => {});
        await renderPage();
      } else {
        await loadOverview().catch(() => {});
      }
      schedule();
    }, ui.page === 'ins-overview' || ui.page === 'ins-matches' ? 8000 : 15000);
  }

  return {
    async onShow(params = {}) {
      ui.visible = true;
      ui.page = PAGES[params.page] ? params.page : 'ins-overview';
      if (!(await insightsAccess())) {
        banner.innerHTML = '';
        tabs.hidden = true;
        body.innerHTML = '<div class="ins-card"><div class="ins-empty">Not found</div></div>';
        return;
      }
      tabs.hidden = false;
      await loadOverview().catch((err) => {
        body.innerHTML = `<div class="ins-card"><div class="ins-empty">${esc(err.message)}</div></div>`;
      });
      await renderPage();
      schedule();
    },
    onHide() {
      ui.visible = false;
      clearTimeout(ui.timer);
      closeDrawer();
    }
  };
}
