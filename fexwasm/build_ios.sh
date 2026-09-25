#!/bin/bash
# Builds the translator (src/: backend, FEX host, C API) for iOS as
# out/ios/libfexwasm.a, against FEXCore built by ../FEX's build-ios (see
# ios_fex_configure below). An app links libfexwasm.a with the FEX archives
# listed in out/ios/libs.txt and calls src/translator.h.
set -euo pipefail
cd -P "$(dirname "$0")"
FEX=${FEX_DIR:-$(cd ../FEX && pwd)}
B=$FEX/build-ios
if [[ ! -f $B/FEXCore/Source/libFEXCore.a ]]; then
  cmake -S "$FEX" -B "$B" -G Ninja -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_DEPLOYMENT_TARGET=17.0 \
    -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=OFF -DTUNE_CPU=none -DBUILD_TESTING=OFF -DBUILD_THUNKS=OFF \
    -DBUILD_FEXCONFIG=OFF -DBUILD_FEX_LINUX_TESTS=OFF -DENABLE_FEX_ALLOCATOR=OFF -DENABLE_JEMALLOC_GLIBC_ALLOC=OFF \
    -DENABLE_ASSERTIONS=OFF -DENABLE_OFFLINE_TELEMETRY=OFF -DENABLE_CLANG_THUNKS=OFF
fi
ninja -C "$B" FEXCore FEXCore_Base JemallocLibs fmt xxhash cephes_128bit softfloat_3e >/dev/null
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
O=out/ios
mkdir -p "$O"
rm -f "$O/libfexwasm.a" "$O/libs.txt" "$O/libfexwasm.a.tmp"
trap 'rm -f "$O/libfexwasm.a.tmp"' EXIT
# The translation cache's key includes this: a different backend never reuses old units.
BUILD_ID=$(bash ./build_id.sh "$FEX")
CXXFLAGS=(
  "-DFEXWASM_BUILD_ID=\"$BUILD_ID\""
  -arch arm64 -isysroot "$SDK" -miphoneos-version-min=17.0
  -std=gnu++20 -O2 -fno-exceptions -fno-strict-aliasing -fwrapv -Wall -Wno-unused-function -fvisibility=hidden
  -DARCHITECTURE_arm64=1 -DJIT_ARM64 -D_LARGEFILE64_SOURCE -DFEX_DISABLE_TELEMETRY=1
  -DFEXCORE_HAS_PRESERVE_ALL_ATTR=1 '-DFEXCORE_PRESERVE_ALL_ATTR=__attribute__((preserve_all))'
  -DFEX_HAS_PRESERVE_ALL_ATTR=1 '-DFEX_PRESERVE_ALL_ATTR=__attribute__((preserve_all))'
  "-I$B/FEXCore/Source" "-I$FEX/FEXCore/Source" "-I$FEX/FEXCore/Source/IncludePrivate" "-I$FEX/FEXCore/include"
  "-I$B/include" "-I$B/generated" "-I$FEX/External/fmt/include" "-I$FEX/External/xxhash"
  "-I$FEX/FEXHeaderUtils" "-I$FEX/CodeEmitter" "-I$FEX/External/unordered_dense/include"
  "-I$FEX/External/cephes/include" "-I$FEX/External/SoftFloat-3e/include" -Isrc
)
OBJS=()
PIDS=()
for f in src/*.cpp; do
  o=$O/$(basename "${f%.cpp}").o
  rm -f "$o"
  clang++ "${CXXFLAGS[@]}" -c -o "$o" "$f" &
  PIDS+=("$!")
  OBJS+=("$o")
done
status=0
for pid in "${PIDS[@]}"; do wait "$pid" || status=1; done
if (( status != 0 )); then echo "translator compilation failed; no archive published" >&2; exit 1; fi
xcrun ar rcs "$O/libfexwasm.a.tmp" "${OBJS[@]}"
mv "$O/libfexwasm.a.tmp" "$O/libfexwasm.a"
# The archives the app links, in order.
printf '%s\n' "$PWD/$O/libfexwasm.a" "$B/FEXCore/Source/libFEXCore.a" "$B/FEXCore/Source/libFEXCore_Base.a" "$B/FEXCore/Source/libJemallocLibs.a" \
  "$B/External/fmt/libfmt.a" "$B/External/xxhash/cmake_unofficial/libxxhash.a" "$B/External/cephes/libcephes_128bit.a" \
  "$B/External/SoftFloat-3e/libsoftfloat_3e.a" > $O/libs.txt
ls -la $O/libfexwasm.a
