// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import Darwin
import BetterJITLinux
import BetterJITFEXAdapter

@MainActor final class LinuxHarness {
    enum Mode: Equatable { case smoke, services, userspace, wineCommand, wineDirect, adaptedWine(AdaptedWinePhase) }
    private(set) var session: LinuxRuntimeSession?
    private(set) var counters: [String:Int] = [:]
    private var process:FEXProcess?
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
        let adapted:AdaptedWinePhase?
        if case .adaptedWine(let phase)=mode { adapted=phase } else { adapted=nil }
        let wine = mode == .wineCommand || mode == .wineDirect || adapted != nil
        // Keep fault operands in the same phone report. The translator's
        // option fingerprint separates these units from ordinary cached code.
        let overlay:[String:Data]=[
            "/test/hello-static":LinuxSmokeFixture.elf,
            "/test/session-static":LinuxSessionFixture.elf,
            "/test/session-input.txt":LinuxSessionFixture.input,
            "/test/userspace.bin":LinuxUserspaceWorkload.payload,
            "/etc/passwd":Data("root:x:0:0:root:/root:/bin/sh\nuser:x:\(getuid()):\(getgid()):user:/home/user:/bin/sh\n".utf8),
            "/etc/group":Data("root:x:0:\nuser:x:\(getgid()):user\n".utf8)]
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
        case .wineCommand, .wineDirect, .adaptedWine:
            guard Self.winePresent else {
                throw LinuxRuntimeError.guest("Wine rootfs is missing at Documents/linuxroot/opt/wine/bin/wine.")
            }
            var environment=["WINEDEBUG":"-all","WINEDLLOVERRIDES":"winemenubuilder.exe=d"]
            if mode == .wineDirect || adapted != nil { environment["WINELOADERNOEXEC"]="1"; environment["WINEARCH"]="win64" }
            if adapted != nil {
                guard Self.flatWinePresent else { throw LinuxRuntimeError.guest("Source-built flat-window Wine candidate is missing.") }
                environment["WINEPREFIX"]="/home/user/.wine-flat"
                environment["BETTERJIT_WINE_SPAWN"]="1"
                // PE and remaining Unix modules come from the signed stock
                // root; the new loader/ntdll live in the separate candidate.
                environment["WINEDLLPATH"]="/usr/lib/wine"
                environment["LD_LIBRARY_PATH"]="/opt/wine-flat/lib/wine/x86_64-unix:/usr/lib"
                environment["WINEDEBUG"]="+module,+loaddll,+process"
            }
            let arguments=adapted?.arguments ?? ["/opt/wine/bin/wine","cmd","/c","ver"]
            cfg=LinuxRuntimeConfiguration(arguments:arguments,
                                          environment:environment,timeoutSeconds:adapted?.timeout ?? 90,
                                          display:adapted == nil ? "1024x768" : nil,regions:false,slowWaitMilliseconds:100,
                                          useNativeChannels:nativeChannels,sharedAddressSpace:adapted == nil,
                                          standardIO:adapted == nil ? .terminal : .captured)
        }
        let owned=try FEXProcess(root:Self.rootURL,configuration:cfg,overlay:overlay,
                                cacheDirectory:cache,memoryTrace:wine)
        process=owned
        let s=owned.session
        session=s
        // Close before a later phase allocates another guest. Keep terminal logs in the report.
        defer { counters=owned.statistics(); owned.close(); process=nil; session=nil; changed(nil,"Finished","") }
        var log=""
        s.onLog={ [weak self] text in
            log=String((log+text).suffix(128*1024))
            self?.changed(s,"Guest running",log)
        }
        s.onOutput={ [weak self] _,text in
            log=String((log+text).suffix(128*1024))
            self?.changed(s,"Guest running",log)
        }
        changed(s,"Starting guest",log)
        await Task.yield()
        let result=try await owned.run()
        return result
    }
    func stop() { process?.close(); process=nil; session=nil; changed(nil,"Stopped","") }
}
