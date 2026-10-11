// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import SwiftUI
import UIKit
import Darwin
import BetterJIT
import BetterJITWebKit
import BetterJITLinux

@MainActor final class DeviceSessionModel: ObservableObject {
    @Published var report: DeviceSessionReport?
    @Published var reportURL: URL?
    @Published var running=false
    @Published var transport: WebKitTransport?
    @Published var linuxSession: LinuxRuntimeSession?
    @Published var liveStatus="Ready"
    @Published var storageError: String?
    @Published var wineAvailable=LinuxHarness.winePresent
    @Published var importing=false
    private var task: Task<Void,Never>?
    private var suiteRunner: SuiteRunner?
    private var diagnosticRunner: DiagnosticRunner?
    private var stopped: ReportState?
    private var expired=false
    private var activeIndex: Int?
    private var lastLogCheckpoint: UInt64=0
    private lazy var linux = LinuxHarness { [weak self] session,status,log in
        guard let self else { return }
        self.linuxSession=session
        if session != nil { self.liveStatus=status }
        if let i=self.activeIndex, !log.isEmpty {
            self.report?.phases[i].log=String(log.suffix(128*1024))
            let now=DispatchTime.now().uptimeNanoseconds
            if now-self.lastLogCheckpoint > 500_000_000 { self.lastLogCheckpoint=now; self.save() }
        }
    }
    init() {
        do {
            let url=try directory().appendingPathComponent("latest-session.json")
            if FileManager.default.fileExists(atPath:url.path) {
                let data=try Data(contentsOf:url)
                guard data.count <= 16*1024*1024 else { throw SuiteFailure("Saved session exceeds the report limit.") }
                let decoder=JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
                var value=try decoder.decode(DeviceSessionReport.self,from:data)
                guard value.schema == 1 else { throw SuiteFailure("Unsupported saved session schema.") }
                value.interrupt(); report=value; save()
                liveStatus="Restored \(value.overall.lowercased()) session"
            }
        } catch { storageError="Could not restore session: \(error.localizedDescription)" }
    }
    func runAll(standalone:Bool, offline:Bool, stress:Bool, resume:Bool = false) {
        guard !running, !importing else { return }
        let previous=resume ? report : nil
        if resume && previous?.canResume != true { return }
        let currentEnvironment=environment()
        if let previous, previous.environment["sourceRevision"] != currentEnvironment["sourceRevision"] {
            storageError="This saved session used a different source revision. Use Run All for the current app build."
            return
        }
        stopped=nil; expired=false; running=true; storageError=nil; reportURL=nil
        report=DeviceSessionReport(environment:currentEnvironment,conditions:[
            "userReportsHomeScreenNoDebugger":String(standalone),"userReportsOffline":String(offline),
            "conditionsIndependentlyVerified":"false","includeStress":String(stress)],resuming:previous)
        save()
        task=Task { [weak self] in guard let self else { return }; await self.executeAll(stress:stress) }
    }
    func stop(interrupted:Bool = false) {
        guard running else { return }
        stopped=interrupted ? .interrupted : .cancelled
        report?.state=stopped!; liveStatus="Stopping; saving completed results"
        save(); abort(interrupted:interrupted); task?.cancel()
        // Retain ownership until teardown finishes; a new run cannot overlap the old one.
    }
    private func abort(interrupted:Bool = false) {
        suiteRunner?.stop(interrupted:interrupted)
        diagnosticRunner?.stop(interrupted:interrupted)
        linux.stop(); transport?.close()
    }
    private func checkStop() throws {
        if expired { throw SuiteFailure("Phase exceeded its host deadline; its executor was closed.") }
        if stopped != nil || Task.isCancelled { throw CancellationError() }
    }
    private func executeAll(stress:Bool) async {
        let count=report?.phases.count ?? 0
        for i in 0..<count {
            if report?.phases[i].status != .pending { continue }
            if stopped != nil || Task.isCancelled { break }
            activeIndex=i; expired=false
            report?.phases[i].status = .running; report?.phases[i].startedAt=Date()
            liveStatus=report?.phases[i].title ?? "Running"; save()
            let seconds=report!.phases[i].deadlineSeconds
            let deadline=Task { [weak self] in
                do { try await Task.sleep(nanoseconds:UInt64(seconds*1_000_000_000)) } catch { return }
                guard let self, self.activeIndex == i else { return }
                self.expired=true; self.liveStatus="Deadline reached; closing this phase"; self.abort()
            }
            let start=DispatchTime.now().uptimeNanoseconds
            do {
                try await execute(i,stress:stress); try checkStop()
            } catch {
                let cancellation=stopped != nil || Task.isCancelled || error is CancellationError
                report?.phases[i].status = cancellation ? .skipped : .failed
                report?.phases[i].error=cancellation ? "Stopped before completion; this phase can be retried." : String(error.localizedDescription.prefix(2048))
            }
            deadline.cancel()
            report?.phases[i].milliseconds=Double(DispatchTime.now().uptimeNanoseconds-start)/1_000_000
            report?.phases[i].finishedAt=Date()
            transport=nil; linuxSession=nil; suiteRunner=nil; diagnosticRunner=nil; activeIndex=nil
            save(); await Task.yield()
        }
        for i in 0..<count where report?.phases[i].status == .pending {
            report?.phases[i].status = .skipped; report?.phases[i].error="Session stopped before this phase."
        }
        report?.state=stopped ?? (Task.isCancelled ? .cancelled : .completed)
        report?.finishedAt=Date()
        report?.environment["thermalAtEnd"]=String(ProcessInfo.processInfo.thermalState.rawValue)
        report?.environment["lowPowerAtEnd"]=String(ProcessInfo.processInfo.isLowPowerModeEnabled)
        liveStatus=report?.overall ?? "Finished"; save()
        running=false; task=nil
    }
    private func execute(_ i:Int, stress:Bool) async throws {
        guard let id=report?.phases[i].id else { throw SuiteFailure("Missing phase.") }
        if id.hasPrefix("linux-") || id == "wine" {
            if id == "wine" && !LinuxHarness.winePresent {
                report?.phases[i].status = .unsupported
                report?.phases[i].details["reason"]="Wine root is absent. Choose a staged linuxroot folder or copy it into Documents/linuxroot, then Run All again."
                return
            }
            let channels=id == "linux-channels"
            let mode:LinuxHarness.Mode=id == "wine" ? .wineCommand : (id == "linux-smoke" ? .smoke : .services)
            let value=try await linux.run(mode,nativeChannels:channels)
            try checkStop()
            report?.phases[i].log=String(value.log.suffix(128*1024))
            report?.phases[i].counters=linux.counters
            report?.phases[i].details["exitCode"]=String(value.exitCode)
            report?.phases[i].details["execution"]="Real guest ELF → native FEX → Wasm → Linux syscalls"
            report?.phases[i].details["nativeChannelsRequested"]=String(channels)
            let attached=value.log.contains("[xlat] channel ready") && value.log.contains("[kern] channel ready")
            report?.phases[i].details["transportObserved"]=channels ? (attached ? "native OPFS channels attached" : "HTTP fallback; native channel attachment not observed") : "HTTP"
            guard value.exitCode == 0, (linux.counters["unitRequests"] ?? 0)>0,
                  (linux.counters["codeMappings"] ?? 0)>0 else {
                throw SuiteFailure("Guest did not exit 0 with live FEX translation and code mapping evidence.")
            }
            if id == "wine" {
                guard value.log.range(of:"(?im)^\\s*(Microsoft )?Windows[^\\n]*[0-9]+\\.[0-9]+",options:.regularExpression) != nil else {
                    throw SuiteFailure("Wine exited 0 but cmd /c ver did not print a Windows version.")
                }
            } else {
                let marker=id == "linux-smoke" ? "BetterJIT Linux OK" : LinuxSessionFixture.marker
                guard value.log.split(separator:"\n").contains(where:{$0.trimmingCharacters(in:.whitespacesAndNewlines) == marker}) else {
                    throw SuiteFailure("Guest success marker was not observed on stdout.")
                }
            }
            report?.phases[i].status = .passed
            return
        }
        if id == "copied-suite" || id == "mapped-suite" {
            let mapped=id == "mapped-suite"
            // Inventory capabilities once before attempting all ABI cases. Missing engine
            // capabilities are unsupported; traps or bad guest results remain failures.
            let probe=WebDiagnosticExecutor(mode:mapped ? .mappedRequired : .copied,mount:{ [weak self] in self?.transport=$0 })
            do {
                let caps=try await probe.start(); probe.close(); try checkStop()
                guard caps.jspi else {
                    report?.phases[i].status = .unsupported
                    report?.phases[i].details["reason"]="This WebKit engine does not provide JSPI for live FEX native calls."
                    return
                }
            } catch let fault as RuntimeFault where fault.code == "mappedTransportUnavailable" || fault.code == "unsupported" {
                probe.close(); report?.phases[i].status = .unsupported
                report?.phases[i].details["reason"]=fault.localizedDescription; return
            } catch { probe.close(); throw error }
            let runner=SuiteRunner(mode:.extended,environment:report!.environment,conditions:report!.conditions,
                factory:{ [weak self] stage in DeviceExecutor(stage:stage,mappedTransport:mapped ? .required : .disabled,
                    mount:{ [weak self] in self?.transport=$0 }) },
                timingAllowed:{ ProcessInfo.processInfo.thermalState.rawValue < 2 },
                changed:{ [weak self] value in
                    self?.report?.suites[id]=value
                    if let stage=value.stages.first(where:{$0.status == .running}) {
                        let check=stage.cases.first(where:{$0.status == .running})?.title ?? "Opening executor"
                        self?.liveStatus="\(stage.title): \(check)"
                    }
                    self?.save()
                })
            suiteRunner=runner
            let value=await runner.run(); try checkStop()
            report?.suites[id]=value
            report?.phases[i].status=value.overall == "PASS" ? .passed : .failed
            if value.overall != "PASS" { report?.phases[i].error="FEX suite \(value.overall); expand the cases for the first failure." }
            return
        }
        let runner=DiagnosticRunner(preset:.full,includeStress:stress,environment:report!.environment,
            conditions:report!.conditions,mount:{ [weak self] in self?.transport=$0 },
            changed:{ [weak self] value in
                self?.report?.diagnostics=value
                if let record=value.records.first(where:{$0.status == .running}) { self?.liveStatus=record.title }
                self?.save()
            })
        diagnosticRunner=runner
        let value=await runner.run(); try checkStop()
        report?.diagnostics=value
        if value.records.contains(where:{$0.status == .failed}) {
            report?.phases[i].status = .failed; report?.phases[i].error="Diagnostic failures; expand the records for details."
        } else if value.records.contains(where:{[.skipped,.pending,.running].contains($0.status)}) {
            report?.phases[i].status = .skipped
        } else if value.records.contains(where:{$0.status == .unsupported}) {
            report?.phases[i].status = .unsupported
            report?.phases[i].details["reason"]="Available primitives completed; unsupported integrations are listed individually below."
        } else { report?.phases[i].status = .passed }
    }
    private func directory() throws -> URL {
        let docs=try FileManager.default.url(for:.documentDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
        let root=docs.appendingPathComponent("BetterJITSessions",isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true); return root
    }
    private func save() {
        guard let report else { return }
        do {
            let root=try directory(), data=try report.data()
            let url=root.appendingPathComponent("BetterJIT-Session-\(report.runID.uuidString).json")
            try data.write(to:url,options:.atomic)
            try data.write(to:root.appendingPathComponent("latest-session.json"),options:.atomic)
            reportURL=url
        } catch { storageError="Session could not be saved: \(error.localizedDescription)" }
    }
    func importRoot(_ url:URL) {
        guard !running, !importing else { return }
        importing=true; storageError=nil; liveStatus="Importing Wine root"
        task=Task { [weak self] in
            guard let self else { return }
            let scoped=url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() }; self.importing=false; self.task=nil }
            do {
                try await LinuxRootImporter.copy(from:url,to:LinuxHarness.rootURL,progress:{ [weak self] count in
                    Task { @MainActor in self?.liveStatus="Imported \(count) files" }
                })
                self.wineAvailable=LinuxHarness.winePresent; self.liveStatus="Wine root ready; tap Run All"
            } catch { self.storageError="Root import failed: \(error.localizedDescription)"; self.liveStatus="Import stopped" }
        }
    }
    func cancelImport() { task?.cancel() }
    private func environment() -> [String:String] {
        let info=Bundle.main.infoDictionary ?? [:]
        var machine=utsname(); uname(&machine)
        let hardware=withUnsafeBytes(of:machine.machine) { String(decoding:$0.prefix{$0 != 0},as:UTF8.self) }
        return ["os":ProcessInfo.processInfo.operatingSystemVersionString,"deviceClass":UIDevice.current.model,
            "hardwareModel":hardware,"appVersion":info["CFBundleShortVersionString"] as? String ?? "unknown",
            "sourceRevision":info["BetterJITSourceCommit"] as? String ?? "unrecorded",
            "sourceStateAtProjectGeneration":info["BetterJITSourceState"] as? String ?? "unrecorded",
            "thermalAtStart":String(ProcessInfo.processInfo.thermalState.rawValue),
            "lowPowerAtStart":String(ProcessInfo.processInfo.isLowPowerModeEnabled)]
    }
}
