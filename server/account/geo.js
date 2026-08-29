// ---------------------------------------------------------------------------
// server/account/geo.js
// Which country is this request coming from?
//
// Two sources, tried in order:
//
//   1. A proxy header (CF-IPCountry from Cloudflare, X-Vercel-IP-Country from
//      Vercel) — but only when AIM4_TRUST_PROXY=1, for the same reason
//      audit.js gates X-Forwarded-For: without a proxy actually in front,
//      these headers are typed by whoever sends the request, and sharing
//      detection built on an attacker-controlled country can be evaded or
//      used to frame an account.
//   2. A local MMDB country database at AIM4_GEOIP_DB (MaxMind GeoLite2 or
//      db-ip lite, same format), read with mmdb-lib (already a dependency).
//      No network call per lookup.
//
// The file MAINTAINS ITSELF: startGeoUpdater() (called at boot) downloads a
// fresh db-ip country-lite build to AIM4_GEOIP_DB whenever the file on disk
// is missing or older than ~a month, and the reader below reloads on mtime
// change. db-ip rather than MaxMind for the automatic path because its
// monthly URL needs no account or license key on the box; a hand-managed
// GeoLite2 file works identically with AIM4_GEOIP_AUTOUPDATE=0.
//
// Unconfigured is a supported state, matching service.js: with neither source
// available every country resolves to null, and the sharing detector treats
// an unknown country as "cannot establish a difference" — it never flags.
// Local dev therefore never trips it: 127.0.0.1 has no country.
// ---------------------------------------------------------------------------

/** Loopback / RFC1918 / link-local, none of which have a country. */
export function isPrivateIp(ip) {
  const v = String(ip || '');
  if (!v) return true;
  if (v === '::1' || v === 'localhost') return true;
  if (/^127\./.test(v) || /^10\./.test(v) || /^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v) || /^fe80:/i.test(v)) return true;
  return false;
}

// Loaded on first use and RELOADED when the file changes on disk, so a cron
// that drops a fresh GeoLite2 build in place takes effect without an app
// restart. The mtime is re-checked at most every RECHECK_MS, and a failed
// refresh keeps serving the previous reader — a half-written file during the
// cron's copy must not turn the whole detector off.
const RECHECK_MS = 6 * 60 * 60 * 1000;
let reader = null;
let loadedMtimeMs = 0;
let lastCheckMs = 0;
let loading = null;

async function geoReader() {
  const path = process.env.AIM4_GEOIP_DB || '';
  if (!path) return null;
  if (Date.now() - lastCheckMs < RECHECK_MS) return reader;
  if (loading) return loading;
  loading = (async () => {
    try {
      const [{ Reader }, { readFile, stat }] = await Promise.all([
        import('mmdb-lib'),
        import('node:fs/promises')
      ]);
      const mtimeMs = (await stat(path)).mtimeMs;
      if (!reader || mtimeMs !== loadedMtimeMs) {
        reader = new Reader(await readFile(path));
        loadedMtimeMs = mtimeMs;
        console.log(`[integrity] GeoIP database loaded (file dated ${new Date(mtimeMs).toISOString().slice(0, 10)})`);
      }
    } catch (err) {
      if (!reader) {
        console.warn(`[integrity] could not load GeoIP database at ${path}: ${err.message}`);
      }
    } finally {
      lastCheckMs = Date.now();
      loading = null;
    }
    return reader;
  })();
  return loading;
}

/** A plausible ISO 3166-1 alpha-2 code. XX and T1 are Cloudflare's "unknown". */
function validCode(value) {
  const code = String(value || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

// ---------------------------------------------------------------------------
// Self-updating database file.
// ---------------------------------------------------------------------------

/** Redownload when the file on disk is older than this. db-ip ships monthly. */
const STALE_MS = 35 * 24 * 60 * 60 * 1000;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
/** A country database is ~10 MB; anything bigger than this is not one. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** db-ip names its free builds by month; early in a month the new build may
 *  not be up yet, so the caller also tries `monthsAgo: 1`. */
function dbIpUrl(monthsAgo = 0) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return `https://download.db-ip.com/free/dbip-country-lite-${d.toISOString().slice(0, 7)}.mmdb.gz`;
}

/**
 * Ensure the file at AIM4_GEOIP_DB is present and fresh. Exported for the
 * boot job and for tests; safe to call repeatedly — it no-ops while the file
 * is younger than STALE_MS.
 *
 * The write is tmp-then-rename so the reader above can never see a half
 * file, and the downloaded bytes are parsed with mmdb-lib BEFORE the rename
 * so an outage page or truncated body can never replace a working database.
 *
 * @returns {Promise<boolean>} true when a new file was installed
 */
export async function refreshGeoDatabase() {
  const path = process.env.AIM4_GEOIP_DB || '';
  if (!path) return false;
  const fs = await import('node:fs/promises');

  try {
    const age = Date.now() - (await fs.stat(path)).mtimeMs;
    if (age < STALE_MS) return false;
  } catch {
    /* missing file: download it */
  }

  const urls = process.env.AIM4_GEOIP_URL
    ? [process.env.AIM4_GEOIP_URL]
    : [dbIpUrl(0), dbIpUrl(1)];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60 * 1000) });
      if (!res.ok) continue;
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) continue;
      // Gzip magic bytes; db-ip serves .mmdb.gz, a hand-set URL may be raw.
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const { gunzipSync } = await import('node:zlib');
        buf = gunzipSync(buf);
      }
      // Validate before install: constructing the reader parses the metadata,
      // and a known lookup proves the tree is readable.
      const { Reader } = await import('mmdb-lib');
      if (new Reader(buf).get('8.8.8.8')?.country?.iso_code !== 'US') continue;

      const tmp = `${path}.tmp`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, path);
      // Make the reader re-stat on its next lookup rather than in 6 hours.
      lastCheckMs = 0;
      console.log(`[integrity] GeoIP database updated from ${url} (${(buf.length / 1e6).toFixed(1)} MB)`);
      return true;
    } catch (err) {
      console.warn(`[integrity] GeoIP update from ${url} failed: ${err.message}`);
    }
  }
  return false;
}

/**
 * Boot job, registered in server/index.js beside the other background work.
 * First check is deferred past the deploy scramble; after that, daily. The
 * timers are unref'd so a pending check never holds the process open.
 */
export function startGeoUpdater() {
  if (!process.env.AIM4_GEOIP_DB) return;
  if (/^(0|false|no|off)$/i.test(process.env.AIM4_GEOIP_AUTOUPDATE || '')) return;
  setTimeout(() => refreshGeoDatabase().catch(() => {}), 45 * 1000).unref?.();
  setInterval(() => refreshGeoDatabase().catch(() => {}), UPDATE_EVERY_MS).unref?.();
}

/**
 * ISO country code for this request, or null when it cannot be established.
 *
 * @param {import('http').IncomingMessage|null} req
 * @param {string|null} ip already extracted via clientIp(), so both callers
 *   agree on which address was used
 */
export async function countryForRequest(req, ip) {
  if (process.env.AIM4_TRUST_PROXY === '1') {
    const header =
      validCode(req?.headers?.['cf-ipcountry']) ||
      validCode(req?.headers?.['x-vercel-ip-country']);
    if (header) return header;
  }
  if (!ip || isPrivateIp(ip)) return null;
  const db = await geoReader();
  if (!db) return null;
  try {
    return validCode(db.get(ip)?.country?.iso_code);
  } catch {
    return null;
  }
}
