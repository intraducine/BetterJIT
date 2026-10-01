// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJITWebKit
#if os(macOS)

final class MappedDataLaneTests: XCTestCase {
    func testFixedSlotReadWriteAndValidation() throws {
        let token = "12345678-1234-4123-8123-123456789abc"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("betterjit-\(token).bin")
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        let writer = try FileHandle(forWritingTo: url)
        try writer.truncate(atOffset: UInt64(MappedDataLane.fileSize))
        try writer.seek(toOffset: 0)
        try writer.write(contentsOf: Data("BetterJIT-mapped-v1:\(token)\n".utf8))
        try writer.synchronize()

        let lease = MappedLease(token: token, slot: 1,
                                offset: UInt64(MappedDataLane.headerSize + MappedDataLane.slotSize),
                                capacity: MappedDataLane.slotSize, generation: 7)
        let input = Data((0..<8192).map { UInt8(truncatingIfNeeded: $0 * 17 + 3) })
        try writer.seek(toOffset: lease.offset)
        try writer.write(contentsOf: input)
        try writer.synchronize()

        let lane = try MappedDataLane(url: url, token: token)
        XCTAssertEqual(try lane.read(lease, length: input.count, expectedHash: MappedDataLane.fnv1a(input)), input)

        let output = Data((0..<65536).map { UInt8(truncatingIfNeeded: $0 * 29 + 11) })
        XCTAssertEqual(try lane.write(output, to: lease), MappedDataLane.fnv1a(output))
        try writer.seek(toOffset: lease.offset)
        XCTAssertEqual(try writer.read(upToCount: output.count), output)

        let invalid = MappedLease(token: token, slot: 1, offset: lease.offset + 1,
                                  capacity: lease.capacity, generation: lease.generation)
        XCTAssertThrowsError(try lane.read(invalid, length: 1, expectedHash: 0))
        lane.close(); try writer.close()
    }
}
#endif
