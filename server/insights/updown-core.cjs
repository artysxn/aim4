// Copied from D:/Dev/claude/polymarket-updown/src/core.js (the backtested pricing model and rules).
// Keep the two in step: change it there, re-run that backtest, copy it here.
// UDCore: the pricing model and trading rules for Polymarket crypto Up/Down markets.
// This exact file is used by the backtest (Node) and is inlined into the userscript by build.mjs,
// so what was backtested is what runs in the browser.
//
// Market mechanics it encodes (BTC/ETH/... 5m and 15m "Up or Down"):
//   resolves Up when  TWAP60(end) >= TWAP60(start)  on the Chainlink stream, where TWAP60(t) is the
//   mean price over the 60 s before t. So the last minute is an averaging window, not a spot print.
//   Taker fee per share = rate * p * (1 - p)  (rate 0.07 for crypto); makers pay nothing.
const UDCore = (() => {
  'use strict';

  // ---- math -------------------------------------------------------------------------------
  function normCdf(x) {
    // Abramowitz-Stegun 7.1.26 on erf; |error| < 1.5e-7
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const logit = (p) => Math.log(p / (1 - p));
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));

  // ---- fees -------------------------------------------------------------------------------
  const feePerShare = (p, rate) => (rate == null ? 0.07 : rate) * p * (1 - p);

  // ---- volatility: blend of EWMAs of squared 1-second log returns ---------------------------
  class Vol {
    constructor(halfLives, weights) {
      this.hl = halfLives || [90, 600, 3600];
      this.w = weights || [0.45, 0.35, 0.2];
      this.a = this.hl.map((h) => 1 - Math.pow(0.5, 1 / h));
      this.v = this.hl.map(() => 0);
      this.n = 0;
      this.last = null;
    }
    // feed one price per second (gaps: call with the carried-forward price)
    push(price) {
      if (this.last != null && price > 0) {
        const r = Math.log(price / this.last);
        const r2 = Math.min(r * r, 2.5e-6); // cap a single second at 0.16% so one print cannot own the estimate
        for (let i = 0; i < this.v.length; i++) this.v[i] += this.a[i] * (r2 - this.v[i]);
        this.n++;
      }
      this.last = price;
    }
    // per-second variance of log returns
    sigma2() {
      let s = 0, ws = 0;
      for (let i = 0; i < this.v.length; i++) {
        const corr = 1 - Math.pow(1 - this.a[i], this.n); // warm-up bias correction
        if (corr > 0.05) { s += this.w[i] * this.v[i] / corr; ws += this.w[i]; }
      }
      return ws > 0 ? s / ws : 0;
    }
  }

  // ---- fair value ---------------------------------------------------------------------------
  // S        current reference price (Chainlink-equivalent)
  // K        price to beat
  // tau      seconds until the window ends
  // L        TWAP lookback in seconds (60); 0 = plain spot settlement
  // avg      mean reference price over the part of the final L seconds already elapsed (only used when tau < L)
  // sigma2   per-second log-return variance
  // P        model params: { kTail, noise, driftW }
  // drift    expected log return over the remaining time (signal tilt), usually 0
  function fair(S, K, tau, L, avg, sigma2, P, drift) {
    P = P || DEFAULTS.model;
    let expFinal, varRel;
    if (tau <= 0) {
      expFinal = L > 0 && avg ? avg : S;
      varRel = 0;
    } else if (L > 0 && tau < L) {
      const e = L - tau;
      expFinal = (avg * e + S * tau) / L;
      varRel = sigma2 * tau * tau * tau / (3 * L * L);
    } else {
      expFinal = S;
      varRel = sigma2 * (L > 0 ? tau - L + L / 3 : tau);
    }
    const m = Math.log(expFinal / K) + (drift || 0);
    const sd = Math.sqrt(varRel + P.noise * P.noise);
    const z = sd > 0 ? m / sd : (m >= 0 ? 40 : -40);
    const p = clamp(normCdf(z * P.kTail), P.pFloor, 1 - P.pFloor);
    return { p, z, m, sd, expFinal };
  }

  // ---- rolling market microstructure signals -------------------------------------------------
  // Keeps the last N seconds of (price, taker buy volume, total volume) and of Polymarket taker flow.
  class Signals {
    constructor(n) {
      this.n = n || 600;
      this.px = new Float64Array(this.n); this.bv = new Float64Array(this.n); this.tv = new Float64Array(this.n);
      this.pf = new Float64Array(this.n); // polymarket signed taker flow in USD (toward Up positive)
      this.pv = new Float64Array(this.n); // polymarket taker volume in USD
      this.i = 0; this.count = 0;
    }
    // one call per second
    push(price, buyVol, totVol, pmFlow, pmVol) {
      const k = this.i % this.n;
      this.px[k] = price; this.bv[k] = buyVol || 0; this.tv[k] = totVol || 0; this.pf[k] = pmFlow || 0; this.pv[k] = pmVol || 0;
      this.i++; this.count = Math.min(this.count + 1, this.n);
    }
    _at(ago) { return this.px[((this.i - 1 - ago) % this.n + this.n) % this.n]; }
    // log return over the last w seconds
    ret(w) { if (this.count <= w) return 0; const a = this._at(w), b = this._at(0); return a > 0 && b > 0 ? Math.log(b / a) : 0; }
    // exchange taker order-flow imbalance over w seconds, in [-1, 1]
    ofi(w) {
      let b = 0, t = 0; const m = Math.min(w, this.count);
      for (let j = 0; j < m; j++) { const k = ((this.i - 1 - j) % this.n + this.n) % this.n; b += this.bv[k]; t += this.tv[k]; }
      return t > 0 ? (2 * b - t) / t : 0;
    }
    // polymarket taker flow imbalance over w seconds, in [-1, 1]
    pmImb(w) {
      let f = 0, v = 0; const m = Math.min(w, this.count);
      for (let j = 0; j < m; j++) { const k = ((this.i - 1 - j) % this.n + this.n) % this.n; f += this.pf[k]; v += this.pv[k]; }
      return v > 0 ? f / v : 0;
    }
  }

  // ---- trading rules -------------------------------------------------------------------------
  // One decision per tick. Pure function: same inputs give the same orders in backtest, paper and live.
  //
  // q:   { bidUp, askUp, bidDn, askDn, askUpSize?, askDnSize? }   prices in 0..1; missing side = null
  // f:   fair() result for Up
  // pos: { up, dn, cost }     shares held on each side and net cash spent on this market so far
  // ctx: { tau, len, budget, feeRate, sinceTrade }   budget = max net cash at risk for this market
  // S:   strategy params (DEFAULTS.strategy)
  // Returns an array of orders: { side: 'UP'|'DN', action: 'BUY'|'SELL', shares, limit, reason }
  function decide(q, f, pos, ctx, S) {
    S = S || DEFAULTS.strategy;
    const out = [];
    const rate = ctx.feeRate == null ? 0.07 : ctx.feeRate;
    const fee = (p) => feePerShare(p, rate);
    const room = () => ctx.budget - pos.cost; // cash still allowed in
    const pUp = f.p, pDn = 1 - f.p;

    // 1) box arbitrage: both sides bought for less than the $1 they pay together
    if (S.arb && q.askUp != null && q.askDn != null) {
      const cost = q.askUp + q.askDn + fee(q.askUp) + fee(q.askDn);
      if (cost <= 1 - S.arbMin) {
        let sh = room() / cost;
        if (q.askUpSize != null) sh = Math.min(sh, q.askUpSize * S.depthFrac);
        if (q.askDnSize != null) sh = Math.min(sh, q.askDnSize * S.depthFrac);
        sh = Math.floor(sh);
        if (sh >= S.minShares) {
          out.push({ side: 'UP', action: 'BUY', shares: sh, limit: q.askUp, reason: 'arb' });
          out.push({ side: 'DN', action: 'BUY', shares: sh, limit: q.askDn, reason: 'arb' });
          return out;
        }
      }
    }

    const unhedged = pos.up - pos.dn; // >0 long Up, <0 long Down

    // 2) manage an open directional position: lock it or cut it when the edge is gone
    if (Math.abs(unhedged) >= S.minShares) {
      const long = unhedged > 0 ? 'UP' : 'DN';
      const n = Math.abs(unhedged);
      const pMine = long === 'UP' ? pUp : pDn;
      const bidMine = long === 'UP' ? q.bidUp : q.bidDn;
      const askOpp = long === 'UP' ? q.askDn : q.askUp;
      // value of getting out now, per share, by the better of: selling it, or buying the other side (pays $1 at expiry)
      const vSell = bidMine != null ? bidMine - fee(bidMine) : -1;
      const vHedge = askOpp != null ? 1 - askOpp - fee(askOpp) : -1;
      const vOut = Math.max(vSell, vHedge);
      if (vOut > 0) {
        // exit when the market pays more than the model thinks the share is worth,
        // or (optional) as soon as getting out locks in a set return on the money in
        const lockedPer = vOut - pos.cost / Math.max(pos.up, pos.dn);
        const exit = vOut - pMine >= S.exitEdge || (S.lockProfit != null && lockedPer >= S.lockProfit * (pos.cost / Math.max(pos.up, pos.dn)));
        if (exit && ctx.tau >= S.minTauExit) {
          if (vHedge >= vSell) out.push({ side: long === 'UP' ? 'DN' : 'UP', action: 'BUY', shares: n, limit: askOpp, reason: 'hedge' });
          else out.push({ side: long, action: 'SELL', shares: n, limit: bidMine, reason: 'exit' });
          return out;
        }
      }
    }

    // 3) entries: buy the side the model prices above the ask, after fees
    if (ctx.tau > S.maxTauFrac * ctx.len || ctx.tau < S.minTau) return out;
    if (ctx.sinceTrade != null && ctx.sinceTrade < S.cooldown) return out;
    if (Math.abs(f.z) < S.minAbsZ) return out;
    for (const side of ['UP', 'DN']) {
      const ask = side === 'UP' ? q.askUp : q.askDn;
      const p = side === 'UP' ? pUp : pDn;
      if (ask == null || ask < S.minPrice || ask > S.maxPrice) continue;
      const cost = ask + fee(ask);
      const edge = p - cost;
      if (edge < S.entryEdge) continue;
      // do not add against an existing position on the other side
      if ((side === 'UP' && unhedged < 0) || (side === 'DN' && unhedged > 0)) continue;
      // fractional Kelly stake for a binary paying $1: f* = edge / (1 - cost)
      const kelly = clamp(edge / (1 - cost), 0, 1) * S.kellyFrac;
      let usd = Math.min(room(), ctx.budget * Math.min(kelly, S.maxStakeFrac));
      let sh = Math.floor(usd / cost);
      const size = side === 'UP' ? q.askUpSize : q.askDnSize;
      if (size != null) sh = Math.min(sh, Math.floor(size * S.depthFrac));
      if (sh >= S.minShares) { out.push({ side, action: 'BUY', shares: sh, limit: ask, reason: 'edge' }); break; }
    }
    return out;
  }

  // Favourite rule: once inside the time window, buy the side priced inside [lo, hi) and hold it to expiry.
  // Motivated by the favourite-longshot bias measured on the 15-minute markets (see backtest report).
  // F: { lo, hi, tauMin, tauMax, stakeFrac, maker, ttl, modelVeto, minShares }
  function favourite(q, f, ctx, F) {
    F = F || DEFAULTS.favourite;
    if (ctx.tau > F.tauMax || ctx.tau < F.tauMin) return [];
    const rate = ctx.feeRate == null ? 0.07 : ctx.feeRate;
    for (const side of ['UP', 'DN']) {
      const ask = side === 'UP' ? q.askUp : q.askDn;
      const bid = side === 'UP' ? q.bidUp : q.bidDn;
      if (ask == null || ask < F.lo || ask >= F.hi) continue;
      const p = side === 'UP' ? f.p : 1 - f.p;
      if (F.modelVeto != null && p < ask - F.modelVeto) continue; // model thinks this favourite is badly overpriced
      const price = F.maker ? bid : ask;
      if (price == null) continue;
      const cost = F.maker ? price : price + feePerShare(price, rate);
      const sh = Math.floor(ctx.budget * F.stakeFrac / cost);
      if (sh >= F.minShares) return [{ side, action: 'BUY', shares: sh, limit: price, maker: !!F.maker, ttl: F.ttl, reason: 'fav' }];
    }
    return [];
  }

  // ---- the advice: what to do now ---------------------------------------------------------------
  // One function decides for the panel, the browser auto mode, the Vision bot and the backtest.
  //
  // Second leg: holding n shares of one side at cost c per share, buying n of the other side at b
  // pays n whatever happens; return on all money in = 1 / (c + b + fee(b)) - 1.
  // lockPrice: the highest b that still returns at least L.
  function lockPrice(costPerShare, L, rate) {
    for (let b = 0.99; b >= 0.01; b = Math.round((b - 0.01) * 100) / 100) if (b + feePerShare(b, rate) <= 1 / (1 + L) - costPerShare) return b;
    return null;
  }
  // Chance a price now at x trades down to b before the end. A binary that ends at 0 or 1 with fair
  // prices gives x = P(hit) * b + (1 - P(hit)) * 1, so P(hit) = (1 - x) / (1 - b). Estimate only.
  const pHit = (x, b) => (b == null || x == null ? 0 : x <= b ? 1 : Math.max(0, (1 - x) / (1 - b)));
  const mid = (b, a) => (b != null && a != null ? (b + a) / 2 : a != null ? a : b);

  // q: quotes; f: fair() of Up or null; pos: { up, dn, cost };
  // ctx: { tau, len, stake, feeRate }; A: advice settings (DEFAULTS.advice)
  // Returns { kind, orders, plan, side, n, info }:
  //   kind: 'arb' | 'buy' | 'lock' | 'take' | 'hold' | 'locked' | 'wait' | 'late' | 'none'
  //   plan: { side, b, p, L } the second buy that would lock L, and the chance it gets there
  function advise(q, f, pos, ctx, A) {
    A = Object.assign({}, DEFAULTS.advice, A || {});
    const rate = ctx.feeRate == null ? 0.07 : ctx.feeRate;
    const fee = (p) => feePerShare(p, rate);
    const ask = (sd) => (sd === 'UP' ? q.askUp : q.askDn);
    const bid = (sd) => (sd === 'UP' ? q.bidUp : q.bidDn);
    const oth = (sd) => (sd === 'UP' ? 'DN' : 'UP');
    const win = (sd) => (f ? (sd === 'UP' ? f.p : 1 - f.p) : sd === 'UP' ? mid(q.bidUp, q.askUp) : mid(q.bidDn, q.askDn));
    const L = A.lockPct / 100; // acts: lock or take at this return (0 = hold to the end)
    const LP = (A.planPct != null ? A.planPct : A.lockPct) / 100; // shown in the plan
    const planFor = (sd, costPerShare) => {
      if (!(LP > 0)) return null;
      const b = lockPrice(costPerShare, LP, rate);
      const o = oth(sd);
      const x = mid(bid(o), ask(o));
      return b == null || x == null ? null : { side: o, b, p: pHit(x, b), L: LP, acts: L > 0 };
    };
    const out = (kind, extra) => Object.assign({ kind, orders: [], plan: null }, extra || {});

    // 1) both sides together under $1
    if (A.arb && q.askUp != null && q.askDn != null) {
      const c = q.askUp + q.askDn + fee(q.askUp) + fee(q.askDn);
      if (c <= 1 - A.arbMin) {
        let n = Math.floor(ctx.stake / c);
        if (q.askUpSize != null) n = Math.min(n, Math.floor(q.askUpSize * 0.5));
        if (q.askDnSize != null) n = Math.min(n, Math.floor(q.askDnSize * 0.5));
        if (n >= A.minShares) return out('arb', { n, info: { cost: c }, orders: [{ side: 'UP', action: 'BUY', shares: n, limit: q.askUp, reason: 'arb' }, { side: 'DN', action: 'BUY', shares: n, limit: q.askDn, reason: 'arb' }] });
      }
    }

    // 2) already holding
    const un = pos.up - pos.dn;
    if (pos.up >= 1 || pos.dn >= 1) {
      if (Math.abs(un) < 1) return out('locked', { info: { locked: Math.min(pos.up, pos.dn) - pos.cost } });
      const mine = un > 0 ? 'UP' : 'DN';
      const n = Math.floor(Math.abs(un) * 100) / 100;
      const hq = hedgeQuote(q, pos, rate) || {};
      const costPer = pos.cost / Math.max(pos.up, pos.dn);
      if (L > 0 && hq.buyOpp && ctx.tau > A.lockMinTau) {
        const r = hq.buyOpp.locked / (pos.cost + hq.buyOpp.cost);
        if (r >= L) return out('lock', { side: oth(mine), n, info: { locked: hq.buyOpp.locked, roi: r, price: hq.buyOpp.price }, orders: [{ side: oth(mine), action: 'BUY', shares: n, limit: hq.buyOpp.price, reason: 'lock' }] });
      }
      if (L > 0 && A.takeProfit && hq.sell && ctx.tau > A.lockMinTau) {
        const r = hq.sell.locked / pos.cost;
        if (r >= L && (!hq.buyOpp || hq.sell.locked > hq.buyOpp.locked)) return out('take', { side: mine, n, info: { locked: hq.sell.locked, roi: r, price: hq.sell.price }, orders: [{ side: mine, action: 'SELL', shares: n, limit: hq.sell.price, reason: 'take' }] });
      }
      const p = win(mine);
      return out('hold', { side: mine, n, plan: planFor(mine, costPer), info: { p, ev: p * Math.max(pos.up, pos.dn) + (1 - p) * Math.min(pos.up, pos.dn) - pos.cost, ifWin: Math.max(pos.up, pos.dn) - pos.cost } });
    }

    // 3) nothing held
    const fav = q.askUp != null && q.askDn != null ? (q.askUp >= q.askDn ? 'UP' : 'DN') : null;
    const entry = (sd, reason) => {
      const a = ask(sd), cps = a + fee(a);
      const n = Math.floor(ctx.stake / cps);
      if (n < A.minShares) return null;
      return out('buy', { side: sd, n, plan: planFor(sd, cps), info: { price: a, p: win(sd), roiIfWin: 1 / cps - 1, reason }, orders: [{ side: sd, action: 'BUY', shares: n, limit: a, reason }] });
    };
    if (A.fav && fav && ctx.tau <= A.favFrom && ctx.tau >= A.favTo) {
      const a = ask(fav);
      // favVeto: skip when the crypto-price model gives the favourite this much less than its price
      const vetoed = A.favVeto != null && f && win(fav) < a - A.favVeto;
      if (!ctx.noEntry && !vetoed && a >= A.favLo && a < A.favHi) { const e = entry(fav, 'fav'); if (e) return e; }
    }
    if (A.edge && f && ctx.tau > 30 && !ctx.noEntry) {
      for (const sd of ['UP', 'DN']) {
        const a = ask(sd);
        if (a == null || a < 0.05 || a > 0.95) continue;
        if (win(sd) - a - fee(a) >= A.entryEdge) { const e = entry(sd, 'edge'); if (e) return e; }
      }
    }
    if (ctx.tau < A.favTo) return out('late');
    if (A.fav && ctx.tau > A.favFrom) return out('wait', { side: fav, info: { opensIn: ctx.tau - A.favFrom } });
    return out('none', { side: fav });
  }

  // What a hedge of an existing position would lock in right now (for the manual panel).
  // Returns null when there is nothing to hedge or no quote.
  function hedgeQuote(q, pos, feeRate) {
    const un = pos.up - pos.dn;
    if (Math.abs(un) < 1e-9) return null;
    const long = un > 0 ? 'UP' : 'DN';
    const n = Math.abs(un);
    const askOpp = long === 'UP' ? q.askDn : q.askUp;
    const bidMine = long === 'UP' ? q.bidUp : q.bidDn;
    const res = { long, shares: n, buyOpp: null, sell: null };
    if (askOpp != null) {
      const c = n * (askOpp + feePerShare(askOpp, feeRate));
      // after the hedge both outcomes pay min(up, dn) + n = max(up, dn)
      res.buyOpp = { price: askOpp, cost: c, locked: Math.max(pos.up, pos.dn) - (pos.cost + c) };
    }
    if (bidMine != null) {
      const proceeds = n * (bidMine - feePerShare(bidMine, feeRate));
      res.sell = { price: bidMine, proceeds, locked: Math.min(pos.up, pos.dn) - (pos.cost - proceeds) };
    }
    return res;
  }

  // Apply a fill to a position (taker fees included). Returns the cash delta (negative = spent).
  function applyFill(pos, side, action, shares, price, feeRate) {
    const fee = shares * feePerShare(price, feeRate);
    const key = side === 'UP' ? 'up' : 'dn';
    let cash;
    if (action === 'BUY') { pos[key] += shares; cash = -(shares * price + fee); }
    else { pos[key] -= shares; cash = shares * price - fee; }
    pos.cost -= cash;
    pos.fees = (pos.fees || 0) + fee;
    return cash;
  }
  const settle = (pos, upWon) => (upWon ? pos.up : pos.dn) - pos.cost; // P&L of a position at resolution

  const DEFAULTS = {
    // Values come from the backtest fit (backtest/report.html). Re-run it before changing them.
    model: { kTail: 0.8, noise: 0.00004, pFloor: 0.005, vol: { hl: [300, 1800, 7200], w: [0.4, 0.4, 0.2] } },
    modelByTf: { '5m': { kTail: 0.8 }, '15m': { kTail: 0.7 } },
    strategy: {
      arb: true, arbMin: 0.005, depthFrac: 0.5, minShares: 5,
      entryEdge: 0.09, exitEdge: 0.06, lockProfit: null, minAbsZ: 0, minPrice: 0.05, maxPrice: 0.95,
      maxTauFrac: 0.9, minTau: 30, minTauExit: 3, cooldown: 5,
      kellyFrac: 0.25, maxStakeFrac: 0.5,
    },
    favourite: { lo: 0.65, hi: 0.95, tauMin: 60, tauMax: 270, stakeFrac: 0.5, maker: false, ttl: 20, modelVeto: null, minShares: 5 },
    // the advice (advise()). Advice backtest, 96 h of BTC to 2026-11-09 (backtest/advice-bt.mjs), 15m:
    // hold to the end with the 5c model veto +6.3% on stake [0.0, 12.3]; plain hold +2.8%;
    // locking at +5% -1.2% (the plan reaches its price ~89% of the time as estimated, but the misses
    // lose the whole stake). So the default holds; the lock price is shown as information.
    advice: { fav: true, favLo: 0.65, favHi: 0.95, favFrom: 270, favTo: 60, edge: false, entryEdge: 0.09, arb: true, arbMin: 0.005, lockPct: 0, planPct: 5, takeProfit: true, lockMinTau: 3, minShares: 5, favVeto: 0.05 },
  };

  return { normCdf, clamp, logit, sigmoid, feePerShare, Vol, Signals, fair, decide, favourite, advise, lockPrice, pHit, hedgeQuote, applyFill, settle, DEFAULTS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = UDCore;
