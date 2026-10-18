// ---------------------------------------------------------------------------
// server/eye/chatStore.js
// Past aim4 eye conversations, kept per account so they follow the user from
// the browser to the desktop app.
//
//   {AIM4_EYE_DIR}/chats/{account hash}/index.json     id, title, updatedAt
//   {AIM4_EYE_DIR}/chats/{account hash}/{chat id}.json the messages
//
// The page sends the conversation already trimmed (pictures replaced by a
// note, long tool results cut), so a chat is text and stays small.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EYE_DIR } from './eyeStore.js';

/** Chats kept per account; saving past this drops the least recently updated. */
export const MAX_CHATS_PER_USER = 100;
/** One saved chat, as JSON. */
export const MAX_CHAT_FILE_BYTES = 2 * 1024 * 1024;
const ID = /^[a-f0-9]{16}$/;

export const isChatId = (id) => ID.test(String(id || ''));

const dirOf = (userId) => path.join(EYE_DIR, 'chats', crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32));

/** One writer at a time per account, so two quick saves cannot lose an index entry. */
const queues = new Map();
function exclusive(userId, task) {
  const run = (queues.get(userId) || Promise.resolve()).then(task, task);
  queues.set(userId, run.catch(() => {}));
  return run;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, file);
}

const cleanTitle = (t) => String(t || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) || 'New chat';

const readIndex = async (userId) => {
  const raw = await readJson(path.join(dirOf(userId), 'index.json'), { chats: [] });
  return Array.isArray(raw.chats) ? raw.chats : [];
};

/** Newest first. */
export async function listChats(userId) {
  return (await readIndex(userId)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(userId, id) {
  if (!isChatId(id)) return null;
  return readJson(path.join(dirOf(userId), `${id}.json`), null);
}

/** @returns {Promise<{ id: string, title: string, updatedAt: number }>} */
export function saveChat(userId, id, { title, messages }) {
  if (!isChatId(id)) throw Object.assign(new Error('Bad chat id.'), { status: 400 });
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('A chat needs messages.'), { status: 400 });
  const body = JSON.stringify(messages);
  if (Buffer.byteLength(body) > MAX_CHAT_FILE_BYTES) throw Object.assign(new Error('This chat is too long to save.'), { status: 413 });
  return exclusive(userId, async () => {
    const dir = dirOf(userId);
    const chats = await readIndex(userId);
    const entry = { id, title: cleanTitle(title), updatedAt: Date.now() };
    const at = chats.findIndex((c) => c.id === id);
    if (at >= 0) chats[at] = entry;
    else chats.push(entry);
    await writeJson(path.join(dir, `${id}.json`), { ...entry, messages });
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of chats.splice(MAX_CHATS_PER_USER)) await fsp.rm(path.join(dir, `${old.id}.json`), { force: true });
    await writeJson(path.join(dir, 'index.json'), { chats });
    return entry;
  });
}

export function deleteChat(userId, id) {
  if (!isChatId(id)) return Promise.resolve(false);
  return exclusive(userId, async () => {
    const chats = await readIndex(userId);
    const at = chats.findIndex((c) => c.id === id);
    if (at < 0) return false;
    chats.splice(at, 1);
    await fsp.rm(path.join(dirOf(userId), `${id}.json`), { force: true });
    await writeJson(path.join(dirOf(userId), 'index.json'), { chats });
    return true;
  });
}
