// ---------------------------------------------------------------------------
// server/eye/eyeStore.js
// Which aim4 eye installs belong to which account.
//
//   {AIM4_REPLAY_DIR}/eye/devices.json
//
// A device is one desktop app linked to one account. Linking happens from the
// site inside the app's own window, where the user is already signed in: the
// page asks for a device token and hands it to the app, which keeps it and
// presents it whenever it connects to the relay.
//
// Only a SHA-256 of each token is stored. A copy of this file cannot be used
// to impersonate anyone's app; it only says which hash belongs to whom.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT as REPLAY_ROOT } from '../replays/demoStore.js';

export const EYE_DIR = process.env.AIM4_EYE_DIR || path.join(REPLAY_ROOT, 'eye');
const FILE = path.join(EYE_DIR, 'devices.json');
/** Enough for a desktop, a laptop and a stray reinstall; old links get revoked. */
export const MAX_DEVICES_PER_USER = 8;
const TOKEN_PREFIX = 'eye_';

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** @type {null | Array<{ id: string, userId: string, hash: string, name: string, createdAt: number, lastSeenAt: number }>} */
let cache = null;
let writing = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    cache = Array.isArray(raw?.devices) ? raw.devices : [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    cache = [];
  }
  return cache;
}

/** Writes are queued so two links in the same second cannot lose one. */
function save() {
  writing = writing.then(async () => {
    await fsp.mkdir(EYE_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ devices: cache }, null, 2), 'utf8');
    await fsp.rename(tmp, FILE);
  });
  return writing;
}

const publicOf = (d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt });

function cleanName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f]/g, '').trim();
  return (s || 'aim4 desktop').slice(0, 60);
}

/**
 * Link a new device to an account. The token is returned once, here, and
 * never again.
 * @returns {Promise<{ device: object, token: string }>}
 */
export async function linkDevice(userId, name) {
  if (!userId) throw new Error('Sign in first.');
  const list = await load();
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const device = {
    id: crypto.randomBytes(6).toString('hex'),
    userId: String(userId),
    hash: hashOf(token),
    name: cleanName(name),
    createdAt: Date.now(),
    lastSeenAt: 0
  };
  list.push(device);
  // Over the cap, the oldest link of this account goes.
  const mine = list.filter((d) => d.userId === device.userId).sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length > MAX_DEVICES_PER_USER) {
    const old = mine.shift();
    list.splice(list.indexOf(old), 1);
  }
  await save();
  return { device: publicOf(device), token };
}

/** The device a token belongs to, or null. */
export async function deviceForToken(token) {
  const t = String(token || '');
  if (!t.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashOf(t);
  const list = await load();
  const found = list.find((d) => d.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(hash)));
  return found || null;
}

export async function touchDevice(id) {
  const d = (await load()).find((x) => x.id === id);
  if (!d) return;
  d.lastSeenAt = Date.now();
  await save();
}

export async function listDevices(userId) {
  return (await load()).filter((d) => d.userId === String(userId)).map(publicOf);
}

export async function revokeDevice(userId, id) {
  const list = await load();
  const at = list.findIndex((d) => d.id === id && d.userId === String(userId));
  if (at < 0) return false;
  list.splice(at, 1);
  await save();
  return true;
}

/** Tests only: forget what was read, so a fresh directory is read again. */
export function _resetForTests() {
  cache = null;
  writing = Promise.resolve();
}
