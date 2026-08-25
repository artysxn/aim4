// ---------------------------------------------------------------------------
// replays/visibility.js
// Who may see which demo, in one place.
//
// Every read path (library list, round meta, ticks, stats index, playlists)
// resolves an access set through here first, so the Database, Analytics,
// Pattern Finder and Charts can only ever aggregate rounds the caller is
// allowed to open. Hiding a row in the UI is not the mechanism; this is.
//
//   public    everyone, signed in or not
//   unlisted  the uploader, their teammates, and anyone opening a direct link
//   private   the uploader alone, link or not
//
// Admin accounts see everything, which is what keeps the pre-account library
// fully usable for its owners.
// ---------------------------------------------------------------------------

import { INGEST_UPLOADER } from './identity.js';
import { teammateIds } from './teamsStore.js';

export const VISIBILITIES = ['public', 'unlisted', 'private'];

export function normalizeVisibility(raw) {
  const v = String(raw || '').toLowerCase();
  return VISIBILITIES.includes(v) ? v : 'public';
}

/**
 * Ownership fields for a record.
 *
 * Explicit uploader* wins. Unattributed records (empty fields) default to
 * @admin so blanks / HLTV ingest are not credited to the historical @artysan
 * identity. LEGACY_UPLOADER remains exported for older call sites.
 */
export function ownerOf(record) {
  if (record?.uploaderId || record?.uploaderName) {
    return {
      id: record.uploaderId || INGEST_UPLOADER.id,
      username: record.uploaderName || INGEST_UPLOADER.username,
      visibility: normalizeVisibility(record?.visibility)
    };
  }
  return {
    id: INGEST_UPLOADER.id,
    username: INGEST_UPLOADER.username,
    visibility: normalizeVisibility(record?.visibility)
  };
}

/**
 * The caller's access context, resolved once per request.
 *
 * @param {{id: string, username: string, admin: boolean}} user
 */
export async function accessFor(user) {
  const mates = user?.id ? await teammateIds(user.id) : new Set();
  return {
    userId: user?.id || '',
    admin: Boolean(user?.admin),
    mates
  };
}

/**
 * @param {object} record   demo record
 * @param {object} access   from accessFor
 * @param {{viaLink?: boolean}} [opts]  true when the caller named this exact
 *   round or demo in the URL, which is what "unlisted" means.
 */
export function canSee(record, access, { viaLink = false } = {}) {
  const owner = ownerOf(record);
  if (access?.admin) return true;
  if (owner.visibility === 'public') return true;
  if (access?.userId && owner.id === access.userId) return true;
  if (owner.visibility === 'private') return false;
  // Unlisted: teammates always, anyone else only through a direct link.
  if (access?.mates?.has(owner.id)) return true;
  return viaLink;
}

/** May the caller rename teams on, delete, or change visibility of this demo? */
export function canManage(record, user) {
  if (user?.admin) return true;
  return Boolean(user?.id) && ownerOf(record).id === user.id;
}

/**
 * Filter a record list down to what the caller may browse. Link-only access is
 * deliberately not granted here: this is the "what is in my library" view.
 */
export function visibleRecords(records, access) {
  return (records || []).filter((r) => canSee(r, access));
}

/** Demo ids the caller may aggregate over, as a Set for fast lookups. */
export function visibleDemoIds(records, access) {
  return new Set(visibleRecords(records, access).map((r) => r.id));
}

/**
 * Round files belong to a demo through the record's materialized round list,
 * so a file name alone is enough to decide access.
 *
 * @returns {Map<string, object>} round file -> owning record
 */
export function roundOwnerIndex(records) {
  const out = new Map();
  for (const r of records || []) {
    for (const round of r.rounds || []) {
      if (round?.file) out.set(round.file, r);
    }
  }
  return out;
}

/**
 * The demo a round file came from. Every materialized round is stored as
 * `<roundId>~<demoId>`, so the name itself carries the answer; the index is
 * the fallback for anything named before that convention.
 *
 * @param {string} file
 * @param {object[]} records
 * @param {Map<string, object>} [index]  from roundOwnerIndex, if already built
 * @param {Map<string, object>} [byId]   id → record, if already built. Without
 *   it every modern `~<demoId>` name pays a linear scan of the whole record
 *   list — per round, per request, which on a large library was most of the
 *   round collector's time.
 */
export function recordForRoundFile(file, records, index = null, byId = null) {
  const name = String(file || '');
  const cut = name.lastIndexOf('~');
  if (cut > 0) {
    const demoId = name.slice(cut + 1).replace(/\.[a-z0-9.]+$/i, '');
    const owner = byId ? byId.get(demoId) : (records || []).find((r) => r.id === demoId);
    if (owner) return owner;
  }
  return (index || roundOwnerIndex(records)).get(name) || null;
}

/** id → record, the companion lookup to roundOwnerIndex. */
export function recordIdIndex(records) {
  const out = new Map();
  for (const r of records || []) if (r?.id) out.set(r.id, r);
  return out;
}
