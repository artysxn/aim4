// ---------------------------------------------------------------------------
// src/site/account/paddleCheckout.js
// Opens Paddle's overlay checkout for a transaction the server already made.
//
// Two things are deliberate here.
//
// The transaction is created server-side, by /api/billing/checkout, and this
// file only opens it. The alternative Paddle documents is opening a checkout
// against a price id from the browser. That path carries no custom_data, and
// custom_data is the only thing tying a Paddle subscription back to one of our
// users: without it the webhook cannot attribute the payment and the customer
// pays for nothing. See applyEvent in server/billing/routes.js.
//
// Paddle.js is loaded from Paddle's CDN rather than bundled through the
// @paddle/paddle-js npm package. The package's whole job is to inject this
// same script tag and hand back window.Paddle; going direct keeps the
// dependency list where it is and means Paddle can ship a checkout fix without
// us cutting a release.
// ---------------------------------------------------------------------------

const CDN = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let loading = null;

/** Resolves with window.Paddle, initialised once for the given config. */
function loadPaddle({ environment, clientToken }) {
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    if (window.Paddle) return resolve(window.Paddle);

    const script = document.createElement('script');
    script.src = CDN;
    script.async = true;
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error('Paddle.js loaded but did not register.')));
    // Ad blockers and strict network policies both land here, and the message
    // a user sees should say that rather than "undefined is not a function".
    script.onerror = () => reject(new Error('Could not reach Paddle. Check for a blocker and try again.'));
    document.head.appendChild(script);
  }).then((Paddle) => {
    // Environment must be set before Setup, and only for sandbox: calling
    // it with 'production' is not valid.
    if (environment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Setup({ token: clientToken });
    return Paddle;
  });

  // A failed load should not poison every later attempt.
  loading.catch(() => {
    loading = null;
  });

  return loading;
}

/**
 * Open the one-page overlay for `transactionId`.
 *
 * The customer, the price, the term and the custom_data all live on the
 * transaction already, so nothing about the purchase is passed from here. That
 * is the point: the browser cannot change what is being bought.
 *
 * @param {object} args
 * @param {string} args.transactionId  txn_... from /api/billing/checkout
 * @param {object} args.billing        the /api/billing/status payload
 * @param {string} [args.successUrl]   where Paddle sends the buyer after paying
 * @param {() => void} [args.onClose]  called when the overlay is dismissed
 */
export async function openCheckout({ transactionId, billing, successUrl, onClose }) {
  if (!transactionId) throw new Error('No transaction to check out.');
  if (!billing?.clientToken || !billing?.environment) {
    throw new Error(billing?.error || 'Payments are not configured.');
  }

  const Paddle = await loadPaddle(billing);

  Paddle.Checkout.open({
    transactionId,
    settings: {
      displayMode: 'overlay',
      variant: 'one-page',
      // Paddle only redirects when this is set; without it the overlay closes
      // and leaves the buyer looking at the pricing page they just paid on.
      ...(successUrl ? { successUrl } : {})
    },
    eventCallback(event) {
      if (event?.name === 'checkout.closed') onClose?.();
    }
  });
}

/**
 * Open the checkout named by a `_ptxn` query parameter, if there is one.
 *
 * This is how Paddle's own emails work. The default payment link is a plain
 * URL on our domain, and Paddle appends `?_ptxn=<transaction id>` to it when it
 * asks a customer to update a card, retry a failed payment, or pay an invoice.
 * The page is expected to notice the parameter and open a checkout for it.
 *
 * Without this the customer follows a link from Paddle asking them to pay,
 * lands on the pricing page, and is shown nothing at all. It only became
 * reachable once the default payment link stopped pointing at localhost.
 *
 * @returns {Promise<boolean>} true when a checkout was opened.
 */
export async function openCheckoutFromPaymentLink({ billing, onClose } = {}) {
  const params = new URLSearchParams(window.location.search);
  const transactionId = params.get('_ptxn');
  if (!transactionId) return false;

  // Drop it from the URL either way. Leaving it behind means a refresh, or a
  // bookmark, reopens a checkout the customer already dealt with.
  params.delete('_ptxn');
  const rest = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));

  if (!billing?.clientToken || !billing?.environment) return false;

  await openCheckout({ transactionId, billing, successUrl: checkoutSuccessUrl(), onClose });
  return true;
}

/**
 * Where a completed checkout lands. Absolute because Paddle requires it, and
 * built from the current origin so it is correct on localhost and in
 * production without a second variable to keep in step.
 *
 * The value must stay `success`: checkoutReturnNotice() in tabs.js matches on
 * it exactly and silently ignores anything else, so a buyer returning with a
 * different spelling gets no confirmation and a stray query param.
 */
export function checkoutSuccessUrl() {
  return `${window.location.origin}/account/subscription?checkout=success`;
}
