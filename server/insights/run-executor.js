// ---------------------------------------------------------------------------
// server/insights/run-executor.js
// The Insights executor on its own, for an always-on machine in the owner's
// own country (a small server in Norway): no site, no app window.
//
//   node server/insights/run-executor.js
//
// It reads the same config file the desktop app writes
// (~/.aim4/insights-executor.json, or AIM4_INSIGHTS_EXECUTOR_FILE): the device
// token, the wallet address, the signer key and the optional Relayer key.
// Copy that file from the PC (Settings > This PC) to the server, then press
// Forget on the PC so only one executor uses it. Orders and claims go to
// https://aim4.io unless AIM4_UPSTREAM says otherwise.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { executorFile, executorStatus, startExecutor } from './executor.js';

if (!process.env.AIM4_UPSTREAM) process.env.AIM4_UPSTREAM = 'https://aim4.io';

const file = executorFile();
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  console.error(`No executor config at ${file}. Copy insights-executor.json from the PC first.`);
  process.exit(1);
}
for (const k of ['token', 'wallet', 'privateKey']) {
  if (!cfg[k]) {
    console.error(`Config is missing "${k}". Link the PC and save the wallet and key in Settings > This PC, then copy the file again.`);
    process.exit(1);
  }
}

startExecutor();
// The server it really polls is cfg.base (or the local default); AIM4_UPSTREAM is only the site fallback.
executorStatus().then((s) => console.log(`Insights executor running for ${cfg.wallet.slice(0, 6)}..${cfg.wallet.slice(-4)}, talking to ${s.base} · relayer key ${s.relayer ? 'set (winnings claimed automatically)' : 'not set'}`));

// A status line every 5 minutes, for the service log.
setInterval(async () => {
  const s = await executorStatus();
  console.log(
    `${new Date().toISOString()} poll ${s.lastOk ? Math.round((Date.now() - s.lastOk) / 1000) + 's ago' : 'never'}` +
      ` | balance ${s.balance ?? '-'} | ${s.geo ? `${s.geo.country} ${s.geo.blocked ? 'BLOCKED' : 'allowed'}` : 'location -'}` +
      ` | placed ${s.placed} failed ${s.failed} | claimed $${(s.claims?.total || 0).toFixed(2)}${s.claims?.pending > 0.049 ? ` (waiting $${s.claims.pending.toFixed(2)})` : ''}` +
      `${s.claims?.lastError ? ` | claim error: ${s.claims.lastError}` : ''}` +
      `${s.lastError ? ` | error: ${s.lastError}` : ''}`
  );
}, 5 * 60e3);
