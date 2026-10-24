# One training cycle for aim4 eye's plays skills, on Windows: baselines, the
# first lessons, the guess-check-learn loop against the current model, the
# fine-tune, and the GGUF. See tools/eye/TRAINING.md ("Plays").
#
#   powershell -ExecutionPolicy Bypass -File tools/eye/train/run-cycle.ps1 `
#     -Corpus '--rounds-dir server/data/replays/<you>/rounds' -BaseModel Qwen/Qwen3.5-4B `
#     -Llama http://127.0.0.1:8899 -LlamaCpp C:\llama.cpp -Out runs/eye-plays-1 -Items 400 -Cycles 2 -Grades aim4-training.jsonl
param(
  [string]$Corpus = '--dir sampledemos',
  [string]$BaseModel = 'Qwen/Qwen3.5-4B',
  [string]$Llama = 'http://127.0.0.1:8899',
  [string]$Out = 'runs/eye-plays',
  [int]$Items = 400,
  [int]$Cycles = 1,
  [string]$Grades = '',
  [string]$LlamaCpp = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..\..')
$corpusArgs = $Corpus -split ' ' | Where-Object { $_ }
$node = @('--max-old-space-size=8192')
$plays = 'tools/eye/plays/out'

function Run($exe, $argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" }
}

Write-Host '== 1. What is default on each map'
Run node ($node + @('tools/eye/plays/build-baselines.mjs') + $corpusArgs + @('--publish'))

Write-Host '== 2. The first lessons (no model needed)'
Run node ($node + @('tools/eye/plays/build-plays-sft.mjs') + $corpusArgs)

Write-Host "== 3. Guess, check, learn (the current model behind $Llama)"
$up = $false
try { Invoke-WebRequest -UseBasicParsing "$Llama/v1/models" -TimeoutSec 5 | Out-Null; $up = $true } catch { }
if ($up) {
  for ($i = 1; $i -le $Cycles; $i++) {
    $a = $node + @('tools/eye/plays/self-train.mjs', '--llama', $Llama, '--items', "$Items") + $corpusArgs + @('--publish')
    if ($Grades) { $a += @('--grades', $Grades) }
    Run node $a
  }
} else {
  Write-Host "   no model server at ${Llama}: skipped (start llama-server with the current model to add this step)"
}

$sft = @("$plays/plays-sft.jsonl", "$plays/self-train/sft.jsonl")
$dpo = @("$plays/plays-dpo.jsonl", "$plays/self-train/dpo.jsonl")
if ($Grades) {
  Write-Host '== 4. Your grades'
  Run node ($node + @('tools/eye/build-sft.mjs', $Grades, "$Out/grades"))
  $sft += "$Out/grades/sft.jsonl"
  $dpo += "$Out/grades/dpo.jsonl"
}

Write-Host "== 5. Fine-tune $BaseModel"
Run python (@('tools/eye/train/train.py', '--base', $BaseModel, '--sft') + $sft + @('--dpo') + $dpo + @('--out', $Out, '--merge'))

if ($LlamaCpp) {
  Write-Host '== 6. GGUF'
  Run python @("$LlamaCpp/convert_hf_to_gguf.py", "$Out/merged", '--outfile', "$Out/eye-bf16.gguf", '--outtype', 'bf16')
  Run "$LlamaCpp/build/bin/Release/llama-quantize.exe" @("$Out/eye-bf16.gguf", "$Out/eye-Q4_K_M.gguf", 'Q4_K_M')
  Write-Host "-> $Out/eye-Q4_K_M.gguf"
}

Write-Host "Next: serve the new model (llama-server -m $Out/eye-Q4_K_M.gguf --jinja -c 32768 --port 8899) and compare it with the base:"
Write-Host "  node --max-old-space-size=8192 tools/eye/plays/self-train.mjs --eval --llama $Llama $Corpus"
