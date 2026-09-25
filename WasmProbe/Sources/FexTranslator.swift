import Foundation

/// The on-device translator: FEX's frontend and the fexwasm backend
/// (fexwasm/src/translator.h), linked into the app. The page's live runtime
/// (Web/fexlive.js) asks for units and regions under /xlat/ as the guest
/// runs; requests come in on the local HTTP server's queue.
final class FexTranslator {
    static let shared = FexTranslator()
    private let lock = NSLock()
    private var translator: OpaquePointer?
    /// Linux processes (fexwasm js/linux): a translator per space (process
    /// image), made on first use; units cached in Caches/xlat-cache.
    private var spaces: [UInt32: OpaquePointer] = [:]
    static var linuxOptions = "linux=1 depth=24"
    private lazy var cacheDir: String = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("xlat-cache")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }()

    // The embedded lab has a bounded lifetime; release all translated code
    // when it closes, without changing Iridium's normal runtime.
    func reset() {
        lock.lock(); defer { lock.unlock() }
        if let translator { fexwasm_destroy(translator) }
        translator = nil
        for t in spaces.values { fexwasm_destroy(t) }
        spaces.removeAll()
    }
    deinit { reset() }

    /// Handles /xlat/* (nil for other paths).
    func handle(path: String, query: [String: String], body: Data?, webRoot: URL) -> (status: Int, type: String, data: Data)? {
        guard path.hasPrefix("/xlat/") else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let sp = query["space"], let id = UInt32(sp) {
            return linux(path: path, space: id, query: query, body: body)
        }
        if path == "/xlat/init" {
            return start(dir: query["dir"] ?? "fex", options: query["opts"] ?? "", webRoot: webRoot)
        }
        guard let t = translator else { return (409, "text/plain", Data("no translator: call /xlat/init".utf8)) }
        switch path {
        case "/xlat/config": return json(fexwasm_config_json(t))
        case "/xlat/stats": return json(fexwasm_stats_json(t))
        case "/xlat/dispatcher": return bytes(fexwasm_dispatcher(t))
        case "/xlat/state": return bytes(fexwasm_state(t))
        case "/xlat/unit":
            return bytes(fexwasm_unit(t, UInt32(query["rip"] ?? "0") ?? 0))
        case "/xlat/region":
            let req = body ?? Data()
            return bytes(req.withUnsafeBytes { fexwasm_region(t, $0.bindMemory(to: UInt8.self).baseAddress, req.count) })
        default:
            return (404, "text/plain", Data("not found".utf8))
        }
    }

    private func linux(path: String, space: UInt32, query: [String: String], body: Data?) -> (status: Int, type: String, data: Data) {
        if path == "/xlat/drop" {
            if let t = spaces.removeValue(forKey: space) { fexwasm_destroy(t) }
            return (200, "text/plain", Data())
        }
        let t: OpaquePointer
        if let have = spaces[space] {
            t = have
        } else {
            guard let made = fexwasm_create(nil, 0, 0, "\(Self.linuxOptions) cache=\(cacheDir)") else {
                return (500, "text/plain", Data("fexwasm_create failed".utf8))
            }
            spaces[space] = made
            t = made
        }
        switch path {
        case "/xlat/config": return json(fexwasm_config_json(t))
        case "/xlat/stats": return json(fexwasm_stats_json(t))
        case "/xlat/dispatcher": return bytes(fexwasm_dispatcher(t))
        case "/xlat/state": return bytes(fexwasm_state(t))
        case "/xlat/unit": return bytes(fexwasm_unit(t, UInt32(query["rip"] ?? "0") ?? 0))
        case "/xlat/region":
            let req = body ?? Data()
            return bytes(req.withUnsafeBytes { fexwasm_region(t, $0.bindMemory(to: UInt8.self).baseAddress, req.count) })
        case "/xlat/code":
            let code = body ?? Data()
            let addr = UInt64(query["addr"] ?? "0", radix: 16) ?? 0
            code.withUnsafeBytes { fexwasm_map_code(t, addr, $0.bindMemory(to: UInt8.self).baseAddress, code.count) }
            return (200, "application/octet-stream", Data())
        case "/xlat/uncode":
            fexwasm_unmap_code(t, UInt64(query["addr"] ?? "0", radix: 16) ?? 0, UInt64(query["size"] ?? "0", radix: 16) ?? 0)
            return (200, "application/octet-stream", Data())
        default:
            return (404, "text/plain", Data("not found".utf8))
        }
    }

    /// A translator for the guest image of a dump directory (its image.bin at
    /// the address config.json gives).
    private func start(dir: String, options: String, webRoot: URL) -> (status: Int, type: String, data: Data) {
        if let t = translator { fexwasm_destroy(t); translator = nil }
        guard let root = ProbeHTTP.file(dir, beneath: webRoot) else {
            return (403, "text/plain", Data("invalid fixture directory".utf8))
        }
        guard let cfgData = try? Data(contentsOf: root.appendingPathComponent("config.json")),
              let cfg = (try? JSONSerialization.jsonObject(with: cfgData)) as? [String: Any],
              let hi = (cfg["windowHi"] as? NSNumber)?.uint64Value, let lo = (cfg["imageLow"] as? NSNumber)?.uint64Value,
              let image = try? Data(contentsOf: root.appendingPathComponent("image.bin")) else {
            return (404, "text/plain", Data("no dump at \(dir)".utf8))
        }
        let t0 = DispatchTime.now().uptimeNanoseconds
        translator = image.withUnsafeBytes { buf in
            fexwasm_create(buf.bindMemory(to: UInt8.self).baseAddress, image.count, (hi << 32) | lo, options)
        }
        guard let t = translator else { return (500, "text/plain", Data("fexwasm_create failed".utf8)) }
        Log.result(["suite": "xlat", "event": "init", "dir": dir, "options": options,
                    "ms": Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6])
        return json(fexwasm_config_json(t))
    }

    private func json(_ s: UnsafePointer<CChar>?) -> (status: Int, type: String, data: Data) {
        guard let s else { return (500, "text/plain", Data("translator returned no JSON".utf8)) }
        return (200, "application/json", Data(String(cString: s).utf8))
    }
    private func bytes(_ b: fexwasm_bytes) -> (status: Int, type: String, data: Data) {
        (200, "application/octet-stream", b.size > 0 ? Data(bytes: b.data, count: b.size) : Data())
    }
}
