// ---------------------------------------------------------------------------
// scripts/i18n-lint.mjs
// The soft checks on a translation: things that are wrong but not broken.
//
//   node scripts/i18n-lint.mjs          every language
//   node scripts/i18n-lint.mjs ru       one
//
// catalogue.test.js already fails the build on the hard errors: a key that
// addresses nothing, a slot invented or dropped, a half-filled enum. This is
// the other half, the mistakes that still render but read badly:
//
//   - an em dash, which CLAUDE.md bans in every string on the site
//   - a button label that got three times longer and will break the layout
//   - a map callout that was translated after all
//   - a string left in English in a language that shares no words with it
//   - a count with no plural forms in a language that needs three
//
// None of these stop a release, so this reports rather than exits non-zero.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/catalogue.en.json'), 'utf8'));
const { LANGS } = await import(pathToFileURL(path.join(ROOT, 'src/i18n/langs.js')).href);

/** Languages whose plural rules need more than the English two. */
const MANY_FORMS = new Set(['ru', 'pl']);
/** Languages that share no alphabet with English, so leftovers are obvious. */
const NON_LATIN = new Set(['ru', 'zh', 'ja']);
/** A short label lives in a fixed-width control; growth there breaks layout. */
const SHORT = 24;

const only = process.argv[2];
const targets = LANGS.filter((l) => l.id !== 'en' && (!only || l.id === only));

/**
 * Callouts that must survive a translation, reduced to the word that carries
 * the callout.
 *
 * The naive check (does the translation still contain "A site"?) is wrong more
 * often than it is right: Russian writes "на сайте A", which keeps the callout
 * perfectly while splitting the two words. So each term is checked on its most
 * distinctive token instead, and terms whose only distinctive token is a common
 * English word are dropped from the check entirely, because "Longer terms are
 * discounted" is not a lost callout.
 */
const GENERIC = new Set([
  'site', 'main', 'long', 'short', 'mid', 'door', 'doors', 'box', 'boxes', 'car', 'blue', 'con',
  'default', 'core', 'cave', 'exit', 'lobby', 'ramp', 'yard', 'water', 'window', 'stairs', 'pit',
  'connector', 'back', 'top', 'lower', 'upper', 'left', 'right', 'boost', 'ladder', 'bridge'
]);
const keep = cat.keep
  .map((term) => {
    // Only a capitalised word of five letters or more, and not one of the
    // generic map nouns above, is distinctive enough to be worth checking. A
    // call name like "Door smoke fake" has no such word, so it is not checked
    // at all rather than checked badly: every one of its words is ordinary
    // English that a translation is expected to replace.
    const token = term
      .split(/[\s/]+/)
      .find((t) => /^[A-Z]\p{L}{4,}$/u.test(t) && !GENERIC.has(t.toLowerCase()));
    return token ? { term, token } : null;
  })
  .filter(Boolean);

/** Strings that are data rather than copy, and are meant to come back unchanged. */
function isMachineText(s) {
  if (/^\d+(?:\s+\d+px)?\s+[\w"'-]/.test(s)) return true; // canvas font shorthand
  if (/^[0-9a-f]{6,}$/i.test(s)) return true; // a hash or an id
  if (/^[A-Z][a-z]+(?:-[A-Za-z]+)+(?:,\s*[A-Z][\w-]+)*$/.test(s)) return true; // header lists
  if (/^(?:Alt|Control|Shift|Meta|Arrow|Bracket|Digit|Key|Numpad|Page|Caps|Os|Intl)[A-Z0-9]/.test(s)) return true;
  if (!/\s/.test(s) && /^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(s)) return true; // PascalCase
  if (/[+/*]\s*\w+\s*[+/*]/.test(s)) return true; // a formula
  return false;
}

let grand = 0;

for (const lang of targets) {
  const file = path.join(ROOT, 'src/i18n/locales', `${lang.id}.json`);
  if (!fs.existsSync(file)) continue;
  const loc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  const say = (kind, key, detail) => problems.push({ kind, key, detail });

  const entries = [
    ...Object.entries(loc.exact || {}).map(([k, v]) => [k, v, 'exact']),
    ...Object.entries(loc.patterns || {}).map(([k, v]) => [k, v, 'pattern'])
  ];

  for (const [en, value, kind] of entries) {
    const forms = typeof value === 'string' ? [value] : Object.values(value || {});

    for (const form of forms) {
      if (typeof form !== 'string') continue;

      if (form.includes('—')) say('em dash', en, form);

      // A control sized for "Rounds" cannot hold a sentence.
      if (en.length <= SHORT && form.length > en.length * 2.6 && form.length > SHORT) {
        say('much longer', en, `${en.length} -> ${form.length} chars: ${form}`);
      }

      // A callout that made it into the English of a string has to make it
      // through to the other side too.
      for (const { term, token } of keep) {
        // The whole callout has to be in the English before its absence from
        // the translation means anything. "Afterplant" on its own is an
        // ordinary word to translate; "A Afterplant" is the name of a call.
        if (!en.includes(term)) continue;
        // Only the leading edge is a boundary, and only against Latin letters.
        // Two languages broke the obvious version of this check:
        //
        //   Japanese sets a callout straight against a CJK character with no
        //   space, so "Undergroundで" is the callout intact.
        //   Finnish declines it in place, so "Tetris" becomes "Tetrisiin" and
        //   "Checkers" becomes "Checkersista". That is correct Finnish, not a
        //   lost callout.
        //
        // So a trailing suffix is allowed and a leading one is not, which still
        // catches the case this exists for: a callout translated away or
        // dropped entirely.
        const inForm = new RegExp(`(?<![A-Za-z])${token}`, 'u').test(form);
        if (!inForm) {
          say('callout lost', en, `"${term}" is missing from: ${form}`);
          break;
        }
      }

      if (
        NON_LATIN.has(lang.id) &&
        form === en &&
        /\p{L}{4}/u.test(en) &&
        !cat.keep.includes(en) &&
        !isMachineText(en)
      ) {
        say('still English', en, form);
      }
    }

    // Russian and Polish have three plural categories, so "{n} rounds" needs
    // three forms. Only a bare count phrase is flagged, though: inside a longer
    // sentence a translator can and usually should sidestep agreement, either
    // with an abbreviated unit ("на {n} сек.") or by putting the noun in the
    // genitive plural ahead of the number ("Просканировано раундов: {n}"). Both
    // are correct for every number, and neither needs plural forms, so
    // flagging them would be noise that trains you to ignore this check.
    if (kind === 'pattern' && MANY_FORMS.has(lang.id) && typeof value === 'string') {
      const bareCount = /^\{n(?:#\d+)?\}\s+\p{Ll}{3,}\s*$/u.test(en);
      if (bareCount) say('no plural forms', en, value);
    }
  }

  grand += problems.length;
  const byKind = new Map();
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) || 0) + 1);
  const summary = [...byKind].map(([k, n]) => `${k} ${n}`).join(', ') || 'clean';
  console.log(`\n${lang.id}  ${entries.length} entries  |  ${summary}`);
  for (const p of problems.slice(0, 12)) {
    console.log(`   ${p.kind.padEnd(16)} ${JSON.stringify(p.key).slice(0, 68)}`);
    console.log(`   ${''.padEnd(16)} ${p.detail.slice(0, 100)}`);
  }
  if (problems.length > 12) console.log(`   ... and ${problems.length - 12} more`);
}

console.log(`\n${grand} thing(s) worth a look.`);
