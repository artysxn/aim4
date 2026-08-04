// ---------------------------------------------------------------------------
// replays/duels/scoring.js
// Two ways of marking the model's homework, kept separate on purpose.
//
// The EXAM is the readable one. A prediction of 60/40 that comes true scores
// +2, and the same prediction that fails scores -2: the confidence above even
// money is the stake, and being right wins it while being wrong loses it. A
// 50/50 call scores nothing either way, because it said nothing.
//
// The exam alone cannot be the training objective, though, and the reason is
// worth being precise about. Its score is linear in the predicted probability,
// so on any fight the model believes it will win more often than not, the
// score improves all the way to predicting 100%. A model trained on the exam
// would learn to shout every call with total confidence and would be rewarded
// for it, right up until it was wrong, and the average would still come out
// ahead. That is not confidence, it is a bluff that the scoring cannot see.
//
// So LOG LOSS trains, and the exam only reports. Log loss is a proper scoring
// rule: its expected value is minimised only by stating the true probability,
// which means overclaiming is punished harder than the overclaim gains. A model
// that says 99% and is wrong one time in ten takes a beating it cannot average
// away. That is exactly the "cannot lie to the meter" property this needs.
//
// DOM-free.
// ---------------------------------------------------------------------------

/** Keeps log(0) out of the arithmetic without meaningfully moving any score. */
const EPS = 1e-6;

/**
 * Binary cross-entropy, in nats. Lower is better.
 * A coin flip on every duel scores ln(2) = 0.693, which is the number any
 * trained model has to beat to have learned anything at all.
 *
 * @param {number} p  predicted probability that A wins
 * @param {number} y  1 when A won, 0 when B won
 */
export function logLoss(p, y) {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

/**
 * Brier score: squared error on the probability. Reported alongside log loss
 * because it is bounded and therefore easier to compare across buckets that
 * contain a handful of confident mistakes.
 */
export function brier(p, y) {
  return (p - y) * (p - y);
}

/**
 * The exam: confidence above even money, signed by whether it was right.
 *
 * 60/40 correct = +2, 60/40 wrong = -2, 50/50 = 0, 100/0 correct = +10.
 *
 * @param {number} p  predicted probability that A wins
 * @param {number} y  1 when A won, 0 when B won
 */
export function examPoints(p, y) {
  const pWinner = y === 1 ? p : 1 - p;
  return (pWinner - 0.5) * 20;
}

/** Running weighted mean, so no caller has to keep two variables in step. */
export function createMeter() {
  let sum = 0;
  let weight = 0;
  return {
    add(value, w = 1) {
      sum += value * w;
      weight += w;
    },
    get mean() {
      return weight > 0 ? sum / weight : 0;
    },
    get total() {
      return sum;
    },
    get weight() {
      return weight;
    }
  };
}

/**
 * Score one prediction into every meter at once.
 *
 * @param {object} acc  from createScoreAccumulator
 * @param {number} p @param {number} y @param {number} w
 */
export function score(acc, p, y, w = 1) {
  acc.n += 1;
  acc.weight += w;
  acc.loss += logLoss(p, y) * w;
  acc.brier += brier(p, y) * w;
  acc.exam += examPoints(p, y) * w;
  acc.predicted += p * w;
  acc.actual += y * w;
}

export function createScoreAccumulator() {
  return { n: 0, weight: 0, loss: 0, brier: 0, exam: 0, predicted: 0, actual: 0 };
}

/**
 * Finished numbers from an accumulator.
 *
 * `predicted` against `actual` is the calibration check: a model claiming 70%
 * across a thousand duels should have won about seven hundred of them, and the
 * gap between those two is what tells the next generation which situations it
 * is systematically wrong about rather than merely uncertain in.
 */
export function summarize(acc) {
  const w = acc.weight || 1;
  return {
    n: acc.n,
    weight: acc.weight,
    logLoss: acc.loss / w,
    brier: acc.brier / w,
    exam: acc.exam / w,
    examTotal: acc.exam,
    predicted: acc.predicted / w,
    actual: acc.actual / w,
    calibration: Math.abs(acc.predicted / w - acc.actual / w)
  };
}
