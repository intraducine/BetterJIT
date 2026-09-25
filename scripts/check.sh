#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift test -j 2
swift run betterjit-probe fixtures .build/fixtures
node scripts/verify.mjs
for file in Web/*.mjs scripts/*.mjs; do node --check "$file"; done
