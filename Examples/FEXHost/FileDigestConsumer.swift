// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import CryptoKit
import SwiftUI
import UniformTypeIdentifiers
import BetterJITFEXAdapter

enum DigestBackendChoice:String,CaseIterable { case native="Native", betterJIT="BetterJIT" }
struct DigestResult { let sha256:String; let counters:[String:Int] }
@MainActor protocol DocumentDigestBackend {
    func digest(_ data:Data) async throws -> DigestResult
    func close()
}
@MainActor final class NativeDocumentDigestBackend:DocumentDigestBackend {
    func digest(_ data:Data) async throws -> DigestResult {
        DigestResult(sha256:SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined(),counters:[:])
    }
    func close() {}
}
@MainActor final class FEXDocumentDigestBackend:DocumentDigestBackend {
    private(set) var process:FEXProcess?
    var mount:((FEXProcess?)->Void)?
    var onLog:((String)->Void)?
    func digest(_ data:Data) async throws -> DigestResult {
        guard data.count<=32*1024*1024 else { throw SuiteFailure("Choose a file of at most 32 MiB for this example.") }
        let command=try FEXProcess(root:LinuxHarness.rootURL,
            configuration:.init(arguments:["/bin/busybox","sha256sum","/input/document"],
                                timeoutSeconds:60,sharedAddressSpace:false),
            overlay:["/input/document":data])
        process=command; mount?(command)
        command.onLog={ [weak self] in self?.onLog?($0) }
        defer { command.close();process=nil;mount?(nil) }
        let result=try await command.run(),stats=command.statistics()
        guard result.exitCode==0,(stats["unitRequests"] ?? 0)>0,(stats["codeMappings"] ?? 0)>0,
              let match=result.log.range(of:"(?m)^[0-9a-f]{64}  /input/document\\r?$",options:.regularExpression) else {
            throw SuiteFailure("The guest file-digest command did not return a checked digest with real translation evidence.")
        }
        return DigestResult(sha256:String(result.log[match].prefix(64)),counters:stats)
    }
    func close() { process?.close();process=nil;mount?(nil) }
}
@MainActor final class FileDigestConsumerModel:ObservableObject {
    @Published var backend=DigestBackendChoice.betterJIT
    @Published var running=false
    @Published var status="Choose a file or use the bundled example."
    @Published var digest=""
    @Published var process:FEXProcess?
    private var bytes=LinuxUserspaceWorkload.payload
    private var executor:(any DocumentDigestBackend)?
    private var task:Task<Void,Never>?
    func choose(_ url:URL) {
        guard !running else { return }
        let scoped=url.startAccessingSecurityScopedResource();defer { if scoped {url.stopAccessingSecurityScopedResource()} }
        do {
            let file=try FileHandle(forReadingFrom:url);defer {try? file.close()}
            let limit=32*1024*1024
            var data=Data()
            // A read may return fewer bytes than requested. Consume through EOF
            // while retaining only one extra byte to detect an oversized input.
            while data.count<=limit {
                guard let chunk=try file.read(upToCount:min(1024*1024,limit+1-data.count)),
                      !chunk.isEmpty else { break }
                data.append(chunk)
            }
            guard data.count<=32*1024*1024 else {throw SuiteFailure("Choose a file of at most 32 MiB.")}
            bytes=data;digest="";status="Selected \(data.count) bytes."
        } catch {status=error.localizedDescription}
    }
    func run() {
        guard !running else{return};running=true;digest="";status="Calculating digest…"
        let selected=backend,data=bytes
        task=Task {
            defer {running=false;executor=nil;task=nil}
            do {
                let implementation:any DocumentDigestBackend
                if selected == .native {implementation=NativeDocumentDigestBackend()}
                else {
                    let fex=FEXDocumentDigestBackend()
                    fex.mount={ [weak self] in self?.process=$0 }
                    fex.onLog={ [weak self] text in self?.status=String(text.suffix(500)) }
                    implementation=fex
                }
                executor=implementation;let result=try await implementation.digest(data)
                try Task.checkCancellation()
                let reference=SHA256.hash(data:data).map {String(format:"%02x",$0)}.joined()
                guard result.sha256==reference else {throw SuiteFailure("Backend digest differs from the native reference.")}
                digest=result.sha256;status="\(data.count) bytes · \(selected.rawValue) · digest verified"
            } catch {status=error.localizedDescription}
        }
    }
    func stop() {task?.cancel();executor?.close();process=nil}
}
@MainActor struct FileDigestConsumerView:View {
    @ObservedObject var model:FileDigestConsumerModel
    var otherOperationRunning:Bool
    @State private var choosing=false
    @Environment(\.scenePhase) private var scenePhase
    var body:some View {
        NavigationStack {
            Form {
                Section("File digest") {
                    Text("Use the same document operation with either backend. BetterJIT executes the x86 Linux sha256sum program through the packaged adapter.")
                    Picker("Backend",selection:$model.backend) {ForEach(DigestBackendChoice.allCases,id:\.self){Text($0.rawValue).tag($0)}}
                    Button("Choose file") {choosing=true}.disabled(model.running || otherOperationRunning)
                    Button("Calculate SHA-256") {model.run()}.disabled(model.running || otherOperationRunning)
                    if model.running {Button("Stop"){model.stop()}}
                    Text(model.status).textSelection(.enabled)
                    if !model.digest.isEmpty {Text(model.digest).font(.caption.monospaced()).textSelection(.enabled)}
                }
                if let process=model.process {Section {FEXProcessView(process:process).frame(height:120)}}
                Section {Text("This is a backend selected through an async document interface. It does not replace arbitrary native function pointers. Files stay on this device.").font(.caption)}
            }.navigationTitle("Use BetterJIT")
        }
        .fileImporter(isPresented:$choosing,allowedContentTypes:[.data]) {
            switch $0 {
            case .success(let url):model.choose(url)
            case .failure(let error):model.status=error.localizedDescription
            }
        }
        .onDisappear {model.stop()}
        .onChange(of:scenePhase){_,phase in if phase == .background {model.stop()}}
    }
}
