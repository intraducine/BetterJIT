#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift test -j 2 --filter 'RuntimeTests|FEXServiceTests'
node --test tests/sdk/engine.test.mjs
if [[ -f tests/sdk/tooling.test.py ]]; then python3 tests/sdk/tooling.test.py; fi
for file in Sources/BetterJITWebKit/Resources/*.mjs Sources/BetterJITWebKit/Resources/*.js; do node --check "$file"; done
swiftc -parse Sources/BetterJITWebKit/*.swift Examples/MinimalHost/App.swift Backends/FEX/Swift/LinkedFEXTranslator.swift
# Browser JSPI tests require Playwright and a current Chromium. Run explicitly:
# python3 tests/sdk/browser-sdk.py --chromium /path/to/chromium
# Add --research-fixtures in the full research checkout, not in a source SDK export.
