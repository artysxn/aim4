// ---------------------------------------------------------------------------
// i18n/translate.js
// One string in English, the same string in the active language.
//
// Three passes, cheapest first:
//
//   1. exact      a fixed label, looked up whole
//   2. pattern    a sentence built from data, recognised by shape (slots.js)
//   3. sentences  the string split on sentence boundaries and each half tried
//                 again, because the coach appends one sentence to another
//                 ("… made it even again." + " Round win chance fell from …")
//                 and the pair has no pattern of its own
//
// Anything that matches nothing comes back null and the caller leaves the
// English alone. A missing translation must always read as English, never as
// an empty label or a raw key.
//
// The pattern pass would be too slow done naively: a page can paint thousands
// of text nodes and the catalogue holds over a thousand patterns. The trick is
// that a pattern's literal words appear verbatim in every string it matches, so
// each pattern is filed under its *rarest* literal word. A candidate string is
// only ever tested against patterns that share a rare word with it, which in
// practice is none of them.
// ---------------------------------------------------------------------------

import {
  compilePattern,
  hasSlots,
  literalLength,
  literalWords,
  matchPattern,
  pluralValue,
  renderTemplate
} from './slots.js';
import { DEFAULT_LANG, localeOf, normalizeLang } from './langs.js';

/** Strings this long are prose blocks, not labels; matching them is wasted work. */
const MAX_LEN = 2000;

let active = null;

/**
 * A catalogue, indexed for lookup.
 *
 * @typedef {{lang: string, exact: Record<string, string>,
 *            patterns: Record<string, string|Record<string,string>>,
 *            enums: Record<string, Record<string, string>>}} Catalogue
 */

function buildIndex(cat) {
  const lang = normalizeLang(cat?.lang);
  const exact = cat?.exact || {};
  const patterns = cat?.patterns || {};
  const enums = cat?.enums || {};

  const enumEnglish = (set) => Object.keys(enums[set] || {});
  const enumOut = (set, english) => enums[set]?.[english] ?? english;

  // Document frequency over literal words, so each pattern can be filed under
  // the word least likely to be shared with anything else.
  const df = new Map();
  const words = new Map();
  for (const source of Object.keys(patterns)) {
    const list = [...new Set(literalWords(source))];
    words.set(source, list);
    for (const w of list) df.set(w, (df.get(w) || 0) + 1);
  }

  /** @type {Map<string, Array<{source: string, compiled: object|null|undefined}>>} */
  const buckets = new Map();
  const unindexed = [];
  for (const source of Object.keys(patterns)) {
    const list = words.get(source);
    const entry = { source, compiled: undefined, weight: literalLength(source) };
    if (!list.length) {
      // No fixed text at all. Such a pattern would match nearly anything, so it
      // is kept out of the buckets and only ever tried as a last resort.
      unindexed.push(entry);
      continue;
    }
    let best = list[0];
    for (const w of list) if ((df.get(w) || 0) < (df.get(best) || 0)) best = w;
    if (!buckets.has(best)) buckets.set(best, []);
    buckets.get(best).push(entry);
  }
  for (const list of buckets.values()) list.sort((a, b) => b.weight - a.weight);
  unindexed.sort((a, b) => b.weight - a.weight);

  const plural = (() => {
    try {
      return new Intl.PluralRules(localeOf(lang));
    } catch {
      return null;
    }
  })();

  return { lang, exact, patterns, enums, enumEnglish, enumOut, buckets, unindexed, plural };
}

/**
 * Install the catalogue for the active language, or clear it for English.
 * @param {Catalogue|null} cat
 */
export function setCatalogue(cat) {
  active = cat ? buildIndex(cat) : null;
}

/** The language the installed catalogue is for. */
export function catalogueLang() {
  return active?.lang || DEFAULT_LANG;
}

/** How much is loaded, for the dev coverage report. */
export function catalogueSize() {
  if (!active) return { exact: 0, patterns: 0, enums: 0 };
  return {
    exact: Object.keys(active.exact).length,
    patterns: Object.keys(active.patterns).length,
    enums: Object.keys(active.enums).length
  };
}

/**
 * Pick the right plural form. A translation may be a plain string, or an object
 * keyed by CLDR category for languages that need more than two forms; Russian
 * and Polish both need three, which no `n === 1 ? '' : 's'` in the source can
 * express.
 */
function pickForm(value, count, plural) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  if (count == null) return value.other ?? value.one ?? null;
  const cat = plural ? plural.select(count) : count === 1 ? 'one' : 'other';
  return value[cat] ?? value.other ?? value.one ?? null;
}

function tryPatterns(text) {
  const { buckets, unindexed, patterns, enumEnglish, enumOut, plural } = active;
  const seen = new Set();
  /** @type {Array<object>} */
  const candidates = [];
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) || []) {
    const list = buckets.get(w);
    if (!list) continue;
    for (const entry of list) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      candidates.push(entry);
    }
  }
  // Most fixed text first: "won {n} of {n} rounds we ran" should win over
  // "{n} rounds" when both could match.
  candidates.sort((a, b) => b.weight - a.weight);
  for (const entry of candidates.concat(unindexed)) {
    if (entry.compiled === undefined) {
      entry.compiled = compilePattern(entry.source, enumEnglish);
    }
    if (!entry.compiled) continue;
    const values = matchPattern(entry.compiled, text);
    if (!values) continue;
    const form = pickForm(patterns[entry.source], pluralValue(entry.compiled, values), plural);
    if (form == null) continue;
    return renderTemplate(form, values, enumOut);
  }
  return null;
}

/**
 * Split on sentence ends, keeping the separator with the sentence it closes, so
 * the pieces can be rejoined without losing the spacing the original had.
 */
function sentences(text) {
  const parts = text.split(/(?<=[.!?])(\s+)/);
  if (parts.length < 3) return null;
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    out.push({ text: parts[i], gap: parts[i + 1] ?? '' });
  }
  return out.filter((p) => p.text);
}

/**
 * Translate a run of sentences by matching the longest prefix that the
 * catalogue knows, then continuing from what is left.
 *
 * One sentence at a time is not enough, because the catalogue's own entries are
 * not one sentence each. A coach note is a two-sentence variant with a third
 * sentence appended by the rule that measured the drop:
 *
 *   coachText('advantage-lost', ...)          two sentences, one catalogue entry
 *   + ' Round win chance fell from X to Y.'   one sentence, its own entry
 *
 * Splitting that into three and looking each up finds only the third, because
 * neither half of the two-sentence entry is an entry on its own. Going longest
 * first finds the pair, then the clause, and the note comes out whole.
 */
function greedy(pieces) {
  let i = 0;
  let out = '';
  let any = false;
  while (i < pieces.length) {
    let matched = false;
    // Longest run first: a two-sentence entry must win over the one-sentence
    // entry that happens to start the same way.
    for (let j = pieces.length; j > i; j--) {
      const run = pieces
        .slice(i, j)
        .map((p, k) => p.text + (k < j - i - 1 ? p.gap : ''))
        .join('');
      const hit = active.exact[run] ?? tryPatterns(run);
      if (typeof hit !== 'string') continue;
      out += hit + (pieces[j - 1].gap || '');
      any = true;
      i = j;
      matched = true;
      break;
    }
    if (matched) continue;
    // Nothing covers this sentence. Leave it in English and move on, so one
    // unknown sentence does not cost the translation of the ones around it.
    out += pieces[i].text + pieces[i].gap;
    i++;
  }
  return any ? out.trimEnd() : null;
}

/**
 * English in, the active language out, or null if nothing in the catalogue
 * covers it.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function translate(raw) {
  if (!active) return null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_LEN) return null;

  const hit = active.exact[text];
  if (typeof hit === 'string') return hit;

  // The DOM is careless with whitespace; the catalogue is not.
  const flat = text.replace(/\s+/g, ' ');
  if (flat !== text) {
    const flatHit = active.exact[flat];
    if (typeof flatHit === 'string') return flatHit;
  }

  const byPattern = tryPatterns(flat);
  if (byPattern != null) return byPattern;

  const pieces = sentences(flat);
  if (!pieces) return null;
  return greedy(pieces);
}

/**
 * Translate while keeping the whitespace the original was padded with. Text
 * nodes in a template literal routinely arrive as "\n        Continue\n      ",
 * and replacing that with a trimmed translation collapses the layout around it.
 */
export function translatePadded(raw) {
  if (typeof raw !== 'string') return null;
  const lead = raw.match(/^\s*/)[0];
  const tail = raw.match(/\s*$/)[0];
  const body = translate(raw);
  if (body == null) return null;
  return lead + body + tail;
}

/** Only for tests and the dev reporter. */
export function hasCatalogue() {
  return active != null;
}

/** True if the exact table knows this string. Used by the miss reporter. */
export function knowsExact(text) {
  return active != null && typeof active.exact[String(text).trim()] === 'string';
}

/** Look up one enum member directly, for callers that hold the value already. */
export function translateEnum(set, english) {
  if (!active) return null;
  const table = active.enums[set];
  if (!table) return null;
  return table[english] ?? null;
}

/** Every pattern source, for the catalogue tests. */
export function patternSources() {
  return active ? Object.keys(active.patterns) : [];
}

/** True when a template is well formed enough to be worth filing as a pattern. */
export function isPattern(template) {
  return hasSlots(template);
}
