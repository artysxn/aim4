#!/usr/bin/env bash
# One training cycle for aim4 eye's plays skills: baselines, the first lessons,
# the guess-check-learn loop against the current model, the fine-tune, and the
# GGUF. See tools/eye/TRAINING.md ("Plays").
#
#   CORPUS="--rounds-dir server/data/replays/<you>/rounds" \
#   BASE_MODEL=Qwen/Qwen3.5-4B LLAMA=http://127.0.0.1:8899 \
#   LLAMA_CPP=~/llama.cpp OUT=runs/eye-plays-1 ITEMS=400 CYCLES=2 GRADES=aim4-training.jsonl \
#   bash tools/eye/train/run-cycle.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

CORPUS=${CORPUS:-"--dir sampledemos"}
BASE_MODEL=${BASE_MODEL:-Qwen/Qwen3.5-4B}
LLAMA=${LLAMA:-http://127.0.0.1:8899}
OUT=${OUT:-runs/eye-plays}
ITEMS=${ITEMS:-400}
CYCLES=${CYCLES:-1}
GRADES=${GRADES:-}
NODE="node --max-old-space-size=8192"
PLAYS=tools/eye/plays/out

echo "== 1. What is default on each map"
$NODE tools/eye/plays/build-baselines.mjs $CORPUS --publish

echo "== 2. The first lessons (no model needed)"
$NODE tools/eye/plays/build-plays-sft.mjs $CORPUS

echo "== 3. Guess, check, learn (the current model behind $LLAMA)"
if curl -fsS "$LLAMA/v1/models" >/dev/null 2>&1; then
  for i in $(seq 1 "$CYCLES"); do
    $NODE tools/eye/plays/self-train.mjs --llama "$LLAMA" --items "$ITEMS" $CORPUS ${GRADES:+--grades "$GRADES"} --publish
  done
else
  echo "   no model server at $LLAMA: skipped (start llama-server with the current model to add this step)"
fi

SFT_FILES="$PLAYS/plays-sft.jsonl $PLAYS/self-train/sft.jsonl"
DPO_FILES="$PLAYS/plays-dpo.jsonl $PLAYS/self-train/dpo.jsonl"
if [ -n "$GRADES" ]; then
  echo "== 4. Your grades"
  $NODE tools/eye/build-sft.mjs "$GRADES" "$OUT/grades"
  SFT_FILES="$SFT_FILES $OUT/grades/sft.jsonl"
  DPO_FILES="$DPO_FILES $OUT/grades/dpo.jsonl"
fi

echo "== 5. Fine-tune $BASE_MODEL"
python tools/eye/train/train.py --base "$BASE_MODEL" --sft $SFT_FILES --dpo $DPO_FILES --out "$OUT" --merge

if [ -n "${LLAMA_CPP:-}" ]; then
  echo "== 6. GGUF"
  python "$LLAMA_CPP/convert_hf_to_gguf.py" "$OUT/merged" --outfile "$OUT/eye-bf16.gguf" --outtype bf16
  "$LLAMA_CPP/build/bin/llama-quantize" "$OUT/eye-bf16.gguf" "$OUT/eye-Q4_K_M.gguf" Q4_K_M
  echo "-> $OUT/eye-Q4_K_M.gguf"
fi

echo "Next: serve the new model (llama-server -m $OUT/eye-Q4_K_M.gguf --jinja -c 32768 --port 8899) and compare it with the base:"
echo "  $NODE tools/eye/plays/self-train.mjs --eval --llama $LLAMA $CORPUS"
