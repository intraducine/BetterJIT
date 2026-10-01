import Foundation
import WebKit

/// Serves probe://app/... from the bundle's Web folder, plus the IPC test
/// endpoints (/sink, /rpc, /blob). Sends the headers needed for
/// cross-origin isolation, to see whether a custom scheme can get it.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    let webRoot: URL
    private var active = Set<ObjectIdentifier>()
    static let blob = Data(repeating: 0xA5, count: 64 << 20)

    init(webRoot: URL) { self.webRoot = webRoot }

    static let isolationHeaders = [
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
    ]

    static func contentType(_ path: String) -> String {
        switch (path as NSString).pathExtension {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }

    /// Shared by the scheme handler and the localhost HTTP server.
    static func route(method: String, path: String, query: [String: String], body: Data?, webRoot: URL)
        -> (status: Int, type: String, data: Data) {
        if let r = FexTranslator.shared.handle(path: path, query: query, body: body, webRoot: webRoot) { return r }
        switch path {
        case "/fs/index": return LinuxFS.index()
        case "/fs/file": return LinuxFS.file(query["p"] ?? "")
        case "/log": return LinuxFS.log(body)
        case "/shot": return LinuxFS.shot(body, name: query["name"] ?? "shot")
        case "/sink":
            return (200, "text/plain", Data("\(body?.count ?? -1)".utf8))
        case "/rpc":
            return (200, "text/plain", Data("ok".utf8))
        case "/blob":
            let n = min(Int(query["n"] ?? "0") ?? 0, blob.count)
            return (200, "application/octet-stream", blob.prefix(n))
        default:
            let rel = path == "/" ? "index.html" : String(path.dropFirst())
            let file = webRoot.appendingPathComponent(rel)
            if let data = try? Data(contentsOf: file) { return (200, contentType(rel), data) }
            return (404, "text/plain", Data("not found".utf8))
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        active.insert(id)
        let req = task.request
        guard let url = req.url else { return }
        var query: [String: String] = [:]
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.forEach { query[$0.name] = $0.value ?? "" }
        var body = req.httpBody
        if body == nil, let stream = req.httpBodyStream { body = SchemeHandler.readAll(stream) }
        let r = SchemeHandler.route(method: req.httpMethod ?? "GET", path: url.path, query: query, body: body, webRoot: webRoot)
        var headers = SchemeHandler.isolationHeaders
        headers["Content-Type"] = r.type
        headers["Content-Length"] = "\(r.data.count)"
        let resp = HTTPURLResponse(url: url, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: headers)!
        guard active.contains(id) else { return }
        task.didReceive(resp)
        task.didReceive(r.data)
        task.didFinish()
        active.remove(id)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }

    static func readAll(_ stream: InputStream) -> Data {
        var out = Data()
        stream.open()
        defer { stream.close() }
        let bufSize = 1 << 20
        let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
        defer { buf.deallocate() }
        while true {
            let n = stream.read(buf, maxLength: bufSize)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        return out
    }
}
