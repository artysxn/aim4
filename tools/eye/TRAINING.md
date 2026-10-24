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

## Plays: what is default, what is a play, and was it good

Two skills, both measured in code first and then taught to the model:

1. **Default or play.** A play is a decision: an execute, split, rush or contact hit, a fake, a lurk, a rotation, a stack, a push, a retake, a save, how the post-plant is held. A default is what a side does before it commits, or a setup many teams use. Which is which is learned from the library, not written down: `src/replays/plays/playMap.js` learns per map where each side stands per economy and per 10 seconds of the clock, how unusual one round's shape is against that, and how often each kind of play is run. `findPlays.js` reads a round against it (kinds and their definitions are at the top of the file and in `DEFINITIONS`), and `summarize` tells the round in simple terms.
2. **Good or bad.** `playReview.js` puts the moment a play started to Similar Rounds: the closest rounds on the map in the same buys. It reports what the same side chose from there and how each choice went (rounds won, win-chance change), how this play went against the rounds that chose the same, and which grenades and timings went with winning ("with a flash on A site 12 of 12 won, without it 0 of 12"). Those the play lacked become the improvements. The verdict has two parts: the decision (the choice against the alternatives) and the execution (against the same choice). The autocoach's rules come in only when there are too few similar rounds, and are marked as rules, not measurements.

In the app (desktop only, like Similar Rounds; the work runs in the app's own server, `server/similar/plays.js`):

| Tool | What it returns |
| --- | --- |
| `round_moves` | the round with no labels: each player's path, both sides' shape every 10 s, utility, kills, plant |
| `round_plays` | the plays, default or play, how usual, what each did to the win chance, a summary; with `guess`, the model's own reading checked (right, wrong, missed, and the definitions of what it missed) |
| `play_review` | one play judged against similar rounds; with `guess`, the model's verdict checked |

The prompt has the eye guess before it checks: `round_moves`, then its reading as `round_plays`' guess, then the answer. Lessons it learned in training (`public/eye/play-notes.json`) ride in the play tools' results for the map in question.

A map's baseline comes from `public/eye/play-baselines/<MAP>.json` when there is one, otherwise the app's server learns it from the library on the first question about that map (a few seconds to a minute) and keeps it for 12 hours.

### How it learns: guess, check, confirm, note

`tools/eye/plays/self-train.mjs` asks the current model about many rounds, the way the app asks:

- **plays**: it reads the moves and guesses the plays; the check scores the guess (F1 over the plays, half credit for the right idea with the wrong kind); then it answers.
- **review**: it guesses a play's verdict; the review checks it; then it answers.

What it got right stays in its own words (confirmed). What it got wrong is replaced by the right guess and the reference answer, and the right turn is paired against its own as a preference pair (DPO): it learns from its real mistakes. Items it got wrong come back first in the next run (reinforced); an item right twice in a row is confirmed and left alone. Repeated mistakes ("on Mirage you read 7 of 10 B contacts as executes") become lessons with the definition of what it confused, in `play-notes.json`.

Your grades count too:

- **Good / Bad under any answer** (admins): a "Bad" with a note is in the eye's prompt from the next answer on (`gradeLessonsNote`, newest twelve), so it is remembered before any training.
- `tools/eye/build-sft.mjs` turns the export into training data. Good answers are traces to learn from, and a question graded both ways becomes a preference pair.
- `self-train.mjs --grades export.jsonl` turns the notes into lessons. It also pairs a bad answer to a plays or review question with the answer that turn's own tool results support.

### Training it on your PC

Node builds the data; Python (`tools/eye/train/train.py`) trains. A whole cycle is one command:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File tools/eye/train/run-cycle.ps1 `
  -Corpus '--base http://127.0.0.1:<app port> --token <sign-in token>' `
  -BaseModel Qwen/Qwen3.5-4B -Llama http://127.0.0.1:8899 -LlamaCpp C:\llama.cpp `
  -Out runs/eye-plays-1 -Items 400 -Cycles 2 -Grades aim4-training.jsonl
```

```bash
# Linux / a rented GPU
CORPUS="--rounds-dir server/data/replays/<you>/rounds" BASE_MODEL=Qwen/Qwen3.5-4B \
LLAMA=http://127.0.0.1:8899 LLAMA_CPP=~/llama.cpp OUT=runs/eye-plays-1 ITEMS=400 CYCLES=2 \
bash tools/eye/train/run-cycle.sh
```

Step by step, what it runs:

1. **The rounds** (`tools/eye/plays/corpus.mjs`, flags shared by every script). Use `--dir <folder>` for `.aim4replay` packages (the default is `sampledemos/`). Use `--rounds-dir` for a server library on disk. Use `--base <url> --token <token>` for the library through a running aim4 server: the desktop app's own, with the Bearer token from any `/api` request in the browser's network tab. Downloads are cached in `tools/eye/plays/out/cache/`, so an expired token loses nothing. More rounds mean better baselines and closer similar rounds: a few hundred a map is a start, a few thousand is good. Run `node scripts/fetch-zone-networks.mjs` once first, so places get their real callouts and bombsites their real names.
2. `node --max-old-space-size=8192 tools/eye/plays/build-baselines.mjs <corpus> --publish` learns each map's default and writes `public/eye/play-baselines/`.
3. `node tools/eye/plays/build-plays-sft.mjs <corpus>` writes the first lessons, no model needed. It writes `out/plays-sft.jsonl` and `out/plays-dpo.jsonl`, and `out/plays-eval.jsonl` from held-out matches (one in five, never split within a match).
4. **Guess, check, learn.** Serve the current model (`llama-server -m <model>.gguf --jinja -c 32768 --port 8899`). Then run `node tools/eye/plays/self-train.mjs --llama http://127.0.0.1:8899 <corpus> --items 400 --publish`, as many runs as you like; each one adds to `out/self-train/`.
5. **Train.** `pip install -r tools/eye/train/requirements.txt` (torch for your GPU first), then `python tools/eye/train/train.py --base Qwen/Qwen3.5-4B --sft <files> --dpo <files> --out runs/eye-plays-1 --merge`. It trains a LoRA on the SFT traces (rank 16, 2 epochs, lr 1e-4, assistant turns only), merges it, trains a second LoRA on the preference pairs (beta 0.1, lr 5e-6; the reference is the model after SFT), and writes merged weights. `--check-data` renders and measures the data without training; `--4bit` fits 9B on 24 GB. Every record carries the app's whole system prompt and tool list (about 16k tokens before the question), so records run to about 20k tokens and `--max-len` is 24k. On a smaller card, `--keep-tools round_moves,round_plays,play_review,round_value,moment_value` renders only those tool schemas (about 10k tokens less), at the price of training on a shorter list than the app sends.
6. **GGUF.** `python convert_hf_to_gguf.py runs/eye-plays-1/merged --outfile eye-bf16.gguf`, then `llama-quantize eye-bf16.gguf eye-Q4_K_M.gguf Q4_K_M` (llama.cpp b11706, the version the app runs).
7. **Compare before you ship.** Serve the base and the fine-tune in turn and run `self-train.mjs --eval <corpus>` against each. It scores the held-out matches (guess score, verdicts right, answers grounded) and learns nothing. Ship the fine-tune only if it beats the base without losing grounding. Shipping means a new entry in `recorder/app/src/eye/models.rs` and in `EYE_MODELS` in `eyePanel.js`.
8. **Again.** Serve the new model and go back to step 4. Each cycle it guesses better, so what it gets wrong is harder and the lessons get finer.

On a rented GPU (24 GB or more): build the data at home (steps 1 to 4 need your library and a served model), copy `tools/eye/plays/out/*.jsonl`, `tools/eye/plays/out/self-train/*.jsonl` and `tools/eye/train/` over, and run step 5 there. The JSONL files are self-contained: system prompt, tool schemas and tool results are in every record.

Where the thresholds are, if a reading looks wrong: hit kinds, lurks, stacks, pushes and retakes are in the constants at the top of `findPlays.js`; similar-round selection, the evidence needed for an improvement and the verdict rules are at the top of `playReview.js`. Change them, rebuild the baselines and the data, and the eye learns the new definitions (they are also what its lessons quote).

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

**When it's worth it:** once there are roughly 300+ good `eye-trace` examples. Until then the prompt and the tools give more for the effort. (The plays data above needs no grades: it can be trained on as soon as the corpus is big enough.)

`tools/eye/train/train.py` trains on any of these files (SFT and DPO JSONL, see its header). The recipe below is what it does; the steps are kept for other trainers.

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
