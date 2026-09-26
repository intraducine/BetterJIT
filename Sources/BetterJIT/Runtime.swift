// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// Platform hosts implement this interface; the API has no dependency on Iridium,
/// a game model, filesystem layout, UI framework or native CPU translator.
@MainActor public protocol RuntimeTransport: AnyObject {
    func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities
    func request(_ operation: String, payload: JSONValue) async throws -> JSONValue
    func close()
}
public typealias NativeService = @Sendable (JSONValue) async throws -> JSONValue

@MainActor public final class RuntimeSession {
    public enum State: String, Sendable { case idle, starting, ready, closed, failed }
    public private(set) var state: State = .idle
    public private(set) var capabilities: RuntimeCapabilities?
    public let limits: RuntimeLimits
    private let transport: any RuntimeTransport
    public init(transport: any RuntimeTransport, limits: RuntimeLimits) throws {
        self.transport = transport; self.limits = try limits.validated()
    }
    @discardableResult public func start() async throws -> RuntimeCapabilities {
        guard state == .idle else { throw RuntimeFault("invalidState", "A session can only be started once.") }
        state = .starting
        do {
            let caps = try await transport.start(limits: limits)
            guard state == .starting else { throw RuntimeFault.closed }
            guard caps.protocolVersion == 1, caps.wasm else {
                throw RuntimeFault("unsupported", "The host does not support the required execution protocol.")
            }
            capabilities = caps; state = .ready; return caps
        } catch { transport.close(); if state != .closed { state = .failed }; throw error }
    }
    public func close() { guard state != .closed else { return }; state = .closed; transport.close() }
    /// Low-level versioned command entry point for backend extensions.
    public func request(_ operation: String, payload: JSONValue = .null) async throws -> JSONValue {
        guard state == .ready else { throw RuntimeFault.closed }
        do { return try await transport.request(operation, payload: payload) }
        catch {
            if error is CancellationError || ["closed", "timeout", "processTerminated", "protocolVersion"].contains((error as? RuntimeFault)?.code ?? "") {
                state = .failed; transport.close()
            }
            throw error
        }
    }
    @discardableResult public func load(_ bytes: Data, as identifier: String = UUID().uuidString.lowercased()) async throws -> String {
        guard bytes.count >= 8, bytes.count <= limits.maximumModuleBytes,
              bytes.prefix(8) == Data([0,97,115,109,1,0,0,0]), Self.validName(identifier) else {
            throw RuntimeFault("invalidModule", "Expected a bounded Wasm v1 module and a valid identifier.")
        }
        _ = try await request("load", payload: .object(["module": .string(identifier), "bytes": .string(bytes.base64EncodedString())]))
        return identifier
    }
    public func unload(_ module: String) async throws {
        _ = try await request("unload", payload: .object(["module": .string(module)]))
    }
    public func invoke(_ module: String, export: String, arguments: [WasmValue] = [], results: [WasmType] = [.i32]) async throws -> [WasmValue] {
        guard Self.validName(module), Self.validName(export), arguments.count <= 64, results.count <= 16 else {
            throw RuntimeFault("invalidCall", "Invalid export name or arity.")
        }
        for value in arguments { try value.validate() }
        let answer = try await request("invoke", payload: .object([
            "module": .string(module), "export": .string(export), "arguments": try .encoding(arguments), "results": try .encoding(results)]))
        let values = try answer.decode([WasmValue].self)
        guard values.map(\.type) == results else { throw RuntimeFault("protocolValue", "Worker returned a different result signature.") }
        for value in values { try value.validate() }
        return values
    }
    public func readMemory(at offset: UInt32, count: Int) async throws -> Data {
        try checkTransfer(offset: offset, count: count)
        let answer = try await request("read", payload: .object(["offset": .number(Double(offset)), "count": .number(Double(count))]))
        guard let text = answer.string, let data = Data(base64Encoded: text), data.count == count else {
            throw RuntimeFault("protocolValue", "Worker returned an invalid memory read.")
        }
        return data
    }
    public func writeMemory(at offset: UInt32, bytes: Data) async throws {
        try checkTransfer(offset: offset, count: bytes.count)
        _ = try await request("write", payload: .object(["offset": .number(Double(offset)), "bytes": .string(bytes.base64EncodedString())]))
    }
    private func checkTransfer(offset: UInt32, count: Int) throws {
        guard count >= 0, count <= limits.maximumTransferBytes,
              UInt64(offset) + UInt64(count) <= UInt64(limits.maximumMemoryPages) * 65536 else {
            throw RuntimeFault("bounds", "Transfer exceeds the configured memory or message range.")
        }
    }
    private static func validName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 128 && !name.unicodeScalars.contains(where: { $0.value < 32 })
    }
}
