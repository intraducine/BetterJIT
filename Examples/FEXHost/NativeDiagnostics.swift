// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import Darwin
#if canImport(Metal)
import Metal
#endif

private final class DiagnosticThreadResults: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [UInt64]
    init(count: Int) { values = [UInt64](repeating:0,count:count) }
    func set(_ value: UInt64, at index: Int) { lock.lock(); values[index]=value; lock.unlock() }
    func snapshot() -> [UInt64] { lock.lock(); defer { lock.unlock() }; return values }
}

enum NativeDiagnostics {
    private static func elapsed(_ start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }
    private static func fnv(_ data: Data) -> UInt32 {
        data.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
    }
    static func environment() -> DiagnosticOutcome {
        let info = ProcessInfo.processInfo
        return .pass(details: [
            "pointerBits": String(MemoryLayout<UnsafeRawPointer>.size * 8),
            "processorCount": String(info.processorCount),
            "activeProcessorCount": String(info.activeProcessorCount),
            "physicalMemoryBytes": String(info.physicalMemory),
            "pageSize": String(getpagesize()),
            "thermalState": String(info.thermalState.rawValue),
            "lowPowerMode": String(info.isLowPowerModeEnabled)
        ])
    }
    static func virtualMemory() throws -> DiagnosticOutcome {
        let size = 64 * 1024 * 1024, page = Int(getpagesize())
        let start = DispatchTime.now().uptimeNanoseconds
        guard let raw = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0), raw != MAP_FAILED else {
            throw SuiteFailure("Anonymous mmap failed with errno \(errno).")
        }
        defer { _ = munmap(raw, size) }
        let bytes = raw.bindMemory(to: UInt8.self, capacity: size)
        var checksum: UInt64 = 0
        for offset in stride(from: 0, to: size, by: page) {
            let value = UInt8(truncatingIfNeeded: offset / page &* 131 &+ 7)
            bytes[offset] = value; checksum &+= UInt64(value)
        }
        guard mprotect(raw, size, PROT_READ) == 0 else { throw SuiteFailure("mprotect read-only failed with errno \(errno).") }
        var verify: UInt64 = 0
        for offset in stride(from: 0, to: size, by: page) { verify &+= UInt64(bytes[offset]) }
        guard verify == checksum else { throw SuiteFailure("Native page-touch checksum changed after mprotect.") }
        guard mprotect(raw, size, PROT_READ | PROT_WRITE) == 0 else { throw SuiteFailure("mprotect restore failed with errno \(errno).") }
        return .pass(metrics: ["mappedBytes":Double(size),"pages":Double(size/page),"milliseconds":elapsed(start)],
                     details:["checksum":String(checksum)])
    }
    static func fileIO() throws -> DiagnosticOutcome {
        let size = 8 * 1024 * 1024
        var data = Data(count: size)
        data.withUnsafeMutableBytes { raw in
            let b = raw.bindMemory(to: UInt8.self)
            for i in b.indices { b[i] = UInt8(truncatingIfNeeded: i &* 31 &+ 7) }
        }
        let expected = fnv(data)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("betterjit-diag-\(UUID().uuidString).bin")
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw SuiteFailure("Could not create diagnostic file.") }
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forUpdating: url); defer { try? handle.close() }
        var t = DispatchTime.now().uptimeNanoseconds
        try handle.write(contentsOf: data)
        let writeMs = elapsed(t)
        try handle.seek(toOffset: 0)
        t = DispatchTime.now().uptimeNanoseconds
        let read = try handle.read(upToCount: size) ?? Data()
        let readMs = elapsed(t)
        guard read.count == size, fnv(read) == expected else { throw SuiteFailure("Native file I/O checksum mismatch.") }
        let mb = Double(size) / 1_048_576
        return .pass(metrics:[
            "bytes":Double(size),"writeMilliseconds":writeMs,"readMilliseconds":readMs,
            "writeMBps":mb / max(writeMs/1000,0.000001),"readMBps":mb / max(readMs/1000,0.000001)
        ], details:["checksum":String(expected)])
    }
    static func threads() throws -> DiagnosticOutcome {
        let workers = min(4, max(2, ProcessInfo.processInfo.activeProcessorCount))
        let iterations = 750_000
        let box = DiagnosticThreadResults(count:workers)
        let start = DispatchTime.now().uptimeNanoseconds
        DispatchQueue.concurrentPerform(iterations: workers) { worker in
            var x = UInt64(worker + 1) &* 0x9e3779b97f4a7c15
            for i in 0..<iterations {
                x ^= x << 13; x ^= x >> 7; x ^= x << 17; x &+= UInt64(i)
            }
            box.set(x,at:worker)
        }
        let results=box.snapshot()
        guard results.allSatisfy({ $0 != 0 }), Set(results).count == workers else {
            throw SuiteFailure("Native thread checksum result was invalid.")
        }
        return .pass(metrics:["workers":Double(workers),"iterationsPerWorker":Double(iterations),"milliseconds":elapsed(start)],
                     details:["checksums":results.map(String.init).joined(separator:",")])
    }
    static func metal() throws -> DiagnosticOutcome {
        #if canImport(Metal)
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
              let buffer = device.makeBuffer(length: 1024 * 1024, options: .storageModeShared),
              let command = queue.makeCommandBuffer() else {
            return .unsupported("Metal device, queue or buffer is unavailable.")
        }
        memset(buffer.contents(), 0x5a, buffer.length)
        let start = DispatchTime.now().uptimeNanoseconds
        command.commit(); command.waitUntilCompleted()
        guard command.status == .completed else { throw SuiteFailure("Metal command buffer did not complete.") }
        return .pass(metrics:["bufferBytes":Double(buffer.length),"commandMilliseconds":elapsed(start)],
                     details:["metalAvailable":"true"])
        #else
        return .unsupported("Metal framework is unavailable on this platform.")
        #endif
    }
}
