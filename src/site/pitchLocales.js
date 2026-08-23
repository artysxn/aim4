// ---------------------------------------------------------------------------
// site/pitchLocales.js
// The pitch in Russian and Ukrainian.
//
// A translation is not a copy of the deck — it is an override map in exactly
// the shape the admin editor saves: {slideId: {path: text}}. applyPitchText
// lays it over the English slides, so structure (tables, bars, lists, tones,
// layout) is written once and every language inherits it. Add a bullet to the
// English deck and it appears in all three, in English, until a line is added
// here; the deck can never fall out of structural sync with itself.
//
// English is the source, so it has no map. `lang` rides in the query string
// (?lang=ru), which means no new routes and no new production rewrites: a
// translated deck shares the address of the deck it translates.
// ---------------------------------------------------------------------------

import { RU_TEXT } from './pitchRu.js';
import { UA_TEXT } from './pitchUa.js';

/** Order matters: this is the order the language buttons appear in. */
export const LANGS = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'ru', label: 'RU', name: 'Русский' },
  { id: 'ua', label: 'UA', name: 'Українська' }
];

/** @type {Record<string, {full: object, talk: object} | null>} */
export const LOCALES = {
  en: null,
  ru: RU_TEXT,
  ua: UA_TEXT
};

export const DEFAULT_LANG = 'en';

/**
 * The deck's own chrome, in each language. Short enough to live here rather
 * than in a translation file: a transcript panel labelled in English on a
 * Russian deck reads as an oversight, not as a brand.
 */
const UI = {
  en: { transcript: 'Transcript', pin: 'Press T to pin', pinned: 'Pinned · press T to unpin', empty: 'No script for this slide yet.' },
  ru: { transcript: 'Расшифровка', pin: 'Нажмите T, чтобы закрепить', pinned: 'Закреплено · T, чтобы открепить', empty: 'Для этого слайда текста пока нет.' },
  ua: { transcript: 'Розшифровка', pin: 'Натисніть T, щоб закріпити', pinned: 'Закріплено · T, щоб відкріпити', empty: 'Для цього слайда тексту поки немає.' }
};

/** One chrome string in the current language, falling back to English. */
export function uiText(lang, key) {
  const id = normalizeLang(lang);
  return UI[id]?.[key] ?? UI.en[key] ?? '';
}

/** Normalise anything that arrives from a URL or a saved preference. */
export function normalizeLang(value) {
  const id = String(value || '').toLowerCase();
  if (id === 'uk') return 'ua';
  return Object.prototype.hasOwnProperty.call(LOCALES, id) ? id : DEFAULT_LANG;
}

/**
 * The translation for one deck, or null for English.
 * @param {string} lang
 * @param {'full'|'talk'} deck
 */
export function localeText(lang, deck) {
  return LOCALES[normalizeLang(lang)]?.[deck] || null;
}

/**
 * Admin edits are stored per language, keyed `<lang>-<slideId>` for everything
 * but English, so editing the Russian deck cannot overwrite the English one.
 * This narrows the saved map to one language and strips the prefix, which is
 * what applyPitchText expects.
 *
 * @param {Record<string, Record<string, string>>|null} overrides
 * @param {string} lang
 */
export function scopeOverrides(overrides, lang) {
  if (!overrides) return null;
  const id = normalizeLang(lang);
  if (id === DEFAULT_LANG) return overrides;
  const prefix = `${id}-`;
  const out = {};
  for (const [key, patch] of Object.entries(overrides)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = patch;
  }
  return out;
}

/** The storage key for one slide in one language. */
export function overrideKey(lang, slideId) {
  const id = normalizeLang(lang);
  return id === DEFAULT_LANG ? slideId : `${id}-${slideId}`;
}
