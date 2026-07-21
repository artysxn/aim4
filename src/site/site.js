// ---------------------------------------------------------------------------
// site.js
// Behavior for the aim4.io site shell: legacy-link redirects into the trainer,
// collapsible sidebar, account (sign in / register), and the view router for
// the site menus (Home, Training, Leaderboards, Football, Tools). The trainer
// itself lives at /train (train.html); gamemode deep links launch it directly.
// ---------------------------------------------------------------------------

// site.css is linked from the HTML entries directly (no JS import: Vite
// treats a dual link+import reference as two different modules in dev).
import trainingIcon from '../icons/webmode_training.svg?raw';
import footballIcon from '../icons/webmode_football.svg?raw';
import toolsIcon from '../icons/webmode_tools.svg?raw';
import accountIcon from '../icons/icon_account.svg?raw';
import leaderboardsIcon from '../icons/icon_leaderboards.svg?raw';
import { SettingsManager } from '../core/SettingsManager.js';
import { AuthManager } from '../core/AuthManager.js';
import { initTrainingView } from './trainingView.js';
import { initLeaderboardsView } from './leaderboardsView.js';
import { initFootballView } from './footballView.js';

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
  training: trainingIcon,
  football: footballIcon,
  tools: toolsIcon,
  account: accountIcon,
  leaderboards: leaderboardsIcon
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

// ---- View router ------------------------------------------------------------
const VIEWS = {
  home: { title: 'Home', path: '/' },
  training: { title: 'Training', path: '/training' },
  leaderboards: { title: 'Leaderboards', path: '/leaderboards' },
  football: { title: 'Football', path: '/football' },
  tools: { title: 'Tools', path: '/tools' }
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEWS).map(([name, v]) => [v.path, name])
);

function viewFromPath(pathname = window.location.pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return PATH_TO_VIEW[clean] || 'home';
}

let activeView = null;
const viewControllers = {};

function setView(name, push = false, params = null) {
  const view = VIEWS[name] ? name : 'home';
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll('.page-actions [data-for-view]').forEach((el) => {
    el.hidden = el.dataset.forView !== view;
  });
  document.querySelectorAll('[data-nav]').forEach((el) => {
    if (el.classList.contains('side-link')) {
      el.classList.toggle('active', el.dataset.nav === view);
    }
  });
  document.getElementById('page-title').textContent = VIEWS[view].title;
  document.title = view === 'home' ? 'AIM4.io' : `AIM4.io - ${VIEWS[view].title}`;
  if (push) {
    const search = params ? `?${new URLSearchParams(params)}` : '';
    const target = VIEWS[view].path + search;
    if (window.location.pathname + window.location.search !== target) {
      window.history.pushState({ view }, '', target);
    }
  }
  if (activeView && activeView !== view) {
    viewControllers[activeView]?.onHide?.();
  }
  activeView = view;
  viewControllers[view]?.onShow?.(params || Object.fromEntries(new URLSearchParams(window.location.search)));
  window.scrollTo({ top: 0 });
}

function openLeaderboards(mode) {
  setView('leaderboards', true, mode ? { mode } : null);
}

viewControllers.training = initTrainingView({ escapeHtml, openLeaderboards });
viewControllers.leaderboards = initLeaderboardsView({ auth, escapeHtml });
viewControllers.football = initFootballView({ auth, escapeHtml });

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    setView(el.dataset.nav, true);
  });
});

window.addEventListener('popstate', () => setView(viewFromPath(), false));

setView(viewFromPath(), false);
