#!/usr/bin/env bash
# Build the live FEX-to-Wasm translator for host execution evidence, not native FEX JIT.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OS=$(uname -s)
ARCH=$(uname -m)
FEX_OPTIONS=()
HOST_FLAGS=(-DARCHITECTURE_arm64=1
  -DFEXCORE_HAS_PRESERVE_ALL_ATTR=1 '-DFEXCORE_PRESERVE_ALL_ATTR=__attribute__((preserve_all))'
  -DFEX_HAS_PRESERVE_ALL_ATTR=1 '-DFEX_PRESERVE_ALL_ATTR=__attribute__((preserve_all))')
LINK_FLAGS=()
if [[ "$OS" == Linux && "$ARCH" == x86_64 && "${BETTERJIT_HOST_DEBUG_X86:-0}" == 1 ]]; then
  # FEX's x86 configuration is for frontend CI/debugging, not its native JIT.
  # The existing Darwin allocator patch needs its private declaration included
  # when compiling on Linux; do not edit the vendor checkout for this.
  echo 'Building the FEX x86 frontend debug configuration; no native guest JIT evidence.'
  FEX_OPTIONS=(-DENABLE_X86_HOST_DEBUG=ON
    "-DCMAKE_CXX_FLAGS=-mavx -include \"$ROOT/FEX/FEXCore/Source/Utils/Allocator.h\"")
  HOST_FLAGS=(-mavx -DARCHITECTURE_x86_64=1
    -DFEXCORE_HAS_PRESERVE_ALL_ATTR=0 '-DFEXCORE_PRESERVE_ALL_ATTR='
    -DFEX_HAS_PRESERVE_ALL_ATTR=0 '-DFEX_PRESERVE_ALL_ATTR=')
  LINK_FLAGS=(-ldl -lpthread)
elif [[ "$OS" != Darwin || "$ARCH" != arm64 ]]; then
  echo 'Host translator requires an arm64 Mac, or BETTERJIT_HOST_DEBUG_X86=1 on Linux x86_64 for frontend diagnostics.' >&2
  exit 1
fi
cd "$ROOT"
bash scripts/prepare-fex.sh
FEX="$ROOT/FEX"
B="$FEX/build-host-wasm"
if [[ "$OS" == Linux ]]; then B="$FEX/build-host-wasm-x86-debug"; fi
cmake -S "$FEX" -B "$B" -G Ninja -DCMAKE_C_COMPILER="$(command -v clang)" -DCMAKE_CXX_COMPILER="$(command -v clang++)" \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=OFF -DTUNE_CPU=none \
  -DBUILD_TESTING=OFF -DBUILD_THUNKS=OFF -DBUILD_FEXCONFIG=OFF -DBUILD_FEX_LINUX_TESTS=OFF \
  -DENABLE_FEX_ALLOCATOR=OFF -DENABLE_JEMALLOC_GLIBC_ALLOC=OFF -DENABLE_ASSERTIONS=OFF \
  -DENABLE_OFFLINE_TELEMETRY=OFF -DENABLE_CLANG_THUNKS=OFF ${FEX_OPTIONS[@]+"${FEX_OPTIONS[@]}"}
cmake --build "$B" --parallel "${BETTERJIT_BUILD_JOBS:-4}" --target FEXCore FEXCore_Base JemallocLibs fmt xxhash cephes_128bit softfloat_3e
mkdir -p .build/host-fex
BUILD_ID=$(bash fexwasm/build_id.sh "$FEX")
for HOST_TARGET in fexserve sparse-memory-add-ir sparse-scalar-shift-ir sparse-register-jump-ir sparse-register-stack-ir sparse-register-memory-add-ir sparse-memory-or-ir sparse-test-immediate-ir sparse-logical-immediate-ir sparse-setcc-ir sparse-register-div-ir; do
HOST_MAIN=fexwasm/tools/fexserve.cpp
if [[ "$HOST_TARGET" == sparse-memory-add-ir ]]; then HOST_MAIN=fexwasm/src/testing/memory-add-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-scalar-shift-ir ]]; then HOST_MAIN=fexwasm/src/testing/scalar-shift-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-register-jump-ir ]]; then HOST_MAIN=fexwasm/src/testing/register-jump-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-register-stack-ir ]]; then HOST_MAIN=fexwasm/src/testing/register-stack-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-register-memory-add-ir ]]; then HOST_MAIN=fexwasm/src/testing/register-memory-add-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-memory-or-ir ]]; then HOST_MAIN=fexwasm/src/testing/memory-or-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-test-immediate-ir ]]; then HOST_MAIN=fexwasm/src/testing/test-immediate-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-logical-immediate-ir ]]; then HOST_MAIN=fexwasm/src/testing/logical-immediate-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-setcc-ir ]]; then HOST_MAIN=fexwasm/src/testing/setcc-ir.cpp; fi
if [[ "$HOST_TARGET" == sparse-register-div-ir ]]; then HOST_MAIN=fexwasm/src/testing/register-div-ir.cpp; fi
clang++ -std=gnu++20 -O2 -gline-tables-only -fno-exceptions -fno-strict-aliasing -fwrapv -Wno-unused-function \
  "-DFEXWASM_BUILD_ID=\"$BUILD_ID\"" "${HOST_FLAGS[@]}" -DJIT_ARM64 -D_LARGEFILE64_SOURCE \
  -I"$B/FEXCore/Source" -I"$FEX/FEXCore/Source" -I"$FEX/FEXCore/Source/IncludePrivate" -I"$FEX/FEXCore/include" \
  -I"$B/include" -I"$B/generated" -I"$FEX/External/fmt/include" -I"$FEX/External/xxhash" \
  -I"$FEX/FEXHeaderUtils" -I"$FEX/CodeEmitter" -I"$FEX/External/unordered_dense/include" \
  -I"$FEX/External/cephes/include" -I"$FEX/External/SoftFloat-3e/include" -Ifexwasm/src \
  "$HOST_MAIN" fexwasm/src/*.cpp \
  "$B/FEXCore/Source/libFEXCore.a" "$B/FEXCore/Source/libFEXCore_Base.a" "$B/FEXCore/Source/libJemallocLibs.a" \
  "$B/External/fmt/libfmt.a" "$B/External/xxhash/cmake_unofficial/libxxhash.a" \
  "$B/External/cephes/libcephes_128bit.a" "$B/External/SoftFloat-3e/libsoftfloat_3e.a" \
  ${LINK_FLAGS[@]+"${LINK_FLAGS[@]}"} -o ".build/host-fex/$HOST_TARGET"
done
