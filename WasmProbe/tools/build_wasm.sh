#!/bin/bash
# Builds Web/bench.wasm from Kernels/kernels.c.
set -euo pipefail
cd "$(dirname "$0")/.."
clang --target=wasm32 -O2 -msimd128 -mbulk-memory -mnontrapping-fptoint -msign-ext \
  -nostdlib -fuse-ld=/opt/homebrew/bin/wasm-ld \
  -Wl,--no-entry -Wl,--initial-memory=134217728 -Wl,--max-memory=134217728 \
  -o Web/bench.wasm Kernels/kernels.c
ls -la Web/bench.wasm
# Demand-paged big-memory kernel: imports its memory so JS sizes the frame pool.
clang --target=wasm32 -O2 -mbulk-memory -nostdlib -fuse-ld=/opt/homebrew/bin/wasm-ld \
  -Wl,--no-entry -Wl,--import-memory -Wl,--initial-memory=16777216 -Wl,--max-memory=4294967296 \
  -Wl,--export=__heap_base -Wl,--allow-undefined \
  -o Web/bigmem.wasm Kernels/bigmem.c
ls -la Web/bigmem.wasm
