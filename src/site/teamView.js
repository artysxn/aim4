// ---------------------------------------------------------------------------
// site/teamView.js
// The TEAM shell: Overview, Documents, Roles & Positions, and the two pages
// that are still being built.
//
// One controller owns all five pages because they share the same roster fetch:
// switching between them re-renders, it does not re-load. Everything here is
// signed-in only, and the server rejects anything the account may not do, so
// the UI hides controls rather than enforcing rules.
// ---------------------------------------------------------------------------

import {
  createTeam,
  deleteTeamDocument,
  fetchDemos,
  fetchInvite,
  fetchStatus,
  fetchTeamDocument,
  fetchTeams,
  joinTeam,
  leaveTeam,
  rollTeamInvite,
  saveTeamDocument,
  setTeamPosition,
  teamMemberAction
} from '../replays/api.js';
import { MAPS } from '../replays/shared/roundId.js';
import { POSITION_MAPS, positionsFor } from '../replays/roles/teamPositions.js';
import { createDocsEditor } from './docsEditor.js';

const PAGES = ['team-overview', 'team-docs', 'team-roles', 'team-stratbook', 'team-strategies'];

function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

/**
 * @param {{auth: object, escapeHtml: (s: string) => string}} deps
 */
export function initTeamView({ auth, escapeHtml }) {
  const shellEl = document.getElementById('tm-shell');
  if (!shellEl) return { onShow() {}, onHide() {} };

  /** @type {object[]} */
  let teams = [];
  /** @type {object|null} */
  let team = null;
  let demos = [];
  let page = 'team-overview';
  let loadToken = 0;
  let loaded = false;
  let status = '';
  let statusBad = false;
  /** @type {ReturnType<typeof createDocsEditor>|null} */
  let editor = null;
  let openDocId = '';
  let rolesSide = 'T';
  let pendingInvite = '';
  /**
   * Who the backend says is calling. The client's own Supabase session is not
   * the authority here: if the backend cannot verify it, every team call would
   * fail, and a page full of dead controls is worse than an honest prompt.
   */
  let account = { signedIn: false, id: '', username: '', admin: false, verifies: true };
  /** Set on an /i/<code> landing so the page can name the team before sign-in. */
  let invitePreview = null;

  const signedIn = () => account.signedIn;
  const myId = () => account.id;

  function setStatus(text, bad = false) {
    status = text || '';
    statusBad = Boolean(bad);
    const el = shellEl.querySelector('#tm-status');
    if (el) {
      el.textContent = status;
      el.classList.toggle('bad', statusBad);
    }
  }

  async function run(fn, okText = '') {
    try {
      const result = await fn();
      if (okText) setStatus(okText);
      return result;
    } catch (err) {
      setStatus(err?.message || 'That did not work.', true);
      return null;
    }
  }

  // ---- data ---------------------------------------------------------------

  async function load() {
    const token = ++loadToken;
    const status = await fetchStatus().catch(() => null);
    if (token !== loadToken) return;
    account = { ...account, ...(status?.account || { signedIn: false }) };
    if (!signedIn()) {
      // An invite is readable signed out, so the visitor at least learns who
      // invited them and to what before being asked to sign in.
      invitePreview = pendingInvite
        ? (await fetchInvite(pendingInvite).catch(() => null))?.invite || null
        : null;
      teams = [];
      team = null;
      loaded = true;
      render();
      return;
    }
    const [teamList, demoList] = await Promise.all([
      fetchTeams().catch(() => []),
      fetchDemos()
        .then((r) => r.demos || [])
        .catch(() => [])
    ]);
    if (token !== loadToken) return;
    teams = teamList;
    // Keep the selected team across reloads when it still exists.
    team = teams.find((t) => t.id === team?.id) || teams[0] || null;
    demos = demoList.filter((d) => (d.status || 'ready') === 'ready');
    loaded = true;
    if (pendingInvite) {
      const code = pendingInvite;
      pendingInvite = '';
      await run(async () => {
        const res = await joinTeam(code);
        teams = res.teams || teams;
        team = teams.find((t) => t.id === res.team?.id) || team;
      }, 'You joined the team.');
    }
    render();
  }

  // ---- shared chrome ------------------------------------------------------

  function headerHtml(title, actions = '') {
    const picker =
      teams.length > 1
        ? `<select class="site-select tm-team-picker" data-team-picker>${teams
            .map(
              (t) =>
                `<option value="${escapeHtml(t.id)}"${t.id === team?.id ? ' selected' : ''}>${escapeHtml(
                  t.name
                )}${t.isOwner ? ' (owner)' : ''}</option>`
            )
            .join('')}</select>`
        : '';
    return `
      <div class="tm-head">
        <h2 class="tm-title">${escapeHtml(title)}</h2>
        <div class="tm-head-actions">${picker}${actions}</div>
      </div>
      <p class="tm-status${statusBad ? ' bad' : ''}" id="tm-status">${escapeHtml(status)}</p>`;
  }

  function signedOutHtml(what) {
    if (invitePreview) {
      return `<div class="tm-empty">
        <h2 class="tm-title">${escapeHtml(invitePreview.name)}</h2>
        <div class="tm-setup-card tm-invite-card">
          <h3>@${escapeHtml(invitePreview.ownerName)} invited you</h3>
          <p class="tm-note">${escapeHtml(
            `${invitePreview.members} of ${invitePreview.maxMembers} places taken.`
          )}</p>
          <p class="tm-note">Sign in and you join automatically.</p>
        </div>
      </div>`;
    }
    const sessionButNoServer = Boolean(auth?.isLoggedIn);
    const message = !sessionButNoServer
      ? 'Sign in to use your team pages.'
      : account.verifies === false
        ? 'The backend cannot verify sign-ins yet. Set SUPABASE_URL and SUPABASE_ANON_KEY on the server, then reload.'
        : 'Your session did not reach the backend. Reload the page, and sign in again if that does not help.';
    return `<div class="tm-empty">
      <h2 class="tm-title">${escapeHtml(what)}</h2>
      <p class="view-empty">${escapeHtml(message)}</p>
    </div>`;
  }

  function noTeamHtml() {
    return `
      ${headerHtml('Team')}
      <div class="tm-setup">
        <div class="tm-setup-card">
          <h3>Create a team</h3>
          <p class="tm-note">You can own one team. Invite up to ${escapeHtml(String(7))} members with a link.</p>
          <div class="tm-row">
            <input class="site-input" id="tm-new-name" type="text" maxlength="40" placeholder="Team name" />
            <button type="button" class="btn primary" data-create>Create</button>
          </div>
        </div>
        <div class="tm-setup-card">
          <h3>Join with an invite</h3>
          <p class="tm-note">Paste the code or the whole aim4.io/i/ link.</p>
          <div class="tm-row">
            <input class="site-input" id="tm-join-code" type="text" maxlength="80" placeholder="dNfrkEs" />
            <button type="button" class="btn" data-join>Join</button>
          </div>
        </div>
      </div>`;
  }

  // ---- overview -----------------------------------------------------------

  function memberRowHtml(m) {
    const me = m.id === myId();
    const canManage = team.isOwner && !me;
    const roleLabel = m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member';
    return `
      <li class="tm-member${me ? ' me' : ''}">
        <span class="tm-member-name">@${escapeHtml(m.username)}${me ? ' (you)' : ''}</span>
        <span class="tm-tag ${m.kind === 'coach' ? 'coach' : 'player'}">${
          m.kind === 'coach' ? 'Coach' : 'Player'
        }</span>
        <span class="tm-tag role">${escapeHtml(roleLabel)}</span>
        <span class="tm-member-when">${escapeHtml(formatWhen(m.joinedAt))}</span>
        ${
          canManage
            ? `<span class="tm-member-actions">
                <button type="button" class="btn btn-sm" data-kick="${escapeHtml(m.id)}">Kick</button>
                <button type="button" class="btn btn-sm danger" data-ban="${escapeHtml(m.id)}">Ban</button>
              </span>`
            : ''
        }
      </li>`;
  }

  function demoRowHtml(d) {
    const owner = d.owner || {};
    const visibility = owner.visibility || 'public';
    const mapName = d.mapName || MAPS[d.map]?.name || d.map || '';
    return `
      <li class="tm-demo">
        <span class="tm-demo-when">${escapeHtml(formatWhen(d.uploadedAt || d.parsedAt))}</span>
        <span class="tm-demo-teams">${escapeHtml(d.team1?.name || 'Team 1')} vs ${escapeHtml(
          d.team2?.name || 'Team 2'
        )}</span>
        <span class="tm-demo-map">${escapeHtml(mapName)}</span>
        <span class="rp-by ${visibility}">by @${escapeHtml(owner.username || 'artysan')}</span>
      </li>`;
  }

  function overviewHtml() {
    const members = team.members || [];
    const banned = team.banned || [];
    return `
      ${headerHtml(team.name, team.isOwner ? '<button type="button" class="btn btn-sm" data-roll>New invite link</button>' : '')}
      <div class="tm-grid">
        <section class="tm-card">
          <h3 class="tm-card-title">Members <span class="tm-count">${members.length} / ${
            team.maxMembers || 7
          }</span></h3>
          <ul class="tm-members">${members.map(memberRowHtml).join('')}</ul>
          ${
            team.isOwner
              ? `<div class="tm-invite">
                  <label class="tm-note" for="tm-invite-url">Invite link</label>
                  <div class="tm-row">
                    <input class="site-input" id="tm-invite-url" readonly value="${escapeHtml(
                      inviteUrl()
                    )}" />
                    <button type="button" class="btn btn-sm" data-copy>Copy</button>
                  </div>
                </div>`
              : '<p class="tm-note">Only the team owner can share the invite link.</p>'
          }
          ${
            banned.length
              ? `<div class="tm-banned">
                  <h4 class="tm-sub">Banned</h4>
                  <ul class="tm-members">${banned
                    .map(
                      (b) =>
                        `<li class="tm-member"><span class="tm-member-name">@${escapeHtml(
                          b.username
                        )}</span><span class="tm-member-actions"><button type="button" class="btn btn-sm" data-unban="${escapeHtml(
                          b.id
                        )}">Lift ban</button></span></li>`
                    )
                    .join('')}</ul>
                </div>`
              : ''
          }
          ${
            team.isOwner
              ? ''
              : '<div class="tm-row tm-leave"><button type="button" class="btn btn-sm danger" data-leave>Leave team</button></div>'
          }
        </section>

        <section class="tm-card">
          <h3 class="tm-card-title">Demos you can see <span class="tm-count">${demos.length}</span></h3>
          ${
            demos.length
              ? `<ul class="tm-demos">${demos.slice(0, 200).map(demoRowHtml).join('')}</ul>`
              : '<p class="view-empty">No demos are shared with you yet.</p>'
          }
        </section>
      </div>`;
  }

  function inviteUrl() {
    return `${window.location.origin}/i/${team?.invite || ''}`;
  }

  // ---- documents ----------------------------------------------------------

  function documentsHtml() {
    const docs = [...(team.documents || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const open = docs.find((d) => d.id === openDocId);
    return `
      ${headerHtml('Documents', '<button type="button" class="btn btn-sm primary" data-new-doc>New document</button>')}
      <div class="tm-docs">
        <aside class="tm-doc-list">
          ${
            docs.length
              ? docs
                  .map(
                    (d) => `
              <div class="tm-doc-item${d.id === openDocId ? ' active' : ''}" data-open-doc="${escapeHtml(d.id)}">
                <span class="tm-doc-name">${escapeHtml(d.title)}</span>
                <span class="tm-doc-meta">@${escapeHtml(d.authorName || '')} · ${escapeHtml(
                  formatWhen(d.updatedAt)
                )}</span>
                ${
                  d.canEdit
                    ? `<button type="button" class="rp-btn-icon danger tm-doc-del" data-del-doc="${escapeHtml(
                        d.id
                      )}" title="Delete">×</button>`
                    : ''
                }
              </div>`
                  )
                  .join('')
              : '<p class="view-empty">No documents yet.</p>'
          }
        </aside>
        <div class="tm-doc-main" id="tm-doc-main">
          ${
            open
              ? `<div class="tm-doc-head">
                  <input class="site-input tm-doc-title" id="tm-doc-title" value="${escapeHtml(
                    open.title
                  )}" ${open.canEdit ? '' : 'readonly'} maxlength="120" />
                  <span class="tm-note">Last edit by @${escapeHtml(open.updatedBy || open.authorName || '')}</span>
                </div>
                <div id="tm-doc-editor"></div>`
              : '<p class="view-empty">Pick a document, or start a new one.</p>'
          }
        </div>
      </div>`;
  }

  async function mountEditor() {
    const host = shellEl.querySelector('#tm-doc-editor');
    if (!host || !openDocId) return;
    const doc = await fetchTeamDocument(team.id, openDocId).catch(() => null);
    if (!doc) return;
    const meta = (team.documents || []).find((d) => d.id === openDocId);
    editor?.destroy();
    editor = createDocsEditor({
      escapeHtml,
      onSave: async (html) => {
        if (!meta?.canEdit) throw new Error('You can only edit your own documents.');
        const res = await saveTeamDocument(team.id, { id: openDocId, html });
        if (res?.team) {
          team = res.team;
          teams = teams.map((t) => (t.id === team.id ? team : t));
        }
      }
    });
    host.appendChild(editor.el);
    editor.load({ html: doc.html });
    if (!meta?.canEdit) {
      editor.el.querySelector('#doc-surface')?.setAttribute('contenteditable', 'false');
      editor.el.querySelector('#doc-toolbar')?.setAttribute('hidden', 'hidden');
    }
  }

  // ---- roles & positions --------------------------------------------------

  function rolesHtml() {
    const members = team.members || [];
    const canEdit = team.isAdmin;
    const positions = team.positions || {};

    const rosterRows = members
      .map((m) => {
        const owner = m.role === 'owner';
        return `
        <tr>
          <td class="tm-cell-name">@${escapeHtml(m.username)}</td>
          <td>
            ${
              canEdit && !owner
                ? `<select class="site-select" data-kind="${escapeHtml(m.id)}">
                    <option value="player"${m.kind !== 'coach' ? ' selected' : ''}>Player</option>
                    <option value="coach"${m.kind === 'coach' ? ' selected' : ''}>Coach</option>
                  </select>`
                : m.kind === 'coach'
                  ? 'Coach'
                  : 'Player'
            }
          </td>
          <td>
            ${
              team.isOwner && !owner
                ? `<select class="site-select" data-role="${escapeHtml(m.id)}">
                    <option value="player"${m.role === 'player' ? ' selected' : ''}>Member</option>
                    <option value="admin"${m.role === 'admin' ? ' selected' : ''}>Admin</option>
                  </select>`
                : owner
                  ? 'Owner'
                  : m.role === 'admin'
                    ? 'Admin'
                    : 'Member'
            }
          </td>
          <td>
            ${
              team.isOwner && !owner
                ? `<button type="button" class="btn btn-sm" data-transfer="${escapeHtml(
                    m.id
                  )}">Make owner</button>`
                : ''
            }
          </td>
        </tr>`;
      })
      .join('');

    const positionRows = members
      .map((m) => {
        const bag = positions[m.id]?.[rolesSide] || {};
        const cells = POSITION_MAPS.map((map) => {
          const value = bag[map.code] || '';
          const options = positionsFor(rolesSide, map.code)
            .map(
              (pos) =>
                `<option value="${escapeHtml(pos)}"${pos === value ? ' selected' : ''}>${escapeHtml(
                  pos
                )}</option>`
            )
            .join('');
          return `<td>${
            canEdit
              ? `<select class="site-select tm-pos" data-pos="${escapeHtml(m.id)}|${escapeHtml(
                  map.code
                )}"><option value="">-</option>${options}</select>`
              : escapeHtml(value || '-')
          }</td>`;
        }).join('');
        return `<tr><td class="tm-cell-name">@${escapeHtml(m.username)}</td>${cells}</tr>`;
      })
      .join('');

    return `
      ${headerHtml('Roles & Positions')}
      <section class="tm-card">
        <h3 class="tm-card-title">Roster</h3>
        <table class="tm-table">
          <thead><tr><th>Member</th><th>Kind</th><th>Permissions</th><th></th></tr></thead>
          <tbody>${rosterRows}</tbody>
        </table>
        ${canEdit ? '' : '<p class="tm-note">Only team admins can change this.</p>'}
      </section>

      <section class="tm-card">
        <div class="tm-card-head">
          <h3 class="tm-card-title">Positions</h3>
          <div class="rp-chips">
            <button type="button" class="rp-chip${rolesSide === 'T' ? ' active' : ''}" data-side="T">T side</button>
            <button type="button" class="rp-chip${rolesSide === 'CT' ? ' active' : ''}" data-side="CT">CT side</button>
          </div>
        </div>
        <div class="tm-table-scroll">
          <table class="tm-table tm-pos-table ${rolesSide === 'CT' ? 'ct' : 't'}">
            <thead>
              <tr><th>${rolesSide} side</th>${POSITION_MAPS.map(
                (m) => `<th>${escapeHtml(m.name)}</th>`
              ).join('')}</tr>
            </thead>
            <tbody>${positionRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  function wipHtml(title) {
    return `
      ${headerHtml(title)}
      <div class="tm-wip"><p>Work in progress...</p></div>`;
  }

  // ---- render -------------------------------------------------------------

  function render() {
    if (!loaded) {
      shellEl.innerHTML = '<p class="view-empty">Loading…</p>';
      return;
    }
    if (!signedIn()) {
      shellEl.innerHTML = signedOutHtml(titleFor(page));
      return;
    }
    if (!team) {
      shellEl.innerHTML = noTeamHtml();
      return;
    }
    if (page === 'team-docs') {
      shellEl.innerHTML = documentsHtml();
      mountEditor();
      return;
    }
    if (page === 'team-roles') {
      shellEl.innerHTML = rolesHtml();
      return;
    }
    if (page === 'team-stratbook') {
      shellEl.innerHTML = wipHtml('Stratbook Editor');
      return;
    }
    if (page === 'team-strategies') {
      shellEl.innerHTML = wipHtml('My Strategies');
      return;
    }
    shellEl.innerHTML = overviewHtml();
  }

  function titleFor(name) {
    return (
      {
        'team-overview': 'Team',
        'team-docs': 'Documents',
        'team-roles': 'Roles & Positions',
        'team-stratbook': 'Stratbook Editor',
        'team-strategies': 'My Strategies'
      }[name] || 'Team'
    );
  }

  // ---- events -------------------------------------------------------------

  shellEl.addEventListener('click', async (e) => {
    const t = e.target;

    if (t.closest('[data-create]')) {
      const name = shellEl.querySelector('#tm-new-name')?.value || '';
      const list = await run(() => createTeam(name), 'Team created.');
      if (list) {
        teams = list;
        team = teams[0] || null;
        render();
      }
      return;
    }
    if (t.closest('[data-join]')) {
      const raw = shellEl.querySelector('#tm-join-code')?.value || '';
      const code = raw.trim().split('/').filter(Boolean).pop() || '';
      const res = await run(() => joinTeam(code), 'You joined the team.');
      if (res) {
        teams = res.teams || [];
        team = teams.find((x) => x.id === res.team?.id) || teams[0] || null;
        await load();
      }
      return;
    }
    if (t.closest('[data-roll]')) {
      const res = await run(() => rollTeamInvite(team.id), 'New invite link created.');
      if (res?.team) {
        team = res.team;
        render();
      }
      return;
    }
    if (t.closest('[data-copy]')) {
      const field = shellEl.querySelector('#tm-invite-url');
      if (field) {
        field.select();
        try {
          await navigator.clipboard.writeText(field.value);
          setStatus('Invite link copied.');
        } catch {
          setStatus('Copy the link from the field.', true);
        }
      }
      return;
    }
    if (t.closest('[data-leave]')) {
      if (!window.confirm(`Leave ${team.name}?`)) return;
      const res = await run(() => leaveTeam(team.id), 'You left the team.');
      if (res) {
        teams = res.teams || [];
        team = teams[0] || null;
        render();
      }
      return;
    }

    const kick = t.closest('[data-kick]');
    const ban = t.closest('[data-ban]');
    const unban = t.closest('[data-unban]');
    const transfer = t.closest('[data-transfer]');
    if (kick || ban || unban || transfer) {
      const id = (kick || ban || unban || transfer).dataset[
        kick ? 'kick' : ban ? 'ban' : unban ? 'unban' : 'transfer'
      ];
      const action = kick ? 'kick' : ban ? 'ban' : unban ? 'unban' : 'transfer';
      if (action === 'ban' && !window.confirm('Ban that member? They cannot rejoin.')) return;
      if (action === 'transfer' && !window.confirm('Hand the team over to that member?')) return;
      const res = await run(() => teamMemberAction(team.id, id, action), 'Done.');
      if (res?.team) {
        team = res.team;
        teams = res.teams || teams;
        render();
      }
      return;
    }

    const side = t.closest('[data-side]');
    if (side) {
      rolesSide = side.dataset.side === 'CT' ? 'CT' : 'T';
      render();
      return;
    }

    // ---- documents --------------------------------------------------------
    if (t.closest('[data-new-doc]')) {
      const res = await run(
        () => saveTeamDocument(team.id, { title: 'Untitled', html: '' }),
        'Document created.'
      );
      if (res?.document) {
        team = res.team || team;
        teams = teams.map((x) => (x.id === team.id ? team : x));
        openDocId = res.document.id;
        render();
      }
      return;
    }
    const delDoc = t.closest('[data-del-doc]');
    if (delDoc) {
      e.stopPropagation();
      const id = delDoc.dataset.delDoc;
      if (!window.confirm('Delete that document?')) return;
      const res = await run(() => deleteTeamDocument(team.id, id), 'Document deleted.');
      if (res) {
        team = res.team || team;
        teams = teams.map((x) => (x.id === team.id ? team : x));
        if (openDocId === id) openDocId = '';
        render();
      }
      return;
    }
    const openDoc = t.closest('[data-open-doc]');
    if (openDoc) {
      await editor?.flush();
      openDocId = openDoc.dataset.openDoc;
      render();
    }
  });

  shellEl.addEventListener('change', async (e) => {
    const t = e.target;

    const picker = t.closest('[data-team-picker]');
    if (picker) {
      team = teams.find((x) => x.id === picker.value) || team;
      openDocId = '';
      render();
      return;
    }

    const kind = t.closest('[data-kind]');
    if (kind) {
      const res = await run(
        () => teamMemberAction(team.id, kind.dataset.kind, 'role', { kind: kind.value }),
        'Saved.'
      );
      if (res?.team) {
        team = res.team;
        render();
      }
      return;
    }

    const role = t.closest('[data-role]');
    if (role) {
      const res = await run(
        () => teamMemberAction(team.id, role.dataset.role, 'role', { role: role.value }),
        'Saved.'
      );
      if (res?.team) {
        team = res.team;
        render();
      }
      return;
    }

    const pos = t.closest('[data-pos]');
    if (pos) {
      const [memberId, map] = pos.dataset.pos.split('|');
      const res = await run(
        () => setTeamPosition(team.id, memberId, rolesSide, map, pos.value),
        'Position saved.'
      );
      if (res?.team) {
        team = res.team;
        teams = teams.map((x) => (x.id === team.id ? team : x));
      }
      return;
    }

    const title = t.closest('#tm-doc-title');
    if (title && openDocId) {
      const res = await run(
        () => saveTeamDocument(team.id, { id: openDocId, title: title.value }),
        'Renamed.'
      );
      if (res?.team) {
        team = res.team;
        teams = teams.map((x) => (x.id === team.id ? team : x));
      }
    }
  });

  auth?.onChange?.(() => {
    loaded = false;
    load();
  });

  return {
    /** @param {{page?: string, invite?: string}} params */
    onShow(params = {}) {
      page = PAGES.includes(params.page) ? params.page : 'team-overview';
      if (params.invite) pendingInvite = params.invite;
      // Re-check whenever the last answer was "signed out": a session that
      // landed while another page was open must not leave this one stuck on
      // the sign-in prompt.
      if (!loaded || params.invite || !signedIn()) load();
      else render();
    },
    onHide() {
      editor?.flush();
    },
    /** Called by the router for /i/<code> landings. */
    setInvite(code) {
      pendingInvite = code;
    }
  };
}
