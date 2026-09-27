// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJIT

@MainActor private final class FailingTransport: RuntimeFailureReportingTransport {
    var onFailure: (@MainActor (RuntimeFault) -> Void)?
    var pending: CheckedContinuation<JSONValue, Error>?
    var closeCount = 0
    func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities {
        RuntimeCapabilities(wasm: true, jspi: false, sharedMemory: false, opfs: false)
    }
    func request(_ operation: String, payload: JSONValue) async throws -> JSONValue {
        try await withCheckedThrowingContinuation { pending = $0 }
    }
    func close() { closeCount += 1 }
    func finish(_ result: Result<JSONValue, Error>) { let p = pending; pending = nil; p?.resume(with: result) }
}

final class LifecycleTests: XCTestCase {
    @MainActor private func waiting(_ condition: () -> Bool) async throws {
        for _ in 0..<10000 { if condition() { return }; await Task.yield() }
        throw RuntimeFault("testTimeout", "Test operation did not start.")
    }
    @MainActor func testIdleFailureImmediatelyUpdatesSession() async throws {
        let transport = FailingTransport(), session = try RuntimeSession(transport: transport, limits: RuntimeLimits())
        try await session.start()
        transport.onFailure?(RuntimeFault("processTerminated", "First cause"))
        XCTAssertEqual(session.state, .failed)
        XCTAssertEqual(session.failure?.code, "processTerminated")
        transport.onFailure?(RuntimeFault.closed)
        XCTAssertEqual(session.failure?.message, "First cause")
        XCTAssertEqual(transport.closeCount, 1)
    }
    @MainActor func testCloseWhileRequestFailsStaysClosed() async throws {
        let transport = FailingTransport(), session = try RuntimeSession(transport: transport, limits: RuntimeLimits())
        try await session.start()
        let task = Task { try await session.request("read") }
        try await waiting { transport.pending != nil }
        session.close(); transport.finish(.failure(RuntimeFault.closed))
        do { _ = try await task.value; XCTFail() } catch {}
        XCTAssertEqual(session.state, .closed)
        XCTAssertNil(session.failure)
        XCTAssertEqual(transport.closeCount, 1)
    }
    @MainActor func testLateSuccessAfterCloseIsNotDelivered() async throws {
        let transport = FailingTransport(), session = try RuntimeSession(transport: transport, limits: RuntimeLimits())
        try await session.start()
        let task = Task { try await session.request("read") }
        try await waiting { transport.pending != nil }
        session.close(); transport.finish(.success(.string("stale")))
        do { _ = try await task.value; XCTFail("A closed session delivered a stale result") } catch {}
        XCTAssertEqual(session.state, .closed)
    }
    @MainActor func testFirstFailureSurvivesExplicitClose() async throws {
        let t = FailingTransport(), s = try RuntimeSession(transport: t, limits: RuntimeLimits())
        try await s.start(); t.onFailure?(RuntimeFault("allocationFailed", "Native allocation failed"))
        s.close(); t.onFailure?(RuntimeFault("worker", "Later crash"))
        XCTAssertEqual(s.state, .closed); XCTAssertEqual(s.failure?.code, "allocationFailed")
    }
    @MainActor func testSessionDoesNotRetainItselfThroughFailureCallback() throws {
        let t = FailingTransport()
        weak var weakSession: RuntimeSession?
        do { let s = try RuntimeSession(transport: t, limits: RuntimeLimits()); weakSession = s }
        XCTAssertNil(weakSession)
    }
    @MainActor func testPendingByteBudgetReturnsAfterCompletion() async throws {
        let limits = try RuntimeLimits(maximumPendingBytes: 65536)
        var sent: RPCMessage?
        let broker = RequestBroker(limits: limits, send: { sent = $0 }, abort: {})
        let task = Task { try await broker.request("x", payload: .string(String(repeating: "x", count: 40000))) }
        try await waiting { sent != nil }
        XCTAssertGreaterThan(broker.pendingBytes, 40000)
        do { _ = try await broker.request("y", payload: .string(String(repeating: "x", count: 40000))); XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "backpressure") }
        broker.receive(RPCMessage(session: broker.session, id: sent!.id, kind: "response"))
        _ = try await task.value
        XCTAssertEqual(broker.pendingBytes, 0); XCTAssertEqual(broker.submittedRequests, 1); XCTAssertEqual(broker.completedRequests, 1)
        broker.close()
    }
    @MainActor func testAbortIsReentrantAndPreservesOriginalError() async throws {
        var broker: RequestBroker!
        broker = RequestBroker(limits: try RuntimeLimits(), send: { _ in }, abort: { broker.close(RuntimeFault.closed) })
        let task = Task { try await broker.request("hang") }
        try await waiting { broker.pendingCount == 1 }
        broker.close(RuntimeFault("allocationFailed", "first"))
        do { _ = try await task.value; XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "allocationFailed") }
        XCTAssertEqual(broker.pendingCount, 0); XCTAssertEqual(broker.pendingBytes, 0)
    }
    @MainActor func testAlreadyCancelledRequestNeverSendsOrAborts() async throws {
        var sends = 0, aborts = 0
        let b = RequestBroker(limits: try RuntimeLimits(), send: { _ in sends += 1 }, abort: { aborts += 1 })
        let task = Task { withUnsafeCurrentTask { $0?.cancel() }; return try await b.request("x") }
        do { _ = try await task.value; XCTFail() } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(sends, 0); XCTAssertEqual(aborts, 0); XCTAssertFalse(b.isClosed)
    }
    func testLegacyLimitsDecodeWithBoundedAdditiveDefaults() throws {
        let old = #"{"initialMemoryPages":16,"maximumMemoryPages":1024,"maximumModuleBytes":8388608,"maximumModules":128,"maximumTransferBytes":1048576,"maximumPendingRequests":16,"timeoutSeconds":15}"#
        let limits = try JSONDecoder().decode(RuntimeLimits.self, from: Data(old.utf8)).validated()
        XCTAssertEqual(limits.maximumResidentModuleBytes, 33554432)
        XCTAssertEqual(limits.maximumPendingBytes, 67108864)
    }
    func testInvalidBudgetValuesRejectWithoutIntegerOverflow() throws {
        XCTAssertThrowsError(try RuntimeLimits(maximumResidentModuleBytes: 0))
        XCTAssertThrowsError(try RuntimeLimits(maximumCumulativeModuleBytes: 1))
        XCTAssertThrowsError(try RuntimeLimits(maximumPendingBytes: Int.max))
        XCTAssertThrowsError(try RuntimeLimits(maximumTableElements: -1))
        XCTAssertThrowsError(try RuntimeLimits(maximumBatchOperations: 0))
        XCTAssertThrowsError(try RuntimeLimits(maximumModuleBytes: Int.max))
    }
    func testNumericWireSyntaxAgreesWithJavaScript() throws {
        for text in [" 1", "1 ", "0x10", "NaN", "Infinity", "01", String(repeating: "1", count: 1000)] {
            let value = try JSONValue.object(["type": .string("f64"), "value": .string(text)]).decode(WasmValue.self)
            XCTAssertThrowsError(try value.validate(), text)
        }
        try WasmValue.f64(-0.0).validate(); try WasmValue.f32(1.25).validate()
    }
    func testUnexpectedNativeErrorsAreRedacted() {
        let error = NSError(domain: "/private/key/location", code: 1, userInfo: [NSLocalizedDescriptionKey: "SECRET"])
        let fault = RuntimeFault.normalizing(error)
        XCTAssertEqual(fault.code, "transport"); XCTAssertFalse(fault.message.contains("SECRET"))
    }
}
