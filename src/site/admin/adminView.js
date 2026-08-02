// ---------------------------------------------------------------------------
// src/site/admin/adminView.js
// The /admin shell and its sub-navigation.
//
// Renders nothing until GET /api/admin/me returns 200. Client-side hiding is
// cosmetic; the API is the boundary, and it answers 404 rather than 403 to a
// non-admin so the endpoint's existence is not confirmed to someone probing.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { auditPanel } from './auditPanel.js';
import { el, render } from './dom.js';
import { usersPanel } from './usersPanel.js';
import { userDetail } from './userDetail.js';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit' }
];

/**
 * @param {HTMLElement} host  the `.view[data-view="admin"]` element
 */
export function initAdminView(host) {
  if (!host) return { onShow() {}, onHide() {} };

  const root = el('div', 'admin-root');
  host.replaceChildren(root);

  let me = null;
  let tab = 'users';
  let openUserId = null;
  let loaded = false;

  function renderShell() {
    const wrap = el('div');
    const nav = el('nav', 'admin-nav');
    for (const t of TABS) {
      const btn = el('button', `admin-tab${t.id === tab ? ' active' : ''}`, t.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        tab = t.id;
        openUserId = null;
        renderShell();
      });
      nav.appendChild(btn);
    }
    wrap.appendChild(nav);

    const panel = el('div', 'admin-body');
    if (tab === 'audit') {
      panel.appendChild(auditPanel());
    } else if (openUserId) {
      panel.appendChild(
        userDetail({
          userId: openUserId,
          canImpersonate: me?.canImpersonate !== false,
          onBack: () => {
            openUserId = null;
            renderShell();
          }
        })
      );
    } else {
      panel.appendChild(
        usersPanel({
          onOpenUser: (id) => {
            openUserId = id;
            renderShell();
          }
        })
      );
    }
    wrap.appendChild(panel);
    render(root, wrap);
  }

  async function load() {
    if (loaded) return;
    render(root, el('p', 'admin-loading', 'Loading'));
    try {
      me = await adminApi.me();
      loaded = true;
      renderShell();
    } catch (err) {
      // 404 is the answer a non-admin gets. Say the page does not exist rather
      // than "you are not an admin", which confirms the panel is there.
      render(
        root,
        el('p', 'admin-error', err.status === 404 ? 'Not found' : err.message)
      );
    }
  }

  return {
    onShow() {
      load();
    },
    onHide() {}
  };
}
