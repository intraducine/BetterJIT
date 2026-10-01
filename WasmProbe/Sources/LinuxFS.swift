import Foundation

/// The guest file system for fexwasm's Linux kernel page (js/linux/web):
/// Documents/linuxroot, staged on the Mac by madeira-wasm/build/stage-device-root.sh
/// and copied over with devicectl. The page's kernel worker reads the index
/// once and fetches files as it first opens them; it posts its output to /log.
enum LinuxFS {
    static let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("linuxroot")
    private static let lock = NSLock()
    /// The page's exit status once it has reported one ([page] exit N).
    static var exitCode: Int? {
        get { lock.lock(); defer { lock.unlock() }; return _exit }
        set { lock.lock(); _exit = newValue; lock.unlock() }
    }
    private static var _exit: Int?

    /// [[path, type, mode, size, mtimeMs, target?], ...] for everything under root.
    static func index() -> (status: Int, type: String, data: Data) {
        let fm = FileManager.default
        var entries: [[Any]] = []
        func walk(_ url: URL, _ guest: String) {
            guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return }
            let type = attrs[.type] as? FileAttributeType
            let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0o644
            let mtime = ((attrs[.modificationDate] as? Date) ?? Date()).timeIntervalSince1970 * 1000
            if type == .typeSymbolicLink {
                let t = (try? fm.destinationOfSymbolicLink(atPath: url.path)) ?? ""
                if t == "fexwasm:socket" { return }
                entries.append([guest, "l", 0o777, t.utf8.count, mtime, t])
            } else if type == .typeDirectory {
                entries.append([guest, "d", mode, 0, mtime])
                if guest == "/tmp" { return }
                for name in (try? fm.contentsOfDirectory(atPath: url.path)) ?? [] {
                    walk(url.appendingPathComponent(name), (guest == "/" ? "" : guest) + "/" + name)
                }
            } else if type == .typeRegular {
                entries.append([guest, "f", mode, (attrs[.size] as? NSNumber)?.intValue ?? 0, mtime])
            }
        }
        walk(root, "/")
        // symlinks travel as a manifest (devicectl won't copy links whose target has '..')
        entries.removeAll { ($0[0] as? String) == "/.symlinks.json" }
        if let d = try? Data(contentsOf: root.appendingPathComponent(".symlinks.json")),
           let links = (try? JSONSerialization.jsonObject(with: d)) as? [String: String] {
            for (path, target) in links.sorted(by: { $0.key < $1.key }) {
                entries.append([path, "l", 0o777, target.utf8.count, Date().timeIntervalSince1970 * 1000, target])
            }
        }
        for d in ["/proc", "/dev", "/sys", "/tmp", "/usr", "/usr/bin", "/bin"] where !entries.contains(where: { ($0[0] as? String) == d }) {
            entries.append([d, "d", 0o755, 0, Date().timeIntervalSince1970 * 1000])
        }
        let obj: [String: Any] = ["entries": entries, "uid": Int(getuid()), "gid": Int(getgid())]
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        return (200, "application/json", data)
    }

    static func file(_ guest: String) -> (status: Int, type: String, data: Data) {
        if guest.contains("/../") || guest.hasSuffix("/..") { return (403, "text/plain", Data()) }
        if let d = try? Data(contentsOf: root.appendingPathComponent(String(guest.drop(while: { $0 == "/" })))) {
            return (200, "application/octet-stream", d)
        }
        return (404, "text/plain", Data("no \(guest)".utf8))
    }

    /// A picture of the guest's screen (PNG) the page posts: Documents/<name>.png.
    static func shot(_ body: Data?, name: String) -> (status: Int, type: String, data: Data) {
        let safe = name.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("\(safe.isEmpty ? "shot" : safe).png")
        try? (body ?? Data()).write(to: url)
        Log.line("@@L [app] saved \(url.lastPathComponent) (\(body?.count ?? 0) bytes)")
        return (200, "text/plain", Data())
    }

    static func log(_ body: Data?) -> (status: Int, type: String, data: Data) {
        let text = String(decoding: body ?? Data(), as: UTF8.self)
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            Log.line("@@L " + line)
            if line.hasPrefix("[page] exit "), let code = Int(line.dropFirst(12).split(separator: " ").first ?? "") {
                exitCode = code
            }
        }
        return (200, "text/plain", Data())
    }
}
