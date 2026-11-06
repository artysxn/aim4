// ---------------------------------------------------------------------------
// server/insights/signals.js
// Whale detection. Pure: every input arrives as data, so the score is
// reproducible in tests and the page can show exactly why a bet was flagged.
//
// The gate is the owner's rule: a BUY of at least `minCash` USD on a team the
// market prices at `maxPrice` or less, at the moment of the bet (before or
// during the match). Everything else adjusts the score on top of that gate:
//
//   size         bigger stake, more conviction (log scale)
//   longshot     the lower the price, the stronger the claim
//   fresh        new wallet, few markets: the classic one-off insider account
//   specialist   wallet trades mostly CS2
//   record       resolved underdog bets beat what their prices implied
//   impact       the bet moved the price (swept the book instead of waiting)
//   stacking     several fills in a few minutes (split to hide the size)
//   cluster      other wallets buying the same underdog in the same window
//   live-down    buying the team that is behind on the scoreboard, live
//   prematch     placed in the last two hours before the start
//   all-in       a big share of the wallet's whole portfolio
//   map          map-winner markets carry less information than the match
//
// A SELL is an exit when the seller holds a flagged entry on that token, and a
// dump when someone unloads a priced-out team in size.
// ---------------------------------------------------------------------------

const DAY = 86400e3;

/** The largest default points of each fixed reason; learned points rescale them. */
const DEFAULT_MAX = { longshot: 10, fresh: 15, specialist: 8, impact: 12, stacking: 6, cluster: 16, 'live-down': 10, prematch: 5, 'all-in': 10, map: -5 };
let learned = {};
/** Points learned from settled bets (learn.js). Reasons not in the map keep their defaults. */
export function setLearnedPoints(points) {
  learned = { ...(points || {}) };
}
export const learnedPoints = () => ({ ...learned });

/** Bayesian-shrunk edge of a wallet's resolved underdog bets: win rate minus the price it paid. */
export function walletEdge(record) {
  if (!record || !record.resolved) return null;
  const k = 4; // pseudo-bets at the implied rate
  const implied = record.avgPrice || 0;
  const shrunk = (record.wins + implied * k) / (record.resolved + k);
  return shrunk - implied;
}

/**
 * @param {object} a
 * @param {{ side: string, price: number, size: number, timestamp: number }} a.trade  Data API row (timestamp in seconds)
 * @param {object} a.settings  sanitized settings
 * @param {object} [a.wallet]  { joinedAt, markets, value, cs2Share, record }
 * @param {object} [a.ctx]     { kind, prevPrice, live, start, behind, stackFills, stackCash, clusterWallets, hasEntry }
 * @returns {{ kind: 'entry'|'exit'|'dump'|null, score: number, cash: number, reasons: Array<{ key: string, label: string, pts: number }> }}
 */
export function scoreTrade({ trade, settings, wallet = {}, ctx = {} }) {
  const price = Number(trade.price) || 0;
  const cash = (Number(trade.size) || 0) * price;
  const side = String(trade.side || '').toUpperCase();
  const reasons = [];
  const add = (key, label, pts) => {
    if (key in learned && DEFAULT_MAX[key]) pts = (pts / Math.abs(DEFAULT_MAX[key])) * learned[key] * Math.sign(DEFAULT_MAX[key]);
    if (pts) reasons.push({ key, label, pts: Math.round(pts) });
  };

  let kind = null;
  if (side === 'BUY' && price > 0 && price <= settings.maxPrice && (ctx.stackCash || cash) >= settings.minCash) {
    kind = 'entry';
  } else if (side === 'SELL' && settings.watchSells) {
    if (ctx.hasEntry && cash >= Math.min(10, settings.minCash)) kind = 'exit';
    else if (price <= settings.maxPrice && cash >= settings.minCash) kind = 'dump';
  }
  if (!kind) return { kind: null, score: 0, cash, reasons };

  const sized = Math.max(cash, ctx.stackCash || 0);
  add('size', `$${Math.round(sized).toLocaleString('en-US')} at ${Math.round(price * 100)}%`, Math.min(30, 10 + 10 * Math.log10(Math.max(1, sized / settings.minCash))));

  if (kind !== 'entry') {
    return { kind, score: Math.min(100, reasons.reduce((s, r) => s + r.pts, 0)), cash, reasons };
  }

  if (price <= 0.15) add('longshot', 'Longshot under 15%', 10);
  else if (price <= 0.22) add('longshot', 'Longshot under 22%', 5);

  const at = (Number(trade.timestamp) || 0) * 1000;
  const age = wallet.joinedAt && at ? (at - wallet.joinedAt) / DAY : null;
  let fresh = 0;
  if (age !== null && age <= 14) fresh = 15;
  else if (age !== null && age <= 45) fresh = 8;
  if (Number.isFinite(wallet.markets) && wallet.markets <= 5) fresh = Math.max(fresh, 10);
  if (fresh) add('fresh', age !== null && age <= 45 ? `Wallet ${Math.max(0, Math.round(age))}d old` : `${wallet.markets} markets traded`, fresh);

  if (Number.isFinite(wallet.cs2Share) && wallet.cs2Share >= 0.7 && (wallet.markets || 0) >= 5) {
    add('specialist', `${Math.round(wallet.cs2Share * 100)}% CS2`, 8);
  }

  const edge = walletEdge(wallet.record);
  if (edge !== null && wallet.record.resolved >= 3) {
    const pts = Math.max(-20, Math.min(25, edge * 60));
    add('record', `${wallet.record.wins}/${wallet.record.resolved} underdogs won`, pts);
  }

  if (Number.isFinite(ctx.prevPrice) && ctx.prevPrice > 0) {
    const moved = price - ctx.prevPrice;
    if (moved >= 0.07) add('impact', `Moved price +${Math.round(moved * 100)}c`, 12);
    else if (moved >= 0.03) add('impact', `Moved price +${Math.round(moved * 100)}c`, 8);
  }

  if ((ctx.stackFills || 0) >= 3) add('stacking', `${ctx.stackFills} fills stacked`, 6);

  const others = Math.min(2, ctx.clusterWallets || 0);
  if (others) add('cluster', `${ctx.clusterWallets} other wallet${ctx.clusterWallets > 1 ? 's' : ''} same side`, others * 8);

  if (ctx.live && ctx.behind) add('live-down', 'Bought while behind live', 10);
  else if (!ctx.live && ctx.start && at && ctx.start - at <= 2 * 3600e3 && ctx.start - at > -600e3) {
    add('prematch', 'Last 2h before start', 5);
  }

  if (Number.isFinite(wallet.value) && wallet.value > 0 && sized / (wallet.value + sized) >= 0.25) {
    add('all-in', `${Math.round((sized / (wallet.value + sized)) * 100)}% of wallet`, 10);
  }

  if (ctx.kind === 'map') add('map', 'Map market', -5);

  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.pts, 0)));
  return { kind, score, cash, reasons };
}

/**
 * Is the outcome's team behind right now? `index` is the outcome's team in
 * event order (the score string lists the home team first).
 */
export function teamBehind(score, index, kind = 'match') {
  if (!score || index < 0) return false;
  const mine = (pair) => (pair ? pair[index] : 0);
  const theirs = (pair) => (pair ? pair[1 - index] : 0);
  if (kind === 'match' && score.maps && mine(score.maps) !== theirs(score.maps)) {
    return mine(score.maps) < theirs(score.maps);
  }
  if (score.rounds) return mine(score.rounds) + 2 <= theirs(score.rounds);
  return false;
}
