// ---------------------------------------------------------------------------
// server/ingest/hltv/status.js
// The status file: how the running ingester talks to the admin page.
//
// A file rather than a socket or shared memory, because the ingester runs as a
// separate process from the API server on purpose (a parser OOM must not take
// the website with it). A file is the simplest thing that survives either side
// restarting independently.
//
// Written on every pipeline event and read on demand. Atomic rename, so the
// admin page can never read a half-written object.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

export function emptyStatus() {
  return {
    running: false,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    current: null,
    downloads: [],
    counts: null,
    next: null,
    recent: [],
    lastError: null,
    idleUntil: null,
    cursor: null,
    updatedAt: new Date().toISOString()
  };
}

/** Rolling window of interesting events, for the activity list in the UI. */
const RECENT_MAX = 25;

export function foldEvent(status, event, ledger) {
  const s = { ...status, updatedAt: new Date().toISOString() };
  s.downloads = Array.isArray(status.downloads) ? [...status.downloads] : [];

  switch (event.type) {
    case 'download-start': {
      const item = {
        matchId: event.matchId,
        label: event.label,
        event: event.event,
        playedAt: event.playedAt,
        stage: 'download',
        received: 0,
        totalBytes: 0
      };
      s.downloads = [item, ...s.downloads.filter((d) => d.matchId !== event.matchId)];
      if (!s.current || s.current.stage === 'download') s.current = item;
      break;
    }
    case 'download-progress': {
      s.downloads = s.downloads.map((d) =>
        d.matchId === event.matchId
          ? {
              ...d,
              received: event.received ?? d.received,
              totalBytes: event.total ?? d.totalBytes,
              downloadPhase: event.phase || d.downloadPhase,
              elapsedMs: event.elapsedMs ?? d.elapsedMs
            }
          : d
      );
      const item = s.downloads.find((d) => d.matchId === event.matchId);
      if (item && (!s.current || s.current.stage === 'download')) s.current = item;
      break;
    }
    case 'download-complete':
      s.downloads = s.downloads.filter((d) => d.matchId !== event.matchId);
      if (s.current?.stage === 'download' && s.current.matchId === event.matchId) {
        s.current = s.downloads[0] || null;
      }
      break;
    case 'match-start':
      s.downloads = s.downloads.filter((d) => d.matchId !== event.matchId);
      s.current = {
        matchId: event.matchId,
        label: event.label,
        event: event.event,
        playedAt: event.playedAt,
        stage: event.stage,
        map: null
      };
      break;
    case 'match-progress':
      if (s.current && s.current.matchId === event.matchId) {
        s.current = {
          ...s.current,
          stage: event.stage || s.current.stage,
          map: event.map || s.current.map,
          round: event.round ?? s.current.round,
          totalRounds: event.total ?? s.current.totalRounds
        };
      }
      break;
    case 'match-ingested':
      s.recent = [
        {
          at: event.at,
          kind: 'ingested',
          matchId: event.matchId,
          text: `${(event.teams || []).join(' vs ')} (${event.maps} map${event.maps === 1 ? '' : 's'})`
        },
        ...s.recent
      ].slice(0, RECENT_MAX);
      break;
    case 'match-duplicate':
      s.recent = [
        {
          at: event.at,
          kind: 'duplicate',
          matchId: event.matchId,
          text: `Duplicate of library demo (${event.maps} map${event.maps === 1 ? '' : 's'})`
        },
        ...s.recent
      ].slice(0, RECENT_MAX);
      break;
    case 'match-failed':
      s.lastError = event.error;
      s.recent = [
        { at: event.at, kind: 'failed', matchId: event.matchId, text: event.error },
        ...s.recent
      ].slice(0, RECENT_MAX);
      s.current = null;
      break;
    case 'download-failed':
      if (!event.missing) s.lastError = event.error;
      s.recent = [
        {
          at: event.at,
          kind: event.missing ? 'missing' : 'failed',
          matchId: event.matchId,
          text: event.error
        },
        ...s.recent
      ].slice(0, RECENT_MAX);
      s.downloads = s.downloads.filter((d) => d.matchId !== event.matchId);
      if (!event.missing && s.current?.stage === 'download' && s.current.matchId === event.matchId) {
        s.current = s.downloads[0] || null;
      }
      break;
    case 'match-cleaned':
      s.current = null;
      break;
    case 'cursor':
      s.cursor = {
        startId: event.startId,
        nextId: event.nextId,
        lastSuccessId: event.lastSuccessId,
        highWaterId: event.highWaterId,
        done: event.done,
        total: event.total,
        left: event.left,
        percent: event.percent,
        loopsPerHour: event.loopsPerHour,
        atFrontier: event.atFrontier,
        frontierMisses: event.frontierMisses
      };
      s.next = {
        matchId: String(event.nextId),
        label: `demo/${event.nextId}`,
        playedAt: null
      };
      break;
    case 'frontier':
      s.current = {
        matchId: String(event.demoId),
        label: `demo/${event.demoId}`,
        demoId: event.demoId,
        stage: 'waiting',
        lastSuccessId: event.lastSuccessId
      };
      s.idleUntil = Date.now() + (event.nextCheckInMs || 0);
      break;
    case 'challenge':
      s.lastError = event.error || s.lastError;
      s.current = {
        matchId: String(event.demoId),
        label: `demo/${event.demoId}`,
        demoId: event.demoId,
        stage: 'waiting',
        reason: 'challenge'
      };
      s.idleUntil = Date.now() + (event.nextCheckInMs || 0);
      break;
    case 'idle':
      // Keep waiting UI for frontier / challenge; clear otherwise.
      if (event.reason !== 'frontier' && event.reason !== 'challenge') s.current = null;
      else if (event.reason === 'challenge' && event.demoId != null) {
        s.current = {
          matchId: String(event.demoId),
          label: `demo/${event.demoId}`,
          demoId: event.demoId,
          stage: 'waiting',
          reason: 'challenge'
        };
      }
      s.idleUntil = Date.now() + (event.nextPollInMs || 0);
      break;
    default:
      break;
  }

  if (ledger) {
    s.counts = ledger.counts();
    if (!s.next) {
      const next = ledger.oldestPending();
      s.next = next
        ? { matchId: next.matchId, label: next.archiveName || next.matchId, playedAt: next.playedAt }
        : null;
    }
  }
  return s;
}

export async function writeStatus(file, status) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(status, null, 2));
  await fsp.rename(tmp, file);
}

export async function readStatus(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return emptyStatus();
  }
}
