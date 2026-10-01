import Foundation
import Network

/// Bundled assets only. Binds exclusively to IPv4 loopback, with a per-launch
/// capability path and exact Host validation. No upload, proxy or file-path API.
final class LocalServer {
    private let queue = DispatchQueue(label: "BetterJIT.loopback")
    private let token = UUID().uuidString.lowercased()
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private let assets: [String: (Data, String)]

    init() throws {
        guard let root = Bundle.main.url(forResource: "Web", withExtension: nil) else {
            throw NSError(domain: "BetterJIT", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing bundled Web assets"])
        }
        var files: [String: (Data, String)] = [:]
        for name in ["index.html", "app.mjs", "worker.mjs", "transport.mjs"] {
            files[name] = (try Data(contentsOf: root.appendingPathComponent(name)),
                           name.hasSuffix("html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8")
        }
        assets = files
    }

    func start(_ completion: @escaping (Result<URL, Error>) -> Void) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        var reported = false
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard !reported, let port = listener.port else { return }
                reported = true
                let url = URL(string: "http://127.0.0.1:\(port.rawValue)/\(self.token)/")!
                completion(.success(url))
            case .failed(let error):
                if !reported { reported = true; completion(.failure(error)) }
                self.stop()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.connections.count < 16 else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.start(queue: self.queue)
            self.receive(connection, id: id, data: Data())
            self.queue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.finish(id) }
        }
        listener.start(queue: queue)
    }

    private func finish(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }
    private func receive(_ connection: NWConnection, id: UUID, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] chunk, _, done, error in
            guard let self, self.connections[id] != nil else { return }
            var buffer = data
            if let chunk { buffer.append(chunk) }
            guard buffer.count <= 8192, error == nil else { self.finish(id); return }
            if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(connection, id: id, request: buffer)
            } else if done { self.finish(id) }
            else { self.receive(connection, id: id, data: buffer) }
        }
    }

    private func respond(_ connection: NWConnection, id: UUID, request: Data) {
        guard let text = String(data: request, encoding: .utf8), let port = listener?.port else { finish(id); return }
        let lines = text.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        let hosts = lines.filter { $0.lowercased().hasPrefix("host:") }
        let host = hosts.first?.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard parts.count == 3, parts[0] == "GET", parts[2] == "HTTP/1.1",
              hosts.count == 1, host == "127.0.0.1:\(port.rawValue)" else { finish(id); return }
        let prefix = "/\(token)/"
        let path = String(parts[1])
        guard path.hasPrefix(prefix) else { finish(id); return }
        let name = String(path.dropFirst(prefix.count))
        guard let (body, mime) = assets[name.isEmpty ? "index.html" : name] else { finish(id); return }
        let headers = [
            "HTTP/1.1 200 OK", "Content-Type: \(mime)", "Content-Length: \(body.count)",
            "Cache-Control: no-store", "Connection: close", "X-Content-Type-Options: nosniff",
            "Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Embedder-Policy: require-corp",
            "Cross-Origin-Resource-Policy: same-origin",
            "Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        ].joined(separator: "\r\n") + "\r\n\r\n"
        connection.send(content: Data(headers.utf8) + body, completion: .contentProcessed { [weak self] _ in self?.finish(id) })
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }
    deinit { listener?.cancel() }
}
