#!/usr/bin/env bash
# Produce a local, unsigned, device-arm64 FEX package. No uploads or signing.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
[[ "$(uname -s)" == Darwin ]] || { echo 'FEX iOS packaging requires macOS/Xcode.' >&2; exit 1; }
cd "$ROOT"
bash scripts/prepare-fex.sh
bash fexwasm/build_ios.sh
DEST="$ROOT/.build/FEXNativePackage"
[[ ! -e "$DEST" ]] || { echo "Output exists: $DEST; choose/retain your existing build deliberately." >&2; exit 1; }
mkdir -p "$DEST/Headers"
cp fexwasm/src/translator.h "$DEST/Headers/translator.h"
printf 'module CFEXWasm { header "translator.h" export * }\n' > "$DEST/Headers/module.modulemap"
LIBS=()
while IFS= read -r lib; do
  [[ -f "$lib" ]] || { echo 'Missing input archive.' >&2; exit 1; }
  LIBS+=("$lib")
done < fexwasm/out/ios/libs.txt
[[ ${#LIBS[@]} -eq 8 ]] || { echo 'Unexpected archive set.' >&2; exit 1; }
xcrun libtool -static -o "$DEST/libCFEXWasm.a" "${LIBS[@]}"
xcodebuild -create-xcframework -library "$DEST/libCFEXWasm.a" -headers "$DEST/Headers" -output "$DEST/CFEXWasm.xcframework"
cat > "$DEST/Package.swift" <<'PACKAGE'
// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "BetterJITFEXNative", platforms: [.iOS(.v17)],
    products: [.library(name: "CFEXWasm", targets: ["CFEXWasm"])],
    targets: [.binaryTarget(name: "CFEXWasm", path: "CFEXWasm.xcframework")])
PACKAGE
cp COPYING "$DEST/COPYING"
printf 'Local device-only native backend: %s\nAdd this package and LinkedFEXTranslator.swift to the host. Not a distribution-ready archive.\n' "$DEST"
