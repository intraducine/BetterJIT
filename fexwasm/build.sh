#!/bin/bash
# Builds the fexwasm tools against FEXCore in ../FEX/build-mac.
# The wasm backend lives here, outside the FEX tree, and only links FEXCore.
set -euo pipefail
cd -P "$(dirname "$0")"
# FEX is checked out beside this directory.
FEX=${FEX_DIR:-$(cd ../FEX && pwd)}
B=$FEX/build-mac
# The probe app's C kernels are fexrun's native references (WasmProbe/Kernels).
WASMPROBE=${WASMPROBE_DIR:-$(cd ../WasmProbe && pwd)}
if [[ ! -f $B/build.ninja ]]; then
  cmake -S "$FEX" -B "$B" -G Ninja -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=ON -DENABLE_ASSERTIONS=ON -DTUNE_CPU=apple-m1 \
    -DBUILD_TESTING=OFF -DBUILD_THUNKS=OFF -DBUILD_FEXCONFIG=OFF -DBUILD_FEX_LINUX_TESTS=OFF -DENABLE_FEX_ALLOCATOR=OFF \
    -DENABLE_JEMALLOC_GLIBC_ALLOC=ON -DENABLE_OFFLINE_TELEMETRY=ON -DENABLE_CLANG_THUNKS=ON >/dev/null
fi
ninja -C "$B" FEXCore FEXCore_Base JemallocLibs fmt xxhash cephes_128bit softfloat_3e >/dev/null
mkdir -p out
# The translation cache's key includes this: a different backend never reuses old units.
BUILD_ID=$(bash ./build_id.sh "$FEX")
CXXFLAGS=(
  "-DFEXWASM_BUILD_ID=\"$BUILD_ID\""
  -std=gnu++20 -O2 -g -fno-exceptions -fno-strict-aliasing -fwrapv -Wall -Wno-unused-function
  -DARCHITECTURE_arm64=1 -DASSERTIONS_ENABLED=1 -DJIT_ARM64 -D_LARGEFILE64_SOURCE
  -DFEXCORE_HAS_PRESERVE_ALL_ATTR=1 '-DFEXCORE_PRESERVE_ALL_ATTR=__attribute__((preserve_all))'
  -DFEX_HAS_PRESERVE_ALL_ATTR=1 '-DFEX_PRESERVE_ALL_ATTR=__attribute__((preserve_all))'
  "-I$B/FEXCore/Source" "-I$FEX/FEXCore/Source" "-I$FEX/FEXCore/Source/IncludePrivate" "-I$FEX/FEXCore/include"
  "-I$B/include" "-I$B/generated" "-I$FEX/External/fmt/include" "-I$FEX/External/xxhash"
  "-I$FEX/FEXHeaderUtils" "-I$FEX/CodeEmitter" "-I$FEX/External/unordered_dense/include"
  "-I$FEX/External/cephes/include" "-I$FEX/External/SoftFloat-3e/include" "-I$WASMPROBE/Kernels"
)
LIBS=(
  $B/FEXCore/Source/libFEXCore.a $B/FEXCore/Source/libFEXCore_Base.a $B/FEXCore/Source/libJemallocLibs.a
  $B/External/fmt/libfmt.a $B/External/xxhash/cmake_unofficial/libxxhash.a
  $B/External/cephes/libcephes_128bit.a $B/External/SoftFloat-3e/libsoftfloat_3e.a
)
SRCS=$(ls src/*.cpp)
for tool in "$@"; do
  EXTRA=()
  if [[ $tool == fexrun ]]; then
    # Native reference kernels and the in-process JavaScriptCore.
    clang -O2 -c -o out/kernels_native.o "$WASMPROBE/Kernels/kernels.c"
    clang -O2 -c -o out/calls_native.o guest/src/calls.c
    clang -O2 -Iguest/coremark -c -o out/coremark_native.o guest/coremark/coremark_unity.c
    # Box2D natively: same deterministic setup as the guest build (no FP
    # contraction, the driver's sin/cos/qsort), NEON instead of SSE2.
    mkdir -p out/box2d_native
    B2=(-O2 -ffp-contract=off -DNDEBUG -Dsinf=det_sinf -Dcosf=det_cosf -Dqsort=det_qsort -Iguest/box2d/include -Iguest/box2d/src
      -Iguest/box2d/shared)
    PIDS=()
    for f in guest/box2d/src/*.c guest/box2d/shared/benchmarks.c guest/box2d/shared/human.c guest/box2d/timer_native.c \
      guest/box2d/box2d_driver.c guest/box2d/native_stub.c; do
      object="out/box2d_native/$(basename "${f%.c}").o"
      rm -f "$object"
      clang "${B2[@]}" -c -o "$object" "$f" &
      PIDS+=("$!")
    done
    status=0
    for pid in "${PIDS[@]}"; do wait "$pid" || status=1; done
    if (( status != 0 )); then echo "native reference compilation failed" >&2; exit 1; fi
    EXTRA=(out/kernels_native.o out/calls_native.o out/coremark_native.o out/box2d_native/*.o -framework JavaScriptCore)
  elif [[ $tool == fextest ]]; then
    EXTRA=(-framework JavaScriptCore)
  fi
  clang++ "${CXXFLAGS[@]}" -Isrc -o out/$tool tools/$tool.cpp $SRCS ${EXTRA[@]+"${EXTRA[@]}"} "${LIBS[@]}" -flto=thin
  if [[ $tool == fexrun || $tool == fextest ]]; then
    # In-process JavaScriptCore only JITs with allow-jit under the hardened runtime.
    codesign -s - -f --options runtime --entitlements jit.entitlements out/$tool 2>/dev/null
  fi
done
