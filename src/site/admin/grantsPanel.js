// ---------------------------------------------------------------------------
// src/site/admin/grantsPanel.js
// Create and revoke grants, subscriptions and trials for one account.
//
// The mode selector is the important control and is labelled plainly: an
// "upgrade" grant only applies if it ranks above what the account already has,
// an "override" applies either way, including downwards. Downwards is how you
// look at the Free experience without cancelling your own plan.
// ---------------------------------------------------------------------------

import {
  CAPABILITY_KEYS,
  PLAN_IDS,
  PLAN_NAMES,
  SOLO_PLAN_IDS,
  requiredPlanFor
} from '../../../shared/entitlements/catalogue.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { adminApi } from './adminApi.js';
import { button, date, el, field, input, notice, select, table } from './dom.js';

/** Every plan dropdown in this panel, in ladder order. */
const PLAN_OPTIONS = PLAN_IDS.map((id) => ({ value: id, label: PLAN_NAMES[id] }));

/**
 * What the plan dropdowns open on.
 *
 * All three are read off the ladder rather than typed in. A hardcoded default
 * outlives the plan it names: these selects opened on two ids from the previous
 * four-plan ladder long after both were gone, and `select()` answers an unknown
 * value by falling back to the first option, so each of them silently opened on
 * the free tier instead.
 *
 * Grants open on the cheapest paid plan, because granting too little is a
 * smaller mistake than granting too much. Trials open on the cheapest plan that
 * can actually create a team: a trial that can only join one has nothing to
 * join, which is what made gifted trials look broken.
 */
const DEFAULT_GRANT_PLAN = SOLO_PLAN_IDS[0];
const DEFAULT_TRIAL_PLAN = requiredPlanFor(CAP.TEAM_CREATE_LIMIT) || DEFAULT_GRANT_PLAN;
const TOP_PLAN = PLAN_IDS[PLAN_IDS.length - 1];

export function grantsPanel({ userId, detail, onChanged }) {
  const root = el('div', 'admin-subpanel');
  root.appendChild(el('h3', null, 'Grants'));

  // ---- existing grants ----------------------------------------------------
  const grants = detail.grants || [];
  if (grants.length) {
    root.appendChild(
      table(
        ['Target', 'Mode', 'From', 'Until', 'Reason', ''],
        grants.map((g) => [
          g.plan_id ? PLAN_NAMES[g.plan_id] || g.plan_id : `${g.capability} = ${JSON.stringify(g.value)}`,
          g.mode,
          date(g.starts_at),
          g.expires_at ? date(g.expires_at) : 'forever',
          g.reason || '',
          g.revoked_at
            ? el('span', 'admin-muted', `revoked ${date(g.revoked_at)}`)
            : button('Revoke', async () => {
                try {
                  await adminApi.revokeGrant(g.id);
                  notice(root, 'Grant revoked.');
                  onChanged();
                } catch (err) {
                  notice(root, err.message, 'error');
                }
              })
        ])
      )
    );
  } else {
    root.appendChild(el('p', 'admin-empty', 'No grants.'));
  }

  // ---- new grant ----------------------------------------------------------
  const form = el('div', 'admin-form');
  const kind = select([
    { value: 'plan', label: 'Whole tier' },
    { value: 'capability', label: 'One capability' }
  ]);
  const plan = select(PLAN_OPTIONS, DEFAULT_GRANT_PLAN);
  const capability = select(CAPABILITY_KEYS.map((k) => ({ value: k, label: k })));
  const value = input('text', '', 'JSON value, e.g. 25 or "full" or true');
  const mode = select([
    { value: 'upgrade', label: 'Upgrade only if higher' },
    { value: 'override', label: 'Override, including downwards' }
  ]);
  const expires = input('datetime-local', '');
  const reason = input('text', '', 'Reason');

  const capabilityFields = el('div', 'admin-inline');
  capabilityFields.append(field('Capability', capability), field('Value', value));
  const planFields = field('Plan', plan);

  function syncKind() {
    const isPlan = kind.value === 'plan';
    planFields.style.display = isPlan ? '' : 'none';
    capabilityFields.style.display = isPlan ? 'none' : '';
  }
  kind.addEventListener('change', syncKind);

  const submit = button(
    'Create grant',
    async () => {
      const payload = {
        userId,
        mode: mode.value,
        reason: reason.value.trim(),
        expiresAt: expires.value ? new Date(expires.value).toISOString() : null
      };
      if (kind.value === 'plan') {
        payload.planId = plan.value;
      } else {
        payload.capability = capability.value;
        try {
          payload.value = JSON.parse(value.value);
        } catch {
          notice(root, 'Value must be valid JSON, e.g. 25 or "full" or true.', 'error');
          return;
        }
      }
      try {
        await adminApi.createGrant(payload);
        notice(root, 'Grant created.');
        onChanged();
      } catch (err) {
        notice(root, err.message, 'error');
      }
    },
    'btn btn-primary'
  );

  form.append(
    field('Grant', kind),
    planFields,
    capabilityFields,
    field('Mode', mode),
    field('Expires', expires),
    field('Reason', reason),
    submit
  );
  syncKind();
  root.appendChild(form);

  // ---- subscriptions and trials -------------------------------------------
  const subs = el('div', 'admin-subpanel');
  subs.appendChild(el('h3', null, 'Subscription'));

  const subPlan = select(PLAN_OPTIONS, DEFAULT_GRANT_PLAN);
  const subTerm = select(['month', 'quarter', 'year', 'lifetime'], 'month');
  const subEnd = input('datetime-local', '');

  subs.append(
    field('Plan', subPlan),
    field('Term', subTerm),
    field('Ends (blank = never)', subEnd),
    button(
      'Create subscription',
      async () => {
        try {
          await adminApi.createSubscription({
            userId,
            planId: subPlan.value,
            term: subTerm.value,
            periodEnd: subEnd.value ? new Date(subEnd.value).toISOString() : null
          });
          notice(subs, 'Subscription created.');
          onChanged();
        } catch (err) {
          notice(subs, err.message, 'error');
        }
      },
      'btn btn-primary'
    ),
    // Used constantly during development, so it is one click rather than four
    // fields and a date picker. The label names whatever the top of the ladder
    // currently is, which is also the plan the endpoint grants.
    button(
      `Grant infinite ${PLAN_NAMES[TOP_PLAN]}`,
      async () => {
        try {
          await adminApi.grantElite(userId, 'Development grant');
          notice(subs, `Infinite ${PLAN_NAMES[TOP_PLAN]} granted.`);
          onChanged();
        } catch (err) {
          notice(subs, err.message, 'error');
        }
      },
      'btn'
    )
  );

  const trialDays = input('number', '7');
  const trialPlan = select(PLAN_OPTIONS, DEFAULT_TRIAL_PLAN);
  subs.append(
    el('h3', null, 'Trial'),
    field('Plan', trialPlan),
    field('Days', trialDays),
    button('Start trial', async () => {
      try {
        await adminApi.startTrial({
          userId,
          planId: trialPlan.value,
          days: Number(trialDays.value) || 7
        });
        notice(subs, 'Trial started.');
        onChanged();
      } catch (err) {
        notice(subs, err.message, 'error');
      }
    })
  );

  const active = (detail.subscriptions || []).find((s) =>
    ['trialing', 'active', 'past_due'].includes(s.status)
  );
  if (active) {
    subs.appendChild(
      el(
        'p',
        'admin-current',
        `Current: ${PLAN_NAMES[active.plan_id] || active.plan_id}, ${active.status}, ends ${
          active.current_period_end ? date(active.current_period_end) : 'never'
        }`
      )
    );
    subs.appendChild(
      button('Cancel at period end', async () => {
        try {
          await adminApi.cancelSubscription(active.id, false);
          notice(subs, 'Cancelled at period end.');
          onChanged();
        } catch (err) {
          notice(subs, err.message, 'error');
        }
      })
    );
  }

  root.appendChild(subs);
  return root;
}
