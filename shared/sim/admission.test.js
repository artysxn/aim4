// Run: node shared/sim/admission.test.js
//
// 7.0's acceptance is one sentence: a checkpoint becomes gen N, or the fail
// names the gate. So the checks here are mostly about the second half, plus
// the rule the old eval got wrong -- a skipped gate is not a passed gate.

import {
  ELO_GATE,
  GATES,
  GATE_IDS,
  GATE_STATUS,
  VERDICT,
  admit,
  buildManifest,
  eloFromScore,
  gateResult
} from './admission.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const all = (status, reason = 'because') => GATE_IDS.map((id) => gateResult(id, status, reason));

// ---- elo -------------------------------------------------------------------

{
  const even = eloFromScore(50, 100);
  assert(Math.abs(even.elo) < 1e-9, 'an even score is zero Elo');
  assert(even.lo < 0 && even.hi > 0, 'and its interval straddles zero');

  const strong = eloFromScore(75, 100);
  assert(strong.elo > 190 && strong.elo < 200, `75% is about 191 Elo, got ${strong.elo.toFixed(1)}`);
  assert(strong.lo < strong.elo && strong.hi > strong.elo, 'the estimate sits inside its interval');

  // More games, same rate: the same estimate, held more tightly. This is the
  // whole reason 9.8 asks for 400 matches rather than 40.
  const few = eloFromScore(30, 50);
  const many = eloFromScore(300, 500);
  assert(Math.abs(few.elo - many.elo) < 1e-9, 'the same rate is the same Elo');
  assert(many.hi - many.lo < few.hi - few.lo, 'but ten times the games is a tighter interval');

  // A clean sweep must not be infinite.
  const swept = eloFromScore(40, 40);
  assert(Number.isFinite(swept.elo) && swept.elo > 0, `40/40 is large and finite: ${swept.elo.toFixed(0)}`);
}

// ---- the fail names the gate ----------------------------------------------

{
  const results = all(GATE_STATUS.PASS);
  const i = results.findIndex((r) => r.id === 'elo');
  results[i] = gateResult('elo', GATE_STATUS.FAIL, '4 Elo vs navaja-3, gate +25');
  const v = admit(results);
  assert(v.verdict === VERDICT.REJECTED, 'a failed gate rejects');
  assert(v.failed.id === 'elo', 'and the verdict carries which one');
  assert(/gate 1 \(Elo vs parent\)/.test(v.reason), `the reason names it: ${v.reason}`);
  assert(/4 Elo/.test(v.reason), 'and carries the number that failed');
}

{
  // Two failures: the one reported is the most fundamental, not the last one
  // evaluated. A nondeterministic engine makes the Elo meaningless, so saying
  // "Elo too low" there would send someone to tune the wrong thing.
  const results = all(GATE_STATUS.PASS);
  for (const id of ['elo', 'determinism']) {
    results[results.findIndex((r) => r.id === id)] = gateResult(id, GATE_STATUS.FAIL, `${id} broke`);
  }
  const v = admit(results);
  assert(v.failed.id === 'determinism', `determinism is reported first, got ${v.failed.id}`);
  assert(GATES[0].id === 'determinism', 'because it is first in the gate order');
}

// ---- a skipped gate is not a passed gate ----------------------------------

{
  const results = all(GATE_STATUS.PASS);
  results[results.findIndex((r) => r.id === 'surprise')] = gateResult(
    'surprise',
    GATE_STATUS.SKIP,
    'no library band on this host'
  );

  const strict = admit(results);
  assert(strict.verdict === VERDICT.REJECTED, 'an unscored gate blocks admission by default');
  assert(!strict.failed, 'without naming a failure, because nothing failed');
  assert(/could not be scored/.test(strict.reason), `the reason says so: ${strict.reason}`);

  const allowed = admit(results, { allowSkipped: true });
  assert(allowed.verdict === VERDICT.PROVISIONAL, 'allowing skips admits PROVISIONALLY');
  assert(allowed.verdict !== VERDICT.ADMITTED, 'and never plain admitted');
  assert(allowed.skipped.includes('surprise'), 'and lists what was never scored');
  assert(allowed.scored === GATE_IDS.length - 1, `scored counts only what ran: ${allowed.scored}`);

  // The failure still wins over the skip: allowing skips is not a bypass.
  const withFail = results.map((r) =>
    r.id === 'belief' ? gateResult('belief', GATE_STATUS.FAIL, 'KL worse than the prior') : r
  );
  assert(
    admit(withFail, { allowSkipped: true }).verdict === VERDICT.REJECTED,
    '--allow-skipped never rescues a real failure'
  );
}

{
  const clean = admit(all(GATE_STATUS.PASS));
  assert(clean.verdict === VERDICT.ADMITTED, 'all nine scored and passed is admitted');
  assert(clean.skipped.length === 0 && clean.scored === GATE_IDS.length, 'with nothing unscored');

  // A gate nobody reported is the same hazard as a skip, one level up.
  const partial = admit(all(GATE_STATUS.PASS).slice(0, 4));
  assert(partial.verdict === VERDICT.REJECTED, 'gates never reported reject');
  assert(/never reported/.test(partial.reason), `and say which: ${partial.reason}`);
}

// ---- the manifest carries the verdict -------------------------------------

{
  const results = all(GATE_STATUS.PASS);
  results[0] = gateResult(results[0].id, GATE_STATUS.SKIP, 'not on this host');
  const verdict = admit(results, { allowSkipped: true });
  const m = buildManifest({
    name: 'paracord-1',
    parent: 'navaja-3',
    gen: 4,
    verdict,
    results,
    league: ['navaja-3', 'scripted'],
    elo: { vs: 'navaja-3', elo: 60 },
    evalId: 'paracord-1-abc',
    createdAt: '2026-08-15T00:00:00Z'
  });
  assert(m.gen === 4 && m.parent === 'navaja-3', 'the manifest is a registry row');
  assert(m.admission.verdict === VERDICT.PROVISIONAL, 'and carries the verdict with the weights');
  assert(m.admission.skipped.length === 1, 'so a reader sees the skip without finding the report');
  assert(m.admission.gates.length === GATE_IDS.length, 'every gate is listed, passed or not');
  assert(m.individual.weights === 'paracord-1.json', 'pointing at the weights it admitted');
}

// ---- the shape refuses nonsense -------------------------------------------

{
  let threw = 0;
  try { gateResult('not-a-gate', GATE_STATUS.PASS, 'x'); } catch { threw += 1; }
  try { gateResult('elo', 'maybe', 'x'); } catch { threw += 1; }
  try { gateResult('elo', GATE_STATUS.FAIL, ''); } catch { threw += 1; }
  assert(threw === 3, 'an unknown gate, a bad status, and a reasonless verdict all throw');
  assert(ELO_GATE === 25, 'the Elo bar is 9.8 gate 1');
}

console.log(`admission: ok (${GATE_IDS.length} gates, skip is not pass, the fail names the gate)`);
