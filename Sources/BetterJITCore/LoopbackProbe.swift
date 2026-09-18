import Foundation
import Dispatch
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum LoopbackAddress: String, CaseIterable, Codable {
    case primary = "127.0.0.1"
    case alternate = "127.0.0.2"
}

public struct ProbeEvent: Codable {
    public let time: Date
    public let event: String
    public let detail: String
    public let port: UInt16?
    public let peerPort: UInt16?
    public init(_ event: String, _ detail: String, port: UInt16? = nil, peerPort: UInt16? = nil) {
        time = Date(); self.event = event; self.detail = detail
        self.port = port; self.peerPort = peerPort
    }
}

public struct PortBinding: Codable {
    public let requestedPort: UInt16
    public let boundPort: UInt16?
    public let errorCode: Int32?
    public let encapsulated: Bool
}

public struct TransportCounters: Codable {
    public fileprivate(set) var nonSelfTestDatagrams = 0
    public fileprivate(set) var filteredDatagrams = 0
    public fileprivate(set) var selfTestDatagrams = 0
    public fileprivate(set) var selfTestsPassed = 0
    public fileprivate(set) var selfTestsFailed = 0
    public fileprivate(set) var cookieRoundTrips = 0
    public fileprivate(set) var repliesSent = 0
    public fileprivate(set) var sendFailures = 0
    public fileprivate(set) var receiveFailures = 0
    public fileprivate(set) var rateLimitedDatagrams = 0
    public init() {}
    var description: String {
        "nonSelfTestDatagrams=\(nonSelfTestDatagrams); filtered=\(filteredDatagrams); selfTestsPassed=\(selfTestsPassed); selfTestsFailed=\(selfTestsFailed); cookieRoundTrips=\(cookieRoundTrips); repliesSent=\(repliesSent); sendFailures=\(sendFailures); receiveFailures=\(receiveFailures)"
    }
}

/// Owns all UDP sources on one serial queue. No address/port reuse is enabled.
/// Call start/stop/snapshot serially and never from an event callback.
public final class LoopbackProbe {
    private let queue = DispatchQueue(label: "BetterJIT.UDP")
    private var sources: [DispatchSourceRead] = []
    private var heartbeat: DispatchSourceTimer?
    private let closed = DispatchGroup()
    private var engine = CookieProbe()
    private var counters = TransportCounters()
    private var selfTests: [UUID: SelfTest] = [:]
    private var target: InterfaceTarget?
    private var validateAssignment = false
    private let onEvent: (ProbeEvent) -> Void
    public init(onEvent: @escaping (ProbeEvent) -> Void) { self.onEvent = onEvent }

    private struct SelfTest {
        let source: DispatchSourceRead
        let address: String
        let family: IPFamily
        let clientPort: UInt16
        let serverPort: UInt16
        let token: Data
    }

    public func snapshot() -> TransportCounters { queue.sync { counters } }

    @discardableResult
    public func start(address: LoopbackAddress, ikePort: UInt16 = 500, natPort: UInt16 = 4500,
                      runSelfTests: Bool = false) -> [PortBinding] {
        let legacy = InterfaceTarget(name: "loopback", index: 0, address: address.rawValue, family: .ipv4, isUp: true)
        return startImpl(target: legacy, validate: false, ikePort: ikePort, natPort: natPort, runSelfTests: runSelfTests)
    }

    /// Binds only a currently assigned, explicitly selected address; no wildcard or port reuse.
    @discardableResult
    public func start(target: InterfaceTarget, ikePort: UInt16 = 500, natPort: UInt16 = 4500,
                      runSelfTests: Bool = true) -> [PortBinding] {
        startImpl(target: target, validate: true, ikePort: ikePort, natPort: natPort, runSelfTests: runSelfTests)
    }

    private func startImpl(target: InterfaceTarget, validate: Bool, ikePort: UInt16, natPort: UInt16,
                           runSelfTests: Bool) -> [PortBinding] {
        stop()
        return queue.sync {
            self.target = target; validateAssignment = validate
            engine = CookieProbe()
            counters = TransportCounters()
            let bindings: [PortBinding] = [(ikePort, false), (natPort, true)].map { requested, encapsulated in
                do {
                    if validate {
                        guard target.isPresent(in: try LocalInterfaces.snapshot()) else {
                            throw SocketFailure(code: EADDRNOTAVAIL)
                        }
                    }
                    let fd = try SocketEndpoint.bind(host: target.address, port: requested, family: target.family)
                    let port: UInt16
                    do { port = try SocketEndpoint.local(fd).port }
                    catch { close(fd); throw error }
                    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
                    source.setEventHandler { [weak self] in self?.read(fd, localPort: port, encapsulated: encapsulated) }
                    trackClose(source, fd: fd)
                    sources.append(source)
                    source.resume()
                    onEvent(ProbeEvent("bound", "Bound exclusively to [\(target.address)]:\(port); selected interface \(target.name)[\(target.index)]. Native interface selection is not controlled.", port: port))
                    return PortBinding(requestedPort: requested, boundPort: port, errorCode: nil, encapsulated: encapsulated)
                } catch {
                    let code = (error as? SocketFailure)?.code ?? -1
                    onEvent(ProbeEvent("bindFailed", "[\(target.address)]:\(requested): errno \(code) (\(String(cString: strerror(code))))", port: requested))
                    return PortBinding(requestedPort: requested, boundPort: nil, errorCode: code, encapsulated: encapsulated)
                }
            }
            if !sources.isEmpty {
                let timer = DispatchSource.makeTimerSource(queue: queue)
                timer.schedule(deadline: .now() + 2, repeating: 2)
                timer.setEventHandler { [weak self] in
                    guard let self else { return }
                    if self.validateAssignment && !target.isPresent(in: (try? LocalInterfaces.snapshot()) ?? []) {
                        self.onEvent(ProbeEvent("targetAddressLost", "Selected address is no longer available; stopped rather than switching addresses"))
                        self.stopOnQueue()
                        return
                    }
                    self.onEvent(ProbeEvent("probeHeartbeat", "UDP queue executing; \(self.counters.description)"))
                }
                heartbeat = timer; timer.resume()
            }
            if runSelfTests {
                for binding in bindings {
                    if let port = binding.boundPort {
                        startSelfTest(target: target, port: port, encapsulated: binding.encapsulated)
                    }
                }
            }
            return bindings
        }
    }

    public func stop() {
        queue.sync { stopOnQueue() }
        closed.wait()
    }
    private func stopOnQueue() {
        let hadSources = !sources.isEmpty
        heartbeat?.cancel(); heartbeat = nil
        for id in Array(selfTests.keys) { finishSelfTest(id, passed: false, detail: "Probe stopped before health check completed") }
        sources.forEach { $0.cancel() }; sources.removeAll()
        engine = CookieProbe()
        if hadSources {
            onEvent(ProbeEvent("transportSummary", counters.description))
            onEvent(ProbeEvent("stopped", "UDP probe stopped"))
        }
    }
    deinit {
        heartbeat?.cancel()
        selfTests.values.forEach { $0.source.cancel() }
        sources.forEach { $0.cancel() }
    }

    private func trackClose(_ source: DispatchSourceRead, fd: Int32) {
        let group = closed
        group.enter()
        source.setCancelHandler { close(fd); group.leave() }
    }

    static func healthPayload(encapsulated: Bool) -> Data {
        // UDP/4500 needs the four-zero Non-ESP Marker, even for this non-IKE self-test.
        (encapsulated ? Data(repeating: 0, count: 4) : Data())
            + Data("BETTERJIT-HEALTH-V1:".utf8) + randomBytes(count: 32)
    }

    /// Non-IKE nonce echo over the actual bound socket. It NEVER enters CookieProbe.
    /// The exact source tuple AND random token must match an active self-test.
    private func startSelfTest(target: InterfaceTarget, port: UInt16, encapsulated: Bool) {
        do {
            let fd = try SocketEndpoint.bind(host: target.address, port: 0, family: target.family)
            let clientPort: UInt16
            let remote: SocketEndpoint
            do { clientPort = try SocketEndpoint.local(fd).port; remote = try SocketEndpoint(host: target.address, port: port, family: target.family) }
            catch { close(fd); throw error }
            let id = UUID()
            let token = Self.healthPayload(encapsulated: encapsulated)
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.readSelfTest(id, fd: fd) }
            trackClose(source, fd: fd)
            selfTests[id] = SelfTest(source: source, address: target.address, family: target.family, clientPort: clientPort, serverPort: port, token: token)
            source.resume()
            onEvent(ProbeEvent("selfTestStarted", "App-generated UDP nonce echo; framing=\(encapsulated ? "nonESPMarker" : "plain"); not native IKE", port: port, peerPort: clientPort))
            if let code = remote.send(token, fd: fd) {
                finishSelfTest(id, passed: false, detail: "Health-check sendto errno \(code)")
            } else {
                queue.asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.finishSelfTest(id, passed: false, detail: "No matching echo within 2 seconds; scheduling delay or transport failure")
                }
            }
        } catch {
            counters.selfTestsFailed += 1
            onEvent(ProbeEvent("selfTestFailed", "Health-check client setup failed: \(error)", port: port))
        }
    }

    private func finishSelfTest(_ id: UUID, passed: Bool, detail: String) {
        guard let test = selfTests.removeValue(forKey: id) else { return }
        test.source.cancel()
        if passed { counters.selfTestsPassed += 1 } else { counters.selfTestsFailed += 1 }
        onEvent(ProbeEvent(passed ? "selfTestPassed" : "selfTestFailed", detail, port: test.serverPort, peerPort: test.clientPort))
    }

    private func readSelfTest(_ id: UUID, fd: Int32) {
        guard let test = selfTests[id] else { return }
        do {
            for _ in 0..<16 {
                guard let (data, peer) = try SocketEndpoint.receive(fd) else { return }
                if let peer, peer.host == test.address, peer.family == test.family,
                   peer.port == test.serverPort, data == test.token {
                    finishSelfTest(id, passed: true, detail: "App-generated nonce echoed through the listener and back; local UDP only, NOT native IKE/VPN/JIT")
                    return
                }
            }
        } catch {
            finishSelfTest(id, passed: false, detail: "Health-check receive failed: \(error.localizedDescription)")
        }
    }

    private func read(_ fd: Int32, localPort: UInt16, encapsulated: Bool) {
        do {
            for _ in 0..<16 {
                guard let (data, peer) = try SocketEndpoint.receive(fd) else { return }
                if let peer, let test = selfTests.values.first(where: {
                    $0.address == peer.host && $0.family == peer.family && $0.clientPort == peer.port
                        && $0.serverPort == localPort && $0.token == data
                }) {
                    counters.selfTestDatagrams += 1
                    onEvent(ProbeEvent("selfTestDatagram", "Received app-generated health check; excluded from IKE and non-self-test counters", port: localPort, peerPort: test.clientPort))
                    if let code = peer.send(data, fd: fd) {
                        onEvent(ProbeEvent("selfTestEchoFailed", "Health-check echo sendto errno \(code)", port: localPort))
                    }
                    continue
                }
                counters.nonSelfTestDatagrams += 1
                // Bound log/CPU amplification as well as the CookieProbe's challenge cache.
                guard counters.nonSelfTestDatagrams <= 128 else {
                    counters.rateLimitedDatagrams += 1
                    if counters.rateLimitedDatagrams == 1 {
                        onEvent(ProbeEvent("packetLimit", "Per-run non-self-test limit reached; further packets counted, not parsed or answered"))
                    }
                    continue
                }
                onEvent(ProbeEvent("datagramReceived", "\(data.count) bytes from \(peer?.host ?? "invalid sockaddr"):\(peer?.port.description ?? "unknown"); source identity not authenticated", port: localPort, peerPort: peer?.port))
                guard let peer, let target, target.accepts(source: peer.host, family: peer.family) else {
                    counters.filteredDatagrams += 1
                    onEvent(ProbeEvent("datagramFiltered", "Source is neither the selected local address nor allowed loopback; metadata logged, no reply", port: localPort, peerPort: peer?.port))
                    continue
                }
                if validateAssignment && !target.isPresent(in: (try? LocalInterfaces.snapshot()) ?? []) {
                    onEvent(ProbeEvent("targetAddressLost", "Address changed before reply; probe stopped"))
                    stopOnQueue(); return
                }
                let key = "\(peer.family.rawValue):\(peer.host):\(peer.port):\(localPort)"
                let result = engine.receive(data, peer: key, encapsulated: encapsulated)
                if result.event == "cookieRoundTrip" { counters.cookieRoundTrips += 1 }
                onEvent(ProbeEvent(result.event, result.detail, port: localPort, peerPort: peer.port))
                if let reply = result.reply {
                    if let code = peer.send(reply, fd: fd) {
                        counters.sendFailures += 1
                        onEvent(ProbeEvent("sendFailed", "sendto errno \(code)", port: localPort, peerPort: peer.port))
                    } else {
                        counters.repliesSent += 1
                        onEvent(ProbeEvent("replySent", "\(reply.count) response bytes accepted by sendto; receipt not proven", port: localPort, peerPort: peer.port))
                    }
                }
            }
        } catch {
            counters.receiveFailures += 1
            onEvent(ProbeEvent("receiveFailed", "recvfrom: \(error.localizedDescription)", port: localPort))
        }
    }
}
