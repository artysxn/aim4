// ---------------------------------------------------------------------------
// server/insights/telegram.js
// A Telegram bot for the Insights engine: pushes real trades, real near-misses
// (skipped by limits/sizing/book, not by the bot's own rules), results and new
// suspicious matches, and takes commands (status, summary + chart, arm/disarm,
// bots on/off, settings).
//
// Config ~/.aim4/telegram.json (or AIM4_TELEGRAM_FILE): { "token": "...", "code": "..." }.
// Only the chat that sent "/start <code>" is obeyed; that chat id is kept in
// <insights dir>/telegram-state.json. Long polling, no inbound port.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { col, insightsDir, logLine } from './store.js';
import * as engine from './engine.js';
import * as botsMod from './bots.js';
import * as db from './db.js';
import { botReport, skipCategory } from './botReport.js';
import * as football from './football.js';
import * as pm from './polymarket.js';
import * as charts from './tgcharts.js';
import { botBacktestRuns } from './botbacktest.js';

const cfgFile = () => process.env.AIM4_TELEGRAM_FILE || path.join(os.homedir(), '.aim4', 'telegram.json');
const stateFile = () => path.join(insightsDir(), 'telegram-state.json');
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const usd = (v) => `${v < 0 ? '-' : ''}$${Math.abs(Number(v) || 0).toFixed(2)}`;
const pct = (p) => `${((Number(p) || 0) * 100).toFixed(1)}%`;

let cfg = null;
let st = null;
const saveState = () => fs.writeFileSync(stateFile(), JSON.stringify(st));

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40e3) });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(`telegram ${method}: ${out.description || res.status}`);
  return out.result;
}
const say = (text, extra = {}) => (st.chat ? tg('sendMessage', { chat_id: st.chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch((e) => logLine('warn', e.message)) : null);
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
const realBots = () => botsMod.allBots().filter((b) => b.mode === 'real');
const findBot = (q) => botsMod.allBots().find((b) => b.id === q || b.name.toLowerCase() === String(q).toLowerCase()) || botsMod.allBots().find((b) => b.name.toLowerCase().includes(String(q).toLowerCase()));

// ---- pushes -------------------------------------------------------------------------

async function scan() {
  if (!st.chat) return;
  const botName = Object.fromEntries(botsMod.allBots().map((b) => [b.id, b.name]));
  // Trades and results: every real bet's status change.
  for (const b of col('bets')) {
    if (b.mode !== 'real') continue;
    const prev = st.bets[b.id];
    if (prev === b.status) continue;
    st.bets[b.id] = b.status;
    if (prev === undefined && st.primed && b.status === 'pending') await say(`🟡 <b>Order sent</b> · ${esc(botName[b.botId])}\n${esc(b.title)}\n<b>${esc(b.outcome)}</b> · ${usd(b.amount)} up to ${pct(b.maxPrice)}`);
    else if (b.status === 'open' && st.primed) await say(`🟢 <b>Filled</b> · ${esc(botName[b.botId])}\n${esc(b.title)}\n<b>${esc(b.outcome)}</b> · ${b.shares} at ${pct(b.price)} · cost ${usd(b.cost)}`);
    else if (['won', 'lost', 'sold', 'void'].includes(b.status) && st.primed) {
      const pnl = (b.payout || 0) - (b.cost || 0);
      await say(`${pnl > 0 ? '✅' : '❌'} <b>${b.status.toUpperCase()}</b> ${usd(pnl)} · ${esc(botName[b.botId])}\n${esc(b.title)} · ${esc(b.outcome)} (paid ${pct(b.price)})`);
    } else if (['failed', 'missed'].includes(b.status) && st.primed) await say(`⚠️ <b>Order ${b.status}</b> · ${esc(b.title)} · ${esc(b.outcome)}\n${esc(b.error || '')}`);
  }
  // Near-misses: real bots skipped by limits, sizing, blocking or the book, not by their own rules.
  for (const bot of realBots()) {
    const rows = db.decisionRows(bot.id, st.lastDecision || Date.now() - 60e3, 200);
    for (const d of rows) {
      st.lastDecision = Math.max(st.lastDecision || 0, d.at + 1);
      if (d.action !== 'skipped' || !st.primed) continue;
      const cat = skipCategory(d.reason);
      if (cat === 'rules' || cat === 'duplicate') continue;
      await say(`🟠 <b>Almost</b> · ${esc(bot.name)}\n${esc(d.title)} · <b>${esc(d.outcome)}</b> at ${pct(d.price)}\nSkipped: ${esc(d.reason)}`);
    }
  }
  // Suspicious matches, once each.
  try {
    const { suspiciousView } = await import('./routes.js');
    for (const m of suspiciousView().slice(0, 20)) {
      const id = m.eventId || m.id;
      if (!id || st.sus[id]) continue;
      st.sus[id] = Date.now();
      // Only a match still to be decided is worth a message (a flag seen after the result is history).
      if (st.primed && openMatch(m)) await say(`🔎 <b>Suspicious</b> ${susLine(m)}`);
    }
  } catch (err) {
    logLine('warn', `telegram suspicious: ${err.message}`);
  }
  // Guard actions (guards.js), each once.
  for (const a of col('meta').alerts || []) {
    if (a.at <= (st.alertAt || 0)) continue;
    st.alertAt = a.at;
    await say(a.text);
  }
  st.primed = true; // the first pass only learns what already exists
  await dailyDigest();
  saveState();
}

/** Every evening at 21:00 (this machine's time): the day for each real bot, and a line per paper bot. */
async function dailyDigest(force = false) {
  const now = new Date();
  const day = now.toDateString();
  if (!force && (now.getHours() < 21 || st.digestDay === day)) return;
  if (!force) st.digestDay = day;
  for (const bot of realBots()) {
    const s = summary(bot, 1);
    await say(`📊 <b>Daily insights</b>\n${s.text}`);
    await sendChart(equityView(bot, 7)).catch((e) => logLine('warn', `digest chart: ${e.message}`));
  }
  const paper = botsMod
    .allBots()
    .filter((b) => b.enabled && b.mode !== 'real')
    .map((b) => {
      const r = botReport({ bot: b, bets: col('bets').filter((x) => x.botId === b.id), decisions: [], funnel: [], now: Date.now(), days: 1, mode: 'sim' });
      return { name: b.name, pnl: r.kpis.realized, n: r.kpis.settled, rec: `${r.kpis.won}-${r.kpis.lost}` };
    })
    .sort((a, c) => c.pnl - a.pnl);
  if (paper.length) await say(`📄 <b>Paper bots today</b>\n${paper.map((p) => `${p.pnl >= 0 ? '🟢' : '🔴'} ${esc(p.name)}: ${usd(p.pnl)} (${p.rec})`).join('\n')}`);
  await sendChart(compareView(7)).catch((e) => logLine('warn', `digest compare chart: ${e.message}`));
}


/** Not settled, no winner yet, and live or still to start. */
function openMatch(m) {
  return !m.settled && (m.winner === null || m.winner === undefined) && Boolean(m.live || (m.start || 0) > Date.now());
}

/** "Dota 2 · <b>Team A</b> to WIN · Team B to lose · DreamLeague…" from a suspicious-match row. */
function susLine(m) {
  const title = String(m.title || '');
  const game = (title.match(/^([^:]+):/) || [])[1] || 'Esports';
  const rest = title.replace(/^[^:]+:\s*/, '').replace(/^.*?\)\s*-\s*/, '');
  const win = m.suspectSide || '';
  const lose = (m.teams || []).find((t) => t !== win) || '';
  const done = m.settled && m.winner !== undefined && m.winner !== null ? ` · result: ${esc((m.teams || [])[m.winner] || '?')} won` : m.live ? ' · LIVE' : '';
  return `(${m.score}) ${esc(game)} · <b>${esc(win)}</b> to WIN · ${esc(lose)} to lose${done}\n   ${esc(rest)}`;
}

/** "(72) Football · Latvia · <b>FS Jelgava</b> to WIN · Ogre United to lose" */
function footLine(ev, kind, score) {
  const [a, b] = ev.teams;
  const pick = kind === 'draw' ? '<b>Draw</b> · neither to win' : `<b>${esc(kind === 'A' ? a : b)}</b> to WIN · ${esc(kind === 'A' ? b : a)} to lose`;
  const when = ev.settledAt && ev.winner ? ` · result: ${esc(ev.winner === 'draw' ? 'draw' : `${ev.teams[ev.winner === 'A' ? 0 : 1]} won`)}` : Date.now() >= ev.start ? ' · LIVE' : ` · kickoff ${new Date(ev.start).toISOString().slice(5, 16).replace('T', ' ')} UTC`;
  return `(${score}) Football · ${esc(ev.league)} · ${pick}${when}\n   ${esc(ev.teams.join(' vs '))}`;
}

function footballPush(e) {
  if (!st?.chat) return;
  if (e.type === 'flag') {
    const f = e.flag;
    say(`⚽🔎 <b>Suspicious</b> ${footLine(e.ev, f.kind, f.score)}\n   $${Math.round(f.cash)} at ${pct(f.avgPrice)} by ${esc(f.name || f.wallet.slice(0, 10))} · ${esc(f.reasons.map((r) => r.label).join(' · '))}`);
  } else if (e.type === 'bet') say(`⚽📄 <b>Paper copy</b> · ${esc(e.bet.outcome)} at ${pct(e.bet.price)} · ${usd(e.bet.cost)}\n   ${esc(e.ev.teams.join(' vs '))} · ${esc(e.ev.league)}`);
  else if (e.type === 'result') {
    const pnl = (e.bet.payout || 0) - (e.bet.cost || 0);
    say(`⚽${pnl > 0 ? '✅' : '❌'} <b>Paper ${e.bet.status.toUpperCase()}</b> ${usd(pnl)} · ${esc(e.bet.outcome)}\n   ${esc(e.ev.teams.join(' vs '))} · ${esc(e.ev.league)}`);
  }
}

// ---- commands -----------------------------------------------------------------------

function statusText() {
  const w = engine.realWallet();
  const ex = col('executor');
  const online = engine.onlineDevice();
  const open = col('bets').filter((b) => b.mode === 'real' && b.status === 'open');
  return `<b>${ex.armed ? '🔴 ARMED' : '⚪ not armed'}</b> · bots ${engine.settings().botsOn !== false ? 'on' : 'OFF'} · executor ${online ? 'online' : 'OFFLINE'}\nCash ${usd(w.cash)} · equity ${usd(w.equity)} · today ${usd(w.today)}\nOpen real bets: ${open.length}${open.map((b) => `\n• ${esc(b.outcome)} (${esc(b.title)}) ${pct(b.price)} → ${pct(b.mark)}`).join('')}\nReal bots: ${realBots().map((b) => `${esc(b.name)} ${b.enabled ? 'on' : 'off'}`).join(', ') || 'none'}`;
}

function summary(bot, days) {
  const now = Date.now();
  const since = days > 0 ? now - days * 86400e3 : 0;
  const r = botReport({ bot, bets: col('bets').filter((b) => b.botId === bot.id), decisions: db.decisionRows(bot.id, since), funnel: db.funnelRows(bot.id, since ? new Date(since).toISOString().slice(0, 10) : ''), wallet: engine.realWallet(), now, days, mode: bot.mode === 'real' ? 'real' : 'sim' });
  const k = r.kpis;
  const top = r.reasons.slice(0, 4).map((x) => `• ${esc(x.label)} (${x.n})`).join('\n');
  const text = `<b>${esc(bot.name)}</b> · ${r.mode === 'real' ? 'real' : 'paper'} · ${days ? `${days}d` : 'all'}\nP&L ${usd(k.realized)}${k.roi === null ? '' : ` (${pct(k.roi)} ROI)`} · record ${k.won}-${k.lost} · open ${k.open}\nPlaced ${k.placed} · avg entry ${k.avgPrice ? pct(k.avgPrice) : '-'} · worst dip ${usd(-k.maxDrawdown)}\nLooked at ${r.funnel.considered} · skipped ${r.funnel.skipped} · taken ${r.funnel.taken}\nTop skip reasons:\n${top || '-'}`;
  return { text, curve: r.curve };
}


// ---- charts (rendered by QuickChart, uploaded as photos; every line has a dashed trend) ----

const DAY_MS = 86400e3;
const short = (name) => String(name).replace(/^Oracle /, '').replace(/^Back the leader/, 'Leader');
/** The bot's settled bets in its current mode, and when that mode started for it. */
function track(bot) {
  const real = bot.mode === 'real';
  const start = real ? bot.realSince || 0 : bot.paperEpoch || 0;
  const bets = col('bets').filter((b) => b.botId === bot.id && b.mode === (real ? 'real' : 'sim') && b.placedAt >= start);
  return { real, start, bets };
}

/** Profit over time with a trendline. */
function equityView(bot, days = 7, now = Date.now()) {
  const { real, start, bets } = track(bot);
  const from = Math.max(now - days * DAY_MS, start || 0, now - 365 * DAY_MS);
  const run = charts.runningPnl(bets.filter((b) => b.settledAt >= from));
  const pts = charts.onDays(run, from, now);
  const values = pts.map((p) => p.v);
  const t = charts.trendline(values);
  const chart = charts.lineChart(`${short(bot.name)} · profit since ${charts.dayLabel(from)} ($)`, pts.map((p) => charts.dayLabel(p.t)), [{ label: `${short(bot.name)} ${real ? '(real)' : '(paper)'}`, values, width: 3 }], { yLabel: '$' });
  const last = values[values.length - 1] || 0;
  return { chart, caption: `📈 <b>${esc(bot.name)}</b> · ${real ? 'real' : 'paper'} · since ${charts.dayLabel(from)}\nProfit ${usd(last)} on ${run.length} settled bets · trend ${charts.perDay(t.slope)}` };
}

/** Profit per day as bars, with a trend. */
function dailyView(bot, days = 14, now = Date.now()) {
  const { real, start, bets } = track(bot);
  if (start > 0) days = Math.min(days, Math.max(2, Math.ceil((now - start) / DAY_MS) + 1));
  const rows = charts.dailyPnl(bets, days, now);
  const values = rows.map((r) => r.v);
  const t = charts.trendline(values);
  const chart = charts.barChart(`${short(bot.name)} · profit per day ($)`, rows.map((r) => charts.dayLabel(r.t)), values);
  const up = rows.filter((r) => r.v > 0).length, down = rows.filter((r) => r.v < 0).length;
  const best = rows.reduce((a, r) => (r.v > a.v ? r : a), rows[0]), worst = rows.reduce((a, r) => (r.v < a.v ? r : a), rows[0]);
  return { chart, caption: `📊 <b>${esc(bot.name)}</b> · ${real ? 'real' : 'paper'} · last ${days} days\nTotal ${usd(values.reduce((s, v) => s + v, 0))} · ${up} days up, ${down} down · best ${charts.dayLabel(best.t)} ${usd(best.v)} · worst ${charts.dayLabel(worst.t)} ${usd(worst.v)} · trend ${charts.perDay(t.slope)}` };
}

/** Every comeback bot side by side, as % of the wallet it started with. */
function compareView(days = 7, now = Date.now()) {
  const bots = botsMod.allBots().filter((b) => b.enabled && b.type === 'comeback').sort((a, b) => (a.mode === 'real' ? -1 : b.mode === 'real' ? 1 : a.name.localeCompare(b.name)));
  // No empty days before every bot had started.
  const from = Math.max(now - days * DAY_MS, Math.min(...bots.map((b) => track(b).start || 0)));
  const w = engine.realWallet();
  const series = [], lines = [];
  let labels = [];
  for (const bot of bots) {
    const { real, start, bets } = track(bot);
    const run = charts.runningPnl(bets.filter((b) => b.settledAt >= Math.max(from, start)));
    const total = run.length ? run[run.length - 1].v : 0;
    // Real: the wallet before these bets (live balance, or the executor's last known one when it is offline).
    const lastBal = (col('executor').devices || []).map((d) => Number(d.info?.balance)).find(Number.isFinite);
    const base = real ? Math.max(10, (w.equity ?? w.cash ?? lastBal ?? 250) - total) : bot.paperBankroll || 1;
    const pts = charts.onDays(run, from, now);
    labels = pts.map((p) => charts.dayLabel(p.t));
    series.push({ label: `${short(bot.name)}${real ? ' (real)' : ''}`, values: pts.map((p) => Math.round((p.v / base) * 1000) / 10), trend: real, width: real ? 4 : 2, ...(real ? { color: charts.REAL_COLOR } : {}) });
    lines.push({ name: bot.name, real, pctv: (total / base) * 100, n: run.length });
  }
  const chart = charts.lineChart(`All bots · return since ${charts.dayLabel(from)} (% of starting wallet)`, labels, series, { yLabel: '%' });
  lines.sort((a, b) => b.pctv - a.pctv);
  return { chart, caption: `🏁 <b>Bots compared</b> · last ${days} days\n${lines.map((l) => `${l.pctv >= 0 ? '🟢' : '🔴'} ${l.real ? '💰 ' : ''}${esc(l.name)}: ${l.pctv >= 0 ? '+' : ''}${l.pctv.toFixed(1)}% (${l.n} bets)`).join('\n')}` };
}

/** A bot's backtest from a date with a starting wallet, as an equity curve with a trend. */
function backtestView(bot, fromMs, start, now = Date.now()) {
  const out = botBacktestRuns({ ...bot, matchCapPct: engine.settings().matchCapPct ?? 4 }, { starts: [fromMs], start });
  const r = out.runs[0];
  const pts = charts.onDays((r.curve || []).map((c) => ({ t: c.t, v: c.v })), fromMs, now, start);
  const values = pts.map((p) => p.v);
  const t = charts.trendline(values);
  const chart = charts.lineChart(`${short(bot.name)} · backtest from ${charts.dayLabel(fromMs)} with $${start}`, pts.map((p) => charts.dayLabel(p.t)), [{ label: 'wallet ($)', values, width: 3 }], { yLabel: '$' });
  return { chart, caption: `🧪 <b>Backtest · ${esc(bot.name)}</b>\n$${start} on ${new Date(fromMs).toISOString().slice(0, 10)} → <b>$${r.end.toFixed(2)}</b> today\n${r.placed} bets · ${r.won} won · lowest $${r.low.toFixed(2)} · worst dip ${Math.round(r.maxDrawdown * 100)}% · trend ${charts.perDay(t.slope)}${r.stopped ? `\nStopped: ${esc(r.stopped.reason)}` : ''}\n<i>Past matches replayed with today's settings; not a promise.</i>` };
}

/** Render a chart and upload it to the chat. */
async function sendChart({ chart, caption }) {
  const r = await fetch('https://quickchart.io/chart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chart, width: 900, height: 500, devicePixelRatio: 2, backgroundColor: 'white', format: 'png' }), signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error(`chart render ${r.status}`);
  const form = new FormData();
  form.append('chat_id', String(st.chat));
  form.append('photo', new Blob([Buffer.from(await r.arrayBuffer())], { type: 'image/png' }), 'chart.png');
  if (caption) {
    form.append('caption', caption.slice(0, 1000));
    form.append('parse_mode', 'HTML');
  }
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(40e3) });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(`telegram sendPhoto: ${out.description || res.status}`);
}
export { equityView as _equityView, dailyView as _dailyView, compareView as _compareView, backtestView as _backtestView };

const HELP = `<b>Commands</b>
/status — wallet, armed, open bets
/summary [bot] [days] — numbers + P&L chart (default: real bot, 7 days)
/bots — all bots
/on &lt;bot&gt; · /off &lt;bot&gt; — switch a bot
/arm · /disarm — real trading
/real &lt;bot&gt; · /paper &lt;bot&gt; — move a bot to real money or paper
/today · /bets — today's real bets, or the last 10, with results
/chart [bot] [days] — profit curve with a trendline (default: real bot, 7 days)
/daily [bot] [days] — profit per day as bars, with a trend (default 14 days)
/compare [days] — every bot side by side, % of its starting wallet
/backtest [bot] [YYYY-MM-DD] [$start] — replay a bot from a date, as a chart
/refresh — re-check the wallet now: positions, fills, cash
/set &lt;bot&gt; &lt;key&gt; &lt;value&gt; — change a bot setting (e.g. /set v3.1 maxOverMid 0.01)
/settings &lt;bot&gt; — show a bot's settings
/suspicious — current suspicious matches
/digest — the daily insights now
/football — football scanner, suspicious matches, paper copy
/fset &lt;key&gt; &lt;value&gt; — football settings (minScore, minCash, copy, stake…)
Sent automatically: real orders, fills, results, near-misses, new suspicious matches, guard actions (a bot sent back to paper or promoted to real, bets in the wallet no bot placed), and daily insights with charts at 21:00.`;

async function handle(msg) {
  const chat = msg.chat?.id;
  const [cmd0, ...args] = String(msg.text || '').trim().split(/\s+/);
  const cmd = cmd0.replace(/@.*$/, '').toLowerCase();
  if (cmd === '/start' && cfg.code && args[0] === cfg.code) {
    st.chat = chat;
    saveState();
    return say(`Paired. ${HELP}`);
  }
  if (!st.chat || chat !== st.chat) return; // only the paired chat is obeyed
  const pickBot = (q) => (q ? findBot(q) : realBots()[0] || botsMod.allBots()[0]);
  if (cmd === '/help' || cmd === '/start') return say(HELP);
  if (cmd === '/status') return say(statusText());
  if (cmd === '/bots') return say(botsMod.allBots().map((b) => `${b.enabled ? '🟢' : '⚫'} ${b.mode === 'real' ? '💰' : '📄'} ${esc(b.name)} <code>${b.id}</code>`).join('\n'));
  if (cmd === '/summary') {
    const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
    const bot = pickBot(args.filter((a) => !/^\d+$/.test(a)).join(' '));
    if (!bot) return say('No such bot.');
    const s = summary(bot, days);
    await say(s.text);
    await sendChart(equityView(bot, days || 365)).catch((e) => say(`Chart failed: ${esc(e.message)}`));
    return;
  }
  if (cmd === '/chart' || cmd === '/daily') {
    const n = Number(args.find((a) => /^\d+$/.test(a)) ?? (cmd === '/chart' ? 7 : 14));
    const bot = pickBot(args.filter((a) => !/^\d+$/.test(a)).join(' '));
    if (!bot) return say('No such bot.');
    return sendChart(cmd === '/chart' ? equityView(bot, n) : dailyView(bot, Math.min(60, Math.max(2, n)))).catch((e) => say(`Chart failed: ${esc(e.message)}`));
  }
  if (cmd === '/compare') {
    const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
    return sendChart(compareView(Math.min(90, Math.max(1, n)))).catch((e) => say(`Chart failed: ${esc(e.message)}`));
  }
  if (cmd === '/backtest') {
    const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const amount = args.find((a) => /^\$?\d+(\.\d+)?$/.test(a) && !/^\d{4}-/.test(a));
    const bot = pickBot(args.filter((a) => a !== date && a !== amount).join(' '));
    if (!bot) return say('No such bot.');
    if (bot.type !== 'comeback') return say('Backtest charts are for the comeback bots (Oracle versions, leader).');
    const fromMs = date ? Date.parse(`${date}T00:00:00Z`) : Date.now() - 30 * 86400e3;
    if (!Number.isFinite(fromMs) || fromMs > Date.now()) return say('Usage: /backtest [bot] [YYYY-MM-DD] [$start], e.g. /backtest v3.2 2026-10-01 259');
    const start = Math.max(10, Math.round(Number(String(amount || '').replace('$', '')) || engine.realWallet().cash || 250));
    await say(`🧪 Replaying ${esc(bot.name)} from ${new Date(fromMs).toISOString().slice(0, 10)} with $${start}…`);
    return sendChart(backtestView(bot, fromMs, start)).catch((e) => say(`Backtest failed: ${esc(e.message)}`));
  }
  if (cmd === '/on' || cmd === '/off') {
    const bot = pickBot(args.join(' '));
    if (!bot) return say('No such bot.');
    botsMod.updateBot(bot.id, { enabled: cmd === '/on' });
    return say(`${esc(bot.name)} ${cmd === '/on' ? 'on' : 'off'}.`);
  }
  if (cmd === '/real' || cmd === '/paper') {
    const bot = args.length ? findBot(args.join(' ')) : null;
    if (!bot) return say(`Usage: ${cmd} &lt;bot&gt;`);
    const next = botsMod.updateBot(bot.id, { mode: cmd === '/real' ? 'real' : 'paper', ...(cmd === '/real' ? { stoppedAt: 0 } : {}) });
    return say(`${esc(next.name)} is now on ${next.mode === 'real' ? '💰 real money' : '📄 paper'}.`);
  }
  if (cmd === '/arm' || cmd === '/disarm') {
    engine.setArmed(cmd === '/arm');
    return say(cmd === '/arm' ? '🔴 Real trading ARMED.' : '⚪ Real trading disarmed.');
  }
  if (cmd === '/settings') {
    const bot = pickBot(args.join(' '));
    if (!bot) return say('No such bot.');
    return say(`<b>${esc(bot.name)}</b> · ${bot.mode === 'real' ? '💰 real' : '📄 paper'}\n<code>${esc(JSON.stringify({ sizing: bot.sizing, ...Object.fromEntries(botsMod.COMMON_FIELDS.map((f) => [f.key, bot[f.key]])), ...bot.params }, null, 1))}</code>`);
  }
  if (cmd === '/set') {
    const [q, key, raw] = args;
    const bot = q && findBot(q);
    if (!bot || !key || raw === undefined) return say('Usage: /set &lt;bot&gt; &lt;key&gt; &lt;value&gt;');
    const value = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    const top = botsMod.COMMON_FIELDS.some((f) => f.key === key);
    const next = botsMod.updateBot(bot.id, top ? { [key]: value } : { params: { ...bot.params, [key]: value } });
    const got = top ? next?.[key] : next?.params?.[key];
    return say(got === undefined ? `Not a setting of ${esc(bot.name)}: ${esc(key)}` : `${esc(bot.name)}: ${esc(key)} = ${esc(JSON.stringify(got))}`);
  }
  if (cmd === '/refresh') {
    await engine.refreshNow().catch(() => {});
    await engine._reconcileRealFills({ force: true }).catch(() => {});
    const wallet = (col('executor').devices || []).map((d) => d.info?.wallet).find(Boolean)?.toLowerCase();
    const body = wallet ? await pm.positions({ user: wallet, limit: 100 }).catch(() => null) : null;
    const rows = (Array.isArray(body?.data) ? body.data : []).filter((r) => Number(r.current_size ?? r.size) > 0.01);
    const realBets = col('bets').filter((b) => b.mode === 'real');
    const nameOf = (tok, cond) => {
      const b = realBets.find((x) => String(x.tokenId) === tok);
      if (b) return `${b.outcome} (${b.title})`;
      const ev = Object.values(col('events')).find((e) => e.markets?.some((x) => x.conditionId === cond));
      const m = ev?.markets.find((x) => x.conditionId === cond);
      const i = m ? m.tokens.indexOf(tok) : -1;
      return ev ? `${i >= 0 ? m.outcomes[i] : '?'} (${ev.teams.join(' vs ')})` : tok.slice(0, 10);
    };
    const w = engine.realWallet();
    const open = realBets.filter((b) => ['open', 'pending'].includes(b.status));
    return say(`🔄 <b>Refreshed</b> · cash ${usd(w.cash)} · ${rows.length} position${rows.length === 1 ? '' : 's'} · ${open.length} bot bet${open.length === 1 ? '' : 's'} open\n${rows.map((r) => { const tok = String(r.token_id ?? r.asset); const sz = Number(r.current_size ?? r.size); const px = Number(r.current_price ?? r.curPrice) || 0; return `${realBets.some((b) => String(b.tokenId) === tok && ['open', 'pending'].includes(b.status)) ? '🤖' : '👤'} ${esc(nameOf(tok, String(r.condition_id ?? r.conditionId)))} · ${sz.toFixed(2)} at ${pct(px)} = ${usd(sz * px)}${r.redeemable ? ' · resolved: redeem it on Polymarket' : ''}`; }).join('\n') || 'No positions.'}`);
  }
  if (cmd === '/today' || cmd === '/bets') {
    const day0 = new Date().setHours(0, 0, 0, 0);
    const real = col('bets').filter((b) => b.mode === 'real').sort((a, b) => b.placedAt - a.placedAt);
    const list = cmd === '/today' ? real.filter((b) => b.placedAt >= day0 || (b.settledAt || 0) >= day0) : real.slice(0, 10);
    const pnl = list.filter((b) => ['won', 'lost', 'sold', 'void'].includes(b.status)).reduce((s, b) => s + (b.payout || 0) - (b.cost || 0), 0);
    const icon = (b) => (['won', 'lost', 'sold', 'void'].includes(b.status) ? ((b.payout || 0) > (b.cost || 0) ? '✅' : '❌') : '⏳');
    return say(`<b>${cmd === '/today' ? 'Today' : 'Last 10 real bets'}</b> · settled P&L ${usd(pnl)}\n${list.map((b) => `${icon(b)} ${esc(b.outcome)} (${esc(b.title)}) at ${pct(b.price ?? b.maxPrice)} · ${usd(b.cost || b.amount)}${b.payout !== undefined ? ` → ${usd(b.payout)}` : ''}`).join('\n') || 'No real bets.'}`);
  }
  if (cmd === '/digest') {
    return dailyDigest(true);
  }
  if (cmd === '/football') {
    const stt = football.footballStatus();
    const p = football.footballPaper();
    const sus = football.footballSuspicious().slice(0, 10);
    return say(`⚽ <b>Football scanner</b> ${stt.on ? 'on' : 'OFF'} · ${stt.events} matches (${stt.hot} near kickoff or live) · ${stt.flags} big buys seen\nPaper copy: ${p.bets} bets · ${p.won}-${p.lost} · P&L ${usd(p.realized)} · ${p.open} open · wallet ${usd(p.equity)}\n${sus.length ? sus.map((r) => `• ${footLine(r.ev, r.kind, r.score)} · $${Math.round(r.cash)} from ${r.wallets} wallet${r.wallets > 1 ? 's' : ''}`).join('\n') : 'Nothing suspicious in the last 48 hours.'}\nSettings: <code>${esc(JSON.stringify(football.fbSettings()))}</code>`);
  }
  if (cmd === '/fset') {
    const [key, raw] = args;
    if (!key || raw === undefined) return say('Usage: /fset &lt;key&gt; &lt;value&gt;\nKeys: on, minScore, minCash, maxFlagPrice, copy, copyMinScore, maxPrice, stake');
    return say(`Football: <code>${esc(JSON.stringify(football.setFootballSettings({ [key]: raw })))}</code>`);
  }
  if (cmd === '/suspicious') {
    const { suspiciousView } = await import('./routes.js');
    const list = suspiciousView().filter(openMatch).slice(0, 10);
    return say(list.length ? list.map((m) => `• ${susLine(m)}`).join('\n') : 'Nothing suspicious right now.');
  }
  return say(HELP);
}

// ---- lifecycle ----------------------------------------------------------------------

export function startTelegram() {
  cfg = readJson(cfgFile(), null);
  if (!cfg?.token) return false;
  st = { chat: null, bets: {}, sus: {}, lastDecision: 0, primed: false, offset: 0, ...readJson(stateFile(), {}) };
  logLine('info', `Telegram bot on${st.chat ? '' : ' (waiting for /start <code>)'}`);
  football.onFootball(footballPush);
  const poll = async () => {
    try {
      const ups = await tg('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['message'] });
      for (const u of ups) {
        st.offset = u.update_id + 1;
        if (u.message) await handle(u.message).catch((e) => say(`Error: ${esc(e.message)}`));
      }
      if (ups.length) saveState();
    } catch (err) {
      logLine('warn', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
    setTimeout(poll, 300);
  };
  poll();
  setInterval(() => scan().catch((e) => logLine('warn', `telegram scan: ${e.message}`)), 20e3).unref?.();
  return true;
}
