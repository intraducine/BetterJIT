// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT
#if canImport(WebKit) && canImport(Network)
import WebKit

/// Mount webView in the host's hierarchy before start. One transport belongs to
/// one session. No service, worker, module table or website store is shared.
@MainActor public final class WebKitTransport: NSObject, RuntimeFailureReportingTransport, WKNavigationDelegate {
    public let webView: WKWebView
    public var onFailure: (@MainActor (RuntimeFault) -> Void)?
    public private(set) var mappedTransportActive = false
    public private(set) var mappedTransportFallbackReason: String?
    public var mappedTransportStatistics: MappedTransportStatistics {
        MappedTransportStatistics(active: mappedTransportActive,
                                  nativeReadBytes: mappedNativeReadBytes,
                                  nativeWriteBytes: mappedNativeWriteBytes,
                                  mappedServiceCalls: mappedServiceCalls,
                                  fallbackReason: mappedTransportFallbackReason)
    }
    private let proxy: MessageProxy
    private let services: [String: NativeService]
    private let mappedPreference: MappedTransportPreference
    private let token = UUID().uuidString.lowercased()
    private var limits: RuntimeLimits?
    private var server: AssetServer?
    private var port: UInt16?
    private var documentURL: URL?
    private var broker: RequestBroker?
    private var ready: CheckedContinuation<Void, Error>?
    private var startupDeadline: Task<Void, Never>?
    private var mappedLane: MappedDataLane?
    private var mappedNativeReadBytes = 0
    private var mappedNativeWriteBytes = 0
    private var mappedServiceCalls = 0
    private struct ServiceWork {
        let task: Task<Void, Never>
        let deadline: Task<Void, Never>
    }
    private struct MappedServiceRequest {
        let payload: JSONValue
        let lease: MappedLease?
        let inputBytes: Int
    }
    private var serviceTasks: [String: ServiceWork] = [:]
    private var closed = false
    private var didStart = false

    public init(services: [String: NativeService] = [:], mappedTransport: MappedTransportPreference = .disabled) throws {
        guard services.count <= 128, services.keys.allSatisfy({
            $0.range(of: "^[a-zA-Z][a-zA-Z0-9_.-]{0,63}\\z", options: .regularExpression) != nil
        }) else { throw RuntimeFault("invalidConfiguration", "Invalid native service names.") }
        self.services = services; self.mappedPreference = mappedTransport; proxy = MessageProxy()
        let config = WKWebViewConfiguration()
        // The successful OPFS/native-mmap device probe uses WebKit's default
        // persistent store. Ephemeral storage could not create the synchronous
        // OPFS lane on the tested iOS build. Mapped transport is opt-in, so the
        // existing copied transport keeps its previous non-persistent behavior.
        switch mappedTransport {
        case .disabled: config.websiteDataStore = .nonPersistent()
        case .preferred, .required: config.websiteDataStore = .default()
        }
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(proxy, name: "betterjit")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(); proxy.owner = self; webView.navigationDelegate = self
    }
    public func start(limits: RuntimeLimits) async throws -> RuntimeCapabilities {
        guard !didStart, !closed else { throw RuntimeFault.closed }
        didStart = true
        do {
            let limits = try limits.validated(); self.limits = limits
            let server = AssetServer(assets: try Self.assets(token: token), onFailure: { [weak self] in
                Task { @MainActor in self?.fail(RuntimeFault("transport", "Loopback asset server failed.")) }
            })
            self.server = server
            let port = try await server.start(timeout: limits.timeoutSeconds)
            guard !closed else { throw RuntimeFault.closed }; self.port = port
            let url = URL(string: "http://127.0.0.1:\(port)/\(token)/index.html#\(token)")!
            documentURL = url
            broker = RequestBroker(session: token, limits: limits, send: { [weak self] message in
                guard let self else { throw RuntimeFault.closed }; try self.send(message)
            }, abort: { [weak self] in
                guard let self else { return }; self.fail(self.broker?.terminalFault ?? RuntimeFault.closed)
            })
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
            var configure: [String: JSONValue] = [
                "limits": try .encoding(limits), "services": .array(services.keys.sorted().map(JSONValue.string))]
            if mappedPreference != .disabled {
                configure["mappedTransport"] = .object([
                    "mode": .string(mappedPreference.rawValue),
                    "thresholdBytes": .number(Double(MappedDataLane.thresholdBytes))])
            }
            let answer = try await request("configure", payload: .object(configure))
            let negotiated = try await negotiateMappedTransport(answer)
            return try negotiated.decode(RuntimeCapabilities.self)
        } catch { fail(error); throw error }
    }
    public func request(_ operation: String, payload: JSONValue) async throws -> JSONValue {
        guard !closed, let broker else { throw RuntimeFault.closed }
        return try await broker.request(operation, payload: payload)
    }
    public func close() { fail(RuntimeFault.closed) }
    private func fail(_ error: Error) {
        guard !closed else { return }
        // Mark closed BEFORE callbacks: broker/session shutdown can reenter here.
        closed = true
        let pendingReady = ready; ready = nil
        startupDeadline?.cancel(); startupDeadline = nil
        pendingReady?.resume(throwing: error)
        broker?.close(error)
        for work in serviceTasks.values { work.task.cancel(); work.deadline.cancel() }
        serviceTasks.removeAll()
        mappedLane?.close(); mappedLane = nil; mappedTransportActive = false
        webView.callAsyncJavaScript("window.BetterJIT?.stop()", arguments: [:], in: nil, in: .page, completionHandler: nil)
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "betterjit")
        webView.navigationDelegate = nil
        // The host may retain webView after close; replace its execution document.
        webView.loadHTMLString("<!doctype html><title>Closed</title>", baseURL: nil)
        server?.stop(); server = nil
        onFailure?(RuntimeFault.normalizing(error))
    }
    private func send(_ message: RPCMessage) throws {
        guard !closed, let limits else { throw RuntimeFault.closed }
        let bytes = try JSONEncoder().encode(message)
        guard bytes.count <= limits.maximumMessageBytes, let text = String(data: bytes, encoding: .utf8) else {
            throw RuntimeFault("messageTooLarge", "Native reply exceeds the configured limit.")
        }
        webView.callAsyncJavaScript("window.BetterJIT.receive(message)", arguments: ["message": text], in: nil, in: .page) { [weak self] result in
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
        let decoded = try decodeMappedRequest(m.payload)
        let task = Task { [weak self] in
            let result: JSONValue; let replyError: RuntimeFault?
            do { result = try await handler(decoded.payload); replyError = nil }
            catch let e as RuntimeFault { result = .null; replyError = e }
            catch { result = .null; replyError = RuntimeFault("nativeService", "The registered native service failed.") }
            guard let self, !self.closed, !Task.isCancelled else { return }
            self.serviceTasks.removeValue(forKey: m.id)?.deadline.cancel()
            do {
                let encoded = try self.encodeMappedResponse(result, lease: decoded.lease)
                if decoded.inputBytes > 0 || encoded.bytes > 0 { self.mappedServiceCalls += 1 }
                try self.send(RPCMessage(session: self.token, id: m.id, kind: "serviceResponse", payload: encoded.payload, error: replyError))
            }
            catch { self.fail(error) }
        }
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(limits.timeoutSeconds * 1_000_000_000)) } catch { return }
            guard let self, self.serviceTasks[m.id] != nil else { return }
            self.fail(RuntimeFault("timeout", "Native service deadline exceeded. Its external side effects are not rolled back."))
        }
        serviceTasks[m.id] = ServiceWork(task: task, deadline: deadline)
    }

    private func negotiateMappedTransport(_ answer: JSONValue) async throws -> JSONValue {
        guard mappedPreference != .disabled else { return answer }
        guard answer["mappedTransport"]?["candidate"]?.integer == 1 else {
            mappedTransportFallbackReason = answer["mappedTransport"]?["reason"]?.string ?? "WebKit did not offer the mapped data lane."
            if mappedPreference == .required {
                throw RuntimeFault("mappedTransportUnavailable", mappedTransportFallbackReason!)
            }
            return answer
        }
        let candidate = answer["mappedTransport"]
        func intField(_ key: String) -> Int? { candidate?[key]?.integer.flatMap { Int(exactly: $0) } }
        guard intField("version") == 1,
              intField("headerSize") == MappedDataLane.headerSize,
              intField("slotSize") == MappedDataLane.slotSize,
              intField("slotCount") == MappedDataLane.slotCount,
              intField("fileSize") == MappedDataLane.fileSize,
              intField("thresholdBytes") == MappedDataLane.thresholdBytes else {
            mappedTransportFallbackReason = "WebKit and native mapped-lane layouts do not match."
            _ = try? await request("mapped.confirm", payload: .object(["active": .number(0)]))
            if mappedPreference == .required { throw RuntimeFault("mappedTransportUnavailable", mappedTransportFallbackReason!) }
            return answer
        }
        do {
            let lane = try MappedDataLane.discover(token: token)
            mappedLane = lane
            let confirmation = try await request("mapped.confirm", payload: .object(["active": .number(1)]))
            guard confirmation["active"]?.integer == 1 else {
                throw RuntimeFault("mappedTransport", "WebKit did not confirm mapped-lane ownership.")
            }
            mappedTransportActive = true; mappedTransportFallbackReason = nil
            return addingMappedCapability(answer)
        } catch {
            mappedLane?.close(); mappedLane = nil; mappedTransportActive = false
            mappedTransportFallbackReason = "The OPFS lane was created but its backing file was not usable by native code."
            _ = try? await request("mapped.confirm", payload: .object(["active": .number(0)]))
            if mappedPreference == .required {
                throw RuntimeFault("mappedTransportUnavailable", mappedTransportFallbackReason!)
            }
            return answer
        }
    }

    private func addingMappedCapability(_ value: JSONValue) -> JSONValue {
        guard case .object(var object) = value, case .array(var extensions)? = object["extensions"] else { return value }
        extensions.append(.string("mappedTransport")); object["extensions"] = .array(extensions)
        return .object(object)
    }

    private func mappedLease(_ object: [String: JSONValue]) throws -> MappedLease {
        guard let lane = mappedLane,
              object["token"]?.string == token,
              let slotValue = object["slot"]?.integer, let slot = Int(exactly: slotValue),
              let offsetText = object["offset"]?.string, let offset = UInt64(offsetText),
              let capacityValue = object["capacity"]?.integer, let capacity = Int(exactly: capacityValue),
              let generationText = object["generation"]?.string, let generation = UInt64(generationText) else {
            throw RuntimeFault("mappedTransport", "Mapped service envelope is malformed.")
        }
        let lease = MappedLease(token: token, slot: slot, offset: offset, capacity: capacity, generation: generation)
        try lane.validate(lease); return lease
    }

    private func decodeMappedRequest(_ value: JSONValue) throws -> MappedServiceRequest {
        guard mappedTransportActive, let lane = mappedLane,
              case .object(let root) = value,
              case .object(let envelope)? = root[MappedDataLane.requestTag] else {
            return MappedServiceRequest(payload: value, lease: nil, inputBytes: 0)
        }
        let lease = try mappedLease(envelope)
        var consumed = false, bytes = 0
        func restore(_ value: JSONValue) throws -> JSONValue {
            if case .object(let object) = value, case .object(let descriptor)? = object[MappedDataLane.valueTag] {
                guard !consumed,
                      let lengthValue = descriptor["length"]?.integer, let length = Int(exactly: lengthValue),
                      let hashValue = descriptor["hash"]?.integer, let hash = UInt32(exactly: hashValue) else {
                    throw RuntimeFault("mappedTransport", "Mapped value descriptor is malformed or duplicated.")
                }
                let data = try lane.read(lease, length: length, expectedHash: hash)
                consumed = true; bytes = data.count; mappedNativeReadBytes += data.count
                return .string(data.base64EncodedString())
            }
            if case .array(let values) = value { return .array(try values.map(restore)) }
            if case .object(let object) = value {
                var result: [String: JSONValue] = [:]
                for (key, child) in object { result[key] = try restore(child) }
                return .object(result)
            }
            return value
        }
        guard let payload = envelope["payload"] else { throw RuntimeFault("mappedTransport", "Mapped service payload is missing.") }
        return MappedServiceRequest(payload: try restore(payload), lease: lease, inputBytes: bytes)
    }

    private func encodeMappedResponse(_ value: JSONValue, lease: MappedLease?) throws -> (payload: JSONValue, bytes: Int) {
        guard mappedTransportActive, let lane = mappedLane, let lease,
              case .string(let text) = value,
              text.utf8.count >= 4 * (MappedDataLane.thresholdBytes / 3),
              let data = Data(base64Encoded: text), data.count >= MappedDataLane.thresholdBytes,
              data.count <= lease.capacity, data.base64EncodedString() == text else { return (value, 0) }
        let hash = try lane.write(data, to: lease); mappedNativeWriteBytes += data.count
        let descriptor: JSONValue = .object([
            "token": .string(token), "slot": .number(Double(lease.slot)),
            "offset": .string(String(lease.offset)), "length": .number(Double(data.count)),
            "capacity": .number(Double(lease.capacity)), "generation": .string(String(lease.generation)),
            "hash": .number(Double(hash))])
        return (.object([MappedDataLane.responseTag: descriptor]), data.count)
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
        let names = ["index.html", "page.mjs", "worker.mjs", "engine.mjs", "wasm-module.mjs", "fex-runtime.js", "mapped-lane.mjs"]
        var result: [String: (Data, String)] = [:]
        for name in names {
            guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Resources") else {
                throw RuntimeFault("resources", "Missing SDK asset: \(name)")
            }
            result["/\(token)/\(name)"] = (try Data(contentsOf: url), name.hasSuffix("html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8")
        }
        return result
    }
    deinit { server?.stop(); mappedLane?.close() }
}

@MainActor private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: WebKitTransport?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}
#else
public enum WebKitUnavailable { public static let reason = "The WebKit transport requires iOS or macOS." }
#endif
