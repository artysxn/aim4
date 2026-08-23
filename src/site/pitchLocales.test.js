// Run: node src/site/pitchLocales.test.js
//
// A translation is an override map, so the failure mode is silent: a typo in a
// key, or a path that no longer exists after the English deck changed, applies
// nothing at all and the slide simply shows English. These assertions turn both
// into a failed build.

import assert from 'node:assert/strict';
import { PITCH_SLIDES, applyPitchText, textLeaves } from './pitchContent.js';
import { TALK_SLIDES } from './pitchTalk.js';
import { LANGS, LOCALES, localeText, normalizeLang, overrideKey, scopeOverrides } from './pitchLocales.js';

const DECKS = { full: PITCH_SLIDES, talk: TALK_SLIDES };

/** Lines that must never be left in English: the ones a room reads or hears. */
const REQUIRED = (path) => /^(title|kicker|lead|note|tableNote|quote|quoteBy)$/.test(path) || path.startsWith('script.');

/** …unless the English is a brand, which stays a brand in every language. */
const BRAND = /^(aim4|aim4\.io|AIM4)$/;

const languages = Object.keys(LOCALES).filter((id) => LOCALES[id]);
assert.ok(languages.length >= 2, 'at least two translations exist');
assert.deepEqual(
  LANGS.map((l) => l.id).sort(),
  Object.keys(LOCALES).sort(),
  'every declared language has an entry (English maps to null)'
);

for (const lang of languages) {
  for (const [deckName, slides] of Object.entries(DECKS)) {
    const map = localeText(lang, deckName);
    assert.ok(map, `${lang}/${deckName} has a translation`);

    const byId = new Map(slides.map((s) => [s.id, s]));

    // 1. No key addresses something that is not there.
    for (const [slideId, patch] of Object.entries(map)) {
      const slide = byId.get(slideId);
      assert.ok(slide, `${lang}/${deckName}: no slide "${slideId}" in the deck`);
      const paths = new Set(textLeaves(slide).map((l) => l.path));
      for (const [path, value] of Object.entries(patch)) {
        assert.ok(paths.has(path), `${lang}/${deckName}/${slideId}: no such text at "${path}"`);
        assert.equal(typeof value, 'string');
        assert.ok(value.trim().length, `${lang}/${deckName}/${slideId}.${path} is empty`);
      }
    }

    // 2. Nothing a person reads aloud is left in English.
    const missing = [];
    for (const slide of slides) {
      for (const leaf of textLeaves(slide)) {
        if (!REQUIRED(leaf.path) || BRAND.test(leaf.value.trim())) continue;
        if (!map[slide.id]?.[leaf.path]) missing.push(`${slide.id}.${leaf.path}`);
      }
    }
    assert.deepEqual(missing, [], `${lang}/${deckName}: untranslated lines`);

    // 3. The translation applies cleanly and changes the deck.
    const applied = applyPitchText(slides, map);
    assert.equal(applied.length, slides.length);
    const changed = applied.filter((s, i) => s !== slides[i]).length;
    assert.equal(changed, Object.keys(map).length, `${lang}/${deckName}: every patch lands`);
  }
}

// ---- language plumbing ------------------------------------------------------

assert.equal(normalizeLang('RU'), 'ru');
assert.equal(normalizeLang('uk'), 'ua', 'the uk code maps to the ua deck');
assert.equal(normalizeLang('fr'), 'en', 'an unknown language falls back to English');
assert.equal(normalizeLang(null), 'en');
assert.equal(localeText('en', 'full'), null, 'English has no override map');

// Admin edits are stored per language and must not bleed across.
assert.equal(overrideKey('en', 'founder'), 'founder');
assert.equal(overrideKey('ru', 'founder'), 'ru-founder');
const saved = { founder: { title: 'EN' }, 'ru-founder': { title: 'RU' }, 'ua-founder': { title: 'UA' } };
assert.deepEqual(scopeOverrides(saved, 'ru'), { founder: { title: 'RU' } });
assert.deepEqual(scopeOverrides(saved, 'ua'), { founder: { title: 'UA' } });
assert.deepEqual(scopeOverrides(saved, 'en'), saved, 'English reads the unprefixed keys');
// The English pass must ignore the prefixed ones rather than applying them.
assert.equal(applyPitchText(PITCH_SLIDES, saved).find((s) => s.id === 'founder').title, 'EN');

const counts = languages
  .map((l) => `${l}: ${Object.values(LOCALES[l]).reduce((n, d) => n + Object.values(d).reduce((m, p) => m + Object.keys(p).length, 0), 0)}`)
  .join(', ');
console.log(`pitchLocales: all assertions passed (${counts})`);
