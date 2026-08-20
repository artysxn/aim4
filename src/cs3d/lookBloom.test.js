import assert from 'node:assert/strict';
import { mapBloomParams, HDR_BLOOM_FLOOR, BLOOM_STRENGTH_CAP } from './lookBloom.js';

{
  const p = mapBloomParams({
    screenStrength: 0,
    strength: 0.12,
    threshold: 0.599,
    computeStrength: 0.03,
    computeThreshold: 1,
    computeRadius: 0.6,
    skyboxStrength: 0.1557
  });
  assert.equal(p.strength, 0.03, 'inferno uses compute bloom, not the LDR add');
  assert.equal(p.threshold, HDR_BLOOM_FLOOR, 'inferno does not bloom sky haze');
  assert.equal(p.radius, 0.6);
}

{
  const p = mapBloomParams({
    screenStrength: 0.0112,
    strength: 0,
    threshold: 1.055,
    computeStrength: 0.03,
    computeThreshold: 1,
    computeRadius: 0.6
  });
  assert.equal(p.strength, 0.0112, 'nuke keeps its small screen strength');
  assert.equal(p.threshold, HDR_BLOOM_FLOOR, 'nuke does not bloom below the HDR floor');
}

{
  const p = mapBloomParams({
    screenStrength: 0,
    strength: 0.163,
    threshold: 1.143,
    computeStrength: 0.34,
    computeThreshold: 8,
    computeRadius: 0.34
  });
  assert.equal(p.strength, BLOOM_STRENGTH_CAP, 'ancient add bloom is capped as an HDR add');
  assert.equal(p.threshold, HDR_BLOOM_FLOOR);
}

{
  const p = mapBloomParams({
    screenStrength: 0.13,
    strength: 0,
    threshold: 1,
    computeStrength: 0.03,
    computeThreshold: 1,
    computeRadius: 0.6
  });
  assert.equal(p.strength, BLOOM_STRENGTH_CAP, 'mirage screen 0.13 is not used as an HDR add');
  assert.ok(p.threshold >= 2.5, 'and the sun disc is the only thing that blooms');
}

{
  const p = mapBloomParams(null);
  assert.equal(p.strength, 0);
}

console.log('lookBloom: ok');
