// Run: node src/i18n/coachPatterns.test.js
//
// The coach is the hardest thing on the site to translate and the easiest to
// get silently wrong.
//
// Its notes are written to the server as finished English text and, by design,
// never regenerated (replays/coach/analyzeDemo.js). So a note that exists today
// will still be an English sentence tomorrow, and the only way it can appear in
// another language is for the translation layer to recognise the sentence it is
// looking at and rebuild it. That recognition is what this file tests.
//
// The failure it exists to catch: the extractor writes a pattern from the
// catalogue's raw template, the coach renders a sentence from the same
// template through a different code path, and the two do not quite line up, so
// every coach note in the app stays English and nothing anywhere says why.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COACH_MESSAGES, coachText } from '../replays/coach/coachMessages.js';
import { compilePattern, matchPattern, slotKey } from './slots.js';
import { ENUM_SETS } from './enums.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(fs.readFileSync(path.join(HERE, 'catalogue.en.json'), 'utf8'));

const members = (set) => ENUM_SETS[set]?.members || [];

/** Every catalogue pattern, compiled once, longest fixed text first. */
const compiled = Object.keys(catalogue.patterns)
  .map((source) => ({ source, re: compilePattern(source, members) }))
  .filter((p) => p.re)
  .sort((a, b) => b.source.replace(/\{[^}]+\}/g, '').length - a.source.replace(/\{[^}]+\}/g, '').length);

function findMatch(text) {
  for (const p of compiled) {
    const values = matchPattern(p.re, text);
    if (values) return { source: p.source, values };
  }
  return null;
}

/**
 * A full bag of substitutions, using values shaped the way the real rules
 * produce them: percentages carry their sign, `distance` carries the noun the
 * source bakes into it, `item` is one of the four article-bearing phrases
 * shotMistakes picks between.
 */
const VARS = {
  player: 's1mple',
  enemy: 'donk',
  teammate: 'b1t',
  zone: 'A Ramp',
  n: 3,
  m: 2,
  hp: 74,
  seconds: 12,
  shots: 9,
  deg: 41,
  speed: 210,
  missed: 6,
  hits: 3,
  delta: 18,
  win: '73%',
  duel: '54%',
  was: '61%',
  is: '22%',
  share: '40%',
  item: 'a knife',
  site: 'A',
  distance: '340 units'
};

// A tick that is not round, so the variant hash is not accidentally always 0.
const TICKS = [1, 7919, 40507, 99991];

const misses = [];
let checked = 0;

for (const [key, def] of Object.entries(COACH_MESSAGES)) {
  for (const tick of TICKS) {
    const text = coachText(key, tick, VARS);
    assert.ok(text, `${key} renders at tick ${tick}`);
    assert.ok(
      !/\{[a-z]+\}/i.test(text),
      `${key} at ${tick} left a placeholder unfilled, so the var bag above is short: ${text}`
    );
    checked++;
    const hit = findMatch(text);
    if (!hit) {
      misses.push({ key, text });
      continue;
    }
    // Whatever a slot pulls back out has to be one of the values that went in.
    // This is the assertion that catches a pattern slicing a sentence in the
    // wrong place: a `{name}` that swallowed half a clause still matches, and
    // still looks fine, until the translation puts that half-clause somewhere
    // English word order was hiding.
    const given = new Set(Object.values(VARS).map(String));
    for (const [slot, captured] of hit.values) {
      assert.ok(
        given.has(captured),
        `${key}: ${slot} captured "${captured}", which is not one of the substituted values.\n  pattern: ${hit.source}\n  text:    ${text}`
      );
    }
  }
  void def;
}

assert.equal(
  misses.length,
  0,
  `every coach sentence is recognised by a catalogue pattern.\nUnmatched (${misses.length} of ${checked}):\n` +
    misses
      .slice(0, 8)
      .map((m) => `  ${m.key}: ${m.text}`)
      .join('\n')
);

// ---------------------------------------------------------------------------
// The clause the rules append themselves, three times over, outside the
// catalogue (coach.js:564, :734, :775). It has to be its own pattern, or every
// note that measures a win-chance drop stays half English.
// ---------------------------------------------------------------------------

const DROP = ' Round win chance fell from 73% to 41%.';
assert.ok(
  findMatch(DROP.trim()),
  'the appended win-chance clause has a pattern of its own'
);

// And the pair, which is what actually reaches the DOM: one sentence from the
// catalogue with a second glued to the end of it.
const pair = coachText('advantage-lost', 7919, VARS) + DROP;
assert.equal(findMatch(pair), null, 'the pair has no pattern of its own, as expected');

// ---------------------------------------------------------------------------
// The two values the source bakes an English noun into.
// ---------------------------------------------------------------------------

/**
 * Render one message key until the variant that uses a given placeholder comes
 * up. Which of the four variants fires is a hash of the tick, so a fixed tick
 * would test whichever one happened to be picked.
 */
function renderVariantWith(key, needle) {
  for (let tick = 1; tick < 5000; tick++) {
    const text = coachText(key, tick, VARS);
    if (text.includes(needle)) return text;
  }
  return null;
}

{
  // `${Math.round(stillFar)} units` (tacticalMistakes.js:498) arrives as one
  // value with the noun already inside it. The extractor lifts "units" back out
  // into the pattern so a translator can reach it; without that the English
  // word would be stranded inside a captured value and survive into Russian.
  const text = renderVariantWith('late-rotation', VARS.distance);
  assert.ok(text, 'a late-rotation variant uses the distance');
  const hit = findMatch(text);
  assert.ok(hit, `late-rotation is recognised: ${text}`);
  assert.ok(
    hit.source.includes('units'),
    `"units" is fixed text in the pattern, not part of a slot: ${hit.source}`
  );
  assert.equal(hit.values.get('n#2'), '340', 'and the number alone is what is captured');
}

{
  // noGunLabel() picks one of four article-bearing phrases. Those have to be an
  // enum, not a passthrough, or "a knife" ends up inside a Russian sentence.
  const text = renderVariantWith('knife-out', VARS.item);
  assert.ok(text, 'a knife-out variant uses the item');
  const hit = findMatch(text);
  assert.ok(hit, `knife-out is recognised: ${text}`);
  const slots = [...hit.values.keys()];
  assert.ok(
    slots.some((k) => k.startsWith('enum:item')),
    `the item is an enum slot, not free text: ${hit.source} -> ${slots.join(', ')}`
  );
  assert.equal(hit.values.get('enum:item#1'), 'a knife');
}

void slotKey;

console.log(`i18n/coachPatterns.test.js ok (${checked} coach sentences, all recognised)`);
