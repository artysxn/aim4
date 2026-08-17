// ---------------------------------------------------------------------------
// Zone overlay paint: T is aim4 red, contested is half T red / half CT blue.
// Run: node src/replays/zones/zoneOverlay.paint.test.js
// ---------------------------------------------------------------------------

import { ZONE_PAINT } from './zoneOverlay.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const T = { r: 230, g: 6, b: 17 };
const CT = { r: 91, g: 159, b: 212 };
const mix = {
  r: Math.round((T.r + CT.r) / 2),
  g: Math.round((T.g + CT.g) / 2),
  b: Math.round((T.b + CT.b) / 2)
};

assert(ZONE_PAINT['t-active'].stroke === '#e60611', 'T active stroke is --rv-t');
assert(
  ZONE_PAINT['t-active'].fill.startsWith('rgba(230,6,17,'),
  'T active fill is T red, not gold'
);
assert(
  !ZONE_PAINT['t-active'].fill.includes('240,193,74') &&
    !ZONE_PAINT['t-control'].stroke.includes('9a7620'),
  'old T yellow is gone'
);
assert(ZONE_PAINT.contested.stroke === '#a15373', `contested stroke is the 50/50 mix, got ${ZONE_PAINT.contested.stroke}`);
assert(
  ZONE_PAINT.contested.fill === `rgba(${mix.r},${mix.g},${mix.b},0.4)`,
  `contested fill is the 50/50 mix, got ${ZONE_PAINT.contested.fill}`
);
assert(
  !ZONE_PAINT.contested.fill.includes('210,70,70') && ZONE_PAINT.contested.stroke !== '#d45555',
  'old contested red is gone'
);
assert(ZONE_PAINT['ct-active'].stroke === '#5b9fd4', 'CT blue is unchanged');

console.log('zoneOverlay.paint.test.js: ok');
