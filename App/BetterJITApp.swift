import SwiftUI
import WebKit

@main
struct BetterJITApp: App {
    @StateObject private var model = ProbeController()
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 0) {
                HStack {
                    Text(model.status).font(.caption)
                    Spacer()
                    if let report = model.reportURL { ShareLink("Share report", item: report) }
                }.padding()
                if let view = model.webView { Browser(view: view) }
                else { Spacer(); Text("Starting local diagnostic host"); Spacer() }
            }
        }
    }
}

private struct Browser: UIViewRepresentable {
    let view: WKWebView
    func makeUIView(context: Context) -> WKWebView { view }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

private final class WeakBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: ProbeController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let owner else { replyHandler(nil, "Host closed"); return }
        owner.receive(message, reply: replyHandler)
    }
}

final class ProbeController: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var webView: WKWebView?
    @Published var status = "Starting"
    @Published var reportURL: URL?
    private var server: LocalServer?
    private var baseURL: URL?
    private var native: NativeSession?
    private let queue = DispatchQueue(label: "BetterJIT.native-probe", qos: .userInitiated)

    override init() {
        super.init()
        do {
            native = try NativeSession()
            let server = try LocalServer()
            self.server = server
            try server.start { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .success(let url): self.load(url)
                    case .failure(let error): self.status = String(describing: error)
                    }
                }
            }
        } catch { status = String(describing: error) }
    }

    private func load(_ url: URL) {
        baseURL = url
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // OPFS must be persistent, not private browsing
        let bridge = WeakBridge(); bridge.owner = self
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "betterjit")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        webView = view
        view.load(URLRequest(url: url))
        status = "On-device loopback host; no external network required"
    }

    private func allowed(_ url: URL?) -> Bool {
        guard let url, let baseURL else { return false }
        return url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port &&
            url.path.hasPrefix(baseURL.path)
    }

    func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, allowed(message.frameInfo.request.url),
              let baseURL, message.frameInfo.securityOrigin.protocol == "http",
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == baseURL.port,
              let body = message.body as? [String: Any], let native else {
            reply(nil, "Untrusted frame/origin or malformed request"); return
        }
        queue.async { [weak self] in
            do {
                let result = try native.process(body)
                DispatchQueue.main.async {
                    if body["command"] as? String == "report" {
                        self?.reportURL = native.reportURL
                        self?.status = "Report saved; check PASS / FAIL / SKIP results"
                    }
                    reply(result, nil)
                }
            } catch { DispatchQueue.main.async { reply(nil, String(describing: error)) } }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(allowed(navigationAction.request.url) ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        status = "WebContent terminated. No RAM-limit conclusion can be drawn without device diagnostics."
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        status = "Local page load failed: \(error.localizedDescription)"
    }
}
