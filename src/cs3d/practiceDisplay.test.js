// Run: node src/cs3d/practiceDisplay.test.js

import { practiceBackbuffer } from './practiceDisplay.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const native = practiceBackbuffer({ resolution: 'native' }, 1920, 1080, 2);
assert(native.width === 1920 && native.height === 1080, 'native uses the window');
assert(native.pixelRatio === 2, 'native keeps dpr (capped at 2)');

const stretched = practiceBackbuffer({ resolution: '1280x960' }, 1920, 1080, 2);
assert(stretched.width === 1280 && stretched.height === 960, '4:3 uses the preset');
assert(stretched.pixelRatio === 1, 'fixed res is 1:1 pixels');

const custom = practiceBackbuffer(
  { resolution: 'custom', resolutionWidth: 1440, resolutionHeight: 1080 },
  2560,
  1440,
  2
);
assert(custom.width === 1440 && custom.height === 1080, 'custom uses stored size');
assert(custom.pixelRatio === 1, 'custom is 1:1 pixels');

const dprCap = practiceBackbuffer({ resolution: 'native' }, 800, 600, 3);
assert(dprCap.pixelRatio === 2, 'dpr caps at 2');

console.log('practiceDisplay.test.js ok');
