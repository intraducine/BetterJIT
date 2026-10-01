// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// Strict single-request parser for serving immutable SDK assets, not an API
/// server. Exact paths and Host are used instead of resolving arbitrary files.
public enum LoopbackRequest {
    public static func assetPath(header: Data, port: UInt16, allowed: Set<String>) throws -> String {
        guard header.count <= 8192, let text = String(data: header, encoding: .ascii), text.hasSuffix("\r\n\r\n") else {
            throw RuntimeFault("badRequest", "Invalid HTTP header.")
        }
        let lines = text.components(separatedBy: "\r\n")
        let request = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard request.count == 3, request[0] == "GET", request[2] == "HTTP/1.1" else {
            throw RuntimeFault("badRequest", "Only bodyless GET requests are accepted.")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":"), line.first != " ", line.first != "\t" else {
                throw RuntimeFault("badRequest", "Malformed HTTP field.")
            }
            let key = line[..<colon].lowercased()
            guard !key.isEmpty, !key.contains(where: { $0 == " " || $0 == "\t" }), headers[key] == nil else {
                throw RuntimeFault("badRequest", "Duplicate or malformed HTTP field.")
            }
            headers[key] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        guard headers["host"] == "127.0.0.1:\(port)", headers["transfer-encoding"] == nil,
              headers["content-length"] == nil || headers["content-length"] == "0",
              allowed.contains(String(request[1])) else {
            throw RuntimeFault("badRequest", "Unrecognized host, asset or body framing.")
        }
        return String(request[1])
    }
}
