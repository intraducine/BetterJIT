// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI
import UIKit
import Darwin
import WebKit
import BetterJITWebKit

@main struct FEXHostApp: App {
    var body: some Scene { WindowGroup { FEXHostView() } }
}

@MainActor private final class FEXHostModel: ObservableObject {
    @Published var report: SuiteReport?
    @Published var running = false
    @Published var transport: WebKitTransport?
    @Published var reportURL: URL?
    @Published var storageError: String?
    @Published var diagnosticReport: DiagnosticReport?
    @Published var diagnosticReportURL: URL?
    private var task: Task<Void, Never>?
    private var runner: SuiteRunner?
    private var diagnosticRunner: DiagnosticRunner?
    init() {
        do {
            let url = try directory().appendingPathComponent("latest.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                guard data.count <= 4 * 1024 * 1024 else { throw SuiteFailure("Previous report is too large.") }
                let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
                var restored = try decoder.decode(SuiteReport.self, from: data)
                guard (1...2).contains(restored.schema) else { throw SuiteFailure("Unsupported previous report schema.") }
                restored.markInterrupted(); report = restored; save(restored)
            }
        } catch { storageError = "Previous report could not be restored: \(error.localizedDescription)" }
        do {
            let url = try directory().appendingPathComponent("latest-diagnostic.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let data = try Data(contentsOf: url)
                guard data.count <= 8 * 1024 * 1024 else { throw SuiteFailure("Previous diagnostic report is too large.") }
                let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
                var restored = try decoder.decode(DiagnosticReport.self, from: data)
                restored.markInterrupted(); diagnosticReport = restored; saveDiagnostic(restored)
            }
        } catch { storageError = "Previous diagnostic report could not be restored: \(error.localizedDescription)" }
    }
    func run(_ mode: SuiteMode, standalone: Bool, offline: Bool, mappedTransport: Bool = false) {
        guard !running else { return }
        running = true; storageError = nil; reportURL = nil
        let runner = SuiteRunner(mode: mode, environment: environment(),
                                 conditions: ["userReportsHomeScreenNoDebugger": String(standalone), "userReportsWiFiAndCellularOff": String(offline),
                                              "conditionsIndependentlyVerified": "false", "mappedTransportRequested": String(mappedTransport)],
                                 factory: { [weak self] stage in
            DeviceExecutor(stage: stage, mappedTransport: mappedTransport ? .required : .disabled,
                           mount: { [weak self] view in self?.transport = view })
        }, timingAllowed: { ProcessInfo.processInfo.thermalState != .serious && ProcessInfo.processInfo.thermalState != .critical },
                                 changed: { [weak self] value in self?.report = value; self?.save(value) })
        self.runner = runner
        task = Task { [weak self] in
            var result = await runner.run()
            guard let self else { return }
            result.environment["thermalAtEnd"] = String(ProcessInfo.processInfo.thermalState.rawValue)
            result.environment["lowPowerAtEnd"] = String(ProcessInfo.processInfo.isLowPowerModeEnabled)
            self.report = result; self.save(result)
            self.transport = nil; self.running = false; self.runner = nil; self.task = nil
        }
    }
    func runDiagnostics(_ preset: DiagnosticPreset, includeStress: Bool, standalone: Bool, offline: Bool) {
        guard !running else { return }
        running = true; storageError = nil; diagnosticReportURL = nil
        let runner = DiagnosticRunner(preset:preset, includeStress:includeStress, environment:environment(),
                                      conditions:["userReportsHomeScreenNoDebugger":String(standalone),
                                                  "userReportsWiFiAndCellularOff":String(offline),
                                                  "conditionsIndependentlyVerified":"false"],
                                      mount:{ [weak self] view in self?.transport = view },
                                      changed:{ [weak self] value in self?.diagnosticReport=value; self?.saveDiagnostic(value) })
        diagnosticRunner = runner
        task = Task { [weak self] in
            var result = await runner.run()
            guard let self else { return }
            result.environment["thermalAtEnd"] = String(ProcessInfo.processInfo.thermalState.rawValue)
            result.environment["lowPowerAtEnd"] = String(ProcessInfo.processInfo.isLowPowerModeEnabled)
            self.diagnosticReport = result; self.saveDiagnostic(result)
            self.transport=nil; self.running=false; self.diagnosticRunner=nil; self.task=nil
        }
    }
    func stop(interrupted: Bool = false) {
        guard running else { return }
        runner?.stop(interrupted: interrupted); diagnosticRunner?.stop(interrupted: interrupted); task?.cancel()
    }
    private func directory() throws -> URL {
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let url = documents.appendingPathComponent("BetterJITBenchmarks", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func saveDiagnostic(_ value: DiagnosticReport) {
        do {
            let root=try directory(), data=try value.data()
            let url=root.appendingPathComponent("BetterJIT-Diagnostic-\(value.runID.uuidString).json")
            try data.write(to:url,options:.atomic)
            try data.write(to:root.appendingPathComponent("latest-diagnostic.json"),options:.atomic)
            diagnosticReportURL=url
        } catch { storageError="Diagnostic report could not be saved: \(error.localizedDescription)" }
    }
    private func save(_ value: SuiteReport) {
        do {
            let root = try directory(), data = try value.data()
            let url = root.appendingPathComponent("BetterJIT-\(value.runID.uuidString).json")
            try data.write(to: url, options: .atomic)
            try data.write(to: root.appendingPathComponent("latest.json"), options: .atomic)
            reportURL = url
        } catch { storageError = "Report could not be saved: \(error.localizedDescription)" }
    }
    private func deviceModelIdentifier() -> String {
        var info = utsname()
        guard uname(&info) == 0 else { return "unknown" }
        let data = withUnsafeBytes(of: info.machine) { Data($0.prefix { $0 != 0 }) }
        return String(data: data, encoding: .ascii) ?? "unknown"
    }
    private func environment() -> [String: String] {
        let info = Bundle.main.infoDictionary ?? [:]
        return ["os": ProcessInfo.processInfo.operatingSystemVersionString,
                "deviceClass": UIDevice.current.model, // Not the user's device name or UDID.
                "hardwareModel": deviceModelIdentifier(),
                "appVersion": info["CFBundleShortVersionString"] as? String ?? "unknown",
                "appBuild": info["CFBundleVersion"] as? String ?? "unknown",
                "sourceRevision": info["BetterJITSourceCommit"] as? String ?? "unrecorded",
                "sourceStateAtProjectGeneration": info["BetterJITSourceState"] as? String ?? "unrecorded",
                "sourceIdentityNote": "Captured at project generation; regenerate after source edits.",
                "thermalAtStart": String(ProcessInfo.processInfo.thermalState.rawValue),
                "thermalStateValues": "0 nominal, 1 fair, 2 serious, 3 critical",
                "lowPowerAtStart": String(ProcessInfo.processInfo.isLowPowerModeEnabled),
                "guestCompiler": CompiledGuest.compiler, "guestCompilerFlags": CompiledGuest.flags,
                "simdCompiler": ExtendedGuest.compiler, "simdCompilerFlags": ExtendedGuest.flags]
    }
}

@MainActor private struct FEXHostView: View {
    @StateObject private var model = FEXHostModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var standalone = false
    @State private var offline = false
    @State private var diagnosticPreset: DiagnosticPreset = .full
    @State private var includeStress = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Runtime diagnostics").font(.headline)
                    Toggle("Launched from Home Screen, without debugger", isOn:$standalone).disabled(model.running)
                    Toggle("Wi-Fi and cellular are off", isOn:$offline).disabled(model.running)
                    Text("These switches only record your stated test conditions; they do not change or independently verify device state.")
                        .font(.caption).foregroundStyle(.secondary)
                    Picker("Preset", selection:$diagnosticPreset) {
                        ForEach(DiagnosticPreset.allCases) { preset in Text(preset.title).tag(preset) }
                    }.disabled(model.running)
                    Toggle("Include stress probes (may terminate WebContent)", isOn:$includeStress).disabled(model.running)
                    Button("Run \(diagnosticPreset.title)") {
                        model.runDiagnostics(diagnosticPreset,includeStress:includeStress,standalone:standalone,offline:offline)
                    }.buttonStyle(.borderedProminent).disabled(model.running)
                    if model.running { Button("Stop current run") { model.stop() }.buttonStyle(.bordered) }
                    Text("Full diagnostics run architecture-level probes in fresh sessions and report unsupported Wine/DXMT pieces explicitly instead of treating them as passes.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let diagnostic = model.diagnosticReport {
                        Text("DIAGNOSTICS: \(diagnostic.overall)").font(.headline).textSelection(.enabled)
                        let passed=diagnostic.records.filter{$0.status == .passed}.count
                        let unsupported=diagnostic.records.filter{$0.status == .unsupported}.count
                        Text("\(passed) passed; \(unsupported) unsupported; \(diagnostic.records.count) total").font(.subheadline)
                        ForEach(diagnostic.records) { record in
                            VStack(alignment:.leading,spacing:4) {
                                Text("\(record.status.rawValue.uppercased()) — \(record.title)").font(.caption.bold())
                                if let error=record.error { Text(error).font(.caption).textSelection(.enabled) }
                                if let reason=record.details["reason"] { Text(reason).font(.caption).foregroundStyle(.secondary) }
                                if let ms=record.durationMilliseconds { Text(String(format:"%.1f ms",ms)).font(.caption.monospacedDigit()) }
                            }
                        }
                        if let url=model.diagnosticReportURL { ShareLink("Share diagnostic JSON",item:url).disabled(model.running) }
                    }

                    Divider()
                    Text("Regression suites").font(.headline)
                    Text("On-device correctness and timing").font(.subheadline)
                    Text("New x86 code is translated by FEX on this device. No recorded Wasm or game files. Timings include the SDK bridge and are not a percentage of normal JIT speed.")
                        .font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        Button("Quick baseline") { model.run(.baseline, standalone: standalone, offline: offline) }.disabled(model.running)
                        Button("Run full suite") { model.run(.full, standalone: standalone, offline: offline) }.disabled(model.running)
                        if model.running { Button("Stop") { model.stop() } }
                    }.buttonStyle(.bordered)
                    Button("Run extended suite (SIMD / regions / long timings)") {
                        model.run(.extended, standalone: standalone, offline: offline)
                    }.buttonStyle(.borderedProminent).disabled(model.running)
                    Button("Run mapped extended suite") {
                        model.run(.extended, standalone: standalone, offline: offline, mappedTransport: true)
                    }.buttonStyle(.borderedProminent).disabled(model.running)
                    Text("Mapped mode requires the OPFS/native-mmap data lane; ordinary Extended remains the copied-control/data baseline.").font(.caption).foregroundStyle(.secondary)
                    Text("Extended timings target 100–500 ms per call with bounded calibration. Leave the app foregrounded; Stop preserves a partial report.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let transport = model.transport { ExecutorView(transport: transport).id(ObjectIdentifier(transport)).frame(height: 96) }
                    if let report = model.report {
                        Text("\(report.mode.rawValue.uppercased()): \(report.overall)").font(.headline).textSelection(.enabled)
                        let passed = report.stages.flatMap(\.cases).filter { $0.status == .passed }.count
                        let total = report.stages.reduce(0) { $0 + $1.cases.count }
                        Text("\(passed) / \(total) checks passed").font(.subheadline)
                        ForEach(report.stages) { stage in
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(stage.status.rawValue.uppercased()) — \(stage.title)").font(.subheadline.bold())
                                if let error = stage.error { Text(error).font(.caption).textSelection(.enabled) }
                                ForEach(stage.cases) { record in
                                    Text("\(record.status.rawValue.uppercased()): \(record.title)").font(.caption)
                                    if let median = record.medianWarmMilliseconds {
                                        Text(String(format: "Warm median: %.3f ms (%d samples)", median, record.warmMilliseconds.count)).font(.caption.monospacedDigit())
                                    }
                                    if let benchmark = record.benchmark, let n = benchmark.selectedIterations {
                                        Text("\(n) iterations; \(benchmark.probes.count) calibration probes; timing window \(benchmark.windowSatisfied ? "complete" : "incomplete")")
                                            .font(.caption.monospacedDigit())
                                    }
                                    if let region = record.region {
                                        Text("Region priming: \(region.checkedPrimingCalls); post-installation checks: \(region.postInstallationCheckedCalls)")
                                            .font(.caption.monospacedDigit())
                                    }
                                    if let note = record.timingNote { Text(note).font(.caption).foregroundStyle(.secondary) }
                                }
                            }.padding(.vertical, 6)
                        }
                    }
                    if let error = model.storageError { Text(error).font(.footnote).textSelection(.enabled) }
                    if let url = model.reportURL { ShareLink("Share JSON report", item: url).disabled(model.running) }
                    Text("Reports stay in this app until you share them. Backgrounding or stopping marks unfinished checks incomplete, not passed.").font(.caption).foregroundStyle(.secondary)
                }.padding()
            }.navigationTitle("BetterJIT FEX Host")
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.stop(interrupted: true) }
        }
        .onDisappear { model.stop(interrupted: true) }
    }
}

private struct ExecutorView: UIViewRepresentable {
    let transport: WebKitTransport
    func makeUIView(context: Context) -> WKWebView { transport.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
