// ---------------------------------------------------------------------------
// site/teamView.js
// The TEAM shell: Overview, Documents, Roles & Positions, Stratbook Editor,
// and My Strategies.
//
// One controller owns all five pages because they share the same roster fetch:
// Overview and Roles re-render that snapshot. Documents, Stratbook Editor, and
// My Strategies refetch on show so items created elsewhere (antistrat, Add
// strategy from a round) appear without a full reload. Team pages are
// signed-in only, except /d/<shareId> document links which open view-only for
// anyone. The server rejects anything the account may not do, so the UI hides
// controls rather than enforcing rules.
// ---------------------------------------------------------------------------

import {
  createTeam,
  createTeamDummy,
  deleteTeamDocument,
  deleteTeamStrategy,
  fetchDemo,
  fetchDemos,
  fetchInvite,
  fetchStatus,
  fetchTeamAutocoach,
  fetchTeamDocument,
  fetchSharedDocument,
  fetchTeams,
  fetchUtilityIndex,
  joinTeam,
  leaveTeam,
  markTeamAutocoachDemo,
  mergeTeamMember,
  resetTeamAutocoachDemos,
  rollTeamInvite,
  savePlaylist,
  saveTeamDocument,
  saveTeamStrategy,
  setTeamPosition,
  teamMemberAction
} from '../replays/api.js';
import { getEntitlements } from '../lib/entitlements.js';
import { useMeteredFeature } from '../lib/meteredFeature.js';
import { CAP } from '../../shared/entitlements/keys.js';
import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';
import { MAPS } from '../replays/shared/roundId.js';
import { teamNameKey } from '../replays/shared/statsMath.js';
import { createStatsPanel } from '../replays/stats/statsPanel.js';
import { getStatsPayload } from '../replays/statsCache.js';
import { createRoundListPanel } from '../replays/analytics/roundListPanel.js';
import { analyzeDemoCoach } from '../replays/coach/analyzeDemo.js';
import { COACH_CATEGORY_LABELS } from '../replays/coach/coachMessages.js';
import { POSITION_MAPS, positionsFor } from '../replays/roles/teamPositions.js';
import {
  mapWinrateCompareKind,
  mapWinrateGapSpan,
  mapWinrateHint
} from '../replays/analytics/mapWinrateHint.js';
import { createDocsEditor } from './docsEditor.js';
import { mountDrawingBoard } from './drawingBoard.js';
import { mountUtilityArchive } from './utilityArchive.js';
import { spinnerHtml } from '../lib/spinner.js';
import { renderStratNoteLinks, safeHref } from './stratNoteLinks.js';

/** Below this a per-side winrate is noise, so the bar stays empty. */
const MIN_SIDE_ROUNDS = 12;
/** Overview map pool: Overpass is out of the active pool. */
const OVERVIEW_MAPS = POSITION_MAPS.filter((m) => m.code !== 'OVP');

const PAGES = [
  'team-overview',
  'team-docs',
  'team-roles',
  'team-stratbook',
  'team-strategies',
  'team-drawing-board',
  'team-utility-archive',
  'team-autocoach'
];

/** Lists that other shells write to. Refetch the roster when these pages show. */
const REFETCH_ON_SHOW = new Set(['team-docs', 'team-stratbook', 'team-strategies']);

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
  /** Doc id currently mounted in `editor` (survives soft re-renders). */
  let mountedDocId = '';
  /** @type {{ destroy: () => void }|null} */
  let boardMount = null;
  let boardMountKey = '';
  /** `{ map, throwId }` from `/team/utility-archive?map=&u=`. */
  let pendingUtilityFocus = { map: '', throwId: '' };
  /** @type {ReturnType<typeof createStatsPanel>|null} */
  let overviewStatsPanel = null;
  /** @type {ReturnType<typeof createRoundListPanel>|null} */
  let overviewRoundList = null;
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
  /** Filter on the Documents page search box. */
  let docsQuery = '';
  /** Public /d/<code> landings — view-only, signed in or not. */
  let pendingShare = '';
  let openingShare = false;
  let shareView = false;
  /** @type {object|null} */
  let sharedDoc = null;
  let rolesSide = 'T';
  /** @type {{ players: object[], demos: object[], unanalyzedCount: number }|null} */
  let autocoachSummary = null;
  let autocoachLoading = false;
  let autocoachBusy = '';
  let autocoachSelectedPlayer = '';
  let autocoachReviewDemoId = '';
  /** @type {Set<string>} */
  let autocoachSelectedDemos = new Set();
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
      // Prefer a team-name filter so Overview does not download the whole library.
      const teamName = String(team?.name || '').trim();
      const r = teamName
        ? await fetchDemos({ team: teamName })
        : await fetchDemos({ limit: 200 });
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
      // Share links are public: open the document without waiting on account status.
      const share = pendingShare;
      if (share) {
        if (openingShare) return;
        openingShare = true;
        loaded = false;
        render();
        try {
          await openSharedDoc(share);
          if (token !== loadToken) return;
          pendingShare = '';
          loaded = true;
        } finally {
          openingShare = false;
        }
        return;
      }

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
      adoptTeams(teamList);
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

  /** Keep the selected team across reloads when it still exists. */
  function adoptTeams(teamList) {
    teams = teamList || [];
    const nextTeam = teams.find((t) => t.id === team?.id) || teams[0] || null;
    if (nextTeam?.id !== team?.id) {
      autocoachSummary = null;
      autocoachSelectedPlayer = '';
      autocoachReviewDemoId = '';
      demos = [];
      demosLoaded = false;
    }
    team = nextTeam;
  }

  /**
   * Documents / stratbook can change outside this shell. Paint the current
   * snapshot first, then replace it when GET /api/teams returns.
   */
  async function refreshTeam() {
    if (!signedIn() || loadInFlight) return;
    const token = ++loadToken;
    const teamList = await fetchTeams().catch(() => null);
    if (token !== loadToken || !teamList) return;
    adoptTeams(teamList);
    if (page === 'team-stratbook' || page === 'team-strategies') {
      utilityIndexTeamId = '';
    }
    render();
  }

  // ---- shared chrome ------------------------------------------------------

  function destroyBoardMount() {
    boardMount?.destroy?.();
    boardMount = null;
    boardMountKey = '';
  }

  function mountBoardPage(kind) {
    const key = `${kind}:${team.id}`;
    if (boardMount && boardMountKey === key) {
      if (kind === 'utility' && (pendingUtilityFocus.map || pendingUtilityFocus.throwId)) {
        boardMount.focusThrow?.(pendingUtilityFocus);
      }
      return;
    }
    destroyBoardMount();
    boardMountKey = key;
    const deps = { host: shellEl, teamId: team.id, escapeHtml, headerHtml };
    boardMount =
      kind === 'drawing'
        ? mountDrawingBoard(deps)
        : mountUtilityArchive({ ...deps, initialFocus: pendingUtilityFocus });
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

  /** Escape note text, then turn `<label><!id><URL=…>` into links. */
  function noteWithUtilityLinks(raw) {
    return renderStratNoteLinks(raw, { escapeHtml });
  }

  /**
   * The round a throw came from, framed on the thrower half a second before he
   * lets go. Only throws imported from a demo carry this; hand-placed lineups
   * have no round to open and just copy.
   */
  function throwMomentHref(th) {
    if (!th?.round || !th?.tick) return '';
    const q = new URLSearchParams({ round: th.round, tick: String(th.tick) });
    if (th.player) q.set('focus', th.player);
    return `/demos?${q}`;
  }

  /** Stratbook 2D field: same-origin paths stay in the app, anything else is a tab. */
  function strat2dHref(raw) {
    const href = safeHref(raw);
    if (!href) return '';
    try {
      const u = new URL(href, window.location.origin);
      if (u.origin === window.location.origin) return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      /* keep the sanitized href */
    }
    return href;
  }

  async function copyUtilityById(id) {
    if (utilityIndexTeamId !== team?.id) await ensureUtilityIndex();
    let th = null;
    for (const g of utilityIndex) {
      const hit = (g.throws || []).find((t) => t.id === id);
      if (hit) {
        th = hit;
        break;
      }
    }
    if (!th) {
      const entry = utilityIndex.find((g) => g.id === id);
      const throws = Array.isArray(entry?.throws) ? entry.throws : [];
      if (throws.length === 1) th = throws[0];
    }
    if (!th) {
      setStatus(`No throw ${id} in the archive.`, true);
      return;
    }
    // Opened before the clipboard await: a tab opened after one is a popup as
    // far as the browser is concerned, and gets blocked.
    const href = throwMomentHref(th);
    const opened = href ? window.open(href, '_blank', 'noopener') : null;

    const text = [th.setpos, th.setang].filter(Boolean).join('\n');
    if (!text) {
      setStatus(
        opened ? 'Opened the round. That throw has no setpos / setang yet.' : 'That throw has no setpos / setang yet.',
        !opened
      );
      return;
    }
    const where = opened ? ' Round opened.' : '';
    try {
      await navigator.clipboard.writeText(text);
      setStatus(th.comment ? `Copied. ${th.comment}${where}` : `Copied ${id}.${where}`);
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
        ${actions}
      </li>`;
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

  function pct1(n) {
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
  }

  function emptyMapStats() {
    return OVERVIEW_MAPS.map((m) => ({
      code: m.code,
      name: m.name,
      matches: 0,
      wins: 0,
      losses: 0,
      rounds: 0,
      roundWinrate: null,
      tWinrate: null,
      tRounds: 0,
      tPrw: null,
      ctWinrate: null,
      ctRounds: 0,
      ctPrw: null,
      pistolWinrate: null,
      pistols: 0,
      prw: null
    }));
  }

  function mapsBodyHtml() {
    if (overviewMapsLoading && !overviewMaps.length) {
      return `<div class="is-loading" role="status" aria-live="polite">${spinnerHtml()}</div>`;
    }
    const rows = overviewMaps.length ? overviewMaps : emptyMapStats();
    /**
     * A round winrate as a bar.
     *
     * Anchored at 50%, because a map pool decision is never "how high is this
     * number" but "which side of even is it, and by how much". Below-even bars
     * grow left from the centre line, above-even grow right. Predicted winrate
     * sits on the same track as a dashed overlay of the gap vs actual.
     */
    const sideBar = (side, rate, rounds, prw) => {
      const known = Number.isFinite(rate) && rounds >= MIN_SIDE_ROUNDS;
      const offset = known ? Math.max(-50, Math.min(50, rate - 50)) : 0;
      const left = offset < 0 ? 50 + offset : 50;
      const kind = known ? mapWinrateCompareKind(rate, prw) : '';
      const gap = kind ? mapWinrateGapSpan(rate, prw) : null;
      const overlay =
        gap && kind
          ? `<span class="tm-map-bar-prw is-${kind}" style="left:${gap.left}%;width:${gap.width}%"></span>`
          : '';
      const hint = kind ? mapWinrateHint(rate, prw) : '';
      const title = hint
        ? hint
        : `${side} round winrate${known ? ` ${pct1(rate)} over ${rounds} rounds` : ', not enough rounds yet'}`;
      return `<span class="tm-map-bar" data-side="${side}" title="${escapeHtml(title)}">
        <span class="tm-map-bar-track">
          <span class="tm-map-bar-fill" style="left:${left}%;width:${Math.abs(offset)}%"></span>
          ${overlay}
        </span>
        <span class="tm-map-bar-label">${side}</span>
      </span>`;
    };
    return `<ul class="tm-maps-list">${rows
      .map((m) => {
        const active = overviewMapFilter === m.code ? ' is-active' : '';
        const name =
          m.matches > 0
            ? `${escapeHtml(m.name)} (${m.wins}W, ${m.losses}L)`
            : escapeHtml(m.name);
        return `
      <li class="tm-map-row${active}" data-tm-map="${escapeHtml(m.code)}" role="button" tabindex="0">
        <span class="tm-map-name">${name}</span>
        <span class="tm-map-bars">
          ${sideBar('T', m.tWinrate, m.tRounds, m.tPrw)}
          ${sideBar('CT', m.ctWinrate, m.ctRounds, m.ctPrw)}
        </span>
      </li>`;
      })
      .join('')}</ul>`;
  }

  function paintOverviewMaps() {
    const el = document.getElementById('tm-overview-maps');
    if (el) el.innerHTML = mapsBodyHtml();
  }

  function destroyOverviewStats() {
    if (overviewStatsPanel) {
      overviewStatsPanel.destroy();
      overviewStatsPanel = null;
    }
    if (overviewRoundList) {
      overviewRoundList.destroy();
      overviewRoundList = null;
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
      const payload = await getStatsPayload(ids);
      if (token !== overviewMapsToken) return;
      const want = teamNameKey(team?.name || '');
      /** @type {Map<string, {matches: number, wins: number, losses: number, rounds: number, won: number, prwSum: number, prwN: number}>} */
      const acc = new Map();
      for (const m of OVERVIEW_MAPS) {
        acc.set(m.code, {
          matches: 0,
          wins: 0,
          losses: 0,
          rounds: 0,
          won: 0,
          prwSum: 0,
          prwN: 0,
          // Per side, because a map is two different games and a single
          // winrate hides which half of it is the problem.
          T: { rounds: 0, won: 0, prwSum: 0, prwN: 0 },
          CT: { rounds: 0, won: 0, prwSum: 0, prwN: 0 },
          pistols: 0,
          pistolsWon: 0
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
          const won = row.w === side;
          if (won) s.won += 1;
          const ourSide = side === 1 ? row.s1 : row.s2;
          const bag = ourSide === 'T' ? s.T : ourSide === 'CT' ? s.CT : null;
          if (bag) {
            bag.rounds += 1;
            if (won) bag.won += 1;
          }
          // MR12: rounds 1 and 13 open each half on pistols.
          if (row.n === 1 || row.n === 13) {
            s.pistols += 1;
            if (won) s.pistolsWon += 1;
          }
          const prw = side === 1 ? row.prw1 : row.prw2;
          if (Number.isFinite(prw)) {
            s.prwSum += prw;
            s.prwN += 1;
            if (bag) {
              bag.prwSum += prw;
              bag.prwN += 1;
            }
          }
        }
      }
      const rate = (bag) => (bag.rounds ? (bag.won / bag.rounds) * 100 : null);
      const sidePrw = (bag) => (bag.prwN ? bag.prwSum / bag.prwN : null);
      overviewMaps = OVERVIEW_MAPS.map((m) => {
        const s = acc.get(m.code);
        return {
          code: m.code,
          name: m.name,
          matches: s.matches,
          wins: s.wins,
          losses: s.losses,
          rounds: s.rounds,
          roundWinrate: s.rounds ? (s.won / s.rounds) * 100 : null,
          tWinrate: rate(s.T),
          tRounds: s.T.rounds,
          tPrw: sidePrw(s.T),
          ctWinrate: rate(s.CT),
          ctRounds: s.CT.rounds,
          ctPrw: sidePrw(s.CT),
          pistolWinrate: s.pistols ? (s.pistolsWon / s.pistols) * 100 : null,
          pistols: s.pistols,
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

  /**
   * The round library panel reads the stats panel's payload rather than
   * fetching again. Map picks stay on this team's demos.
   */
  function paintRoundList() {
    if (!overviewRoundList) return;
    overviewRoundList.update({
      preferredMap: overviewMapFilter,
      teamName: team?.name || '',
      payload: overviewStatsPanel?.getPayload?.() || null
    });
  }

  function applyOverviewMapToStats() {
    if (!overviewStatsPanel?.applyView) return;
    const maps = overviewMapFilter ? [overviewMapFilter] : [];
    overviewStatsPanel.applyView({ maps });
    paintRoundList();
  }

  function selectOverviewMap(code) {
    const next = overviewMapFilter === code ? '' : code;
    overviewMapFilter = next;
    paintOverviewMaps();
    // Single-demo stats leave the middle panel scoped to one match; a map pick
    // should return to the full team library with that map filter.
    if (String(overviewStatsKey).startsWith('single:')) {
      overviewStatsKey = '';
      mountOverviewExtras();
      return;
    }
    applyOverviewMapToStats();
  }

  function mountOverviewExtras() {
    const teamDemos = demosForTeam();
    const listMount = document.getElementById('tm-overview-roundlist');
    if (listMount) {
      if (!overviewRoundList) overviewRoundList = createRoundListPanel({ escapeHtml });
      if (overviewRoundList.el.parentElement !== listMount) {
        listMount.replaceChildren(overviewRoundList.el);
      }
    }
    const mount = document.getElementById('tm-overview-stats');
    if (mount) {
      const ids = teamDemos.map((d) => d.id).filter(Boolean);
      // Team-scoped stats. Map picks filter those same demos; they do not
      // expand to the full database.
      const key = `${team.id}|${teamNameKey(team.name)}|${ids.join(',')}`;
      if (!overviewStatsPanel) overviewStatsPanel = createStatsPanel({
        escapeHtml,
        omitTeamColumn: true
      });
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
          paintRoundList();
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

  function membersCardHtml() {
    const members = team.members || [];
    const banned = team.banned || [];
    const realCount = team.realMembers ?? members.filter((m) => !m.dummy).length;
    return `
      <section class="tm-card tm-members-card">
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
      </section>`;
  }

  function overviewHtml() {
    return `
      ${headerHtml('')}
      <div class="tm-grid tm-grid-overview">
        <div class="tm-overview-left">
          <section class="tm-card">
            <div class="tm-card-head">
              <h3 class="tm-card-title">Map winrate</h3>
            </div>
            <div id="tm-overview-maps">${mapsBodyHtml()}</div>
          </section>
        </div>

        <div class="tm-overview-main">
          <section class="tm-card tm-overview-stats">
            <div class="tm-card-head">
              <h3 class="tm-card-title">Statistics</h3>
            </div>
            <div id="tm-overview-stats" class="tm-overview-stats-mount"></div>
          </section>
          <div id="tm-overview-roundlist"></div>
        </div>
      </div>`;
  }

  function inviteUrl() {
    return `${window.location.origin}/i/${team?.invite || ''}`;
  }

  // ---- documents ----------------------------------------------------------

  function documentShareUrl(shareId) {
    if (!shareId) return '';
    return `${window.location.origin}/d/${shareId}`;
  }

  function sharedDocHtml(doc) {
    return `
      <div class="tm-docs tm-docs-shared">
        <aside class="tm-docs-side">
          <nav class="tm-doc-outline" data-doc-outline hidden></nav>
        </aside>
        <div class="tm-doc-main" id="tm-doc-main">
          <div class="tm-doc-head">
            <h1 class="tm-doc-title-static">${escapeHtml(doc.title || 'Untitled')}</h1>
            <span class="tm-note">View only</span>
          </div>
          <div id="tm-doc-editor"></div>
        </div>
      </div>`;
  }

  function mountSharedEditor(doc) {
    destroyBoardMount();
    destroyOverviewStats();
    editor?.destroy();
    editor = null;
    mountedDocId = '';
    shellEl.innerHTML = sharedDocHtml(doc);
    const host = shellEl.querySelector('#tm-doc-editor');
    if (!host) return;
    editor = createDocsEditor({
      escapeHtml,
      onSave: async () => {
        throw new Error('This shared link is view only.');
      }
    });
    mountedDocId = doc.id || doc.shareId || 'shared';
    host.appendChild(editor.el);
    editor.load({ html: doc.html || '' });
    editor.el.querySelector('#doc-surface')?.setAttribute('contenteditable', 'false');
    editor.el.querySelector('#doc-toolbar')?.setAttribute('hidden', 'hidden');
  }

  async function openSharedDoc(shareId) {
    shareView = true;
    page = 'team-docs';
    try {
      const doc = await fetchSharedDocument(shareId);
      if (!doc) throw new Error('That document link is not valid.');
      sharedDoc = doc;
      mountSharedEditor(doc);
    } catch (err) {
      sharedDoc = null;
      editor?.destroy();
      editor = null;
      mountedDocId = '';
      shellEl.innerHTML = `<div class="tm-empty">
        <p class="view-empty">${escapeHtml(err.message || 'That document link is not valid.')}</p>
      </div>`;
    }
  }

  function documentsHtml() {
    const open = (team.documents || []).find((d) => d.id === openDocId);
    return `
      ${headerHtml('')}
      <div class="tm-docs">
        <aside class="tm-docs-side">
        <div class="tm-doc-list">
          ${docsListInnerHtml()}
        </div>
        <nav class="tm-doc-outline" data-doc-outline hidden></nav>
        </aside>
        <div class="tm-doc-main" id="tm-doc-main">
          ${
            open
              ? `<div id="tm-doc-editor"></div>`
              : '<p class="view-empty">Pick a document, or start a new one.</p>'
          }
        </div>
      </div>`;
  }

  function sortedDocs() {
    return [...(team.documents || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function filteredDocs() {
    const q = docsQuery.trim().toLowerCase();
    const docs = sortedDocs();
    if (!q) return docs;
    return docs.filter((d) => {
      const title = String(d.title || '').toLowerCase();
      const author = String(d.authorName || '').toLowerCase();
      return title.includes(q) || author.includes(q);
    });
  }

  function docItemHtml(d) {
    return `
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
              </div>`;
  }

  function docsListInnerHtml() {
    const docs = filteredDocs();
    if (!docs.length) {
      return docsQuery.trim()
        ? '<p class="view-empty">No matching documents.</p>'
        : '<p class="view-empty">No documents yet.</p>';
    }
    return docs.map(docItemHtml).join('');
  }

  function paintDocsList() {
    const list = shellEl.querySelector('.tm-doc-list');
    if (list) list.innerHTML = docsListInnerHtml();
  }

  function mountDocsHeadActions() {
    const slot = document.getElementById('page-head-actions');
    if (!slot) return;
    if (page !== 'team-docs' || shareView) return;
    if (slot.querySelector('[data-doc-search]')) {
      const input = slot.querySelector('[data-doc-search]');
      if (input && document.activeElement !== input) input.value = docsQuery;
      return;
    }
    slot.innerHTML = `
      <input type="search" class="tm-doc-search" data-doc-search placeholder="Search" spellcheck="false" autocomplete="off" aria-label="Search documents" />
      <button type="button" class="btn btn-sm primary" data-new-doc>New document</button>`;
    const input = slot.querySelector('[data-doc-search]');
    if (input) input.value = docsQuery;
  }

  function clearDocsHeadActions() {
    const slot = document.getElementById('page-head-actions');
    if (slot?.querySelector('[data-doc-search]')) slot.replaceChildren();
  }

  async function createDocument() {
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
  }

  function syncCopyLink() {
    const open = (team?.documents || []).find((d) => d.id === openDocId);
    const url = open ? documentShareUrl(open.shareId) : '';
    const btn = editor?.el?.querySelector('[data-copy-doc-link]');
    if (!btn) return;
    if (url) {
      btn.hidden = false;
      btn.title = url;
    } else {
      btn.hidden = true;
      btn.title = '';
    }
  }

  /** Patch the docs sidebar without tearing down the live editor. */
  function refreshDocsChrome() {
    paintDocsList();
    syncCopyLink();
    editor?.refreshOutline?.();
  }

  async function mountEditor() {
    const host = shellEl.querySelector('#tm-doc-editor');
    if (!host || !openDocId) return;
    // Keep the live surface when the open doc has not changed.
    if (editor && mountedDocId === openDocId && host.contains(editor.el)) {
      refreshDocsChrome();
      return;
    }
    const wantId = openDocId;
    const doc = await fetchTeamDocument(team.id, wantId).catch(() => null);
    if (!doc || openDocId !== wantId) return;
    const hostNow = shellEl.querySelector('#tm-doc-editor');
    if (!hostNow) return;
    const meta = (team.documents || []).find((d) => d.id === wantId);
    if (meta && doc.shareId && meta.shareId !== doc.shareId) {
      meta.shareId = doc.shareId;
    }
    editor?.destroy();
    editor = createDocsEditor({
      escapeHtml,
      onSave: async (html) => {
        if (!meta?.canEdit) throw new Error('You can only edit your own documents.');
        const res = await saveTeamDocument(team.id, { id: wantId, html });
        if (res?.team) {
          team = res.team;
          teams = teams.map((t) => (t.id === team.id ? team : t));
          // Sidebar timestamps only. Never re-render the shell while typing.
          if (page === 'team-docs' && openDocId === wantId) refreshDocsChrome();
        }
      }
    });
    mountedDocId = wantId;
    hostNow.appendChild(editor.el);
    editor.load({ html: doc.html });
    if (!meta?.canEdit) {
      editor.el.querySelector('#doc-surface')?.setAttribute('contenteditable', 'false');
      editor.el.querySelector('#doc-toolbar')?.classList.add('is-readonly');
    }
    refreshDocsChrome();
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
      <div class="tm-grid tm-grid-roles-top">
        <section class="tm-card">
          <h3 class="tm-card-title">Roster</h3>
          ${
            canEdit
              ? '<p class="tm-note">Drag a member onto a placeholder to merge seats and positions.</p>'
              : ''
          }
          <table class="tm-table">
            <thead><tr><th>Member</th><th>Kind</th><th>Permissions</th><th></th></tr></thead>
            <tbody>${rosterRows}</tbody>
          </table>
          ${canEdit ? '' : '<p class="tm-note">Only team admins can change this.</p>'}
        </section>

        ${membersCardHtml()}
      </div>

      <section class="tm-card">
        <div class="tm-card-head">
          <h3 class="tm-card-title">Positions</h3>
          <div class="rp-seg rp-seg-side" role="group" aria-label="Side">
            <button type="button" class="rp-seg-btn${
              rolesSide === 'T' ? ' active' : ''
            }" data-side="T" aria-label="T" title="T">
              <img src="/icons/icon_t.png" alt="" width="16" height="16" draggable="false" />
            </button>
            <button type="button" class="rp-seg-btn${
              rolesSide === 'CT' ? ' active' : ''
            }" data-side="CT" aria-label="CT" title="CT">
              <img src="/icons/icon_ct.png" alt="" width="16" height="16" draggable="false" />
            </button>
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

  function mapLabel(code) {
    return MAPS[code]?.name || code || '—';
  }

  function formatWhen(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '—';
    try {
      return new Date(n).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return '—';
    }
  }

  async function refreshAutocoach() {
    if (!team?.id) {
      autocoachSummary = null;
      return;
    }
    autocoachLoading = true;
    try {
      const res = await fetchTeamAutocoach(team.id);
      autocoachSummary = {
        players: res.players || [],
        demos: res.demos || [],
        unanalyzedCount: Number(res.unanalyzedCount) || 0
      };
      if (res.team) team = res.team;
    } catch (err) {
      autocoachSummary = { players: [], demos: [], unanalyzedCount: 0 };
      setStatus(err.message || 'Could not load Autocoach.', true);
    } finally {
      autocoachLoading = false;
    }
  }

  /**
   * One player's mistakes, broken out.
   *
   * A running total reads as an accusation and offers nothing to do about it.
   * Two things fix that: which kind of mistake it is, and whether it is getting
   * better. Both come out of the payload already in hand; the categories are
   * counted server-side and the trend is the per-demo rate over time.
   */
  function playerFocusHtml(p, demos) {
    const cats = Object.entries(p.cats || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const worst = cats[0]?.[1] || 1;

    // Per demo, oldest first. Rate rather than count, so a long match does not
    // look worse than a short one.
    const points = (demos || [])
      .filter((d) => d.analyzed)
      .map((d) => {
        const seat = (d.players || []).find((x) => x.id === p.id);
        if (!seat || !seat.rounds) return null;
        return { at: d.uploadedAt || 0, rate: seat.total / seat.rounds, label: `${d.name1} vs ${d.name2}` };
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);

    let trend = '';
    if (points.length >= 4) {
      const half = Math.floor(points.length / 2);
      const mean = (list) => list.reduce((s, x) => s + x.rate, 0) / list.length;
      const before = mean(points.slice(0, half));
      const after = mean(points.slice(half));
      const delta = after - before;
      // Down is better here: fewer flagged moments per round.
      trend = `<span class="tm-ac-trend ${delta <= 0 ? 'good' : 'bad'}">${
        delta <= 0 ? '↓' : '↑'
      } ${Math.abs(delta).toFixed(2)} per round vs earlier</span>`;
    }

    const bars = cats.length
      ? cats
          .map(
            ([key, n]) => `<li class="tm-ac-cat">
              <span class="tm-ac-cat-label">${escapeHtml(
                COACH_CATEGORY_LABELS[key] || key
              )}</span>
              <span class="tm-ac-cat-track"><span style="width:${Math.round(
                (n / worst) * 100
              )}%"></span></span>
              <span class="tm-ac-cat-count">${n}</span>
            </li>`
          )
          .join('')
      : '<li class="tm-note">Nothing flagged yet.</li>';

    return `
      <section class="tm-card tm-ac-focus">
        <div class="tm-card-head">
          <h3 class="tm-card-title">${escapeHtml(p.name)}</h3>
          ${trend}
        </div>
        <ul class="tm-ac-cats">${bars}</ul>
        <div class="tm-ac-focus-actions">
          <button type="button" class="btn btn-sm" data-ac-playlist="${escapeHtml(p.id)}"
            ${p.total > 0 ? '' : 'disabled'}>Playlist of this week</button>
          <button type="button" class="btn btn-sm" data-ac-digest>Write weekly digest</button>
        </div>
      </section>`;
  }

  /** A week back from now, for the digest and the per-player playlist. */
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  /** Demos analyzed in the last week, newest first. */
  function recentAnalyzedDemos() {
    const cutoff = Date.now() - WEEK_MS;
    return (autocoachSummary?.demos || [])
      .filter((d) => d.analyzed && (d.uploadedAt || 0) >= cutoff)
      .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  }

  /**
   * One player's flagged rounds from the last week, as a playlist.
   *
   * This is the link the whole team side was missing: a tally is an argument,
   * a playlist is twelve minutes of watching the actual moments.
   */
  async function buildMistakePlaylist(playerId) {
    const player = (autocoachSummary?.players || []).find((p) => p.id === playerId);
    if (!player) return;
    let recent = recentAnalyzedDemos();
    // Nothing this week is common on a quiet roster; fall back to everything
    // analyzed rather than handing back an empty playlist with no explanation.
    let windowed = true;
    if (!recent.length) {
      recent = (autocoachSummary?.demos || []).filter((d) => d.analyzed);
      windowed = false;
    }
    const files = [];
    for (const d of recent) {
      const seat = (d.players || []).find((p) => p.id === playerId);
      for (const f of seat?.files || []) if (!files.includes(f)) files.push(f);
    }
    if (!files.length) {
      setStatus(`No flagged rounds for ${player.name} yet.`, true);
      return;
    }
    const name = `${player.name} mistakes${windowed ? ' this week' : ''}`;
    await run(
      () => savePlaylist({ name, rounds: files, scope: 'team' }),
      `Saved "${name}" with ${files.length} round${files.length === 1 ? '' : 's'}.`
    );
  }

  /**
   * The week, written into a team document.
   *
   * Top categories across the roster, who improved most, and one linked example
   * per category. Written as a document rather than shown here because the
   * point is that it survives the week it describes.
   */
  async function writeWeeklyDigest() {
    const recent = recentAnalyzedDemos();
    if (!recent.length) {
      setStatus('No demos analyzed in the last week.', true);
      return;
    }
    /** category -> count, and category -> one round to watch. */
    const cats = new Map();
    const example = new Map();
    /** playerId -> { name, total, rounds } over the window. */
    const perPlayer = new Map();
    for (const d of recent) {
      for (const seat of d.players || []) {
        const bag = perPlayer.get(seat.id) || { name: seat.name, total: 0, rounds: 0 };
        bag.total += seat.total || 0;
        bag.rounds += seat.rounds || 0;
        perPlayer.set(seat.id, bag);
        for (const [key, n] of Object.entries(seat.cats || {})) {
          cats.set(key, (cats.get(key) || 0) + n);
          if (!example.has(key) && seat.files?.length) {
            example.set(key, { file: seat.files[0], who: seat.name });
          }
        }
      }
    }
    const top = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!top.length) {
      setStatus('Nothing was flagged in the last week.', true);
      return;
    }

    // Biggest improver: lowest rate this week against their rate before it.
    const older = (autocoachSummary?.demos || []).filter(
      (d) => d.analyzed && !recent.includes(d)
    );
    const before = new Map();
    for (const d of older) {
      for (const seat of d.players || []) {
        const bag = before.get(seat.id) || { total: 0, rounds: 0 };
        bag.total += seat.total || 0;
        bag.rounds += seat.rounds || 0;
        before.set(seat.id, bag);
      }
    }
    let improver = null;
    for (const [id, now] of perPlayer) {
      const was = before.get(id);
      if (!was?.rounds || !now.rounds) continue;
      const delta = now.total / now.rounds - was.total / was.rounds;
      if (!improver || delta < improver.delta) improver = { name: now.name, delta };
    }

    const esc = escapeHtml;
    const lines = [
      `<h2>Autocoach week to ${esc(new Date().toLocaleDateString())}</h2>`,
      `<p>${recent.length} match${recent.length === 1 ? '' : 'es'} analyzed.</p>`,
      '<h3>Most common</h3>',
      '<ul>',
      ...top.map(([key, n]) => {
        const ex = example.get(key);
        const label = esc(COACH_CATEGORY_LABELS[key] || key);
        const link = ex
          ? ` <a href="/demos?round=${encodeURIComponent(ex.file)}">watch ${esc(ex.who)}</a>`
          : '';
        return `<li>${label}: ${n}${link}</li>`;
      }),
      '</ul>'
    ];
    if (improver && improver.delta < 0) {
      lines.push(
        `<h3>Biggest improver</h3><p>${esc(improver.name)}, ${Math.abs(
          improver.delta
        ).toFixed(2)} fewer flagged moments per round.</p>`
      );
    }
    await run(
      () =>
        saveTeamDocument(team.id, {
          title: `Autocoach week to ${new Date().toLocaleDateString()}`,
          html: lines.join('\n')
        }),
      'Digest written to Documents.'
    );
  }

  function autocoachHtml() {
    const players = autocoachSummary?.players || [];
    const demos = autocoachSummary?.demos || [];
    const n = Number(autocoachSummary?.unanalyzedCount) || 0;
    const selectedCount = autocoachSelectedDemos.size;
    const analyzedCount = demos.filter((d) => d.analyzed).length;
    const reviewDemo = demos.find((d) => d.id === autocoachReviewDemoId) || null;
    const reviewPlayers = reviewDemo?.players?.length
      ? reviewDemo.players
      : players;

    const playerRows = players.length
      ? players
          .map((p) => {
            const active = autocoachSelectedPlayer === p.id ? ' active' : '';
            const avg = Number(p.avg);
            const avgLabel = Number.isFinite(avg) ? avg.toFixed(2) : '0.00';
            return `<button type="button" class="tm-ac-player${active}" data-ac-player="${escapeHtml(
              p.id
            )}">
              <span class="tm-ac-player-name">${escapeHtml(p.name)}</span>
              <span class="tm-ac-player-stats">
                <span title="Mistakes">${p.total}</span>
                <span class="avg" title="Mistakes per round">${escapeHtml(avgLabel)}</span>
                <span class="ok" title="Acknowledged">${p.ok}</span>
                <span class="deny" title="Disagreed">${p.x}</span>
              </span>
            </button>`;
          })
          .join('')
      : '<p class="tm-note">No demos with this team name yet.</p>';

    const focus = autocoachSelectedPlayer
      ? players.find((p) => p.id === autocoachSelectedPlayer)
      : null;
    const focusPanel = focus ? playerFocusHtml(focus, demos) : '';

    const visibleDemos = autocoachSelectedPlayer
      ? demos.filter((d) => (d.players || []).some((p) => p.id === autocoachSelectedPlayer))
      : demos;

    const demoRows = visibleDemos.length
      ? visibleDemos
          .map((d) => {
            const title = `${d.name1} vs ${d.name2}`;
            const score = `${d.score1}-${d.score2}`;
            const badge = d.analyzed
              ? '<span class="tm-ac-badge done">Analyzed</span>'
              : '<span class="tm-ac-badge">Pending</span>';
            const checked = autocoachSelectedDemos.has(d.id) ? ' checked' : '';
            return `<div class="tm-ac-demo" data-ac-demo="${escapeHtml(d.id)}">
              <label class="tm-ac-demo-check">
                <input type="checkbox" data-ac-select="${escapeHtml(d.id)}"${checked} />
              </label>
              <div class="tm-ac-demo-main">
                <strong>${escapeHtml(title)}</strong>
                <span class="tm-ac-demo-meta">${escapeHtml(mapLabel(d.map))} · ${escapeHtml(
                  score
                )} · ${escapeHtml(formatWhen(d.uploadedAt))}</span>
                ${badge}
                ${
                  d.analyzed
                    ? `<span class="tm-ac-demo-meta">${d.mistakeCount} mistake${
                        d.mistakeCount === 1 ? '' : 's'
                      }</span>`
                    : ''
                }
              </div>
              <div class="tm-ac-demo-actions">
                ${
                  d.analyzed
                    ? `<button type="button" class="btn btn-sm" data-ac-review="${escapeHtml(
                        d.id
                      )}">Review</button>`
                    : ''
                }
              </div>
            </div>`;
          })
          .join('')
      : '<p class="tm-note">No demos with this team name yet.</p>';

    const reviewPicker = reviewDemo
      ? `<div class="tm-ac-review-pick">
          <p>Review as</p>
          <div class="tm-ac-review-players">
            ${
              reviewPlayers
                .map((p) => {
                  const nMistakes = Number(p.total) || 0;
                  const label = nMistakes > 0 ? `${p.name} (${nMistakes})` : p.name;
                  return `<button type="button" class="btn btn-sm${
                    autocoachSelectedPlayer === p.id ? ' primary' : ''
                  }" data-ac-review-as="${escapeHtml(p.id)}" data-ac-review-demo="${escapeHtml(
                    reviewDemo.id
                  )}">${escapeHtml(label)}</button>`;
                })
                .join('') ||
              '<span class="tm-note">No players on this team in that demo.</span>'
            }
          </div>
          <button type="button" class="btn btn-sm" data-ac-review-cancel>Cancel</button>
        </div>`
      : '';

    return `
      ${headerHtml('')}
      <div class="tm-ac-layout">
        <section class="tm-card tm-ac-players">
          <div class="tm-card-head">
            <h3 class="tm-card-title">Players</h3>
            <span class="tm-ac-legend">total · avg/r · <span class="ok">✓</span> ack · <span class="deny">✗</span> deny</span>
          </div>
          <div class="tm-ac-player-list">${
            autocoachLoading ? spinnerHtml() : playerRows
          }</div>
        </section>
        ${focusPanel}
        <section class="tm-card tm-ac-demos">
          <div class="tm-card-head tm-ac-demos-head">
            <h3 class="tm-card-title">Games</h3>
            <div class="tm-ac-demo-toolbar">
              <button type="button" class="btn btn-sm primary" data-ac-analyze ${
                n <= 0 || autocoachBusy ? ' disabled' : ''
              }>Analyze (${n}) demos</button>
              <button type="button" class="btn btn-sm" data-ac-reset-selected ${
                selectedCount <= 0 || autocoachBusy ? ' disabled' : ''
              }>Reset selected (${selectedCount})</button>
              <button type="button" class="btn btn-sm" data-ac-reset-all ${
                analyzedCount <= 0 || autocoachBusy ? ' disabled' : ''
              }>Reset all</button>
            </div>
          </div>
          ${
            autocoachBusy
              ? `<p class="tm-note tm-ac-busy">${escapeHtml(autocoachBusy)}</p>`
              : ''
          }
          ${reviewPicker}
          <div class="tm-ac-demo-list">${autocoachLoading ? spinnerHtml() : demoRows}</div>
        </section>
      </div>`;
  }

  async function runAnalyzePending() {
    const pending = (autocoachSummary?.demos || []).filter((d) => !d.analyzed);
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i++) {
      const d = pending[i];
      // One metered use per demo, same as enabling coach in the viewer.
      if (!(await useMeteredFeature(CAP.DEMOS_AUTO_COACH, { host: shellEl }))) {
        if (i === 0) return;
        break;
      }
      autocoachBusy = `Analyzing ${i + 1}/${pending.length}: ${d.name1} vs ${d.name2}`;
      render();
      try {
        const wrapped = await fetchDemo(d.id);
        const demo = wrapped?.demo || wrapped;
        const list = (demo?.rounds || []).map((r) => ({
          ...r,
          map: demo.map,
          tickRate: r.tickRate || demo.tickRate
        }));
        if (!list.length) {
          setStatus(`No rounds in ${d.name1} vs ${d.name2}.`, true);
          continue;
        }
        await analyzeDemoCoach({
          demoId: d.id,
          side: d.side === 2 ? 2 : 1,
          rounds: list,
          onProgress: (msg) => {
            if (msg) {
              autocoachBusy = `${i + 1}/${pending.length}: ${msg}`;
              const el = shellEl.querySelector('.tm-ac-busy');
              if (el) el.textContent = autocoachBusy;
            }
          }
        });
        await markTeamAutocoachDemo(team.id, d.id, d.side === 2 ? 2 : 1);
      } catch (err) {
        setStatus(err.message || `Failed on ${d.id}`, true);
      }
    }
    autocoachBusy = '';
    await refreshAutocoach();
    render();
    setStatus('Autocoach analysis finished.');
  }

  async function runResetAutocoach({ all = false } = {}) {
    if (!team?.id || autocoachBusy) return;
    const demoIds = all ? [] : [...autocoachSelectedDemos];
    if (!all && !demoIds.length) return;
    const label = all
      ? 'Reset Autocoach on all analyzed demos? Coach notes for this team will be cleared.'
      : `Reset Autocoach on ${demoIds.length} selected demo${
          demoIds.length === 1 ? '' : 's'
        }? Coach notes will be cleared.`;
    if (!window.confirm(label)) return;
    autocoachBusy = all ? 'Resetting all analyses…' : `Resetting ${demoIds.length} demos…`;
    render();
    try {
      const res = await resetTeamAutocoachDemos(team.id, { demoIds, all });
      autocoachSummary = {
        players: res.players || [],
        demos: res.demos || [],
        unanalyzedCount: Number(res.unanalyzedCount) || 0
      };
      if (res.team) team = res.team;
      autocoachSelectedDemos = new Set();
      autocoachReviewDemoId = '';
      setStatus(
        `Reset ${res.reset || 0} demo${res.reset === 1 ? '' : 's'} (${res.cleared || 0} rounds cleared).`
      );
    } catch (err) {
      setStatus(err.message || 'Could not reset Autocoach.', true);
    } finally {
      autocoachBusy = '';
      render();
    }
  }

  async function openAutocoachReview(demoId, playerId) {
    const row = (autocoachSummary?.demos || []).find((d) => d.id === demoId);
    if (!row || !playerId) return;
    setStatus('Loading review…');
    try {
      const wrapped = await fetchDemo(demoId);
      const demo = wrapped?.demo || wrapped;
      const rounds = (demo?.rounds || []).map((r) => ({
        ...r,
        map: demo.map,
        tickRate: r.tickRate || demo.tickRate
      }));
      if (!rounds.length) {
        setStatus('That replay has no rounds yet.', true);
        return;
      }
      if (!viewerModule) {
        viewerModule = await import('../replays/viewer/viewerApp.js');
      }
      const playerName =
        (row.players || []).find((p) => p.id === playerId)?.name ||
        (autocoachSummary?.players || []).find((p) => p.id === playerId)?.name ||
        playerId;
      // Full match: notes are generated for the whole team, but the viewer
      // only shows the selected player's mistakes.
      viewerModule.openViewer({
        rounds,
        mode: 'timeline',
        title: `Autocoach · ${playerName}`,
        escapeHtml,
        statsDemoId: demoId,
        coachTeamId: team.id,
        coachForceSide: row.side === 2 ? 2 : 1,
        coachAutoEnable: true,
        coachReviewPlayerId: playerId
      });
      setStatus('');
    } catch (err) {
      setStatus(err.message || 'Could not open review.', true);
    }
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
            return `<td class="sb-cell-role"><div class="sb-role-wrap" data-sb-role-drag data-sb-id="${escapeHtml(
              s.id
            )}" data-sb-idx="${i}"><textarea class="sb-input sb-role-note" data-sb-field="roleNotes" data-sb-idx="${i}" data-sb-id="${escapeHtml(
              s.id
            )}" rows="1" maxlength="800" placeholder="Role" draggable="false">${escapeHtml(note)}</textarea></div></td>`;
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
              : noteWithUtilityLinks(s.description || '')
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
    const tas = [...row.querySelectorAll('textarea.sb-role-note')];
    tas.forEach((ta) => {
      ta.style.height = 'auto';
    });
    let maxH = 28;
    for (const ta of tas) maxH = Math.max(maxH, ta.scrollHeight);
    tas.forEach((ta) => {
      ta.style.height = `${maxH}px`;
    });
    const desc = row.querySelector('input[data-sb-field="description"]');
    if (desc) desc.style.height = `${maxH}px`;
  }

  function collapseStratRow(row) {
    if (!row || stratbookView === 'full') return;
    row.querySelectorAll('textarea.sb-role-note').forEach((ta) => {
      if (ta === document.activeElement) return;
      ta.style.height = '28px';
    });
    const desc = row.querySelector('input[data-sb-field="description"]');
    if (desc && desc !== document.activeElement) desc.style.height = '';
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

  function roleNotesCopy(s, minLen) {
    const notes = [...(s.roleNotes || [])].map((n) => String(n ?? ''));
    const need = Math.max(minLen, notes.length, 5);
    while (notes.length < need) notes.push('');
    return notes;
  }

  function roleNoteEl(id, idx) {
    return shellEl.querySelector(
      `textarea.sb-role-note[data-sb-id="${CSS.escape(id)}"][data-sb-idx="${idx}"]`
    );
  }

  function readRoleNote(id, idx, fallbackStrat) {
    const ta = roleNoteEl(id, idx);
    if (ta) return ta.value;
    return roleNotesCopy(fallbackStrat, idx + 1)[idx] || '';
  }

  function writeRoleNote(id, idx, value) {
    const ta = roleNoteEl(id, idx);
    if (!ta) return;
    ta.value = value;
    const row = ta.closest('tr.sb-row');
    if (row) expandStratRow(row);
  }

  function roleNoteFromWrap(wrap) {
    if (!wrap) return null;
    const id = wrap.dataset.sbId || '';
    const idx = Number(wrap.dataset.sbIdx);
    if (!id || Number.isNaN(idx)) return null;
    return { id, idx, wrap };
  }

  function roleDropWrapAt(x, y, sourceWrap) {
    const prev = sourceWrap.style.pointerEvents;
    sourceWrap.style.pointerEvents = 'none';
    const hit = document.elementFromPoint(x, y);
    sourceWrap.style.pointerEvents = prev;
    const drop =
      hit?.closest?.('[data-sb-role-drag]') ||
      hit?.closest?.('.sb-cell-role')?.querySelector('[data-sb-role-drag]');
    if (!drop || drop === sourceWrap) return null;
    if (drop.closest('table') !== sourceWrap.closest('table')) return null;
    return drop;
  }

  function setRoleDropTarget(drop) {
    shellEl.querySelectorAll('[data-sb-role-drag].is-drop-target').forEach((el) => {
      if (el !== drop) el.classList.remove('is-drop-target');
    });
    drop?.classList.add('is-drop-target');
  }

  async function applyRoleNoteDrag(from, to, duplicate) {
    if (!from || !to || !team?.isAdmin) return;
    if (from.id === to.id && from.idx === to.idx) return;
    const srcStrat = (team.stratbook || []).find((s) => s.id === from.id);
    const dstStrat = (team.stratbook || []).find((s) => s.id === to.id);
    if (!srcStrat || !dstStrat) return;
    const srcVal = readRoleNote(from.id, from.idx, srcStrat);
    const dstVal = readRoleNote(to.id, to.idx, dstStrat);
    const minLen = Math.max(from.idx, to.idx) + 1;

    if (from.id === to.id) {
      const notes = roleNotesCopy(srcStrat, minLen);
      notes[to.idx] = srcVal;
      if (!duplicate) notes[from.idx] = dstVal;
      writeRoleNote(to.id, to.idx, notes[to.idx]);
      if (!duplicate) writeRoleNote(from.id, from.idx, notes[from.idx]);
      await patchStrategy(from.id, { roleNotes: notes });
      return;
    }

    const srcNotes = roleNotesCopy(srcStrat, minLen);
    const dstNotes = roleNotesCopy(dstStrat, minLen);
    dstNotes[to.idx] = srcVal;
    writeRoleNote(to.id, to.idx, srcVal);
    if (!duplicate) {
      srcNotes[from.idx] = dstVal;
      writeRoleNote(from.id, from.idx, dstVal);
      await patchStrategy(from.id, { roleNotes: srcNotes });
    }
    await patchStrategy(to.id, { roleNotes: dstNotes });
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
        const href = strat2dHref(s.link2d);
        const nameHtml = href
          ? `<a class="ms-name-link" href="${escapeHtml(href)}"${
              href.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"'
            } title="Open 2D">${escapeHtml(name)}</a>`
          : escapeHtml(name);
        const noteHtml = noteWithUtilityLinks(note).replace(/\n/g, '<br />');
        return `
        <tr class="ms-row ms-${side.toLowerCase()}">
          <td class="ms-cell-name">${nameHtml}</td>
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
    if (page !== 'team-docs' || shareView || !team) clearDocsHeadActions();
    const onBoard = page === 'team-drawing-board' || page === 'team-utility-archive';
    const onOverview = page === 'team-overview';
    if (!onBoard) destroyBoardMount();
    if (!onOverview) destroyOverviewStats();
    if (page !== 'team-docs' && editor) {
      void editor.flush();
      editor.destroy();
      editor = null;
      mountedDocId = '';
    }
    if (!loaded) {
      if (editor && !shareView) {
        void editor.flush();
        editor.destroy();
        editor = null;
        mountedDocId = '';
      }
      shellEl.innerHTML = spinnerHtml();
      return;
    }
    // Guest (or member) viewing a /d/<code> link: keep the read-only surface.
    if (shareView) {
      if (sharedDoc && editor && editor.el?.isConnected) return;
      if (sharedDoc) {
        mountSharedEditor(sharedDoc);
        return;
      }
      return;
    }
    if (!signedIn()) {
      destroyBoardMount();
      destroyOverviewStats();
      if (editor) {
        editor.destroy();
        editor = null;
        mountedDocId = '';
      }
      shellEl.innerHTML = signedOutHtml(titleFor(page));
      return;
    }
    if (!team) {
      destroyBoardMount();
      destroyOverviewStats();
      if (editor) {
        editor.destroy();
        editor = null;
        mountedDocId = '';
      }
      shellEl.innerHTML = noTeamHtml();
      return;
    }
    if (page === 'team-docs') {
      // Re-homing the live editor avoids a blank flash (and caret loss) when
      // auth token refresh or another chrome update calls render() mid-edit.
      const live =
        editor && mountedDocId === openDocId && editor.el?.isConnected ? editor.el : null;
      let savedRange = null;
      const hadFocus = Boolean(live && live.contains(document.activeElement));
      if (live) {
        const sel = window.getSelection?.();
        if (sel?.rangeCount && live.contains(sel.anchorNode)) {
          try {
            savedRange = sel.getRangeAt(0).cloneRange();
          } catch {
            savedRange = null;
          }
        }
        live.remove();
      } else {
        editor?.destroy();
        editor = null;
        mountedDocId = '';
      }
      shellEl.innerHTML = documentsHtml();
      mountDocsHeadActions();
      if (live) {
        const host = shellEl.querySelector('#tm-doc-editor');
        if (host) {
          host.appendChild(live);
          refreshDocsChrome();
          if (hadFocus) {
            const surface = live.querySelector('#doc-surface');
            surface?.focus();
            if (savedRange) {
              const sel = window.getSelection?.();
              try {
                sel?.removeAllRanges();
                sel?.addRange(savedRange);
              } catch {
                /* range may be stale after a rare DOM rewrite */
              }
            }
          }
          return;
        }
        editor?.destroy();
        editor = null;
        mountedDocId = '';
      }
      void mountEditor();
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
    if (page === 'team-autocoach') {
      shellEl.innerHTML = autocoachHtml();
      if (!autocoachSummary && !autocoachLoading) {
        void refreshAutocoach().then(() => {
          if (page === 'team-autocoach') render();
        });
      }
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
        'team-utility-archive': 'Utility Archive',
        'team-autocoach': 'Matches'
      }[name] || 'Team'
    );
  }

  // ---- events -------------------------------------------------------------

  document.getElementById('page-head-actions')?.addEventListener('click', (e) => {
    if (page !== 'team-docs' || shareView) return;
    if (e.target.closest('[data-new-doc]')) void createDocument();
  });
  document.getElementById('page-head-actions')?.addEventListener('input', (e) => {
    const search = e.target.closest?.('[data-doc-search]');
    if (!search || page !== 'team-docs') return;
    docsQuery = search.value;
    paintDocsList();
  });

  shellEl.addEventListener('click', async (e) => {
    const t = e.target;

    if (t.closest('[data-ac-analyze]')) {
      void runAnalyzePending();
      return;
    }
    if (t.closest('[data-ac-reset-selected]')) {
      void runResetAutocoach({ all: false });
      return;
    }
    if (t.closest('[data-ac-reset-all]')) {
      void runResetAutocoach({ all: true });
      return;
    }
    const acSelect = t.closest('[data-ac-select]');
    if (acSelect) {
      const id = acSelect.dataset.acSelect || '';
      if (!id) return;
      // Checkbox state is already toggled when this click handler runs.
      if (acSelect.checked) autocoachSelectedDemos.add(id);
      else autocoachSelectedDemos.delete(id);
      const btn = shellEl.querySelector('[data-ac-reset-selected]');
      if (btn) {
        const count = autocoachSelectedDemos.size;
        btn.textContent = `Reset selected (${count})`;
        btn.disabled = count <= 0 || Boolean(autocoachBusy);
      }
      return;
    }
    const acPlayer = t.closest('[data-ac-player]');
    if (acPlayer) {
      const id = acPlayer.dataset.acPlayer || '';
      autocoachSelectedPlayer = autocoachSelectedPlayer === id ? '' : id;
      render();
      return;
    }
    const acReview = t.closest('[data-ac-review]');
    if (acReview) {
      autocoachReviewDemoId = acReview.dataset.acReview || '';
      render();
      return;
    }
    if (t.closest('[data-ac-review-cancel]')) {
      autocoachReviewDemoId = '';
      render();
      return;
    }
    const acReviewAs = t.closest('[data-ac-review-as]');
    if (acReviewAs) {
      const demoId = acReviewAs.dataset.acReviewDemo || '';
      const playerId = acReviewAs.dataset.acReviewAs || '';
      autocoachReviewDemoId = '';
      render();
      void openAutocoachReview(demoId, playerId);
      return;
    }

    const acPlaylist = t.closest('[data-ac-playlist]');
    if (acPlaylist) {
      await buildMistakePlaylist(acPlaylist.dataset.acPlaylist || '');
      return;
    }
    if (t.closest('[data-ac-digest]')) {
      await writeWeeklyDigest();
      return;
    }

    const uaCopy = t.closest('[data-ua-copy]');
    if (uaCopy) {
      if (uaCopy.tagName === 'BUTTON') e.preventDefault();
      void copyUtilityById(uaCopy.dataset.uaCopy || '');
      return;
    }

    const mapRow = t.closest('[data-tm-map]');
    if (mapRow) {
      selectOverviewMap(mapRow.dataset.tmMap || '');
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
    if (t.closest('[data-copy-doc-link]')) {
      const open = (team?.documents || []).find((d) => d.id === openDocId);
      const url = documentShareUrl(open?.shareId);
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        setStatus('Document link copied.');
      } catch {
        setStatus(url, true);
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

    // Roles page only — stats Side chips also use data-side and must not remount Overview.
    const side = page === 'team-roles' ? t.closest('[data-side]') : null;
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
      void createDocument();
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
      autocoachSummary = null;
      autocoachSelectedPlayer = '';
      autocoachReviewDemoId = '';
      render();
      return;
    }

    // Scoped to the select itself: a document widget mounts a
    // <div data-kind="util-map"> whose own controls would otherwise walk up
    // into this handler and be read as a member id.
    const kind = t.closest('select[data-kind]');
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

    const role = t.closest('select[data-role]');
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

    const pos = t.closest('select[data-pos]');
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
    const row = e.target.closest?.('tr.sb-row');
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
      const row = ta.closest('tr.sb-row');
      if (row) expandStratRow(row);
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
      const row = ta.closest('tr.sb-row');
      if (row) expandStratRow(row);
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
  // Role-note tiles: drag the box to swap, Shift+drop to copy.
  const ROLE_DRAG_PX = 6;
  let roleDragFrom = null;
  let roleDragCopy = false;
  let roleDragActive = false;
  let roleDragStart = null;

  function onRolePointerMove(e) {
    if (!roleDragStart || !roleDragFrom) return;
    if (!roleDragActive) {
      const dx = e.clientX - roleDragStart.x;
      const dy = e.clientY - roleDragStart.y;
      if (dx * dx + dy * dy < ROLE_DRAG_PX * ROLE_DRAG_PX) return;
      roleDragActive = true;
      roleDragFrom.wrap.classList.add('is-dragging');
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.getSelection()?.removeAllRanges?.();
    }
    e.preventDefault();
    roleDragCopy = Boolean(e.shiftKey);
    setRoleDropTarget(roleDropWrapAt(e.clientX, e.clientY, roleDragFrom.wrap));
  }

  function onRolePointerUp(e) {
    window.removeEventListener('pointermove', onRolePointerMove);
    window.removeEventListener('pointerup', onRolePointerUp);
    window.removeEventListener('pointercancel', onRolePointerCancel);
    if (!roleDragStart || !roleDragFrom) return;
    const from = roleDragFrom;
    const active = roleDragActive;
    const duplicate = Boolean(e.shiftKey || roleDragCopy);
    const drop = active ? roleDropWrapAt(e.clientX, e.clientY, from.wrap) : null;
    const to = drop ? roleNoteFromWrap(drop) : null;
    from.wrap.classList.remove('is-dragging');
    shellEl.querySelectorAll('[data-sb-role-drag].is-drop-target').forEach((el) => {
      el.classList.remove('is-drop-target');
    });
    roleDragFrom = null;
    roleDragCopy = false;
    roleDragActive = false;
    roleDragStart = null;
    if (!active || !to) return;
    void applyRoleNoteDrag(from, to, duplicate);
  }

  function onRolePointerCancel() {
    window.removeEventListener('pointermove', onRolePointerMove);
    window.removeEventListener('pointerup', onRolePointerUp);
    window.removeEventListener('pointercancel', onRolePointerCancel);
    roleDragFrom?.wrap?.classList.remove('is-dragging');
    shellEl.querySelectorAll('[data-sb-role-drag].is-drop-target').forEach((el) => {
      el.classList.remove('is-drop-target');
    });
    roleDragFrom = null;
    roleDragCopy = false;
    roleDragActive = false;
    roleDragStart = null;
  }

  shellEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !team?.isAdmin) return;
    const wrap = e.target.closest?.('[data-sb-role-drag]');
    if (!wrap) return;
    const from = roleNoteFromWrap(wrap);
    if (!from) return;
    roleDragStart = { x: e.clientX, y: e.clientY };
    roleDragFrom = from;
    roleDragActive = false;
    roleDragCopy = false;
    window.addEventListener('pointermove', onRolePointerMove, { passive: false });
    window.addEventListener('pointerup', onRolePointerUp);
    window.addEventListener('pointercancel', onRolePointerCancel);
  });

  shellEl.addEventListener('dragstart', (e) => {
    if (e.target.closest('[data-sb-role-drag]')) {
      e.preventDefault();
      return;
    }
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
    // Same signed-in user (e.g. JWT refresh while a doc autosaves): keep the
    // page mounted. A full reload remounts the docs editor and flashes blank.
    if (auth?.isLoggedIn && account.signedIn && auth.user?.id && auth.user.id === account.id) {
      return;
    }
    if (!auth?.isLoggedIn && !account.signedIn) return;
    // A public document link stays up across auth changes.
    if (openingShare || pendingShare || shareView) return;
    loaded = false;
    demosLoaded = false;
    loadInFlight = false;
    void load();
  });

  return {
    /** @param {{page?: string, invite?: string, share?: string}} params */
    onShow(params = {}) {
      const share = String(params.share || '').trim();
      if (share) {
        pendingShare = share;
        page = 'team-docs';
        if (openingShare) return;
        loaded = false;
        void load();
        return;
      }
      // Leaving a share landing for normal team pages.
      if (shareView && !share) {
        shareView = false;
        sharedDoc = null;
        editor?.destroy();
        editor = null;
        mountedDocId = '';
      }
      const next = PAGES.includes(params.page) ? params.page : 'team-overview';
      if (next !== page) {
        openVisibleMenu = '';
        stratbookSettingsOpen = false;
        if (page === 'team-docs' && next !== 'team-docs' && editor) {
          void editor.flush();
          editor.destroy();
          editor = null;
          mountedDocId = '';
        }
      }
      page = next;
      pendingUtilityFocus = {
        map: String(params.map || '').trim().toUpperCase(),
        throwId: String(params.u || params.throw || '')
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 4)
      };
      if (params.invite) pendingInvite = params.invite;
      void ents.ready();
      // Page switches must paint immediately. Overview keeps the first roster
      // fetch so nav never waits on the demo library. Documents / Stratbook /
      // My Strategies refetch so outside creates show up on enter.
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
      if (REFETCH_ON_SHOW.has(page)) void refreshTeam();
    },
    onHide() {
      if (shareView) return;
      clearDocsHeadActions();
      editor?.flush();
      editor?.destroy();
      editor = null;
      mountedDocId = '';
      destroyBoardMount();
    },
    /** Called by the router for /i/<code> landings. */
    setInvite(code) {
      pendingInvite = code;
    },
    /** Called by the router for /d/<code> landings. */
    setShare(code) {
      pendingShare = code;
    }
  };
}
