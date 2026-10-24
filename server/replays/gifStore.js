// ---------------------------------------------------------------------------
// server/replays/gifStore.js
// Saved GIFs: the GIF creator's output, kept for Bookmarks and served at a
// share link.
//
// Layout, beside the playlists in the shared library folder:
//   gifs/<id>.gif     the image, as uploaded
//   gifs.json         every record: owner, size, dimensions, and what the GIF
//                     shows (map, teams, buys, winner, title; see gifMeta.js)
//
// The id is 16 random hex characters and is the whole share link: anyone with
// /g/<id>.gif sees the picture, nobody can list them. The image file is found
// by id alone, so the public route never reads the index.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { userDir } from './demoStore.js';
import { GIF_DESCRIPTION_MAX, GIF_ID, GIF_TITLE_MAX, cleanGifMeta } from '../../src/replays/gif/gifMeta.js';

export const MAX_GIF_BYTES = 40 * 1024 * 1024;
/** Per account. A GIF is a few MB; this is the rail, not a plan limit. */
export const MAX_GIFS = 500;

const gifDir = (user) => path.join(userDir(user), 'gifs');
const indexPath = (user) => path.join(userDir(user), 'gifs.json');
const filePath = (user, id) => path.join(gifDir(user), `${id}.gif`);

/** Width and height from the logical screen descriptor, or null when it is not a GIF. */
export function gifDimensions(buf) {
  if (!buf || buf.length < 13) return null;
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF89a' && sig !== 'GIF87a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** Frames in the file: one image descriptor each. Walks the blocks rather than searching for 0x2C. */
export function gifFrameCount(buf) {
  if (!gifDimensions(buf)) return 0;
  let p = 13;
  const flags = buf[10];
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  let frames = 0;
  const skipBlocks = () => {
    while (p < buf.length) {
      const n = buf[p++];
      if (!n) return;
      p += n;
    }
  };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      p++;
      skipBlocks();
    } else if (b === 0x2c) {
      frames++;
      const f = buf[p + 8];
      p += 9;
      if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
      p++;
      skipBlocks();
    } else {
      break;
    }
  }
  return frames;
}

export async function readGifs(user) {
  try {
    const raw = JSON.parse(await fsp.readFile(indexPath(user), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function writeGifs(user, list) {
  await fsp.mkdir(userDir(user), { recursive: true });
  const tmp = `${indexPath(user)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
  await fsp.rename(tmp, indexPath(user));
  return list;
}

/** One write at a time to the index: two uploads finishing together must not drop each other. */
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Store an uploaded GIF.
 *
 * @param {string} user  the library
 * @param {Buffer} bytes
 * @param {object} meta  what the GIF shows (cleaned here again)
 * @param {{ id: string, username?: string }} actor
 */
export async function addGif(user, bytes, meta, actor) {
  if (!actor?.id) throw fail(401, 'Sign in to save GIFs.');
  if (!bytes?.length) throw fail(400, 'The GIF is empty.');
  if (bytes.length > MAX_GIF_BYTES) throw fail(413, `That GIF is over ${MAX_GIF_BYTES / 1024 / 1024} MB, too large to keep in Bookmarks.`);
  const dims = gifDimensions(bytes);
  if (!dims) throw fail(400, 'That is not a GIF.');
  return serial(async () => {
    const list = await readGifs(user);
    if (list.filter((g) => g.ownerId === actor.id).length >= MAX_GIFS) {
      throw fail(409, `You can keep ${MAX_GIFS} GIFs. Delete some first.`);
    }
    const id = crypto.randomBytes(8).toString('hex');
    await fsp.mkdir(gifDir(user), { recursive: true });
    await fsp.writeFile(filePath(user, id), bytes);
    const record = {
      ...cleanGifMeta(meta),
      id,
      ownerId: actor.id,
      ownerName: actor.username || '',
      bytes: bytes.length,
      width: dims.width,
      height: dims.height,
      frames: gifFrameCount(bytes),
      createdAt: Date.now()
    };
    list.unshift(record);
    await writeGifs(user, list);
    return record;
  });
}

/** Records this account may see: its own, or every one for a site admin. */
export async function listGifs(user, actor) {
  const list = await readGifs(user);
  if (actor?.admin) return list;
  return list.filter((g) => actor?.id && g.ownerId === actor.id);
}

/** Change the title or description. Only the owner (or an admin). */
export async function updateGif(user, id, patch, actor) {
  if (!GIF_ID.test(String(id))) throw fail(404, 'GIF not found.');
  return serial(async () => {
    const list = await readGifs(user);
    const g = list.find((x) => x.id === id);
    if (!g) throw fail(404, 'GIF not found.');
    if (!actor?.admin && g.ownerId !== actor?.id) throw fail(403, 'That GIF belongs to someone else.');
    const next = cleanGifMeta({ ...g, title: patch?.title ?? g.title, description: patch?.description ?? g.description });
    g.title = next.title.slice(0, GIF_TITLE_MAX);
    g.description = next.description.slice(0, GIF_DESCRIPTION_MAX);
    g.updatedAt = Date.now();
    await writeGifs(user, list);
    return g;
  });
}

/** Delete a GIF and its file. Resolves false when there was nothing to delete. */
export async function removeGif(user, id, actor) {
  if (!GIF_ID.test(String(id))) return false;
  return serial(async () => {
    const list = await readGifs(user);
    const g = list.find((x) => x.id === id);
    if (!g) return false;
    if (!actor?.admin && g.ownerId !== actor?.id) throw fail(403, 'That GIF belongs to someone else.');
    await writeGifs(user, list.filter((x) => x.id !== id));
    await fsp.rm(filePath(user, id), { force: true });
    return true;
  });
}

/** The image bytes for a share link, or null. */
export async function readGifFile(user, id) {
  if (!GIF_ID.test(String(id))) return null;
  try {
    return await fsp.readFile(filePath(user, id));
  } catch {
    return null;
  }
}

/** One record by id, for the share page's title and description. */
export async function gifRecord(user, id) {
  if (!GIF_ID.test(String(id))) return null;
  return (await readGifs(user)).find((g) => g.id === id) || null;
}
