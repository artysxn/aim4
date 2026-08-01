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
  'team-strategies': sideTeamStrategies
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
let authMode = 'login';

function setAuthStatus(msg, ok = true) {
  const status = document.getElementById('auth-status');
  status.textContent = msg || '';
  status.classList.toggle('is-error', !ok);
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  const isReg = authMode === 'register';
  document.getElementById('auth-title').textContent = isReg ? 'Create account' : 'Sign in';
  document.getElementById('auth-submit').textContent = isReg ? 'Register' : 'Sign in';
  document.getElementById('auth-username-wrap').hidden = !isReg;
  document.getElementById('auth-confirm-wrap').hidden = !isReg;
  document.getElementById('auth-password').autocomplete = isReg ? 'new-password' : 'current-password';
  document.querySelectorAll('#auth-tabs .auth-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.authTab === authMode);
  });
  setAuthStatus('');
}

function openAuth(mode = 'login') {
  setAuthMode(mode);
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

document.getElementById('auth-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-auth-tab]');
  if (!tab) return;
  setAuthMode(tab.dataset.authTab);
});

document.getElementById('auth-google').addEventListener('click', async () => {
  setAuthStatus('Redirecting to Google…');
  try {
    await auth.signInWithGoogle();
  } catch (e) {
    setAuthStatus(e.message || 'Google sign-in failed.', false);
  }
});

document.getElementById('auth-submit').addEventListener('click', async () => {
  const username = document.getElementById('auth-username').value.trim();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value || '';
  const password2 = document.getElementById('auth-password2').value || '';
  setAuthStatus('…');
  try {
    if (authMode === 'register') {
      if (password !== password2) throw new Error('Passwords do not match.');
      const result = await auth.signUp({ username, email, password });
      if (result.pendingConfirmation) {
        setAuthStatus(`Check ${result.email} for a confirmation link, then sign in.`, true);
        setAuthMode('login');
        return;
      }
      setAuthStatus('Account created!', true);
    } else {
      await auth.signIn({ email, password });
      setAuthStatus('', true);
    }
    closeAuth();
  } catch (e) {
    setAuthStatus(e.message || 'Authentication failed.', false);
  }
});

document.getElementById('auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('auth-submit').click();
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
  charts: { title: 'Charts', path: '/charts', shell: 'replays', page: 'charts' },
  patterns: { title: 'Pattern Finder', path: '/patterns', shell: 'replays', page: 'analytics' },
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
  training: { title: 'Gamemodes', path: '/training', shell: 'training' },
  leaderboards: { title: 'Leaderboards', path: '/leaderboards', shell: 'leaderboards' },
  'replay-viewer': { title: 'Replay Viewer', path: '/replay-viewer', shell: 'replay-viewer' },
  football: { title: 'Football', path: '/football', shell: 'football' },
  tools: { title: 'Tools', path: '/tools', shell: 'tools' },
  routines: { title: 'Routines', path: '/routines', shell: 'routines' }
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
  viewControllers[shell]?.onShow?.(resolvedParams);
  window.scrollTo({ top: 0 });
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

if (inviteCode) {
  // Redeeming needs a signed-in account; the team view holds the code and
  // retries once auth lands, so a signed-out visitor can sign in in place.
  viewControllers.team?.setInvite?.(inviteCode);
  setView('team', false, { invite: inviteCode });
} else {
  setView(routeFromPath(), false, searchParams());
}
