// ---------------------------------------------------------------------------
// site.js
// Behavior for the aim4.io site shell (landing + tools hub): legacy-link
// redirects into the trainer, collapsible sidebar, and the tiny Home/Tools
// view router. The trainer itself lives at /train (train.html).
// ---------------------------------------------------------------------------

// site.css is linked from the HTML entries directly (no JS import — Vite
// treats a dual link+import reference as two different modules in dev).
import trainingIcon from '../icons/webmode_training.svg?raw';
import footballIcon from '../icons/webmode_football.svg?raw';
import toolsIcon from '../icons/webmode_tools.svg?raw';
import accountIcon from '../icons/icon_account.svg?raw';
import baselinesIcon from '../aim4/calendar_view_month_24dp_E3E3E3_FILL0_wght200_GRAD0_opsz24.svg?raw';

// ---- Legacy / auth redirects ----------------------------------------------
// The game used to live at "/". Lobby invites (?lobby=), replay shares
// (?replay=) and Supabase auth callbacks (?code= / #access_token=) must keep
// resolving into the trainer, which now owns /train.
{
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash || '';
  const isAuthCallback =
    params.has('code') || /access_token=|refresh_token=|error_description=/.test(hash);
  if (params.has('lobby') || params.has('replay') || params.has('server') || isAuthCallback) {
    window.location.replace('/train' + window.location.search + hash);
  }
}

// ---- Icons -----------------------------------------------------------------
// Inlined so CSS can tint them (fill: currentColor / var(--accent)).
const ICONS = {
  training: trainingIcon,
  football: footballIcon,
  tools: toolsIcon,
  account: accountIcon,
  baselines: baselinesIcon
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
      /* storage unavailable — session-only */
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

// ---- Home / Tools view router ----------------------------------------------
const VIEWS = {
  home: { title: 'Home', path: '/' },
  tools: { title: 'Tools', path: '/tools' }
};

function viewFromPath(pathname = window.location.pathname) {
  return pathname.replace(/\/+$/, '') === '/tools' ? 'tools' : 'home';
}

function setView(name, push = false) {
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
  document.title = view === 'home' ? 'AIM4.io' : `AIM4.io — ${VIEWS[view].title}`;
  if (push && window.location.pathname !== VIEWS[view].path) {
    window.history.pushState({ view }, '', VIEWS[view].path);
  }
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    setView(el.dataset.nav, true);
  });
});

window.addEventListener('popstate', () => setView(viewFromPath(), false));

setView(viewFromPath(), false);
