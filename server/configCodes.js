// ---------------------------------------------------------------------------
// configCodes.js — AIM4-XXXX-YYYY-ZZZZ-000000 format (server + client shared)
// ---------------------------------------------------------------------------

export const CODE_PREFIX = 'AIM4';
export const CODE_PATTERN = /^AIM4-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[0-9]{6}$/;

const SEGMENT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

export function isValidCodeFormat(code) {
  return CODE_PATTERN.test(normalizeCode(code));
}

function randomSegment(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += SEGMENT_CHARS[Math.floor(Math.random() * SEGMENT_CHARS.length)];
  }
  return out;
}

/** Create a new code candidate (caller must ensure uniqueness). */
export function generateCode() {
  const serial = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `${CODE_PREFIX}-${randomSegment()}-${randomSegment()}-${randomSegment()}-${serial}`;
}
