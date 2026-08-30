// ---------------------------------------------------------------------------
// src/site/admin/codesPanel.js
// Minting trial codes and promo codes.
//
// Two kinds, one panel, because an admin arrives wanting to give something
// away and only then cares which mechanism does it. The split is stated at the
// top of the panel rather than left implicit, since the two behave differently
// in ways that matter: a trial code grants access without a card and can be
// revoked from the account it landed on, while a promo code discounts a real
// payment and lives in Paddle, where it counts its own redemptions.
// ---------------------------------------------------------------------------

import { PLAN_IDS, PLAN_NAMES, SOLO_PLAN_IDS } from '../../../shared/entitlements/catalogue.js';
import { adminApi } from './adminApi.js';
import { button, date, el, field, input, notice, select, table } from './dom.js';

/** Paid plans only. A code for the free tier grants what everyone already has. */
const PAID_PLANS = PLAN_IDS.filter((id) => id !== 'free');
const PLAN_OPTIONS = PAID_PLANS.map((id) => ({ value: id, label: PLAN_NAMES[id] }));
const DEFAULT_PLAN = SOLO_PLAN_IDS[0];

/** Durations people actually reach for, plus a free-text day count. */
const DURATION_PRESETS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom' }
];

/** dom.input is positional and has no min/max, which these numeric fields want. */
function numberInput(value = '', placeholder = '', { min, max } = {}) {
  const node = input('number', value, placeholder);
  if (min !== undefined) node.min = String(min);
  if (max !== undefined) node.max = String(max);
  return node;
}

export function codesPanel() {
  const root = el('div', 'admin-panel');

  root.appendChild(el('h2', null, 'Codes'));
  root.appendChild(
    el(
      'p',
      'admin-muted',
      'Trial codes grant a plan for a set time with no payment. Promo codes discount a real ' +
        'purchase and live in Paddle. Use a trial code to hand someone access; use a promo code ' +
        'to make a plan cheaper at checkout.'
    )
  );

  root.appendChild(trialSection());
  root.appendChild(promoSection());
  return root;
}

// ---------------------------------------------------------------------------
// Trial codes
// ---------------------------------------------------------------------------

function trialSection() {
  const box = el('div', 'admin-subpanel');
  box.appendChild(el('h3', null, 'Trial codes'));

  const planSel = select(PLAN_OPTIONS, DEFAULT_PLAN);
  const durationSel = select(DURATION_PRESETS, '30');
  const customDays = numberInput('', 'days', { min: 1, max: 3650 });
  customDays.style.display = 'none';
  durationSel.addEventListener('change', () => {
    customDays.style.display = durationSel.value === 'custom' ? '' : 'none';
  });

  // Either a count of random codes, or explicit names. Both are offered because
  // a giveaway wants 200 unguessable strings and a streamer wants their handle.
  const modeSel = select(
    [
      { value: 'random', label: 'Random codes' },
      { value: 'named', label: 'Specific names' }
    ],
    'random'
  );
  const countInput = numberInput('1', '', { min: 1, max: 500 });
  const prefixInput = input('text', '', 'AIM4 (optional)');
  const namesInput = input('text', '', 'LAUNCHDAY, MYSTREAM, PARTNER1');
  const namesRow = field('Names, comma separated', namesInput);
  namesRow.style.display = 'none';
  const countRow = field('How many', countInput);
  const prefixRow = field('Prefix', prefixInput);

  modeSel.addEventListener('change', () => {
    const named = modeSel.value === 'named';
    namesRow.style.display = named ? '' : 'none';
    countRow.style.display = named ? 'none' : '';
    prefixRow.style.display = named ? 'none' : '';
  });

  const usesInput = numberInput('1', 'blank = unlimited', { min: 1 });
  const expiresInput = input('date');
  const batchInput = input('text', '', 'summer-giveaway');
  const noteInput = input('text', '', 'What this batch is for');

  box.appendChild(field('Plan', planSel));
  box.appendChild(field('Access lasts', durationSel));
  box.appendChild(field('Custom length', customDays));
  box.appendChild(field('Generate', modeSel));
  box.appendChild(countRow);
  box.appendChild(prefixRow);
  box.appendChild(namesRow);
  box.appendChild(field('Redemptions per code', usesInput));
  box.appendChild(field('Code stops working on', expiresInput));
  box.appendChild(field('Batch label', batchInput));
  box.appendChild(field('Note', noteInput));

  const output = el('div', 'admin-code-output');
  const list = el('div');

  box.appendChild(
    button(
      'Generate',
      async () => {
        output.replaceChildren();
        const days =
          durationSel.value === 'custom' ? Number(customDays.value) : Number(durationSel.value);
        if (!Number.isInteger(days) || days < 1) {
          notice(box, 'Give a whole number of days.', 'error');
          return;
        }
        const body = {
          planId: planSel.value,
          durationDays: days,
          // Blank means unlimited, which is a real choice for a public code.
          maxRedemptions: usesInput.value ? Number(usesInput.value) : null,
          expiresAt: expiresInput.value ? new Date(expiresInput.value).toISOString() : null,
          batch: batchInput.value.trim() || null,
          note: noteInput.value.trim()
        };
        if (modeSel.value === 'named') {
          body.names = namesInput.value.split(',').map((n) => n.trim()).filter(Boolean);
        } else {
          body.count = Number(countInput.value || 1);
          body.prefix = prefixInput.value.trim();
        }

        try {
          const res = await adminApi.mintCodes(body);
          renderMinted(output, res);
          await refresh(list);
        } catch (err) {
          notice(box, err.message, 'error');
        }
      },
      'btn btn-primary'
    )
  );

  box.appendChild(output);
  box.appendChild(list);
  refresh(list);
  return box;
}

/**
 * The generated codes, as text you can copy in one go.
 *
 * A table of 200 codes is unusable for the thing people actually do next,
 * which is paste them into a spreadsheet or a scheduler.
 */
function renderMinted(host, { created = [], rejected = [] }) {
  if (created.length) {
    host.appendChild(el('p', 'admin-ok', `${created.length} code${created.length === 1 ? '' : 's'} created.`));
    const area = el('textarea', 'admin-code-dump');
    area.readOnly = true;
    area.rows = Math.min(12, created.length + 1);
    area.value = created.map((c) => c.code).join('\n');
    host.appendChild(area);
    host.appendChild(
      button(
        'Copy all',
        () => navigator.clipboard?.writeText(area.value),
        'btn'
      )
    );
  }
  if (rejected.length) {
    host.appendChild(
      el(
        'p',
        'admin-warning',
        `${rejected.length} skipped: ${rejected.map((r) => `${r.code} (${r.reason})`).join(', ')}`
      )
    );
  }
}

async function refresh(host) {
  host.replaceChildren();
  let codes = [];
  try {
    codes = await adminApi.listCodes();
  } catch (err) {
    host.appendChild(el('p', 'admin-muted', err.message));
    return;
  }
  if (!codes.length) {
    host.appendChild(el('p', 'admin-muted', 'No active trial codes.'));
    return;
  }
  host.appendChild(el('h4', null, `Active trial codes (${codes.length})`));
  host.appendChild(
    table(
      ['Code', 'Plan', 'Grants', 'Used', 'Expires', 'Batch', ''],
      codes.map((c) => [
        c.code,
        PLAN_NAMES[c.plan_id] || c.plan_id,
        `${c.duration_days} days`,
        `${c.times_redeemed}${c.max_redemptions ? ` / ${c.max_redemptions}` : ''}`,
        c.expires_at ? date(c.expires_at) : 'never',
        c.batch || '',
        button(
          'Archive',
          async () => {
            await adminApi.archiveCodes({ ids: [c.id] });
            await refresh(host);
          },
          'btn btn-small'
        )
      ])
    )
  );
}

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------

function promoSection() {
  const box = el('div', 'admin-subpanel');
  box.appendChild(el('h3', null, 'Promo codes'));
  box.appendChild(
    el(
      'p',
      'admin-muted',
      'Created in Paddle and applied at checkout. Paddle counts redemptions and enforces limits.'
    )
  );

  const codeInput = input('text', '', 'LAUNCH20 (blank = Paddle generates one)');
  const typeSel = select(
    [
      { value: 'percentage', label: 'Percentage off' },
      { value: 'flat', label: 'Fixed amount off (cents)' }
    ],
    'percentage'
  );
  const amountInput = numberInput('20', '', { min: 1 });
  const descInput = input('text', '', 'What this code is for');
  const usesInput = numberInput('', 'blank = unlimited', { min: 1 });
  const expiresInput = input('date');

  // Which plans it works on. Nothing ticked means every plan, which is what
  // Paddle does with no restrict_to.
  const planBoxes = PAID_PLANS.map((id) => {
    const cb = input('checkbox');
    cb.value = id;
    const label = el('label', 'admin-check');
    label.appendChild(cb);
    label.appendChild(el('span', null, PLAN_NAMES[id]));
    return { id, cb, label };
  });
  const planWrap = el('div', 'admin-check-row');
  for (const p of planBoxes) planWrap.appendChild(p.label);

  // "Free for the first N periods, then normal price" is a recurring 100%
  // discount with a period cap, so it is expressed here rather than being a
  // separate kind of code.
  const recurCb = input('checkbox');
  const intervalsInput = numberInput('', 'periods', { min: 1 });
  intervalsInput.style.display = 'none';
  recurCb.addEventListener('change', () => {
    intervalsInput.style.display = recurCb.checked ? '' : 'none';
  });
  const recurLabel = el('label', 'admin-check');
  recurLabel.appendChild(recurCb);
  recurLabel.appendChild(el('span', null, 'Also applies to renewals'));

  box.appendChild(field('Code', codeInput));
  box.appendChild(field('Type', typeSel));
  box.appendChild(field('Amount', amountInput));
  box.appendChild(field('Works on', planWrap));
  box.appendChild(field('Recurring', recurLabel));
  box.appendChild(field('For how many periods', intervalsInput));
  box.appendChild(field('Total redemptions', usesInput));
  box.appendChild(field('Expires', expiresInput));
  box.appendChild(field('Description', descInput));

  const list = el('div');
  box.appendChild(
    button(
      'Create in Paddle',
      async () => {
        try {
          await adminApi.createPromoCode({
            code: codeInput.value.trim().toUpperCase() || undefined,
            type: typeSel.value,
            amount: String(amountInput.value),
            description: descInput.value.trim(),
            planIds: planBoxes.filter((p) => p.cb.checked).map((p) => p.id),
            usageLimit: usesInput.value ? Number(usesInput.value) : null,
            expiresAt: expiresInput.value ? new Date(expiresInput.value).toISOString() : null,
            recur: recurCb.checked,
            maximumRecurringIntervals: intervalsInput.value ? Number(intervalsInput.value) : null
          });
          notice(box, 'Created in Paddle.', 'ok');
          await refreshPromo(list);
        } catch (err) {
          notice(box, err.message, 'error');
        }
      },
      'btn btn-primary'
    )
  );

  box.appendChild(list);
  refreshPromo(list);
  return box;
}

async function refreshPromo(host) {
  host.replaceChildren();
  let codes = [];
  try {
    codes = await adminApi.listPromoCodes();
  } catch (err) {
    host.appendChild(el('p', 'admin-muted', `Paddle: ${err.message}`));
    return;
  }
  if (!codes.length) {
    host.appendChild(el('p', 'admin-muted', 'No active promo codes.'));
    return;
  }
  host.appendChild(el('h4', null, `Active promo codes (${codes.length})`));
  host.appendChild(
    table(
      ['Code', 'Discount', 'Recurs', 'Used', 'Expires', ''],
      codes.map((c) => [
        c.code || c.id,
        c.type === 'percentage' ? `${c.amount}%` : `${(Number(c.amount) / 100).toFixed(2)} off`,
        c.recur ? `yes${c.maximumRecurringIntervals ? ` x${c.maximumRecurringIntervals}` : ''}` : 'no',
        `${c.timesUsed}${c.usageLimit ? ` / ${c.usageLimit}` : ''}`,
        c.expiresAt ? date(c.expiresAt) : 'never',
        button(
          'Archive',
          async () => {
            await adminApi.archivePromoCode(c.id);
            await refreshPromo(host);
          },
          'btn btn-small'
        )
      ])
    )
  );
}
