// ---------------------------------------------------------------------------
// replays/teamsStore.js
// Teams, membership, invites, roles, per-map positions, documents and stratbook.
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

/**
 * Seats a team has when nothing says otherwise: an unconfigured backend, a team
 * created before tiers existed, or an owner whose entitlements have not been
 * recomputed yet. Matches the old flat cap, so behaviour is unchanged until a
 * capacity is actually written.
 */
export const DEFAULT_MAX_MEMBERS = 7;

/** -1, matching the catalogue's spelling of unlimited. */
export const UNLIMITED_MEMBERS = -1;

/**
 * Seat capacity is a property of the owner's *subscription*, not of the team:
 * Team Elite's 14 seats are pooled across the 2 teams it may create, so
 * counting members of one team is the wrong question. The resolved number is
 * denormalised onto the team record by recomputeUser(), the same way
 * profiles.effective_capabilities is, because publicTeam() is synchronous and
 * called from a dozen places that have no business awaiting an entitlement
 * lookup.
 */
export function seatCapacityOf(team) {
  const stored = Number(team?.seatCapacity);
  if (Number.isFinite(stored) && (stored > 0 || stored === UNLIMITED_MEMBERS)) return stored;
  return DEFAULT_MAX_MEMBERS;
}

export function teamIsFull(team) {
  const capacity = seatCapacityOf(team);
  if (capacity === UNLIMITED_MEMBERS) return false;
  return realMemberCount(team) >= capacity;
}

/** Called by the entitlements recompute whenever an owner's plan changes. */
export async function setTeamSeatCapacity(teamId, capacity) {
  const value = Number(capacity);
  if (!Number.isFinite(value)) return null;
  return updateTeam(teamId, (t) => {
    t.seatCapacity = value;
  });
}

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
    documents: [],
    stratbook: [],
    /** demoId -> { side: 1|2, analyzedAt, analyzedBy } — Autocoach pass registry */
    autocoach: { demos: {} }
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
  if (teamIsFull(team)) {
    throw new Error(`That team is full (${seatCapacityOf(team)} members).`);
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
    // Placeholders consume no seat, but a team that can field 14 players should
    // be able to plan for 14, so the ceiling tracks capacity rather than 7.
    const capacity = seatCapacityOf(t);
    const dummyCount = (t.members || []).filter((m) => isDummyMember(m)).length;
    if (capacity !== UNLIMITED_MEMBERS && dummyCount >= capacity) {
      throw new Error(`A team can keep ${capacity} placeholders.`);
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

// ---------------------------------------------------------------------------
// Stratbook
// ---------------------------------------------------------------------------

export const MAX_STRATEGIES = 400;

export const STRAT_ECONOMY = [
  'Pistol',
  'Full buy',
  'Full buy + AWP',
  'Antiforce',
  'Force',
  'Eco'
];

export const STRAT_CATEGORY_T = [
  'Pistol',
  'Set call',
  'Default',
  'Opener',
  'Midround',
  'Lateround',
  'Cheap exec'
];

export const STRAT_CATEGORY_CT = [
  'Pistol',
  'Set call',
  'Default',
  'Opener',
  'Midround',
  'Setup',
  'Retake'
];

const STRAT_MAPS = new Set(['ANC', 'DD2', 'MIR', 'NUK', 'INF', 'OVP', 'ANU', 'CCH']);

const newStratId = () => `sb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function sanitizeUrl(value) {
  const raw = String(value || '').trim().slice(0, 2000);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

function normalizeRoleNotes(raw) {
  const src = Array.isArray(raw) ? raw : [];
  return [0, 1, 2, 3, 4].map((i) => String(src[i] ?? '').slice(0, 800));
}

function normalizeVisibleTo(raw, team) {
  const ids = new Set((team.members || []).map((m) => m.id));
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((id) => String(id)).filter((id) => ids.has(id)))];
}

function publicStrategy(s) {
  return {
    id: s.id,
    map: s.map,
    side: s.side,
    economy: s.economy,
    category: s.category,
    name: s.name || '',
    description: s.description || '',
    link3d: s.link3d || '',
    link2d: s.link2d || '',
    roleNotes: normalizeRoleNotes(s.roleNotes),
    visibleAll: Boolean(s.visibleAll),
    visibleTo: Array.isArray(s.visibleTo) ? [...s.visibleTo] : [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy || ''
  };
}

/** Admin upsert for one strategy row in the Stratbook Editor. */
export async function upsertStrategy(actor, teamId, patch = {}) {
  return updateTeam(teamId, (t) => {
    if (!isAdmin(t, actor.id)) throw denied('Only team admins can edit the stratbook.');
    t.stratbook = t.stratbook || [];
    const id = String(patch.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    const existing = id ? t.stratbook.find((s) => s.id === id) : null;

    const side = (patch.side ?? existing?.side) === 'CT' ? 'CT' : 'T';
    const map = String(patch.map ?? existing?.map ?? '').toUpperCase();
    if (!STRAT_MAPS.has(map)) throw new Error('Unknown map.');

    const economyOpts = STRAT_ECONOMY;
    const categoryOpts = side === 'CT' ? STRAT_CATEGORY_CT : STRAT_CATEGORY_T;
    const economy = String(patch.economy ?? existing?.economy ?? economyOpts[0]);
    const category = String(patch.category ?? existing?.category ?? categoryOpts[0]);
    if (!economyOpts.includes(economy)) throw new Error('Unknown economy.');
    if (!categoryOpts.includes(category)) throw new Error('Unknown category.');

    const next = {
      id: existing?.id || newStratId(),
      map,
      side,
      economy,
      category,
      name: String(patch.name ?? existing?.name ?? '')
        .trim()
        .slice(0, 120),
      description: String(patch.description ?? existing?.description ?? '')
        .trim()
        .slice(0, 500),
      link3d:
        patch.link3d === undefined ? existing?.link3d || '' : sanitizeUrl(patch.link3d),
      link2d:
        patch.link2d === undefined ? existing?.link2d || '' : sanitizeUrl(patch.link2d),
      roleNotes:
        patch.roleNotes === undefined
          ? normalizeRoleNotes(existing?.roleNotes)
          : normalizeRoleNotes(patch.roleNotes),
      visibleAll:
        patch.visibleAll === undefined ? Boolean(existing?.visibleAll) : Boolean(patch.visibleAll),
      visibleTo:
        patch.visibleTo === undefined
          ? normalizeVisibleTo(existing?.visibleTo, t)
          : normalizeVisibleTo(patch.visibleTo, t),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      updatedBy: actor.username
    };

    if (existing) {
      Object.assign(existing, next);
      return publicStrategy(existing);
    }
    if (t.stratbook.length >= MAX_STRATEGIES) {
      throw new Error(`A team can keep ${MAX_STRATEGIES} strategies.`);
    }
    t.stratbook.push(next);
    return publicStrategy(next);
  });
}

export async function deleteStrategy(actor, teamId, strategyId) {
  return updateTeam(teamId, (t) => {
    if (!isAdmin(t, actor.id)) throw denied('Only team admins can edit the stratbook.');
    const id = String(strategyId || '');
    const before = (t.stratbook || []).length;
    t.stratbook = (t.stratbook || []).filter((s) => s.id !== id);
    if (t.stratbook.length === before) throw new Error('That strategy no longer exists.');
  });
}

/** Mark a demo as Autocoach-analyzed for this team (idempotent until reset). */
export async function markAutocoachDemo(actor, teamId, demoId, side) {
  return updateTeam(teamId, (t) => {
    if (!isMember(t, actor.id)) throw denied('You are not on that team.');
    const id = String(demoId || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) throw new Error('Missing demo id.');
    const seat = side === 2 ? 2 : 1;
    t.autocoach = t.autocoach && typeof t.autocoach === 'object' ? t.autocoach : { demos: {} };
    t.autocoach.demos = t.autocoach.demos || {};
    if (t.autocoach.demos[id]) return; // already locked — do not overwrite
    t.autocoach.demos[id] = {
      side: seat,
      analyzedAt: Date.now(),
      analyzedBy: actor.id
    };
  });
}

/**
 * Drop Autocoach registry entries so demos can be analyzed again.
 * @param {string[]|'all'} demoIds
 */
export async function unmarkAutocoachDemos(actor, teamId, demoIds) {
  return updateTeam(teamId, (t) => {
    if (!isMember(t, actor.id)) throw denied('You are not on that team.');
    t.autocoach = t.autocoach && typeof t.autocoach === 'object' ? t.autocoach : { demos: {} };
    t.autocoach.demos = t.autocoach.demos || {};
    if (demoIds === 'all') {
      t.autocoach.demos = {};
      return;
    }
    const ids = (Array.isArray(demoIds) ? demoIds : [])
      .map((id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, ''))
      .filter(Boolean);
    for (const id of ids) delete t.autocoach.demos[id];
  });
}

export function autocoachDemosOf(team) {
  const bag = team?.autocoach?.demos;
  return bag && typeof bag === 'object' ? bag : {};
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
    stratbook: (team.stratbook || []).map(publicStrategy),
    autocoach: { demos: autocoachDemosOf(team) },
    isOwner: owner,
    isAdmin: isAdmin(team, viewerId),
    maxMembers: seatCapacityOf(team),
    realMembers: realMemberCount(team)
  };
}
