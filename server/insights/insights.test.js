// Run: node server/insights/insights.test.js
//
// Insights: which matches are tracked, how a trade is scored, how records add
// up, and that a paper copy respects the stake caps. Network-free: the engine
// test stubs fetch and points the store at a temp folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim4-insights-'));
process.env.AIM4_INSIGHTS_DIR = tmp;
process.env.AIM4_LOCAL = '1';

const { matchEntry, matchKeyword, normalizeEvent, parseScore, parseTitle, trackDecision, vrsRankOf } = await import('./matching.js');
const { DEFAULT_SETTINGS, sanitizeSettings } = await import('./config.js');
const { scoreTrade, teamBehind, walletEdge } = await import('./signals.js');
const { betTotals, calibration, teamTable, walletRecord } = await import('./stats.js');
const { walkAsks, walkBids, takerFee } = await import('./polymarket.js');

// ---- name matching -----------------------------------------------------------

const list = DEFAULT_SETTINGS.teams;
assert(matchEntry('UNiTY esports', list) === 'unity', 'unity');
assert(matchEntry('Betclic Apogee Esports', list) === 'betclic', 'betclic');
assert(matchEntry('KUUSAMO.gg', list) === 'kuusamo', 'kuusamo.gg');
assert(matchEntry('QUINTESSÊNCIA', list) === 'Quintessence', 'accented language ending');
assert(matchEntry(' Phantom Academy', list) === 'phantom academy', 'leading space');
assert(matchEntry('BET-M 33', list) === 'bet-m', 'hyphenated');
assert(matchEntry('WRAITH PCIFIC', list) === 'pcific', 'second word');
assert(matchEntry('Drama eSports', list) === 'drama', 'drama');
assert(matchEntry('maybe', list) === 'maybe', 'maybe');
assert(matchEntry('Zero Tenacity', list) === 'ex-zero tenacity', 'ex- prefix optional');
assert(matchEntry('Nemiga', list) === '', 'NT must not match inside Nemiga');
assert(matchEntry('ENTROPIQ', list) === '', 'no substring hits');
assert(matchEntry('Natus Vincere', list) === '', 'navi untracked');
assert(matchEntry('Colorado', ['color']) === '', 'short entries need whole words');
assert(matchEntry('Team NT', ['NT']) === 'NT', 'filler word dropped');

assert(matchKeyword(['Counter-Strike: A vs B (BO3) - European Pro League Group C'], ['EPL', 'European Pro League']) === 'European Pro League', 'league words');
assert(matchKeyword(['x', 'CCT Europe'], ['CCT']) === 'CCT', 'league field');
assert(matchKeyword(['Exortion Cup'], ['Exort']) === '', 'keyword is a whole word');

const t = parseTitle('Counter-Strike: Drama eSports vs Ryvex (BO3) - CCT Europe Closed Qualifier: Series Group D');
assert(t.teamA === 'Drama eSports' && t.teamB === 'Ryvex' && t.format === 'BO3', 'title parse');
assert(t.league.startsWith('CCT Europe'), 'league from title');
assert(parseTitle('Will FaZe win a Tier 1 event in 2026?') === null, 'futures are not matches');

const sc = parseScore('4-9|1-0|Bo3');
assert(sc.rounds[0] === 4 && sc.maps[0] === 1 && sc.bestOf === 3, 'score parse');
assert(teamBehind(parseScore('4-9|1-1|Bo3'), 0, 'match') === true, 'down on rounds, level on maps');
assert(teamBehind(parseScore('12-3|0-1|Bo3'), 0, 'match') === true, 'down a map');
assert(teamBehind(parseScore('12-3|0-1|Bo3'), 1, 'match') === false, 'ahead a map');

// ---- VRS and tracking --------------------------------------------------------

const ranks = { size: 3, byKey: new Map([['vitality', { name: 'Vitality', rank: 2 }], ['falcons', { name: 'Falcons', rank: 6 }], ['sinners', { name: 'SINNERS', rank: 190 }]]), list: [{ name: 'Vitality', rank: 2 }, { name: 'Falcons', rank: 6 }, { name: 'SINNERS', rank: 190 }] };
assert(vrsRankOf('Team Falcons', ranks) === 6, 'filler word on the VRS side');
assert(vrsRankOf('Nobody FC', ranks) === 0, 'unranked');

const rawEvent = (title, teams, extra = {}) => ({
  id: '1',
  title,
  teams: teams.map((name) => ({ name })),
  startTime: '2026-11-07T10:00:00Z',
  eventMetadata: { league: extra.league || '' },
  markets: [{ id: 'm', conditionId: '0xabc', sportsMarketType: 'moneyline', outcomes: JSON.stringify(teams), clobTokenIds: JSON.stringify(['111', '222']), outcomePrices: JSON.stringify(['0.8', '0.2']) }]
});
const s = sanitizeSettings({});
const top = normalizeEvent(rawEvent('Counter-Strike: Vitality vs Team Falcons (BO3) - BLAST Rivals', ['Vitality', 'Team Falcons']));
assert(!trackDecision(top, s, ranks).track, 'two top teams are not tracked');
const low = normalizeEvent(rawEvent('Counter-Strike: Vitality vs SINNERS (BO3) - Qualifier', ['Vitality', 'SINNERS']));
assert(trackDecision(low, s, ranks).reasons.some((r) => r.startsWith('vrs:SINNERS')), 'rank 190 is below 160');
const unranked = normalizeEvent(rawEvent('Counter-Strike: Vitality vs Nobody (BO1) - Qualifier', ['Vitality', 'Nobody']));
assert(trackDecision(unranked, s, ranks).track, 'unranked counts by default');
assert(!trackDecision(unranked, sanitizeSettings({ vrsUnranked: false }), ranks).track, 'unranked switch');
const byTour = normalizeEvent(rawEvent('Counter-Strike: Vitality vs Falcons (BO3) - United21 Playoffs', ['Vitality', 'Falcons']));
assert(trackDecision(byTour, s, ranks).reasons.includes('event:United21'), 'tournament keyword');
const excluded = sanitizeSettings({ excludeTeams: ['Nobody'] });
assert(!trackDecision(unranked, excluded, ranks).track, 'exclude wins');

// ---- settings sanitizer ------------------------------------------------------

const bad = sanitizeSettings({ stakePct: 'lots', maxPrice: 5, mode: 'yolo', teams: ['a', 'A', ' b ', ''] });
assert(bad.stakePct === DEFAULT_SETTINGS.stakePct, 'NaN stake falls back');
assert(bad.maxPrice === 0.6, 'price clamped');
assert(bad.mode === 'sim', 'unknown mode ignored');
assert(bad.teams.length === 2 && bad.teams[1] === 'b', 'list cleaned');
assert(sanitizeSettings({}).mode === 'sim', 'starts in sim');

// ---- scoring -----------------------------------------------------------------

const trade = (side, price, size, extra = {}) => ({ side, price, size, timestamp: 1_800_000_000, ...extra });
assert(scoreTrade({ trade: trade('BUY', 0.5, 200), settings: s }).kind === null, 'favourite is not a signal');
assert(scoreTrade({ trade: trade('BUY', 0.2, 100), settings: s }).kind === null, '$20 is under the line');
const plain = scoreTrade({ trade: trade('BUY', 0.25, 400), settings: s });
assert(plain.kind === 'entry' && plain.score >= 10, 'gate: $100 at 25%');
const fresh = scoreTrade({
  trade: trade('BUY', 0.12, 5000),
  settings: s,
  wallet: { joinedAt: 1_800_000_000_000 - 3 * 86400e3, markets: 2, value: 100, cs2Share: 1 },
  ctx: { prevPrice: 0.04, clusterWallets: 2, stackFills: 3, live: true, behind: true }
});
assert(fresh.score > 80, `strong insider pattern scores high (${fresh.score})`);
const keys = new Set(fresh.reasons.map((r) => r.key));
for (const k of ['size', 'longshot', 'fresh', 'impact', 'cluster', 'stacking', 'live-down', 'all-in']) assert(keys.has(k), `reason ${k}`);
const stacked = scoreTrade({ trade: trade('BUY', 0.2, 100), settings: s, ctx: { stackCash: 60 } });
assert(stacked.kind === 'entry', 'split buys add up to the line');
assert(scoreTrade({ trade: trade('SELL', 0.2, 400), settings: s }).kind === 'dump', 'big underdog sale');
assert(scoreTrade({ trade: trade('SELL', 0.6, 100), settings: s, ctx: { hasEntry: true } }).kind === 'exit', 'holder selling is an exit');
const loser = { resolved: 10, wins: 0, avgPrice: 0.2 };
assert(walletEdge(loser) < -0.1, 'zero for ten is a negative edge');
const neg = scoreTrade({ trade: trade('BUY', 0.25, 400), settings: s, wallet: { record: loser } });
assert(neg.reasons.some((r) => r.key === 'record' && r.pts < 0), 'losing record subtracts');

// ---- records and tables ------------------------------------------------------

const rec = walletRecord([
  { cash: 20, price: 0.2, shares: 100, result: 'won', at: 1 },
  { cash: 25, price: 0.25, shares: 100, result: 'lost', at: 2 },
  { cash: 10, price: 0.1, shares: 100, result: 'lost', exitShares: 100, exitCash: 30, at: 3 },
  { cash: 5, price: 0.25, shares: 20, result: null, at: 4 }
]);
assert(rec.bets === 4 && rec.open === 1 && rec.resolved === 3 && rec.wins === 1, 'counts');
assert(near(rec.pnl, 100 + 30 - 55), `pnl counts the early sale (${rec.pnl})`);

const matches = [
  { start: 1, teams: [{ name: 'A', pre: 0.25, min: 0.1, won: true }, { name: 'B', pre: 0.75, min: 0.6, won: false }] },
  { start: 2, teams: [{ name: 'A', pre: 0.6, min: 0.2, won: false }, { name: 'C', pre: 0.4, min: 0.3, won: true }] }
];
const table = teamTable(matches, 0.3);
const a = table.find((r) => r.name === 'A');
assert(a.matches === 2 && a.dips === 2 && a.dipWins === 1 && a.dogs === 1 && a.dogWins === 1, 'team A underdog counts');
const cal = calibration(matches, 'pre');
assert(cal[2].n === 1 && cal[2].wins === 1, '0.2-0.3 bucket');

const totals = betTotals([
  { status: 'won', cost: 10, payout: 40, placedAt: 0, settledAt: 0 },
  { status: 'open', cost: 5, shares: 20, mark: 0.3, exitProceeds: 1, placedAt: 0 },
  { status: 'failed', cost: 99, placedAt: 0 }
]);
assert(totals.count === 2 && near(totals.realized, 30) && near(totals.openMark, 7), 'bet totals skip failures and count partial exits');

// ---- book walking ------------------------------------------------------------

const book = { asks: [{ price: '0.22', size: '100' }, { price: '0.20', size: '50' }, { price: '0.30', size: '1000' }], bids: [{ price: '0.18', size: '100' }, { price: '0.15', size: '100' }] };
const fill = walkAsks(book, 30, 0.25);
assert(near(fill.cost, 30) && near(fill.shares, 50 + 20 / 0.22), 'cheapest asks first, within the cap');
assert(walkAsks(book, 100, 0.21).shares === 50, 'price cap stops the walk');
const sell = walkBids(book, 150, 0.1);
assert(near(sell.proceeds, 18 + 7.5), 'bids best first');
assert(near(takerFee(0.03, 0.2, 100), 0.6), 'fee on the cheaper side');

// ---- engine: a live entry becomes a paper copy within the caps -----------------

const stubs = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  stubs.push(u);
  const ok = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/v2/user-stats')) return ok({ data: { trades: 1, join_date: Math.floor(Date.now() / 1000) - 86400 } });
  if (u.includes('/v2/value')) return ok({ data: { value: 10 } });
  if (u.includes('/v2/trades?user=')) return ok({ data: [] });
  if (u.includes('/book')) return ok({ asks: [{ price: '0.21', size: '10000' }], bids: [{ price: '0.19', size: '10000' }] });
  return ok({ data: [] });
};
const store = await import('./store.js');
const engine = await import('./engine.js');
engine.updateSettings({ simBankroll: 1000, stakePct: 2, maxStake: 100, minScore: 30 });
const botsMod = await import('./bots.js');
// The first look at the bots seeds them from the settings above: eight paper bots.
assert(botsMod.allBots().length === 16 && botsMod.allBots().every((b) => b.mode === 'paper'), 'ten paper bots seeded');
assert(botsMod.botById('split-buys').enabled && botsMod.botById('split-buys').params.minWhalePrice === 0.25 && botsMod.botById('value-dogs').type === 'value' && !botsMod.botById('w-score').enabled, 'edge bots on, losing styles off');
assert(botsMod.botById('w-score').params.minScore === 30 && botsMod.botById('w-score').sizing.value === 2, 'seeded from the old settings');
for (const b of botsMod.allBots()) botsMod.updateBot(b.id, { enabled: b.id === 'w-score' });
const ev = normalizeEvent(rawEvent('Counter-Strike: Vitality vs Nobody (BO3) - United21', ['Vitality', 'Nobody']));
Object.assign(ev, { track: true, reasons: ['event:United21'], live: true, score: '3-9|0-1|Bo3', start: Date.now() - 3600e3 });
ev.markets[0].prices = [0.8, 0.2];
ev.markets[0].accepting = true;
store.col('events')[ev.id] = ev;
const now = Math.floor(Date.now() / 1000);
const big = { proxy_wallet: '0x' + '1'.repeat(40), side: 'BUY', token_id: '222', condition_id: '0xabc', size: 2000, price: 0.2, timestamp: now, outcome: 'Nobody', outcome_index: 1, transaction_hash: '0xt1', name: 'insider' };
const flag = await engine.handleTrade(big, ev, ev.markets[0], 'live');
assert(flag.kind === 'entry', 'flagged');
assert(flag.action === 'copied', `copied (${flag.action}: ${flag.actionReason})`);
const bets = store.col('bets');
assert(bets.length === 1 && bets[0].mode === 'sim' && bets[0].botId === 'w-score', 'one paper bet, owned by the bot');
assert(bets[0].cost <= 20.0001 && bets[0].cost > 19, `2% of 1000 (${bets[0].cost})`);
const again = await engine.handleTrade({ ...big, transaction_hash: '0xt2', proxy_wallet: '0x' + '2'.repeat(40) }, ev, ev.markets[0], 'live');
assert(again.action === 'skip' && /Match stake/.test(again.actionReason), `match cap holds (${again.actionReason})`);
const other = await engine.handleTrade({ ...big, transaction_hash: '0xt3', token_id: '111', outcome: 'Vitality', outcome_index: 0, price: 0.1, proxy_wallet: '0x' + '3'.repeat(40) }, ev, ev.markets[0], 'live');
assert(other.action === 'skip', 'never both sides of one market');
engine.updateSettings({ botsOn: false });
const offFlag = await engine.handleTrade({ ...big, transaction_hash: '0xt4', proxy_wallet: '0x' + '4'.repeat(40) }, ev, ev.markets[0], 'live');
assert(offFlag.action === 'skip' && /off/i.test(offFlag.actionReason), 'off copies nothing');
engine.updateSettings({ botsOn: true });

// Real orders: the report finds its bet (BUY by intentId, SELL by exiting), and a
// "delayed" live-sports fill is confirmed from the wallet's positions (2026-11-07).
{
  const { token } = engine.linkDevice('test-mac');
  const device = engine.deviceForToken(token);
  engine.setArmed(true);
  engine.heartbeat(device, { balance: 21, wallet: '0xwallet' });
  const buy = engine.queueIntent({ type: 'market', side: 'BUY', tokenId: 'TOK1', conditionId: 'C1', amount: 1, maxPrice: 0.22 });
  const rb = { id: 'rb_delay', mode: 'real', botId: 'oracle-v2-2', status: 'pending', tokenId: 'TOK1', conditionId: 'C1', title: 'A vs B', outcome: 'B', amount: 1, intentId: buy.id, placedAt: Date.now() };
  store.col('bets').push(rb);
  engine.pollIntents(device);
  assert(engine.reportIntent(device, { id: buy.id, ok: true, orderId: '0xo', status: 'delayed', spent: 0, shares: 0 }), 'report accepted');
  assert(rb.status === 'pending' && rb.awaitingFill && rb.orderId === '0xo', `a delayed fill waits instead of failing (${rb.status})`);
  const pos = (size, extra = {}) => async () => ({ data: [{ token_id: 'TOK1', current_size: size, total_size: 17.2413, avg_price: 0.0579, total_cost_usdc: 1.047, current_price: 0.0005, realized_pnl: 0, ...extra }] });
  const n = await engine._reconcileRealFills({ fetchPositions: pos(17.2413), force: true });
  assert(n === 1 && rb.status === 'open' && near(rb.shares, 17.2413, 1e-6) && near(rb.cost, 1.047, 1e-6) && near(rb.price, 0.0579, 1e-9), `confirmed from positions (${rb.status} ${rb.shares} ${rb.cost})`);
  // Take profit: a delayed SELL settles from the drop in size and the realized P&L.
  const sell = engine.queueIntent({ type: 'market', side: 'SELL', tokenId: 'TOK1', conditionId: 'C1', shares: rb.shares, minPrice: 0.6 });
  rb.exiting = sell.id;
  engine.pollIntents(device);
  engine.reportIntent(device, { id: sell.id, ok: true, orderId: '0xs', status: 'delayed', spent: 0, shares: 0 });
  assert(rb.exitAwaiting && rb.exiting === sell.id, 'a delayed sale waits for confirmation and stays marked as selling (no second sell)');
  // The position is gone once fully sold: the sale is priced from the wallet's SELL trades.
  const sellAt = Math.floor(Date.now() / 1000);
  await engine._reconcileRealFills({ fetchPositions: async () => ({ data: [] }), fetchTrades: async () => ({ data: [{ side: 'SELL', token_id: 'TOK1', size: 17.2413, price: 0.63, timestamp: sellAt }, { side: 'BUY', token_id: 'TOK1', size: 5, price: 0.1, timestamp: sellAt }] }), force: true });
  assert(!rb.exitAwaiting && !rb.exiting && rb.status === 'sold' && near(rb.payout, 17.2413 * 0.63, 1e-3), `sale priced from the real sell trades (${rb.status} payout ${rb.payout})`);
  // A delayed BUY that never shows up fails after 10 minutes.
  const buy2 = engine.queueIntent({ type: 'market', side: 'BUY', tokenId: 'TOK2', conditionId: 'C2', amount: 1, maxPrice: 0.2 });
  const rb2 = { id: 'rb_never', mode: 'real', botId: 'oracle-v2-2', status: 'pending', tokenId: 'TOK2', intentId: buy2.id, placedAt: Date.now() };
  store.col('bets').push(rb2);
  engine.pollIntents(device);
  engine.reportIntent(device, { id: buy2.id, ok: true, orderId: '0xo2', status: 'delayed', spent: 0, shares: 0 });
  await engine._reconcileRealFills({ fetchPositions: async () => ({ data: [] }), now: Date.now() + 11 * 60e3, force: true });
  assert(rb2.status === 'failed' && /never filled/.test(rb2.error), 'an order that never fills is failed');
  // An outright fill still opens the bet straight from the report.
  const buy3 = engine.queueIntent({ type: 'market', side: 'BUY', tokenId: 'TOK3', conditionId: 'C3', amount: 1, maxPrice: 0.2 });
  const rb3 = { id: 'rb_now', mode: 'real', botId: 'oracle-v2-2', status: 'pending', tokenId: 'TOK3', intentId: buy3.id, placedAt: Date.now() };
  store.col('bets').push(rb3);
  engine.pollIntents(device);
  engine.reportIntent(device, { id: buy3.id, ok: true, orderId: '0xo3', status: 'matched', spent: 1, shares: 10 });
  assert(rb3.status === 'open' && rb3.shares === 10 && near(rb3.price, 0.1), 'an immediate fill opens the bet from the report');
  store.col('bets').splice(0, store.col('bets').length, ...store.col('bets').filter((b) => !['rb_delay', 'rb_never', 'rb_now'].includes(b.id)));
  engine.setArmed(false);
  engine.revokeDevice(device.id);
}
botsMod.updateBot('w-score', { mode: 'real' });
const realFlag = await engine.handleTrade({ ...big, transaction_hash: '0xt5', proxy_wallet: '0x' + '5'.repeat(40) }, { ...ev, id: '2' }, ev.markets[0], 'live');
assert(realFlag.action === 'skip' && /armed/i.test(realFlag.actionReason), 'real mode does nothing until armed');
botsMod.updateBot('w-score', { mode: 'paper' });

// ---- bots: sizing, sanitizing, copies ------------------------------------------------

const fixed = botsMod.sanitizeBot({ type: 'swing', sizing: { kind: 'fixed', value: 25 }, maxStake: 20 });
assert(botsMod.stakeFor(fixed, 1000) === 20, 'fixed stake inside the max');
const pctBot = botsMod.sanitizeBot({ type: 'whale', sizing: { kind: 'pct', value: 3 } });
assert(near(botsMod.stakeFor(pctBot, 500), 15), '3% of 500');
const wild = botsMod.sanitizeBot({ type: 'mm', mode: 'real', params: { spreadK: 99, nonsense: 1, priceMin: 0.9, priceMax: 0.1 } });
assert(wild.mode === 'paper', 'market making stays on paper');
assert(wild.params.spreadK === 6 && !('nonsense' in wild.params), 'params clamped, unknown dropped');
assert(wild.params.priceMin < wild.params.priceMax, 'price band put in order');
const made = botsMod.createBot({ type: 'whale', name: 'Test bot', params: { minScore: 10 } });
assert(made.mode === 'paper' && !made.enabled && made.params.minScore === 10, 'new bots start off, on paper');
const dup = botsMod.duplicateBot(made.id);
assert(dup.id !== made.id && dup.name === 'Test bot copy', 'duplicate');
assert(botsMod.deleteBot(dup.id) && !botsMod.botById(dup.id), 'delete');
botsMod.updateBot(made.id, { enabled: true });
const twoBots = await engine.handleTrade({ ...big, transaction_hash: '0xt6', proxy_wallet: '0x' + '6'.repeat(40) }, { ...ev, id: '3' }, ev.markets[0], 'live');
assert(twoBots.copies.length === 2 && twoBots.copies.every((c) => c.action === 'entered'), `two bots copy the same signal (${JSON.stringify(twoBots.copies)})`);
assert(/2 paper bots/.test(twoBots.actionReason), 'the flag says how many copied');
const own = store.col('bets').filter((b) => b.eventId === '3');
assert(new Set(own.map((b) => b.botId)).size === 2, 'each bot has its own bet');

// Settlement: the paper bet pays out, the whale's record updates.
ev.markets[0].closed = true;
ev.markets[0].prices = [0, 1];
await engine._settleClosed();
assert(bets[0].status === 'won' && near(bets[0].payout, bets[0].shares), 'paper bet settled as a win');
const w = store.col('wallets')['0x' + '1'.repeat(40)];
assert(w.entries[0].result === 'won', 'wallet record settled');

// ---- reaction tables: a market that always gives back half its 5-minute move ----

const reaction = await import('./reaction.js');
const synth = [];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let k = 0; k < 120; k++) {
  const start = 1_800_000_000_000 + k * 86400e3;
  const path = [];
  let p = 0.5;
  for (let t = 0; t < 72; t++) {
    const shock = (rnd() - 0.5) * 0.12;
    const prev = path.length > 1 ? path[path.length - 1][1] - path[path.length - 2][1] : 0;
    p = Math.min(0.95, Math.max(0.05, p + shock - 0.5 * prev));
    path.push([start - 3 * 3600e3 + t * 300e3, p]);
  }
  synth.push({ start, path });
}
const fitted = reaction.fitTables(synth.flatMap((m) => reaction.samplesOf(m)));
const bigRise = reaction.predict(fitted, 'live', 0.5, 0.1)[0];
assert(bigRise.n > 20 && bigRise.mean < 0, `a big rise is followed by a fall in a mean-reverting market (${bigRise.mean})`);
const wf = reaction.walkForward(synth, { cost: 0.01 });
assert(wf.corr > 0.1, `walk-forward finds the reversion on unseen matches (corr ${wf.corr})`);
assert(near(reaction.priceAt([[1, 0.2], [5, 0.4]], 4), 0.2) && reaction.priceAt([[1, 0.2]], 0) === null, 'priceAt');
const eps = reaction.scoreEpisodes([[0, 0.5], [61000, 0.6], [600000, 0.55], [700000, 0.55]], [2000]);
assert(eps.length === 1 && near(eps[0].first, 0.1) && near(eps[0].later, 0.05), 'score episode');
assert(near(reaction.fitScoreReaction([{ first: 0.1, later: 0.05 }, { first: -0.1, later: -0.05 }]).beta, 0.5), 'half of a score jump holds');

// ---- analysts and the combiner ------------------------------------------------------

const analysts = await import('./analysts.js');
reaction.setTables({ reaction: fitted.reaction, volatility: fitted.volatility });
const now2 = 1_900_000_000_000;
const view = analysts.runAnalysts({
  token: 'A', mid: 0.6, bid: 0.59, ask: 0.61, now: now2, live: true, start: now2 - 3600e3,
  mids: [[now2 - 6 * 60e3, 0.5], [now2 - 60e3, 0.6]],
  flags: [{ at: now2 - 60e3, tokenId: 'A', kind: 'entry', cash: 900, score: 90 }],
  depth: { bidUsd: 600, askUsd: 200 }, flow: { buy: 300, sell: 100, n: 5 }, horizon: 30
});
const byKey = Object.fromEntries(view.analysts.map((a) => [a.key, a]));
assert(byKey.reaction.shift < 0, 'reaction analyst fades the 10c jump');
assert(byKey.whale.shift > 0 && byKey.book.shift > 0 && byKey.flow.shift > 0, 'whale, book and flow lean up');
const comb = analysts.combine(0.6, view.analysts, view.vol, 30);
assert(comb.sd > 0 && comb.expected > 0 && comb.expected < 1, 'combined view has an uncertainty');
const ed = analysts.edgeOf({ side: 'BUY', expected: 0.7, ask: 0.6, bid: 0.58, feeRate: 0.03 });
assert(near(ed.edge, 0.1 - 0.03 * 0.4), 'edge pays the taker fee');
assert(near(analysts.edgeOf({ side: 'BUY', expected: 0.7, ask: 0.6, bid: 0.58, feeRate: 0.03, maker: true }).edge, 0.1), 'makers pay no fee');

// ---- risk gate ----------------------------------------------------------------------

const { riskGate } = await import('./risk.js');
const limits = sanitizeSettings({});
const okRisk = riskGate({ cand: { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 20, price: 0.3 }, open: [], bankroll: 1000, todayPnl: 0, limits });
assert(okRisk.ok && okRisk.stake === 20, 'clean book passes');
const capped = riskGate({ cand: { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 30, price: 0.3 }, open: [{ eventId: 'e', conditionId: 'c2', tokenId: 'z', outcome: 'X', cost: 25, status: 'open' }], bankroll: 1000, todayPnl: 0, limits });
assert(capped.stake <= 15 + 1e-9, `match cap trims the stake (${capped.stake})`);
const both = riskGate({ cand: { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 10, price: 0.3 }, open: [{ eventId: 'e', conditionId: 'c', tokenId: 't2', outcome: 'Y', cost: 5, status: 'open', strategy: 'swing' }], bankroll: 1000, todayPnl: 0, limits });
assert(!both.ok && both.checks.some((c) => c.key === 'sides' && !c.ok), 'no both-sides positions');
const lossDay = riskGate({ cand: { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 10, price: 0.3 }, open: [], bankroll: 1000, todayPnl: -200, limits });
assert(!lossDay.ok, 'daily loss stop');
const thin = riskGate({ cand: { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 20, price: 0.3, needsExit: true }, open: [], bankroll: 1000, todayPnl: 0, limits, exitDepth: { bidUsd: 2 } });
assert(!thin.ok && thin.checks.some((c) => c.key === 'exit' && !c.ok), 'no swing entry without bids to exit into');

// Small real wallet: 4% of $21.24 is $0.85, under the $1 minimum. capFloor keeps the size caps at one minimum bet.
const dollar = { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 1, price: 0.11 };
const small = riskGate({ cand: dollar, open: [], bankroll: 21.24, todayPnl: 0, limits });
assert(!small.ok && small.checks.some((c) => c.key === 'match' && !c.ok), 'without a floor a $21 wallet cannot place $1');
const floored = riskGate({ cand: dollar, open: [], bankroll: 21.24, todayPnl: 0, limits: { ...limits, capFloor: 1 } });
assert(floored.ok && floored.stake === 1, `with the floor a $21 wallet places $1 (${floored.stake})`);
const secondLeg = riskGate({ cand: dollar, open: [{ eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', cost: 1, status: 'open' }], bankroll: 21.24, todayPnl: 0, limits: { ...limits, capFloor: 1 } });
assert(!secondLeg.ok && secondLeg.checks.some((c) => c.key === 'match' && !c.ok), 'the floor is one bet per match, not more');
const tiny = riskGate({ cand: dollar, open: [], bankroll: 9, todayPnl: 0, limits: { ...limits, capFloor: 1 } });
assert(!tiny.ok, 'no floor once a minimum bet is over 10% of the wallet');
const smallLossDay = riskGate({ cand: dollar, open: [], bankroll: 21.24, todayPnl: -2.2, limits: { ...limits, capFloor: 1 } });
assert(!smallLossDay.ok && smallLossDay.checks.some((c) => c.key === 'daily' && !c.ok), 'the daily loss stop is not floored');
const bigFloored = riskGate({ cand: { eventId: 'e', conditionId: 'c', tokenId: 't1', outcome: 'X', side: 'BUY', stake: 30, price: 0.3 }, open: [{ eventId: 'e', conditionId: 'c2', tokenId: 'z', outcome: 'X', cost: 25, status: 'open' }], bankroll: 1000, todayPnl: 0, limits: { ...limits, capFloor: 1 } });
assert(bigFloored.stake === capped.stake && bigFloored.ok === capped.ok, 'the floor changes nothing for a big wallet');

// ---- learning pieces ----------------------------------------------------------------

const learn = await import('./learn.js');
const X = [];
const Y = [];
for (let i = 0; i < 400; i++) {
  const a = rnd() - 0.5;
  const b = rnd() - 0.5;
  X.push([a, b]);
  Y.push(2 * a - b + (rnd() - 0.5) * 0.01);
}
const w2 = learn.ridge(X, Y, 0.001);
assert(near(w2[0], 2, 0.05) && near(w2[1], -1, 0.05), `ridge recovers the weights (${w2})`);
const goodR = Array.from({ length: 60 }, () => 0.1 + (rnd() - 0.5) * 0.1);
const badR = Array.from({ length: 60 }, () => -0.05 + (rnd() - 0.5) * 0.1);
assert(learn.probBetter(goodR, badR, 1000, rnd) > 0.95, 'bootstrap sees the better variant');
assert(near(learn.probBetter(goodR, goodR, 1000, rnd), 0.5, 0.1), 'and no difference against itself');
const losingBot = botsMod.createBot({ type: 'whale', name: 'Losing real bot' });
botsMod.updateBot(losingBot.id, { mode: 'real', autoStop: true });
for (let i = 0; i < 36; i++) store.col('bets').push({ id: 'lb' + i, botId: losingBot.id, mode: 'real', status: i % 6 ? 'lost' : 'won', cost: 10, payout: i % 6 ? 0 : 25, settledAt: Date.now() - (36 - i) * 1000, placedAt: Date.now() - 1e6 });
const report = learn.botReport(rnd);
assert(report.bots.length >= 9, 'report covers every bot');
assert(report.stopped.some((x) => x.id === losingBot.id) && botsMod.botById(losingBot.id).mode === 'paper', 'a losing real bot goes back to paper');

// ---- tick replay and the backtester -------------------------------------------------

const backtest = await import('./backtest.js');
const lines = [
  { t: 0, k: 'b', a: 'T', b: [[0.4, 100]], s: [[0.42, 100]] },
  { t: 6000, k: 'p', a: 'T', p: 0.42, z: 0, d: 's' },
  { t: 6000, k: 'p', a: 'T', p: 0.45, z: 50, d: 's' },
  { t: 12000, k: 'x', a: 'T', p: 0.45, z: 10, d: 'b' }
];
const rm = backtest.replayMids(lines, 'T', 5000);
assert(rm.length === 3 && near(rm[0][1], 0.41) && near(rm[1][1], 0.425) && rm[2][0] === 12000, `mid path from book deltas (${JSON.stringify(rm)})`);
const hb = backtest.historyBacktest(synth, botsMod.botById('s-taker5').params, { spread: 0.01 });
assert(hb.testMatches > 0 && hb.trades >= 0, 'history backtest runs walk-forward');

// ---- paper limit orders fill only when the tape trades through ------------------------

const feeds = await import('./feeds.js');
const brain = await import('./brain.js');
const db = await import('./db.js');
feeds._ingestMarket({ event_type: 'book', asset_id: 'Z', market: '0xz', bids: [{ price: '0.30', size: '100' }], asks: [{ price: '0.34', size: '100' }], timestamp: String(Date.now()) });
assert(feeds.books.get('Z').bestBid === 0.3 && feeds.books.get('Z').bestAsk === 0.34, 'book from the socket');
feeds._ingestMarket({ event_type: 'price_change', market: '0xz', price_changes: [{ asset_id: 'Z', price: '0.31', size: '40', side: 'BUY' }], timestamp: String(Date.now()) });
assert(feeds.books.get('Z').bestBid === 0.31, 'level delta moves the best bid');
const dec = { id: 'd_test', mode: 'sim', strategy: 'swing', variant: 's-maker3', eventId: ev.id, conditionId: '0xz', token: 'Z', outcome: 'Nobody', title: 'T', market: 'Match', trigger: {}, plan: { target: 0.4, stop: 0.2, timeStop: Date.now() + 1e6 } };
brain._state.paperOrders.set('o1', { id: 'o1', kind: 'entry', decisionId: 'd_test', token: 'Z', side: 'BUY', price: 0.31, usd: 6.2, filledShares: 0, cost: 0, expiresAt: Date.now() + 60e3, decision: dec, outcomeIndex: 1 });
feeds._ingestMarket({ event_type: 'last_trade_price', asset_id: 'Z', market: '0xz', price: '0.32', size: '50', side: 'SELL', timestamp: String(Date.now()) });
assert(!store.col('bets').some((b) => b.decisionId === 'd_test'), 'a print above our bid does not fill it');
feeds._ingestMarket({ event_type: 'last_trade_price', asset_id: 'Z', market: '0xz', price: '0.30', size: '50', side: 'SELL', timestamp: String(Date.now()) });
const lim = store.col('bets').find((b) => b.decisionId === 'd_test');
assert(lim && near(lim.shares, 20) && near(lim.cost, 6.2), 'a print through our bid fills it at our price');

// Marks: a stray last print never leaves the book (2026-11-07: 0.999 with no bids, ask 0.001).
feeds.books.set('MK1', { bestBid: null, bestAsk: 0.001, last: { p: 0.999 } });
assert(near(feeds.midOf('MK1'), 0.001), `no bids: the mark is capped at the ask (${feeds.midOf('MK1')})`);
feeds.books.set('MK2', { bestBid: 0.4, bestAsk: 0.42, last: { p: 0.9 } });
assert(near(feeds.midOf('MK2'), 0.41), 'a tight book still marks at the mid');
feeds.books.set('MK3', { bestBid: 0.2, bestAsk: 0.6, last: { p: 0.35 } });
assert(near(feeds.midOf('MK3'), 0.35), 'a wide book still uses a last print inside it');
feeds.books.set('MK4', { bestBid: 0.2, bestAsk: 0.6, last: { p: 0.95 } });
assert(near(feeds.midOf('MK4'), 0.6), 'a wide book clamps a print outside it');
feeds.books.set('MK5', { bestBid: 0.3, bestAsk: null, last: null });
assert(near(feeds.midOf('MK5'), 0.3), 'only a bid: mark at the bid');
for (const k of ['MK1', 'MK2', 'MK3', 'MK4', 'MK5']) feeds.books.delete(k);
assert(!brain._state.paperOrders.has('o1'), 'filled order is gone');

// ---- decision records ------------------------------------------------------------------

db.saveDecision({ id: 'd_x', at: Date.now() - 31 * 60e3, strategy: 'swing', variant: 's-taker5', mode: 'shadow', eventId: 'e', conditionId: '0xc', token: 'T', outcome: 'X', side: 'BUY', price: 0.4, pMarket: 0.4, pFinal: 0.46, edge: 0.05, stake: 10, action: 'entered', reason: 'r', analysts: [{ key: 'reaction', shift: 0.05, conf: 0.5 }] });
assert(db.pendingFollowups(Date.now()).some((d) => d.id === 'd_x'), 'decision waits for its follow-ups');
db.updateDecision('d_x', { m5: 0.42, m30: 0.45 });
const back = db.getDecision('d_x');
assert(back.m30 === 0.45 && back.analysts[0].key === 'reaction', 'decision round-trips with its analysts');
brain.onSettle('0xc', ['T', 'U'], 0);
assert(db.getDecision('d_x').result === 1 && near(db.getDecision('d_x').pnl, 1 / 0.4 - 1), 'settlement writes the result');

// ---- per-bot report ------------------------------------------------------------------

const rep = await import('./botReport.js');
assert(rep.reasonKey('At 45%, not down to 20%') === rep.reasonKey('At 38%, not down to 20%'), 'reason keys ignore the numbers');
assert(rep.reasonKey('Risk: match, team, open') === 'Risk: match, team, open', 'risk reasons keep their checks');
assert(rep.skipCategory('Risk: match, team, open') === 'risk' && rep.skipCategory('Real trading not armed') === 'blocked' && rep.skipCategory('Started at 40%, under 50%') === 'rules', 'skip categories');
const day0 = new Date().toISOString().slice(0, 10);
db.tallyFunnel({ day: day0, variant: 'rb', reason: '__considered', category: 'considered', at: Date.now(), sample: 'A vs B' });
db.tallyFunnel({ day: day0, variant: 'rb', reason: '__considered', category: 'considered', at: Date.now(), sample: 'C vs D' });
db.tallyFunnel({ day: day0, variant: 'rb', reason: 'Risk: match, team, open', category: 'risk', at: Date.now(), sample: 'Risk: match, team, open' });
assert(db.funnelRows('rb').find((r) => r.reason === '__considered').n === 2, 'funnel counts upsert');
const now0 = Date.now();
db.saveDecision({ id: 'rb1', at: now0 - 3600e3, strategy: 'comeback', variant: 'rb', mode: 'real', eventId: 'ev1', conditionId: 'rc1', token: 'R1', outcome: 'A', side: 'BUY', price: 0.2, stake: 0, action: 'skipped', reason: 'Risk: match, team, open', title: 'A vs B', market: 'Match' });
db.saveDecision({ id: 'rb2', at: now0 - 1800e3, strategy: 'comeback', variant: 'rb', mode: 'real', eventId: 'ev2', conditionId: 'rc2', token: 'R2', outcome: 'C', side: 'BUY', price: 0.25, stake: 1, action: 'queued', reason: 'Real market order', title: 'C vs D', market: 'Match' });
db.updateDecision('rb1', { result: 1, pnl: 4 });
db.updateDecision('rb2', { result: 0, pnl: -1 });
const rows = db.decisionRows('rb', 0);
assert(rows.length === 2 && rows[0].title === 'A vs B' && rows[0].at < rows[1].at, 'decision rows carry the title, oldest first');
const rbBot = { id: 'rb', name: 'Report bot', type: 'comeback', mode: 'real', enabled: true, sizing: { kind: 'auto' }, minStake: 1, maxStake: 25, paperBankroll: 500 };
const rbBets = [
  { id: 'x1', botId: 'rb', mode: 'real', status: 'won', cost: 1, payout: 4, price: 0.25, placedAt: now0 - 5 * 3600e3, settledAt: now0 - 4 * 3600e3, title: 'E vs F', outcome: 'E', eventId: 'e1', live: true },
  { id: 'x2', botId: 'rb', mode: 'real', status: 'lost', cost: 1, payout: 0, price: 0.15, placedAt: now0 - 3 * 3600e3, settledAt: now0 - 2 * 3600e3, title: 'G vs H', outcome: 'G', eventId: 'e2', live: true },
  { id: 'x3', botId: 'rb', mode: 'real', status: 'open', cost: 1, shares: 5, mark: 0.3, price: 0.2, placedAt: now0 - 600e3 },
  { id: 'x4', botId: 'rb', mode: 'sim', status: 'won', cost: 10, payout: 30, price: 0.3, placedAt: now0 - 3600e3, settledAt: now0 - 60e3 }
];
const r1 = rep.botReport({ bot: rbBot, bets: rbBets, decisions: rows, funnel: db.funnelRows('rb'), wallet: { equity: 21.5 }, now: now0, days: 7 });
assert(r1.mode === 'real' && r1.kpis.equity === 21.5, 'real mode uses the real wallet');
assert(r1.curve.length === 2 && r1.curve[1].v === 2 && r1.kpis.realized === 2 && r1.kpis.won === 1 && r1.kpis.lost === 1, `real curve and record (${JSON.stringify(r1.kpis)})`);
assert(r1.kpis.open === 1 && r1.kpis.streak === -1 && r1.kpis.maxDrawdown === 1, 'open bets, streak and drawdown');
assert(r1.funnel.considered === 2 && r1.funnel.byCategory.risk === 1 && r1.funnel.taken === 1, 'funnel counts');
const riskRow = r1.reasons.find((x) => x.key === 'Risk: match, team, open');
assert(riskRow && riskRow.n === 1 && riskRow.recorded === 1 && riskRow.avgPnl === 4, 'a skip reason shows what $1 would have made');
assert(r1.perDollar.skipped.length === 1 && r1.perDollar.taken[0].v === -1, 'per-dollar lines for taken and skipped');
assert(r1.breakdowns.price.find((g) => g.label === '20-30%').pnl === 3, 'price-band breakdown');
assert(r1.daily.length >= 7 && r1.daily.some((d) => d.taken === 1), 'every day of the window is on the axis');
const r2 = rep.botReport({ bot: rbBot, bets: rbBets, decisions: rows, funnel: [], now: now0, days: 7, mode: 'sim' });
assert(r2.curve.length === 1 && r2.kpis.equity === 520, 'paper mode reads the paper wallet');

// ---- lower-tier football ----------------------------------------------------------------

{
  const fbm = await import('./football.js');
  const mk = (title, group, yes, price, extra = {}) => ({ sportsMarketType: 'moneyline', groupItemTitle: group, question: title, outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(price), String(1 - price)]), clobTokenIds: JSON.stringify([yes, `${yes}n`]), conditionId: `c_${yes}`, bestBid: price - 0.01, bestAsk: price + 0.01, volume: '300', feeSchedule: { rate: 0.05 }, ...extra });
  const start = Date.now() + 2 * 3600e3;
  const raw = { id: 'fe1', title: 'FS Jelgava vs. Ogre United', startTime: new Date(start).toISOString(), teams: [{ name: 'FS Jelgava' }, { name: 'Ogre United' }], markets: [mk('Will FS Jelgava win on 2026-11-08?', 'FS Jelgava', 'TA', 0.53), mk('Will FS Jelgava vs. Ogre United end in a draw?', 'Draw (FS Jelgava vs. Ogre United)', 'TD', 0.24), mk('Will Ogre United win on 2026-11-08?', 'Ogre United', 'TB', 0.23), { sportsMarketType: 'totals' }] };
  const ev = fbm.normalizeFootball(raw, 'Latvia');
  assert(ev && ev.markets.length === 3 && ev.markets.map((m) => m.kind).sort().join() === 'A,B,draw' && ev.markets.find((m) => m.kind === 'B').label === 'Ogre United', 'football: three markets, A / draw / B');
  assert(fbm.normalizeFootball({ ...raw, markets: raw.markets.slice(0, 2) }, 'Latvia') === null, 'football: a side market is not a match');
  // Scoring: a big buy into a thin market from a fresh wallet is loud; a small one into a deep market is not.
  const loud = fbm.scoreBuy({ cash: 800, priorVolume: 400, price: 0.23, wallet: { joinedAt: Date.now() - 2 * 86400e3, trades: 3 }, start, at: Date.now() });
  const quiet = fbm.scoreBuy({ cash: 120, priorVolume: 50000, price: 0.5, wallet: { joinedAt: Date.now() - 900 * 86400e3, trades: 4000 }, start: start + 20 * 3600e3, at: Date.now() });
  assert(loud.score >= 80 && quiet.score < 20, `football scoring (${loud.score} vs ${quiet.score})`);
  // A wallet stacking buys on Ogre United is flagged once, as one stack.
  fbm.setFootballSettings({ copy: false, minScore: 55, minCash: 100 });
  const fs0 = fbm.fb();
  fs0.events[ev.id] = ev;
  fs0.wallets['0xfresh'] = { at: Date.now(), joinedAt: Date.now() - 3 * 86400e3, trades: 2 };
  const seen = [];
  fbm.onFootball((e) => seen.push(e));
  const m = ev.markets.find((x) => x.kind === 'B');
  const now = Math.floor(Date.now() / 1000);
  for (const [i, size] of [[1, 1000], [2, 1500]]) await fbm._handleTrade({ transaction_hash: `0xh${i}`, proxy_wallet: '0xFRESH', token_id: 'TB', side: 'BUY', price: 0.23, size, timestamp: now + i, condition_id: m.conditionId, name: 'newguy' }, ev, m, fbm.fbSettings());
  const flags = fs0.flags.filter((f) => f.eventId === ev.id);
  assert(flags.length === 1 && flags[0].fills === 2 && near(flags[0].cash, 575, 1e-6) && flags[0].kind === 'B', `stacked buys are one flag (${flags.length}, ${flags[0]?.cash})`);
  assert(seen.some((e) => e.type === 'flag' && e.flag.kind === 'B'), 'a suspicious stack is announced');
  const sus = fbm.footballSuspicious();
  assert(sus[0]?.label === 'Ogre United' && sus[0].score >= 55, 'suspicious list names the backed team');
  // Paper copy settles on the result.
  store.col('bets').push({ id: 'fb_t', mode: 'sim', botId: 'football-sus', status: 'open', eventId: ev.id, kind: 'B', shares: 80, cost: 20.5, outcome: 'Ogre United' });
  fbm._settle(ev, 'B');
  const pb = store.col('bets').find((b) => b.id === 'fb_t');
  assert(pb.status === 'won' && pb.payout === 80 && flags[0].result === 'won' && fbm.footballPaper().realized > 59, 'paper copy settles and the flag records the result');
  store.col('bets').splice(store.col('bets').indexOf(pb), 1);
}

// ---- dated backtest runs ---------------------------------------------------------------

// A small synthetic history pack: low-tier CS2 BO3s where the favourite collapses to 15%.
fs.mkdirSync(path.join(tmp, 'packs'), { recursive: true });
const packLines = [];
const nowS0 = Math.floor(Date.now() / 1000);
for (let i = 0; i < 240; i++) {
  const s = nowS0 - (120 - i * 0.5) * 86400;
  const win = i % 5 < 2;
  const p = [0, 620, 300, 600, 600, 560, 700, 300, 760, 150, 820, 150, 880, 150, 1500, win ? 700 : 100, 3000, win ? 990 : 10];
  packLines.push(JSON.stringify({ g: 'cs2', id: `m${i}`, cid: `c${i}`, s, f: 'BO3', low: true, n: [`Fav ${i}`, `Dog ${i}`], w: win ? 0 : 1, pre: 0.62, e: s + 3600, p }));
}
fs.writeFileSync(path.join(tmp, 'packs', 'comeback-recent.ndjson'), packLines.join('\n') + '\n');
const bt = await import('./botbacktest.js');
const cbBot = { id: 'cb', name: 'Comeback test', type: 'comeback', sizing: { kind: 'auto' }, minStake: 1, maxStake: 25, maxOpenPct: 25, dailyLossPct: 10, params: { games: ['cs2'], preMin: 0.5, collapseAt: 0.2, maxSlippage: 0.02, maxMinutes: 90, formats: ['BO3'], lowTierOnly: true, minDrop: 0.2, sellAt: 0 } };
const dayMs = 86400e3;
const tRuns = bt.botBacktestRuns(cbBot, { starts: [Date.now() - 60 * dayMs, Date.now() - 200 * dayMs, Date.now() - 100 * dayMs], start: 21 });
assert(tRuns.runs.length === 3 && tRuns.runs[0].from < tRuns.runs[1].from, 'runs come back oldest start first');
assert(tRuns.runs[0].beforeData && !tRuns.runs[1].beforeData, 'a start before the history is flagged');
const r100 = tRuns.runs[1];
assert(r100.placed > 50 && r100.curve.length === r100.placed, `every placed bet settles into the curve (${r100.placed})`);
assert(r100.curve.every((c, i) => i === 0 || c.t >= r100.curve[i - 1].t) && r100.curve[0].t >= r100.from, 'curve is in time order, after the start');
assert(near(r100.curve[0].v - r100.curve[0].d, 21, 1e-6) && near(r100.curve[r100.curve.length - 1].v, r100.end, 0.01), 'curve starts at the wallet and ends at the result');
assert(tRuns.runs[2].placed < r100.placed && r100.months.length >= 3, 'a later start sees fewer bets; months are listed');
assert(r100.curve.slice(0, 10).every((c) => c.stake === 1), 'the first 10 fills use the halved stake, floored at $1');
const dear = bt.botBacktestRuns(cbBot, { starts: [Date.now() - 100 * dayMs], start: 500, extraSlip: 0.02 }).runs[0];
assert(dear.placed === 10 && dear.stopped && /over the mid/.test(dear.stopped.reason), `fills over 2.5c stop the bot after 10 (${dear.placed}, ${dear.stopped?.reason})`);

// V3: busy markets are skipped; a leader bot buys the other side of crashes the crash bots skip.
{
  const all = bt._comebackBets(cbBot.params, 0, 0);
  const quiet = bt._comebackBets({ ...cbBot.params, maxTradesPerMin: 0.1 }, 0, 0); // every synthetic crash has ~0.3 trades a minute
  assert(all.length > 50 && quiet.length === 0, `busy-market skip (${all.length} -> ${quiet.length})`);
  const leaderP = { ...cbBot.params, bet: 'leader', busyAt: 4, minDrop: 0, formats: [], lowTierOnly: false, sellAt: 0 };
  assert(bt._comebackBets(leaderP, 0, 0).length === 0, 'leader leaves low-tier BO3 sudden crashes to the crash bots');
  // The same crashes in BO1: the comeback is overpriced there, so the leader buys the other team.
  const bo1 = packLines.slice(0, 40).map((l) => JSON.stringify({ ...JSON.parse(l), cid: `${JSON.parse(l).cid}b`, f: 'BO1' }));
  fs.appendFileSync(path.join(tmp, 'packs', 'comeback-recent.ndjson'), bo1.join('\n') + '\n');
  const lead = bt._comebackBets(leaderP, 0, 0).filter((b) => /leader/.test(b.team));
  const crashedWon = bo1.filter((l) => JSON.parse(l).w === 0).length;
  assert(lead.length === 40 && lead.filter((b) => b.won).length === 40 - crashedWon && lead.every((b) => b.q > 0.8), `leader bets on BO1 crashes (${lead.length}, won ${lead.filter((b) => b.won).length})`);
}
db.closeDb();

store.flush();
assert(fs.existsSync(path.join(tmp, 'bets.json')), 'state written');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('insights: ok');
process.exit(0);
