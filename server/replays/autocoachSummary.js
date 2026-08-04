// ---------------------------------------------------------------------------
// replays/autocoachSummary.js
// Build the Autocoach team page payload: players with mark tallies + demos
// that match the team name, analyzed or not. Coach notes on our roster side
// are mistakes.
// ---------------------------------------------------------------------------

import { SHARED_LIBRARY } from './auth.js';
import {
  listDemos,
  listNotedRounds,
  normalizeRoundNotes,
  readRoundMeta,
  writeRoundNotes
} from './demoStore.js';
import { autocoachDemosOf } from './teamsStore.js';

function teamNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase();
}

function emptyPlayer(id, name) {
  return { id, name: name || id, total: 0, ok: 0, x: 0, rounds: 0, avg: 0 };
}

function withAvg(bag) {
  const rounds = Number(bag.rounds) || 0;
  bag.avg = rounds > 0 ? bag.total / rounds : 0;
  return bag;
}

/**
 * Players who appeared on our roster seat in this demo (same idea as Overview
 * ratings: everyone who played under the matching team display name).
 */
async function rosterForSide(demo, side) {
  const file = (demo.rounds || []).find((r) => r?.file)?.file;
  if (!file) return [];
  let meta = null;
  try {
    meta = await readRoundMeta(SHARED_LIBRARY, file);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const p of meta?.players || []) {
    if (!p?.id || p.team !== side || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name || p.id });
  }
  return out;
}

/**
 * @param {object} team
 * @returns {Promise<{
 *   players: Array<{id:string,name:string,total:number,ok:number,x:number,rounds:number,avg:number}>,
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
    const roster = await rosterForSide(demo, side);
    const roundCount =
      (Array.isArray(demo.rounds) && demo.rounds.length) ||
      Number(demo.roundCount) ||
      0;
    const perDemo = new Map(roster.map((p) => [p.id, emptyPlayer(p.id, p.name)]));

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
        const pid = n.playerId;
        if (!pid) continue;
        const seat = nameOf.get(pid);
        // Only mistakes by players on our roster side.
        if (!seat || seat.team !== side) continue;

        const bag = perDemo.get(pid) || emptyPlayer(pid, seat.name || pid);
        if (seat.name) bag.name = seat.name;
        bag.total++;
        if (n.mark === 'ok') bag.ok++;
        if (n.mark === 'x') bag.x++;
        perDemo.set(pid, bag);

        const global = players.get(pid) || emptyPlayer(pid, bag.name);
        if (bag.name) global.name = bag.name;
        global.total++;
        if (n.mark === 'ok') global.ok++;
        if (n.mark === 'x') global.x++;
        players.set(pid, global);
      }
    }

    const mistakeCount = [...perDemo.values()].reduce((n, p) => n + p.total, 0);
    // Analyzed means we ran (or restored) a pass for this team — registry wins.
    // Notes alone also count so older demos coached in the viewer stay marked.
    const isAnalyzed = Boolean(entry) || mistakeCount > 0;

    // Roster players with zero mistakes still belong on the team list / Review.
    // Avg uses rounds from analyzed demos only (pending matches do not dilute it).
    for (const p of roster) {
      const global = players.get(p.id) || emptyPlayer(p.id, p.name);
      if (p.name && (global.name === p.id || !global.name)) global.name = p.name;
      if (isAnalyzed && roundCount > 0) global.rounds += roundCount;
      players.set(p.id, global);

      const local = perDemo.get(p.id) || emptyPlayer(p.id, p.name);
      if (isAnalyzed && roundCount > 0) local.rounds = roundCount;
      perDemo.set(p.id, withAvg(local));
    }

    const demoPlayers = [...perDemo.values()]
      .map(withAvg)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
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
      mistakeCount,
      players: demoPlayers,
      uploadedAt: Number(demo.uploadedAt || demo.parsedAt || 0) || 0
    });
  }

  demos.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  const playerList = [...players.values()]
    .map(withAvg)
    .sort((a, b) => b.avg - a.avg || b.total - a.total || a.name.localeCompare(b.name));
  const unanalyzedCount = demos.filter((d) => !d.analyzed).length;

  return { players: playerList, demos, unanalyzedCount };
}

/**
 * Strip coach notes from the given demos' rounds so analysis can run again.
 * User notes are kept.
 * @param {string[]} demoIds
 * @returns {Promise<number>} rounds cleared
 */
export async function clearCoachNotesForDemos(demoIds) {
  const want = new Set(
    (Array.isArray(demoIds) ? demoIds : [])
      .map((id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, ''))
      .filter(Boolean)
  );
  if (!want.size) return 0;

  const records = await listDemos(SHARED_LIBRARY);
  let cleared = 0;
  for (const demo of records) {
    if (!want.has(demo.id)) continue;
    for (const r of demo.rounds || []) {
      const file = r?.file;
      if (!file) continue;
      let meta = null;
      try {
        meta = await readRoundMeta(SHARED_LIBRARY, file);
      } catch {
        continue;
      }
      if (!meta) continue;
      const before = normalizeRoundNotes(meta);
      if (!before.some((n) => n.kind === 'coach')) continue;
      const next = before.filter((n) => n.kind !== 'coach');
      await writeRoundNotes(SHARED_LIBRARY, file, { notes: next });
      cleared++;
    }
  }
  return cleared;
}
