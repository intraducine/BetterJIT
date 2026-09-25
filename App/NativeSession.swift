import Foundation
import CoreFoundation
import BetterJITCore

/// Owned by one serial queue. Neither guest pointers nor arbitrary native paths
/// are accepted by the message handler; only the fixed diagnostic operations exist.
final class NativeSession {
    private var token: String?
    private var fileURL: URL?
    private var sequence = 0
    let reportURL: URL
    private let roots: [URL]

    init() throws {
        let library = try FileManager.default.url(for: .libraryDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        roots = [library.appendingPathComponent("WebKit"), library.appendingPathComponent("Caches/WebKit")]
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        reportURL = documents.appendingPathComponent("BetterJIT-last-report.json")
    }

    private func integer(_ object: Any?, maximum: Int) throws -> Int {
        guard let number = object as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0,
              number.doubleValue <= Double(maximum), number.doubleValue.rounded() == number.doubleValue else {
            throw ProbeError.invalid("Invalid bounded integer")
        }
        return number.intValue
    }

    @inline(never) private func reference(_ n: Int, _ seed: UInt64) -> UInt64 {
        var result = seed
        for _ in 0..<n { result = result &* 3 &+ 1 }
        return result
    }

    func process(_ body: [String: Any]) throws -> [String: Any] {
        switch body["command"] as? String {
        case "configuration":
            let session = UUID().uuidString.lowercased()
            token = session; fileURL = nil; sequence = 0
            var config: [String: Any] = ["schema": 1, "session": session, "nativeHost": true,
                "environment": ["os": ProcessInfo.processInfo.operatingSystemVersionString,
                    "appBuild": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
                    "commit": Bundle.main.infoDictionary?["BetterJITCommit"] as? String ?? "workspace",
                    "physicalMemoryBytes": String(ProcessInfo.processInfo.physicalMemory)]]
            for (name, x86) in [
                ("arithmetic", try X86Wasm.hex(X86Wasm.arithmeticHex)),
                ("low-memory", X86Wasm.memoryFixture(address: 8192)),
                ("high-memory", X86Wasm.memoryFixture(address: Transport.highOffset))
            ] { config[name] = try X86Wasm.compile(x86).base64EncodedString() }
            let warm = reference(10_000, 7)
            var samples: [[String: Any]] = []
            for _ in 0..<5 {
                let start = DispatchTime.now().uptimeNanoseconds
                let result = reference(1_000_000, 7)
                samples.append(["ms": Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6,
                                "checksum": String(Int64(bitPattern: result))])
            }
            config["baseline"] = ["iterations": 1_000_000, "samples": samples, "warmupChecksum": String(warm),
                "scope": "AOT Swift arithmetic only, not a native FEX or game baseline. Use Release builds."]
            return config
        case "exchange":
            guard let token, body["session"] as? String == token,
                  let offsetString = body["offset"] as? String,
                  let offset = UInt64(offsetString), String(offset) == offsetString else {
                throw ProbeError.invalid("Invalid session/offset")
            }
            let incoming = try integer(body["sequence"], maximum: 1000)
            guard incoming == sequence + 1 else { throw ProbeError.invalid("Out-of-order transport operation") }
            let length = try integer(body["length"], maximum: Transport.maxPayload)
            guard (offset == UInt64(Transport.headerSize) && [4096, 65536, Transport.maxPayload].contains(length)) ||
                  (offset == Transport.highOffset && length == 4096) else {
                throw ProbeError.invalid("Only the diagnostic payload windows are accessible")
            }
            let expected = UInt32(try integer(body["hash"], maximum: Int(UInt32.max)))
            if fileURL == nil { fileURL = try Transport.discover(in: roots, token: token) }
            guard let fileURL else { throw ProbeError.invalid("Missing OPFS file") }
            let start = DispatchTime.now().uptimeNanoseconds
            let mapped = try MappedFile(url: fileURL, marker: Transport.marker(token))
            let result = try mapped.exchange(offset: offset, length: length, expectedHash: expected)
            mapped.close() // reply only after the mapping/descriptor are released
            sequence = incoming
            return ["sequence": incoming, "hash": result,
                    "nativeMapMs": Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6,
                    "device": String(mapped.device), "inode": String(mapped.inode)]
        case "report":
            guard let report = body["report"] as? [String: Any], report["session"] as? String == token,
                  JSONSerialization.isValidJSONObject(report) else { throw ProbeError.invalid("Invalid report") }
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            guard data.count <= 512 * 1024 else { throw ProbeError.invalid("Report too large") }
            try data.write(to: reportURL, options: .atomic)
            return ["saved": true]
        default: throw ProbeError.invalid("Unknown diagnostic command")
        }
    }
}
