# Training aim4 eye

aim4 eye is a small open model (Qwen3.5 4B / 9B / 35B-A3B) running on the user's own computer. It learns in two ways, cheapest first.

## 1. Tools and the prompt (no training)

Most of what "knowing how to scout" means is in code the model calls, not in its weights. The model picks the tool, fills in the arguments and puts the result into words. It never computes a number itself.

| Skill | Tool | What the code does |
| --- | --- | --- |
| Weaknesses | `find_weaknesses` | `src/replays/eye/weaknesses.js`: sites/paces lost more than the team's own baseline, spots where they lose their fights, where opening deaths pile up, ranked by gap × √rounds; situations (retakes, post-plants, anti-ecos, forces) listed but not ranked; the rule-bot's exploits (`opinions.js`) |
| Reviewing a document | `review_antistrat_document` | `src/replays/eye/docReview.js`: arithmetic, impossible counts, thin points, duplicates, numbers that changed or are not in the current data, strong points missing, empty sections |
| Rewriting a document | `rewrite_antistrat_document` | Takes the model's reorganised outline and **refuses any number that is in neither the document nor the fresh sheet**. Points keep their round links. The user confirms before it saves. |
| Many documents | `queue_antistrat_documents` | One confirmation for the whole queue; `maps: ["all"]` covers every map with 3+ demos; a failed job does not stop the rest |

The ordering and fixing rules (which issue matters most, the section order of a rewrite) live in `SYSTEM_PROMPT` in `src/replays/eye/eyeAgent.js`. Change behaviour there first: it costs nothing, and it works on every model size.

## Writing strategy notes: the coach's stratbook is the bar

"Add strategy" in the round viewer has aim4 eye write each column's note from the facts the rules measured (`src/replays/eye/eyeStrategyNotes.js`, rules in `src/replays/strategy/roundNarrative.js`). How a note should read comes from a coach's real stratbook, not from a description of one:

```bash
node tools/eye/stratbook-style.mjs     # measures tools/eye/gold/stratbook-notes.json
```

On the 457 per-player notes there (22 Oct 2026): a median of 57 characters and two sentences, 90% under 111; a time in only 11% of them; pistol and eco rows open with the buy in stratbook letters (K, SFF, SM, SF+P250); the words are the job (go, hold, search, lurk, entry, refrag, line up, take bomb, on flash). `STRATEGY_NOTES_PROMPT` says this and quotes twelve of the notes, times rewritten 1:45 (the coach writes 1.45) and lineup numbers removed (here the grenade links do that). The checks in the same file keep the model honest whatever it copies: grenade tags must be the player's own, every time must be in his facts, the opening buy is replaced by his real loadout's.

Measured on the user's Qwen3.8 27B (8 library rounds, same rounds before and after): median note 118 → 63 characters, notes with a time 90% → 38%, every grenade linked, 0 of 40 columns falling back to the rules. With thinking off the model is 5× faster but made up a buy on every column of two full-buy rounds and timed 73% of its notes, so thinking stays on (about 25 s a strategy).

More rows in `stratbook-notes.json` (one string per column, a string repeated in all five is a team-wide call) make the measurements and the choice of examples better. They are style, not grounded pairs: there is no round behind them, so they are not fine-tuning data on their own.

## Judging a round: the models are the teacher

eye can say whether a move was good or bad because it can price it, not because it was told a rule. `round_value` and `moment_value` (`src/replays/eye/roundValue.js`) read the two models that were fitted on the library's own rounds:

- **Round win chance** (`rounds/roundModel.js`), before and after every kill, plant and defuse. The change is the move's swing for the side that made it, with the factors that moved it (players alive, health, equipment, bomb, map control...).
- **xK in the moment** (`duels/duelScanner.js`): at any tick of any open gunfight, each player's win chance in it, summed over the fights they are in (a 1v1 is just the win chance). `round_value` follows each fight as it turned (win chance when it opened, just before the kill, and a trace between), so a fight lost at 70% reads as variance and one that started at 10% reads as behind from the start.

A kill that cost nothing is not a mistake, and one that looked wrong but moved the round is. Neither the PDF nor the coach rules decide that; the numbers do. `costliest_flags` carries the coach rules' own flags, priced the same way.

**Training data from every round, with no rating needed:**

```bash
node --max-old-space-size=4096 tools/eye/build-value-sft.mjs value-out/ --dir sampledemos
#   value-out/value-sft.jsonl    traces: question -> round_value / moment_value -> answer
#   value-out/value-eval.jsonl   one demo in five held out, with what the numbers say is true
```

The tool results in a trace are exactly what the tools return, and the answer is written from them alone (every number in an answer is in a tool result; the builder's grounding check is `0 of N` ungrounded). Question types: what decided the round, best and worst player, was a death a losing fight from the start, what went wrong for the losing side. Point `--dir` at a folder of `.aim4replay` packages; more demos is more traces. `value-eval.jsonl` is split by demo, never by round.

**Scoring a model on the held-out rounds** (`tools/eye/eval-value.mjs`): runs any OpenAI-compatible server through the same loop and system prompt as the app, with the value tools backed by the same code, and grades the runs.

```bash
llama-server -m model.gguf --jinja -c 16384 --port 8899
node --max-old-space-size=4096 tools/eye/eval-value.mjs --llama http://127.0.0.1:8899 --model qwen3.5-4b
#   -> tools/eye/value-out/run-<time>/summary.json and results.jsonl (every answer, the calls it made, why it failed)
node tools/eye/eval-value.mjs --oracle     # no model: replays the reference answers; must read 100%
```

What is graded (`valueScore.mjs`): the first call is `round_value` on the right round; every number and every clock time in the answer is in a tool result (rounding to a whole number is allowed and counted); the answer names at least two thirds of the biggest swings; the verdict matches (best and worst player in order, a death read as behind / close / favoured, at least half of the loser's costly moments). Calls to any other eye tool count as wrong tools, because the default offers all of them. Run the base model first, then each fine-tune, and only ship one that beats the base on `pass` without losing `grounded`. The verdict check is keyword voting on the answer, so read a few `results.jsonl` failures before trusting a low `take` score.

The doctrine in the Counter-Strike 101 PDF is not copied in. Where it makes a claim that can be measured ("the first pick converts at ~82%", "block at 1:00 and 0:40"), test it against `query_rounds` and the win model before it goes anywhere near a prompt or a training set.

## 2. Fine-tuning, from what admins rate

Data comes from two places. Both end up in the admin training store (`/api/admin/labels`, JSON Lines):

- `/admin/training_1…5`: round descriptions, antistrat points and opinions, each marked yes or no, with corrections.
- **Good / Bad under each aim4 eye answer** (admins only, stored as stage 6, `eye-trace`). This saves the whole turn: the question, every tool call with its arguments, the tool results (cut to 6,000 characters each) and the answer, plus the system prompt and tool schemas from that moment.

Then:

```bash
# 1. Export (Admin > Training > Export, or GET /api/admin/labels/export)
# 2. Turn it into chat-format training data
node tools/eye/build-sft.mjs export.jsonl sft-out/
#    sft-out/sft.jsonl   good traces, round descriptions, point reviews, opinions
#    sft-out/eval.jsonl  bad answers with the admin's note: the test set, never trained on
```

**The coach's own sheets:** `tools/eye/gold/` holds the 13 manual antistrats (HAVU, NAVI Junior, INFINITE, EAC, ENCE, WBT; English and Russian, extracted from the PDFs, listed in `gold/index.json`). They are the quality bar.

```bash
node tools/eye/gold-pairs.mjs --base http://localhost:3784 gold-pairs.jsonl   # generated sheet next to each manual one
node tools/eye/build-sft.mjs export.jsonl sft-out/ gold-pairs.jsonl           # adds "rewrite" examples
```

A pair needs that team's demos on that map in the library you point `--base` at. The local library has NAVI Junior (Mirage) and WBT (Anubis), which gives 3 pairs. Pointed at a full library, it pairs all 13 sheets. Each new manual sheet you add to `gold/` and `index.json` becomes another example. What the sheets show the rule-based generators are missing is in `GENERATOR_GAPS.md`.

**When it's worth it:** once there are roughly 300+ good `eye-trace` examples. Until then the prompt and the tools give more for the effort.

**Recipe (LoRA, ~1–2 h for 4B):**

1. Train a LoRA on `Qwen/Qwen3.5-4B` (or 9B), using `sft.jsonl` as tool-calling chat data:
   - On a rented 24 GB GPU: unsloth or axolotl.
   - On Apple silicon with 16 GB or more: `mlx_lm.lora`.
   - Settings: rank 16, 2–3 epochs, learning rate 1e-4. Train on assistant turns only.
2. Merge the LoRA into the base model. Convert it with `convert_hf_to_gguf.py`, then `llama-quantize … Q4_K_M` (llama.cpp b11706, the version the app runs).
3. Test with `eval.jsonl` and a fixed set of questions: replay each question through the dev agent (`tools/eye/dev-agent.mjs` pointed at a `llama-server` running the new GGUF). Check two things:
   - Did it call the right tool with sane arguments?
   - Does every number in the answer appear in a tool result?
4. Ship it as a new entry in `recorder/app/src/eye/models.rs`, pinned by URL, size and SHA-256 like the others. Add it to `EYE_MODELS` in `eyePanel.js`.

Keep the base models selectable: a fine-tune that scores worse on the eval set does not ship.
