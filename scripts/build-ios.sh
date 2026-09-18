#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen' >&2; exit 1; }
mkdir -p build
xcodegen generate
xcodebuild -project BetterJIT.xcodeproj -scheme BetterJIT -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build
rm -rf build/Payload
mkdir -p build/Payload
cp -R build/DerivedData/Build/Products/Debug-iphoneos/BetterJIT.app build/Payload/
rm -f build/BetterJIT-unsigned.ipa
(cd build && /usr/bin/zip -qr BetterJIT-unsigned.ipa Payload)
echo 'Created build/BetterJIT-unsigned.ipa; it must be signed before installation.'
