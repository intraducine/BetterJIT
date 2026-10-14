// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import WebKit
import BetterJIT
import BetterJITWebKit
import BetterJITFEX
import BetterJITFEXAdapter

private actor ProbeByteService {
    private(set) var calls = 0
    func handle(_ payload: JSONValue) throws -> JSONValue {
        guard let text = payload.string, text.utf8.count <= 8192,
              let data = Data(base64Encoded: text), data.count <= 4096 else {
            throw RuntimeFault("testInput", "Invalid native-service input.")
        }
        calls += 1
        return .string(Data(data.map { $0 ^ 0x5a }).base64EncodedString())
    }
}

@MainActor final class DeviceExecutor: SuiteExecutor {
    let stage: DeviceStage
    private(set) var transport: WebKitTransport?
    private var session: RuntimeSession?
    private var fex: FEXService?
    private let bytes = ProbeByteService()
    private var module: String?
    private var aborted = false
    private let mappedTransport: MappedTransportPreference
    private let mount: @MainActor (WebKitTransport?) -> Void
    init(stage: DeviceStage, mappedTransport: MappedTransportPreference = .disabled,
         mount: @escaping @MainActor (WebKitTransport?) -> Void) {
        self.stage = stage; self.mappedTransport = mappedTransport; self.mount = mount
    }
    private func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
    private func elapsed(_ start: UInt64) -> Double { Double(now() - start) / 1_000_000 }
    func start() async throws -> StartEvidence {
        var evidence = StartEvidence()
        let start = now()
        let transport: WebKitTransport
        if stage.kind == .nativeService {
            let service = bytes
            transport = try WebKitTransport(services: ["host.1": { try await service.handle($0) }], mappedTransport: mappedTransport)
        } else {
            let abi: LinkedFEXTranslator.ABI = stage.abi == .win64 ? .win64 : .sysv
            let image = stage.image
            let native = try LinkedFEXTranslator(image: image, guestBase: SuitePlan.guestBase, abi: abi)
            let service = try FEXService(translator: native, image: image); fex = service
            transport = try WebKitTransport(binaryServices: ["fex": { try await service.handleBinary($0) }],
                                            mappedTransport: mappedTransport)
        }
        evidence.timings["nativeSetup"] = elapsed(start)
        self.transport = transport; mount(transport)
        // Preserve the proven host mount/start ordering from the baseline app.
        await Task.yield(); try ensureActive()
        let session = try RuntimeSession(transport: transport,
                                        limits: RuntimeLimits(maximumMemoryPages: stage.kind == .nativeService ? 1024 : 4096, timeoutSeconds: 30))
        self.session = session
        let boot = now(); let caps = try await session.start(); try ensureActive()
        evidence.timings["webKitStartup"] = elapsed(boot)
        evidence.capabilities = ["wasm": String(caps.wasm), "jspi": String(caps.jspi), "protocol": String(caps.protocolVersion),
                                 "extensions": caps.extensions.sorted().joined(separator: ","),
                                 "transport": transport.mappedTransportActive ? "OPFS/native mmap data lane + copied control RPC" : "copied messages; mapped lane inactive"]
        if let reason = transport.mappedTransportFallbackReason { evidence.capabilities["mappedTransportFallback"] = reason }
        guard caps.jspi else { throw RuntimeFault("unsupported", "WebKit JSPI is unavailable; no fallback is substituted.") }
        let open = now()
        if stage.kind == .nativeService { module = try await session.load(SuitePlan.byteModule, as: "native-roundtrip") }
        else { try await session.openFEX() }
        evidence.timings["executorOpen"] = elapsed(open)
        try ensureActive(); return evidence
    }
    func invoke(_ test: DeviceCase) async throws -> CallEvidence {
        try ensureActive()
        guard let session else { throw SuiteFailure("Session has not started.") }
        if let input = test.input { try await session.writeMemory(at: test.memoryOffset, bytes: input) }
        let start = now(); let result: UInt64
        if stage.kind == .nativeService {
            guard let module, let input = test.input else { throw SuiteFailure("Missing native-service fixture.") }
            let values = try await session.invoke(module, export: "run", arguments: [.i32(Int32(input.count))], results: [.i32])
            guard let value = values.first?.value, let n = UInt64(value) else { throw SuiteFailure("Invalid native-service result.") }
            result = n
        } else { result = try await session.callFEX(entry: test.entry, arguments: test.arguments) }
        let ms = elapsed(start); try ensureActive()
        var readback: Data?
        if let expected = test.expectedMemory {
            readback = try await session.readMemory(at: stage.kind == .nativeService ? 65536 : test.memoryOffset, count: expected.count)
        }
        return CallEvidence(result: result, milliseconds: ms, memory: readback)
    }
    func counters() async -> [String: Int] {
        if let fex {
            let stats = await fex.statistics()
            var result = ["unitRequests": stats.unitRequests, "regionRequests": stats.regionRequests,
                          "returnedTranslationBytes": stats.returnedBytes, "rejectedRequests": stats.rejectedRequests]
            if let session, session.state == .ready,
               session.capabilities?.extensions.contains("fex.runtimeStatistics") == true {
                do {
                    let reply = try await session.request("statistics")
                    if reply["fex"]?["schema"]?.integer == 1 {
                        let fields = ["units":"unitModulesInstalled", "regions":"regionModulesInstalled",
                                      "regionUnits":"regionUnitsInstalled", "flushes":"fexCacheFlushes"]
                        var snapshot: [String:Int] = [:]
                        for (key,label) in fields {
                            guard let count = reply["fex"]?[key]?.integer, count >= 0 else {
                                throw SuiteFailure("Invalid FEX runtime statistics.")
                            }
                            snapshot[label] = count
                        }
                        result.merge(snapshot) { _,new in new }; result["runtimeStatisticsAvailable"] = 1
                    }
                } catch { result["runtimeStatisticsUnavailable"] = 1 }
            }
            addMappedCounters(&result)
            return result
        }
        var result = ["nativeServiceCalls": await bytes.calls]
        addMappedCounters(&result); return result
    }
    private func addMappedCounters(_ result: inout [String: Int]) {
        guard let stats = transport?.mappedTransportStatistics else { return }
        result["mappedTransportActive"] = stats.active ? 1 : 0
        result["mappedNativeReadBytes"] = stats.nativeReadBytes
        result["mappedNativeWriteBytes"] = stats.nativeWriteBytes
        result["mappedServiceCalls"] = stats.mappedServiceCalls
    }
    func abort() { aborted = true; session?.close(); transport?.close() }
    func close() async {
        abort()
        if let fex { await fex.close() }
        session = nil; fex = nil; transport = nil; mount(nil)
    }
    private func ensureActive() throws {
        try Task.checkCancellation()
        if aborted { throw CancellationError() }
    }
}
