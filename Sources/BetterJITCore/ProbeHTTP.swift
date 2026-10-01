import Foundation

/// Small HTTP/1 framing parser shared with the FEX probe's loopback server.
/// Only Content-Length framing is supported; ambiguous framing is rejected.
public enum ProbeHTTP {
    public struct Request {
        public let method: String
        public let target: String
        public let body: Data
    }
    public struct Failure: Error {
        public let status: Int
        public let message: String
    }
    public static func pop(_ buffer: inout Data, maxHeader: Int = 16 << 10,
                           maxBody: Int = 64 << 20) throws -> Request? {
        guard maxHeader >= 4, maxBody >= 0 else { throw Failure(status: 500, message: "Invalid parser limits") }
        guard let separator = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            if buffer.count > maxHeader { throw Failure(status: 431, message: "Header too large") }
            return nil
        }
        let headerSize = buffer.distance(from: buffer.startIndex, to: separator.upperBound)
        guard headerSize <= maxHeader else { throw Failure(status: 431, message: "Header too large") }
        guard let header = String(data: buffer[buffer.startIndex..<separator.lowerBound], encoding: .utf8) else {
            throw Failure(status: 400, message: "Invalid header encoding")
        }
        let lines = header.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard request.count == 3, !request[0].isEmpty,
              request[0].utf8.allSatisfy({ (65...90).contains($0) }),
              request[1].hasPrefix("/"), !request[1].hasPrefix("//"),
              request[1].utf8.allSatisfy({ $0 > 32 && $0 != 127 }),
              request[2] == "HTTP/1.1" || request[2] == "HTTP/1.0" else {
            throw Failure(status: 400, message: "Invalid request line")
        }
        var length: Int?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
                throw Failure(status: 400, message: "Invalid header")
            }
            let name = line[..<colon]
            let token = "!#$%&'*+-.^_`|~".utf8
            guard name.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) ||
                (48...57).contains($0) || token.contains($0) }) else {
                throw Failure(status: 400, message: "Invalid header name")
            }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard value.utf8.allSatisfy({ $0 == 9 || ($0 >= 32 && $0 != 127) }) else {
                throw Failure(status: 400, message: "Invalid header value")
            }
            if name.lowercased() == "transfer-encoding" {
                throw Failure(status: 400, message: "Transfer-Encoding is not supported")
            }
            if name.lowercased() == "content-length" {
                guard length == nil, !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }),
                      let n = Int(value) else { throw Failure(status: 400, message: "Invalid Content-Length") }
                guard n <= maxBody else { throw Failure(status: 413, message: "Body too large") }
                length = n
            }
        }
        let bodySize = length ?? 0
        guard buffer.count - headerSize >= bodySize else { return nil }
        let end = buffer.index(separator.upperBound, offsetBy: bodySize)
        let body = buffer.subdata(in: separator.upperBound..<end)
        buffer.removeSubrange(buffer.startIndex..<end)
        return Request(method: String(request[0]), target: String(request[1]), body: body)
    }

    /// Resolve a relative path without escaping an app-owned root, including
    /// through existing symlinks. Callers must keep this root app-controlled.
    public static func file(_ relative: String, beneath root: URL) -> URL? {
        guard !relative.hasPrefix("/"), !relative.contains("\0"),
              !relative.split(separator: "/").contains("..") else { return nil }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        var candidate = base
        // Resolve existing ancestors separately: Foundation may leave the entire
        // path unresolved when its final component does not exist yet.
        for part in relative.split(separator: "/") {
            candidate = candidate.appendingPathComponent(String(part)).standardizedFileURL.resolvingSymlinksInPath()
            guard candidate.path == base.path || candidate.path.hasPrefix(base.path + "/") else { return nil }
        }
        return candidate.path == base.path ? nil : candidate
    }
}
