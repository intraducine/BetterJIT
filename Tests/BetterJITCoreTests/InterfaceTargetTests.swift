import XCTest
@testable import BetterJITCore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

final class InterfaceTargetTests: XCTestCase {
    private func sample(_ host: String = "192.0.2.10", family: IPFamily = .ipv4,
                        name: String = "en0", index: UInt32 = 20, up: Bool = true) -> InterfaceTarget {
        InterfaceTarget(name: name, index: index, address: host, family: family, isUp: up)
    }
    func testInventoryHasUniqueIDsAndParseableAddresses() throws {
        let rows = try LocalInterfaces.snapshot()
        XCTAssertFalse(rows.isEmpty)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
        for row in rows { XCTAssertNoThrow(try SocketEndpoint(host: row.address, port: 0, family: row.family)) }
    }
    func testStaleAddressInterfaceAndIndexAreRejected() {
        let target = sample()
        XCTAssertTrue(target.isPresent(in: [target]))
        for other in [sample("192.0.2.11"), sample(name: "en1"), sample(index: 21), sample(up: false)] {
            XCTAssertFalse(target.isPresent(in: [other]))
        }
        XCTAssertFalse(target.isPresent(in: []))
    }
    func testSpecialAddressesAndAuxiliaryInterfacesAreExcluded() {
        for host in ["0.0.0.0", "224.0.0.1", "255.255.255.255"] { XCTAssertNotNil(sample(host).exclusion) }
        for host in ["::", "ff02::1", "fe80::1", "fe90::1", "fea0::1", "feb0::1", "::ffff:192.0.2.1"] {
            XCTAssertNotNil(sample(host, family: .ipv6).exclusion)
        }
        for name in ["utun2", "ipsec1", "awdl0", "llw0", "ap1", "nan0"] {
            XCTAssertNotNil(sample(name: name).exclusion)
        }
        XCTAssertNil(sample("2001:db8::10", family: .ipv6).exclusion)
        XCTAssertNil(sample("fd00::10", family: .ipv6).exclusion)
        XCTAssertNotNil(sample(up: false).exclusion)
    }
    func testPeerPolicyRejectsUnrelatedHostsAndFamilies() {
        let target = sample()
        XCTAssertTrue(target.accepts(source: target.address, family: .ipv4))
        XCTAssertTrue(target.accepts(source: "127.0.0.1", family: .ipv4))
        XCTAssertFalse(target.accepts(source: "192.0.2.11", family: .ipv4))
        XCTAssertFalse(target.accepts(source: "::1", family: .ipv6))
        let v6 = sample("2001:db8::10", family: .ipv6)
        XCTAssertTrue(v6.accepts(source: "::1", family: .ipv6))
        XCTAssertFalse(v6.accepts(source: "2001:db8::11", family: .ipv6))
    }
    func testHealthFramingIsExplicitAndNoncesDiffer() {
        let plain = LoopbackProbe.healthPayload(encapsulated: false)
        let nat = LoopbackProbe.healthPayload(encapsulated: true)
        XCTAssertTrue(plain.starts(with: Data("BETTERJIT-HEALTH-V1:".utf8)))
        XCTAssertEqual(nat.prefix(4), Data(repeating: 0, count: 4))
        XCTAssertTrue(nat.dropFirst(4).starts(with: Data("BETTERJIT-HEALTH-V1:".utf8)))
        XCTAssertEqual(nat.count, plain.count + 4)
        XCTAssertNotEqual(nat, LoopbackProbe.healthPayload(encapsulated: true))
    }
    func testUnavailableTargetCannotOpenSocketsOrGenerateProfile() throws {
        let target = sample(name: "not-an-interface", index: UInt32.max)
        let probe = LoopbackProbe { _ in }
        defer { probe.stop() }
        let bindings = probe.start(target: target, ikePort: 0, natPort: 0)
        XCTAssertTrue(bindings.allSatisfy { $0.boundPort == nil && $0.errorCode == EADDRNOTAVAIL })
        XCTAssertThrowsError(try ProbeProfile.make(target: target))
        XCTAssertEqual(probe.snapshot().selfTestsPassed, 0)
    }
    func testExactInterfaceProfileHasSeparateIdentityAndNoRouteOverride() throws {
        let target = try localTarget(family: .ipv4, loopback: true)
        let data = try ProbeProfile.make(target: target)
        let root = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(root["PayloadRemovalDisallowed"] as? Bool, false)
        XCTAssertEqual(root["PayloadIdentifier"] as? String, "io.github.intraducine.betterjit.interfaceprobe.profile")
        let vpn = try XCTUnwrap((root["PayloadContent"] as? [[String: Any]])?.first)
        let ike = try XCTUnwrap(vpn["IKEv2"] as? [String: Any])
        XCTAssertEqual(vpn["UserDefinedName"] as? String, target.vpnName)
        XCTAssertEqual(ike["RemoteAddress"] as? String, target.address)
        XCTAssertEqual(ike["OnDemandEnabled"] as? Int, 0)
        XCTAssertEqual(ike["IncludeAllNetworks"] as? Int, 0)
        XCTAssertEqual(ike["EnforceRoutes"] as? Int, 0)
        XCTAssertNil(ike["Interface"])
        XCTAssertNil(vpn["VPNSubType"])
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(ike["SharedSecret"] as? String))?.count, 32)
    }
    func testIPv6ProfileUsesNumericLiteralNotURLBrackets() throws {
        let target = try localTarget(family: .ipv6, loopback: true)
        let root = try XCTUnwrap(PropertyListSerialization.propertyList(from: ProbeProfile.make(target: target), format: nil) as? [String: Any])
        let vpn = try XCTUnwrap((root["PayloadContent"] as? [[String: Any]])?.first)
        XCTAssertEqual((vpn["IKEv2"] as? [String: Any])?["RemoteAddress"] as? String, "::1")
    }
    func testIPv4AssignedLoopbackSelfTests() throws { try checkSelfTests(localTarget(family: .ipv4, loopback: true)) }
    func testIPv6AssignedLoopbackSelfTests() throws { try checkSelfTests(localTarget(family: .ipv6, loopback: true)) }
    func testPhysicalIPv4AssignedAddressSelfTests() throws { try checkSelfTests(localTarget(family: .ipv4, loopback: false)) }
    func testIPv6MalformedInputIsLoggedAndRejected() throws {
        let target = try localTarget(family: .ipv6, loopback: true)
        let done = expectation(description: "IPv6 request rejected by parser")
        let probe = LoopbackProbe { if $0.event == "ignored" { done.fulfill() } }
        defer { probe.stop() }
        let port = try XCTUnwrap(probe.start(target: target, ikePort: 0, natPort: 0, runSelfTests: false).first?.boundPort)
        let fd = try SocketEndpoint.bind(host: target.address, port: 0, family: target.family)
        defer { close(fd) }
        XCTAssertNil(try SocketEndpoint(host: target.address, port: port, family: target.family).send(Data([1, 2, 3]), fd: fd))
        wait(for: [done], timeout: 3)
        XCTAssertEqual(probe.snapshot().nonSelfTestDatagrams, 1)
        XCTAssertEqual(probe.snapshot().cookieRoundTrips, 0)
    }
    func testPacketBudgetDoesNotProduceFalseCookieSuccess() throws {
        let target = try localTarget(family: .ipv4, loopback: true)
        let done = expectation(description: "packet limit reached")
        let probe = LoopbackProbe { if $0.event == "packetLimit" { done.fulfill() } }
        defer { probe.stop() }
        let port = try XCTUnwrap(probe.start(target: target, ikePort: 0, natPort: 0, runSelfTests: false).first?.boundPort)
        let fd = try SocketEndpoint.bind(host: target.address, port: 0, family: target.family)
        defer { close(fd) }
        let peer = try SocketEndpoint(host: target.address, port: port, family: target.family)
        for _ in 0..<140 { XCTAssertNil(peer.send(Data([7]), fd: fd)); usleep(1000) }
        wait(for: [done], timeout: 3)
        XCTAssertGreaterThan(probe.snapshot().rateLimitedDatagrams, 0)
        XCTAssertEqual(probe.snapshot().cookieRoundTrips, 0)
    }
    private func localTarget(family: IPFamily, loopback: Bool) throws -> InterfaceTarget {
        guard let target = try LocalInterfaces.snapshot().first(where: {
            $0.family == family && $0.isLoopback == loopback && $0.exclusion == nil
        }) else { throw XCTSkip("No matching local address on this test host") }
        return target
    }
    private func checkSelfTests(_ target: InterfaceTarget) throws {
        let done = expectation(description: "two nonce echoes on \(target.label)")
        done.expectedFulfillmentCount = 2
        let probe = LoopbackProbe { if $0.event == "selfTestPassed" { done.fulfill() } }
        defer { probe.stop() }
        let bindings = probe.start(target: target, ikePort: 0, natPort: 0)
        XCTAssertEqual(bindings.compactMap(\.boundPort).count, 2)
        wait(for: [done], timeout: 4)
        XCTAssertEqual(probe.snapshot().selfTestsPassed, 2)
        XCTAssertEqual(probe.snapshot().selfTestsFailed, 0)
        XCTAssertEqual(probe.snapshot().nonSelfTestDatagrams, 0)
        XCTAssertEqual(probe.snapshot().cookieRoundTrips, 0)
    }
}
