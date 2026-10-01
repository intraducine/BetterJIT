// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum GuestABI: String, Codable, CaseIterable { case sysv, win64 }
enum SuiteMode: String, Codable { case baseline, full, extended }
enum StageKind: String, Codable { case baseline, compiled, nativeService, lifecycle, simd, region }

struct DeviceCase: Codable {
    let id: String
    let title: String
    let entry: UInt32
    var arguments: [UInt64]
    var expected: UInt64
    var input: Data? = nil
    var expectedMemory: Data? = nil
    var warmSamples: Int = 0
    // Reset/read back the complete guard+payload region outside the timed call.
    var memoryOffset: UInt32 = 0x01000000
    var benchmark: BenchmarkKind? = nil
    var requiresRegion = false
}
struct DeviceStage {
    let id: String
    let title: String
    let kind: StageKind
    let abi: GuestABI?
    let cases: [DeviceCase]
    var image: Data {
        if kind == .simd { return ExtendedGuest.image(abi!) }
        if kind == .compiled || kind == .region { return CompiledGuest.image(abi!) }
        return Data(abi == .win64 ? [0x48,0x89,0xc8,0x48,0x01,0xd0,0xc3] : [0x48,0x89,0xf8,0x48,0x01,0xf0,0xc3])
    }
}

enum SuitePlan {
    static let version = "device-suite-v1"
    static let guestBase: UInt64 = 0x500000400000
    static let addressWindow: UInt64 = 0x500000000000
    static let guardLength = 19 // Deliberately unaligned byte payload.
    static func stages(_ mode: SuiteMode) -> [DeviceStage] {
        if mode == .extended { return stages(.full) + AdvancedPlan.stages() }
        var stages = GuestABI.allCases.map { abi in
            DeviceStage(id: "baseline-" + abi.rawValue, title: "Working baseline / " + abi.rawValue,
                        kind: .baseline, abi: abi,
                        cases: [DeviceCase(id: "add", title: "Fresh translation: 20 + 22", entry: 0x400000, arguments: [20,22], expected: 42)])
        }
        guard mode == .full else { return stages }
        for abi in GuestABI.allCases {
            func test(_ id: String, _ title: String, _ name: String, _ args: [UInt64], _ expected: UInt64, samples: Int = 0) -> DeviceCase {
                DeviceCase(id: id, title: title, entry: CompiledGuest.entry(name, abi), arguments: args, expected: expected, warmSamples: samples)
            }
            let arguments: [UInt64] = [UInt64.max,1,0x8000000000000000,0,7,0x20000000000001,9,11,13,17,19,23,29,31,37,41]
            let cases = [
                test("overflow", "64-bit wrapping addition", "add64", [.max,1], 0),
                test("precision", "Integer bits above 2^53", "add64", [0x20000000000001,42], 0x2000000000002b),
                test("stack16", "16 arguments: registers and stack", "weighted16", arguments, weighted(arguments)),
                test("zero-loop", "Zero-iteration branch", "branch_mix", [0,.max], .max),
                test("short-loop", "Branching scalar loop", "branch_mix", [257,7], branch(257,7)),
                test("nested", "Nested calls and return stack", "nested_calls", [257,9], nested(257,9)),
                memoryCase(abi, count: 31), memoryCase(abi, count: 16_401),
                test("bench-branch", "Branch workload / 20,000 iterations", "branch_mix", [20_000,7], branch(20_000,7), samples: 5),
                test("bench-calls", "Nested-call workload / 5,000 iterations", "nested_calls", [5_000,9], nested(5_000,9), samples: 5)
            ]
            // Stable order: first-in-session timings are never called cold-JIT timings.
            stages.append(DeviceStage(id: "compiled-" + abi.rawValue, title: "Compiled C / " + abi.rawValue,
                                      kind: .compiled, abi: abi, cases: cases))
        }
        let nativeCases = [64,4096].map { n -> DeviceCase in
            let input = Data((0..<n).map { UInt8(truncatingIfNeeded: $0 * 31 + 7) })
            return DeviceCase(id: "bytes-\(n)", title: "Wasm → Swift → Wasm / \(n) bytes", entry: 0,
                              arguments: [], expected: UInt64(n), input: input,
                              expectedMemory: Data(input.map { $0 ^ 0x5a }), warmSamples: 3, memoryOffset: 0)
        }
        stages.append(DeviceStage(id: "native-service", title: "Native-service bridge (not FEX/OPFS)", kind: .nativeService, abi: nil, cases: nativeCases))
        for i in 1...3 {
            stages.append(DeviceStage(id: "lifecycle-\(i)", title: "Create / execute / close \(i) of 3", kind: .lifecycle, abi: .sysv,
                                      cases: [DeviceCase(id: "roundtrip", title: "Independent FEX session", entry: 0x400000, arguments: [UInt64(i),42], expected: UInt64(i+42))]))
        }
        return stages
    }
    static func weighted(_ a: [UInt64]) -> UInt64 {
        a.enumerated().reduce(0) { $0 &+ ($1.element &* UInt64($1.offset + 1)) }
    }
    static func branch(_ n: UInt64, _ seed: UInt64) -> UInt64 {
        var x = seed
        for i in 0..<n {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17
            x = x & 1 != 0 ? x &+ i : x ^ i
        }
        return x
    }
    static func nested(_ n: UInt64, _ seed: UInt64) -> UInt64 {
        var x = seed
        for i in 0..<n { x = (((x << 9) | (x >> 55)) ^ (i &* 0x9e3779b97f4a7c15)) &+ 0x100000001 }
        return x
    }
    static func memoryCase(_ abi: GuestABI, count: Int) -> DeviceCase {
        let prefix = Data(repeating: 0xa5, count: guardLength)
        let payload = Data((0..<count).map { UInt8(truncatingIfNeeded: $0 * 31 + 7) })
        let suffix = Data(repeating: 0x5a, count: 17)
        let seed: UInt64 = 249
        let output = Data(payload.enumerated().map { UInt8(truncatingIfNeeded: UInt64($0.element ^ UInt8(truncatingIfNeeded: seed &+ UInt64($0.offset))) &+ 3) })
        let checksum = output.reduce(UInt64(0xcbf29ce484222325)) { ($0 ^ UInt64($1)) &* 0x100000001b3 }
        return DeviceCase(id: "memory-\(count)", title: "Guarded unaligned memory / \(count) bytes", entry: CompiledGuest.entry("mutate", abi),
                          arguments: [addressWindow + 0x01000000 + UInt64(guardLength),UInt64(count),seed], expected: checksum,
                          input: prefix + payload + suffix, expectedMemory: prefix + output + suffix)
    }
    // (func (export "run") (param i32) (result i32)
    //   i32.const 1; i32.const 0; local.get 0; i32.const 65536; local.get 0; call host)
    // Generated in Swift from this compact fixture, never recorded from guest execution.
    static var byteModule: Data {
        func section(_ id: UInt8, _ bytes: [UInt8]) -> [UInt8] { [id,UInt8(bytes.count)] + bytes }
        func name(_ text: String) -> [UInt8] { [UInt8(text.utf8.count)] + Array(text.utf8) }
        var bytes: [UInt8] = [0,97,115,109,1,0,0,0]
        bytes += section(1,[2,0x60,5,0x7f,0x7f,0x7f,0x7f,0x7f,1,0x7f,0x60,1,0x7f,1,0x7f])
        var imports: [UInt8] = [2]
        imports += name("betterjit"); imports += name("memory"); imports += [2,0,1]
        imports += name("betterjit"); imports += name("call"); imports += [0,0]
        bytes += section(2,imports); bytes += section(3,[1,1])
        bytes += section(7,[1] + name("run") + [0,1])
        let body: [UInt8] = [0,0x41,1,0x41,0,0x20,0,0x41,0x80,0x80,4,0x20,0,0x10,0,0x0b]
        bytes += section(10,[1,UInt8(body.count)] + body)
        return Data(bytes)
    }
}
