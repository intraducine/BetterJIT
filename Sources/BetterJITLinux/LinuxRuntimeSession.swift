// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(WebKit) && canImport(Network)
import Foundation
import WebKit

@MainActor public final class LinuxRuntimeSession: NSObject, WKNavigationDelegate {
    public enum State: String, Sendable { case idle, starting, running, exited, failed, closed }

    public let webView: WKWebView
    public private(set) var state: State = .idle
    public private(set) var result: LinuxRuntimeResult?
    public private(set) var failure: LinuxRuntimeError?
    /// Counts successful native-channel replies; attachment alone is not usage.
    public var nativeChannelStatistics: [String:Int] { server?.channelStatistics() ?? [:] }
    public var onLog: (@MainActor (String)->Void)?
    /// UTF-8 text fragments; write boundaries are not line boundaries.
    public var onOutput: (@MainActor (LinuxOutputStream,String)->Void)?
    public var onWindow: (@MainActor ([String:String])->Void)?
    public var onScreenshot: (@MainActor (String,Data)->Void)?

    private let backend: LinuxTranslationBackend
    private let fileSystem: LinuxFileSystemSource
    private let configuration: LinuxRuntimeConfiguration
    private let gpuHandler: LinuxGPUChannelHandler?
    private let token=UUID().uuidString.lowercased()
    private var server: LinuxLoopbackServer?
    private var navigation: CheckedContinuation<Void,Error>?
    private var exitWaiter: CheckedContinuation<LinuxRuntimeResult,Error>?
    private var port: UInt16?
    private var startedAt: UInt64=0
    private var logText=""
    private var stdoutText="",stderrText="",retainedOutputBytes=0
    private var outputTruncated=false
    private var timeoutTask: Task<Void,Never>?

    public init(backend: LinuxTranslationBackend,
                fileSystem: LinuxFileSystemSource,
                configuration: LinuxRuntimeConfiguration,
                gpuHandler: LinuxGPUChannelHandler? = nil) throws {
        guard !configuration.arguments.isEmpty,
              configuration.arguments.count <= 256,
              configuration.arguments.allSatisfy({ $0.utf8.count <= 4096 && !$0.contains("\0") }),
              configuration.environment.count <= 512,
              configuration.timeoutSeconds.isFinite,
              (1...3600).contains(configuration.timeoutSeconds),
              configuration.currentDirectory.first == "/" else {
            throw LinuxRuntimeError.invalidConfiguration("Invalid Linux runtime arguments, environment, timeout or cwd.")
        }
        if configuration.executionProfile == .sparseStatic &&
           (configuration.standardIO != .captured || configuration.regions || configuration.useNativeChannels || !configuration.sharedAddressSpace ||
            configuration.display != nil || configuration.screenOnly || configuration.currentDirectory != "/" ||
            configuration.trace || configuration.traceCode || configuration.traceMaps) {
            throw LinuxRuntimeError.unsupported("The sparse command profile requires captured single-process execution without regions, native channels, display, tracing or a different cwd.")
        }
        self.backend=backend; self.fileSystem=fileSystem; self.configuration=configuration
        self.gpuHandler=gpuHandler
        let c=WKWebViewConfiguration()
        c.websiteDataStore = .default()
        c.defaultWebpagePreferences.allowsContentJavaScript=true
        webView=WKWebView(frame:.zero,configuration:c)
        super.init(); webView.navigationDelegate=self
    }

    public func start() async throws {
        guard state == .idle else { throw LinuxRuntimeError.invalidConfiguration("Linux runtime sessions start once.") }
        state = .starting
        // Cover server startup and WebKit navigation too: an uncommitted page
        // must not leave run() suspended forever before the guest timer starts.
        timeoutTask=Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(nanoseconds:UInt64((configuration.timeoutSeconds+15)*1_000_000_000)) }
            catch { return }
            if self.state == .running || self.state == .starting {
                self.fail(.guest("Linux guest exceeded its host deadline."))
            }
        }
        do {
            let assets=try Self.assets()
            let server=LinuxLoopbackServer(token:token,assets:assets,backend:backend,fileSystem:fileSystem,
                onEvents:{ [weak self] events in await self?.receiveEvents(events) },
                onWindow:{ [weak self] event in Task { @MainActor in self?.onWindow?(event) } },
                onShot:{ [weak self] name,data in Task { @MainActor in self?.onScreenshot?(name,data) } },
                gpuHandler:gpuHandler)
            self.server=server
            let port=try await server.start(timeout:10)
            guard state == .starting else { throw failure ?? LinuxRuntimeError.closed }
            self.port=port
            let url=try launchURL(port:port)
            startedAt=DispatchTime.now().uptimeNanoseconds
            try await withCheckedThrowingContinuation { (c:CheckedContinuation<Void,Error>) in
                navigation=c; webView.load(URLRequest(url:url))
            }
            if result == nil && failure == nil { state = .running }

        } catch {
            fail(error as? LinuxRuntimeError ?? .server("Linux runtime startup failed."))
            throw error
        }
    }

    public func waitForExit() async throws -> LinuxRuntimeResult {
        if let result { return result }
        if let failure { throw failure }
        guard state == .running || state == .starting else { throw LinuxRuntimeError.closed }
        return try await withCheckedThrowingContinuation { exitWaiter=$0 }
    }

    public func run() async throws -> LinuxRuntimeResult {
        try await start(); return try await waitForExit()
    }

    public func close() {
        guard state != .closed else { return }
        state = .closed; timeoutTask?.cancel(); timeoutTask=nil
        // Consumers commonly capture the mounted session in these callbacks.
        // Terminal cleanup must release those captures before the next guest.
        onLog=nil; onOutput=nil; onWindow=nil; onScreenshot=nil
        navigation?.resume(throwing:LinuxRuntimeError.closed); navigation=nil
        exitWaiter?.resume(throwing:LinuxRuntimeError.closed); exitWaiter=nil
        server?.stop(); server=nil; backend.close()
        webView.evaluateJavaScript("globalThis.betterjitClose?.()",completionHandler:nil)
        webView.stopLoading(); webView.navigationDelegate=nil
        webView.loadHTMLString("<!doctype html><title>Closed</title>",baseURL:nil)
    }

    func receiveEvents(_ events:[LinuxRuntimeEvent]) {
        for event in events {
            guard state != .closed, result == nil, failure == nil else { return }
            switch event.kind {
            case .exit: if let code=event.code { receiveExit(code) }
            case .unsupported: fail(.unsupported(event.text ?? "Sparse runtime is unsupported."))
            case .failure: fail(.guest(event.text ?? "Sparse runtime failed."))
            case .truncated: outputTruncated=true
            case .log, .stdout, .stderr:
                guard let text=event.text, !outputTruncated else { continue }
                let remaining=4*1024*1024-retainedOutputBytes
                var bytes=Data(text.utf8.prefix(remaining))
                // Keep a valid scalar prefix, never exceed the byte budget with U+FFFD.
                while String(data:bytes,encoding:.utf8) == nil { bytes.removeLast() }
                let accepted=String(decoding:bytes,as:UTF8.self)
                retainedOutputBytes+=bytes.count
                if bytes.count<text.utf8.count { outputTruncated=true }
                guard !accepted.isEmpty else { continue }
                if event.kind == .log { logText+=accepted;onLog?(accepted) }
                else if event.kind == .stdout { stdoutText+=accepted;onOutput?(.stdout,accepted) }
                else { stderrText+=accepted;onOutput?(.stderr,accepted) }
            }
        }
    }
    private func receiveExit(_ code:Int) {
        guard result == nil, failure == nil, state != .closed else { return }
        timeoutTask?.cancel(); timeoutTask=nil
        let ms=Double(DispatchTime.now().uptimeNanoseconds-startedAt)/1_000_000
        let value=LinuxRuntimeResult(exitCode:code,milliseconds:ms,log:logText,
                                    stdout:stdoutText,stderr:stderrText,outputTruncated:outputTruncated)
        result=value; state = .exited
        navigation?.resume(); navigation=nil
        exitWaiter?.resume(returning:value); exitWaiter=nil
    }
    private func fail(_ error:LinuxRuntimeError) {
        guard failure == nil, result == nil, state != .closed else { return }
        failure=error; state = .failed
        timeoutTask?.cancel(); timeoutTask=nil
        navigation?.resume(throwing:error); navigation=nil
        exitWaiter?.resume(throwing:error); exitWaiter=nil
        server?.stop(); server=nil
    }

    public func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {
        let c=self.navigation; self.navigation=nil; c?.resume()
    }
    public func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error) {
        fail(.server("Linux WebKit navigation failed."))
    }
    public func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) {
        fail(.server("Linux WebKit navigation failed before commit."))
    }
    public func webViewWebContentProcessDidTerminate(_ webView:WKWebView) {
        fail(.guest("Linux WebContent process terminated."))
    }
    public func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,
                        decisionHandler:@escaping (WKNavigationActionPolicy)->Void) {
        guard let port else { decisionHandler(.cancel); return }
        let u=action.request.url
        let ok=u?.scheme=="http" && u?.host=="127.0.0.1" && u?.port==Int(port)
        decisionHandler(ok ? .allow : .cancel)
    }

    func launchURL(port:UInt16) throws -> URL {
        var c=URLComponents()
        c.scheme="http"; c.host="127.0.0.1"; c.port=Int(port); c.path=configuration.executionProfile == .sparseStatic ? "/linux/web/sparse.html" : "/linux/web/linux.html"
        let argv=try JSONSerialization.data(withJSONObject:configuration.arguments)
        let env=try JSONSerialization.data(withJSONObject:configuration.environment)
        guard let a=String(data:argv,encoding:.utf8),let e=String(data:env,encoding:.utf8) else {
            throw LinuxRuntimeError.invalidConfiguration("Linux argv/environment are not UTF-8 JSON.")
        }
        var q=[
            URLQueryItem(name:"session",value:token),
            URLQueryItem(name:"argv",value:a),
            URLQueryItem(name:"env",value:e),
            URLQueryItem(name:"cwd",value:configuration.currentDirectory),
            URLQueryItem(name:"timeout",value:String(Int(configuration.timeoutSeconds))),
            URLQueryItem(name:"chan",value:configuration.useNativeChannels ? "1":"0"),
            URLQueryItem(name:"shared",value:configuration.sharedAddressSpace ? "1":"0"),
            URLQueryItem(name:"stdio",value:configuration.standardIO.rawValue),
            URLQueryItem(name:"regions",value:configuration.regions ? "1":"0"),
            URLQueryItem(name:"trace",value:configuration.trace ? "1":"0"),
            URLQueryItem(name:"traceCode",value:configuration.traceCode ? "1":"0"),
            URLQueryItem(name:"traceMaps",value:configuration.traceMaps ? "1":"0"),
            URLQueryItem(name:"slowWait",value:String(configuration.slowWaitMilliseconds)),
            URLQueryItem(name:"kspin",value:String(configuration.kernelSpinMilliseconds)),
            URLQueryItem(name:"tspin",value:String(configuration.threadSpinMilliseconds))
        ]
        q.append(URLQueryItem(name:"display",value:configuration.display ?? "0"))
        if configuration.screenOnly { q.append(URLQueryItem(name:"ui",value:"screen")) }
        c.queryItems=q
        // URLSearchParams uses form decoding: a literal '+' becomes a space.
        // Foundation permits '+' in query items, so escape it after encoding.
        c.percentEncodedQuery=c.percentEncodedQuery?.replacingOccurrences(of:"+",with:"%2B")
        guard let url=c.url else { throw LinuxRuntimeError.invalidConfiguration("Could not build Linux launch URL.") }
        return url
    }

    private static func assets() throws -> [String:(Data,String)] {
        let paths=[
            "runtime.js",
            "linux/thread_core.js","linux/compositor.js",
            "linux/guest_memory.js","linux/guest_memory_broker.js","linux/guest_image.js",
            "linux/web/sparse.html","linux/web/sparse_main.js","linux/web/sparse_kernel.js","linux/web/sparse_thread.js",
            "linux/web/linux.html","linux/web/linux_main.js","linux/web/kworker_web.js",
            "linux/web/thread_web.js","linux/web/chan_web.js","linux/web/chan_file.js",
            "linux/web/sampler.js","linux/web/probe_worker.js","linux/web/linux-kernel.js",
            "linux/web/file_transport.js","linux/web/owned_workers.js"
        ]
        var out:[String:(Data,String)]=[:]
        for path in paths {
            let ns=path as NSString
            let name=ns.lastPathComponent
            let dir=ns.deletingLastPathComponent
            let subdir=dir.isEmpty ? "Resources" : "Resources/"+dir
            guard let url=Bundle.module.url(forResource:name,withExtension:nil,subdirectory:subdir) else {
                throw LinuxRuntimeError.server("Missing BetterJITLinux resource: \(path)")
            }
            let type=path.hasSuffix(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8"
            out["/"+path]=(try Data(contentsOf:url),type)
        }
        return out
    }

    deinit { server?.stop(); backend.close() }
}
#endif
