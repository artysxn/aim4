// Every message the coach can say must have something that can say it.
//
// This test exists because seven rules did not. Their copy sat in
// coachMessages.js with four wording variants each, fully reviewed, and nothing
// anywhere in the codebase ever called coachText for them. The coach could
// describe those mistakes and could never find one, and nothing failed: no
// error, no warning, just notes that never appeared.
//
// A catalogue and its callers drifting apart is invisible by construction, so
// it needs a test rather than discipline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COACH_CATEGORY, COACH_MESSAGES, coachText } from './coachMessages.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../../..');

/** Every .js file under src/ and server/, minus tests and the catalogue itself. */
function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sources(full, out);
    } else if (
      entry.name.endsWith('.js') &&
      !entry.name.endsWith('.test.js') &&
      entry.name !== 'coachMessages.js'
    ) {
      out.push(full);
    }
  }
  return out;
}

const called = new Set();
for (const file of [...sources(path.join(root, 'src')), ...sources(path.join(root, 'server'))]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/coachText\(\s*'([^']+)'/g)) called.add(m[1]);
}

// --- every message key is reachable -----------------------------------------
{
  const keys = Object.keys(COACH_MESSAGES);
  const orphans = keys.filter((k) => !called.has(k));
  assert(
    orphans.length === 0,
    `these coach messages have no detector calling them: ${orphans.join(', ')}. ` +
      'Either implement the rule or remove the copy.'
  );
  assert(keys.length > 30, 'the catalogue should not have shrunk unexpectedly');
}

// --- nothing renders a message that does not exist --------------------------
{
  const missing = [...called].filter((k) => !COACH_MESSAGES[k]);
  assert(
    missing.length === 0,
    `these keys are rendered but not defined: ${missing.join(', ')}`
  );
}

// --- every message is well formed -------------------------------------------
{
  const categories = new Set(Object.values(COACH_CATEGORY));
  for (const [key, def] of Object.entries(COACH_MESSAGES)) {
    assert(def.rule, `${key}: missing rule id`);
    assert(categories.has(def.category), `${key}: unknown category ${def.category}`);
    assert(def.variants?.length === 4, `${key}: expected 4 variants`);
    for (const v of def.variants) {
      assert(typeof v === 'string' && v.length > 0, `${key}: empty variant`);
      // House rule: always name the player, never address them directly.
      assert(v.includes('{player}'), `${key}: every variant must name {player}`);
      assert(!/\byou\b|\byour\b/i.test(v), `${key}: variants must not say "you"`);
      assert(!v.includes('—'), `${key}: no long dash in coach copy`);
    }
  }
}

// --- rendering fills every placeholder --------------------------------------
{
  // A variant that ends up on screen still holding {seconds} is a bug that only
  // shows in the UI, so the catalogue is rendered here with a full bag of vars.
  // Built from the catalogue rather than hand-listed, so adding a placeholder
  // to a variant cannot fail this test for the wrong reason.
  const vars = {};
  for (const def of Object.values(COACH_MESSAGES)) {
    for (const v of def.variants) {
      for (const m of v.matchAll(/\{(\w+)\}/g)) vars[m[1]] = `<${m[1]}>`;
    }
  }
  for (const key of Object.keys(COACH_MESSAGES)) {
    for (let tick = 0; tick < 4; tick++) {
      const text = coachText(key, tick, vars);
      assert(text, `${key}: rendered empty at tick ${tick}`);
      assert(!/\{[a-z]+\}/.test(text), `${key}: unfilled placeholder in "${text}"`);
    }
  }
}

console.log(`coachCoverage.test.js: ok (${Object.keys(COACH_MESSAGES).length} messages, all reachable)`);
