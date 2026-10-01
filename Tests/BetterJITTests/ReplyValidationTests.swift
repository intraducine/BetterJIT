// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJIT
final class ReplyValidationTests: XCTestCase {
    @MainActor func testMalformedRepliesCloseSession() async throws {
        for operation in ["invoke", "read", "batch", "statistics"] {
            let t = BadReplyTransport()
            let s = try RuntimeSession(transport: t, limits: RuntimeLimits())
            try await s.start()
            do {
                switch operation {
                case "invoke": _ = try await s.invoke("m", export: "run")
                case "read": _ = try await s.readMemory(at: 0, count: 1)
                case "batch": _ = try await s.invokeBatch([WasmInvocation(module: "m", export: "run")])
                default: _ = try await s.statistics()
                }
                XCTFail("Malformed reply accepted")
            } catch { XCTAssertEqual((error as? RuntimeFault)?.code, "protocolValue") }
            XCTAssertEqual(s.state, .failed); XCTAssertEqual(t.closed, 1)
        }
    }
}
@MainActor private final class BadReplyTransport: RuntimeTransport {
    var closed = 0
    func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities { .init(wasm: true, jspi: false, sharedMemory: false, opfs: false, extensions: ["batch", "statistics"]) }
    func request(_ operation: String, payload: JSONValue) async throws -> JSONValue { .string("invalid") }
    func close() { closed += 1 }
}
