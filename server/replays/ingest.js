// ---------------------------------------------------------------------------
// replays/ingest.js
// Bridges a parsed demo into the library: assigns every round its name and
// writes the round files. The parser stays unaware of the naming scheme, and
// the store stays unaware of parsing; this is the seam between them.
// ---------------------------------------------------------------------------

import { buildRoundId, MAPS } from '../../src/replays/shared/roundId.js';
import { writeRound, writeRecord } from './demoStore.js';

/**
 * Name and persist every round of a parsed demo.
 *
 * @param {string} user
 * @param {string} demoId
 * @param {import('../demoparser/schema.js').NormalizedDemo} demo
 * @param {object} meta         upload metadata (filename, size, uploadedAt)
 * @param {(p: object) => void} [onProgress]
 */
export async function ingestDemo(user, demoId, demo, meta = {}, onProgress = () => {}) {
  const rounds = [];

  for (let i = 0; i < demo.rounds.length; i++) {
    const r = demo.rounds[i];
    const team1Players = r.players.filter((p) => p.team === 1).sort((a, b) => a.slot - b.slot);
    const team2Players = r.players.filter((p) => p.team === 2).sort((a, b) => a.slot - b.slot);

    const id = buildRoundId({
      team1: demo.team1.id,
      team2: demo.team2.id,
      winner: r.winner,
      econ1: r.econ1,
      econ2: r.econ2,
      map: demo.map,
      round: r.round,
      players1: team1Players.map((p) => p.id),
      players2: team2Players.map((p) => p.id)
    });

    // Everything the viewer needs for one round, minus the tick buffer, which
    // writeRound splits into the .bin sidecar.
    const file = await writeRound(
      user,
      demoId,
      { ...r, id },
      {
        map: demo.map,
        mapName: MAPS[demo.map].name,
        tickRate: demo.tickRate,
        team1: demo.team1,
        team2: demo.team2,
        parser: demo.parser
      }
    );

    rounds.push({
      id,
      file,
      round: r.round,
      winner: r.winner,
      econ1: r.econ1,
      econ2: r.econ2,
      startTick: r.startTick,
      freezeEndTick: r.freezeEndTick,
      plantTick: r.plantTick,
      endTick: r.endTick,
      officialEndTick: r.officialEndTick
    });

    onProgress({ stage: 'store', round: i + 1, total: demo.rounds.length });
  }

  const record = {
    id: demoId,
    status: 'ready',
    filename: meta.filename || `${demoId}.dem`,
    sizeBytes: meta.sizeBytes || 0,
    uploadedAt: meta.uploadedAt || Date.now(),
    parsedAt: Date.now(),
    map: demo.map,
    mapName: MAPS[demo.map].name,
    tickRate: demo.tickRate,
    team1: demo.team1,
    team2: demo.team2,
    parser: demo.parser,
    players: demo.rounds[0]?.players ?? [],
    score: scoreOf(demo.rounds),
    roundCount: rounds.length,
    rounds
  };

  await writeRecord(user, record);
  return record;
}

function scoreOf(rounds) {
  let t1 = 0;
  let t2 = 0;
  for (const r of rounds) {
    if (r.winner === 1) t1++;
    else t2++;
  }
  return { team1: t1, team2: t2 };
}
