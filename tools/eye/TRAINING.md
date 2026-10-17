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
