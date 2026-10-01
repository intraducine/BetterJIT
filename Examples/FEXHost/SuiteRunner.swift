// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// Same orchestration is testable without UIKit or WebKit. Each stage owns one
/// executor; failures stop that stage, not unrelated tests in a fresh executor.
@MainActor final class SuiteRunner {
    typealias Factory = @MainActor (DeviceStage) throws -> any SuiteExecutor
    private(set) var report: SuiteReport
    private let factory: Factory
    private let changed: @MainActor (SuiteReport) -> Void
    private let timingAllowed: @MainActor () -> Bool
    private var current: (any SuiteExecutor)?
    private var stopState: ReportState?
    init(mode: SuiteMode, environment: [String: String], conditions: [String: String],
         factory: @escaping Factory, timingAllowed: @escaping @MainActor () -> Bool = { true },
         changed: @escaping @MainActor (SuiteReport) -> Void) {
        report = SuiteReport(mode: mode, environment: environment, conditions: conditions)
        self.factory = factory; self.timingAllowed = timingAllowed; self.changed = changed
    }
    func stop(interrupted: Bool = false) {
        stopState = interrupted ? .interrupted : .cancelled
        current?.abort()
    }
    private func checkpoint() { changed(report) }
    private func checkStop() throws {
        if stopState != nil || Task.isCancelled { throw CancellationError() }
    }
    func run() async -> SuiteReport {
        checkpoint()
        let stages = SuitePlan.stages(report.mode)
        for (i, stage) in stages.enumerated() {
            do {
                try checkStop()
                report.stages[i].status = .running; checkpoint()
                let executor = try factory(stage); current = executor
                let evidence = try await executor.start(); try checkStop()
                guard evidence.timings.values.allSatisfy({ $0.isFinite && $0 >= 0 }) else { throw SuiteFailure("Invalid setup timer result.") }
                report.stages[i].setupMilliseconds = evidence.timings
                report.stages[i].capabilities = evidence.capabilities
                for (j, test) in stage.cases.enumerated() {
                    try checkStop()
                    report.stages[i].cases[j].status = .running; checkpoint()
                    let first = try await executor.invoke(test); try checkStop()
                    try record(first, expected: test, stage: i, index: j)
                    report.stages[i].cases[j].firstCallMilliseconds = first.milliseconds
                    if test.requiresRegion {
                        try await checkRegion(test, executor: executor, stage: i, index: j)
                    } else if test.benchmark != nil {
                        try await calibrate(test, executor: executor, stage: i, index: j)
                    } else if test.warmSamples > 0 {
                        if timingAllowed() {
                            // The warmup is correctness-checked, excluded from samples.
                            let warmup = try await executor.invoke(test); try checkStop()
                            try record(warmup, expected: test, stage: i, index: j)
                            for _ in 0..<test.warmSamples {
                                try checkStop()
                                guard timingAllowed() else {
                                    report.stages[i].cases[j].timingNote = "Warm sampling stopped because of thermal pressure; do not compare this partial series."
                                    break
                                }
                                let value = try await executor.invoke(test); try checkStop()
                                try record(value, expected: test, stage: i, index: j)
                                report.stages[i].cases[j].warmMilliseconds.append(value.milliseconds)
                                checkpoint()
                            }
                        } else {
                            report.stages[i].cases[j].timingNote = "Correctness checked once; warm sampling skipped because of thermal pressure."
                        }
                    }
                    report.stages[i].cases[j].status = .passed; checkpoint()
                }
                let counters = await executor.counters(); try checkStop()
                report.stages[i].counters = counters
                if stage.kind != .nativeService && (counters["unitRequests"] ?? 0) <= 0 {
                    throw SuiteFailure("No native translation-unit requests were observed in this stage.")
                }
                if stage.kind == .nativeService && (counters["nativeServiceCalls"] ?? 0) <= 0 {
                    throw SuiteFailure("No native service calls were observed.")
                }
                report.stages[i].status = .passed
            } catch {
                if let current { report.stages[i].counters = await current.counters() }
                let stopping = error is CancellationError || stopState != nil || Task.isCancelled
                report.stages[i].status = stopping ? .skipped : .failed
                report.stages[i].error = stopping ? "Run stopped; uncompleted checks are not passes." : String(error.localizedDescription.prefix(1024))
                for j in report.stages[i].cases.indices {
                    if report.stages[i].cases[j].status == .running {
                        report.stages[i].cases[j].status = stopping ? .skipped : .failed
                        report.stages[i].cases[j].error = report.stages[i].error
                    } else if report.stages[i].cases[j].status == .pending {
                        report.stages[i].cases[j].status = .skipped
                        report.stages[i].cases[j].error = "Previous failure or cancellation in this session."
                    }
                }
                if stopping { report.state = stopState ?? .cancelled }
            }
            if let current { await current.close() }
            current = nil; checkpoint()
            if report.state != .running { break }
            // Give released WebViews a turn to tear down. This is not a memory-reclamation guarantee.
            await Task.yield()
        }
        if let stopState { report.state = stopState }
        else if Task.isCancelled { report.state = .cancelled }
        else if report.state == .running { report.state = .completed }
        for i in report.stages.indices where report.stages[i].status == .pending {
            report.stages[i].status = .skipped
            for j in report.stages[i].cases.indices { report.stages[i].cases[j].status = .skipped }
        }
        report.finishedAt = Date(); checkpoint()
        return report
    }
    private func calibrate(_ original: DeviceCase, executor: any SuiteExecutor, stage: Int, index: Int) async throws {
        report.stages[stage].cases[index].benchmark = BenchmarkRecord(initialIterations: BenchmarkPolicy.iterations(original), firstExpected: String(original.expected), firstActual: report.stages[stage].cases[index].actual, requestedSamples: original.warmSamples)
        guard timingAllowed() else {
            report.stages[stage].cases[index].timingNote = "Correctness passed; calibration skipped under thermal pressure."
            return
        }
        let warmup = try await executor.invoke(original); try checkStop()
        try record(warmup, expected: original, stage: stage, index: index)
        let start = DispatchTime.now().uptimeNanoseconds
        var candidate = original, chosen: DeviceCase?
        var visited = Set<UInt64>()
        for _ in 0..<BenchmarkPolicy.maximumProbes {
            try checkStop()
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            guard timingAllowed(), elapsed < BenchmarkPolicy.calibrationBudgetMilliseconds else { break }
            let n = BenchmarkPolicy.iterations(candidate)
            guard visited.insert(n).inserted else { break }
            // The reference result and memory reset/readback are outside the timer.
            report.stages[stage].cases[index].expected = String(candidate.expected); checkpoint()
            let value = try await executor.invoke(candidate); try checkStop()
            try record(value, expected: candidate, stage: stage, index: index)
            report.stages[stage].cases[index].benchmark?.probes.append(
                CalibrationProbe(iterations:n,milliseconds:value.milliseconds,expected:String(candidate.expected),actual:String(value.result)))
            report.stages[stage].cases[index].benchmark?.selectedIterations = n
            checkpoint()
            if BenchmarkPolicy.inWindow(value.milliseconds) { chosen = candidate; break }
            let next = try BenchmarkPolicy.next(iterations:n,milliseconds:value.milliseconds)
            guard next != n else { break }
            candidate = try AdvancedPlan.resized(original,iterations:next)
            await Task.yield()
        }
        guard let chosen else {
            report.stages[stage].cases[index].timingNote = "Correctness checked, but calibration did not reach 100–500 ms within the bounded count/time/thermal limits. No comparable timing series."
            return
        }
        // Freeze the workload size for every sample; do not tune it between samples.
        report.stages[stage].cases[index].expected = String(chosen.expected)
        for _ in 0..<original.warmSamples {
            try checkStop()
            guard timingAllowed() else { break }
            let value = try await executor.invoke(chosen); try checkStop()
            try record(value,expected:chosen,stage:stage,index:index)
            report.stages[stage].cases[index].warmMilliseconds.append(value.milliseconds)
            checkpoint()
        }
        let samples = report.stages[stage].cases[index].warmMilliseconds
        let complete = timingAllowed() && samples.count == original.warmSamples && samples.allSatisfy(BenchmarkPolicy.inWindow)
        report.stages[stage].cases[index].benchmark?.windowSatisfied = complete
        if !complete {
            report.stages[stage].cases[index].timingNote = "Correctness checked; warm series was interrupted or drifted outside 100–500 ms. Raw samples retained, comparison summary suppressed."
        }
    }
    private func checkRegion(_ test: DeviceCase, executor: any SuiteExecutor, stage: Int, index: Int) async throws {
        let before = await executor.counters(); try checkStop()
        report.stages[stage].cases[index].region = RegionRecord(before: before)
        guard before["runtimeStatisticsAvailable"] == 1 else { throw SuiteFailure("Region coverage needs the updated worker runtime statistics.") }
        let start = DispatchTime.now().uptimeNanoseconds
        var installed: [String:Int]?
        // Repeated calls drive real hot-entry profiling. No fabricated profile,
        // forced region request, recorded Wasm or unsupported native option.
        for attempt in 0..<512 {
            try checkStop()
            if Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 > 10_000 { break }
            let value = try await executor.invoke(test); try checkStop()
            try record(value,expected:test,stage:stage,index:index)
            report.stages[stage].cases[index].region?.checkedPrimingCalls += 1
            if attempt % 8 == 7 {
                let counters = await executor.counters(); try checkStop()
                report.stages[stage].cases[index].region?.after = counters; checkpoint()
                if BenchmarkPolicy.usableRegion(counters) { installed = counters; break }
            }
        }
        guard let installed else {
            throw SuiteFailure("Region coverage not demonstrated within 512 priming calls / 10 seconds. Requests alone do not prove installation; inspect the runtime counters.")
        }
        report.stages[stage].cases[index].region?.installed = installed; checkpoint()
        for _ in 0..<2 {
            try checkStop()
            let value = try await executor.invoke(test); try checkStop()
            try record(value,expected:test,stage:stage,index:index)
            report.stages[stage].cases[index].region?.postInstallationCheckedCalls += 1
        }
        let after = await executor.counters(); try checkStop()
        report.stages[stage].cases[index].region?.after = after
        guard BenchmarkPolicy.usableRegion(after), after["unitRequests"] == installed["unitRequests"],
              after["regionRequests"] == installed["regionRequests"] else {
            throw SuiteFailure("Translation/flush state changed during the post-installation region checks.")
        }
    }
    private func record(_ value: CallEvidence, expected: DeviceCase, stage: Int, index: Int) throws {
        report.stages[stage].cases[index].actual = String(value.result)
        guard value.milliseconds.isFinite, value.milliseconds >= 0 else { throw SuiteFailure("Invalid timer result.") }
        guard value.result == expected.expected else {
            throw SuiteFailure("Checksum mismatch: expected \(expected.expected), got \(value.result).")
        }
        if let bytes = expected.expectedMemory {
            let matched = value.memory == bytes
            report.stages[stage].cases[index].memoryMatched = matched
            guard matched else { throw SuiteFailure("Memory or guard bytes differ from the independent reference.") }
        }
        report.stages[stage].cases[index].checkedCalls += 1
    }
}
