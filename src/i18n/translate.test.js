// Run: node src/i18n/translate.test.js
//
// The pattern engine is the part of the translation layer that can be wrong
// quietly. An exact lookup either hits or misses; a pattern can match a
// sentence it was never meant for, capture the wrong halves, or drop a value on
// the floor, and every one of those ships as a plausible-looking sentence.
//
// So this pins the behaviour that the rest of the layer relies on: what a slot
// is allowed to swallow, that a nickname comes out the far side untouched, that
// a language with three plural forms gets three, and that a translation may put
// the pieces in a different order from English.

import assert from 'node:assert/strict';
import {
  compilePattern,
  literalWords,
  matchPattern,
  parseTemplate,
  pluralValue,
  renderTemplate,
  slotKey
} from './slots.js';
import { setCatalogue, translate, translateEnum } from './translate.js';
import { normalizeLang, preferredLang } from './langs.js';
import { ENUM_SETS } from './enums.js';

// ---------------------------------------------------------------------------
// Slot parsing
// ---------------------------------------------------------------------------

{
  const { slots } = parseTemplate('{name} died in a {n}v{n} with {name#2} watching.');
  assert.deepEqual(
    slots.map(slotKey),
    ['name#1', 'n#1', 'n#2', 'name#2'],
    'bare slots are numbered in reading order, per type'
  );
}

assert.deepEqual(
  literalWords('{name} won {n} of {n#2} rounds'),
  ['won', 'of', 'rounds'],
  'literal words are what a matching string is guaranteed to contain'
);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

{
  const p = compilePattern('{name} died in a {n}v{n} with nobody able to trade.');
  const v = matchPattern(p, 's1mple died in a 3v2 with nobody able to trade.');
  assert.ok(v, 'the sentence its own template produced matches it');
  assert.equal(v.get('name#1'), 's1mple');
  assert.equal(v.get('n#1'), '3');
  assert.equal(v.get('n#2'), '2');
}

{
  const p = compilePattern('{name} died in a {n}v{n} with nobody able to trade.');
  assert.equal(
    matchPattern(p, 's1mple got a kill in a 3v2.'),
    null,
    'a different sentence does not match: a wrong match is worse than none'
  );
}

{
  // Whitespace is the DOM's business, not the catalogue's. A sentence that
  // arrives folded across lines with template-literal indentation is the same
  // sentence.
  const p = compilePattern('Round win chance fell from {pct} to {pct#2}.');
  const v = matchPattern(p, 'Round win chance fell from 73% to 41%.');
  assert.equal(v.get('pct#1'), '73%');
  assert.equal(v.get('pct#2'), '41%');
}

{
  const p = compilePattern('Line up {name}, throw at {clock}');
  const v = matchPattern(p, 'Line up A Ramp smoke, throw at 1:37');
  assert.equal(v.get('name#1'), 'A Ramp smoke', 'a callout is captured whole');
  assert.equal(v.get('clock#1'), '1:37');
}

// ---------------------------------------------------------------------------
// Rendering, including reordering
// ---------------------------------------------------------------------------

{
  const p = compilePattern('{name} died in a {n}v{n} with nobody able to trade.');
  const v = matchPattern(p, 's1mple died in a 3v2 with nobody able to trade.');
  assert.equal(
    renderTemplate('В {n}v{n#2} {name} умер, и разменять его было некому.', v),
    'В 3v2 s1mple умер, и разменять его было некому.',
    'the translation may put the slots wherever its own grammar wants them'
  );
}

{
  // The nickname is what passes through untouched, and that is the whole reason
  // callouts stay English: neither declines.
  const p = compilePattern('Go {name}, hold {name#2}');
  const v = matchPattern(p, 'Go Catwalk, hold A Ramp');
  assert.equal(renderTemplate('Иди {name}, держи {name#2}', v), 'Иди Catwalk, держи A Ramp');
}

{
  const p = compilePattern('{name} won {n} of {n#2}');
  const v = matchPattern(p, 'ropz won 4 of 9');
  assert.equal(
    renderTemplate('{name} は {n#2} 回中 {n} 回勝ちました', v),
    'ropz は 9 回中 4 回勝ちました',
    'Japanese reverses the two numbers, which is exactly what #2 is for'
  );
}

{
  const p = compilePattern('{name} has {n} left');
  const v = matchPattern(p, 'donk has 3 left');
  assert.equal(
    renderTemplate('{name} has {n} and {n#2} left', v),
    'donk has 3 and {n} left',
    'a slot the English never captured stays visible rather than printing undefined'
  );
}

// ---------------------------------------------------------------------------
// Enum slots: the words the code chooses, which do inflect
// ---------------------------------------------------------------------------

{
  const members = (set) => ENUM_SETS[set].members;
  const p = compilePattern('{name} had {enum:item} out.', members);
  const v = matchPattern(p, 'b1t had a knife out.');
  assert.equal(v.get('enum:item#1'), 'a knife');
  assert.equal(
    renderTemplate('У {name} в руках был {enum:item}.', v, (set, en) =>
      set === 'item' && en === 'a knife' ? 'нож' : en
    ),
    'У b1t в руках был нож.',
    'an enum member is translated, not passed through: it is an ordinary noun'
  );
}

{
  const members = () => [];
  assert.equal(
    compilePattern('{name} had {enum:nothing} out.', members),
    null,
    'an enum with no members compiles to nothing rather than matching everything'
  );
}

// ---------------------------------------------------------------------------
// Plurals
// ---------------------------------------------------------------------------

{
  const p = compilePattern('{n} rounds');
  assert.equal(pluralValue(p, matchPattern(p, '5 rounds')), 5);
  assert.equal(pluralValue(p, matchPattern(p, '21 rounds')), 21);
}

setCatalogue({
  lang: 'ru',
  exact: { Cancel: 'Отмена', 'Sign in': 'Войти' },
  patterns: {
    '{n} rounds': { one: '{n} раунд', few: '{n} раунда', many: '{n} раундов', other: '{n} раунда' },
    '{name} died in a {n}v{n#2} with nobody able to trade.':
      'В {n}v{n#2} {name} умер, и разменять его было некому.',
    'Round win chance fell from {pct} to {pct#2}.':
      'Шанс выиграть раунд упал с {pct} до {pct#2}.'
  },
  enums: { item: { 'a knife': 'нож' } }
});

assert.equal(translate('Cancel'), 'Отмена');
assert.equal(translate('  Cancel  '), 'Отмена', 'the catalogue is not asked to care about padding');
assert.equal(translate('Nothing here'), null, 'an unknown string comes back null, never empty');

assert.equal(translate('1 rounds'), '1 раунд', 'Russian "one" covers 1');
assert.equal(translate('3 rounds'), '3 раунда', 'Russian "few" covers 2-4');
assert.equal(translate('7 rounds'), '7 раундов', 'Russian "many" covers 5-20');
assert.equal(translate('21 rounds'), '21 раунд', 'and 21 is "one" again, which no ternary can express');

assert.equal(translateEnum('item', 'a knife'), 'нож');
assert.equal(translateEnum('item', 'the bomb'), null, 'an untranslated member reports itself missing');

// The coach appends one sentence to another, and the pair has no pattern of its
// own. Splitting on the sentence boundary is what covers that.
assert.equal(
  translate(
    's1mple died in a 3v2 with nobody able to trade. Round win chance fell from 73% to 41%.'
  ),
  'В 3v2 s1mple умер, и разменять его было некому. Шанс выиграть раунд упал с 73% до 41%.',
  'two sentences in one node are translated one at a time'
);

assert.equal(
  translate('Something unknown. Round win chance fell from 73% to 41%.'),
  'Something unknown. Шанс выиграть раунд упал с 73% до 41%.',
  'a half nothing covers stays in English rather than losing the half that is covered'
);

// The shape the coach actually emits: a two-sentence variant from the catalogue
// with a third sentence appended by the rule that measured the drop. Matching a
// sentence at a time finds only the appended clause, because neither half of the
// two-sentence entry is an entry on its own. The longest run has to win.
setCatalogue({
  lang: 'ru',
  exact: {},
  patterns: {
    '{name} died in a {n}v{n#2} with nobody able to trade. Being up a man only wins the round if the side stays up a man, and this made it even again.':
      'В {n}v{n#2} {name} умер без размена. Плюс игрок держится только пока сторона в плюсе, а теперь снова равно.',
    'Round win chance fell from {pct} to {pct#2}.':
      'Шанс выиграть раунд упал с {pct} до {pct#2}.'
  },
  enums: {}
});

assert.equal(
  translate(
    's1mple died in a 3v2 with nobody able to trade. Being up a man only wins the round if the side stays up a man, and this made it even again. Round win chance fell from 73% to 41%.'
  ),
  'В 3v2 s1mple умер без размена. Плюс игрок держится только пока сторона в плюсе, а теперь снова равно. Шанс выиграть раунд упал с 73% до 41%.',
  'a two-sentence entry plus an appended clause comes out whole'
);

setCatalogue(null);
assert.equal(translate('Cancel'), null, 'with no catalogue everything stays English');

// ---------------------------------------------------------------------------
// Language ids
// ---------------------------------------------------------------------------

assert.equal(normalizeLang('RU'), 'ru');
assert.equal(normalizeLang('pt-BR'), 'pt', 'a region subtag falls back to the language we serve');
assert.equal(normalizeLang('nb'), 'no', 'both written Norwegians land on one catalogue');
assert.equal(normalizeLang('zh-Hans'), 'zh');
assert.equal(
  normalizeLang('zh-Hant'),
  'en',
  'Traditional Chinese is a different written language; English is the honest answer'
);
assert.equal(normalizeLang(null), 'en');
assert.equal(normalizeLang('klingon'), 'en');

assert.equal(preferredLang({ languages: ['pt-BR', 'pt', 'en'] }), 'pt');
assert.equal(preferredLang({ languages: ['de', 'en-GB'] }), 'en', 'a language we do not serve is not guessed at');

console.log('i18n/translate.test.js ok');
