// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJITLinux

@MainActor final class LinuxHarness {
    enum Mode { case smoke, services, wineCommand }
    private(set) var session: LinuxRuntimeSession?
    private(set) var counters: [String:Int] = [:]
    private let changed: @MainActor (LinuxRuntimeSession?,String,String)->Void
    init(changed:@escaping @MainActor (LinuxRuntimeSession?,String,String)->Void) { self.changed=changed }
    static var rootURL: URL {
        FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("linuxroot",isDirectory:true)
    }
    static var winePresent: Bool {
        LinuxRootManifest.wineEntryExists(at:rootURL)
    }
    func run(_ mode:Mode, nativeChannels:Bool = false) async throws -> LinuxRuntimeResult {
        let cache=FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
            .appendingPathComponent("BetterJITLinux/xlat-cache",isDirectory:true)
        let backend=try LinkedLinuxFEXBackend(cacheDirectory:cache)
        defer { counters=backend.statistics(); backend.close() }
        let fs=try DirectoryLinuxFileSystem(root:Self.rootURL,overlay:[
            "/test/hello-static":LinuxSmokeFixture.elf,
            "/test/session-static":LinuxSessionFixture.elf,
            "/test/session-input.txt":LinuxSessionFixture.input])
        let cfg:LinuxRuntimeConfiguration
        switch mode {
        case .smoke:
            cfg=LinuxRuntimeConfiguration(arguments:["/test/hello-static"],timeoutSeconds:30,display:nil,
                                          regions:true,slowWaitMilliseconds:100,useNativeChannels:nativeChannels)
        case .services:
            cfg=LinuxRuntimeConfiguration(arguments:["/test/session-static"],currentDirectory:"/test",
                                          timeoutSeconds:40,display:nil,regions:true,
                                          slowWaitMilliseconds:100,useNativeChannels:nativeChannels)
        case .wineCommand:
            guard Self.winePresent else {
                throw LinuxRuntimeError.guest("Wine rootfs is missing at Documents/linuxroot/opt/wine/bin/wine.")
            }
            cfg=LinuxRuntimeConfiguration(arguments:["/opt/wine/bin/wine","cmd","/c","ver"],
                                          environment:["WINEDEBUG":"-all"],timeoutSeconds:90,
                                          display:"1024x768",regions:true,slowWaitMilliseconds:100,
                                          useNativeChannels:nativeChannels)
        }
        let s=try LinuxRuntimeSession(backend:backend,fileSystem:fs,configuration:cfg)
        session=s
        // Close before a later phase allocates another guest. Keep terminal logs in the report.
        defer { s.close(); session=nil; changed(nil,"Finished","") }
        var log=""
        s.onLog={ [weak self] text in
            log=String((log+text).suffix(128*1024))
            self?.changed(s,"Guest running",log)
        }
        changed(s,"Starting guest",log)
        await Task.yield()
        return try await s.run()
    }
    func stop() { session?.close(); session=nil; changed(nil,"Stopped","") }
}
