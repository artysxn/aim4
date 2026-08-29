// ---------------------------------------------------------------------------
// src/site/admin/usersPanel.js
// Search, list, drill in.
// ---------------------------------------------------------------------------

import { PLAN_IDS, PLAN_NAMES } from '../../../shared/entitlements/catalogue.js';
import { adminApi } from './adminApi.js';
import { button, date, el, input, render, select, table } from './dom.js';
import { spinnerNode } from '../../lib/spinner.js';

const STATUSES = ['', 'trialing', 'active', 'past_due', 'cancelled', 'expired'];

export function usersPanel({ onOpenUser }) {
  const root = el('div', 'admin-panel');
  const controls = el('div', 'admin-controls');
  const results = el('div', 'admin-results');

  const search = input('search', '', 'Username or email');
  const tier = select([{ value: '', label: 'Any tier' }, ...PLAN_IDS.map((id) => ({ value: id, label: PLAN_NAMES[id] }))]);
  const status = select(STATUSES.map((s) => ({ value: s, label: s || 'Any status' })));
  const sort = select([
    { value: 'created_at', label: 'Newest' },
    { value: 'last_sign_in_at', label: 'Last seen' },
    { value: 'username', label: 'Username' },
    { value: 'effective_tier', label: 'Tier' }
  ]);

  let page = 0;

  async function load() {
    render(results, spinnerNode());
    try {
      const data = await adminApi.users({
        q: search.value.trim(),
        tier: tier.value,
        status: status.value,
        sort: sort.value,
        page
      });
      renderUsers(data);
    } catch (err) {
      render(results, el('p', 'admin-error', err.message));
    }
  }

  function renderUsers(data) {
    const rows = (data.users || []).map((u) => {
      // A red name is the probation marker: visible from the list without
      // opening the account. The detail pane carries the evidence and the
      // lift button.
      const open = button(
        u.username || '(no username)',
        () => onOpenUser(u.id),
        `link-btn${u.probation_at ? ' admin-probation' : ''}`
      );
      if (u.probation_at) open.title = 'On probation: potential account sharing';
      // An account with no row yet reads as the base tier, under its catalogue
      // name: the column is a list of plan names, and one lowercase id in the
      // middle of it looks like a bug rather than like Free.
      const tierCell = el(
        'span',
        'admin-tier',
        `${PLAN_NAMES[u.effective_tier] || u.effective_tier || PLAN_NAMES[PLAN_IDS[0]]}${
          u.is_admin ? ' (admin)' : ''
        }`
      );
      return [
        open,
        u.email || '',
        tierCell,
        u.subscription_status || '',
        u.seats_held || 0,
        date(u.last_sign_in_at),
        date(u.created_at)
      ];
    });

    const wrap = el('div');
    wrap.appendChild(
      table(['Username', 'Email', 'Tier', 'Subscription', 'Seats', 'Last seen', 'Joined'], rows)
    );

    if (!rows.length) wrap.appendChild(el('p', 'admin-empty', 'No accounts match.'));

    const pager = el('div', 'admin-pager');
    if (page > 0) {
      pager.appendChild(
        button('Previous', () => {
          page -= 1;
          load();
        })
      );
    }
    if (data.hasMore) {
      pager.appendChild(
        button('Next', () => {
          page += 1;
          load();
        })
      );
    }
    wrap.appendChild(pager);
    render(results, wrap);
  }

  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      page = 0;
      load();
    }, 250);
  });
  for (const control of [tier, status, sort]) {
    control.addEventListener('change', () => {
      page = 0;
      load();
    });
  }

  controls.append(search, tier, status, sort);
  root.append(controls, results);
  load();
  return root;
}
