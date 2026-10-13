// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJITLinux

final class LinuxFileSystemTests: XCTestCase {
    func testOverlayIndexAndRanges() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        try Data([1,2,3,4,5]).write(to:root.appendingPathComponent("host.bin"))
        try JSONEncoder().encode(["/host.bin":0o755]).write(to:root.appendingPathComponent(".modes.json"))
        let fs=try DirectoryLinuxFileSystem(root:root,overlay:["/test/hello":Data([9,8,7,6])])
        let object=try JSONSerialization.jsonObject(with:fs.indexJSON()) as! [String:Any]
        let entries=object["entries"] as! [[Any]]
        XCTAssertTrue(entries.contains { ($0.first as? String) == "/test/hello" })
        let hostRow = try XCTUnwrap(entries.first { ($0.first as? String) == "/host.bin" })
        XCTAssertEqual(hostRow[2] as? Int, 0o755)
        XCTAssertFalse(entries.contains { ($0.first as? String) == "/.modes.json" })
        XCTAssertEqual(try fs.fileSize(path:"/test/hello"),4)
        XCTAssertEqual(try fs.fileSize(path:"/host.bin"),5)
        XCTAssertEqual(try fs.readFile(path:"/test/hello",offset:1,length:2),Data([8,7]))
        XCTAssertEqual(try fs.readFile(path:"/host.bin",offset:2,length:2),Data([3,4]))
        XCTAssertThrowsError(try fs.readFile(path:"/../escape",offset:nil,length:nil))
        XCTAssertThrowsError(try fs.fileSize(path:"/../escape"))
    }
    func testOverlayReplacesStagedFileMetadata() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        try Data([1]).write(to:root.appendingPathComponent("input"))
        let bytes=Data([9,8,7,6])
        let fs=try DirectoryLinuxFileSystem(root:root,overlay:["/input":bytes])
        let object=try JSONSerialization.jsonObject(with:fs.indexJSON()) as! [String:Any]
        let rows=(object["entries"] as! [[Any]]).filter { $0.first as? String == "/input" }
        XCTAssertEqual(rows.count,1)
        XCTAssertEqual(rows.first?[3] as? Int,bytes.count)
        XCTAssertEqual(try fs.readFile(path:"/input",offset:nil,length:nil),bytes)
    }

}
