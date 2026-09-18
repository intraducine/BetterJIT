import SwiftUI

@main
@MainActor
struct BetterJITApp: App {
    @StateObject private var model = ProbeModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmProfile = false

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Form {
                    Section("Transport probe only") {
                        Text("This prototype does not enable JIT or establish a VPN. It tests whether the native IKEv2 client can exchange packets with this app over localhost.")
                        LabeledContent("Result", value: model.status)
                    }
                    Section("1. Prepare") {
                        Picker("Loopback address", selection: $model.address) {
                            ForEach(LoopbackAddress.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }.disabled(model.running)
                        Picker("Your test condition", selection: $model.condition) {
                            ForEach(ProbeModel.Condition.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }.disabled(model.running)
                        Button("Install test profile") { confirmProfile = true }.disabled(model.running)
                        Button("Generate profile for export") { model.exportProfile() }.disabled(model.running)
                        if let url = model.profileURL { ShareLink("Export profile", item: url) }
                        Text("Install the profile before starting a run. Changing the address requires reinstalling it. Radio settings are user-reported, not automatically verified.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("2. Observe") {
                        Button("Start 60-second probe") { model.start() }.disabled(model.running)
                        Button("Stop probe") { model.stop() }.disabled(!model.running)
                        Text("After starting, open Settings → General → VPN & Device Management → VPN and connect BetterJIT Probe. Return here to inspect the trace. A VPN connection failure is expected after the cookie test.")
                            .font(.footnote)
                        Text("iOS may suspend the app before the observation window ends. A silent trace does not prove the architecture impossible.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("3. Diagnostics") {
                        if let url = model.reportURL { ShareLink("Export diagnostic report", item: url) }
                        if let error = model.errorMessage { Text(error).textSelection(.enabled) }
                        ForEach(Array(model.events.suffix(80).enumerated()), id: \.offset) { _, event in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(event.time.formatted(date: .omitted, time: .standard))  \(event.event)").font(.caption.monospaced())
                                Text(event.detail).font(.footnote)
                            }.textSelection(.enabled)
                        }
                    }
                }
                .navigationTitle("BetterJIT Probe")
                .alert("Install a removable test VPN profile?", isPresented: $confirmProfile) {
                    Button("Continue") { model.installProfile() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The profile points only to localhost. It is not a working VPN, does not enable JIT, and adds no certificates or device management. Approve it in Settings and remove it after testing.")
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in model.sceneChanged(phase) }
    }
}
