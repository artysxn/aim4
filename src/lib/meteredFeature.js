// ---------------------------------------------------------------------------
// lib/meteredFeature.js
// Spending a daily allowance, and saying so when there is none left.
//
// The quota'd capabilities (macro viewer, map control, the two win predictions,
// auto coach, comms coach, anti-strat, charts, pattern finder) are all metered
// the same way: the client asks the server to spend one use before opening the
// feature, and the server either allows it or answers 402 with the standard
// upgrade payload.
//
// The check is the server's. This module never reads the client's own mirror of
// the plan to decide that a user may proceed: for these features the consume
// call IS the gate rather than a hint about some other gated surface, and an
// out-of-date mirror would be a free pass. The one judgement it does make is
// what to do when the server cannot be asked at all, which is the failsClosed()
// comment below.
//
// Refusals surface as a dialog rather than an inline panel because every one of
// these lives inside the fullscreen viewer overlay, where there is nowhere to
// put a banner.
// ---------------------------------------------------------------------------

import { SHARED_QUOTA_KEYS } from '../../shared/entitlements/catalogue.js';
import { consumeCapability } from '../replays/api.js';
import { renderUpgradeError, upgradePrompt } from '../site/upgradeGate.js';
import { getEntitlements } from './entitlements.js';

/**
 * What a failed consume call means, when it was not a 402.
 *
 * A quota marked `shared` in the catalogue is metered against the subscription,
 * so one team's daily allowance is spent by whichever seat clicks first. If the
 * consume call fails for any reason other than a refusal, we do not know
 * whether the use was recorded, and we do not know what a teammate has already
 * spent. Failing open there hands the whole roster an unmetered run each time
 * the meter is unreachable, and a client that retries turns that into as many
 * runs as it likes. So shared quotas fail CLOSED: the user is told the
 * allowance could not be checked and asked to try again.
 *
 * The per-account quotas that come through here (the macro viewer) still fail
 * open. One unmetered use is worth more than a dead feature: the cost of the
 * mistake is bounded by the one person who hit the blip, and what they get is a
 * view over data their account can already download. The trade is deliberate
 * and it is deliberately not symmetric with the shared ones.
 *
 * Charts and the pattern finder spend their own use through the API directly
 * and treat any failure as a failure to load, so they never reach this.
 */
function failsClosed(key) {
  return SHARED_QUOTA_KEYS.includes(key);
}

/**
 * Spend one use of a metered capability.
 *
 * `reason` is 'ok' when the use was granted, 'upgrade' when the server refused
 * (allowance spent, or the plan does not include it) and 'unreachable' when the
 * meter could not be asked at all. The last two are different messages: only
 * one of them is about the plan.
 *
 * @param {string} key  a capability key from shared/entitlements/keys.js
 * @returns {Promise<{allowed: boolean, body: object|null, quota: object|null, reason: string}>}
 */
export async function spendCapability(key) {
  try {
    const body = await consumeCapability(key);
    return { allowed: true, body, quota: body?.quota || null, reason: 'ok' };
  } catch (err) {
    if (err?.status === 402) {
      return { allowed: false, body: err.body || null, quota: null, reason: 'upgrade' };
    }
    console.warn(`[entitlements] could not meter ${key}:`, err?.message || err);
    if (failsClosed(key)) {
      return { allowed: false, body: null, quota: null, reason: 'unreachable' };
    }
    return { allowed: true, body: null, quota: null, reason: 'unreachable' };
  }
}

/**
 * Spend a use, and put a dialog up when the caller may not proceed.
 *
 * @param {string} key
 * @param {{host?: HTMLElement}} [opts]  where to mount the dialog
 * @returns {Promise<boolean>} true when the caller may proceed
 */
export async function useMeteredFeature(key, opts = {}) {
  const { allowed, body, reason } = await spendCapability(key);
  if (allowed) return true;
  if (reason === 'unreachable') {
    showMeterUnavailableDialog(opts);
    return false;
  }
  showUpgradeDialog(body, opts);
  return false;
}

/**
 * The dialog chrome: backdrop, panel, close button, Escape and click-away.
 *
 * Shared by the two things that can stop a metered feature, because they look
 * the same and only the content differs.
 *
 * @param {HTMLElement} host
 * @param {HTMLElement} content
 * @returns {() => void} dismiss
 */
function modalShell(host, content) {
  const backdrop = document.createElement('div');
  backdrop.className = 'upgrade-dialog-backdrop';

  const panel = document.createElement('div');
  panel.className = 'upgrade-dialog';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.appendChild(content);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'upgrade-dialog-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  panel.appendChild(close);

  const dismiss = () => {
    backdrop.remove();
    // Removed with the same capture flag it was added with. Without the flag
    // the listener is a different registration and stays on the document for
    // the rest of the session.
    document.removeEventListener('keydown', onKey, true);
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

/**
 * Modal wrapper around the shared upgrade prompt.
 *
 * @param {object|null} body  the 402 payload
 * @param {{host?: HTMLElement, message?: string}} [opts]
 */
export function showUpgradeDialog(body, opts = {}) {
  const ents = getEntitlements();
  const prompt =
    renderUpgradeError(body, { trialOffer: ents?.trialOffer || null }) ||
    upgradePrompt({
      message: opts.message || body?.message || 'That is not available on your plan.',
      requiredTier: body?.requiredTier || null,
      trialOffer: ents?.trialOffer || null
    });
  return modalShell(opts.host || document.body, prompt);
}

/**
 * The other refusal: the meter could not be reached, so a shared allowance was
 * held back rather than spent blind. No Upgrade button, because upgrading is
 * not the fix and offering it here would be a lie about what went wrong.
 *
 * @param {{host?: HTMLElement, message?: string}} [opts]
 */
export function showMeterUnavailableDialog(opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'upgrade-gate';
  const message = document.createElement('p');
  message.className = 'upgrade-gate-message';
  message.textContent =
    opts.message ||
    'The daily allowance could not be checked, so this was not run. Try again in a moment.';
  wrap.appendChild(message);
  return modalShell(opts.host || document.body, wrap);
}
