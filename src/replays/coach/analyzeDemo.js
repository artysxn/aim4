// ---------------------------------------------------------------------------
// replays/coach/analyzeDemo.js
// Run one Autocoach pass over a demo outside the timeline viewer (team page).
// Once notes exist for a round they are never regenerated — only new flags
// that do not collide on id are appended.
// ---------------------------------------------------------------------------

import { TickStore } from '../tickStore.js';
import { fetchRoundMeta, saveRoundNotes } from '../api.js';
import { analyseRound, flagToNote } from './coach.js';

function notesFromMeta(meta) {
  if (!meta) return [];
  if (Array.isArray(meta.notes) && meta.notes.length) {
    return [...meta.notes]
      .map((n) => ({
        id: String(n.id || ''),
        tick: Math.max(0, Math.round(Number(n.tick) || 0)),
        text: String(n.text ?? ''),
        kind: n.kind === 'coach' ? 'coach' : 'user',
        mark: n.mark === 'ok' || n.mark === 'x' ? n.mark : '',
        playerId: String(n.playerId || ''),
        rule: String(n.rule || ''),
        updatedAt: Number(n.updatedAt) || 0
      }))
      .sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt);
  }
  return [];
}

/**
 * @param {{
 *   demoId: string,
 *   side: 1|2,
 *   rounds: Array<{ file: string }>,
 *   onProgress?: (msg: string) => void
 * }} opts
 * @returns {Promise<{ wrote: number, rounds: number }>}
 */
export async function analyzeDemoCoach({ demoId, side, rounds, onProgress }) {
  const seat = side === 2 ? 2 : 1;
  const files = (rounds || []).map((r) => r.file).filter(Boolean);
  if (!files.length) return { wrote: 0, rounds: 0 };

  const store = new TickStore();
  let wrote = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.(`Loading ${i + 1}/${files.length}…`);
      const meta = await fetchRoundMeta(file);
      if (!meta?.players?.length) continue;
      const track = await store.loadFull(file);
      if (!track) continue;

      onProgress?.(`Analysing ${i + 1}/${files.length}…`);
      const scratch = [];
      let result;
      try {
        result = analyseRound({
          meta,
          track,
          network: null,
          sampleAt: (tick) => {
            track.sampleAll(tick, scratch);
            return scratch;
          },
          duelsAt: null
        });
      } catch {
        continue;
      }
      if (!result?.flags?.length) continue;

      const teamOf = new Map((meta.players || []).map((p) => [p.id, p.team]));
      const existing = notesFromMeta(meta);
      const have = new Set(existing.filter((n) => n.kind === 'coach').map((n) => n.id));
      const fresh = result.flags
        .filter((f) => f.rule === 'round-decided' || teamOf.get(f.playerId) === seat)
        .map(flagToNote)
        .filter((n) => !have.has(n.id));
      if (!fresh.length) continue;

      const next = [...existing, ...fresh].sort(
        (a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt
      );
      const payload = next
        .map((n) => ({
          id: n.id,
          tick: n.tick,
          text: String(n.text || '').trim(),
          kind: n.kind === 'coach' ? 'coach' : 'user',
          mark: n.mark || '',
          playerId: n.playerId || '',
          rule: n.rule || '',
          updatedAt: n.updatedAt || Date.now()
        }))
        .filter((n) => n.text);
      await saveRoundNotes(file, payload);
      wrote += fresh.length;
    }
  } finally {
    store.clear();
  }
  onProgress?.('');
  return { wrote, rounds: files.length, demoId };
}
