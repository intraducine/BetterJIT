import XCTest
@testable import BetterJITCore

final class CookieProbeTests: XCTestCase {
    private func packet(cookie: Data? = nil, nonce: Data = Data(repeating: 0xaa, count: 32), extra: (UInt8, UInt8, Data)? = nil) -> Data {
        let sa = Data([0,0,0,44,1,1,0,4, 3,0,0,12,1,0,0,12,0x80,14,1,0,
                       3,0,0,8,2,0,0,5, 3,0,0,8,3,0,0,12, 0,0,0,8,4,0,0,19])
        var payloads: [(UInt8, UInt8, Data)] = [(33,0,sa), (34,0,Data([0,19,0,0]) + Data(repeating: 1, count: 64)), (40,0,nonce)]
        if let cookie { payloads.insert((41,0,Data([0,0,0x40,6]) + cookie), at: 0) }
        if let extra { payloads.append(extra) }
        var payloadData = Data()
        for (index, payload) in payloads.enumerated() {
            payloadData.append(contentsOf: [index + 1 < payloads.count ? payloads[index + 1].0 : 0, payload.1])
            payloadData.appendBE(UInt16(payload.2.count + 4)); payloadData.append(payload.2)
        }
        var result = Data([1,2,3,4,5,6,7,8] + Array(repeating: UInt8(0), count: 8))
        result.append(contentsOf: [payloads[0].0,0x20,34,0x08])
        result.appendBE(UInt32(0)); result.appendBE(UInt32(28 + payloadData.count)); result.append(payloadData)
        return result
    }
    private func receive(_ data: Data, engine: inout CookieProbe, at: Double = 10) -> CookieProbe.Result {
        engine.receive(data, peer: "loopback:50000:500", encapsulated: false, now: at)
    }
    private func cookie(_ result: CookieProbe.Result) throws -> Data {
        let reply = try XCTUnwrap(result.reply)
        XCTAssertEqual(reply.count, 68)
        XCTAssertEqual(Array(reply[32...35]), [0,0,0x40,6])
        return Data(reply.dropFirst(36))
    }
    func testCookieRoundTripEndsWithoutSA() throws {
        var engine = CookieProbe()
        let initial = packet()
        let challenge = receive(initial, engine: &engine)
        XCTAssertEqual(challenge.event, "cookieChallenge")
        let reply = try XCTUnwrap(challenge.reply)
        XCTAssertEqual(reply.prefix(8), initial.prefix(8))
        XCTAssertEqual(reply[8..<16], Data(repeating: 0, count: 8))
        XCTAssertEqual(Array(reply[16..<24]), [41,0x20,34,0x20,0,0,0,0])
        let echo = packet(cookie: try cookie(challenge))
        let verified = receive(echo, engine: &engine)
        XCTAssertEqual(verified.event, "cookieRoundTrip")
        XCTAssertEqual(verified.reply?.suffix(4), Data([0,0,0,14]))
        XCTAssertEqual(verified.reply?.count, 36)
        XCTAssertEqual(receive(echo, engine: &engine).event, "cookieEchoRepeated")
    }
    func testRetransmitKeepsCookie() {
        var engine = CookieProbe()
        let first = receive(packet(), engine: &engine)
        XCTAssertEqual(first.reply, receive(packet(), engine: &engine, at: 11).reply)
    }
    func testWrongCookieNotAccepted() throws {
        var engine = CookieProbe()
        _ = receive(packet(), engine: &engine)
        XCTAssertEqual(receive(packet(cookie: Data(repeating: 0, count: 32)), engine: &engine).event, "cookieChallenge")
    }
    func testChangedNonceNotAccepted() throws {
        var engine = CookieProbe()
        let value = try cookie(receive(packet(), engine: &engine))
        XCTAssertEqual(receive(packet(cookie: value, nonce: Data(repeating: 2, count: 32)), engine: &engine).event, "cookieChallenge")
    }
    func testDifferentPeerNotAccepted() throws {
        var engine = CookieProbe()
        let value = try cookie(receive(packet(), engine: &engine))
        XCTAssertEqual(engine.receive(packet(cookie: value), peer: "other", encapsulated: false, now: 10).event, "cookieChallenge")
    }
    func testExpiredCookieNotAccepted() throws {
        var engine = CookieProbe()
        let value = try cookie(receive(packet(), engine: &engine))
        XCTAssertEqual(receive(packet(cookie: value), engine: &engine, at: 70).event, "cookieChallenge")
    }
    func testEncapsulatedRoundTrip() throws {
        var engine = CookieProbe()
        let marker = Data(repeating: 0, count: 4)
        let first = engine.receive(marker + packet(), peer: "peer", encapsulated: true)
        let reply = try XCTUnwrap(first.reply)
        XCTAssertEqual(reply.prefix(4), marker)
        let value = Data(reply.dropFirst(40))
        let echo = engine.receive(marker + packet(cookie: value), peer: "peer", encapsulated: true)
        XCTAssertEqual(echo.event, "cookieRoundTrip")
        XCTAssertEqual(echo.reply?.prefix(4), marker)
    }
    func testKeepaliveAndESPDoNotProveAnything() {
        var engine = CookieProbe()
        XCTAssertEqual(engine.receive(Data([0xff]), peer: "p", encapsulated: true).event, "natKeepalive")
        XCTAssertEqual(engine.receive(Data([1,2,3,4,5,6,7,8]), peer: "p", encapsulated: true).event, "ignoredESP")
        XCTAssertEqual(engine.pendingCount, 0)
    }
    func testAllTruncationsRejected() {
        var engine = CookieProbe()
        let data = packet()
        for length in 0..<data.count { XCTAssertNil(receive(Data(data.prefix(length)), engine: &engine).reply) }
    }
    func testInvalidHeaderFieldsRejected() {
        for (offset, value): (Int, UInt8) in [(17,0x10),(18,35),(19,0x28),(20,1),(8,1),(24,0xff)] {
            var engine = CookieProbe(); var data = packet(); data[offset] = value
            XCTAssertNil(receive(data, engine: &engine).reply)
        }
    }
    func testMinorVersionIgnoredForInitialRequest() {
        var engine = CookieProbe(); var data = packet(); data[17] = 0x21
        XCTAssertEqual(receive(data, engine: &engine).event, "cookieChallenge")
    }
    func testPayloadBoundsAndTrailingGarbage() {
        var engine = CookieProbe()
        for length: UInt8 in [0,1,2,3,255] {
            var data = packet(); data[30] = 0; data[31] = length
            XCTAssertNil(receive(data, engine: &engine).reply)
        }
        var trailing = packet() + Data([0])
        let size = UInt32(trailing.count); trailing.replaceSubrange(24..<28, with: withUnsafeBytes(of: size.bigEndian) { Data($0) })
        XCTAssertNil(receive(trailing, engine: &engine).reply)
    }
    func testNonceSizeLimits() {
        var engine = CookieProbe()
        for size in [0,15,257] { XCTAssertNil(receive(packet(nonce: Data(repeating: 1, count: size)), engine: &engine).reply) }
    }
    func testUnknownCriticalPayloadRejected() {
        var engine = CookieProbe()
        XCTAssertNil(receive(packet(extra: (250,0x80,Data([1]))), engine: &engine).reply)
        XCTAssertNotNil(receive(packet(extra: (250,0,Data([1]))), engine: &engine).reply)
    }
    func testCookieMustBeFirstAndUnique() {
        var engine = CookieProbe()
        let value = Data([0,0,0x40,6,1])
        XCTAssertNil(receive(packet(extra: (41,0,value)), engine: &engine).reply)
        XCTAssertNil(receive(packet(cookie: Data([1]), extra: (41,0,value)), engine: &engine).reply)
    }
    func testCacheBounded() {
        var engine = CookieProbe()
        for index in 0..<100 { _ = engine.receive(packet(), peer: "\(index)", encapsulated: false, now: Double(index) / 10) }
        XCTAssertEqual(engine.pendingCount, engine.capacity)
        _ = engine.receive(Data(), peer: "none", encapsulated: false, now: 100)
        XCTAssertEqual(engine.pendingCount, 0)
    }
    func testDeterministicMalformedInputSweepDoesNotCrash() {
        var engine = CookieProbe(); var seed: UInt64 = 17
        for index in 0..<5000 {
            seed = seed &* 6364136223846793005 &+ 1
            var data = packet()
            let position = Int(seed % UInt64(data.count))
            data[position] = UInt8(truncatingIfNeeded: seed >> 32)
            let result = engine.receive(data, peer: "mutation", encapsulated: index % 2 == 0, now: 10)
            XCTAssertNotEqual(result.event, "cookieRoundTrip")
        }
    }
}
