#!/usr/bin/env python3
"""
tools/eye/train/merge.py
Fold the trained LoRA adapters into the base model's own checkpoint, shard by
shard, and keep everything else exactly as the base has it.

transformers loads Qwen3.5/3.8 for text only: it leaves out the vision tower
and the MTP layer (`mtp.*`), so saving the trained model writes neither. The
app needs both: the vision tower for the mmproj, and the MTP layer, which
llama-server drafts tokens with (about twice the writing speed on the 27B).
Here the base checkpoint is copied as it is, with each trained weight replaced
by W + (B @ A) * alpha / r for every adapter in order, so llama.cpp's
convert_hf_to_gguf.py sees the same model it converts for the base, trained.

  python tools/eye/train/merge.py --base Qwen/Qwen3.8-27B --run runs/eye-plays-1 --out runs/eye-plays-1/merged

  --run       a train.py output folder: its adapters.json says which adapters
              make the trained model, in order
  --adapters  or the adapter folders themselves, in order

Works on the CPU with about one shard of memory (a few GB); the GPU is not needed.
"""

import argparse
import json
import os
import shutil
import sys


def base_dir(base):
    if os.path.isdir(base):
        return base
    from huggingface_hub import snapshot_download

    return snapshot_download(base)


def adapter_deltas(path, torch):
    """{module path in the checkpoint, e.g. model.language_model.layers.0.mlp.up_proj: (A, B, scale)}"""
    from safetensors.torch import load_file

    cfg = json.load(open(os.path.join(path, "adapter_config.json")))
    if cfg.get("use_dora"):
        raise SystemExit(f"{path}: DoRA adapters are not handled here")
    r, alpha = cfg["r"], cfg["lora_alpha"]
    scale = alpha / (r**0.5) if cfg.get("use_rslora") else alpha / r
    sd = load_file(os.path.join(path, "adapter_model.safetensors"))
    out = {}
    for k, a in sd.items():
        if ".lora_A." not in k:
            continue
        module = k.split(".lora_A.")[0]
        b = sd[k.replace(".lora_A.", ".lora_B.")]
        module = module.removeprefix("base_model.model.")
        out[module] = (a, b, scale)
    return out


def checkpoint_key(module, names):
    """The base checkpoint's name for a trained module's weight (text-only load names it model.layers...)."""
    for cand in (module, module.replace("model.", "model.language_model.", 1)):
        if cand + ".weight" in names:
            return cand + ".weight"
    return None


def merge(base, adapters, out):
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    src = base_dir(base)
    index_path = os.path.join(src, "model.safetensors.index.json")
    shards = sorted(set(json.load(open(index_path))["weight_map"].values())) if os.path.exists(index_path) else ["model.safetensors"]
    names = set()
    for s in shards:
        with safe_open(os.path.join(src, s), "pt") as f:
            names.update(f.keys())

    stack = []
    for path in adapters:
        deltas = adapter_deltas(path, torch)
        mapped = {}
        for module, d in deltas.items():
            key = checkpoint_key(module, names)
            if key is None:
                raise SystemExit(f"{path}: {module} has no weight in the base checkpoint")
            mapped[key] = d
        stack.append(mapped)
        print(f"  {path}: {len(mapped)} weights")

    os.makedirs(out, exist_ok=True)
    patched = 0
    for s in shards:
        tensors = {}
        with safe_open(os.path.join(src, s), "pt") as f:
            meta = f.metadata() or {"format": "pt"}
            for k in f.keys():
                w = f.get_tensor(k)
                hits = [m[k] for m in stack if k in m]
                if hits:
                    acc = w.float()
                    for a, b, scale in hits:
                        acc += (b.float() @ a.float()) * scale
                    w = acc.to(w.dtype)
                    patched += 1
                tensors[k] = w
        save_file(tensors, os.path.join(out, s), metadata=meta)
        print(f"  {s}: {len(tensors)} tensors")
    for name in os.listdir(src):
        p = os.path.join(src, name)
        if os.path.isfile(p) and not name.endswith(".safetensors") and not name.startswith("."):
            shutil.copy(p, out)
    print(f"Merged {patched} weights into {len(shards)} shard(s) -> {out}")
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", required=True, help="Hugging Face id or local folder of the base checkpoint")
    p.add_argument("--run", default="", help="train.py's --out folder (reads adapters.json)")
    p.add_argument("--adapters", nargs="*", default=[], help="adapter folders, in the order they were trained")
    p.add_argument("--out", required=True)
    args = p.parse_args()
    adapters = args.adapters
    if args.run:
        adapters = [os.path.join(args.run, a) for a in json.load(open(os.path.join(args.run, "adapters.json")))]
    if not adapters:
        raise SystemExit("no adapters: pass --run or --adapters")
    merge(args.base, adapters, args.out)


if __name__ == "__main__":
    sys.exit(main())
