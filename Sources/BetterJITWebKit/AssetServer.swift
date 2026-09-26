// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(WebKit) && canImport(Network)
import Foundation
import Network
import BetterJIT

/// Serves a fixed resource set on IPv4 loopback, with an unguessable per-session
/// path. No filesystem routes, translation routes, uploads or external listeners.
final class AssetServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "BetterJIT.assets")
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var started: CheckedContinuation<UInt16, Error>?
    private var stopped = false
    private var port: UInt16 = 0
    private let assets: [String: (Data, String)]
    init(assets: [String: (Data, String)]) { self.assets = assets }
    func start(timeout: Double) async throws -> UInt16 {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    guard !self.stopped, self.listener == nil else { continuation.resume(throwing: RuntimeFault.closed); return }
                    self.started = continuation
                    do {
                        let parameters = NWParameters.tcp
                        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                        parameters.requiredInterfaceType = .loopback
                        let listener = try NWListener(using: parameters)
                        self.listener = listener
                        listener.stateUpdateHandler = { [weak self] state in
                            guard let self else { return }
                            switch state {
                            case .ready:
                                guard let port = listener.port?.rawValue else { self.finishStart(.failure(RuntimeFault("server", "Missing loopback port."))); return }
                                self.port = port; self.finishStart(.success(port))
                            case .failed(let error): self.finishStart(.failure(error)); self.stopOnQueue()
                            case .cancelled: self.finishStart(.failure(RuntimeFault.closed))
                            default: break
                            }
                        }
                        listener.newConnectionHandler = { [weak self] in self?.accept($0) }
                        listener.start(queue: self.queue)
                        self.queue.asyncAfter(deadline: .now() + timeout) {
                            if self.started != nil { self.finishStart(.failure(RuntimeFault("timeout", "Loopback startup timed out."))); self.stopOnQueue() }
                        }
                    } catch { self.finishStart(.failure(error)); self.stopOnQueue() }
                }
            }
        }, onCancel: { self.stop() })
    }
    func stop() { queue.async { self.stopOnQueue() } }
    private func finishStart(_ result: Result<UInt16, Error>) {
        let c = started; started = nil; c?.resume(with: result)
    }
    private func stopOnQueue() {
        guard !stopped else { return }; stopped = true
        listener?.stateUpdateHandler = nil; listener?.newConnectionHandler = nil
        listener?.cancel(); listener = nil
        for connection in connections.values { connection.cancel() }; connections.removeAll()
        finishStart(.failure(RuntimeFault.closed))
    }
    private func accept(_ connection: NWConnection) {
        guard !stopped, connections.count < 16 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.start(queue: queue)
        receive(connection, id: id, buffer: Data())
        queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.finish(id) }
    }
    private func finish(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }
    private func receive(_ connection: NWConnection, id: UUID, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8193 - buffer.count) { [weak self] data, _, complete, error in
            guard let self, self.connections[id] != nil else { return }
            var input = buffer; if let data { input.append(data) }
            guard input.count <= 8192, error == nil else { self.finish(id); return }
            if let end = input.range(of: Data("\r\n\r\n".utf8)) {
                do {
                    guard end.upperBound == input.endIndex else { throw RuntimeFault("badRequest", "No request body or pipelining is accepted.") }
                    let path = try LoopbackRequest.assetPath(header: input, port: self.port, allowed: Set(self.assets.keys))
                    let (body, type) = self.assets[path]!
                    let header = "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\nContent-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'\r\n\r\n"
                    var response = Data(header.utf8); response.append(body)
                    connection.send(content: response, completion: .contentProcessed { [weak self] _ in self?.finish(id) })
                } catch { self.finish(id) }
            } else if complete { self.finish(id) }
            else { self.receive(connection, id: id, buffer: input) }
        }
    }
}
#endif
