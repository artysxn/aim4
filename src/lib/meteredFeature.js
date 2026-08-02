// ---------------------------------------------------------------------------
// lib/meteredFeature.js
// Spending a daily allowance, and saying so when there is none left.
//
// The quota'd capabilities (macro viewer, map control, the two win predictions,
// auto coach, charts, pattern finder) are all metered the same way: the client
// asks the server to spend one use before opening the feature, and the server
// either allows it or answers 402 with the standard upgrade payload.
//
// The check is the server's. This module never decides on its own that a user
// may proceed: an out-of-date client mirror would otherwise be a free pass,
// because for these features the consume call IS the gate rather than a hint
// about some other gated surface.
//
// Refusals surface as a dialog rather than an inline panel because every one of
// these lives inside the fullscreen viewer overlay, where there is nowhere to
// put a banner.
// ---------------------------------------------------------------------------

import { consumeCapability } from '../replays/api.js';
import { renderUpgradeError, upgradePrompt } from '../site/upgradeGate.js';
import { getEntitlements } from './entitlements.js';

/**
 * Spend one use of a metered capability.
 *
 * @param {string} key  a capability key from shared/entitlements/keys.js
 * @returns {Promise<{allowed: boolean, body: object|null, quota: object|null}>}
 */
export async function spendCapability(key) {
  try {
    const body = await consumeCapability(key);
    return { allowed: true, body, quota: body?.quota || null };
  } catch (err) {
    if (err?.status === 402) return { allowed: false, body: err.body || null, quota: null };
    // Anything else (offline, backend down) is not an entitlement decision.
    // Let the feature open: refusing on a network blip would read as the
    // allowance being spent, which is worse than one unmetered use.
    console.warn(`[entitlements] could not meter ${key}:`, err?.message || err);
    return { allowed: true, body: null, quota: null };
  }
}

/**
 * Spend a use, and put the upgrade dialog up if there is none left.
 *
 * @param {string} key
 * @param {{host?: HTMLElement}} [opts]  where to mount the dialog
 * @returns {Promise<boolean>} true when the caller may proceed
 */
export async function useMeteredFeature(key, opts = {}) {
  const { allowed, body } = await spendCapability(key);
  if (allowed) return true;
  showUpgradeDialog(body, opts);
  return false;
}

/**
 * Modal wrapper around the shared upgrade prompt.
 *
 * @param {object|null} body  the 402 payload
 * @param {{host?: HTMLElement, message?: string}} [opts]
 */
export function showUpgradeDialog(body, opts = {}) {
  const host = opts.host || document.body;
  const ents = getEntitlements();

  const backdrop = document.createElement('div');
  backdrop.className = 'upgrade-dialog-backdrop';

  const panel = document.createElement('div');
  panel.className = 'upgrade-dialog';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const prompt =
    renderUpgradeError(body, { trialOffer: ents?.trialOffer || null }) ||
    upgradePrompt({
      message: opts.message || body?.message || 'That is not available on your plan.',
      requiredTier: body?.requiredTier || null,
      trialOffer: ents?.trialOffer || null
    });
  panel.appendChild(prompt);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'upgrade-dialog-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  panel.appendChild(close);

  const dismiss = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  };

  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) dismiss();
  });
  // Capture phase: the viewer closes itself on Escape, and dismissing a dialog
  // must not also close the demo behind it.
  document.addEventListener('keydown', onKey, true);

  backdrop.appendChild(panel);
  host.appendChild(backdrop);
  close.focus();
  return dismiss;
}
