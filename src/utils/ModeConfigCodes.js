// ---------------------------------------------------------------------------
// ModeConfigCodes.js — self-contained share codes for a single training mode.
//
// Unlike the server-backed AIM4-XXXX account settings codes (ConfigCodes.js),
// a mode config code embeds everything inline: the scenario id, that mode's
// practice settings and its duration (time or kills). No backend round-trip,
// so it works offline and is the unit playlists are built from.
//
// Format:  AIM4M-<base64url(JSON)>   where JSON = { v, s: scenario, c: config }
// ---------------------------------------------------------------------------

export const MODE_CODE_PREFIX = 'AIM4M-';
const VERSION = 1;

/** UTF-8 safe base64url (browser btoa/atob only handle latin1). */
function b64urlEncode(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return decodeURIComponent(escape(atob(t)));
}

export function normalizeModeCode(raw) {
  return String(raw || '').trim().replace(/\s+/g, '');
}

export function isModeConfigCode(raw) {
  const code = normalizeModeCode(raw);
  return code.toUpperCase().startsWith(MODE_CODE_PREFIX);
}

/**
 * Encode one mode's practice config into a shareable code.
 * @param {{ scenario: string, config: object }} mode
 */
export function encodeModeConfig({ scenario, config }) {
  if (!scenario || typeof scenario !== 'string') {
    throw new Error('Mode config requires a scenario');
  }
  const payload = { v: VERSION, s: scenario, c: config ?? {} };
  return MODE_CODE_PREFIX + b64urlEncode(JSON.stringify(payload));
}

/**
 * Decode a mode config code back into { scenario, config }.
 * Throws with a friendly message on malformed input.
 */
export function decodeModeConfig(raw) {
  const code = normalizeModeCode(raw);
  if (!isModeConfigCode(code)) {
    throw new Error('Not a mode config code (expected AIM4M-…)');
  }
  const body = code.slice(MODE_CODE_PREFIX.length);
  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(body));
  } catch {
    throw new Error('Config code is corrupted');
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.s !== 'string') {
    throw new Error('Config code is missing a scenario');
  }
  const config = parsed.c && typeof parsed.c === 'object' && !Array.isArray(parsed.c)
    ? parsed.c
    : {};
  return { scenario: parsed.s, config };
}
