// ---------------------------------------------------------------------------
// Storage.js
// Thin, defensive wrappers around localStorage. Everything is namespaced under
// a single prefix and JSON-encoded. All access is wrapped in try/catch so a
// disabled / full localStorage never crashes the game.
// ---------------------------------------------------------------------------

const PREFIX = 'aimtrainer:';

export function read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (e) {
    /* ignore */
  }
}

// ---- Leaderboard helpers --------------------------------------------------
// Records are grouped by scenario + configuration permutation so that scores
// achieved under different settings never pollute each other.

const lbKey = (scenario, configKey) => `lb:${scenario}:${configKey}`;
const MAX_RECORDS = 50;

export function getLeaderboard(scenario, configKey) {
  return read(lbKey(scenario, configKey), []);
}

export function addLeaderboardRecord(scenario, configKey, record) {
  const list = getLeaderboard(scenario, configKey);
  list.push(record);
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, MAX_RECORDS);
  write(lbKey(scenario, configKey), trimmed);
  // Return the 1-based rank of the freshly added record (or null if trimmed).
  const rank = trimmed.indexOf(record);
  return rank === -1 ? null : rank + 1;
}
