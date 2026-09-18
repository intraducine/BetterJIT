import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum IPFamily: String, Codable { case ipv4, ipv6 }

/// An observed local address, not a claim about the native VPN's chosen interface.
public struct InterfaceTarget: Codable, Hashable, Identifiable {
    public let name: String
    public let index: UInt32
    public let address: String
    public let family: IPFamily
    public let isUp: Bool
    public var id: String { "\(name)|\(index)|\(family.rawValue)|\(address)" }
    public var isLoopback: Bool { family == .ipv4 ? address.hasPrefix("127.") : address == "::1" }
    public var label: String { "\(name) · \(address) (\(family.rawValue))" }
    public var vpnName: String { "BetterJIT Interface (\(name) \(address))" }
    public var categoryHint: String {
        if isLoopback { return "Loopback control" }
        if name.hasPrefix("pdp_ip") { return "Cellular candidate; verify active data interface" }
        if name == "en0" { return "Wi-Fi candidate on iOS; verify path observation" }
        return "Other local interface; verify path observation"
    }
    public var exclusion: String? {
        if !isUp || index == 0 { return "Interface is down or has no index" }
        if ["utun", "ipsec", "awdl", "llw", "ap", "nan"].contains(where: { name.hasPrefix($0) }) {
            return "Tunnel or auxiliary interface; excluded from this experiment"
        }
        if family == .ipv6 {
            if address.hasPrefix("fe8") || address.hasPrefix("fe9") || address.hasPrefix("fea") || address.hasPrefix("feb") {
                return "IPv6 link-local requires a zone; not supported in this revision"
            }
            if address == "::" || address.hasPrefix("ff") || address.hasPrefix("::ffff:") { return "Not a supported unicast address" }
        } else {
            let first = Int(address.split(separator: ".").first ?? "") ?? 0
            if first == 0 || first >= 224 || address == "255.255.255.255" { return "Not a supported unicast address" }
        }
        return nil
    }
    public func isPresent(in inventory: [InterfaceTarget]) -> Bool {
        exclusion == nil && inventory.contains { $0.id == id && $0.exclusion == nil }
    }
    /// Exact selected source address, or loopback for local controls. Not authentication.
    public func accepts(source: String, family: IPFamily) -> Bool {
        guard family == self.family else { return false }
        if isLoopback { return family == .ipv4 ? source.hasPrefix("127.") : source == "::1" }
        return source == address || source == (family == .ipv4 ? "127.0.0.1" : "::1")
    }
}

public enum LocalInterfaces {
    /// Enumerates assigned addresses only; never contacts a router or external service.
    public static func snapshot() throws -> [InterfaceTarget] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { throw SocketFailure(code: errno) }
        guard let first = list else { return [] }
        defer { freeifaddrs(first) }
        var rows = Set<InterfaceTarget>()
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let item = cursor {
            defer { cursor = item.pointee.ifa_next }
            guard let address = item.pointee.ifa_addr, let namePointer = item.pointee.ifa_name else { continue }
            let family = Int32(address.pointee.sa_family)
            guard family == AF_INET || family == AF_INET6 else { continue }
            let length = family == AF_INET ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size
            guard let endpoint = SocketEndpoint.decode(address, length: socklen_t(length)) else { continue }
            let name = String(cString: namePointer)
            rows.insert(InterfaceTarget(name: name, index: if_nametoindex(namePointer),
                                        address: endpoint.host, family: endpoint.family,
                                        isUp: item.pointee.ifa_flags & UInt32(IFF_UP) != 0))
        }
        return rows.sorted { $0.id < $1.id }
    }
}

struct SocketFailure: Error, LocalizedError {
    let code: Int32
    var errorDescription: String? { "errno \(code): \(String(cString: strerror(code)))" }
}

/// sockaddr_storage avoids using IPv4 memory layouts for IPv6 sockets.
struct SocketEndpoint {
    var storage: sockaddr_storage
    let length: socklen_t
    let host: String
    let port: UInt16
    let family: IPFamily

    init(host: String, port: UInt16, family: IPFamily) throws {
        var storage = sockaddr_storage()
        let length: Int
        if family == .ipv4 {
            var value = sockaddr_in()
            #if canImport(Darwin)
            value.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            #endif
            value.sin_family = sa_family_t(AF_INET); value.sin_port = port.bigEndian
            guard inet_pton(AF_INET, host, &value.sin_addr) == 1 else { throw SocketFailure(code: EINVAL) }
            length = MemoryLayout<sockaddr_in>.size
            withUnsafeBytes(of: value) { source in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: source) }
            }
        } else {
            var value = sockaddr_in6()
            #if canImport(Darwin)
            value.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            #endif
            value.sin6_family = sa_family_t(AF_INET6); value.sin6_port = port.bigEndian
            guard inet_pton(AF_INET6, host, &value.sin6_addr) == 1 else { throw SocketFailure(code: EINVAL) }
            length = MemoryLayout<sockaddr_in6>.size
            withUnsafeBytes(of: value) { source in
                withUnsafeMutableBytes(of: &storage) { $0.copyBytes(from: source) }
            }
        }
        self.storage = storage; self.length = socklen_t(length)
        self.host = host; self.port = port; self.family = family
    }

    static func decode(_ pointer: UnsafePointer<sockaddr>, length: socklen_t) -> SocketEndpoint? {
        let af = Int32(pointer.pointee.sa_family)
        var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let port: UInt16
        let family: IPFamily
        if af == AF_INET && length >= MemoryLayout<sockaddr_in>.size {
            var value = UnsafeRawPointer(pointer).assumingMemoryBound(to: sockaddr_in.self).pointee
            guard inet_ntop(af, &value.sin_addr, &buffer, socklen_t(buffer.count)) != nil else { return nil }
            port = UInt16(bigEndian: value.sin_port); family = .ipv4
        } else if af == AF_INET6 && length >= MemoryLayout<sockaddr_in6>.size {
            var value = UnsafeRawPointer(pointer).assumingMemoryBound(to: sockaddr_in6.self).pointee
            guard inet_ntop(af, &value.sin6_addr, &buffer, socklen_t(buffer.count)) != nil else { return nil }
            port = UInt16(bigEndian: value.sin6_port); family = .ipv6
        } else { return nil }
        // Link-local scoped targets are excluded, so no zone is reconstructed here.
        return try? SocketEndpoint(host: String(cString: buffer), port: port, family: family)
    }

    func withAddress<T>(_ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
        var value = storage
        return withUnsafePointer(to: &value) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, length) }
        }
    }
    static func bind(host: String, port: UInt16, family: IPFamily) throws -> Int32 {
        let af = family == .ipv4 ? AF_INET : AF_INET6
        #if canImport(Darwin)
        let fd = socket(af, SOCK_DGRAM, IPPROTO_UDP)
        #else
        let fd = socket(af, Int32(SOCK_DGRAM.rawValue), Int32(IPPROTO_UDP))
        #endif
        guard fd >= 0 else { throw SocketFailure(code: errno) }
        var success = false
        defer { if !success { close(fd) } }
        let flags = fcntl(fd, F_GETFL, 0)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw SocketFailure(code: errno) }
        if family == .ipv6 {
            var only: Int32 = 1
            guard setsockopt(fd, Int32(IPPROTO_IPV6), IPV6_V6ONLY, &only, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                throw SocketFailure(code: errno)
            }
        }
        let endpoint = try SocketEndpoint(host: host, port: port, family: family)
        let result = endpoint.withAddress { pointer, length in
            #if canImport(Darwin)
            return Darwin.bind(fd, pointer, length)
            #else
            return Glibc.bind(fd, pointer, length)
            #endif
        }
        guard result == 0 else { throw SocketFailure(code: errno) }
        success = true
        return fd
    }
    static func local(_ fd: Int32) throws -> SocketEndpoint {
        var storage = sockaddr_storage(); var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
        return try withUnsafeMutablePointer(to: &storage) { p in
            try p.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                guard getsockname(fd, address, &length) == 0 else { throw SocketFailure(code: errno) }
                guard let result = decode(address, length: length) else { throw SocketFailure(code: EINVAL) }
                return result
            }
        }
    }
    static func receive(_ fd: Int32) throws -> (Data, SocketEndpoint?)? {
        var bytes = [UInt8](repeating: 0, count: 65535)
        var storage = sockaddr_storage(); var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
        var peer: SocketEndpoint?
        let count = withUnsafeMutablePointer(to: &storage) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                let count = bytes.withUnsafeMutableBytes { recvfrom(fd, $0.baseAddress, $0.count, 0, address, &length) }
                if count >= 0 { peer = decode(address, length: length) }
                return count
            }
        }
        if count < 0 {
            let code = errno
            if code == EAGAIN || code == EWOULDBLOCK || code == EINTR { return nil }
            throw SocketFailure(code: code)
        }
        return (Data(bytes.prefix(count)), peer)
    }
    func send(_ bytes: Data, fd: Int32) -> Int32? {
        let count = withAddress { address, length in
            bytes.withUnsafeBytes { sendto(fd, $0.baseAddress, $0.count, 0, address, length) }
        }
        return count == bytes.count ? nil : (count < 0 ? errno : EMSGSIZE)
    }
}
