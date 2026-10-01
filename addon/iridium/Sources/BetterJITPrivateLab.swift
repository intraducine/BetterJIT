import SwiftUI
import UIKit
import WebKit

/// Included only in the private overlay. Normal Iridium has neither this
/// button nor these native libraries, assets or native request endpoints.
struct BetterJITPrivateLabButton: View {
    @State private var showing = false
    var body: some View {
        Button("BetterJIT Lab") { showing = true }
            .sheet(isPresented: $showing) { BetterJITPrivateLabView() }
    }
}

private struct BetterJITPrivateLabView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var session = BetterJITLabSession()
    @State private var share: BetterJITLabLog?
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Private FEX → WebAssembly experiments").font(.headline)
                Text("Runs bundled CPU tests inside Iridium. This does not switch game launches to a WebAssembly Wine/DXMT backend.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text(session.status).font(.callout)
                HStack {
                    Button("Run x86-64") { session.run("fex") }
                    Button("Run Win64") { session.run("fexw64") }
                }.disabled(!session.ready || session.running)
                BetterJITLabWeb(session: session)
                Button("Share lab log") {
                    if let url = Log.snapshot() { share = BetterJITLabLog(url: url) }
                }
            }.padding()
                .navigationTitle("BetterJIT Lab")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { session.stop(); dismiss() } } }
                .sheet(item: $share) { log in BetterJITLabShare(url: log.url) }
        }.onDisappear { session.stop() }
    }
}

private struct BetterJITLabLog: Identifiable { let id = UUID(); let url: URL }
private struct BetterJITLabShare: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
private struct BetterJITLabWeb: UIViewRepresentable {
    let session: BetterJITLabSession
    func makeUIView(context: Context) -> WKWebView { session.open() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

@MainActor
private final class BetterJITLabSession: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    @Published var status = "Starting local test host…"
    @Published var ready = false
    @Published var running = false
    private var webView: WKWebView?
    private var server: BetterJITLabServer?
    private var root: URL?
    private var generation = UUID()
    private var timeout: DispatchWorkItem?

    func open() -> WKWebView {
        if let webView { return webView }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(self, name: "betterjitLab")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        webView = view
        let current = generation
        do {
            guard let resources = Bundle.main.url(forResource: "BetterJITWeb", withExtension: nil) else {
                throw NSError(domain: "BetterJIT", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing private add-on resources"])
            }
            let server = try BetterJITLabServer(webRoot: resources)
            self.server = server
            try server.start { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, self.generation == current else { return }
                    switch result {
                    case .success(let url): self.root = url; view.load(URLRequest(url: url.appendingPathComponent("index.html")))
                    case .failure(let error): self.fail(error.localizedDescription)
                    }
                }
            }
            let deadline = DispatchWorkItem { [weak self] in
                guard let self, self.generation == current, !self.ready else { return }
                self.stop(); self.status = "Local test host did not become ready. Close and reopen the lab."
            }
            timeout = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: deadline)
            Log.result(["suite": "private-addon", "hostCommit": Bundle.main.object(forInfoDictionaryKey: "BetterJITHostCommit") ?? "unknown",
                        "addonCommit": Bundle.main.object(forInfoDictionaryKey: "BetterJITSourceCommit") ?? "unknown",
                        "bundleID": Bundle.main.bundleIdentifier ?? "unknown", "gameBackendChanged": false])
        } catch { fail(error.localizedDescription) }
        return view
    }

    func run(_ directory: String) {
        guard ready, !running, ["fex", "fexw64"].contains(directory), let webView else { return }
        running = true
        status = "Translating and checking \(directory == "fex" ? "x86-64" : "Win64") kernels…"
        let current = generation
        timeout?.cancel()
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, self.generation == current, self.running else { return }
            self.stop(); self.status = "Test timed out. Close and reopen the lab."
        }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 180, execute: deadline)
        webView.callAsyncJavaScript("return await BetterJITLab.run(directory);", arguments: ["directory": directory],
                                   in: nil, in: .page) { [weak self] result in
            guard let self, self.generation == current else { return }
            self.timeout?.cancel()
            self.running = false
            switch result {
            case .success(let value):
                if let report = value as? [String: Any], report["passed"] as? Bool == true,
                   let checked = report["checked"] as? Int, checked > 0 {
                    self.status = "\(checked) checksums matched. This is a CPU test, not a game benchmark."
                } else { self.status = "Test failed or unsupported; see the lab log." }
            case .failure(let error): self.fail(error.localizedDescription)
            }
        }
    }

    func stop() {
        generation = UUID()
        timeout?.cancel(); timeout = nil
        ready = false; running = false
        webView?.stopLoading()
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView?.navigationDelegate = nil
        webView = nil
        server?.stop(); server = nil
        root = nil
    }
    private func fail(_ message: String) {
        running = false
        let clean = root.map { message.replacingOccurrences(of: $0.absoluteString, with: "<local-lab>/") } ?? message
        status = clean
        Log.result(["suite": "private-addon", "error": clean])
    }
    private func accepts(_ url: URL?) -> Bool {
        guard let url, let root else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == root.port && url.path.hasPrefix(root.path)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(accepts(action.request.url) ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard accepts(webView.url) else { return }
        // A successful navigation is not enough: JS may be blocked or unsupported.
        webView.evaluateJavaScript("typeof BetterJITLab === 'object'") { [weak self] value, error in
            guard let self, self.accepts(webView.url) else { return }
            if error == nil, value as? Bool == true {
                self.timeout?.cancel(); self.ready = true; self.status = "Ready. No test runs until you select one."
            } else { self.fail("The lab scripts did not load.") }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stop(); status = "WebContent terminated. Close and reopen the lab."
        Log.result(["suite": "private-addon", "error": "WebContent terminated"])
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "betterjitLab", message.frameInfo.isMainFrame,
              accepts(message.frameInfo.request.url), let text = message.body as? String, text.utf8.count <= 1 << 20 else { return }
        let clean = root.map { text.replacingOccurrences(of: $0.absoluteString, with: "<local-lab>/") } ?? text
        Log.resultJSON(clean, extra: ["source": "private-addon"])
    }
}
