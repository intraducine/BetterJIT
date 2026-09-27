#!/usr/bin/env bash
# Compile ordinary C to this SDK's imported-memory ABI. No Emscripten/Iridium.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-"$ROOT/.build/c-guest"}
CC=${WASM_CLANG:-clang}
mkdir -p "$OUT"
"$CC" --target=wasm32 -O2 -fno-builtin -nostdlib -I"$ROOT/Guest/include" \
  "$ROOT/Examples/CGuest/guest.c" -Wl,--no-entry -Xlinker '--import-memory=betterjit,memory' \
  -Wl,--export=checksum -Wl,--export=host_double -Wl,-z,stack-size=65536 -o "$OUT/guest.wasm"
"${NATIVE_CC:-clang}" -O2 "$ROOT/Examples/CGuest/guest.c" "$ROOT/Examples/CGuest/reference.c" -o "$OUT/reference"
"$OUT/reference" > "$OUT/reference.txt"
printf 'Compiled guest and independent native reference: %s\n' "$OUT"
