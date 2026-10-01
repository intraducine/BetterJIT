import XCTest
@testable import BetterJITCore

final class CoreTests: XCTestCase {
    func testValidFixturesEmitWasm() throws {
        for hex in [X86Wasm.arithmeticHex, "c3", "48 31 c0 c3", "48 05 ff ff ff ff c3",
                    "49 b8 ff ff ff ff ff ff ff ff 4c 01 c0 c3"] {
            let data = try X86Wasm.compile(X86Wasm.hex(hex))
            XCTAssertEqual(Array(data.prefix(8)), [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
        }
    }
    func testUnsupportedInstructionsFailClosed() throws {
        for hex in ["", "48", "48 b8 00", "48 05 01 00 00 00", "c3 90", "90 c3",
                    "48 8b 00 c3", "48 0f 05 c3", "75 00 c3", "66 48 31 c0 c3",
                    "4a 31 c0 c3", "4c a1 00 00 00 00 00 00 00 00 c3"] {
            XCTAssertThrowsError(try X86Wasm.compile(X86Wasm.hex(hex)), hex)
        }
    }
    func testHexValidation() {
        for hex in ["a", "zz", "0x48", String(repeating: "00", count: 4097)] {
            XCTAssertThrowsError(try X86Wasm.hex(hex))
        }
    }
    func testMarkerValidation() {
        for token in ["", "../file", UUID().uuidString] {
            XCTAssertThrowsError(try Transport.marker(token))
        }
    }
    func testFNVKnownVector() {
        let bytes = Array("hello".utf8)
        XCTAssertEqual(bytes.withUnsafeBytes { Transport.fnv1a($0) }, 0x4f9f2cab)
    }

    private func fixture(_ body: (URL, String, URL, FileHandle) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let token = UUID().uuidString.lowercased()
        let file = root.appendingPathComponent("betterjit-\(token).bin")
        try Transport.marker(token).write(to: file)
        let handle = try FileHandle(forUpdating: file)
        defer { try? handle.close() }
        try handle.truncate(atOffset: UInt64(Transport.headerSize + Transport.maxPayload))
        try body(root, token, file, handle)
    }

    func testBidirectionalMappingAndBounds() throws {
        try fixture { root, token, file, handle in
            XCTAssertEqual(try Transport.discover(in: [root], token: token).path, file.path)
            let mapped = try MappedFile(url: file, marker: Transport.marker(token))
            let input = Data((0..<65536).map { UInt8(truncatingIfNeeded: $0) })
            try handle.seek(toOffset: 4096)
            try handle.write(contentsOf: input)
            let hash = input.withUnsafeBytes { Transport.fnv1a($0) }
            let result = try mapped.exchange(offset: 4096, length: input.count, expectedHash: hash)
            try handle.seek(toOffset: 4096)
            let output = try XCTUnwrap(handle.read(upToCount: input.count))
            XCTAssertEqual(output, Data(input.map { $0 ^ 0x5a }))
            XCTAssertEqual(output.withUnsafeBytes { Transport.fnv1a($0) }, result)
            XCTAssertThrowsError(try mapped.exchange(offset: 0, length: 1, expectedHash: 0))
            XCTAssertThrowsError(try mapped.exchange(offset: UInt64.max, length: 1, expectedHash: 0))
            XCTAssertThrowsError(try mapped.exchange(offset: 4096, length: 0, expectedHash: 0))
            XCTAssertThrowsError(try mapped.exchange(offset: 4096, length: Transport.maxPayload + 1, expectedHash: 0))
            XCTAssertThrowsError(try mapped.exchange(offset: 99999999, length: 8, expectedHash: 0))
            XCTAssertThrowsError(try mapped.exchange(offset: 4096, length: 8, expectedHash: 0))
            mapped.close()
            XCTAssertThrowsError(try mapped.exchange(offset: 4096, length: 8, expectedHash: 0))
        }
    }

    func testHighOffsetMappingUsesSmallWindow() throws {
        try fixture { _, token, file, handle in
            let offset = Transport.highOffset
            try handle.truncate(atOffset: offset + 4096)
            try handle.seek(toOffset: offset)
            let input = Data([1, 2, 3, 4, 5, 6, 7, 8])
            try handle.write(contentsOf: input)
            let mapped = try MappedFile(url: file, marker: Transport.marker(token))
            let hash = input.withUnsafeBytes { Transport.fnv1a($0) }
            _ = try mapped.exchange(offset: offset, length: 8, expectedHash: hash)
            try handle.seek(toOffset: offset)
            XCTAssertEqual(try handle.read(upToCount: 8), Data(input.map { $0 ^ 0x5a }))
        }
    }

    func testWrongMarkerAndSymlinkRejected() throws {
        try fixture { root, token, file, _ in
            XCTAssertThrowsError(try MappedFile(url: file, marker: Data("wrong".utf8)))
            let link = root.appendingPathComponent("link")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
            XCTAssertThrowsError(try MappedFile(url: link, marker: Transport.marker(token)))
        }
    }
}
