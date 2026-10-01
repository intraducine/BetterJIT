// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum BenchmarkKind: String, Codable { case branch, nested, vector }
struct CalibrationProbe: Codable {
    let iterations: UInt64
    let milliseconds: Double
    let expected: String
    let actual: String
}
struct BenchmarkRecord: Codable {
    var targetMinimumMilliseconds = 100.0
    var targetMaximumMilliseconds = 500.0
    var targetMilliseconds = 200.0
    var initialIterations: UInt64?
    var firstExpected: String?
    var firstActual: String?
    var probes: [CalibrationProbe] = []
    var selectedIterations: UInt64?
    var requestedSamples = 5
    var windowSatisfied = false
}
struct RegionRecord: Codable {
    var checkedPrimingCalls = 0
    var postInstallationCheckedCalls = 0
    var before: [String:Int] = [:]
    var installed: [String:Int] = [:]
    var after: [String:Int] = [:]
    // Only a single-unit/no-flush stage permits attribution without instrumenting
    // every translated instruction. Multiple-unit coverage requires another probe.
    var contract = "Single translated unit, one installed region, no cache flushes, then two checksum-checked calls. Not an instruction counter or speed comparison."
}
enum BenchmarkPolicy {
    static let minimum = 100.0, maximum = 500.0, target = 200.0
    static let maximumIterations: UInt64 = 128_000_000
    static let maximumProbes = 10
    static let calibrationBudgetMilliseconds = 6_000.0
    static func inWindow(_ ms: Double) -> Bool { ms.isFinite && (minimum...maximum).contains(ms) }
    static func next(iterations: UInt64, milliseconds: Double) throws -> UInt64 {
        guard (1...maximumIterations).contains(iterations), milliseconds.isFinite, milliseconds>=0 else {
            throw SuiteFailure("Invalid calibration input.")
        }
        let factor=max(0.25,min(4.0,target/max(milliseconds,0.05)))
        return max(1,min(maximumIterations,UInt64((Double(iterations)*factor).rounded(.up))))
    }
    static func iterations(_ test: DeviceCase) -> UInt64 { test.arguments[test.benchmark == .vector ? 1:0] }
    static func usableRegion(_ counters: [String:Int]) -> Bool {
        // Native requests alone do not establish that WebKit installed a region.
        (counters["runtimeStatisticsAvailable"] ?? 0)==1 && (counters["unitModulesInstalled"] ?? 0)==1 &&
        (counters["regionModulesInstalled"] ?? 0)==1 && (counters["regionUnitsInstalled"] ?? 0)==1 &&
        (counters["fexCacheFlushes"] ?? -1)==0 && (counters["regionRequests"] ?? 0)>0
    }
}
