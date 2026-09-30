#!/usr/bin/env bash
# Tests the sample's plan/report/orchestration and guest fixtures, not Apple/FEX.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
common=(Examples/FEXHost/GuestImage.swift Examples/FEXHost/ExtendedGuest.swift
  Examples/FEXHost/SuitePlan.swift Examples/FEXHost/AdvancedPlan.swift
  Examples/FEXHost/BenchmarkPolicy.swift Examples/FEXHost/SuiteReport.swift
  Examples/FEXHost/SuiteRunner.swift)
swiftc -swift-version 5 -warnings-as-errors -o .build/fexhost-tests "${common[@]}" tests/fexhost/PortableTests.swift
swiftc -O -swift-version 5 -warnings-as-errors -o .build/extended-tests "${common[@]}" tests/fexhost/ExtendedTests.swift
.build/extended-tests
swiftc -swift-version 5 -warnings-as-errors -o .build/diagnostic-tests \
  Examples/FEXHost/DiagnosticModel.swift Examples/FEXHost/DiagnosticPlan.swift \
  Examples/FEXHost/SuiteReport.swift Examples/FEXHost/SuitePlan.swift \
  Examples/FEXHost/BenchmarkPolicy.swift Examples/FEXHost/AdvancedPlan.swift \
  Examples/FEXHost/GuestImage.swift Examples/FEXHost/ExtendedGuest.swift \
  tests/fexhost/DiagnosticTests.swift
.build/diagnostic-tests
python3 tests/fexhost/extended-native.py
.build/fexhost-tests
python3 tests/fexhost/native-fixtures.py
if command -v node >/dev/null; then node tests/fexhost/service-module.cjs; node tests/fexhost/worker-statistics.cjs; node tests/sdk/mapped-lane.test.mjs; node tests/sdk/diagnostics.test.mjs; else echo "SKIP: Node is required for the Wasm byte-protocol/mapped-lane tests."; fi
swiftc -swift-version 5 -parse Examples/FEXHost/*.swift
python3 -m py_compile Examples/FEXHost/prepare.py Examples/FEXHost/Guest/build.py Examples/FEXHost/Guest/build-extended.py
