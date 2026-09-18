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
                    Section("Interface-address experiment") {
                        Text("Tests whether using a device-interface address avoids the native client's localhost send failure. No working VPN or JIT is implemented.")
                        LabeledContent("Version", value: model.versionLabel)
                        LabeledContent("Local socket checks", value: model.selfTestStatus)
                        LabeledContent("IKE result", value: model.status)
                    }
                    Section("1. Choose a device address") {
                        Button("Refresh addresses") { model.refreshInterfaces() }.disabled(model.running)
                        Picker("Responder address", selection: $model.targetID) {
                            Text("Select an address").tag("")
                            ForEach(model.targets) { Text($0.label).tag($0.id) }
                            if !model.targetID.isEmpty && model.selectedTarget == nil {
                                Text("Selected address is unavailable").tag(model.targetID)
                            }
                        }.disabled(model.running)
                        if let target = model.selectedTarget {
                            Text(target.categoryHint).font(.footnote)
                            Text("VPN entry: \(target.vpnName)").font(.footnote).textSelection(.enabled)
                        }
                        Text(model.pathDescription).font(.caption.monospaced()).textSelection(.enabled)
                        Picker("Your test condition", selection: $model.condition) {
                            ForEach(ProbeModel.Condition.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }.disabled(model.running)
                        DisclosureGroup("Excluded addresses") {
                            ForEach(model.interfaces.filter { $0.exclusion != nil }) { target in
                                Text("\(target.label): \(target.exclusion ?? "")").font(.caption)
                            }
                        }
                        Text("Start with en0 / IPv4 on Wi-Fi. For cellular, disable Wi-Fi first, refresh, and select an assigned pdp_ip address matching the path observation. IPv6 unicast is supported; link-local zones are not. No suitable address means this variant cannot run in that state.")
                            .font(.footnote)
                    }
                    Section("2. Install the matching profile") {
                        Button("Install matching profile") { confirmProfile = true }
                            .disabled(model.running || model.selectedTarget == nil)
                        Button("Generate profile for export") { model.exportProfile() }
                            .disabled(model.running || model.selectedTarget == nil)
                        if let url = model.profileURL { ShareLink("Export profile", item: url) }
                        Toggle("I installed the profile for this address", isOn: $model.profileConfirmed)
                            .disabled(model.running || model.profileURL == nil)
                        Text("Use the new BetterJIT Interface VPN entry, not the old 127.0.0.1 profile. Regenerate and reinstall whenever the selected IP address changes. This app does not verify profile installation or control the native VPN's interface.")
                            .font(.footnote)
                    }
                    Section("3. Run the probe") {
                        Button("Start 60-second probe") { model.start() }.disabled(!model.canStart)
                        Button("Stop probe and finalize report") { model.stop() }.disabled(!model.running)
                        Text("Check the two local socket results, then open Settings → General → VPN & Device Management → VPN and connect the matching BetterJIT Interface entry. Return immediately after the attempt. Background time is limited; the VPN intentionally cannot stay connected.")
                            .font(.footnote)
                        Text("Only cookieRoundTrip establishes the COOKIE milestone. Local self-tests, a VPN icon, or disappearance of error 49 do not prove a tunnel or JIT.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("4. Record and export") {
                        Picker("What Settings showed", selection: $model.vpnObservation) {
                            ForEach(ProbeModel.VPNObservation.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                        Text(model.running ? "Report is still running. Stop before exporting." : "Export after the attempt and stopping the probe.").font(.footnote)
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
                .navigationTitle("BetterJIT Interface Probe")
                .alert("Install a removable test VPN profile?", isPresented: $confirmProfile) {
                    Button("Continue") { model.installProfile() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The server address is the selected address of this device. The probe binds only that address and rejects other source addresses except loopback. This is not authenticated peer identity. No certificates or management enrollment are installed. Approve in Settings and remove after testing.")
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in model.sceneChanged(phase) }
    }
}
