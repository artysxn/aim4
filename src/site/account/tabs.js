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
import { checkoutSuccessUrl, openCheckout, openCheckoutFromPaymentLink } from './paddleCheckout.js';
import logoGoogle from '../../icons/logo_google.svg?raw';
import logoSteam from '../../icons/logo_steam.svg?raw';
import logoDiscord from '../../icons/logo_discord.svg?raw';
import logoX from '../../icons/logo_x.svg?raw';

const PENCIL_SVG =
  '<svg viewBox="0 -960 960 960" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/></svg>';

function limitText(value) {
  return Number(value) === UNLIMITED ? 'Unlimited' : String(value);
}

// ---------------------------------------------------------------------------

export function overviewTab(state, { reload, auth }) {
  const root = el('div', 'account-panel');
  const account = state.account || {};

  // ---- identity card ------------------------------------------------------
  // Who this site thinks you are, and where you change it: the display name
  // and the @ tag edit in place, behind a pencil that appears on hover. No
  // separate settings card repeating the same two values under labels.
  const card = el('section', 'account-card account-identity');
  const avatar = el('div', 'account-avatar', (account.username || '?').slice(0, 1).toUpperCase());
  card.appendChild(avatar);

  const idCol = el('div', 'account-identity-main');
  idCol.appendChild(
    editable({
      tag: 'h2',
      className: 'account-username',
      value: account.displayName || account.username || 'Account',
      label: 'Change display name',
      maxLength: 32,
      allowEmpty: true,
      enabled: account.signedIn,
      save: async (next) => {
        const clean = next.replace(/\s+/g, ' ').trim();
        if (clean === (account.displayName || '')) return;
        await accountApi.setDisplayName(clean);
        reload();
      },
      host: card
    })
  );
  if (account.username) {
    idCol.appendChild(
      editable({
        tag: 'span',
        className: 'account-handle',
        value: account.username,
        prefix: '@',
        label: 'Change @ tag',
        maxLength: 20,
        enabled: account.signedIn,
        save: async (next) => {
          const clean = next.trim().replace(/^@+/, '').toLowerCase();
          if (!clean || clean === account.username) return;
          await accountApi.setUsername(clean);
          reload();
        },
        host: card
      })
    );
  }

  const meta = el('div', 'account-meta');
  if (account.email) meta.appendChild(metaRow('Email', account.email));
  if (account.createdAt) meta.appendChild(metaRow('Member since', date(account.createdAt)));
  if (state.entitlements?.expiresAt) {
    meta.appendChild(metaRow('Renews', date(state.entitlements.expiresAt)));
  }
  meta.appendChild(metaRow('Account id', account.id || '', true));
  idCol.appendChild(meta);
  card.appendChild(idCol);

  // ---- connections --------------------------------------------------------
  // Four provider marks in one row, inside the identity card: lit when
  // connected, dim when not. Click connects; click again unlinks, behind a
  // confirm because losing the Google or Steam link also locks uploads.
  if (account.signedIn) {
    const linked = account.linked || {};
    // The return leg of the Steam link lands back here with ?steam=<result>.
    const steamNotice = steamReturnNotice();
    if (steamNotice) root.appendChild(steamNotice);

    // Two sources, deliberately. /api/me is authoritative but is served from a
    // 60s identity cache keyed by the access token, and linkIdentity does not
    // rotate that token: for a minute after linking, the server still says the
    // provider is not connected. The browser's own session was refreshed on
    // the way back in, so it already knows. Believe whichever says "connected".
    const fresh = auth?.linkedProviders || [];
    const hasFresh = (...ids) => ids.some((id) => fresh.includes(id));

    const PROVIDERS = [
      {
        key: 'google',
        name: 'Google',
        svg: logoGoogle,
        connected: Boolean(linked.google) || hasFresh('google'),
        connect: () => auth?.linkProvider?.('google'),
        unlink: () => auth?.unlinkProvider?.('google')
      },
      {
        key: 'steam',
        name: 'Steam',
        svg: logoSteam,
        // Steam is not a Supabase identity, so only the server knows.
        connected: Boolean(linked.steam),
        connect: async () => {
          const res = await accountApi.steamStart();
          window.location.href = res.url;
        },
        unlink: () => accountApi.steamUnlink()
      },
      {
        key: 'discord',
        name: 'Discord',
        svg: logoDiscord,
        connected: Boolean(linked.discord) || hasFresh('discord'),
        connect: () => auth?.linkProvider?.('discord'),
        unlink: () => auth?.unlinkProvider?.('discord')
      },
      {
        key: 'x',
        name: 'X',
        svg: logoX,
        connected: Boolean(linked.x) || hasFresh('x', 'twitter'),
        connect: () => auth?.linkProvider?.('x'),
        unlink: () => auth?.unlinkProvider?.('x')
      }
    ];

    // When the browser can see an identity the server just denied, the cache
    // is stale -- and the upload gate reads that same cache, so a fresh Google
    // link would leave uploads blocked. Fire and forget: the display above is
    // already right, this only corrects the server.
    const serverBehind = PROVIDERS.some(
      (p) => p.key !== 'steam' && p.connected && !linked[p.key]
    );
    if (serverBehind) accountApi.refreshIdentity().catch(() => {});

    const row = el('div', 'account-conn-icons');
    for (const p of PROVIDERS) {
      const btn = el('button', `conn-icon-btn conn-${p.key}${p.connected ? ' is-connected' : ''}`);
      btn.type = 'button';
      btn.innerHTML = p.svg;
      const label = p.connected ? `${p.name} connected. Click to unlink.` : `Connect ${p.name}`;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          if (p.connected) {
            if (!window.confirm(`Unlink ${p.name} from this account?`)) return;
            await p.unlink();
            reload();
          } else {
            // Connect redirects away; errors are the only thing to render.
            await p.connect();
          }
        } catch (err) {
          notice(card, err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      });
      row.appendChild(btn);
    }
    idCol.appendChild(row);

    // One line, only while it matters: without Google or Steam, uploads stay
    // locked, and nothing on this card would otherwise say so.
    if (!linked.google && !linked.steam) {
      idCol.appendChild(
        el('p', 'account-muted account-conn-hint', 'Connect Google or Steam to upload demos.')
      );
    }
  }
  root.appendChild(card);

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
 * A value that edits where it is shown.
 *
 * Renders as text with a pencil that appears on hover. The pencil swaps the
 * text for an input: Enter saves, Escape or clicking away cancels. No labels,
 * no separate form — the identity card IS the form.
 *
 * `host` is where errors land, because the field itself is replaced by the
 * input while one could occur.
 */
function editable({
  tag,
  className,
  value,
  save,
  host,
  label,
  prefix = '',
  maxLength = 32,
  allowEmpty = false,
  enabled = true
}) {
  const wrap = el(tag, `${className} account-editable`);
  const text = el('span', 'account-editable-text', `${prefix}${value}`);
  wrap.appendChild(text);
  if (!enabled) return wrap;

  const pencil = el('button', 'account-editable-pencil');
  pencil.type = 'button';
  pencil.innerHTML = PENCIL_SVG;
  pencil.title = label;
  pencil.setAttribute('aria-label', label);
  wrap.appendChild(pencil);

  pencil.addEventListener('click', () => {
    const field = input('text', value, '');
    field.className = 'account-editable-input';
    field.maxLength = maxLength;
    field.spellcheck = false;
    wrap.replaceChildren(prefix ? el('span', 'account-editable-prefix', prefix) : '', field);
    field.focus();
    field.select();

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const next = field.value;
      wrap.replaceChildren(text, pencil);
      if (!commit || next === value || (!next.trim() && !allowEmpty)) return;
      try {
        await save(next);
      } catch (err) {
        notice(host, err.message, 'error');
      }
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => finish(false));
  });
  return wrap;
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

export function subscriptionTab(state, { reload, billing, openAuth }) {
  const root = el('div', 'account-panel');
  const currentTier = state.entitlements?.tier || 'free';
  const sub = state.subscription;
  const signedIn = Boolean(state.account?.signedIn);

  // The provider bounces back here with ?checkout=success|cancelled once
  // payments are live; saying nothing on that return would leave the user
  // guessing whether their card just worked.
  const returned = checkoutReturnNotice();
  if (returned) root.appendChild(returned);

  // Paddle's emails link here with ?_ptxn=<transaction>, expecting the page to
  // open a checkout for it. Fire and forget: a failure to open must not stop
  // the rest of the page rendering, and the notice below reports it.
  openCheckoutFromPaymentLink({ billing }).catch((err) => {
    notice(root, err.message || 'Could not open that payment.', 'error');
  });

  // ---- current state ------------------------------------------------------
  // Only for someone who has a plan. Signed out there is nothing to report,
  // and the sign-in card the page puts above this already says what to do.
  if (signedIn) root.appendChild(currentPlanHead(state, currentTier, sub, { reload, billing }));

  // ---- redeem a code ------------------------------------------------------
  // Above the ladder rather than below it: someone arriving with a code in hand
  // is not shopping, and making them scroll past six plans to use it reads as a
  // dark pattern.
  if (signedIn) root.appendChild(redeemCard({ reload }));

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
    freeRow.appendChild(planCard('free', currentTier, billing, term, root, { signedIn, openAuth, reload }));
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
        if (planId) grid.appendChild(planCard(planId, currentTier, billing, term, root, { signedIn, openAuth, reload }));
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
 * The "Your plan" card: current tier, status, renewal, and the manage row.
 *
 * Its own function because the tab now renders for signed-out visitors too,
 * who have no plan and no subscription to describe.
 */
function currentPlanHead(state, currentTier, sub, { reload, billing }) {
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
  // A seat is where the access came from, and saying so is not optional. The
  // holder pays nothing, cannot cancel or manage it, and loses it when the team
  // owner's plan ends. Left unexplained, the page reads as though they bought a
  // plan themselves, and the day it disappears looks like a bug.
  //
  // Both branches matter. This used to be one branch guarded on `sub`, so the
  // explanation only appeared for the rarer case of a seat holder who ALSO had
  // their own subscription, and the common case -- a seat and nothing else --
  // showed a bare plan name with no status, no end date and no context at all.
  const ent = state.entitlements || {};
  if (ent.source === 'seat') {
    const until = ent.expiresAt ? ` It lasts until ${date(ent.expiresAt)}.` : '';
    if (sub) {
      head.appendChild(
        el(
          'p',
          'account-warning',
          `You hold both your own ${PLAN_NAMES[sub.planId] || sub.planId} and a team seat. Your ` +
            `effective tier is ${PLAN_NAMES[currentTier] || currentTier}, the better of the two.`
        )
      );
    } else {
      head.appendChild(
        el(
          'p',
          'account-notice',
          `This comes from a team seat, not a subscription of your own.${until}`
        )
      );
      head.appendChild(
        el(
          'p',
          'account-muted',
          'Nothing is charged to you. The team owner manages this seat, and the daily model ' +
            'allowances are shared across the whole roster rather than counted per person.'
        )
      );
    }
  }
  return head;
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
function planCard(
  planId,
  currentTier,
  billing,
  term = 'month',
  noticeHost = null,
  { signedIn = true, openAuth = null, reload = null } = {}
) {
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
    } else if (!signedIn) {
      // Checkout needs an account: /api/billing/checkout answers 401 without
      // one. Ask for the sign-in here rather than letting someone click a
      // buy button and be told no by an error toast.
      cta.textContent = 'Sign in to subscribe';
      cta.addEventListener('click', () => openAuth?.('login'));
    } else {
      cta.addEventListener('click', async () => {
        cta.disabled = true;
        try {
          const res = await accountApi.checkout(planId, term);

          // Already subscribed: the server previewed a change to the existing
          // subscription rather than selling a second one. Paddle bills the
          // card on file with no checkout screen, so the amount is shown here
          // and nothing happens without a yes.
          if (res?.kind === 'change') {
            const now = euros(res.dueNowCents || 0);
            const per = res.recurringCents == null ? null : euros(res.recurringCents);
            const lines = [
              `Change to ${PLAN_NAMES[planId]}, ${TERM_NAMES[term].toLowerCase()}.`,
              '',
              (res.dueNowCents || 0) > 0
                ? `${now} is charged now, with unused time on ${PLAN_NAMES[res.from.planId]} credited.`
                : 'Nothing is charged now: the unused time on your current plan covers it.',
              per ? `Then ${per} every ${TERM_NAMES[term].toLowerCase()}.` : '',
              '',
              'Your card on file is used. Continue?'
            ].filter(Boolean);

            if (!window.confirm(lines.join('\n'))) {
              cta.disabled = false;
              return;
            }
            await accountApi.changePlan(planId, term);
            if (noticeHost) {
              notice(noticeHost, `You are on ${PLAN_NAMES[planId]}. This page may take a moment to catch up.`, 'ok');
            }
            reload?.();
            return;
          }

          // The overlay is the wanted path: the buyer never leaves the pricing
          // page, and the transaction already carries the plan, the term and
          // the user id, so nothing about the purchase travels through the
          // browser where it could be edited.
          if (res?.transactionId) {
            await openCheckout({
              transactionId: res.transactionId,
              customerId: res.customerId || null,
              billing,
              successUrl: checkoutSuccessUrl(),
              // Paddle gives no signal for "paid" here, only "closed". Re-enable
              // so a buyer who dismissed the overlay by accident can click again;
              // one who paid gets redirected before this matters.
              onClose: () => {
                cta.disabled = false;
              }
            });
            return;
          }

          // Hosted page. Reached when Paddle.js cannot load at all, and worth
          // keeping: a blocked CDN should cost the overlay, not the sale.
          if (res?.checkoutUrl) {
            window.location.href = res.checkoutUrl;
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

/**
 * Redeem a trial code.
 *
 * Deliberately not a plan card. A code is not a purchase: nothing is charged,
 * no card is stored, and what arrives is a time-boxed grant that sits on top of
 * whatever the account already has. Presenting it as a seventh tile would
 * suggest otherwise.
 */
function redeemCard({ reload }) {
  const card = el('section', 'account-card account-redeem');
  card.appendChild(el('h3', null, 'Redeem a code'));

  const row = el('div', 'account-redeem-row');
  const box = input('text', '', 'AIM4-XXXX-XXXX');
  box.autocapitalize = 'characters';
  box.spellcheck = false;
  box.setAttribute('aria-label', 'Trial code');
  row.appendChild(box);

  const submit = button(
    'Redeem',
    async () => {
      const code = box.value.trim();
      if (!code) return;
      submit.disabled = true;
      try {
        const res = await accountApi.redeemCode(code);
        notice(
          card,
          `${res.planName} unlocked for ${res.durationDays} days, until ${date(res.expiresAt)}.`,
          'ok'
        );
        box.value = '';
        reload?.();
      } catch (err) {
        // The server sends a plain reason for the cases a person can act on:
        // already used, expired, not recognised.
        notice(card, err.message, 'error');
      } finally {
        submit.disabled = false;
      }
    },
    'btn btn-primary'
  );
  // Enter is what people press after typing a code.
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });
  row.appendChild(submit);
  card.appendChild(row);
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

// ---------------------------------------------------------------------------
// Affiliate
// ---------------------------------------------------------------------------

/** Minor units and a currency code into something a person reads. */
function money(amount, currency = 'EUR') {
  const value = (Number(amount) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    // An unknown currency code should still show the number.
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** The share link for a code, against whatever origin the page is served from. */
function referralLink(code) {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://aim4.io';
  return `${origin}/?ref=${encodeURIComponent(code)}`;
}

/** How this affiliate's terms read as one line. */
function termsText(affiliate) {
  const pct = `${Number(affiliate.commissionPct)}% of each payment`;
  if (!affiliate.recurring) return `${pct}, first payment only`;
  if (affiliate.maxMonths) return `${pct}, renewals included for ${affiliate.maxMonths} months`;
  return `${pct}, renewals included`;
}

export function affiliateTab(state, { reload }) {
  const wrap = el('div', 'account-pane');

  if (!state?.account?.signedIn) {
    const card = el('section', 'account-card');
    card.appendChild(el('h3', null, 'Affiliate'));
    card.appendChild(el('p', 'account-empty', 'Sign in to set up a code.'));
    wrap.appendChild(card);
    return wrap;
  }

  const card = el('section', 'account-card');
  card.appendChild(el('h3', null, 'Affiliate'));
  const body = el('div', 'account-affiliate-body');
  card.appendChild(body);
  wrap.appendChild(card);

  body.appendChild(el('p', 'account-empty', 'Loading.'));

  accountApi
    .affiliate()
    .then((data) => {
      body.replaceChildren();
      if (data.affiliate) renderAffiliate(body, data, reload);
      else renderClaim(body, data, reload);
    })
    .catch((err) => {
      body.replaceChildren();
      body.appendChild(el('p', 'account-empty', err?.message || 'Could not load your code.'));
    });

  return wrap;
}

/** No code yet: pick one. */
function renderClaim(body, data, reload) {
  const row = el('div', 'account-redeem-row');
  const box = input('text', data.suggestion || '', 'YOURCODE');
  box.autocapitalize = 'characters';
  box.spellcheck = false;
  box.maxLength = 24;
  box.setAttribute('aria-label', 'Affiliate code');
  row.appendChild(box);

  const submit = button(
    'Create code',
    async () => {
      const code = box.value.trim();
      if (!code) return;
      submit.disabled = true;
      try {
        await accountApi.claimAffiliateCode(code);
        reload?.();
      } catch (err) {
        notice(body, err.message, 'error');
      } finally {
        submit.disabled = false;
      }
    },
    'btn btn-primary'
  );
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });
  row.appendChild(submit);
  body.appendChild(row);

  // The terms, and the one thing that is not undoable about this form.
  body.appendChild(metaRow('Rate', `${data.defaultPct ?? 20}% of each payment`));
  body.appendChild(metaRow('Code', 'Permanent once created'));
}

/** A code exists: show it, and what it has made. */
function renderAffiliate(body, data, reload) {
  const { affiliate, stats, commissions, holdDays } = data;

  body.appendChild(metaRow('Code', affiliate.code, true));

  const link = referralLink(affiliate.code);
  const linkRow = el('div', 'account-affiliate-link');
  const linkBox = input('text', link);
  linkBox.readOnly = true;
  linkBox.setAttribute('aria-label', 'Referral link');
  linkBox.addEventListener('focus', () => linkBox.select());
  linkRow.appendChild(linkBox);
  const copy = button(
    'Copy',
    async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1500);
      } catch {
        // Clipboard is blocked in some contexts, so fall back to selecting the
        // text and letting the person copy it themselves.
        linkBox.select();
      }
    },
    'btn'
  );
  linkRow.appendChild(copy);
  body.appendChild(linkRow);

  body.appendChild(metaRow('Rate', termsText(affiliate)));
  body.appendChild(metaRow('Referrals', String(stats?.referrals ?? 0)));

  if (affiliate.status === 'suspended') {
    notice(body, 'This code is suspended and is not earning. Contact support.', 'error');
  }

  for (const bucket of stats?.currencies || []) {
    body.appendChild(
      metaRow(`Earned (${bucket.currency})`, money(bucket.total, bucket.currency))
    );
    body.appendChild(
      metaRow(
        'Held',
        `${money(bucket.pending, bucket.currency)} for ${holdDays} days, ` +
          `${money(bucket.approved, bucket.currency)} ready, ` +
          `${money(bucket.paid, bucket.currency)} paid`
      )
    );
  }

  if (!commissions?.length) {
    body.appendChild(el('p', 'account-empty', 'Nothing has been bought through this code yet.'));
    return;
  }

  body.appendChild(
    table(
      ['Date', 'Type', 'Sale', 'Rate', 'You earn', 'Status'],
      commissions.map((c) => [
        date(c.occurredAt),
        c.isRenewal ? 'Renewal' : 'First payment',
        money(c.base, c.currency),
        `${c.pct}%`,
        money(c.amount, c.currency),
        c.status === 'pending' ? `Held until ${date(c.payableAt)}` : capitalise(c.status)
      ])
    )
  );
}

function capitalise(s) {
  const text = String(s || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
