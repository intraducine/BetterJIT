// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import BetterJIT
@testable import BetterJITFEX
private final class FakeTranslator: FEXTranslator {
    func configuration() throws -> Data { Data("{}".utf8) }
    func dispatcher() throws -> Data { Data([0,97,115,109,1,0,0,0]) }
    func initialState() throws -> Data { Data([1,2]) }
    func unit(at rip: UInt32) throws -> Data { Data([1,0,0,0,0,97,115,109,1,0,0,0]) }
    func region(profile: Data) throws -> Data { Data() }
    func close() {}
}
final class FEXHardeningTests: XCTestCase {
    private func words(_ values: [UInt32]) -> Data {
        Data(values.flatMap { n in (0..<4).map { UInt8(truncatingIfNeeded: n >> ($0 * 8)) } })
    }
    func testValidAndTruncatedProfiles() throws {
        let profile = words([1,4096,1,4096,1,8192,0])
        try FEXService.validateProfile(profile)
        for count in 0..<profile.count { XCTAssertThrowsError(try FEXService.validateProfile(profile.prefix(count))) }
    }
    func testDuplicateUnknownAndOversizedProfilesReject() throws {
        for values: [UInt32] in [[2,1,1,0,0], [1,1,1,2,0,0], [1,1,0,65537], [25]] {
            XCTAssertThrowsError(try FEXService.validateProfile(words(values)))
        }
        XCTAssertThrowsError(try FEXService.validateProfile(Data(count: 1024 * 1024 + 4)))
    }
    func testServiceCountersAndClosedService() async throws {
        let service = try FEXService(translator: FakeTranslator(), image: Data([1]))
        _ = try await service.handle(.object(["method": .string("unit"), "rip": .number(4096)]))
        do { _ = try await service.handle(.object(["method": .string("unit"), "rip": .number(-1)])); XCTFail() } catch {}
        let stats = await service.statistics()
        XCTAssertEqual(stats.unitRequests, 1); XCTAssertEqual(stats.returnedBytes, 12); XCTAssertEqual(stats.rejectedRequests, 1)
        await service.close(); await service.close()
        do { _ = try await service.handle(.object(["method": .string("image")])); XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "closed") }
    }
    func testSeededMalformedProfilesNeverReachNativeOrTrap() {
        var seed: UInt64 = 123
        for count in 0..<1000 {
            let length = count % 96
            let data = Data((0..<length).map { _ in seed = seed &* 6364136223846793005 &+ 1; return UInt8(truncatingIfNeeded: seed >> 32) })
            do { try FEXService.validateProfile(data) } catch { XCTAssertTrue(error is RuntimeFault) }
        }
    }
}
