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
                    if test.warmSamples > 0 {
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
