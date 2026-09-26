// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT

/// Adapter boundary for the optional native FEX library. Methods return owned
/// bytes, never pointers into a translator's scratch buffer. Give each service
/// exclusive ownership of one translator; the actor serializes access to it.
public protocol FEXTranslator: AnyObject {
    func configuration() throws -> Data
    func dispatcher() throws -> Data
    func initialState() throws -> Data
    /// Native FEX wire format: little-endian u32 slot, followed by Wasm bytes.
    func unit(at rip: UInt32) throws -> Data
    func region(profile: Data) throws -> Data
    func close()
}

public actor FEXService {
    private var translator: (any FEXTranslator)?
    private let image: Data
    private let maximumBytes: Int
    public init(translator: any FEXTranslator, image: Data, maximumBytes: Int = 8 * 1024 * 1024) throws {
        guard (8...16 * 1024 * 1024).contains(maximumBytes), image.count <= maximumBytes else {
            throw RuntimeFault("messageTooLarge", "FEX image exceeds the configured bridge limit.")
        }
        self.translator = translator; self.image = image; self.maximumBytes = maximumBytes
    }
    public func close() { translator?.close(); translator = nil }
    public func handle(_ payload: JSONValue) throws -> JSONValue {
        guard let translator else { throw RuntimeFault.closed }
        guard let method = payload["method"]?.string else { throw RuntimeFault("invalidBackendRequest", "Missing FEX operation.") }
        let data: Data
        switch method {
        case "config":
            let config = try translator.configuration()
            guard config.count <= 65536 else { throw RuntimeFault("messageTooLarge", "FEX config too large.") }
            return try JSONDecoder().decode(JSONValue.self, from: config)
        case "image": data = image
        case "state": data = try translator.initialState()
        case "dispatcher": data = try translator.dispatcher()
        case "unit":
            guard let n = payload["rip"]?.integer, let rip = UInt32(exactly: n) else {
                throw RuntimeFault("invalidBackendRequest", "RIP must be an unsigned 32-bit window address.")
            }
            data = try translator.unit(at: rip)
        case "region":
            guard let text = payload["profile"]?.string, text.count <= 4 * 1024 * 1024,
                  let profile = Data(base64Encoded: text), profile.count <= 1024 * 1024,
                  profile.count % 4 == 0 else {
                throw RuntimeFault("invalidBackendRequest", "Invalid FEX profile encoding.")
            }
            try Self.validateProfile(profile)
            data = try translator.region(profile: profile)
        default: throw RuntimeFault("serviceDenied", "Unknown FEX translation operation.")
        }
        guard data.count <= maximumBytes + (method == "unit" ? 4 : 0) else {
            throw RuntimeFault("messageTooLarge", "Translated module exceeds bridge budget.")
        }
        return .string(data.base64EncodedString())
    }
    /// Check counts before the native decoder sees an externally supplied profile.
    public static func validateProfile(_ data: Data) throws {
        guard data.count % 4 == 0 else { throw RuntimeFault("invalidBackendRequest", "Unaligned profile.") }
        let bytes = [UInt8](data); var offset = 0
        func word() throws -> UInt32 {
            guard offset + 4 <= bytes.count else { throw RuntimeFault("invalidBackendRequest", "Truncated profile.") }
            defer { offset += 4 }
            return (0..<4).reduce(0) { $0 | UInt32(bytes[offset + $1]) << (8 * $1) }
        }
        let n = try word()
        guard n >= 1, n <= 24 else { throw RuntimeFault("invalidBackendRequest", "Region must contain 1...24 units.") }
        for _ in 0..<n { _ = try word() }
        let m = try word()
        guard m <= 24 else { throw RuntimeFault("invalidBackendRequest", "Too many successor lists.") }
        for _ in 0..<m {
            _ = try word(); let k = try word()
            guard k <= 12 else { throw RuntimeFault("invalidBackendRequest", "Too many successors.") }
            for _ in 0..<k { _ = try word() }
        }
        let c = try word()
        guard c <= 65536 else { throw RuntimeFault("invalidBackendRequest", "Too many call sites.") }
        for _ in 0..<c {
            _ = try word(); let k = try word()
            guard k <= 4 else { throw RuntimeFault("invalidBackendRequest", "Too many call targets.") }
            for _ in 0..<k { _ = try word() }
        }
        guard offset == bytes.count else { throw RuntimeFault("invalidBackendRequest", "Trailing profile data.") }
    }
}

@MainActor public extension RuntimeSession {
    func openFEX() async throws { _ = try await request("fex.open") }
    func callFEX(entry: UInt32, argument: UInt64) async throws -> UInt64 {
        let result = try await request("fex.call", payload: .object(["entry": .number(Double(entry)), "argument": .string(String(argument))]))
        guard let text = result.string, let value = UInt64(text), String(value) == text else {
            throw RuntimeFault("protocolValue", "Invalid FEX register result.")
        }
        return value
    }
}
