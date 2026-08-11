// ---------------------------------------------------------------------------
// server/ingest/hltv/classify.js
// Classify CloakBrowser download outcomes: archive vs HLTV 404 vs challenge.
// ---------------------------------------------------------------------------

import { looksLikeChallenge } from './fetcher.js';

export class MissingDemoError extends Error {
  constructor(demoId, detail = '') {
    super(
      detail
        ? `HLTV demo ${demoId} not found (${detail})`
        : `HLTV demo ${demoId} not found`
    );
    this.name = 'MissingDemoError';
    this.missing = true;
    this.demoId = demoId;
  }
}

const MAGIC = [
  { kind: 'rar', ext: '.rar', test: (b) => b.slice(0, 4).toString('latin1') === 'Rar!' },
  { kind: 'zip', ext: '.zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { kind: 'gz', ext: '.gz', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  {
    kind: 'zst',
    ext: '.zst',
    test: (b) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd
  },
  { kind: 'dem', ext: '.dem', test: (b) => b.slice(0, 7).toString('latin1') === 'PBDEMS2' },
  { kind: 'dem', ext: '.dem', test: (b) => b.slice(0, 7).toString('latin1') === 'HL2DEMO' }
];

export function sniffMagic(buf) {
  for (const m of MAGIC) {
    if (buf.length >= 4 && m.test(buf)) return { kind: m.kind, ext: m.ext };
  }
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<!doctype') || head.includes('<html')) {
    return { kind: 'html', ext: null };
  }
  return { kind: 'unknown', ext: null };
}

export function pageTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html || '');
  return m ? m[1].trim().slice(0, 120) : '';
}

export function looksLikeMissingPage(html) {
  const text = String(html || '');
  const title = pageTitle(text);
  if (/page not found/i.test(title)) return true;
  if (/requested URL doesn't exist/i.test(text)) return true;
  if (/<h1[^>]*>\s*404\s*<\/h1>/i.test(text)) return true;
  return false;
}

/** True when an Error from CloakBrowser/navigation means the demo id is gone. */
export function isMissingDownloadError(err) {
  const msg = String(err?.message || err || '');
  if (err?.missing) return true;
  if (/HTTP 404/i.test(msg)) return true;
  if (/page not found/i.test(msg)) return true;
  return false;
}

export function classifyDownloadedBytes(buf) {
  const magic = sniffMagic(buf);
  if (magic.kind === 'rar' || magic.kind === 'zip' || magic.kind === 'gz' || magic.kind === 'zst' || magic.kind === 'dem') {
    return { kind: 'archive', magic };
  }
  if (magic.kind === 'html') {
    const html = buf.toString('utf8');
    if (looksLikeChallenge(html)) return { kind: 'challenge', magic, title: pageTitle(html) };
    if (looksLikeMissingPage(html)) return { kind: 'missing', magic, title: pageTitle(html) };
    return { kind: 'html', magic, title: pageTitle(html) };
  }
  return { kind: 'unknown', magic };
}
