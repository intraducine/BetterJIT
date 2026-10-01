// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

public extension RuntimeFault {
    static func normalizing(_ error: Error) -> RuntimeFault {
        if let fault = error as? RuntimeFault { return fault }
        if error is CancellationError { return RuntimeFault("cancelled", "Execution was cancelled; the session cannot be reused.") }
        // Do not expose paths, tokens or arbitrary native Error descriptions.
        return RuntimeFault("transport", "The execution transport failed.")
    }
}

public struct WasmInvocation: Codable, Sendable, Equatable {
    public let module: String
    public let export: String
    public let arguments: [WasmValue]
    public let results: [WasmType]
    public init(module: String, export: String, arguments: [WasmValue] = [], results: [WasmType] = [.i32]) {
        self.module = module; self.export = export; self.arguments = arguments; self.results = results
    }
}

/// Counts bytes submitted to compilation, not resident JIT machine-code pages.
public struct RuntimeStatistics: Codable, Sendable, Equatable {
    public let loadedModules: Int
    public let residentModuleBytes: Int
    public let cumulativeModuleBytes: Int
    public let reservedTableElements: Int
    public let memoryBytes: Int
    public let invocations: Int
    public let nativeCalls: Int
    public let nativeRequestBytes: Int
    public let nativeResponseBytes: Int
    public let compileMilliseconds: Double
    public let invokeMilliseconds: Double
    public func validated() throws -> Self {
        guard [loadedModules, residentModuleBytes, cumulativeModuleBytes, reservedTableElements,
               memoryBytes, invocations, nativeCalls, nativeRequestBytes, nativeResponseBytes].allSatisfy({ $0 >= 0 }),
              compileMilliseconds.isFinite, compileMilliseconds >= 0,
              invokeMilliseconds.isFinite, invokeMilliseconds >= 0 else {
            throw RuntimeFault("protocolValue", "Invalid execution statistics.")
        }
        return self
    }
}

@MainActor public extension RuntimeSession {
    /// One bridge round trip for an ordered group of calls. Validation of all
    /// signatures happens first. Execution is NOT transactional: a guest trap
    /// stops the batch, but earlier guest/native side effects are not rolled back.
    func invokeBatch(_ calls: [WasmInvocation]) async throws -> [[WasmValue]] {
        guard capabilities?.extensions.contains("batch") == true else { throw RuntimeFault("unsupported", "The peer does not support batched calls.") }
        guard !calls.isEmpty, calls.count <= limits.maximumBatchOperations else {
            throw RuntimeFault("invalidCall", "Batch size exceeds the configured limit.")
        }
        for call in calls {
            guard !call.module.isEmpty, !call.export.isEmpty, call.module.utf8.count <= 128,
                  call.export.utf8.count <= 128, call.arguments.count <= 64, call.results.count <= 16,
                  !call.module.unicodeScalars.contains(where: { $0.value < 32 }),
                  !call.export.unicodeScalars.contains(where: { $0.value < 32 }) else {
                throw RuntimeFault("invalidCall", "Invalid batched call.")
            }
            for argument in call.arguments { try argument.validate() }
        }
        let answer = try await request("invokeBatch", payload: .object(["calls": try .encoding(calls)]))
        return try checkedReply {
            let values = try answer.decode([[WasmValue]].self)
            guard values.count == calls.count else { throw RuntimeFault("protocolValue", "Wrong batch result count.") }
            for (row, call) in zip(values, calls) {
                guard row.map(\.type) == call.results else { throw RuntimeFault("protocolValue", "Wrong batch result signature.") }
                for value in row { try value.validate() }
            }
            return values
        }
    }
    func statistics() async throws -> RuntimeStatistics {
        guard capabilities?.extensions.contains("statistics") == true else { throw RuntimeFault("unsupported", "The peer does not support statistics.") }
        let answer = try await request("statistics")
        return try checkedReply { try answer.decode(RuntimeStatistics.self).validated() }
    }
}
