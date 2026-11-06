// ---------------------------------------------------------------------------
// server/insights/risk.js
// The last word before an order: does this trade fit the whole book?
//
// Checks one candidate against every open position in the same wallet
// (paper, real or a shadow variant's own): combined exposure on this match
// across all its markets, on this team across matches, the worst case if the
// match goes the wrong way, whether there is enough bid depth to get out
// again, the 50-50 rule on forfeits, the day's losses and the overall cap.
// Each check is reported, passed or not, so the decision card can show it.
// ---------------------------------------------------------------------------

import { normName } from './matching.js';

/**
 * @param {object} a
 * @param {object} a.cand    { eventId, conditionId, tokenId, outcome, side, stake, price, needsExit, start, live }
 * @param {Array}  a.open    open and pending bets in the same wallet
 * @param {number} a.bankroll
 * @param {number} a.todayPnl
 * @param {object} a.limits  settings
 * @param {{ bidUsd: number }} [a.exitDepth]
 * @param {number} [a.spread]
 * @param {string} [a.rules] event resolution text
 * @returns {{ ok: boolean, stake: number, checks: Array<{ key: string, ok: boolean, detail: string }> }}
 */
export function riskGate({ cand, open, bankroll, todayPnl, limits, exitDepth, spread, rules, now = Date.now() }) {
  const checks = [];
  let stake = cand.stake;
  const add = (key, ok, detail) => checks.push({ key, ok, detail });
  const usd = (v) => `$${Math.round(v)}`;

  if (!(bankroll > 0)) {
    add('bankroll', false, 'Wallet empty or unknown');
    return { ok: false, stake: 0, checks };
  }

  const exposure = (b) => b.cost || b.amount || 0;
  const onMatch = open.filter((b) => b.eventId === cand.eventId).reduce((s, b) => s + exposure(b), 0);
  const matchCap = bankroll * (limits.matchCapPct / 100);
  if (onMatch + stake > matchCap) stake = Math.max(0, matchCap - onMatch);
  add('match', stake >= limits.minStake, `${usd(onMatch)} already on this match, cap ${usd(matchCap)}`);

  const team = normName(cand.outcome);
  const onTeam = open.filter((b) => normName(b.outcome) === team).reduce((s, b) => s + exposure(b), 0);
  const teamCap = bankroll * (limits.teamCapPct / 100);
  if (onTeam + stake > teamCap) stake = Math.max(0, teamCap - onTeam);
  add('team', stake >= limits.minStake, `${usd(onTeam)} already on ${cand.outcome}, cap ${usd(teamCap)}`);

  const conflict = open.some((b) => b.conditionId === cand.conditionId && b.tokenId !== cand.tokenId && b.status === 'open' && b.strategy !== 'mm');
  add('sides', !conflict, conflict ? 'Already holding the other side of this market' : 'No opposite position');

  // Worst case on this match: everything on it loses.
  const worst = onMatch + stake;
  const worstCap = bankroll * (limits.worstCasePct / 100);
  add('worst', worst <= worstCap + 1e-9, `Worst case ${usd(worst)} vs ${usd(worstCap)} allowed`);

  const openTotal = open.reduce((s, b) => s + exposure(b), 0);
  const openCap = bankroll * (limits.maxOpenPct / 100);
  if (openTotal + stake > openCap) stake = Math.max(0, openCap - openTotal);
  add('open', stake >= limits.minStake, `${usd(openTotal)} open of ${usd(openCap)} allowed`);

  const lossStop = -bankroll * (limits.dailyLossPct / 100);
  add('daily', todayPnl > lossStop, `Today ${todayPnl >= 0 ? '+' : ''}${usd(todayPnl)}, stop at ${usd(lossStop)}`);

  if (cand.needsExit) {
    const shares = stake / Math.max(0.01, cand.price);
    const room = (exitDepth?.bidUsd || 0) / Math.max(0.01, cand.price);
    add('exit', room >= shares * 0.5, `${Math.round(room)} shares bid within 5c to sell ${Math.round(shares)} into`);
  }

  if (Number.isFinite(spread)) add('spread', spread <= limits.maxSpread + 1e-9, `Spread ${(spread * 100).toFixed(1)}c, max ${(limits.maxSpread * 100).toFixed(1)}c`);

  // A forfeit or a match that never happens resolves 50-50: a favourite bought
  // above 50% loses on that, an underdog gains. Flag favourites near the start.
  const fiftyFifty = /50-50/i.test(rules || '');
  const nearStart = cand.start && cand.start - now < 2 * 3600e3 && !cand.live;
  if (fiftyFifty && cand.side === 'BUY' && cand.price > 0.6 && nearStart) {
    stake = Math.min(stake, cand.stake * 0.5);
    add('forfeit', true, 'Favourite near the start: a forfeit settles 50-50, stake halved');
  }

  stake = Math.floor(stake * 100) / 100;
  const ok = checks.every((c) => c.ok) && stake >= limits.minStake;
  if (stake < limits.minStake && checks.every((c) => c.ok)) add('size', false, `Stake ${usd(stake)} under the minimum`);
  return { ok, stake: ok ? stake : 0, checks };
}
