// Run: node shared/sim/strategy.test.js

import { Rng } from './rng.js';
import { ExperienceIndex } from './experience.js';
import { StrategyAI } from './strategy.js';
import { situationKey } from './situationKey.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const rng = new Rng(4);
  const index = new ExperienceIndex();
  const sit = situationKey({ map: 'INF', side: 'CT', phase: 'early' });
  const ai = new StrategyAI({ index });
  const cands = [
    { id: 'a-default', protocol: 'poke', convert: 'a' },
    { id: 'b-rush', protocol: 'three-man', convert: 'b' }
  ];
  const pick = ai.select(cands, { key: sit.hash, policyPick: cands[0], rng, idOf: (c) => c.id });
  assert(cands.includes(pick), 'select returns a candidate');
  assert(cands.length === 2, 'and does not shrink the legal set');
  ai.observeRound({ won: false, attrib: 'call' });
  const after = index.read(sit.hash, ai.last.call);
  assert(after.n >= 1, 'the round is in the index');
}

{
  const rng = new Rng(8);
  const index = new ExperienceIndex();
  const sit = situationKey({ map: 'INF', side: 'CT' });
  const ai = new StrategyAI({ index });
  const cands = [{ id: 'a-default' }, { id: 'b-rush' }];
  for (let i = 0; i < 8; i += 1) {
    ai.last = { key: sit.hash, call: 'a-default', banditKey: 'CT|full|even' };
    ai.observeRound({ won: false, attrib: 'call' });
  }
  for (let i = 0; i < 8; i += 1) {
    ai.last = { key: sit.hash, call: 'b-rush', banditKey: 'CT|full|even' };
    ai.observeRound({ won: true, attrib: 'call' });
  }
  const pick = ai.select(cands, { key: sit.hash, policyPick: cands[0], rng, idOf: (c) => c.id, side: 'CT' });
  assert(
    index.read(sit.hash, 'b-rush').lower > index.read(sit.hash, 'a-default').lower,
    'the head prefers the call that actually won'
  );
  assert(cands.includes(pick), 'and select still returns a legal call');
}

// ---- 18.6b: a perceptual loss is not a bad call --------------------------

{
  const index = new ExperienceIndex();
  const sit = situationKey({ map: 'INF', side: 'T' });
  const ai = new StrategyAI({ index });
  for (let i = 0; i < 6; i += 1) {
    ai.last = { key: sit.hash, call: 'a-execute', banditKey: 'T|full|even' };
    ai.observeRound({ won: i % 2 === 0, attrib: 'call' });
  }
  const before = index.read(sit.hash, 'a-execute');
  const weightBefore = ai.bandit.weight('T|full|even', 'a-execute');

  // It ranked its options right and could not see the site was full.
  ai.last = { key: sit.hash, call: 'a-execute', banditKey: 'T|full|even' };
  ai.observeRound({ won: false, attrib: 'perc' });

  const after = index.read(sit.hash, 'a-execute');
  assert(after.n === before.n && after.w === before.w, 'perc adds no pull to the head');
  assert(after.lower === before.lower, 'so the call value does not move');
  assert(after.attrib.perc > 0, 'the bucket is counted instead');
  const weightAfter = ai.bandit.weight('T|full|even', 'a-execute');
  assert(weightAfter === weightBefore, 'and EXP3 is not punished for it either');
}

console.log('strategy: ok');
