// ---------------------------------------------------------------------------
// server/ingest/hltv/duplicates.js
// Skip HLTV maps that already exist in the library (manual uploads).
// ---------------------------------------------------------------------------

import { listDemos } from '../../replays/demoStore.js';

function scoreOf(rounds) {
  let t1 = 0;
  let t2 = 0;
  for (const r of rounds || []) {
    if (r.winner === 1) t1++;
    else if (r.winner === 2) t2++;
  }
  return { team1: t1, team2: t2 };
}

function playerKeyFromList(players) {
  const steam = (players || [])
    .map((p) => String(p.steamId || '').trim())
    .filter(Boolean)
    .sort();
  if (steam.length >= 8) return `steam:${steam.join(',')}`;
  const names = (players || [])
    .map((p) => String(p.name || '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return names.length ? `name:${names.join(',')}` : '';
}

function sizeClose(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (!x || !y) return false;
  const ratio = Math.abs(x - y) / Math.max(x, y);
  return ratio <= 0.05;
}

function scoreClose(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(Number(a.team1) - Number(b.team1)) <= 1 &&
    Math.abs(Number(a.team2) - Number(b.team2)) <= 1
  );
}

/** Fingerprint a parsed demo + dem size for library comparison. */
export function fingerprintDemo(demo, sizeBytes) {
  const players = demo?.rounds?.[0]?.players || [];
  return {
    map: demo?.map || '',
    playersKey: playerKeyFromList(players),
    score: scoreOf(demo?.rounds),
    sizeBytes: Number(sizeBytes) || 0
  };
}

export function fingerprintRecord(record) {
  return {
    map: record?.map || '',
    playersKey: playerKeyFromList(record?.players || []),
    score: record?.score || { team1: 0, team2: 0 },
    sizeBytes: Number(record?.sizeBytes) || 0,
    id: record?.id || null
  };
}

export function fingerprintsMatch(a, b) {
  if (!a?.map || !b?.map || a.map !== b.map) return false;
  if (!a.playersKey || !b.playersKey || a.playersKey !== b.playersKey) return false;
  if (!sizeClose(a.sizeBytes, b.sizeBytes)) return false;
  if (!scoreClose(a.score, b.score)) return false;
  return true;
}

/**
 * Find an existing library demo that matches the candidate fingerprint.
 * @returns {object|null} matching record
 */
export async function findLibraryDuplicate(library, fingerprint, { excludeId = null } = {}) {
  if (!fingerprint?.playersKey || !fingerprint.map) return null;
  const demos = await listDemos(library, { fresh: false });
  for (const record of demos) {
    if (excludeId && record.id === excludeId) continue;
    if (fingerprintsMatch(fingerprint, fingerprintRecord(record))) return record;
  }
  return null;
}
