// Run: node tools/eye/plays/plays-tools.test.mjs
//
// The plays training tools, without a model:
//
//   * reference answers pass their own grading, on every sample round; an
//     invented number or the wrong verdict fails it
//   * a perturbed guess scores lower than the right one; a wrong verdict is wrong
//   * lessons come from repeated mistakes only, carry the definition, and the
//     graders' corrections join them
//   * a bad graded play answer is paired with the answer its own tool results support
//   * the grade corrections note the eye's prompt ends with
//   * an index survives the corpus cache

import assert from 'node:assert/strict';

import { gradeLessonsNote, systemWith, SYSTEM_PROMPT } from '../../../src/replays/eye/eyeAgent.js';
import { TOOLS } from '../../../src/replays/eye/eyeTools.js';
import { checkGuess } from '../../../src/replays/plays/findPlays.js';
import {
  gradePairs,
  gradePlays,
  gradeReview,
  perturbGuess,
  playsAnswer,
  reviewAnswer,
  reviewable,
  verdictOf,
  wrongVerdict
} from './answers.mjs';
import { baselinesFor, playsMemo, playsResult, reviewResult, truthGuess } from './common.mjs';
import { deserializeIndex, heldOut, loadCorpus, serializeIndex } from './corpus.mjs';
import { buildLessons, countGuess, countVerdict, emptyStats, mergeStats } from './notes.mjs';

// ---- the tools the eye calls are registered ---------------------------------------
{
  const names = TOOLS.map((t) => t.function.name);
  for (const n of ['round_moves', 'round_plays', 'play_review']) assert.ok(names.includes(n), `${n} is offered to the model`);
  const review = TOOLS.find((t) => t.function.name === 'play_review').function.parameters;
  assert.deepEqual(review.properties.guess.properties.verdict.enum, ['good', 'bad', 'mixed']);
  assert.ok(review.properties.round && review.properties.match, 'a round by file, or by match and number');
  assert.match(SYSTEM_PROMPT, /round_moves first, then your own reading/, 'the prompt says to guess before checking');
}

// ---- grade corrections in the prompt -----------------------------------------------
{
  assert.equal(gradeLessonsNote([]), '', 'no corrections, no note');
  const note = gradeLessonsNote([{ question: 'Was the B execute good?', comment: 'Say how many similar rounds it rests on.' }, { comment: '' }]);
  assert.match(note, /^Corrections from answers you were graded on/);
  assert.match(note, /- Asked "Was the B execute good\?": Say how many similar rounds it rests on\./);
  assert.equal(note.split('\n').length, 2, 'an empty comment is no correction');
  assert.ok(systemWith(note).startsWith(SYSTEM_PROMPT) && systemWith(note).endsWith(note));
  assert.equal(systemWith(''), SYSTEM_PROMPT);
  const long = gradeLessonsNote(Array.from({ length: 30 }, (_, i) => ({ comment: `fix ${i} ${'x'.repeat(500)}` })));
  assert.equal(long.split('\n').length, 13, 'at most twelve corrections');
  assert.ok(long.split('\n').every((l) => l.length <= 400), 'each one cut short');
}

// ---- lessons -------------------------------------------------------------------------
{
  const stats = emptyStats();
  const plays = [
    { id: 'T1', side: 'T', kind: 'contact', site: 'B', start: 50, end: 70, clock: '1:05', label: 'B contact' },
    { id: 'CT1', side: 'CT', kind: 'setup', start: 0, end: 30, clock: '1:55', label: 'setup 2-1-2' }
  ];
  for (let i = 0; i < 5; i++) countGuess(stats, 'MIR', plays, checkGuess([{ side: 'T', kind: 'execute', site: 'B', clock: '1:05' }, { side: 'CT', kind: 'setup' }], plays));
  countGuess(stats, 'MIR', plays, checkGuess([{ side: 'T', kind: 'contact', site: 'B', clock: '1:05' }, { side: 'CT', kind: 'setup' }], plays));
  for (let i = 0; i < 4; i++) countVerdict(stats, 'MIR', 'contact', 'good', 'bad');
  const merged = mergeStats(emptyStats(), stats);
  const { lessons } = buildLessons(merged, { graded: [{ question: 'what happened in round 4?', comment: 'You called a stack a setup.' }] });
  const confusion = lessons.find((l) => l.kind === 'contact' && /read 5 of 6 contacts as a execute/.test(l.text));
  assert.ok(confusion, `a contact read as an execute five times in six is a lesson (${lessons.map((l) => l.text).join(' | ')})`);
  assert.match(confusion.text, /A contact hit is 2\+ players onto a site with fewer than 3 grenades/, 'with the definition of what was confused');
  assert.equal(confusion.map, 'MIR');
  assert.ok(lessons.some((l) => /expected 4 of 4 contact hits the similar rounds called good to be bad/.test(l.text)), 'a verdict expected wrong again and again is a lesson');
  assert.ok(lessons.some((l) => /A grader marked an answer wrong \("what happened in round 4\?"\): You called a stack a setup\./.test(l.text)), 'the grader\'s correction is a lesson');
  assert.ok(!lessons.some((l) => l.kind === 'setup'), 'what it got right is no lesson');
  const once = emptyStats();
  countGuess(once, 'MIR', plays, checkGuess([{ side: 'T', kind: 'execute', site: 'B' }], plays));
  assert.equal(buildLessons(once).lessons.length, 0, 'one mistake is not a pattern');
}

// ---- grades on play answers ------------------------------------------------------------
{
  const review = { verdict: 'bad', play: { id: 'T2', side: 'T', label: 'A rush', from: '1:44' }, why: ['T win chance fell 32 points over the play.'], improve: ['Consider contact A from here: 4 of 6 won (67%) against 0 of 9 (0%) for rush A.'], similar: { rounds: 33, closest_pct: 68, median_pct: 51, trust: 'good' }, decision: 'worse than contact A', execution_read: 'better than usual' };
  const trace = (verdict, comment, result) => ({
    task: 'eye-trace',
    verdict,
    comment,
    subject: { question: 'Was the rush good?' },
    bot: {
      system: 'SYS',
      tools: [],
      messages: [
        { role: 'user', content: 'Was the rush good?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'play_review', arguments: '{"play":"T2"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: result },
        { role: 'assistant', content: 'Good play, nothing to change.' }
      ]
    }
  });
  const pairs = gradePairs([trace('no', 'It was a bad call', JSON.stringify(review)), trace('yes', '', JSON.stringify(review)), trace('no', 'cut', '{"verdict":"ba')]);
  assert.equal(pairs.length, 1, 'only bad answers whose tool result can be read back');
  assert.equal(pairs[0].prompt.at(-1).role, 'tool', 'the turn as it was, up to the answer');
  assert.equal(pairs[0].rejected[0].content, 'Good play, nothing to change.');
  assert.match(pairs[0].chosen[0].content, /^(Bad play|It was a bad play)\./, 'the answer the review supports');
  assert.equal(verdictOf(pairs[0].chosen[0].content), 'bad');
  assert.equal(pairs[0].note, 'It was a bad call');
}

// ---- reference answers on the sample demos ----------------------------------------------
{
  const corpus = await loadCorpus({ maps: ['CCH'], cache: '' });
  const indexes = corpus.get('CCH') || [];
  if (indexes.length < 20) {
    console.log('plays-tools.test.mjs: sampledemos/ has no Cache rounds, sample checks skipped');
  } else {
    const baselines = await baselinesFor(corpus, { dir: '/nonexistent' });
    const baseline = baselines.get('CCH');
    const playsOf = playsMemo();
    let passed = 0;
    let reviews = 0;
    for (const index of indexes) {
      const plays = playsOf(index, baseline);
      const guess = truthGuess(plays);
      assert.equal(checkGuess(guess, plays).score, 100, `${index.file}: the truth guess scores 100`);
      const wrong = perturbGuess(guess, plays, index.file);
      assert.ok(checkGuess(wrong, plays).score < 100, `${index.file}: a perturbed guess scores less`);
      const report = playsResult(index, baseline, plays, { guess });
      const text = JSON.stringify(report);
      const answer = playsAnswer(report);
      const g = gradePlays(answer, [text], report);
      assert.ok(g.grounded, `${index.file}: the reference answer is grounded (${g.ungrounded})`);
      if (g.pass) passed++;
      assert.equal(gradePlays(`${answer}\nThey threw 4321 grenades.`, [text], report).grounded, false, 'an invented number is caught');
      for (const play of reviewable(plays).slice(0, 1)) {
        const review = reviewResult(index, play, indexes.filter((x) => x !== index), baseline, playsOf);
        const r = reviewAnswer(review);
        const rg = gradeReview(r, [JSON.stringify(review)], review);
        assert.ok(rg.pass, `${index.file} ${play.label}: the reference review answer passes (${JSON.stringify(rg)})`);
        assert.equal(verdictOf(r), review.verdict);
        const flipped = reviewAnswer({ ...review, verdict: wrongVerdict(review.verdict, index.file) });
        assert.equal(gradeReview(flipped, [JSON.stringify(review)], review).pass, false, 'the wrong verdict fails');
        reviews++;
      }
    }
    assert.equal(passed, indexes.length, 'every reference plays answer passes its own grading');
    assert.ok(reviews > 20);

    // The corpus cache gives back the same index.
    const back = deserializeIndex(serializeIndex(indexes[0]));
    assert.deepEqual(Array.from(back.px.slice(0, 50)), Array.from(indexes[0].px.slice(0, 50)));
    assert.deepEqual(back.kills, indexes[0].kills);
    assert.deepEqual(playsOf(back, baseline).map((p) => p.label), playsOf(indexes[0], baseline).map((p) => p.label));
    // Held out by match: every round of a match lands on the same side.
    const byDemo = new Map();
    for (const i of indexes) {
      const demo = i.file.split('~')[1];
      if (!byDemo.has(demo)) byDemo.set(demo, new Set());
      byDemo.get(demo).add(heldOut(i.file));
    }
    for (const sides of byDemo.values()) assert.equal(sides.size, 1, 'a match is never split between training and held out');
  }
}

console.log('plays-tools.test.mjs: all assertions passed');
