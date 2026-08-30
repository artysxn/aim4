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
import logoGoogle from '../icons/logo_google.svg?raw';
import logoSteam from '../icons/logo_steam.svg?raw';
import logoDiscord from '../icons/logo_discord.svg?raw';
import logoX from '../icons/logo_x.svg?raw';
import footballIcon from '../icons/webmode_football.svg?raw';
import toolsIcon from '../icons/webmode_tools.svg?raw';
import trainingIcon from '../icons/webmode_training.svg?raw';
import replaysIcon from '../icons/webmode_replays.svg?raw';
import pfPlayers from '../icons/patternfinder/patternfinder_players.svg?raw';
import pfAntistrat from '../icons/patternfinder/patternfinder_antistrat.svg?raw';
import pfExplore from '../icons/patternfinder/patternfinder_explore.svg?raw';
import pfMeta from '../icons/patternfinder/patternfinder_meta.svg?raw';
import pfSearch from '../icons/patternfinder/patternfinder_search.svg?raw';
import sideDemoManager from '../icons/sideicons/sideicon_replays.svg?raw';
import sidePlaylists from '../icons/sideicons/sideicon_playlists.svg?raw';
import sideDatabase from '../icons/sideicons/sideicon_database.svg?raw';
import sideCharts from '../icons/sideicons/sideicon_charts.svg?raw';
import sideInspector from '../icons/sideicons/sideicon_inspector.svg?raw';
import sideUpload from '../icons/sideicons/sideicon_upload.svg?raw';
import sidePerformance from '../icons/sideicons/sideicon_performance.svg?raw';
import sideGamemodes from '../icons/sideicons/sideicon_gamemodes.svg?raw';
import sideLeaderboards from '../icons/sideicons/sideicon_leaderboards.svg?raw';
import sideReplayViewer from '../icons/sideicons/sideicon_replayviewer.svg?raw';
import sideRoutines from '../icons/sideicons/sideicon_routines.svg?raw';
import sideAchievements from '../icons/sideicons/sideicon_achievements.svg?raw';
import sideMapPractice from '../icons/sideicons/sideicon_map_practice.svg?raw';
import sideTeam from '../icons/sideicons/sideicon_team.svg?raw';
import sideTeamDocs from '../icons/sideicons/sideicon_docs.svg?raw';
import sideTeamPositions from '../icons/sideicons/sideicon_positions.svg?raw';
import sideTeamStratbook from '../icons/sideicons/sideicon_stratbook.svg?raw';
import sideTeamStrategies from '../icons/sideicons/sideicon_my_strategies.svg?raw';
import sideTeamDrawingBoard from '../icons/sideicons/sideicon_drawing_board.svg?raw';
import sideTeamUtilityArchive from '../icons/sideicons/sideicon_utility_archive.svg?raw';
import sideTeamCoach from '../icons/sideicons/sideicon_teamreplays.svg?raw';
import sideTeamComms from '../icons/sideicons/sideicon_comms.svg?raw';
import sideTeamCreator from '../icons/sideicons/sideicon_2d_creator.svg?raw';
import logoFullUrl from '../icons/aim4logos/logocolor.png';
import logoMarkUrl from '../icons/aim4logos/logo1x1.png';
import { SettingsManager } from '../core/SettingsManager.js';
import { bindColumnPrefs } from '../replays/stats/columnPrefs.js';
import { AuthManager } from '../core/AuthManager.js';
import { initTrainingView } from './trainingView.js';
import { initMapPracticeView } from './mapPracticeView.js';
import { initLeaderboardsView } from './leaderboardsView.js';
import { initFootballView } from './footballView.js';
import { initPlayerProfileView } from './playerProfileView.js';
import { initHomeView } from './homeView.js';
import { initChangelogView } from './changelogView.js';
import { initDocsView } from './docsView.js';
import { initContactView } from './contactView.js';
import { initPrivacyView, initTermsView } from './legalView.js';
import { initNotifications } from './notify.js';
import { initIntegrity } from './integrity.js';
import { initAccountView } from './account/accountView.js';
import { getEntitlements } from '../lib/entitlements.js';
import { upgradePrompt } from './upgradeGate.js';
import { accountApi } from './account/accountApi.js';
import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';
import { initIngestReminder } from './ingestReminder.js';
import {
  isMobileSite,
  isPhoneDevice,
  viewSwitchUrl,
  addFooterViewSwitch,
  initMobileChrome,
  initMobileFilterToggle
} from './mobileMode.js';

/**
 * Defer heavy view modules until first visit so Home/Training boot stays light
 * and the sidebar stays clickable during import.
 * @param {() => Promise<object>} factory
 */
function lazyController(factory) {
  let ctrl = null;
  /** @type {Promise<object> | null} */
  let loading = null;
  const ensure = () => {
    if (ctrl) return Promise.resolve(ctrl);
    if (!loading) {
      loading = Promise.resolve()
        .then(factory)
        .then((c) => {
          ctrl = c || {};
          return ctrl;
        })
        .catch((err) => {
          loading = null;
          throw err;
        });
    }
    return loading;
  };
  return {
    async onShow(params) {
      const c = await ensure();
      return c.onShow?.(params);
    },
    onHide() {
      ctrl?.onHide?.();
    }
  };
}

// The mobile layout. The inline script in index.html has already resolved it
// from the device and the saved preference, and set <html data-mobile="1">,
// by the time modules run.
const IS_MOBILE = isMobileSite();

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
    if (IS_MOBILE) {
      // The trainer is desktop only; drop its params instead of bouncing
      // through /train and straight back here.
      for (const k of ['lobby', 'replay', 'replayPath', 'server']) params.delete(k);
      const rest = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    } else {
      window.location.replace('/train' + window.location.search + hash);
    }
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
  performance: sidePerformance,
  'pattern-inspector': sideInspector,
  'pf-players': pfPlayers,
  'pf-antistrat': pfAntistrat,
  'pf-explore': pfExplore,
  'pf-meta': pfMeta,
  'pf-search': pfSearch,
  uploads: sideUpload,
  gamemodes: sideGamemodes,
  leaderboards: sideLeaderboards,
  'replay-viewer': sideReplayViewer,
  routines: sideRoutines,
  achievements: sideAchievements,
  'map-practice': sideMapPractice,
  team: sideTeam,
  'team-docs': sideTeamDocs,
  'team-positions': sideTeamPositions,
  'team-stratbook': sideTeamStratbook,
  'team-strategies': sideTeamStrategies,
  'team-drawing-board': sideTeamDrawingBoard,
  'team-utility-archive': sideTeamUtilityArchive,
  'team-autocoach': sideTeamCoach,
  'team-comms': sideTeamComms,
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

// ---- Mobile layout ----------------------------------------------------------
// In the mobile layout the sidebar is a drawer and the trainer has no entry
// points: gamemodes need a mouse and pointer lock, so it drops the sidebar
// link, home card, hero button and footer links, and /training explains
// instead of launching. Everything else keeps working.
if (IS_MOBILE) {
  document.body.classList.add('is-mobile-site');
  setCollapsed(false, false);
  initMobileChrome({ shell });
  initMobileFilterToggle();

  // Map Practice goes with them: the 3D explorer is WASD and pointer lock.
  document
    .querySelectorAll(
      '.side-link[data-nav="training"], .site-card[data-nav="training"], ' +
        '.side-link[data-nav="map-practice"]'
    )
    .forEach((el) => el.remove());
  document
    .querySelectorAll('.site-footer a[href="/train"], .site-footer a[href="/training"]')
    .forEach((el) => el.remove());

  const heroActions = document.querySelector('.hero-actions');
  if (heroActions) {
    heroActions.innerHTML = `
      <a class="btn primary btn-lg" href="/demos" data-nav="demos">Demo Manager</a>
      <a class="btn btn-lg" href="/leaderboards" data-nav="leaderboards">Leaderboards</a>`;
  }

  const trainingPad = document.querySelector('.view[data-view="training"] .view-pad');
  if (trainingPad) {
    trainingPad.innerHTML = `
      <div class="mobile-desktop-only">
        <h3>Aim training is desktop only</h3>
        <p>Play needs a mouse and pointer lock.</p>
        <a class="btn" href="${viewSwitchUrl('desktop')}">Use the desktop site</a>
      </div>`;
  }
} else if (isPhoneDevice()) {
  // A phone that asked for the desktop layout keeps it, on this device and in
  // this browser, until it switches back from here.
  addFooterViewSwitch('mobile', 'Mobile site');
}

// ---- Account (sign in / register) -------------------------------------------
// Sign-in lives here, on the main site, and nowhere else: the trainer and
// football both read this same Supabase session (persisted in localStorage)
// instead of offering their own login forms.
const settings = new SettingsManager();
const auth = new AuthManager(settings);
// Database column choices ride the same per-account settings blob AuthManager
// already syncs, so a signed-in account keeps its columns across devices.
bindColumnPrefs(settings);

const authModal = document.getElementById('auth-modal');
const sideAccountBtn = document.getElementById('side-account-btn');
const sideAccountName = document.getElementById('side-account-name');
const sideAccountHint = document.getElementById('side-account-hint');
function setAuthStatus(msg, ok = true) {
  const status = document.getElementById('auth-status');
  status.textContent = msg || '';
  status.classList.toggle('is-error', !ok);
}

const authIdentifier = document.getElementById('auth-identifier');
const authPassword = document.getElementById('auth-password');
const authSubmit = document.getElementById('auth-submit');
const authTitle = document.getElementById('auth-title');
const authIdentifierLabel = document.getElementById('auth-identifier-label');
const authRegisterNote = document.getElementById('auth-register-note');
const authSwitchText = document.getElementById('auth-switch-text');
const authSwitchBtn = document.getElementById('auth-switch-btn');

/**
 * Three ways in: Google, a username and password, or a brand-new username
 * account. `authMode` flips the same form between the last two — same fields,
 * different endpoint — because a second modal would be the same modal twice.
 */
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  setAuthStatus('');
  if (authTitle) authTitle.textContent = registering ? 'Create account' : 'Sign in';
  if (authIdentifierLabel) authIdentifierLabel.textContent = registering ? 'Username' : 'Username or email';
  if (authSubmit) authSubmit.textContent = registering ? 'Create account' : 'Sign in';
  if (authRegisterNote) authRegisterNote.hidden = !registering;
  if (authSwitchText) authSwitchText.textContent = registering ? 'Already have an account?' : 'New here?';
  if (authSwitchBtn) authSwitchBtn.textContent = registering ? 'Sign in' : 'Create an account';
  // The browser's password tooling should offer to SAVE a new password here,
  // not fill an old one.
  authPassword?.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
  authIdentifier?.setAttribute('autocomplete', registering ? 'off' : 'username');
}

function openAuth(mode = 'login') {
  setAuthMode(mode === 'register' ? 'register' : 'login');
  if (authIdentifier) authIdentifier.value = '';
  if (authPassword) authPassword.value = '';
  authModal.hidden = false;
  // Focus the field someone typing a password is heading for anyway. Deferred
  // because the modal is still hidden as this runs.
  requestAnimationFrame(() => authIdentifier?.focus());
}

authSwitchBtn?.addEventListener('click', () => {
  setAuthMode(authMode === 'register' ? 'login' : 'register');
  requestAnimationFrame(() => authIdentifier?.focus());
});

function closeAuth() {
  authModal.hidden = true;
  if (authPassword) authPassword.value = '';
}

document.getElementById('auth-modal-backdrop').addEventListener('click', closeAuth);
document.getElementById('auth-close').addEventListener('click', closeAuth);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !authModal.hidden) closeAuth();
});

// The brand marks, from the same icon files the rest of the site imports.
const PROVIDER_ICONS = {
  google: logoGoogle,
  steam: logoSteam,
  discord: logoDiscord,
  x: logoX
};
for (const slot of document.querySelectorAll('[data-provider-icon]')) {
  const svg = PROVIDER_ICONS[slot.dataset.providerIcon];
  if (svg) slot.innerHTML = svg;
}

// Everything Supabase brokers goes through one handler. Steam is separate
// below because it is our own OpenID flow, not a Supabase provider.
// 'x' is Supabase's OAuth 2.0 provider id; 'twitter' is the LEGACY OAuth 1.0a
// one. Enabling "X (OAuth 2.0)" in the dashboard turns on 'x' only, so sending
// 'twitter' answers "provider is not enabled" no matter what is enabled.
const OAUTH_BUTTONS = [
  ['auth-google', 'google', 'Google'],
  ['auth-discord', 'discord', 'Discord'],
  ['auth-x', 'x', 'X']
];
for (const [id, provider, label] of OAUTH_BUTTONS) {
  document.getElementById(id)?.addEventListener('click', async () => {
    setAuthStatus(`Redirecting to ${label}…`);
    try {
      await auth.signInWithProvider(provider);
    } catch (e) {
      setAuthStatus(e.message || `${label} sign-in failed.`, false);
    }
  });
}

/**
 * What ?steam_error=<code> from the sign-in callback means, in words. Mirrors
 * SIGNIN_ERRORS in server/account/steamAuth.js, the way tabs.js mirrors the
 * link flow's copy: the server module cannot be imported into the bundle.
 */
const STEAM_SIGNIN_ERRORS = {
  expired: 'That Steam sign-in expired. Try again.',
  cancelled: 'Steam sign-in was cancelled.',
  invalid: 'Steam did not confirm that sign-in.',
  unreachable: 'Steam could not be reached. Try again in a minute.',
  unavailable: 'Sign-in is unavailable right now. Try again in a minute.',
  in_use: 'That Steam account is already linked to a different aim4 account.'
};

document.getElementById('auth-steam')?.addEventListener('click', () => {
  setAuthStatus('Redirecting to Steam…');
  try {
    // Comes back to whatever page the modal was opened on.
    auth.signInWithSteam();
  } catch (e) {
    setAuthStatus(e.message || 'Steam sign-in failed.', false);
  }
});

let signingIn = false;
async function submitAuth() {
  // The button is disabled below, but Enter reaches here directly, and a second
  // submit mid-request would spend another attempt against the rate limit.
  if (signingIn) return;
  const identifier = authIdentifier?.value.trim() || '';
  const password = authPassword?.value || '';
  if (!identifier || !password) {
    setAuthStatus(
      authMode === 'register' ? 'Pick a username and a password.' : 'Enter your username and password.',
      false
    );
    return;
  }
  signingIn = true;
  if (authSubmit) authSubmit.disabled = true;
  setAuthStatus(authMode === 'register' ? 'Creating your account…' : 'Signing in…');
  try {
    if (authMode === 'register') {
      await auth.register({ username: identifier, password });
    } else {
      await auth.signIn({ identifier, password });
    }
    closeAuth();
  } catch (e) {
    setAuthStatus(e.message || (authMode === 'register' ? 'Could not create the account.' : 'Sign-in failed.'), false);
  } finally {
    signingIn = false;
    if (authSubmit) authSubmit.disabled = false;
  }
}

authSubmit?.addEventListener('click', submitAuth);
for (const field of [authIdentifier, authPassword]) {
  field?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAuth();
    }
  });
}

// ---- Username picker --------------------------------------------------------
// Retired by migration 0012, kept as the safety net.
//
// A sign-in that carries no username now gets a random @ tag from
// handle_new_user() with username_chosen = true, and both the tag and the
// display name are editable under Account. So needsUsername is false for every
// account this site creates and the modal never opens — which is the point:
// blocking a brand-new user on a naming decision they have no basis to make is
// a wall in front of the thing they came for.
//
// It still fires for any row that somehow has username_chosen = false, rather
// than leaving such an account with no way to name itself.

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
// Retired, deliberately, rather than deleted.
//
// This asked password accounts once per browser to link Google "to keep
// access", because the Email provider was going to be turned off. Password
// sign-in is a supported way in again, so that sentence is no longer true and
// the prompt would be telling people their access is at risk when it is not.
//
// The modal, its handlers and AuthManager.linkGoogle() all stay: linking is
// still offered from the account screen, where it is an option rather than a
// warning. Flip PROMPT_GOOGLE_LINK back to true to bring the nag back if the
// provider is ever retired for real.
const PROMPT_GOOGLE_LINK = false;

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
  if (!PROMPT_GOOGLE_LINK) return;
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
    sideAccountHint.textContent = 'My profile';
  } else {
    sideAccountName.textContent = 'Guest';
    sideAccountHint.textContent = 'Sign in';
  }
}

// Signed in, this is the way to My Profile: name, subscription and settings.
// It used to sign out on click, which is a destructive action sitting where
// every other app puts the profile, and there was nowhere else to change a
// name from. Sign out moved onto the page itself.
sideAccountBtn.addEventListener('click', () => {
  // Both states land on the same page. Signed out it opens on Subscription,
  // where the plans are readable and the sign-in button sits at the top: one
  // more step than the modal that used to open here, and the pricing is no
  // longer behind a login form.
  setView('account', true, {});
});

auth.onChange(syncAccountRow);
syncAccountRow();
auth.init();

// ---- Steam sign-in, coming back ---------------------------------------------
// The callback redirects here with ?steam_code=<single-use code>, which is
// exchanged for the session over POST. A brand-new Steam account already has
// its @ tag and its display name (the Steam persona, carried through
// handle_new_user), so there is nothing to ask for — the persona only prefills
// the picker in the fallback case where it somehow opens.
auth
  .completeSteamSignIn()
  .then((result) => {
    if (result.error) {
      openAuth('login');
      setAuthStatus(STEAM_SIGNIN_ERRORS[result.error] || result.error, false);
      return;
    }
    if (result.signedIn && result.persona && usernameInput && auth.needsUsername) {
      usernameInput.value = result.persona;
    }
  })
  .catch(() => {
    /* nothing to recover: the user is simply still signed out */
  });

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
  patterns: {
    title: 'Pattern Finder',
    path: '/patterns',
    shell: 'replays',
    page: 'analytics',
    requires: 'analytics.pattern_finder'
  },
  performance: { title: 'Performance', path: '/performance', shell: 'performance' },
  uploads: { title: 'My Uploads', path: '/uploads', shell: 'replays', page: 'upload' },
  // The team pages carry `requires` so the shared upgrade banner appears on
  // the ones a plan does not include. Two of them deliberately do not:
  // /team is where an account without a team is told how to get one, so
  // gating it would hide the only route out of that state, and /team/replays
  // is metered per auto coach run rather than gated per visit.
  team: { title: 'Team', path: '/team', shell: 'team', page: 'team-overview' },
  'team-documents': {
    title: 'Documents',
    path: '/team/documents',
    shell: 'team',
    page: 'team-docs',
    requires: 'team.documents'
  },
  'team-roles': {
    title: 'Roles & Positions',
    path: '/team/roles',
    shell: 'team',
    page: 'team-roles',
    requires: 'team.roles_positions'
  },
  'team-stratbook': {
    title: 'Stratbook Editor',
    path: '/team/stratbook',
    shell: 'team',
    page: 'team-stratbook',
    requires: 'team.stratbook_access'
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
    page: 'team-drawing-board',
    requires: 'drawing_board'
  },
  'team-utility-archive': {
    title: 'Utility Archive',
    path: '/team/utility-archive',
    shell: 'team',
    page: 'team-utility-archive',
    requires: 'team.utility_archive'
  },
  'team-autocoach': {
    title: 'Matches',
    path: '/team/replays',
    shell: 'team',
    page: 'team-autocoach'
  },
  'team-comms': {
    title: 'Communication',
    path: '/team/communication',
    shell: 'team',
    page: 'team-comms',
    requires: 'team.comms'
  },
  'team-creator': {
    title: '2D Strategy Creator',
    path: '/team/creator',
    shell: 'strategy-creator',
    requires: 'team.strategy_creator_2d'
  },
  training: { title: 'Play', path: '/training', shell: 'training' },
  leaderboards: { title: 'Leaderboards', path: '/leaderboards', shell: 'leaderboards' },
  'replay-viewer': { title: 'Replay Viewer', path: '/replay-viewer', shell: 'replay-viewer' },
  football: { title: 'Football', path: '/football', shell: 'football' },
  tools: { title: 'Tools', path: '/tools', shell: 'tools' },
  changelog: { title: 'Changelog', path: '/changelog', shell: 'changelog' },
  docs: { title: 'Documentation', path: '/docs', shell: 'docs' },
  contact: { title: 'Contact', path: '/contact', shell: 'contact' },
  terms: { title: 'Terms of service', path: '/terms', shell: 'terms' },
  privacy: { title: 'Privacy', path: '/privacy', shell: 'privacy' },
  // Admin-only, chromeless. The view refuses non-admins itself; the route
  // entry only stops the deep link from falling through to the trainer.
  pitchdeck: { title: 'Pitch deck', path: '/tools/pitchdeck', shell: 'pitchdeck' },
  // The talking version: minimal slides plus a transcript, for presenting over.
  pitchtalk: { title: 'Pitch talk', path: '/tools/pitchtalk', shell: 'pitchdeck' },
  // The same two decks, shareable. Same shell and controller; the view reads
  // the path and skips the admin gate on these. The title is what a link
  // preview shows, so it reads as the pitch rather than as an internal tool.
  'public-pitch': { title: 'Aim for trophies', path: '/public-pitch', shell: 'pitchdeck' },
  'public-talk': { title: 'Aim for trophies', path: '/public-talk', shell: 'pitchdeck' },
  routines: { title: 'Routines', path: '/routines', shell: 'routines' },
  achievements: { title: 'Achievements', path: '/achievements', shell: 'achievements' },
  'map-practice': { title: 'Map Practice', path: '/map-practice', shell: 'map-practice' },
  player: { title: 'Player', path: '/player', shell: 'player' },
  account: { title: 'My Profile', path: '/account', shell: 'account' },
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
  admin: { title: 'Admin', path: '/admin', shell: 'admin' },
  // Same arrangement as admin, and more strictly: no nav entry anywhere, the
  // API answers 404 to everyone else, and the heavy chunk is only fetched once
  // /api/sim/me has said yes. This entry only stops the deep link from falling
  // through to the trainer.
  sim: { title: 'Sim', path: '/sim', shell: 'sim' },
  'not-found': { title: 'Page not found', path: '/404', shell: 'error' },
  forbidden: { title: 'No access', path: '/403', shell: 'error' }
};

/** Old /replays/* bookmarks → new top-level paths. Destinations may include a query. */
const LEGACY_PATHS = {
  '/replays': '/demos',
  '/replays/playlists': '/playlists',
  '/replays/stats': '/database',
  '/charts': '/patterns?chapter=charts',
  '/replays/charts': '/patterns?chapter=charts',
  '/replays/analytics': '/patterns',
  '/replays/upload': '/uploads',
  '/team/autocoach': '/team/replays'
};

function legacyPathOnly(dest) {
  return String(dest || '').split('?')[0] || '/';
}

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
    return PATH_TO_ROUTE[legacyPathOnly(LEGACY_PATHS[clean])] || 'home';
  }
  // A typo'd or dead link gets told so, not silently teleported home. The
  // special prefixes (/i/, /d/, /s2/, /player/…) have already been rewritten
  // to real routes by the time this runs.
  return PATH_TO_ROUTE[clean] || 'not-found';
}

function searchParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/** Rewrite legacy /replays/* URLs once on load (keeps leftover query params). */
{
  const clean = cleanPath();
  const next = LEGACY_PATHS[clean];
  if (next) {
    const dest = new URL(next, window.location.origin);
    const incoming = new URLSearchParams(window.location.search);
    for (const [k, v] of incoming) {
      if (!dest.searchParams.has(k)) dest.searchParams.set(k, v);
    }
    window.history.replaceState(null, '', dest.pathname + dest.search + window.location.hash);
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
 * A player page is linked as aim4.io/player/<id>, which is the readable form
 * worth putting in a message. The router matches exact paths, so the id moves
 * into the query string the same way an invite code does.
 */
{
  const m = cleanPath().match(/^\/player\/([A-Za-z0-9_-]{1,32})$/);
  if (m) {
    const q = new URLSearchParams(window.location.search);
    q.set('id', m[1]);
    window.history.replaceState(null, '', `/player?${q}`);
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

/**
 * A shared team document lands on aim4.io/d/<code>. Same rewrite pattern as /s2/.
 */
let sharedDocCode = '';
{
  const m = cleanPath().match(/^\/d\/([A-Za-z0-9_-]{6,32})$/);
  if (m) {
    sharedDocCode = m[1];
    window.history.replaceState(
      null,
      '',
      `/team/documents?share=${encodeURIComponent(sharedDocCode)}`
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
  const routeName = ROUTES[name] ? name : 'not-found';
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

  // The head-actions slot belongs to whichever page is on screen; the page
  // repopulates it on show (e.g. the pattern finder's chapter tabs).
  document.getElementById('page-head-actions')?.replaceChildren();
  const patternsSub = document.getElementById('side-patterns-sub');
  if (patternsSub) patternsSub.hidden = routeName !== 'patterns';

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
    const shown = viewControllers[shell]?.onShow?.(resolvedParams);
    // Lazy controllers return a Promise; keep the router from throwing across
    // a dynamic import while still logging a failed open.
    if (shown && typeof shown.then === 'function') {
      shown.catch((err) => console.error(`[router] ${routeName} failed to open`, err));
    }
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
  // `requires` is a capability key of any shape, not a boolean flag. The read
  // below goes through EntitlementManager.can, which is isEnabled() from the
  // catalogue, so a limit of 0 and an enum sitting on its weakest mode gate
  // exactly like a false. That is what lets a team page name a limit key
  // (`team.documents`) instead of needing a parallel boolean for every one.
  let requires = route.requires;
  if (
    route.path === '/patterns' &&
    new URLSearchParams(window.location.search).get('chapter') === 'charts'
  ) {
    requires = 'analytics.charts';
  }
  if (!requires) return;

  const show = () => {
    host.querySelector(':scope > .upgrade-gate')?.remove();
    if (activeRoute !== PATH_TO_ROUTE[route.path]) return;
    if (entitlements.can(requires)) return;
    const tier = entitlements.requiredPlan(requires);
    host.prepend(
      upgradePrompt({
        message: `${entitlements.label(requires)} is available on ${
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

// On mobile the training view is the static desktop-only notice above, and the
// launch-list DOM this controller renders into is gone.
viewControllers.training = IS_MOBILE ? {} : initTrainingView({ escapeHtml, openLeaderboards });
viewControllers.leaderboards = initLeaderboardsView({ auth, escapeHtml, openProfile });
viewControllers.football = initFootballView({ auth, escapeHtml });
viewControllers.player = initPlayerProfileView({ escapeHtml });
viewControllers['map-practice'] = initMapPracticeView({ escapeHtml });
viewControllers.home = initHomeView({ auth, escapeHtml });
viewControllers.changelog = initChangelogView(
  document.querySelector('.view[data-view="changelog"]'),
  { escapeHtml }
);
viewControllers.docs = initDocsView(document.querySelector('.view[data-view="docs"]'), {
  escapeHtml
});
viewControllers.contact = initContactView(document.querySelector('.view[data-view="contact"]'), {
  auth,
  escapeHtml
});
viewControllers.terms = initTermsView(document.querySelector('.view[data-view="terms"]'));
viewControllers.privacy = initPrivacyView(document.querySelector('.view[data-view="privacy"]'));
// One manager per page, refreshed whenever the session changes. Gates read it
// for UI state only; the server has already made every decision it reflects.
const entitlements = getEntitlements(auth);
entitlements.refresh();
initIngestReminder(auth, entitlements);
// Server-side notifications (ticket replies, admin news) surface as the same
// toasts the ingest reminder uses.
initNotifications(auth);
// Account-sharing detection: session ping on load/refocus, plus the warning
// cooldown and probation overlays it can come back with.
initIntegrity(auth, entitlements);

viewControllers.account = initAccountView(
  document.querySelector('.view[data-view="account"]'),
  { auth, openAuth }
);

// Heavy shells: import on first visit so cold Home/Training never parse demos,
// team tools, creator, admin, or the aim-run replay codec.
viewControllers['replay-viewer'] = lazyController(async () => {
  const { initReplayViewerView } = await import('./replayViewerView.js');
  return initReplayViewerView({
    auth,
    escapeHtml,
    openSelf: () => setView('replay-viewer', true, {})
  });
});
viewControllers.team = lazyController(async () => {
  const { initTeamView } = await import('./teamView.js');
  return initTeamView({ auth, escapeHtml });
});
viewControllers['strategy-creator'] = lazyController(async () => {
  const { initStrategyCreatorView } = await import('./strategyCreatorView.js');
  return initStrategyCreatorView({ auth, escapeHtml });
});
viewControllers.pitchdeck = lazyController(async () => {
  const { initPitchDeckView } = await import('./pitchDeckView.js');
  // The deck switch (full ↔ talking) is a route change, not a reload: both
  // routes share this shell, so setView swaps the content in place.
  return initPitchDeckView({
    escapeHtml,
    // The deck switch keeps the presentation language: setView rebuilds the
    // query string, so the lang param has to be handed back to it.
    openRoute: (name, lang) => setView(name, true, lang && lang !== 'en' ? { lang } : {})
  });
});
viewControllers.admin = lazyController(async () => {
  const { initAdminView } = await import('./admin/adminView.js');
  return initAdminView(document.querySelector('.view[data-view="admin"]'));
});
viewControllers.sim = lazyController(async () => {
  const { initSimView } = await import('./simView.js');
  return initSimView(document.querySelector('.view[data-view="sim"]'));
});
viewControllers.replays = lazyController(async () => {
  const { initReplaysView } = await import('./replaysView.js');
  return initReplaysView({
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
});
viewControllers.performance = lazyController(async () => {
  const { initPerformanceView } = await import('./performanceView.js');
  return initPerformanceView({ auth, escapeHtml });
});

// 404 / 403. One shell, two routes; the route decides the wording. The wrong
// URL stays in the address bar on a 404 so the reader can see the typo.
viewControllers.error = {
  onShow() {
    const code = document.getElementById('error-code');
    const title = document.getElementById('error-title');
    const text = document.getElementById('error-text');
    if (!code || !title || !text) return;
    if (activeRoute === 'forbidden') {
      code.textContent = '403';
      title.textContent = 'No access';
      text.textContent = 'This page belongs to an account or plan with more access than this one. Sign in, or ask whoever sent the link.';
    } else {
      const at = cleanPath();
      code.textContent = '404';
      title.textContent = 'Page not found';
      text.textContent =
        at && at !== '/404' ? `Nothing lives at ${at}. The link may be old or mistyped.` : 'Nothing lives at this address. The link may be old or mistyped.';
    }
  }
};
document.getElementById('error-back')?.addEventListener('click', () => {
  // A fresh tab that opened straight onto the 404 has nowhere to go back to.
  if (window.history.length > 1) window.history.back();
  else setView('home', true);
});

// A "view as" session must be unmissable on every page, not only on /admin.
void import('./admin/impersonate.js').then((m) => m.mountImpersonationBanner());

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    // Sidebar clicks start a fresh route — don't carry ?user= / ?mode= from the previous page.
    setView(el.dataset.nav, true, {});
  });
});

/**
 * Route internal links that were rendered after boot.
 *
 * `data-nav` is wired once over the markup that exists at load, which covers
 * the sidebar and nothing else. A player name inside a stats table is written
 * long afterwards, and it should still navigate rather than reload the site.
 */
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href^="/"]');
  if (!a || a.target === '_blank' || a.hasAttribute('data-nav') || a.hasAttribute('download')) {
    return;
  }
  const url = new URL(a.getAttribute('href'), window.location.origin);
  const clean = cleanPath(url.pathname);
  const params = Object.fromEntries(url.searchParams);
  const player = clean.match(/^\/player\/([A-Za-z0-9_-]{1,32})$/);
  if (player) {
    e.preventDefault();
    setView('player', true, { ...params, id: player[1] });
    return;
  }
  const legacy = LEGACY_PATHS[clean];
  if (legacy) {
    const dest = new URL(legacy, window.location.origin);
    e.preventDefault();
    setView(PATH_TO_ROUTE[dest.pathname] || 'home', true, {
      ...Object.fromEntries(dest.searchParams),
      ...params
    });
    return;
  }
  const route = PATH_TO_ROUTE[clean];
  if (!route) return;
  e.preventDefault();
  setView(route, true, params);
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
} else if (sharedDocCode) {
  viewControllers.team?.setShare?.(sharedDocCode);
  setView('team-documents', false, { share: sharedDocCode });
} else if (inviteCode) {
  // Redeeming needs a signed-in account; the team view holds the code and
  // retries once auth lands, so a signed-out visitor can sign in in place.
  viewControllers.team?.setInvite?.(inviteCode);
  setView('team', false, { invite: inviteCode });
} else {
  setView(routeFromPath(), false, searchParams());
}
