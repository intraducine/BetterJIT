// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI
import WebKit
import BetterJIT
import BetterJITWebKit

@main struct BetterJITExampleApp: App {
    var body: some Scene { WindowGroup { ExampleView() } }
}
@MainActor private final class ExampleModel: ObservableObject {
    @Published var status = "Starting execution host"
    @Published var running = false
    let transport: WebKitTransport?
    let session: RuntimeSession?
    private var module: String?
    init() {
        do {
            let t = try WebKitTransport()
            session = try RuntimeSession(transport: t, limits: RuntimeLimits())
            transport = t
        } catch { transport = nil; session = nil; status = error.localizedDescription }
    }
    func start() async {
        guard let session, session.state == .idle else { return }
        do { try await session.start(); status = "Ready" }
        catch { status = error.localizedDescription }
    }
    func run() async {
        guard let session, session.state == .ready, !running else { return }
        running = true; defer { running = false }
        do {
            if module == nil {
                // (func (export "add") (param i32 i32) (result i32)
                //   local.get 0; local.get 1; i32.add)
                let wasm = Data([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,
                                 7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11])
                module = try await session.load(wasm)
            }
            let result = try await session.invoke(module!, export: "add", arguments: [.i32(20), .i32(22)])
            status = "20 + 22 = \(result.first?.value ?? "missing result")"
        } catch { status = error.localizedDescription }
    }
}
@MainActor private struct ExampleView: View {
    @StateObject private var model = ExampleModel()
    var body: some View {
        VStack(spacing: 16) {
            Text("BetterJIT standalone host").font(.headline)
            Text(model.status)
            if let transport = model.transport { WebHost(webView: transport.webView).frame(height: 96) }
            Button("Run Wasm addition") { Task { await model.run() } }.disabled(model.running)
        }
        .padding()
        .task { await model.start() }
        .onDisappear { model.session?.close() }
    }
}
private struct WebHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
