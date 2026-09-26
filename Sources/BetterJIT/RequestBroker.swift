// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// Correlates versioned requests with bounded pending work. Abort is session-wide:
/// a timed-out or cancelled guest may have mutated memory; do not reuse its worker.
@MainActor public final class RequestBroker {
    public let session: String
    private let limits: RuntimeLimits
    private let send: (RPCMessage) throws -> Void
    private let abort: () -> Void
    private struct Pending {
        let continuation: CheckedContinuation<JSONValue, Error>
        let deadline: Task<Void, Never>
    }
    private var pending: [String: Pending] = [:]
    public private(set) var isClosed = false
    public var pendingCount: Int { pending.count }
    public init(session: String = UUID().uuidString.lowercased(), limits: RuntimeLimits,
                send: @escaping (RPCMessage) throws -> Void, abort: @escaping () -> Void) {
        self.session = session; self.limits = limits; self.send = send; self.abort = abort
    }
    public func request(_ operation: String, payload: JSONValue = .null) async throws -> JSONValue {
        guard !isClosed else { throw RuntimeFault.closed }
        _ = try limits.validated()
        guard pending.count < limits.maximumPendingRequests else {
            throw RuntimeFault("backpressure", "The session's pending request limit was reached.")
        }
        try Task.checkCancellation()
        let id = UUID().uuidString.lowercased()
        let message = RPCMessage(session: session, id: id, kind: "request", operation: operation, payload: payload)
        guard try JSONEncoder().encode(message).count <= limits.maximumMessageBytes else {
            throw RuntimeFault("messageTooLarge", "Request exceeds the configured wire limit.")
        }
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { [weak self, seconds = limits.timeoutSeconds] in
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
                    catch { return }
                    guard let self, self.pending[id] != nil else { return }
                    self.close(RuntimeFault("timeout", "The worker exceeded its deadline and was terminated."))
                }
                pending[id] = Pending(continuation: continuation, deadline: timeout)
                do { try send(message) } catch { close(error) }
            }
        }, onCancel: { [weak self] in
            Task { @MainActor in
                guard let self, self.pending[id] != nil else { return }
                self.close(CancellationError())
            }
        })
    }
    public func receive(_ message: RPCMessage) {
        guard !isClosed, message.session == session, message.kind == "response" else { return }
        guard message.v == 1 else { close(RuntimeFault("protocolVersion", "Unsupported worker protocol.")); return }
        guard let entry = pending.removeValue(forKey: message.id) else { return }
        entry.deadline.cancel()
        if let error = message.error { entry.continuation.resume(throwing: error) }
        else { entry.continuation.resume(returning: message.payload) }
    }
    public func close(_ error: Error = RuntimeFault.closed) {
        guard !isClosed else { return }
        isClosed = true
        let entries = pending.values; pending.removeAll()
        abort()
        for entry in entries { entry.deadline.cancel(); entry.continuation.resume(throwing: error) }
    }
}
