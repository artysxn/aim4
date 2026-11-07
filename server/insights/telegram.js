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
      if (st.primed) await say(`🔎 <b>Suspicious</b> ${susLine(m)}`);
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
    if (s.curve.length >= 2) await tg('sendPhoto', { chat_id: st.chat, photo: chartUrl(s.curve, `${bot.name} today`) }).catch(() => {});
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

function chartUrl(curve, title) {
  const pts = curve.length > 300 ? curve.filter((_, i) => i % Math.ceil(curve.length / 300) === 0) : curve;
  const chart = { type: 'line', data: { labels: pts.map((p) => new Date(p.t).toISOString().slice(5, 16).replace('T', ' ')), datasets: [{ label: title, data: pts.map((p) => p.v), fill: false, borderColor: '#3987e5', pointRadius: 0 }] }, options: { plugins: { legend: { display: true } } } };
  return `https://quickchart.io/chart?w=800&h=400&bkg=white&c=${encodeURIComponent(JSON.stringify(chart))}`;
}

const HELP = `<b>Commands</b>
/status — wallet, armed, open bets
/summary [bot] [days] — numbers + P&L chart (default: real bot, 7 days)
/bots — all bots
/on &lt;bot&gt; · /off &lt;bot&gt; — switch a bot
/arm · /disarm — real trading
/real &lt;bot&gt; · /paper &lt;bot&gt; — move a bot to real money or paper
/set &lt;bot&gt; &lt;key&gt; &lt;value&gt; — change a bot setting (e.g. /set v3.1 maxOverMid 0.01)
/settings &lt;bot&gt; — show a bot's settings
/suspicious — current suspicious matches
/digest — the daily insights now
/football — football scanner, suspicious matches, paper copy
/fset &lt;key&gt; &lt;value&gt; — football settings (minScore, minCash, copy, stake…)
Sent automatically: real orders, fills, results, near-misses, new suspicious matches, guard actions (a bot sent back to paper or promoted to real, bets in the wallet no bot placed), and daily insights at 21:00.`;

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
    if (s.curve.length >= 2) await tg('sendPhoto', { chat_id: st.chat, photo: chartUrl(s.curve, `${bot.name} settled P&L`) }).catch((e) => say(`Chart failed: ${esc(e.message)}`));
    return;
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
    const list = suspiciousView().slice(0, 10);
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
