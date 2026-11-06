// ---------------------------------------------------------------------------
// server/insights/analysts.js
// Several independent views on one outcome token, then one combined view.
//
// Every analyst reads only Polymarket data and answers the same question:
// where will this price be in `horizon` minutes, relative to now? Each gives
// a shift (in price points, +0.03 = three cents up), a confidence 0..1, and
// the evidence in words. The combiner adds the shifts with learned weights
// (learn.js refits them nightly against what prices actually did), and the
// spread between analysts becomes part of the uncertainty.
//
//   market        the mid and how much to trust it (spread, depth)
//   reaction      what this market usually did after a move like the last 5 min
//   overreaction  the share of a post-score jump that usually fades
//   whale         flagged underdog money on each side in the last 30 minutes
//   book          resting size near the top, bids against asks
//   flow          taker buys against taker sells in the last 5 minutes
//   team          this team's record on Polymarket when priced this low
//   context       no direction: liquidity and time, for sizing and risk
// ---------------------------------------------------------------------------

import { predict, volOf, tables, HORIZONS } from './reaction.js';

export const ANALYST_KEYS = ['reaction', 'overreaction', 'whale', 'book', 'flow', 'team'];
export const DEFAULT_WEIGHTS = Object.freeze({ reaction: 1, overreaction: 1, whale: 1, book: 1, flow: 1, team: 1 });

let weights = { ...DEFAULT_WEIGHTS };
export const getWeights = () => ({ ...weights });
export function setWeights(w) {
  weights = { ...DEFAULT_WEIGHTS, ...w };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const cents = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}c`;

/**
 * @param {object} c context
 * @param {number} c.mid      current mid of this token (0..1)
 * @param {number|null} c.bid
 * @param {number|null} c.ask
 * @param {Array<[number, number]>} c.mids  recent [t, mid] path of this token
 * @param {number} c.now
 * @param {boolean} c.live
 * @param {number} c.start
 * @param {Array<[number, string]>} [c.scoreTimes]  recent score changes [t, score]
 * @param {Array} [c.flags]   recent flagged trades on this market
 * @param {string} c.token
 * @param {{ bidUsd: number, askUsd: number }} [c.depth]
 * @param {{ buy: number, sell: number, n: number }} [c.flow]
 * @param {object|null} [c.team]  teamTable row for this outcome's team
 * @param {number} [c.line]
 * @param {number} [c.horizon] minutes, one of HORIZONS
 */
export function runAnalysts(c) {
  const h = HORIZONS.indexOf(c.horizon || 30) >= 0 ? HORIZONS.indexOf(c.horizon || 30) : 2;
  const phase = c.live ? 'live' : c.start && c.now < c.start ? 'pre' : 'live';
  const out = [];
  const spread = c.bid !== null && c.ask !== null ? c.ask - c.bid : null;

  out.push({
    key: 'market',
    label: 'Market',
    shift: 0,
    conf: spread === null ? 0.3 : clamp(1 - spread / 0.1, 0.1, 1),
    detail: `Mid ${(c.mid * 100).toFixed(1)}%${spread !== null ? `, spread ${(spread * 100).toFixed(1)}c` : ''}`
  });

  // Last five minutes of this price.
  const pastIdx = (() => {
    const t = c.now - 5 * 60e3;
    for (let i = c.mids.length - 1; i >= 0; i--) if (c.mids[i][0] <= t) return i;
    return -1;
  })();
  const move5 = pastIdx >= 0 ? c.mid - c.mids[pastIdx][1] : 0;
  const cell = predict(tables(), phase, c.mid, move5)[h];
  out.push({
    key: 'reaction',
    label: 'Usual reaction',
    shift: cell.shrunk,
    conf: cell.n ? clamp(cell.n / (cell.n + 60), 0, 1) : 0,
    detail: cell.n ? `After ${cents(move5)} in 5 min ${phase === 'pre' ? 'before the start' : 'live'}, it moved ${cents(cell.mean)} on average over ${c.horizon || 30} min (${cell.n} cases)` : 'No history for this state yet'
  });

  // A score change in the last three minutes: has the market overshot?
  const sr = tables().scoreReaction || { n: 0, beta: 1 };
  const lastScore = (c.scoreTimes || []).filter(([t]) => c.now - t <= 3 * 60e3).pop();
  if (lastScore) {
    const before = (() => {
      for (let i = c.mids.length - 1; i >= 0; i--) if (c.mids[i][0] <= lastScore[0] - 2000) return c.mids[i][1];
      return null;
    })();
    const jump = before === null ? 0 : c.mid - before;
    const fade = sr.n >= 10 ? -(1 - clamp(sr.beta, 0, 1.5)) * jump : 0;
    out.push({
      key: 'overreaction',
      label: 'Score reaction',
      shift: fade,
      conf: sr.n ? clamp(sr.n / (sr.n + 40), 0, 1) : 0,
      detail: sr.n >= 10 ? `Moved ${cents(jump)} since the score changed to ${lastScore[1]}; ${Math.round(clamp(sr.beta, 0, 1.5) * 100)}% of such moves usually holds (${sr.n} cases)` : `Moved ${cents(jump)} since the score changed; not enough recorded score changes to judge yet`
    });
  } else {
    out.push({ key: 'overreaction', label: 'Score reaction', shift: 0, conf: 0, detail: 'No score change in the last 3 minutes' });
  }

  // Whale money: flagged entries in the last 30 minutes, this side minus the other.
  let net = 0;
  let scoreSum = 0;
  let nFlags = 0;
  for (const f of c.flags || []) {
    if (c.now - f.at > 30 * 60e3) continue;
    const weight = (f.score || 0) / 100;
    const signed = f.tokenId === c.token ? 1 : -1;
    const dir = f.kind === 'entry' ? 1 : -0.7;
    net += signed * dir * (f.stackCash || f.cash) * weight;
    scoreSum += f.score || 0;
    nFlags++;
  }
  out.push({
    key: 'whale',
    label: 'Whale money',
    shift: 0.05 * Math.tanh(net / 600),
    conf: nFlags ? clamp(scoreSum / nFlags / 100, 0.1, 1) : 0,
    detail: nFlags ? `${nFlags} flagged trade${nFlags > 1 ? 's' : ''} in 30 min, net $${Math.round(net)} score-weighted toward this side` : 'No flagged money in 30 min'
  });

  const bidUsd = c.depth?.bidUsd || 0;
  const askUsd = c.depth?.askUsd || 0;
  const imb = bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0;
  out.push({
    key: 'book',
    label: 'Order book',
    shift: 0.015 * imb,
    conf: clamp((bidUsd + askUsd) / 800, 0, 1),
    detail: `$${Math.round(bidUsd)} bid vs $${Math.round(askUsd)} ask within 5c`
  });

  const fb = c.flow?.buy || 0;
  const fs = c.flow?.sell || 0;
  const fl = fb + fs > 0 ? (fb - fs) / (fb + fs) : 0;
  out.push({
    key: 'flow',
    label: 'Trade flow',
    shift: 0.015 * fl,
    conf: clamp((fb + fs) / 500, 0, 1),
    detail: `$${Math.round(fb)} taker buys vs $${Math.round(fs)} sells in 5 min`
  });

  const line = c.line || 0.3;
  const t = c.team;
  if (t && c.mid <= line + 0.05 && t.dogs + t.dips > 0) {
    const n = t.dips;
    const rate = n ? (t.dipWins + line * 5) / (n + 5) : line;
    const implied = t.avgDipMin ?? line;
    out.push({
      key: 'team',
      label: 'Team record',
      shift: clamp((rate - implied) * 0.5, -0.05, 0.05),
      conf: clamp(n / (n + 12), 0, 1),
      detail: `${t.name} came back ${t.dipWins} of ${t.dips} times after falling to ${Math.round(line * 100)}% or less`
    });
  } else {
    out.push({ key: 'team', label: 'Team record', shift: 0, conf: 0, detail: t ? 'Not priced as an underdog' : 'No Polymarket history for this team' });
  }

  const v = volOf(tables(), phase, c.mid);
  const minsToStart = c.start ? Math.round((c.start - c.now) / 60e3) : null;
  out.push({
    key: 'context',
    label: 'Context',
    shift: 0,
    conf: 1,
    detail: `${phase === 'pre' ? `Starts in ${minsToStart} min` : 'Live'}; typical 5-min move ${v.sd5 ? cents(v.sd5).replace('+', '') : 'unknown'}`
  });
  return { analysts: out, phase, move5, vol: v };
}

/**
 * One expected price from all analysts, with an uncertainty.
 * @returns {{ expected: number, shift: number, sd: number, parts: object }}
 */
export function combine(mid, analysts, vol, horizon = 30) {
  let shift = 0;
  const parts = {};
  const contribs = [];
  for (const a of analysts) {
    if (!ANALYST_KEYS.includes(a.key)) continue;
    const c = (weights[a.key] ?? 1) * a.shift * a.conf;
    parts[a.key] = c;
    shift += c;
    if (a.conf > 0) contribs.push(a.shift);
  }
  const spreadOfViews = contribs.length > 1 ? Math.sqrt(contribs.reduce((s, x) => s + (x - shift) ** 2, 0) / contribs.length) : 0;
  const base = vol?.sd5 ? vol.sd5 * Math.sqrt(horizon / 5) : 0.04;
  const sd = Math.sqrt(base * base + spreadOfViews * spreadOfViews);
  const expected = clamp(mid + shift, 0.005, 0.995);
  return { expected, shift, sd, parts };
}

/**
 * Edge per share of buying at `ask` (or selling held shares at `bid`) after
 * the taker fee and the cost of walking the book, in price points.
 */
export function edgeOf({ side, expected, ask, bid, fill, feeRate = 0, maker = false }) {
  const px = side === 'BUY' ? (fill?.avg || ask) : (fill?.avg || bid);
  if (!Number.isFinite(px) || px <= 0) return { edge: -1, px: null, fee: 0, slip: 0 };
  const fee = maker ? 0 : feeRate * Math.min(px, 1 - px);
  const top = side === 'BUY' ? ask : bid;
  const slip = Number.isFinite(top) ? Math.abs(px - top) : 0;
  const edge = side === 'BUY' ? expected - px - fee : px - expected - fee;
  return { edge, px, fee, slip };
}
