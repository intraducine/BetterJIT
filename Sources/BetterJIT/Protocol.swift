// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// JSON on the public wire protocol. Guest integers use tagged decimal strings,
/// never JSON numbers, so a 64-bit register cannot silently lose precision.
public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String)
    case array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let x = try? c.decode(Bool.self) { self = .bool(x) }
        else if let x = try? c.decode(String.self) { self = .string(x) }
        else if let x = try? c.decode(Double.self) { self = .number(x) }
        else if let x = try? c.decode([JSONValue].self) { self = .array(x) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let x): try c.encode(x)
        case .number(let x): try c.encode(x)
        case .string(let x): try c.encode(x)
        case .array(let x): try c.encode(x)
        case .object(let x): try c.encode(x)
        }
    }
    public subscript(_ key: String) -> JSONValue? {
        guard case .object(let v) = self else { return nil }; return v[key]
    }
    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var integer: Int? {
        guard case .number(let n) = self, n.isFinite, n.rounded() == n,
              n >= -9_007_199_254_740_991, n <= 9_007_199_254_740_991 else { return nil }
        return Int(exactly: n)
    }
    public static func encoding<T: Encodable>(_ value: T) throws -> Self {
        try JSONDecoder().decode(Self.self, from: JSONEncoder().encode(value))
    }
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}

public struct RuntimeFault: Error, Codable, Sendable, Equatable, LocalizedError {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { "\(code): \(message)" }
    public static let closed = Self("closed", "Create a new runtime session after close, timeout or cancellation.")
}

public struct RuntimeLimits: Codable, Sendable, Equatable {
    public let initialMemoryPages: Int
    public let maximumMemoryPages: Int
    public let maximumModuleBytes: Int
    public let maximumModules: Int
    public let maximumTransferBytes: Int
    public let maximumPendingRequests: Int
    public let timeoutSeconds: Double
    /// Limits count Wasm input bytes, not JavaScriptCore's opaque JIT allocation.
    public let maximumResidentModuleBytes: Int
    public let maximumCumulativeModuleBytes: Int
    public let maximumTableElements: Int
    public let maximumPendingBytes: Int
    public let maximumBatchOperations: Int
    public init(initialMemoryPages: Int = 16, maximumMemoryPages: Int = 1024,
                maximumModuleBytes: Int = 8 * 1024 * 1024, maximumModules: Int = 128,
                maximumTransferBytes: Int = 1024 * 1024, maximumPendingRequests: Int = 16,
                timeoutSeconds: Double = 15,
                maximumResidentModuleBytes: Int = 32 * 1024 * 1024,
                maximumCumulativeModuleBytes: Int = 256 * 1024 * 1024,
                maximumTableElements: Int = 65536,
                maximumPendingBytes: Int = 64 * 1024 * 1024,
                maximumBatchOperations: Int = 64) throws {
        guard initialMemoryPages >= 1, initialMemoryPages <= maximumMemoryPages,
              maximumMemoryPages <= 65536, (8...16 * 1024 * 1024).contains(maximumModuleBytes),
              (1...4096).contains(maximumModules), (1...4 * 1024 * 1024).contains(maximumTransferBytes),
              (1...128).contains(maximumPendingRequests), timeoutSeconds.isFinite,
              (0.01...600).contains(timeoutSeconds),
              (maximumModuleBytes...256 * 1024 * 1024).contains(maximumResidentModuleBytes),
              (maximumResidentModuleBytes...1024 * 1024 * 1024).contains(maximumCumulativeModuleBytes),
              (1...1048576).contains(maximumTableElements),
              (65536...256 * 1024 * 1024).contains(maximumPendingBytes),
              (1...128).contains(maximumBatchOperations) else {
            throw RuntimeFault("invalidConfiguration", "Memory, message, queue or deadline limit is out of range.")
        }
        self.initialMemoryPages = initialMemoryPages; self.maximumMemoryPages = maximumMemoryPages
        self.maximumModuleBytes = maximumModuleBytes; self.maximumModules = maximumModules
        self.maximumTransferBytes = maximumTransferBytes; self.maximumPendingRequests = maximumPendingRequests
        self.timeoutSeconds = timeoutSeconds
        self.maximumResidentModuleBytes = maximumResidentModuleBytes
        self.maximumCumulativeModuleBytes = maximumCumulativeModuleBytes
        self.maximumTableElements = maximumTableElements
        self.maximumPendingBytes = maximumPendingBytes
        self.maximumBatchOperations = maximumBatchOperations
    }
    private enum CodingKeys: String, CodingKey {
        case initialMemoryPages, maximumMemoryPages, maximumModuleBytes, maximumModules
        case maximumTransferBytes, maximumPendingRequests, timeoutSeconds
        case maximumResidentModuleBytes, maximumCumulativeModuleBytes, maximumTableElements
        case maximumPendingBytes, maximumBatchOperations
    }
    /// v1 settings without the additive budget fields retain bounded defaults.
    /// Every entry point calls validated() before using decoded limits.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        initialMemoryPages = try c.decode(Int.self, forKey: .initialMemoryPages)
        maximumMemoryPages = try c.decode(Int.self, forKey: .maximumMemoryPages)
        maximumModuleBytes = try c.decode(Int.self, forKey: .maximumModuleBytes)
        maximumModules = try c.decode(Int.self, forKey: .maximumModules)
        maximumTransferBytes = try c.decode(Int.self, forKey: .maximumTransferBytes)
        maximumPendingRequests = try c.decode(Int.self, forKey: .maximumPendingRequests)
        timeoutSeconds = try c.decode(Double.self, forKey: .timeoutSeconds)
        maximumResidentModuleBytes = try c.decodeIfPresent(Int.self, forKey: .maximumResidentModuleBytes) ?? 32 * 1024 * 1024
        maximumCumulativeModuleBytes = try c.decodeIfPresent(Int.self, forKey: .maximumCumulativeModuleBytes) ?? 256 * 1024 * 1024
        maximumTableElements = try c.decodeIfPresent(Int.self, forKey: .maximumTableElements) ?? 65536
        maximumPendingBytes = try c.decodeIfPresent(Int.self, forKey: .maximumPendingBytes) ?? 64 * 1024 * 1024
        maximumBatchOperations = try c.decodeIfPresent(Int.self, forKey: .maximumBatchOperations) ?? 64
    }
    public var maximumMessageBytes: Int { 2 * max(maximumModuleBytes, maximumTransferBytes) + 65536 }
    /// Revalidate decoded settings as well as settings constructed by the public initializer.
    public func validated() throws -> Self {
        try Self(initialMemoryPages: initialMemoryPages, maximumMemoryPages: maximumMemoryPages,
                 maximumModuleBytes: maximumModuleBytes, maximumModules: maximumModules,
                 maximumTransferBytes: maximumTransferBytes, maximumPendingRequests: maximumPendingRequests,
                 timeoutSeconds: timeoutSeconds,
                 maximumResidentModuleBytes: maximumResidentModuleBytes,
                 maximumCumulativeModuleBytes: maximumCumulativeModuleBytes,
                 maximumTableElements: maximumTableElements,
                 maximumPendingBytes: maximumPendingBytes,
                 maximumBatchOperations: maximumBatchOperations)
    }
}

public enum WasmType: String, Codable, Sendable { case i32, i64, f32, f64 }
public struct WasmValue: Codable, Sendable, Equatable {
    public let type: WasmType
    public let value: String
    private init(type: WasmType, value: String) { self.type = type; self.value = value }
    public static func i32(_ n: Int32) -> Self { Self(type: .i32, value: String(n)) }
    public static func i64(_ n: Int64) -> Self { Self(type: .i64, value: String(n)) }
    public static func f32(_ n: Float) throws -> Self {
        guard n.isFinite else { throw RuntimeFault("invalidValue", "The v1 host ABI requires finite floats.") }
        return Self(type: .f32, value: String(n))
    }
    public static func f64(_ n: Double) throws -> Self {
        guard n.isFinite else { throw RuntimeFault("invalidValue", "The v1 host ABI requires finite floats.") }
        return Self(type: .f64, value: String(n))
    }
    private static func decimal(_ value: String) -> Bool {
        value.range(of: #"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?\z"#, options: .regularExpression) != nil
    }
    public func validate() throws {
        guard value.utf8.count <= 64 else { throw RuntimeFault("invalidValue", "Numeric value is too long.") }
        let valid: Bool
        switch type {
        case .i32: valid = Int32(value).map { String($0) == value } ?? false
        case .i64: valid = Int64(value).map { String($0) == value } ?? false
        case .f32: valid = Self.decimal(value) && Float(value)?.isFinite == true
        case .f64: valid = Self.decimal(value) && Double(value)?.isFinite == true
        }
        guard valid else { throw RuntimeFault("invalidValue", "Malformed tagged numeric value.") }
    }
}

public struct RuntimeCapabilities: Codable, Sendable, Equatable {
    public let protocolVersion: Int
    public let wasm: Bool
    public let jspi: Bool
    public let sharedMemory: Bool
    public let opfs: Bool
    public let extensions: [String]
    public init(protocolVersion: Int = 1, wasm: Bool, jspi: Bool, sharedMemory: Bool, opfs: Bool,
                extensions: [String] = []) {
        self.protocolVersion = protocolVersion; self.wasm = wasm; self.jspi = jspi
        self.sharedMemory = sharedMemory; self.opfs = opfs; self.extensions = extensions
    }
    private enum CodingKeys: String, CodingKey { case protocolVersion, wasm, jspi, sharedMemory, opfs, extensions }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try c.decode(Int.self, forKey: .protocolVersion)
        wasm = try c.decode(Bool.self, forKey: .wasm); jspi = try c.decode(Bool.self, forKey: .jspi)
        sharedMemory = try c.decode(Bool.self, forKey: .sharedMemory); opfs = try c.decode(Bool.self, forKey: .opfs)
        extensions = try c.decodeIfPresent([String].self, forKey: .extensions) ?? []
        guard extensions.count <= 64, extensions.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 64 }) else {
            throw RuntimeFault("protocolValue", "Invalid capability extension list.")
        }
    }
    // API capabilities, not proof of an engine's current JIT tier.
}

public struct RPCMessage: Codable, Sendable, Equatable {
    public let v: Int
    public let session: String
    public let id: String
    public let kind: String
    public let operation: String?
    public let payload: JSONValue
    public let error: RuntimeFault?
    public init(v: Int = 1, session: String, id: String, kind: String,
                operation: String? = nil, payload: JSONValue = .null, error: RuntimeFault? = nil) {
        self.v = v; self.session = session; self.id = id; self.kind = kind
        self.operation = operation; self.payload = payload; self.error = error
    }
}
