#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Do not omit newly added SDK tests by matching only the original class names.
swift test -j 2 --filter 'BetterJITTests|BetterJITFEXTests|BetterJITLinuxTests'
node --test tests/sdk/*.test.mjs
python3 -m py_compile scripts/stage-linux-runtime.py
for test in tests/sdk/tooling.test.py tests/sdk/cleanup.test.py; do
  if [[ -f "$test" ]]; then python3 "$test"; fi
done
for file in Sources/BetterJITWebKit/Resources/*.mjs Sources/BetterJITWebKit/Resources/*.js; do node --check "$file"; done
for file in Sources/BetterJITLinux/Resources/runtime.js Sources/BetterJITLinux/Resources/linux/*.js Sources/BetterJITLinux/Resources/linux/web/*.js; do node --check "$file"; done
swiftc -parse Sources/BetterJITWebKit/*.swift Sources/BetterJITLinux/*.swift Backends/FEX/Swift/*.swift
# Separate evidence levels, run explicitly:
# swift test --filter AppleHostTests                # macOS WKWebView, not iPhone
# python3 tests/sdk/native-binding.test.py          # real Swift binding + test C shim, not FEX
# bash Examples/CGuest/build.sh
# python3 tests/sdk/browser-sdk.py --c-guest --native-service --research-fixtures
