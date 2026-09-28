// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

@MainActor final class FixtureExecutor: SuiteExecutor {
    enum Behavior { case okay, wrongAnswer, corruptMemory, startupFailure, noRequests, badTimer }
    let behavior: Behavior
    var closed = 0
    var invocations = 0
    var wasAborted = false
    var afterInvoke: (() -> Void)?
    init(_ behavior: Behavior = .okay) { self.behavior = behavior }
    func start() async throws -> StartEvidence {
        if behavior == .startupFailure { throw SuiteFailure("fixture startup failure") }
        return StartEvidence(timings: ["webKitStartup": 1], capabilities: ["fixture": "not WebKit"])
    }
    func invoke(_ test: DeviceCase) async throws -> CallEvidence {
        invocations += 1; afterInvoke?()
        return CallEvidence(result: behavior == .wrongAnswer ? test.expected &+ 1 : test.expected,
                            milliseconds: behavior == .badTimer ? .nan : Double(invocations),
                            memory: behavior == .corruptMemory ? Data([0]) : test.expectedMemory)
    }
    func counters() async -> [String: Int] { ["unitRequests": behavior == .noRequests ? 0 : invocations, "nativeServiceCalls": invocations] }
    func close() async { closed += 1 }
    func abort() { wasAborted = true }
}

@main struct PortableTests {
    @MainActor static func main() async throws {
        if CommandLine.arguments.contains("--wasm") { print(SuitePlan.byteModule.base64EncodedString()); return }
        if CommandLine.arguments.contains("--vectors") {
            var rows: [[String: Any]] = []
            for stage in SuitePlan.stages(.full) where stage.kind == .compiled {
                for c in stage.cases {
                    rows.append(["abi": stage.abi!.rawValue, "id": c.id, "entry": c.entry,
                                 "arguments": c.arguments.map(String.init), "expected": String(c.expected),
                                 "input": c.input?.base64EncodedString() ?? "", "memory": c.expectedMemory?.base64EncodedString() ?? ""])
                }
            }
            print(String(data: try JSONSerialization.data(withJSONObject: rows,options:[.sortedKeys]),encoding:.utf8)!); return
        }
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message); checks += 1
        }
        check(SuitePlan.stages(.baseline).count == 2, "baseline preserved")
        check(SuitePlan.stages(.full).flatMap(\.cases).count == 27, "full case inventory")
        check(SuitePlan.branch(0, .max) == .max, "zero iteration reference")
        check(SuitePlan.weighted([.max,1]) == 1, "reference wrapping")
        check(CaseRecord.median([]) == nil, "empty timing")
        check(CaseRecord.median([4,1,3,2]) == 2.5, "even median")
        var failedTiming = CaseRecord(id: "timing", title: "timing", status: .failed, expected: "42", warmMilliseconds: [1,2,3])
        check(failedTiming.medianWarmMilliseconds == nil, "failed samples do not get a valid median")
        failedTiming.status = .passed; failedTiming.timingNote = "thermal stop"
        check(failedTiming.medianWarmMilliseconds == nil, "partial thermal samples do not get a valid median")
        let empty = SuiteReport(mode: .full, environment: [:], conditions: [:])
        check(empty.overall == "RUNNING", "never pass unfinished run")
        var checkpoint = empty; checkpoint.markInterrupted()
        check(checkpoint.overall == "INTERRUPTED", "restore interrupted")
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(SuiteReport.self,from:checkpoint.data())
        check(decoded.overall == "INTERRUPTED", "JSON round trip")
        for behavior in [FixtureExecutor.Behavior.okay,.wrongAnswer,.startupFailure,.noRequests,.badTimer] {
            var hosts: [FixtureExecutor] = [], updates: [String] = []
            let runner = SuiteRunner(mode: .baseline, environment: [:], conditions: [:], factory: { _ in
                let h = FixtureExecutor(behavior); hosts.append(h); return h
            }, changed: { updates.append($0.overall) })
            let report = await runner.run()
            _ = try report.data() // Failed timer evidence must not poison the JSON checkpoint.
            check(report.overall == (behavior == .okay ? "PASS" : "FAIL"), "bad evidence must not pass")
            check(hosts.allSatisfy { $0.closed == 1 }, "exactly one executor close")
            check(updates.first == "RUNNING", "checkpoint precedes execution")
        }
        var all: [FixtureExecutor] = []
        let full = SuiteRunner(mode: .full, environment: [:], conditions: [:], factory: { _ in
            let h = FixtureExecutor(); all.append(h); return h
        },changed: {_ in})
        let good = await full.run()
        check(good.overall == "PASS", "full runner orchestration")
        let benches = good.stages.flatMap(\.cases).filter { $0.id.hasPrefix("bench-") }
        check(benches.count == 4 && benches.allSatisfy { $0.warmMilliseconds.count == 5 && $0.checkedCalls == 7 }, "checked warmup and five samples")
        check(good.stages.flatMap(\.cases).filter { $0.id.hasPrefix("memory-") }.allSatisfy { $0.memoryMatched == true }, "memory checked")
        check(all.allSatisfy { $0.closed == 1 }, "all lifecycle sessions closed")
        let badMemory = SuiteRunner(mode: .full,environment:[:],conditions:[:],factory:{_ in FixtureExecutor(.corruptMemory)},changed:{_ in})
        let memoryFailure = await badMemory.run()
        check(memoryFailure.overall == "FAIL", "guard corruption fails")
        var stopRunner: SuiteRunner!
        var cancelledHost: FixtureExecutor?
        stopRunner = SuiteRunner(mode:.baseline,environment:[:],conditions:[:],factory:{_ in
            let h=FixtureExecutor();cancelledHost=h;h.afterInvoke={stopRunner.stop()};return h
        },changed:{_ in})
        let stopped = await stopRunner.run()
        check(stopped.overall == "CANCELLED", "late reply cannot pass after cancellation")
        check(cancelledHost?.wasAborted == true && cancelledHost?.closed == 1, "cancel abort and close")
        check(stopped.stages.last?.status == .skipped, "unattempted cases explicit")
        let hot = SuiteRunner(mode:.full,environment:[:],conditions:[:],factory:{_ in FixtureExecutor()},timingAllowed:{false},changed:{_ in})
        let hotReport = await hot.run()
        check(hotReport.overall == "PASS", "thermal skip does not claim a correctness failure")
        check(hotReport.stages.flatMap(\.cases).filter{$0.id.hasPrefix("bench-")}.allSatisfy{$0.warmMilliseconds.isEmpty && $0.timingNote != nil}, "thermal skip explicitly removes timings")
        print("PASS: \(checks) portable assertions; fixture executors test orchestration, not FEX or Apple execution.")
    }
}
