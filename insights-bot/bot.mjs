// Built by insights-bot/build.mjs from server/insights. Do not edit by hand.

// server/insights/run-executor.js
import fs2 from "node:fs";

// server/insights/executor.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server/insights/polymarket.js
var DATA = "https://data-api.polymarket.com";
var GEOBLOCK = "https://polymarket.com/api/geoblock";
var MAX_IN_FLIGHT = 4;
var TIMEOUT_MS = 15e3;
var inFlight = 0;
var waiting = [];
var requestStats = { total: 0, failed: 0, throttled: 0, lastError: "" };
function acquire() {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, opts = {}) {
  const f = opts.fetchImpl || globalThis.fetch;
  await acquire();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      requestStats.total++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await f(url, { headers: { Accept: "application/json", "User-Agent": "aim4-insights/1.0" }, signal: ctl.signal });
      } catch (err) {
        requestStats.failed++;
        requestStats.lastError = `${new URL(url).host}: ${err.name === "AbortError" ? "timeout" : err.message}`;
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt === 0) {
        requestStats.throttled++;
        const after = Number(res.headers.get("retry-after")) || 2;
        await sleep(Math.min(30, after) * 1e3);
        continue;
      }
      if (!res.ok) {
        requestStats.failed++;
        const body = await res.text().catch(() => "");
        const err = new Error(`${new URL(url).host}${new URL(url).pathname} ${res.status} ${body.slice(0, 160)}`);
        err.status = res.status;
        requestStats.lastError = err.message;
        throw err;
      }
      return await res.json();
    }
    throw new Error("rate limited");
  } finally {
    release();
  }
}
function geoblock(opts) {
  return getJson(GEOBLOCK, opts);
}

// server/insights/executor.js
var POLL_MS = 700;
var HEARTBEAT_MS = 3e4;
var GEO_TTL = 10 * 6e4;
function executorFile() {
  return process.env.AIM4_INSIGHTS_EXECUTOR_FILE || path.join(os.homedir(), ".aim4", "insights-executor.json");
}
var state = {
  running: false,
  timer: null,
  lastPoll: 0,
  lastOk: 0,
  lastError: "",
  lastBeat: 0,
  geo: null,
  geoAt: 0,
  balance: null,
  signer: "",
  client: null,
  clientKey: "",
  sdk: "",
  placed: 0,
  failed: 0,
  busy: false
};
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(executorFile(), "utf8"));
  } catch {
    return {};
  }
}
function baseUrl(cfg2) {
  if (cfg2.base) return cfg2.base.replace(/\/$/, "");
  if (process.env.AIM4_UPSTREAM) return String(process.env.AIM4_UPSTREAM).replace(/\/$/, "");
  return `http://127.0.0.1:${process.env.AIM4_PORT || process.env.PORT || 3784}`;
}
var ready = (cfg2) => Boolean(cfg2.token && cfg2.wallet && cfg2.privateKey);
async function sdk() {
  try {
    const mod = await import("@polymarket/client");
    const viem = await import("@polymarket/client/viem");
    state.sdk = "ok";
    return { ...mod, privateKey: viem.privateKey };
  } catch (err) {
    state.sdk = `missing: ${err.message.slice(0, 120)}`;
    throw new Error("Polymarket SDK is not installed here (npm install).");
  }
}
async function addressOf(privateKey) {
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(normalizeKey(privateKey)).address;
  } catch {
    return "";
  }
}
function normalizeKey(k) {
  const s = String(k || "").trim();
  return s.startsWith("0x") ? s : `0x${s}`;
}
async function client(cfg2) {
  const key = `${cfg2.wallet}|${cfg2.privateKey.slice(-6)}|${cfg2.relayerKey ? cfg2.relayerKey.slice(-4) : ""}`;
  if (state.client && state.clientKey === key) return state.client;
  const m = await sdk();
  const opts = { wallet: cfg2.wallet, signer: m.privateKey(normalizeKey(cfg2.privateKey)) };
  if (cfg2.relayerKey && cfg2.relayerAddress) opts.apiKey = m.relayerApiKey({ key: cfg2.relayerKey, address: cfg2.relayerAddress });
  state.client = await m.createSecureClient(opts);
  state.clientKey = key;
  state.signer = await addressOf(cfg2.privateKey);
  return state.client;
}
async function checkGeo(force = false) {
  if (!force && state.geo && Date.now() - state.geoAt < GEO_TTL) return state.geo;
  try {
    state.geo = await geoblock();
    state.geoAt = Date.now();
  } catch (err) {
    state.geo = { blocked: null, error: err.message };
    state.geoAt = Date.now() - GEO_TTL + 6e4;
  }
  return state.geo;
}
async function fetchBalance(cfg2) {
  const m = await sdk();
  const c = await client(cfg2);
  const actions = await import("@polymarket/client/actions");
  const r = await actions.fetchBalanceAllowance(c, { assetType: m.AssetType?.COLLATERAL || "COLLATERAL" });
  const raw = typeof r.balance === "bigint" ? Number(r.balance) : Number(r.balance);
  state.balance = Number.isFinite(raw) ? raw / 1e6 : null;
  return state.balance;
}
async function call(cfg2, which, body) {
  const res = await fetch(`${baseUrl(cfg2)}/api/insights/executor/${which}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg2.token}` },
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
function journalFile() {
  return `${executorFile()}.journal`;
}
function journalHas(id) {
  try {
    return fs.readFileSync(journalFile(), "utf8").includes(`${id}
`);
  } catch {
    return false;
  }
}
function journalAdd(id) {
  fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
  fs.appendFileSync(journalFile(), `${id}
`);
}
var hb = { id: null, timer: null, until: 0, errors: 0 };
function keepHeartbeat(cfg2, untilMs) {
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
      const c = await client(cfg2);
      const r = await c.sendOrderHeartbeat(hb.id ? { heartbeatId: hb.id } : void 0);
      hb.id = r?.heartbeatId ?? hb.id;
      hb.errors = 0;
    } catch (err) {
      hb.errors++;
      state.lastError = `heartbeat: ${err.message}`;
    }
  };
  beat();
  hb.timer = setInterval(beat, 5e3);
  hb.timer.unref?.();
}
async function placeLimit(cfg2, intent) {
  const m = await sdk();
  const c = await client(cfg2);
  const ttl = Math.min(600, Math.max(30, intent.ttlSec || 90));
  const expiration = Math.floor(Date.now() / 1e3) + 60 + ttl;
  keepHeartbeat(cfg2, Date.now() + (ttl + 20) * 1e3);
  const r = await c.placeLimitOrder({ assetId: intent.tokenId, side: intent.side === "SELL" ? m.OrderSide.SELL : m.OrderSide.BUY, price: String(intent.price), size: String(intent.size), expiration });
  if (!r.ok) return { ok: false, error: `${r.code}: ${r.message}` };
  let filledShares = Number(r.takingAmount) || 0;
  let spent = Number(r.makingAmount) || 0;
  if (intent.side === "SELL") [filledShares, spent] = [Number(r.makingAmount) || 0, Number(r.takingAmount) || 0];
  const deadline = Date.now() + ttl * 1e3;
  while (Date.now() < deadline && filledShares < Number(intent.size) - 0.01) {
    await new Promise((res) => setTimeout(res, 3e3));
    try {
      const o = await c.fetchOrder({ orderId: r.orderId });
      const matched = Number(o?.sizeMatched ?? o?.size_matched ?? 0);
      if (matched > filledShares) {
        filledShares = matched;
        spent = matched * Number(intent.price);
      }
      if (o && /cancel|expired/i.test(String(o.status || ""))) break;
    } catch {
    }
  }
  try {
    await c.cancelOrder({ orderId: r.orderId });
  } catch {
  }
  return { ok: true, orderId: r.orderId, status: filledShares > 0 ? "matched" : "unfilled", spent, shares: filledShares };
}
async function execute(cfg2, intent) {
  const geo = await checkGeo();
  if (geo?.blocked) return { ok: false, error: `Polymarket blocks trading from ${geo.country || "this location"}` };
  if (intent.expiresAt && Date.now() > intent.expiresAt) return { ok: false, error: "Expired before it could be placed" };
  if (journalHas(intent.id)) return { ok: false, error: "Already placed once (journal); not placing again" };
  journalAdd(intent.id);
  if (intent.type === "limit") return placeLimit(cfg2, intent);
  const m = await sdk();
  const c = await client(cfg2);
  let r;
  if (intent.side === "BUY") {
    r = await c.placeMarketOrder({ assetId: intent.tokenId, side: m.OrderSide.BUY, amount: String(intent.amount), maxPrice: String(intent.maxPrice), orderType: m.OrderType.FAK });
    if (!r.ok) return { ok: false, error: `${r.code}: ${r.message}` };
    return { ok: true, orderId: r.orderId, status: r.status, spent: Number(r.makingAmount) || 0, shares: Number(r.takingAmount) || 0 };
  }
  r = await c.placeMarketOrder({ assetId: intent.tokenId, side: m.OrderSide.SELL, shares: String(Math.floor(intent.shares * 100) / 100), minPrice: String(intent.minPrice || 0.01), orderType: m.OrderType.FAK });
  if (!r.ok) return { ok: false, error: `${r.code}: ${r.message}` };
  return { ok: true, orderId: r.orderId, status: r.status, spent: Number(r.takingAmount) || 0, shares: Number(r.makingAmount) || 0 };
}
var CLAIM_EVERY_MS = 5 * 6e4;
var claims = { running: false, lastScan: 0, total: 0, count: 0, last: null, errors: 0, lastError: "", pending: 0, retryAt: /* @__PURE__ */ new Map() };
async function claimWinnings(cfg2) {
  if (claims.running || !ready(cfg2)) return;
  claims.running = true;
  try {
    const body = await getJson(`${DATA}/v2/positions?user=${encodeURIComponent(cfg2.wallet)}&status=REDEEMABLE&limit=500`);
    const rows = (body?.data || []).filter((r) => Number(r.current_value) >= 0.05);
    const byCond = /* @__PURE__ */ new Map();
    for (const r of rows) byCond.set(r.condition_id, (byCond.get(r.condition_id) || 0) + Number(r.current_value || 0));
    claims.pending = [...byCond.values()].reduce((sum, v) => sum + v, 0);
    for (const [cond, value] of byCond) {
      if ((claims.retryAt.get(cond) || 0) > Date.now()) continue;
      try {
        const c = await client(cfg2);
        const handle = await c.redeemPositions({ conditionId: cond });
        const out = await handle.wait();
        claims.total += value;
        claims.count++;
        claims.pending -= value;
        claims.last = { at: Date.now(), value, tx: String(out?.transactionHash || "") };
        claims.retryAt.delete(cond);
        state.lastBeat = 0;
      } catch (err) {
        claims.errors++;
        claims.lastError = /relayer|api key|unauthor|401|403/i.test(err.message) && !cfg2.relayerKey ? `${err.message.slice(0, 160)} (add a Relayer API key)` : err.message.slice(0, 200);
        claims.retryAt.set(cond, Date.now() + 30 * 6e4);
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
  const cfg2 = readConfig();
  try {
    if (!ready(cfg2)) return;
    state.lastPoll = Date.now();
    if (Date.now() - state.lastBeat > HEARTBEAT_MS) {
      state.lastBeat = Date.now();
      let error = "";
      try {
        await fetchBalance(cfg2);
      } catch (err) {
        error = err.message;
      }
      const geo = await checkGeo();
      await call(cfg2, "heartbeat", { balance: state.balance, wallet: cfg2.wallet, signer: state.signer || await addressOf(cfg2.privateKey), geo, sdk: state.sdk, error });
    }
    if (Date.now() - claims.lastScan > CLAIM_EVERY_MS) claimWinnings(cfg2).catch(() => {
    });
    const work = await call(cfg2, "poll", {});
    state.lastOk = Date.now();
    state.lastError = "";
    if (!work.armed && hb.timer) {
      try {
        const c = await client(cfg2);
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
          result = await execute(cfg2, intent);
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        if (result.ok) state.placed++;
        else state.failed++;
        await call(cfg2, "report", { id: intent.id, ...result }).catch((err) => {
          state.lastError = `report: ${err.message}`;
        });
        state.lastBeat = 0;
      };
      if (intent.type === "limit") runOne();
      else await runOne();
    }
  } catch (err) {
    state.lastError = err.message;
    if (hb.timer && Date.now() - state.lastOk > 15e3) {
      try {
        const c = await client(cfg2);
        await c.cancelAll();
        hb.until = 0;
      } catch {
      }
    }
  } finally {
    state.busy = false;
  }
}
function startExecutor() {
  if (state.running) return;
  state.running = true;
  const tickFn = async () => {
    await loop();
    state.timer = setTimeout(tickFn, POLL_MS);
    state.timer.unref?.();
  };
  state.timer = setTimeout(tickFn, 3e3);
  state.timer.unref?.();
}
async function executorStatus() {
  const cfg2 = readConfig();
  return {
    available: true,
    linked: Boolean(cfg2.token),
    deviceName: cfg2.name || "",
    wallet: cfg2.wallet || "",
    hasKey: Boolean(cfg2.privateKey),
    signer: cfg2.privateKey ? state.signer || await addressOf(cfg2.privateKey) : "",
    base: baseUrl(cfg2),
    running: state.running && ready(cfg2),
    lastPoll: state.lastPoll,
    lastOk: state.lastOk,
    lastError: state.lastError,
    balance: state.balance,
    geo: state.geo,
    sdk: state.sdk,
    placed: state.placed,
    failed: state.failed,
    file: executorFile(),
    relayer: Boolean(cfg2.relayerKey && cfg2.relayerAddress),
    claims: { total: claims.total, count: claims.count, last: claims.last, pending: claims.pending, errors: claims.errors, lastError: claims.lastError, lastScan: claims.lastScan }
  };
}

// server/insights/run-executor.js
if (!process.env.AIM4_UPSTREAM) process.env.AIM4_UPSTREAM = "https://aim4.io";
var file = executorFile();
var cfg = {};
try {
  cfg = JSON.parse(fs2.readFileSync(file, "utf8"));
} catch {
  console.error(`No executor config at ${file}. Copy insights-executor.json from the PC first.`);
  process.exit(1);
}
for (const k of ["token", "wallet", "privateKey"]) {
  if (!cfg[k]) {
    console.error(`Config is missing "${k}". Link the PC and save the wallet and key in Settings > This PC, then copy the file again.`);
    process.exit(1);
  }
}
startExecutor();
console.log(`Insights executor running for ${cfg.wallet.slice(0, 6)}..${cfg.wallet.slice(-4)}, talking to ${process.env.AIM4_UPSTREAM}`);
setInterval(async () => {
  const s = await executorStatus();
  console.log(
    `${(/* @__PURE__ */ new Date()).toISOString()} poll ${s.lastOk ? Math.round((Date.now() - s.lastOk) / 1e3) + "s ago" : "never"} | balance ${s.balance ?? "-"} | ${s.geo ? `${s.geo.country} ${s.geo.blocked ? "BLOCKED" : "allowed"}` : "location -"} | placed ${s.placed} failed ${s.failed} | claimed $${(s.claims?.total || 0).toFixed(2)}${s.lastError ? ` | error: ${s.lastError}` : ""}`
  );
}, 5 * 6e4);
