// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI
import WebKit
import UniformTypeIdentifiers
import BetterJITWebKit
import BetterJITLinux

@main struct FEXHostApp: App {
    var body: some Scene { WindowGroup { DeviceSessionView() } }
}
@MainActor private struct DeviceSessionView: View {
    @StateObject private var model=DeviceSessionModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var standalone=false
    @State private var offline=false
    @State private var stress=false
    @State private var chooseRoot=false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:16) {
                    Text("One build. One device session.").font(.title2.bold())
                    Text("Run Linux and Wine first, then the complete FEX, mapped transport, memory, threading and graphics checks. Results stay here until you share them.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    HStack {
                        Button("Run All") { run(resume:false) }
                            .buttonStyle(.borderedProminent).disabled(model.running || model.importing)
                        if model.running {
                            Button("Stop") { model.stop() }.buttonStyle(.bordered)
                        } else if model.report?.canResume == true {
                            Button("Resume unfinished") { run(resume:true) }.buttonStyle(.bordered).disabled(model.importing)
                        }
                    }
                    if model.report?.canResume == true && !model.running {
                        Text("Resume creates a new report, keeps completed phases, and retries unfinished phases from their start. The earlier report is preserved.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let report=model.report {
                        ProgressView(value:Double(report.completedCount),total:Double(report.phases.count))
                        Text("\(report.completedCount)/\(report.phases.count) phases · \(report.overall)").font(.headline)
                    }
                    Text(model.liveStatus).font(.subheadline.bold()).accessibilityIdentifier("session-progress")
                    if let session=model.linuxSession {
                        LinuxExecutorView(session:session).id(ObjectIdentifier(session)).frame(height:200)
                    }
                    if let transport=model.transport {
                        ExecutorView(transport:transport).id(ObjectIdentifier(transport)).frame(height:64)
                    }
                    if let report=model.report {
                        ForEach(report.phases) { phase in
                            PhaseRow(phase:phase,suite:report.suites[phase.id],
                                     diagnostics:phase.id == "diagnostics" ? report.diagnostics : nil)
                        }
                    }
                    if let error=model.storageError { Text(error).foregroundStyle(.red).font(.footnote).textSelection(.enabled) }
                    if let url=model.reportURL {
                        ShareLink("Share session report",item:url).buttonStyle(.borderedProminent)
                            .disabled(model.running || model.importing)
                    }
                    DisclosureGroup("Wine root and session options") {
                        VStack(alignment:.leading,spacing:12) {
                            Text(model.wineAvailable ? "Wine root found" : "Wine root missing: Wine will be UNSUPPORTED")
                                .font(.subheadline.bold())
                            Button("Choose staged Wine root folder") { chooseRoot=true }
                                .disabled(model.running || model.importing)
                            if model.importing { Button("Cancel import") { model.cancelImport() } }
                            Text("Select linuxroot with opt/wine/bin/wine, .symlinks.json and .modes.json, or copy it to this app’s Documents/linuxroot in Files/Finder. No rebuild is needed. Use your redistributable Wine build and dependencies.")
                                .font(.caption).foregroundStyle(.secondary)
                            Toggle("Home Screen launch, no debugger",isOn:$standalone)
                            Toggle("Wi-Fi and cellular are off",isOn:$offline)
                            Toggle("Include memory stress probes",isOn:$stress)
                            Text("Conditions are self-reported. Stress probes may terminate WebContent. Keep this app foregrounded; backgrounding saves an interrupted session.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.disabled(model.running).padding(.top,8)
                    }
                    Text("Linux and Wine use real guest execution. Metal checks an offscreen rendered image. DXMT/game rendering remains unsupported. Timings include bridge work and do not measure game speed.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding()
            }.navigationTitle("BetterJIT Device Session")
        }
        .fileImporter(isPresented:$chooseRoot,allowedContentTypes:[.folder]) { result in
            switch result {
            case .success(let url): model.importRoot(url)
            case .failure(let error): model.storageError=error.localizedDescription
            }
        }
        .onChange(of:scenePhase) { _,phase in if phase == .background { model.stop(interrupted:true) } }
    }
    private func run(resume:Bool) { model.runAll(standalone:standalone,offline:offline,stress:stress,resume:resume) }
}
private struct PhaseRow: View {
    let phase:SessionPhase
    let suite:SuiteReport?
    let diagnostics:DiagnosticReport?
    @State private var expanded=false
    var body: some View {
        DisclosureGroup(isExpanded:$expanded) {
            VStack(alignment:.leading,spacing:8) {
                if let error=phase.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if let reason=phase.details["reason"] { Text(reason).textSelection(.enabled) }
                ForEach(phase.details.keys.sorted().filter{$0 != "reason"},id:\.self) { key in
                    Text("\(key): \(phase.details[key] ?? "")").font(.caption.monospaced())
                }
                if let suite {
                    ForEach(suite.stages) { stage in
                        Text("\(stage.status.rawValue.uppercased()) · \(stage.title)").font(.subheadline.bold())
                        if let error=stage.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                        ForEach(stage.cases) { check in
                            Text("\(check.status.rawValue.uppercased()) · \(check.title)")
                            if let error=check.error { Text(error).foregroundStyle(.red) }
                            if let median=check.medianWarmMilliseconds {
                                Text(String(format:"Checked warm median %.2f ms",median)).font(.caption.monospacedDigit())
                            }
                            if let note=check.timingNote { Text(note).foregroundStyle(.secondary) }
                        }
                    }
                }
                if let diagnostics {
                    ForEach(diagnostics.records) { check in
                        Text("\(check.status.rawValue.uppercased()) · \(check.title)").font(.subheadline.bold())
                        if let error=check.error { Text(error).foregroundStyle(.red) }
                        if let reason=check.details["reason"] { Text(reason).foregroundStyle(.secondary) }
                    }
                }
                if !phase.log.isEmpty {
                    Text(phase.log.suffix(16000)).font(.caption.monospaced()).textSelection(.enabled)
                }
                if let ms=phase.milliseconds { Text(String(format:"Phase %.1f s",ms/1000)).font(.caption.monospacedDigit()) }
            }.font(.caption).padding(.top,8)
        } label: {
            VStack(alignment:.leading,spacing:3) {
                Text(phase.title).font(.subheadline.bold())
                Text(phase.status.rawValue.uppercased()).font(.caption.monospacedDigit()).foregroundStyle(color)
                if phase.status == .running, !phase.log.isEmpty {
                    Text(phase.log.suffix(500)).font(.caption.monospaced()).lineLimit(5)
                }
            }
        }.padding(12).background(Color.secondary.opacity(0.08),in:RoundedRectangle(cornerRadius:12))
    }
    private var color:Color {
        switch phase.status {
        case .passed: return .green
        case .failed: return .red
        case .unsupported,.skipped: return .orange
        case .pending,.running: return .secondary
        }
    }
}
private struct ExecutorView:UIViewRepresentable {
    let transport:WebKitTransport
    func makeUIView(context:Context)->WKWebView { transport.webView }
    func updateUIView(_ view:WKWebView,context:Context) {}
}
private struct LinuxExecutorView:UIViewRepresentable {
    let session:LinuxRuntimeSession
    func makeUIView(context:Context)->WKWebView { session.webView }
    func updateUIView(_ view:WKWebView,context:Context) {}
}
