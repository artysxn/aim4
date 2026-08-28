import assert from 'node:assert/strict';
import { demoIdFromFile, soleDemoId } from './roundId.js';

const DEMO = '00cc294d9679ee90';
const round = (file) => ({ file });
const one = `GKO-HCQ-200-CCH-01_Hbe-X85-SZP-Q8G-kCh_2Km-Ja3-WNv-sv3-oxO~${DEMO}`;
const two = `GKO-HCQ-244-CCH-02_Hbe-X85-SZP-Q8G-kCh_2Km-Ja3-WNv-sv3-oxO~${DEMO}`;

{
  assert.equal(demoIdFromFile(one), DEMO);
  assert.equal(demoIdFromFile('legacy-name-with-no-suffix'), '', 'legacy names have no demo id');
  assert.equal(demoIdFromFile('trailing~'), '');
  assert.equal(demoIdFromFile(null), '');
}

{
  assert.equal(soleDemoId([round(one), round(two)]), DEMO, 'a whole match resolves');
  assert.equal(soleDemoId([round(one)]), DEMO, 'one shared round resolves too');
}

{
  // A playlist spanning demos has no single answer and must not invent one:
  // attaching one demo's voice comms to another demo's rounds would caption
  // players with words from a different match.
  assert.equal(soleDemoId([round('a~demo111'), round('b~demo222')]), '');
  assert.equal(soleDemoId([round('a~demo111'), round('legacy-no-suffix')]), '');
  assert.equal(soleDemoId([]), '');
  assert.equal(soleDemoId(null), '');
}

console.log('roundId demo-id tests passed');
