// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJITLinux

@MainActor final class LinuxHarness {
    enum Mode { case smoke, wineCommand }
    private(set) var session: LinuxRuntimeSession?
    private let changed: @MainActor (LinuxRuntimeSession?,String,String)->Void
    init(changed:@escaping @MainActor (LinuxRuntimeSession?,String,String)->Void) { self.changed=changed }

    static var rootURL: URL {
        FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("linuxroot",isDirectory:true)
    }
    static var winePresent: Bool {
        FileManager.default.fileExists(atPath:rootURL.appendingPathComponent("opt/wine/bin/wine").path)
    }

    func run(_ mode:Mode) async throws -> LinuxRuntimeResult {
        let cache=FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
            .appendingPathComponent("BetterJITLinux/xlat-cache",isDirectory:true)
        let backend=try LinkedLinuxFEXBackend(cacheDirectory:cache)
        let fs=try DirectoryLinuxFileSystem(root:Self.rootURL,
                                            overlay:["/test/hello-static":LinuxSmokeFixture.elf])
        let cfg:LinuxRuntimeConfiguration
        switch mode {
        case .smoke:
            cfg=LinuxRuntimeConfiguration(arguments:["/test/hello-static"],timeoutSeconds:30,display:nil,
                                          regions:true,slowWaitMilliseconds:100)
        case .wineCommand:
            guard Self.winePresent else {
                backend.close()
                throw LinuxRuntimeError.guest("Wine rootfs is missing at Documents/linuxroot/opt/wine/bin/wine.")
            }
            cfg=LinuxRuntimeConfiguration(arguments:["/opt/wine/bin/wine","cmd","/c","ver"],
                                          environment:["WINEDEBUG":"-all"],timeoutSeconds:90,
                                          display:"1024x768",regions:true,slowWaitMilliseconds:100)
        }
        let s=try LinuxRuntimeSession(backend:backend,fileSystem:fs,configuration:cfg)
        session=s
        var log=""
        s.onLog={ [weak self] text in
            log += text
            self?.changed(s,mode == .smoke ? "Linux smoke running" : "Wine running",log)
        }
        changed(s,mode == .smoke ? "Starting Linux smoke" : "Starting Wine",log)
        await Task.yield()
        do {
            let result=try await s.run()
            let status="Exited \(result.exitCode) in \(String(format:"%.0f",result.milliseconds)) ms"
            changed(s,status,result.log)
            return result
        } catch {
            changed(s,"Linux runtime failed",log+"\n"+error.localizedDescription)
            throw error
        }
    }

    func stop() {
        session?.close(); session=nil
        changed(nil,"Stopped","")
    }
}
