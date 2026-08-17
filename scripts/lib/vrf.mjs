// ---------------------------------------------------------------------------
// scripts/lib/vrf.mjs
// Shared plumbing for the CS3D extraction scripts: where the Source2Viewer CLI
// is, where the CS2 install is, and how to run the CLI without drowning in its
// shader-version chatter. Lifted from scripts/cs3d-import.mjs so the model and
// animation importer (scripts/cs3d-models.mjs) does not grow a second copy.
//
// Everything here is Windows workstation work: the CLI is a Windows binary and
// the install is the operator's own (CS3D-PLAN §0, local-only forever).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_VRF = path.join(ROOT, 'tools', 'vrf', 'Source2Viewer-CLI.exe');

export function fail(tag, msg) {
  console.error(`${tag}: ${msg}`);
  process.exit(1);
}

/** Refuse to write anywhere but the gitignored data dir (CS3D-PLAN §0). */
export function assertLocalOutput(tag, dir) {
  const rel = path.relative(path.join(ROOT, 'server', 'data'), dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(tag, `refusing output outside server/data: ${dir}`);
}

export function findVrf(tag) {
  const cand = process.env.CS3D_VRF || DEFAULT_VRF;
  if (!fs.existsSync(cand)) {
    fail(
      tag,
      `VRF CLI not found at ${cand}. Download cli-windows-x64.zip from ` +
        'https://github.com/ValveResourceFormat/ValveResourceFormat/releases and unzip into tools/vrf/.'
    );
  }
  return cand;
}

/** The CS2 game/csgo folder: an explicit path, CS2_GAME_DIR, else scan Steam libraries. */
export function findGameDir(tag, explicit) {
  const wanted = explicit || process.env.CS2_GAME_DIR;
  if (wanted) {
    if (!fs.existsSync(path.join(wanted, 'pak01_dir.vpk'))) fail(tag, `no pak01_dir.vpk under ${wanted}`);
    return wanted;
  }
  const libs = new Set();
  for (const steam of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(process.env.ProgramFiles || '', 'Steam')
  ]) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(steam);
    const txt = fs.readFileSync(vdf, 'utf8');
    for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  for (const lib of libs) {
    const g = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
    if (fs.existsSync(path.join(g, 'pak01_dir.vpk'))) return g;
  }
  fail(tag, 'CS2 install not found. Pass --game "<...>\\Counter-Strike Global Offensive\\game\\csgo".');
}

/**
 * Run the CLI, streaming a filtered log (VRF is chatty; shader-version noise
 * is dropped). With `capture` the full stdout is returned instead of logged,
 * for the block dumps (-b DATA / -a) that print KV3 to the console.
 */
export function runVrf(vrf, cliArgs, label, { capture = false, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(vrf, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let written = 0;
    let lastErr = '';
    const captured = [];
    const onLine = (line) => {
      if (capture) captured.push(line);
      if (!line) return;
      if (/^--- (Writing model|Dump written)/.test(line)) written++;
      // The CS2 shader format moved past what this VRF build parses; textures
      // still resolve through its fallbacks, so this is noise, not a failure.
      if (/VCS file versions|UnexpectedMagicException|^\s+at Valve|Failed to get texture inputs/.test(line)) return;
      if (/^(Failed|Unhandled|Exception)/.test(line)) lastErr = line;
    };
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      onLine(buf);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (code !== 0) return reject(new Error(`${label}: VRF exited ${code} ${lastErr}`));
      if (!capture && !quiet) console.log(`  ${label}: ${written} file(s) written in ${secs}s`);
      resolve(captured.join('\n'));
    });
  });
}
