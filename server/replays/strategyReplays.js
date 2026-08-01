// ---------------------------------------------------------------------------
// replays/strategyReplays.js
// Storage for synthetic 2D rounds built in the Strategy Creator.
//
// A round body is tens of thousands of samples, so each one is its own file and
// the team keeps a light index next to them. teams.json stays small and a list
// view never reads a single sample.
//
//   server/data/replays/strategies2d/<teamId>/index.json
//   server/data/replays/strategies2d/<teamId>/<id>.json
//
// Every round carries a share id. Team members list and open their team's
// rounds; anybody holding the share link can open that one round and nothing
// else, which is what makes a strat sendable to a coach outside the team.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './demoStore.js';
import { isAdmin, isOwner, teamById } from './teamsStore.js';
import {
  decodeRound,
  roundSummary,
  sanitizeEncodedRound
} from '../../src/replays/creator/recordingFormat.js';

/** Rounds one team may keep per map. */
export const MAX_ROUNDS_PER_MAP = 8;
/**
 * A serialized round over this is refused. The encoder puts a full ten-body
 * round at ~85 KB, so anything past 512 KB is not a round this tool produced.
 */
export const MAX_ROUND_BYTES = 512 * 1024;

const baseDir = () => path.join(ROOT, 'strategies2d');
const teamDir = (teamId) => path.join(baseDir(), safeId(teamId));
const indexPath = (teamId) => path.join(teamDir(teamId), 'index.json');
const roundPath = (teamId, id) => path.join(teamDir(teamId), `${safeId(id)}.json`);

function safeId(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) throw new Error('Bad id.');
  return s;
}

const newId = () => `s2_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const newShareId = () => crypto.randomBytes(9).toString('base64url');

function denied(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

async function readIndex(teamId) {
  try {
    const raw = await fsp.readFile(indexPath(teamId), 'utf8');
    const body = JSON.parse(raw);
    return Array.isArray(body?.rounds) ? body.rounds : [];
  } catch {
    return [];
  }
}

async function writeIndex(teamId, rounds) {
  await fsp.mkdir(teamDir(teamId), { recursive: true });
  await fsp.writeFile(indexPath(teamId), JSON.stringify({ rounds }, null, 2));
  return rounds;
}

/** Index entries for a team, newest first. */
export async function listRounds(teamId) {
  const rounds = await readIndex(teamId);
  return [...rounds].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function readRound(teamId, id) {
  try {
    const raw = await fsp.readFile(roundPath(teamId, id), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** May this account change or delete the round? Author, team admin, or owner. */
export function canEditRound(team, entry, userId, admin = false) {
  if (admin) return true;
  if (!entry || !userId) return false;
  if (entry.authorId === userId) return true;
  return isOwner(team, userId) || isAdmin(team, userId);
}

/**
 * Create or replace a round. The body is validated through the same sanitizer
 * the client uses, so a hand-rolled POST cannot store a shape the player would
 * choke on.
 *
 * @param {{id: string, username: string, admin?: boolean}} actor
 */
export async function saveRound(actor, teamId, patch = {}) {
  const team = await teamById(teamId);
  if (!team) throw new Error('That team no longer exists.');
  const isMember = (team.members || []).some((m) => m.id === actor.id);
  if (!isMember && !actor.admin) throw denied('You are not on that team.');

  const rounds = await readIndex(teamId);
  const id = patch.id ? safeId(patch.id) : '';
  const existing = id ? rounds.find((r) => r.id === id) : null;
  if (existing && !canEditRound(team, existing, actor.id, actor.admin)) {
    throw denied('You can only edit rounds you made.');
  }

  // Validated by round trip: anything that does not survive decode + encode is
  // not stored, so a hand-rolled POST cannot plant a shape the player chokes on.
  const round = sanitizeEncodedRound(patch.round || {});
  const body = JSON.stringify(round);
  if (body.length > MAX_ROUND_BYTES) {
    throw new Error('That round is too large to save.');
  }

  // The cap is per map, so a team can fill out one map's book without spending
  // the allowance the rest of the pool needs.
  if (!existing) {
    const onMap = rounds.filter((r) => r.map === round.map).length;
    if (onMap >= MAX_ROUNDS_PER_MAP) {
      throw new Error(
        `That map already has ${MAX_ROUNDS_PER_MAP} strategy rounds. Delete one first.`
      );
    }
  }

  const summary = roundSummary(decodeRound(round));
  const entry = {
    id: existing?.id || newId(),
    shareId: existing?.shareId || newShareId(),
    name: String(patch.name ?? round.name ?? '').trim().slice(0, 120) || 'Untitled round',
    map: round.map,
    side: round.side,
    strategyId: round.strategyId || '',
    authorId: existing?.authorId || actor.id,
    authorName: existing?.authorName || actor.username,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    updatedBy: actor.username,
    summary
  };

  round.name = entry.name;
  await fsp.mkdir(teamDir(teamId), { recursive: true });
  await fsp.writeFile(roundPath(teamId, entry.id), JSON.stringify(round));

  const next = existing
    ? rounds.map((r) => (r.id === entry.id ? entry : r))
    : [...rounds, entry];
  await writeIndex(teamId, next);
  return entry;
}

export async function deleteRound(actor, teamId, id) {
  const team = await teamById(teamId);
  if (!team) throw new Error('That team no longer exists.');
  const rounds = await readIndex(teamId);
  const entry = rounds.find((r) => r.id === id);
  if (!entry) throw new Error('That round no longer exists.');
  if (!canEditRound(team, entry, actor.id, actor.admin)) {
    throw denied('You can only delete rounds you made.');
  }
  await fsp.rm(roundPath(teamId, id), { force: true });
  await writeIndex(teamId, rounds.filter((r) => r.id !== id));
  return true;
}

/**
 * Resolve a share link. Walks every team's index, which is fine at this scale
 * (one small JSON per team) and keeps share ids opaque: nothing about the URL
 * says which team it belongs to.
 *
 * @returns {Promise<{teamId: string, entry: object, round: object}|null>}
 */
export async function findByShareId(shareId) {
  const code = String(shareId || '');
  if (!code) return null;
  let teamIds;
  try {
    teamIds = await fsp.readdir(baseDir());
  } catch {
    return null;
  }
  for (const teamId of teamIds) {
    const rounds = await readIndex(teamId).catch(() => []);
    const entry = rounds.find((r) => r.shareId === code);
    if (!entry) continue;
    const round = await readRound(teamId, entry.id);
    if (!round) return null;
    return { teamId, entry, round };
  }
  return null;
}

/** Drop everything a team stored, used when a team goes away. */
export async function forgetTeam(teamId) {
  await fsp.rm(teamDir(teamId), { recursive: true, force: true }).catch(() => {});
}
