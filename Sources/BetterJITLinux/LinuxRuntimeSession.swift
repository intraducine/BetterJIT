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
                onLog:{ [weak self] text in Task { @MainActor in self?.receiveLog(text) } },
                onExit:{ _ in }, // receiveLog handles the exit marker in the same actor turn as its stdout.
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
        onLog=nil; onWindow=nil; onScreenshot=nil
        navigation?.resume(throwing:LinuxRuntimeError.closed); navigation=nil
        exitWaiter?.resume(throwing:LinuxRuntimeError.closed); exitWaiter=nil
        server?.stop(); server=nil; backend.close()
        webView.stopLoading(); webView.navigationDelegate=nil
        webView.loadHTMLString("<!doctype html><title>Closed</title>",baseURL:nil)
    }

    private func receiveLog(_ text:String) {
        guard state != .closed else { return }
        if logText.utf8.count < 4*1024*1024 {
            let remaining=4*1024*1024-logText.utf8.count
            logText += String(text.prefix(remaining))
        }
        onLog?(text)
        for line in text.split(separator:"\n") where line.hasPrefix("[page] exit ") {
            if let code=Int(line.dropFirst(12).split(separator:" ").first ?? "") { receiveExit(code) }
        }
    }
    private func receiveExit(_ code:Int) {
        guard result == nil, failure == nil, state != .closed else { return }
        timeoutTask?.cancel(); timeoutTask=nil
        let ms=Double(DispatchTime.now().uptimeNanoseconds-startedAt)/1_000_000
        let value=LinuxRuntimeResult(exitCode:code,milliseconds:ms,log:logText)
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

    private func launchURL(port:UInt16) throws -> URL {
        var c=URLComponents()
        c.scheme="http"; c.host="127.0.0.1"; c.port=Int(port); c.path="/linux/web/linux.html"
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
        guard let url=c.url else { throw LinuxRuntimeError.invalidConfiguration("Could not build Linux launch URL.") }
        return url
    }

    private static func assets() throws -> [String:(Data,String)] {
        let paths=[
            "runtime.js",
            "linux/thread_core.js","linux/compositor.js",
            "linux/web/linux.html","linux/web/linux_main.js","linux/web/kworker_web.js",
            "linux/web/thread_web.js","linux/web/chan_web.js","linux/web/chan_file.js",
            "linux/web/sampler.js","linux/web/probe_worker.js","linux/web/linux-kernel.js",
            "linux/web/file_transport.js"
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
