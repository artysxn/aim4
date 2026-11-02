// ---------------------------------------------------------------------------
// server/replays/gifShare.js
// A saved GIF at its share link, for anyone who has it.
//
//   /g/<id>.gif   the image itself: pasted into Discord, Slack or a forum it
//                 embeds and plays like any image link. Made from the clip on
//                 the first request (gifStore.js), so that one can take a while.
//   /g/<id>.mp4   the clip, which is what is kept and what the pages play
//   /g/<id>.jpg   its first frame
//   /g/<id>       a page with the clip, its title and description, and the
//                 link-preview tags pointing at the video, so a preview of this
//                 link plays without making a GIF
//
// No sign-in and no listing: the 16 random hex characters are the secret.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { identify } from './auth.js';
import { gifFile, gifRecord, posterFile, videoFile } from './gifStore.js';
import { descriptionParts, descriptionPlain, gifDisplayTitle, notePerspectives, perspectiveLabel } from '../../src/replays/gif/gifMeta.js';

const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MEDIA = {
  gif: { type: 'image/gif', find: gifFile },
  mp4: { type: 'video/mp4', find: videoFile },
  jpg: { type: 'image/jpeg', find: posterFile }
};

/** The one byte range a video element asks for, or null for the whole file. */
function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return start <= end && start < size ? { start, end } : { unsatisfiable: true };
}

/**
 * A clip's file, cached hard: a share id never points at a different picture. Streamed, with ranges, since a
 * video seeks and a file can be 100 MB. Answers 404 when there is no such clip, and resolves true either way.
 *
 * @param {'gif'|'mp4'|'jpg'} ext
 */
export async function sendGifMedia(req, res, user, id, ext) {
  const { type, find } = MEDIA[ext];
  const refuse = (status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  let file;
  try {
    file = await find(user, id);
  } catch (err) {
    console.warn(`[gifs] ${id}.${ext} could not be made: ${err.message}`);
    refuse(503, 'That GIF could not be made right now. Try again in a moment.');
    return true;
  }
  if (!file) {
    refuse(404, 'That GIF does not exist, or it was deleted.');
    return true;
  }
  const { size } = await fsp.stat(file);
  const range = rangeOf(req.headers?.range, size);
  const common = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff'
  };
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` });
    res.end();
    return true;
  }
  const { start = 0, end = size - 1 } = range || {};
  res.writeHead(range ? 206 : 200, { ...common, 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD' || !size) {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
  return true;
}

/** At most `max` characters, cut at a word with an ellipsis. */
const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`);

/** This server's own origin as the client reached it, for absolute preview links. */
function originOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'aim4.io').split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** The share page's technical line, shown while Alt is held: map, round, teams, who won. */
function summaryOf(g) {
  const [a, b] = g.teams || [];
  const teams = a?.name && b?.name ? `${a.name}${a.side ? ` (${a.side})` : ''} vs ${b.name}${b.side ? ` (${b.side})` : ''}` : '';
  const won = g.winnerTeam ? `${g.winnerTeam} won` : g.winnerSide ? `${g.winnerSide} won` : '';
  const clip = g.clockFrom && g.clockTo ? `${g.clockFrom} to ${g.clockTo}` : '';
  return [g.mapName || g.map, g.round ? `Round ${g.round}` : '', clip, teams, won].filter(Boolean).join(' · ');
}

/** The description with its <...> copy links as buttons (the same reading as Bookmarks). */
function descriptionHtml(text) {
  return descriptionParts(text)
    .map((p) => (p.copy ? `<a href="#" class="cp" data-copy="${escape(p.copy)}" title="Copy">${escape(p.text)}</a>` : escape(p.text)))
    .join('');
}

const icon = (viewBox, d) => `<svg viewBox="${viewBox}" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_PLAY = icon('0 -960 960 960', 'M364.31-279.08v-401.84L679.39-480 364.31-279.08Z');
const ICON_DOWNLOAD = icon('0 0 24 24', 'M12,15.58L8.46,12.04l0.71-0.72l2.33,2.33V5h1v8.65l2.33-2.33l0.71,0.72L12,15.58ZM5,19V14.96H6V18H18V14.96h1V19H5Z');
const ICON_HOME = icon('0 0 24 24', 'M5,20V9.5l7-5.29L19,9.5V20H13.81V13.62H10.19V20H5Z');

/** The technical line is there only while Alt is down; leaving the window lets go of it. */
const ALT_SCRIPT = `(function(){var c=document.documentElement.classList;var set=function(e,on){if(e.key==='Alt'){e.preventDefault();c.toggle('alt',on)}};addEventListener('keydown',function(e){set(e,true)});addEventListener('keyup',function(e){set(e,false)});addEventListener('blur',function(){c.remove('alt')})})();`;

/**
 * One listener for every copy link; a button that copied says so for a moment. Copying the image URL also
 * asks for the image, so the GIF is made before whoever gets the link opens it.
 */
const COPY_SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-copy]');if(!b)return;e.preventDefault();var t=b.getAttribute('data-copy');if(b.hasAttribute('data-warm'))fetch(t,{method:'HEAD'}).catch(function(){});var done=function(){b.classList.add('ok');setTimeout(function(){b.classList.remove('ok')},1200)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){window.prompt('Copy:',t)})}else{window.prompt('Copy:',t)}});`;

/**
 * Switching perspective: a tab swaps the video and keeps the moment, and the image link follows it so that link is
 * of what is on screen. All shows them together, lined up on the first.
 */
const CLIPS_SCRIPT = `(function(){var root=document.querySelector('[data-clips]');if(!root)return;var one=document.getElementById('clip');var all=document.getElementById('clips-all');var copy=document.querySelector('[data-image-link]');var dl=document.querySelector('[data-download]');var origin=copy?copy.getAttribute('data-copy').replace(/\\/g\\/[^/]*$/,''):'';function press(b){root.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b)})}function pick(b){var id=b.getAttribute('data-clip');press(b);if(id==='all'){one.pause();one.hidden=true;all.hidden=false;var vs=all.querySelectorAll('video');vs.forEach(function(v){if(!v.src)v.src=v.getAttribute('data-src');v.play().catch(function(){})});if(vs.length>1&&!all.dataset.synced){all.dataset.synced='1';vs[0].addEventListener('timeupdate',function(){var t=vs[0].currentTime;for(var i=1;i<vs.length;i++){if(Math.abs(vs[i].currentTime-t)>0.25&&t<(vs[i].duration||Infinity))vs[i].currentTime=t}})}return}all.hidden=true;all.querySelectorAll('video').forEach(function(v){v.pause()});one.hidden=false;var at=one.currentTime;one.src='/g/'+id+'.mp4';one.poster='/g/'+id+'.jpg';one.addEventListener('loadedmetadata',function f(){one.removeEventListener('loadedmetadata',f);if(at<(one.duration||0))one.currentTime=at;one.play().catch(function(){})});if(copy)copy.setAttribute('data-copy',origin+'/g/'+id+'.gif');if(dl)dl.setAttribute('href','/g/'+id+'.gif')}root.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-clip]');if(b)pick(b)})})();`;

export function sharePageHtml(g, origin) {
  const clips = notePerspectives(g);
  const many = clips.length > 1;
  const title = gifDisplayTitle(g);
  const summary = summaryOf(g);
  // A link preview shows a line or two; a description carrying a setpos per grenade is far longer.
  const plain = clip(descriptionPlain(g.description), 300);
  const image = `${origin}/g/${g.id}.gif`;
  const video = `${origin}/g/${g.id}.mp4`;
  const poster = `${origin}/g/${g.id}.jpg`;
  const round = g.file ? `/demos?round=${encodeURIComponent(g.file)}${g.fromTick ? `&tick=${g.fromTick}` : ''}` : '';
  const aspect = g.width && g.height ? g.width / g.height : 16 / 9;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)} | aim4</title>
<meta name="description" content="${escape(plain || summary)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="aim4" />
<meta property="og:title" content="${escape(title)}" />
<meta property="og:description" content="${escape(plain || summary)}" />
<meta property="og:url" content="${escape(`${origin}/g/${g.id}`)}" />
<meta property="og:image" content="${escape(poster)}" />
<meta property="og:image:type" content="image/jpeg" />
<meta property="og:video" content="${escape(video)}" />
<meta property="og:video:secure_url" content="${escape(video)}" />
<meta property="og:video:type" content="video/mp4" />
${g.width ? `<meta property="og:image:width" content="${g.width}" />\n<meta property="og:image:height" content="${g.height}" />\n<meta property="og:video:width" content="${g.width}" />\n<meta property="og:video:height" content="${g.height}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${escape(poster)}" />
<style>
  :root { color-scheme: dark; }
  @font-face { font-family: 'PP Monument Extended'; src: url('/fonts/pp/PPMonumentExtended-SemiBold.otf') format('opentype'); font-weight: 600; font-display: swap; }
  body { margin: 0; min-height: 100vh; background: #0b0b0c; color: #e9e9ea; font: 15px/1.5 system-ui, sans-serif; display: flex; justify-content: center; }
  /* As large as the window takes with the whole picture in view: people copy lineups off it. */
  main { width: min(100vw, calc((100vh - 104px) * ${aspect.toFixed(4)} + 32px)); padding: 16px; box-sizing: border-box; }
  video { display: block; width: 100%; height: auto; border-radius: 8px; background: #050505; }
  h1 { font: 600 20px/1.3 'PP Monument Extended', system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; margin: 16px 0 6px; }
  p { margin: 4px 0; white-space: pre-line; }
  a { color: #e9e9ea; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; font-size: 14px; }
  .desc { color: #e9e9ea; white-space: pre-wrap; }
  .tech { display: none; position: fixed; inset: auto 0 0 0; margin: 0; padding: 8px 16px; background: rgba(5, 5, 5, 0.88); color: #a3a3a8; font-size: 13px; text-align: center; }
  .alt .tech { display: block; }
  .ico { display: inline-flex; color: #a3a3a8; }
  .ico:hover, .ico:focus-visible { color: #fff; }
  .cp { padding: 0 2px; border: 0; border-radius: 4px; background: rgba(255,255,255,.06); color: #8ab4ff; font: 500 13px/1.5 ui-monospace, Menlo, Consolas, monospace; text-decoration: underline dotted; cursor: copy; }
  .cp.ok { color: #7bd88f; }
  .links { display: inline-flex; overflow: hidden; border-radius: 16px; }
  .link { padding: 6px 14px; border: 0; background: #e60611; color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
  .link + .link { box-shadow: inset 1px 0 0 rgba(255,255,255,.35); }
  .link.ok { background: #2e7d43; }
  video[hidden], .grid[hidden] { display: none; }
  .clips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .clips button { padding: 4px 10px; border: 1px solid #242424; border-radius: 6px; background: rgba(255,255,255,.03); color: #a3a3a8; font: 600 13px system-ui, sans-serif; cursor: pointer; }
  .clips button:hover { color: #fff; }
  .clips button.on { background: rgba(255,255,255,.1); color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
  .grid { display: grid; grid-template-columns: repeat(${clips.length > 4 ? 3 : clips.length > 2 ? 2 : 1}, minmax(0, 1fr)); gap: 4px; }
  .grid figure { position: relative; margin: 0; min-width: 0; }
  .grid video { aspect-ratio: 16 / 9; object-fit: contain; }
  .grid figcaption { position: absolute; left: 4px; bottom: 4px; padding: 2px 6px; border-radius: 4px; background: rgba(5,5,5,.72); font-size: 12px; }
</style>
</head>
<body>
<main>
  <video src="/g/${escape(g.id)}.mp4" id="clip" poster="/g/${escape(g.id)}.jpg" aria-label="${escape(title)}" width="${g.width || ''}" height="${g.height || ''}" autoplay loop muted playsinline></video>
  ${
    many
      ? `<div id="clips-all" class="grid" hidden>${clips.map((c) => `<figure><video data-src="/g/${escape(c.id)}.mp4" poster="/g/${escape(c.id)}.jpg" loop muted playsinline></video><figcaption>${escape(perspectiveLabel(c))}</figcaption></figure>`).join('')}</div>
  <div class="clips" data-clips>${clips.map((c, i) => `<button type="button" data-clip="${escape(c.id)}"${i === 0 ? ' class="on"' : ''}>${escape(perspectiveLabel(c))}</button>`).join('')}<button type="button" data-clip="all">All</button></div>`
      : ''
  }
  <h1>${escape(title)}</h1>
  ${g.description ? `<p class="desc">${descriptionHtml(g.description)}</p>` : ''}
  <div class="row">
    <span class="links"><button type="button" class="link" data-copy="${escape(`${origin}/g/${g.id}`)}" title="Copy a link to this page">Share</button><button type="button" class="link" data-copy="${escape(image)}" data-warm data-image-link title="The GIF file itself, which plays wherever it is pasted">Copy image URL</button></span>
    ${round ? `<a class="ico" href="${escape(round)}" title="Open the round" aria-label="Open the round">${ICON_PLAY}</a>` : ''}
    <a class="ico" href="/g/${escape(g.id)}.gif" download data-download title="Download" aria-label="Download">${ICON_DOWNLOAD}</a>
    <a class="ico" href="/" title="aim4.io" aria-label="aim4.io">${ICON_HOME}</a>
  </div>
</main>
${summary ? `<p class="tech">${escape(summary)}</p>` : ''}
<script>${COPY_SCRIPT}${ALT_SCRIPT}${many ? CLIPS_SCRIPT : ''}</script>
</body>
</html>`;
}

/** Handles /g/<id> and its files. Resolves true when it answered. */
export async function handleGifShare(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = url.pathname.match(/^\/g\/([a-f0-9]{16})(?:\.(gif|mp4|jpg))?\/?$/);
  if (!m) return false;
  const { user } = await identify(req);
  if (m[2]) return sendGifMedia(req, res, user, m[1], m[2]);
  const g = await gifRecord(user, m[1]);
  if (!g) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('That GIF does not exist, or it was deleted.');
    return true;
  }
  const html = sharePageHtml(g, originOf(req));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'public, max-age=300'
  });
  res.end(req.method === 'HEAD' ? undefined : html);
  return true;
}
