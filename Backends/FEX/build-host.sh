#!/usr/bin/env bash
# Build the live FEX-to-Wasm translator for host execution evidence, not native FEX JIT.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Host translator build requires an arm64 Mac.' >&2; exit 1; }
cd "$ROOT"
bash scripts/prepare-fex.sh
FEX="$ROOT/FEX"
B="$FEX/build-host-wasm"
cmake -S "$FEX" -B "$B" -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=OFF -DTUNE_CPU=none \
  -DBUILD_TESTING=OFF -DBUILD_THUNKS=OFF -DBUILD_FEXCONFIG=OFF -DBUILD_FEX_LINUX_TESTS=OFF \
  -DENABLE_FEX_ALLOCATOR=OFF -DENABLE_JEMALLOC_GLIBC_ALLOC=OFF -DENABLE_ASSERTIONS=OFF \
  -DENABLE_OFFLINE_TELEMETRY=OFF -DENABLE_CLANG_THUNKS=OFF
ninja -C "$B" FEXCore FEXCore_Base JemallocLibs fmt xxhash cephes_128bit softfloat_3e
mkdir -p .build/host-fex
BUILD_ID=$(bash fexwasm/build_id.sh "$FEX")
clang++ -std=gnu++20 -O2 -gline-tables-only -fno-exceptions -fno-strict-aliasing -fwrapv -Wno-unused-function \
  "-DFEXWASM_BUILD_ID=\"$BUILD_ID\"" -DARCHITECTURE_arm64=1 -DJIT_ARM64 -D_LARGEFILE64_SOURCE \
  -DFEXCORE_HAS_PRESERVE_ALL_ATTR=1 '-DFEXCORE_PRESERVE_ALL_ATTR=__attribute__((preserve_all))' \
  -DFEX_HAS_PRESERVE_ALL_ATTR=1 '-DFEX_PRESERVE_ALL_ATTR=__attribute__((preserve_all))' \
  -I"$B/FEXCore/Source" -I"$FEX/FEXCore/Source" -I"$FEX/FEXCore/Source/IncludePrivate" -I"$FEX/FEXCore/include" \
  -I"$B/include" -I"$B/generated" -I"$FEX/External/fmt/include" -I"$FEX/External/xxhash" \
  -I"$FEX/FEXHeaderUtils" -I"$FEX/CodeEmitter" -I"$FEX/External/unordered_dense/include" \
  -I"$FEX/External/cephes/include" -I"$FEX/External/SoftFloat-3e/include" -Ifexwasm/src \
  fexwasm/tools/fexserve.cpp fexwasm/src/*.cpp \
  "$B/FEXCore/Source/libFEXCore.a" "$B/FEXCore/Source/libFEXCore_Base.a" "$B/FEXCore/Source/libJemallocLibs.a" \
  "$B/External/fmt/libfmt.a" "$B/External/xxhash/cmake_unofficial/libxxhash.a" \
  "$B/External/cephes/libcephes_128bit.a" "$B/External/SoftFloat-3e/libsoftfloat_3e.a" \
  -o .build/host-fex/fexserve
