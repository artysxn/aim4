// Run: node shared/sim/modelNames.test.js

import {
  HIVEMIND_PREFIX,
  KNIFE_TIERS,
  LEGACY_ALIASES,
  LINEAGE,
  TEST_TIER,
  compareModelNames,
  displayName,
  formatModelId,
  nextModelName,
  parseModelId,
  resolveModelName
} from './modelNames.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- one vocabulary, two brains ------------------------------------------

{
  assert(parseModelId('navaja-1').lineage === LINEAGE.INDIVIDUAL, 'a bare name is the bots');
  assert(parseModelId('igl-navaja-1').lineage === LINEAGE.HIVEMIND, 'the prefix is the caller');
  assert(parseModelId('paracord-1').tierIndex > parseModelId('navaja-1').tierIndex, 'tiers ascend');
  assert(KNIFE_TIERS[0] === 'navaja' && KNIFE_TIERS.at(-1) === 'karambit', 'the tier order');
  assert(HIVEMIND_PREFIX === 'igl', 'and the prefix is spelled one way');

  // The pair of a generation carries ONE name, because they are one
  // generation: same corpus, same level, meant to be run together.
  const bots = parseModelId('paracord-lite-1');
  const caller = parseModelId('igl-paracord-lite-1');
  assert(bots.tier === caller.tier && bots.major === caller.major, 'same tier, same number');
  assert(bots.variant === caller.variant, 'and the same variant');
  assert(bots.display === 'Paracord Lite 1', `bots: ${bots.display}`);
  assert(caller.display === 'Paracord Lite 1 (IGL)', `caller: ${caller.display}`);
  assert(bots.id !== caller.id, 'but two files, because they are two nets');
}

// ---- ids parse, format, and round-trip -----------------------------------

{
  const p = parseModelId('paracord-lite-1-2');
  assert(p.tier === 'paracord' && p.variant === 'lite', 'variant is read off the tier');
  assert(p.major === 1 && p.minor === 2, 'and the version behind it');
  assert(p.display === 'Paracord Lite 1.2', `display: ${p.display}`);
  assert(p.id === 'paracord-lite-1-2', 'canonical id round-trips');
}

{
  assert(displayName({ tier: 'navaja', major: 1 }) === 'Navaja 1', 'minor zero is not shown');
  assert(displayName({ tier: 'alpha', major: 2, minor: 1 }) === 'Alpha 2.1', 'minor is shown');
  assert(formatModelId({ tier: 'paracord', major: 1, minor: 0 }) === 'paracord-1', 'nor written');
  // The short and long spellings of the same model are the same model.
  assert(parseModelId('paracord-1-0').id === parseModelId('paracord-1').id, 'one model, one id');
  // A bare tier is that tier's first model, because that is what people type.
  assert(parseModelId('karambit').id === 'karambit-1', 'a bare tier means 1');
}

{
  assert(parseModelId('') === null, 'nothing is not a model');
  assert(parseModelId('bc0') === null, 'a legacy id is not a scheme id');
  assert(parseModelId('paracord-1-2-3') === null, 'trailing junk is a different name');
  assert(parseModelId('paracord-0') === null, 'there is no version zero');
  assert(parseModelId('spatula-1') === null, 'and no tier called spatula');
}

// ---- legacy names still resolve ------------------------------------------

{
  assert(resolveModelName('bc0') === 'navaja-1', 'the scripted-teacher clone');
  assert(resolveModelName('gen1') === 'navaja-2', 'the RL smoke test');
  assert(resolveModelName('demo-g0') === 'navaja-3', 'the first real demo-trained net');
  assert(resolveModelName('Paracord-1') === 'paracord-1', 'case is normalized');
  // An unknown name comes back untouched: a one-off file predating all of
  // this must still be loadable by whatever it is actually called.
  assert(resolveModelName('some-experiment') === 'some-experiment', 'unknown names survive');
  assert(Object.keys(LEGACY_ALIASES).length === 3, 'three legacy names, no more inventing');
}

// ---- ordering ------------------------------------------------------------

{
  const sorted = [
    'igl-paracord-lite-1',
    'paracord-2',
    'navaja-1',
    'igl-navaja-1',
    'paracord-1-3',
    'paracord-lite-1',
    'paracord-1'
  ].sort(compareModelNames);
  // A generation's two halves sit together, which is how they are run. Within
  // a tier the full run's versions come in order, then the lite run's — two
  // variants' version numbers are not comparable, so they do not interleave.
  assert(
    sorted.join(' ') ===
      'navaja-1 igl-navaja-1 paracord-1 paracord-1-3 paracord-2 paracord-lite-1 igl-paracord-lite-1',
    `order: ${sorted.join(' ')}`
  );
}

{
  // Unnameable files sort last rather than vanishing: the file nobody can name
  // is the one somebody is trying to find.
  const sorted = ['zzz-experiment', 'navaja-1'].sort(compareModelNames);
  assert(sorted[0] === 'navaja-1' && sorted[1] === 'zzz-experiment', 'strays go last');
}

// ---- the Nomad wanders outside the ladder --------------------------------

{
  // It's a Nomad. Clue's in the name: a knife, but never a rung.
  const n = parseModelId('nomad-1');
  assert(n && n.tier === TEST_TIER, 'the harness parses');
  assert(n.display === 'Nomad 1', `and reads as ${n.display}`);
  assert(!KNIFE_TIERS.includes(TEST_TIER), 'but is not on the ladder');
  assert(n.tierIndex < parseModelId('navaja-1').tierIndex, 'it sits below Navaja');
  const sorted = ['navaja-1', 'nomad-1'].sort(compareModelNames);
  assert(sorted[0] === 'nomad-1', 'so a listing shows the harness first');
  // A Nomad has no successor: improving the harness is editing its knobs,
  // not promoting it to Navaja.
  assert(nextModelName('nomad-1', 'tier') === null, 'no next tier');
  assert(nextModelName('nomad-1', 'minor') === 'nomad-1-1', 'but knob revisions still count');
}

// ---- what comes next -----------------------------------------------------

{
  assert(nextModelName('paracord-1', 'minor') === 'paracord-1-1', 'a touch-up');
  assert(nextModelName('paracord-1-3', 'major') === 'paracord-2', 'a real change resets the minor');
  assert(nextModelName('paracord-1', 'tier') === 'bayonet-1', 'a new brain is a new name');
  // The caller walks the same ladder and keeps its prefix all the way up.
  assert(nextModelName('igl-paracord-1', 'tier') === 'igl-bayonet-1', 'the caller ascends too');
  assert(nextModelName('igl-paracord-1', 'minor') === 'igl-paracord-1-1', 'and versions the same');
  // A variant keeps its variant across a tier step: Paracord Lite improving
  // into Bayonet is still the lite run of Bayonet, not the full one.
  assert(nextModelName('paracord-lite-1', 'tier') === 'bayonet-lite-1', 'lite stays lite');
  assert(nextModelName('karambit-1', 'tier') === null, 'the last knife has no successor');
  assert(nextModelName('bc0', 'major') === null, 'and a legacy id is not a place to count from');
}

console.log('modelNames: ok');
