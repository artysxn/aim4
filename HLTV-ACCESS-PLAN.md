# Getting demos into aim4: the access problem

The ingest pipeline is built and working. The only missing piece is a supply of
archives. This document is about where they come from.

**Written 2026-08-03.** Companion to `HLTV-INGEST-PLAN.md`, which covers the
pipeline itself.

---

## 1. Where we actually are

`sources/hltv.js` is written and correct, and it cannot run. Every hltv.org
endpoint returns **403 with a Cloudflare managed challenge** to any non-browser
client, `/robots.txt` included. Their `/terms` page returns 403 to automated
fetches too, so the crawl rules cannot be read even to comply with them.

The pipeline itself is source-agnostic and proven: two real matches, four maps,
correct team names, sources deleted, disk flat. Whatever supply we pick, only
the source module changes.

### The line this document will not cross

The request was "bypass Cloudflare". I will not plan that, and it is worth being
precise about why rather than just refusing.

A managed challenge is not a rate limit that we are hitting too hard. It is
HLTV, through Cloudflare, saying *no automated clients*. Getting past it
requires solving the challenge, spoofing a browser's TLS/JA4 fingerprint,
driving a stealth headless browser, or rotating IPs when banned. All four are
circumvention of an access control, all four escalate if noticed, and the
realistic outcome is HLTV blocking the aim4 production IP. Given aim4 is a
commercial product with a paying tier, that is a bad trade against any amount of
engineering effort.

**Enumerating `/download/demo/<id>` directly is the same thing.** The ids look
sequential (your example is `109970`), so in principle you could skip the match
page. But that endpoint is challenged too, and blind enumeration is a
higher-volume, lower-signal version of the same unwanted traffic. It is not a
loophole, it is the same door with more knocking.

### 1.1 The R2 direct link is not a way in either. Tested.

A human-verified direct link looks like it should sidestep the site entirely:

```
https://r2-demos.hltv.org/demos/128974/blast-bounty-...-spirit-vs-mouz-bo5--wn1awkp4iFRmswi58ug57.rar
```

It does not. Measured 2026-08-03:

| Check | Result |
|---|---|
| `HEAD` on the R2 URL | **403**, header `cf-mitigated: challenge` |
| First bytes of the "archive" | `<!DOCTYPE html><html lang="en-US"` — the challenge page, not `Rar!` |
| `GET /download/demo/109950`, no redirect follow | **403**, and **no `Location` header at all** |
| `dig r2-demos.hltv.org` | `104.18.41.212`, `172.64.146.44` |
| `dig www.hltv.org` | `172.64.146.44`, `104.18.41.212` |

Same Cloudflare IPs means the same zone and the same bot policy. `r2-demos` is
not a separate unprotected bucket, it is another hostname behind the same rules.

**Why it works in a browser and not in a script:** passing the challenge on
hltv.org sets a `cf_clearance` cookie scoped to the whole `hltv.org` zone, which
therefore covers `r2-demos.hltv.org`. A human who has browsed the site carries
that cookie and sees a clean download. A script has never been issued one.

Two further reasons enumeration cannot work even in principle:

- The redirect **never happens** for an unclearanced client. There is no
  `Location` to follow, so the R2 URL is undiscoverable from the demo id.
- The R2 path carries an unguessable token (`wn1awkp4iFRmswi58ug57`, 21
  mixed-case alphanumerics, on the order of 125 bits) and its own id (`128974`)
  which is *not* the download id (`109950`). Nothing derives one from the other.

Lifting `cf_clearance` out of a browser into a script is not a fix: it is
straightforwardly circumvention, and Cloudflare binds the cookie to the client's
IP, User-Agent and TLS fingerprint, so it would fail from the server anyway.

What follows is the set of paths that actually lead somewhere.

---

## 2. The options

| # | Path | Works now | Cost | Corpus | Risk |
|---|---|---|---|---|---|
| 1 | Assisted drop (built) | **Yes** | Your time | Anything you can download | None |
| 2 | Ask HLTV | Weeks | Probably free | HLTV pro matches | None |
| 3 | FACEIT Downloads API | ~30 days | Free | FACEIT matches, not pro | None |
| 4 | Better-CS-API (reseller) | Same day | ~$0.01/demo | HLTV pro matches | **Real** |
| 5 | Verified-bot registration | Weeks | Free | Enables 2 | None |
| 6 | Browser-assisted capture | Days | Your time | HLTV pro matches | Grey |

### Option 1: Assisted drop — already working

The `local` source watches a directory. You download in a browser as you already
do; the ingester picks up the archive, parses it, names the teams from the
filename, and deletes it. No HLTV automation is involved at any point, because
you are the client.

This is not a workaround, it is a legitimate mode. It is how the two test
matches were processed, and the naming works entirely offline because HLTV's own
filenames carry the metadata.

Two small additions would make it comfortable at volume:

- **A drop zone in the admin panel.** An upload box that writes into the inbox,
  so you can feed it from any machine without shell access. Reuses the existing
  upload plumbing in `routes.js`.
- **A watched cloud folder.** Point `AIM4_INGEST_INBOX` at a synced directory
  (Dropbox, rclone, an S3 mount). You drag archives in on your laptop, the
  server picks them up. About an hour of work, no new moving parts.

Rate: you can realistically queue tens of matches per sitting. Not a 15,000
match backfill, but it makes the pipeline useful this week.

### Option 2: Ask HLTV — the actual answer for HLTV data

HLTV A/S is a Danish company and they have no public API or partner programme,
so this is an email rather than a form. What makes it plausible: you are not
asking to republish their site, you want match demos, which are already free
downloads, for analysis in a product that sends people back to those matches.

Ask for a specific, small, boring thing:
- a documented rate (one request every N seconds), from one named IP
- a stable User-Agent with a contact address
- optionally a bulk archive or feed instead of crawling

Worst case they say no and you have a clear answer instead of an open question.
This is the only path that ends with "we are allowed to do this", which matters
for something running continuously inside a commercial product.

### Option 3: FACEIT Downloads API — official, free, different corpus

FACEIT has a real, documented Downloads API. Demo URLs come back in the Matches
endpoint, the Downloads API converts a resource URL into a signed URL, and a
"Match Demo Ready" webhook fires when a demo is uploaded. Access needs an
application form; the stated response time is 30 days.

The catch is the corpus. This is FACEIT matches, mostly pugs and FPL, not the
tier-1 tournament matches HLTV carries. If aim4's value is pro-match analysis,
this does not replace HLTV. If volume of high-level CS2 data is what matters, it
is a much larger and entirely legitimate firehose, with a webhook that fits our
continuous poll better than crawling does.

**Worth applying for regardless.** The 30-day clock starts when you send it, it
costs nothing, and the pipeline already supports a second source.

### Option 4: Better-CS-API — fast, cheap, and the one to think hardest about

A commercial reseller that fronts HLTV (and FACEIT) as a developer API,
including demo downloads, at roughly **$0.0012 per request and $0.01 per demo
download** on the $50+ tier. For a 15,000 match backfill that is about $150,
which is nothing, and it would work this afternoon.

The problem is stated on their own front page: *not affiliated with HLTV,
Faceit, Valve, Steam, or other services.* They are almost certainly doing the
scraping we have just decided not to do, and reselling it. Buying from them does
not make the collection authorised, it moves it one step away and adds a
dependency that can vanish the moment HLTV sends a letter.

Not an automatic no. It is a normal commercial risk decision and it is yours to
make, not mine. If you take it, take it knowingly: budget for the supply
disappearing, and do not build anything that only works if they exist. The
pipeline's source abstraction already gives you that insulation.

### Option 5: Cloudflare Verified Bot — the legitimate version of "get past Cloudflare"

This is the useful thing the research turned up. Cloudflare runs a **verified
bots** programme: operators register a crawler, and site owners can then
allowlist it. The requirements are honest self-identification (a Web Bot Auth
signature, a published IP list with a stable User-Agent, or reverse DNS),
obeying robots.txt, reasonable request rates, and not evading owner preferences.
Approval takes a few weeks.

Read that list again: our `fetcher.js` already does all of it except the
registration. We are, technically, already a well-behaved crawler; we are simply
an anonymous one, and anonymous is indistinguishable from malicious.

The honest caveat: being verified means Cloudflare *can* recognise us, not that
HLTV *will* allow us. The allowlist is the site owner's choice. So this is not an
alternative to option 2, it is what makes option 2 easy to say yes to. "We are a
registered crawler, here is our IP and contact, please allowlist us" is a very
different email from "please let our script in".

**Do 5 and 2 together.**

### Interlude: how do competitors do it?

Products like CS2Lens advertise HLTV integration, so it is clearly achievable.
I could not find a public statement of their method, and I am not going to
assert one. What the measurements above do tell us is which explanations are
still standing:

- **An agreement with HLTV.** Most likely for a serious commercial product, and
  invisible from outside. This is option 2.
- **A real browser.** Headless Chrome with a genuine fingerprint holds a
  `cf_clearance` cookie and sails through. Effective, and it is circumvention
  when the browser is a server pretending to be a person.
- **A reseller.** Someone else does the collection and sells the result. Option 4.
- **The user supplies it.** "HLTV integration" can mean the user pastes a link
  or uploads a file, with their browser doing the fetch. Option 1 and option 6.

The thing not to conclude is "a competitor does it, therefore it is allowed".
If they are driving a stealth browser they are carrying that risk, and it is not
visible in their marketing copy. Being second to get blocked is no better than
being first.

### Aside: gigobyte/HLTV, the popular Node library

Investigated 2026-08-03. Verdict: **not an access solution, but a good parser to
adopt the day we have access.**

| Check | Finding |
|---|---|
| Demo download | **None.** It parses metadata; it cannot fetch a `.rar` |
| Default transport | `got-scraping` (Apify), i.e. browser JA3/JA4 TLS impersonation |
| Maintenance | README: "no longer actively maintained" |
| Last release | v3.5.0, **2023-09-20**. Last push 2025-03-03 |
| Open issues | 15, including unmerged parser fixes from 2025-09 |
| Its own README | Warns that abuse "will likely result in an IP ban from HLTV" |
| Issue history | Cloudflare blocks 2021-2024, incl. #737 "hltv has strengthened its protection against scraping" |

Two things follow. First, it does not address our actual problem: we need 500 MB
archives, and this library only reads pages. Second, adopting it wholesale would
mean doing the TLS-fingerprint circumvention by proxy, via a dependency, which
is the same act with an extra layer of indirection. Apify's own guidance notes
that `got-scraping` handles sites whose defence is TLS fingerprinting and that
aggressive JavaScript challenges still need full browser automation. HLTV serves
a **managed challenge**, which is the second kind, so it likely would not work
now regardless.

**The part worth keeping:** `loadPage` is pluggable, so its parsers are
separable from its transport. If HLTV allowlists us, we can drop in an honest
fetch and reuse gigobyte's selector logic instead of maintaining our own. That
directly retires the biggest maintenance risk in `sources/hltv.js`, which is
that HLTV markup changes and our hand-written selectors rot. Worth doing then,
worth nothing now.

### Option 6: Browser-assisted capture — grey, and I would not lead with it

A userscript or extension running in your own logged-in browser, walking results
pages at human pace and pushing archives to aim4's upload endpoint.

It is not circumvention: it is your browser, your session, a challenge you
passed yourself. But it is still bulk automated collection wearing a person's
face, and it is exactly what the ToS would object to if anyone read it closely.
It also ties throughput to a machine being awake with a browser open.

Listed for completeness because it is technically the fastest unblocked route to
HLTV specifically. If you want it, it is your call and I will build it, but it
should be a deliberate choice rather than the default.

---

## 3. What I would do

1. **Today.** Add the admin drop zone and the watched-folder inbox (option 1).
   Small, no risk, makes the pipeline immediately useful and exercises the
   ingester against real volume so we learn the true parse rate and compression
   ratio.
2. **This week.** Send the FACEIT Downloads API application (option 3) and the
   Cloudflare verified-bot registration (option 5). Both are free, both have
   multi-week clocks, both are strictly better started now.
3. **This week.** Email HLTV (option 2), citing the verified-bot registration.
4. **Decide separately.** Better-CS-API (option 4) is a business call about
   vendor and legal risk, not an engineering one. It is the only same-day route
   to a full HLTV backfill, and it is the only option here with a real downside.

The pipeline does not care which of these lands. Each is a `sources/*.js` file
implementing `check()`, `discover()` and `fetchArchive()`, and the ledger, the
naming, the cleanup, the admin page and the supervisor are all already done.

---

## 4. Work items, if you want them built

| Item | Where | Size |
|---|---|---|
| Admin drop zone (upload into the inbox) | `ingestPanel.js`, `admin/routes.js` | ~2h |
| Watched cloud folder | config only, plus docs | ~1h |
| `sources/faceit.js` + webhook receiver | new file, `routes.js` | ~1d |
| `sources/betterCsApi.js` | new file | ~3h |
| Web Bot Auth signing in `fetcher.js` | `fetcher.js` | ~3h |
| `sources/browserAssist.js` + userscript | new files | ~1d |

Nothing above touches the pipeline, the ledger, the naming or the admin page.

---

## Sources

- [FACEIT Downloads API](https://docs.faceit.com/getting-started/Guides/download-api/)
- [FACEIT Data API](https://docs.faceit.com/docs/data-api/data/)
- [Cloudflare verified bots](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/)
- [Cloudflare: how to manage good bots](https://www.cloudflare.com/learning/bots/how-to-manage-good-bots/)
- [Cloudflare: announcing Friendly Bots](https://blog.cloudflare.com/friendly-bots/)
- [Better-CS-API](https://better-cs-api.com/)
- [HLTV terms of service](https://www.hltv.org/terms) (403s to automated fetches; read it in a browser)
