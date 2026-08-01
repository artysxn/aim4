// ---------------------------------------------------------------------------
// replays/teamsStore.js
// Teams, membership, invites, roles and per-map positions.
//
// One JSON file next to the replay library. A user may belong to many teams but
// own exactly one: ownership is what grants the invite link, the kick/ban list
// and the role table, so it has to be single-valued.
//
//   server/data/replays/teams.json
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './demoStore.js';

const FILE = () => path.join(ROOT, 'teams.json');

export const MAX_MEMBERS = 7;

/** How often the owner may mint a fresh invite code. */
export const INVITE_ROLL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Invite codes are 7 chars of mixed case, as in aim4.io/i/dNfrkEs. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function newInviteCode() {
  let out = '';
  for (let i = 0; i < 7; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

const newTeamId = () => `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** @returns {Promise<{teams: object[]}>} */
export async function readTeams() {
  try {
    const raw = await fsp.readFile(FILE(), 'utf8');
    const body = JSON.parse(raw);
    return { teams: Array.isArray(body?.teams) ? body.teams : [] };
  } catch {
    return { teams: [] };
  }
}

async function writeTeams(state) {
  await fsp.mkdir(ROOT, { recursive: true });
  await fsp.writeFile(FILE(), JSON.stringify(state, null, 2));
  return state;
}

const memberOf = (team, userId) => (team.members || []).find((m) => m.id === userId) || null;

/** A permission failure, so routes answer 403 rather than a generic 400. */
function denied(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

export const isMember = (team, userId) => Boolean(memberOf(team, userId));
export const isOwner = (team, userId) => team?.ownerId === userId;
export const isAdmin = (team, userId) =>
  isOwner(team, userId) || memberOf(team, userId)?.role === 'admin';

/** Placeholder roster slots used to plan positions before a real player joins. */
export function isDummyMember(m) {
  return Boolean(m?.dummy) || String(m?.id || '').startsWith('dummy_');
}

export function realMemberCount(team) {
  return (team?.members || []).filter((m) => !isDummyMember(m)).length;
}

const newDummyId = () =>
  `dummy_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function copyPositionBag(bag) {
  return {
    T: { ...(bag?.T || {}) },
    CT: { ...(bag?.CT || {}) }
  };
}

function clearMemberPositions(team, memberId) {
  if (team?.positions && memberId in team.positions) delete team.positions[memberId];
}

/** Every team the user belongs to, owned first. */
export async function teamsOf(userId) {
  if (!userId) return [];
  const { teams } = await readTeams();
  return teams
    .filter((t) => isMember(t, userId))
    .sort((a, b) => Number(isOwner(b, userId)) - Number(isOwner(a, userId)));
}

/** The one team a user owns, if any. */
export async function ownedTeam(userId) {
  const { teams } = await readTeams();
  return teams.find((t) => isOwner(t, userId)) || null;
}

/**
 * Everyone who shares a team with this user, including the user. This is the
 * set that "unlisted" demos and team playlists are visible to.
 */
export async function teammateIds(userId) {
  if (!userId) return new Set();
  const mine = await teamsOf(userId);
  const out = new Set([userId]);
  for (const team of mine) {
    for (const m of team.members || []) {
      // Placeholders are not accounts — they must not unlock unlisted demos.
      if (!isDummyMember(m)) out.add(m.id);
    }
  }
  return out;
}

export async function teamByInvite(code) {
  if (!code) return null;
  const { teams } = await readTeams();
  return teams.find((t) => t.invite === code) || null;
}

export async function teamById(id) {
  const { teams } = await readTeams();
  return teams.find((t) => t.id === id) || null;
}

/** Mutate one team in place and persist. */
async function updateTeam(id, mutate) {
  const state = await readTeams();
  const team = state.teams.find((t) => t.id === id);
  if (!team) throw new Error('That team no longer exists.');
  const result = mutate(team);
  await writeTeams(state);
  return result === undefined ? team : result;
}

/**
 * @param {{id: string, username: string}} user
 */
export async function createTeam(user, name) {
  const label = String(name || '').trim().slice(0, 40);
  if (!label) throw new Error('Give the team a name.');
  const state = await readTeams();
  if (state.teams.some((t) => isOwner(t, user.id))) {
    throw new Error('You already own a team. A user can only own one.');
  }
  const team = {
    id: newTeamId(),
    name: label,
    ownerId: user.id,
    ownerName: user.username,
    invite: newInviteCode(),
    createdAt: Date.now(),
    members: [
      { id: user.id, username: user.username, role: 'owner', kind: 'player', joinedAt: Date.now() }
    ],
    banned: [],
    /** userId -> { T: { MAP: position }, CT: { MAP: position } } */
    positions: {},
    documents: []
  };
  state.teams.push(team);
  await writeTeams(state);
  return team;
}

export async function joinTeam(user, code) {
  const team = await teamByInvite(code);
  if (!team) throw new Error('That invite link is not valid.');
  if ((team.banned || []).some((b) => b.id === user.id)) {
    throw denied('You cannot rejoin that team.');
  }
  if (isMember(team, user.id)) return team;
  if (realMemberCount(team) >= MAX_MEMBERS) {
    throw new Error(`That team is full (${MAX_MEMBERS} members).`);
  }
  return updateTeam(team.id, (t) => {
    t.members.push({
      id: user.id,
      username: user.username,
      role: 'player',
      kind: 'player',
      joinedAt: Date.now()
    });
  });
}

export async function leaveTeam(user, teamId) {
  return updateTeam(teamId, (t) => {
    if (isOwner(t, user.id)) throw new Error('Transfer ownership before leaving your own team.');
    t.members = (t.members || []).filter((m) => m.id !== user.id);
    clearMemberPositions(t, user.id);
  });
}

export async function removeMember(actor, teamId, memberId, { ban = false } = {}) {
  return updateTeam(teamId, (t) => {
    const gone = memberOf(t, memberId);
    if (!gone) throw new Error('That member is not on the team.');
    if (isDummyMember(gone)) {
      if (!isAdmin(t, actor.id)) throw denied('Only team admins can remove placeholders.');
    } else {
      if (!isOwner(t, actor.id)) throw denied('Only the team owner can remove members.');
      if (memberId === t.ownerId) throw new Error('The owner cannot be removed.');
    }
    t.members = (t.members || []).filter((m) => m.id !== memberId);
    clearMemberPositions(t, memberId);
    if (ban && !isDummyMember(gone)) {
      t.banned = [...(t.banned || []), { id: gone.id, username: gone.username, at: Date.now() }];
    }
  });
}

/**
 * Owner-only: add a placeholder seat so positions can be planned before the
 * real player joins. Placeholders do not count against the real-member cap.
 */
export async function createDummyMember(actor, teamId, displayName) {
  return updateTeam(teamId, (t) => {
    if (!isOwner(t, actor.id)) throw denied('Only the team owner can add placeholders.');
    const label = String(displayName || '')
      .trim()
      .replace(/^@+/, '')
      .slice(0, 32);
    if (!label) throw new Error('Give the placeholder a name.');
    const dummyCount = (t.members || []).filter((m) => isDummyMember(m)).length;
    if (dummyCount >= MAX_MEMBERS) {
      throw new Error(`A team can keep ${MAX_MEMBERS} placeholders.`);
    }
    const id = newDummyId();
    t.members = t.members || [];
    t.members.push({
      id,
      username: label,
      role: 'player',
      kind: 'player',
      joinedAt: Date.now(),
      dummy: true
    });
    t.positions = t.positions || {};
    t.positions[id] = { T: {}, CT: {} };
  });
}

/**
 * Admin: drag a real member onto a placeholder. The placeholder wins: its
 * kind, permissions (unless the real member is owner), and map positions
 * replace the real member's; then the placeholder seat is removed.
 */
export async function mergeMemberIntoDummy(actor, teamId, realUserId, dummyId) {
  return updateTeam(teamId, (t) => {
    if (!isAdmin(t, actor.id)) throw denied('Only team admins can merge placeholders.');
    const real = memberOf(t, realUserId);
    const dummy = memberOf(t, dummyId);
    if (!real) throw new Error('That member is not on the team.');
    if (isDummyMember(real)) throw new Error('Drag a real member onto a placeholder.');
    if (!dummy || !isDummyMember(dummy)) throw new Error('Drop onto a placeholder seat.');
    t.positions = t.positions || {};
    // Always take the placeholder's positions, even when empty.
    t.positions[realUserId] = copyPositionBag(t.positions[dummyId]);
    clearMemberPositions(t, dummyId);
    real.kind = dummy.kind === 'coach' ? 'coach' : 'player';
    if (real.role !== 'owner') {
      real.role = dummy.role === 'admin' ? 'admin' : 'player';
    }
    t.members = (t.members || []).filter((m) => m.id !== dummyId);
  });
}

export async function unbanMember(actor, teamId, memberId) {
  return updateTeam(teamId, (t) => {
    if (!isOwner(t, actor.id)) throw denied('Only the team owner can lift a ban.');
    t.banned = (t.banned || []).filter((b) => b.id !== memberId);
  });
}

/** Player vs coach, and who holds admin rights. */
export async function setMemberRole(actor, teamId, memberId, patch = {}) {
  return updateTeam(teamId, (t) => {
    if (!isAdmin(t, actor.id)) throw denied('Only team admins can change roles.');
    const m = memberOf(t, memberId);
    if (!m) throw new Error('That member is not on the team.');
    if (patch.kind === 'player' || patch.kind === 'coach') m.kind = patch.kind;
    if (patch.role === 'admin' || patch.role === 'player' || patch.role === 'coach') {
      if (!isOwner(t, actor.id)) throw denied('Only the owner can grant admin rights.');
      if (m.id === t.ownerId) throw new Error('The owner already has every right.');
      m.role = patch.role;
    }
  });
}

export async function transferOwnership(actor, teamId, memberId) {
  const state = await readTeams();
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) throw new Error('That team no longer exists.');
  if (!isOwner(team, actor.id)) throw denied('Only the owner can transfer a team.');
  const next = memberOf(team, memberId);
  if (!next) throw new Error('That member is not on the team.');
  if (isDummyMember(next)) throw new Error('Cannot transfer ownership to a placeholder.');
  if (state.teams.some((t) => t.id !== teamId && isOwner(t, memberId))) {
    throw new Error('That member already owns a team.');
  }
  const previous = memberOf(team, actor.id);
  team.ownerId = next.id;
  team.ownerName = next.username;
  next.role = 'owner';
  if (previous) previous.role = 'admin';
  await writeTeams(state);
  return team;
}

export async function rollInvite(actor, teamId) {
  return updateTeam(teamId, (t) => {
    if (!isOwner(t, actor.id)) throw denied('Only the owner can change the invite link.');
    const last = Number(t.inviteRolledAt) || 0;
    const wait = last + INVITE_ROLL_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      const hours = Math.ceil(wait / (60 * 60 * 1000));
      const err = new Error(
        hours <= 1
          ? 'You can mint a new invite link in under an hour.'
          : `You can mint a new invite link in about ${hours} hours.`
      );
      err.status = 429;
      throw err;
    }
    t.invite = newInviteCode();
    t.inviteRolledAt = Date.now();
  });
}

/**
 * Per-map position for one member, one side.
 * @param {'T'|'CT'} side
 */
export async function setPosition(actor, teamId, memberId, side, map, position) {
  return updateTeam(teamId, (t) => {
    if (!isAdmin(t, actor.id)) throw denied('Only team admins can set positions.');
    if (!memberOf(t, memberId)) throw new Error('That member is not on the team.');
    const key = side === 'CT' ? 'CT' : 'T';
    t.positions = t.positions || {};
    const bag = (t.positions[memberId] = t.positions[memberId] || { T: {}, CT: {} });
    bag[key] = bag[key] || {};
    if (position) bag[key][map] = String(position).slice(0, 24);
    else delete bag[key][map];
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const MAX_DOCUMENTS = 200;
export const DOC_MAX_BYTES = 400 * 1024;

const newDocId = () => `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Owner edits and deletes everything; a member owns what they wrote. */
export function canEditDocument(team, doc, userId) {
  if (!team || !doc) return false;
  return isOwner(team, userId) || doc.authorId === userId;
}

export async function listDocuments(teamId) {
  const team = await teamById(teamId);
  return (team?.documents || []).map((d) => ({ ...d }));
}

export async function upsertDocument(actor, teamId, patch = {}) {
  return updateTeam(teamId, (t) => {
    if (!isMember(t, actor.id)) throw denied('Only team members can write documents.');
    t.documents = t.documents || [];
    const id = String(patch.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    const existing = id ? t.documents.find((d) => d.id === id) : null;
    if (existing && !canEditDocument(t, existing, actor.id)) {
      throw denied('You can only edit your own documents.');
    }
    if (!existing && t.documents.length >= MAX_DOCUMENTS) {
      throw new Error(`A team can keep ${MAX_DOCUMENTS} documents.`);
    }
    const title = String(patch.title ?? existing?.title ?? 'Untitled').trim().slice(0, 120) || 'Untitled';
    const html = patch.html === undefined ? existing?.html || '' : String(patch.html);
    if (html.length > DOC_MAX_BYTES) throw new Error('That document is too large to save.');

    if (existing) {
      existing.title = title;
      existing.html = html;
      existing.updatedAt = Date.now();
      existing.updatedBy = actor.username;
      return existing;
    }
    const doc = {
      id: newDocId(),
      title,
      html,
      authorId: actor.id,
      authorName: actor.username,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: actor.username
    };
    t.documents.push(doc);
    return doc;
  });
}

export async function deleteDocument(actor, teamId, docId) {
  return updateTeam(teamId, (t) => {
    const doc = (t.documents || []).find((d) => d.id === docId);
    if (!doc) throw new Error('That document no longer exists.');
    if (!canEditDocument(t, doc, actor.id)) {
      throw denied('You can only delete your own documents.');
    }
    t.documents = t.documents.filter((d) => d.id !== docId);
  });
}

/** Shape sent to the client: no internal fields, invite only for the owner. */
export function publicTeam(team, viewerId) {
  if (!team) return null;
  const owner = isOwner(team, viewerId);
  const inviteRolledAt = Number(team.inviteRolledAt) || 0;
  const inviteRollReadyAt = inviteRolledAt ? inviteRolledAt + INVITE_ROLL_COOLDOWN_MS : 0;
  return {
    id: team.id,
    name: team.name,
    ownerId: team.ownerId,
    ownerName: team.ownerName,
    createdAt: team.createdAt,
    invite: owner ? team.invite : '',
    inviteRollReadyAt: owner ? inviteRollReadyAt : 0,
    members: (team.members || []).map((m) => ({
      id: m.id,
      username: m.username,
      role: m.role,
      kind: m.kind || 'player',
      joinedAt: m.joinedAt,
      dummy: isDummyMember(m)
    })),
    banned: owner ? team.banned || [] : [],
    positions: team.positions || {},
    documents: (team.documents || []).map((d) => ({
      id: d.id,
      title: d.title,
      authorId: d.authorId,
      authorName: d.authorName,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
      canEdit: canEditDocument(team, d, viewerId)
    })),
    isOwner: owner,
    isAdmin: isAdmin(team, viewerId),
    maxMembers: MAX_MEMBERS,
    realMembers: realMemberCount(team)
  };
}
