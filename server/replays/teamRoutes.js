// ---------------------------------------------------------------------------
// replays/teamRoutes.js
// /api/teams/* — roster, invites, roles, positions, documents and stratbook.
//
// Every route here needs a verified account: teams are the thing demo privacy
// hangs off, so an anonymous caller has nothing to do in this file.
// ---------------------------------------------------------------------------

import { whoami } from './identity.js';
import {
  deleteRound as deleteStrategyRound,
  findByShareId,
  listRounds,
  readRound,
  saveRound
} from './strategyReplays.js';
import {
  createDummyMember,
  deleteDocument,
  deleteStrategy,
  joinTeam,
  leaveTeam,
  listDocuments,
  mergeMemberIntoDummy,
  publicTeam,
  realMemberCount,
  removeMember,
  rollInvite,
  setMemberRole,
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
  getDrawingBoard,
  getUtilityArchive,
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
        maxMembers: 7,
        full: realMemberCount(team) >= 7,
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

  const fail = (err) =>
    json(res, err?.status || 400, { error: err?.message || 'That did not work.' });

  // ---- my teams -----------------------------------------------------------
  if (p === '/api/teams') {
    if (req.method === 'GET') {
      json(res, 200, { teams: await myTeams(me) });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson(req);
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
    const boardMatch = p.match(
      /^\/api\/teams\/[A-Za-z0-9_]+\/drawing-boards\/([A-Za-z0-9]{2,4})$/i
    );
    if (boardMatch) {
      const map = boardMatch[1];
      if (req.method === 'GET') {
        json(res, 200, { board: await getDrawingBoard(me, teamId, map) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 2 * 1024 * 1024);
        json(res, 200, { board: await saveDrawingBoard(me, teamId, map, body) });
        return true;
      }
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
