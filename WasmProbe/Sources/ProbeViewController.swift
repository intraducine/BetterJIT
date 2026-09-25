import UIKit
import WebKit

/// Runs the suites named on the command line (`--suites a,b,c`) in order and
/// prints results. Suite names:
///   native_kernels, native_dispatch, jsc_kernels, jsc_dispatch  — no WebView
///   page:scheme, page:localhost                                  — (re)create the WebView on that origin
///   w:<name>[:json-args]                                          — Probe.run(name) in the page
///   native_to_js, hidden, sleep:<s>                               — native-driven WebView tests
@MainActor
final class ProbeViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private var webView: WKWebView?
    private let webRoot = Bundle.main.resourceURL!.appendingPathComponent("Web")
    private lazy var scheme = SchemeHandler(webRoot: webRoot)
    private var http: HTTPServer?
    private var ws: WSServer?
    private var httpPort: UInt16 = 0
    private var wsPort: UInt16 = 0
    private var origin = "none"
    private var loadContinuation: CheckedContinuation<Bool, Never>?
    private var pendingJS: ((String) -> Void)?
    private var sinkCount = 0
    private var needsReload = false
    var sharedFile: SharedFile?
    private let status = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        status.textColor = .green
        status.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        status.numberOfLines = 0
        status.frame = CGRect(x: 12, y: 60, width: view.bounds.width - 24, height: 80)
        status.autoresizingMask = [.flexibleWidth]
        view.addSubview(status)
        UIApplication.shared.isIdleTimerDisabled = true
        Task { await self.main() }
    }

    private func setStatus(_ s: String) { status.text = s; Log.line("@@S " + s) }

    // MARK: - Orchestration

    private func main() async {
        let args = CommandLine.arguments
        var suites = ["native_kernels", "native_dispatch", "page:scheme", "w:env", "w:kernels", "w:dispatch"]
        if let i = args.firstIndex(of: "--suites"), i + 1 < args.count {
            suites = args[i + 1].split(separator: ",").map(String.init)
        }
        var info = NativeBench.memoryInfo()
        info["suite"] = "device"
        info["suites"] = suites
        Log.result(info)
        await startServers()
        for s in suites {
            setStatus("running \(s)")
            let t = NativeBench.nowMs()
            await runSuite(s)
            Log.result(["suite": "timing", "name": s, "ms": NativeBench.nowMs() - t])
        }
        setStatus("done")
        Log.line("@@DONE")
        if args.contains("--exit") {
            try? await Task.sleep(nanoseconds: 500_000_000)
            exit(0)
        }
    }

    private func startServers() async {
        do {
            let h = try HTTPServer(webRoot: webRoot)
            let w = try WSServer()
            http = h; ws = w
            httpPort = await withCheckedContinuation { c in h.start { c.resume(returning: $0) } }
            wsPort = await withCheckedContinuation { c in w.start { c.resume(returning: $0) } }
            Log.result(["suite": "servers", "http": Int(httpPort), "ws": Int(wsPort)])
        } catch {
            Log.result(["suite": "servers", "error": "\(error)"])
        }
    }

    private func runSuite(_ s: String) async {
        if s == "native_kernels" {
            await Task.detached { NativeBench.runKernels() }.value
        } else if s == "native_tso" {
            await Task.detached { NativeBench.runTSO() }.value
        } else if s == "native_fexkernels" {
            let url = webRoot.appendingPathComponent("fex/config.json")
            await Task.detached { NativeBench.runFexKernels(configURL: url) }.value
        } else if s == "native_box2d_threads" {
            await Task.detached { NativeBench.runBox2DThreads() }.value
        } else if s == "native_dispatch" {
            await Task.detached { NativeBench.runDispatch() }.value
        } else if s == "jsc_kernels" || s == "jsc_dispatch" || s == "jsc_env" {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                JSCRunner.run(webRoot: webRoot, kernels: s == "jsc_kernels", dispatch: s == "jsc_dispatch") { c.resume() }
            }
        } else if s.hasPrefix("page:") {
            await loadPage(String(s.dropFirst(5)))
        } else if s.hasPrefix("linux:") {
            await linuxRun(String(s.dropFirst(6)))
        } else if s.hasPrefix("url:") {
            await linuxRun(String(s.dropFirst(4)), path: nil)
        } else if s.hasPrefix("w:") {
            if needsReload {
                Log.result(["suite": "page", "event": "reloading after WebContent termination"])
                await loadPage(origin)
            }
            let parts = s.dropFirst(2).split(separator: ":", maxSplits: 1).map(String.init)
            let argJSON = parts.count > 1 ? parts[1].replacingOccurrences(of: ";", with: ",") : "{}"
            let r = await callProbe(parts[0], argsJSON: argJSON, timeout: 900)
            Log.result(["suite": "call", "name": parts[0], "origin": origin, "return": r])
        } else if s == "opfs_share" {
            await opfsShare()
        } else if s.hasPrefix("opfs_big:") {
            await opfsBig(gb: Int(s.dropFirst(9)) ?? 4)
        } else if s == "opfs_bigmem" {
            await opfsBigmem()
        } else if s == "opfs_map" {
            await opfsMap()
        } else if s.hasPrefix("appram:") {
            await appRAM(gb: Int(s.dropFirst(7)) ?? 7)
        } else if s == "storagecheck" {
            await storageCheck()
        } else if s == "native_cleanup" {
            ProbeViewController.removeStaleOPFSFiles()
        } else if s == "opfs_cleanup" {
            await opfsCleanup()
        } else if s == "native_to_js" {
            await nativeToJS()
        } else if s == "hidden" {
            await hiddenStates()
        } else if s.hasPrefix("sleep:") {
            try? await Task.sleep(nanoseconds: UInt64((Double(s.dropFirst(6)) ?? 1) * 1e9))
        } else if s == "meminfo" {
            var info = NativeBench.memoryInfo(); info["suite"] = "meminfo"; Log.result(info)
        } else {
            Log.result(["suite": s, "error": "unknown suite"])
        }
    }

    // MARK: - WebView management

    private func makeWebView() {
        if let old = webView {
            old.configuration.userContentController.removeAllScriptMessageHandlers()
            old.removeFromSuperview()
        }
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(scheme, forURLScheme: "probe")
        if CommandLine.arguments.contains("--inactive-none") {
            cfg.preferences.inactiveSchedulingPolicy = .none
        } else if CommandLine.arguments.contains("--inactive-throttle") {
            cfg.preferences.inactiveSchedulingPolicy = .throttle
        }
        let ucc = cfg.userContentController
        ucc.add(self, name: "log")
        ucc.add(self, name: "sink")
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "echo")
        let wv = WKWebView(frame: view.bounds.insetBy(dx: 0, dy: 150), configuration: cfg)
        wv.navigationDelegate = self
        wv.isInspectable = true
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(wv)
        webView = wv
    }

    private func loadPage(_ which: String) async {
        needsReload = false
        makeWebView()
        let url: URL
        if which == "localhost" {
            url = URL(string: "http://127.0.0.1:\(httpPort)/index.html?ws=\(wsPort)")!
            origin = "localhost"
        } else {
            url = URL(string: "probe://app/index.html?ws=\(wsPort)")!
            origin = "scheme"
        }
        let ok = await withCheckedContinuation { c in
            loadContinuation = c
            webView?.load(URLRequest(url: url))
        }
        Log.result(["suite": "page", "origin": origin, "url": url.absoluteString, "loaded": ok])
    }

    /// fexwasm's Linux kernel page with the query (';' for '&'), until it
    /// reports its exit or its timeout (+60 s) passes.
    /// (path nil: q is a page path and query of its own, "url:<path>?...")
    private func linuxRun(_ q: String, path: String? = "js/linux/web/linux.html") async {
        LinuxFS.exitCode = nil
        needsReload = false
        makeWebView()
        let query = q.replacingOccurrences(of: ";", with: "&")
        let url = URL(string: path.map { "http://127.0.0.1:\(httpPort)/\($0)?\(query)" } ?? "http://127.0.0.1:\(httpPort)/\(query)")!
        origin = "localhost"
        _ = await withCheckedContinuation { c in
            loadContinuation = c
            webView?.load(URLRequest(url: url))
        }
        let timeout = Double(URLComponents(string: "x:?" + query)?.queryItems?.first(where: { $0.name == "timeout" })?.value ?? "") ?? 120
        let t0 = NativeBench.nowMs()
        // WebContent's footprint, sampled (if this process may read it)
        let wcPid = (webView?.value(forKey: "_webProcessIdentifier") as? Int).map { pid_t($0) } ?? 0
        var wcMax = 0, wcLast = 0, lastSample = 0.0
        let sysBase = NativeBench.systemUsedMB(), appBase = NativeBench.memoryInfo()["appFootprintMB"] as? Int ?? 0
        var sysMax = 0
        while LinuxFS.exitCode == nil && !needsReload && NativeBench.nowMs() - t0 < (timeout + 60) * 1000 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if NativeBench.nowMs() - lastSample >= 2000 {
                lastSample = NativeBench.nowMs()
                let secs = Int((lastSample - t0) / 1000)
                if wcPid > 0 {
                    wcLast = NativeBench.footprintMB(pid: wcPid)
                    wcMax = max(wcMax, wcLast)
                }
                if wcLast > 0 {
                    Log.line("@@L [app] \(secs)s WebContent footprint \(wcLast) MB")
                } else {
                    // system-wide rise, less this app's own
                    let app = NativeBench.memoryInfo()["appFootprintMB"] as? Int ?? 0
                    let used = NativeBench.systemUsedMB()
                    let rise = used - sysBase - (app - appBase)
                    sysMax = max(sysMax, rise)
                    Log.line("@@L [app] \(secs)s memory in use elsewhere +\(rise) MB (system \(used) MB, app \(app) MB)")
                }
            }
        }
        var info = NativeBench.memoryInfo()
        info["webContentMaxMB"] = wcMax
        info["webContentLastMB"] = wcLast
        info["elsewhereMaxRiseMB"] = sysMax
        info["suite"] = "linux"
        info["query"] = query
        info["exit"] = LinuxFS.exitCode ?? -1
        info["webcontentTerminated"] = needsReload
        info["ms"] = NativeBench.nowMs() - t0
        Log.result(info)
    }

    private func resolveLoad(_ ok: Bool) {
        loadContinuation?.resume(returning: ok)
        loadContinuation = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { resolveLoad(true) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Log.result(["suite": "page", "error": "\(error)"]); resolveLoad(false)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Log.result(["suite": "page", "error": "\(error)"]); resolveLoad(false)
    }
    // WebKit's private variant says why (_WKProcessTerminationReason: 0 memory
    // limit, 1 CPU limit, 2 requested by client, 3 crash, 4 navigation swap,
    // 5 idle exit, 6 unresponsive); when implemented it's called instead.
    @objc(_webView:webContentProcessDidTerminateWithReason:)
    func webView(_ webView: WKWebView, webContentProcessDidTerminateWithReason reason: Int) {
        terminated(reason: reason)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        terminated(reason: -1)
    }
    private func terminated(reason: Int) {
        var info = NativeBench.memoryInfo()
        info["suite"] = "webcontent-terminated"
        info["reason"] = ["memory limit", "CPU limit", "requested by client", "crash", "navigation swap", "idle exit", "unresponsive"]
            .indices.contains(reason) ? ["memory limit", "CPU limit", "requested by client", "crash", "navigation swap", "idle exit", "unresponsive"][reason] : "unknown (\(reason))"
        info["origin"] = origin
        Log.result(info)
        needsReload = true
        resolveLoad(false)
        pendingJS?("webcontent-terminated")
    }

    /// Calls Probe.run(name, args) and waits for its promise.
    func callProbe(_ name: String, argsJSON: String = "{}", timeout: Double = 300) async -> String {
        await callJS("return await Probe.run(name, JSON.parse(args));", ["name": name, "args": argsJSON], timeout: timeout)
    }

    private func callJS(_ body: String, _ args: [String: Any], timeout: Double) async -> String {
        guard let wv = webView else { return "no webview" }
        return await withCheckedContinuation { cont in
            var done = false
            let finish: (String) -> Void = { s in
                if done { return }
                done = true
                self.pendingJS = nil
                cont.resume(returning: s)
            }
            pendingJS = finish
            wv.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { result in
                switch result {
                case .success(let v): finish("\(v)")
                case .failure(let e): finish("error: \(e)")
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish("timeout") }
        }
    }

    // MARK: - Script message handlers

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "log", let s = message.body as? String {
            Log.resultJSON(s, extra: ["engine": "webview", "origin": origin])
        } else if message.name == "sink" {
            sinkCount += 1
        }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let body = message.body
        if let d = body as? [String: Any], d["k"] as? String == "b64", let s = d["s"] as? String {
            replyHandler("decoded:\(Data(base64Encoded: s)?.count ?? -1)", nil)
            return
        }
        replyHandler(Self.describe(body), nil)
    }

    private static func describe(_ b: Any) -> String {
        switch b {
        case let d as Data: return "Data(\(d.count))"
        case let s as String: return "String(\(s.utf16.count))"
        case let n as NSNumber: return "NSNumber(\(n))"
        case let a as [Any]: return "Array(\(a.count))"
        case let d as [String: Any]: return "Dictionary(\(d.keys.sorted().prefix(4).joined(separator: ",")))"
        default: return "\(type(of: b))"
        }
    }

    // MARK: - Native-driven tests

    private func nativeToJS() async {
        guard let wv = webView else { return }
        for size in [1 << 10, 64 << 10, 1 << 20, 8 << 20, 32 << 20] {
            var bytes = [UInt8](repeating: 0, count: size)
            for i in 0..<size { bytes[i] = UInt8(truncatingIfNeeded: i &* 131) }
            let data = Data(bytes)
            var t = NativeBench.nowMs()
            let b64 = data.base64EncodedString()
            let encMs = NativeBench.nowMs() - t
            t = NativeBench.nowMs()
            let r1 = await callJS("return Probe.recvB64(s);", ["s": b64], timeout: 120)
            let argMs = NativeBench.nowMs() - t
            t = NativeBench.nowMs()
            var r2 = "?"
            do { r2 = "\(try await wv.evaluateJavaScript("Probe.recvB64('\(b64)')") ?? "nil")" } catch { r2 = "error: \(error)" }
            let evalMs = NativeBench.nowMs() - t
            let mb = Double(size) / 1_048_576
            Log.result(["suite": "native_to_js", "bytes": size, "b64EncodeMs": encMs,
                        "callAsyncArg": ["ms": argMs, "MBps": mb / ((argMs + encMs) / 1000), "js": r1],
                        "evaluateLiteral": ["ms": evalMs, "MBps": mb / ((evalMs + encMs) / 1000), "js": r2]])
        }
        // Can binary data be passed as an argument directly?
        let r = await callJS("return (typeof d) + ':' + Object.prototype.toString.call(d) + ':' + (d && (d.byteLength ?? d.length));",
                             ["d": Data(count: 16)], timeout: 10)
        Log.result(["suite": "native_to_js", "test": "Data-argument", "js": r])
        let r2 = await callJS("return (typeof d) + ':' + Object.prototype.toString.call(d) + ':' + (d && d.length);",
                              ["d": [UInt8](repeating: 1, count: 16).map { NSNumber(value: $0) }], timeout: 10)
        Log.result(["suite": "native_to_js", "test": "NSArray-argument", "js": r2])
    }

    private func hiddenStates() async {
        guard let wv = webView else { return }
        let full = view.bounds.insetBy(dx: 0, dy: 150)
        func reset() {
            wv.alpha = 1; wv.isHidden = false; wv.frame = full
            if wv.superview == nil { view.addSubview(wv) }
        }
        let states: [(String, () -> Void)] = [
            ("visible", {}),
            ("alpha0", { wv.alpha = 0 }),
            ("isHidden", { wv.isHidden = true }),
            ("offscreen", { wv.frame = full.offsetBy(dx: 5000, dy: 0) }),
            ("tiny1x1", { wv.frame = CGRect(x: 0, y: 0, width: 1, height: 1) }),
            ("detached", { wv.removeFromSuperview() }),
            ("never-attached", {}),
        ]
        for (name, apply) in states {
            reset()
            if name == "never-attached" {
                // A fresh WebView that is never added to any window.
                await loadPage(origin == "localhost" ? "localhost" : "scheme")
                webView?.removeFromSuperview()
            } else {
                apply()
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            let r = await callProbe("liveness", argsJSON: "{\"state\":\"\(name)\"}", timeout: 30)
            Log.result(["suite": "liveness-call", "state": name, "return": r])
        }
        if let w = webView, w.superview == nil { view.addSubview(w) }
        webView?.frame = full
    }
}
