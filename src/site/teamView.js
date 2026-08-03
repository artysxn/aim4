// ---------------------------------------------------------------------------
// site/teamView.js
// The TEAM shell: Overview, Documents, Roles & Positions, Stratbook Editor,
// and My Strategies.
//
// One controller owns all five pages because they share the same roster fetch:
// switching between them re-renders, it does not re-load. Everything here is
// signed-in only, and the server rejects anything the account may not do, so
// the UI hides controls rather than enforcing rules.
// ---------------------------------------------------------------------------

import {
  createTeam,
  createTeamDummy,
  deleteDemo,
  deleteTeamDocument,
  deleteTeamStrategy,
  fetchDemo,
  fetchDemos,
  fetchInvite,
  fetchStats,
  fetchStatus,
  fetchTeamDocument,
  fetchTeams,
  fetchUtilityIndex,
  joinTeam,
  leaveTeam,
  mergeTeamMember,
  rollTeamInvite,
  saveTeamDocument,
  saveTeamStrategy,
  setTeamPosition,
  teamMemberAction
} from '../replays/api.js';
import { getEntitlements } from '../lib/entitlements.js';
import { CAP } from '../../shared/entitlements/keys.js';
import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';
import { MAPS } from '../replays/shared/roundId.js';
import { teamNameKey } from '../replays/shared/statsMath.js';
import { createStatsPanel } from '../replays/stats/statsPanel.js';
import { POSITION_MAPS, positionsFor } from '../replays/roles/teamPositions.js';
import { createDocsEditor } from './docsEditor.js';
import { mountDrawingBoard } from './drawingBoard.js';
import { mountUtilityArchive } from './utilityArchive.js';
import { spinnerHtml } from '../lib/spinner.js';

const PAGES = [
  'team-overview',
  'team-docs',
  'team-roles',
  'team-stratbook',
  'team-strategies',
  'team-drawing-board',
  'team-utility-archive'
];

const STRAT_ECONOMY = [
  'Pistol',
  'Full buy',
  'Full buy + AWP',
  'Antiforce',
  'Force',
  'Eco'
];
const STRAT_CATEGORY_T = [
  'Pistol',
  'Set call',
  'Default',
  'Opener',
  'Midround',
  'Lateround',
  'Cheap exec'
];
const STRAT_CATEGORY_CT = [
  'Pistol',
  'Set call',
  'Default',
  'Opener',
  'Midround',
  'Setup',
  'Retake'
];

const SB_COLOR_DEFAULTS = {
  'econ-pistol': '#7a7a7a',
  'econ-full-buy': '#3db8b0',
  'econ-full-buy-awp': '#2a9d96',
  'econ-antiforce': '#8b8fd4',
  'econ-force': '#d4a05a',
  'econ-eco': '#5a5a5a',
  'cat-pistol': '#7a7a7a',
  'cat-set-call': '#3f8f4a',
  'cat-default': '#2a5c45',
  'cat-opener': '#b56a3a',
  'cat-midround': '#7a4ea8',
  'cat-lateround': '#8a3a5c',
  'cat-cheap-exec': '#a87830',
  'cat-setup': '#3a6f8f',
  'cat-retake': '#8f3a4a'
};

const SB_ECON_COLOR_LABELS = STRAT_ECONOMY;
const SB_CAT_COLOR_LABELS = [
  ...new Set([...STRAT_CATEGORY_T, ...STRAT_CATEGORY_CT])
];

function stratToneSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function econToneKey(value) {
  return `econ-${stratToneSlug(value)}`;
}

function catToneKey(value) {
  return `cat-${stratToneSlug(value)}`;
}

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

  const ents = getEntitlements(auth);

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
  /** @type {{ destroy: () => void }|null} */
  let boardMount = null;
  let boardMountKey = '';
  /** @type {ReturnType<typeof createStatsPanel>|null} */
  let overviewStatsPanel = null;
  let overviewStatsKey = '';
  let overviewMapsKey = '';
  /** Selected map code on Overview, or '' for all. */
  let overviewMapFilter = '';
  /** @type {Array<{code: string, name: string, matches: number, wins: number, losses: number, roundWinrate: number|null, prw: number|null}>} */
  let overviewMaps = [];
  let overviewMapsLoading = false;
  let overviewMapsToken = 0;
  /** Lazy-loaded timeline viewer module. */
  let viewerModule = null;
  let openDocId = '';
  let rolesSide = 'T';
  /** @type {Array<{id: string, map: string, type: string, name: string, throws: object[]}>} */
  let utilityIndex = [];
  let utilityIndexTeamId = '';
  let loadInFlight = false;
  let demosLoaded = false;
  /** Which stratbook "Visible to" menu is open (strategy id). */
  let openVisibleMenu = '';
  /** Member whose My Strategies view is shown. */
  let strategiesPlayerId = '';
  const SB_ZOOM_KEY = 'aim4.stratbookZoom';
  const SB_ZOOM_STEPS = [50, 75, 100, 125, 150, 175, 200];
  let stratbookZoom = 100;
  try {
    const saved = Number(localStorage.getItem(SB_ZOOM_KEY));
    if (SB_ZOOM_STEPS.includes(saved)) stratbookZoom = saved;
  } catch {
    /* ignore */
  }
  const SB_VIEW_KEY = 'aim4.stratbookView';
  /** @type {'compact'|'full'} */
  let stratbookView = 'compact';
  try {
    const savedView = localStorage.getItem(SB_VIEW_KEY);
    if (savedView === 'compact' || savedView === 'full') stratbookView = savedView;
  } catch {
    /* ignore */
  }
  const SB_COLORS_KEY = 'aim4.stratbookColors';
  /** @type {Record<string, string>} */
  let stratbookColors = { ...SB_COLOR_DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(SB_COLORS_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) && k in SB_COLOR_DEFAULTS) {
          stratbookColors[k] = v;
        }
      }
    }
  } catch {
    /* ignore */
  }
  let stratbookSettingsOpen = false;
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
    // Success toasts are hidden; surface failures so actions aren't silent.
    if (bad && text) window.alert(text);
  }

  async function run(fn, _okText = '') {
    try {
      return await fn();
    } catch (err) {
      setStatus(err?.message || 'That did not work.', true);
      return null;
    }
  }

  // ---- data ---------------------------------------------------------------

  async function ensureDemos() {
    if (!signedIn() || demosLoaded) return;
    demosLoaded = true;
    try {
      const r = await fetchDemos();
      demos = (r.demos || []).filter((d) => (d.status || 'ready') === 'ready');
    } catch {
      demos = [];
      demosLoaded = false;
    }
    if (page === 'team-overview') render();
  }

  async function load() {
    if (loadInFlight) return;
    loadInFlight = true;
    const token = ++loadToken;
    try {
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
        demos = [];
        demosLoaded = false;
        loaded = true;
        render();
        return;
      }
      // Teams only here — the full demo library is heavy and only needed on Overview.
      const teamList = await fetchTeams().catch(() => []);
      if (token !== loadToken) return;
      teams = teamList;
      // Keep the selected team across reloads when it still exists.
      team = teams.find((t) => t.id === team?.id) || teams[0] || null;
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
      if (page === 'team-overview') void ensureDemos();
    } finally {
      if (token === loadToken) loadInFlight = false;
    }
  }

  // ---- shared chrome ------------------------------------------------------

  function destroyBoardMount() {
    boardMount?.destroy?.();
    boardMount = null;
    boardMountKey = '';
  }

  function mountBoardPage(kind) {
    const key = `${kind}:${team.id}`;
    if (boardMount && boardMountKey === key) return;
    destroyBoardMount();
    boardMountKey = key;
    const deps = { host: shellEl, teamId: team.id, escapeHtml, headerHtml };
    boardMount =
      kind === 'drawing' ? mountDrawingBoard(deps) : mountUtilityArchive(deps);
  }

  async function ensureUtilityIndex(force = false) {
    if (!team?.id) {
      utilityIndex = [];
      utilityIndexTeamId = '';
      return;
    }
    if (!force && utilityIndexTeamId === team.id) return;
    try {
      utilityIndex = await fetchUtilityIndex(team.id);
      utilityIndexTeamId = team.id;
    } catch {
      utilityIndex = [];
      utilityIndexTeamId = team.id;
    }
  }

  /** Escape note text, then turn `&lt;!####&gt;` into copyable utility links. */
  function noteWithUtilityLinks(raw) {
    return escapeHtml(raw || '').replace(
      /&lt;!([A-Za-z0-9]{4})&gt;/g,
      (_m, id) =>
        `<button type="button" class="ua-link" data-ua-link="${id}" title="Copy setpos / setang">&lt;!${id}&gt;</button>`
    );
  }

  async function copyUtilityById(id) {
    await ensureUtilityIndex();
    const entry = utilityIndex.find((g) => g.id === id);
    if (!entry) {
      setStatus(`No utility with id ${id} in the archive.`, true);
      return;
    }
    const throws = Array.isArray(entry.throws) ? entry.throws : [];
    if (!throws.length) {
      setStatus(`${id} has no throw spots yet.`, true);
      return;
    }
    let th = throws[0];
    if (throws.length > 1) {
      const lines = throws
        .map((t, i) => `${i + 1}. ${(t.comment || t.setpos || 'Throw').slice(0, 60)}`)
        .join('\n');
      const pick = window.prompt(`Pick a throw spot for ${id}:\n${lines}`, '1');
      if (pick == null) return;
      const idx = Math.max(1, Math.min(throws.length, Number(pick) || 1)) - 1;
      th = throws[idx];
    }
    const text = [th.setpos, th.setang].filter(Boolean).join('\n');
    if (!text) {
      setStatus('That throw has no setpos / setang yet.', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(th.comment ? `Copied. ${th.comment}` : `Copied ${id}.`);
    } catch {
      setStatus('Could not copy to clipboard.', true);
    }
  }

  function headerHtml(title = '', actions = '') {
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
    if (!title && !picker && !actions) return '';
    return `
      <div class="tm-head">
        ${title ? `<h2 class="tm-title">${escapeHtml(title)}</h2>` : ''}
        <div class="tm-head-actions">${picker}${actions}</div>
      </div>`;
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
    const canCreate = ents.can(CAP.TEAM_CREATE_LIMIT);
    const canJoin = ents.can(CAP.TEAM_JOIN);
    const createTier = PLAN_NAMES[ents.requiredPlan(CAP.TEAM_CREATE_LIMIT)] || 'Team Premium';
    const joinTier = PLAN_NAMES[ents.requiredPlan(CAP.TEAM_JOIN)] || 'Premium';
    return `
      ${headerHtml('Team')}
      <div class="tm-setup">
        <div class="tm-setup-card">
          <h3>Create a team</h3>
          <p class="tm-note">${
            canCreate
              ? `You can own a team. Invite members with a link.`
              : `Creating a team is available on ${escapeHtml(createTier)}.`
          }</p>
          <div class="tm-row">
            <input class="site-input" id="tm-new-name" type="text" maxlength="40" placeholder="Team name"${
              canCreate ? '' : ' disabled'
            } />
            <button type="button" class="btn primary" data-create${canCreate ? '' : ' disabled'}>Create</button>
          </div>
        </div>
        <div class="tm-setup-card">
          <h3>Join with an invite</h3>
          <p class="tm-note">${
            canJoin
              ? `Paste the code or the whole aim4.io/i/ link.`
              : `Joining a team is available on ${escapeHtml(joinTier)}.`
          }</p>
          <div class="tm-row">
            <input class="site-input" id="tm-join-code" type="text" maxlength="80" placeholder="dNfrkEs"${
              canJoin ? '' : ' disabled'
            } />
            <button type="button" class="btn" data-join${canJoin ? '' : ' disabled'}>Join</button>
          </div>
        </div>
      </div>`;
  }

  // ---- overview -----------------------------------------------------------

  function memberLabel(m) {
    if (m.dummy) return escapeHtml(m.username);
    return `@${escapeHtml(m.username)}`;
  }

  function memberRowHtml(m) {
    const me = !m.dummy && m.id === myId();
    const dummy = Boolean(m.dummy);
    const canMerge = team.isAdmin;
    const canManageReal = team.isOwner && !me && !dummy;
    const canRemoveDummy = dummy && team.isAdmin;
    // Member only — never Player, Admin, Coach, Owner, or Placeholder pills.
    const rolePill =
      !dummy && m.role === 'player' ? '<span class="tm-tag role">Member</span>' : '';
    const dragAttrs =
      canMerge && !dummy
        ? `draggable="true" data-drag-member="${escapeHtml(m.id)}"`
        : dummy && canMerge
          ? `data-drop-dummy="${escapeHtml(m.id)}"`
          : '';
    const actions = canManageReal
      ? `<span class="tm-member-actions">
            <button type="button" class="btn btn-sm" data-kick="${escapeHtml(m.id)}">Kick</button>
            <button type="button" class="btn btn-sm danger" data-ban="${escapeHtml(m.id)}">Ban</button>
          </span>`
      : canRemoveDummy
        ? `<span class="tm-member-actions">
            <button type="button" class="btn btn-sm danger" data-kick="${escapeHtml(
              m.id
            )}" title="Remove placeholder">Remove</button>
          </span>`
        : '<span class="tm-member-actions" aria-hidden="true"></span>';
    return `
      <li class="tm-member${me ? ' me' : ''}${dummy ? ' is-dummy' : ''}" ${dragAttrs}>
        <span class="tm-member-name">${memberLabel(m)}${me ? ' (you)' : ''}</span>
        ${rolePill}
        ${actions}
      </li>`;
  }

  function demoRowHtml(d) {
    const want = teamNameKey(team?.name || '');
    const a = teamNameKey(d.team1?.name);
    const enemy =
      a === want ? d.team2?.name || 'Team 2' : d.team1?.name || 'Team 1';
    const mapName = d.mapName || MAPS[d.map]?.name || d.map || '—';
    const id = escapeHtml(d.id);
    const canDelete =
      Boolean(account.admin) ||
      (Boolean(account.id) && (d.owner?.id || '') === account.id);
    return `
      <tr class="tm-replay-row" data-demo-id="${id}">
        <td class="tm-replay-enemy">${escapeHtml(enemy)}</td>
        <td class="tm-replay-map">${escapeHtml(mapName)}</td>
        <td class="tm-replay-actions">
          <button type="button" class="rp-btn-icon" data-tm-demo-stats="${id}" title="Stats">
            <svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M640-160v-280h120v280H640Zm-220 0v-640h120v640H420Zm-220 0v-440h120v440H200Z"/></svg>
          </button>
          ${
            canDelete
              ? `<button type="button" class="rp-btn-icon danger" data-tm-demo-delete="${id}" title="Delete">×</button>`
              : ''
          }
          <button type="button" class="rp-btn-play" data-tm-demo-replay="${id}" title="Replay">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7L8 5z"/></svg>
          </button>
        </td>
      </tr>`;
  }

  /** Demos where either side's display name matches the current team. */
  function demosForTeam() {
    const want = teamNameKey(team?.name || '');
    if (!want) return [];
    return demos.filter((d) => {
      const a = teamNameKey(d.team1?.name);
      const b = teamNameKey(d.team2?.name);
      return a === want || b === want;
    });
  }

  function visibleTeamDemos() {
    const list = demosForTeam();
    if (!overviewMapFilter) return list;
    return list.filter((d) => String(d.map || '').toUpperCase() === overviewMapFilter);
  }

  function demoWhen(d) {
    return Number(d.uploadedAt || d.parsedAt || 0) || 0;
  }

  function pct1(n) {
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
  }

  function emptyMapStats() {
    return POSITION_MAPS.map((m) => ({
      code: m.code,
      name: m.name,
      matches: 0,
      wins: 0,
      losses: 0,
      roundWinrate: null,
      prw: null
    }));
  }

  function mapsBodyHtml() {
    if (overviewMapsLoading && !overviewMaps.length) {
      return `<div class="is-loading" role="status" aria-live="polite">${spinnerHtml()}</div>`;
    }
    const rows = overviewMaps.length ? overviewMaps : emptyMapStats();
    return `<ul class="tm-maps-list">${rows
      .map((m) => {
        const active = overviewMapFilter === m.code ? ' is-active' : '';
        const record =
          m.matches > 0 ? `${m.wins}–${m.losses}` : '—';
        return `
      <li class="tm-map-row${active}" data-tm-map="${escapeHtml(m.code)}" role="button" tabindex="0">
        <span class="tm-map-name">${escapeHtml(m.name)}</span>
        <span class="tm-map-wl" title="Map wins–losses">${escapeHtml(record)}</span>
        <span class="tm-map-rwr" title="Round winrate">${escapeHtml(pct1(m.roundWinrate))}</span>
        <span class="tm-map-prw" title="Predicted round winrate">${escapeHtml(pct1(m.prw))}</span>
      </li>`;
      })
      .join('')}</ul>`;
  }

  function replaysBodyHtml() {
    const list = visibleTeamDemos();
    if (!list.length) {
      return overviewMapFilter
        ? `<p class="view-empty">No replays on ${escapeHtml(
            MAPS[overviewMapFilter]?.name || overviewMapFilter
          )}.</p>`
        : `<p class="view-empty">No replays with this team name yet.</p>`;
    }
    return `<div class="tm-replays-scroll">
      <table class="tm-replays-table">
        <thead>
          <tr><th>Enemy</th><th>Map</th><th></th></tr>
        </thead>
        <tbody>${list
          .slice()
          .sort((a, b) => demoWhen(b) - demoWhen(a))
          .slice(0, 200)
          .map(demoRowHtml)
          .join('')}</tbody>
      </table>
    </div>`;
  }

  function paintOverviewMaps() {
    const el = document.getElementById('tm-overview-maps');
    if (el) el.innerHTML = mapsBodyHtml();
  }

  function paintOverviewReplays() {
    const el = document.getElementById('tm-overview-replays');
    if (el) el.innerHTML = replaysBodyHtml();
  }

  function destroyOverviewStats() {
    if (overviewStatsPanel) {
      overviewStatsPanel.destroy();
      overviewStatsPanel = null;
    }
    overviewStatsKey = '';
    overviewMapsKey = '';
    overviewMapFilter = '';
    overviewMaps = [];
    overviewMapsLoading = false;
    overviewMapsToken++;
  }

  /**
   * Per-map W/L, round winrate, and predicted round winrate for our team name.
   */
  async function refreshOverviewMaps(teamDemos) {
    const token = ++overviewMapsToken;
    const ids = teamDemos.map((d) => d.id).filter(Boolean);
    overviewMapsLoading = true;
    paintOverviewMaps();
    if (!ids.length) {
      overviewMaps = emptyMapStats();
      overviewMapsLoading = false;
      paintOverviewMaps();
      return;
    }
    try {
      const payload = await fetchStats(ids);
      if (token !== overviewMapsToken) return;
      const want = teamNameKey(team?.name || '');
      /** @type {Map<string, {matches: number, wins: number, losses: number, rounds: number, won: number, prwSum: number, prwN: number}>} */
      const acc = new Map();
      for (const m of POSITION_MAPS) {
        acc.set(m.code, {
          matches: 0,
          wins: 0,
          losses: 0,
          rounds: 0,
          won: 0,
          prwSum: 0,
          prwN: 0
        });
      }
      for (const d of payload.demos || []) {
        const code = String(d.map || '').toUpperCase();
        if (!acc.has(code)) continue;
        const side =
          teamNameKey(d.name1) === want ? 1 : teamNameKey(d.name2) === want ? 2 : 0;
        if (!side) continue;
        const s = acc.get(code);
        s.matches += 1;
        if (d.winner === side) s.wins += 1;
        else if (d.winner === 1 || d.winner === 2) s.losses += 1;
        for (const row of d.rounds || []) {
          s.rounds += 1;
          if (row.w === side) s.won += 1;
          const prw = side === 1 ? row.prw1 : row.prw2;
          if (Number.isFinite(prw)) {
            s.prwSum += prw;
            s.prwN += 1;
          }
        }
      }
      overviewMaps = POSITION_MAPS.map((m) => {
        const s = acc.get(m.code);
        return {
          code: m.code,
          name: m.name,
          matches: s.matches,
          wins: s.wins,
          losses: s.losses,
          roundWinrate: s.rounds ? (s.won / s.rounds) * 100 : null,
          prw: s.prwN ? s.prwSum / s.prwN : null
        };
      }).sort(
        (a, b) =>
          b.matches - a.matches || a.name.localeCompare(b.name)
      );
    } catch {
      if (token !== overviewMapsToken) return;
      overviewMaps = emptyMapStats();
    }
    overviewMapsLoading = false;
    paintOverviewMaps();
  }

  function applyOverviewMapToStats() {
    if (!overviewStatsPanel?.applyView) return;
    overviewStatsPanel.applyView({
      tab: 'teams',
      maps: overviewMapFilter || []
    });
  }

  function selectOverviewMap(code) {
    const next = overviewMapFilter === code ? '' : code;
    overviewMapFilter = next;
    paintOverviewMaps();
    paintOverviewReplays();
    // Single-demo stats leave the middle panel scoped to one match; a map pick
    // should return to the full team library with that map filter.
    if (String(overviewStatsKey).startsWith('single:')) {
      overviewStatsKey = '';
      mountOverviewExtras();
      return;
    }
    applyOverviewMapToStats();
  }

  async function openTeamDemoStats(id) {
    const d = demos.find((x) => x.id === id);
    if (!overviewStatsPanel) return;
    overviewMapFilter = '';
    paintOverviewMaps();
    paintOverviewReplays();
    await overviewStatsPanel.load({
      demos: [id],
      title: d
        ? `${d.team1?.name || 'Team 1'} vs ${d.team2?.name || 'Team 2'}`
        : '',
      teamName: team?.name || '',
      tab: 'teams'
    });
    overviewStatsKey = `single:${id}`;
  }

  async function openTeamDemoReplay(id) {
    let demo = demos.find((d) => d.id === id);
    if (!demo) {
      try {
        demo = (await fetchDemo(id))?.demo || null;
      } catch {
        demo = null;
      }
    }
    if (!demo) {
      setStatus('Could not open that replay.', true);
      return;
    }
    const list = (demo.rounds || []).map((r) => ({
      ...r,
      map: demo.map,
      tickRate: r.tickRate || demo.tickRate
    }));
    if (!list.length) {
      setStatus('That replay has no rounds yet.', true);
      return;
    }
    if (!viewerModule) {
      viewerModule = await import('../replays/viewer/viewerApp.js');
    }
    viewerModule.openViewer({
      rounds: list,
      mode: 'timeline',
      title: `${demo.team1?.name || 'Team 1'} vs ${demo.team2?.name || 'Team 2'}`,
      escapeHtml,
      statsDemoId: demo.id
    });
  }

  async function deleteTeamDemo(id) {
    const d = demos.find((x) => x.id === id);
    const label = d
      ? `${d.team1?.name || 'Team 1'} vs ${d.team2?.name || 'Team 2'}`
      : 'this replay';
    if (!window.confirm(`Delete ${label}?`)) return;
    const res = await run(() => deleteDemo(id), '');
    if (!res) return;
    demos = demos.filter((x) => x.id !== id);
    overviewStatsKey = '';
    overviewMapsKey = '';
    mountOverviewExtras();
    paintOverviewReplays();
  }

  function mountOverviewExtras() {
    const teamDemos = demosForTeam();
    const mount = document.getElementById('tm-overview-stats');
    if (mount) {
      const ids = teamDemos.map((d) => d.id).filter(Boolean);
      const key = `${team.id}|${teamNameKey(team.name)}|${ids.join(',')}`;
      if (!overviewStatsPanel) overviewStatsPanel = createStatsPanel({ escapeHtml });
      if (overviewStatsPanel.el.parentElement !== mount) {
        mount.replaceChildren(overviewStatsPanel.el);
      }
      if (overviewStatsKey !== key) {
        overviewStatsKey = key;
        if (!ids.length) {
          const filtersEl = overviewStatsPanel.el.querySelector('#st-filters');
          const body = overviewStatsPanel.el.querySelector('#st-body');
          const scope = overviewStatsPanel.el.querySelector('#st-scope');
          if (filtersEl) filtersEl.innerHTML = '';
          if (scope) scope.textContent = team.name || '';
          if (body) {
            body.innerHTML =
              '<p class="view-empty">No replays with this team name yet. Rename demo teams to match, or upload matches.</p>';
          }
        } else {
          void overviewStatsPanel
            .load({
              demos: ids,
              title: team.name || '',
              teamName: team.name || '',
              tab: 'teams',
              maps: overviewMapFilter ? [overviewMapFilter] : []
            })
            .then(() => applyOverviewMapToStats());
        }
      } else {
        applyOverviewMapToStats();
      }
    }
    const mapsKey = `${team.id}|${teamNameKey(team.name)}|${idsKey(teamDemos)}`;
    if (overviewMapsKey !== mapsKey) {
      overviewMapsKey = mapsKey;
      void refreshOverviewMaps(teamDemos);
    } else {
      paintOverviewMaps();
    }
    paintOverviewReplays();
  }

  function idsKey(list) {
    return list
      .map((d) => d.id)
      .filter(Boolean)
      .join(',');
  }

  function formatInviteCooldown(readyAt) {
    const ms = Math.max(0, (Number(readyAt) || 0) - Date.now());
    if (ms <= 0) return '';
    const totalMin = Math.ceil(ms / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function rollInviteButtonHtml() {
    if (!team?.isOwner) return '';
    const readyAt = Number(team.inviteRollReadyAt) || 0;
    const left = formatInviteCooldown(readyAt);
    if (left) {
      return `<button type="button" class="btn btn-sm" data-roll disabled title="New invite available in ${escapeHtml(
        left
      )}">New invite in ${escapeHtml(left)}</button>`;
    }
    return `<button type="button" class="btn btn-sm" data-roll title="Invalidate the current link and mint a new one (24h cooldown)">New invite link</button>`;
  }

  function overviewHtml() {
    const members = team.members || [];
    const banned = team.banned || [];
    const realCount = team.realMembers ?? members.filter((m) => !m.dummy).length;
    return `
      ${headerHtml('')}
      <div class="tm-grid tm-grid-overview">
        <div class="tm-overview-left">
          <section class="tm-card">
            <div class="tm-card-head">
              <h3 class="tm-card-title">Members</h3>
              <span class="tm-count">${realCount} / ${team.maxMembers || 7}</span>
            </div>
            <ul class="tm-members">${members.map(memberRowHtml).join('')}</ul>
            ${
              team.isOwner
                ? `<div class="tm-row tm-placeholder-add">
                    <button type="button" class="btn btn-sm" data-add-dummy>Add placeholder</button>
                  </div>`
                : ''
            }
            ${
              team.isOwner
                ? `<div class="tm-invite">
                    <div class="tm-row">
                      <input class="site-input" id="tm-invite-url" readonly value="${escapeHtml(
                        inviteUrl()
                      )}" aria-label="Invite link" />
                      <button type="button" class="btn btn-sm" data-copy>Copy</button>
                      ${rollInviteButtonHtml()}
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
            <div class="tm-card-head">
              <h3 class="tm-card-title">Maps</h3>
            </div>
            <div class="tm-maps-head" aria-hidden="true">
              <span></span>
              <span>W–L</span>
              <span>RWR</span>
              <span>PRW</span>
            </div>
            <div id="tm-overview-maps">${mapsBodyHtml()}</div>
          </section>
        </div>

        <section class="tm-card tm-overview-stats">
          <div class="tm-card-head">
            <h3 class="tm-card-title">Statistics</h3>
          </div>
          <div id="tm-overview-stats" class="tm-overview-stats-mount"></div>
        </section>

        <section class="tm-card tm-overview-replays-card">
          <div id="tm-overview-replays">${replaysBodyHtml()}</div>
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
      ${headerHtml('', '<button type="button" class="btn btn-sm primary" data-new-doc>New document</button>')}
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
        const dummy = Boolean(m.dummy);
        const dragAttrs =
          canEdit && !dummy
            ? `draggable="true" data-drag-member="${escapeHtml(m.id)}"`
            : dummy && canEdit
              ? `data-drop-dummy="${escapeHtml(m.id)}"`
              : '';
        const kindSelect = canEdit
          ? `<select class="site-select" data-kind="${escapeHtml(m.id)}"${
              owner ? ' disabled' : ''
            }>
                <option value="player"${m.kind !== 'coach' ? ' selected' : ''}>Player</option>
                <option value="coach"${m.kind === 'coach' ? ' selected' : ''}>Coach</option>
              </select>`
          : m.kind === 'coach'
            ? 'Coach'
            : 'Player';
        const roleSelect = canEdit
          ? owner
            ? `<select class="site-select" disabled>
                  <option value="owner" selected>Owner</option>
                </select>`
            : team.isOwner
              ? `<select class="site-select" data-role="${escapeHtml(m.id)}">
                  <option value="player"${
                    m.role === 'player' || m.role === 'coach' ? ' selected' : ''
                  }>Member</option>
                  <option value="admin"${m.role === 'admin' ? ' selected' : ''}>Admin</option>
                </select>`
              : `<select class="site-select" disabled>
                  <option value="${m.role === 'admin' ? 'admin' : 'player'}" selected>${
                    m.role === 'admin' ? 'Admin' : 'Member'
                  }</option>
                </select>`
          : owner
            ? 'Owner'
            : m.role === 'admin'
              ? 'Admin'
              : 'Member';
        const actions =
          team.isOwner && !owner && !dummy
            ? `<button type="button" class="btn btn-sm" data-transfer="${escapeHtml(
                m.id
              )}">Make owner</button>`
            : dummy && canEdit
              ? `<button type="button" class="btn btn-sm danger" data-kick="${escapeHtml(
                  m.id
                )}">Remove</button>`
              : '';
        return `
        <tr class="${dummy ? 'is-dummy' : ''}" ${dragAttrs}>
          <td class="tm-cell-name">${memberLabel(m)}</td>
          <td>${kindSelect}</td>
          <td>${roleSelect}</td>
          <td class="tm-cell-actions">${actions}</td>
        </tr>`;
      })
      .join('');

    const positionRows = members
      .map((m) => {
        const bag = positions[m.id]?.[rolesSide] || {};
        const dummy = Boolean(m.dummy);
        const dragAttrs =
          canEdit && !dummy
            ? `draggable="true" data-drag-member="${escapeHtml(m.id)}"`
            : dummy && canEdit
              ? `data-drop-dummy="${escapeHtml(m.id)}"`
              : '';
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
        return `<tr class="${dummy ? 'is-dummy' : ''}" ${dragAttrs}><td class="tm-cell-name">${memberLabel(
          m
        )}</td>${cells}</tr>`;
      })
      .join('');

    return `
      ${headerHtml('')}
      <section class="tm-card">
        <h3 class="tm-card-title">Roster</h3>
        ${
          canEdit
            ? '<p class="tm-note">Drag a real member onto a placeholder to merge seats and positions.</p>'
            : ''
        }
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

  function wipHtml() {
    return `
      ${headerHtml('')}
      <div class="tm-wip"><p>Work in progress...</p></div>`;
  }

  // ---- Stratbook Editor ---------------------------------------------------

  /** Player assigned to a map position, if any. */
  function assigneeFor(side, mapCode, position) {
    const bag = team?.positions || {};
    for (const m of team?.members || []) {
      if (bag[m.id]?.[side]?.[mapCode] === position) return m.username || '';
    }
    return '';
  }

  function roleColumnTitle(side, mapCode, position) {
    const who = assigneeFor(side, mapCode, position);
    return who ? `${position} (${who})` : position;
  }

  function optionsHtml(list, selected) {
    return list
      .map(
        (v) =>
          `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(
            v
          )}</option>`
      )
      .join('');
  }

  function stratRows(mapCode, side) {
    const canEdit = Boolean(team?.isAdmin);
    const roles = positionsFor(side, mapCode);
    const categories = side === 'CT' ? STRAT_CATEGORY_CT : STRAT_CATEGORY_T;
    const colCount = 8 + roles.length;
    const rows = (team.stratbook || [])
      .filter((s) => s.map === mapCode && s.side === side)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (!rows.length) {
      return `<tr class="sb-empty sb-${side.toLowerCase()}"><td colspan="${colCount}">No strategies yet.</td></tr>`;
    }

    return rows
      .map((s) => {
        const notes = Array.isArray(s.roleNotes) ? s.roleNotes : [];
        const visibleTo = new Set(Array.isArray(s.visibleTo) ? s.visibleTo : []);
        const menuOpen = openVisibleMenu === s.id;
        const members = team.members || [];
        const visibleLabel =
          visibleTo.size === 0
            ? 'None'
            : members
                .filter((m) => visibleTo.has(m.id))
                .map((m) => m.username)
                .join(', ') || `${visibleTo.size} selected`;

        const roleCells = roles
          .map((_, i) => {
            const note = notes[i] || '';
            if (!canEdit) {
              const html = noteWithUtilityLinks(note).replace(/\n/g, '<br />') || '—';
              return `<td class="sb-cell-role">${html}</td>`;
            }
            return `<td class="sb-cell-role"><textarea class="sb-input sb-role-note" data-sb-field="roleNotes" data-sb-idx="${i}" data-sb-id="${escapeHtml(
              s.id
            )}" rows="1" maxlength="800" placeholder="Role">${escapeHtml(note)}</textarea></td>`;
          })
          .join('');

        const dis = canEdit ? '' : ' disabled';

        return `
        <tr class="sb-row sb-${side.toLowerCase()}" data-sb-row="${escapeHtml(s.id)}">
          <td class="sb-cell-name">${
            canEdit
              ? `<input class="sb-input" type="text" data-sb-field="name" data-sb-id="${escapeHtml(
                  s.id
                )}" value="${escapeHtml(s.name || '')}" maxlength="120" placeholder="Name" />`
              : escapeHtml(s.name || '')
          }</td>
          <td class="sb-cell-econ ${econClass(s.economy)}">${
            canEdit
              ? `<select class="sb-cell-select" data-sb-field="economy" data-sb-id="${escapeHtml(
                  s.id
                )}">${optionsHtml(STRAT_ECONOMY, s.economy || STRAT_ECONOMY[0])}</select>`
              : escapeHtml(s.economy || '')
          }</td>
          <td class="sb-cell-cat ${catClass(s.category)}">${
            canEdit
              ? `<select class="sb-cell-select" data-sb-field="category" data-sb-id="${escapeHtml(
                  s.id
                )}">${optionsHtml(categories, s.category || categories[0])}</select>`
              : escapeHtml(s.category || '')
          }</td>
          <td class="sb-cell-desc">${
            canEdit
              ? `<input class="sb-input" type="text" data-sb-field="description" data-sb-id="${escapeHtml(
                  s.id
                )}" value="${escapeHtml(s.description || '')}" maxlength="500" placeholder="Description" />`
              : escapeHtml(s.description || '')
          }</td>
          <td class="sb-cell-links">
            <span class="sb-links">
            <button type="button" class="sb-link${s.link3d ? '' : ' is-empty'}" data-sb-link="link3d" data-sb-id="${escapeHtml(
              s.id
            )}" title="${s.link3d ? 'Open · Shift+click to edit' : 'Set 3D link'}">3D</button>
            <button type="button" class="sb-link${s.link2d ? '' : ' is-empty'}" data-sb-link="link2d" data-sb-id="${escapeHtml(
              s.id
            )}" title="${s.link2d ? 'Open · Shift+click to edit' : 'Set 2D link'}">2D</button>
            </span>
          </td>
          ${roleCells}
          <td class="sb-cell-all">
            <input type="checkbox" class="sb-check" data-sb-field="visibleAll" data-sb-id="${escapeHtml(
              s.id
            )}"${s.visibleAll ? ' checked' : ''}${dis} />
          </td>
          <td class="sb-cell-visible">
            <div class="sb-visible${menuOpen ? ' is-open' : ''}">
              <button type="button" class="sb-visible-btn" data-sb-visible-toggle="${escapeHtml(
                s.id
              )}"${dis}>${escapeHtml(visibleLabel)}</button>
              ${
                menuOpen && canEdit
                  ? `<div class="sb-visible-menu" data-sb-visible-menu="${escapeHtml(s.id)}">
                      ${members
                        .map(
                          (m) => `<label class="sb-visible-item">
                            <input type="checkbox" data-sb-visible-player="${escapeHtml(
                              m.id
                            )}" data-sb-id="${escapeHtml(s.id)}"${
                              visibleTo.has(m.id) ? ' checked' : ''
                            } />
                            <span>${escapeHtml(m.username)}</span>
                          </label>`
                        )
                        .join('')}
                    </div>`
                  : ''
              }
            </div>
          </td>
          <td class="sb-cell-del">
            ${
              canEdit
                ? `<button type="button" class="btn btn-sm danger" data-sb-del="${escapeHtml(
                    s.id
                  )}">Delete</button>`
                : ''
            }
          </td>
        </tr>`;
      })
      .join('');
  }

  function stratSection(mapCode, side) {
    const canEdit = Boolean(team?.isAdmin);
    const roles = positionsFor(side, mapCode);
    const colCount = 8 + roles.length;
    const roleHeads = roles
      .map(
        (pos) =>
          `<th class="sb-role-h"><span class="sb-role-h-text">${escapeHtml(
            roleColumnTitle(side, mapCode, pos)
          )}</span></th>`
      )
      .join('');
    const addRow = canEdit
      ? `<tr class="sb-add-row sb-${side.toLowerCase()}"><td colspan="${colCount}"><button type="button" class="sb-add" data-sb-add="${escapeHtml(
          mapCode
        )}|${side}" title="Add ${side} strategy">+</button></td></tr>`
      : '';
    return `
      <div class="sb-section sb-${side.toLowerCase()}">
        <div class="sb-table-scroll">
          <table class="sb-table" style="--sb-cols: ${colCount}">
            <colgroup>${Array.from({ length: colCount }, () => '<col />').join('')}</colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Economy</th>
                <th>Category</th>
                <th>Description</th>
                <th>Links</th>
                ${roleHeads}
                <th>All</th>
                <th>Visible to</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${stratRows(mapCode, side)}
              ${addRow}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function stratbookZoomIndex() {
    const i = SB_ZOOM_STEPS.indexOf(stratbookZoom);
    return i >= 0 ? i : SB_ZOOM_STEPS.indexOf(100);
  }

  function stratbookHtml() {
    const maps = POSITION_MAPS.map(
      (m) => `
      <section class="tm-card sb-map" data-sb-map="${escapeHtml(m.code)}">
        <h3 class="sb-map-title">${escapeHtml(m.name.toUpperCase())}</h3>
        ${stratSection(m.code, 'T')}
        ${stratSection(m.code, 'CT')}
      </section>`
    ).join('');

    const colorVars = stratColorVarsStyle();
    return `
      ${headerHtml('', stratSettingsPanelHtml({ showZoomView: true }))}
      ${
        team?.isAdmin
          ? ''
          : '<p class="tm-note">Only team admins can edit the stratbook.</p>'
      }
      <div class="sb-maps is-${stratbookView}" data-sb-color-root style="--sb-zoom: ${
        stratbookZoom / 100
      };${colorVars}">${maps}</div>`;
  }

  function applyTeam(next) {
    if (!next) return;
    team = next;
    teams = teams.map((x) => (x.id === team.id ? team : x));
  }

  function expandStratRow(row) {
    if (!row) return;
    row.querySelectorAll('textarea.sb-role-note').forEach((ta) => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(28, ta.scrollHeight)}px`;
    });
  }

  function collapseStratRow(row) {
    if (!row || stratbookView === 'full') return;
    row.querySelectorAll('textarea.sb-role-note').forEach((ta) => {
      if (ta === document.activeElement) return;
      ta.style.height = '28px';
    });
  }

  function applyStratbookViewHeights() {
    const rows = shellEl.querySelectorAll('tr.sb-row');
    if (stratbookView === 'full') {
      rows.forEach(expandStratRow);
    } else {
      rows.forEach((row) => {
        if (row.matches(':hover') || row.contains(document.activeElement)) expandStratRow(row);
        else collapseStratRow(row);
      });
    }
  }

  /** Patch one strategy without a full re-render (keeps focus). */
  async function patchStrategy(id, patch) {
    const existing = (team.stratbook || []).find((s) => s.id === id);
    if (!existing) return null;
    const res = await run(
      () => saveTeamStrategy(team.id, { ...existing, ...patch, id }),
      ''
    );
    if (res?.team) applyTeam(res.team);
    return res;
  }

  // ---- My Strategies ------------------------------------------------------

  function ensureStrategiesPlayer() {
    const members = team?.members || [];
    if (!members.length) {
      strategiesPlayerId = '';
      return;
    }
    if (strategiesPlayerId && members.some((m) => m.id === strategiesPlayerId)) return;
    const me = members.find((m) => !m.dummy && m.id === myId());
    strategiesPlayerId = me?.id || members[0].id;
  }

  function stratVisibleToPlayer(s, playerId) {
    if (s.visibleAll) return true;
    return (s.visibleTo || []).includes(playerId);
  }

  /** Index of this player's assigned position on a map/side, or -1. */
  function playerRoleIndex(playerId, side, mapCode) {
    const position = team?.positions?.[playerId]?.[side]?.[mapCode] || '';
    if (!position) return -1;
    return positionsFor(side, mapCode).indexOf(position);
  }

  function playerRoleNote(s, playerId) {
    const idx = playerRoleIndex(playerId, s.side, s.map);
    if (idx < 0) return '';
    const notes = Array.isArray(s.roleNotes) ? s.roleNotes : [];
    return String(notes[idx] || '');
  }

  function econClass(value) {
    return `ms-econ ms-econ-${stratToneSlug(value)}`;
  }

  function catClass(value) {
    return `ms-cat ms-cat-${stratToneSlug(value)}`;
  }

  function stratColorVarsStyle() {
    return Object.entries(stratbookColors)
      .map(([k, v]) => `--sb-${k}:${v}`)
      .join(';');
  }

  function saveStratbookColors() {
    try {
      localStorage.setItem(SB_COLORS_KEY, JSON.stringify(stratbookColors));
    } catch {
      /* ignore */
    }
  }

  function applyStratColorVars() {
    shellEl.querySelectorAll('[data-sb-color-root]').forEach((el) => {
      for (const [k, v] of Object.entries(stratbookColors)) {
        el.style.setProperty(`--sb-${k}`, v);
      }
    });
  }

  function colorRowHtml(kind, label) {
    const key = kind === 'econ' ? econToneKey(label) : catToneKey(label);
    const value = stratbookColors[key] || SB_COLOR_DEFAULTS[key] || '#888888';
    return `<label class="sb-color-row">
      <span class="sb-color-name">${escapeHtml(label)}</span>
      <input type="color" class="sb-color-input" data-sb-color="${escapeHtml(key)}" value="${escapeHtml(
        value
      )}" />
    </label>`;
  }

  function stratSettingsPanelHtml({ showZoomView }) {
    const zoomBlock = showZoomView
      ? `<div class="sb-settings-block">
          <div class="sb-settings-title">Zoom</div>
          <div class="sb-zoom">
            <input class="sb-zoom-range" type="range" min="0" max="${
              SB_ZOOM_STEPS.length - 1
            }" step="1" value="${stratbookZoomIndex()}" data-sb-zoom />
            <span class="sb-zoom-value" data-sb-zoom-label>${stratbookZoom}%</span>
          </div>
        </div>
        <div class="sb-settings-block">
          <div class="sb-settings-title">View</div>
          <select class="site-select sb-view-select" data-sb-view>
            <option value="compact"${stratbookView === 'compact' ? ' selected' : ''}>Compact view</option>
            <option value="full"${stratbookView === 'full' ? ' selected' : ''}>Full view</option>
          </select>
        </div>`
      : '';
    return `
      <div class="sb-settings${stratbookSettingsOpen ? ' is-open' : ''}" data-sb-settings>
        <button type="button" class="sb-settings-btn" data-sb-settings-toggle title="Stratbook settings" aria-label="Stratbook settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.77 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.89 14.5a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.66.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.24.12.52.02.66-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
          </svg>
        </button>
        <div class="sb-settings-panel" data-sb-settings-panel>
          ${zoomBlock}
          <div class="sb-settings-block">
            <div class="sb-settings-head">
              <div class="sb-settings-title">Economy colors</div>
              <button type="button" class="btn btn-sm" data-sb-colors-reset>Reset</button>
            </div>
            <div class="sb-color-list">${SB_ECON_COLOR_LABELS.map((l) => colorRowHtml('econ', l)).join('')}</div>
          </div>
          <div class="sb-settings-block">
            <div class="sb-settings-title">Category colors</div>
            <div class="sb-color-list">${SB_CAT_COLOR_LABELS.map((l) => colorRowHtml('cat', l)).join('')}</div>
          </div>
        </div>
      </div>`;
  }

  function myStratRows(mapCode, side, playerId) {
    const rows = (team.stratbook || [])
      .filter(
        (s) => s.map === mapCode && s.side === side && stratVisibleToPlayer(s, playerId)
      )
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    return rows
      .map((s) => {
        const note = playerRoleNote(s, playerId);
        const name = (s.name || 'Untitled').toUpperCase();
        const noteHtml = noteWithUtilityLinks(note).replace(/\n/g, '<br />');
        return `
        <tr class="ms-row ms-${side.toLowerCase()}">
          <td class="ms-cell-name">${escapeHtml(name)}</td>
          <td class="ms-cell-econ ${econClass(s.economy)}">${escapeHtml(s.economy || '')}</td>
          <td class="ms-cell-cat ${catClass(s.category)}">${escapeHtml(s.category || '')}</td>
          <td class="ms-cell-note">${noteHtml || '<span class="ms-note-empty">—</span>'}</td>
        </tr>`;
      })
      .join('');
  }

  function myStratMapHtml(map, playerId) {
    const tBody = myStratRows(map.code, 'T', playerId);
    const ctBody = myStratRows(map.code, 'CT', playerId);
    if (!tBody && !ctBody) return '';
    return `
      <section class="tm-card ms-map">
        <h3 class="ms-map-title">${escapeHtml(map.name.toUpperCase())}</h3>
        <div class="ms-table-scroll">
          <table class="ms-table">
            <tbody>
              ${tBody}
              ${ctBody}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function myStrategiesHtml() {
    ensureStrategiesPlayer();
    const members = team.members || [];
    const playerChips = members
      .map((m) => {
        const active = m.id === strategiesPlayerId ? ' active' : '';
        const label = m.dummy ? m.username : `@${m.username}`;
        return `<button type="button" class="rp-chip${active}" data-ms-player="${escapeHtml(
          m.id
        )}">${escapeHtml(label)}</button>`;
      })
      .join('');

    const selected = members.find((m) => m.id === strategiesPlayerId);
    const mapsHtml = POSITION_MAPS.map((m) => myStratMapHtml(m, strategiesPlayerId)).join('');

    return `
      ${headerHtml('', stratSettingsPanelHtml({ showZoomView: false }))}
      <div data-sb-color-root style="${stratColorVarsStyle()}">
      <section class="tm-card">
        <div class="tm-card-head">
          <h3 class="tm-card-title">Player</h3>
        </div>
        <div class="rp-chips ms-player-chips">${playerChips || '<span class="tm-note">No members.</span>'}</div>
      </section>
      ${
        selected
          ? mapsHtml ||
            `<section class="tm-card"><p class="tm-note">No strategies visible for ${escapeHtml(
              selected.dummy ? selected.username : `@${selected.username}`
            )} yet.</p></section>`
          : ''
      }
      </div>`;
  }

  // ---- render -------------------------------------------------------------

  function syncTeamChrome() {
    const sideLabel = document.getElementById('side-team-label');
    if (sideLabel) sideLabel.textContent = team?.name || 'Team';
  }

  function render() {
    syncTeamChrome();
    const onBoard = page === 'team-drawing-board' || page === 'team-utility-archive';
    const onOverview = page === 'team-overview';
    if (!onBoard) destroyBoardMount();
    if (!onOverview) destroyOverviewStats();
    if (!loaded) {
      shellEl.innerHTML = spinnerHtml();
      return;
    }
    if (!signedIn()) {
      destroyBoardMount();
      destroyOverviewStats();
      shellEl.innerHTML = signedOutHtml(titleFor(page));
      return;
    }
    if (!team) {
      destroyBoardMount();
      destroyOverviewStats();
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
      shellEl.innerHTML = stratbookHtml();
      applyStratbookViewHeights();
      void ensureUtilityIndex();
      return;
    }
    if (page === 'team-strategies') {
      shellEl.innerHTML = myStrategiesHtml();
      void ensureUtilityIndex();
      return;
    }
    if (page === 'team-drawing-board') {
      if (!boardMount || boardMountKey !== `drawing:${team.id}`) shellEl.innerHTML = '';
      mountBoardPage('drawing');
      return;
    }
    if (page === 'team-utility-archive') {
      // Archive edits should refresh stratbook `<!####>` lookups next visit.
      if (!boardMount || boardMountKey !== `utility:${team.id}`) {
        utilityIndexTeamId = '';
        shellEl.innerHTML = '';
      }
      mountBoardPage('utility');
      return;
    }
    shellEl.innerHTML = overviewHtml();
    mountOverviewExtras();
  }

  function titleFor(name) {
    return (
      {
        'team-overview': 'Team',
        'team-docs': 'Documents',
        'team-roles': 'Roles & Positions',
        'team-stratbook': 'Stratbook Editor',
        'team-strategies': 'My Strategies',
        'team-drawing-board': 'Drawing Board',
        'team-utility-archive': 'Utility Archive'
      }[name] || 'Team'
    );
  }

  // ---- events -------------------------------------------------------------

  shellEl.addEventListener('click', async (e) => {
    const t = e.target;

    const uaLink = t.closest('[data-ua-link]');
    if (uaLink) {
      e.preventDefault();
      await copyUtilityById(uaLink.dataset.uaLink || '');
      return;
    }

    const mapRow = t.closest('[data-tm-map]');
    if (mapRow) {
      selectOverviewMap(mapRow.dataset.tmMap || '');
      return;
    }
    const demoStats = t.closest('[data-tm-demo-stats]');
    if (demoStats) {
      await openTeamDemoStats(demoStats.dataset.tmDemoStats || '');
      return;
    }
    const demoReplay = t.closest('[data-tm-demo-replay]');
    if (demoReplay) {
      await openTeamDemoReplay(demoReplay.dataset.tmDemoReplay || '');
      return;
    }
    const demoDelete = t.closest('[data-tm-demo-delete]');
    if (demoDelete) {
      await deleteTeamDemo(demoDelete.dataset.tmDemoDelete || '');
      return;
    }

    if (t.closest('[data-create]')) {
      if (!ents.can(CAP.TEAM_CREATE_LIMIT)) {
        setStatus(
          `Creating a team is available on ${PLAN_NAMES[ents.requiredPlan(CAP.TEAM_CREATE_LIMIT)] || 'Team Premium'}.`,
          true
        );
        return;
      }
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
      if (!ents.can(CAP.TEAM_JOIN)) {
        setStatus(
          `Joining a team is available on ${PLAN_NAMES[ents.requiredPlan(CAP.TEAM_JOIN)] || 'Premium'}.`,
          true
        );
        return;
      }
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
      const btn = t.closest('[data-roll]');
      if (btn?.disabled) return;
      const res = await run(() => rollTeamInvite(team.id), 'New invite link created.');
      if (res?.team) {
        team = res.team;
        teams = (res.teams || teams).map((x) => (x.id === team.id ? team : x));
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

    if (t.closest('[data-add-dummy]')) {
      const name = window.prompt('Placeholder name');
      if (name == null) return;
      const res = await run(() => createTeamDummy(team.id, name), 'Placeholder added.');
      if (res?.team) {
        team = res.team;
        teams = res.teams || teams;
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
      const target = (team.members || []).find((m) => m.id === id);
      const action = kick ? 'kick' : ban ? 'ban' : unban ? 'unban' : 'transfer';
      if (action === 'ban' && !window.confirm('Ban that member? They cannot rejoin.')) return;
      if (action === 'transfer' && !window.confirm('Hand the team over to that member?')) return;
      if (
        action === 'kick' &&
        target?.dummy &&
        !window.confirm(`Remove placeholder ${target.username}?`)
      ) {
        return;
      }
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

    const msPlayer = t.closest('[data-ms-player]');
    if (msPlayer) {
      strategiesPlayerId = msPlayer.dataset.msPlayer || '';
      render();
      return;
    }

    const settingsToggle = t.closest('[data-sb-settings-toggle]');
    if (settingsToggle) {
      stratbookSettingsOpen = !stratbookSettingsOpen;
      shellEl.querySelector('[data-sb-settings]')?.classList.toggle('is-open', stratbookSettingsOpen);
      return;
    }

    if (t.closest('[data-sb-colors-reset]')) {
      stratbookColors = { ...SB_COLOR_DEFAULTS };
      saveStratbookColors();
      applyStratColorVars();
      shellEl.querySelectorAll('[data-sb-color]').forEach((input) => {
        const key = input.dataset.sbColor;
        if (key && SB_COLOR_DEFAULTS[key]) input.value = SB_COLOR_DEFAULTS[key];
      });
      return;
    }

    if (stratbookSettingsOpen && !t.closest('[data-sb-settings]')) {
      stratbookSettingsOpen = false;
      shellEl.querySelector('[data-sb-settings]')?.classList.remove('is-open');
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
      return;
    }

    // ---- stratbook --------------------------------------------------------
    const addStrat = t.closest('[data-sb-add]');
    if (addStrat) {
      const [mapCode, side] = (addStrat.dataset.sbAdd || '').split('|');
      if (!mapCode || !side) return;
      const cats = side === 'CT' ? STRAT_CATEGORY_CT : STRAT_CATEGORY_T;
      const res = await run(
        () =>
          saveTeamStrategy(team.id, {
            map: mapCode,
            side,
            economy: STRAT_ECONOMY[0],
            category: cats[0],
            name: '',
            description: '',
            visibleAll: false,
            visibleTo: [],
            roleNotes: ['', '', '', '', '']
          }),
        'Strategy added.'
      );
      if (res?.team) {
        applyTeam(res.team);
        render();
      }
      return;
    }

    const delStrat = t.closest('[data-sb-del]');
    if (delStrat) {
      const id = delStrat.dataset.sbDel;
      if (!window.confirm('Delete this strategy?')) return;
      const res = await run(() => deleteTeamStrategy(team.id, id), 'Strategy deleted.');
      if (res?.team) {
        applyTeam(res.team);
        if (openVisibleMenu === id) openVisibleMenu = '';
        render();
      }
      return;
    }

    const linkBtn = t.closest('[data-sb-link]');
    if (linkBtn) {
      const id = linkBtn.dataset.sbId;
      const field = linkBtn.dataset.sbLink;
      const existing = (team.stratbook || []).find((s) => s.id === id);
      if (!existing) return;
      const current = existing[field] || '';
      if (!team.isAdmin) {
        if (current) window.open(current, '_blank', 'noopener');
        return;
      }
      if (e.shiftKey || !current) {
        const next = window.prompt('Link URL (https://…)', current);
        if (next === null) return;
        await patchStrategy(id, { [field]: next.trim() });
        render();
        return;
      }
      window.open(current, '_blank', 'noopener');
      return;
    }

    const visToggle = t.closest('[data-sb-visible-toggle]');
    if (visToggle) {
      if (!team.isAdmin) return;
      const id = visToggle.dataset.sbVisibleToggle;
      openVisibleMenu = openVisibleMenu === id ? '' : id;
      render();
      return;
    }

    if (
      page === 'team-stratbook' &&
      openVisibleMenu &&
      !t.closest('[data-sb-visible-menu]') &&
      !t.closest('[data-sb-visible-toggle]')
    ) {
      openVisibleMenu = '';
      render();
    }
  });

  shellEl.addEventListener('change', async (e) => {
    const t = e.target;

    const zoom = t.closest?.('[data-sb-zoom]');
    if (zoom) {
      const next = SB_ZOOM_STEPS[Number(zoom.value)] ?? 100;
      stratbookZoom = next;
      try {
        localStorage.setItem(SB_ZOOM_KEY, String(next));
      } catch {
        /* ignore */
      }
      const maps = shellEl.querySelector('.sb-maps');
      if (maps) maps.style.setProperty('--sb-zoom', String(next / 100));
      const label = shellEl.querySelector('[data-sb-zoom-label]');
      if (label) label.textContent = `${next}%`;
      return;
    }

    const viewSel = t.closest?.('[data-sb-view]');
    if (viewSel) {
      const next = viewSel.value === 'full' ? 'full' : 'compact';
      stratbookView = next;
      try {
        localStorage.setItem(SB_VIEW_KEY, next);
      } catch {
        /* ignore */
      }
      const maps = shellEl.querySelector('.sb-maps');
      if (maps) {
        maps.classList.toggle('is-full', next === 'full');
        maps.classList.toggle('is-compact', next === 'compact');
      }
      applyStratbookViewHeights();
      return;
    }

    const picker = t.closest('[data-team-picker]');
    if (picker) {
      team = teams.find((x) => x.id === picker.value) || team;
      openDocId = '';
      openVisibleMenu = '';
      strategiesPlayerId = '';
      utilityIndex = [];
      utilityIndexTeamId = '';
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
      return;
    }

    // ---- stratbook fields -------------------------------------------------
    const sbField = t.closest('[data-sb-field]');
    if (sbField) {
      const id = sbField.dataset.sbId;
      const field = sbField.dataset.sbField;
      if (!id || !field) return;

      if (field === 'visibleAll') {
        await patchStrategy(id, { visibleAll: sbField.checked });
        return;
      }
      if (field === 'economy' || field === 'category') {
        await patchStrategy(id, { [field]: sbField.value });
        const td = sbField.closest('td');
        if (td) {
          td.className =
            field === 'economy'
              ? `sb-cell-econ ${econClass(sbField.value)}`
              : `sb-cell-cat ${catClass(sbField.value)}`;
        }
        return;
      }
      return;
    }

    const visPlayer = t.closest('[data-sb-visible-player]');
    if (visPlayer) {
      const id = visPlayer.dataset.sbId;
      const playerId = visPlayer.dataset.sbVisiblePlayer;
      const existing = (team.stratbook || []).find((s) => s.id === id);
      if (!existing) return;
      const set = new Set(existing.visibleTo || []);
      if (visPlayer.checked) set.add(playerId);
      else set.delete(playerId);
      await patchStrategy(id, { visibleTo: [...set] });
      // Refresh the button label without closing the menu.
      render();
    }
  });

  shellEl.addEventListener('focusout', async (e) => {
    const leaving = e.target.closest?.('textarea.sb-role-note');
    if (leaving) {
      const row = leaving.closest('.sb-row');
      queueMicrotask(() => {
        if (!row || row.matches(':hover') || row.contains(document.activeElement)) return;
        collapseStratRow(row);
      });
    }

    const t = e.target;
    const sbField = t.closest?.('[data-sb-field]');
    if (!sbField || !team) return;
    const field = sbField.dataset.sbField;
    const id = sbField.dataset.sbId;
    if (!id || !field) return;
    if (field === 'name' || field === 'description') {
      const existing = (team.stratbook || []).find((s) => s.id === id);
      if (!existing || existing[field] === sbField.value) return;
      await patchStrategy(id, { [field]: sbField.value });
      return;
    }
    if (field === 'roleNotes') {
      const idx = Number(sbField.dataset.sbIdx);
      const existing = (team.stratbook || []).find((s) => s.id === id);
      if (!existing || Number.isNaN(idx)) return;
      const notes = [...(existing.roleNotes || ['', '', '', '', ''])];
      while (notes.length < 5) notes.push('');
      if (notes[idx] === sbField.value) return;
      notes[idx] = sbField.value;
      await patchStrategy(id, { roleNotes: notes });
    }
  });

  shellEl.addEventListener('focusin', (e) => {
    const ta = e.target.closest?.('textarea.sb-role-note');
    if (!ta) return;
    const row = ta.closest('.sb-row');
    if (row) expandStratRow(row);
  });

  // Role notes: Ctrl/Cmd+Enter inserts a newline; plain Enter does not.
  shellEl.addEventListener('keydown', (e) => {
    const ta = e.target.closest?.('textarea.sb-role-note');
    if (!ta) return;
    if (e.key !== 'Enter') return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const v = ta.value;
      ta.value = `${v.slice(0, start)}\n${v.slice(end)}`;
      ta.selectionStart = ta.selectionEnd = start + 1;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(28, ta.scrollHeight)}px`;
      return;
    }
    e.preventDefault();
  });

  shellEl.addEventListener('input', (e) => {
    const color = e.target.closest?.('[data-sb-color]');
    if (color) {
      const key = color.dataset.sbColor;
      if (key && key in SB_COLOR_DEFAULTS) {
        stratbookColors[key] = color.value;
        saveStratbookColors();
        applyStratColorVars();
      }
      return;
    }
    const zoom = e.target.closest?.('[data-sb-zoom]');
    if (zoom) {
      const next = SB_ZOOM_STEPS[Number(zoom.value)] ?? 100;
      stratbookZoom = next;
      try {
        localStorage.setItem(SB_ZOOM_KEY, String(next));
      } catch {
        /* ignore */
      }
      const maps = shellEl.querySelector('.sb-maps');
      if (maps) maps.style.setProperty('--sb-zoom', String(next / 100));
      const label = shellEl.querySelector('[data-sb-zoom-label]');
      if (label) label.textContent = `${next}%`;
      return;
    }
    const ta = e.target.closest?.('textarea.sb-role-note');
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(28, ta.scrollHeight)}px`;
    }
  });

  shellEl.addEventListener('mouseover', (e) => {
    if (stratbookView === 'full') return;
    const row = e.target.closest?.('tr.sb-row');
    if (!row || !shellEl.contains(row)) return;
    const from = e.relatedTarget;
    if (from instanceof Node && row.contains(from)) return;
    expandStratRow(row);
  });

  shellEl.addEventListener('mouseout', (e) => {
    if (stratbookView === 'full') return;
    const row = e.target.closest?.('tr.sb-row');
    if (!row || !shellEl.contains(row)) return;
    const to = e.relatedTarget;
    if (to instanceof Node && row.contains(to)) return;
    if (row.contains(document.activeElement)) return;
    collapseStratRow(row);
  });

  // Drag a real member onto a placeholder to merge seats / positions.
  shellEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-drag-member]');
    if (!row || !team?.isAdmin) return;
    const id = row.dataset.dragMember;
    e.dataTransfer?.setData('text/aim4-member', id);
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    row.classList.add('is-dragging');
  });
  shellEl.addEventListener('dragend', (e) => {
    e.target.closest('[data-drag-member]')?.classList.remove('is-dragging');
    shellEl.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
  });
  shellEl.addEventListener('dragover', (e) => {
    const drop = e.target.closest('[data-drop-dummy]');
    if (!drop || !team?.isAdmin) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    drop.classList.add('is-drop-target');
  });
  shellEl.addEventListener('dragleave', (e) => {
    const drop = e.target.closest('[data-drop-dummy]');
    if (!drop) return;
    if (drop.contains(e.relatedTarget)) return;
    drop.classList.remove('is-drop-target');
  });
  shellEl.addEventListener('drop', async (e) => {
    const drop = e.target.closest('[data-drop-dummy]');
    if (!drop || !team?.isAdmin) return;
    e.preventDefault();
    drop.classList.remove('is-drop-target');
    const realId =
      e.dataTransfer?.getData('text/aim4-member') || e.dataTransfer?.getData('text/plain') || '';
    const dummyId = drop.dataset.dropDummy;
    if (!realId || !dummyId || realId === dummyId) return;
    const real = (team.members || []).find((m) => m.id === realId);
    const dummy = (team.members || []).find((m) => m.id === dummyId);
    if (!real || real.dummy || !dummy?.dummy) return;
    if (
      !window.confirm(
        `Merge @${real.username} onto placeholder ${dummy.username}? The placeholder’s positions, kind, and permissions replace theirs.`
      )
    ) {
      return;
    }
    const res = await run(
      () => mergeTeamMember(team.id, realId, dummyId),
      `@${real.username} took ${dummy.username}’s seat.`
    );
    if (res?.team) {
      team = res.team;
      teams = res.teams || teams;
      render();
    }
  });

  auth?.onChange?.(() => {
    loaded = false;
    demosLoaded = false;
    loadInFlight = false;
    void load();
  });

  return {
    /** @param {{page?: string, invite?: string}} params */
    onShow(params = {}) {
      const next = PAGES.includes(params.page) ? params.page : 'team-overview';
      if (next !== page) {
        openVisibleMenu = '';
        stratbookSettingsOpen = false;
      }
      page = next;
      if (params.invite) pendingInvite = params.invite;
      void ents.ready();
      // Page switches must paint immediately. Only the first visit / invite /
      // auth recovery refetch teams — never block nav on the demo library.
      if (params.invite) {
        void load();
        return;
      }
      if (!loaded) {
        render();
        if (!loadInFlight) void load();
        return;
      }
      render();
      if (page === 'team-overview') void ensureDemos();
    },
    onHide() {
      editor?.flush();
      destroyBoardMount();
    },
    /** Called by the router for /i/<code> landings. */
    setInvite(code) {
      pendingInvite = code;
    }
  };
}
