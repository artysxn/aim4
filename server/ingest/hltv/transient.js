// ---------------------------------------------------------------------------
// server/ingest/hltv/transient.js
// Errors that must retry the same demo id, never advance the cursor.
// ---------------------------------------------------------------------------

/** Navigation / proxy / challenge weather. Not proof the demo id is gone. */
export function isTransientDownloadError(err) {
  if (!err) return false;
  if (err.missing) return false;
  if (err.blocked || err.proxyRetryable) return true;
  if (err.name === 'ChallengeError') return true;
  const msg = String(err.message || err);
  return (
    /Cloudflare challenge/i.test(msg) ||
    /Timeout \d+ms exceeded/i.test(msg) ||
    /No browser download started/i.test(msg) ||
    /No archive download after page load/i.test(msg) ||
    /net::ERR_/i.test(msg) ||
    /ERR_TUNNEL|ERR_PROXY|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(
      msg
    ) ||
    /proxy/i.test(msg)
  );
}
