// ---------------------------------------------------------------------------
// src/site/upgradeGate.js
// The one locked-feature UI.
//
// Every gated control in the app renders through here, so that "this is not on
// your plan" looks and reads the same everywhere and there is one place to
// change the upsell.
//
// Copy follows CLAUDE.md: no em dashes, no explanatory filler under a heading.
// The button says "Upgrade". It does not say "Upgrade to unlock more powerful
// analytics".
//
// Locked features are shown, never hidden. A feature nobody can see is a
// feature nobody upgrades for.
// ---------------------------------------------------------------------------

import { PLAN_NAMES } from '../../shared/entitlements/catalogue.js';

/**
 * Where every Upgrade button lands. This used to be '/#pricing', an anchor
 * that never existed on any page: the button scrolled nowhere and the whole
 * upsell path dead-ended. The subscription tab is the pricing page.
 */
const PRICING_URL = '/account/subscription';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** "4 hours", "35 minutes". Used for quota resets, never for anything precise. */
export function untilText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * The upgrade affordance: a line of copy, an Upgrade button, and, only when the
 * account is actually eligible, a trial button. An ineligible account never
 * sees a disabled "Start 7 day trial" with an explanation next to it.
 *
 * @param {object} opts
 * @param {string} opts.message
 * @param {string|null} [opts.requiredTier]
 * @param {object|null} [opts.trialOffer]
 * @param {() => void} [opts.onTrial]
 */
export function upgradePrompt({ message, requiredTier = null, trialOffer = null, onTrial = null }) {
  const wrap = el('div', 'upgrade-gate');
  wrap.appendChild(el('p', 'upgrade-gate-message', message));

  const actions = el('div', 'upgrade-gate-actions');

  const upgrade = el('a', 'btn btn-primary upgrade-gate-btn', 'Upgrade');
  upgrade.href = PRICING_URL;
  if (requiredTier) upgrade.dataset.tier = requiredTier;
  actions.appendChild(upgrade);

  if (trialOffer && onTrial) {
    const trial = el('button', 'btn upgrade-gate-trial', `Start ${trialOffer.days} day trial`);
    trial.type = 'button';
    trial.addEventListener('click', onTrial);
    actions.appendChild(trial);
  }

  wrap.appendChild(actions);
  return wrap;
}

/**
 * Turn any element into a locked control: dimmed, non-interactive, with the
 * prompt underneath. Returns a function that unlocks it again, so a gate can
 * be re-evaluated when entitlements change without rebuilding the page.
 */
export function lock(node, { message, requiredTier = null, trialOffer = null, onTrial = null }) {
  if (!node) return () => {};
  node.classList.add('is-locked');
  node.setAttribute('aria-disabled', 'true');
  node.querySelectorAll('button, input, select, textarea, a').forEach((child) => {
    child.setAttribute('tabindex', '-1');
    if ('disabled' in child) child.disabled = true;
  });

  const prompt = upgradePrompt({ message, requiredTier, trialOffer, onTrial });
  node.insertAdjacentElement('afterend', prompt);

  return () => {
    node.classList.remove('is-locked');
    node.removeAttribute('aria-disabled');
    node.querySelectorAll('button, input, select, textarea, a').forEach((child) => {
      child.removeAttribute('tabindex');
      if ('disabled' in child) child.disabled = false;
    });
    prompt.remove();
  };
}

/**
 * Apply a capability to a control.
 *
 * @param {HTMLElement} node
 * @param {import('../lib/entitlements.js').EntitlementManager} ents
 * @param {string} key
 * @param {{level?: any, current?: number, onTrial?: () => void}} [opts]
 * @returns {{allowed: boolean, unlock?: () => void}}
 */
export function gate(node, ents, key, opts = {}) {
  const label = ents.label(key);
  const allowed = opts.level ? ents.atLeast(key, opts.level) : ents.can(key);
  if (allowed) return { allowed: true };

  const requiredTier = ents.requiredPlan(key, opts.level);
  const unlock = lock(node, {
    message: requiredTier
      ? `${label} is available on ${PLAN_NAMES[requiredTier] || requiredTier}.`
      : `${label} is not available.`,
    requiredTier,
    trialOffer: ents.trialOffer,
    onTrial: opts.onTrial
  });
  return { allowed: false, unlock };
}

/**
 * Inline quota text, e.g. "Auto coach (3 left today)". Returns an empty string
 * on unlimited tiers, so a paid user never sees a counter they do not have.
 */
export function quotaBadge(ents, key) {
  const q = ents.quota(key);
  if (q.unlimited) return '';
  if (q.limit <= 0) return '';
  if (q.spent) return q.resetsAt ? `resets in ${untilText(q.resetsAt)}` : 'none left today';
  return `${q.remaining} left today`;
}

/** Inline cap text, e.g. "40 / 40 on this map". */
export function capBadge(ents, key, current) {
  const l = ents.limit(key, current);
  if (l.unlimited) return '';
  return `${current} / ${l.limit}`;
}

/**
 * Render a 402 from the API. The server sends one shape for every refusal, so
 * this is the only place that has to understand it.
 */
export function renderUpgradeError(body, { onTrial = null, trialOffer = null } = {}) {
  if (!body || body.error !== 'upgrade_required') return null;
  return upgradePrompt({
    message: body.message,
    requiredTier: body.requiredTier,
    trialOffer,
    onTrial
  });
}
