#!/usr/bin/env python3
"""
tools/eye/train/train.py
Fine-tune aim4 eye's model on what tools/eye builds: the traces to learn from
first (SFT), then the preference pairs (DPO), as LoRA adapters on an open
Qwen model. Runs on one NVIDIA GPU (24 GB for 4B in bf16; --4bit for less, or
for 9B on 24 GB), at home or on a rented card.

  python tools/eye/train/train.py --base Qwen/Qwen3.5-4B \\
      --sft tools/eye/plays/out/plays-sft.jsonl tools/eye/plays/out/self-train/sft.jsonl sft-out/sft.jsonl \\
      --dpo tools/eye/plays/out/plays-dpo.jsonl tools/eye/plays/out/self-train/dpo.jsonl sft-out/dpo.jsonl \\
      --out runs/eye-plays-1 --merge

Input (JSON Lines, what the tools/eye scripts write):
  SFT  { "messages": [...], "tools": [...] }   OpenAI chat format with tool calls
  DPO  { "prompt": [...], "chosen": [...], "rejected": [...], "tools": [...] }

Only the assistant's own turns are learned (its tool calls and answers); the
system prompt, the questions and the tool results are context. Every record is
rendered with the base model's own chat template and tools, exactly as
llama-server renders the app's requests.

Out (in --out):
  sft-adapter/   the LoRA after SFT
  dpo-adapter/   the LoRA after DPO (on top of the SFT weights)
  merged/        with --merge: full weights, ready for llama.cpp's
                 convert_hf_to_gguf.py and llama-quantize (see TRAINING.md)

  --check-data   read and render everything, report sizes, train nothing

Every record carries the app's whole system prompt and tool list, as the app
sends them: about 16k tokens before the question. --max-len is 24k by default;
on a smaller card, --keep-tools round_moves,round_plays,play_review,round_value,moment_value
renders only those schemas (about 10k tokens less), at the price of training on
a shorter list than the app offers.
"""

import argparse
import glob
import inspect
import json
import math
import os
import random
import sys

CHATML_START = "<|im_start|>assistant\n"
CHATML_END = "<|im_end|>"


def parse_args():
    p = argparse.ArgumentParser(description="Fine-tune aim4 eye (SFT then DPO, LoRA).")
    p.add_argument("--base", required=True, help="Hugging Face id or local path of the base model (Qwen/Qwen3.5-4B)")
    p.add_argument("--sft", nargs="*", default=[], help="SFT JSONL files (globs allowed; missing files are skipped)")
    p.add_argument("--dpo", nargs="*", default=[], help="DPO JSONL files")
    p.add_argument("--out", default="runs/eye", help="output directory")
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--dpo-epochs", type=float, default=1.0)
    p.add_argument("--dpo-lr", type=float, default=5e-6)
    p.add_argument("--dpo-beta", type=float, default=0.1)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--alpha", type=int, default=32)
    p.add_argument("--max-len", type=int, default=24576, help="longest record in tokens; longer ones are left out (the app's prompt and tool list alone are about 16k)")
    p.add_argument("--keep-tools", default="", help="only these tool schemas in every record (comma list): a shorter context when memory is short, at the price of training on less than the app sends")
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--accum", type=int, default=8)
    p.add_argument("--limit", type=int, default=0, help="at most this many records of each kind (a quick trial)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--4bit", dest="four_bit", action="store_true", help="load the base in 4 bit (QLoRA): less memory")
    p.add_argument("--merge", action="store_true", help="write full merged weights to --out/merged for GGUF")
    p.add_argument("--check-data", action="store_true", help="render and measure the data, train nothing")
    p.add_argument("--assistant-start", default=CHATML_START, help="what opens an assistant turn in the rendered chat (ChatML for Qwen)")
    p.add_argument("--turn-end", default=CHATML_END, help="what closes a turn")
    p.add_argument("--cpu", action="store_true", help="train on the CPU (only for testing this script)")
    return p.parse_args()


# ---- data ---------------------------------------------------------------------


def read_jsonl(patterns, limit=0, seed=42):
    rows = []
    for pattern in patterns:
        files = sorted(glob.glob(pattern)) or ([pattern] if os.path.exists(pattern) else [])
        if not files:
            print(f"  (skipped {pattern}: not found)")
        for path in files:
            n = 0
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                        n += 1
                    except json.JSONDecodeError:
                        pass
            print(f"  {path}: {n}")
    random.Random(seed).shuffle(rows)
    return rows[:limit] if limit else rows


def normalise(messages):
    """Tool call arguments as objects: chat templates write them with tojson."""
    out = []
    for m in messages:
        m = dict(m)
        if m.get("tool_calls"):
            calls = []
            for c in m["tool_calls"]:
                c = json.loads(json.dumps(c))
                fn = c.get("function", {})
                if isinstance(fn.get("arguments"), str):
                    try:
                        fn["arguments"] = json.loads(fn["arguments"] or "{}")
                    except json.JSONDecodeError:
                        fn["arguments"] = {}
                c["function"] = fn
                calls.append(c)
            m["tool_calls"] = calls
        if m.get("content") is None:
            m["content"] = ""
        out.append(m)
    return out


KEEP_TOOLS = set()


def render(tok, messages, tools, generation=False):
    if tools and KEEP_TOOLS:
        tools = [t for t in tools if t.get("function", {}).get("name") in KEEP_TOOLS]
    kwargs = dict(tokenize=False, add_generation_prompt=generation)
    if tools:
        kwargs["tools"] = tools
    try:
        # Qwen3's switch; the app asks with thinking off unless it says otherwise.
        return tok.apply_chat_template(normalise(messages), enable_thinking=False, **kwargs)
    except TypeError:
        return tok.apply_chat_template(normalise(messages), **kwargs)


def assistant_spans(text, start, end):
    """Character spans of every assistant turn's body, through its end marker."""
    spans = []
    i = text.find(start)
    while i >= 0:
        body = i + len(start)
        j = text.find(end, body)
        stop = len(text) if j < 0 else j + len(end)
        spans.append((body, stop))
        i = text.find(start, stop)
    return spans


def tokenize_sft(tok, row, args):
    text = render(tok, row["messages"], row.get("tools"))
    enc = tok(text, return_offsets_mapping=True, add_special_tokens=False)
    ids = enc["input_ids"]
    if len(ids) > args.max_len:
        return None
    spans = assistant_spans(text, args.assistant_start, args.turn_end)
    labels = [-100] * len(ids)
    k = 0
    for t, (a, b) in enumerate(enc["offset_mapping"]):
        while k < len(spans) and spans[k][1] <= a:
            k += 1
        if k < len(spans) and spans[k][0] <= a < spans[k][1]:
            labels[t] = ids[t]
    if all(x == -100 for x in labels):
        return None
    return {"input_ids": ids, "labels": labels}


def split_dpo(tok, row):
    """Prompt text and the two completions, each rendered after the same prompt."""
    tools = row.get("tools")
    prompt = render(tok, row["prompt"], tools)
    out = {"prompt": prompt}
    for side in ("chosen", "rejected"):
        full = render(tok, row["prompt"] + row[side], tools)
        if not full.startswith(prompt):
            return None
        # Ending on the turn's end marker, not the newline after it: TRL adds an EOS to a completion that does not end with one.
        out[side] = full[len(prompt):].rstrip("\n")
    if out["chosen"] == out["rejected"]:
        return None
    return out


# ---- training -------------------------------------------------------------------


def only_known(cls, **kwargs):
    """Keyword arguments a config class takes, in whatever version is installed."""
    names = set(inspect.signature(cls.__init__).parameters)
    # transformers 5 folded warmup_ratio into warmup_steps (a float under 1 is a ratio).
    if "warmup_ratio" in kwargs and "warmup_ratio" not in names:
        kwargs["warmup_steps"] = kwargs.pop("warmup_ratio")
    dropped = [k for k in kwargs if k not in names]
    if dropped:
        print(f"  ({cls.__name__} in this version has no {', '.join(dropped)}: left out)")
    return cls(**{k: v for k, v in kwargs.items() if k in names})


def load_base(args, torch):
    from transformers import AutoModelForCausalLM

    kwargs = {"torch_dtype": torch.float32 if args.cpu else torch.bfloat16, "trust_remote_code": True}
    if args.four_bit and not args.cpu:
        from transformers import BitsAndBytesConfig

        kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    if not args.cpu:
        kwargs["device_map"] = "auto"
    model = AutoModelForCausalLM.from_pretrained(args.base, **kwargs)
    if args.four_bit and not args.cpu:
        from peft import prepare_model_for_kbit_training

        model = prepare_model_for_kbit_training(model)
    model.config.use_cache = False
    return model


def lora(args):
    from peft import LoraConfig

    return LoraConfig(r=args.rank, lora_alpha=args.alpha, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")


def train_sft(args, tok, model, rows, torch):
    from peft import get_peft_model
    from transformers import Trainer, TrainingArguments

    data = [x for x in (tokenize_sft(tok, r, args) for r in rows) if x]
    print(f"SFT: {len(data)} records ({len(rows) - len(data)} left out: too long or no assistant turn)")
    if not data:
        return model
    if not args.cpu and hasattr(model, "enable_input_require_grads"):
        # Gradient checkpointing through a frozen base needs the inputs to carry gradients.
        model.enable_input_require_grads()
    model = get_peft_model(model, lora(args))
    model.print_trainable_parameters()
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id

    def collate(batch):
        n = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), n), pad, dtype=torch.long)
        labels = torch.full((len(batch), n), -100, dtype=torch.long)
        mask = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            L = len(b["input_ids"])
            ids[i, :L] = torch.tensor(b["input_ids"])
            labels[i, :L] = torch.tensor(b["labels"])
            mask[i, :L] = 1
        return {"input_ids": ids, "labels": labels, "attention_mask": mask}

    targs = only_known(
        TrainingArguments,
        output_dir=os.path.join(args.out, "sft-work"),
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=5,
        save_strategy="no",
        bf16=not args.cpu,
        gradient_checkpointing=not args.cpu,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        remove_unused_columns=False,
        report_to=[],
        seed=args.seed,
        use_cpu=args.cpu,
    )
    Trainer(model=model, args=targs, train_dataset=data, data_collator=collate).train()
    model.save_pretrained(os.path.join(args.out, "sft-adapter"))
    print(f"SFT adapter -> {os.path.join(args.out, 'sft-adapter')}")
    return model


def train_dpo(args, tok, model, rows, torch):
    from datasets import Dataset
    from peft import PeftModel, get_peft_model
    from trl import DPOConfig, DPOTrainer

    pairs = [x for x in (split_dpo(tok, r) for r in rows) if x]
    pairs = [p for p in pairs if len(tok(p["prompt"] + p["chosen"], add_special_tokens=False)["input_ids"]) <= args.max_len]
    print(f"DPO: {len(pairs)} pairs ({len(rows) - len(pairs)} left out)")
    if not pairs:
        return model
    # The reference is the model after SFT: its LoRA is merged into the weights and
    # a fresh one learns the preferences (in 4 bit the weights cannot take a merge,
    # so the SFT LoRA goes on learning and the reference is the base).
    if isinstance(model, PeftModel) and not args.four_bit:
        model = model.merge_and_unload()
    if not isinstance(model, PeftModel):
        model = get_peft_model(model, lora(args))
    cfg = only_known(
        DPOConfig,
        output_dir=os.path.join(args.out, "dpo-work"),
        beta=args.dpo_beta,
        num_train_epochs=args.dpo_epochs,
        learning_rate=args.dpo_lr,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        max_length=args.max_len,
        max_prompt_length=args.max_len,
        logging_steps=5,
        save_strategy="no",
        bf16=not args.cpu,
        gradient_checkpointing=not args.cpu,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        remove_unused_columns=False,
        report_to=[],
        seed=args.seed,
        use_cpu=args.cpu,
    )
    kwargs = dict(model=model, ref_model=None, args=cfg, train_dataset=Dataset.from_list(pairs))
    params = set(inspect.signature(DPOTrainer.__init__).parameters)
    kwargs["processing_class" if "processing_class" in params else "tokenizer"] = tok
    DPOTrainer(**kwargs).train()
    model.save_pretrained(os.path.join(args.out, "dpo-adapter"))
    print(f"DPO adapter -> {os.path.join(args.out, 'dpo-adapter')}")
    return model


def main():
    args = parse_args()
    random.seed(args.seed)
    KEEP_TOOLS.update(t.strip() for t in args.keep_tools.split(",") if t.strip())
    os.makedirs(args.out, exist_ok=True)
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    print("Reading SFT records:")
    sft_rows = read_jsonl(args.sft, args.limit, args.seed)
    print("Reading DPO pairs:")
    dpo_rows = read_jsonl(args.dpo, args.limit, args.seed)

    if args.check_data:
        sizes = []
        learned = 0
        for r in sft_rows:
            x = tokenize_sft(tok, r, argparse.Namespace(**{**vars(args), "max_len": 10**9}))
            if x:
                sizes.append(len(x["input_ids"]))
                learned += sum(1 for l in x["labels"] if l != -100)
        pairs = [x for x in (split_dpo(tok, r) for r in dpo_rows) if x]
        if sizes:
            sizes.sort()
            print(f"SFT: {len(sizes)} records, tokens median {sizes[len(sizes) // 2]}, 95% {sizes[int(len(sizes) * 0.95)]}, max {sizes[-1]}; {math.floor(learned / max(1, sum(sizes)) * 100)}% of tokens are learned; {sum(1 for s in sizes if s > args.max_len)} over --max-len")
        print(f"DPO: {len(pairs)} of {len(dpo_rows)} pairs render cleanly")
        return

    import torch

    model = load_base(args, torch)
    if sft_rows:
        model = train_sft(args, tok, model, sft_rows, torch)
    if dpo_rows:
        model = train_dpo(args, tok, model, dpo_rows, torch)
    if args.merge:
        from peft import PeftModel

        if args.four_bit:
            print("--merge with --4bit: load the base in bf16 and the adapter, then merge (see TRAINING.md); skipped here.")
        else:
            merged = model.merge_and_unload() if isinstance(model, PeftModel) else model
            path = os.path.join(args.out, "merged")
            merged.save_pretrained(path, safe_serialization=True)
            tok.save_pretrained(path)
            print(f"Merged weights -> {path}")


if __name__ == "__main__":
    sys.exit(main())
