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
    let outputFixture: Bool
    init(outputFixture:Bool=false) { self.outputFixture=outputFixture }
    private func unused() throws -> Data { throw LinuxRuntimeError.guest("Ownership fixture has no translator.") }
    func configuration(space:UInt32) throws -> Data { if outputFixture { return Data("{}".utf8) };return try unused() }
    func dispatcher(space:UInt32) throws -> Data { if outputFixture { return Data() };return try unused() }
    func initialState(space:UInt32) throws -> Data { if outputFixture { return Data() };return try unused() }
    func unit(space:UInt32,rip:UInt32) throws -> Data { try unused() }
    func region(space:UInt32,profile:Data) throws -> Data { try unused() }
    func mapCode(space:UInt32,address:UInt64,bytes:Data,abi:UInt32) throws { _=try unused() }
    func patchCode(space:UInt32,address:UInt64,bytes:Data) throws { _=try unused() }
    func unmapCode(space:UInt32,address:UInt64,size:UInt64) throws { _=try unused() }
    func drop(space:UInt32) {}
    func close() { closes += 1 }
}

final class LinuxSessionOwnershipTests:XCTestCase {
    /// Real production page, HTTP endpoint and Swift consumer; only the guest worker is a fixture.
    /// This is output-transport coverage, not guest/FEX execution evidence.
    @MainActor func testProductionPageDeliversSeparateStreamsBeforeExit() async throws {
        #if os(macOS)
        _=NSApplication.shared
        #endif
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let session=try LinuxRuntimeSession(backend:OwnershipBackend(outputFixture:true),
            fileSystem:DirectoryLinuxFileSystem(root:root),
            configuration:.init(arguments:["/output-fixture"],timeoutSeconds:15,useNativeChannels:false,standardIO:.captured))
        #if os(macOS)
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:480,height:320),styleMask:[.titled],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.contentView=session.webView;window.orderFrontRegardless()
        defer { window.close() }
        #endif
        defer { session.close() }
        session.webView.configuration.userContentController.addUserScript(WKUserScript(source:"""
        window.Worker=class {
          constructor(name){this.name=name;this.closed=false;}
          terminate(){this.closed=true;}
          postMessage(){
            if(this.name!=='kworker_web.js')return;
            const emit=data=>{if(!this.closed)this.onmessage?.({data});};
            const write=(fd,bytes)=>emit({op:'write',fd,bytes:new Uint8Array(bytes)});
            const text=(fd,value)=>write(fd,new TextEncoder().encode(value));
            setTimeout(()=>{
              write(1,[97]);write(1,[98]);write(1,[0xe2]);write(2,[0xe2]);
              emit({op:'log',m:'diagnostic only'});
            },10);
            setTimeout(()=>{
              write(1,[0x82,0xac]);write(2,[0x82,0xac,0xff,0xe2]);
              text(1,'BetterJIT captured ');
            },350);
            setTimeout(()=>{
              text(1,'stdio OK\\n[page] exit 99\\n');
              emit({op:'exit',code:7});
            },700);
          }
        };
        """,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        var stdout="",stderr="",diagnostics=""
        session.onOutput={stream,text in if stream == .stdout { stdout+=text } else { stderr+=text }}
        session.onLog={diagnostics+=$0}
        let result=try await session.run()
        XCTAssertEqual(result.exitCode,7,"Guest text must not be interpreted as process completion.")
        XCTAssertEqual(result.stdout,"ab€BetterJIT captured stdio OK\n[page] exit 99\n")
        XCTAssertEqual(result.stderr,"€\u{FFFD}\u{FFFD}")
        XCTAssertEqual(stdout,result.stdout);XCTAssertEqual(stderr,result.stderr)
        XCTAssertEqual(diagnostics,result.log);XCTAssertTrue(result.log.contains("diagnostic only\n"))
        XCTAssertFalse(result.log.contains("captured stdio OK"));XCTAssertFalse(result.outputTruncated)
    }
    @MainActor func testCombinedOutputLimitKeepsValidUTF8AndRetainsExit() throws {
        #if os(macOS)
        _=NSApplication.shared
        #endif
        let root=FileManager.default.temporaryDirectory
        let session=try LinuxRuntimeSession(backend:OwnershipBackend(),fileSystem:DirectoryLinuxFileSystem(root:root),
            configuration:.init(arguments:["/unused"]))
        defer { session.close() }
        session.receiveEvents([.init(kind:.stdout,text:String(repeating:"a",count:4*1024*1024-2)),
                               .init(kind:.stderr,text:"€"),.init(kind:.log,text:"must not exceed limit"),.init(kind:.exit,code:9)])
        let result=try XCTUnwrap(session.result)
        XCTAssertEqual(result.stdout.utf8.count,4*1024*1024-2)
        XCTAssertEqual(result.stderr,"");XCTAssertEqual(result.log,"")
        XCTAssertTrue(result.outputTruncated);XCTAssertEqual(result.exitCode,9)
    }
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
            session.onOutput={ [session] _,_ in _=session.state }
            session.onWindow={ [session] _ in _=session.state }
            session.onScreenshot={ [session] _,_ in _=session.state }
            session.close();session.close()
            XCTAssertNil(session.onLog)
            XCTAssertNil(session.onOutput)
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
