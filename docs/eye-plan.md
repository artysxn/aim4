# aim4 eye: plan of action

Status: plan only. Nothing below is built unless marked done.
Source: the 17 Oct 2026 test chat (PDF), with the user's notes and follow-up requests.

---

## Fixes from the second test chat (exported 17 Oct, `aim4-eye_what-ai-model-are-you`)

### What went wrong, and why

| # | Seen in the chat | Cause found in the code |
|---|---|---|
| C1 | "Pick a random game" gave round 1 of the first match in the list; "I said game, not round" | No match-level tool. `find_rounds` only lists rounds, and `limit: 1` takes the first, not a random one. |
| C2 | "Phantom vs fnatic on Ancient, score?" The model made "3-2" from rounds 1 and 5 of one match plus rounds 2, 3 and 4 of another | The match a round belongs to is the `~<demoId>` suffix of its file, and no tool exposes it. The model guessed a match id from the file prefix (`AVg-CNh`), which only names the two teams. |
| C3 | `find_rounds` with team Phantom and opponent fnatic also returned Phantom vs Voca, Nemiga, SINNERS and so on | The opponent's ids were added to the server's teams filter, which matches a round when either side is in it, so the opponent filter widened the search instead of narrowing it. |
| C4 | "Top performer" was totalled from kill lines in 3 sampled rounds | No per-match player stats tool. The Database tool pools many matches, and nothing tells the model not to add up a sample. |
| C5 | "23 rounds, beyond the 15-15 tie point; 12-11 is a complete match" | No CS2 format facts in the prompt (MR12: first to 13, 12-12 goes to overtime). |
| C6 | Answers to a match question used the antistrat sheet; the user said "I didn't ask you about antistrat" | No routing rule for match questions, so the general "overview: antistrat_summary" rule won. |
| C7 | "Can you watch a game?" answered no, and listed tool names in backticks | Prompt has no capability answer and no rule against naming tools. |
| C8 | Many answers end with "Would you like me to 1. 2. 3." | No rule against option menus. |
| C9 | Long monologues before tool calls ("Wait, I think I understand… Actually…"), and the last answer was one | With Think longer off, the model plans in visible text. Its own earlier narration is fed back to it each step, which reinforces it. |
| C10 | "Analysis document for the T side" produced a document with both sides | `create_antistrat_document` has no side option. |
| C11 | "Review it" reviewed an older, undated "Summary: The Golden Horde on Cache", not the "(18 Oct)" one just created | `documentOf` prefers an exact title over a newer document whose title only adds the date. |
| C12 | The review reported 47 issues, many false: "A contact … repeats B contact …", "3 of 4 is 81%" where 81% was a different figure | (1) `similarity` drops words under 3 letters, so A/B/T/CT are ignored and A and B points look the same. (2) The arithmetic check pairs any "a of b" with any percentage in the point, even unrelated ones. |
| C13 | The rewrite refused 63 ("5 of 8, 63%"), the correct value the review itself gave | Allowed numbers were the document, the sheet and this turn's tools. The review was in the previous turn, and its issue texts (with corrected numbers) were never kept. A percentage computed from counts in the same point also counts as invented. |
| C14 | After two refusals, every later rewrite (other sections, other numbers) was blocked as "failed the same way twice" | The repeat-error guard blocked by tool and title alone, ignoring the sections, so any call to that document was blocked. |
| C15 | The rewrite, sent in parts without `final: false`, saved two separate partial "Reviewed:" documents | Each call without `final: false` saved a new copy. |
| C16 | The export showed shortened tool results ("… [shortened to save space]") | Shortening edits the message in place, so the original was gone for the export. The model also lost the review's issue list this way. |
| C17 | "T T Pace", "T T Positions" section names | `antistrat_summary` prefixes the side to a section name that already has it. |

### Fixes (built 18 Oct)
1. **Matches:**
   - `list_matches`: team, opponent, map, random, newest first, with labels like "Phantom vs fnatic, Ancient, 12 Oct" and a match id.
   - `match_summary`: score, halves, rounds in the library, whether the match looks complete, round-by-round winners, and player stats for that match only (rating, kills, deaths, ADR, KAST).
   - `find_rounds` gets a `match` filter and returns each round's match, and the opponent filter now requires both teams.
   - The prompt routes game/match questions to these tools and gives the CS2 format (MR12, overtime MR3).
2. **Documents:**
   - Matching ignores the date in titles, so the newest wins.
   - `create_antistrat_document` takes `side` and returns the id.
   - A rewrite in several calls updates one "Reviewed:" copy.
   - The number check accepts percentages computed from counts in the same point, and numbers from the stored review issues.
3. **Review:**
   - Site and side letters count in similarity.
   - Arithmetic only pairs a percentage with the count next to it.
   - All-zero points are not flagged as unbacked.
4. **Agent loop:**
   - The repeat-error guard blocks only a call with identical arguments, or a tool that failed 4 times this turn.
   - Narration before tool calls is no longer sent back to the model.
   - Shortened results keep the original for export.
5. **Prompt:**
   - Capability answer, with no tool names or file names.
   - No option menus, and no planning in the answer.
   - Match routing, CS2 format facts, and never totalling a statistic from sampled rounds.
   - A document just created comes from current data.

## Strategies are the execute, from the call (fixed 18 Oct)

- **Seen:** asked for the Phantom vs fnatic round 3 B execute "from around 0:30", the model wrote every player's whole round from 1:55, including routes, deaths and "die at", and linked no grenades.
- **Cause 1, the wrong round.** Two Phantom vs fnatic Inferno games from the same day both had the name "Phantom vs fnatic, Inferno, 17 Oct". The model showed round 3 of one and drafted round 3 of the other, an A take that ended at 0:30. The clocks were fine: the player and the round record agree.
- **Cause 2, the draft.** The draft covered the whole round and said nothing about where the execute is.
- **Fixes:**
  - Matches with the same teams, map and day are named "(game 1)", "(game 2)".
  - Showing a round tells the model its match id and number, to reuse when the user picks it.
  - `strategy_draft` finds the execute: the densest burst of the side's utility, at least 3 grenades from 2+ players within 8 s, the later burst on a tie. The user's own start clock is used when given.
  - The window opens 4 s before the call. The draft returns where each column's player waits at the call, each grenade's clock and throw spot, and how many earlier grenades were left out.
  - Notes are written from the call with exact times and no deaths. A grenade of the player named in plain words is linked automatically.
  - The timeline names moves by callout (Car, Pit, Bottom mid), not zone groupings ("Mid + A", "T_A").
  - `query_rounds` with team "all" ignores group_by.
- **Real data:** game 2, round 3 gives call_at 0:24, 6 grenades from 4 players between 0:24 and 0:17, 7 earlier grenades left out, and setups at Sandbags, Car, Banana top and Banana. Game 1, round 3 gives an A execute at 1:03 (9 grenades).

## The 400 after "best B executes on Inferno" (fixed 18 Oct)

- **Cause:** the model read 11 teams' antistrat sheets in one step, up to 12,000 characters each, which overflowed the model's 32k-token context, and llama-server answered 400.
- **Why every later message also failed:** the latest tool step was never shortened. After the failed turn, that step (the 11 sheets) was still the latest one, so it went into every following request whole.
- **Fixes:**
  - Only the current question's latest step is protected. When even that does not fit the budget, its largest results are shortened too.
  - On a 400 the agent shortens everything to half the budget and retries once, then says to /compact or start a new chat.
  - `query_rounds` takes `team: "all"`: one call ranks every team with 2+ demos on the map. On real data, best B executes on Inferno was 1.5k characters in 14 s: Phantom 5 of 6, HAVU 3 of 6, The Golden Horde 2 of 4, EAC 1 of 3, fnatic 1 of 1 (too few to rank).
  - `query_rounds` returns example rounds by match and number, so "find any B execute round" can open, show or write one up.
  - The prompt routes team comparisons to `team: "all"` and forbids reading several teams' sheets.

## Rounds in the chat, and model-written strategies (built 18 Oct)

- **Before this:** screenshots only appeared inside a collapsed tool line, and there was no round player. Phase 4 had not been built.
- **`show_round`** puts a round in the chat as a small radar player (`eyeRoundPlayer.js`).
  - Controls: play/pause, scrubber, 1x/2x/4x speed, Open in the full viewer, click to enlarge (names show when large).
  - `at` opens it paused, as a still.
  - It loads when scrolled into view, and only one plays at a time.
  - It is drawn by the viewer's `RadarRenderer`, and it is offered with or without vision.
- **`screenshot_round` with `show: true`** shows the moment the model looked at, as the same widget paused at that clock.
- **Saved chats** keep the widget on the tool message (`ui.widget`, never sent to the model) and draw it again on reopen.
- **`strategy_draft` and `save_strategy`** write a round into the team stratbook the way the in-demo tool does (`addStrategy.js`):
  - players seated into the map's columns by the same role ruleset
  - grenades folded into the utility archive before the notes, so links point at real throws
  - the round linked as the 2D view
  - **the difference:** the notes are written by the model from `round_timeline`, not by `roundNarrative.js` rules. The draft lists each grenade with a tag (t1, t2, ...); the model links them as `<Window smoke><!t3>`; save turns tags into archive ids and drops unknown ones to plain text. Call and economy types are the stratbook's own lists.
- **Checked on real data** (a Cache round from the local server, headless Edge, team and stratbook writes intercepted): the player draws, plays, scrubs and changes speed; the draft seats 5 players and names 11 grenades; the save writes the archive, then the strategy with real ids.
- **Not checked:** a strategy saved for real into your stratbook, and the model's own note writing.

## Fixes from the third test chat (`aim4-eye_what-differentiates-round-15`, 17 Oct)

The question: what differentiates round 15 of The Golden Horde vs GenOne from round 4 of The Golden Horde vs ynkesu (both on Cache). Your correct answer was about setups, map control, utility, timing and the defenders' stack. The model answered with buys, sides and winners, called round 15 "missing" and round 13 "overtime", and described a passive round as "a fast push".

| # | Seen | Cause |
|---|---|---|
| D1 | It saw rounds 2 to 13 of a 20-round match and said round 15 was not in the library | `find_rounds` shows 12 rows by default, including for one match. |
| D2 | It asked again with `limit: 30` and was told 19 times that "a bigger limit returns nothing new" | The repeat guard ignored `limit` even when the earlier answer was partial (12 of 20). Nothing stopped a run of refused repeats. |
| D3 | It wrote a round file itself (`…-155-CCH-15_…`) and got "Round not found" | The round tools only took a file, so the model copied the pattern of other files. |
| D4 | "Round 13, 12-12 before this round, overtime" | No tool said the half or the score going into a round, so the model guessed. |
| D5 | First answer used the Inferno match | The two teams played on three maps and the model took the first; nothing told it to ask. |
| D6 | Compared buys, sides, opponent and result; "fast T push" for a round they stood still in | No tool gave positions over time, and the prompt routed "explain a round" to `round_value` (win-chance swings). Pace was guessed from kills. |

### Fixes (built 18 Oct)
1. **`round_timeline` (new; Phase 2's core).** Built in `roundStory.js` from the antistrat scan's per-second positions, so the data is already there. It gives:
   - every move to a new place, after 2 seconds held, for both teams, with the clock
   - both teams' shape every 10 seconds by area, naming players in groups of 1 or 2, so a lone lurk or a 5-stack shows
   - each grenade with where it landed, and each kill with where both players stood
   - the plant, the score going in, and the half
   - pace compared with the same team's rounds with the same buys (when 2 players first stood on a site, first kill, utility by 1:20), as "later than 3 of 3"
2. **Rounds by match and number.** `round_details`, `round_timeline`, `round_value`, `moment_value` and `screenshot_round` take match and number instead of a file. A number not in the library gets "has no round 40. It has 21 rounds: 1 to 21". A file the model wrote itself gets "never write a round file".
3. **`find_rounds` with a match** lists all its rounds, each with its half and the score going in, and says how many more there are when a limit cuts the list. `round_details` also returns the half and the score going in.
4. **Agent loop.**
   - A bigger limit runs when the earlier answer was partial.
   - After 3 refused repeats, the model must answer and say what it could not find.
5. **Prompt.**
   - "What happened" and "what differentiates" go to `round_timeline` and are told like a commentator.
   - Rounds are compared on what the teams did, not the facts around them.
   - Fast and slow come only from the pace block.
   - `round_value` is only for why a round was won.
   - Never write round files.
   - Halves: rounds 1-12, 13-24, overtime from 25.
   - Ask which map when two teams played on several maps.
   - Say a round is missing only when a tool says so.

Not yet checked against real demo data: the timeline is tested on a synthetic round shaped like the scan's records, and the place names come from each map's zone network.

---

## 0. Goal and principles

**Goal.** aim4 eye should understand Counter-Strike rounds the way an analyst or commentator does:
- who went where
- what each team was trying to do
- why it worked or failed

It explains this in plain language and backs it up with evidence the user can see.

**Principles (every phase follows these):**
1. **Answer the question asked.** "What happened" is a story. "Why" is reasoning. Numbers appear only when asked for or when they support a point.
2. **Never guess.** If the model lacks a fact (a position, a utility landing spot, a buy), it calls a tool for it. If no tool can give it, it says so in one sentence. Hedges like "held B main or rotated to B main" are forbidden.
3. **Speak like a person.**
   - Team and player names, not file codes.
   - Callouts, not coordinates.
   - Round labels ("fnatic vs Phantom, Ancient, round 2"), never internal IDs.
4. **Show, don't only tell.** When a moment matters, the model can attach a radar image or a playable round.
5. **Measure every change.** Every prompt, tool or model change is checked against the eval set (section 7) before shipping.
6. **Human-approved training data only.** Nothing the model wrote becomes training data unless a human approved it or a demo-data check confirmed it.

---

## 1. What went wrong in the test chat

| # | Symptom | Root cause | Fixed in |
|---|---|---|---|
| 1 | "AVg vs CNh" instead of team names | Tools return filename codes; the payload's team names are not passed through | Phase 1.1 |
| 2 | Round ID shown to the user | No rule against it; tool results only carry the ID | Phase 1.2 |
| 3 | "Only 5 rounds in the library" | `find_rounds` default limit; no browse/random tool | Phase 1.3 |
| 4 | "I cannot watch a game" | No position-over-time tool exists, and the prompt describes the tools as limits | Phase 2, Phase 3 |
| 5 | Round summary was a dump of win-probability swings and "costliest mistakes" | `round_value` output is rich, and the prompt does not separate "what" from "why" | Phase 3 |
| 6 | Second attempt was vague and hedged | The model had kill events but no positions, so it invented plausible ones | Phase 2 (data), Phase 3 (ban guessing) |
| 7 | "Pick a random game" refused | No tool, and the model asks permission instead of acting | Phase 1.3, Phase 3 |
| 8 | No way to tell the model it was wrong | No feedback loop | Phase 5 |

---

## 2. Phase 0: leftovers (do first, minutes)

- [ ] Install the rebuilt desktop exe.
  1. Close aim4.
  2. Copy `recorder/target/release/aim4-recorder.exe` to `D:/Dev/claude/aim4-app/aim4.exe`.
  3. Start it from Explorer.
  4. Check that `%APPDATA%/aim4-recorder/eye/eye.log` shows `start: last model ... downloaded=true` and no `download start`.
- [ ] Optional: delete the duplicate 22 GB model in Claude's container copy:
  `C:/Users/itsda/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/aim4-recorder`.
  It is only used by aim4 instances started from inside the Claude desktop app.
- [ ] Commit the earlier eye UI, the agent loop guard and the chat store work, once the user approves.

---

## 3. Phase 1: fix the data the model receives

Cheap, highest value per hour. Files: `src/replays/eye/eyeTools.js`, `eyeAgent.js` (prompt), server routes if a new endpoint is needed.

### 1.1 Real team names
- **Find the source.** Look for where the round payload stores team names: the demo header, the match metadata, or the library index. The fnatic name appeared in `round_value` output, so the payload has it somewhere.
- **Add a field to every round result:**
  `teams: { ct: "fnatic", t: "Phantom" }`.
  The result must flip at halftime: CT and T are per round, not per match.
- **Fallback order:**
  1. the library team name
  2. the in-demo clan tag
  3. "Team A / Team B"

  Never use the filename code.
- **Edge cases:**
  - mixes and PUGs with no team name: use "Team of <best-known player>", or "CT side / T side"
  - stand-ins
  - a renamed team (use the name at match date)
- **Done when:** no tool output contains a filename code in a field the model reads as a name.

### 1.2 Hide internal IDs
- Every round in a tool result gets `label: "fnatic vs Phantom · Ancient · R2 · 17 Oct"`, next to the `id`.
- Prompt rule: the user never sees `id`; always use `label`.
- The UI can turn labels into links to the replay (it already links rounds in tool details).
- **Done when:** 20 replayed eval answers contain no `~` or hash-like strings.

### 1.3 Library browsing and random pick
- **New tool `list_matches`** with arguments:
  - `team?`, `opponent?`, `map?`, `player?`, `date_from?`, `date_to?`
  - `event?`, if the metadata has it
  - `random?: bool`, `limit` (default 20, max 50), `cursor?`
- **Returns:**
  - per match: `{label, id, map, teams, score, date, rounds_count, access: "public" | "mine" | "shared"}`
  - plus `total` and `next_cursor`
- **Access scope.** Same rules as the library page: public demos plus the user's own and shared demos.
  - Desktop app: proxied to aim4.io with the user's session.
  - Website: server-side, with the logged-in user.

  Never return demos the user cannot open.
- **`list_rounds(match_id)`:** a cheap round list (number, winner, buy types, end reason) so the model can choose a round without loading the whole match.
- **Fix the `find_rounds` limit.** Report `total` so the model knows there are more than it was shown, mirroring the `note_complete` already added to `database_query`.
- **Edge cases:**
  - an empty library
  - filters matching nothing: say so and suggest the nearest match, e.g. the map exists but not for that team
  - an ambiguous team name ("Vitality" vs "Vitality Academy"): ask back, listing the options

### 1.4 Bugs found in the saved chat logs (17 Oct)
Source: the three saved chats in `server/data/replays/eye/chats/164ff49112df10f1082c97a2f640cd7e/`, plus `eye.log`.
- `eye.log` is clean: the model was found on disk at every start, and nothing was downloaded.
- These bugs come before the rest of Phase 1, because several of them cause the loops.

**Status (18 Oct): B1, B8 and B9 done; not yet replayed against the live model.**
- **B1:** `eyeContext.js` shortens JSON into a readable summary. Earlier questions are shortened first. A repeat call is allowed once when its answer was shortened.
- **B8:**
  - The document pools are now listed in the `query_rounds` description.
  - `query_rounds` takes `buy: "bought"`, matching the pace section.
  - Each `query_rounds` result says which rounds it counted.
  - The stored per-point filters from B8 (a) were not built; the review tool already recounts with each point's own pool.
- **B9:**
  - `find_rounds` filters the team's buy across all of its per-demo ids, and returns team names and a label.
  - The round picker shows names.
- **B2, B3, B4, B5, B6, B7, B10, B11 done (18 Oct), tested with a scripted model and a fake team API; not replayed against the live model.**
  - **B2:** documents have ids and written dates. `team_documents`, `review_antistrat_document` and `rewrite_antistrat_document` take an `id`. Several documents with one title resolve to the newest, with a note saying so. Different titles that match are refused with their dates and ids. New titles carry the date ("Outline: HAVU on Nuke (17 Oct)"). `scripts/doc-duplicates.mjs` lists old copies and deletes nothing.
  - **B3:** a call that fails the same way twice gets a "do not retry" note, and a third try is not run. An identical call that already failed gets the failure back.
  - **B4:** the rewrite takes `final: false` parts and saves on the final call; a section sent again replaces the earlier one. A cut-off call gets a message saying so and how to send less. The generation limit itself was not changed; the stream's `finish_reason` is used to say when it ran out of room.
  - **B5:** an empty reply, or running out of steps, ends with a readable message saying what was done and the last step.
  - **B6:** create and queue only confirm the save. The prompt reviews only when asked, and a hand review of rounds only when asked for.
  - **B7:** a rewrite may quote numbers from this turn's data tools; a refused number names its point and the sent sections are kept.
  - **B10:** dates are written ("17 Oct 21:30"). Text before a tool call shows as one gray line, not an answer bubble.
  - **B11:** results say "your team's Documents".
- **Also fixed:** the eye tools had pistol and eco swapped (`BUY_CODE`), so `buy: "pistol"` in `find_rounds` and `database_query` returned eco rounds.

**B1. Compaction and the repeat guard contradict each other (the main loop cause).**
- **Seen:** older tool results are cut to about 460 chars with "[cut to save space; call the tool again for the full result]". When the model calls again, the repeat guard answers "You already made this exact call and have its full answer above". The full answer is not above, so the model is stuck: it re-calls, gets refused, and narrates "the system is having trouble".
- **Fix:**
  - (a) The repeat guard must check whether the earlier result is still in full in the conversation. If it was compacted, allow the call and return the full result again, once per turn.
  - (b) Better: compact into a useful summary, not a cut-off string. For JSON results, keep the keys, counts and the first rows, and say "N more rows; ask with a narrower filter". For document text, keep the section headings and point counts.
  - (c) Never compact a result from the current turn. Compact only results from earlier user turns.
- **Test:** a chat that reads one document, then asks a follow-up needing its full text. It must re-fetch exactly once and answer.

**B2. Duplicate document titles block review and rewrite.**
- **Seen:**
  - `review_antistrat_document` and `rewrite_antistrat_document` failed with `"Outline: HAVU on Nuke" could be "Outline: HAVU on Nuke", "Outline: HAVU on Nuke", "Outline: HAVU on Nuke". Use the full title.` Every option is identical, so no title can ever work.
  - The model retried the rewrite about 7 times with near-identical arguments. The repeat guard didn't catch this because the long `sections` argument differed slightly each time.
- **Fix:**
  - (a) `team_documents` returns `{id, title, updated (human date), style, maps}`.
  - (b) Every document tool accepts `id`. `title` stays as a fallback.
  - (c) When several documents share a title, pick the most recently updated one, and say "used the newest of 3 with this title (17 Oct 21:30)". Don't fail.
  - (d) `create_antistrat_document` either overwrites the same team, map and style document (with a version history), or adds the date to the title. The second is recommended: "Outline: HAVU on Nuke (17 Oct)".
  - (e) The error text for ambiguity must list distinguishing facts (date, id), never identical strings.
  - (f) One-time cleanup script: list duplicate titles per team folder, so the user can delete the old ones.

**B3. No repeat guard for repeated errors.**
- **Seen:** the same tool with the same title returned the same error 3 or more times in one turn.
- **Fix:**
  - Key the guard on (tool name, main id/title argument, error text). On the second identical error, the tool result says to stop retrying and tell the user, quoting the error.
  - Add a per-tool cap: at most 3 calls to the same tool per turn, unless the arguments differ in their filter fields.

**B4. Large tool arguments break.**
- **Seen:** the turn ended with "the arguments were not valid JSON", after a very long `rewrite_antistrat_document` call (all sections of a document). The output most likely hit the generation token limit mid-JSON. The turn then ended with no answer to the user.
- **Fix:**
  - (a) Change the rewrite tool to take patches per section, e.g. `{section, replace_points[]}`, called once per section, not the whole document in one call.
  - (b) Raise the llama-server generation limit for tool-call turns, and log when a generation stops on the token limit.
  - (c) After invalid JSON, the agent retries once with "your last call was cut off; send smaller calls". It must never end the turn silently.

**B5. Turns end without an answer.**
- **Seen:** two chats end on a tool result ("Saved ...", invalid JSON) with no final message.
- **Fix:**
  - Any turn that ends on a tool result, a step cap or an error must produce a final assistant message: what was done, what failed, and what to do next.
  - Add a test for this in `eye.test.js`.

**B6. A tool result tells the model to start a huge manual task.**
- **Seen:** `create_antistrat_document` returns "Now do the manual review for each team and map just written, read the rounds yourself ... using find_rounds, round_details, query_rounds and screenshot_round." That starts a 20+ call review the user never asked for, which then hits B1 to B4.
- **Fix:** the tool result just confirms the save. The model only reviews when asked, or when the user's request says "then review it". The review is done by `review_antistrat_document`, which compares numbers in code; the model doesn't redo it call by call.

**B7. The rewrite number check rejects real numbers.**
- **Seen:** the rewrite was refused with "These numbers are in neither the document nor the current data: 95". But 95 came from a `query_rounds` result the model had fetched (`"share":95`).
- **Fix:**
  - The check accepts numbers from the review result, the sheet, and any tool result in this turn.
  - When it refuses, it names the point that holds the number, so the model can fix that one point.

**B8. The document's numbers and query numbers use different definitions.**
- **Seen:**
  - The document says "Rush 12 rounds". `query_rounds` with pace rush says 9.
  - The document says "A hits 9 of 20". `query_rounds` with site A says 18 of 31.
  - The model called these errors, but they are probably different filters: buy type, opponent buy, "hit" versus "round ended at site".
- **Fix:**
  - (a) Documents store the filter behind each number, e.g. `[T, full vs full, pace=rush]`, hidden from print but readable by tools.
  - (b) `query_rounds` gets the same filters the document generator uses: opponent buy, and `hit` (a T execute onto a site) versus `site` (where the round ended).
  - (c) The review compares numbers using the stored filter, so real changes are told apart from definition mismatches.

**B9. Team filter mismatch (codes again).**
- **Seen:**
  - `find_rounds {team: "The Golden Horde", map: "Cache", buy: "full"}` returned 0, but `list_teams` showed 3 Cache demos.
  - With `buy: "any"` it returned rounds labelled with codes (`52C`, `WkB`), so the model couldn't tell which side was The Golden Horde.
- **Fix:** part of 1.1.
  - Resolve the team name to its codes in every tool before filtering. Return names.
  - Add a test: for each team from `list_teams`, `find_rounds {team}` returns at least 1 round.

**B10. Raw timestamps and filler narration.**
- **Seen:**
  - "updated timestamp 1792264605162" was shown to the user.
  - Almost every step starts with "Let me check ..."; the same paragraph was repeated 4 times.
- **Fix:**
  - Tools return human dates.
  - Prompt rule: no narration between tool calls. In the UI, text before a tool call shows as a one-line status, not as answer text.

**B11. Unclear owner wording.**
- **Seen:**
  - The model said documents go "in the user's team Documents folder once confirmed". It should say "your", and nothing needed confirming.
  - "Saved HAVU on Nuke to The Golden Horde's Documents" looks wrong to a reader. It is the user's team folder.
- **Fix:** tool results say "your team's Documents (The Golden Horde)", and the prompt says to address the user as "you".

**Done when:**
- All three saved chats replay with no loop, no repeated error, and a final answer every turn.
- `npm test` covers B1, B2, B3, B5 and B9.

---

## 4. Phase 2: let the model "watch" a round

The core of the project. The model must know positions over time, and the team plan behind them.

### 2.1 Map callout zones (prerequisite)
- **Check first:** does the repo already have callout polygons, e.g. cs3d map data, radar overlays or the pattern finder's zones? If yes, reuse them.
- **If not:** author 2D polygons per map in radar coordinates, with height bands where floors overlap (Nuke, Vertigo, Ancient cave, Inferno banana and apps). Store them as JSON per map: `{name, aliases[], polygon, z_min?, z_max?, area: "A" | "B" | "mid" | "T-side" | "CT-side"}`.
- **Maps:** the current active duty, plus any map present in the library. Unknown maps fall back to "near A site / near B site / mid" from the bomb-site positions, or to raw coordinates with a warning.
- **Validation:** a script that replays known rounds and checks no sampled position is "unzoned" for more than 5% of samples.

### 2.2 `round_timeline` tool (text, main path)
- **Input:** round id, optional `from` and `to` clock times, `detail: "brief" | "full"`.
- **Sampling.** Every 1 s from the demo trajectories (0.5 s near kills).
- **Per player:** zone, alive, HP, armor, main weapon, has bomb or kit, and facing zone (only when stationary, e.g. "holding long A").
- **Emit changes only, as lines.** Examples:
  - `1:52 T  nicoodoz, Kylar  T spawn -> B main`
  - `1:48 CT cairne  CT spawn -> mid (window)`
  - `1:46 T  Kylar flash -> B site (blinded TMB, own team)`
  - `1:44 T  smoke lands B short`
  - `1:40 KILL cairne (CT, mid window) -> TMB (T, cave), AK, trade: none in 3 s`
  - `1:35 BOMB dropped T, B main`
  - `1:23 END CT win (elimination), T alive 0, CT alive 3`
- **Group lines:** when 3 or more players of one team share an area, write `T x3 B main (nicoodoz, Kylar, Kunai)` instead of three lines.
- **Size budget:** at most 1.5k tokens for "brief" and 4k for "full". Merge idle periods ("1:30-1:10 no movement, CT holding: ...").
- **Header line:** buys and economy for both teams, starting side, score before the round, and who has the bomb.

### 2.3 Derived phase labels (hints, not answers)
Rule-based detection, output as a short "hints" block at the top of the timeline:
- **Default spread:** T players in 3 or more areas with no utility cluster.
- **Group push or execute:** 3 or more T players in one area within 5 s, plus 2 or more utility pieces landing on the site.
- **Rotation:** a player crosses from one area to another (A to B via mid or CT-side) after a trigger.
- **Lurk:** one T player stays 1 area or more away from the group for more than 15 s.
- **Stack:** 3 or more CT players on one site at the moment of contact.
- **Retake, save, eco or force, fake** (utility on one site, then the group at the other within 20 s).

Hints carry a confidence. The prompt tells the model to check them against the timeline and to override them when the timeline disagrees, saying why.

### 2.4 `watch_round` (visual path, optional and slower)
- **Contact sheet.** Radar frames every 2 s, packed 3x3 into one image (18 s per image), each frame stamped with the clock time. A 1:55 round is about 7 images.
- **Used when:**
  - "Think longer" is on
  - the question is spatial and the text timeline is ambiguous (e.g. overlapping floors)
  - the user asks it to "watch"
- **Vision-only:** disabled with a clear message when the loaded model has no vision projector.
- **Prompt rule:** use images to confirm or correct the timeline, not as the only source.

### 2.5 Facts to expose for "why" questions
These can be extensions of `round_timeline` "full" or of `moment_value`:
- **Numbers on each side** at each contact: X v Y, and whether the fights were taken one at a time or as a group.
- **Time since the last teammate contact:** trade distance and whether a trade was possible.
- **Utility state at the moment of the fight:** blind, smoked, molly blocking.
- **Duel odds at contact:** only on request or as support.

### 2.6 Done when
- For the PDF round, the model's "what happened" answer names both teams, the T plan, the CT setup and the decisive fight, with correct callouts.
- A human marks it correct against the demo.

---

## 5. Phase 3: answer style and agent behaviour

Files: `eyeAgent.js` (system prompt, step policy) and tool descriptions in `eyeTools.js`.

### 3.1 Question intent drives the shape of the answer
The prompt contains this table:

| Intent | Example | Shape |
|---|---|---|
| What happened | "What happens in this round" | 1 to 3 short paragraphs by phase (setup, mid-round, decisive fight, outcome). Names, callouts, utility, team plan. No percentages. |
| Why | "Why couldn't they kill Cairne" | 2 to 5 sentences of reasoning. 1 or 2 numbers allowed as support. |
| Moment | "What's happening at 1:20" | Positions plus one sentence of intent; optional image. |
| Tendency | "What does fnatic do on Ancient T" | Pattern plus frequency ("in 9 of 14 rounds"), plus 1 or 2 example rounds as links. |
| Compare | "fnatic vs NAVI on Mirage" | A short table or paired bullets. |
| Counter | "How do we beat their B default" | Concrete steps, each tied to an observed habit. |
| Lookup | "How many demos of G2" | The direct answer, one line. |
| Capability | "Can you watch a game" | Yes, plus how, in 2 sentences. No tool list. |

### 3.2 Hard rules in the prompt
- **No guessing,** no "likely X or Y". Fetch, or state the gap once.
- **No internal IDs,** file codes or tool names in answers.
- **No raw tool dumps:** pick the 1 to 3 facts that answer the question.
- **Act, don't ask** when the request is clear enough ("pick a random game": pick one). Ask back only for true ambiguity (two teams with the same name, no map given for a map-specific question).
- **Keep it short:** "what happened" under about 200 words unless the user asks for more.
- **Respect the conversation:** a follow-up ("why?") refers to the last round discussed. Don't re-fetch what is already in context unless the details are needed.

### 3.3 Few-shot examples
- Seed with the user's two examples (the fnatic narrative and the Cairne "why"), placed in a separate examples block.
- Later, examples are pulled from the training store by question category (Phase 5.6).

### 3.4 Tool budget and loop safety (partly done)
- **Done:**
  - `MAX_STEPS = 10`
  - the repeat-call guard
  - the final "answer now" nudge, sent as a user message so Qwen's chat template accepts it
- **Add:**
  - A per-turn token budget for tool output. Truncate the oldest tool results to a one-line summary when it is over budget.
  - "Think longer" raises `MAX_STEPS` to 20 and allows `watch_round`.

### 3.5 Done when
- On the eval set, "style" failures (dumps, hedges, IDs, refusals of possible tasks) are under 5%.

---

## 6. Phase 4: show, don't tell

Files: `eyePanel.js`, `eye.css`, the replays radar renderer and `chatStore.js` (persistence).

### 4.1 Model-attached images
- `screenshot_round` and `watch_round` take a `show: true` argument. Shown images appear inside the answer, below the paragraph that references them, not only inside the collapsed tool line.
- Click to enlarge (lightbox). Images are saved with the chat; they are already stored as tool results.

### 4.2 Round mini player in chat
- **New tool `show_round`:**
  - arguments: `round_id` or a list of up to 10, `from?`, `to?`, `caption?`
  - returns a widget spec, not data
- **Chat widget:**
  - a compact radar player, about 360 px, that reuses the replays radar renderer
  - controls: play/pause, scrub, 1x/2x/4x speed, previous and next round (for lists), and "open in full replay"
  - starts at `from` and loops between `from` and `to` when both are set
- **Loading:** lazy. The player loads round data only when scrolled into view, and at most 2 players are active at once (the rest pause and release memory).
- **Saved chats** store the spec only, so they re-render on open.
- **Edge cases:**
  - a round deleted or access revoked: placeholder "Round no longer available"
  - offline or desktop: same endpoints through the local proxy

### 4.3 Done when
- An answer about a round can include a working player.
- A saved chat reopens with the player intact.

---

## 7. Phase 5: human training and evaluation

### 5.0 Start from what exists
- Read `admin/training_1` to `training_5` first: storage, queue, auth and UI patterns.
- Reuse their admin gate and storage approach.
- Write down what they do in this doc before building, so the new pieces fit.

### 5.1 Data model (one record per rated item)
```
{
  id, created_at, source: "chat" | "generated" | "eval",
  question, category, difficulty,
  evidence: { round_ids[], match_ids[], time_range? },
  model_answer, model_trace, model_id, prompt_version, tools_version,
  human_answer?,            // blind mode
  verdict: "good" | "partial" | "bad" | "skip",
  tags[],                   // see 5.3
  rewrite?,                 // "how I would have said it"
  expected_reasoning?,      // for "why" questions
  auto_checks?: [{fact, expected, got, pass}],
  reviewer, reviewed_at, approved_for_training: bool
}
```
- `prompt_version` is a hash of the system prompt plus tool descriptions, so ratings stay comparable across changes.

### 5.2 Review page
**Layout:**
- left: the question, the model's answer and the collapsed trace
- right: the evidence, which is the round mini player, the `round_timeline` and any screenshots
- bottom: the rating controls

**Rating controls:**
- verdict buttons
- tag chips
- a rewrite textarea
- an optional "expected reasoning" line
- Save and next

**Keyboard:** 1/2/3 for the verdict, T to focus the rewrite, Ctrl+Enter to save and go to the next item, S to skip.

**Modes:**
- **Blind:** the question and evidence first. You write your answer, then the model's answer is revealed and you rate it. Your answer becomes the reference (`human_answer`).
- **Review:** the model's answer is shown at once; rate and optionally rewrite. Faster for bulk.

**Queue filters:** category, verdict, unreviewed, low confidence, and disagreement (see 5.5).

**Saved chats:** a thumbs up/down under each answer in the normal chat sends the item to the queue with the user's comment (optional for normal users; admin-only review).

### 5.3 Tags (fixed list, extend sparingly)
- guessing or vague
- wrong focus (numbers instead of the story)
- wrong fact
- wrong team or player names, or codes shown
- IDs shown
- refused a possible task
- asked when it should have acted
- too long
- missed the team plan
- missed the decisive moment
- wrong callout
- good structure

### 5.4 Varied question bank
Templates are filled with real library data (`list_matches`, `list_rounds`, team and player lists). Each generated question records its category and difficulty. The target mix is adjustable per run, and no category exceeds 20%.

| Category | Examples |
|---|---|
| Round narrative | What happened? What was the T plan? How did CT set up? |
| Why / causal | Why did the execute fail? Why couldn't they kill X? Was the rotation late? |
| Single moment | What's happening at 1:20? Where is the bomb? Who is lurking? |
| Team tendency | fnatic's Ancient T default? Pistol habits? 4v5 play? |
| Player role | What does X do on CT Inferno? Who entries? AWP positions? |
| Comparison | Team A vs B on Mirage; first half vs second half; map vs their average |
| Counter-strategy | How to beat their B default? What to stack? |
| Counterfactual | What if they had traded / waited for the flash / saved? |
| Economy | Should they have force bought? Why did they lose the gun round? |
| Library / lookup | Find rounds where X happens; how many demos of Y; pick a random game |
| Clarification / trick | Non-existent team or map, live game, ambiguous name: correct is to ask back or decline briefly |
| Capability / identity | What can you do? Can you watch a game? |

**Difficulty tiers:**
- easy: a single fact
- medium: one round's reasoning
- hard: aggregation over several rounds or matches, or open-ended analysis

### 5.5 Self-play: the model writes questions, both of you answer
1. **Question.** A generator run (model or template) picks a random accessible match and round via `list_matches(random: true)`, plus a category from the mix. It writes the question and records the evidence.
2. **Answers.**
   - The model answers with tools in a fresh context, never seeing the human answer.
   - The human answers in blind mode.
3. **Automatic checks.** Questions with checkable facts are graded against demo data with no human needed: position at time T, kill count, site, buy type, who planted, round winner. Each generated question of this kind stores its expected fact at generation time.
4. **Grading of open answers:**
   - The human grades the model against their own answer.
   - A judge pass (the model comparing the two answers) is logged but only trusted once it agrees with human verdicts on at least 90% of a 100-item sample. It is re-checked every 200 items.
5. **Adaptive mix.** Categories with the lowest scores over the last 100 items are sampled more often, with each category kept at 5% minimum.
6. **Disagreements:**
   - human "bad" plus judge "good", or the reverse
   - a model answer that contradicts the auto-check

   These go to a "disagreement" queue. Each one should end as a concrete fix: a prompt rule, a tool change or a new example.
7. **Guard (no self-teaching errors).** Only items with `approved_for_training: true`, or an auto-check pass, enter training data. Model-written questions are fine; model-written answers are not training data unless approved.

### 5.6 How the data is used (in order of payoff)
1. **Eval set.**
   - A frozen set of about 150 items covering all categories.
   - Re-run after every prompt, tool or model change. The report shows the score per category, style-failure rate and auto-check accuracy, compared with the last run.
   - A change that lowers any category by more than 5 points is not shipped without a reason.
2. **Few-shot retrieval.** At answer time, pull 1 or 2 approved rewrites from the same category (and the same map or team when available) into the prompt.
3. **Fine-tuning (later, at roughly 500 approved items).** Build an SFT/LoRA set from approved rewrites and blind human answers, extending the existing SFT builder from the value tools. Train for the local Qwen and compare it on the eval set before switching.

### 5.7 Privacy and access
- The review page is admin only.
- Chats from other users enter the queue only if they pressed feedback. Store the question and answer; strip anything that isn't CS content (free-text personal details) before training use.
- Demos used as evidence must stay accessible to reviewers. Private demos are only used in that owner's own items.

### 5.8 Done when
- You can rate 30 items in under 15 minutes.
- An eval run produces a per-category report.
- Self-play produces varied questions with auto-checks passing on at least 95% of their own expected facts.

---

## 8. Phase 6: model capacity (measure, don't assume)

- Run the eval set on:
  - local Qwen3.5-35B-A3B, normal and "Think longer"
  - a smaller local model, for speed
  - a cloud model as a ceiling
- Record the score per category, time per answer and tool-call count.
- **Decide on data:**
  - If the local model is within about 10 points of the ceiling after Phases 1 to 3, stay local.
  - If not, options are a larger local model, a cloud model only for "Think longer", or fine-tuning (5.6.3).
- **Context window:** check that a "full" timeline plus history fits. If not, lower the timeline budget or summarize older turns.

---

## 9. Situations to handle (checklist)

| Situation | Expected behaviour |
|---|---|
| Model not loaded / downloading | The chat input stays usable; send shows "Model is starting" with progress. No silent failure. |
| Model has no vision | Image tools are hidden from the model; image attach is disabled with a tooltip. |
| Demo missing or corrupt | The tool returns a clear error; the model says the round can't be read and offers another. |
| Round has no positions (old or partial demo) | The timeline says so; the model answers from events only and says positions are unavailable. |
| Warmup or knife round picked | Skipped by `list_rounds` (flagged); never offered as random. |
| Overtime, halftime side switch | Side labels per round, never per match. |
| Unknown map | Fallback zones (near A / near B / mid) plus a warning line in the timeline. |
| Ambiguous team or player name | Ask back with up to 5 options. |
| Question about a live game or outside the library | Say briefly it only knows demos in the library; offer the closest thing. |
| User asks for raw numbers | Allowed: give them, with a short reading. |
| Very long chat | Older turns compacted (already marked `compacted`); the round in focus stays in full. |
| Tool loop | Repeat-call guard, step cap, final answer nudge (done). |
| llama server 500 / crash | Show the error line; offer a retry; the server log path is in `eye.log`. |
| User without pattern-finder access | The page is gated by `analytics.pattern_finder` (done); tools are scoped to the user's demos. |
| Desktop vs website | Same tools; the desktop proxies to aim4.io except the local `/api/eye/` routes. |

---

## 10. Order of work and rough size

1. Phase 0: minutes.
2. Phase 1.4 (log bugs B1 to B11) first, then the rest of Phase 1: small to medium (2 sessions).
3. Phase 3.1 to 3.3, prompt only: small. Do it together with Phase 1.
4. Phase 5, minimal: the eval set plus a thumbs/rewrite on saved chats, without self-play. This makes every later step measurable.
5. Phase 2: large. Callout zones decide the size; check for existing ones first.
6. Phase 4: medium.
7. Phase 5, full: the review page, question bank and self-play. Medium to large.
8. Phase 6: small, once Phases 1 to 3 have landed.

## 11. Verification (every phase)

Replay the original test chat and compare against the user's examples:
- "What AI model are you"
- "Can you watch a game"
- "Pick a random game"
- "What happens in round 2"
- "Why couldn't they kill Cairne"

Then run the eval set once it exists. No gameplay testing in the browser: the user tests the game; checks are static or headless.

## 12. Open questions (resolve during the work)

- Does the repo already have callout polygons per map? (decides the size of Phase 2)
- Where exactly do team names live in the round payload and library index?
- What do `admin/training_1` to `training_5` store, and in what format? (decides the 5.1 schema details)
- Should normal users' feedback enter the queue, or only admin chats?

## 13. Longer conversations at the same context (32k)

**Measured (18 Oct, before the doctrine was added; budgets now 44k history, 32k fold):**
- Every request carries the system prompt (16.8k characters) and 23 tool schemas (21.9k). That is about 11k tokens, a third of the window, before the chat starts.
- History is capped at 48k characters by shortening old tool results.
- Nothing else ever leaves the conversation: questions, answers, tool-call arguments (a rewrite call carries whole sections) and each shortened result (about 1.3k) keep adding up.
- So a long chat overflows, and the only way out is the `/compact` hint in the error.

**Fix, in order of payoff:**
1. **Rolling memory (automatic `/compact`).**
   - When the earlier questions take more than 36k characters, the oldest finished ones are folded into a model-written memory, which merges the previous one, until 12k characters of recent turns are left. The newest earlier question is always kept.
   - Folded messages stay in the chat, so the screen, the export and the saved chat still show them. Only the model's view drops them, and the memory goes in as one user/assistant pair at the start.
   - Because the system prompt and tools are untouched, llama-server's prompt cache still hits on them.
   - If the model cannot write the summary, a plain digest (each question and the start of its answer) is used instead.
2. **Shorten old tool-call arguments**, not only results. A rewrite or save call from an earlier question keeps its short fields; long lists are cut to their first rows.
3. **`recall_earlier` tool.** It lists the folded questions by number and returns one in full: the question, the answer and short tool results. The memory can then stay short without losing anything for good.
4. **Overflow fallback folds instead of failing.** On a 400 everything before the current question is folded, then results are shortened to half the budget and the request is tried again. Only then does it show an error.
5. **`/context` shows the folded questions and the memory size.**

**Done when:**
- A scripted 30-question chat runs to the end with no 400, against both the fake model and the real one.
- After a fold the model still answers a question about a folded turn, through the memory or `recall_earlier`.

## 14. Capability gaps: round kinds, player habits, merging, doctrine (18 Oct)

These come from the user's list of 11 capabilities. Items 1, 8, 9 and 10 already had tools.
- **Item 11, `classify_rounds`** (`roundTypes.js`). Each T round is an execute, split, rush, contact or no hit, read from where the players walked:
  - **Target:** the plant site, or else the first site two players entered.
  - **Wave:** the first players onto that site, within 12 s of each other.
  - **Lanes:** each player's lane is the zone he came from. The site's own zone and spawn zones are never a lane. Mirage palace and ramp share a zone, so a small table separates them; distance can't (ramp to palace is 700 units, banana is 1,000 long).
  - **Kinds:** a split is 2+ lanes with 3+ players. An execute is one lane with 3+ grenades onto the site in the 15 s before the entry. A rush is the existing rush or pop pace. A fake is 2+ grenades on the other bombsite itself, not utility near it.
  - **Results:** best rounds of each kind are ranked by won, planted, players kept, kills by the plant, and speed. `team: "all"` ranks every team.
  - **Checked** on HAVU Mirage (B Aps + B Short and Jungle + Ramp splits) and Phantom Inferno with `tools/eye/classify-check.mjs`.
- **Item 7, `player_patterns`** (`playerPatterns.js`). Each player, per side, with counts:
  - start spot, early fights and where, playing alone, opening duels
  - whether his deaths are traded, and whether he trades teammates within reach (1,000 units, height included)
  - his regular grenades and their timing, and whether he spends all his utility in the first 25 s
  - CT rotations, and whether he left before the attackers were on the site; T lurks
  - what to do about each
- **Item 6, merging in the review** (`docReview.js`):
  - Points over the same rounds (80%+ shared, same side and site) are duplicates, however each is worded.
  - Points worded alike over different rounds are "same-words": keep both and tell them apart.
  - A mangled link (repeated segment, dropped hash character) is the same round. A neighbouring round never is, because its prefix differs.
- **Items 2–4, doctrine in the prompt:**
  - micro vs macro, weakness vs exploit
  - low-buy CT options (stack, push, default) and how to play T against them
  - block utility shows where a defense is thin
  - proximity is not intention, causes come before effects, counts and exceptions
  - It costs about 3k characters per request, so the history budget went from 48k to 44k and the fold line from 36k to 32k.

## 15. Desktop app: offline and shipping (18 Oct)

- **Offline** (`server/offline.js`, `upstream.js`, `identity.js`, `index.js`): with `AIM4_UPSTREAM` set, the local server asks the online aim4 who a caller is (`/api/me`, no database key) and keeps the last signed-in answer on disk.
  - If the upstream can't be reached (6 s connect timeout), the server answers everything itself. The remembered account is used when the token's `sub` matches it, and the library is the demos on this PC.
  - A demo uploaded offline is parsed locally and its raw upload queued in `server/data/offline/queue`. When the upstream answers again (checked every 10 s), the queue is sent there with the account's next token.
  - Tested end to end against a stand-in cloud on :3785: remembered login, refusing another account, a 412 MB offline upload parsed locally, then sent on reconnect.
- **The pack** (`scripts/build-pack.mjs`) bundles this Node, the server, `shared`, `src`, `scripts`, its modules and the slim `dist-account` into `recorder/app/pack/aim4-pack.zip`, which `build.rs` embeds in the exe (126 MB).
  - Without `aim4-local.json`, the app unpacks it to `<settings>/pack` on first run and after an update; `server/data` is kept between versions. It starts `node.exe server/run-pack.js` on port 37840 and opens the window there.
  - Online, the pages and data come from aim4.io; offline, the pack's own site and this PC's library are used.
  - Checked: the unpacked pack serves the site, `/api/me` and the library against aim4.io, and serves the site and the library with the upstream unreachable.
  - Not checked: a double-click launch of the new exe on a clean PC.
  - Build order: `npm run build:account`, `node scripts/build-pack.mjs`, `cargo build --release`.
- **Shipping:** publish the exe from Admin > App builds. The download buttons serve the newest build from `/api/recorder/download`.
