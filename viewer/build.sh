#!/usr/bin/env bash
# Bundle the SlicerLive viewer (slicerlive.js + @kitware/vtk.js) into slicerlive-bundle.js with esbuild,
# run in a throwaway node container (no local node needed). vtk.js's UMD global is gone in v36 and generic
# ESM CDNs break its singletons, so we bundle once with ONE shared vtk-core.
#   ./build.sh        # produces slicerlive-bundle.js (loaded by viewer.html)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
docker run --rm -v "$DIR":/work -w /work node:20-slim sh -c '
  set -e
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  echo ">> installing @kitware/vtk.js + esbuild…"
  npm i --no-audit --no-fund --silent @kitware/vtk.js@36.2.0 esbuild >/dev/null 2>&1
  echo ">> bundling…"
  for entry in "slicerlive.js:slicerlive-bundle.js"; do
    src=${entry%%:*}; out=${entry##*:}
    ./node_modules/.bin/esbuild "$src" --bundle --format=iife --outfile="$out" \
      --define:process.env.NODE_ENV=\"production\" --loader:.glsl=text --loader:.svg=text \
      --alias:url=./url-shim.js --alias:events=./events-shim.js --log-level=warning
  done
  echo ">> done:"; ls -la slicerlive-bundle.js
'
