// Live smoke test of Vision against real Polymarket feeds, in a throwaway data dir. Nothing is sent to
// Polymarket: the real-money bot's orders go to the engine's intent queue and a fake Mac executor here
// reports them filled, the way insights-bot would.
// Usage: node scripts/vision-smoke.mjs [seconds=420]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-'));
process.env.AIM4_INSIGHTS_DIR = tmp;
process.env.AIM4_LOCAL = '1';
const secs = Number(process.argv[2] || 420);

const { col, touch } = await import('../server/insights/store.js');
const engine = await import('../server/insights/engine.js'); // wires brain's hooks (wallets, intents)
const { allBots, updateBot, createBot } = await import('../server/insights/bots.js');
const { startVision, visionStatus, _loop } = await import('../server/insights/vision.js');

const v = allBots().find((b) => b.id === 'vision-v1');
console.log('seeded:', v && { name: v.name, type: v.type, mode: v.mode, enabled: v.enabled, sizing: v.sizing, params: v.params });
// trade at once: both timeframes, any favourite from 50c, almost the whole market
const loose = { ...v.params, timeframes: ['15m'], favLo: 0.55, favFrom: 880, favTo: 30 };
updateBot('vision-v1', { params: loose });
// a second Vision bot on real money, $5 a market
const real = createBot({ type: 'vision', name: 'Vision real test', enabled: true, sizing: { kind: 'fixed', value: 5 }, maxStake: 5, params: loose });
updateBot(real.id, { mode: 'real' });
// fake Mac executor: linked, online, armed, $100 balance
const { device } = engine.linkDevice('smoke-mac');
const dev = col('executor').devices.find((d) => d.id === device.id);
col('executor').armed = true;
touch('executor');
const keepOnline = () => Object.assign(dev, { lastSeen: Date.now(), info: { ...dev.info, balance: 100 } });
keepOnline();
let reported = 0;
const mac = setInterval(() => {
  keepOnline();
  for (const it of engine.pollIntents(dev).intents || []) {
    // fill at the cap, the worst case the executor allows
    const shares = Math.floor((it.amount / it.maxPrice) * 100) / 100;
    engine.reportIntent(dev, { id: it.id, ok: true, orderId: 'smoke', status: 'matched', spent: it.amount, shares });
    reported++;
  }
}, 1000);

startVision({ settings: () => ({ tracking: true, botsOn: true }), queueIntent: engine.queueIntent });
const t0 = Date.now();
const show = () => {
  const s = visionStatus();
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, JSON.stringify({ feed: s.feed, markets: s.markets.map((m) => ({ slug: m.slug, left: m.secondsLeft, up: m.askUp, dn: m.askDown, fair: m.fairUp, K: m.priceToBeat && Math.round(m.priceToBeat), err: m.error })), fills: s.fills, settled: s.settled, unsettled: s.unsettled, errors: s.errors, macReports: reported }));
};
const iv = setInterval(show, 30000);
await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(iv);
clearInterval(mac);
show();
await _loop();
const bets = col('bets').filter((b) => b.strategy === 'vision');
for (const b of bets) console.log(`${b.mode.padEnd(4)} ${b.status.padEnd(7)} ${b.title} | ${b.outcome} ${b.shares ?? '-'} @ ${b.price ? (b.price * 100).toFixed(1) + 'c' : '-'} cost $${(b.cost ?? b.amount).toFixed(2)} payout ${b.payout == null ? '-' : '$' + b.payout.toFixed(2)} | ${b.reason} ${b.secondsLeft}s left`);
const intents = col('intents');
console.log('intents:', JSON.stringify(intents.map((i) => ({ side: i.side, amount: i.amount, maxPrice: i.maxPrice, status: i.status }))));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
