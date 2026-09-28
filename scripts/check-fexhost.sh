#!/usr/bin/env bash
# Tests the sample's plan/report/orchestration and guest fixtures, not Apple/FEX.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
swiftc -swift-version 5 -warnings-as-errors -o .build/fexhost-tests \
  Examples/FEXHost/GuestImage.swift Examples/FEXHost/SuitePlan.swift \
  Examples/FEXHost/SuiteReport.swift Examples/FEXHost/SuiteRunner.swift \
  tests/fexhost/PortableTests.swift
.build/fexhost-tests
python3 tests/fexhost/native-fixtures.py
if command -v node >/dev/null; then node tests/fexhost/service-module.cjs; else echo "SKIP: Node is required for the Wasm byte-protocol test."; fi
swiftc -swift-version 5 -parse Examples/FEXHost/*.swift
python3 -m py_compile Examples/FEXHost/prepare.py Examples/FEXHost/Guest/build.py
