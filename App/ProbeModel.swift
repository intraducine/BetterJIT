import Foundation
import Network
import SwiftUI
import UIKit

@MainActor
final class ProbeModel: ObservableObject {
    enum Condition: String, CaseIterable {
        case unspecified = "Not specified"
        case wifi = "Wi-Fi connected (control)"
        case cellular = "Wi-Fi off; cellular on"
        case offline = "Wi-Fi off; cellular off"
    }
    enum VPNObservation: String, CaseIterable {
        case unrecorded = "Not recorded"
        case notAttempted = "Did not turn VPN on"
        case disconnected = "Connecting, then disconnected"
        case connecting = "Still connecting"
        case connected = "Showed Connected"
    }
    @Published var targetID = "" {
        didSet {
            if targetID != oldValue {
                profileURL = nil; profileTargetID = nil; profileConfirmed = false
                profileServer.stop(); profileServing = false
            }
        }
    }
    @Published private(set) var interfaces: [InterfaceTarget] = []
    @Published var profileConfirmed = false
    @Published private(set) var pathDescription = "Not sampled; not radio-switch verification"
    private var profileTargetID: String?
    var targets: [InterfaceTarget] { interfaces.filter { $0.exclusion == nil } }
    var selectedTarget: InterfaceTarget? { targets.first { $0.id == targetID } }
    var canStart: Bool { selectedTarget != nil && profileConfirmed && profileTargetID == targetID && !running }
    var versionLabel: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        return "\(version) (\(build)) / interfaces-v3"
    }
    @Published var condition = Condition.unspecified
    @Published var vpnObservation = VPNObservation.unrecorded {
        didSet {
            if startedAt != nil { record(ProbeEvent("userVPNObservation", "User-reported Settings status: \(vpnObservation.rawValue); not read from system VPN APIs")) }
        }
    }
    @Published private(set) var running = false
    @Published private(set) var status = "Not tested"
    @Published private(set) var selfTestStatus = "Not run"
    @Published private(set) var events: [ProbeEvent] = []
    @Published private(set) var reportURL: URL?
    @Published private(set) var profileURL: URL?
    @Published private(set) var errorMessage: String?
    private var droppedEvents = 0
    private let monitor = NWPathMonitor()
    private let profileServer = ProfileServer()
    private var profileServing = false
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    private var timer: Timer?
    private var deadline: Date?
    private var startedAt: Date?
    private var endedAt: Date?
    private var stopReason: String?
    private var runID = UUID()
    private var bindings: [PortBinding] = []
    private var runCondition = Condition.unspecified
    private var runTarget: InterfaceTarget?
    private var interfacesAtStart: [InterfaceTarget] = []
    private var runPath = "Not sampled"
    private var runProfileConfirmed = false
    private var probe: LoopbackProbe?

    init() {
        refreshInterfaces()
        newReport()
        monitor.pathUpdateHandler = { [weak self] path in
            let used = path.availableInterfaces.filter { path.usesInterfaceType($0.type) }
                .map { "\($0.name)[\($0.index)]:\($0.type)" }.joined(separator: ", ")
            let description = "path=\(path.status); usesWiFi=\(path.usesInterfaceType(.wifi)); usesCellular=\(path.usesInterfaceType(.cellular)); interface candidates=\(used); not a native VPN route or radio-switch measurement"
            Task { @MainActor in
                guard let self else { return }
                self.pathDescription = description
                self.refreshInterfaces()
                self.record(ProbeEvent("pathObservation", description))
            }
        }
        monitor.start(queue: DispatchQueue(label: "BetterJIT.Path"))
    }

    func refreshInterfaces() {
        do { interfaces = try LocalInterfaces.snapshot() }
        catch { interfaces = []; errorMessage = error.localizedDescription }
    }

    func start() {
        guard !running else { return }
        refreshInterfaces()
        guard canStart, let selectedTarget else {
            errorMessage = "Choose a current device address, install its matching profile, and confirm installation."
            return
        }
        probe?.stop(); probe = nil
        errorMessage = nil
        newReport()
        startedAt = Date()
        status = "Waiting for IKE_SA_INIT"
        selfTestStatus = "Checking local UDP"
        let id = runID
        let probe = LoopbackProbe { [weak self] event in
            Task { @MainActor in
                guard let self, self.runID == id else { return }
                self.record(event)
                if event.event == "targetAddressLost" { self.stop(reason: "targetAddressLost") }
            }
        }
        self.probe = probe
        record(ProbeEvent("runStarted", "User-labeled condition: \(runCondition.rawValue). Native-client origin and radio state are not independently authenticated."))
        record(ProbeEvent("pathAtStart", pathDescription))
        record(ProbeEvent("selectedTarget", "\(selectedTarget.label); native interface selection is NOT overridden; allowed peers are the selected address or loopback only"))
        record(ProbeEvent("profileAssumption", "User confirmed installation of \(selectedTarget.vpnName); installation is not read from system APIs"))
        bindings = probe.start(target: selectedTarget, runSelfTests: true)
        running = bindings.contains { $0.boundPort != nil }
        if bindings.first?.boundPort == nil { status = "UDP/500 bind failed; native test blocked" }
        if !running { stop(reason: "bindFailed"); return }
        deadline = Date().addingTimeInterval(60)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.runID == id else { return }
                self.record(ProbeEvent("deadline", "60-second observation window ended"))
                self.stop(reason: "deadline")
            }
        }
        saveReport()
    }

    func stop(reason: String = "userStopped") {
        timer?.invalidate(); timer = nil; deadline = nil
        probe?.stop(); running = false
        if startedAt != nil && endedAt == nil { endedAt = Date(); stopReason = reason }
        profileServer.stop(); profileServing = false
        endBackgroundTime()
        updateStatus()
        saveReport()
    }

    func installProfile() {
        do {
            let data = try prepareProfile()
            profileServing = true
            requestBackgroundTime()
            profileServer.start(profile: data) { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    switch result {
                    case .success(let url):
                        UIApplication.shared.open(url) { opened in
                            Task { @MainActor in
                                if !opened { self.errorMessage = "Safari could not open the local download. Export the profile instead." }
                            }
                        }
                        self.record(ProbeEvent("profileOffered", "Matching device-address IKEv2 profile offered to Safari; Settings approval still required"))
                    case .failure(let error): self.errorMessage = error.localizedDescription
                    }
                }
            }
        } catch { errorMessage = error.localizedDescription }
    }

    func exportProfile() { do { _ = try prepareProfile() } catch { errorMessage = error.localizedDescription } }

    private func prepareProfile() throws -> Data {
        refreshInterfaces()
        guard let target = selectedTarget else { throw NSError(domain: "BetterJIT", code: 1, userInfo: [NSLocalizedDescriptionKey: "Select an available interface address first."]) }
        let data = try ProbeProfile.make(target: target)
        let directory = try documents().appendingPathComponent("Profiles", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("BetterJIT-Interface.mobileconfig")
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        profileURL = url; profileTargetID = target.id; profileConfirmed = false
        return data
    }

    func sceneChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            record(ProbeEvent("sceneBackground", "Entering background; execution time is system-limited"))
            if running || profileServing { requestBackgroundTime() }
        case .active:
            endBackgroundTime()
            record(ProbeEvent("sceneActive", "Foreground resumed"))
            if let deadline, Date() >= deadline { stop(reason: "deadlineAfterResume") }
        default: break
        }
    }

    private func requestBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "BetterJIT probe") { [weak self] in
            Task { @MainActor in
                self?.record(ProbeEvent("backgroundExpired", "iOS ended the background allowance; an empty trace is inconclusive"))
                self?.stop(reason: "backgroundExpired")
            }
        }
        record(ProbeEvent("backgroundAllowance", backgroundTask == .invalid ? "Background execution request denied" : "Finite background execution requested; no guaranteed duration"))
    }

    private func endBackgroundTime() {
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }

    private func newReport() {
        runID = UUID(); runTarget = selectedTarget; runCondition = condition
        interfacesAtStart = interfaces; runPath = pathDescription
        runProfileConfirmed = profileConfirmed && profileTargetID == targetID
        startedAt = nil; endedAt = nil; stopReason = nil; bindings = []
        vpnObservation = .unrecorded
        events.removeAll(); droppedEvents = 0
        do {
            let directory = try documents().appendingPathComponent("Reports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            reportURL = directory.appendingPathComponent("probe-\(runID.uuidString).json")
            saveReport()
        } catch { errorMessage = error.localizedDescription }
    }

    private func documents() throws -> URL {
        try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    }

    private func updateStatus() {
        guard startedAt != nil else { return }
        let count = probe?.snapshot() ?? TransportCounters()
        let expected = bindings.filter { $0.boundPort != nil }.count
        if count.selfTestsPassed + count.selfTestsFailed > 0 {
            selfTestStatus = "\(count.selfTestsPassed)/\(expected) passed; \(count.selfTestsFailed) failed — local UDP only"
        }
        if count.cookieRoundTrips > 0 {
            status = "COOKIE round trip observed — no VPN/JIT"
        } else if bindings.first?.boundPort == nil {
            status = "UDP/500 bind failed; native test blocked"
        } else if count.nonSelfTestDatagrams > 0 {
            status = "\(count.nonSelfTestDatagrams) non-self-test packets; \(count.filteredDatagrams) filtered; no COOKIE round trip"
        } else if running {
            status = "Waiting for native IKE; no non-self-test packets"
        } else {
            status = "No non-self-test packets observed; native startup unresolved"
        }
    }

    private func record(_ event: ProbeEvent) {
        events.append(event)
        if events.count > 512 { events.removeFirst(); droppedEvents += 1 }
        updateStatus()
        saveReport()
    }

    private struct Report: Encodable {
        let schemaVersion = 3
        let experimentRevision = "interfaces-v3"
        let udp4500SelfTestFraming = "four-zero Non-ESP Marker"
        let nativeInterfaceSelectionControlled = false
        let hostProcess = ProcessInfo.processInfo.processName
        let hostBundleIdentifier = Bundle.main.bundleIdentifier ?? "unknown"
        let scope = "IKEv2 COOKIE transport probe only; no tunnel, authentication, packet reflection, or JIT"
        let generatedAt = Date()
        let os: String
        let device: String
        let appVersion: String
        let appBuild: String
        let runID: UUID
        let runState: String
        let startedAt: Date?
        let endedAt: Date?
        let stopReason: String?
        let address: String
        let selectedTarget: InterfaceTarget?
        let interfacesAtStart: [InterfaceTarget]
        let pathAtStart: String
        let profileInstallationConfirmedByUser: Bool
        let userLabeledCondition: String
        let userReportedVPNObservation: String
        let radioStateIndependentlyVerified = false
        let nativeClientIdentityAuthenticated = false
        let pathObservation: String
        let bindings: [PortBinding]
        let transportCounters: TransportCounters
        let droppedEvents: Int
        let events: [ProbeEvent]
    }

    private func saveReport() {
        guard let reportURL else { return }
        do {
            let report = Report(os: ProcessInfo.processInfo.operatingSystemVersionString,
                                device: UIDevice.current.model,
                                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                                appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                                runID: runID, runState: running ? "running" : (endedAt == nil ? "notStarted" : "ended"),
                                startedAt: startedAt, endedAt: endedAt, stopReason: stopReason,
                                address: runTarget?.address ?? "not-selected", selectedTarget: runTarget,
                                interfacesAtStart: interfacesAtStart, pathAtStart: runPath,
                                profileInstallationConfirmedByUser: runProfileConfirmed,
                                userLabeledCondition: runCondition.rawValue,
                                userReportedVPNObservation: vpnObservation.rawValue,
                                pathObservation: pathDescription, bindings: bindings,
                                transportCounters: probe?.snapshot() ?? TransportCounters(),
                                droppedEvents: droppedEvents, events: events)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(report).write(to: reportURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { errorMessage = "Could not save diagnostics: \(error.localizedDescription)" }
    }
}
