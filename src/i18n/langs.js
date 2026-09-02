// ---------------------------------------------------------------------------
// i18n/langs.js
// The languages the site speaks, and the one function that turns anything
// arriving from a URL, a profile row or a browser into one of them.
//
// The ids are not invented here. `shared/comms/format.js` already ships a
// thirteen-language set for voice transcription (da en es fi fr no pl pt ro ru
// sv uk zh), and an account whose comms language is `no` should not have to
// learn that the site calls the same language `nb`. So the site borrows those
// ids exactly and adds `ja`, which comms does not have.
//
// English is the source language, not a translation. It has no catalogue file,
// it is what every other language falls back to line by line, and a string
// nobody has translated yet simply stays English rather than disappearing.
// ---------------------------------------------------------------------------

/**
 * Order matters: this is the order the account picker lists them in. English
 * first because it is the source, then the rest by rough audience size for a
 * CS2 site rather than alphabetically, which would bury Russian under Danish.
 *
 * `name` is written in the language itself. A picker that offers "Russian"
 * rather than "Русский" is asking people to find their language in a language
 * they may not read.
 */
export const LANGS = Object.freeze([
  { id: 'en', label: 'EN', name: 'English', locale: 'en' },
  { id: 'ru', label: 'RU', name: 'Русский', locale: 'ru' },
  { id: 'zh', label: 'ZH', name: '简体中文', locale: 'zh-Hans' },
  { id: 'pt', label: 'PT', name: 'Português', locale: 'pt-BR' },
  { id: 'es', label: 'ES', name: 'Español', locale: 'es' },
  { id: 'fr', label: 'FR', name: 'Français', locale: 'fr' },
  { id: 'pl', label: 'PL', name: 'Polski', locale: 'pl' },
  { id: 'ja', label: 'JA', name: '日本語', locale: 'ja' },
  { id: 'sv', label: 'SV', name: 'Svenska', locale: 'sv' },
  { id: 'da', label: 'DA', name: 'Dansk', locale: 'da' },
  { id: 'no', label: 'NO', name: 'Norsk', locale: 'nb' },
  { id: 'fi', label: 'FI', name: 'Suomi', locale: 'fi' }
]);

export const DEFAULT_LANG = 'en';

/** Every id, for validation on both sides of the wire. */
export const LANG_IDS = Object.freeze(LANGS.map((l) => l.id));

const BY_ID = new Map(LANGS.map((l) => [l.id, l]));

/**
 * Aliases we accept but do not offer. These are the tags a browser or an OS
 * actually sends: `nb`/`nn` for the two written Norwegians, `pt-BR` with a
 * region, `zh-Hans` with a script. Normalising them here means every other
 * module can assume one of LANG_IDS and never parse a language tag again.
 */
const ALIASES = Object.freeze({
  nb: 'no',
  nn: 'no',
  nb_no: 'no',
  'zh-hans': 'zh',
  'zh-cn': 'zh',
  'zh-sg': 'zh',
  // Traditional Chinese is a different written language and we do not have it.
  // Sending those readers Simplified is worse than sending them English.
  'zh-hant': 'en',
  'zh-tw': 'en',
  'zh-hk': 'en',
  uk: 'en',
  ua: 'en'
});

/**
 * Anything to a language id, or null if it is not a language tag we recognise
 * at all.
 *
 * The null matters on exactly one path. A render can always fall back to
 * English, so `normalizeLang` below is what it wants. A *setter* cannot: an
 * account POSTing "klingon" has to be told so, not quietly reset to English,
 * and the only way to tell that apart from a legitimate "en" is to keep the
 * failure distinct from the default.
 *
 * `zh-Hant` resolving to `en` is not a failure. It is recognised, and English
 * is the honest answer for a reader of Traditional Chinese when the site only
 * has Simplified.
 *
 * @param {unknown} value
 * @returns {string|null} one of LANG_IDS, or null
 */
export function resolveLang(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!raw) return null;
  if (BY_ID.has(raw)) return raw;
  if (raw in ALIASES) return ALIASES[raw];
  // `pt-BR`, `es-419`, `fr-CA`: the base language is the one we serve.
  const base = raw.split('-')[0];
  if (BY_ID.has(base)) return base;
  if (base in ALIASES) return ALIASES[base];
  return null;
}

/**
 * The same, for the render paths: never throws, never returns undefined, and
 * answers English for anything it does not know, because a thrown error here is
 * a blank page.
 *
 * @param {unknown} value
 * @returns {string} one of LANG_IDS
 */
export function normalizeLang(value) {
  return resolveLang(value) ?? DEFAULT_LANG;
}

/** True for a value that is already a language we serve, without coercion. */
export function isLang(value) {
  return typeof value === 'string' && BY_ID.has(value);
}

/** The full record, or the English one for anything unknown. */
export function langInfo(id) {
  return BY_ID.get(normalizeLang(id)) || BY_ID.get(DEFAULT_LANG);
}

/**
 * The BCP 47 tag to hand to Intl. Distinct from the id: the site calls
 * Norwegian `no` and Chinese `zh`, but `Intl.PluralRules('no')` and a `zh`
 * date format both want the fuller tag to behave correctly.
 */
export function localeOf(id) {
  return langInfo(id).locale;
}

/**
 * The best language for a browser that has never chosen one. Walks
 * `navigator.languages` in order and takes the first we serve, so a visitor
 * whose list is [pt-BR, pt, en] gets Portuguese rather than English.
 *
 * Only used for a *suggestion*; nothing auto-switches on it. Guessing wrong
 * and silently swapping the interface out from under someone is worse than
 * leaving them on English with a picker.
 */
export function preferredLang(nav = typeof navigator === 'undefined' ? null : navigator) {
  const tags = nav?.languages?.length ? nav.languages : [nav?.language].filter(Boolean);
  for (const tag of tags || []) {
    const raw = String(tag).trim().toLowerCase();
    if (BY_ID.has(raw)) return raw;
    if (raw in ALIASES && ALIASES[raw] !== DEFAULT_LANG) return ALIASES[raw];
    const base = raw.split('-')[0];
    if (BY_ID.has(base)) return base;
  }
  return DEFAULT_LANG;
}
