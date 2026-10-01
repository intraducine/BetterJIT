#!/bin/bash
# Cache identity includes the frontend revision/patch and build flags, not just
# this backend's sources. An upstream decoder fix must invalidate old Wasm.
set -euo pipefail
cd -P "$(dirname "$0")"
FEX=${1:?usage: build_id.sh FEX_DIRECTORY}
{
  printf '%s\n' 'betterjit-fex-cache-v2'
  git -C "$FEX" rev-parse HEAD
  git -C "$FEX" diff --no-ext-diff --no-textconv HEAD -- .
  cat src/*.cpp src/*.h build_ios.sh build.sh
} | shasum -a 256 | cut -c1-16
