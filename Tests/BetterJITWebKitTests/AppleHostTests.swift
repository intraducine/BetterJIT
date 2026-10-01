// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import BetterJIT
import BetterJITWebKit
#if os(macOS)
import AppKit
import WebKit

/// These are real WKWebView tests, not a replacement transport. They require
/// a macOS graphical login session; Linux reports an explicit skip below.
final class AppleHostTests: XCTestCase {
    @MainActor private func host(services: [String: NativeService] = [:], timeout: Double = 10) throws -> (NSWindow, WebKitTransport, RuntimeSession) {
        _ = NSApplication.shared
        let t = try WebKitTransport(services: services)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = t.webView
        window.orderFrontRegardless()
        let session = try RuntimeSession(transport: t, limits: RuntimeLimits(timeoutSeconds: timeout))
        return (window, t, session)
    }
    @MainActor func testWasmAndRepeatedLifecycle() async throws {
        for _ in 0..<3 {
            let (window, _, session) = try host()
            defer { session.close(); window.close() }
            try await session.start()
            let module = try await session.load(Self.module())
            let answer = try await session.invoke(module, export: "run", arguments: [.i32(20), .i32(22)])
            XCTAssertEqual(answer, [.i32(42)])
            let batched = try await session.invokeBatch([.init(module: module, export: "run", arguments: [.i32(1), .i32(2)]),
                                                        .init(module: module, export: "run", arguments: [.i32(3), .i32(4)])])
            XCTAssertEqual(batched, [[.i32(3)], [.i32(7)]])
        }
    }
    @MainActor func testNativeSwiftService() async throws {
        let (window, _, session) = try host(services: ["host.1": { input in
            guard input == .string("AQID") else { throw RuntimeFault("testMismatch", "Unexpected bytes") }
            return .string("BAUG")
        }])
        defer { session.close(); window.close() }
        let capabilities = try await session.start()
        guard capabilities.jspi else { throw XCTSkip("This macOS WebKit does not provide JSPI; no fallback pass.") }
        let module = try await session.load(Self.module(nativeCall: true))
        try await session.writeMemory(at: 0, bytes: Data([1,2,3]))
        let result = try await session.invoke(module, export: "run", results: [.i32])
        XCTAssertEqual(result, [.i32(3)])
        let bytes = try await session.readMemory(at: 8, count: 3)
        XCTAssertEqual(bytes, Data([4,5,6]))
    }
    @MainActor func testNativeSwiftServiceFailureReplies() async throws {
        // Exercise both catch branches: known runtime faults retain their details;
        // arbitrary native errors must become sanitized replies, not time out.
        let cases: [(handler: NativeService, expected: RuntimeFault)] = [
            ({ _ in throw RuntimeFault("fixtureService", "Expected service failure") },
             RuntimeFault("fixtureService", "Expected service failure")),
            ({ _ in throw NSError(domain: "private-test-domain", code: 7,
                                  userInfo: [NSLocalizedDescriptionKey: "private diagnostic"]) },
             RuntimeFault("nativeService", "The registered native service failed."))
        ]
        for testCase in cases {
            let (window, _, session) = try host(services: ["host.1": testCase.handler])
            defer { session.close(); window.close() }
            let capabilities = try await session.start()
            guard capabilities.jspi else { throw XCTSkip("This macOS WebKit does not provide JSPI; no fallback pass.") }
            let module = try await session.load(Self.module(nativeCall: true))
            try await session.writeMemory(at: 0, bytes: Data([1,2,3]))
            do {
                _ = try await session.invoke(module, export: "run", results: [.i32])
                XCTFail("A throwing native service returned successfully")
            } catch {
                let fault = error as? RuntimeFault
                XCTAssertEqual(fault?.code, testCase.expected.code)
                XCTAssertEqual(fault?.message, testCase.expected.message)
            }
        }
    }
    @MainActor func testBusyGuestDeadline() async throws {
        let (window, _, session) = try host(timeout: 3)
        defer { session.close(); window.close() }
        try await session.start()
        let module = try await session.load(Self.module(loop: true))
        do { _ = try await session.invoke(module, export: "run", results: []); XCTFail("Infinite guest returned") }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "timeout") }
        XCTAssertEqual(session.state, .failed)
    }
    @MainActor func testIdleTerminationNotification() async throws {
        let (window, transport, session) = try host()
        defer { session.close(); window.close() }
        try await session.start()
        // Synthetic delegate notification tests state plumbing, NOT an OS-killed process.
        transport.webViewWebContentProcessDidTerminate(transport.webView)
        XCTAssertEqual(session.state, .failed)
        XCTAssertEqual(session.failure?.code, "processTerminated")
    }
    private static func module(nativeCall: Bool = false, loop: Bool = false) -> Data {
        func section(_ id: UInt8, _ bytes: [UInt8]) -> [UInt8] { [id, UInt8(bytes.count)] + bytes }
        func name(_ s: String) -> [UInt8] { [UInt8(s.utf8.count)] + Array(s.utf8) }
        var bytes: [UInt8] = [0,97,115,109,1,0,0,0]
        let type: [UInt8] = nativeCall ? [2,0x60,5,0x7f,0x7f,0x7f,0x7f,0x7f,1,0x7f,0x60,0,1,0x7f]
            : loop ? [1,0x60,0,0] : [1,0x60,2,0x7f,0x7f,1,0x7f]
        bytes += section(1, type)
        if nativeCall { bytes += section(2, [2] + name("betterjit") + name("memory") + [2,0,1] + name("betterjit") + name("call") + [0,0]) }
        bytes += section(3, [1,nativeCall ? 1 : 0])
        bytes += section(7, [1] + name("run") + [0,nativeCall ? 1 : 0])
        let instructions: [UInt8] = nativeCall ? [0x41,1,0x41,0,0x41,3,0x41,8,0x41,4,0x10,0]
            : loop ? [0x03,0x40,0x0c,0,0x0b] : [0x20,0,0x20,1,0x6a]
        let body = [UInt8(0)] + instructions + [0x0b]
        bytes += section(10, [1,UInt8(body.count)] + body)
        return Data(bytes)
    }
}
#else
final class AppleHostTests: XCTestCase {
    func testAppleHostRequiresAppleSDK() throws { throw XCTSkip("Real WebKit host tests require macOS; portable tests do not compile Apple code.") }
}
#endif
