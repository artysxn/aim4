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
    counts: null,
    next: null,
    recent: [],
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}

/** Rolling window of interesting events, for the activity list in the UI. */
const RECENT_MAX = 25;

export function foldEvent(status, event, ledger) {
  const s = { ...status, updatedAt: new Date().toISOString() };

  switch (event.type) {
    case 'match-start':
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
    case 'match-failed':
    case 'download-failed':
      s.lastError = event.error;
      s.recent = [
        { at: event.at, kind: 'failed', matchId: event.matchId, text: event.error }
        , ...s.recent
      ].slice(0, RECENT_MAX);
      s.current = null;
      break;
    case 'match-cleaned':
      s.current = null;
      break;
    case 'idle':
      s.current = null;
      s.idleUntil = Date.now() + (event.nextPollInMs || 0);
      break;
    default:
      break;
  }

  if (ledger) {
    s.counts = ledger.counts();
    const next = ledger.oldestPending();
    s.next = next
      ? { matchId: next.matchId, label: next.archiveName || next.matchId, playedAt: next.playedAt }
      : null;
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
