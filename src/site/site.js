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
import { SettingsManager } from '../core/SettingsManager.js';
import { AuthManager } from '../core/AuthManager.js';
import { initTrainingView } from './trainingView.js';
import { initLeaderboardsView } from './leaderboardsView.js';
import { initFootballView } from './footballView.js';
import { initReplaysView } from './replaysView.js';
import { initProfileModal } from './profileModal.js';

// ---- Legacy redirects -------------------------------------------------------
// The game used to live at "/". Lobby invites (?lobby=) and replay shares
// (?replay=) must keep resolving into the trainer, which now owns /train.
// Auth callbacks (?code= / #access_token=) are NOT redirected: sign-in lives
// on this page, so its own AuthManager below consumes them in place.
{
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash || '';
  if (params.has('lobby') || params.has('replay') || params.has('server')) {
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
  routines: sideRoutines
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
const VIEWS = {
  home: { title: 'Home', path: '/' },
  training: { title: 'Gamemodes', path: '/training' },
  replays: { title: 'Demo Manager', path: '/replays' },
  leaderboards: { title: 'Leaderboards', path: '/leaderboards' },
  football: { title: 'Football', path: '/football' },
  tools: { title: 'Tools', path: '/tools' },
  routines: { title: 'Routines', path: '/routines' }
};

const RP_SUBPAGES = {
  library: { title: 'Demo Manager', path: '/replays', flag: null },
  playlists: { title: 'Demo Playlists', path: '/replays/playlists', flag: 'playlists' },
  stats: { title: 'Database', path: '/replays/stats', flag: 'stats' },
  analytics: { title: 'Pattern Finder', path: '/replays/analytics', flag: 'analytics' },
  charts: { title: 'Charts', path: '/replays/charts', flag: 'charts' },
  upload: { title: 'Uploads & Storage', path: '/replays/upload', flag: 'upload' }
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEWS).map(([name, v]) => [v.path, name])
);

function viewFromPath(pathname = window.location.pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean.startsWith('/replays/')) return 'replays';
  return PATH_TO_VIEW[clean] || 'home';
}

function rpFromParams(params = {}, pathname = window.location.pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (params.playlists === '1' || params.playlists === true || clean === '/replays/playlists') {
    return 'playlists';
  }
  if (params.upload === '1' || params.upload === true || clean === '/replays/upload') {
    return 'upload';
  }
  if (params.stats === '1' || params.stats === true || clean === '/replays/stats') {
    return 'stats';
  }
  if (params.analytics === '1' || params.analytics === true || clean === '/replays/analytics') {
    return 'analytics';
  }
  if (params.charts === '1' || params.charts === true || clean === '/replays/charts') {
    return 'charts';
  }
  return 'library';
}

function paramsFromPath(pathname = window.location.pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const fromSearch = Object.fromEntries(new URLSearchParams(window.location.search));
  if (clean === '/replays/playlists') return { ...fromSearch, playlists: '1' };
  if (clean === '/replays/upload') return { ...fromSearch, upload: '1' };
  if (clean === '/replays/stats') return { ...fromSearch, stats: '1' };
  if (clean === '/replays/analytics') return { ...fromSearch, analytics: '1' };
  if (clean === '/replays/charts') return { ...fromSearch, charts: '1' };
  return fromSearch;
}

function paramsForRp(rp) {
  const flag = RP_SUBPAGES[rp]?.flag;
  return flag ? { [flag]: '1' } : {};
}

let activeView = null;
let activeRp = 'library';
const viewControllers = {};

function syncSideNav(view, rp = 'library') {
  document.querySelectorAll('.side-link[data-nav]').forEach((el) => {
    const nav = el.dataset.nav;
    if (nav === 'replays' && el.dataset.rp) {
      el.classList.toggle('active', view === 'replays' && el.dataset.rp === rp);
      return;
    }
    el.classList.toggle('active', nav === view && !el.dataset.rp);
  });
}

function setView(name, push = false, params = null) {
  const view = VIEWS[name] ? name : 'home';
  const resolvedParams = params || paramsFromPath();
  const rp = view === 'replays' ? rpFromParams(resolvedParams) : 'library';
  activeRp = rp;

  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  syncSideNav(view, rp);

  const title =
    view === 'replays' ? RP_SUBPAGES[rp]?.title || VIEWS.replays.title : VIEWS[view].title;
  document.getElementById('page-title').textContent = title;
  document.title = view === 'home' ? 'AIM4.io' : `AIM4.io - ${title}`;

  if (push) {
    const pathParams = { ...resolvedParams };
    delete pathParams.playlists;
    delete pathParams.upload;
    delete pathParams.stats;
    delete pathParams.analytics;
    delete pathParams.charts;
    const search = Object.keys(pathParams).length
      ? `?${new URLSearchParams(pathParams)}`
      : '';
    const base = view === 'replays' ? RP_SUBPAGES[rp].path : VIEWS[view].path;
    const target = base + search;
    if (window.location.pathname + window.location.search !== target) {
      window.history.pushState({ view, rp }, '', target);
    }
  }
  if (activeView && activeView !== view) {
    viewControllers[activeView]?.onHide?.();
  }
  activeView = view;
  viewControllers[view]?.onShow?.(resolvedParams);
  window.scrollTo({ top: 0 });
}

function openLeaderboards(mode) {
  setView('leaderboards', true, mode ? { mode } : null);
}

const { openProfile } = initProfileModal({ escapeHtml });

viewControllers.training = initTrainingView({ escapeHtml, openLeaderboards });
viewControllers.leaderboards = initLeaderboardsView({ auth, escapeHtml, openProfile });
viewControllers.football = initFootballView({ auth, escapeHtml });
viewControllers.replays = initReplaysView({
  auth,
  escapeHtml,
  onSubpage(rp) {
    activeRp = rp;
    syncSideNav('replays', rp);
    const title = RP_SUBPAGES[rp]?.title || VIEWS.replays.title;
    document.getElementById('page-title').textContent = title;
    document.title = `AIM4.io - ${title}`;
  }
});

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const nav = el.dataset.nav;
    if (nav === 'replays' && el.dataset.rp) {
      setView('replays', true, paramsForRp(el.dataset.rp));
      return;
    }
    setView(nav, true);
  });
});

window.addEventListener('popstate', () =>
  setView(viewFromPath(), false, paramsFromPath())
);

setView(viewFromPath(), false, paramsFromPath());
