// ---------------------------------------------------------------------------
// src/site/admin/auditPanel.js
// The audit log, filterable.
//
// This is the panel that makes impersonation defensible. If a user asks what an
// admin looked at, the answer comes from here.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, date, el, input, render, table } from './dom.js';
import { spinnerNode } from '../../lib/spinner.js';

const ACTIONS = [
  '',
  'impersonate.start',
  'impersonate.start.write',
  'impersonate.activity',
  'impersonate.end',
  'grant.create',
  'grant.revoke',
  'subscription.create',
  'subscription.cancel',
  'trial.start',
  'seat.assign',
  'seat.release',
  'account.export',
  'account.delete.request'
];

export function auditPanel() {
  const root = el('div', 'admin-panel');
  const controls = el('div', 'admin-controls');
  const results = el('div', 'admin-results');

  const actor = input('text', '', 'Actor UUID');
  const target = input('text', '', 'Target UUID');
  const action = document.createElement('select');
  for (const a of ACTIONS) {
    const option = document.createElement('option');
    option.value = a;
    option.textContent = a || 'Any action';
    action.appendChild(option);
  }

  let offset = 0;

  async function load() {
    render(results, spinnerNode());
    try {
      const { entries } = await adminApi.audit({
        actorId: actor.value.trim(),
        targetUser: target.value.trim(),
        action: action.value,
        offset
      });
      const rows = entries.map((e) => [
        date(e.created_at),
        e.action,
        e.actor_id,
        e.target_user || '',
        // Payloads are arbitrary JSON. textContent, never innerHTML.
        el('code', 'admin-payload', JSON.stringify(e.payload || {}).slice(0, 300))
      ]);
      const wrap = el('div');
      wrap.appendChild(table(['When', 'Action', 'Actor', 'Target', 'Detail'], rows));
      if (!rows.length) wrap.appendChild(el('p', 'admin-empty', 'Nothing recorded.'));

      const pager = el('div', 'admin-pager');
      if (offset > 0) {
        pager.appendChild(
          button('Newer', () => {
            offset = Math.max(0, offset - 100);
            load();
          })
        );
      }
      if (entries.length === 100) {
        pager.appendChild(
          button('Older', () => {
            offset += 100;
            load();
          })
        );
      }
      wrap.appendChild(pager);
      render(results, wrap);
    } catch (err) {
      render(results, el('p', 'admin-error', err.message));
    }
  }

  for (const control of [actor, target, action]) {
    control.addEventListener('change', () => {
      offset = 0;
      load();
    });
  }

  controls.append(actor, target, action, button('Refresh', load));
  root.append(controls, results);
  load();
  return root;
}
