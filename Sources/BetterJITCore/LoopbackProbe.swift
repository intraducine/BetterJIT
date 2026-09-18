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

/// Owns both UDP sockets on one serial queue. A failed bind never enables port reuse.
/// Event callbacks run on that queue; callers must dispatch UI updates themselves.
public final class LoopbackProbe {
    private let queue = DispatchQueue(label: "BetterJIT.UDP")
    private var sources: [DispatchSourceRead] = []
    private let closed = DispatchGroup()
    private var engine = CookieProbe()
    private let onEvent: (ProbeEvent) -> Void
    public init(onEvent: @escaping (ProbeEvent) -> Void) { self.onEvent = onEvent }

    @discardableResult
    public func start(address: LoopbackAddress, ikePort: UInt16 = 500, natPort: UInt16 = 4500) -> [PortBinding] {
        stop()
        return queue.sync {
            engine = CookieProbe()
            return [(ikePort, false), (natPort, true)].map { requested, encapsulated in
                do {
                    let fd = try Self.bind(address: address.rawValue, port: requested)
                    var local = sockaddr_in()
                    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
                    let status = withUnsafeMutablePointer(to: &local) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
                    }
                    guard status == 0 else { let code = errno; close(fd); throw SocketFailure(code: code) }
                    let port = UInt16(bigEndian: local.sin_port)
                    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
                    source.setEventHandler { [weak self] in self?.read(fd, localPort: port, encapsulated: encapsulated) }
                    let closed = self.closed
                    closed.enter()
                    source.setCancelHandler { close(fd); closed.leave() }
                    sources.append(source)
                    source.resume()
                    onEvent(ProbeEvent("bound", "Bound exclusively to \(address.rawValue):\(port)", port: port))
                    return PortBinding(requestedPort: requested, boundPort: port, errorCode: nil, encapsulated: encapsulated)
                } catch {
                    let code = (error as? SocketFailure)?.code ?? -1
                    onEvent(ProbeEvent("bindFailed", "\(address.rawValue):\(requested): errno \(code) (\(String(cString: strerror(code))))", port: requested))
                    return PortBinding(requestedPort: requested, boundPort: nil, errorCode: code, encapsulated: encapsulated)
                }
            }
        }
    }

    /// Call start/stop serially, and never from the event callback.
    public func stop() {
        queue.sync { stopOnQueue() }
        closed.wait() // Cancellation must close old descriptors before a restart binds.
    }
    deinit { sources.forEach { $0.cancel() } }

    private func stopOnQueue() {
        let hadSources = !sources.isEmpty
        sources.forEach { $0.cancel() }
        sources.removeAll()
        engine = CookieProbe()
        if hadSources { onEvent(ProbeEvent("stopped", "UDP probe stopped")) }
    }

    private static func bind(address: String, port: UInt16) throws -> Int32 {
        #if canImport(Darwin)
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        #else
        let fd = socket(AF_INET, Int32(SOCK_DGRAM.rawValue), Int32(IPPROTO_UDP))
        #endif
        guard fd >= 0 else { throw SocketFailure(code: errno) }
        var success = false
        defer { if !success { close(fd) } }
        let flags = fcntl(fd, F_GETFL, 0)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw SocketFailure(code: errno) }
        var local = sockaddr_in()
        #if canImport(Darwin)
        local.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        local.sin_family = sa_family_t(AF_INET)
        local.sin_port = port.bigEndian
        guard inet_pton(AF_INET, address, &local.sin_addr) == 1 else { throw SocketFailure(code: EINVAL) }
        let result = withUnsafePointer(to: &local) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                #if canImport(Darwin)
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #else
                Glibc.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                #endif
            }
        }
        guard result == 0 else { throw SocketFailure(code: errno) }
        success = true
        return fd
    }

    private func read(_ fd: Int32, localPort: UInt16, encapsulated: Bool) {
        // Yield periodically even if a loopback client sends continuously.
        for _ in 0..<16 {
            var bytes = [UInt8](repeating: 0, count: 65535)
            var remote = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let count = withUnsafeMutablePointer(to: &remote) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                    bytes.withUnsafeMutableBytes { recvfrom(fd, $0.baseAddress, $0.count, 0, address, &length) }
                }
            }
            if count < 0 {
                let code = errno
                if code == EINTR { continue }
                if code != EAGAIN && code != EWOULDBLOCK {
                    onEvent(ProbeEvent("receiveFailed", "recvfrom errno \(code)", port: localPort))
                }
                return
            }
            guard length == MemoryLayout<sockaddr_in>.size, remote.sin_family == AF_INET,
                  UInt32(bigEndian: remote.sin_addr.s_addr) >> 24 == 127 else { continue }
            let peerPort = UInt16(bigEndian: remote.sin_port)
            let peer = "\(remote.sin_addr.s_addr):\(peerPort):\(localPort)"
            let result = engine.receive(Data(bytes.prefix(count)), peer: peer, encapsulated: encapsulated)
            onEvent(ProbeEvent(result.event, result.detail, port: localPort, peerPort: peerPort))
            if let reply = result.reply {
                let sent = withUnsafePointer(to: &remote) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                        reply.withUnsafeBytes { sendto(fd, $0.baseAddress, $0.count, 0, address, length) }
                    }
                }
                if sent != reply.count {
                    onEvent(ProbeEvent("sendFailed", "sendto errno \(errno)", port: localPort, peerPort: peerPort))
                }
            }
        }
    }
}

private struct SocketFailure: Error { let code: Int32 }
