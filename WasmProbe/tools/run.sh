#!/bin/bash
# Usage: tools/run.sh <logname> <suites> [--nobuild]
# Builds, installs and runs WasmProbe on the connected iPhone, saving @@ lines to results/<logname>.log
set -euo pipefail
cd "$(dirname "$0")/.."
DEV=00008160-00086DD82021400A
if [[ "${3:-}" != "--nobuild" ]]; then
  ./tools/build_wasm.sh >/dev/null
  # the translator library the app links (fexwasm's src), when its sources changed
  if [[ -n "$(find ../fexwasm/src -newer ../fexwasm/out/ios/libfexwasm.a -name '*.[ch]*' 2>/dev/null | head -1)" ]]; then
    (cd ../fexwasm && ./build_ios.sh >/dev/null 2>&1) || { echo "build_ios.sh failed"; exit 1; }
  fi
  ./tools/sync_linux_web.sh
  if ! xcodebuild -project WasmProbe.xcodeproj -scheme WasmProbe -configuration Release -destination "generic/platform=iOS" \
    -derivedDataPath build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build > build/last-build.log 2>&1; then
    grep -E "error:" build/last-build.log | head -20
    echo "BUILD FAILED (build/last-build.log)"
    exit 1
  fi
  xcrun devicectl device install app --device $DEV build/Build/Products/Release-iphoneos/WasmProbe.app >/dev/null 2>&1
fi
xcrun devicectl device process launch --device $DEV --console --terminate-existing audio.volta.wasmprobe \
  --suites "$2" --exit ${EXTRA_ARGS:-} 2>&1 | grep -E "^@@" | tee "results/$1.log" | grep -v '"suite":"timing"' | cut -c1-600
