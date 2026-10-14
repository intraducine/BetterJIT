// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJITLinux
#if canImport(WebKit) && canImport(Network)
import WebKit
#if os(macOS)
import AppKit
#endif

/// Ownership fixture only: no translator or guest execution is substituted.
private final class OwnershipBackend:LinuxTranslationBackend {
    var closes=0
    private func unused() throws -> Data { throw LinuxRuntimeError.guest("Ownership fixture has no translator.") }
    func configuration(space:UInt32) throws -> Data { try unused() }
    func dispatcher(space:UInt32) throws -> Data { try unused() }
    func initialState(space:UInt32) throws -> Data { try unused() }
    func unit(space:UInt32,rip:UInt32) throws -> Data { try unused() }
    func region(space:UInt32,profile:Data) throws -> Data { try unused() }
    func mapCode(space:UInt32,address:UInt64,bytes:Data,abi:UInt32) throws { _=try unused() }
    func patchCode(space:UInt32,address:UInt64,bytes:Data) throws { _=try unused() }
    func unmapCode(space:UInt32,address:UInt64,size:UInt64) throws { _=try unused() }
    func drop(space:UInt32) {}
    func close() { closes += 1 }
}

final class LinuxSessionOwnershipTests:XCTestCase {
    @MainActor func testLaunchURLPreservesFormSensitiveArgumentsAndEnvironment() throws {
        #if os(macOS)
        _=NSApplication.shared
        #endif
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let arguments=["/test/a+b","C++","a b","%2B","a&b=c"]
        let environment=["WINEDEBUG":"+module,+process","VALUE":"a+b & c=%2B"]
        let session=try LinuxRuntimeSession(backend:OwnershipBackend(),fileSystem:DirectoryLinuxFileSystem(root:root),
            configuration:.init(arguments:arguments,environment:environment,currentDirectory:"/a+b",standardIO:.captured))
        defer { session.close() }
        let url=try session.launchURL(port:12345)
        let components=try XCTUnwrap(URLComponents(url:url,resolvingAgainstBaseURL:false))
        let encoded=try XCTUnwrap(components.percentEncodedQuery)
        XCTAssertFalse(encoded.contains("+"),"URLSearchParams would convert an unescaped plus to a space.")
        XCTAssertTrue(encoded.contains("%2B"))
        let query=Dictionary(uniqueKeysWithValues:components.queryItems!.map{($0.name,$0.value!)})
        XCTAssertEqual(try JSONDecoder().decode([String].self,from:Data(query["argv"]!.utf8)),arguments)
        XCTAssertEqual(try JSONDecoder().decode([String:String].self,from:Data(query["env"]!.utf8)),environment)
        XCTAssertEqual(query["cwd"],"/a+b")
        XCTAssertEqual(query["stdio"],"captured")
    }
    @MainActor func testTerminalCallbacksReleaseCapturedSession() async throws {
        #if os(macOS)
        _=NSApplication.shared
        #endif
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let backend=OwnershipBackend()
        weak var released:LinuxRuntimeSession?
        try autoreleasepool {
            let session=try LinuxRuntimeSession(backend:backend,
                fileSystem:DirectoryLinuxFileSystem(root:root),configuration:.init(arguments:["/unused"]))
            released=session
            session.onLog={ [session] _ in _=session.state }
            session.onWindow={ [session] _ in _=session.state }
            session.onScreenshot={ [session] _,_ in _=session.state }
            session.close();session.close()
            XCTAssertNil(session.onLog)
            XCTAssertNil(session.onWindow)
            XCTAssertNil(session.onScreenshot)
            XCTAssertEqual(backend.closes,1)
        }
        XCTAssertNil(released,"A completed process must not retain itself through its event callbacks.")
    }
}
#else
final class LinuxSessionOwnershipTests:XCTestCase {
    func testRequiresAppleWebKit() throws {
        throw XCTSkip("Linux session callback ownership requires Apple WebKit; no substitute pass.")
    }
}
#endif
