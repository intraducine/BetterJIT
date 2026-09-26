// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJIT

final class RuntimeTests: XCTestCase {
    func testExactIntegerWireRoundTrip() throws {
        for value in [Int64.min, -1, 0, 9_007_199_254_740_993, Int64.max] {
            let wire = try JSONValue.encoding(WasmValue.i64(value))
            XCTAssertEqual(wire["value"], .string(String(value)))
            let restored = try wire.decode(WasmValue.self)
            try restored.validate(); XCTAssertEqual(restored, .i64(value))
        }
    }
    func testRejectInvalidNumbersAndLimits() throws {
        XCTAssertThrowsError(try RuntimeLimits(initialMemoryPages: 17, maximumMemoryPages: 16))
        XCTAssertThrowsError(try RuntimeLimits(timeoutSeconds: .nan))
        XCTAssertThrowsError(try RuntimeLimits(maximumMemoryPages: 65537))
        XCTAssertThrowsError(try WasmValue.f64(.infinity))
        for s in ["+2", "01", "-0", "9223372036854775808", "9.0"] {
            let value = try JSONValue.object(["type": .string("i64"), "value": .string(s)]).decode(WasmValue.self)
            XCTAssertThrowsError(try value.validate())
        }
    }
    func testDecodedLimitsAreRevalidated() throws {
        let valid = try JSONValue.encoding(RuntimeLimits())
        guard case .object(var fields) = valid else { return XCTFail() }
        fields["maximumPendingRequests"] = .number(100000)
        let decoded = try JSONValue.object(fields).decode(RuntimeLimits.self)
        XCTAssertThrowsError(try decoded.validated())
    }
    func testStrictAssetRequestParser() throws {
        let valid = "GET /secret/index.html HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n"
        XCTAssertEqual(try LoopbackRequest.assetPath(header: Data(valid.utf8), port: 1234, allowed: ["/secret/index.html"]), "/secret/index.html")
        for header in [
            valid.replacingOccurrences(of: "127.0.0.1", with: "evil.example"),
            valid.replacingOccurrences(of: "GET", with: "POST"),
            valid.replacingOccurrences(of: "/secret/index.html", with: "/secret/../index.html"),
            valid.replacingOccurrences(of: "\r\n\r\n", with: "\r\nContent-Length: -1\r\n\r\n"),
            valid.replacingOccurrences(of: "\r\n\r\n", with: "\r\nTransfer-Encoding: chunked\r\n\r\n"),
            valid.replacingOccurrences(of: "\r\n\r\n", with: "\r\nHost: 127.0.0.1:1234\r\n\r\n"),
            valid.replacingOccurrences(of: "\r\n\r\n", with: "\r\n Host: 127.0.0.1:1234\r\n\r\n")
        ] { XCTAssertThrowsError(try LoopbackRequest.assetPath(header: Data(header.utf8), port: 1234, allowed: ["/secret/index.html"])) }
    }
    @MainActor func testSessionLifecycleAndMemoryBounds() async throws {
        let transport = EchoTransport()
        let session = try RuntimeSession(transport: transport, limits: RuntimeLimits())
        do { _ = try await session.request("read"); XCTFail() } catch {}
        let caps = try await session.start(); XCTAssertTrue(caps.wasm)
        do { _ = try await session.start(); XCTFail() } catch {}
        do { try await session.writeMemory(at: UInt32.max, bytes: Data([1,2])); XCTFail() } catch {}
        let bytes = Data([0,97,115,109,1,0,0,0])
        let module = try await session.load(bytes, as: "module")
        XCTAssertEqual(module, "module")
        session.close(); session.close()
        XCTAssertEqual(session.state, .closed)
        do { _ = try await session.request("read"); XCTFail() } catch {}
    }
    @MainActor private func awaitValue<T>(_ work: () async throws -> T) async rethrows -> T { try await work() }
    @MainActor func testBrokerOutOfOrderDuplicateAndStaleReplies() async throws {
        var messages: [RPCMessage] = []
        let broker = RequestBroker(limits: try RuntimeLimits(), send: { messages.append($0) }, abort: {})
        let a = Task { try await broker.request("first") }
        let b = Task { try await broker.request("second") }
        while messages.count < 2 { await Task.yield() }
        for m in messages.reversed() {
            broker.receive(RPCMessage(session: "other", id: m.id, kind: "response", payload: .string("wrong")))
            broker.receive(RPCMessage(session: broker.session, id: m.id, kind: "response", payload: .string(m.operation!)))
            broker.receive(RPCMessage(session: broker.session, id: m.id, kind: "response", payload: .string("duplicate")))
        }
        let av = try await a.value, bv = try await b.value
        XCTAssertEqual(av, .string("first")); XCTAssertEqual(bv, .string("second"))
        XCTAssertEqual(broker.pendingCount, 0); broker.close()
    }
    @MainActor func testTimeoutAbortsWorkerAndAllPendingRequests() async throws {
        var aborted = 0
        let broker = RequestBroker(limits: try RuntimeLimits(timeoutSeconds: 0.02), send: { _ in }, abort: { aborted += 1 })
        let a = Task { try await broker.request("hang") }
        let b = Task { try await broker.request("queued") }
        for t in [a,b] {
            do { _ = try await t.value; XCTFail() }
            catch { XCTAssertEqual((error as? RuntimeFault)?.code, "timeout") }
        }
        XCTAssertEqual(aborted, 1); XCTAssertTrue(broker.isClosed); XCTAssertEqual(broker.pendingCount, 0)
    }
    @MainActor func testCancellationAbortsInsteadOfReusingUncertainMemory() async throws {
        var aborted = false
        let broker = RequestBroker(limits: try RuntimeLimits(), send: { _ in }, abort: { aborted = true })
        let task = Task { try await broker.request("hang") }
        while broker.pendingCount == 0 { await Task.yield() }
        task.cancel()
        do { _ = try await task.value; XCTFail() } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(aborted); XCTAssertTrue(broker.isClosed)
    }
    @MainActor func testBackpressureAndVersionMismatch() async throws {
        var sent: RPCMessage?
        let broker = RequestBroker(limits: try RuntimeLimits(maximumPendingRequests: 1), send: { sent = $0 }, abort: {})
        let task = Task { try await broker.request("pending") }
        while sent == nil { await Task.yield() }
        do { _ = try await broker.request("excess"); XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "backpressure") }
        broker.receive(RPCMessage(v: 2, session: broker.session, id: sent!.id, kind: "response"))
        do { _ = try await task.value; XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "protocolVersion") }
    }
    @MainActor func testOversizedMessageRejectedBeforeSend() async throws {
        var sent = false
        let broker = RequestBroker(limits: try RuntimeLimits(maximumModuleBytes: 8, maximumTransferBytes: 1), send: { _ in sent = true }, abort: {})
        do { _ = try await broker.request("test", payload: .string(String(repeating: "x", count: 70000))); XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "messageTooLarge") }
        XCTAssertFalse(sent); broker.close()
    }
}
@MainActor private final class EchoTransport: RuntimeTransport {
    func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities {
        try JSONValue.object(["protocolVersion": .number(1), "wasm": .bool(true), "jspi": .bool(false), "sharedMemory": .bool(false), "opfs": .bool(false)]).decode(RuntimeCapabilities.self)
    }
    func request(_ operation: String, payload: JSONValue) async throws -> JSONValue { .null }
    func close() {}
}
