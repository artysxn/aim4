// ---------------------------------------------------------------------------
// recorder/routes.js — /api/recorder/*
//
//   GET    /api/recorder/latest              the build recorders should run
//   GET    /api/recorder/download            latest build, as a plain .exe
//   GET    /api/recorder/download/:version   one specific build
//   GET    /api/recorder/releases            admin: everything published
//   POST   /api/recorder/releases            admin: publish a build
//   DELETE /api/recorder/releases/:version   admin: pull a bad build
//
// The two GETs are deliberately public and unauthenticated. The download link
// on the site has to work before anyone has installed anything, and a running
// recorder checks for updates without holding an aim4 login: the app never
// signs in, because uploading a recording happens in the browser where the
// user already is.
// ---------------------------------------------------------------------------

import { whoami } from '../replays/identity.js';
import { isSiteAdmin } from '../entitlements/service.js';
import {
  MAX_BUILD_BYTES,
  deleteRelease,
  isValidVersion,
  latestRelease,
  listReleases,
  publishRelease,
  readBuild
} from './releaseStore.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Aim4-Version, X-Aim4-Notes'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...CORS
  });
  res.end(payload);
}

/** The update manifest, shaped for the app's own updater. */
const manifestOf = (rel) =>
  rel
    ? {
        version: rel.version,
        notes: rel.notes,
        sizeBytes: rel.sizeBytes,
        sha256: rel.sha256,
        publishedAt: rel.publishedAt,
        url: `/api/recorder/download/${rel.version}`
      }
    : null;

async function requireAdmin(req, res) {
  const me = await whoami(req);
  if (!me?.id || !(await isSiteAdmin(me.id))) {
    json(res, 403, { error: 'Admins only.' });
    return null;
  }
  return me;
}

function sendExe(res, bytes, version) {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'application/vnd.microsoft.portable-executable',
    'Content-Length': String(bytes.length),
    // One file, named for a human. The updater reads the version from the
    // manifest, not from this name, so renaming on save is harmless.
    'Content-Disposition': `attachment; filename="aim4-recorder.exe"`,
    // Builds are immutable once published, so a version-addressed download can
    // be cached hard. The manifest above is what must never be cached.
    'Cache-Control': version ? 'public, max-age=31536000, immutable' : 'no-store'
  });
  res.end(bytes);
}

/** @returns {Promise<boolean>} true when the request was handled here. */
export async function handleRecorderRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/recorder')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  if (req.method === 'GET' && p === '/api/recorder/latest') {
    const rel = await latestRelease();
    json(res, 200, { latest: manifestOf(rel) });
    return true;
  }

  const versioned = p.match(/^\/api\/recorder\/download\/([0-9.]+)$/);
  if (req.method === 'GET' && (p === '/api/recorder/download' || versioned)) {
    const rel = versioned ? { version: versioned[1] } : await latestRelease();
    if (!rel) {
      json(res, 404, { error: 'No recorder build has been published yet.' });
      return true;
    }
    if (versioned && !isValidVersion(rel.version)) {
      json(res, 400, { error: 'Bad version.' });
      return true;
    }
    const bytes = await readBuild(rel.version);
    if (!bytes) {
      json(res, 404, { error: 'That build is not available.' });
      return true;
    }
    sendExe(res, bytes, versioned ? rel.version : '');
    return true;
  }

  if (req.method === 'GET' && p === '/api/recorder/releases') {
    if (!(await requireAdmin(req, res))) return true;
    json(res, 200, { releases: await listReleases() });
    return true;
  }

  if (req.method === 'POST' && p === '/api/recorder/releases') {
    const me = await requireAdmin(req, res);
    if (!me) return true;

    const version = String(req.headers['x-aim4-version'] || '');
    if (!isValidVersion(version)) {
      json(res, 400, { error: 'Send the version in X-Aim4-Version, like 1.2.3.' });
      return true;
    }

    // Metered while it streams: the body is an executable, not JSON, and must
    // not go through the generic body reader or its 64 KB cap.
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BUILD_BYTES) {
        req.destroy();
        json(res, 413, { error: 'That build is too large.' });
        return true;
      }
      chunks.push(chunk);
    }

    try {
      const release = await publishRelease({
        version,
        notes: String(req.headers['x-aim4-notes'] || ''),
        bytes: Buffer.concat(chunks),
        publishedBy: me.id
      });
      json(res, 200, { release, latest: manifestOf(await latestRelease()) });
    } catch (err) {
      json(res, 400, { error: err?.message || 'Could not publish that build.' });
    }
    return true;
  }

  const del = p.match(/^\/api\/recorder\/releases\/([0-9.]+)$/);
  if (req.method === 'DELETE' && del) {
    if (!(await requireAdmin(req, res))) return true;
    const removed = await deleteRelease(del[1]);
    json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'No such build.' });
    return true;
  }

  return false;
}
