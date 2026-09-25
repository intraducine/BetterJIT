#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen' >&2; exit 1; }
mkdir -p .build
xcodegen generate
commit="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'workspace')"
xcodebuild -project BetterJITProbe.xcodeproj -scheme BetterJITProbe \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath .build/xcode CODE_SIGNING_ALLOWED=NO \
  CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}" BETTERJIT_COMMIT="$commit" build
staging="$(mktemp -d "${TMPDIR:-/tmp}/betterjit-ipa.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/Payload"
ditto .build/xcode/Build/Products/Release-iphoneos/BetterJITProbe.app "$staging/Payload/BetterJITProbe.app"
ditto -c -k --keepParent "$staging/Payload" .build/BetterJITProbe-unsigned.ipa
echo 'Created .build/BetterJITProbe-unsigned.ipa (must be signed before installation)'
