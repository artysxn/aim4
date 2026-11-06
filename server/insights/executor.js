// ---------------------------------------------------------------------------
// server/insights/executor.js
// Real orders, placed from the owner's PC.
//
// Why a separate piece: Polymarket refuses orders from some countries, the
// aim4.io server's among them (geoblock answered blocked:true, DE, 2026-11-06),
// and a wallet key does not belong on a shared server anyway. So aim4.io only
// decides; this loop, inside the aim4 desktop app's local server, holds the
// key, asks aim4.io for queued orders every ~1.5 s, places them through
// Polymarket's SDK and reports back.
//
// The key never leaves this PC: it is stored in a file under the user's home
// folder, read by this process only, and never sent to aim4.io or the page
// (the page sees the signer ADDRESS, derived from it, and nothing else).
//
// Local routes (this machine only, never proxied to aim4.io):
//   GET    /api/insights-local/status
//   POST   /api/insights-local/config   { token?, wallet?, privateKey?, name? }
//   DELETE /api/insights-local/config
//   POST   /api/insights-local/test     balance + geoblock now
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geoblock, getJson, DATA } from './polymarket.js';

const POLL_MS = 700;
const HEARTBEAT_MS = 30e3;
const GEO_TTL = 10 * 60e3;

export function executorFile() {
  return process.env.AIM4_INSIGHTS_EXECUTOR_FILE || path.join(os.homedir(), '.aim4', 'insights-executor.json');
}

const state = {
  running: false,
  timer: null,
  lastPoll: 0,
  lastOk: 0,
  lastError: '',
  lastBeat: 0,
  geo: null,
  geoAt: 0,
  balance: null,
  signer: '',
  client: null,
  clientKey: '',
  sdk: '',
  placed: 0,
  failed: 0,
  busy: false
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(executorFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const f = executorFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Where the decisions come from: the online aim4, or this same server when it runs the engine. */
function baseUrl(cfg) {
  if (cfg.base) return cfg.base.replace(/\/$/, '');
  if (process.env.AIM4_UPSTREAM) return String(process.env.AIM4_UPSTREAM).replace(/\/$/, '');
  return `http://127.0.0.1:${process.env.AIM4_PORT || process.env.PORT || 3784}`;
}

const ready = (cfg) => Boolean(cfg.token && cfg.wallet && cfg.privateKey);

async function sdk() {
  try {
    const mod = await import('@polymarket/client');
    const viem = await import('@polymarket/client/viem');
    state.sdk = 'ok';
    return { ...mod, privateKey: viem.privateKey };
  } catch (err) {
    state.sdk = `missing: ${err.message.slice(0, 120)}`;
    throw new Error('Polymarket SDK is not installed here (npm install).');
  }
}

/** Signer address for a key, without keeping anything around. */
async function addressOf(privateKey) {
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    return privateKeyToAccount(normalizeKey(privateKey)).address;
  } catch {
    return '';
  }
}

function normalizeKey(k) {
  const s = String(k || '').trim();
  return s.startsWith('0x') ? s : `0x${s}`;
}

async function client(cfg) {
  const key = `${cfg.wallet}|${cfg.privateKey.slice(-6)}|${cfg.relayerKey ? cfg.relayerKey.slice(-4) : ''}`;
  if (state.client && state.clientKey === key) return state.client;
  const m = await sdk();
  const opts = { wallet: cfg.wallet, signer: m.privateKey(normalizeKey(cfg.privateKey)) };
  // Claims are gasless wallet transactions; Polymarket authorises those with a Relayer API key.
  if (cfg.relayerKey && cfg.relayerAddress) opts.apiKey = m.relayerApiKey({ key: cfg.relayerKey, address: cfg.relayerAddress });
  state.client = await m.createSecureClient(opts);
  state.clientKey = key;
  state.signer = await addressOf(cfg.privateKey);
  return state.client;
}

async function checkGeo(force = false) {
  if (!force && state.geo && Date.now() - state.geoAt < GEO_TTL) return state.geo;
  try {
    state.geo = await geoblock();
    state.geoAt = Date.now();
  } catch (err) {
    state.geo = { blocked: null, error: err.message };
    state.geoAt = Date.now() - GEO_TTL + 60e3;
  }
  return state.geo;
}

async function fetchBalance(cfg) {
  const m = await sdk();
  const c = await client(cfg);
  // A low-level action in this SDK version, not a client method.
  const actions = await import('@polymarket/client/actions');
  const r = await actions.fetchBalanceAllowance(c, { assetType: m.AssetType?.COLLATERAL || 'COLLATERAL' });
  // pUSD has 6 decimals; the SDK hands back base units.
  const raw = typeof r.balance === 'bigint' ? Number(r.balance) : Number(r.balance);
  state.balance = Number.isFinite(raw) ? raw / 1e6 : null;
  return state.balance;
}

async function call(cfg, which, body) {
  const res = await fetch(`${baseUrl(cfg)}/api/insights/executor/${which}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body || {})
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(out.error || `${which} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return out;
}

// ---- idempotency journal: an intent id is placed at most once on this PC ----------

function journalFile() {
  return `${executorFile()}.journal`;
}
function journalHas(id) {
  try {
    return fs.readFileSync(journalFile(), 'utf8').includes(`${id}\n`);
  } catch {
    return false;
  }
}
function journalAdd(id) {
  fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
  fs.appendFileSync(journalFile(), `${id}\n`);
}

// ---- dead-man switch: while orders rest, heartbeat every 5 s ------------------------
// Polymarket cancels every open order of this API key ten seconds after the
// last accepted heartbeat. So if this PC, the app or the network dies, resting
// limit orders die with it instead of filling unattended.

const hb = { id: null, timer: null, until: 0, errors: 0 };
function keepHeartbeat(cfg, untilMs) {
  hb.until = Math.max(hb.until, untilMs);
  if (hb.timer) return;
  const beat = async () => {
    if (Date.now() > hb.until) {
      clearInterval(hb.timer);
      hb.timer = null;
      hb.id = null;
      return;
    }
    try {
      const c = await client(cfg);
      const r = await c.sendOrderHeartbeat(hb.id ? { heartbeatId: hb.id } : undefined);
      hb.id = r?.heartbeatId ?? hb.id;
      hb.errors = 0;
    } catch (err) {
      hb.errors++;
      state.lastError = `heartbeat: ${err.message}`;
    }
  };
  beat();
  hb.timer = setInterval(beat, 5000);
  hb.timer.unref?.();
}

/** A GTD limit order: rests until ttl, then whatever is left is cancelled. Reports the total fill. */
async function placeLimit(cfg, intent) {
  const m = await sdk();
  const c = await client(cfg);
  const ttl = Math.min(600, Math.max(30, intent.ttlSec || 90));
  // GTD expirations need a minute of slack on the CLOB side; cancel ourselves at ttl.
  const expiration = Math.floor(Date.now() / 1000) + 60 + ttl;
  keepHeartbeat(cfg, Date.now() + (ttl + 20) * 1000);
  const r = await c.placeLimitOrder({ assetId: intent.tokenId, side: intent.side === 'SELL' ? m.OrderSide.SELL : m.OrderSide.BUY, price: String(intent.price), size: String(intent.size), expiration });
  if (!r.ok) return { ok: false, error: `${r.code}: ${r.message}` };
  let filledShares = Number(r.takingAmount) || 0;
  let spent = Number(r.makingAmount) || 0;
  if (intent.side === 'SELL') [filledShares, spent] = [Number(r.makingAmount) || 0, Number(r.takingAmount) || 0];
  const deadline = Date.now() + ttl * 1000;
  // Poll the order until it fills or its time is up.
  while (Date.now() < deadline && filledShares < Number(intent.size) - 0.01) {
    await new Promise((res) => setTimeout(res, 3000));
    try {
      const o = await c.fetchOrder({ orderId: r.orderId });
      const matched = Number(o?.sizeMatched ?? o?.size_matched ?? 0);
      if (matched > filledShares) {
        filledShares = matched;
        spent = matched * Number(intent.price);
      }
      if (o && /cancel|expired/i.test(String(o.status || ''))) break;
    } catch {
      /* keep waiting; the heartbeat and the GTD expiry are the safety nets */
    }
  }
  try {
    await c.cancelOrder({ orderId: r.orderId });
  } catch {
    /* filled or already gone */
  }
  return { ok: true, orderId: r.orderId, status: filledShares > 0 ? 'matched' : 'unfilled', spent, shares: filledShares };
}

/** One order. Market (FAK) orders with a hard price cap, so a thin book cannot fill at any price. */
async function execute(cfg, intent) {
  const geo = await checkGeo();
  if (geo?.blocked) return { ok: false, error: `Polymarket blocks trading from ${geo.country || 'this location'}` };
  if (intent.expiresAt && Date.now() > intent.expiresAt) return { ok: false, error: 'Expired before it could be placed' };
  if (journalHas(intent.id)) return { ok: false, error: 'Already placed once (journal); not placing again' };
  journalAdd(intent.id);
  if (intent.type === 'limit') return placeLimit(cfg, intent);
  const m = await sdk();
  const c = await client(cfg);
  let r;
  if (intent.side === 'BUY') {
    r = await c.placeMarketOrder({ assetId: intent.tokenId, side: m.OrderSide.BUY, amount: String(intent.amount), maxPrice: String(intent.maxPrice), orderType: m.OrderType.FAK });
    if (!r.ok) return { ok: false, error: `${r.code}: ${r.message}` };
    // BUY: making = pUSD paid, taking = shares received.
    return { ok: true, orderId: r.orderId, status: r.status, spent: Number(r.makingAmount) || 0, shares: Number(r.takingAmount) || 0 };
  }
  r = await c.placeMarketOrder({ assetId: intent.tokenId, side: m.OrderSide.SELL, shares: String(Math.floor(intent.shares * 100) / 100), minPrice: String(intent.minPrice || 0.01), orderType: m.OrderType.FAK });
  if (!r.ok) return { ok: false, error: `${r.code}: ${r.message}` };
  // SELL: making = shares sold, taking = pUSD received.
  return { ok: true, orderId: r.orderId, status: r.status, spent: Number(r.takingAmount) || 0, shares: Number(r.makingAmount) || 0 };
}

// ---- claiming winnings -------------------------------------------------------------
// A resolved market's winning shares sit in the wallet until they are redeemed
// for pUSD. Until then they are not in the cash balance, so stakes sized as a
// % of the wallet shrink and the balance looks like it is draining. Every five
// minutes the executor redeems every resolved market
// with a winning value, as soon as Polymarket marks it redeemable. Losing
// positions (worth 0) are left alone.

const CLAIM_EVERY_MS = 5 * 60e3;
const claims = { running: false, lastScan: 0, total: 0, count: 0, last: null, errors: 0, lastError: '', pending: 0, retryAt: new Map() };

async function claimWinnings(cfg) {
  if (claims.running || !ready(cfg)) return;
  claims.running = true;
  try {
    const body = await getJson(`${DATA}/v2/positions?user=${encodeURIComponent(cfg.wallet)}&status=REDEEMABLE&limit=500`);
    const rows = (body?.data || []).filter((r) => Number(r.current_value) >= 0.05);
    const byCond = new Map();
    for (const r of rows) byCond.set(r.condition_id, (byCond.get(r.condition_id) || 0) + Number(r.current_value || 0));
    claims.pending = [...byCond.values()].reduce((sum, v) => sum + v, 0);
    for (const [cond, value] of byCond) {
      if ((claims.retryAt.get(cond) || 0) > Date.now()) continue;
      try {
        const c = await client(cfg);
        const handle = await c.redeemPositions({ conditionId: cond });
        const out = await handle.wait();
        claims.total += value;
        claims.count++;
        claims.pending -= value;
        claims.last = { at: Date.now(), value, tx: String(out?.transactionHash || '') };
        claims.retryAt.delete(cond);
        state.lastBeat = 0; // the balance changed: report it with the next round
      } catch (err) {
        claims.errors++;
        claims.lastError = /relayer|api key|unauthor|401|403/i.test(err.message) && !cfg.relayerKey ? `${err.message.slice(0, 160)} (add a Relayer API key)` : err.message.slice(0, 200);
        claims.retryAt.set(cond, Date.now() + 30 * 60e3);
      }
    }
  } catch (err) {
    claims.lastError = `scan: ${err.message.slice(0, 160)}`;
  } finally {
    claims.running = false;
    claims.lastScan = Date.now();
  }
}

async function loop() {
  if (state.busy) return;
  state.busy = true;
  const cfg = readConfig();
  try {
    if (!ready(cfg)) return;
    state.lastPoll = Date.now();
    if (Date.now() - state.lastBeat > HEARTBEAT_MS) {
      state.lastBeat = Date.now();
      let error = '';
      try {
        await fetchBalance(cfg);
      } catch (err) {
        error = err.message;
      }
      const geo = await checkGeo();
      await call(cfg, 'heartbeat', { balance: state.balance, wallet: cfg.wallet, signer: state.signer || (await addressOf(cfg.privateKey)), geo, sdk: state.sdk, error });
    }
    if (Date.now() - claims.lastScan > CLAIM_EVERY_MS) claimWinnings(cfg).catch(() => {});
    const work = await call(cfg, 'poll', {});
    state.lastOk = Date.now();
    state.lastError = '';
    // Disarmed upstream: nothing new is placed, and anything resting is pulled.
    if (!work.armed && hb.timer) {
      try {
        const c = await client(cfg);
        await c.cancelAll();
      } catch (err) {
        state.lastError = `cancel all: ${err.message}`;
      }
      hb.until = 0;
    }
    for (const intent of work.intents || []) {
      const runOne = async () => {
        let result;
        try {
          result = await execute(cfg, intent);
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        if (result.ok) state.placed++;
        else state.failed++;
        await call(cfg, 'report', { id: intent.id, ...result }).catch((err) => {
          state.lastError = `report: ${err.message}`;
        });
        state.lastBeat = 0; // balance changed: send it with the next round
      };
      // A resting limit order waits up to its ttl; it must not hold up market orders.
      if (intent.type === 'limit') runOne();
      else await runOne();
    }
  } catch (err) {
    state.lastError = err.message;
    // Lost aim4 for 15 s with orders resting: pull them rather than leave them unattended.
    if (hb.timer && Date.now() - state.lastOk > 15e3) {
      try {
        const c = await client(cfg);
        await c.cancelAll();
        hb.until = 0;
      } catch {
        /* the heartbeat lapsing cancels them within 10 s anyway */
      }
    }
  } finally {
    state.busy = false;
  }
}

export function startExecutor() {
  if (state.running) return;
  state.running = true;
  const tickFn = async () => {
    await loop();
    state.timer = setTimeout(tickFn, POLL_MS);
    state.timer.unref?.();
  };
  state.timer = setTimeout(tickFn, 3000);
  state.timer.unref?.();
}

export async function executorStatus() {
  const cfg = readConfig();
  return {
    available: true,
    linked: Boolean(cfg.token),
    deviceName: cfg.name || '',
    wallet: cfg.wallet || '',
    hasKey: Boolean(cfg.privateKey),
    signer: cfg.privateKey ? state.signer || (await addressOf(cfg.privateKey)) : '',
    base: baseUrl(cfg),
    running: state.running && ready(cfg),
    lastPoll: state.lastPoll,
    lastOk: state.lastOk,
    lastError: state.lastError,
    balance: state.balance,
    geo: state.geo,
    sdk: state.sdk,
    placed: state.placed,
    failed: state.failed,
    file: executorFile(),
    relayer: Boolean(cfg.relayerKey && cfg.relayerAddress),
    claims: { total: claims.total, count: claims.count, last: claims.last, pending: claims.pending, errors: claims.errors, lastError: claims.lastError, lastScan: claims.lastScan }
  };
}

// ---- local routes ---------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8192) throw Object.assign(new Error('Too large.'), { status: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

const isLoopback = (a) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(a || ''));

/**
 * Only the Insights owner may configure this. With an upstream, the page's own
 * session is checked against aim4.io; in local mode the one local account is it.
 */
async function ownerOk(req) {
  const upstream = String(process.env.AIM4_UPSTREAM || '').replace(/\/$/, '');
  if (!upstream) {
    const { localMode } = await import('../local/mode.js');
    if (localMode()) return true;
    const { whoami } = await import('../replays/identity.js');
    const { isInsightsOwner } = await import('./routes.js');
    return isInsightsOwner(await whoami(req));
  }
  const auth = String(req.headers.authorization || '');
  if (!auth) return false;
  try {
    const r = await fetch(`${upstream}/api/insights/access`, { headers: { Authorization: auth } });
    return r.ok;
  } catch {
    return false;
  }
}

/** @returns {Promise<boolean>} */
export async function handleInsightsLocalRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/insights-local/')) return false;
  if (!isLoopback(req.socket?.remoteAddress)) return json(res, 404, { error: 'Not found' }), true;
  try {
    if (!(await ownerOk(req))) return json(res, 404, { error: 'Not found' }), true;
    if (req.method === 'GET' && p === '/api/insights-local/status') return json(res, 200, await executorStatus()), true;
    if (p === '/api/insights-local/config' && req.method === 'POST') {
      const body = await readJson(req);
      const cfg = readConfig();
      if (typeof body.token === 'string' && body.token) cfg.token = body.token.trim();
      if (typeof body.name === 'string') cfg.name = body.name.slice(0, 40);
      if (typeof body.wallet === 'string') {
        const w = body.wallet.trim();
        if (w && !/^0x[0-9a-fA-F]{40}$/.test(w)) return json(res, 400, { error: 'Wallet address should be 0x followed by 40 hex characters.' }), true;
        cfg.wallet = w;
      }
      if (typeof body.relayerKey === 'string' && body.relayerKey.trim()) cfg.relayerKey = body.relayerKey.trim().slice(0, 200);
      if (typeof body.relayerAddress === 'string') {
        const a = body.relayerAddress.trim();
        if (a && !/^0x[0-9a-fA-F]{40}$/.test(a)) return json(res, 400, { error: 'Relayer key address should be 0x followed by 40 hex characters.' }), true;
        if (a) cfg.relayerAddress = a;
      }
      if (typeof body.privateKey === 'string' && body.privateKey.trim()) {
        const k = normalizeKey(body.privateKey);
        if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return json(res, 400, { error: 'Private key should be 64 hex characters.' }), true;
        cfg.privateKey = k;
      }
      writeConfig(cfg);
      state.client = null;
      state.lastBeat = 0;
      startExecutor();
      return json(res, 200, await executorStatus()), true;
    }
    if (p === '/api/insights-local/config' && req.method === 'DELETE') {
      try {
        fs.unlinkSync(executorFile());
      } catch {
        /* already gone */
      }
      state.client = null;
      state.balance = null;
      state.signer = '';
      return json(res, 200, await executorStatus()), true;
    }
    if (p === '/api/insights-local/claim' && req.method === 'POST') {
      claims.retryAt.clear();
      await claimWinnings(readConfig());
      return json(res, 200, await executorStatus()), true;
    }
    if (p === '/api/insights-local/test' && req.method === 'POST') {
      const cfg = readConfig();
      const out = { geo: await checkGeo(true), balance: null, error: '' };
      if (cfg.wallet && cfg.privateKey) {
        try {
          out.balance = await fetchBalance(cfg);
        } catch (err) {
          out.error = err.message;
        }
      } else out.error = 'Add the wallet address and key first.';
      return json(res, 200, { ...out, status: await executorStatus() }), true;
    }
    return json(res, 404, { error: 'Not found' }), true;
  } catch (err) {
    json(res, err.status || 500, { error: err.message });
    return true;
  }
}

/** Start the loop at boot when this PC already has a configured executor. */
export function maybeStartExecutor() {
  if (ready(readConfig())) startExecutor();
}
