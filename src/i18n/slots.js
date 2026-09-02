// ---------------------------------------------------------------------------
// i18n/slots.js
// The pattern grammar: how an English sentence that was built from data gets
// recognised again, and how the same values get poured into another language.
//
// The site writes its sentences inline, in code:
//
//     `${player} died in a ${n}v${m} with nobody able to trade.`
//
// By the time that reaches the screen it is one flat string, and the pieces
// that came from data are indistinguishable from the pieces that were typed.
// A pattern is the shape put back:
//
//     "{name} died in a {n}v{n} with nobody able to trade."
//
// which compiles to a regex whose capture groups are exactly the data. Match a
// rendered sentence against it and the values fall out; pour them into the
// Russian pattern and the sentence is Russian with the same numbers and the
// same nickname in it.
//
// Two properties make this safe rather than clever:
//
//   1. A pattern is a whole sentence, so word order, case and agreement belong
//      to whoever wrote the translation. Nothing here translates word by word.
//   2. What passes through untouched is only ever a nickname, a map callout, a
//      number or a clock. Those do not inflect in any language we serve, which
//      is why "positions stay English" makes the whole approach work instead of
//      fighting it. A word that *would* inflect is not a passthrough slot; it
//      is an enum slot, and the catalogue carries its forms.
//
// Slot syntax
// -----------
//   {name}   anything that is not a slot: nicknames, team names, callouts
//   {n}      a number, optionally signed and with a decimal part
//   {pct}    a number followed by %
//   {clock}  1:39, 0:07, 12.45
//   {money}  $1,200 / €19
//   {enum:x} one of a named set, whose forms per language live in the catalogue
//
// A type may appear more than once. In the English pattern the occurrences are
// numbered in order; a translation refers to the first as {n} and to the rest
// as {n#2}, {n#3}, which is what lets Japanese put them in a different order
// from English.
// ---------------------------------------------------------------------------

/**
 * What each slot type is allowed to swallow.
 *
 * `{name}` is lazy and forbids newlines so it cannot eat the rest of a
 * paragraph looking for a match further down. Everything else is tight enough
 * that a wrong pattern fails rather than matching sloppily, which matters more
 * than catching every case: a sentence left in English is a gap, a sentence
 * matched by the wrong pattern is a lie.
 */
const SLOT_SOURCE = Object.freeze({
  n: '-?\\d+(?:[.,]\\d+)?',
  pct: '-?\\d+(?:[.,]\\d+)?\\s*%',
  clock: '\\d{1,2}[:.]\\d{2}',
  money: '[€$£]\\s?-?\\d[\\d,.  ]*\\d|[€$£]\\s?-?\\d',
  name: '[^\\n]*?'
});

/** Slot types whose captured value is a number we can pluralise on. */
const NUMERIC = Object.freeze(new Set(['n', 'pct', 'money', 'clock']));

const TOKEN = /\{(name|n|pct|clock|money|enum:[a-z][a-z0-9_-]*)(?:#(\d+))?\}/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Split a template into literal and slot segments.
 *
 * Occurrence numbers are resolved here: a bare `{n}` is the next unnumbered
 * `{n}` in reading order, so the English side never has to write `#1`.
 *
 * @param {string} template
 * @returns {{segments: Array<{lit?: string, type?: string, set?: string, index?: number}>, slots: Array<{type: string, set: string|null, index: number}>}}
 */
export function parseTemplate(template) {
  const segments = [];
  const slots = [];
  const seen = new Map();
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(template))) {
    if (m.index > last) segments.push({ lit: template.slice(last, m.index) });
    const raw = m[1];
    const type = raw.startsWith('enum:') ? 'enum' : raw;
    const set = raw.startsWith('enum:') ? raw.slice(5) : null;
    const key = set ? `enum:${set}` : type;
    // A bare token is the next *bare* one of its type, counted on its own. It
    // cannot be "one past the highest number seen", because a translation is
    // free to write {n#2} before {n} when its word order wants the second
    // number first, and that bare {n} still means the first one.
    let index;
    if (m[2]) {
      index = Number(m[2]);
    } else {
      index = (seen.get(key) || 0) + 1;
      seen.set(key, index);
    }
    const slot = { type, set, index };
    segments.push(slot);
    slots.push(slot);
    last = m.index + m[0].length;
  }
  if (last < template.length) segments.push({ lit: template.slice(last) });
  return { segments, slots };
}

/**
 * Literal words in a template, lowercased.
 *
 * These are the words guaranteed to appear verbatim in any string the pattern
 * matches, which is what makes the inverted index in translate.js exact rather
 * than a heuristic.
 */
export function literalWords(template) {
  const { segments } = parseTemplate(template);
  const out = [];
  for (const seg of segments) {
    if (!seg.lit) continue;
    for (const w of seg.lit.toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (w.length >= 2) out.push(w);
    }
  }
  return out;
}

/** How much of a template is fixed text. Longer means more specific. */
export function literalLength(template) {
  const { segments } = parseTemplate(template);
  let n = 0;
  for (const seg of segments) if (seg.lit) n += seg.lit.trim().length;
  return n;
}

/**
 * Compile an English template into something that can recognise its own output.
 *
 * Runs of whitespace in the literal parts compile to `\s+` because the DOM is
 * not careful about whitespace: the same sentence can arrive with a newline and
 * eight spaces of indentation where the source had one space.
 *
 * @param {string} template
 * @param {(set: string) => string[]} enumValues  English members of a named set
 */
export function compilePattern(template, enumValues = () => []) {
  const { segments, slots } = parseTemplate(template);
  let src = '^';
  for (const seg of segments) {
    if (seg.lit != null) {
      // Escape first, then relax whitespace, so the escaping cannot eat it.
      src += escapeRe(seg.lit).replace(/(?:\\?\s)+/g, '\\s+');
      continue;
    }
    if (seg.type === 'enum') {
      const values = enumValues(seg.set) || [];
      if (!values.length) return null; // an enum with no members can never match
      const alt = values
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(escapeRe)
        .join('|');
      src += `(${alt})`;
      continue;
    }
    src += `(${SLOT_SOURCE[seg.type]})`;
  }
  src += '$';
  let re;
  try {
    re = new RegExp(src, 'u');
  } catch {
    return null;
  }
  return { re, slots, template };
}

/**
 * Try one compiled pattern against a string.
 *
 * @returns {Map<string, string>|null} slot key (`n#1`, `name#2`) to captured text
 */
export function matchPattern(compiled, text) {
  const m = compiled.re.exec(text);
  if (!m) return null;
  const values = new Map();
  compiled.slots.forEach((slot, i) => {
    values.set(slotKey(slot), m[i + 1]);
  });
  return values;
}

/** The stable name of a slot, used to line the two templates up. */
export function slotKey(slot) {
  const base = slot.set ? `enum:${slot.set}` : slot.type;
  return `${base}#${slot.index}`;
}

/**
 * Pour captured values into a template.
 *
 * A slot the translation asks for that the English side never captured is left
 * as written rather than printed as `undefined`. That is the same choice
 * `coachText` already makes, and for the same reason: a visible `{n}` is a bug
 * report, `undefined` in the middle of a sentence is a mystery.
 *
 * @param {string} template
 * @param {Map<string, string>} values
 * @param {(set: string, english: string) => string} [enumOut] English member to
 *   its form in the target language
 */
export function renderTemplate(template, values, enumOut) {
  const { segments } = parseTemplate(template);
  let out = '';
  for (const seg of segments) {
    if (seg.lit != null) {
      out += seg.lit;
      continue;
    }
    const key = slotKey(seg);
    const raw = values.get(key);
    if (raw == null) {
      out += seg.set ? `{enum:${seg.set}}` : `{${seg.type}}`;
      continue;
    }
    out += seg.type === 'enum' && enumOut ? enumOut(seg.set, raw) : raw;
  }
  return out;
}

/**
 * The number a plural form should agree with: the first numeric slot in the
 * English pattern, which in practice is always the count the sentence is about.
 *
 * @returns {number|null}
 */
export function pluralValue(compiled, values) {
  for (const slot of compiled.slots) {
    if (!NUMERIC.has(slot.type)) continue;
    const raw = values.get(slotKey(slot));
    if (raw == null) continue;
    const n = Number(String(raw).replace(/[^0-9.,-]/g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** True if the template has at least one slot. Slot-free strings go in `exact`. */
export function hasSlots(template) {
  TOKEN.lastIndex = 0;
  return TOKEN.test(template);
}
