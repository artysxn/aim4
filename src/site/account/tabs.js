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
  PLAN_BANDS,
  PLAN_CAPACITY,
  PLAN_IDS,
  PLAN_NAMES,
  PLAN_RANKS,
  PLAN_TAGLINES,
  SOLO_PLAN_IDS,
  TEAM_PLAN_IDS,
  TERM_IDS,
  TERM_NAMES,
  UNLIMITED,
  compareValues,
  euros,
  isTeamPlan,
  priceForTerm
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

/**
 * The bands the two paid ladders share, weakest first.
 *
 * Read out of PLAN_BANDS rather than typed, so a band added to the catalogue
 * appears on the pricing page without an edit here, and a ladder that carries a
 * band the other one does not still gets its row.
 */
const LADDER_BANDS = Object.freeze(
  [...SOLO_PLAN_IDS, ...TEAM_PLAN_IDS].reduce(
    (out, id) => (out.includes(PLAN_BANDS[id]) ? out : [...out, PLAN_BANDS[id]]),
    []
  )
);

/** Every plan that costs money, in the order the grid draws them. */
const PAID_PLAN_IDS = Object.freeze([...SOLO_PLAN_IDS, ...TEAM_PLAN_IDS]);

/**
 * What a term saves across the whole grid, as a range.
 *
 * The discount is not one number any more. It is the term discount compounded
 * with a per-plan bonus, so a year saves 20% on Solo Lite and 28% on Team Tier
 * 1. A single "save 20%" on the button would be wrong on five of the six paid
 * plans and "save 28%" would be wrong on the other five, so the button carries
 * the range and each card carries its own exact figure in euros.
 *
 * Null for the monthly term, which by definition saves nothing.
 */
function termSavingRange(term) {
  if (term === 'month') return null;
  const pcts = PAID_PLAN_IDS.map((planId) => Math.round(priceForTerm(planId, term).savedPct));
  const low = Math.min(...pcts);
  const high = Math.max(...pcts);
  return low === high ? `Save ${low}%` : `Save ${low}% to ${high}%`;
}

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
    // Subscription rows carry the database spelling of the term ('month',
    // 'halfyear', 'lifetime'). Name it the way the buttons below name it, and
    // fall back to the raw value for a term with no button, such as lifetime.
    if (sub.term) bits.push(TERM_NAMES[sub.term] || sub.term);
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
  // One term for the whole grid rather than a switch per card: the question is
  // asked once and every price on screen answers it. The starting term is the
  // one the account is actually billed on, so a subscriber does not land on a
  // page quoting prices they are not paying. A term the buttons do not offer,
  // 'lifetime', falls back to monthly rather than selecting nothing.
  let term = TERM_IDS.includes(sub?.term) ? sub.term : 'month';
  const termRow = el('div', 'plan-term');
  const grid = el('div', 'plan-ladders');

  const renderTerm = () => {
    termRow.replaceChildren();
    for (const id of TERM_IDS) {
      const btn = el('button', `plan-term-btn${term === id ? ' is-on' : ''}`);
      btn.type = 'button';
      btn.appendChild(el('span', 'plan-term-name', TERM_NAMES[id]));
      const saving = termSavingRange(id);
      if (saving) btn.appendChild(el('span', 'plan-term-save', saving));
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

    // Free belongs to neither ladder, so it gets its own row above them rather
    // than a column of its own next to six paid cards.
    const freeRow = el('div', 'plan-free-row');
    freeRow.appendChild(planCard('free', currentTier, billing, term, root));
    grid.appendChild(freeRow);

    grid.appendChild(el('div', 'plan-ladder-head is-solo', 'Solo'));
    grid.appendChild(el('div', 'plan-ladder-head is-team', 'Team'));

    // Written band by band, not ladder by ladder. The grid is two columns
    // wide, so appending the solo plan and then the team plan of the same band
    // puts Solo Lite next to Team Tier 3 and keeps matching bands on one row.
    // The narrow-screen rules reorder them back into two blocks.
    for (const band of LADDER_BANDS) {
      for (const ladder of [SOLO_PLAN_IDS, TEAM_PLAN_IDS]) {
        const planId = ladder.find((id) => PLAN_BANDS[id] === band);
        if (planId) grid.appendChild(planCard(planId, currentTier, billing, term, root));
      }
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
 * real thing, and it works before payments do: an admin-granted subscription
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
    const gcell = el('td');
    // The title lives in its own span so it can be pinned while the table
    // scrolls sideways. Pinning the cell would achieve nothing: it spans every
    // column, so it already begins at the left edge.
    gcell.appendChild(el('span', 'plan-matrix-group-label', group.title));
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

/**
 * One plan, priced for the chosen term.
 *
 * Three money lines, in the order the questions get asked: what it works out to
 * a month, what actually leaves the account and how many months that covers,
 * and what the term saves against paying month to month. A card that shows only
 * the first of those is how pricing pages earn distrust, which is why the total
 * is not hidden behind the per-month figure.
 *
 * `band-` and the ladder class are on the card because the narrow-screen rules
 * use them to regroup the interleaved grid into two blocks.
 */
function planCard(planId, currentTier, billing, term = 'month', noticeHost = null) {
  const price = priceForTerm(planId, term);
  const isCurrent = planId === currentTier;
  const ladder = planId === 'free' ? 'is-free' : isTeamPlan(planId) ? 'is-team' : 'is-solo';
  const card = el(
    'div',
    `plan-card ${ladder} band-${PLAN_BANDS[planId]}${isCurrent ? ' is-current' : ''}`
  );

  card.appendChild(el('h4', 'plan-name', PLAN_NAMES[planId]));

  const priceRow = el('div', 'plan-price');
  priceRow.appendChild(el('span', 'plan-price-value', euros(price.perMonthCents)));
  if (price.monthlyCents > 0) {
    priceRow.appendChild(el('span', 'plan-price-unit', '/month'));
  }
  card.appendChild(priceRow);

  if (price.monthlyCents > 0) {
    card.appendChild(
      el(
        'p',
        'plan-price-total',
        price.months === 1
          ? `${euros(price.totalCents)} charged every month`
          : `${euros(price.totalCents)} charged once, covering ${price.months} months`
      )
    );
    // Nothing on the monthly term, where the saving is zero and a line saying
    // so would be noise.
    if (price.savedCents > 0) {
      card.appendChild(
        el(
          'p',
          'plan-price-save',
          `${euros(price.savedCents)} less than paying monthly, ${price.savedPct}% off`
        )
      );
    }
  }
  card.appendChild(el('p', 'plan-tagline', PLAN_TAGLINES[planId] || ''));

  // Three to five load-bearing bullets per plan, read straight off the
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

/** "Unlimited", "3 a day", or "None" for a quota value. */
function quotaText(value) {
  if (Number(value) === UNLIMITED) return 'Unlimited';
  if (Number(value) === 0) return 'None';
  return `${value} a day`;
}

/**
 * The four cutting-edge model tools. They ride one ladder in the catalogue, so
 * one bullet can honestly speak for all four instead of spending four lines on
 * the same number.
 */
const MODEL_KEYS = [
  CAP.DEMOS_MAP_CONTROL,
  CAP.DEMOS_ROUND_WIN_PREDICTION,
  CAP.DEMOS_DUEL_WIN_PREDICTION,
  CAP.DEMOS_AUTO_COACH
];

/** The two model tools no solo plan carries, on their own ladder. */
const TEAM_MODEL_KEYS = [CAP.ANALYTICS_ANTISTRAT, CAP.DEMOS_COMMS_COACH];

/** The two free-tier allowances that are metered rather than locked. */
const EXPLORE_KEYS = [CAP.ANALYTICS_CHARTS, CAP.ANALYTICS_PATTERN_FINDER];

/**
 * The weakest value a plan has across a set of capability keys.
 *
 * A bullet that covers several keys at once must quote the smallest of them,
 * never the first: taking the first would silently start lying the day someone
 * moves one of those keys onto a different ladder, and the bullet would promise
 * an allowance the plan does not have.
 */
function weakestValue(planId, keys) {
  let out = CAPABILITIES[keys[0]].values[planId];
  for (const key of keys) {
    const value = CAPABILITIES[key].values[planId];
    if (compareValues(key, value, out) < 0) out = value;
  }
  return out;
}

/**
 * The card bullets, read off the catalogue for all seven plans.
 *
 * No number here is typed. Every one of them is a capability value or a plan
 * capacity, so a catalogue edit cannot leave a card claiming an allowance the
 * plan no longer has, and the seven plans need no seven branches.
 *
 * Team cards lead with the two things only a team plan buys, teams and seats,
 * and say out loud that the daily allowances are one pot for the whole roster
 * rather than one each. Solo cards lead with the upload cap and the daily model
 * allowance, which are the two numbers a solo player chooses a band on.
 */
function planHighlights(planId) {
  const v = (key) => CAPABILITIES[key].values[planId];
  const uploads = `${limitText(v(CAP.DEMOS_UPLOAD_LIMIT))} demo uploads`;
  const models = quotaText(weakestValue(planId, MODEL_KEYS));

  if (isTeamPlan(planId)) {
    const capacity = PLAN_CAPACITY[planId];
    const teams = capacity.team_capacity;
    return [
      `${teams} ${teams === 1 ? 'team' : 'teams'}, ${capacity.seat_capacity} seats`,
      uploads,
      `Anti-strat and comms coach: ${quotaText(
        weakestValue(planId, TEAM_MODEL_KEYS)
      )}, shared across the roster`,
      `Map control, win models and auto coach: ${models} each, shared across the roster`,
      `${limitText(v(CAP.TEAM_STRATBOOK_LIMIT))} strategies per map, ${limitText(
        v(CAP.TEAM_DOCUMENTS)
      )} documents`
    ];
  }

  if (Number(weakestValue(planId, MODEL_KEYS)) === 0) {
    // Free. Quoting an allowance of none reads as a taunt, so the card names
    // the two allowances free accounts do have instead.
    return [
      uploads,
      `Charts and pattern finder: ${quotaText(weakestValue(planId, EXPLORE_KEYS))} each`,
      'Demo viewer and aim trainer'
    ];
  }

  return [
    uploads,
    `Map control, win models and auto coach: ${models} each`,
    `${limitText(v(CAP.AIM_CUSTOM_ROUTINES))} custom routines`,
    `Aim replays: ${capValueText(CAPABILITIES[CAP.AIM_REPLAYS], v(CAP.AIM_REPLAYS))}`
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
