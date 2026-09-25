import Foundation
import Network

/// Bundled test assets and FEX requests only, on IPv4 loopback. A fresh
/// capability path isolates each lab session; there is no filesystem, Wine,
/// arbitrary upload, proxy, or game-launch endpoint in this add-on.
final class BetterJITLabServer {
    private let queue = DispatchQueue(label: "BetterJIT.private-lab")
    private let token = UUID().uuidString.lowercased()
    private let assets: [String: (Data, String)]
    private let webRoot: URL
    private let translator = FexTranslator()
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var stopped = false

    init(webRoot: URL) throws {
        self.webRoot = webRoot
        var assets: [String: (Data, String)] = [:]
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                     "css": "text/css; charset=utf-8", "json": "application/json"]
        for path in ["index.html", "lab.js", "lab.css", "fexruntime.js", "fexlive.js",
                     "fex/config.json", "fex/image.bin", "fexw64/config.json", "fexw64/image.bin"] {
            let url = webRoot.appendingPathComponent(path)
            assets["/" + path] = (try Data(contentsOf: url), types[url.pathExtension] ?? "application/octet-stream")
        }
        self.assets = assets
    }

    func start(_ completion: @escaping (Result<URL, Error>) -> Void) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        self.listener = listener
        var reported = false
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard !reported, let port = listener.port else { return }
                reported = true
                completion(.success(URL(string: "http://127.0.0.1:\(port.rawValue)/\(self.token)/")!))
            case .failed(let error):
                if !reported { reported = true; completion(.failure(error)) }
                self.stop()
            case .cancelled:
                if !reported {
                    reported = true
                    completion(.failure(NSError(domain: "BetterJIT", code: 1,
                                                userInfo: [NSLocalizedDescriptionKey: "Lab server stopped"])))
                }
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, !self.stopped, self.connections.count < 16 else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.start(queue: self.queue)
            self.receive(connection, id: id, buffered: Data())
            self.queue.asyncAfter(deadline: .now() + 120) { [weak self] in self?.finish(id) }
        }
        listener.start(queue: queue)
    }

    func stop() {
        queue.async { [self] in
            stopped = true
            listener?.cancel()
            for c in connections.values { c.cancel() }
            connections.removeAll()
            translator.reset()
        }
    }

    private func finish(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }

    private func receive(_ connection: NWConnection, id: UUID, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 << 10) { [weak self] data, _, done, error in
            guard let self, !self.stopped, self.connections[id] != nil else { return }
            var buffer = buffered
            if let data { buffer.append(data) }
            do {
                // A response is sent once, then the socket closes. This avoids
                // ambiguous pipelining and keeps native request ownership simple.
                if let request = try ProbeHTTP.pop(&buffer, maxBody: 8 << 20) {
                    let response = self.route(request)
                    self.send(connection, id: id, response: response)
                    return
                }
            } catch let failure as ProbeHTTP.Failure {
                self.send(connection, id: id, response: (failure.status, "text/plain", Data(failure.message.utf8)))
                return
            } catch {
                self.send(connection, id: id, response: (400, "text/plain", Data()))
                return
            }
            if done || error != nil { self.finish(id); return }
            self.receive(connection, id: id, buffered: buffer)
        }
    }

    private func route(_ r: ProbeHTTP.Request) -> (Int, String, Data) {
        guard let c = URLComponents(string: r.target), c.path.hasPrefix("/\(token)/") else {
            return (404, "text/plain", Data())
        }
        let path = "/" + c.path.dropFirst(token.count + 2)
        var q: [String: String] = [:]
        for item in c.queryItems ?? [] {
            guard q[item.name] == nil else { return (400, "text/plain", Data()) }
            q[item.name] = item.value ?? ""
        }
        if r.method == "GET", let asset = assets[path] {
            return (200, asset.1, asset.0)
        }
        let allowed = ["/xlat/init", "/xlat/config", "/xlat/dispatcher", "/xlat/state", "/xlat/unit", "/xlat/region", "/xlat/stats"]
        guard allowed.contains(path), q["space"] == nil,
              r.method == (path == "/xlat/region" ? "POST" : "GET") else { return (404, "text/plain", Data()) }
        switch path {
        case "/xlat/init":
            guard let dir = q["dir"], ["fex", "fexw64"].contains(dir), q.count == 1 else { return (400, "text/plain", Data()) }
            q["opts"] = dir == "fexw64" ? "abi=win64" : "abi=sysv"
        case "/xlat/unit":
            guard q.count == 1, let rip = q["rip"], UInt32(rip) != nil else { return (400, "text/plain", Data()) }
        default:
            guard q.isEmpty else { return (400, "text/plain", Data()) }
        }
        guard let response = translator.handle(path: path, query: q, body: r.body, webRoot: webRoot) else {
            return (404, "text/plain", Data())
        }
        return (response.status, response.type, response.data)
    }

    private func send(_ c: NWConnection, id: UUID, response: (Int, String, Data)) {
        let (status, type, data) = response
        let headers = "HTTP/1.1 \(status) Response\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\nConnection: close\r\nCache-Control: no-store\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'\r\n\r\n"
        var out = Data(headers.utf8)
        out.append(data)
        c.send(content: out, completion: .contentProcessed { [weak self] _ in self?.finish(id) })
    }
}
