// ---------------------------------------------------------------------------
// shared/sim/review.js
// Post-round review (SIM-PLAN 18.6).
//
// After a round the team is allowed PRW and PFW, not god-view positions.
// Search runs from the belief held at the time, not the true world. A drop
// attributed to a better option the same bot had is execution; a drop where
// every option was already bad walks up to the call.
// ---------------------------------------------------------------------------

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
 * @param {object} args
 * @param {{tick:number, drop:number}} args.drop
 * @param {(tick:number) => Array<{id:string, value:number, bot?:number}>} args.optionsAtTick
 * @param {string} [args.played]
 * @param {number} [args.minDelta]
 */
export function attributeDrop({ drop, optionsAtTick, played = null, minDelta = 0.05 } = {}) {
  const opts = optionsAtTick ? optionsAtTick(drop.tick) : [];
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
 */
export function reviewRound({
  timeline = [],
  optionsAtTick = null,
  played = null,
  searchLog = [],
  k = 3
} = {}) {
  const drops = prwDrops(timeline, k);
  const attribs = drops.map((d) => attributeDrop({ drop: d, optionsAtTick, played }));
  const callLosses = attribs.filter((a) => a.kind === 'call').length;
  const execLosses = attribs.filter((a) => a.kind === 'exec').length;
  return {
    drops,
    attribs,
    callLosses,
    execLosses,
    regret: searchLog
  };
}
