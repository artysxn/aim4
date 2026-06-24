// ---------------------------------------------------------------------------
// ConfigCodes.js — client API for AIM4 settings share codes
// ---------------------------------------------------------------------------

export const CODE_PATTERN = /^AIM4-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[0-9]{6}$/;

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

export function isValidCodeFormat(code) {
  return CODE_PATTERN.test(normalizeCode(code));
}

async function apiFetch(path, opts) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/** Register current settings server-side; returns unique AIM4-XXXX-YYYY-ZZZZ-000000 code. */
export async function exportConfig(settings) {
  const data = await apiFetch('/api/configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings })
  });
  return data.code;
}

/** Fetch settings for a share code. */
export async function importConfig(code) {
  const normalized = normalizeCode(code);
  if (!isValidCodeFormat(normalized)) {
    throw new Error('Code must look like AIM4-XXXX-YYYY-ZZZZ-000000');
  }
  const data = await apiFetch(`/api/configs/${encodeURIComponent(normalized)}`);
  return data.settings;
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
