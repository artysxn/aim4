// ---------------------------------------------------------------------------
// server/ingest/hltv/cloakDisplay.js
// Headed CloakBrowser needs a real X server. After SIGKILL the unix socket
// file often remains while nothing listens; trusting `access()` alone is how
// ingest loops on "Missing X server".
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';

/** Prefer a dedicated display so parent `xvfb-run -a` and ingest do not fight. */
export const INGEST_DISPLAY_NUMBER = 99;

let displayPromise = null;
let displayStarting = false;
let xvfbProcess = null;

export function displaySocketPath(displayNumber) {
  return `/tmp/.X11-unix/X${displayNumber}`;
}

export function displayLockPath(displayNumber) {
  return `/tmp/.X${displayNumber}-lock`;
}

/** Parse `:99` / `localhost:99.0` → 99. */
export function parseDisplayNumber(display) {
  const m = String(display || '').match(/:(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * True only when something is actually listening on the X11 unix socket.
 * A leftover `/tmp/.X11-unix/X99` after SIGKILL looks present to `access()`
 * but Chrome still dies with "Missing X server".
 */
export function isDisplayAlive(displayNumber, { timeoutMs = 500 } = {}) {
  const socket = displaySocketPath(displayNumber);
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socket });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    client.once('connect', () => done(true));
    client.once('error', () => done(false));
    client.setTimeout(timeoutMs, () => done(false));
  });
}

export async function clearStaleDisplayFiles(displayNumber) {
  await fsp.rm(displaySocketPath(displayNumber), { force: true }).catch(() => {});
  await fsp.rm(displayLockPath(displayNumber), { force: true }).catch(() => {});
}

export function resetHeadedDisplay() {
  delete process.env.DISPLAY;
  displayPromise = null;
  displayStarting = false;
  try {
    xvfbProcess?.kill?.('SIGKILL');
  } catch {
    /* already gone */
  }
  xvfbProcess = null;
  // Best-effort sync cleanup so the next ensureHeadedDisplay does not trust a
  // dead socket left behind by a SIGKILL'd prior Xvfb.
  try {
    fs.rmSync(displaySocketPath(INGEST_DISPLAY_NUMBER), { force: true });
    fs.rmSync(displayLockPath(INGEST_DISPLAY_NUMBER), { force: true });
  } catch {
    /* ignore */
  }
}

export async function ensureHeadedDisplay() {
  if (process.platform !== 'linux') return;

  // Reuse any DISPLAY that still answers (parent `xvfb-run`, prior healthy Xvfb).
  const existingNum = parseDisplayNumber(process.env.DISPLAY);
  if (existingNum != null && (await isDisplayAlive(existingNum))) {
    return;
  }

  const displayNumber = INGEST_DISPLAY_NUMBER;
  const display = `:${displayNumber}`;
  if (await isDisplayAlive(displayNumber)) {
    process.env.DISPLAY = display;
    return;
  }

  // Socket/lock files often survive the process that owned them.
  delete process.env.DISPLAY;
  await clearStaleDisplayFiles(displayNumber);

  if (!displayStarting) {
    displayStarting = true;
    displayPromise = (async () => {
      try {
        try {
          xvfbProcess?.kill?.('SIGKILL');
        } catch {
          /* ignore */
        }
        await clearStaleDisplayFiles(displayNumber);
        xvfbProcess = spawn(
          'Xvfb',
          [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
          { stdio: 'ignore' }
        );
        xvfbProcess.unref();
        let launchError = null;
        xvfbProcess.once('error', (err) => {
          launchError = err;
        });
        xvfbProcess.once('exit', () => {
          if (xvfbProcess) xvfbProcess = null;
        });
        process.once('exit', () => {
          try {
            xvfbProcess?.kill?.('SIGKILL');
          } catch {
            /* ignore */
          }
        });

        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (launchError) {
            throw new Error(
              `Could not start Xvfb for headed CloakBrowser: ${launchError.message}. Rebuild the Docker image so the xvfb package is installed.`
            );
          }
          if (await isDisplayAlive(displayNumber)) {
            process.env.DISPLAY = display;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Xvfb did not become ready within 8 seconds');
      } finally {
        displayStarting = false;
      }
    })();
  }
  return displayPromise;
}
