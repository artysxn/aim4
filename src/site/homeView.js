// ---------------------------------------------------------------------------
// site/homeView.js
// The landing page.
//
// It used to be a full screen of logo-on-black over a card grid that repeated
// the sidebar, which is always on screen anyway, and a footer that repeated it
// a third time. Nobody navigating the site needed any of that: the sidebar had
// already done the job before the page finished painting.
//
// So the page splits by whether anyone is home. Signed out it is a front door
// and keeps a hero. Signed in it answers "what happened since I was here" -
// where you left off, what has landed, and how you are going.
//
// Everything on the signed-in side is cheap: one demos listing, and state the
// viewer and the trainer already write down locally. No stats index, no round
// files, nothing that makes the first page of the site wait.
// ---------------------------------------------------------------------------

import { fetchDemos } from '../replays/api.js';
import { MAPS } from '../replays/shared/roundId.js';
import { ago, date } from '../i18n/format.js';

/** Where the viewer records the round you were last in. */
export const LAST_ROUND_KEY = 'aim4:last-round';
/** Where the trainer records the last scenario played. */
export const LAST_MODE_KEY = 'aim4:last-mode';

/** How many recent uploads the signed-in page lists. */
const RECENT_DEMOS = 4;

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Remember the round the viewer is on, for Continue. */
export function rememberRound(entry) {
  try {
    window.localStorage.setItem(LAST_ROUND_KEY, JSON.stringify({ ...entry, at: Date.now() }));
  } catch {
    /* private browsing; Continue simply will not appear */
  }
}

/**
 * "3 minutes ago", in the interface language.
 *
 * This was four hand-written English forms ("just now", "5m ago", "3h ago",
 * "2d ago"). Intl says the same thing in every language and gets the plural
 * agreement right, which "2d ago" cannot: the compactness was never worth a
 * card that reads half in Finnish and half in English.
 */
function whenText(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  // Past a month the gap stops being useful and the date is what you want.
  if (Date.now() - t > 30 * 24 * 60 * 60 * 1000) return date(t);
  return ago(t);
}

export function initHomeView({ auth, escapeHtml }) {
  const host = document.querySelector('.view[data-view="home"]');
  if (!host) return {};

  let demos = [];
  let loaded = false;
  let loading = null;

  const mapName = (d) => d?.mapName || (d?.map ? MAPS[d.map]?.name : '') || d?.map || '';

  function scoreText(d) {
    const s = d?.score;
    if (!s || (!s.team1 && !s.team2)) return '';
    return `${s.team1}-${s.team2}`;
  }

  // ---- signed out ---------------------------------------------------------

  function signedOutHtml() {
    return `
      <div class="hm-front">
        <div class="hm-front-copy">
          <h2 class="hm-front-title">Aim training and CS2 demo review, one account.</h2>
          <div class="hm-front-actions">
            <a class="btn primary btn-lg" href="/train">Start training</a>
            <a class="btn btn-lg" href="/demos" data-nav="demos">Review a demo</a>
          </div>
        </div>
        <div class="hm-front-art" aria-hidden="true">
          <img src="/icons/aim4logos/logocolor.png" alt="" width="440" height="73" decoding="async" />
        </div>
      </div>`;
  }

  // ---- signed in ----------------------------------------------------------

  function continueHtml() {
    const round = readJson(LAST_ROUND_KEY);
    const mode = readJson(LAST_MODE_KEY);
    const cards = [];
    if (round?.file) {
      cards.push(`
        <a class="hm-continue" href="/demos?round=${encodeURIComponent(round.file)}">
          <span class="hm-continue-kind">Replay</span>
          <span class="hm-continue-title">${escapeHtml(round.title || 'Last round')}</span>
          <span class="hm-continue-meta">${escapeHtml(
            [round.map ? MAPS[round.map]?.name || round.map : '', whenText(round.at)]
              .filter(Boolean)
              .join(' · ')
          )}</span>
        </a>`);
    }
    if (mode?.id) {
      cards.push(`
        <a class="hm-continue" href="/train?mode=${encodeURIComponent(mode.id)}">
          <span class="hm-continue-kind">Training</span>
          <span class="hm-continue-title">${escapeHtml(mode.title || mode.id)}</span>
          <span class="hm-continue-meta">${escapeHtml(whenText(mode.at))}</span>
        </a>`);
    }
    if (!cards.length) return '';
    return `
      <section class="hm-block">
        <h3 class="hm-block-title">Continue</h3>
        <div class="hm-continue-row">${cards.join('')}</div>
      </section>`;
  }

  function recentHtml() {
    if (!loaded) return '<section class="hm-block hm-block-loading"></section>';
    const list = demos
      .filter((d) => (d.status || 'ready') === 'ready')
      .slice(0, RECENT_DEMOS);
    if (!list.length) {
      return `
        <section class="hm-block">
          <h3 class="hm-block-title">Recent demos</h3>
          <p class="hm-empty">Nothing here yet. <a href="/uploads" data-nav="uploads">Upload one</a>.</p>
        </section>`;
    }
    return `
      <section class="hm-block">
        <h3 class="hm-block-title">Recent demos</h3>
        <div class="hm-demos">
          ${list
            .map(
              (d) => `
            <a class="hm-demo" href="/demos">
              <span class="hm-demo-teams">${escapeHtml(d.team1?.name || 'Team 1')} vs ${escapeHtml(
                d.team2?.name || 'Team 2'
              )}</span>
              <span class="hm-demo-meta">${escapeHtml(
                [mapName(d), scoreText(d), whenText(d.uploadedAt || d.parsedAt)]
                  .filter(Boolean)
                  .join(' · ')
              )}</span>
              ${
                d.topPlayer?.name
                  ? `<span class="hm-demo-top">${escapeHtml(d.topPlayer.name)} ${Number(
                      d.topPlayer.rating
                    ).toFixed(2)}</span>`
                  : ''
              }
            </a>`
            )
            .join('')}
        </div>
      </section>`;
  }

  /** The four places worth one click from the front page. */
  function jumpHtml() {
    const links = [
      ['/training', 'training', 'Play'],
      ['/demos', 'demos', 'Demo Manager'],
      ['/team', 'team', 'Team'],
      ['/leaderboards', 'leaderboards', 'Leaderboards']
    ];
    return `
      <section class="hm-block">
        <div class="hm-jump">
          ${links
            .map(
              ([href, nav, label]) =>
                `<a class="hm-jump-link" href="${href}" data-nav="${nav}">${escapeHtml(label)}</a>`
            )
            .join('')}
        </div>
      </section>`;
  }

  function signedInHtml() {
    const name = auth?.displayName ? `@${auth.displayName}` : '';
    return `
      <div class="hm-dash">
        <header class="hm-dash-head">
          <h2 class="hm-dash-title">Welcome back${name ? ` ${escapeHtml(name)}` : ''}</h2>
          <a class="btn primary" href="/train">Start training</a>
        </header>
        ${continueHtml()}
        ${recentHtml()}
        ${jumpHtml()}
      </div>`;
  }

  function render() {
    host.innerHTML = auth?.isLoggedIn ? signedInHtml() : signedOutHtml();
  }

  async function loadDemos() {
    if (loading) return loading;
    loading = fetchDemos({ limit: 12 })
      .then((res) => {
        demos = Array.isArray(res?.demos) ? res.demos : [];
      })
      .catch(() => {
        demos = [];
      })
      .finally(() => {
        loaded = true;
        loading = null;
        if (auth?.isLoggedIn) render();
      });
    return loading;
  }

  auth?.onChange?.(() => {
    // Signing in or out changes which page this is, not just what is on it.
    loaded = false;
    demos = [];
    render();
    if (auth.isLoggedIn) void loadDemos();
  });

  return {
    onShow() {
      render();
      if (auth?.isLoggedIn && !loaded) void loadDemos();
    },
    onHide() {}
  };
}
