// ---------------------------------------------------------------------------
// replays/teamRoutes.js
// /api/teams/* — roster, invites, roles, positions, documents and stratbook.
//
// Every route here needs a verified account: teams are the thing demo privacy
// hangs off, so an anonymous caller has nothing to do in this file.
// ---------------------------------------------------------------------------

import { whoami } from './identity.js';
import { guardImpersonation } from '../admin/guard.js';
import { DRAWING_BOARD_CAP } from '../../shared/entitlements/catalogue.js';
import { CAP } from '../../shared/entitlements/keys.js';
import {
  UpgradeRequiredError,
  capability,
  requireCapability,
  requireLimit,
  upgradeResponse
} from '../entitlements/enforce.js';
import {
  deleteRound as deleteStrategyRound,
  findByShareId,
  listRounds,
  readRound,
  saveRound
} from './strategyReplays.js';
import { buildAutocoachSummary } from './autocoachSummary.js';
import {
  createDummyMember,
  createTeam,
  deleteDocument,
  deleteStrategy,
  joinTeam,
  leaveTeam,
  listDocuments,
  autocoachDemosOf,
  markAutocoachDemo,
  mergeMemberIntoDummy,
  publicTeam,
  realMemberCount,
  removeMember,
  rollInvite,
  seatCapacityOf,
  setMemberRole,
  teamIsFull,
  setPosition,
  teamById,
  teamByInvite,
  teamsOf,
  transferOwnership,
  unbanMember,
  upsertDocument,
  upsertStrategy
} from './teamsStore.js';
import {
  deleteDrawingBoard,
  getDrawingBoard,
  getUtilityArchive,
  listDrawingBoards,
  listUtilityIndex,
  saveDrawingBoard,
  saveUtilityArchive
} from './teamBoards.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Aim4-Filename, X-Aim4-Visibility',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

/** Teams the caller is on, in the client's shape. */
async function myTeams(me) {
  const teams = await teamsOf(me.id);
  return teams.map((t) => publicTeam(t, me.id));
}

/**
 * @returns {Promise<boolean>} true when this request was a team route.
 */
export async function handleTeamRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/teams')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  const me = await whoami(req);

  // A read-only "view as" session may look at a team but never edit it.
  const blocked = guardImpersonation(req, url, me);
  if (blocked) {
    json(res, blocked.status, blocked.body);
    return true;
  }

  // Invite previews are readable signed out so the landing page can name the
  // team before asking the visitor to sign in.
  const previewMatch = p.match(/^\/api\/teams\/invite\/([A-Za-z0-9]{4,16})$/);
  if (req.method === 'GET' && previewMatch) {
    const team = await teamByInvite(previewMatch[1]);
    if (!team) {
      json(res, 404, { error: 'That invite link is not valid.' });
      return true;
    }
    json(res, 200, {
      invite: {
        code: previewMatch[1],
        name: team.name,
        ownerName: team.ownerName,
        members: (team.members || []).length,
        maxMembers: seatCapacityOf(team),
        full: teamIsFull(team),
        banned: (team.banned || []).some((b) => b.id === me.id),
        alreadyIn: (team.members || []).some((m) => m.id === me.id && !String(m.id).startsWith('dummy_'))
      },
      signedIn: me.signedIn
    });
    return true;
  }

  // A shared 2D round opens for anyone holding the link, signed in or not —
  // that is the whole point of the share id. It exposes one round and says
  // nothing about the team's other work.
  const shareMatch = p.match(/^\/api\/teams\/shared2d\/([A-Za-z0-9_-]{6,32})$/);
  if (req.method === 'GET' && shareMatch) {
    const hit = await findByShareId(shareMatch[1]);
    if (!hit) {
      json(res, 404, { error: 'That strategy link is not valid.' });
      return true;
    }
    json(res, 200, {
      entry: { ...hit.entry, teamId: undefined },
      round: hit.round,
      shared: true
    });
    return true;
  }

  if (!me.signedIn) {
    json(res, 401, { error: 'Sign in to use teams.' });
    return true;
  }

  /**
   * Entitlement refusals leave here as 402 with the documented body, so the
   * client can render the shared upgrade prompt. Everything else stays a 400.
   */
  const fail = (err) => {
    const refusal = upgradeResponse(err);
    if (refusal) {
      json(res, refusal.status, refusal.body);
      return;
    }
    json(res, err?.status || 400, { error: err?.message || 'That did not work.' });
  };

  // ---- my teams -----------------------------------------------------------
  if (p === '/api/teams') {
    if (req.method === 'GET') {
      json(res, 200, { teams: await myTeams(me) });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson(req);
        // Free and Premium may not create teams at all; Team Premium may create
        // one and Elite two, counted against teams already owned.
        const owned = (await teamsOf(me.id)).filter((t) => t.ownerId === me.id).length;
        requireLimit(me, CAP.TEAM_CREATE_LIMIT, owned);
        await createTeam(me, body.name);
        json(res, 200, { teams: await myTeams(me) });
      } catch (err) {
        fail(err);
      }
      return true;
    }
  }

  if (req.method === 'POST' && p === '/api/teams/join') {
    try {
      const body = await readJson(req);
      await requireCapability(me, CAP.TEAM_JOIN);
      const team = await joinTeam(me, String(body.code || '').trim());
      json(res, 200, { team: publicTeam(team, me.id), teams: await myTeams(me) });
    } catch (err) {
      fail(err);
    }
    return true;
  }

  const teamMatch = p.match(/^\/api\/teams\/([A-Za-z0-9_]+)((?:\/[A-Za-z0-9_-]+)*)$/);
  if (!teamMatch) {
    json(res, 404, { error: 'Not found' });
    return true;
  }
  const teamId = teamMatch[1];
  const tail = (teamMatch[2] || '').replace(/\/$/, '');
  const team = await teamById(teamId);
  if (!team) {
    json(res, 404, { error: 'That team no longer exists.' });
    return true;
  }
  const onTeam = (team.members || []).some((m) => m.id === me.id);
  if (!onTeam) {
    json(res, 403, { error: 'You are not on that team.' });
    return true;
  }

  const ok = async (result) =>
    json(res, 200, {
      team: publicTeam(result || (await teamById(teamId)), me.id),
      teams: await myTeams(me)
    });

  try {
    if (req.method === 'GET' && !tail) {
      await ok(team);
      return true;
    }

    if (req.method === 'POST' && tail === '/invite') {
      await ok(await rollInvite(me, teamId));
      return true;
    }

    if (req.method === 'POST' && tail === '/leave') {
      await leaveTeam(me, teamId);
      json(res, 200, { teams: await myTeams(me) });
      return true;
    }

    if (req.method === 'POST' && tail === '/members') {
      const body = await readJson(req);
      const action = String(body.action || '');
      if (action === 'kick' || action === 'ban') {
        await removeMember(me, teamId, body.memberId, { ban: action === 'ban' });
      } else if (action === 'unban') {
        await unbanMember(me, teamId, body.memberId);
      } else if (action === 'role') {
        await setMemberRole(me, teamId, body.memberId, {
          role: body.role,
          kind: body.kind
        });
      } else if (action === 'transfer') {
        await transferOwnership(me, teamId, body.memberId);
      } else if (action === 'createDummy') {
        await createDummyMember(me, teamId, body.name || body.username);
      } else if (action === 'merge') {
        await mergeMemberIntoDummy(me, teamId, body.memberId, body.dummyId);
      } else {
        json(res, 400, { error: 'Unknown member action.' });
        return true;
      }
      await ok();
      return true;
    }

    if (req.method === 'POST' && tail === '/positions') {
      const body = await readJson(req);
      await requireCapability(me, CAP.TEAM_ROLES_POSITIONS);
      await setPosition(me, teamId, body.memberId, body.side, body.map, body.position);
      await ok();
      return true;
    }

    // ---- documents --------------------------------------------------------
    if (tail === '/documents') {
      if (req.method === 'GET') {
        json(res, 200, { documents: await listDocuments(teamId) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const existing = await listDocuments(teamId);
        // An edit of a document that already exists is not a new one, so the
        // cap only applies to creating.
        if (!body.id || !existing.some((d) => d.id === body.id)) {
          requireLimit(me, CAP.TEAM_DOCUMENTS, existing.length);
        }
        const doc = await upsertDocument(me, teamId, body);
        json(res, 200, { document: doc, team: publicTeam(await teamById(teamId), me.id) });
        return true;
      }
    }

    const docMatch = p.match(/^\/api\/teams\/[A-Za-z0-9_]+\/documents\/([A-Za-z0-9_-]+)$/);
    if (docMatch) {
      const docId = docMatch[1];
      if (req.method === 'GET') {
        const docs = await listDocuments(teamId);
        const doc = docs.find((d) => d.id === docId);
        if (!doc) {
          json(res, 404, { error: 'That document no longer exists.' });
          return true;
        }
        json(res, 200, { document: doc });
        return true;
      }
      if (req.method === 'DELETE') {
        await deleteDocument(me, teamId, docId);
        json(res, 200, { ok: true, team: publicTeam(await teamById(teamId), me.id) });
        return true;
      }
    }

    // ---- synthetic 2D rounds ----------------------------------------------
    if (tail === '/replays2d') {
      if (req.method === 'GET') {
        json(res, 200, { rounds: await listRounds(teamId) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 12 * 1024 * 1024);
        const rounds = await listRounds(teamId);
        // Capped per map, not per team.
        const map = String(body.map || body.mapCode || '').toLowerCase();
        if (!body.id || !rounds.some((r) => r.id === body.id)) {
          const onMap = rounds.filter((r) => String(r.map || '').toLowerCase() === map).length;
          requireLimit(me, CAP.TEAM_STRATEGY_CREATOR_2D, onMap);
        }
        const entry = await saveRound(me, teamId, body);
        json(res, 200, { entry, rounds: await listRounds(teamId) });
        return true;
      }
    }

    const roundMatch = p.match(/^\/api\/teams\/[A-Za-z0-9_]+\/replays2d\/([A-Za-z0-9_-]+)$/);
    if (roundMatch) {
      const roundId = roundMatch[1];
      if (req.method === 'GET') {
        const round = await readRound(teamId, roundId);
        if (!round) {
          json(res, 404, { error: 'That round no longer exists.' });
          return true;
        }
        const entry = (await listRounds(teamId)).find((r) => r.id === roundId) || null;
        json(res, 200, { entry, round });
        return true;
      }
      if (req.method === 'DELETE') {
        await deleteStrategyRound(me, teamId, roundId);
        json(res, 200, { ok: true, rounds: await listRounds(teamId) });
        return true;
      }
    }

    // ---- stratbook --------------------------------------------------------
    if (req.method === 'POST' && tail === '/stratbook') {
      const body = await readJson(req);
      await requireCapability(me, CAP.TEAM_STRATBOOK_ACCESS);
      const book = team.stratbook || [];
      const map = String(body.map || '').toLowerCase();
      if (!body.id || !book.some((s) => s.id === body.id)) {
        const onMap = book.filter((s) => String(s.map || '').toLowerCase() === map).length;
        requireLimit(me, CAP.TEAM_STRATBOOK_LIMIT, onMap);
      }
      const strategy = await upsertStrategy(me, teamId, body);
      json(res, 200, { strategy, team: publicTeam(await teamById(teamId), me.id) });
      return true;
    }

    const stratMatch = p.match(/^\/api\/teams\/[A-Za-z0-9_]+\/stratbook\/([A-Za-z0-9_-]+)$/);
    if (stratMatch && req.method === 'DELETE') {
      await deleteStrategy(me, teamId, stratMatch[1]);
      json(res, 200, { ok: true, team: publicTeam(await teamById(teamId), me.id) });
      return true;
    }

    // ---- drawing boards ---------------------------------------------------
    const boardOne = p.match(
      /^\/api\/teams\/[A-Za-z0-9_]+\/drawing-boards\/([A-Za-z0-9]{2,4})\/([A-Za-z0-9_-]{4,40})$/i
    );
    if (boardOne) {
      const map = boardOne[1];
      const boardId = boardOne[2];
      if (req.method === 'GET') {
        json(res, 200, { board: await getDrawingBoard(me, teamId, map, boardId) });
        return true;
      }
      if (req.method === 'DELETE') {
        json(res, 200, await deleteDrawingBoard(me, teamId, map, boardId));
        return true;
      }
    }
    const boardMatch = p.match(
      /^\/api\/teams\/[A-Za-z0-9_]+\/drawing-boards\/([A-Za-z0-9]{2,4})$/i
    );
    if (boardMatch) {
      const map = boardMatch[1];
      if (req.method === 'GET') {
        json(res, 200, { boards: await listDrawingBoards(me, teamId, map) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 2 * 1024 * 1024);
        // Access to the board is nearly free; persistence is the gate. Premium
        // resolves to 'nosave', which is exactly this refusal.
        await requireCapability(me, CAP.DRAWING_BOARD, { atLeast: 'limited' });
        const boards = await listDrawingBoards(me, teamId, map);
        if (capability(me, CAP.DRAWING_BOARD) === 'limited') {
          const existing = boards.find((b) => b.id === body.id);
          if (!existing && boards.length >= DRAWING_BOARD_CAP) {
            throw new UpgradeRequiredError({
              capability: CAP.DRAWING_BOARD,
              message: `Drawing board: you are at your limit of ${DRAWING_BOARD_CAP} on this map. More is available on Team Elite.`,
              currentTier: me.entitlements?.tier || 'free',
              requiredTier: 'team_elite',
              limit: { current: boards.length, limit: DRAWING_BOARD_CAP }
            });
          }
        }
        json(res, 200, { board: await saveDrawingBoard(me, teamId, map, body) });
        return true;
      }
    }

    // ---- autocoach --------------------------------------------------------
    if (req.method === 'GET' && tail === '/autocoach') {
      await requireCapability(me, CAP.DEMOS_AUTO_COACH, { consume: false });
      const summary = await buildAutocoachSummary(await teamById(teamId));
      json(res, 200, {
        ...summary,
        team: publicTeam(await teamById(teamId), me.id)
      });
      return true;
    }
    const coachDemoMatch = p.match(
      /^\/api\/teams\/[A-Za-z0-9_]+\/autocoach\/demos\/([A-Za-z0-9_-]+)$/
    );
    if (coachDemoMatch && req.method === 'POST') {
      await requireCapability(me, CAP.DEMOS_AUTO_COACH, { consume: false });
      const body = await readJson(req);
      await markAutocoachDemo(me, teamId, coachDemoMatch[1], body.side);
      const next = await teamById(teamId);
      json(res, 200, {
        team: publicTeam(next, me.id),
        demos: autocoachDemosOf(next)
      });
      return true;
    }

    // ---- utility archive --------------------------------------------------
    if (req.method === 'GET' && tail === '/utility') {
      json(res, 200, { index: await listUtilityIndex(me, teamId) });
      return true;
    }
    const utilMatch = p.match(/^\/api\/teams\/[A-Za-z0-9_]+\/utility\/([A-Za-z0-9]{2,4})$/i);
    if (utilMatch) {
      const map = utilMatch[1];
      if (req.method === 'GET') {
        json(res, 200, { archive: await getUtilityArchive(me, teamId, map) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 2 * 1024 * 1024);
        const current = await getUtilityArchive(me, teamId, map);
        const held = Array.isArray(current?.entries) ? current.entries.length : 0;
        const incoming = Array.isArray(body?.entries) ? body.entries.length : held;
        // The archive is saved whole, so the cap is checked against what the
        // save would leave behind rather than against a single new entry.
        if (incoming > held) requireLimit(me, CAP.TEAM_UTILITY_ARCHIVE, incoming - 1);
        json(res, 200, { archive: await saveUtilityArchive(me, teamId, map, body) });
        return true;
      }
    }
  } catch (err) {
    fail(err);
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
