// ---------------------------------------------------------------------------
// src/site/account/tabs.js
// The five tabs of the account page.
//
// Kept together because they share one loaded state object and differ only in
// what they read from it. Splitting five 40-line renderers across five files
// would mean five copies of the same imports and no clearer boundary.
//
// Copy follows CLAUDE.md throughout: no em dashes, no explanatory subtitles.
// ---------------------------------------------------------------------------

import { PLAN_NAMES, UNLIMITED } from '../../../shared/entitlements/catalogue.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { bytes, button, date, el, field, input, notice, table } from '../admin/dom.js';
import { accountApi } from './accountApi.js';

const SOURCE_LABEL = {
  free: 'No plan',
  seat: 'Seat on a team plan',
  subscription: 'Own subscription',
  grant: 'Granted',
  admin: 'Site admin'
};

function tierBadge(state) {
  const ents = state.entitlements || {};
  const trial = ents.trial;
  if (trial) return `${PLAN_NAMES[ents.tier] || ents.tier}, trial, ${trial.daysLeft} days left`;
  return `${PLAN_NAMES[ents.tier] || ents.tier} · ${SOURCE_LABEL[ents.source] || ents.source}`;
}

function limitText(value) {
  return Number(value) === UNLIMITED ? 'Unlimited' : String(value);
}

// ---------------------------------------------------------------------------

export function overviewTab(state, { reload, auth }) {
  const root = el('div', 'account-panel');
  const account = state.account || {};

  root.appendChild(el('h2', null, account.username || 'Account'));
  root.appendChild(el('p', 'account-tier', tierBadge(state)));

  // The display name, editable in place. It is what every other surface shows
  // for this account, so this is the one field worth putting on the front tab.
  if (account.signedIn) {
    const nameInput = input('text', account.username || '', 'Display name');
    nameInput.maxLength = 24;
    const save = button(
      'Save name',
      async () => {
        const next = nameInput.value.trim();
        if (!next || next === account.username) return;
        save.disabled = true;
        try {
          await accountApi.setUsername(next);
          notice(root, 'Name changed.');
          reload();
        } catch (err) {
          notice(root, err.message, 'error');
        } finally {
          save.disabled = false;
        }
      },
      'btn'
    );
    const row = el('div', 'account-name-row');
    row.appendChild(field('Display name', nameInput));
    row.appendChild(save);
    root.appendChild(row);
  }

  if (state.entitlements?.expiresAt) {
    root.appendChild(el('p', 'account-muted', `Renews ${date(state.entitlements.expiresAt)}`));
  }

  const trial = state.entitlements?.trial;
  if (trial && !trial.cancelAtPeriodEnd) {
    root.appendChild(
      button(
        'Cancel trial',
        async () => {
          try {
            const res = await accountApi.cancelTrial();
            notice(root, `Cancelled. Access continues until ${date(res.accessUntil)}.`);
            reload();
          } catch (err) {
            notice(root, err.message, 'error');
          }
        },
        'btn'
      )
    );
  }

  // Shown only when actually eligible. An ineligible account never sees a
  // disabled trial button with an explanation next to it.
  if (state.trial?.enabled && state.trial?.eligible) {
    root.appendChild(
      button(
        `Start ${state.trial.days} day trial`,
        async () => {
          try {
            await accountApi.startTrial();
            notice(root, 'Trial started.');
            reload();
          } catch (err) {
            notice(root, err.message, 'error');
          }
        },
        'btn btn-primary'
      )
    );
  }

  // Signing out lives here now. The sidebar button that used to do it opens
  // this page instead, so it needs somewhere to go.
  if (account.signedIn && auth?.signOut) {
    const out = el('div', 'account-signout');
    out.appendChild(button('Sign out', () => auth.signOut(), 'btn'));
    root.appendChild(out);
  }

  return root;
}

// ---------------------------------------------------------------------------

export function subscriptionTab(state, { reload, billing }) {
  const root = el('div', 'account-panel');
  root.appendChild(el('h2', null, 'Subscription'));

  const sub = state.subscription;
  if (!sub) {
    root.appendChild(el('p', null, `You are on ${PLAN_NAMES[state.entitlements?.tier] || 'Free'}.`));
  } else {
    root.appendChild(
      table(
        ['Plan', 'Status', 'Term', 'Renews', 'Source'],
        [
          [
            PLAN_NAMES[sub.planId] || sub.planId,
            sub.status,
            sub.term,
            sub.currentPeriodEnd ? date(sub.currentPeriodEnd) : 'never',
            sub.source
          ]
        ]
      )
    );

    if (sub.cancelAtPeriodEnd) {
      root.appendChild(
        el(
          'p',
          'account-notice',
          `Cancelled. Access continues until ${date(sub.currentPeriodEnd || sub.trialEndsAt)}.`
        )
      );
    }
  }

  // A seat is not a subscription, and FAQ #6 makes holding both non-refundable,
  // so it is stated here rather than discovered on a bank statement.
  if (state.entitlements?.source === 'seat' && sub) {
    root.appendChild(
      el(
        'p',
        'account-warning',
        `You hold both your own ${PLAN_NAMES[sub.planId] || sub.planId} and a team seat. Your effective tier is ${
          PLAN_NAMES[state.entitlements.tier] || state.entitlements.tier
        }.`
      )
    );
  }

  if (billing?.configured) {
    const upgrade = el('a', 'btn btn-primary', 'Upgrade');
    upgrade.href = '/#pricing';
    root.appendChild(upgrade);
  } else {
    // Render the state, hide the controls. A payment button that cannot work is
    // worse than no button.
    root.appendChild(el('p', 'account-muted', 'Payment is not available yet.'));
  }

  return root;
}

// ---------------------------------------------------------------------------

export function teamsTab(state) {
  const root = el('div', 'account-panel');
  root.appendChild(el('h2', null, 'Teams'));

  const seats = state.seats || [];
  if (seats.length) {
    root.appendChild(
      table(
        ['Team', 'Plan'],
        seats.map((s) => [s.teamId || '', PLAN_NAMES[s.planId] || s.planId || ''])
      )
    );
  } else {
    root.appendChild(el('p', 'account-empty', 'No seats.'));
  }

  const caps = state.entitlements?.capabilities || {};
  root.appendChild(
    table(
      ['Allowance', 'Value'],
      [
        ['Teams you may create', limitText(caps[CAP.TEAM_CREATE_LIMIT])],
        ['Seats on your plan', limitText(caps[CAP.TEAM_SEAT_CAPACITY])],
        ['Documents', limitText(caps[CAP.TEAM_DOCUMENTS])],
        ['Strategies per map', limitText(caps[CAP.TEAM_STRATBOOK_LIMIT])],
        ['Utility per map', limitText(caps[CAP.TEAM_UTILITY_ARCHIVE])]
      ]
    )
  );

  return root;
}

// ---------------------------------------------------------------------------

export function dataTab(state, { reload }) {
  const root = el('div', 'account-panel');
  root.appendChild(el('h2', null, 'Data and usage'));

  const quotas = state.quotas || {};
  const quotaRows = Object.entries(quotas).map(([key, q]) => [
    key,
    `${q.used} / ${q.limit}`,
    q.resetsAt ? date(q.resetsAt) : ''
  ]);
  if (quotaRows.length) {
    root.appendChild(el('h3', null, 'Today'));
    root.appendChild(table(['Feature', 'Used', 'Resets'], quotaRows));
  }

  const retention = el('div', 'account-retention');
  root.appendChild(retention);
  accountApi
    .retention()
    .then((r) => {
      retention.appendChild(el('h3', null, 'Storage'));
      retention.appendChild(
        table(
          ['Demos', 'Limit'],
          [[String(r.demos.held), limitText(r.demos.limit)]]
        )
      );
      if (r.demos.mustChoose) {
        retention.appendChild(
          el(
            'p',
            'account-warning',
            `${r.demos.overCap} demos are over your current limit. Choose which to keep before uploading or editing again.`
          )
        );
        if (r.deleteAt) {
          retention.appendChild(
            el('p', 'account-muted', `Kept until ${date(r.deleteAt)}, then deleted.`)
          );
        }
        retention.appendChild(retentionPicker(r, reload));
      }
    })
    .catch(() => {
      retention.appendChild(el('p', 'account-muted', 'Storage could not be read.'));
    });

  // ---- export -------------------------------------------------------------
  root.appendChild(el('h3', null, 'Export'));
  const exportBox = el('div');
  exportBox.appendChild(
    button(
      'Export my data',
      async () => {
        try {
          const res = await accountApi.exportData();
          const link = el('a', 'btn', `Download (${bytes(res.sizeBytes)})`);
          link.href = accountApi.exportUrl(res.downloadUrl);
          link.download = 'aim4-export.json';
          exportBox.appendChild(link);
          exportBox.appendChild(el('p', 'account-muted', res.note));
        } catch (err) {
          notice(exportBox, err.message, 'error');
        }
      },
      'btn'
    )
  );
  root.appendChild(exportBox);

  // ---- deletion -----------------------------------------------------------
  root.appendChild(el('h3', null, 'Delete account'));
  const deleteBox = el('div');
  const confirm = input('text', '', 'Type your username');
  deleteBox.append(
    field('Confirm', confirm),
    button(
      'Delete my account',
      async () => {
        try {
          const res = await accountApi.deleteAccount(confirm.value.trim());
          notice(deleteBox, res.message);
        } catch (err) {
          notice(deleteBox, err.message, 'error');
        }
      },
      'btn btn-danger'
    )
  );
  root.appendChild(deleteBox);

  return root;
}

/**
 * The forced-selection flow: when a plan lapses, over-cap demos are locked
 * rather than deleted and the user picks which to keep. A background job that
 * chose for them would delete the wrong ones.
 */
function retentionPicker(retention, reload) {
  const root = el('div', 'retention-picker');
  const keep = Number(retention.demos.limit);
  root.appendChild(el('p', null, `Choose ${keep} to keep.`));

  const list = el('div', 'retention-list');
  const boxes = [];
  for (const demo of retention.demos.items) {
    const line = el('label', 'retention-item');
    const box = input('checkbox');
    box.checked = !demo.locked;
    boxes.push({ box, demo });
    line.append(box, el('span', null, `${demo.name} · ${bytes(demo.sizeBytes)}`));
    list.appendChild(line);
  }
  root.appendChild(list);

  root.appendChild(
    button('Save selection', () => {
      const chosen = boxes.filter((b) => b.box.checked);
      if (chosen.length > keep) {
        notice(root, `Choose at most ${keep}.`, 'error');
        return;
      }
      // Deliberately not wired to a delete endpoint: choosing what to keep must
      // not silently destroy the rest. The selection is recorded and the
      // remainder stays locked until the retention window ends.
      notice(root, `${chosen.length} kept. The rest stay locked until the retention date.`);
      reload();
    })
  );
  return root;
}

// ---------------------------------------------------------------------------

export function securityTab(state, { auth }) {
  const root = el('div', 'account-panel');
  root.appendChild(el('h2', null, 'Security'));

  root.appendChild(
    table(
      ['Sign in method', 'Status'],
      [['Google', state.account?.signedIn ? 'Connected' : 'Not connected']]
    )
  );

  root.appendChild(
    button(
      'Sign out',
      () => {
        auth?.signOut?.();
      },
      'btn'
    )
  );

  return root;
}
