#!/usr/bin/env bash
# Unmodified pinned FEX core, isolated from BetterJIT's prepared vendor checkout.
set -euo pipefail
corpus_root=$(cd "$(dirname "$0")/../.." && pwd)
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo 'Native corpus build requires macOS ARM64.' >&2
  exit 77
fi
corpus_source="$corpus_root/.build/corpus-source/fex"
corpus_build="$corpus_root/.build/corpus-native-build"
corpus_asset="$corpus_root/.build/corpus-native-asset"
python3 "$corpus_root/research/corpus/source.py" "$corpus_source" --dependencies
mkdir -p "$corpus_build" "$corpus_asset"
cmake -S "$corpus_source" -B "$corpus_build" -G Ninja \
  -DCMAKE_C_COMPILER="$(command -v clang)" -DCMAKE_CXX_COMPILER="$(command -v clang++)" \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=OFF -DTUNE_CPU=none \
  -DBUILD_TESTING=OFF -DBUILD_THUNKS=OFF -DBUILD_FEXCONFIG=OFF -DBUILD_FEX_LINUX_TESTS=OFF \
  -DENABLE_FEX_ALLOCATOR=OFF -DENABLE_JEMALLOC_GLIBC_ALLOC=OFF -DENABLE_ASSERTIONS=OFF \
  -DENABLE_OFFLINE_TELEMETRY=OFF -DENABLE_CLANG_THUNKS=OFF -DENABLE_ZYDIS=OFF \
  -DENABLE_GUEST_WINDOW=OFF
cmake --build "$corpus_build" --parallel 3 --target FEXCore FEXCore_Base JemallocLibs fmt xxhash cephes_128bit softfloat_3e
clang++ -std=gnu++20 -O2 -DNDEBUG -fno-exceptions -fno-strict-aliasing -fwrapv -Wno-unused-function \
  -DARCHITECTURE_arm64=1 -DJIT_ARM64 -D_LARGEFILE64_SOURCE \
  -DFEXCORE_HAS_PRESERVE_ALL_ATTR=1 '-DFEXCORE_PRESERVE_ALL_ATTR=__attribute__((preserve_all))' \
  -DFEX_HAS_PRESERVE_ALL_ATTR=1 '-DFEX_PRESERVE_ALL_ATTR=__attribute__((preserve_all))' \
  -I"$corpus_build/FEXCore/Source" -I"$corpus_source/FEXCore/Source" -I"$corpus_source/FEXCore/Source/IncludePrivate" \
  -I"$corpus_source/FEXCore/include" -I"$corpus_build/include" -I"$corpus_build/generated" \
  -I"$corpus_source/External/fmt/include" -I"$corpus_source/External/xxhash" \
  -I"$corpus_source/FEXHeaderUtils" -I"$corpus_source/CodeEmitter" -I"$corpus_source/External/unordered_dense/include" \
  -I"$corpus_source/External/cephes/include" -I"$corpus_source/External/SoftFloat-3e/include" \
  "$corpus_root/research/corpus/native-arm64.cpp" \
  "$corpus_build/FEXCore/Source/libFEXCore.a" "$corpus_build/FEXCore/Source/libFEXCore_Base.a" "$corpus_build/FEXCore/Source/libJemallocLibs.a" \
  "$corpus_build/External/fmt/libfmt.a" "$corpus_build/External/xxhash/cmake_unofficial/libxxhash.a" \
  "$corpus_build/External/cephes/libcephes_128bit.a" "$corpus_build/External/SoftFloat-3e/libsoftfloat_3e.a" \
  -o "$corpus_asset/corpus-native-arm64"
# Keep an explicit build receipt, never a copied test outcome.
python3 - "$corpus_build/CMakeCache.txt" "$corpus_asset/options.json" <<'PY'
import json,sys
from pathlib import Path
prefixes=('CMAKE_BUILD_TYPE:', 'CMAKE_SYSTEM_NAME:', 'CMAKE_OSX_ARCHITECTURES:', 'ENABLE_', 'BUILD_', 'TUNE_CPU:')
rows=[line for line in Path(sys.argv[1]).read_text().splitlines() if line.startswith(prefixes)]
Path(sys.argv[2]).write_text(json.dumps({'selectedCMakeCache':rows,'iOSRuntime':False,'GuestWindow':False,'FEX_IOS_HOST':False},indent=2)+'\n')
PY
