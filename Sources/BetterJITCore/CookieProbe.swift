import Foundation

/// A reachability experiment, not an IKE SA, VPN implementation, or JIT enabler.
/// RFC 7296 section 2.6: a client echoes a COOKIE before key negotiation.
public struct CookieProbe {
    public struct Result {
        public let event: String
        public let detail: String
        public let reply: Data?
    }

    private struct Challenge {
        let cookie: Data
        let original: [Payload]
        let version: UInt8
        let flags: UInt8
        let created: TimeInterval
        var verified = false
    }

    private var challenges: [String: Challenge] = [:]
    public let capacity = 32
    public let lifetime: TimeInterval = 60
    public var pendingCount: Int { challenges.count }
    public init() {}

    public mutating func receive(
        _ datagram: Data, peer: String, encapsulated: Bool,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> Result {
        challenges = challenges.filter { now >= $0.value.created && now - $0.value.created < lifetime }
        var wire = datagram
        if encapsulated {
            if wire == Data([0xff]) { return result("natKeepalive", "NAT keepalive; not IKE proof") }
            guard wire.count >= 4 else { return result("ignored", "Truncated UDP-encapsulated packet") }
            guard wire.prefix(4) == Data(repeating: 0, count: 4) else {
                return result("ignoredESP", "Non-IKE UDP/4500 traffic; not decrypted")
            }
            wire = Data(wire.dropFirst(4))
        }
        do {
            let message = try InitialMessage(wire)
            let cookies = message.payloads.filter { $0.isCookie }
            guard cookies.count <= 1 else { throw Invalid.message("Multiple COOKIE notifications") }
            if let first = cookies.first {
                guard message.payloads.first == first,
                      first.body.count >= 5, first.body.count <= 68,
                      first.body.prefix(2) == Data([0, 0]) else {
                    throw Invalid.message("Invalid COOKIE position, size, or protocol")
                }
            }
            let original = message.payloads.filter { !$0.isCookie }
            let key = "\(peer)|\(encapsulated)|\(message.spi.base64EncodedString())"
            let echoed = cookies.first.map { Data($0.body.dropFirst(4)) }
            if var old = challenges[key], old.original == original,
               old.version == message.version, old.flags == message.flags {
                if echoed == old.cookie {
                    let repeated = old.verified
                    old.verified = true
                    challenges[key] = old
                    return Result(
                        event: repeated ? "cookieEchoRepeated" : "cookieRoundTrip",
                        detail: "COOKIE echoed with unchanged request; intentionally ending with NO_PROPOSAL_CHOSEN. No tunnel or JIT.",
                        reply: notify(spi: message.spi, type: 14, data: Data(), encapsulated: encapsulated)
                    )
                }
                // Retransmit the same challenge; never accept an unsolicited or stale cookie.
                return Result(event: "cookieChallenge", detail: "COOKIE challenge sent; waiting for echo",
                              reply: notify(spi: message.spi, type: 16390, data: old.cookie, encapsulated: encapsulated))
            }
            if challenges.count >= capacity, let oldest = challenges.min(by: { $0.value.created < $1.value.created }) {
                challenges.removeValue(forKey: oldest.key)
            }
            let cookie = randomBytes(count: 32)
            challenges[key] = Challenge(cookie: cookie, original: original,
                                        version: message.version, flags: message.flags, created: now)
            return Result(event: "cookieChallenge", detail: "IKE_SA_INIT received; returning COOKIE challenge",
                          reply: notify(spi: message.spi, type: 16390, data: cookie, encapsulated: encapsulated))
        } catch {
            return result("ignored", String(describing: error))
        }
    }

    private func result(_ event: String, _ detail: String) -> Result {
        Result(event: event, detail: detail, reply: nil)
    }

    private func notify(spi: Data, type: UInt16, data: Data, encapsulated: Bool) -> Data {
        var body = Data([0, 0]) // Protocol ID and SPI size, RFC 7296 3.10.
        body.appendBE(type)
        body.append(data)
        var reply = spi
        reply.append(Data(repeating: 0, count: 8)) // No responder SA allocated.
        reply.append(contentsOf: [41, 0x20, 34, 0x20]) // Notify, IKEv2, SA_INIT, response.
        reply.appendBE(UInt32(0))
        reply.appendBE(UInt32(32 + body.count))
        reply.append(contentsOf: [0, 0])
        reply.appendBE(UInt16(4 + body.count))
        reply.append(body)
        return (encapsulated ? Data(repeating: 0, count: 4) : Data()) + reply
    }
}

private enum Invalid: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let value): return value } }
}

private struct Payload: Equatable {
    let type: UInt8
    let flags: UInt8
    let body: Data
    var isCookie: Bool { type == 41 && body.count >= 4 && Array(body)[2...3] == [0x40, 0x06] }
}

private struct InitialMessage {
    let spi: Data
    let version: UInt8
    let flags: UInt8
    let payloads: [Payload]

    init(_ data: Data) throws {
        let bytes = Array(data)
        guard (28...32768).contains(bytes.count) else { throw Invalid.message("Invalid IKE datagram size") }
        guard bytes[17] >> 4 == 2, bytes[18] == 34,
              bytes[19] & 0x28 == 0x08,
              bytes[20...23].allSatisfy({ $0 == 0 }),
              bytes[8...15].allSatisfy({ $0 == 0 }),
              bytes[0...7].contains(where: { $0 != 0 }) else {
            throw Invalid.message("Not an initial IKEv2 request")
        }
        let length = bytes[24...27].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length == bytes.count else { throw Invalid.message("IKE length mismatch") }
        spi = Data(bytes[0...7]); version = bytes[17]; flags = bytes[19]
        var parsed: [Payload] = []
        var next = bytes[16]
        var offset = 28
        while next != 0 {
            guard parsed.count < 32, offset + 4 <= bytes.count else { throw Invalid.message("Invalid payload chain") }
            let size = Int(bytes[offset + 2]) * 256 + Int(bytes[offset + 3])
            guard size >= 4, offset + size <= bytes.count else { throw Invalid.message("Invalid payload length") }
            let known: Set<UInt8> = [33, 34, 38, 40, 41, 43]
            guard known.contains(next) || bytes[offset + 1] & 0x80 == 0 else {
                throw Invalid.message("Unsupported critical payload")
            }
            parsed.append(Payload(type: next, flags: bytes[offset + 1], body: Data(bytes[(offset + 4)..<(offset + size)])))
            next = bytes[offset]; offset += size
        }
        guard offset == bytes.count else { throw Invalid.message("Trailing bytes after payload chain") }
        for required: UInt8 in [33, 34, 40] {
            guard parsed.filter({ $0.type == required }).count == 1 else { throw Invalid.message("Missing or duplicate SA, KE, or nonce") }
        }
        guard parsed.first(where: { $0.type == 33 })!.body.count >= 8,
              parsed.first(where: { $0.type == 34 })!.body.count >= 5,
              (16...256).contains(parsed.first(where: { $0.type == 40 })!.body.count) else {
            throw Invalid.message("Invalid SA, KE, or nonce envelope")
        }
        for notification in parsed where notification.type == 41 {
            guard notification.body.count >= 4 else { throw Invalid.message("Truncated notification") }
            let b = Array(notification.body)
            guard Int(b[1]) <= b.count - 4 else { throw Invalid.message("Truncated notification SPI") }
        }
        // SA transforms and DH values are deliberately not negotiated by this probe.
        payloads = parsed
    }
}

func randomBytes(count: Int) -> Data {
    var generator = SystemRandomNumberGenerator()
    return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
}

extension Data {
    mutating func appendBE<T: FixedWidthInteger>(_ value: T) {
        var big = value.bigEndian
        Swift.withUnsafeBytes(of: &big) { append(contentsOf: $0) }
    }
}
