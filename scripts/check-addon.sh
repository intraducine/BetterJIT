#!/usr/bin/env bash
# Portable setup/distribution tests; no iOS build, credentials, network or publishing.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tests/generalized-addon.test.py
python3 -m py_compile addon/iridium/configuration.py addon/iridium/prepare.py addon/iridium/sync.py scripts/export-source.py
bash -n addon/iridium/build-local.sh
