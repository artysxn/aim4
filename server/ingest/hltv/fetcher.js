// ---------------------------------------------------------------------------
// server/ingest/hltv/fetcher.js
// The only thing in this program that talks to hltv.org.
//
// It rate-limits. It does not defeat bot detection, and that distinction is the
// whole design:
//
//   In scope   low concurrency, jittered delays, Retry-After, 429/503 backoff,
//              one IP, one session, an honest User-Agent with a contact address
//   Excluded   CAPTCHA/challenge solving, TLS or JA3 fingerprint spoofing,
//              stealth headless browsers, proxy rotation to dodge a ban
//
// When Cloudflare serves a managed challenge the correct response is to stop,
// not to get cleverer, so `ChallengeError` halts the entire run rather than
// being retried. Auto-retrying into a challenge is how a soft throttle becomes
// a hard IP ban.
//
// As of the last check every hltv.org endpoint, /robots.txt included, answers
// 403 with a managed challenge to any non-browser client. This module is
// therefore correct and currently unusable, which is a deliberate outcome: the
// remedy is permission or an allowlisted address, not a workaround.
// ---------------------------------------------------------------------------

export class ChallengeError extends Error {
  constructor(url, status) {
    super(
      `hltv.org served a Cloudflare challenge for ${url} (HTTP ${status}). ` +
        'Stopping. This is an access decision, not a rate limit: slow the run ' +
        'down or arrange access. Do not attempt to satisfy the challenge.'
    );
    this.name = 'ChallengeError';
    this.url = url;
    this.status = status;
    this.fatal = true;
  }
}

export class HttpError extends Error {
  constructor(url, status) {
    super(`GET ${url} failed with HTTP ${status}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when a 200 body is actually a challenge interstitial. Also used by
 * probe.js, which applies the same test to whatever a download URL served. */
export function looksLikeChallenge(text) {
  return (
    /cdn-cgi\/challenge-platform/.test(text) ||
    /<title>\s*Just a moment/i.test(text) ||
    /_cf_chl_opt/.test(text)
  );
}

export function createFetcher(cfg) {
  let inFlight = 0;
  let nextAllowedAt = 0;
  let throttleStrikes = 0;
  /** Once tripped the whole run is over; nothing resets this. */
  let tripped = null;

  const jitter = () =>
    cfg.minDelayMs + Math.random() * Math.max(0, cfg.maxDelayMs - cfg.minDelayMs);

  /** Global gate: never more than batchSize requests to the site at once. */
  async function acquire() {
    while (inFlight >= cfg.batchSize) await sleep(250);
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = Date.now() + jitter();
    inFlight++;
  }

  function release() {
    inFlight = Math.max(0, inFlight - 1);
  }

  function assertLive() {
    if (tripped) throw tripped;
  }

  async function request(url, { method = 'GET', headers = {}, redirect = 'follow' } = {}) {
    assertLive();
    await acquire();
    try {
      return await fetch(url, {
        method,
        redirect,
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          ...headers
        }
      });
    } finally {
      release();
    }
  }

  /**
   * One GET, with backoff on throttling and a hard stop on a challenge.
   *
   * @param {string} url
   * @param {{attempts?: number, headers?: object}} [opts]
   */
  async function get(url, opts = {}) {
    const maxAttempts = opts.attempts ?? 4;
    let backoff = 60_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      assertLive();
      const res = await request(url, { headers: opts.headers });

      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        if (looksLikeChallenge(body)) {
          tripped = new ChallengeError(url, res.status);
          throw tripped;
        }
        throw new HttpError(url, res.status);
      }

      if (res.status === 429 || res.status === 503) {
        throttleStrikes++;
        // Three throttles and we are demonstrably going too fast. Halve the
        // rate for the rest of the run and never restore it.
        if (throttleStrikes >= 3) {
          cfg.minDelayMs *= 2;
          cfg.maxDelayMs *= 2;
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
        if (attempt === maxAttempts) throw new HttpError(url, res.status);
        await sleep(Math.min(wait, 30 * 60_000) * (0.8 + Math.random() * 0.4));
        backoff = Math.min(backoff * 2, 30 * 60_000);
        continue;
      }

      if (!res.ok) throw new HttpError(url, res.status);
      return res;
    }
    throw new HttpError(url, 0);
  }

  /** HTML, with the challenge check applied to 200 bodies too. */
  async function getText(url, opts = {}) {
    const res = await get(url, opts);
    const text = await res.text();
    if (looksLikeChallenge(text)) {
      tripped = new ChallengeError(url, res.status);
      throw tripped;
    }
    return text;
  }

  return {
    get,
    getText,
    get tripped() {
      return tripped;
    },
    /** For preflight: is the site reachable without a challenge at all? */
    async probe(url = 'https://www.hltv.org/results') {
      try {
        await getText(url, { attempts: 1 });
        return { ok: true };
      } catch (err) {
        return { ok: false, challenge: err instanceof ChallengeError, error: err.message };
      }
    }
  };
}
