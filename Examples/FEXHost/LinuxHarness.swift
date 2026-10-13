// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import Darwin
import BetterJITLinux

@MainActor final class LinuxHarness {
    enum Mode: Equatable { case smoke, services, userspace, wineCommand, wineDirect, wineFlat }
    private(set) var session: LinuxRuntimeSession?
    private(set) var counters: [String:Int] = [:]
    private let changed: @MainActor (LinuxRuntimeSession?,String,String)->Void
    init(changed:@escaping @MainActor (LinuxRuntimeSession?,String,String)->Void) { self.changed=changed }
    static var documentsRootURL: URL {
        FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("linuxroot",isDirectory:true)
    }
    static var rootURL: URL {
        if LinuxRootManifest.wineEntryExists(at:documentsRootURL) { return documentsRootURL }
        if let bundled=Bundle.main.resourceURL?.appendingPathComponent("device-linuxroot",isDirectory:true),
           LinuxRootManifest.wineEntryExists(at:bundled) { return bundled }
        return documentsRootURL
    }
    static var winePresent: Bool {
        LinuxRootManifest.wineEntryExists(at:rootURL)
    }
    static var flatWinePresent: Bool {
        FileManager.default.fileExists(atPath:rootURL.appendingPathComponent("opt/wine-flat/.betterjit-wine-flat.json").path)
    }
    func run(_ mode:Mode, nativeChannels:Bool = false) async throws -> LinuxRuntimeResult {
        counters=[:]
        let cache=FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
            .appendingPathComponent("BetterJITLinux/xlat-cache",isDirectory:true)
        let wine = mode == .wineCommand || mode == .wineDirect || mode == .wineFlat
        // Keep fault operands in the same phone report. The translator's
        // option fingerprint separates these units from ordinary cached code.
        let backend=try LinkedLinuxFEXBackend(cacheDirectory:cache,extraOptions:wine ? "memtrace=1" : "")
        defer { counters.merge(backend.statistics(),uniquingKeysWith:{ _,new in new }); backend.close() }
        let fs=try DirectoryLinuxFileSystem(root:Self.rootURL,overlay:[
            "/test/hello-static":LinuxSmokeFixture.elf,
            "/test/session-static":LinuxSessionFixture.elf,
            "/test/session-input.txt":LinuxSessionFixture.input,
            "/test/userspace.bin":LinuxUserspaceWorkload.payload,
            "/etc/passwd":Data("root:x:0:0:root:/root:/bin/sh\nuser:x:\(getuid()):\(getgid()):user:/home/user:/bin/sh\n".utf8),
            "/etc/group":Data("root:x:0:\nuser:x:\(getgid()):user\n".utf8)])
        let cfg:LinuxRuntimeConfiguration
        switch mode {
        case .smoke:
            cfg=LinuxRuntimeConfiguration(arguments:["/test/hello-static"],timeoutSeconds:30,display:nil,
                                          regions:true,slowWaitMilliseconds:100,useNativeChannels:nativeChannels)
        case .services:
            cfg=LinuxRuntimeConfiguration(arguments:["/test/session-static"],currentDirectory:"/test",
                                          timeoutSeconds:40,display:nil,regions:true,
                                          slowWaitMilliseconds:100,useNativeChannels:nativeChannels)
        case .userspace:
            cfg=LinuxRuntimeConfiguration(arguments:LinuxUserspaceWorkload.arguments,timeoutSeconds:90,
                                          display:nil,regions:true,slowWaitMilliseconds:100,useNativeChannels:nativeChannels)
        case .wineCommand, .wineDirect, .wineFlat:
            guard Self.winePresent else {
                throw LinuxRuntimeError.guest("Wine rootfs is missing at Documents/linuxroot/opt/wine/bin/wine.")
            }
            var environment=["WINEDEBUG":"-all","WINEDLLOVERRIDES":"winemenubuilder.exe=d"]
            if mode == .wineDirect || mode == .wineFlat { environment["WINELOADERNOEXEC"]="1"; environment["WINEARCH"]="win64" }
            if mode == .wineFlat {
                guard Self.flatWinePresent else { throw LinuxRuntimeError.guest("Source-built flat-window Wine candidate is missing.") }
                environment["WINEPREFIX"]="/home/user/.wine-flat"
                // PE and remaining Unix modules come from the signed stock
                // root; the new loader/ntdll live in the separate candidate.
                environment["WINEDLLPATH"]="/usr/lib/wine"
                environment["LD_LIBRARY_PATH"]="/opt/wine-flat/lib/wine/x86_64-unix:/usr/lib"
                environment["WINEDEBUG"]="+module,+loaddll,+process"
            }
            let arguments=mode == .wineFlat
                ? ["/bin/busybox","sh","-c","/opt/wine-flat/share/betterjit-provenance/fs-reset.elf && exec /opt/wine-flat/bin/wine /usr/lib/wine/x86_64-windows/cmd.exe /c ver"]
                : ["/opt/wine/bin/wine","cmd","/c","ver"]
            cfg=LinuxRuntimeConfiguration(arguments:arguments,
                                          environment:environment,timeoutSeconds:mode == .wineFlat ? 180 : 90,
                                          display:"1024x768",regions:false,slowWaitMilliseconds:100,
                                          useNativeChannels:nativeChannels,sharedAddressSpace:mode != .wineFlat)
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
        let result=try await s.run()
        counters=s.nativeChannelStatistics
        return result
    }
    func stop() { session?.close(); session=nil; changed(nil,"Stopped","") }
}
