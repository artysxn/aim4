import assert from 'node:assert/strict';
import { mapBloomParams } from './lookBloom.js';

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
  assert.equal(p.threshold, 1, 'inferno does not bloom below 1 in linear HDR');
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
  assert.equal(p.strength, 0.0112, 'nuke keeps its screen strength');
  assert.equal(p.threshold, 1.055);
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
  assert.equal(p.strength, 0.163, 'ancient keeps its HDR-safe add bloom');
  assert.equal(p.threshold, 1.143);
}

{
  const p = mapBloomParams(null);
  assert.equal(p.strength, 0);
}

console.log('lookBloom: ok');
