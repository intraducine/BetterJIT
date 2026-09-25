#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift test -j 2
swift run betterjit-probe fixtures .build/fixtures
node scripts/verify.mjs
for file in Web/*.mjs scripts/*.mjs; do node --check "$file"; done

# Private local overlay safety, browser orchestration and HTTP framing.
python3 tests/private-addon.test.py
node --test tests/private-lab.test.cjs
python3 tests/build-failure.test.py
node tests/fex-replay.cjs
swiftc -parse addon/iridium/Sources/*.swift WasmProbe/Sources/FexTranslator.swift WasmProbe/Sources/Log.swift
