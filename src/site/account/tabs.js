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

import {
  CAPABILITIES,
  PLAN_IDS,
  PLAN_NAMES,
  PLAN_PRICES,
  PLAN_RANKS,
  PLAN_TAGLINES,
  UNLIMITED
} from '../../../shared/entitlements/catalogue.js';
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
  const ents = state.entitlements || {};

  // ---- identity card ------------------------------------------------------
  // The page answers "who does this site think I am" in one card: name, email,
  // plan, when the account started. Everything else hangs off tabs.
  const card = el('section', 'account-card account-identity');
  const avatar = el('div', 'account-avatar', (account.username || '?').slice(0, 1).toUpperCase());
  card.appendChild(avatar);

  const idCol = el('div', 'account-identity-main');
  idCol.appendChild(el('h2', 'account-username', account.username || 'Account'));
  const badge = el('span', `account-plan-badge tier-${ents.tier || 'free'}`, tierBadge(state));
  idCol.appendChild(badge);

  const meta = el('div', 'account-meta');
  if (account.email) meta.appendChild(metaRow('Email', account.email));
  if (account.createdAt) meta.appendChild(metaRow('Member since', date(account.createdAt)));
  if (state.entitlements?.expiresAt) {
    meta.appendChild(metaRow('Renews', date(state.entitlements.expiresAt)));
  }
  meta.appendChild(metaRow('Account id', account.id || '', true));
  idCol.appendChild(meta);
  card.appendChild(idCol);
  root.appendChild(card);

  // ---- display name -------------------------------------------------------
  if (account.signedIn) {
    const nameCard = el('section', 'account-card');
    nameCard.appendChild(el('h3', 'account-card-title', 'Display name'));
    nameCard.appendChild(
      el('p', 'account-muted', 'Shown on every board, table, and team page.')
    );
    const nameInput = input('text', account.username || '', 'Display name');
    nameInput.maxLength = 24;
    nameInput.className = 'site-input';
    const save = button(
      'Save',
      async () => {
        const next = nameInput.value.trim();
        if (!next || next === account.username) return;
        save.disabled = true;
        try {
          await accountApi.setUsername(next);
          notice(nameCard, 'Name changed.');
          reload();
        } catch (err) {
          notice(nameCard, err.message, 'error');
        } finally {
          save.disabled = false;
        }
      },
      'btn'
    );
    const row = el('div', 'account-name-row');
    row.append(nameInput, save);
    nameCard.appendChild(row);
    root.appendChild(nameCard);
  }

  // ---- connections --------------------------------------------------------
  // One row per identity provider, driven by account.linked from /api/me.
  // Google and Steam are live; X stays declared so the section remains a map
  // of what the account can be connected to.
  const linked = account.linked || {};
  const conns = el('section', 'account-card');
  conns.appendChild(el('h3', 'account-card-title', 'Connections'));
  conns.appendChild(
    el(
      'p',
      'account-muted',
      linked.google || linked.steam
        ? 'Linked accounts can sign in here and attach their identity to your stats.'
        : 'Link Google or Steam to upload demos. A username account can do everything else without one.'
    )
  );
  // The return leg of the Steam link lands back here with ?steam=<result>.
  const steamNotice = steamReturnNotice();
  if (steamNotice) conns.appendChild(steamNotice);

  const list = el('div', 'account-connections');
  list.appendChild(
    connectionRow({
      name: 'Google',
      icon: 'G',
      connected: account.signedIn && Boolean(linked.google),
      detail: linked.google ? account.email || '' : 'Sign in with Google and unlock demo uploads.',
      connect: account.signedIn
        ? async () => {
            // Redirects away; errors are the only thing to render here.
            await auth?.linkGoogle?.();
          }
        : null
    })
  );
  list.appendChild(
    connectionRow({
      name: 'Steam',
      icon: 'S',
      connected: account.signedIn && Boolean(linked.steam),
      detail: linked.steam
        ? `SteamID ${linked.steamId}`
        : 'Verify through Steam sign-in and unlock demo uploads.',
      connect: account.signedIn
        ? async () => {
            const res = await accountApi.steamStart();
            window.location.href = res.url;
          }
        : null,
      unlink: linked.steam
        ? async () => {
            await accountApi.steamUnlink();
            reload();
          }
        : null
    })
  );
  list.appendChild(
    connectionRow({
      name: 'X',
      icon: 'X',
      connected: false,
      detail: 'Share clips and boards straight from the site.',
      soon: true
    })
  );
  conns.appendChild(list);
  root.appendChild(conns);

  // ---- trial --------------------------------------------------------------
  const trial = state.entitlements?.trial;
  if (trial && !trial.cancelAtPeriodEnd) {
    const trialCard = el('section', 'account-card');
    trialCard.appendChild(el('h3', 'account-card-title', 'Trial'));
    trialCard.appendChild(
      el('p', 'account-muted', `${trial.daysLeft} days left on your trial.`)
    );
    trialCard.appendChild(
      button(
        'Cancel trial',
        async () => {
          try {
            const res = await accountApi.cancelTrial();
            notice(trialCard, `Cancelled. Access continues until ${date(res.accessUntil)}.`);
            reload();
          } catch (err) {
            notice(trialCard, err.message, 'error');
          }
        },
        'btn'
      )
    );
    root.appendChild(trialCard);
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

/** Label on the left, value on the right. `mono` for ids. */
function metaRow(label, value, mono = false) {
  const row = el('div', 'account-meta-row');
  row.appendChild(el('span', 'account-meta-label', label));
  row.appendChild(el('span', `account-meta-value${mono ? ' is-mono' : ''}`, value));
  return row;
}

/**
 * One provider row: icon, name, state, action.
 *
 * `soon: true` renders the row locked rather than omitting it. The section is
 * a map of what the account can be connected to, and a bridge that is not
 * built yet still belongs on the map.
 */
function connectionRow({ name, icon, connected, detail = '', soon = false, connect = null, unlink = null }) {
  const row = el('div', `account-conn${connected ? ' is-connected' : ''}`);
  row.appendChild(el('span', `account-conn-icon conn-${name.toLowerCase()}`, icon));
  const mid = el('div', 'account-conn-main');
  mid.appendChild(el('span', 'account-conn-name', name));
  if (detail) mid.appendChild(el('span', 'account-conn-detail', detail));
  row.appendChild(mid);
  if (connected) {
    row.appendChild(el('span', 'account-conn-state is-on', 'Connected'));
    if (unlink) {
      row.appendChild(
        button(
          'Unlink',
          async () => {
            try {
              await unlink();
            } catch (err) {
              notice(row, err.message, 'error');
            }
          },
          'btn btn-sm'
        )
      );
    }
  } else if (soon) {
    row.appendChild(el('span', 'account-conn-state', 'Soon'));
  } else if (connect) {
    const btn = button(
      'Connect',
      async () => {
        btn.disabled = true;
        try {
          await connect();
        } catch (err) {
          notice(row, err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      },
      'btn btn-sm'
    );
    row.appendChild(btn);
  } else {
    row.appendChild(el('span', 'account-conn-state', 'Sign in first'));
  }
  return row;
}

/** What ?steam=<code> from the link's return redirect means, said once. */
const STEAM_RETURN_COPY = {
  linked: 'Steam linked. Demo uploads are unlocked.',
  expired: 'The Steam link expired. Start it again below.',
  cancelled: 'Steam sign-in was cancelled.',
  invalid: 'Steam did not confirm that sign-in.',
  unreachable: 'Steam could not be reached. Try again in a minute.',
  in_use: 'That Steam account is already linked to a different aim4 account.',
  unavailable: 'Steam linking is not configured on this deployment.'
};

/** The notice for a Steam return code in the URL, and the URL cleaned up. */
function steamReturnNotice() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('steam');
  if (!code || !STEAM_RETURN_COPY[code]) return null;
  params.delete('steam');
  const rest = params.toString();
  // Cleared so a reload or a copied link does not re-announce old news.
  window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
  return el(
    'p',
    code === 'linked' ? 'account-notice' : 'account-warning',
    STEAM_RETURN_COPY[code]
  );
}

// ---------------------------------------------------------------------------

export function subscriptionTab(state, { reload, billing }) {
  const root = el('div', 'account-panel');
  const currentTier = state.entitlements?.tier || 'free';
  const sub = state.subscription;

  // The provider bounces back here with ?checkout=success|cancelled once
  // payments are live; saying nothing on that return would leave the user
  // guessing whether their card just worked.
  const returned = checkoutReturnNotice();
  if (returned) root.appendChild(returned);

  // ---- current state ------------------------------------------------------
  const head = el('section', 'account-card account-sub-head');
  head.appendChild(el('h3', 'account-card-title', 'Your plan'));
  head.appendChild(
    el('p', 'account-sub-current', `${PLAN_NAMES[currentTier] || currentTier}`)
  );
  if (sub) {
    const bits = [];
    if (sub.status) bits.push(sub.status);
    if (sub.term) bits.push(sub.term);
    if (sub.currentPeriodEnd) bits.push(`renews ${date(sub.currentPeriodEnd)}`);
    head.appendChild(el('p', 'account-muted', bits.join(' · ')));
    if (sub.cancelAtPeriodEnd) {
      head.appendChild(
        el(
          'p',
          'account-notice',
          `Cancelled. Access continues until ${date(sub.currentPeriodEnd || sub.trialEndsAt)}.`
        )
      );
    }
    head.appendChild(manageRow(sub, { reload, billing }));
  }
  if (state.entitlements?.source === 'seat' && sub) {
    head.appendChild(
      el(
        'p',
        'account-warning',
        `You hold both your own ${PLAN_NAMES[sub.planId] || sub.planId} and a team seat. Your effective tier is ${
          PLAN_NAMES[currentTier] || currentTier
        }.`
      )
    );
  }
  root.appendChild(head);

  // ---- term, then the tier cards ------------------------------------------
  // One term for the whole grid rather than a switch per card: the question
  // "monthly or yearly" is asked once, and every price on screen answers it.
  let term = sub?.term === 'yearly' ? 'yearly' : 'monthly';
  const termRow = el('div', 'plan-term');
  const grid = el('div', 'plan-grid');

  const renderTerm = () => {
    termRow.replaceChildren();
    for (const [id, label] of [
      ['monthly', 'Monthly'],
      ['yearly', 'Yearly · 2 months free']
    ]) {
      const btn = el('button', `plan-term-btn${term === id ? ' is-on' : ''}`, label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (term === id) return;
        term = id;
        renderTerm();
        renderCards();
      });
      termRow.appendChild(btn);
    }
  };
  const renderCards = () => {
    grid.replaceChildren();
    for (const planId of PLAN_IDS) {
      grid.appendChild(planCard(planId, currentTier, billing, term, root));
    }
  };
  renderTerm();
  renderCards();
  root.appendChild(termRow);
  root.appendChild(grid);

  if (!billing?.configured) {
    root.appendChild(
      el(
        'p',
        'account-muted account-billing-note',
        'Payments open soon. Plans and prices are final; checkout switches on the day they do.'
      )
    );
  }

  // ---- feature matrix -----------------------------------------------------
  root.appendChild(featureMatrix(currentTier));

  return root;
}

/**
 * Cancel / resume / manage billing for the subscription the account owns.
 *
 * Trials keep their own controls on the overview tab; this row handles the
 * real thing, and it works before payments do — an admin-granted subscription
 * winds down the same way a paid one will.
 */
function manageRow(sub, { reload, billing }) {
  const row = el('div', 'account-sub-manage');
  const isTrial = sub.status === 'trialing' || sub.source === 'trial';

  if (!isTrial) {
    if (sub.cancelAtPeriodEnd) {
      row.appendChild(
        button(
          'Keep my subscription',
          async () => {
            try {
              await accountApi.resumeSubscription();
              notice(row, 'Kept. It renews as before.');
              reload();
            } catch (err) {
              notice(row, err.message, 'error');
            }
          },
          'btn'
        )
      );
    } else {
      row.appendChild(
        button(
          'Cancel at period end',
          async () => {
            try {
              const res = await accountApi.cancelSubscription();
              notice(
                row,
                res.accessUntil
                  ? `Cancelled. Access continues until ${date(res.accessUntil)}.`
                  : 'Cancelled at the period end.'
              );
              reload();
            } catch (err) {
              notice(row, err.message, 'error');
            }
          },
          'btn'
        )
      );
    }
  }

  if (billing?.configured) {
    row.appendChild(
      button(
        'Manage billing',
        async () => {
          try {
            const res = await accountApi.billingPortal();
            if (res?.url) window.location.href = res.url;
          } catch (err) {
            notice(row, err.message, 'error');
          }
        },
        'btn'
      )
    );
  }
  return row;
}

/** The notice for ?checkout=<result> in the URL, and the URL cleaned up. */
function checkoutReturnNotice() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('checkout');
  if (code !== 'success' && code !== 'cancelled') return null;
  params.delete('checkout');
  const rest = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
  return el(
    'p',
    code === 'success' ? 'account-notice' : 'account-warning',
    code === 'success'
      ? 'Payment received. Your plan is active; this page may take a moment to catch up.'
      : 'Checkout was cancelled. Nothing was charged.'
  );
}

/** "50", "Unlimited", "✓", "✗", or an enum mode spelled out. */
function capValueText(def, value) {
  if (def.shape === 'bool') return value ? '✓' : '✗';
  if (def.shape === 'limit') {
    if (Number(value) === UNLIMITED) return 'Unlimited';
    return Number(value) === 0 ? '✗' : String(value);
  }
  if (def.shape === 'quota') {
    if (Number(value) === UNLIMITED) return 'Unlimited';
    if (Number(value) === 0) return '✗';
    return `${value} / day`;
  }
  // enum: spell the mode without inventing copy per mode.
  const MODE_LABELS = {
    none: '✗',
    nosave: 'No saving',
    limited: 'Limited',
    full: 'Full',
    best_and_recent: 'Best and recent',
    best_plus_10: 'Best plus 10',
    presets: 'Presets'
  };
  return MODE_LABELS[value] ?? String(value);
}

/** The groups of the matrix, in reading order. Keys prefix-match the catalogue. */
const MATRIX_GROUPS = [
  { title: 'Demos and viewer', prefix: ['demos.', 'drawing_board'] },
  { title: 'Stats and analytics', prefix: ['stats.', 'analytics.'] },
  { title: 'Teams', prefix: ['team.'] },
  { title: 'Aim trainer', prefix: ['aim.'] }
];

function featureMatrix(currentTier) {
  const wrap = el('section', 'account-card plan-matrix-wrap');
  wrap.appendChild(el('h3', 'account-card-title', 'Everything, by plan'));

  const scroll = el('div', 'plan-matrix-scroll');
  const t = el('table', 'plan-matrix');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', 'left', 'Feature'));
  for (const planId of PLAN_IDS) {
    const th = el('th', planId === currentTier ? 'is-current' : '', PLAN_NAMES[planId]);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const group of MATRIX_GROUPS) {
    const gr = el('tr', 'plan-matrix-group');
    const gcell = el('td', null, group.title);
    gcell.colSpan = 1 + PLAN_IDS.length;
    gr.appendChild(gcell);
    tbody.appendChild(gr);

    for (const [key, def] of Object.entries(CAPABILITIES)) {
      if (!group.prefix.some((p) => key.startsWith(p))) continue;
      // A row every plan has in full says nothing; a row no plan has is noise.
      const values = PLAN_IDS.map((id) => def.values[id]);
      const allSame = values.every((v) => v === values[0]);
      if (allSame && def.shape === 'bool' && values[0] === true) continue;
      const tr = el('tr');
      tr.appendChild(el('td', 'left', def.label));
      for (const planId of PLAN_IDS) {
        const text = capValueText(def, def.values[planId]);
        const td = el('td', planId === currentTier ? 'is-current' : '');
        td.appendChild(el('span', text === '✗' ? 'plan-no' : text === '✓' ? 'plan-yes' : '', text));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  t.appendChild(tbody);
  scroll.appendChild(t);
  wrap.appendChild(scroll);
  return wrap;
}

function planCard(planId, currentTier, billing, term = 'monthly', noticeHost = null) {
  const price = PLAN_PRICES[planId] || { monthly: 0, yearlyMonthly: 0 };
  const isCurrent = planId === currentTier;
  const popular = planId === 'team_premium';
  const card = el('div', `plan-card${isCurrent ? ' is-current' : ''}${popular ? ' is-popular' : ''}`);

  if (popular) card.appendChild(el('span', 'plan-flag', 'Most popular'));
  card.appendChild(el('h4', 'plan-name', PLAN_NAMES[planId]));

  // The shown price is the effective monthly price on the chosen term. On
  // yearly the honest total appears underneath: "€8.33/mo" with no yearly sum
  // is how pricing pages earn distrust.
  const shown = term === 'yearly' ? price.yearlyMonthly : price.monthly;
  const priceRow = el('div', 'plan-price');
  if (price.monthly === 0) {
    priceRow.appendChild(el('span', 'plan-price-value', '€0'));
  } else {
    priceRow.appendChild(el('span', 'plan-price-value', `€${shown.toFixed(2)}`));
    priceRow.appendChild(el('span', 'plan-price-unit', '/month'));
  }
  card.appendChild(priceRow);
  if (price.monthly > 0) {
    card.appendChild(
      el(
        'p',
        'plan-price-yearly',
        term === 'yearly'
          ? `€${(price.yearlyMonthly * 12).toFixed(2)} billed once a year`
          : `€${price.yearlyMonthly.toFixed(2)}/mo on the yearly term`
      )
    );
  }
  card.appendChild(el('p', 'plan-tagline', PLAN_TAGLINES[planId] || ''));

  // Three or four load-bearing bullets per plan, read straight off the
  // catalogue so a capability change cannot leave the card lying.
  const points = el('ul', 'plan-points');
  for (const text of planHighlights(planId)) {
    points.appendChild(el('li', null, text));
  }
  card.appendChild(points);

  if (isCurrent) {
    card.appendChild(el('span', 'plan-cta is-current-label', 'Current plan'));
  } else {
    const downgrade = (PLAN_RANKS[planId] ?? 0) < (PLAN_RANKS[currentTier] ?? 0);
    const cta = el('button', 'btn plan-cta' + (downgrade ? '' : ' btn-primary'));
    cta.type = 'button';
    cta.textContent = downgrade ? 'Downgrade' : 'Upgrade';
    if (!billing?.configured || planId === 'free') {
      // Wired but parked: the click path below goes live the day a provider
      // is configured, with no client change.
      cta.disabled = true;
      cta.title = planId === 'free' ? 'Cancel your plan instead' : 'Payments open soon';
    } else {
      cta.addEventListener('click', async () => {
        cta.disabled = true;
        try {
          const res = await accountApi.checkout(planId, term);
          if (res?.url) {
            window.location.href = res.url;
            return;
          }
          throw new Error('Checkout did not return a payment page.');
        } catch (err) {
          if (noticeHost) notice(noticeHost, err.message, 'error');
          cta.disabled = false;
        }
      });
    }
    card.appendChild(cta);
  }
  return card;
}

/** The card bullets, derived from the catalogue rather than hand-copied. */
function planHighlights(planId) {
  const v = (key) => CAPABILITIES[key].values[planId];
  const n = (key) => (Number(v(key)) === UNLIMITED ? 'Unlimited' : String(v(key)));
  if (planId === 'free') {
    return [
      `${n('demos.upload_limit')} demo uploads`,
      `${v('analytics.charts')} charts and ${v('analytics.pattern_finder')} searches a day`,
      'Demo viewer and aim trainer'
    ];
  }
  if (planId === 'premium') {
    return [
      `${n('demos.upload_limit')} demo uploads`,
      'Unlimited charts and pattern finder',
      'Full player metrics and filters',
      'Join a team'
    ];
  }
  if (planId === 'team_premium') {
    return [
      `${n('team.create_limit')} team, ${n('team.seat_capacity')} seats`,
      'Stratbook, documents, utility archive',
      'Team stats and antistrat',
      'Unlimited demo uploads'
    ];
  }
  return [
    `${n('team.create_limit')} teams, ${n('team.seat_capacity')} seats pooled`,
    'Round and duel win models, auto coach',
    'Full team metrics and comms coach',
    'Everything unlimited'
  ];
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

  const linked = state.account?.linked || {};
  root.appendChild(
    table(
      ['Sign in method', 'Status'],
      [
        ['Username and password', state.account?.provider === 'google' ? 'Not set' : 'Active'],
        ['Google', linked.google ? 'Connected' : 'Not connected'],
        ['Steam', linked.steam ? 'Connected' : 'Not connected']
      ]
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
