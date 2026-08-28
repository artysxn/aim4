// Run: node server/ingest/gdrive/drive.test.js
//
// The Drive transports, without Google in the room.
//
// The scrape-half tests pin the exact markup shapes being parsed
// (embeddedfolderview entries, the virus-scan interstitial form): when Google
// changes them, these tests name the breakage before an admin hits it live.

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  createDriveClient,
  parseDriveLink,
  parseFolderViewHtml,
  parseInterstitial
} from './drive.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- link parsing ------------------------------------------------------------
{
  // The link the whole feature exists for.
  const pasted = parseDriveLink(
    'https://drive.google.com/drive/folders/1Qi6yHD9uTNAEeKwDtIlsTtx3E49QwFia?usp=drive_link'
  );
  assert(pasted?.kind === 'folder' && pasted.id === '1Qi6yHD9uTNAEeKwDtIlsTtx3E49QwFia', 'a real pasted folder link');

  assert(
    parseDriveLink('https://drive.google.com/drive/u/0/folders/1ABCdefGHIjkLMN').id === '1ABCdefGHIjkLMN',
    'the signed-in u/0 variant'
  );
  assert(
    parseDriveLink('https://drive.google.com/file/d/1FiLe_id-0123456/view?usp=sharing').kind === 'file',
    'a single file link'
  );
  assert(parseDriveLink('https://drive.google.com/open?id=1FiLe_id-0123456').kind === 'file', 'open?id=');
  assert(parseDriveLink('https://evil.example/drive/folders/1ABCdefGHIjkLMN') === null, 'google.com only');
  assert(parseDriveLink('not a url') === null, 'garbage');
  assert(parseDriveLink('') === null, 'empty');
}

// ---- API transport: listing paginates, fields map ----------------------------
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.pathname.endsWith('/files')) {
      const page2 = u.searchParams.has('pageToken');
      return Response.json(
        page2
          ? { files: [{ id: 'f2', name: 'map2.dem', mimeType: 'application/octet-stream', size: '99' }] }
          : {
              nextPageToken: 'tok',
              files: [
                { id: 'sub', name: 'Groups', mimeType: 'application/vnd.google-apps.folder' },
                { id: 'f1', name: 'Match.rar', mimeType: 'application/rar', size: '1234', md5Checksum: 'aa' }
              ]
            }
      );
    }
    return Response.json({ id: 'root', name: 'Cup', mimeType: 'application/vnd.google-apps.folder' });
  };
  const client = createDriveClient({ apiKey: 'k', fetchImpl });
  assert(client.transport === 'api', 'a key selects the API');

  const listed = await client.listFolder('root');
  assert(listed.length === 3, 'both pages were read');
  assert(listed[0].isFolder === true, 'folders are marked');
  assert(listed[1].sizeBytes === 1234 && listed[1].md5 === 'aa', 'size and checksum map over');
  assert(listed[2].name === 'map2.dem', 'page two arrived');
  assert(calls[1].includes('pageToken=tok'), 'the token was passed back');
  assert(calls.every((c) => c.includes('key=k')), 'every call carries the key');

  const meta = await client.describe('root');
  assert(meta.name === 'Cup' && meta.isFolder, 'describe names the folder');
}

// ---- API transport: download streams to disk, cap enforced -------------------
{
  const dir = path.join(process.env.TMPDIR || '/tmp', `gdrive-test-${process.pid}`);
  const dest = path.join(dir, 'out.bin');
  const bytes = Buffer.alloc(4096, 7);
  const client = createDriveClient({
    apiKey: 'k',
    fetchImpl: async () => new Response(bytes)
  });
  const got = await client.download({ id: 'f1' }, dest, {});
  assert(got.bytes === 4096, 'all bytes landed');
  assert((await fsp.readFile(dest)).equals(bytes), 'byte for byte');

  let refused = null;
  try {
    await client.download({ id: 'f1' }, dest, { maxBytes: 1024 });
  } catch (err) {
    refused = err;
  }
  assert(refused, 'the cap refuses an oversize body');
  assert(!(await fsp.stat(dest).catch(() => null)), 'and the partial file is gone');
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---- scrape transport: the folder view markup --------------------------------
{
  const html = `
    <html><title>Small Cup Demos - Google Drive</title><body>
    <div class="flip-entry" id="entry-1SubFolder__abc"><div class="flip-entry-info">
      <a href="https://drive.google.com/drive/folders/1SubFolder__abc" target="_blank"></a>
      <div class="flip-entry-title">Group A &amp; B</div></div></div>
    <div class="flip-entry" id="entry-1DemFile____xyz"><div class="flip-entry-info">
      <a href="https://drive.google.com/file/d/1DemFile____xyz/view" target="_blank"></a>
      <div class="flip-entry-title">final-map1.dem</div></div></div>
    </body></html>`;
  const entries = parseFolderViewHtml(html);
  assert(entries.length === 2, `two entries (got ${entries.length})`);
  assert(entries[0].isFolder && entries[0].name === 'Group A & B', 'folder, entity decoded');
  assert(!entries[1].isFolder && entries[1].id === '1DemFile____xyz', 'file by id');

  const client = createDriveClient({ fetchImpl: async () => new Response(html) });
  assert(client.transport === 'scrape', 'no key selects the scrape');
  const meta = await client.describe('1AnyFolder__abc');
  assert(meta.name === 'Small Cup Demos - Google Drive', 'title names the folder');
}

// ---- scrape transport: the virus-scan interstitial ---------------------------
{
  const page = `
    <html><body><form action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="1DemFile____xyz">
      <input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t">
      <input type="hidden" name="uuid" value="u-u-i-d">
      <input type="submit" value="Download anyway">
    </form></body></html>`;
  const confirmed = parseInterstitial(page);
  const u = new URL(confirmed);
  assert(u.host === 'drive.usercontent.google.com', 'the real download host');
  assert(u.searchParams.get('confirm') === 't' && u.searchParams.get('uuid') === 'u-u-i-d', 'the form fields ride along');
  assert(parseInterstitial('<html>no form here</html>') === null, 'no form, no url');

  // The full two-leg download: HTML first, bytes on the confirmed URL.
  const dir = path.join(process.env.TMPDIR || '/tmp', `gdrive-test2-${process.pid}`);
  const dest = path.join(dir, 'big.rar');
  const bytes = Buffer.from('Rar!\x1a\x07\x01' + 'x'.repeat(100), 'latin1');
  const hits = [];
  const client = createDriveClient({
    fetchImpl: async (url) => {
      hits.push(String(url));
      if (String(url).startsWith('https://drive.google.com/uc')) {
        return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    }
  });
  const got = await client.download({ id: '1DemFile____xyz' }, dest, {});
  assert(got.bytes === bytes.length, 'the confirmed leg delivered the file');
  assert(hits.length === 2 && hits[1].includes('usercontent'), 'exactly two legs, in order');
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---- scrape transport: a page that is not the interstitial is an error -------
{
  const client = createDriveClient({
    fetchImpl: async () =>
      new Response('<html>You need access</html>', { headers: { 'content-type': 'text/html' } })
  });
  let err = null;
  try {
    await client.download({ id: '1DemFile____xyz' }, '/tmp/never.bin', {});
  } catch (e) {
    err = e;
  }
  assert(err && /not be public/i.test(err.message), `says what it probably is: ${err?.message}`);
}

console.log('gdrive/drive: all assertions passed');
