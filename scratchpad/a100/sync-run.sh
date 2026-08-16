#!/bin/bash
# Sync feature/detector code to spw2, run a Deno script full-res on the A100 GPU,
# pull review PNGs back to the Air. Usage: sync-run.sh <script.ts> [args...]
set -e
cd /Users/pieper/slicer/SlicerLive
Q='-o LogLevel=ERROR'
scp -q algorithms/features/*.ts spw2:~/seg/algorithms/features/ 2>/dev/null
scp -q render/device.ts spw2:~/seg/render/ 2>/dev/null
scp -q scratchpad/*.ts spw2:~/seg/scratchpad/ 2>/dev/null
ssh $Q spw2 "cd ~/seg && KITS_DIR=/home/ubuntu/kits ~/.deno/bin/deno run --unstable-webgpu -A scratchpad/$1 ${@:2} 2>&1 | grep -vE 'readline|Download'"
mkdir -p scratchpad/feat
scp -q "spw2:~/seg/scratchpad/feat/*" scratchpad/feat/ 2>/dev/null || true
echo "[sync-run] review PNGs pulled to scratchpad/feat/"
