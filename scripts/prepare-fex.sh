#!/usr/bin/env bash
# Prepare the public pinned frontend without resetting an existing checkout.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FEX=${FEX_DIR:-$ROOT/FEX}
PIN=0f8edf8f6383ae8085e0ffac511c789cdae97514
PATCH=$ROOT/patches/fex-wasm.patch
if [[ ! -e "$FEX" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/willfaust/FEX.git "$FEX"
  git -C "$FEX" checkout --detach "$PIN"
fi
actual=$(git -C "$FEX" rev-parse HEAD)
if [[ "$actual" != "$PIN" ]]; then
  echo "FEX is at $actual, expected $PIN. Existing work was not changed." >&2
  exit 1
fi
if git -C "$FEX" apply --check "$PATCH" 2>/dev/null; then
  git -C "$FEX" apply "$PATCH"
elif git -C "$FEX" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo 'FEX patch is already applied.'
else
  echo 'FEX patch does not match this working tree; refusing to reset local changes.' >&2
  exit 1
fi
git -C "$FEX" submodule update --init --recursive
