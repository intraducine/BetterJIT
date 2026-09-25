import Foundation

/// Results go to stdout (captured by `devicectl ... --console`) as `@@R {json}`
/// lines, and are mirrored to Documents/results.jsonl.
enum Log {
    private static let lock = NSLock()
    private static let fileURL: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("results.jsonl")
    }()

    static func line(_ s: String) {
        lock.lock(); defer { lock.unlock() }
        print(s)
        fflush(stdout)
        if let data = (s + "\n").data(using: .utf8) {
            if let h = try? FileHandle(forWritingTo: fileURL) {
                h.seekToEndOfFile(); h.write(data); try? h.close()
            } else {
                try? data.write(to: fileURL)
            }
        }
    }

    static func result(_ dict: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8) else {
            line("@@R {\"error\":\"unserialisable result\",\"desc\":\"\(dict)\"}")
            return
        }
        line("@@R " + s)
    }

    /// Merges extra keys into a JSON object string produced by JS.
    static func resultJSON(_ json: String, extra: [String: Any]) {
        guard let data = json.data(using: .utf8),
              var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            line("@@R " + json)
            return
        }
        for (k, v) in extra where obj[k] == nil { obj[k] = v }
        result(obj)
    }
}
