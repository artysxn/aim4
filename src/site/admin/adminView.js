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
import { codesPanel } from './codesPanel.js';
import { affiliatesPanel } from './affiliatesPanel.js';
import { el, render } from './dom.js';
import { ingestPanel } from './ingestPanel.js';
import { toolsPanel } from './toolsPanel.js';
import { initModelsPanel } from './modelsPanel.js';
import { usersPanel } from './usersPanel.js';
import { userDetail } from './userDetail.js';
import { coachSmokesPanel } from './coachSmokesPanel.js';
import { uploadsPanel } from './uploadsPanel.js';
import { perfPanel } from './perfPanel.js';
import { pitchPanel } from './pitchPanel.js';
import { supportPanel } from './supportPanel.js';
import { trainingPanel } from './trainingPanel.js';
import { releasesPanel } from './releasesPanel.js';
import { spinnerNode } from '../../lib/spinner.js';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'ingest', label: 'Ingest' },
  { id: 'support', label: 'Support' },
  { id: 'tools', label: 'Tools' },
  { id: 'models', label: 'Models' },
  { id: 'app', label: 'App builds' },
  { id: 'smokes', label: 'Utility' },
  { id: 'perf', label: 'Performance' },
  { id: 'codes', label: 'Codes' },
  { id: 'affiliates', label: 'Affiliates' },
  { id: 'pitch', label: 'Pitch' },
  { id: 'training', label: 'Training' },
  { id: 'audit', label: 'Audit' }
];

/** /admin/training_<n>: the training pages are addressable, the other tabs are not. */
const TRAINING_PATH = /^\/admin\/training_([1-5])\/?$/;
const trainingStageOf = (pathname) => Number(TRAINING_PATH.exec(pathname || '')?.[1] || 0);

/** Tabs backed by Supabase or an internet service. A local install has neither. */
const HOSTED_ONLY_TABS = new Set(['users', 'ingest', 'codes', 'affiliates', 'audit']);

/**
 * @param {HTMLElement} host  the `.view[data-view="admin"]` element
 */
export function initAdminView(host) {
  if (!host) return { onShow() {}, onHide() {} };

  const root = el('div', 'admin-root');
  host.replaceChildren(root);

  let me = null;
  let tab = 'users';
  /** Training stage on screen, 1 … 5. */
  let stage = 1;
  let openUserId = null;
  let loaded = false;
  /** The panel currently on screen, so its polling can be shut down. */
  let livePanel = null;

  /** Ingest polls on a timer; leaving the tab or the page has to stop it. */
  function releasePanel() {
    livePanel?._stopPolling?.();
    livePanel = null;
  }

  function renderShell() {
    releasePanel();
    const wrap = el('div');
    const nav = el('nav', 'admin-nav');
    for (const t of TABS) {
      if (me?.local && HOSTED_ONLY_TABS.has(t.id)) continue;
      const btn = el('button', `admin-tab${t.id === tab ? ' active' : ''}`, t.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        tab = t.id;
        openUserId = null;
        syncPath();
        renderShell();
      });
      nav.appendChild(btn);
    }
    wrap.appendChild(nav);

    const panel = el('div', 'admin-body');
    if (tab === 'ingest') {
      livePanel = ingestPanel();
      panel.appendChild(livePanel);
    } else if (tab === 'uploads') {
      panel.appendChild(uploadsPanel());
    } else if (tab === 'support') {
      panel.appendChild(supportPanel());
    } else if (tab === 'audit') {
      panel.appendChild(auditPanel());
    } else if (tab === 'app') {
      panel.appendChild(releasesPanel());
    } else if (tab === 'tools') {
      panel.appendChild(toolsPanel());
    } else if (tab === 'models') {
      livePanel = initModelsPanel();
      panel.appendChild(livePanel);
    } else if (tab === 'smokes') {
      livePanel = coachSmokesPanel();
      panel.appendChild(livePanel);
    } else if (tab === 'perf') {
      livePanel = perfPanel();
      panel.appendChild(livePanel);
    } else if (tab === 'codes') {
      panel.appendChild(codesPanel());
    } else if (tab === 'affiliates') {
      panel.appendChild(affiliatesPanel());
    } else if (tab === 'training') {
      livePanel = trainingPanel({
        stage,
        onStage: (n) => {
          stage = n;
          syncPath();
          renderShell();
        }
      });
      panel.appendChild(livePanel);
    } else if (tab === 'pitch') {
      // Not polling, but it registers a beforeunload guard for unsaved text and
      // uses the same hook to drop it when the tab changes.
      livePanel = pitchPanel();
      panel.appendChild(livePanel);
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

  /**
   * Keep the address bar on the training page that is open, and off it when
   * another tab is. pushState, so Back steps between training stages; the
   * router's popstate brings us back through onShow.
   */
  function syncPath() {
    const want = tab === 'training' ? `/admin/training_${stage}` : '/admin';
    if (window.location.pathname !== want) window.history.pushState({ route: 'admin' }, '', want);
    // The router set the heading for the page it opened; keep it on this one.
    const title = tab === 'training' ? `Training ${stage}` : 'Admin';
    const heading = document.getElementById('page-title');
    if (heading) heading.textContent = title;
    document.title = `AIM4.io - ${title}`;
  }

  /** The tab and stage the address bar asks for. */
  function readPath() {
    const n = trainingStageOf(window.location.pathname);
    if (n) {
      tab = 'training';
      stage = n;
    }
    return n;
  }

  async function load() {
    if (loaded) return;
    render(root, spinnerNode());
    try {
      me = await adminApi.me();
      if (!readPath() && me?.local && HOSTED_ONLY_TABS.has(tab)) tab = 'tools';
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
      // Back / forward between /admin and /admin/training_<n> lands here.
      if (loaded) {
        const n = trainingStageOf(window.location.pathname);
        const want = n ? 'training' : tab === 'training' ? 'users' : tab;
        if (want !== tab || (n && n !== stage)) {
          tab = want;
          if (n) stage = n;
          if (me?.local && HOSTED_ONLY_TABS.has(tab)) tab = 'tools';
          renderShell();
        }
      }
      load();
    },
    onHide() {
      // Navigating away from /admin must stop the ingest poll; a weeks-long
      // backfill does not need a request every five seconds from a tab nobody
      // is looking at.
      releasePanel();
    }
  };
}
