// ---------------------------------------------------------------------------
// server/insights/guards.js
// Real-money guards, run once a minute by the engine (2026-11-07 plan):
//  - Losing stop: a real bot with autoStop whose settled bets since it went
//    real return less than stopBelow % a bet after stopAfter bets goes back
//    to paper. Thresholds sit ~1.7 standard errors under the backtest, so a
//    bot that really has its edge trips it about 1 time in 20.
//  - Fill stop: a real bot whose fills run more than 2.5c over the mid (the
//    point where autoStake stops sizing: the edge is gone) goes back to paper,
//    so the pause is visible instead of a silent "Auto stake" skip.
//  - Promotion: a paper bot with promoteAfter settled paper bets at
//    promoteAbove % a bet or better moves to real money, once.
//  - Foreign positions: anything in the wallet no bot bought is reported
//    once. The bots size from the whole wallet, so manual bets move their stakes.
// Every action is logged and queued in meta.alerts for Telegram.
// ---------------------------------------------------------------------------

import * as pm from './polymarket.js';
import { col, touch, logLine } from './store.js';
import { allBots, updateBot, resetPaper } from './bots.js';

const SETTLED = new Set(['won', 'lost', 'sold']);
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const retOf = (b) => ((Number(b.payout) || 0) - (Number(b.cost) || 0)) / (Number(b.cost) || 1);

/** Queue a message for Telegram and the event log. */
export function alert(text, level = 'warn') {
  const meta = col('meta');
  meta.alerts = [...(meta.alerts || []), { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text }].slice(-50);
  touch('meta');
  logLine(level, text.replace(/<[^>]+>/g, ''));
}

/** Settled bets of one bot in one mode since a time, oldest first, with the return per bet. */
export function track(bot, mode, since = 0) {
  const bets = col('bets')
    .filter((b) => b.botId === bot.id && b.mode === mode && b.placedAt >= since && SETTLED.has(b.status) && b.cost > 0)
    .sort((a, b) => (a.settledAt || 0) - (b.settledAt || 0));
  const n = bets.length;
  return { n, avg: n ? bets.reduce((s, b) => s + retOf(b), 0) / n : 0, pnl: bets.reduce((s, b) => s + (b.payout || 0) - (b.cost || 0), 0) };
}

/** Average fill over the mid on the bot's last 30 real fills (null under 10), as autoStake measures it. */
export function fillCost(bot) {
  const fills = col('bets')
    .filter((b) => b.botId === bot.id && b.mode === 'real' && Number.isFinite(b.price) && Number.isFinite(b.midAt))
    .sort((a, b) => a.placedAt - b.placedAt)
    .slice(-30);
  return fills.length >= 10 ? fills.reduce((s, b) => s + (b.price - b.midAt), 0) / fills.length : null;
}

let lastPositions = 0;

/**
 * One pass of every guard.
 * @param {{ now?:number, fetchPositions?:(wallet:string)=>Promise<any> }} o
 * @returns {string[]} what it did
 */
export async function runGuards({ now = Date.now(), fetchPositions = (w) => pm.positions({ user: w, limit: 500 }) } = {}) {
  const did = [];
  for (const bot of allBots()) {
    if (!bot.enabled) continue;
    if (bot.mode === 'real') {
      const t = track(bot, 'real', bot.realSince || 0);
      if (bot.autoStop && t.n >= (bot.stopAfter || 30) && t.avg * 100 < (bot.stopBelow ?? -20)) {
        updateBot(bot.id, { mode: 'paper', stoppedAt: now });
        resetPaper(bot.id);
        alert(`🛑 <b>${esc(bot.name)} back to paper</b>\n${t.n} real bets returned ${pct(t.avg)} a bet (${t.pnl >= 0 ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)}), under the ${bot.stopBelow ?? -20}% stop. It keeps trading on paper. /real ${esc(bot.id)} puts it back on real money.`);
        did.push(`stop ${bot.id}`);
        continue;
      }
      const fc = fillCost(bot);
      if (bot.sizing.kind === 'auto' && fc !== null && fc > 0.025) {
        updateBot(bot.id, { mode: 'paper', stoppedAt: now });
        resetPaper(bot.id);
        alert(`🛑 <b>${esc(bot.name)} back to paper</b>\nIts real fills average ${(fc * 100).toFixed(1)}c over the mid. Past 2.5c the backtested edge is gone, so it stopped spending real money. /real ${esc(bot.id)} puts it back.`);
        did.push(`fills ${bot.id}`);
      }
    } else if (bot.promoteAfter > 0 && !bot.promotedAt && !bot.stoppedAt) {
      const t = track(bot, 'sim', bot.paperEpoch || 0);
      if (t.n >= bot.promoteAfter && t.avg * 100 >= (bot.promoteAbove ?? 2)) {
        updateBot(bot.id, { mode: 'real', promotedAt: now });
        alert(`🚀 <b>${esc(bot.name)} moves to real money</b>\n${t.n} paper bets returned ${pct(t.avg)} a bet, over the ${bot.promoteAbove ?? 2}% bar. It now trades the real wallet with the automatic stake.`, 'info');
        did.push(`promote ${bot.id}`);
      }
    }
  }
  // Foreign positions, every 10 minutes.
  if (now - lastPositions >= 10 * 60e3) {
    lastPositions = now;
    const wallet = (col('executor').devices || []).map((d) => d.info?.wallet).find(Boolean);
    if (wallet) {
      const body = await fetchPositions(wallet).catch(() => null);
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      const mine = new Set(col('bets').filter((b) => b.mode === 'real').map((b) => String(b.tokenId)));
      const meta = col('meta');
      const seen = (meta.foreignSeen ||= {});
      for (const r of rows) {
        const token = String(r.token_id ?? r.asset ?? '');
        const size = Number(r.current_size ?? r.size ?? 0);
        const price = Number(r.current_price ?? r.curPrice ?? 0);
        if (!token || mine.has(token) || seen[token] || size * price < 0.5) continue;
        seen[token] = now;
        touch('meta');
        alert(`👀 <b>Not a bot's bet</b> in the bot wallet\n${esc(r.title || r.market || r.slug || token.slice(0, 12))} · <b>${esc(r.outcome || '')}</b> · ${size.toFixed(2)} shares, worth $${(size * price).toFixed(2)}\nThe bots size their stakes and limits from the whole wallet, so bets placed by hand here change what they do.`, 'info');
        did.push(`foreign ${token}`);
      }
    }
  }
  return did;
}

/** For tests: forget when positions were last read. */
export function _resetGuards() {
  lastPositions = 0;
}
