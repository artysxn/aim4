// ---------------------------------------------------------------------------
// server/replays/gifStore.js
// Saved GIFs: the GIF creator's output, kept for Bookmarks and served at a
// share link. A clip is kept as a video; a GIF is made from it when asked for.
//
// Layout, beside the playlists in the shared library folder:
//   gifs/<id>.mp4     the clip, what is kept
//   gifs/<id>.jpg     its first frame, for link previews and walls of them
//   gifs/<id>.gif     a GIF of it, made on the first request and thrown away
//                     again when they take too much room (GIF_CACHE_BYTES). One
//                     from before clips were videos is turned into its MP4 first.
//   gifs.json         every record: owner, size, dimensions, and what the clip
//                     shows (map, teams, buys, winner, title; see gifMeta.js)
//
// The id is 16 random hex characters and is the whole share link: anyone with
// /g/<id>.gif sees the picture, nobody can list them. The files are found by
// id alone, so the public route never reads the index.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { userDir } from './demoStore.js';
import { GIF_DESCRIPTION_MAX, GIF_ID, GIF_TITLE_MAX, cleanGifMeta } from '../../src/replays/gif/gifMeta.js';
import { gifToMp4, mp4ToGif, posterOf, probeVideo } from './gifVideo.js';

export const MAX_GIF_BYTES = 100 * 1024 * 1024;
/** Per account. A clip is a few MB; this is the rail, not a plan limit. */
export const MAX_GIFS = 500;
/** GIFs made on request, kept for the next one to ask. They can always be made again. */
export const GIF_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

const gifDir = (user) => path.join(userDir(user), 'gifs');
const indexPath = (user) => path.join(userDir(user), 'gifs.json');
const filePath = (user, id, ext = 'gif') => path.join(gifDir(user), `${id}.${ext}`);
const exists = (file) => fsp.stat(file).then((s) => s.isFile(), () => false);

/** Width and height from the logical screen descriptor, or null when it is not a GIF. */
export function gifDimensions(buf) {
  if (!buf || buf.length < 13) return null;
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF89a' && sig !== 'GIF87a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** An MP4 starts with its ftyp box. ffmpeg decides whether the rest of it is one. */
export const looksLikeMp4 = (buf) => Boolean(buf && buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp');

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

/** Write a file so that nobody ever reads half of it. */
async function intoPlace(file, write) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await write(tmp);
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** The clip's MP4 and poster from what was uploaded, or a refusal. An upload that fails leaves nothing behind. */
async function storeMedia(user, id, bytes) {
  const mp4 = filePath(user, id, 'mp4');
  await fsp.mkdir(gifDir(user), { recursive: true });
  try {
    if (gifDimensions(bytes)) {
      await fsp.writeFile(filePath(user, id), bytes);
      await intoPlace(mp4, (tmp) => gifToMp4(filePath(user, id), tmp));
    } else {
      await intoPlace(mp4, (tmp) => fsp.writeFile(tmp, bytes));
    }
    const video = await probeVideo(mp4);
    // What every browser plays. The creator only makes this, so anything else did not come from it.
    if (video.codec !== 'h264') throw fail(400, 'That video is not H.264.');
    await intoPlace(filePath(user, id, 'jpg'), (tmp) => posterOf(mp4, tmp));
    return { ...video, bytes: (await fsp.stat(mp4)).size };
  } catch (err) {
    await removeMedia(user, id);
    if (err.status) throw err;
    // ffmpeg saying it cannot read the file is the uploader's answer; ffmpeg being gone is ours.
    throw fail(/not installed/.test(err.message) ? 503 : 400, /not installed/.test(err.message) ? 'Saving clips is not available on this server right now.' : 'That file could not be read as a video.');
  }
}

const removeMedia = (user, id) => Promise.all(['mp4', 'jpg', 'gif'].map((ext) => fsp.rm(filePath(user, id, ext), { force: true })));

/**
 * Store an uploaded clip: an MP4 from the creator, or a GIF from a browser that cannot make one.
 *
 * @param {string} user  the library
 * @param {Buffer} bytes
 * @param {object} meta  what the clip shows (cleaned here again)
 * @param {{ id: string, username?: string }} actor
 */
export async function addGif(user, bytes, meta, actor) {
  if (!actor?.id) throw fail(401, 'Sign in to save GIFs.');
  if (!bytes?.length) throw fail(400, 'The GIF is empty.');
  if (bytes.length > MAX_GIF_BYTES) throw fail(413, `That GIF is over ${MAX_GIF_BYTES / 1024 / 1024} MB, too large to keep in Bookmarks.`);
  if (!gifDimensions(bytes) && !looksLikeMp4(bytes)) throw fail(400, 'That is not a GIF or an MP4.');
  const full = () => fail(409, `You can keep ${MAX_GIFS} GIFs. Delete some first.`);
  const owned = async () => (await readGifs(user)).filter((g) => g.ownerId === actor.id).length;
  // Refused before the conversion when it can be, and checked again in the queue where it counts.
  if ((await owned()) >= MAX_GIFS) throw full();
  const id = crypto.randomBytes(8).toString('hex');
  const media = await storeMedia(user, id, bytes);
  return serial(async () => {
    const list = await readGifs(user);
    if (list.filter((g) => g.ownerId === actor.id).length >= MAX_GIFS) {
      await removeMedia(user, id);
      throw full();
    }
    const record = {
      ...cleanGifMeta(meta),
      id,
      ownerId: actor.id,
      ownerName: actor.username || '',
      bytes: media.bytes,
      width: media.width,
      height: media.height,
      frames: media.frames,
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
    await removeMedia(user, id);
    return true;
  });
}

/** One build per file at a time: a second asker waits for the first's. */
const building = new Map();
function buildOnce(file, build) {
  if (!building.has(file)) building.set(file, build().finally(() => building.delete(file)));
  return building.get(file);
}

/**
 * The clip's MP4, made first from a GIF saved before clips were videos. Null when there is no such clip.
 *
 * @returns {Promise<string|null>} the file
 */
export async function videoFile(user, id) {
  if (!GIF_ID.test(String(id))) return null;
  const mp4 = filePath(user, id, 'mp4');
  if (await exists(mp4)) return mp4;
  const gif = filePath(user, id);
  if (!(await exists(gif))) return null;
  await buildOnce(mp4, async () => {
    await intoPlace(mp4, (tmp) => gifToMp4(gif, tmp));
    await intoPlace(filePath(user, id, 'jpg'), (tmp) => posterOf(mp4, tmp));
    const { size } = await fsp.stat(mp4);
    await serial(async () => {
      const list = await readGifs(user);
      const g = list.find((x) => x.id === id);
      if (!g) return;
      g.bytes = size;
      await writeGifs(user, list);
    });
  });
  return mp4;
}

/** The clip's poster, or null. */
export async function posterFile(user, id) {
  if (!(await videoFile(user, id))) return null;
  const jpg = filePath(user, id, 'jpg');
  return (await exists(jpg)) ? jpg : null;
}

/**
 * The clip as a GIF, made on the first request. Null when there is no such clip.
 *
 * @returns {Promise<string|null>} the file
 */
export async function gifFile(user, id) {
  if (!GIF_ID.test(String(id))) return null;
  const gif = filePath(user, id);
  if (await exists(gif)) {
    const now = new Date();
    await fsp.utimes(gif, now, now).catch(() => {});
    return gif;
  }
  const mp4 = filePath(user, id, 'mp4');
  if (!(await exists(mp4))) return null;
  await buildOnce(gif, async () => {
    await intoPlace(gif, (tmp) => mp4ToGif(mp4, tmp));
    await trimGifCache(user);
  });
  return gif;
}

/**
 * Keep the made GIFs under the budget, the longest unasked for going first. Only one with its MP4 beside
 * it goes: that one can be made again, and a GIF from before clips were videos is the only copy.
 */
export async function trimGifCache(user, budget = GIF_CACHE_BYTES) {
  const names = await fsp.readdir(gifDir(user)).catch(() => []);
  const held = new Set(names);
  const gifs = [];
  let total = 0;
  for (const name of names) {
    if (!name.endsWith('.gif')) continue;
    const s = await fsp.stat(path.join(gifDir(user), name)).catch(() => null);
    if (!s) continue;
    total += s.size;
    if (held.has(name.replace(/\.gif$/, '.mp4'))) gifs.push({ name, size: s.size, at: s.mtimeMs });
  }
  gifs.sort((a, b) => a.at - b.at);
  for (const g of gifs) {
    if (total <= budget) break;
    await fsp.rm(path.join(gifDir(user), g.name), { force: true }).catch(() => {});
    total -= g.size;
  }
}

/**
 * Turn every GIF saved before clips were videos into its MP4, one at a time, and let go of the GIFs over
 * the budget. Safe to run again: a clip that has its MP4 is skipped, and one that fails is tried next time.
 *
 * @returns {Promise<{ converted: number, failed: number }>}
 */
export async function convertSavedGifs(user) {
  const names = await fsp.readdir(gifDir(user)).catch(() => []);
  const held = new Set(names);
  let converted = 0;
  let failed = 0;
  for (const name of names) {
    const id = name.replace(/\.gif$/, '');
    if (id === name || !GIF_ID.test(id) || held.has(`${id}.mp4`)) continue;
    try {
      await videoFile(user, id);
      converted++;
    } catch (err) {
      failed++;
      console.warn(`[gifs] ${id} could not be converted: ${err.message}`);
    }
  }
  await trimGifCache(user);
  return { converted, failed };
}

/** One record by id, for the share page's title and description. */
export async function gifRecord(user, id) {
  if (!GIF_ID.test(String(id))) return null;
  return (await readGifs(user)).find((g) => g.id === id) || null;
}
