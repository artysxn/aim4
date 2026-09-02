// Run: node src/i18n/catalogue.test.js
//
// The catalogues are generated and merged by scripts, and their failure modes
// are all silent. A key that no longer matches anything in the source simply
// never fires. A pattern whose translation asks for a slot the English never
// captured prints "{n}" in the middle of a sentence. A half-filled enum leaves
// an English noun inside a Russian line, which is the exact bug enums.js was
// written to prevent.
//
// None of that shows up in a browser until somebody reads the page in that
// language, so it is checked here instead.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePattern, parseTemplate, slotKey } from './slots.js';
import { ENUM_SETS } from './enums.js';
import { LANGS } from './langs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(fs.readFileSync(path.join(HERE, 'catalogue.en.json'), 'utf8'));

const TARGETS = LANGS.filter((l) => l.id !== 'en');

// ---------------------------------------------------------------------------
// The English source
// ---------------------------------------------------------------------------

assert.ok(Object.keys(catalogue.exact).length > 500, 'the source catalogue is not empty');
assert.ok(Object.keys(catalogue.patterns).length > 100, 'patterns were extracted, not just labels');

const keep = new Set(catalogue.keep);
assert.ok(keep.size > 100, 'the do-not-translate list was built from the data modules');

for (const term of ['A Site', 'Banana', 'A Heaven', 'Mid', 'AWP', 'AK-47']) {
  assert.ok(keep.has(term), `"${term}" is a callout or a weapon and must stay English`);
}

for (const text of Object.keys(catalogue.exact)) {
  assert.ok(
    !keep.has(text),
    `"${text}" is on the keep list and must not also be offered for translation`
  );
}

for (const template of Object.keys(catalogue.patterns)) {
  const compiled = compilePattern(template, (set) => ENUM_SETS[set]?.members || []);
  assert.ok(compiled, `pattern compiles: ${template}`);
  assert.ok(
    compiled.slots.length > 0,
    `a pattern has at least one slot, or it belongs in exact: ${template}`
  );
  // A pattern that is nearly all slot would match sentences it was never meant
  // for, and a wrong match reads as a confident mistranslation. The bar depends
  // on shape rather than length, and mirrors specificEnough() in
  // scripts/i18n-extract.mjs: a pattern that opens with a real word can only
  // match a line opening with that word, so "Drop {name}" is safe on four
  // letters, while "{name} {n}" needs eight. Strategy notes are almost all of
  // the first kind, and a flat threshold silently dropped every one of them.
  const literal = template.replace(/\{[^}]+\}/g, ' ');
  const letters = (literal.match(/\p{L}/gu) || []).length;
  const frontAnchored = /^\p{L}{2,}/u.test(template.trim());
  assert.ok(
    letters >= (frontAnchored ? 4 : 8),
    `a pattern carries enough fixed text to be safe: ${template}`
  );
}

for (const set of Object.keys(ENUM_SETS)) {
  assert.ok(ENUM_SETS[set].members.length > 0, `enum set ${set} has members`);
  assert.ok(ENUM_SETS[set].from, `enum set ${set} says which module produces it`);
}

// ---------------------------------------------------------------------------
// Each translation
// ---------------------------------------------------------------------------

/** Which enum sets a pattern needs, so a locale can be checked against use. */
function enumsUsed(template) {
  return new Set(
    parseTemplate(template)
      .slots.filter((s) => s.type === 'enum')
      .map((s) => s.set)
  );
}

let anyTranslated = false;

for (const lang of TARGETS) {
  const file = path.join(HERE, 'locales', `${lang.id}.json`);
  assert.ok(fs.existsSync(file), `${lang.id} has a catalogue file (run: node scripts/i18n-locale.mjs --init)`);
  const loc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(loc.lang, lang.id, `${lang.id}.json declares its own language`);

  // 1. Nothing addresses a string the source no longer has. A stale key is
  //    dead weight that can never fire, and hides how much is really done.
  for (const key of Object.keys(loc.exact || {})) {
    assert.ok(key in catalogue.exact, `${lang.id}: "${key}" is not in the source catalogue`);
  }
  for (const key of Object.keys(loc.patterns || {})) {
    assert.ok(key in catalogue.patterns, `${lang.id}: pattern "${key}" is not in the source catalogue`);
  }

  // 2. A translation may reorder slots but may not invent them.
  for (const [source, value] of Object.entries(loc.patterns || {})) {
    const available = new Set(parseTemplate(source).slots.map(slotKey));
    const forms = typeof value === 'string' ? [value] : Object.values(value);
    assert.ok(forms.length, `${lang.id}: pattern "${source}" has at least one form`);
    for (const form of forms) {
      assert.equal(typeof form, 'string', `${lang.id}: every plural form of "${source}" is a string`);
      for (const slot of parseTemplate(form).slots) {
        assert.ok(
          available.has(slotKey(slot)),
          `${lang.id}: "${source}" has no ${slotKey(slot)} to fill in "${form}"`
        );
      }
    }
    if (typeof value === 'object') {
      assert.ok(
        value.other || value.one,
        `${lang.id}: plural forms for "${source}" need at least "other" as a fallback`
      );
    }
    anyTranslated = true;
  }

  // 3. Enum sets are all-or-nothing. A set with some members translated leaves
  //    an English noun sitting inside a translated sentence, which is worse
  //    than the whole sentence staying English.
  const needed = new Set();
  for (const source of Object.keys(loc.patterns || {})) {
    for (const set of enumsUsed(source)) needed.add(set);
  }
  for (const [set, table] of Object.entries(loc.enums || {})) {
    assert.ok(ENUM_SETS[set], `${lang.id}: no enum set called "${set}"`);
    needed.add(set);
    for (const member of Object.keys(table)) {
      assert.ok(
        ENUM_SETS[set].members.includes(member),
        `${lang.id}: "${member}" is not a member of ${set}`
      );
    }
  }
  for (const set of needed) {
    for (const member of ENUM_SETS[set].members) {
      assert.equal(
        typeof loc.enums?.[set]?.[member],
        'string',
        `${lang.id}: enum ${set} is in use, so every member needs a form; "${member}" has none`
      );
    }
  }

  // 4. A translation that is still English is not a translation. Latin-script
  //    languages legitimately share words with English, so this only checks the
  //    two that cannot: nothing in Russian or Japanese should come back
  //    identical unless it is a bare number or a brand.
  if (lang.id === 'ru' || lang.id === 'ja') {
    let identical = 0;
    for (const [en, ru] of Object.entries(loc.exact || {})) {
      if (en === ru && /\p{L}{3}/u.test(en)) identical++;
    }
    const total = Object.keys(loc.exact || {}).length;
    assert.ok(
      total === 0 || identical / total < 0.25,
      `${lang.id}: ${identical} of ${total} entries are byte-identical to the English`
    );
  }
}

void anyTranslated;

console.log('i18n/catalogue.test.js ok');
