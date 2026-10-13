// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT
import BetterJITWebKit

@MainActor final class DiagnosticRunner {
    private(set) var report: DiagnosticReport
    private let specs: [DiagnosticSpec]
    private let mount: @MainActor (WebKitTransport?) -> Void
    private let changed: @MainActor (DiagnosticReport) -> Void
    private var stopped: DiagnosticRunState?
    private var abortCurrent: (() -> Void)?

    init(preset: DiagnosticPreset, includeStress: Bool, includeWineReadiness: Bool = true, environment: [String:String],
         conditions: [String:String], mount: @escaping @MainActor (WebKitTransport?) -> Void,
         changed: @escaping @MainActor (DiagnosticReport) -> Void) {
        specs = DiagnosticPlan.specs(preset, includeStress:includeStress).filter { includeWineReadiness || $0.kind != .wineReadiness }
        report = DiagnosticReport(preset:preset, includeStress:includeStress, environment:environment,
                                  conditions:conditions, specs:specs)
        self.mount = mount; self.changed = changed
    }
    func stop(interrupted: Bool = false) {
        stopped = interrupted ? .interrupted : .cancelled
        abortCurrent?()
    }
    private func checkpoint() { changed(report) }
    private func checkStop() throws {
        if stopped != nil || Task.isCancelled { throw CancellationError() }
    }
    func run() async -> DiagnosticReport {
        checkpoint()
        for (i,spec) in specs.enumerated() {
            do {
                try checkStop()
                report.records[i].status = .running; report.records[i].startedAt = Date(); checkpoint()
                let start = DispatchTime.now().uptimeNanoseconds
                let outcome = try await execute(spec); try checkStop()
                report.records[i].status = outcome.status
                report.records[i].details = outcome.details
                report.records[i].metrics = outcome.metrics
                report.records[i].counters = outcome.counters
                report.records[i].notes = outcome.notes
                let thermal = ProcessInfo.processInfo.thermalState.rawValue
                report.records[i].details["thermalStateAfter"] = String(thermal)
                report.records[i].details["lowPowerAfter"] = String(ProcessInfo.processInfo.isLowPowerModeEnabled)
                if thermal >= 2 && !report.records[i].notes.contains("Thermal state is serious/critical; timing metrics are not comparable.") {
                    report.records[i].notes.append("Thermal state is serious/critical; timing metrics are not comparable.")
                }
                report.records[i].durationMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
                report.records[i].finishedAt = Date()
            } catch let fault as RuntimeFault where fault.code == "unsupported" || fault.code == "mappedTransportUnavailable" {
                report.records[i].status = .unsupported
                report.records[i].details["reason"] = fault.localizedDescription
                report.records[i].finishedAt = Date()
            } catch {
                let stopping = error is CancellationError || stopped != nil || Task.isCancelled
                report.records[i].status = stopping ? .skipped : .failed
                report.records[i].error = stopping ? "Run stopped; incomplete diagnostics are not passes." :
                    String(error.localizedDescription.prefix(1024))
                report.records[i].finishedAt = Date()
                if stopping { report.state = stopped ?? .cancelled }
            }
            abortCurrent = nil; checkpoint()
            if report.state != .running { break }
            await Task.yield()
        }
        if let stopped { report.state = stopped }
        else if Task.isCancelled { report.state = .cancelled }
        else { report.state = .completed }
        for i in report.records.indices where report.records[i].status == .pending {
            report.records[i].status = .skipped
        }
        report.finishedAt = Date(); checkpoint()
        return report
    }

    private func execute(_ spec: DiagnosticSpec) async throws -> DiagnosticOutcome {
        switch spec.kind {
        case .nativeEnvironment: return NativeDiagnostics.environment()
        case .nativeVM: return try NativeDiagnostics.virtualMemory()
        case .nativeFileIO: return try NativeDiagnostics.fileIO()
        case .nativeThreads: return try NativeDiagnostics.threads()
        case .nativeMetal: return try NativeDiagnostics.metal()
        case .webFeatures:
            return try await web("features", mode:.copied)
        case .transportCopied:
            return try await web("native-roundtrip", mode:.copied,
                                 args:["repeats":.number(2)])
        case .transportMappedPreferred:
            return try await web("native-roundtrip", mode:.mappedPreferred,
                                 args:["repeats":.number(2)])
        case .transportMappedRequired:
            return try await web("native-roundtrip", mode:.mappedRequired,
                                 args:["repeats":.number(2)])
        case .transportSummary:
            return transportSummary()
        case .wasmMemory:
            return try await web("wasm-memory", mode:.mappedPreferred,
                                 args:["initialMB":.number(64),"growMB":.number(64)])
        case .wasmMemoryStress:
            return try await web("wasm-memory", mode:.mappedPreferred,
                                 args:["initialMB":.number(256),"growMB":.number(256)])
        case .opfsIO:
            return try await web("opfs-io", mode:.mappedPreferred,
                                 args:["megabytes":.number(16)])
        case .pagingSafe:
            return try await web("paging", mode:.mappedPreferred,
                                 args:["spanMB":.number(256),"frameMB":.number(32),"accesses":.number(20_000)])
        case .pagingStress:
            return try await web("paging", mode:.mappedRequired,
                                 args:["spanMB":.number(1024),"frameMB":.number(128),"accesses":.number(80_000)])
        case .sharedWorkers:
            return try await web("shared-workers", mode:.copied)
        case .moduleClone:
            return try await web("module-clone", mode:.copied)
        case .fexLayout:
            return try FEXMetadataDiagnostic.run()
        case .fexSysV: return try await fexSmoke(.sysv, simd:false)
        case .fexWin64: return try await fexSmoke(.win64, simd:false)
        case .fexSIMDSysV: return try await fexSmoke(.sysv, simd:true)
        case .fexSIMDWin64: return try await fexSmoke(.win64, simd:true)
        case .fexRegionSysV: return try await fexRegion(.sysv)
        case .fexRegionWin64: return try await fexRegion(.win64)
        case .syscallSubset:
            return try await SyscallDiagnosticExecutor.run(mapped:false, mount:mount)
        case .processLifecycle:
            return try await lifecycle()
        case .wineReadiness:
            return readiness(kind:"wine")
        case .graphicsReadiness:
            return readiness(kind:"graphics")
        }
    }

    private func web(_ name: String, mode: DiagnosticTransportMode,
                     args: [String:JSONValue] = [:]) async throws -> DiagnosticOutcome {
        let executor = WebDiagnosticExecutor(mode:mode, mount:mount)
        abortCurrent = { executor.close() }
        do {
            let caps = try await executor.start()
            var outcome = try await executor.run(name,args:args)
            outcome.details["runtimeProtocol"] = String(caps.protocolVersion)
            outcome.details["jspi"] = String(caps.jspi)
            outcome.details["sharedMemory"] = String(caps.sharedMemory)
            outcome.details["opfs"] = String(caps.opfs)
            outcome.details["transportMode"] = mode.rawValue
            executor.close(); abortCurrent = nil
            return outcome
        } catch {
            executor.close(); abortCurrent = nil; throw error
        }
    }

    private func fexSmoke(_ abi: GuestABI, simd: Bool) async throws -> DiagnosticOutcome {
        let stage: DeviceStage
        if simd {
            let cases = AdvancedPlan.simdCases(abi)
            stage = DeviceStage(id:"diag-simd-\(abi.rawValue)",title:"diag",kind:.simd,abi:abi,cases:[cases[0]])
        } else {
            stage = DeviceStage(id:"diag-fex-\(abi.rawValue)",title:"diag",kind:.baseline,abi:abi,
                                cases:[DeviceCase(id:"add",title:"add",entry:0x400000,arguments:[20,22],expected:42)])
        }
        let executor = DeviceExecutor(stage:stage, mappedTransport:.preferred, mount:mount)
        abortCurrent = { executor.abort() }
        do {
            let start = try await executor.start()
            let test = stage.cases[0]
            let value = try await executor.invoke(test)
            guard value.result == test.expected, value.memory == test.expectedMemory else {
                throw SuiteFailure("FEX diagnostic result or memory did not match.")
            }
            let counters = await executor.counters()
            await executor.close(); abortCurrent = nil
            var details = start.capabilities; details["abi"] = abi.rawValue; details["simd"] = String(simd)
            return .pass(details:details, metrics:["firstCallMilliseconds":value.milliseconds],
                         counters:counters)
        } catch {
            await executor.close(); abortCurrent = nil; throw error
        }
    }

    private func fexRegion(_ abi: GuestABI) async throws -> DiagnosticOutcome {
        guard let stage = AdvancedPlan.stages().first(where: { $0.id == "region-" + abi.rawValue }) else {
            throw SuiteFailure("Region diagnostic stage is missing.")
        }
        let executor = DeviceExecutor(stage:stage,mappedTransport:.preferred,mount:mount)
        abortCurrent = { executor.abort() }
        do {
            let evidence = try await executor.start()
            let test = stage.cases[0]
            let first = try await executor.invoke(test)
            guard first.result == test.expected else { throw SuiteFailure("Region seed call mismatch.") }
            var installed = false, calls = 1
            for attempt in 0..<192 {
                try checkStop()
                let value = try await executor.invoke(test); calls += 1
                guard value.result == test.expected else { throw SuiteFailure("Region priming checksum mismatch.") }
                if attempt % 8 == 7 {
                    let c = await executor.counters()
                    if BenchmarkPolicy.usableRegion(c) { installed = true; break }
                }
            }
            guard installed else { throw SuiteFailure("Region was not installed within the bounded diagnostic priming window.") }
            for _ in 0..<2 {
                let value = try await executor.invoke(test); calls += 1
                guard value.result == test.expected else { throw SuiteFailure("Post-region checksum mismatch.") }
            }
            let counters = await executor.counters()
            await executor.close(); abortCurrent = nil
            return .pass(details:evidence.capabilities,metrics:["checkedCalls":Double(calls),"firstCallMilliseconds":first.milliseconds],
                         counters:counters)
        } catch {
            await executor.close(); abortCurrent = nil; throw error
        }
    }

    private func lifecycle() async throws -> DiagnosticOutcome {
        var starts: [Double] = []
        for _ in 0..<3 {
            try checkStop()
            let executor = WebDiagnosticExecutor(mode:.mappedPreferred,mount:mount)
            abortCurrent = { executor.close() }
            let t = DispatchTime.now().uptimeNanoseconds
            _ = try await executor.start()
            let result = try await executor.run("features")
            guard result.status == .passed else { throw SuiteFailure("Lifecycle feature probe did not pass.") }
            starts.append(Double(DispatchTime.now().uptimeNanoseconds - t)/1_000_000)
            executor.close(); abortCurrent = nil
            await Task.yield()
        }
        return .pass(metrics:["sessions":3,"startupMedianMilliseconds":CaseRecord.median(starts) ?? 0])
    }

    private func transportSummary() -> DiagnosticOutcome {
        func record(_ id: String) -> DiagnosticRecord? { report.records.first { $0.id == id } }
        guard let copied = record("transport-copied"), let mapped = record("transport-mapped-required"),
              copied.status == .passed, mapped.status == .passed,
              let copiedRate = copied.metrics["bytes_1048576_MBps"],
              let mappedRate = mapped.metrics["bytes_1048576_MBps"] else {
            return .unsupported("Run both copied and mapped-required transport probes successfully before comparing them.")
        }
        let ratio = mappedRate / max(copiedRate, 0.000001)
        return .pass(details:[
            "comparison":"Whole native-service round trip; includes Base64 work at the service API boundary.",
            "mappedTransportActive":String(mapped.counters["mappedTransportActive"] ?? 0)
        ], metrics:[
            "copied1MiBMBps":copiedRate,
            "mapped1MiBMBps":mappedRate,
            "mappedOverCopied":ratio
        ], notes:["This does not measure pure mmap bandwidth or guest execution speed."])
    }

    private func readiness(kind: String) -> DiagnosticOutcome {
        func state(_ id: String) -> String {
            report.records.first(where: { $0.id == id })?.status.rawValue ?? "not-run"
        }
        if kind == "wine" {
            return .unsupported("Run All attempts real Wine cmd /c ver in the Linux process runtime. This primitive inventory alone is not Wine execution evidence.", details:[
                "linuxProcessRuntime":"integrated; independently executed by Run All",
                "rootfs":"application-supplied", "syscallSubset":state("syscall-subset")])
        }
        let details = [
            "nativeMetal":state("native-metal"),"mappedTransport":state("transport-mapped-required"),
            "dxmtCommandBridge":"not-integrated","nativePresentationBridge":"not-integrated"
        ]
        return .unsupported("Native Metal and the mapped data plane can be tested, but the DXMT command/resource bridge and presentation bridge are not integrated yet.", details:details)
    }
}
