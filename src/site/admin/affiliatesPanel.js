// ---------------------------------------------------------------------------
// src/site/admin/affiliatesPanel.js
// Affiliates: their terms, what they are owed, and recording what was paid.
//
// The one thing this panel cannot do is pay anybody. Paddle pays the seller,
// not the seller's affiliates, so there is no API call that could sit behind a
// "Pay" button. What happens instead is that someone makes a transfer and then
// records it here, which closes the commissions it covered. The button says
// "Record payout" for that reason and not as a euphemism.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, date, el, field, input, notice, select, table } from './dom.js';

/** Minor units and a currency code into something a person reads. */
function money(amount, currency = 'EUR') {
  const value = (Number(amount) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function numberInput(value = '', placeholder = '', { min, max, step } = {}) {
  const node = input('number', value, placeholder);
  if (min !== undefined) node.min = String(min);
  if (max !== undefined) node.max = String(max);
  if (step !== undefined) node.step = String(step);
  return node;
}

export function affiliatesPanel() {
  const panel = el('section', 'admin-panel');
  panel.appendChild(el('h2', null, 'Affiliates'));

  const controls = el('div', 'admin-controls');
  const statusFilter = select(
    [
      { value: '', label: 'All' },
      { value: 'active', label: 'Active' },
      { value: 'suspended', label: 'Suspended' }
    ],
    ''
  );
  statusFilter.setAttribute('aria-label', 'Status');
  controls.appendChild(statusFilter);

  const approve = button(
    'Approve everything past its hold',
    async () => {
      approve.disabled = true;
      try {
        const res = await adminApi.approveAffiliateCommissions();
        notice(
          panel,
          res.approved
            ? `${res.approved} commission${res.approved === 1 ? '' : 's'} approved for payout.`
            : 'Nothing is past its hold yet.',
          'ok'
        );
        await load();
      } catch (err) {
        notice(panel, err.message, 'error');
      } finally {
        approve.disabled = false;
      }
    },
    'btn'
  );
  controls.appendChild(approve);
  panel.appendChild(controls);

  const list = el('div', 'admin-list');
  panel.appendChild(list);

  async function load() {
    list.replaceChildren(el('p', 'admin-empty', 'Loading.'));
    try {
      const { affiliates, holdDays } = await adminApi.listAffiliates(statusFilter.value);
      list.replaceChildren();
      if (!affiliates.length) {
        list.appendChild(el('p', 'admin-empty', 'No affiliate codes yet.'));
        return;
      }
      for (const affiliate of affiliates) {
        list.appendChild(affiliateRow(affiliate, holdDays, load, panel));
      }
    } catch (err) {
      list.replaceChildren(el('p', 'admin-empty', err.message));
    }
  }

  statusFilter.addEventListener('change', load);
  load();
  return panel;
}

/** One affiliate: terms that can be edited, totals, and the ledger. */
function affiliateRow(affiliate, holdDays, reload, host) {
  const card = el('div', 'admin-card');

  const head = el('div', 'admin-card-head');
  head.appendChild(el('strong', null, affiliate.code));
  head.appendChild(
    el(
      'span',
      'admin-muted',
      `${affiliate.stats?.referrals ?? 0} referred, ${affiliate.stats?.payments ?? 0} payments`
    )
  );
  if (affiliate.status === 'suspended') {
    head.appendChild(el('span', 'admin-tag is-error', 'Suspended'));
  }
  card.appendChild(head);

  for (const bucket of affiliate.stats?.currencies || []) {
    card.appendChild(
      el(
        'div',
        'admin-muted',
        `${bucket.currency}: ${money(bucket.pending, bucket.currency)} held, ` +
          `${money(bucket.approved, bucket.currency)} ready to pay, ` +
          `${money(bucket.paid, bucket.currency)} paid`
      )
    );
  }

  // ---- terms ----
  const terms = el('div', 'admin-row');
  const pct = numberInput(String(affiliate.commissionPct), '', { min: 0, max: 100, step: 0.5 });
  terms.appendChild(field('Percent', pct));

  const recurring = select(
    [
      { value: '1', label: 'Renewals included' },
      { value: '0', label: 'First payment only' }
    ],
    affiliate.recurring ? '1' : '0'
  );
  terms.appendChild(field('Renewals', recurring));

  const maxMonths = numberInput(
    affiliate.maxMonths ? String(affiliate.maxMonths) : '',
    'Forever',
    { min: 1 }
  );
  terms.appendChild(field('Month limit', maxMonths));

  const status = select(
    [
      { value: 'active', label: 'Active' },
      { value: 'suspended', label: 'Suspended' }
    ],
    affiliate.status
  );
  terms.appendChild(field('Status', status));

  terms.appendChild(
    button(
      'Save',
      async () => {
        try {
          await adminApi.updateAffiliate({
            affiliateId: affiliate.id,
            commissionPct: Number(pct.value),
            recurring: recurring.value === '1',
            maxMonths: maxMonths.value ? Number(maxMonths.value) : null,
            status: status.value
          });
          // Said explicitly because it is the surprising part: a rate change is
          // not retroactive, since every ledger row froze the rate it was
          // earned at.
          notice(host, `${affiliate.code} updated. Existing commissions keep their old rate.`, 'ok');
          await reload();
        } catch (err) {
          notice(host, err.message, 'error');
        }
      },
      'btn btn-primary'
    )
  );
  card.appendChild(terms);

  // ---- ledger ----
  const ledger = el('div', 'admin-sub');
  const toggle = button(
    'Commissions',
    async () => {
      if (ledger.childElementCount) {
        ledger.replaceChildren();
        return;
      }
      ledger.replaceChildren(el('p', 'admin-empty', 'Loading.'));
      try {
        const rows = await adminApi.listAffiliateCommissions(affiliate.id);
        ledger.replaceChildren();
        if (!rows.length) {
          ledger.appendChild(el('p', 'admin-empty', 'Nothing earned yet.'));
          return;
        }
        ledger.appendChild(payoutForm(affiliate, rows, holdDays, reload, host));
      } catch (err) {
        ledger.replaceChildren(el('p', 'admin-empty', err.message));
      }
    },
    'btn'
  );
  card.appendChild(toggle);
  card.appendChild(ledger);
  return card;
}

/**
 * The ledger, with the approved rows selectable for a payout.
 *
 * Only approved rows get a checkbox. Paying something still inside its refund
 * hold is the mistake this prevents, and it is easier to prevent than to
 * unwind: getting money back from a person is a conversation, not an API call.
 */
function payoutForm(affiliate, rows, holdDays, reload, host) {
  const wrap = el('div');
  const picked = new Set();

  const totals = el('div', 'admin-muted');
  const refreshTotal = () => {
    const chosen = rows.filter((r) => picked.has(r.id));
    const sum = chosen.reduce((n, r) => n + Number(r.commission_amount), 0);
    const currency = chosen[0]?.currency || 'EUR';
    totals.textContent = chosen.length
      ? `${chosen.length} selected, ${money(sum, currency)}`
      : 'Nothing selected.';
  };

  wrap.appendChild(
    table(
      ['', 'Date', 'Type', 'Sale', 'Rate', 'Owed', 'Status'],
      rows.map((r) => {
        let picker;
        if (r.status === 'approved') {
          picker = input('checkbox');
          picker.addEventListener('change', () => {
            if (picker.checked) picked.add(r.id);
            else picked.delete(r.id);
            refreshTotal();
          });
        } else {
          picker = el('span', null, '');
        }
        return [
          picker,
          date(r.occurred_at),
          r.is_renewal ? 'Renewal' : 'First',
          money(r.base_amount, r.currency),
          `${Number(r.commission_pct)}%`,
          money(r.commission_amount, r.currency),
          r.status === 'pending' ? `Held to ${date(r.payable_at)}` : r.status
        ];
      })
    )
  );
  wrap.appendChild(totals);
  refreshTotal();

  const form = el('div', 'admin-row');
  const method = input('text', '', 'SEPA, PayPal, Wise');
  const reference = input('text', '', 'Bank reference');
  form.appendChild(field('Method', method));
  form.appendChild(field('Reference', reference));
  form.appendChild(
    button(
      'Record payout',
      async () => {
        if (!picked.size) {
          notice(host, 'Pick the commissions this payout covered.', 'error');
          return;
        }
        try {
          const res = await adminApi.recordAffiliatePayout({
            affiliateId: affiliate.id,
            commissionIds: [...picked],
            method: method.value || null,
            reference: reference.value || null
          });
          notice(
            host,
            `Recorded ${money(res.amount, res.currency)} to ${affiliate.code} over ${res.count} commissions.`,
            'ok'
          );
          await reload();
        } catch (err) {
          notice(host, err.message, 'error');
        }
      },
      'btn btn-primary'
    )
  );
  wrap.appendChild(form);
  return wrap;
}
