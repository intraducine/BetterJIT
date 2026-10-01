import Foundation
import Network

/// Loopback-only HTTP/1.1 server (keep-alive, Content-Length bodies) so the
/// page can be loaded from http://127.0.0.1 — a secure context that can be
/// cross-origin isolated.
final class HTTPServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "http-server")
    let webRoot: URL

    init(webRoot: URL) throws {
        self.webRoot = webRoot
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        // Fixed port: the origin (and so its OPFS directory) stays the same across launches.
        listener = try NWListener(using: params, on: 47113)
    }

    func start(onReady: @escaping (UInt16) -> Void) {
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = self?.listener.port?.rawValue { DispatchQueue.main.async { onReady(port) } }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            HTTPConnection(conn: conn, queue: self.queue, webRoot: self.webRoot).start()
        }
        listener.start(queue: queue)
    }
}

private final class HTTPConnection {
    let conn: NWConnection
    let queue: DispatchQueue
    let webRoot: URL
    var buf = Data()
    var selfRef: HTTPConnection?

    init(conn: NWConnection, queue: DispatchQueue, webRoot: URL) {
        self.conn = conn; self.queue = queue; self.webRoot = webRoot
    }

    func start() {
        selfRef = self
        conn.start(queue: queue)
        receive()
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.buf.append(data); self.process() }
            if isComplete || error != nil { self.conn.cancel(); self.selfRef = nil; return }
            self.receive()
        }
    }

    private func process() {
        let sep = Data("\r\n\r\n".utf8)
        while let r = buf.range(of: sep) {
            let head = String(decoding: buf[buf.startIndex..<r.lowerBound], as: UTF8.self)
            let lines = head.components(separatedBy: "\r\n")
            let parts = lines.first?.split(separator: " ") ?? []
            guard parts.count >= 2 else { conn.cancel(); return }
            var contentLength = 0
            for l in lines.dropFirst() {
                let kv = l.split(separator: ":", maxSplits: 1)
                if kv.count == 2, kv[0].lowercased() == "content-length" {
                    contentLength = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }
            let bodyStart = r.upperBound
            guard buf.count - (bodyStart - buf.startIndex) >= contentLength else { return }
            let body = buf.subdata(in: bodyStart..<(bodyStart + contentLength))
            buf = buf.subdata(in: (bodyStart + contentLength)..<buf.endIndex)

            let method = String(parts[0])
            let comps = URLComponents(string: String(parts[1]))
            var query: [String: String] = [:]
            comps?.queryItems?.forEach { query[$0.name] = $0.value ?? "" }
            let res = SchemeHandler.route(method: method, path: comps?.path ?? "/", query: query,
                                          body: method == "POST" ? body : nil, webRoot: webRoot)
            var head2 = "HTTP/1.1 \(res.status) OK\r\nContent-Type: \(res.type)\r\nContent-Length: \(res.data.count)\r\nConnection: keep-alive\r\n"
            for (k, v) in SchemeHandler.isolationHeaders { head2 += "\(k): \(v)\r\n" }
            head2 += "\r\n"
            var out = Data(head2.utf8)
            out.append(res.data)
            conn.send(content: out, completion: .contentProcessed { _ in })
        }
    }
}

/// Loopback WebSocket server. First byte of each binary message selects the
/// reply: 0 = echo, 1 = reply with the received length, 2 = reply with N bytes
/// (N = little-endian u32 at bytes 1...4).
final class WSServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "ws-server")
    private var conns: [NWConnection] = []

    init() throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 64 << 20
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: 47114)
    }

    func start(onReady: @escaping (UInt16) -> Void) {
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = self?.listener.port?.rawValue { DispatchQueue.main.async { onReady(port) } }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            self.conns.append(conn)
            conn.start(queue: self.queue)
            self.receive(conn)
        }
        listener.start(queue: queue)
    }

    private func receive(_ conn: NWConnection) {
        conn.receiveMessage { [weak self] content, _, _, error in
            guard let self else { return }
            if error != nil { conn.cancel(); return }
            if let data = content, !data.isEmpty {
                let mode = data[data.startIndex]
                var reply: Data
                // 0x10/0x11: translator requests (u32 id, then a unit's u32 RIP or a
                // region request); the reply is the id and the /xlat/ body.
                if mode == 0x10 || mode == 0x11, data.count >= 5 {
                    let id = data.subdata(in: (data.startIndex + 1)..<(data.startIndex + 5))
                    let rest = data.subdata(in: (data.startIndex + 5)..<data.endIndex)
                    var query: [String: String] = [:]
                    if mode == 0x10, rest.count >= 4 {
                        var rip: UInt32 = 0
                        _ = withUnsafeMutableBytes(of: &rip) { rest.copyBytes(to: $0, count: 4) }
                        query["rip"] = String(rip)
                    }
                    let r = FexTranslator.shared.handle(path: mode == 0x10 ? "/xlat/unit" : "/xlat/region", query: query,
                                                        body: mode == 0x11 ? rest : nil, webRoot: URL(fileURLWithPath: "/"))
                    reply = id
                    reply.append(r?.data ?? Data())
                    let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
                    let ctx = NWConnection.ContentContext(identifier: "xlat", metadata: [meta])
                    conn.send(content: reply, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
                    self.receive(conn)
                    return
                }
                switch mode {
                case 1:
                    var n = UInt32(data.count)
                    reply = Data(bytes: &n, count: 4)
                case 2:
                    var n: UInt32 = 0
                    if data.count >= 5 { _ = withUnsafeMutableBytes(of: &n) { data[(data.startIndex + 1)...].copyBytes(to: $0, count: 4) } }
                    reply = SchemeHandler.blob.prefix(Int(n))
                default:
                    reply = data
                }
                let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
                let ctx = NWConnection.ContentContext(identifier: "reply", metadata: [meta])
                conn.send(content: reply, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
            }
            self.receive(conn)
        }
    }
}
