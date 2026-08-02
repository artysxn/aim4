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
export function initAccountView(host, { auth } = {}) {
  if (!host) return { onShow() {}, onHide() {} };

  const root = el('div', 'account-root');
  host.replaceChildren(root);

  let state = null;
  let billing = { configured: false };
  let active = 'overview';

  function renderShell() {
    if (!state) return;
    const wrap = el('div');

    const nav = el('nav', 'account-nav');
    for (const tab of TABS) {
      const btn = el('button', `account-tab${tab.id === active ? ' active' : ''}`, tab.label);
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
    wrap.appendChild(nav);

    const panel = el('div', 'account-body');
    const tab = TABS.find((t) => t.id === active) || TABS[0];
    panel.appendChild(tab.render(state, { reload: load, billing, auth }));
    wrap.appendChild(panel);

    render(root, wrap);
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
      if (!state.account?.signedIn) {
        render(root, el('p', 'account-empty', 'Sign in to see your account.'));
        return;
      }
      renderShell();
    } catch (err) {
      render(root, el('p', 'account-error', err.message));
    }
  }

  return {
    onShow(params = {}) {
      // Deep links land on the right tab.
      const path = window.location.pathname.replace(/\/+$/, '');
      const match = TABS.find((t) => t.path === path);
      active = params.tab || match?.id || 'overview';
      load();
    },
    onHide() {}
  };
}
