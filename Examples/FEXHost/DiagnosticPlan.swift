// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum DiagnosticKind: String {
    case nativeEnvironment, nativeVM, nativeFileIO, nativeThreads, nativeMetal
    case webFeatures, transportCopied, transportMappedPreferred, transportMappedRequired, transportSummary
    case wasmMemory, wasmMemoryStress, opfsIO, pagingSafe, pagingStress
    case sharedWorkers, moduleClone, fexLayout
    case fexSysV, fexWin64, fexSIMDSysV, fexSIMDWin64, fexRegionSysV, fexRegionWin64
    case syscallSubset, processLifecycle
    case wineReadiness, graphicsReadiness
}
struct DiagnosticSpec: Identifiable {
    let id: String
    let title: String
    let category: String
    let kind: DiagnosticKind
}
enum DiagnosticPlan {
    static let allSafe: [DiagnosticSpec] = [
        .init(id:"environment", title:"Native environment snapshot", category:"Host", kind:.nativeEnvironment),
        .init(id:"native-vm", title:"Native mmap / mprotect / page touch", category:"Memory", kind:.nativeVM),
        .init(id:"native-file-io", title:"Native app-container file I/O", category:"Storage", kind:.nativeFileIO),
        .init(id:"native-threads", title:"Native concurrent worker checksum", category:"Threads", kind:.nativeThreads),
        .init(id:"web-features", title:"WebKit execution feature inventory", category:"WebKit", kind:.webFeatures),
        .init(id:"transport-copied", title:"Copied RPC large-payload round trips", category:"Transport", kind:.transportCopied),
        .init(id:"transport-mapped-preferred", title:"Mapped transport preferred / fallback", category:"Transport", kind:.transportMappedPreferred),
        .init(id:"transport-mapped-required", title:"Mapped transport required", category:"Transport", kind:.transportMappedRequired),
        .init(id:"transport-summary", title:"Copied vs mapped 1 MiB comparison", category:"Transport", kind:.transportSummary),
        .init(id:"wasm-memory", title:"Wasm linear-memory allocation / growth", category:"Memory", kind:.wasmMemory),
        .init(id:"opfs-io", title:"Synchronous OPFS read / write", category:"Storage", kind:.opfsIO),
        .init(id:"paging-safe", title:"OPFS-backed software paging prototype", category:"Memory", kind:.pagingSafe),
        .init(id:"shared-workers", title:"WebWorker SharedArrayBuffer / Atomics", category:"Threads", kind:.sharedWorkers),
        .init(id:"module-clone", title:"Compiled Wasm module worker cloning", category:"Threads", kind:.moduleClone),
        .init(id:"fex-layout", title:"FEX guest address / memory layout", category:"FEX", kind:.fexLayout),
        .init(id:"fex-sysv", title:"Live FEX SysV translation smoke", category:"FEX", kind:.fexSysV),
        .init(id:"fex-win64", title:"Live FEX Win64 translation smoke", category:"FEX", kind:.fexWin64),
        .init(id:"fex-simd-sysv", title:"FEX SSE2 smoke / SysV", category:"FEX", kind:.fexSIMDSysV),
        .init(id:"fex-simd-win64", title:"FEX SSE2 smoke / Win64", category:"FEX", kind:.fexSIMDWin64),
        .init(id:"fex-region-sysv", title:"FEX hot-region install / SysV", category:"FEX", kind:.fexRegionSysV),
        .init(id:"fex-region-win64", title:"FEX hot-region install / Win64", category:"FEX", kind:.fexRegionWin64),
        .init(id:"syscall-subset", title:"Minimal Linux syscall subset through FEX", category:"Guest OS", kind:.syscallSubset),
        .init(id:"process-lifecycle", title:"Repeated WebKit session create / execute / close", category:"Lifecycle", kind:.processLifecycle),
        .init(id:"native-metal", title:"Native Metal command-queue smoke", category:"Graphics", kind:.nativeMetal),
        .init(id:"wine-readiness", title:"Wine runtime readiness gate", category:"Readiness", kind:.wineReadiness),
        .init(id:"graphics-readiness", title:"DXMT / native graphics readiness gate", category:"Readiness", kind:.graphicsReadiness)
    ]
    static let stress: [DiagnosticSpec] = [
        .init(id:"wasm-memory-stress", title:"Wasm 512 MiB allocation / touch stress", category:"Stress", kind:.wasmMemoryStress),
        .init(id:"paging-stress", title:"1 GiB logical OPFS paging stress", category:"Stress", kind:.pagingStress)
    ]
    static func specs(_ preset: DiagnosticPreset, includeStress: Bool) -> [DiagnosticSpec] {
        func pick(_ ids: [String]) -> [DiagnosticSpec] {
            let map = Dictionary(uniqueKeysWithValues: allSafe.map { ($0.id,$0) })
            return ids.compactMap { map[$0] }
        }
        var result: [DiagnosticSpec]
        switch preset {
        case .quick:
            result = pick(["environment","web-features","transport-mapped-required","fex-sysv","fex-win64","syscall-subset","native-metal"])
        case .runtimeCore:
            result = pick(["environment","native-vm","web-features","wasm-memory","fex-layout","fex-sysv","fex-win64",
                           "fex-simd-sysv","fex-simd-win64","fex-region-sysv","fex-region-win64","syscall-subset","process-lifecycle"])
        case .transport:
            result = pick(["transport-copied","transport-mapped-preferred","transport-mapped-required","transport-summary","opfs-io"])
        case .memory:
            result = pick(["environment","native-vm","native-file-io","wasm-memory","opfs-io","paging-safe"])
        case .threads:
            result = pick(["native-threads","web-features","shared-workers","module-clone","process-lifecycle"])
        case .wineReadiness:
            result = pick(["web-features","wasm-memory","shared-workers","fex-layout","fex-sysv","fex-win64","fex-simd-sysv",
                           "fex-simd-win64","syscall-subset","wine-readiness"])
        case .graphicsReadiness:
            result = pick(["transport-mapped-required","native-metal","graphics-readiness"])
        case .full:
            result = allSafe
        }
        if includeStress && [.memory,.full].contains(preset) { result += stress }
        return result
    }
}
