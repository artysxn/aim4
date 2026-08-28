// ---------------------------------------------------------------------------
// src/site/admin/userDetail.js
// One account: identity, resolved entitlements, seats, content.
//
// The Postgres half and the Node half load separately. Demo counts mean walking
// the library on disk, which is much slower than the account query, and
// blocking the whole page on it would make the panel feel broken.
// ---------------------------------------------------------------------------

import { PLAN_NAMES } from '../../../shared/entitlements/catalogue.js';
import { adminApi } from './adminApi.js';
import { bytes, button, date, el, field, input, notice, render, select, table } from './dom.js';
import { grantsPanel } from './grantsPanel.js';
import { startImpersonation } from './impersonate.js';
import { spinnerNode } from '../../lib/spinner.js';

export function userDetail({ userId, canImpersonate, onBack }) {
  const root = el('div', 'admin-panel');
  const head = el('div', 'admin-detail-head');
  const body = el('div');
  const contentBox = el('div', 'admin-subpanel');

  head.appendChild(button('Back', onBack, 'link-btn'));
  root.append(head, body, contentBox);

  async function load() {
    render(body, spinnerNode());
    try {
      const detail = await adminApi.user(userId);
      renderDetail(detail);
    } catch (err) {
      render(body, el('p', 'admin-error', err.message));
    }
    loadContent();
  }

  function renderDetail(detail) {
    const o = detail.overview || {};
    const ents = detail.entitlements || {};
    const wrap = el('div');

    wrap.appendChild(el('h2', null, o.username || '(no username)'));
    wrap.appendChild(
      el(
        'p',
        'admin-muted',
        `${o.email || 'no email'} · joined ${date(o.created_at)} · last seen ${date(o.last_sign_in_at) || 'never'}`
      )
    );

    // Resolved tier and, crucially, where it came from. "Why does this account
    // have the tier it has" is the single most common question this panel
    // answers, and the answer is usually a seat rather than a purchase.
    const sourceLabel = {
      free: 'no plan',
      seat: 'a seat on someone else’s plan',
      subscription: 'their own subscription',
      grant: 'an admin grant',
      admin: 'site admin'
    }[ents.source] || ents.source;

    wrap.appendChild(
      el(
        'p',
        'admin-tier-line',
        `Tier: ${PLAN_NAMES[ents.tier] || ents.tier} from ${sourceLabel}${
          ents.expiresAt ? `, until ${date(ents.expiresAt)}` : ''
        }${o.is_admin ? ' · site admin' : ''}`
      )
    );

    if (ents.trial) {
      wrap.appendChild(
        el(
          'p',
          'admin-trial-line',
          `Trial: ${ents.trial.daysLeft} days left, ends ${date(ents.trial.endsAt)}${
            ents.trial.cancelAtPeriodEnd ? ', cancelled' : ''
          }`
        )
      );
    }

    // ---- actions ----------------------------------------------------------
    const actions = el('div', 'admin-actions');
    if (canImpersonate && !o.is_admin) {
      actions.appendChild(
        button('View as', () => startImpersonation(userId, o.username, { readOnly: true }).catch((e) => notice(wrap, e.message, 'error')), 'btn')
      );
      actions.appendChild(
        button(
          'View as, with writes',
          () => {
            if (!window.confirm(`Write as @${o.username}? Changes are real.`)) return;
            startImpersonation(userId, o.username, { readOnly: false }).catch((e) =>
              notice(wrap, e.message, 'error')
            );
          },
          'btn btn-danger'
        )
      );
    }
    actions.appendChild(
      button('Recompute', async () => {
        try {
          await adminApi.recompute(userId);
          notice(wrap, 'Recomputed.');
          load();
        } catch (err) {
          notice(wrap, err.message, 'error');
        }
      })
    );
    wrap.appendChild(actions);

    // ---- seats ------------------------------------------------------------
    const seats = detail.seats || [];
    const seatBox = el('div', 'admin-subpanel');
    seatBox.appendChild(el('h3', null, 'Seats held'));
    if (seats.length) {
      seatBox.appendChild(
        table(
          ['Plan', 'Team', 'Since', ''],
          seats.map((s) => [
            PLAN_NAMES[s.subscription?.plan_id] || s.subscription?.plan_id || '',
            s.team_id || '',
            date(s.assigned_at),
            button('Release', async () => {
              try {
                await adminApi.releaseSeat(s.id);
                notice(seatBox, 'Seat released.');
                load();
              } catch (err) {
                notice(seatBox, err.message, 'error');
              }
            })
          ])
        )
      );
    } else {
      seatBox.appendChild(el('p', 'admin-empty', 'No seats.'));
    }

    // Assign onto one of this account's own subscriptions.
    const ownSubs = (detail.subscriptions || []).filter((s) =>
      ['trialing', 'active', 'past_due'].includes(s.status)
    );
    if (ownSubs.length) {
      const target = input('text', '', 'Account UUID to seat');
      const sub = select(ownSubs.map((s) => ({ value: s.id, label: PLAN_NAMES[s.plan_id] || s.plan_id })));
      seatBox.append(
        field('Subscription', sub),
        field('Seat this account', target),
        button('Assign seat', async () => {
          try {
            await adminApi.assignSeat({ subscriptionId: sub.value, userId: target.value.trim() });
            notice(seatBox, 'Seat assigned.');
            load();
          } catch (err) {
            notice(seatBox, err.message, 'error');
          }
        })
      );
    }
    wrap.appendChild(seatBox);

    wrap.appendChild(grantsPanel({ userId, detail, onChanged: load }));

    // ---- resolved capabilities --------------------------------------------
    const caps = ents.capabilities || {};
    const capBox = el('div', 'admin-subpanel');
    capBox.appendChild(el('h3', null, 'Resolved capabilities'));
    capBox.appendChild(
      el(
        'p',
        'admin-muted',
        'Edit access with Grants above (whole tier or one capability). Recompute after changes.'
      )
    );
    const capRows = Object.keys(caps)
      .sort()
      .map((key) => [key, JSON.stringify(caps[key])]);
    if (capRows.length) {
      capBox.appendChild(table(['Capability', 'Value'], capRows));
    } else {
      capBox.appendChild(el('p', 'admin-empty', 'No capabilities resolved.'));
    }
    wrap.appendChild(capBox);

    // ---- profile ----------------------------------------------------------
    const profileBox = el('div', 'admin-subpanel');
    profileBox.appendChild(el('h3', null, 'Profile'));
    const rename = input('text', o.username || '', 'New username');
    profileBox.append(
      field('Username', rename),
      button('Rename', async () => {
        try {
          await adminApi.content('profile', 'rename', { userId, username: rename.value.trim() });
          notice(profileBox, 'Renamed.');
          load();
        } catch (err) {
          notice(profileBox, err.message, 'error');
        }
      })
    );
    wrap.appendChild(profileBox);

    render(body, wrap);
  }

  async function loadContent() {
    render(contentBox, spinnerNode('Loading demos and teams'));
    try {
      const content = await adminApi.userContent(userId);
      const wrap = el('div');
      wrap.appendChild(
        el('h3', null, `Demos: ${content.demos.count}, ${bytes(content.demos.bytes)}`)
      );
      if (content.demos.items.length) {
        wrap.appendChild(
          table(
            ['Name', 'Map', 'Visibility', 'Size', 'Uploaded', ''],
            content.demos.items.map((d) => [
              d.name || d.id,
              d.map || '',
              d.visibility || '',
              bytes(d.sizeBytes),
              date(d.uploadedAt),
              button('Delete', async () => {
                if (!window.confirm(`Delete ${d.name || d.id}? This cannot be undone.`)) return;
                try {
                  await adminApi.content('demos', 'delete', { demoId: d.id, userId });
                  notice(wrap, 'Demo deleted.');
                  loadContent();
                } catch (err) {
                  notice(wrap, err.message, 'error');
                }
              })
            ])
          )
        );
      }

      wrap.appendChild(el('h3', null, 'Teams'));
      if (content.teams.length) {
        wrap.appendChild(
          table(
            ['Name', 'Role', 'Members', 'Seats'],
            content.teams.map((t) => [
              t.name,
              t.isOwner ? 'owner' : 'member',
              t.members,
              t.seatCapacity ?? 'default'
            ])
          )
        );
      } else {
        wrap.appendChild(el('p', 'admin-empty', 'No teams.'));
      }
      render(contentBox, wrap);
    } catch (err) {
      render(contentBox, el('p', 'admin-error', err.message));
    }
  }

  load();
  return root;
}
