// ---------------------------------------------------------------------------
// site/mapPracticeView.js
// Map Practice: the front door to the 3D map explorer. One card per map on the
// roster; opening one navigates to /<slug>, which is a separate document
// (cs3d.html) rather than a view in this shell — the explorer owns the whole
// window, its own pointer lock and its own WebGPU context, so it is a real
// navigation and not a data-nav swap.
//
// Map practice is a paid feature, so the list is locked rather than hidden: the
// cards are what somebody upgrades for. The explorer document carries the same
// check at its own entry point, because a card that cannot be clicked is not a
// gate on a URL anyone can type.
// ---------------------------------------------------------------------------

import { CS3D_MAPS } from '../../shared/cs3d/maps.js';
import { getEntitlements } from '../lib/entitlements.js';
import { lock } from './upgradeGate.js';
import { CAP } from '../../shared/entitlements/keys.js';
import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';

/** The explorer answers to /de_<name> for every map; bare /<slug> is opt-out. */
function hrefFor(map) {
  return map.bareRoute === false ? `/de_${map.slug}` : `/${map.slug}`;
}

export function initMapPracticeView({ escapeHtml }) {
  const listEl = document.getElementById('map-practice-list');
  if (!listEl) return { onShow() {}, onHide() {} };

  let painted = false;
  /** Undoes the lock from the last visit, or null when the list was open. */
  let unlock = null;

  function render() {
    listEl.innerHTML = CS3D_MAPS.map((m) => {
      const href = escapeHtml(hrefFor(m));
      const name = escapeHtml(m.name);
      return `<div class="mp-row">
        <span class="mp-row-title">${name}</span>
        <a class="btn btn-sm mp-play" href="${href}">Play</a>
      </div>`;
    }).join('');
  }

  /**
   * Dim the list and put the upgrade prompt under it, or take both away again.
   *
   * Re-entrant on purpose: it runs once on show against whatever /api/me has
   * already said, and again when a late answer arrives, so a paying account
   * that opened the page on a cold load does not sit behind a lock.
   */
  function applyGate() {
    unlock?.();
    unlock = null;
    const ents = getEntitlements();
    if (ents?.can(CAP.AIM_MAP_PRACTICE)) return;
    const tier = ents?.requiredPlan(CAP.AIM_MAP_PRACTICE) || null;
    const label = ents?.label(CAP.AIM_MAP_PRACTICE) || 'Map practice';
    unlock = lock(listEl, {
      message: tier
        ? `${label} is available on ${PLAN_NAMES[tier] || tier}.`
        : `${label} is not available.`,
      requiredTier: tier
    });
  }

  return {
    onShow() {
      // The roster is a compile-time constant, so one paint is enough.
      if (!painted) {
        painted = true;
        render();
      }
      applyGate();
      void getEntitlements()
        ?.ready()
        .then(() => applyGate());
    },
    onHide() {}
  };
}
