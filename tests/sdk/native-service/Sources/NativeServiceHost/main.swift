// SPDX-License-Identifier: GPL-3.0-or-later
// Test-only stdio adapter: this exercises a real NativeService in a separate
// Swift process. It is NOT WKWebView, a production daemon, or FEX translation.
import Foundation
import BetterJIT
let service: NativeService = { input in
    guard let text = input.string, text.utf8.count <= 8,
          let data = Data(base64Encoded: text), data.count == 4,
          data.base64EncodedString() == text else { throw RuntimeFault("invalidInput", "Expected one little-endian u32.") }
    let n = data.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * $1.offset) }
    let value = n &* 2
    return .string(Data((0..<4).map { UInt8(truncatingIfNeeded: value >> (8 * $0)) }).base64EncodedString())
}
while let line = readLine() {
    do {
        guard line.utf8.count <= 1024 else { throw RuntimeFault("invalidInput", "Test message too large.") }
        let request = try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
        guard request["service"] == .string("host.1"), let payload = request["payload"] else {
            throw RuntimeFault("serviceDenied", "Unregistered test service.")
        }
        let answer = try await service(payload)
        print(String(decoding: try JSONEncoder().encode(JSONValue.object(["result": answer])), as: UTF8.self))
    } catch {
        print("{\"error\":\"nativeService\"}")
    }
    fflush(stdout)
}
