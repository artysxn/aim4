// Writes ~/.aim4/insights-executor.json, the bot's config.
//   npm run setup -- /path/to/insights-executor.json   copy the PC's file
//   npm run setup                                       type the values in
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const file = process.env.AIM4_INSIGHTS_EXECUTOR_FILE || path.join(os.homedir(), '.aim4', 'insights-executor.json');
const hex = (n) => new RegExp(`^0x[0-9a-fA-F]{${n}}$`);
const save = (cfg) => {
  for (const k of ['token', 'wallet', 'privateKey']) if (!cfg[k]) throw new Error(`Missing ${k}.`);
  if (!hex(40).test(cfg.wallet)) throw new Error('Wallet should be 0x followed by 40 hex characters.');
  if (!hex(64).test(cfg.privateKey)) throw new Error('Signer key should be 0x followed by 64 hex characters.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(`Saved ${file} (readable by you only). Start with: npm start`);
};

try {
  const src = process.argv[2];
  if (src) {
    save(JSON.parse(fs.readFileSync(src, 'utf8')));
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q) => (await rl.question(q)).trim();
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const cfg = { ...old };
    cfg.token = (await ask(`Device token (the "token" value in the PC's insights-executor.json)${old.token ? ' [keep]' : ''}: `)) || old.token;
    cfg.wallet = (await ask(`Polymarket wallet address${old.wallet ? ` [${old.wallet}]` : ''}: `)) || old.wallet;
    let k = (await ask(`Signer private key${old.privateKey ? ' [keep]' : ''}: `)) || old.privateKey || '';
    if (k && !k.startsWith('0x')) k = '0x' + k;
    cfg.privateKey = k;
    const rk = await ask('Relayer API key (optional, Enter to skip): ');
    if (rk) {
      cfg.relayerKey = rk;
      cfg.relayerAddress = await ask('Relayer key address: ');
    }
    cfg.name = cfg.name || 'mac';
    rl.close();
    console.clear();
    save(cfg);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
