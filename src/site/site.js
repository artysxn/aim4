// ---------------------------------------------------------------------------
// site.js
// Behavior for the aim4.io site shell: legacy-link redirects into the trainer,
// collapsible sidebar, account (sign in / register), and the view router for
// Analytics (demo tools) and Training. The trainer itself lives at /train
// (train.html); gamemode deep links launch it directly.
// ---------------------------------------------------------------------------

// site.css is linked from the HTML entries directly (no JS import: Vite
// treats a dual link+import reference as two different modules in dev).
import accountIcon from '../icons/icon_account.svg?raw';
import footballIcon from '../icons/webmode_football.svg?raw';
import toolsIcon from '../icons/webmode_tools.svg?raw';
import trainingIcon from '../icons/webmode_training.svg?raw';
import replaysIcon from '../icons/webmode_replays.svg?raw';
import sideDemoManager from '../icons/sideicons/sideicon_replays.svg?raw';
import sidePlaylists from '../icons/sideicons/sideicon_playlists.svg?raw';
import sideDatabase from '../icons/sideicons/sideicon_database.svg?raw';
import sideCharts from '../icons/sideicons/sideicon_charts.svg?raw';
import sideInspector from '../icons/sideicons/sideicon_inspector.svg?raw';
import sideUpload from '../icons/sideicons/sideicon_upload.svg?raw';
import sideGamemodes from '../icons/sideicons/sideicon_gamemodes.svg?raw';
import sideLeaderboards from '../icons/sideicons/sideicon_leaderboards.svg?raw';
import sideReplayViewer from '../icons/sideicons/sideicon_replayviewer.svg?raw';
import sideRoutines from '../icons/sideicons/sideicon_routines.svg?raw';
import sideTeam from '../icons/sideicons/sideicon_team.svg?raw';
import sideTeamDocs from '../icons/sideicons/sideicon_docs.svg?raw';
import sideTeamPositions from '../icons/sideicons/sideicon_positions.svg?raw';
import sideTeamStratbook from '../icons/sideicons/sideicon_stratbook.svg?raw';
import sideTeamStrategies from '../icons/sideicons/sideicon_my_strategies.svg?raw';
import sideTeamDrawingBoard from '../icons/sideicons/sideicon_drawing_board.svg?raw';
import sideTeamUtilityArchive from '../icons/sideicons/sideicon_utility_archive.svg?raw';
import sideTeamCreator from '../icons/sideicons/sideicon_2d_creator.svg?raw';
import logoFullUrl from '../icons/aim4logos/logocolor.png';
import logoMarkUrl from '../icons/aim4logos/logo1x1.png';
import { SettingsManager } from '../core/SettingsManager.js';
import { AuthManager } from '../core/AuthManager.js';
import { initTrainingView } from './trainingView.js';
import { initLeaderboardsView } from './leaderboardsView.js';
import { initFootballView } from './footballView.js';
import { initReplaysView } from './replaysView.js';
import { initReplayViewerView } from './replayViewerView.js';
import { initTeamView } from './teamView.js';
import { initStrategyCreatorView } from './strategyCreatorView.js';
import { initAccountView } from './account/accountView.js';
import { initAdminView } from './admin/adminView.js';
import { mountImpersonationBanner } from './admin/impersonate.js';
import { getEntitlements } from '../lib/entitlements.js';
import { upgradePrompt } from './upgradeGate.js';
import { accountApi } from './account/accountApi.js';
import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';

// Brand logos — Vite hashes these into /assets so Vercel serves them (the
// catch-all rewrite used to send /icons/* to train.html).
document.querySelectorAll('.side-logo-full, .hero-logo img, .foot-logo img').forEach((img) => {
  img.src = logoFullUrl;
});
document.querySelectorAll('.side-logo-mark').forEach((img) => {
  img.src = logoMarkUrl;
});

// ---- Legacy redirects -------------------------------------------------------
// The game used to live at "/". Lobby invites (?lobby=) and replay shares
// (?replay=) must keep resolving into the trainer, which now owns /train.
// Auth callbacks (?code= / #access_token=) are NOT redirected: sign-in lives
// on this page, so its own AuthManager below consumes them in place.
{
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash || '';
  if (params.has('lobby') || params.has('replay') || params.has('replayPath') || params.has('server')) {
    window.location.replace('/train' + window.location.search + hash);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- Icons -----------------------------------------------------------------
// Inlined so CSS can tint them (fill: currentColor / var(--accent)).
const ICONS = {
  account: accountIcon,
  football: footballIcon,
  tools: toolsIcon,
  training: trainingIcon,
  replays: replaysIcon,
  // Sidebar (sideicon_*.svg)
  'demo-manager': sideDemoManager,
  'demo-playlists': sidePlaylists,
  database: sideDatabase,
  charts: sideCharts,
  'pattern-inspector': sideInspector,
  uploads: sideUpload,
  gamemodes: sideGamemodes,
  leaderboards: sideLeaderboards,
  'replay-viewer': sideReplayViewer,
  routines: sideRoutines,
  team: sideTeam,
  'team-docs': sideTeamDocs,
  'team-positions': sideTeamPositions,
  'team-stratbook': sideTeamStratbook,
  'team-strategies': sideTeamStrategies,
  'team-drawing-board': sideTeamDrawingBoard,
  'team-utility-archive': sideTeamUtilityArchive,
  'team-creator': sideTeamCreator
};

document.querySelectorAll('[data-icon]').forEach((el) => {
  const svg = ICONS[el.dataset.icon];
  if (svg) el.innerHTML = svg;
});

// ---- Collapsible sidebar ----------------------------------------------------
const shell = document.getElementById('site-shell');
const collapseBtn = document.getElementById('side-collapse');
const COLLAPSE_KEY = 'aim4_site_sidebar_collapsed';

function setCollapsed(collapsed, persist = true) {
  shell.dataset.collapsed = collapsed ? 'true' : 'false';
  collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  collapseBtn.setAttribute('aria-label', collapseBtn.title);
  if (persist) {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable, session-only */
    }
  }
}

let initialCollapsed = window.matchMedia('(max-width: 760px)').matches;
try {
  const stored = localStorage.getItem(COLLAPSE_KEY);
  if (stored !== null) initialCollapsed = stored === '1';
} catch {
  /* storage unavailable */
}
setCollapsed(initialCollapsed, false);

collapseBtn.addEventListener('click', () => {
  setCollapsed(shell.dataset.collapsed !== 'true');
});

// ---- Account (sign in / register) -------------------------------------------
// Sign-in lives here, on the main site, and nowhere else: the trainer and
// football both read this same Supabase session (persisted in localStorage)
// instead of offering their own login forms.
const settings = new SettingsManager();
const auth = new AuthManager(settings);

const authModal = document.getElementById('auth-modal');
const sideAccountBtn = document.getElementById('side-account-btn');
const sideAccountName = document.getElementById('side-account-name');
const sideAccountHint = document.getElementById('side-account-hint');
function setAuthStatus(msg, ok = true) {
  const status = document.getElementById('auth-status');
  status.textContent = msg || '';
  status.classList.toggle('is-error', !ok);
}

/**
 * Google is the only provider. `mode` is still accepted because callers all
 * over the shell pass 'register', and there is now no difference between
 * signing in and signing up.
 */
function openAuth() {
  setAuthStatus('');
  authModal.hidden = false;
}

function closeAuth() {
  authModal.hidden = true;
}

document.getElementById('auth-modal-backdrop').addEventListener('click', closeAuth);
document.getElementById('auth-close').addEventListener('click', closeAuth);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !authModal.hidden) closeAuth();
});

document.getElementById('auth-google').addEventListener('click', async () => {
  setAuthStatus('Redirecting to Google…');
  try {
    await auth.signInWithGoogle();
  } catch (e) {
    setAuthStatus(e.message || 'Google sign-in failed.', false);
  }
});

// ---- Username picker --------------------------------------------------------
// A Google sign-in carries no username, so a first-run account gets a
// provisional player_<id> name and username_chosen = false. This modal blocks
// until a real one is set: no backdrop click, no escape, no close button.

const usernameModal = document.getElementById('username-modal');
const usernameInput = document.getElementById('username-input');
const usernameStatus = document.getElementById('username-status');
const usernameSubmit = document.getElementById('username-submit');

function syncUsernamePrompt() {
  if (!auth.ready) return;
  const needed = auth.needsUsername;
  usernameModal.hidden = !needed;
  if (needed) {
    closeAuth();
    usernameInput.focus();
  }
}

usernameSubmit.addEventListener('click', async () => {
  usernameStatus.textContent = '';
  usernameStatus.classList.remove('is-error');
  try {
    await auth.claimUsername(usernameInput.value);
    usernameModal.hidden = true;
  } catch (e) {
    usernameStatus.textContent = e.message || 'Could not set that username.';
    usernameStatus.classList.add('is-error');
  }
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') usernameSubmit.click();
});

// ---- Password account migration ---------------------------------------------
// Existing email/password accounts keep working. They are asked once, per
// browser, to link Google before the Email provider is turned off. Dismissible:
// this is a prompt, not a lockout, and the lockout only comes after a real
// deadline and an email.

const linkGoogleModal = document.getElementById('link-google-modal');
const linkGoogleStatus = document.getElementById('link-google-status');
const LINK_PROMPT_KEY = 'aim4.linkGooglePrompted';

function closeLinkGoogle() {
  linkGoogleModal.hidden = true;
  try {
    localStorage.setItem(LINK_PROMPT_KEY, '1');
  } catch {
    /* private browsing */
  }
}

document.getElementById('link-google-close').addEventListener('click', closeLinkGoogle);
document.getElementById('link-google-backdrop').addEventListener('click', closeLinkGoogle);

document.getElementById('link-google-btn').addEventListener('click', async () => {
  linkGoogleStatus.textContent = '';
  try {
    await auth.linkGoogle();
  } catch (e) {
    linkGoogleStatus.textContent = e.message || 'Could not link Google.';
    linkGoogleStatus.classList.add('is-error');
  }
});

function syncLinkGooglePrompt() {
  if (!auth.ready || !auth.isLoggedIn) return;
  let prompted = false;
  try {
    prompted = localStorage.getItem(LINK_PROMPT_KEY) === '1';
  } catch {
    prompted = false;
  }
  // Never over the username picker: one blocking decision at a time.
  if (prompted || auth.needsUsername || !auth.needsGoogleLink) return;
  linkGoogleModal.hidden = false;
}

auth.onChange(() => {
  syncUsernamePrompt();
  syncLinkGooglePrompt();
});

function syncAccountRow() {
  if (!auth.isConfigured) {
    sideAccountBtn.hidden = true;
    return;
  }
  if (auth.isLoggedIn) {
    sideAccountName.textContent = auth.displayName ? `@${auth.displayName}` : 'Signed in';
    sideAccountHint.textContent = 'Log out';
  } else {
    sideAccountName.textContent = 'Guest';
    sideAccountHint.textContent = 'Sign in';
  }
}

sideAccountBtn.addEventListener('click', () => {
  if (auth.isLoggedIn) {
    auth.signOut();
  } else {
    openAuth('login');
  }
});

auth.onChange(syncAccountRow);
syncAccountRow();
auth.init();

// ---- Clear auth tokens out of the address bar --------------------------------
// The OAuth redirect returns with #access_token=...&refresh_token=... in the
// URL. Supabase reads it, but it then sits in the address bar, in the tab
// title's history entry, and in the text of any browser console error that
// echoes location.href — which is a live credential in plain sight. Remove it
// once the session has been picked up.
function stripAuthFragment() {
  const hash = window.location.hash || '';
  if (!/(access_token|refresh_token|provider_token)=/.test(hash)) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Only after sign-in lands, so clearing the fragment can never cost the login.
auth.onChange(() => {
  if (auth.isLoggedIn) stripAuthFragment();
});
// And unconditionally a moment later, in case the sign-in failed: a token that
// did not work is still a token worth not leaving on screen.
setTimeout(stripAuthFragment, 4000);

// ---- View router ------------------------------------------------------------
// Each sidebar page owns a top-level path. Analytics tools share one shell
// panel (`data-view="replays"`) but are routed as separate URLs so switching
// never re-reads the previous pathname.

const ROUTES = {
  home: { title: 'Home', path: '/', shell: 'home' },
  demos: { title: 'Demo Manager', path: '/demos', shell: 'replays', page: 'library' },
  playlists: { title: 'Demo Playlists', path: '/playlists', shell: 'replays', page: 'playlists' },
  database: { title: 'Database', path: '/database', shell: 'replays', page: 'stats' },
  charts: {
    title: 'Charts',
    path: '/charts',
    shell: 'replays',
    page: 'charts',
    requires: 'analytics.charts'
  },
  patterns: {
    title: 'Pattern Finder',
    path: '/patterns',
    shell: 'replays',
    page: 'analytics',
    requires: 'analytics.pattern_finder'
  },
  uploads: { title: 'My Uploads', path: '/uploads', shell: 'replays', page: 'upload' },
  team: { title: 'Team', path: '/team', shell: 'team', page: 'team-overview' },
  'team-documents': {
    title: 'Documents',
    path: '/team/documents',
    shell: 'team',
    page: 'team-docs'
  },
  'team-roles': {
    title: 'Roles & Positions',
    path: '/team/roles',
    shell: 'team',
    page: 'team-roles'
  },
  'team-stratbook': {
    title: 'Stratbook Editor',
    path: '/team/stratbook',
    shell: 'team',
    page: 'team-stratbook'
  },
  'team-strategies': {
    title: 'My Strategies',
    path: '/team/strategies',
    shell: 'team',
    page: 'team-strategies'
  },
  'team-drawing-board': {
    title: 'Drawing Board',
    path: '/team/drawing-board',
    shell: 'team',
    page: 'team-drawing-board'
  },
  'team-utility-archive': {
    title: 'Utility Archive',
    path: '/team/utility-archive',
    shell: 'team',
    page: 'team-utility-archive'
  },
  'team-creator': {
    title: '2D Strategy Creator',
    path: '/team/creator',
    shell: 'strategy-creator'
  },
  training: { title: 'Gamemodes', path: '/training', shell: 'training' },
  leaderboards: { title: 'Leaderboards', path: '/leaderboards', shell: 'leaderboards' },
  'replay-viewer': { title: 'Replay Viewer', path: '/replay-viewer', shell: 'replay-viewer' },
  football: { title: 'Football', path: '/football', shell: 'football' },
  tools: { title: 'Tools', path: '/tools', shell: 'tools' },
  routines: { title: 'Routines', path: '/routines', shell: 'routines' },
  account: { title: 'My Account', path: '/account', shell: 'account' },
  'account-subscription': {
    title: 'Subscription',
    path: '/account/subscription',
    shell: 'account'
  },
  'account-teams': { title: 'Teams', path: '/account/teams', shell: 'account' },
  'account-data': { title: 'Data', path: '/account/data', shell: 'account' },
  'account-security': { title: 'Security', path: '/account/security', shell: 'account' },
  // The panel itself refuses to render until /api/admin/me returns 200, and the
  // API answers 404 to everyone else. This entry only stops the deep link from
  // falling through to the trainer.
  admin: { title: 'Admin', path: '/admin', shell: 'admin' }
};

/** Old /replays/* bookmarks → new top-level paths. */
const LEGACY_PATHS = {
  '/replays': '/demos',
  '/replays/playlists': '/playlists',
  '/replays/stats': '/database',
  '/replays/charts': '/charts',
  '/replays/analytics': '/patterns',
  '/replays/upload': '/uploads'
};

const PATH_TO_ROUTE = Object.fromEntries(
  Object.entries(ROUTES).map(([name, r]) => [r.path, name])
);

const PAGE_TO_ROUTE = Object.fromEntries(
  Object.entries(ROUTES)
    .filter(([, r]) => r.page)
    .map(([name, r]) => [r.page, name])
);

function cleanPath(pathname = window.location.pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function routeFromPath(pathname = window.location.pathname) {
  const clean = cleanPath(pathname);
  if (LEGACY_PATHS[clean]) {
    return PATH_TO_ROUTE[LEGACY_PATHS[clean]] || 'home';
  }
  return PATH_TO_ROUTE[clean] || 'home';
}

function searchParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/** Rewrite legacy /replays/* URLs once on load (keeps query string). */
{
  const clean = cleanPath();
  const next = LEGACY_PATHS[clean];
  if (next) {
    window.history.replaceState(null, '', next + window.location.search + window.location.hash);
  }
}

/**
 * Team invites land on aim4.io/i/<code>. The code is lifted into a query param
 * and the URL rewritten to /team, so a refresh after joining does not try to
 * redeem the same invite twice.
 */
let inviteCode = '';
{
  const m = cleanPath().match(/^\/i\/([A-Za-z0-9]{4,16})$/);
  if (m) {
    inviteCode = m[1];
    window.history.replaceState(null, '', '/team');
  }
}

/**
 * A shared 2D round lands on aim4.io/s2/<code>. Keep the code in the query
 * string after rewriting so a refresh / auth race cannot lose it — the creator
 * view reads `?share=` the same way onShow gets it from setView.
 */
let sharedRoundCode = '';
{
  const m = cleanPath().match(/^\/s2\/([A-Za-z0-9_-]{6,32})$/);
  if (m) {
    sharedRoundCode = m[1];
    window.history.replaceState(
      null,
      '',
      `/team/creator?share=${encodeURIComponent(sharedRoundCode)}`
    );
  }
}

let activeRoute = null;
let activeShell = null;
const viewControllers = {};

function syncSideNav(routeName) {
  document.querySelectorAll('.side-link[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === routeName);
  });
}

/**
 * @param {string} name  ROUTES key
 * @param {boolean} [push]
 * @param {object|null} [params]  extra query params (round, mode, …)
 */
function setView(name, push = false, params = null) {
  const routeName = ROUTES[name] ? name : 'home';
  const route = ROUTES[routeName];
  const shell = route.shell;
  const resolvedParams = { ...(params || searchParams()) };
  if (route.page) resolvedParams.page = route.page;
  else delete resolvedParams.page;

  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === shell);
  });
  syncSideNav(routeName);

  document.getElementById('page-title').textContent = route.title;
  document.title = routeName === 'home' ? 'AIM4.io' : `AIM4.io - ${route.title}`;

  if (push) {
    const q = { ...resolvedParams };
    delete q.page;
    const search = Object.keys(q).length ? `?${new URLSearchParams(q)}` : '';
    const target = route.path + search;
    if (window.location.pathname + window.location.search !== target) {
      window.history.pushState({ route: routeName }, '', target);
    }
  }

  if (activeShell && activeShell !== shell) {
    viewControllers[activeShell]?.onHide?.();
  }
  activeRoute = routeName;
  activeShell = shell;
  // A view that throws on entry must not take the router down with it. Without
  // this, one bad onShow leaves the history entry pushed and the shell swapped
  // but the gate unapplied, and the next Back or nav click throws again from
  // the same place: the site looks stuck on a page it has already left.
  try {
    viewControllers[shell]?.onShow?.(resolvedParams);
  } catch (err) {
    console.error(`[router] ${routeName} failed to open`, err);
  }
  applyRouteGate(route, shell);
  window.scrollTo({ top: 0 });
}

/**
 * Show the upgrade prompt above a gated page.
 *
 * The page still renders. Redirecting away from a paid feature is a bad
 * conversion surface and it breaks shared links: someone following a colleague's
 * link to a chart should land on the chart and be told what unlocks it, not be
 * bounced to the home page with no explanation.
 */
function applyRouteGate(route, shell) {
  const host = document.querySelector(`.view[data-view="${shell}"]`);
  if (!host) return;
  host.querySelector(':scope > .upgrade-gate')?.remove();
  if (!route.requires) return;

  const show = () => {
    host.querySelector(':scope > .upgrade-gate')?.remove();
    if (activeRoute !== PATH_TO_ROUTE[route.path]) return;
    if (entitlements.can(route.requires)) return;
    const tier = entitlements.requiredPlan(route.requires);
    host.prepend(
      upgradePrompt({
        message: `${entitlements.label(route.requires)} is available on ${
          PLAN_NAMES[tier] || tier
        }.`,
        requiredTier: tier,
        trialOffer: entitlements.trialOffer,
        onTrial: startTrialFromGate
      })
    );
  };

  // Entitlements may not have landed yet on a cold load, so render once now and
  // again when they arrive rather than flashing a lock at a paying user.
  show();
  entitlements.ready().then(show);
}

async function startTrialFromGate() {
  try {
    await accountApi.startTrial();
    await entitlements.refresh();
    setView(activeRoute, false, searchParams());
  } catch (e) {
    window.alert(e.message || 'Could not start the trial.');
  }
}

function openLeaderboards(mode) {
  setView('leaderboards', true, mode ? { mode } : null);
}

function openProfile(userId, username = 'Player') {
  if (!userId) return;
  setView('replay-viewer', true, { user: userId, name: username });
}

viewControllers.training = initTrainingView({ escapeHtml, openLeaderboards });
viewControllers.leaderboards = initLeaderboardsView({ auth, escapeHtml, openProfile });
viewControllers.football = initFootballView({ auth, escapeHtml });
viewControllers['replay-viewer'] = initReplayViewerView({
  auth,
  escapeHtml,
  openSelf: () => setView('replay-viewer', true, {})
});
viewControllers.team = initTeamView({ auth, escapeHtml });
viewControllers['strategy-creator'] = initStrategyCreatorView({ auth, escapeHtml });
// One manager per page, refreshed whenever the session changes. Gates read it
// for UI state only; the server has already made every decision it reflects.
const entitlements = getEntitlements(auth);
entitlements.refresh();

viewControllers.account = initAccountView(
  document.querySelector('.view[data-view="account"]'),
  { auth }
);
viewControllers.admin = initAdminView(document.querySelector('.view[data-view="admin"]'));

// A "view as" session must be unmissable on every page, not only on /admin.
mountImpersonationBanner();

viewControllers.replays = initReplaysView({
  auth,
  escapeHtml,
  pathForPage(page) {
    return ROUTES[PAGE_TO_ROUTE[page]]?.path || '/demos';
  },
  onNavigate(page, params = {}) {
    const routeName = PAGE_TO_ROUTE[page] || 'demos';
    setView(routeName, true, params);
  }
});

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    // Sidebar clicks start a fresh route — don't carry ?user= / ?mode= from the previous page.
    setView(el.dataset.nav, true, {});
  });
});

auth.onChange(() => {
  if (activeShell === 'replay-viewer') {
    viewControllers['replay-viewer']?.onShow?.(searchParams());
  }
});

window.addEventListener('popstate', () => setView(routeFromPath(), false, searchParams()));

if (sharedRoundCode) {
  viewControllers['strategy-creator']?.setShare?.(sharedRoundCode);
  setView('team-creator', false, { share: sharedRoundCode });
} else if (inviteCode) {
  // Redeeming needs a signed-in account; the team view holds the code and
  // retries once auth lands, so a signed-out visitor can sign in in place.
  viewControllers.team?.setInvite?.(inviteCode);
  setView('team', false, { invite: inviteCode });
} else {
  setView(routeFromPath(), false, searchParams());
}
