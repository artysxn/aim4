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

console.log('strategy: ok');
