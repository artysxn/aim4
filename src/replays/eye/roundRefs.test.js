// Run: node src/replays/eye/roundRefs.test.js
//
// Reading back a round id a model copied badly, and never landing on the
// wrong round while doing it. The ids are real ones from sampledemos/, and the
// mangled copies are the two kinds a Qwen3.5-35B-A3B eval run produced.

import assert from 'node:assert/strict';
import { editDistance, noteRounds, resolveRound, roundIdsIn, seenRounds } from './roundRefs.js';

const r06 = 'CNh-Rrx-145-CCH-06_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe';
const r07 = 'CNh-Rrx-146-CCH-07_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe';
const r11 = 'CNh-Rrx-144-CCH-11_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe';
const a21 = 'CNh-ZvZ-154-ANU-21_q1S-X74-VmM-RG9-rBR_PIa-1hM-Bvc-YDH-SvE~45f139d949a0d13d';
const known = [r06, r07, r11, a21];

assert.equal(editDistance('kitten', 'sitting'), 3);
assert.equal(editDistance('', 'abc'), 3);

assert.deepEqual(resolveRound(r06, known), { round: r06, repaired: false }, 'an exact id is itself');

// A repeated segment, as seen in the eval: "…-CCH-06_rBR-06_rBR-…".
assert.deepEqual(resolveRound('CNh-Rrx-145-CCH-06_rBR-06_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe', known), { round: r06, repaired: true });
assert.deepEqual(resolveRound('CNh-Rrx-144-CCH-11_rBR-11_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe', known), { round: r11, repaired: true });
// A dropped hash character, as seen in the eval.
assert.deepEqual(resolveRound('CNh-ZvZ-154-ANU-21_q1S-X74-VmM-RG9-rBR_PIa-1hM-Bvc-YDH-SvE~45f139d49a0d13d', known), { round: a21, repaired: true });

// Never a neighbouring round of the same demo, and never a guess.
assert.equal(resolveRound('CNh-Rrx-147-CCH-08_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe', known), null, 'a round that is not known is not repaired into one that is');
assert.equal(resolveRound('CNh-Rrx-145-CCH-06_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~ffffffffffffffff', known), null, 'a different demo hash is a different demo');
assert.equal(resolveRound('round 6', known), null);
assert.equal(resolveRound('', known), null);
assert.equal(resolveRound(r06, []), null, 'nothing known, nothing to repair against');

// Ids are picked out of questions and tool results.
assert.deepEqual(roundIdsIn(`Round ${r06} (fnatic on Cache): what decided it? Also "${a21}".`), [r06, a21]);
assert.deepEqual(roundIdsIn('{"file":"' + r07 + '","round":7}'), [r07]);
assert.deepEqual(roundIdsIn('no ids here, 1:15 and 30%'), []);

noteRounds([r06, r07, r06]);
assert.deepEqual(seenRounds(), [r07, r06], 'remembered once each, newest last');

console.log('roundRefs.test.js ok');
