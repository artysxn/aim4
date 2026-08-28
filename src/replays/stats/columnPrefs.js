// ---------------------------------------------------------------------------
// replays/stats/columnPrefs.js
// Which Database columns this person has switched off.
//
// Two layers, both optional at runtime:
//  - localStorage: always written, so the choice survives a reload even
//    signed out.
//  - the site's SettingsManager (bound once by site.js): the preference rides
//    the existing per-account settings blob, which AuthManager already syncs
//    to the cloud, so a signed-in account keeps its columns across devices.
//
// The stored value is a list of DISABLED entry ids (`players:psdt`); an empty
// list means every column is on, which is the default.
// ---------------------------------------------------------------------------

import { normalizeDisabledColumns } from './columnCatalog.js';

const STORAGE_KEY = 'aim4_database_columns_off';

/** @type {import('../../core/SettingsManager.js').SettingsManager | null} */
let settingsRef = null;
/** @type {Set<(disabled: string[]) => void>} */
const listeners = new Set();
let lastSerialized = null;

function readLocal() {
  try {
    return normalizeDisabledColumns(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function writeLocal(disabled) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(disabled));
  } catch {
    /* private mode; the in-memory session still works */
  }
}

function readSettings() {
  const stored = settingsRef?.data?.site?.databaseColumnsOff;
  return Array.isArray(stored) ? normalizeDisabledColumns(stored) : null;
}

function notify() {
  const now = disabledStatsColumns();
  const serialized = now.join(',');
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  for (const fn of listeners) {
    try {
      fn(now);
    } catch {
      /* one panel's paint must not stop the others */
    }
  }
}

/**
 * Bind the site's settings instance so the preference syncs per account.
 * Also listens for cloud pulls (sign-in on another device's choice arriving)
 * and tells the panels.
 */
export function bindColumnPrefs(settings) {
  settingsRef = settings || null;
  lastSerialized = disabledStatsColumns().join(',');
  settingsRef?.onChange?.(() => notify());
}

/** The disabled entry ids. Settings blob wins over localStorage when present. */
export function disabledStatsColumns() {
  return readSettings() ?? readLocal();
}

/** Persist a new disabled list everywhere and tell every listener. */
export function setDisabledStatsColumns(next) {
  const disabled = normalizeDisabledColumns(next);
  writeLocal(disabled);
  if (settingsRef) {
    const site = settingsRef.data.site && typeof settingsRef.data.site === 'object'
      ? settingsRef.data.site
      : {};
    settingsRef.data.site = { ...site, databaseColumnsOff: disabled };
    // save() persists locally and schedules the account's cloud push.
    settingsRef.save();
  }
  notify();
}

/** @returns {() => void} unsubscribe */
export function onStatsColumnsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}
