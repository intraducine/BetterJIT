// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI
import BetterJIT
import BetterJITWebKit
import BetterJITFEX

/// An independent consumer of newly generated native FEX translations. No
/// Iridium, recorded Wasm units, game files, or native JIT activation is used.
@main struct FEXHostApp: App {
    var body: some Scene { WindowGroup { FEXHostView() } }
}
@MainActor private final class FEXHostModel: ObservableObject {
    @Published var message = "Run the native FEX translation check."
    @Published var running = false
    @Published var transport: WebKitTransport?
    private var session: RuntimeSession?
    private var service: FEXService?
    func run() async {
        guard !running else { return }; running = true
        defer { running = false }
        do {
            for abi in [LinkedFEXTranslator.ABI.sysv, .win64] {
                message = "Translating fresh x86-64 (\(abi.rawValue))"
                // mov rax,rdi; add rax,rsi; ret / mov rax,rcx; add rax,rdx; ret
                let bytes: [UInt8] = abi == .sysv ? [0x48,0x89,0xf8,0x48,0x01,0xf0,0xc3]
                                                    : [0x48,0x89,0xc8,0x48,0x01,0xd0,0xc3]
                let image = Data(bytes)
                let native = try LinkedFEXTranslator(image: image, guestBase: 0x500000400000, abi: abi)
                let service = try FEXService(translator: native, image: image); self.service = service
                let transport = try WebKitTransport(services: ["fex": { try await service.handle($0) }]); self.transport = transport
                // Allow SwiftUI to mount the WebView before loading its worker.
                await Task.yield()
                let session = try RuntimeSession(transport: transport, limits: RuntimeLimits(maximumMemoryPages: 4096))
                self.session = session
                let caps = try await session.start()
                guard caps.jspi else { throw RuntimeFault("unsupported", "WebKit JSPI is unavailable on this OS.") }
                try await session.openFEX()
                let answer = try await session.callFEX(entry: 0x400000, arguments: [20,22])
                let stats = await service.statistics()
                guard answer == 42, stats.unitRequests > 0 else { throw RuntimeFault("testMismatch", "Expected fresh translation and RAX=42.") }
                session.close(); await service.close()
                self.session = nil; self.service = nil; self.transport = nil
            }
            message = "PASS: SysV and Win64 freshly translated 20 + 22 = 42."
        } catch {
            message = "FAIL: \(error.localizedDescription)"
            session?.close(); if let service { await service.close() }
            session = nil; service = nil; transport = nil
        }
    }
}
private struct FEXHostView: View {
    @StateObject private var model = FEXHostModel()
    var body: some View {
        VStack {
            Text(model.message).textSelection(.enabled)
            Button("Run live FEX check") { Task { await model.run() } }.disabled(model.running)
            if let transport = model.transport { ExecutorView(transport: transport).frame(minHeight: 160) }
        }.padding()
    }
}
private struct ExecutorView: UIViewRepresentable {
    let transport: WebKitTransport
    func makeUIView(context: Context) -> WKWebView { transport.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
import WebKit
