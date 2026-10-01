// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT
import BetterJITWebKit
import BetterJITFEX

private actor DiagnosticEchoService {
    private(set) var calls = 0
    private(set) var bytes = 0
    func handleBinary(_ request: NativeBinaryServiceRequest) throws -> NativeBinaryServiceResponse {
        guard request.payload == .null, let data = request.bytes, data.count <= 4 * 1024 * 1024 else {
            throw RuntimeFault("testInput", "Diagnostic binary echo payload is invalid or too large.")
        }
        calls += 1; bytes += data.count
        return .bytes(data)
    }
    func snapshot() -> (Int,Int) { (calls,bytes) }
}

@MainActor final class WebDiagnosticExecutor {
    private let mode: DiagnosticTransportMode
    private let mount: @MainActor (WebKitTransport?) -> Void
    private let echo = DiagnosticEchoService()
    private(set) var transport: WebKitTransport?
    private var session: RuntimeSession?
    init(mode: DiagnosticTransportMode, mount: @escaping @MainActor (WebKitTransport?) -> Void) {
        self.mode = mode; self.mount = mount
    }
    private var preference: MappedTransportPreference {
        switch mode {
        case .copied: return .disabled
        case .mappedPreferred: return .preferred
        case .mappedRequired: return .required
        }
    }
    func start() async throws -> RuntimeCapabilities {
        let echo = self.echo
        let transport = try WebKitTransport(binaryServices:["diag.echo": { try await echo.handleBinary($0) }],
                                            mappedTransport: preference)
        self.transport = transport; mount(transport)
        await Task.yield()
        let limits = try RuntimeLimits(initialMemoryPages:16, maximumMemoryPages:4096,
                                       maximumTransferBytes:4 * 1024 * 1024,
                                       maximumPendingRequests:16, timeoutSeconds:90,
                                       maximumPendingBytes:64 * 1024 * 1024)
        let session = try RuntimeSession(transport:transport, limits:limits); self.session = session
        return try await session.start()
    }
    func run(_ name: String, args: [String:JSONValue] = [:]) async throws -> DiagnosticOutcome {
        guard let session else { throw SuiteFailure("Diagnostic session has not started.") }
        let answer = try await session.request("diagnostic.run", payload:.object([
            "name":.string(name), "args":.object(args)
        ]))
        var outcome = try answer.decode(WorkerDiagnosticReply.self).outcome()
        let stats = transport?.mappedTransportStatistics
        if let stats {
            outcome.counters["mappedTransportActive"] = stats.active ? 1 : 0
            outcome.counters["mappedNativeReadBytes"] = stats.nativeReadBytes
            outcome.counters["mappedNativeWriteBytes"] = stats.nativeWriteBytes
            outcome.counters["mappedServiceCalls"] = stats.mappedServiceCalls
            if let reason = stats.fallbackReason { outcome.details["mappedFallback"] = reason }
        }
        let echoStats = await self.echo.snapshot()
        outcome.counters["nativeEchoCalls"] = echoStats.0
        outcome.counters["nativeEchoBytes"] = echoStats.1
        return outcome
    }
    func close() {
        session?.close(); session = nil
        transport?.close(); transport = nil; mount(nil)
    }
}


@MainActor enum FEXMetadataDiagnostic {
    static func run() throws -> DiagnosticOutcome {
        let image = Data([0x48,0x89,0xf8,0x48,0x01,0xf0,0xc3])
        let translator = try LinkedFEXTranslator(image:image, guestBase:SuitePlan.guestBase, abi:.sysv)
        defer { translator.close() }
        let config = try JSONDecoder().decode(JSONValue.self, from:translator.configuration())
        func number(_ key: String) -> Int? { config[key]?.integer }
        guard let pages=number("memPages"), pages > 0,
              let imageLow=number("imageLow"), let stackTop=number("stackTop"),
              let stateSize=number("stateSize"), let hot=number("hotThreshold") else {
            throw SuiteFailure("FEX configuration is missing required layout fields.")
        }
        let details: [String:String] = [
            "guestABI":config["guestAbi"]?.string ?? "unknown",
            "shared":String(config["shared"]?.integer ?? -1),
            "windowHi":String(number("windowHi") ?? -1),
            "imageLow":String(imageLow),
            "stackTop":String(stackTop),
            "stateSize":String(stateSize),
            "hotThreshold":String(hot),
            "dispatchBits":String(number("dispatchBits") ?? -1),
            "callSiteBits":String(number("callSiteBits") ?? -1),
            "unitCounterBits":String(number("unitCounterBits") ?? -1)
        ]
        return .pass(details:details, metrics:[
            "guestMemoryBytes":Double(pages) * 65536,
            "guestMemoryPages":Double(pages),
            "imageLow":Double(imageLow),
            "stackTop":Double(stackTop),
            "stateSize":Double(stateSize)
        ])
    }
}

@MainActor enum SyscallDiagnosticExecutor {
    static func run(mapped: Bool, mount: @escaping @MainActor (WebKitTransport?) -> Void) async throws -> DiagnosticOutcome {
        let native = try LinkedFEXTranslator(image:SyscallGuest.image, guestBase:SuitePlan.guestBase, abi:.sysv)
        let service = try FEXService(translator:native, image:SyscallGuest.image)
        let transport = try WebKitTransport(binaryServices:["fex": { try await service.handleBinary($0) }],
                                            mappedTransport:mapped ? .required : .disabled)
        mount(transport)
        defer { transport.close(); mount(nil); Task { await service.close() } }
        await Task.yield()
        let session = try RuntimeSession(transport:transport,
                                         limits:RuntimeLimits(maximumMemoryPages:4096, timeoutSeconds:30))
        let caps = try await session.start()
        guard caps.extensions.contains("fex.linuxSyscallSubset") else {
            session.close(); return .unsupported("Runtime does not advertise the minimal synchronous Linux syscall subset.")
        }
        try await session.openFEX()
        let pid = try await session.callFEX(entry:SyscallGuest.getpid, arguments:[])
        let tid = try await session.callFEX(entry:SyscallGuest.gettid, arguments:[])
        let yielded = try await session.callFEX(entry:SyscallGuest.yield, arguments:[])
        let missing = try await session.callFEX(entry:SyscallGuest.unsupported, arguments:[])
        let counters = await service.statistics()
        session.close()
        guard pid == 1, tid == 1, yielded == 0, missing == SyscallGuest.enosys else {
            throw SuiteFailure("Linux syscall subset returned unexpected register values.")
        }
        return .pass(details:[
            "getpid":String(pid),"gettid":String(tid),"schedYield":String(yielded),
            "unknownSyscall":String(missing),"unknownExpected":"-ENOSYS"
        ], counters:[
            "unitRequests":counters.unitRequests,"regionRequests":counters.regionRequests,
            "returnedTranslationBytes":counters.returnedBytes,"rejectedRequests":counters.rejectedRequests
        ], notes:["This is a minimal synchronous subset, not a Wine-capable Linux syscall/VFS implementation."])
    }
}
