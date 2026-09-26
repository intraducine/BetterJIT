// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT
#if canImport(WebKit) && canImport(Network)
import WebKit

/// A per-session WebView and dedicated Wasm worker. Add webView to your view
/// hierarchy before starting. Closing/cancellation destroys the worker; sessions
/// never share modules, guest memory, services or a persistent website store.
@MainActor public final class WebKitTransport: NSObject, RuntimeTransport, WKNavigationDelegate {
    public let webView: WKWebView
    private let proxy: MessageProxy
    private let services: [String: NativeService]
    private let token = UUID().uuidString.lowercased()
    private var limits: RuntimeLimits?
    private var server: AssetServer?
    private var port: UInt16?
    private var documentURL: URL?
    private var broker: RequestBroker?
    private var ready: CheckedContinuation<Void, Error>?
    private var startupDeadline: Task<Void, Never>?
    private var serviceTasks: [String: Task<Void, Never>] = [:]
    private var closed = false
    private var didStart = false

    public init(services: [String: NativeService] = [:]) throws {
        guard services.count <= 128, services.keys.allSatisfy({ $0.range(of: "^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$", options: .regularExpression) != nil }) else {
            throw RuntimeFault("invalidConfiguration", "Invalid native service names.")
        }
        self.services = services; proxy = MessageProxy()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(proxy, name: "betterjit")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(); proxy.owner = self; webView.navigationDelegate = self
    }
    public func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities {
        guard !didStart, !closed else { throw RuntimeFault.closed }
        didStart = true; self.limits = try limits.validated()
        do {
            let assets = try Self.assets(token: token)
            let server = AssetServer(assets: assets); self.server = server
            let port = try await server.start(timeout: limits.timeoutSeconds)
            guard !closed else { throw RuntimeFault.closed }; self.port = port
            let url = URL(string: "http://127.0.0.1:\(port)/\(token)/index.html#\(token)")!
            documentURL = url
            broker = RequestBroker(session: token, limits: limits, send: { [weak self] in try self?.send($0) }, abort: { [weak self] in self?.tearDown() })
            try await withTaskCancellationHandler(operation: {
                try Task.checkCancellation()
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    ready = continuation
                    startupDeadline = Task { [weak self] in
                        do { try await Task.sleep(nanoseconds: UInt64(limits.timeoutSeconds * 1_000_000_000)) } catch { return }
                        self?.fail(RuntimeFault("timeout", "WebKit worker startup timed out."))
                    }
                    webView.load(URLRequest(url: url))
                }
            }, onCancel: { [weak self] in Task { @MainActor in self?.fail(CancellationError()) } })
            let answer = try await request("configure", payload: .object([
                "limits": try .encoding(limits), "services": .array(services.keys.sorted().map(JSONValue.string))]))
            return try answer.decode(RuntimeCapabilities.self)
        } catch { fail(error); throw error }
    }
    public func request(_ operation: String, payload: JSONValue) async throws -> JSONValue {
        guard !closed, let broker else { throw RuntimeFault.closed }
        return try await broker.request(operation, payload: payload)
    }
    public func close() { fail(RuntimeFault.closed) }
    private func fail(_ error: Error) {
        let pendingReady = ready; ready = nil
        startupDeadline?.cancel(); startupDeadline = nil
        pendingReady?.resume(throwing: error)
        broker?.close(error); tearDown()
    }
    private func tearDown() {
        guard !closed else { return }; closed = true
        startupDeadline?.cancel(); startupDeadline = nil
        for task in serviceTasks.values { task.cancel() }; serviceTasks.removeAll()
        webView.callAsyncJavaScript("window.BetterJIT?.stop()", arguments: [:], in: nil, contentWorld: .page, completionHandler: nil)
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "betterjit")
        webView.navigationDelegate = nil
        server?.stop(); server = nil
    }
    private func send(_ message: RPCMessage) throws {
        guard !closed, let limits else { throw RuntimeFault.closed }
        let bytes = try JSONEncoder().encode(message)
        guard bytes.count <= limits.maximumMessageBytes, let text = String(data: bytes, encoding: .utf8) else {
            throw RuntimeFault("messageTooLarge", "Native reply exceeds the configured limit.")
        }
        // Values are arguments, not interpolated JavaScript source.
        webView.callAsyncJavaScript("window.BetterJIT.receive(message)", arguments: ["message": text], in: nil, contentWorld: .page) { [weak self] result in
            if case .failure(let error) = result { self?.fail(error) }
        }
    }
    fileprivate func receive(_ message: WKScriptMessage) {
        guard !closed, let limits, let port, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "http", message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == Int(port), JSONSerialization.isValidJSONObject(message.body) else { return }
        do {
            let bytes = try JSONSerialization.data(withJSONObject: message.body)
            guard bytes.count <= limits.maximumMessageBytes else { throw RuntimeFault("messageTooLarge", "Worker reply exceeds configured limit.") }
            let m = try JSONDecoder().decode(RPCMessage.self, from: bytes)
            guard m.session == token else { return }
            guard m.v == 1 else { throw RuntimeFault("protocolVersion", "Unexpected worker protocol.") }
            switch m.kind {
            case "ready":
                startupDeadline?.cancel(); startupDeadline = nil
                let c = ready; ready = nil; c?.resume()
            case "response": broker?.receive(m)
            case "fatal": throw m.error ?? RuntimeFault("worker", "Worker failed.")
            case "service": try service(m, limits: limits)
            default: break
            }
        } catch { fail(error) }
    }
    private func service(_ m: RPCMessage, limits: RuntimeLimits) throws {
        guard serviceTasks[m.id] == nil, serviceTasks.count < limits.maximumPendingRequests,
              m.id.hasPrefix("service-"), m.id.utf8.count <= 64 else {
            throw RuntimeFault("backpressure", "Invalid or excessive native service calls.")
        }
        guard let operation = m.operation, let handler = services[operation] else {
            try send(RPCMessage(session: token, id: m.id, kind: "serviceResponse", error: RuntimeFault("serviceDenied", "Native service was not registered."))); return
        }
        serviceTasks[m.id] = Task { [weak self] in
            let result: JSONValue; let error: RuntimeFault?
            do { result = try await handler(m.payload); error = nil }
            catch let e as RuntimeFault { result = .null; error = e }
            catch { result = .null; error = RuntimeFault("nativeService", "The registered native service failed.") }
            guard let self, !self.closed, !Task.isCancelled else { return }
            self.serviceTasks.removeValue(forKey: m.id)
            do { try self.send(RPCMessage(session: self.token, id: m.id, kind: "serviceResponse", payload: result, error: error)) }
            catch { self.fail(error) }
        }
    }
    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail(RuntimeFault("processTerminated", "WebContent terminated. Create a new session; guest state was lost."))
    }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(!closed && action.request.url == documentURL && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }
    private static func assets(token: String) throws -> [String: (Data, String)] {
        let names = ["index.html", "page.mjs", "worker.mjs", "engine.mjs", "fex-runtime.js"]
        var result: [String: (Data, String)] = [:]
        for name in names {
            guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Resources") else {
                throw RuntimeFault("resources", "Missing SDK asset: \(name)")
            }
            result["/\(token)/\(name)"] = (try Data(contentsOf: url), name.hasSuffix("html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8")
        }
        return result
    }
    deinit { server?.stop() }
}

@MainActor private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: WebKitTransport?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}
#else
/// Linux can build/test the protocol and backend packages, but has no native
/// WKWebView executor. No interpreter fallback is silently substituted.
public enum WebKitUnavailable { public static let reason = "The WebKit transport requires iOS or macOS." }
#endif
