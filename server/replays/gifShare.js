// ---------------------------------------------------------------------------
// server/replays/gifShare.js
// A saved GIF at its share link, for anyone who has it.
//
//   /g/<id>.gif   the image itself: pasted into Discord, Slack or a forum it
//                 embeds and plays like any image link
//   /g/<id>       a page with the GIF, its title and description, and the
//                 link-preview tags pointing at the image, so this link
//                 previews as the GIF too
//
// No sign-in and no listing: the 16 random hex characters are the secret.
// ---------------------------------------------------------------------------

import { identify } from './auth.js';
import { gifRecord, readGifFile } from './gifStore.js';
import { descriptionParts, descriptionPlain, gifDisplayTitle } from '../../src/replays/gif/gifMeta.js';

const escape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The image bytes, cached hard: a share id never points at different bytes. */
export function sendGifBytes(req, res, buf) {
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/** At most `max` characters, cut at a word with an ellipsis. */
const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`);

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('That GIF does not exist, or it was deleted.');
}

/** This server's own origin as the client reached it, for absolute preview links. */
function originOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'aim4.io').split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** The share page's line under the title: map, round, teams, who won. */
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

/** One listener for every copy link; a button that copied says so for a moment. */
const COPY_SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-copy]');if(!b)return;e.preventDefault();var t=b.getAttribute('data-copy');var done=function(){b.classList.add('ok');setTimeout(function(){b.classList.remove('ok')},1200)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){window.prompt('Copy:',t)})}else{window.prompt('Copy:',t)}});`;

export function sharePageHtml(g, origin) {
  const title = gifDisplayTitle(g);
  const summary = summaryOf(g);
  // A link preview shows a line or two; a description carrying a setpos per grenade is far longer.
  const plain = clip(descriptionPlain(g.description), 300);
  const image = `${origin}/g/${g.id}.gif`;
  const round = g.file ? `/demos?round=${encodeURIComponent(g.file)}${g.fromTick ? `&tick=${g.fromTick}` : ''}` : '';
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
<meta property="og:image" content="${escape(image)}" />
<meta property="og:image:type" content="image/gif" />
${g.width ? `<meta property="og:image:width" content="${g.width}" />\n<meta property="og:image:height" content="${g.height}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${escape(image)}" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; background: #0b0b0c; color: #e9e9ea; font: 15px/1.5 system-ui, sans-serif; display: flex; align-items: center; justify-content: center; }
  main { width: min(100%, ${Math.max(320, g.width || 960)}px); padding: 24px 16px; box-sizing: border-box; }
  img { display: block; width: 100%; height: auto; border-radius: 8px; background: #050505; }
  h1 { font-size: 18px; margin: 14px 0 4px; }
  p { margin: 4px 0; color: #a3a3a8; white-space: pre-line; }
  a { color: #e9e9ea; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 10px; font-size: 14px; }
  .desc { color: #e9e9ea; white-space: pre-wrap; }
  .cp { padding: 0 2px; border: 0; border-radius: 4px; background: rgba(255,255,255,.06); color: #8ab4ff; font: 500 13px/1.5 ui-monospace, Menlo, Consolas, monospace; text-decoration: underline dotted; cursor: copy; }
  .cp.ok { color: #7bd88f; }
  .links { display: inline-flex; overflow: hidden; border-radius: 16px; }
  .link { padding: 6px 14px; border: 0; background: #e60611; color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
  .link + .link { box-shadow: inset 1px 0 0 rgba(255,255,255,.35); }
  .link.ok { background: #2e7d43; }
</style>
</head>
<body>
<main>
  <img src="/g/${escape(g.id)}.gif" alt="${escape(title)}" width="${g.width || ''}" height="${g.height || ''}" />
  <h1>${escape(title)}</h1>
  ${summary ? `<p>${escape(summary)}</p>` : ''}
  ${g.description ? `<p class="desc">${descriptionHtml(g.description)}</p>` : ''}
  <div class="row">
    <span class="links"><button type="button" class="link" data-copy="${escape(`${origin}/g/${g.id}`)}" title="A link to this page">Page link</button><button type="button" class="link" data-copy="${escape(image)}" title="The GIF file itself, which plays wherever it is pasted">Image link</button></span>
    ${round ? `<a href="${escape(round)}">Open the round</a>` : ''}
    <a href="/g/${escape(g.id)}.gif" download>Download</a>
    <a href="/">aim4</a>
  </div>
</main>
<script>${COPY_SCRIPT}</script>
</body>
</html>`;
}

/** Handles /g/<id> and /g/<id>.gif. Resolves true when it answered. */
export async function handleGifShare(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = url.pathname.match(/^\/g\/([a-f0-9]{16})(\.gif)?\/?$/);
  if (!m) return false;
  const { user } = await identify(req);
  if (m[2]) {
    const buf = await readGifFile(user, m[1]);
    if (!buf) notFound(res);
    else sendGifBytes(req, res, buf);
    return true;
  }
  const g = await gifRecord(user, m[1]);
  if (!g) {
    notFound(res);
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
