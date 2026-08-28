// ---------------------------------------------------------------------------
// server/ingest/gdrive/drive.js
// Reading a public Google Drive folder: list what is in it, download a file.
//
// Two transports, chosen by whether GOOGLE_DRIVE_API_KEY is set:
//
//   API key      the Drive v3 API. Clean listing with names, sizes and
//                checksums, paginated, and alt=media downloads that stream
//                without interstitials. Public ("anyone with the link")
//                folders need no OAuth, only a key.
//   no key       the embedded folder view (drive.google.com/embeddedfolderview)
//                for listing, and uc?export=download for files — including the
//                "can't scan for viruses" interstitial that every demo-sized
//                file triggers, whose confirm form is parsed and followed.
//                Works today, is inherently scrape-shaped, and says so in the
//                queue log; the key is the reliable path.
//
// Everything network-shaped takes a fetch implementation so tests can hand in
// a fake and exercise both transports without Google in the room.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const API = 'https://www.googleapis.com/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * The id inside any of the link shapes people actually paste.
 * @returns {{ kind: 'folder' | 'file', id: string } | null}
 */
export function parseDriveLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return null;

  const folder = /\/(?:drive\/)?(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (folder) return { kind: 'folder', id: folder[1] };
  const file = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (file) return { kind: 'file', id: file[1] };
  const byParam = url.searchParams.get('id');
  if (byParam && /^[A-Za-z0-9_-]{10,}$/.test(byParam)) {
    // open?id=... and uc?id=... are file links; folderview?id= is a folder.
    const isFolder = /folderview/.test(url.pathname);
    return { kind: isFolder ? 'folder' : 'file', id: byParam };
  }
  return null;
}

/** One listed entry, whichever transport produced it. */
function entry({ id, name, mimeType, sizeBytes = 0, md5 = '' }) {
  return { id, name, mimeType, isFolder: mimeType === FOLDER_MIME, sizeBytes, md5 };
}

export function createDriveClient({ apiKey = '', fetchImpl = fetch } = {}) {
  return apiKey ? apiClient(apiKey, fetchImpl) : scrapeClient(fetchImpl);
}

// ---------------------------------------------------------------------------
// Transport 1: the Drive v3 API.
// ---------------------------------------------------------------------------

function apiClient(key, fetchImpl) {
  async function getJson(url) {
    const res = await fetchImpl(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || res.status;
      throw new Error(`Drive API: ${body?.error?.message || `HTTP ${res.status}`} (${reason})`);
    }
    return body;
  }

  return {
    transport: 'api',

    /** The folder's own name, for labelling the job. */
    async describe(id) {
      const meta = await getJson(
        `${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true&key=${key}`
      );
      return entry({ ...meta, sizeBytes: Number(meta.size) || 0 });
    },

    /** Every child of a folder, across however many pages Drive needs. */
    async listFolder(id) {
      const out = [];
      let pageToken = '';
      do {
        const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
        const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,size,md5Checksum)');
        const page = await getJson(
          `${API}/files?q=${q}&fields=${fields}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true` +
            `${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}&key=${key}`
        );
        for (const f of page.files || []) {
          out.push(entry({ ...f, sizeBytes: Number(f.size) || 0, md5: f.md5Checksum || '' }));
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return out;
    },

    async download(file, destPath, opts = {}) {
      const url = `${API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true&key=${key}`;
      const res = await fetchImpl(url, { signal: opts.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Drive API download: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
      }
      return streamToFile(res, destPath, opts);
    }
  };
}

// ---------------------------------------------------------------------------
// Transport 2: no key. The embedded folder view and uc?export=download.
// ---------------------------------------------------------------------------

/**
 * Pull the entries out of an embeddedfolderview page.
 * Exported for the test that pins the shape being parsed: when Google changes
 * this markup, the test names the breakage before an admin hits it live.
 */
export function parseFolderViewHtml(html) {
  const out = [];
  // Each entry: <div class="flip-entry" id="entry-<id>"> ... href to the item
  // ... <div class="flip-entry-title">name</div>
  const re =
    /class="flip-entry"[^>]*id="entry-([A-Za-z0-9_-]{10,})"[\s\S]*?href="([^"]+)"[\s\S]*?class="flip-entry-title"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html))) {
    const [, id, href, rawName] = m;
    const isFolder = /\/folders\/|folderview/.test(href);
    out.push(
      entry({
        id,
        name: decodeEntities(rawName.trim()),
        mimeType: isFolder ? FOLDER_MIME : 'application/octet-stream'
      })
    );
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The "can't scan for viruses" page: a form whose action plus hidden inputs is
 * the real download URL. Exported for the same pin-the-shape reason.
 */
export function parseInterstitial(html) {
  const form = /<form[^>]*action="([^"]+)"[\s\S]*?<\/form>/.exec(html);
  if (!form) return null;
  const action = decodeEntities(form[1]);
  const params = new URLSearchParams();
  const inputRe = /<input[^>]*type="hidden"[^>]*>/g;
  let m;
  while ((m = inputRe.exec(form[0]))) {
    const name = /name="([^"]+)"/.exec(m[0]);
    const value = /value="([^"]*)"/.exec(m[0]);
    if (name) params.set(decodeEntities(name[1]), decodeEntities(value ? value[1] : ''));
  }
  const url = new URL(action);
  for (const [k, v] of params) url.searchParams.set(k, v);
  return url.href;
}

function scrapeClient(fetchImpl) {
  return {
    transport: 'scrape',

    async describe(id) {
      const res = await fetchImpl(`https://drive.google.com/embeddedfolderview?id=${id}`);
      if (!res.ok) throw new Error(`Folder view: HTTP ${res.status}`);
      const html = await res.text();
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
      return entry({
        id,
        name: decodeEntities((title ? title[1] : '').trim()) || id,
        mimeType: FOLDER_MIME
      });
    },

    async listFolder(id) {
      const res = await fetchImpl(`https://drive.google.com/embeddedfolderview?id=${id}`);
      if (!res.ok) throw new Error(`Folder view: HTTP ${res.status}`);
      const html = await res.text();
      return parseFolderViewHtml(html);
    },

    async download(file, destPath, opts = {}) {
      // Leg 1: the uc endpoint. Small files stream from here directly; big
      // ones answer with the interstitial instead.
      let res = await fetchImpl(`https://drive.google.com/uc?export=download&id=${file.id}`, {
        signal: opts.signal,
        redirect: 'follow'
      });
      if (!res.ok) throw new Error(`uc download: HTTP ${res.status}`);

      const type = String(res.headers.get('content-type') || '');
      if (/text\/html/i.test(type)) {
        const html = await res.text();
        const confirmed = parseInterstitial(html);
        if (!confirmed) {
          throw new Error(
            'Drive answered with a page instead of the file, and it does not look like the ' +
              'virus-scan interstitial. The file may not be public.'
          );
        }
        res = await fetchImpl(confirmed, { signal: opts.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`confirmed download: HTTP ${res.status}`);
        if (/text\/html/i.test(String(res.headers.get('content-type') || ''))) {
          throw new Error('Drive kept answering with pages instead of the file. Try an API key.');
        }
      }
      return streamToFile(res, destPath, opts);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared: stream a response body to disk, counting and capping as it goes.
// ---------------------------------------------------------------------------

async function streamToFile(res, destPath, { maxBytes = 0, onProgress, signal } = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const total = Number(res.headers.get('content-length')) || 0;
  if (maxBytes && total > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw new Error(`File is ${total} bytes, over the ${maxBytes} byte cap`);
  }

  const out = fs.createWriteStream(destPath);
  let received = 0;
  try {
    const body = Readable.fromWeb(res.body, { signal });
    for await (const chunk of body) {
      received += chunk.length;
      if (maxBytes && received > maxBytes) {
        throw new Error(`Download passed the ${maxBytes} byte cap`);
      }
      if (!out.write(chunk)) {
        await new Promise((r) => out.once('drain', r));
      }
      onProgress?.({ received, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    return { path: destPath, bytes: received };
  } catch (err) {
    out.destroy();
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }
}
