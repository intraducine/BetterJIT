// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// Additional tests do not change the already validated scalar fixture image.
enum AdvancedPlan {
    static let version = "device-suite-v2"
    static let seeds: [UInt32] = [0, 1, .max, 0x80000000]
    static let pointer = SuitePlan.addressWindow + 0x01000000 + UInt64(SuitePlan.guardLength)
    static func stages() -> [DeviceStage] {
        GuestABI.allCases.flatMap { abi -> [DeviceStage] in
            let simd = simdCases(abi)
            let region = DeviceCase(id: "hot-region", title: "Request, install, then verify a single-entry region",
                                    entry: CompiledGuest.entry("branch_mix", abi), arguments: [257,7], expected: SuitePlan.branch(257,7), requiresRegion: true)
            let branch = DeviceCase(id: "calibrated-branch", title: "Calibrated scalar branching", entry: CompiledGuest.entry("branch_mix", abi),
                                    arguments: [20_000,7], expected: SuitePlan.branch(20_000,7), warmSamples: 5, benchmark: .branch)
            let calls = DeviceCase(id: "calibrated-calls", title: "Calibrated nested calls", entry: CompiledGuest.entry("nested_calls", abi),
                                   arguments: [5_000,9], expected: SuitePlan.nested(5_000,9), warmSamples: 5, benchmark: .nested)
            var vector = vectorLoop(abi, iterations: 10_000)
            vector.warmSamples = 5; vector.benchmark = .vector
            return [
                DeviceStage(id: "simd-" + abi.rawValue, title: "SSE2 correctness / " + abi.rawValue, kind: .simd, abi: abi, cases: simd),
                DeviceStage(id: "region-" + abi.rawValue, title: "Automatic region promotion / " + abi.rawValue, kind: .region, abi: abi, cases: [region]),
                DeviceStage(id: "calibration-" + abi.rawValue, title: "Long scalar timings / " + abi.rawValue, kind: .compiled, abi: abi, cases: [branch,calls]),
                DeviceStage(id: "simd-calibration-" + abi.rawValue, title: "Long SSE2 timings / " + abi.rawValue, kind: .simd, abi: abi, cases: [vector])
            ]
        }
    }
    static func little<T: FixedWidthInteger>(_ values: [T]) -> Data {
        Data(values.flatMap { value in (0..<MemoryLayout<T>.size).map { UInt8(truncatingIfNeeded: value >> ($0*8)) } })
    }
    static func guarded(_ payload: Data) -> Data {
        Data(repeating: 0xa5, count: SuitePlan.guardLength) + payload + Data(repeating: 0x5a, count: 17)
    }
    static func memoryTest(_ abi: GuestABI, id: String, title: String, function: String, input: Data, output: Data) -> DeviceCase {
        DeviceCase(id: id, title: title, entry: ExtendedGuest.entry(function,abi), arguments: [pointer], expected: 1,
                   input: guarded(input), expectedMemory: guarded(output))
    }
    static func simdCases(_ abi: GuestABI) -> [DeviceCase] {
        let x: [UInt32] = [.max, 0x80000000, 0x12345678, 1]
        let constants: [UInt32] = [1,.max,0x80000000,0x12345678]
        let mixed = zip(x,constants).map { ($0 &+ $1) ^ ($0 >> 7) }
        let shuffled = [2,0,3,1].map { mixed[$0] }
        let rotated = shuffled.map { ($0 << 3) | ($0 >> 29) }
        let words = memoryTest(abi,id: "simd-words",title: "Packed words: wrap, shifts, shuffle, unaligned access",function: "vector_words",
                               input: little(x) + Data(repeating: 0xcc,count:16), output: little(shuffled) + little(rotated))
        let signed: [Int16] = [.min,-1,0,1,127,254,255,256,32767,-32767,17,239,240,241,128,42]
        let packed = signed.map { UInt8(max(0,min(255,Int($0)))) }
        let saturated = packed.map { UInt8(min(255,Int($0)+17)) }
        let saturation = memoryTest(abi,id: "simd-saturation",title: "Signed-word packing and unsigned-byte saturation",function: "vector_saturation",
                                    input: little(signed),output: Data(packed + saturated))
        let f32: [Float] = [1.5,-2,32,-0.5]
        let out32: [Float] = [7,0,68,3] // Exact finite values; not a NaN/rounding-mode test.
        let masks32: [UInt32] = [0,.max,0,.max]
        let floats = memoryTest(abi,id: "simd-f32",title: "Packed Float32 arithmetic and comparison masks",function: "vector_f32",
                               input: little(f32.map(\.bitPattern)) + Data(repeating: 0xcc,count:16),output: little(out32.map(\.bitPattern)) + little(masks32))
        let f64: [Double] = [1.25,-8], out64: [Double] = [6,-31], masks64: [UInt64] = [0,.max]
        let doubles = memoryTest(abi,id: "simd-f64",title: "Packed Float64 arithmetic and comparison masks",function: "vector_f64",
                                input: little(f64.map(\.bitPattern)) + Data(repeating: 0xcc,count:16),output: little(out64.map(\.bitPattern)) + little(masks64))
        return [words,saturation,floats,doubles]
    }
    /// Scalar affine exponentiation oracle, independent of the vector loop.
    /// Computes x <- 5*x + b modulo 2^32 in O(log n), including n=0.
    static func affine(_ n: UInt64, seed: UInt32, add: UInt32) -> UInt32 {
        var n=n, a:UInt32=5, b=add, x=seed
        while n>0 {
            if n&1 != 0 { x = a &* x &+ b }
            b = a &* b &+ b; a = a &* a; n >>= 1
        }
        return x
    }
    static func vectorLoop(_ abi: GuestABI, iterations: UInt64) -> DeviceCase {
        let result = seeds.enumerated().map { affine(iterations,seed:$0.element,add:UInt32($0.offset*2+1)) }
        return DeviceCase(id: "calibrated-simd",title: "Calibrated four-lane SIMD recurrence",entry:ExtendedGuest.entry("vector_lcg",abi),
                          arguments:[pointer,iterations],expected:result.reduce(UInt64(0)){$0 &+ UInt64($1)},
                          input:guarded(little(seeds)),expectedMemory:guarded(little(result)))
    }
    static func resized(_ test: DeviceCase, iterations: UInt64) throws -> DeviceCase {
        guard iterations>0, iterations<=BenchmarkPolicy.maximumIterations, let kind=test.benchmark else {
            throw SuiteFailure("Invalid calibrated iteration count.")
        }
        var copy=test
        switch kind {
        case .branch: copy.arguments[0]=iterations; copy.expected=SuitePlan.branch(iterations,test.arguments[1])
        case .nested: copy.arguments[0]=iterations; copy.expected=SuitePlan.nested(iterations,test.arguments[1])
        case .vector:
            copy.arguments[1]=iterations
            let result=seeds.enumerated().map{affine(iterations,seed:$0.element,add:UInt32($0.offset*2+1))}
            copy.expected=result.reduce(0){$0 &+ UInt64($1)}; copy.expectedMemory=guarded(little(result))
        }
        return copy
    }
}
