// ---------------------------------------------------------------------------
// server/ingest/hltv/disk.js
// List and delete ingest scratch files (archives, demos, probe packages).
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { dirBytes, freeBytes } from './cleanup.js';

const INTERESTING =
  /\.(rar|zip|7z|dem|gz|zst|tar|tgz|aim4replay)$/i;

function kindOf(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.aim4replay')) return 'aim4replay';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar.zst')) return 'tar.zst';
  if (lower.endsWith('.dem.gz')) return 'dem.gz';
  if (lower.endsWith('.dem.zst')) return 'dem.zst';
  const ext = path.extname(lower).slice(1);
  return ext || 'file';
}

function rootsFor(cfg) {
  return {
    work: path.resolve(cfg.workDir),
    probe: path.resolve(path.join(cfg.stateDir, 'probe'))
  };
}

function cloakDownloadsPath(cfg) {
  return path.resolve(
    cfg.cloakDownloadsDir || path.join(cfg.workDir, '.cloakbrowser-downloads')
  );
}

async function walkFiles(root, relative = '') {
  const dir = relative ? path.join(root, relative) : root;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(root, rel);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, rel)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!INTERESTING.test(entry.name)) continue;
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    out.push({
      relative: rel.replace(/\\/g, '/'),
      name: entry.name,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: kindOf(entry.name)
    });
  }
  return out;
}

function resolveSafe(root, relative) {
  const cleaned = String(relative || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('..')) return null;
  const full = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

/**
 * Inventory of download/scratch files under the ingest work + probe keep dirs.
 */
export async function listIngestDisk(cfg) {
  const roots = rootsFor(cfg);
  const files = [];

  for (const [rootKey, rootPath] of Object.entries(roots)) {
    const exists = await fsp.access(rootPath).then(() => true, () => false);
    if (!exists) continue;
    const found = await walkFiles(rootPath);
    for (const file of found) {
      files.push({
        id: `${rootKey}:${file.relative}`,
        root: rootKey,
        ...file
      });
    }
  }

  files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));

  const cloakPath = cloakDownloadsPath(cfg);
  const [workBytes, probeBytes, cloakBytes, free] = await Promise.all([
    dirBytes(roots.work),
    dirBytes(roots.probe),
    dirBytes(cloakPath),
    freeBytes(roots.work)
  ]);

  // cloakDownloads is usually inside workDir; usedBytes is work + probe only.
  const usedBytes = workBytes + probeBytes;

  return {
    files,
    usedBytes,
    freeBytes: Number.isFinite(free) ? free : null,
    breakdown: {
      work: workBytes,
      probe: probeBytes,
      cloakDownloads: cloakBytes
    },
    roots: {
      work: roots.work,
      probe: roots.probe,
      cloakDownloads: cloakPath
    }
  };
}

/**
 * Delete listed file ids (`root:relative`). Returns freed bytes and results.
 */
export async function deleteIngestDisk(cfg, ids = []) {
  const roots = rootsFor(cfg);
  const list = Array.isArray(ids) ? ids : [];
  const deleted = [];
  const errors = [];
  let freed = 0;

  for (const id of list) {
    const raw = String(id || '');
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      errors.push({ id: raw, error: 'invalid id' });
      continue;
    }
    const rootKey = raw.slice(0, colon);
    const relative = raw.slice(colon + 1);
    const rootPath = roots[rootKey];
    if (!rootPath) {
      errors.push({ id: raw, error: 'unknown root' });
      continue;
    }
    const full = resolveSafe(rootPath, relative);
    if (!full) {
      errors.push({ id: raw, error: 'path rejected' });
      continue;
    }
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) {
      errors.push({ id: raw, error: 'missing' });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ id: raw, error: 'not a file' });
      continue;
    }
    if (!INTERESTING.test(path.basename(full))) {
      errors.push({ id: raw, error: 'type not allowed' });
      continue;
    }
    await fsp.rm(full, { force: true });
    freed += stat.size;
    deleted.push(raw);

    // Drop empty parent dirs under the root (not the root itself).
    let parent = path.dirname(full);
    while (parent.startsWith(rootPath + path.sep) && parent !== rootPath) {
      const left = await fsp.readdir(parent).catch(() => null);
      if (!left || left.length) break;
      await fsp.rmdir(parent).catch(() => {});
      parent = path.dirname(parent);
    }
  }

  const inventory = await listIngestDisk(cfg);
  return { deleted, errors, freed, ...inventory };
}
