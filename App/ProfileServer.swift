import Foundation
import Network

/// Short-lived, loopback-only profile download for Safari. No remote server,
/// certificate installation, VPN entitlement, or silent profile installation.
/// All calls and Network callbacks are serialized on the main queue.
final class ProfileServer {
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var token = ""
    private var profile = Data()
    private var expiry: DispatchWorkItem?
    private var completion: ((Result<URL, Error>) -> Void)?

    func start(profile: Data, completion: @escaping (Result<URL, Error>) -> Void) {
        stop()
        self.profile = profile
        self.completion = completion
        token = UUID().uuidString
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self, self.listener === listener else { return }
                switch state {
                case .ready:
                    guard let port = listener?.port,
                          let url = URL(string: "http://127.0.0.1:\(port.rawValue)/\(self.token)/BetterJIT.mobileconfig") else { return }
                    self.completion?(.success(url)); self.completion = nil
                case .failed(let error):
                    self.completion?(.failure(error)); self.completion = nil; self.stop()
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: .main)
            let expiry = DispatchWorkItem { [weak self] in self?.stop() }
            self.expiry = expiry
            DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: expiry)
        } catch {
            self.completion = nil; completion(.failure(error)); stop()
        }
    }

    func stop() {
        expiry?.cancel(); expiry = nil
        listener?.cancel(); listener = nil
        connections.values.forEach { $0.cancel() }; connections.removeAll()
        completion = nil; profile = Data(); token = ""
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 4 else { connection.cancel(); return }
        guard case .hostPort(let host, _) = connection.endpoint, String(describing: host) == "127.0.0.1" else {
            connection.cancel(); return
        }
        let id = UUID()
        connections[id] = connection
        connection.start(queue: .main)
        read(connection, id: id, received: Data())
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self, weak connection] in
            connection?.cancel(); self?.connections.removeValue(forKey: id)
        }
    }

    private func read(_ connection: NWConnection, id: UUID, received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            guard let self, self.connections[id] != nil else { return }
            let request = received + (data ?? Data())
            if request.count > 8192 || error != nil { self.close(id); return }
            guard request.range(of: Data("\r\n\r\n".utf8)) != nil else {
                if complete { self.close(id) } else { self.read(connection, id: id, received: request) }
                return
            }
            let line = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
            let valid = line == "GET /\(self.token)/BetterJIT.mobileconfig HTTP/1.1"
                || line == "GET /\(self.token)/BetterJIT.mobileconfig HTTP/1.0"
            let body = valid ? self.profile : Data("Not found".utf8)
            let status = valid ? "200 OK" : "404 Not Found"
            let mime = valid ? "application/x-apple-aspen-config" : "text/plain"
            let header = "HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(header.utf8) + body, completion: .contentProcessed { [weak self] _ in self?.close(id) })
        }
    }

    private func close(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }
}
