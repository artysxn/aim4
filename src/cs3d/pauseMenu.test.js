// Run: node src/cs3d/pauseMenu.test.js

import { PAUSE_MENUS_HREF, resolutionSelectHtml } from './pauseMenu.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(PAUSE_MENUS_HREF === '/map-practice', 'leave goes to map practice');

const html = resolutionSelectHtml();
assert(html.includes('value="native"'), 'native option');
assert(html.includes('value="1280x960"'), '4:3 option');
assert(html.includes('value="custom"'), 'custom option');
assert(!html.includes('—'), 'no em dash in labels');

console.log('pauseMenu.test.js ok');
