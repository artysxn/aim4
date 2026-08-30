// ---------------------------------------------------------------------------
// src/site/legalView.js
// /terms and /privacy: the rules and the data story, written to be read.
//
// Static content, one narrow column each, same render-once pattern as the
// changelog. Every claim below describes what the site actually does — the
// numbers (14 day deletion grace, 90 day retention, 24 hour export links,
// 7 day trials) are the defaults in server/account/data.js and
// entitlements/subscriptions.js, and the sharing-detection description
// matches server/account/integrity.js. If a behavior changes, this page is
// part of the change.
// ---------------------------------------------------------------------------

const UPDATED = '30 August 2026';

// ---------------------------------------------------------------------------
// The refund policy, written once.
//
// It appears in two places: section 5 of the terms, and the standalone
// /refunds page that Paddle's verification form asks for by URL. Two copies
// would drift, and a refund policy that says different things in different
// places is worse than one that is hard to find.
// ---------------------------------------------------------------------------
const REFUNDS_BODY = `
    <p>The policy, in full:</p>
    <ul>
      <li><strong>14 days, no questions asked</strong>, on a first purchase of any paid plan. Ask within 14 days of the charge and you get the whole amount back, whether or not you used the plan.</li>
      <li><strong>Renewals</strong> are refundable in full within 14 days of the renewal charge if you have not used any paid feature in that period. A renewal you did use is not refundable, but you can cancel to stop the next one.</li>
      <li><strong>Trials</strong> never charge. If a trial converted and you did not want it to, that is a first purchase and the 14 days above apply.</li>
      <li><strong>Cancelling mid-term does not refund the rest of the term</strong>: access simply continues to the end of the period you paid for. Longer terms are discounted on the basis that they are paid up front.</li>
      <li><strong>If the service is materially broken</strong> for a sustained period and you cannot use what you paid for, ask for a refund regardless of the above. Extended downtime is our problem, not yours.</li>
    </ul>
    <p>To request one, open a ticket from the <a href="/contact">contact page</a> with the email you paid with. Refunds are answered within 5 working days and returned to the original payment method. Nothing here limits your statutory rights, including the right of withdrawal you may have as a consumer in the EU, the EEA or the UK; where those rights give you more than this policy, they win.</p>
    <p>If something looks wrong on a charge, please open a ticket before asking your bank to reverse it. A chargeback locks the account until it is resolved, and a message is almost always faster.</p>
`;

/** The same policy under an h3, for the billing section of the terms. */
const REFUNDS_BODY_H3 = `<h3>Refunds</h3>${REFUNDS_BODY}`;

const TERMS_HTML = `
  <header class="page-head-block">
    <h1>Terms of service</h1>
    <p class="page-lede">The rules for using aim4, in plain language. Last updated ${UPDATED}.</p>
  </header>

  <section id="acceptance">
    <h2>1. Agreeing to these terms</h2>
    <p>aim4.io ("aim4", "we") is a browser-based training and demo-review platform for Counter-Strike 2, built and run by an independent developer. By using the site you agree to these terms; if you do not agree, do not use it. You must be at least 16 years old to create an account.</p>
    <p>aim4 is not affiliated with, endorsed by, or sponsored by Valve Corporation. Counter-Strike and Steam are trademarks of Valve Corporation.</p>
  </section>

  <section id="account">
    <h2>2. Your account is personal</h2>
    <p>One account, one person. Accounts — including their subscriptions — are personal and non-transferable, and <strong>account sharing is not allowed</strong>. Keep your password to yourself; what happens under your sign-in is your responsibility.</p>
    <p>We detect sharing automatically. When an account is used from a different country on different hardware of the same kind within a few hours of its last session, the first detection shows a warning with a short cooldown, and a repeat places the account on <strong>probation</strong>: premium features are suspended and the account is served as Free until the flag is reviewed. Your subscription is not cancelled by probation. If we got it wrong, <a href="/contact">open a ticket</a> — probation is lifted when the evidence supports it. Note that VPNs can interact badly with these checks; using one is allowed, but expect the occasional question.</p>
  </section>

  <section id="content">
    <h2>3. Your content</h2>
    <p>Demos, voice recordings, documents, strategies and notes you upload remain yours. You grant aim4 the license needed to run the service on them: storing, parsing, transcoding, analysing, and displaying them to whoever your visibility settings allow. We claim no other rights.</p>
    <p>Upload only what you have the right to upload. For voice recordings this matters most: the recorder runs on your machine and records the people in your channel, and <strong>it is your responsibility to have everyone's consent</strong> before recording and uploading — the law on recording conversations differs by country. We may remove content that is unlawful or breaks these terms.</p>
  </section>

  <section id="use">
    <h2>4. Acceptable use</h2>
    <p>Do not use aim4 to do anything unlawful. Do not attack, probe, or overload the service; do not scrape it at scale; do not attempt to bypass plan limits, entitlements, or the sharing checks; do not access or attempt to access other people's accounts or private content; do not resell access. We may rate-limit, suspend, or block usage that harms the service or other users.</p>
  </section>

  <section id="billing">
    <h2>5. Plans, trials and billing</h2>
    <p>The free tier covers watching demos, browsing the database, and trying the tools. Paid plans raise limits and unlock features as described on <a href="/account/subscription">Account → Subscription</a>. Trials (normally 7 days) are one per account and can be cancelled at any time without charge.</p>
    <p>You can cancel a paid plan whenever you like; access continues to the end of the paid period and no further charges are made. When a plan lapses, <strong>nothing is deleted</strong>: content over the free tier's limits locks, and you have 90 days to choose what to keep or export before over-limit content may be removed.</p>
    <p>Payments are taken by Paddle, our merchant of record: Paddle acts as the seller of record for the transaction, collects any tax due, and issues your invoice. Card details never reach aim4's servers. Prices are shown in euros; any tax due is determined by the country you buy from and is shown before you confirm.</p>
${REFUNDS_BODY_H3}
  </section>

  <section id="termination">
    <h2>6. Ending things</h2>
    <p>You can delete your account yourself under <a href="/account/data">Account → Data</a>. Deletion is scheduled 14 days out and cancelled by simply signing in again during that window. We may suspend or terminate accounts that materially breach these terms; probation, described above, is the lesser measure we prefer where it fits.</p>
  </section>

  <section id="disclaimer">
    <h2>7. Disclaimers and liability</h2>
    <p>aim4 is provided as-is, without warranties of any kind. We work to keep it fast, correct, and available, but we do not guarantee uninterrupted or error-free operation, and we are not liable for indirect or consequential damages. To the extent permitted by law, our total liability is limited to the amount you paid us in the twelve months before the claim. Nothing here limits liability that cannot lawfully be limited.</p>
  </section>

  <section id="changes">
    <h2>8. Changes to these terms</h2>
    <p>These terms may change as the product does. Material changes are announced on the site — through the <a href="/changelog">changelog</a> and, for signed-in users, a notification. Continuing to use aim4 after a change means you accept the updated terms.</p>
  </section>

  <section id="contact">
    <h2>9. Contact</h2>
    <p>Questions about these terms: <a href="/contact">open a ticket</a>. It lands directly with the site admin.</p>
  </section>
`;

const PRIVACY_HTML = `
  <header class="page-head-block">
    <h1>Privacy</h1>
    <p class="page-lede">What aim4 collects, why, where it lives, and how to take it with you or delete it. Last updated ${UPDATED}.</p>
  </header>

  <section id="who">
    <h2>1. Who is responsible</h2>
    <p>aim4.io is built and run by an independent developer, who is the data controller for the processing described here. The fastest way to reach us about your data is a <a href="/contact">ticket</a>.</p>
  </section>

  <section id="collect">
    <h2>2. What we collect, and why</h2>
    <p><strong>Account data</strong> — your email address, username (@ tag), display name, optional country flag, and the identities you link (Google, Steam ID, Discord, X). Used to sign you in, attribute your uploads, and anchor accounts to real identities. Passwords are handled and hashed by our authentication provider; we never see them.</p>
    <p><strong>Your content</strong> — demos, voice recordings, playlists, documents, strategies, notes, and the statistics derived from them. Processed to provide the product, shown to whoever your visibility settings allow.</p>
    <p><strong>Sign-in security data</strong> — for each session: your IP address, the country derived from it, a random device token your browser keeps, the device type, and the browser's user-agent string. This exists for one purpose: detecting account sharing and abuse (see the <a href="/terms">terms</a>). The country is derived <em>locally</em> on our server from an offline database — your IP is not sent to any third party to look it up.</p>
    <p><strong>Operational records</strong> — subscription state, support tickets, notifications, and an audit log of administrative actions (including any time an admin views your account, which is recorded and reviewable).</p>
  </section>

  <section id="not-collect">
    <h2>3. What we do not do</h2>
    <p>No advertising, no third-party analytics or tracking scripts, no selling or sharing of personal data for marketing. Payment card details go directly to the payment processor and never touch aim4's servers.</p>
  </section>

  <section id="cookies">
    <h2>4. Cookies and local storage</h2>
    <p>aim4 stores in your browser: your session tokens (to keep you signed in), a random device token (part of the sharing checks), and your preferences and settings. That is the list — there are no advertising or cross-site tracking cookies, which is why there is no cookie banner.</p>
  </section>

  <section id="where">
    <h2>5. Where data lives</h2>
    <p>Accounts and database records live with <strong>Supabase</strong> (our authentication and database provider). Demos, derived statistics, and voice recordings live on servers rented from <strong>Hetzner</strong> in Germany. The website is delivered by <strong>Vercel</strong>, and static map assets by <strong>Cloudflare R2</strong> (no personal data there). These providers process data on our behalf under their respective data-processing terms.</p>
    <p><strong>Voice recordings</strong> deserve their own line: the recorder runs on <em>your</em> machine, records your TeamSpeak channel, and transcribes locally. Nothing reaches aim4 until you choose to upload, and the uploader is responsible for the consent of everyone recorded.</p>
  </section>

  <section id="retention">
    <h2>6. How long we keep things</h2>
    <p>Account data, content, and sign-in security data are kept while your account exists and are removed with it. Account deletion is self-serve, scheduled 14 days out (signing in again cancels it). After a paid plan lapses, content over the free limits is retained for 90 days for you to export or trim before it may be removed. Account export downloads expire after 24 hours.</p>
  </section>

  <section id="rights">
    <h2>7. Your rights and the self-serve tools</h2>
    <p>You can <strong>export</strong> everything (a JSON archive plus download links for your demos) and <strong>delete</strong> your account under <a href="/account/data">Account → Data</a>, and correct your profile under <a href="/account">Account</a> — no ticket required. Under the GDPR and similar laws you also have the rights of access, rectification, erasure, restriction, portability, and objection, and the right to complain to your local supervisory authority. Anything the self-serve tools do not cover: <a href="/contact">open a ticket</a>.</p>
  </section>

  <section id="changes">
    <h2>8. Changes</h2>
    <p>If what we collect or how we use it changes, this page changes first and materially affected users are notified on the site. The "last updated" date at the top is the tell.</p>
  </section>
`;

function makeLegalView(html) {
  return function init(host) {
    if (!host) return { onShow() {}, onHide() {} };
    let rendered = false;
    return {
      onShow() {
        if (!rendered) {
          rendered = true;
          host.innerHTML = `<div class="view-pad page-narrow legal-page">${html}</div>`;
        }
        const hash = window.location.hash.slice(1);
        if (hash) document.getElementById(hash)?.scrollIntoView();
      },
      onHide() {}
    };
  };
}


const REFUNDS_HTML = `
  <h1>Refund policy</h1>
  <p class="legal-updated">Part of the <a href="/terms">terms of service</a>. Last updated with them.</p>

  <section id="refunds">
${REFUNDS_BODY}
  </section>

  <section id="who-charges">
    <h2>Who takes the payment</h2>
    <p>Payments are taken by Paddle, our merchant of record. Paddle acts as the seller of record, collects any tax due, and issues your invoice, so a refund is returned by Paddle to the method you paid with. Asking us is the right first step either way: <a href="/contact">open a ticket</a> and we handle it from there.</p>
  </section>
`;

export const initTermsView = makeLegalView(TERMS_HTML);
export const initPrivacyView = makeLegalView(PRIVACY_HTML);
export const initRefundsView = makeLegalView(REFUNDS_HTML);
