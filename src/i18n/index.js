// ---------------------------------------------------------------------------
// i18n/index.js
// Which language the page is in, and everything that follows from it.
//
// The choice lives on the account, so it follows a person between machines.
// It is also mirrored into localStorage, and that mirror is what the first
// paint reads: /api/me is a round trip, and a page that renders in English and
// then swaps to Russian a moment later reads as a bug. The mirror is written
// whenever the account tells us something new, so the two only disagree for the
// one paint after a change made somewhere else.
//
// There is deliberately no ?lang= and no /ru/ prefix. A URL is a third place
// for the answer to live, and two is already one more than ideal.
// ---------------------------------------------------------------------------

import { DEFAULT_LANG, LANGS, localeOf, normalizeLang } from './langs.js';
import { setCatalogue } from './translate.js';
import { resweep, startDomTranslation, stopDomTranslation } from './dom.js';

export { LANGS, DEFAULT_LANG, normalizeLang, localeOf, langInfo, LANG_IDS, preferredLang } from './langs.js';
export { translate, translateEnum } from './translate.js';
export { collectMissing, missingStrings } from './dom.js';

/** Same `aim4.` convention the rest of the site uses for stored preferences. */
export const LANG_KEY = 'aim4.lang';

/**
 * One entry per language with a catalogue on disk. Written as a literal map of
 * arrow functions rather than a computed import of a path built at runtime, so
 * Vite can see each file at build time and give every language its own chunk: a
 * Finnish visitor should not download Japanese.
 *
 * The catalogues are JSON rather than modules because they are data, they are
 * generated and merged by a script, and a JSON diff of a translation change is
 * readable in a way a diff of a hand-formatted JS object is not.
 */
const LOADERS = Object.freeze({
  ru: () => import('./locales/ru.json'),
  zh: () => import('./locales/zh.json'),
  pt: () => import('./locales/pt.json'),
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  pl: () => import('./locales/pl.json'),
  ja: () => import('./locales/ja.json'),
  sv: () => import('./locales/sv.json'),
  da: () => import('./locales/da.json'),
  no: () => import('./locales/no.json'),
  fi: () => import('./locales/fi.json')
});

let current = DEFAULT_LANG;
let started = false;
let loadToken = 0;
const listeners = new Set();

function readStored() {
  try {
    return normalizeLang(window.localStorage.getItem(LANG_KEY));
  } catch {
    return DEFAULT_LANG;
  }
}

function writeStored(id) {
  try {
    if (id === DEFAULT_LANG) window.localStorage.removeItem(LANG_KEY);
    else window.localStorage.setItem(LANG_KEY, id);
  } catch {
    /* private browsing; the account still remembers */
  }
}

/**
 * Mark the document. `lang` is what a screen reader and the browser's own
 * spellcheck read; `data-lang` is what the font rules in site.css hang off,
 * because PP Mori has no Cyrillic and no CJK.
 */
function markDocument(id) {
  const root = document.documentElement;
  root.setAttribute('lang', localeOf(id));
  if (id === DEFAULT_LANG) root.removeAttribute('data-lang');
  else root.setAttribute('data-lang', id);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      /* one bad listener must not stop the rest */
    }
  }
}

/** The language the page is currently in. */
export function currentLang() {
  return current;
}

/** Told when the language changes, after the catalogue has been applied. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function loadAndApply(id) {
  const token = ++loadToken;
  if (id === DEFAULT_LANG) {
    setCatalogue(null);
    if (started) stopDomTranslation();
    started = false;
    return;
  }
  const loader = LOADERS[id];
  if (!loader) {
    setCatalogue(null);
    return;
  }
  let mod = null;
  try {
    mod = await loader();
  } catch {
    // A missing or broken catalogue leaves the site in English, which is the
    // correct failure: readable, just not translated.
    return;
  }
  if (token !== loadToken) return; // a newer switch overtook this one
  setCatalogue(mod?.default || mod?.CATALOGUE || null);
  if (started) resweep();
  else {
    startDomTranslation(document.body);
    started = true;
  }
}

/**
 * Switch language.
 *
 * @param {string} value
 * @param {{persist?: boolean}} [opts] persist:false is for adopting what the
 *   account already said, where writing it back would be a pointless round trip
 */
export async function setLang(value, { persist = true } = {}) {
  const id = normalizeLang(value);
  if (persist) writeStored(id);
  if (id === current && (started || id === DEFAULT_LANG)) return;
  current = id;
  markDocument(id);
  await loadAndApply(id);
  notify();
}

/**
 * Start up from whatever the browser remembers. Called once, early, before the
 * views mount, so the first sweep sees the shell markup that is already in
 * index.html rather than translating it a frame later.
 */
export function initI18n() {
  current = readStored();
  markDocument(current);
  if (current === DEFAULT_LANG) return Promise.resolve();
  return loadAndApply(current);
}

/**
 * A handle on the translation layer from the console, in dev only.
 *
 * Coverage is the thing that is otherwise impossible to see: a string nobody
 * translated looks exactly like a string that was deliberately left English,
 * and both look exactly like a string the extractor never found. `misses()`
 * separates the third case from the other two, and it is the loop that grows
 * the catalogue.
 */
if (import.meta.env?.DEV) {
  window.__i18n = {
    lang: currentLang,
    set: setLang,
    async misses() {
      const { collectMissing, missingStrings } = await import('./dom.js');
      collectMissing(true);
      const { resweep: sweep } = await import('./dom.js');
      sweep();
      await new Promise((r) => requestAnimationFrame(r));
      return missingStrings();
    },
    async size() {
      const { catalogueSize } = await import('./translate.js');
      return catalogueSize();
    }
  };
}

/**
 * What /api/me said. The account is the source of truth, so this overrides the
 * local mirror, and updates it.
 */
export function adoptAccountLanguage(value) {
  if (value == null) return Promise.resolve();
  const id = normalizeLang(value);
  writeStored(id);
  if (id === current) return Promise.resolve();
  return setLang(id, { persist: false });
}
