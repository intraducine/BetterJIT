// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import BetterJIT
@testable import BetterJITFEX

final class FEXServiceTests: XCTestCase {
    func testServiceCopiesBytesAndRejectsUnregisteredOperations() async throws {
        let translator = FixtureTranslator()
        let service = try FEXService(translator: translator, image: Data([1,2,3]))
        let image = try await service.handle(.object(["method": .string("image")]))
        XCTAssertEqual(image, .string("AQID"))
        let unit = try await service.handle(.object(["method": .string("unit"), "rip": .number(0xffffffff)]))
        XCTAssertEqual(unit, .string("BAUG"))
        for payload in [JSONValue.null, .object(["method": .string("shell")]), .object(["method": .string("unit"), "rip": .number(-1)])] {
            do { _ = try await service.handle(payload); XCTFail() } catch {}
        }
        await service.close(); await service.close()
        do { _ = try await service.handle(.object(["method": .string("image")])); XCTFail() }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "closed") }
        XCTAssertEqual(translator.closedCount, 1)
    }
    func testRegionProfileCountsAreValidatedBeforeNativeEntry() throws {
        func bytes(_ words: [UInt32]) -> Data { Data(words.flatMap { x in (0..<4).map { UInt8(truncatingIfNeeded: x >> ($0 * 8)) } }) }
        try FEXService.validateProfile(bytes([1, 100, 1, 100, 1, 200, 1, 300, 1, 400]))
        for words: [UInt32] in [[], [0], [25], [1,100], [1,100,0,0,123], [1,100,1,100,13], [1,100,0,1,300,5]] {
            XCTAssertThrowsError(try FEXService.validateProfile(bytes(words)))
        }
        XCTAssertThrowsError(try FEXService.validateProfile(Data([1])))
    }

    func testImagePatchValidatesBothTransportsAndPreservesImageOnFailure() async throws {
        let translator = FixtureTranslator()
        let imageSlice = Data([0, 1, 2, 3]).dropFirst()
        let service = try FEXService(translator: translator, image: imageSlice)
        func patch(_ offset: Double, _ bytes: String) -> JSONValue {
            .object(["method": .string("patchImage"), "offset": .number(offset), "bytes": .string(bytes)])
        }
        let json = try await service.handle(patch(1, "BA=="))
        XCTAssertEqual(json, .bool(true))
        let binary = try await service.handleBinary(.init(payload: patch(2, "BQ=="), bytes: nil))
        XCTAssertEqual(binary, .json(.bool(true)))
        XCTAssertEqual(translator.replacements, [Data([1, 4, 3]), Data([1, 4, 5])])
        for request in [patch(-1, "BA=="), patch(0.5, "BA=="), patch(3, "BA=="),
                        patch(2, "BAg="), patch(0, "BB=="), patch(0, "")] {
            do { _ = try await service.handle(request); XCTFail("Invalid patch was accepted") }
            catch { XCTAssertEqual((error as? RuntimeFault)?.code, "invalidBackendRequest") }
        }
        translator.rejectReplacement = true
        do { _ = try await service.handle(patch(0, "Bg==")); XCTFail("Rejected patch was accepted") }
        catch { XCTAssertEqual((error as? RuntimeFault)?.code, "unsupported") }
        let image = try await service.handle(.object(["method": .string("image")]))
        XCTAssertEqual(image, .string("AQQF"))
        XCTAssertEqual(translator.replacements.count, 2)
        await service.close()
    }
}
private final class FixtureTranslator: FEXTranslator {
    var closedCount = 0
    var replacements = [Data]()
    var rejectReplacement = false
    func configuration() throws -> Data { Data("{}".utf8) }
    func dispatcher() throws -> Data { Data([0]) }
    func initialState() throws -> Data { Data([0]) }
    func unit(at rip: UInt32) throws -> Data { Data([4,5,6]) }
    func region(profile: Data) throws -> Data { Data() }
    func replaceImage(_ image: Data) throws {
        if rejectReplacement { throw RuntimeFault("unsupported", "Fixture rejected replacement") }
        replacements.append(image)
    }
    func close() { closedCount += 1 }
}
