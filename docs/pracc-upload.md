# Upload PRACC demos to aim4

An **Upload** button beside each demo's DEMO button on the Demos tab of
[pracc.com/team/server](https://pracc.com/team/server). A click sends that demo to aim4. The aim4 server
downloads it, unpacks it, parses it, deletes the archive and the raw demo, and keeps the parsed rounds
in the library.

## Install

The route and the script both ship with the site, so this needs a deploy first.

1. Install Tampermonkey: [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/) or
   [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Chrome only: open `chrome://extensions`, then Tampermonkey's **Details**, and turn on
   **Allow User Scripts**. On older Chrome versions, turn on **Developer mode** at the top right of
   `chrome://extensions` instead. Without this Tampermonkey runs no scripts at all.
3. Open <https://aim4.io/tools/aim4-pracc.user.js>. Tampermonkey shows its install page. Click **Install**.
4. Sign in at [aim4.io](https://aim4.io) in the same browser. The account needs Google or Steam linked,
   like any upload.

To try it before a deploy, open Tampermonkey's dashboard, choose **+** to create a script, and paste in
`public/tools/aim4-pracc.user.js`.

## Use

Open the Demos tab and click **Upload** on the demos you want. Each button shows its own progress
(`Queued`, `64%`, `Unpacking`, `Round 7/24`), then `In aim4` or `Failed`. A failure's reason is on the
button's tooltip and under the list.

You can close the tab once a button shows progress: the server keeps going. Clicking again is always
safe, because a demo already in the library is not downloaded twice. That includes `In aim4`, which
checks again, so a demo you deleted from aim4 can be sent back that way.

If your aim4 session has expired, a background aim4 tab opens for a moment to renew it and closes itself.
If you are signed out of aim4, that tab stays open: sign in there and click Upload again.

## How it works

PRACC's DEMO button navigates to a `DownloadUrl` that comes from `GET /api/team/server/demos`. That
URL is a `pracc.com/api/...` address that needs the PRACC cookie, and it redirects to an S3 presigned
link: SigV4 over the `host` header only, valid for one hour, with no cookie and no client address in
the signature. So:

- The browser reads the list and follows each redirect using your PRACC session, on pracc.com, asking
  for one byte and hanging up at the headers. It sends aim4 **only the signed links** it ended up on.
  Your PRACC session never reaches aim4.
- The browser remembers which rows aim4 has confirmed, so they say `In aim4` when the page loads.
- The aim4 token travels only in an `Authorization` header. It is the one-hour access token, copied
  from your aim4.io session into Tampermonkey's storage. The refresh token is never copied.
- Status polling needs no token, because an import can outlast the one that started it. The status
  id is 128 random bits and the answer holds no links.

### Which demos

The one you click. Row ids are not in the page's DOM, so a button is matched to its row by position in
the list, with the same filter the page applies, and checked against the team names shown. If a new demo
has landed since the page loaded the buttons step aside and the page asks to be reloaded, rather than
risk sending the wrong demo.

### On the server (`server/replays/praccImport.js`)

    POST /api/replays/pracc/imports       { demos: [{ uid, url, label }], visibility? }   (up to 100)
    GET  /api/replays/pracc/imports/:id   progress per demo

Downloads run one at a time and ahead of parsing, holding the compressed file on the volume. Links
die after an hour and parsing takes longer than that for a month of demos, so downloads must not
wait for the parser. Each file then goes to `startIngest`, the path every normal upload takes, once
the parse queue has room. Demos arrive `private`.

| State | Meaning |
| --- | --- |
| `queued` | waiting for its turn to download |
| `downloading` | `received` and `total` show bytes |
| `waiting` | on disk, waiting for the parse queue |
| `unpacking`, `parsing` | `round` and `rounds` show progress |
| `done` | in the library, `demoIds` says where |
| `duplicate` | already in the library, nothing was kept |
| `failed` | see `reason` and `error` below |
| `refused` | the link was turned down before anything was fetched |

| Reason | Meaning |
| --- | --- |
| `no_link` | PRACC would not give the browser a signed link for this row |
| `host_not_allowed` | not a known PRACC storage location; the error names it |
| `bad_url` | not https, a login or port in the link, an IP address, a name resolving to a private address, or too many redirects |
| `link_expired` | the host answered 401 or 403. The button fetches fresh links and re-sends these, up to three times |
| `missing` | the host answered 404 |
| `too_large` | over `AIM4_PRACC_MAX_BYTES` or the storage left |
| `not_a_demo` | the bytes are not a demo or an archive |
| `blocked` | the host answered with a bot check. aim4 does not try to get past these |
| `source_unavailable` | network failure or a 5xx |
| `parse_failed` | downloaded fine, the parser refused it |
| `unsupported_map` | a map the viewer does not cover. Remembered for a week, so later clicks do not fetch it again |
| `limit`, `link_required` | the same plan and account gates as any upload |

### What stops this being used to fetch anything else

- A link must be https on port 443, with no login in it, no IP address, and no encoded slashes.
- Its host **and bucket** must be on the list. `fsn1.your-objectstorage.com` is shared by all Hetzner
  customers, so the host alone would allow every bucket on it.
- Every redirect target passes the same check before anything connects to it.
- The socket's own DNS lookup refuses a name with any private, loopback, link-local or similar address,
  so a name that changes its answer between check and connect gets nowhere.
- Nothing from the response is ever sent back to the caller. It is written to disk only after its first
  bytes prove to be a demo or an archive, and the size cap holds while it streams.
- Links are never logged or written to disk.

### Knowing a demo is already there

The key is the file id in the link's path, which stays the same when the signature changes. It is
checked against a ledger (`.pracc-imports.json` in the replay root) confirmed against the record, so
a deleted demo can come back, and against library file names, which catches copies uploaded by hand
after unpacking with 7-Zip. A copy under any other name is caught by the normal identity check after
parsing, and is remembered so it is not fetched again.

The library is shared and the duplicate check does not look at who can see a copy. If a teammate
already imported a scrim as private, your click reports `duplicate` even though you cannot see that
copy. Manual uploads behave the same way.

## If something goes wrong

- **After a deploy, check the host can unpack `.bz2`:** `GET /api/replays/status` should show
  `"bz2":{"available":true,...}`. It uses `bsdcat` from `libarchive-tools`, already in `nixpacks.toml`
  and the `Dockerfile`.
- **`aim4 does not fetch demos from <place>`:** PRACC moved its storage, as it did from R2 to Hetzner in
  2026. Add the place to `AIM4_PRACC_DEMO_SOURCES` and restart.
- **`Click Upload again`:** the server restarted and lost its in-memory queue. Nothing is lost, and leftover
  temp files are swept at startup.

## Tests

    node server/replays/praccImport.test.js
    node scripts/pracc-import-e2e.mjs <path to a real .dem.bz2>

The first plays the storage host locally and covers the refusals and the queue. The second runs a real
demo through download, unpack and the real parser in a temp library. Both need a bz2 tool on `PATH` for
their `.bz2` parts.
