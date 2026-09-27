// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT

/// One service exclusively owns one translator. Methods return copied bytes,
/// never pointers into scratch storage. Do not also use the translator directly.
public protocol FEXTranslator: AnyObject {
    func configuration() throws -> Data
    func dispatcher() throws -> Data
    func initialState() throws -> Data
    func unit(at rip: UInt32) throws -> Data
    func region(profile: Data) throws -> Data
    func close()
}

public struct FEXServiceStatistics: Codable, Sendable, Equatable {
    public internal(set) var unitRequests = 0
    public internal(set) var regionRequests = 0
    public internal(set) var returnedBytes = 0
    public internal(set) var rejectedRequests = 0
}

public actor FEXService {
    private var translator: (any FEXTranslator)?
    private let image: Data
    private let maximumBytes: Int
    private var counters = FEXServiceStatistics()
    public init(translator: any FEXTranslator, image: Data, maximumBytes: Int = 8 * 1024 * 1024) throws {
        guard (8...16 * 1024 * 1024).contains(maximumBytes), image.count <= maximumBytes else {
            throw RuntimeFault("messageTooLarge", "FEX image exceeds the configured bridge limit.")
        }
        self.translator = translator; self.image = image; self.maximumBytes = maximumBytes
    }
    public func close() { translator?.close(); translator = nil }
    public func statistics() -> FEXServiceStatistics { counters }
    public func handle(_ payload: JSONValue) throws -> JSONValue {
        do { return try dispatch(payload) }
        catch { counters.rejectedRequests += 1; throw error }
    }
    private func dispatch(_ payload: JSONValue) throws -> JSONValue {
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
            counters.unitRequests += 1; data = try translator.unit(at: rip)
        case "region":
            guard let text = payload["profile"]?.string, text.utf8.count <= 4 * ((1024 * 1024 + 2) / 3),
                  let profile = Data(base64Encoded: text), profile.count <= 1024 * 1024,
                  profile.base64EncodedString() == text else {
                throw RuntimeFault("invalidBackendRequest", "Invalid FEX profile encoding.")
            }
            try Self.validateProfile(profile)
            counters.regionRequests += 1; data = try translator.region(profile: profile)
        default: throw RuntimeFault("serviceDenied", "Unknown FEX translation operation.")
        }
        guard data.count <= maximumBytes + (method == "unit" ? 4 : 0) else {
            throw RuntimeFault("messageTooLarge", "Translated module exceeds bridge budget.")
        }
        counters.returnedBytes += data.count
        return .string(data.base64EncodedString())
    }
    /// Validate lengths and counts before calling the native decoder. The byte
    /// ceiling also applies to callers using this helper directly.
    public static func validateProfile(_ data: Data) throws {
        guard data.count <= 1024 * 1024, data.count % 4 == 0 else {
            throw RuntimeFault("invalidBackendRequest", "Oversized or unaligned profile.")
        }
        let bytes = [UInt8](data); var offset = 0
        func word() throws -> UInt32 {
            guard offset + 4 <= bytes.count else { throw RuntimeFault("invalidBackendRequest", "Truncated profile.") }
            defer { offset += 4 }
            return (0..<4).reduce(0) { $0 | UInt32(bytes[offset + $1]) << (8 * $1) }
        }
        let n = try word()
        guard n >= 1, n <= 24 else { throw RuntimeFault("invalidBackendRequest", "Region must contain 1...24 units.") }
        var entries = Set<UInt32>()
        for _ in 0..<n {
            guard entries.insert(try word()).inserted else { throw RuntimeFault("invalidBackendRequest", "Duplicate region entry.") }
        }
        let m = try word()
        guard m <= 24 else { throw RuntimeFault("invalidBackendRequest", "Too many successor lists.") }
        var predecessors = Set<UInt32>()
        for _ in 0..<m {
            let rip = try word(), k = try word()
            guard entries.contains(rip), predecessors.insert(rip).inserted, k <= 12 else {
                throw RuntimeFault("invalidBackendRequest", "Invalid successor list.")
            }
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
        try await callFEX(entry: entry, arguments: [argument])
    }
    /// Integer/pointer arguments only. Up to 16 values are placed in SysV/Win64
    /// registers and stack slots. This is not a general C ABI for structs/floats.
    func callFEX(entry: UInt32, arguments: [UInt64]) async throws -> UInt64 {
        guard arguments.count <= 16 else { throw RuntimeFault("invalidCall", "At most 16 integer arguments are supported.") }
        let payload: JSONValue
        if capabilities?.extensions.contains("fex.integerArguments") == true {
            payload = .object(["entry": .number(Double(entry)), "arguments": .array(arguments.map { .string(String($0)) })])
        } else {
            guard arguments.count == 1 else { throw RuntimeFault("unsupported", "The peer supports only the legacy single FEX argument.") }
            payload = .object(["entry": .number(Double(entry)), "argument": .string(String(arguments[0]))])
        }
        let result = try await request("fex.call", payload: payload)
        guard let text = result.string, text.utf8.count <= 20, let value = UInt64(text), String(value) == text else {
            close()
            throw RuntimeFault("protocolValue", "Invalid FEX register result; session closed.")
        }
        return value
    }
}
