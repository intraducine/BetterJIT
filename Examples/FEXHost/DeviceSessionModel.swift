// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import SwiftUI
import UIKit
import Darwin
import BetterJIT
import BetterJITWebKit
import BetterJITLinux
import BetterJITFEXAdapter

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
    private var consumerBackend:FEXDocumentDigestBackend?
    private var lastLogCheckpoint: UInt64=0
    private var linuxEngineCapabilities: RuntimeCapabilities?
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
        stopped=nil; expired=false; running=true; storageError=nil; reportURL=nil; linuxEngineCapabilities=nil
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
        consumerBackend?.close(); linux.stop(); transport?.close()
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
    private func linuxSupported(phase:Int) async throws -> Bool {
        if linuxEngineCapabilities == nil {
            let probe=WebDiagnosticExecutor(mode:.copied,mount:{ [weak self] in self?.transport=$0 })
            defer { probe.close() }
            linuxEngineCapabilities=try await probe.start()
            try checkStop()
        }
        if let caps=linuxEngineCapabilities {
            report?.phases[phase].details["engineJSPI"]=String(caps.jspi)
            report?.phases[phase].details["engineSharedMemory"]=String(caps.sharedMemory)
            guard caps.jspi && caps.sharedMemory else {
                report?.phases[phase].status = .unsupported
                report?.phases[phase].details["reason"]="This WebKit engine lacks JSPI or shared Wasm memory required by the Linux/Wine runtime."
                return false
            }
        }
        return true
    }
    private func execute(_ i:Int, stress:Bool) async throws {
        guard let id=report?.phases[i].id else { throw SuiteFailure("Missing phase.") }
        if id == "compiled-pipeline" {
            report?.phases[i].details["execution"]="Compiler C parent → fork → compiler child exec → inherited stdin/stdout → wait/exit"
            report?.phases[i].details["lifecycle"]="Bounded guest-access quiescence; occupied slots and internal contexts retained until session teardown; physical worker retirement unsupported"
            report?.phases[i].details["JSPIRequired"]="false"
            do {
                let parent=try SparsePipelineFixture.load(),child=try SparseCatFixture.load()
                report?.phases[i].details["compiler"]=parent.1.compiler
                report?.phases[i].details["sourceSHA256"]=parent.1.sourceSHA256
                report?.phases[i].details["elfSHA256"]=parent.1.elfSHA256
                report?.phases[i].details["childELFSHA256"]=child.1.elfSHA256
                report?.phases[i].details["childSourceSHA256"]=child.1.sourceSHA256
                report?.phases[i].details["childCompiler"]=child.1.compiler
                let value=try await linux.run(.sparsePipeline)
                try checkStop()
                report?.phases[i].captureOutput(log:value.log,stdout:value.stdout,stderr:value.stderr,runtimeTruncated:value.outputTruncated)
                report?.phases[i].counters=linux.counters
                let evidence=try SparsePipelineFixture.RuntimeEvidence.parse(value.log)
                report?.phases[i].details["exitCode"]=String(value.exitCode)
                report?.phases[i].details["stdinProvidedBytes"]=String(evidence.stdin.providedBytes)
                report?.phases[i].details["stdinConsumedBytes"]=String(evidence.stdin.consumedBytes)
                report?.phases[i].details["stdinPositiveReads"]=String(evidence.stdin.positiveReads)
                report?.phases[i].details["stdinSHA256"]=SparseCatFixture.digest(SparsePipelineFixture.input)
                report?.phases[i].details["stdoutSHA256"]=SparseCatFixture.digest(Data(value.stdout.utf8))
                report?.phases[i].details["guestWasmSteps"]=String(evidence.steps)
                report?.phases[i].details["guestBackingAfterCloseBytes"]=String(evidence.guestBacking.ownedPayloadBytes)
                report?.phases[i].details["internalContextsRetained"]=String(evidence.internalContextsRetained)
                report?.phases[i].details["internalBytesRetained"]=String(evidence.internalBytesRetained)
                report?.phases[i].details["guestAccessQuiescenceAcknowledged"]=String(evidence.guestAccessQuiescenceAcknowledged)
                report?.phases[i].details["workerRetirementAcknowledged"]=String(evidence.workerRetirementAcknowledged)
                guard value.exitCode==0,value.stdout==SparsePipelineFixture.expected,value.stderr.isEmpty,!value.outputTruncated,
                      evidence.stdin.providedBytes==SparsePipelineFixture.input.count,evidence.stdin.consumedBytes==SparsePipelineFixture.input.count,evidence.stdin.positiveReads==3,
                      evidence.births.count==1,evidence.commits.count==1,evidence.commits[0].pid==evidence.births[0].pid,evidence.commits[0].path=="/test/cat",
                      evidence.guestAccessQuiescenceAcknowledged,!evidence.workerRetirementAcknowledged,evidence.internalContextsRetainedUntilSessionTeardown,
                      evidence.internalContextsRetained==3,evidence.internalBytesRetained==3*33*65536,evidence.guestBacking.ownedPayloadBytes==0,
                      (linux.counters["stepRequests"] ?? 0)>0,(linux.counters["codeMappings"] ?? 0)>0 else {
                    throw SuiteFailure("Compiled process tree did not complete its bounded guest lifecycle with exact output and retained-context evidence.")
                }
                report?.phases[i].status = .passed
            } catch LinuxRuntimeError.unsupported(let reason) {
                report?.phases[i].counters=linux.counters;report?.phases[i].status = .unsupported;report?.phases[i].details["reason"]=reason
            } catch SparseROT13Fixture.LinuxFixtureError.missing {
                report?.phases[i].status = .unsupported;report?.phases[i].details["reason"]="A compiled process payload is absent from this build."
            }
            return
        }
        if id == "compiled-rot13" || id == "compiled-cat" {
            let cat=id == "compiled-cat",expected=cat ? SparseCatFixture.expected : SparseROT13Fixture.expected
            let input=cat ? SparseCatFixture.input : Data()
            report?.phases[i].details["execution"]="Ordinary compiler ELF → sparse FEX/Wasm → captured output and normal exit"
            report?.phases[i].details["JSPIRequired"]="false"
            report?.phases[i].details["lifecycle"]="One process; storage retained until session teardown; fork/exec/retirement unsupported"
            do {
                let fixture=try (cat ? SparseCatFixture.load() : SparseROT13Fixture.load())
                report?.phases[i].details["compiler"]=fixture.1.compiler
                report?.phases[i].details["elfSHA256"]=fixture.1.elfSHA256
                report?.phases[i].details["sourceSHA256"]=fixture.1.sourceSHA256
                let value=try await linux.run(cat ? .sparseCat : .sparseROT13)
                try checkStop()
                report?.phases[i].captureOutput(log:value.log,stdout:value.stdout,stderr:value.stderr,runtimeTruncated:value.outputTruncated)
                report?.phases[i].counters=linux.counters
                report?.phases[i].details["exitCode"]=String(value.exitCode)
                let evidence=try SparseCatFixture.RuntimeEvidence.parse(value.log)
                report?.phases[i].details["stdinProvidedBytes"]=String(evidence.stdin.providedBytes)
                report?.phases[i].details["stdinConsumedBytes"]=String(evidence.stdin.consumedBytes)
                report?.phases[i].details["stdinPositiveReads"]=String(evidence.stdin.positiveReads)
                report?.phases[i].details["stdinSHA256"]=SparseCatFixture.digest(input)
                report?.phases[i].details["stdoutSHA256"]=SparseCatFixture.digest(Data(value.stdout.utf8))
                report?.phases[i].details["guestWasmSteps"]=String(evidence.steps)
                report?.phases[i].details["internalBytes"]=String(evidence.internalBytes)
                report?.phases[i].details["workerRetirementAcknowledged"]=String(evidence.workerRetirementAcknowledged)
                guard value.exitCode == 0, value.stdout == expected, value.stderr.isEmpty,
                      evidence.stdin.providedBytes==input.count,evidence.stdin.consumedBytes==input.count,
                      evidence.retainedUntilSessionTeardown,!evidence.workerRetirementAcknowledged,
                      (linux.counters["stepRequests"] ?? 0)>0, (linux.counters["codeMappings"] ?? 0)>0,
                      !value.outputTruncated else {
                    throw SuiteFailure("Compiled command did not produce the expected text and input evidence through live sparse FEX steps.")
                }
                report?.phases[i].status = .passed
            } catch LinuxRuntimeError.unsupported(let reason) {
                report?.phases[i].counters=linux.counters
                report?.phases[i].status = .unsupported;report?.phases[i].details["reason"]=reason
            } catch SparseROT13Fixture.LinuxFixtureError.missing {
                report?.phases[i].status = .unsupported;report?.phases[i].details["reason"]="The compiled command payload is absent from this app build."
            }
            return
        }
        if id == "consumer-digest" {
            guard try await linuxSupported(phase:i) else { return }
            guard FileManager.default.fileExists(atPath:LinuxHarness.rootURL.appendingPathComponent("bin/busybox").path) else {
                report?.phases[i].status = .unsupported
                report?.phases[i].details["reason"]="BusyBox is missing from the selected Linux root."
                return
            }
            let consumer=FEXDocumentDigestBackend();consumerBackend=consumer
            consumer.mount={ [weak self] in self?.linuxSession=$0?.session }
            consumer.onLog={ [weak self] text in
                guard let self, self.activeIndex == i else { return }
                self.report?.phases[i].log=String(((self.report?.phases[i].log ?? "")+text).suffix(128*1024))
                self.liveStatus="Consumer: guest sha256sum running"
                self.save()
            }
            defer {consumer.close();consumerBackend=nil;linuxSession=nil}
            let result=try await consumer.digest(LinuxUserspaceWorkload.payload)
            try checkStop()
            guard result.sha256==LinuxUserspaceWorkload.expectedSHA256 else {throw SuiteFailure("Consumer backend returned a different document digest.")}
            report?.phases[i].counters=result.counters
            report?.phases[i].details["sha256"]=result.sha256
            report?.phases[i].details["execution"]="Public packaged FEXProcess adapter → real x86 Linux sha256sum"
            report?.phases[i].details["inputBytes"]=String(LinuxUserspaceWorkload.payloadBytes)
            report?.phases[i].status = .passed
            return
        }
        let adapted=AdaptedWinePhase(rawValue:id)
        let wine = id == "wine" || id == "wine-direct" || adapted != nil
        if id.hasPrefix("linux-") || wine {
            if adapted != nil && !LinuxHarness.flatWinePresent {
                report?.phases[i].status = .unsupported
                report?.phases[i].details["reason"]="The separate source-built Wine flat-window input is absent. Stock Wine attempts remain available."
                return
            }
            if wine && !LinuxHarness.winePresent {
                report?.phases[i].status = .unsupported
                report?.phases[i].details["reason"]="Wine root is absent. Choose a staged linuxroot folder or copy it into Documents/linuxroot, then Run All again."
                return
            }
            if let adapted {
                report?.phases[i].details["workload"]=adapted.arguments.joined(separator:" ")
                report?.phases[i].details["standardIO"]="Separate UTF-8 stdout/stderr; EOF stdin; no terminal ioctls"
                report?.phases[i].details["isolation"]="Fresh FEXProcess and kernel worker for this workload; no prerequisite contract in the same guest. Cleanup is not proof of engine collection or a separate OS process."
            }
            if wine {
                report?.phases[i].details["memoryFaultTrace"]="Guest instruction and scalar/bulk operands requested; unit translation only. Diagnostic overhead is included in phase time."
                report?.phases[i].details["loaderMode"]=id == "wine" ? "stock Wine preloader" : "WINELOADERNOEXEC=1; WINEARCH=win64"
                report?.phases[i].details["addressSpaces"]=adapted != nil ? "Separate guest process memories; existing per-executable maxima" : "Existing shared guest address space"
                let root=LinuxHarness.rootURL
                report?.phases[i].details["rootOrigin"]=root == LinuxHarness.documentsRootURL ? "imported Documents root" : "bundled input candidate"
                if let handle=try? FileHandle(forReadingFrom:root.appendingPathComponent(".betterjit-linux-root.json")) {
                    defer { try? handle.close() }
                    if let data=try? handle.read(upToCount:1024*1024),
                       let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any] {
                        for key in ["candidate","wineVersion","rootArchiveSHA256","baseImageID"] {
                            if let value=object[key] as? String { report?.phases[i].details[key]=String(value.prefix(512)) }
                        }
                    }
                }
                if adapted != nil,
                   let handle=try? FileHandle(forReadingFrom:root.appendingPathComponent("opt/wine-flat/.betterjit-wine-flat.json")) {
                    defer { try? handle.close() }
                    if let data=try? handle.read(upToCount:1024*1024),
                       let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any] {
                        for key in ["candidate","wineSourceCommit","patchSHA256","guestAddressLimitExclusive","nonNullFSSelectors","nativePrefix","nativePrefixArchiveSHA256","nativePrefixUpdates","processSpawnPolicy"] {
                            if let value=object[key] as? String { report?.phases[i].details[key]=String(value.prefix(512)) }
                        }
                    }
                }
            }
            if id == "linux-userspace", !FileManager.default.fileExists(atPath:LinuxHarness.rootURL.appendingPathComponent("bin/busybox").path) {
                report?.phases[i].status = .unsupported
                report?.phases[i].details["reason"]="BusyBox is missing from the selected Linux root. The bundled root includes it."
                return
            }
            guard try await linuxSupported(phase:i) else { return }
            let channels=id == "linux-channels"
            let mode:LinuxHarness.Mode=adapted.map{.adaptedWine($0)} ?? (id == "wine-direct" ? .wineDirect : (id == "wine" ? .wineCommand : (id == "linux-smoke" ? .smoke : (id == "linux-userspace" ? .userspace : .services))))
            let value=try await linux.run(mode,nativeChannels:channels)
            try checkStop()
            report?.phases[i].captureOutput(log:value.log,stdout:value.stdout,stderr:value.stderr,
                                            runtimeTruncated:value.outputTruncated)
            report?.phases[i].counters=linux.counters
            report?.phases[i].details["exitCode"]=String(value.exitCode)
            let allocations=value.log.split(separator:"\n").filter { $0.hasPrefix("[memory-allocation] ") }
            report?.phases[i].details["allocationEventCount"]=String(allocations.count)
            let allocationFailures=allocations.filter{$0.contains("\"event\":\"failed\"")}
            report?.phases[i].details["allocationFailureSampleCount"]=String(allocationFailures.count)
            if let first=allocationFailures.first {
                report?.phases[i].details["firstAllocationFailure"]=String(first.dropFirst(20).prefix(8192))
            }
            if let failed=allocationFailures.last {
                report?.phases[i].details["lastAllocationFailure"]=String(failed.dropFirst(20).prefix(8192))
            }
            let faults=value.log.split(separator:"\n").filter { $0.hasPrefix("[memory-fault] ") }
            if let first=faults.first {
                report?.phases[i].details["firstMemoryFaultTrace"]=String(first.dropFirst(15).prefix(2048))
                report?.phases[i].details["memoryFaultTraceCount"]=String(faults.count)
            }
            report?.phases[i].details["execution"]="Real guest ELF → native FEX → Wasm → Linux syscalls"
            report?.phases[i].details["nativeChannelsRequested"]=String(channels)
            let usedNative=(linux.counters["xlatChannelCompletedRequests"] ?? 0)>0 && (linux.counters["kernChannelCompletedRequests"] ?? 0)>0
            let attached=value.log.contains("[xlat] channel ready") && value.log.contains("[kern] channel ready")
            report?.phases[i].details["transportObserved"]=channels ? (usedNative ? "successful xlat and kernel native-channel replies" : (attached ? "attached, but successful use of both channels unproven" : "HTTP fallback; native channel attachment not observed")) : "HTTP"
            guard value.exitCode == 0, (linux.counters["unitRequests"] ?? 0)>0,
                  (linux.counters["codeMappings"] ?? 0)>0 else {
                throw SuiteFailure("Guest did not exit 0 with live FEX translation and code mapping evidence.")
            }
            if wine {
                if let adapted {
                    let missing=adapted.missingMarkers(in:value.stdout)
                    guard missing.isEmpty else { throw SuiteFailure("Missing guest milestones: "+missing.joined(separator:"; ")) }
                }
                if adapted == nil || adapted == .command {
                    guard let version=DeviceSessionGuestOutput.windowsVersion(in:value.stdout) else {
                        throw SuiteFailure("Wine exited 0 but cmd /c ver did not print a Windows version.")
                    }
                    report?.phases[i].details["windowsVersion"]=version
                }
            } else {
                let marker=id == "linux-smoke" ? "BetterJIT Linux OK" : (id == "linux-userspace" ? LinuxUserspaceWorkload.marker : LinuxSessionFixture.marker)
                if id == "linux-userspace" {
                    guard LinuxUserspaceWorkload.requiredMarkers.allSatisfy({ value.stdout.contains($0) }) else {
                        throw SuiteFailure("Linux userspace did not complete every file, signal and process-status milestone.")
                    }
                    report?.phases[i].details["expectedSHA256"]=LinuxUserspaceWorkload.expectedSHA256
                    report?.phases[i].details["inputBytes"]=String(LinuxUserspaceWorkload.payloadBytes)
                    guard value.stdout.contains(LinuxUserspaceWorkload.expectedSHA256+"  -") else {
                        throw SuiteFailure("Guest shell/pipeline SHA-256 did not match the bundled input.")
                    }
                }
                guard value.stdout.split(separator:"\n").contains(where:{$0.trimmingCharacters(in:.whitespacesAndNewlines) == marker}) else {
                    throw SuiteFailure("Guest success marker was not observed on stdout.")
                }
            }
            report?.phases[i].details["guestExecutionPassed"]="true"
            report?.phases[i].status = channels && !usedNative ? .unsupported : .passed
            if channels && !usedNative {
                report?.phases[i].details["reason"]="Guest passed, but successful xlat and kernel native-channel requests were not both observed. HTTP fallback is not proof of native-channel execution."
            }
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
        let runner=DiagnosticRunner(preset:.full,includeStress:stress,includeWineReadiness:false,environment:report!.environment,
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
                try await LinuxRootImporter.copy(from:url,to:LinuxHarness.documentsRootURL,progress:{ [weak self] count in
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
            "appBuild":info["CFBundleVersion"] as? String ?? "unknown",
            "guestCompiler":CompiledGuest.compiler,"guestCompilerFlags":CompiledGuest.flags,
            "simdCompiler":ExtendedGuest.compiler,"simdCompilerFlags":ExtendedGuest.flags,
            "sourceRevision":info["BetterJITSourceCommit"] as? String ?? "unrecorded",
            "sourceStateAtProjectGeneration":info["BetterJITSourceState"] as? String ?? "unrecorded",
            "thermalAtStart":String(ProcessInfo.processInfo.thermalState.rawValue),
            "lowPowerAtStart":String(ProcessInfo.processInfo.isLowPowerModeEnabled)]
    }
}
