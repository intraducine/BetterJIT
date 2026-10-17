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
python3 scripts/iterate-sparse.py prepare-frontend --fex-build "$B"
cmake -S "$FEX" -B "$B" -G Ninja -DCMAKE_C_COMPILER="$(command -v clang)" -DCMAKE_CXX_COMPILER="$(command -v clang++)" \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=OFF -DTUNE_CPU=none \
  -DBUILD_TESTING=OFF -DBUILD_THUNKS=OFF -DBUILD_FEXCONFIG=OFF -DBUILD_FEX_LINUX_TESTS=OFF \
  -DENABLE_FEX_ALLOCATOR=OFF -DENABLE_JEMALLOC_GLIBC_ALLOC=OFF -DENABLE_ASSERTIONS=OFF \
  -DENABLE_OFFLINE_TELEMETRY=OFF -DENABLE_CLANG_THUNKS=OFF ${FEX_OPTIONS[@]+"${FEX_OPTIONS[@]}"}
cmake --build "$B" --parallel "${BETTERJIT_BUILD_JOBS:-4}" --target FEXCore FEXCore_Base JemallocLibs fmt xxhash cephes_128bit softfloat_3e
python3 scripts/iterate-sparse.py seal-frontend --fex-build "$B"
mkdir -p .build/host-fex
BUILD_ID=$(bash fexwasm/build_id.sh "$FEX")
# Positional targets support a focused local iteration; no targets builds all.
BUILD_ARGS=(build-tools --fex-build "$B" --build-id "$BUILD_ID")
for FLAG in "${HOST_FLAGS[@]}"; do BUILD_ARGS+=("--host-flag=$FLAG"); done
for FLAG in ${LINK_FLAGS[@]+"${LINK_FLAGS[@]}"}; do BUILD_ARGS+=("--link-flag=$FLAG"); done
python3 scripts/iterate-sparse.py "${BUILD_ARGS[@]}" "$@"
