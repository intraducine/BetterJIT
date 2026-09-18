import XCTest
@testable import BetterJITCore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

final class ProfileAndSocketTests: XCTestCase {
    func testProfileIsRemovableLocalAndNotOnDemand() throws {
        for address in LoopbackAddress.allCases {
            let data = try ProbeProfile.make(address: address)
            let root = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            XCTAssertEqual(root["PayloadRemovalDisallowed"] as? Bool, false)
            let payloads = try XCTUnwrap(root["PayloadContent"] as? [[String: Any]])
            XCTAssertEqual(payloads.count, 1)
            let vpn = try XCTUnwrap(payloads.first)
            XCTAssertEqual(vpn["PayloadType"] as? String, "com.apple.vpn.managed")
            XCTAssertEqual(vpn["VPNType"] as? String, "IKEv2")
            let ike = try XCTUnwrap(vpn["IKEv2"] as? [String: Any])
            XCTAssertEqual(ike["RemoteAddress"] as? String, address.rawValue)
            XCTAssertEqual(ike["OnDemandEnabled"] as? Int, 0)
            XCTAssertEqual(ike["IncludeAllNetworks"] as? Int, 0)
            XCTAssertEqual(ike["ExtendedAuthEnabled"] as? Int, 0)
            let secret = try XCTUnwrap(ike["SharedSecret"] as? String)
            XCTAssertEqual(Data(base64Encoded: secret)?.count, 32)
            XCTAssertNil(vpn["VPNSubType"])
        }
    }
    func testSecretsAreNotHardCoded() throws {
        XCTAssertNotEqual(try ProbeProfile.make(address: .primary), try ProbeProfile.make(address: .primary))
    }
    func testOnlyExplicitLoopbackAddressesAllowed() {
        for host in ["0.0.0.0","localhost","192.168.1.1","::1",""] { XCTAssertNil(LoopbackAddress(rawValue: host)) }
    }
    func testExclusiveBindingAndPartialFailure() throws {
        let first = LoopbackProbe { _ in }
        let firstBindings = first.start(address: .primary, ikePort: 0, natPort: 0)
        defer { first.stop() }
        let occupied = try XCTUnwrap(firstBindings[0].boundPort)
        XCTAssertNotNil(firstBindings[1].boundPort)
        let second = LoopbackProbe { _ in }
        let bindings = second.start(address: .primary, ikePort: occupied, natPort: 0)
        defer { second.stop() }
        XCTAssertEqual(bindings[0].errorCode, EADDRINUSE)
        XCTAssertNil(bindings[0].boundPort)
        XCTAssertNotNil(bindings[1].boundPort)
    }
    func testCleanRestartReleasesPorts() throws {
        let probe = LoopbackProbe { _ in }
        let bindings = probe.start(address: .primary, ikePort: 0, natPort: 0)
        let ike = try XCTUnwrap(bindings[0].boundPort)
        let nat = try XCTUnwrap(bindings[1].boundPort)
        probe.stop()
        let restarted = probe.start(address: .primary, ikePort: ike, natPort: nat)
        defer { probe.stop() }
        XCTAssertEqual(restarted[0].boundPort, ike)
        XCTAssertEqual(restarted[1].boundPort, nat)
    }
}
