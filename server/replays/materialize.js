// ---------------------------------------------------------------------------
// replays/materialize.js
// Turn a NormalizedDemo into the exact on-disk shapes ingest would write:
// a demo record (manifest) plus one .json/.bin pair per round, named with
// the round-id scheme. Used by server-side ingest and by the local parser
// that builds an .aim4replay package for upload.
// ---------------------------------------------------------------------------

import { buildRoundId, MAPS } from '../../src/replays/shared/roundId.js';

/**
 * @param {import('../demoparser/schema.js').NormalizedDemo} demo
 * @param {string} demoId
 * @param {object} [meta]
 * @param {(p: object) => void} [onProgress]
 * @returns {{ record: object, files: Map<string, Uint8Array> }}
 */
export function materializeDemo(demo, demoId, meta = {}, onProgress = () => {}) {
  const files = new Map();
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

    const stem = `${id}~${demoId}`;
    const { ticks, ...rest } = r;
    const roundJson = {
      ...rest,
      id,
      map: demo.map,
      mapName: MAPS[demo.map].name,
      tickRate: demo.tickRate,
      team1: demo.team1,
      team2: demo.team2,
      parser: demo.parser,
      demoId
    };

    files.set(`rounds/${stem}.json`, new TextEncoder().encode(JSON.stringify(roundJson)));
    files.set(`rounds/${stem}.bin`, ticksToBytes(ticks));

    rounds.push({
      id,
      file: stem,
      round: r.round,
      winner: r.winner,
      winnerSide: r.winnerSide || null,
      team1Side: r.team1Side || null,
      team2Side: r.team2Side || null,
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
    source: meta.source || 'parse',
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

  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(record, null, 2)));
  return { record, files };
}

function ticksToBytes(ticks) {
  if (ticks instanceof Uint8Array) return ticks;
  if (ticks instanceof ArrayBuffer) return new Uint8Array(ticks);
  if (ticks && typeof ticks.byteLength === 'number') {
    return new Uint8Array(ticks.buffer || ticks, ticks.byteOffset || 0, ticks.byteLength);
  }
  throw new Error('Round is missing a tick buffer.');
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
