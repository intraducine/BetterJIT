// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJITLinux
#if canImport(Network) && canImport(WebKit)
import Foundation
private final class SparseRouteBackend:LinuxTranslationBackend,@unchecked Sendable {
    var received:[UInt64]=[]
    func configuration(space:UInt32)throws->Data {Data()}
    func initialState(space:UInt32)throws->Data {Data()}
    func dispatcher(space:UInt32)throws->Data {Data()}
    func unit(space:UInt32,rip:UInt32)throws->Data {Data()}
    func region(space:UInt32,profile:Data)throws->Data {Data()}
    func step(space:UInt32,rip:UInt64)throws->Data {received.append(rip);return Data(String(rip).utf8)}
    func mapCode(space:UInt32,address:UInt64,bytes:Data,abi:UInt32)throws {}
    func patchCode(space:UInt32,address:UInt64,bytes:Data)throws {}
    func unmapCode(space:UInt32,address:UInt64,size:UInt64)throws {}
    func drop(space:UInt32){};func close(){}
}
final class LinuxSparseTransportTests:XCTestCase {
    func testFullWidthStepRouteAndSparsePageAuthentication() async throws {
        let backend=SparseRouteBackend(),token="sparse-route-test"
        let input=Data([0,0xff,0xc3,0xa9])
        let server=LinuxLoopbackServer(token:token,assets:["/linux/web/sparse.html":(Data("sparse".utf8),"text/html")],backend:backend,fileSystem:try DirectoryLinuxFileSystem(root:FileManager.default.temporaryDirectory.appendingPathComponent("sparse-route-"+UUID().uuidString)),onEvents:{_ in},standardInput:input)
        let port=try await server.start(timeout:5);defer{server.stop()}
        let base="http://127.0.0.1:\(port)"
        let (_,initial)=try await URLSession.shared.data(from:URL(string:base+"/linux/web/sparse.html?session="+token)!)
        XCTAssertEqual((initial as? HTTPURLResponse)?.statusCode,200)
        let unauthenticated=URLSession(configuration:.ephemeral)
        defer{unauthenticated.invalidateAndCancel()}
        let (_,denied)=try await unauthenticated.data(from:URL(string:base+"/stdin")!)
        XCTAssertEqual((denied as? HTTPURLResponse)?.statusCode,403)
        var stdin=URLRequest(url:URL(string:base+"/stdin")!);stdin.setValue("BJSESSION="+token,forHTTPHeaderField:"Cookie")
        let (stdinBytes,stdinResponse)=try await URLSession.shared.data(for:stdin)
        XCTAssertEqual((stdinResponse as? HTTPURLResponse)?.statusCode,200);XCTAssertEqual(stdinBytes,input)
        for rip in [UInt64(0x123456780000),UInt64.max] {
            var request=URLRequest(url:URL(string:base+"/xlat/step?space=9&rip=\(rip)")!);request.setValue("BJSESSION="+token,forHTTPHeaderField:"Cookie")
            let (data,response)=try await URLSession.shared.data(for:request);XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,200);XCTAssertEqual(String(data:data,encoding:.utf8),String(rip))
        }
        var bad=URLRequest(url:URL(string:base+"/xlat/step?space=9&rip=18446744073709551616")!);bad.setValue("BJSESSION="+token,forHTTPHeaderField:"Cookie")
        let (_,response)=try await URLSession.shared.data(for:bad);XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,500);XCTAssertEqual(backend.received,[0x123456780000,UInt64.max])
    }
    func testSparseFailureEventsAndDefaultProfileStayExplicit() throws {
        let c=LinuxRuntimeConfiguration(arguments:["/a"]);XCTAssertEqual(c.executionProfile,.direct)
        XCTAssertTrue(LinuxRuntimeEvent(kind:.unsupported,text:"no shared memory").valid)
        XCTAssertTrue(LinuxRuntimeEvent(kind:.failure,text:"translation failed").valid)
        XCTAssertFalse(LinuxRuntimeEvent(kind:.unsupported,text:nil,code:0).valid)
        XCTAssertEqual(LinuxRuntimeError.unsupported("missing").errorDescription,"missing")
    }
    @MainActor func testFiniteStdinBoundsAndProfileFailBeforeStartingWebContent() throws {
        let backend=SparseRouteBackend(),files=try DirectoryLinuxFileSystem(root:FileManager.default.temporaryDirectory.appendingPathComponent("sparse-input-"+UUID().uuidString))
        XCTAssertThrowsError(try LinuxRuntimeSession(backend:backend,fileSystem:files,configuration:.init(arguments:["/a"],standardInput:Data()))) {error in
            guard let runtime=error as? LinuxRuntimeError,case .unsupported=runtime else{return XCTFail("Expected explicit input profile refusal: \(error)")}
        }
        XCTAssertThrowsError(try LinuxRuntimeSession(backend:backend,fileSystem:files,configuration:.init(arguments:["/a"],regions:false,useNativeChannels:false,standardIO:.captured,executionProfile:.sparseStatic,standardInput:Data(count:1024*1024+1)))) {error in
            guard let runtime=error as? LinuxRuntimeError,case .invalidConfiguration=runtime else{return XCTFail("Expected bounded input refusal: \(error)")}
        }
    }
}
#endif
