// ---------------------------------------------------------------------------
// src/site/account/accountView.js
// /account, with shareable sub-paths.
//
// Distinct from profileModal.js, which is the *public* view of *another*
// player and stays exactly as it is.
// ---------------------------------------------------------------------------

import { el, render } from '../admin/dom.js';
import { accountApi } from './accountApi.js';
import { dataTab, overviewTab, securityTab, subscriptionTab, teamsTab } from './tabs.js';
import { spinnerNode } from '../../lib/spinner.js';

const TABS = [
  { id: 'overview', label: 'Overview', path: '/account', render: overviewTab },
  { id: 'subscription', label: 'Subscription', path: '/account/subscription', render: subscriptionTab },
  { id: 'teams', label: 'Teams', path: '/account/teams', render: teamsTab },
  { id: 'data', label: 'Data', path: '/account/data', render: dataTab },
  { id: 'security', label: 'Security', path: '/account/security', render: securityTab }
];

/**
 * @param {HTMLElement} host  the `.view[data-view="account"]` element
 * @param {{auth: object}} deps
 */
export function initAccountView(host, { auth, openAuth } = {}) {
  if (!host) return { onShow() {}, onHide() {} };

  const root = el('div', 'account-root');
  host.replaceChildren(root);

  let state = null;
  let billing = { configured: false };
  let active = 'overview';
  // #page-head-actions is one element shared by every page; a deferred paint
  // arriving after navigation must not write tabs under someone else's title.
  // Same guard performanceView documents at length.
  let visible = false;

  /**
   * Tabs this visitor can actually use. Signed out, only Subscription: plans
   * and prices are public (a payment provider's review has to be able to see
   * what is sold and for how much), and every other tab is about an account
   * that does not exist yet.
   */
  function visibleTabs() {
    return state?.account?.signedIn ? TABS : TABS.filter((t) => t.id === 'subscription');
  }

  function mountTabs() {
    const slot = document.getElementById('page-head-actions');
    if (!slot || !visible) return;
    // The same chapter-nav chrome Performance and Analytics put here, so the
    // top bar reads as one thing across pages.
    const nav = el('nav', 'an-chapters');
    nav.setAttribute('aria-label', 'Account');
    for (const tab of visibleTabs()) {
      const btn = el('button', `an-chapter-btn${tab.id === active ? ' active' : ''}`, tab.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        active = tab.id;
        // Sub-paths so a link to the subscription tab opens the subscription
        // tab, matching the existing /team/* pattern.
        window.history.pushState({ route: 'account' }, '', tab.path);
        renderShell();
      });
      nav.appendChild(btn);
    }
    slot.replaceChildren(nav);
  }

  /**
   * The way in, at the top of the page.
   *
   * The sidebar's account button used to open the sign-in modal directly for a
   * signed-out visitor, which put a login form in front of the pricing before
   * anyone could read it. It now opens this page, and signing in is a step
   * taken from here instead.
   */
  function signInCard() {
    const card = el('section', 'account-card account-signin');
    card.appendChild(el('h3', 'account-card-title', 'Sign in'));
    card.appendChild(
      el(
        'p',
        'account-muted',
        'Plans and prices are below, and the free tier needs no account. Sign in to subscribe, upload demos, and keep your library.'
      )
    );
    const row = el('div', 'account-signin-actions');
    const signIn = el('button', 'btn btn-primary', 'Sign in');
    signIn.type = 'button';
    signIn.addEventListener('click', () => openAuth?.('login'));
    const create = el('button', 'btn', 'Create account');
    create.type = 'button';
    create.addEventListener('click', () => openAuth?.('register'));
    row.appendChild(signIn);
    row.appendChild(create);
    card.appendChild(row);
    return card;
  }

  function renderShell() {
    if (!state) return;
    mountTabs();

    const panel = el('div', 'account-body');
    if (!state.account?.signedIn) panel.appendChild(signInCard());
    const tabs = visibleTabs();
    const tab = tabs.find((t) => t.id === active) || tabs[0];
    panel.appendChild(tab.render(state, { reload: load, billing, auth, openAuth }));
    render(root, panel);
  }

  async function load() {
    render(root, spinnerNode());
    try {
      const [me, billingStatus] = await Promise.all([
        accountApi.me(),
        accountApi.billingStatus().catch(() => ({ configured: false }))
      ]);
      state = me;
      billing = billingStatus;
      // Signed out is no longer a dead end: the page opens on Subscription,
      // which is public, with the way in above it.
      if (!state.account?.signedIn) active = 'subscription';
      renderShell();
    } catch (err) {
      render(root, el('p', 'account-error', err.message));
    }
  }

  return {
    onShow(params = {}) {
      visible = true;
      // Deep links land on the right tab.
      const path = window.location.pathname.replace(/\/+$/, '');
      const match = TABS.find((t) => t.path === path);
      active = params.tab || match?.id || 'overview';
      load();
    },
    onHide() {
      visible = false;
      document.getElementById('page-head-actions')?.replaceChildren();
    }
  };
}
