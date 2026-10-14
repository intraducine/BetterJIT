// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(WebKit) && canImport(Network)
import Foundation
import WebKit
import BetterJITLinux
#if canImport(Darwin)
import Darwin
#endif

/// A one-shot guest process. Code, pointers and callbacks stay inside the guest
/// boundary; this is not a native executable-memory/function-pointer API.
@MainActor public final class FEXProcess {
    public typealias Configuration = LinuxRuntimeConfiguration
    public typealias Result = LinuxRuntimeResult
    public let session: LinuxRuntimeSession
    public var webView: WKWebView { session.webView }
    public var onLog: (@MainActor (String)->Void)? {
        get { session.onLog }
        set { session.onLog = newValue }
    }
    private let backend: LinkedLinuxFEXBackend
    private var completedChannelStatistics:[String:Int]=[:]
    public init(root:URL, configuration:Configuration, overlay:[String:Data]=[:],
                cacheDirectory:URL?=nil, memoryTrace:Bool=false) throws {
        guard root.isFileURL else { throw LinuxRuntimeError.invalidConfiguration("Guest root must be a local directory.") }
        let cache=cacheDirectory ?? FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
            .appendingPathComponent("BetterJIT/FEX",isDirectory:true)
        let native=try LinkedLinuxFEXBackend(cacheDirectory:cache,extraOptions:memoryTrace ? "memtrace=1" : "")
        var files=overlay
        if files["/etc/passwd"] == nil {
            files["/etc/passwd"]=Data("root:x:0:0:root:/root:/bin/sh\nuser:x:\(getuid()):\(getgid()):user:/home/user:/bin/sh\n".utf8)
        }
        if files["/etc/group"] == nil { files["/etc/group"]=Data("root:x:0:\nuser:x:\(getgid()):user\n".utf8) }
        do {
            let fs=try DirectoryLinuxFileSystem(root:root,overlay:files)
            session=try LinuxRuntimeSession(backend:native,fileSystem:fs,configuration:configuration)
            backend=native
        } catch { native.close(); throw error }
    }
    public func statistics() -> [String:Int] {
        backend.statistics().merging(completedChannelStatistics,uniquingKeysWith:{_,new in new})
            .merging(session.nativeChannelStatistics,uniquingKeysWith:{_,new in new})
    }
    /// Always closes the process after exit, failure or cancellation. Create a
    /// new FEXProcess for another command; the translator cache is reused.
    public func run() async throws -> Result {
        defer { close() }
        return try await withTaskCancellationHandler(operation:{
            try Task.checkCancellation()
            return try await session.run()
        },onCancel:{ [weak self] in Task { @MainActor in self?.close() } })
    }
    public func close() {
        completedChannelStatistics.merge(session.nativeChannelStatistics,uniquingKeysWith:{_,new in new})
        session.close()
    }
}
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
/// Mount this view while the process runs. The packaged adapter owns WebKit;
/// the consumer does not implement transport or translator callbacks.
@MainActor public struct FEXProcessView: UIViewRepresentable {
    public let process:FEXProcess
    public init(process:FEXProcess) { self.process=process }
    public func makeUIView(context:Context) -> WKWebView { process.webView }
    public func updateUIView(_ view:WKWebView,context:Context) {}
}
#endif
#endif
