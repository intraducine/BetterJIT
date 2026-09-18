import XCTest
@testable import BetterJITCore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private final class EventTrace {
    private let lock = NSLock()
    private var events: [ProbeEvent] = []
    func append(_ event: ProbeEvent) { lock.lock(); defer { lock.unlock() }; events.append(event) }
    func snapshot() -> [ProbeEvent] { lock.lock(); defer { lock.unlock() }; return events }
}

final class TransportDiagnosticsTests: XCTestCase {
    func testSelfTestsExerciseBothListenersWithoutClaimingIKE() throws {
        let trace = EventTrace()
        let done = expectation(description: "two local nonce echoes")
        done.expectedFulfillmentCount = 2
        let probe = LoopbackProbe { event in
            trace.append(event)
            if event.event == "selfTestPassed" { done.fulfill() }
        }
        defer { probe.stop() }
        let ports = probe.start(address: .primary, ikePort: 0, natPort: 0, runSelfTests: true)
        XCTAssertEqual(ports.compactMap { $0.boundPort }.count, 2)
        wait(for: [done], timeout: 4)
        let counts = probe.snapshot()
        XCTAssertEqual(counts.selfTestDatagrams, 2)
        XCTAssertEqual(counts.selfTestsPassed, 2)
        XCTAssertEqual(counts.selfTestsFailed, 0)
        XCTAssertEqual(counts.nonSelfTestDatagrams, 0)
        XCTAssertEqual(counts.cookieRoundTrips, 0)
        XCTAssertEqual(counts.repliesSent, 0) // IKE replies, not health-check echoes.
        XCTAssertFalse(trace.snapshot().contains { $0.event == "cookieChallenge" || $0.event == "cookieRoundTrip" })
    }

    func testMalformedDatagramIsLoggedBeforeParserRejection() throws {
        let trace = EventTrace()
        let rejected = expectation(description: "malformed request logged and rejected")
        let probe = LoopbackProbe { event in
            trace.append(event)
            if event.event == "ignored" { rejected.fulfill() }
        }
        defer { probe.stop() }
        let port = try XCTUnwrap(probe.start(address: .primary, ikePort: 0, natPort: 0).first?.boundPort)
        try send(Data([1, 2, 3]), to: port)
        wait(for: [rejected], timeout: 2)
        let events = trace.snapshot()
        let received = try XCTUnwrap(events.firstIndex { $0.event == "datagramReceived" })
        let ignored = try XCTUnwrap(events.firstIndex { $0.event == "ignored" })
        XCTAssertLessThan(received, ignored)
        XCTAssertTrue(events[received].detail.contains("3 bytes from 127.0.0.1:"))
        XCTAssertEqual(probe.snapshot().nonSelfTestDatagrams, 1)
        XCTAssertEqual(probe.snapshot().cookieRoundTrips, 0)
    }

    func testHealthPrefixAloneCannotMasqueradeAsSelfTest() throws {
        let done = expectation(description: "unsolicited test-shaped bytes still parsed normally")
        let probe = LoopbackProbe { if $0.event == "ignored" { done.fulfill() } }
        defer { probe.stop() }
        let port = try XCTUnwrap(probe.start(address: .primary, ikePort: 0, natPort: 0).first?.boundPort)
        try send(Data("BETTERJIT-HEALTH-V1:made-up-nonce".utf8), to: port)
        wait(for: [done], timeout: 2)
        XCTAssertEqual(probe.snapshot().nonSelfTestDatagrams, 1)
        XCTAssertEqual(probe.snapshot().selfTestDatagrams, 0)
        XCTAssertEqual(probe.snapshot().selfTestsPassed, 0)
    }

    func testSummaryIsEmittedOnStopAndCountersSurviveStop() throws {
        let trace = EventTrace()
        let received = expectation(description: "datagram received")
        let probe = LoopbackProbe {
            trace.append($0)
            if $0.event == "ignored" { received.fulfill() }
        }
        let port = try XCTUnwrap(probe.start(address: .primary, ikePort: 0, natPort: 0).first?.boundPort)
        try send(Data([42]), to: port)
        wait(for: [received], timeout: 2)
        probe.stop()
        XCTAssertEqual(probe.snapshot().nonSelfTestDatagrams, 1)
        let events = trace.snapshot()
        XCTAssertEqual(events.suffix(2).map { $0.event }, ["transportSummary", "stopped"])
        XCTAssertTrue(events[events.count - 2].detail.contains("nonSelfTestDatagrams=1"))
    }

    func testRestartResetsCountersAndCancelledTimeoutsDoNotLeak() throws {
        let checked = expectation(description: "first run health checks")
        checked.expectedFulfillmentCount = 2
        let heartbeat = expectation(description: "new run queue heartbeat")
        let probe = LoopbackProbe { event in
            if event.event == "selfTestPassed" { checked.fulfill() }
            if event.event == "probeHeartbeat" { heartbeat.fulfill() }
        }
        defer { probe.stop() }
        _ = probe.start(address: .primary, ikePort: 0, natPort: 0, runSelfTests: true)
        wait(for: [checked], timeout: 3)
        _ = probe.start(address: .primary, ikePort: 0, natPort: 0)
        wait(for: [heartbeat], timeout: 4)
        let counts = probe.snapshot()
        XCTAssertEqual(counts.selfTestsPassed, 0)
        XCTAssertEqual(counts.selfTestsFailed, 0)
        XCTAssertEqual(counts.nonSelfTestDatagrams, 0)
    }

    func testNonLoopbackSourceMetadataIsLoggedBeforeFilter() throws {
        // Keep the destination strictly localhost; use an existing non-loopback
        // local source address to exercise the previously silent source filter.
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { throw XCTSkip("No interface list") }
        defer { freeifaddrs(first) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        var localSource: in_addr?
        while let current = cursor {
            if let address = current.pointee.ifa_addr, address.pointee.sa_family == AF_INET {
                let candidate = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
                let value = UInt32(bigEndian: candidate.s_addr)
                if value >> 24 != 127 && value != 0 { localSource = candidate; break }
            }
            cursor = current.pointee.ifa_next
        }
        guard let source = localSource else { throw XCTSkip("No local non-loopback IPv4 address") }
        let trace = EventTrace()
        let filtered = expectation(description: "non-loopback source logged and filtered")
        let probe = LoopbackProbe {
            trace.append($0)
            if $0.event == "datagramFiltered" { filtered.fulfill() }
        }
        defer { probe.stop() }
        let port = try XCTUnwrap(probe.start(address: .primary, ikePort: 0, natPort: 0).first?.boundPort)
        try send(Data([5, 6]), to: port, source: source)
        wait(for: [filtered], timeout: 2)
        let events = trace.snapshot()
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex { $0.event == "datagramReceived" }),
                          try XCTUnwrap(events.firstIndex { $0.event == "datagramFiltered" }))
        XCTAssertEqual(probe.snapshot().nonSelfTestDatagrams, 1)
        XCTAssertEqual(probe.snapshot().filteredDatagrams, 1)
        XCTAssertEqual(probe.snapshot().repliesSent, 0)
    }

    private func send(_ bytes: Data, to port: UInt16, source: in_addr? = nil) throws {
        #if canImport(Darwin)
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        #else
        let fd = socket(AF_INET, Int32(SOCK_DGRAM.rawValue), Int32(IPPROTO_UDP))
        #endif
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        var remote = sockaddr_in()
        #if canImport(Darwin)
        remote.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        remote.sin_family = sa_family_t(AF_INET)
        remote.sin_port = port.bigEndian
        XCTAssertEqual(inet_pton(AF_INET, "127.0.0.1", &remote.sin_addr), 1)
        if let source {
            var local = remote; local.sin_addr = source; local.sin_port = 0
            let result = withUnsafePointer(to: &local) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    #if canImport(Darwin)
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                    #else
                    Glibc.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                    #endif
                }
            }
            guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        let sent = withUnsafePointer(to: &remote) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                bytes.withUnsafeBytes { sendto(fd, $0.baseAddress, $0.count, 0, address, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
        }
        guard sent == bytes.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
