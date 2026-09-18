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
    @Published var address = LoopbackAddress.primary {
        didSet { profileURL = nil; profileServer.stop(); profileServing = false }
    }
    @Published var condition = Condition.unspecified
    @Published private(set) var running = false
    @Published private(set) var status = "Not tested"
    @Published private(set) var events: [ProbeEvent] = []
    @Published private(set) var reportURL: URL?
    @Published private(set) var profileURL: URL?
    @Published private(set) var errorMessage: String?
    private var droppedEvents = 0
    private var pathDescription = "Not yet sampled; not a radio-state measurement"
    private let monitor = NWPathMonitor()
    private let profileServer = ProfileServer()
    private var profileServing = false
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    private var timer: Timer?
    private var deadline: Date?
    private var runCondition = Condition.unspecified
    private var runAddress = LoopbackAddress.primary
    private lazy var probe = LoopbackProbe { [weak self] event in
        Task { @MainActor in self?.record(event) }
    }

    init() {
        newReport()
        monitor.pathUpdateHandler = { [weak self] path in
            let description = "path=\(path.status); usesWiFi=\(path.usesInterfaceType(.wifi)); usesCellular=\(path.usesInterfaceType(.cellular)); not radio-switch verification"
            Task { @MainActor in
                guard let self else { return }
                self.pathDescription = description
                self.record(ProbeEvent("pathObservation", description))
            }
        }
        monitor.start(queue: DispatchQueue(label: "BetterJIT.Path"))
    }

    func start() {
        guard !running else { return }
        errorMessage = nil
        newReport()
        status = "Waiting for IKE_SA_INIT"
        let bindings = probe.start(address: address)
        running = bindings.contains { $0.boundPort != nil }
        if bindings.first?.boundPort == nil { status = "UDP/500 bind failed; native test blocked" }
        if !running { status = "Both UDP binds failed"; return }
        deadline = Date().addingTimeInterval(60)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.record(ProbeEvent("deadline", "60-second observation window ended")); self?.stop() }
        }
        record(ProbeEvent("runStarted", "User-labeled condition: \(runCondition.rawValue). Native-client origin and radio state are not independently authenticated."))
        record(ProbeEvent("pathAtStart", pathDescription))
    }

    func stop() {
        timer?.invalidate(); timer = nil; deadline = nil
        probe.stop(); running = false
        profileServer.stop(); profileServing = false
        endBackgroundTime()
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
                        self.record(ProbeEvent("profileOffered", "Removable localhost IKEv2 profile offered to Safari; Settings approval still required"))
                    case .failure(let error): self.errorMessage = error.localizedDescription
                    }
                }
            }
        } catch { errorMessage = error.localizedDescription }
    }

    func exportProfile() { do { _ = try prepareProfile() } catch { errorMessage = error.localizedDescription } }

    private func prepareProfile() throws -> Data {
        let data = try ProbeProfile.make(address: address)
        let directory = try documents().appendingPathComponent("Profiles", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("BetterJIT-\(address.rawValue).mobileconfig")
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        profileURL = url
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
            if let deadline, Date() >= deadline { stop() }
        default: break
        }
    }

    private func requestBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "BetterJIT probe") { [weak self] in
            Task { @MainActor in
                self?.record(ProbeEvent("backgroundExpired", "iOS ended the background allowance; an empty trace is inconclusive"))
                self?.stop()
            }
        }
        record(ProbeEvent("backgroundAllowance", backgroundTask == .invalid ? "Background execution request denied" : "Finite background execution requested; no guaranteed duration"))
    }

    private func endBackgroundTime() {
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }

    private func newReport() {
        runAddress = address; runCondition = condition
        events.removeAll(); droppedEvents = 0
        do {
            let directory = try documents().appendingPathComponent("Reports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            reportURL = directory.appendingPathComponent("probe-\(UUID().uuidString).json")
            saveReport()
        } catch { errorMessage = error.localizedDescription }
    }

    private func documents() throws -> URL {
        try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    }

    private func record(_ event: ProbeEvent) {
        if event.event == "cookieRoundTrip" { status = "COOKIE round trip observed — no VPN/JIT" }
        events.append(event)
        if events.count > 512 { events.removeFirst(); droppedEvents += 1 }
        saveReport()
    }

    private struct Report: Encodable {
        let schemaVersion = 1
        let scope = "IKEv2 COOKIE transport probe only; no tunnel, authentication, packet reflection, or JIT"
        let os: String
        let device: String
        let appVersion: String
        let address: String
        let userLabeledCondition: String
        let radioStateIndependentlyVerified = false
        let nativeClientIdentityAuthenticated = false
        let pathObservation: String
        let droppedEvents: Int
        let events: [ProbeEvent]
    }

    private func saveReport() {
        guard let reportURL else { return }
        do {
            let report = Report(os: ProcessInfo.processInfo.operatingSystemVersionString,
                                device: UIDevice.current.model,
                                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                                address: runAddress.rawValue, userLabeledCondition: runCondition.rawValue,
                                pathObservation: pathDescription, droppedEvents: droppedEvents, events: events)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(report).write(to: reportURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { errorMessage = "Could not save diagnostics: \(error.localizedDescription)" }
    }
}
