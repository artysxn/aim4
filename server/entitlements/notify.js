// ---------------------------------------------------------------------------
// server/entitlements/notify.js
// Trial and renewal notices.
//
// There is no mail provider in this project. Rather than pretend, this module
// has the real shape of a notifier with a pluggable transport, defaults to
// recording each notice in the audit log, and reports plainly that nothing was
// emailed. Wiring a provider later means implementing one function.
//
// The notices themselves are not optional. The 48 hour warning before a trial
// converts is what prevents chargebacks, and for EU users it is expected of an
// auto-renewing subscription. Shipping the trial without it would be building
// the part that takes money and skipping the part that warns.
// ---------------------------------------------------------------------------

import { writeAudit } from './audit.js';
import { db, isConfigured } from './service.js';

/** Replace with a real transport. Returning false means "not delivered". */
let transport = null;

export function setTransport(fn) {
  transport = typeof fn === 'function' ? fn : null;
}

export function transportConfigured() {
  return transport !== null;
}

const TEMPLATES = {
  'trial.started': ({ planName, endsAt, days }) => ({
    subject: `Your ${days} day trial has started`,
    body: [
      `Your ${planName} trial is active until ${endsAt}.`,
      `On that date it converts to a paid ${planName} subscription.`,
      'Cancel any time before then and you keep access until the end date.'
    ].join('\n')
  }),
  'trial.ending': ({ planName, endsAt }) => ({
    subject: 'Your trial converts in 48 hours',
    body: [
      `Your ${planName} trial ends on ${endsAt} and converts to a paid subscription.`,
      'Cancel before then if you do not want to continue. You keep access either way until that date.'
    ].join('\n')
  }),
  'trial.converted': ({ planName }) => ({
    subject: `Your ${planName} subscription is active`,
    body: `Your trial has converted to a paid ${planName} subscription.`
  }),
  'trial.expired': ({ planName }) => ({
    subject: 'Your trial has ended',
    body: `Your ${planName} trial has ended and your account is back on Free.`
  }),
  'trial.cancelled': ({ planName, endsAt }) => ({
    subject: 'Your trial is cancelled',
    body: `Your ${planName} trial is cancelled. You keep access until ${endsAt}.`
  }),
  'subscription.lapsed': ({ planName, retentionDays }) => ({
    subject: 'Your subscription has ended',
    body: [
      `Your ${planName} subscription has ended.`,
      `Content over the Free limits is kept but inaccessible for ${retentionDays} days, then deleted.`
    ].join('\n')
  }),
  'retention.warning': ({ days, deleteAt }) => ({
    subject: `Content is deleted in ${days} days`,
    body: `Content kept from your previous plan is deleted on ${deleteAt}. Export or upgrade before then.`
  })
};

/**
 * @param {{userId: string, kind: keyof TEMPLATES, data?: object}} input
 * @returns {Promise<{delivered: boolean, kind: string}>}
 */
export async function notify({ userId, kind, data = {} }) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`Unknown notification: ${kind}`);
  const { subject, body } = template(data);

  let delivered = false;
  if (transport) {
    try {
      await transport({ userId, kind, subject, body, data });
      delivered = true;
    } catch (err) {
      console.error(`[notify] transport failed for ${kind} to ${userId}: ${err.message}`);
    }
  } else {
    console.log(`[notify] ${kind} -> ${userId}: ${subject} (no transport configured, not sent)`);
  }

  // Recorded either way, so "did we warn them" is answerable.
  await writeAudit({
    actorId: userId,
    action: `notify.${kind}`,
    targetUser: userId,
    payload: { subject, delivered }
  });

  return { delivered, kind };
}

/**
 * Notices are recorded on the subscription so a restart cannot send the 48 hour
 * warning twice, and a missed sweep cannot skip it silently.
 */
export async function markNotified(subscriptionId, kind) {
  if (!isConfigured()) return;
  try {
    const row = await db.selectOne('subscriptions', {
      select: 'id,notes',
      id: `eq.${subscriptionId}`
    });
    const sent = new Set(String(row?.notes || '').split('|').filter(Boolean));
    sent.add(`sent:${kind}`);
    await db.update('subscriptions', { id: `eq.${subscriptionId}` }, { notes: [...sent].join('|') }, {
      returning: false
    });
  } catch {
    /* a lost marker means one duplicate notice, not a failed sweep */
  }
}

export function wasNotified(subscription, kind) {
  return String(subscription?.notes || '').includes(`sent:${kind}`);
}
