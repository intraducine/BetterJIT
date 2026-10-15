// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import BetterJITLinux
#if os(macOS) && canImport(WebKit) && canImport(Network)
import Foundation
import AppKit
import WebKit
import Darwin

// Test-only HTTP bridge to the real, separately built native FEX service.
private final class SparseNativeHost: LinuxTranslationBackend, @unchecked Sendable {
    private let process=Process(), lock=NSLock()
    private var closed=false, counts:[String:Int]=[:]
    private let base:String
    private final class Reply: @unchecked Sendable { var data:Data?;var error:Error?;var status:Int? }
    init(binary:String) throws {
        let fd=socket(AF_INET,SOCK_STREAM,0)
        guard fd >= 0 else { throw LinuxRuntimeError.server("Test port allocation failed.") }
        var address=sockaddr_in();address.sin_len=UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family=sa_family_t(AF_INET);address.sin_addr.s_addr=inet_addr("127.0.0.1")
        let bound=withUnsafePointer(to:&address) { $0.withMemoryRebound(to:sockaddr.self,capacity:1) { Darwin.bind(fd,$0,socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        var size=socklen_t(MemoryLayout<sockaddr_in>.size)
        let named=withUnsafeMutablePointer(to:&address) { $0.withMemoryRebound(to:sockaddr.self,capacity:1) { getsockname(fd,$0,&size) } }
        Darwin.close(fd)
        guard bound == 0, named == 0 else { throw LinuxRuntimeError.server("Test port lookup failed.") }
        let port=UInt16(bigEndian:address.sin_port);base="http://127.0.0.1:\(port)"
        process.executableURL=URL(fileURLWithPath:binary);process.arguments=["--linux",String(port),"guestmem=broker1"]
        process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice
        try process.run()
    }
    private func request(_ path:String,body:Data?=nil) throws -> Data {
        let box=Reply(),done=DispatchSemaphore(value:0)
        var r=URLRequest(url:URL(string:base+path)!);r.timeoutInterval=10
        if let body { r.httpMethod="POST";r.httpBody=body }
        let task=URLSession.shared.dataTask(with:r) { data,response,error in
            box.data=data;box.status=(response as? HTTPURLResponse)?.statusCode;box.error=error;done.signal()
        };task.resume()
        guard done.wait(timeout:.now()+12) == .success else {task.cancel();throw LinuxRuntimeError.server("Native test request deadline.")}
        if let error=box.error {throw error}
        guard box.status == 200, let data=box.data else {throw LinuxRuntimeError.server("Native test HTTP failure.")}
        return data
    }
    func ready() async throws {
        for _ in 0..<100 { if (try? configuration(space:1)) != nil { return };try await Task.sleep(nanoseconds:20_000_000) }
        throw LinuxRuntimeError.server("Native sparse translator did not start.")
    }
    func configuration(space:UInt32)throws->Data {try request("/xlat/config?space=\(space)")}
    func initialState(space:UInt32)throws->Data {try request("/xlat/state?space=\(space)")}
    func dispatcher(space:UInt32)throws->Data {throw LinuxRuntimeError.unsupported("No direct dispatcher in sparse test.")}
    func unit(space:UInt32,rip:UInt32)throws->Data {throw LinuxRuntimeError.unsupported("No direct unit in sparse test.")}
    func region(space:UInt32,profile:Data)throws->Data {throw LinuxRuntimeError.unsupported("No regions in sparse test.")}
    func step(space:UInt32,rip:UInt64)throws->Data {
        let data=try request("/xlat/step?space=\(space)&rip=\(rip)");lock.lock();counts["steps",default:0]+=1;lock.unlock();return data
    }
    func mapCode(space:UInt32,address:UInt64,bytes:Data,abi:UInt32)throws {
        _=try request("/xlat/code?space=\(space)&addr=\(String(address,radix:16))",body:bytes)
        lock.lock();counts["maps",default:0]+=1;lock.unlock()
    }
    func patchCode(space:UInt32,address:UInt64,bytes:Data)throws {throw LinuxRuntimeError.unsupported("Immutable sparse code.")}
    func unmapCode(space:UInt32,address:UInt64,size:UInt64)throws {throw LinuxRuntimeError.unsupported("Immutable sparse code.")}
    func drop(space:UInt32) {_=try? request("/xlat/drop?space=\(space)")}
    func statistics()->[String:Int] {lock.lock();defer{lock.unlock()};return counts}
    func close(){lock.lock();if closed{lock.unlock();return};closed=true;lock.unlock();if process.isRunning{process.terminate();process.waitUntilExit()}}
    deinit {close()}
}
final class SparseWebKitHostTests:XCTestCase {
    @MainActor func testOrdinaryCompiledCThroughProductionSparsePage() async throws {
        guard let native=ProcessInfo.processInfo.environment["BETTERJIT_SPARSE_FEXSERVE"] else {
            throw XCTSkip("Opt-in real native FEX/WebKit test; run after building the host translator.")
        }
        _=NSApplication.shared
        let root=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let object=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("Examples/FEXHost/Guest/sparse-rot13.json"))) as! [String:Any]
        let elf=try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(object["elf"] as? String)))
        let inputs:[(String?,Int,String,String)]=[("Hello, BetterJIT 2026!",0,"Uryyb, OrggreWVG 2026!\n",""),("",0,"\n",""),("AaNnZz09- é🙂",0,"NnAaMm09- é🙂\n",""),(nil,64,"","usage: rot13 TEXT\n"),(String(repeating:"x",count:256),65,"","input too long\n")]
        for (arg,code,out,err) in inputs {
            let backend=try SparseNativeHost(binary:native);defer{backend.close()};try await backend.ready()
            let files=try DirectoryLinuxFileSystem(root:root.appendingPathComponent(".build/sparse-empty-root"),overlay:["/test/rot13":elf])
            let session=try LinuxRuntimeSession(backend:backend,fileSystem:files,configuration:.init(arguments:["/test/rot13"]+(arg.map{[$0]} ?? []),timeoutSeconds:60,regions:false,useNativeChannels:false,standardIO:.captured,executionProfile:.sparseStatic))
            let window=NSWindow(contentRect:NSRect(x:0,y:0,width:480,height:320),styleMask:[.titled],backing:.buffered,defer:false)
            window.isReleasedWhenClosed=false;window.contentView=session.webView;window.orderFrontRegardless();defer{session.close();window.close()}
            let value:LinuxRuntimeResult
            do {value=try await session.run()}
            catch LinuxRuntimeError.unsupported(let reason) {
                if reason.contains("engine")&&reason.contains("memory") {throw XCTSkip(reason)}
                throw LinuxRuntimeError.unsupported(reason)
            }
            XCTAssertEqual(value.exitCode,code);XCTAssertEqual(value.stdout,out);XCTAssertEqual(value.stderr,err)
            XCTAssertFalse(value.outputTruncated);XCTAssertTrue(value.log.contains("retainedUntilSessionTeardown"));XCTAssertTrue(value.log.contains("\"workerRetirementAcknowledged\":false"));XCTAssertGreaterThan(backend.statistics()["steps"] ?? 0,0);XCTAssertGreaterThan(backend.statistics()["maps"] ?? 0,0)
            print("[sparse-webkit] \(try String(data:JSONSerialization.data(withJSONObject:["elfSHA256":object["elfSHA256"] ?? "","exitCode":code,"stdout":value.stdout,"stderr":value.stderr,"native":backend.statistics(),"runtimeLog":value.log],options:[.sortedKeys]),encoding:.utf8)!)")
        }
    }
}
#endif
