#!/usr/bin/env node
// ---------------------------------------------------------------------------
// parse-demo-local.js
// Parse one or more CS2 .dem files on this machine and write .aim4replay
// packages. Upload those packages on the website instead of the raw demos —
// the server only has to store already-named rounds, not run the heavy parser.
//
// Round files inside the package use the exact id scheme from
// src/replays/shared/roundId.js (same as server ingest).
//
// Usage:
//   node tools/parse-demo-local.js match.dem
//   node tools/parse-demo-local.js a.dem b.dem -o out/
//   tools\parse-demo.bat              (drag-and-drop GUI)
//   tools\parse-demo.bat match.dem    (CLI)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDemo, parserStatus } from '../server/demoparser/index.js';
import { materializeDemo } from '../server/replays/materialize.js';
import { newDemoId } from '../server/replays/demoStore.js';
import { encodeReplayPackage, PACKAGE_EXT } from '../src/replays/shared/replayPackage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(args.length ? 0 : 1);
  }

  let outDir = null;
  const demos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out') {
      outDir = args[++i];
      if (!outDir) fail('Missing path after -o');
      continue;
    }
    demos.push(a);
  }
  if (!demos.length) fail('Pass at least one .dem file.');

  const status = parserStatus();
  if (!status.available) {
    fail(
      `Demo parser "${status.name}" is not installed.\n` +
        `From the repo root run:\n  npm install @laihoe/demoparser2`
    );
  }

  if (outDir) await fsp.mkdir(outDir, { recursive: true });

  let failed = 0;
  for (const dem of demos) {
    const abs = path.resolve(dem);
    if (!fs.existsSync(abs)) {
      console.error(`[skip] not found: ${dem}`);
      failed++;
      continue;
    }
    if (!/\.dem$/i.test(abs)) {
      console.error(`[skip] not a .dem file: ${dem}`);
      failed++;
      continue;
    }

    const base = path.basename(abs, path.extname(abs));
    const demoId = typeof newDemoId === 'function' ? newDemoId() : crypto.randomBytes(8).toString('hex');
    const sizeBytes = (await fsp.stat(abs)).size;
    console.log(`\nParsing ${abs}`);
    console.log(`  parser ${status.name} ${status.version}`);

    let demo;
    try {
      demo = await parseDemo(abs, {
        onProgress: (p) => {
          if (p.stage === 'round' && p.total) {
            process.stdout.write(`\r  round ${p.round}/${p.total}   `);
          } else if (p.stage) {
            process.stdout.write(`\r  ${p.stage}                 `);
          }
        }
      });
    } catch (err) {
      console.error(`\n  FAILED: ${err.message || err}`);
      failed++;
      continue;
    }
    process.stdout.write('\n');

    const { record, files } = materializeDemo(
      demo,
      demoId,
      {
        filename: path.basename(abs),
        sizeBytes,
        uploadedAt: Date.now(),
        source: 'local'
      },
      (p) => {
        if (p.stage === 'store') {
          process.stdout.write(`\r  writing round ${p.round}/${p.total}   `);
        }
      }
    );
    process.stdout.write('\n');

    const packaged = encodeReplayPackage(files);
    const outPath = path.resolve(
      outDir || path.dirname(abs),
      `${base}${PACKAGE_EXT}`
    );
    await fsp.writeFile(outPath, packaged);

    console.log(`  map ${record.mapName} (${record.map})  ${record.score.team1}:${record.score.team2}`);
    console.log(`  ${record.team1.name} vs ${record.team2.name}`);
    console.log(`  ${record.roundCount} rounds → ${outPath}`);
    console.log(`  ${(packaged.byteLength / 1024 / 1024).toFixed(1)} MB package (upload this, not the .dem)`);
  }

  if (failed) {
    console.error(`\n${failed} demo(s) failed.`);
    process.exit(1);
  }
  console.log('\nDone. Upload the .aim4replay file(s) on the Replays page.');
}

function printHelp() {
  console.log(`Parse CS2 demos locally into AIM4 replay packages.

Usage:
  tools\\parse-demo.bat                      drag-and-drop GUI (Windows)
  tools\\parse-demo.bat --cli <demo.dem>     command line
  node tools/parse-demo-local.js <demo.dem> [more.dem ...] [-o outDir]

Requires (once, from the repo root):
  npm install
  npm install @laihoe/demoparser2

Then upload the produced .aim4replay file on the website Replays page.
Round names inside the package match the library filter scheme exactly.`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
