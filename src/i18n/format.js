// ---------------------------------------------------------------------------
// i18n/format.js
// Numbers, dates and lists in the language the interface is in.
//
// Every Intl call on the site passes `undefined` as the locale, which means the
// browser's language, not the one the account chose. That was invisible while
// there was only English; it is not once someone reading Russian sees "1,234"
// where they expect "1 234", or a Finnish date in the middle of a Finnish page
// written the American way round.
//
// These wrappers are drop-in for the calls already in the code, so the change
// at each of those sites is the import and nothing else. Formatters are cached
// per locale because constructing an Intl formatter is not cheap and the stats
// tables build thousands of cells.
// ---------------------------------------------------------------------------

import { currentLang } from './index.js';
import { localeOf } from './langs.js';

const cache = new Map();

function get(kind, opts) {
  const locale = localeOf(currentLang());
  const key = `${kind}:${locale}:${opts ? JSON.stringify(opts) : ''}`;
  let f = cache.get(key);
  if (f) return f;
  try {
    f =
      kind === 'number'
        ? new Intl.NumberFormat(locale, opts)
        : kind === 'date'
          ? new Intl.DateTimeFormat(locale, opts)
          : kind === 'list'
            ? new Intl.ListFormat(locale, opts)
            : new Intl.RelativeTimeFormat(locale, opts);
  } catch {
    // An unsupported option set must not take a page down; fall back to the
    // default formatter for the same locale.
    try {
      f =
        kind === 'number'
          ? new Intl.NumberFormat(locale)
          : kind === 'date'
            ? new Intl.DateTimeFormat(locale)
            : kind === 'list'
              ? new Intl.ListFormat(locale)
              : new Intl.RelativeTimeFormat(locale);
    } catch {
      return null;
    }
  }
  cache.set(key, f);
  return f;
}

/** The active BCP 47 tag, for the handful of call sites that want it raw. */
export function activeLocale() {
  return localeOf(currentLang());
}

/** Drop-in for `n.toLocaleString()`. */
export function num(value, opts) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return get('number', opts)?.format(n) ?? String(n);
}

/** Drop-in for `d.toLocaleDateString()`. */
export function date(value, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return get('date', opts)?.format(d) ?? d.toISOString().slice(0, 10);
}

/** Money, with the currency written the way the language writes it. */
export function money(value, currency = 'EUR') {
  return num(value, { style: 'currency', currency, maximumFractionDigits: 0 });
}

/** `73%`, spaced the way the locale spaces it (French puts a gap in). */
export function percent(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return num(n / 100, { style: 'percent', maximumFractionDigits: digits });
}

/**
 * "a, b and c" in the target language, replacing the `.join(', ')` and the one
 * hard-coded `' and '` in antistratConfig.
 */
export function list(items, type = 'conjunction') {
  const parts = (items || []).filter((s) => s != null && s !== '').map(String);
  if (!parts.length) return '';
  const f = get('list', { style: 'long', type });
  return f ? f.format(parts) : parts.join(', ');
}

/**
 * "3 minutes ago", "in 2 days". Replaces the two hand-rolled relative-time
 * helpers, which produced "3m ago" in every language.
 */
export function ago(from, now = Date.now()) {
  const ms = (from instanceof Date ? from.getTime() : Number(from)) - now;
  if (!Number.isFinite(ms)) return '';
  const f = get('relative', { numeric: 'auto' });
  const units = [
    ['year', 31536e6],
    ['month', 2592e6],
    ['week', 6048e5],
    ['day', 864e5],
    ['hour', 36e5],
    ['minute', 6e4],
    ['second', 1e3]
  ];
  for (const [unit, size] of units) {
    if (Math.abs(ms) >= size || unit === 'second') {
      const v = Math.round(ms / size);
      return f ? f.format(v, unit) : `${Math.abs(v)} ${unit}${Math.abs(v) === 1 ? '' : 's'}`;
    }
  }
  return '';
}

/** Month and weekday names, replacing the hard-coded English arrays. */
export function monthNames(style = 'short') {
  const f = get('date', { month: style });
  return Array.from({ length: 12 }, (_, i) => f?.format(new Date(Date.UTC(2021, i, 1))) ?? '');
}

export function weekdayNames(style = 'short') {
  const f = get('date', { weekday: style });
  // 2021-02-01 was a Monday, which is where the site's calendar week starts.
  return Array.from({ length: 7 }, (_, i) => f?.format(new Date(Date.UTC(2021, 1, 1 + i))) ?? '');
}

/** A country name in the active language, for the flag picker. */
export function regionName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([activeLocale()], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/** Clears the formatter cache. Called on a language change. */
export function resetFormatters() {
  cache.clear();
}
