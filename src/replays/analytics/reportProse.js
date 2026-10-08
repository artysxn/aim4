// ---------------------------------------------------------------------------
// replays/analytics/reportProse.js
// The grammar under the generated reports: lists, counts, articles, clocks and
// the variant pick.
//
// The summary and internal reports are written by templates, the same way the
// autocoach writes its notes (coach/coachMessages.js): a table of phrasings per
// finding, one picked by a hash of what the finding is about, so a report reads
// the same every time it is generated from the same rounds but two findings of
// one kind do not read identically. Everything here is pure and has no idea
// what Counter-Strike is; the reports supply the words.
// ---------------------------------------------------------------------------

/**
 * Deterministic variant index (FNV-1a), the coach's own scheme.
 *
 * @param {string} key   what kind of line this is
 * @param {string|number} seed  what it is about (a player, a call, a round)
 * @param {number} count
 */
export function variantIndex(key, seed, count) {
  if (!(count > 0)) return 0;
  let h = 0x811c9dc5;
  const s = `${key}:${seed}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % count;
}

/**
 * Fill `{name}` placeholders. An unknown placeholder stays visible rather than
 * printing "undefined": a template asking for a value its finding never
 * computed is a copy bug, and it should look like one.
 */
export function fill(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name])
  );
}

/**
 * One line from a message table entry, picked and filled.
 *
 * @param {Record<string, string[]>} table
 * @param {string} key
 * @param {string|number} seed
 * @param {Record<string, unknown>} [vars]
 */
export function phrase(table, key, seed, vars = {}) {
  const variants = table?.[key];
  if (!variants?.length) return '';
  return fill(variants[variantIndex(key, seed, variants.length)], vars);
}

/** First letter up, the rest untouched ("b pop" -> "B pop"). */
export function capitalize(s) {
  const str = String(s || '');
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/**
 * A finished sentence: capitalised, single spaces, one closing mark.
 * Leaves a sentence that already ends in . ! or ? alone.
 *
 * `keep` lists words that are written the way they are written: player
 * handles. "headtr1ck looks for Suicide" stays lower case, because the
 * handle is the name and "Headtr1ck" is somebody else's.
 *
 * @param {string} s
 * @param {Iterable<string>} [keep]
 */
export function sentence(s, keep = null) {
  const str = String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  if (!str) return '';
  let body = str;
  const protectedStart = keep && [...keep].some((name) => name && str.startsWith(name));
  if (!protectedStart) body = capitalize(str);
  return /[.!?]$/.test(body) ? body : `${body}.`;
}

/** Several sentences as one paragraph. Empty parts drop out. */
export function paragraph(parts, keep = null) {
  return (parts || [])
    .map((p) => sentence(p, keep))
    .filter(Boolean)
    .join(' ');
}

/**
 * "a", "a and b", "a, b and c". No serial comma, which is how the reports
 * this mirrors are written. `conj` swaps the last joiner ("or", "+").
 */
export function joinList(items, conj = 'and') {
  const list = (items || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (conj === '+') return list.join(' + ');
  return `${list.slice(0, -1).join(', ')} ${conj} ${list[list.length - 1]}`;
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** 0..10 in words, anything else in digits. */
export function numberWord(n) {
  const i = Math.round(Number(n));
  return i >= 0 && i < SMALL.length ? SMALL[i] : String(i);
}

/** "once", "twice", "3 times". */
export function countWord(n) {
  const i = Math.round(Number(n));
  if (i === 1) return 'once';
  if (i === 2) return 'twice';
  return `${i} times`;
}

/**
 * "1 round", "4 rounds". Pass the plural when it is not a plain -s.
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
export function plural(n, one, many = '') {
  const i = Math.round(Number(n));
  return `${i} ${i === 1 ? one : many || `${one}s`}`;
}

/** The noun alone, agreeing with n: noun(1, 'round') -> 'round'. */
export function noun(n, one, many = '') {
  return Math.round(Number(n)) === 1 ? one : many || `${one}s`;
}

/**
 * Letters whose NAME starts with a vowel sound: "an A Split", "an F1", "an HE",
 * "an M4", but "a B Split", "a CT".
 */
const VOWEL_SOUND_LETTERS = new Set(['A', 'E', 'F', 'H', 'I', 'L', 'M', 'N', 'O', 'R', 'S', 'X']);

/**
 * The indefinite article for a phrase.
 *
 * Map talk is full of letters read as letters ("A site", "B Split", "HE",
 * "AWP"), so a capital standing alone or opening an all-caps word is read by
 * its letter name. Everything else goes by its first sound, with the usual
 * handful of exceptions ("a one-way", "an hour", "a unit").
 */
export function article(phraseText) {
  const s = String(phraseText || '').trim();
  if (!s) return 'a';
  const first = s.split(/[\s-]/)[0];
  const isInitialism =
    /^[A-Z]$/.test(first) || (/^[A-Z0-9]{2,}$/.test(first) && /[A-Z]/.test(first.charAt(0)));
  if (isInitialism) return VOWEL_SOUND_LETTERS.has(first.charAt(0)) ? 'an' : 'a';
  const lower = s.toLowerCase();
  if (/^(one|once|uni|use|usu|eu|ewe|ufo|uk\b|us\b)/.test(lower)) return 'a';
  if (/^(hour|honest|honou?r|heir)/.test(lower)) return 'an';
  if (/^\d/.test(lower)) {
    return /^(8|11|18|80|800)/.test(lower) ? 'an' : 'a';
  }
  return /^[aeiou]/.test(lower) ? 'an' : 'a';
}

/** "an A Split", "a B pop". */
export function withArticle(phraseText) {
  const s = String(phraseText || '').trim();
  return s ? `${article(s)} ${s}` : '';
}

/** Whole percent of part/whole, 0 when there is no whole. */
export function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Countdown clock from seconds left: 92 -> "1:32". */
export function clockText(secondsLeft) {
  if (!Number.isFinite(secondsLeft)) return '';
  const s = Math.max(0, Math.round(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * "Always" when every round did it, "Mostly" above the bar, '' below it.
 * The two words carry the whole tell, so they are decided in one place.
 */
export function frequencyWord(hits, rounds, mostly = 80) {
  if (!(rounds > 0)) return '';
  if (hits >= rounds) return 'Always';
  return percent(hits, rounds) >= mostly ? 'Mostly' : '';
}

/**
 * A narrated sequence of labels: "unawareness once, then poor spacing, then
 * unawareness again, and lastly bad judgement".
 *
 * A label that comes back later is "once" the first time and "again" after;
 * one that never repeats is named plainly.
 *
 * @param {string[]} labels
 * @param {{ last?: string }} [opts]  tail on the final item
 */
export function narrateSequence(labels, opts = {}) {
  const list = (labels || []).filter(Boolean);
  if (!list.length) return '';
  // Back-to-back repeats are one run: "unlucky three times in a row" reads,
  // "unlucky again, then unlucky again" does not.
  const runs = [];
  for (const l of list) {
    const last = runs[runs.length - 1];
    if (last && last.label === l) last.n++;
    else runs.push({ label: l, n: 1 });
  }
  const total = new Map();
  for (const r of runs) total.set(r.label, (total.get(r.label) || 0) + 1);
  const seen = new Map();
  const parts = runs.map(({ label: l, n: run }) => {
    const n = (seen.get(l) || 0) + 1;
    seen.set(l, n);
    if (run > 1) return `${l}${n > 1 ? ' again,' : ''} ${numberWord(run)} times in a row`;
    if (n > 1) return `${l} again`;
    return total.get(l) > 1 ? `${l} once` : l;
  });
  const tail = opts.last ? ` ${opts.last}` : '';
  if (parts.length === 1) return `${parts[0]}${tail}`;
  if (parts.length === 2) return `${parts[0]}, then ${parts[1]}${tail}`;
  const head = parts.slice(0, -1).map((p, i) => (i === 0 ? p : `then ${p}`));
  return `${head.join(', ')}, and lastly ${parts[parts.length - 1]}${tail}`;
}

/** "B" from "b", "Mid" from "mid": the site letters stay letters. */
export function siteName(site) {
  const s = String(site || '').trim();
  if (/^[ab]$/i.test(s)) return s.toUpperCase();
  return s;
}

/**
 * A grenade as the reports say it: "Top Con flash", "Blue molo".
 * `words` maps the internal type to the slang the reports use.
 */
export const NADE_SLANG = {
  smokegrenade: 'smoke',
  molotov: 'molo',
  flashbang: 'flash',
  hegrenade: 'nade'
};

export function nadeName(spot, type) {
  const word = NADE_SLANG[type] || 'nade';
  const s = String(spot || '').trim();
  return s ? `${s} ${word}` : word;
}

/** Plural of a grenade word: "flashes", "smokes", "molos", "nades". */
export function nadePlural(type) {
  const word = NADE_SLANG[type] || 'nade';
  return word === 'flash' ? 'flashes' : `${word}s`;
}
