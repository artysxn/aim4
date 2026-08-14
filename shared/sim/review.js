// ---------------------------------------------------------------------------
// shared/sim/review.js
// Post-round review (SIM-PLAN 18.6, 18.6b).
//
// After a round the team is allowed PRW and PFW, not god-view positions.
// Search runs from the belief held at the time, not the true world. A drop
// attributed to a better option the same bot had is execution; a drop where
// every option was already bad walks up to the call.
//
// 18.6b adds a third bucket. When the believed ranking of options matched the
// true ranking and only the PRICE was wrong, the loss is PERCEPTION: the team
// ranked correctly on a picture that was not the round. That is not a bad
// call, it is a bad picture, and it is paid as calibration rather than as
// blame — the hivemind is not punished for freezing a 5v4 it believed was 80%
// when the truth was 78%, and it IS told when it believed 80% and truth was
// 51% because the site it had empty was full.
// ---------------------------------------------------------------------------

import { PERC_MARGIN, calibrationFromRows, rankAgrees, residualStats } from './prw.js';

export { PERC_MARGIN };

/**
 * Largest PRW drops, k of them. `timeline` is [{tick, prw}].
 */
export function prwDrops(timeline, k = 3) {
  const rows = timeline || [];
  const drops = [];
  for (let i = 1; i < rows.length; i += 1) {
    const d = (rows[i - 1].prw ?? 0) - (rows[i].prw ?? 0);
    if (d > 0) drops.push({ tick: rows[i].tick, drop: d, i });
  }
  drops.sort((a, b) => b.drop - a.drop);
  return drops.slice(0, k);
}

/**
 * Attribute one drop. `optionsAtTick(tick)` returns [{id, value}] priced from
 * the belief at that moment. If a better option existed for the acting bot,
 * the drop is execution; otherwise walk to the previous decision (the call).
 *
 * When the drop carries a residual (18.6b), perception is tested first: a
 * team whose believed ranking agreed with the true one and whose price was
 * off by more than the margin has a picture problem, and neither the call nor
 * the execution is the lesson.
 *
 * @param {object} args
 * @param {{tick:number, drop:number}} args.drop
 * @param {(tick:number) => Array<{id:string, value:number, bot?:number}>} args.optionsAtTick
 * @param {string} [args.played]
 * @param {number} [args.minDelta]
 * @param {number} [args.residual]  pWin_true - pWin_belief at this tick
 * @param {(tick:number) => Array<{id:string, value:number}>} [args.trueOptionsAtTick]
 * @param {number} [args.percMargin]
 */
export function attributeDrop({
  drop,
  optionsAtTick,
  played = null,
  minDelta = 0.05,
  residual = null,
  trueOptionsAtTick = null,
  percMargin = PERC_MARGIN
} = {}) {
  const opts = optionsAtTick ? optionsAtTick(drop.tick) : [];
  if (Number.isFinite(residual) && Math.abs(residual) > percMargin) {
    // Without a true ranking to compare against, an agreeing ranking is the
    // assumption the margin already encodes: the options were ranked on the
    // same board, only the board was wrong.
    const trueOpts = trueOptionsAtTick ? trueOptionsAtTick(drop.tick) : null;
    const agrees = trueOpts ? rankAgrees(opts, trueOpts) : true;
    if (agrees) {
      return {
        kind: 'perc',
        reason: `the picture was off by ${residual.toFixed(2)} with the ranking intact`,
        tick: drop.tick,
        drop: drop.drop,
        residual
      };
    }
  }
  if (!opts.length) {
    return { kind: 'call', reason: 'no options at the drop', tick: drop.tick, drop: drop.drop };
  }
  let best = opts[0];
  for (const o of opts) if (o.value > best.value) best = o;
  const playedRow = played ? opts.find((o) => o.id === played) : null;
  const playedVal = playedRow ? playedRow.value : opts[0].value;
  if (best.value - playedVal >= minDelta) {
    return {
      kind: 'exec',
      reason: `${best.id} was better than ${played || 'the play'} by ${(best.value - playedVal).toFixed(2)}`,
      tick: drop.tick,
      drop: drop.drop,
      better: best.id
    };
  }
  return {
    kind: 'call',
    reason: 'every option at this point was already bad',
    tick: drop.tick,
    drop: drop.drop
  };
}

/**
 * Review one round. Returns attributions plus the regret log (search
 * disagreements), which is the expert-iteration dataset.
 *
 * With graded PRW rows (18.6b), the walk uses the TRUE timeline — that is
 * where the round actually dropped — and the residual at those moments is the
 * perception lesson. Without them it is 18.6 exactly as before, on whatever
 * timeline the caller hands in.
 *
 * @param {object} args
 * @param {Array<{tick:number, prw:number}>} [args.timeline]
 * @param {Array<object>} [args.rows]  graded rows from prw.js
 * @param {Array<object>} [args.searchLog]
 */
export function reviewRound({
  timeline = [],
  rows = [],
  optionsAtTick = null,
  trueOptionsAtTick = null,
  played = null,
  searchLog = [],
  k = 3
} = {}) {
  const graded = rows.filter((r) => Number.isFinite(r?.pWin_true));
  const trueLine = graded.length
    ? graded.map((r) => ({ tick: r.tick, prw: r.pWin_true })).sort((a, b) => a.tick - b.tick)
    : timeline;
  const residualAt = new Map(graded.map((r) => [r.tick, r.residual]));

  const drops = prwDrops(trueLine, k);
  const attribs = drops.map((d) =>
    attributeDrop({
      drop: d,
      optionsAtTick,
      trueOptionsAtTick,
      played,
      residual: residualAt.has(d.tick) ? residualAt.get(d.tick) : null
    })
  );
  const countOf = (kind) => attribs.filter((a) => a.kind === kind).length;
  return {
    drops,
    attribs,
    callLosses: countOf('call'),
    execLosses: countOf('exec'),
    percLosses: countOf('perc'),
    // What the experience index writes: a bias per situation, and the honesty
    // of the picture over the whole round.
    calibrations: calibrationFromRows(graded),
    residuals: residualStats(graded),
    believed: graded.map((r) => ({ tick: r.tick, prw: r.pWin_belief })),
    truth: trueLine,
    regret: searchLog
  };
}
