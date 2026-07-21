// Path-based deep links for singleplayer gamemodes (e.g. /survival, /gridshot/competitive).

import { SCENARIOS } from '../core/SceneManager.js';

/** Segments that must never be treated as scenario ids. */
const RESERVED = new Set(['api', 'ws', 'assets', 'src', 'dist', 'train', 'tools', 'football']);

/** The trainer's own root path — the site landing page owns "/". */
export const TRAINER_PATH = '/train';

/**
 * Parse the pathname into { scenario, variant } or null.
 * Supports /survival, /survival/competitive, and nested deploy paths like /app/survival.
 */
export function parseGamemodePath(pathname = window.location.pathname) {
  const parts = String(pathname || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (!parts.length) return null;

  let variant = 'practice';
  const competitiveIdx = parts.indexOf('competitive');
  if (competitiveIdx >= 0) {
    variant = 'competitive';
    parts.splice(competitiveIdx, 1);
    if (!parts.length) return null;
  }

  const scenario = parts[parts.length - 1];
  if (!scenario || RESERVED.has(scenario) || !SCENARIOS[scenario]) return null;

  return { scenario, variant };
}

/** Build the canonical URL path for a running gamemode. */
export function gamemodePath(scenario, variant = 'practice') {
  if (!SCENARIOS[scenario]) return TRAINER_PATH;
  if (variant === 'competitive') return `/${scenario}/competitive`;
  return `/${scenario}`;
}

/** Replace the browser path without reloading (preserves query string). */
export function replaceGamemodePath(scenario, variant = 'practice') {
  const path = gamemodePath(scenario, variant);
  const url = new URL(window.location.href);
  if (url.pathname === path) return;
  url.pathname = path;
  window.history.replaceState({ gamemode: scenario, variant }, '', url);
}

/** Reset to the trainer root while keeping unrelated query params (lobby, etc.). */
export function clearGamemodePath() {
  const url = new URL(window.location.href);
  if (url.pathname === TRAINER_PATH) return;
  url.pathname = TRAINER_PATH;
  window.history.replaceState(null, '', url);
}
