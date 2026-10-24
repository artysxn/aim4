// ---------------------------------------------------------------------------
// scripts/cs3d-bench.mjs — frame rate of a map, uncapped, in headless Edge.
//
//   node scripts/cs3d-bench.mjs [map...] [--base http://127.0.0.1:3784]
//        [--secs 5] [--spin] [--cmd "r_bundles 0;r_bloom 0"] [--params "msaa=1"]
//
// Opens /<map>?bench=1 (which hands the page's renderer to the script), waits
// for the map, then times requestAnimationFrame with vsync and the frame-rate
// limit off, so the number is what the frame costs, not the panel's refresh.
// `--spin` turns the camera every frame, the way aiming does; `--cmd` runs
// Y-console commands first, for A/B runs. Edge because it is what aim4.exe's
// WebView2 runs.
//
// Headless numbers move with whatever else the machine is doing; compare runs
// made back to back, and prefer several short ones to one long one.
// ---------------------------------------------------------------------------

import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const valued = new Set(['--base', '--secs', '--cmd', '--params']);
const maps = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const BASE = opt('--base', 'http://127.0.0.1:3784');
const SECS = Number(opt('--secs', '5'));
const SPIN = args.includes('--spin');
const CMDS = String(opt('--cmd', '') || '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
const PARAMS = opt('--params', '');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const browser = await chromium.launch({
  executablePath: EDGE.find((p) => {
    try {
      return !!process.getBuiltinModule('node:fs').statSync(p);
    } catch {
      return false;
    }
  }),
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--window-size=1920,1080']
});

for (const map of maps.length ? maps : ['dust2']) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));
  await page.goto(`${BASE}/${map}?bench=1&r_profile=1${PARAMS ? `&${PARAMS}` : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cs3d?.pack?.world && window.__cs3d.viewModel?.ready, null, { timeout: 180000, polling: 250 });
  await page.waitForTimeout(6000);
  for (const c of ['fps_max 0', ...CMDS]) {
    const [cmd, ...a] = c.split(/\s+/);
    await page.evaluate(([cmd, a]) => window.__cs3d.perf.command(cmd, a), [cmd, a]);
  }
  if (SPIN) {
    await page.evaluate(() => {
      const p = window.__cs3d.player;
      const turn = () => {
        p.yaw += 0.03;
        p.pitch = Math.sin(performance.now() / 700) * 0.3;
        requestAnimationFrame(turn);
      };
      requestAnimationFrame(turn);
    });
  }
  await page.waitForTimeout(1500);
  const r = await page.evaluate(
    (secs) =>
      new Promise((resolve) => {
        const t = [];
        let last = performance.now();
        const t0 = last;
        const step = (now) => {
          t.push(now - last);
          last = now;
          if (now - t0 < secs * 1000) requestAnimationFrame(step);
          else {
            t.shift();
            const s = t.slice().sort((a, b) => a - b);
            const avg = s.reduce((a, b) => a + b, 0) / s.length;
            const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
            resolve({ fps: Math.round(1000 / avg), avg, p50: at(0.5), p90: at(0.9), p99: at(0.99) });
          }
        };
        requestAnimationFrame(step);
      }),
    SECS
  );
  const passes = await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find((e) => /^sky [\d.]+ {2}world/m.test(e.textContent || '') && e.children.length === 0);
    return el ? (el.textContent.match(/sky [^\n]*/) || [''])[0] : '';
  });
  const ms = (x) => x.toFixed(2);
  console.log(
    `${map.padEnd(8)} ${String(r.fps).padStart(4)} fps  avg ${ms(r.avg)}  p50 ${ms(r.p50)}  p90 ${ms(r.p90)}  p99 ${ms(r.p99)} ms` +
      `${passes ? `  | ${passes}` : ''}${CMDS.length ? `  [${CMDS.join('; ')}]` : ''}`
  );
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}
await browser.close();
