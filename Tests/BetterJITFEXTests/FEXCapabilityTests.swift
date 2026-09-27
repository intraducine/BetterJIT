// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import BetterJIT
import BetterJITFEX
final class FEXCapabilityTests: XCTestCase {
    @MainActor func testLegacySingleArgumentAndExplicitExtensionNegotiation() async throws {
        for modern in [false,true] {
            let transport = CallTransport(modern: modern)
            let session = try RuntimeSession(transport: transport, limits: RuntimeLimits())
            try await session.start()
            let value = try await session.callFEX(entry: 4, argument: UInt64.max)
            XCTAssertEqual(value, 42)
            if modern { XCTAssertEqual(transport.payload?["arguments"], .array([.string(String(UInt64.max))])) }
            else { XCTAssertEqual(transport.payload?["argument"], .string(String(UInt64.max))) }
            let before = transport.calls
            do {
                _ = try await session.callFEX(entry: 4, arguments: [])
                XCTAssertTrue(modern)
            } catch { XCTAssertFalse(modern); XCTAssertEqual(transport.calls, before) }
            session.close()
        }
    }
}
@MainActor private final class CallTransport: RuntimeTransport {
    let modern: Bool
    var payload: JSONValue?
    var calls = 0
    init(modern: Bool) { self.modern = modern }
    func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities {
        .init(wasm: true, jspi: true, sharedMemory: false, opfs: false, extensions: modern ? ["fex.integerArguments"] : [])
    }
    func request(_ operation: String, payload: JSONValue) async throws -> JSONValue {
        calls += 1; self.payload = payload; return .string("42")
    }
    func close() {}
}
