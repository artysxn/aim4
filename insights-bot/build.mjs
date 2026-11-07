// Bundles server/insights/run-executor.js into bot.mjs for the standalone bot.
// Run from the repo root: node insights-bot/build.mjs
import { build } from 'esbuild';
const skip = { name: 'skip-site', setup(b) {
  // Owner checks for the desktop app's local routes; never called standalone.
  b.onResolve({ filter: /(local\/mode|replays\/identity|\.\/routes)\.js$/ }, (a) => ({ path: a.path, external: true }));
} };
await build({
  entryPoints: ['server/insights/run-executor.js'], outfile: 'insights-bot/bot.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', external: ['@polymarket/client', '@polymarket/client/*', 'viem', 'viem/*'],
  plugins: [skip], banner: { js: '// Built by insights-bot/build.mjs from server/insights. Do not edit by hand.' }, logLevel: 'warning'
});
console.log('insights-bot/bot.mjs built');
