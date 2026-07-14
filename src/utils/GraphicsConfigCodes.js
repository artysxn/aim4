// ---------------------------------------------------------------------------
// GraphicsConfigCodes.js — self-contained share codes for the Graphics menu.
//
// Embeds colors, target bloom, and skybox settings inline (works offline).
// Format:  AIM4G-<base64url(JSON)>   where JSON = { v, g: graphicsConfig }
// ---------------------------------------------------------------------------

export const GRAPHICS_CODE_PREFIX = 'AIM4G-';
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

export function normalizeGraphicsCode(raw) {
  return String(raw || '').trim().replace(/\s+/g, '');
}

export function isGraphicsConfigCode(raw) {
  const code = normalizeGraphicsCode(raw);
  return code.toUpperCase().startsWith(GRAPHICS_CODE_PREFIX);
}

/** Encode graphics settings into a shareable code. */
export function encodeGraphicsConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Graphics config is missing');
  }
  const payload = { v: VERSION, g: config };
  return GRAPHICS_CODE_PREFIX + b64urlEncode(JSON.stringify(payload));
}

/** Decode a graphics config code. Throws on malformed input. */
export function decodeGraphicsConfig(raw) {
  const code = normalizeGraphicsCode(raw);
  if (!isGraphicsConfigCode(code)) {
    throw new Error('Not a graphics config code (expected AIM4G-…)');
  }
  const body = code.slice(GRAPHICS_CODE_PREFIX.length);
  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(body));
  } catch {
    throw new Error('Graphics code is corrupted');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Graphics code is invalid');
  }
  const config = parsed.g && typeof parsed.g === 'object' && !Array.isArray(parsed.g)
    ? parsed.g
    : null;
  if (!config) throw new Error('Graphics code is missing settings');
  return { config };
}
