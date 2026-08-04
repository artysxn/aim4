// ---------------------------------------------------------------------------
// replays/autocoachSummary.js
// Build the Autocoach team page payload: players with mark tallies + demos
// that match the team name, analyzed or not.
// ---------------------------------------------------------------------------

import { SHARED_LIBRARY } from './auth.js';
import {
  listDemos,
  listNotedRounds,
  normalizeRoundNotes,
  readRoundMeta
} from './demoStore.js';
import { autocoachDemosOf } from './teamsStore.js';

function teamNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {object} team
 * @returns {Promise<{
 *   players: Array<{id:string,name:string,total:number,ok:number,x:number}>,
 *   demos: Array<object>,
 *   unanalyzedCount: number
 * }>}
 */
export async function buildAutocoachSummary(team) {
  const want = teamNameKey(team?.name);
  if (!want) {
    return { players: [], demos: [], unanalyzedCount: 0 };
  }

  const records = (await listDemos(SHARED_LIBRARY)).filter(
    (d) => (d.status || 'ready') === 'ready'
  );
  const teamDemos = records.filter((d) => {
    const a = teamNameKey(d.team1?.name);
    const b = teamNameKey(d.team2?.name);
    return a === want || b === want;
  });

  const analyzed = autocoachDemosOf(team);
  const noted = await listNotedRounds(SHARED_LIBRARY);
  const notedByDemo = new Map();
  for (const stem of noted) {
    const m = String(stem).match(/~([A-Za-z0-9_-]+)$/);
    if (!m) continue;
    const demoId = m[1];
    if (!notedByDemo.has(demoId)) notedByDemo.set(demoId, []);
    notedByDemo.get(demoId).push(stem);
  }

  const players = new Map();
  const demos = [];

  for (const demo of teamDemos) {
    const side = teamNameKey(demo.team1?.name) === want ? 1 : 2;
    const entry = analyzed[demo.id] || null;
    const stems = notedByDemo.get(demo.id) || [];
    let coachNotes = 0;
    let playerMistakes = 0;

    for (const stem of stems) {
      let meta = null;
      try {
        meta = await readRoundMeta(SHARED_LIBRARY, stem);
      } catch {
        continue;
      }
      if (!meta) continue;
      const nameOf = new Map((meta.players || []).map((p) => [p.id, p]));
      for (const n of normalizeRoundNotes(meta)) {
        if (n.kind !== 'coach') continue;
        coachNotes++;
        const pid = n.playerId;
        if (!pid) continue;
        const seat = nameOf.get(pid);
        // Count mistakes attributed to players on our side (or unseated).
        if (seat && seat.team && seat.team !== side) continue;
        playerMistakes++;
        const bag = players.get(pid) || {
          id: pid,
          name: seat?.name || pid,
          total: 0,
          ok: 0,
          x: 0
        };
        if (seat?.name) bag.name = seat.name;
        bag.total++;
        if (n.mark === 'ok') bag.ok++;
        if (n.mark === 'x') bag.x++;
        players.set(pid, bag);
      }
    }

    const isAnalyzed = Boolean(entry) || coachNotes > 0;
    const score = demo.score || { team1: 0, team2: 0 };
    demos.push({
      id: demo.id,
      map: demo.map || '',
      mapName: demo.mapName || '',
      name1: demo.team1?.name || 'Team 1',
      name2: demo.team2?.name || 'Team 2',
      score1: Number(score.team1) || 0,
      score2: Number(score.team2) || 0,
      side,
      analyzed: isAnalyzed,
      analyzedAt: entry?.analyzedAt || 0,
      mistakeCount: playerMistakes,
      uploadedAt: Number(demo.uploadedAt || demo.parsedAt || 0) || 0
    });
  }

  demos.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  const playerList = [...players.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name)
  );
  const unanalyzedCount = demos.filter((d) => !d.analyzed).length;

  return { players: playerList, demos, unanalyzedCount };
}
