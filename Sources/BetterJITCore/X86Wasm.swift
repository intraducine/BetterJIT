import Foundation

public enum ProbeError: Error, CustomStringConvertible {
    case invalid(String)
    public var description: String {
        switch self { case .invalid(let text): return text }
    }
}

/// Deliberately NOT FEX. A fail-closed, register-only x86-64 subset plus absolute
/// 64-bit loads/stores, sufficient to test native translation -> WebKit execution.
/// Flags, guest stack/RET semantics, branches, syscalls, SIMD and exceptions are absent.
/// RET is the end-of-fixture marker; nothing following it is accepted.
public enum X86Wasm {
    private enum Op {
        case constant(Int, UInt64), copy(Int, Int)
        case binary(Int, Int, UInt8), immediate(UInt64, UInt8)
        case load(UInt64), store(UInt64)
    }

    private struct Reader {
        let bytes: [UInt8]
        var offset = 0
        mutating func byte() throws -> UInt8 {
            guard offset < bytes.count else { throw ProbeError.invalid("Truncated instruction at \(offset)") }
            defer { offset += 1 }
            return bytes[offset]
        }
        mutating func little(_ count: Int) throws -> UInt64 {
            var result: UInt64 = 0
            for shift in 0..<count { result |= UInt64(try byte()) << (shift * 8) }
            return result
        }
    }

    private static func decode(_ bytes: [UInt8]) throws -> [Op] {
        guard !bytes.isEmpty, bytes.count <= 4096 else { throw ProbeError.invalid("Fixture must contain 1...4096 bytes") }
        var r = Reader(bytes: bytes)
        var ops: [Op] = []
        while r.offset < bytes.count {
            let start = r.offset
            let prefix = try r.byte()
            if prefix == 0xc3 {
                guard r.offset == bytes.count else { throw ProbeError.invalid("Trailing bytes after RET") }
                return ops
            }
            // Require exactly REX.W, with R/B extensions only; do not silently
            // reinterpret 32-bit operations, address-size overrides or REX.X.
            guard (prefix & 0xfa) == 0x48 else {
                throw ProbeError.invalid("Unsupported prefix at \(start)")
            }
            let opcode = try r.byte()
            if (0xb8...0xbf).contains(opcode) {
                guard prefix & 4 == 0 else { throw ProbeError.invalid("Unexpected REX.R on MOV immediate") }
                ops.append(.constant(Int(opcode - 0xb8) + Int(prefix & 1) * 8, try r.little(8)))
            } else if opcode == 0x05 || opcode == 0x2d {
                guard prefix == 0x48 else { throw ProbeError.invalid("Unexpected REX extension on accumulator instruction") }
                let immediate = Int64(Int32(bitPattern: UInt32(try r.little(4))))
                ops.append(.immediate(UInt64(bitPattern: immediate), opcode == 0x05 ? 0x7c : 0x7d))
            } else if opcode == 0xa1 || opcode == 0xa3 {
                guard prefix == 0x48 else { throw ProbeError.invalid("Unexpected REX extension on absolute memory instruction") }
                let address = try r.little(8)
                ops.append(opcode == 0xa1 ? .load(address) : .store(address))
            } else {
                var operation = opcode
                if opcode == 0x0f {
                    guard try r.byte() == 0xaf else { throw ProbeError.invalid("Unsupported two-byte opcode at \(start)") }
                    operation = 0xaf
                }
                guard [0x89, 0x8b, 0x01, 0x29, 0x31, 0xaf].contains(operation) else {
                    throw ProbeError.invalid("Unsupported opcode at \(start)")
                }
                let modrm = try r.byte()
                guard modrm & 0xc0 == 0xc0 else { throw ProbeError.invalid("Only register ModRM operands are supported") }
                let reg = Int((modrm >> 3) & 7) + Int((prefix >> 2) & 1) * 8
                let rm = Int(modrm & 7) + Int(prefix & 1) * 8
                switch operation {
                case 0x89: ops.append(.copy(rm, reg))
                case 0x8b: ops.append(.copy(reg, rm))
                case 0x01: ops.append(.binary(rm, reg, 0x7c))
                case 0x29: ops.append(.binary(rm, reg, 0x7d))
                case 0x31: ops.append(.binary(rm, reg, 0x85))
                default: ops.append(.binary(reg, rm, 0x7e))
                }
            }
        }
        throw ProbeError.invalid("Missing terminal RET")
    }

    private static func uleb(_ value: UInt64) -> [UInt8] {
        var v = value, out: [UInt8] = []
        repeat {
            var byte = UInt8(v & 0x7f)
            v >>= 7
            if v != 0 { byte |= 0x80 }
            out.append(byte)
        } while v != 0
        return out
    }

    private static func sleb(_ value: UInt64) -> [UInt8] {
        var v = Int64(bitPattern: value), out: [UInt8] = []
        while true {
            var byte = UInt8(truncatingIfNeeded: v) & 0x7f
            v >>= 7
            let done = (v == 0 && byte & 0x40 == 0) || (v == -1 && byte & 0x40 != 0)
            if !done { byte |= 0x80 }
            out.append(byte)
            if done { return out }
        }
    }

    private static func string(_ text: String) -> [UInt8] {
        let bytes = Array(text.utf8)
        return uleb(UInt64(bytes.count)) + bytes
    }

    /// Exports run(iterations: i32, seed: i64) -> i64. RAX starts at seed;
    /// the other 15 integer registers start at zero and persist between iterations.
    /// At most 10M iterations; invalid counts trap before any guest side effects.
    /// Memory helpers take i64 guest addresses; no pointer truncation to memory32.
    public static func compile(_ x86: [UInt8]) throws -> Data {
        let operations = try decode(x86)
        var module: [UInt8] = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]
        func section(_ id: UInt8, _ bytes: [UInt8]) {
            module += [id] + uleb(UInt64(bytes.count)) + bytes
        }
        // (i64)->i64, (i64,i64)->(), (i32,i64)->i64
        section(1, [3, 0x60, 1, 0x7e, 1, 0x7e,
                    0x60, 2, 0x7e, 0x7e, 0,
                    0x60, 2, 0x7f, 0x7e, 1, 0x7e])
        var imports: [UInt8] = [2]
        imports += string("guest")
        imports += string("load64")
        imports += [0, 0]
        imports += string("guest")
        imports += string("store64")
        imports += [0, 1]
        section(2, imports)
        section(3, [1, 2])
        section(7, [1] + string("run") + [0, 2])
        // Local group: 16 i64 registers at indices 2...17 (params at 0,1).
        var code: [UInt8] = [1, 16, 0x7e]
        func get(_ r: Int) -> [UInt8] { [0x20, UInt8(r + 2)] }
        func set(_ r: Int) -> [UInt8] { [0x21, UInt8(r + 2)] }
        func constant(_ value: UInt64) -> [UInt8] { [0x42] + sleb(value) }
        // Unsigned test also rejects negative i32 inputs.
        code += [0x20, 0, 0x41] + sleb(10_000_000) + [0x4b, 0x04, 0x40, 0x00, 0x0b]
        code += [0x20, 1] + set(0)
        code += [0x02, 0x40, 0x03, 0x40, 0x20, 0, 0x45, 0x0d, 1]
        for op in operations {
            switch op {
            case let .constant(dst, value): code += constant(value) + set(dst)
            case let .copy(dst, src): code += get(src) + set(dst)
            case let .binary(dst, src, opcode): code += get(dst) + get(src) + [opcode] + set(dst)
            case let .immediate(value, opcode): code += get(0) + constant(value) + [opcode] + set(0)
            case let .load(address): code += constant(address) + [0x10, 0] + set(0)
            case let .store(address): code += constant(address) + get(0) + [0x10, 1]
            }
        }
        code += [0x20, 0, 0x41, 1, 0x6b, 0x21, 0, 0x0c, 0, 0x0b, 0x0b]
        code += get(0) + [0x0b]
        section(10, [1] + uleb(UInt64(code.count)) + code)
        return Data(module)
    }

    public static func hex(_ text: String) throws -> [UInt8] {
        let compact = text.filter { !$0.isWhitespace }
        guard compact.count % 2 == 0, compact.count <= 8192 else { throw ProbeError.invalid("Invalid hex length") }
        let chars = Array(compact)
        return try stride(from: 0, to: chars.count, by: 2).map { index in
            guard let byte = UInt8(String(chars[index...index + 1]), radix: 16) else {
                throw ProbeError.invalid("Invalid hex byte at \(index / 2)")
            }
            return byte
        }
    }

    public static let arithmeticHex = "48 b9 03 00 00 00 00 00 00 00 48 0f af c1 48 05 01 00 00 00 c3"

    public static func memoryFixture(address: UInt64) -> [UInt8] {
        let little = (0..<8).map { UInt8(truncatingIfNeeded: address >> ($0 * 8)) }
        return [0x48, 0xa1] + little + [0x48, 0x05, 1, 0, 0, 0, 0x48, 0xa3] + little + [0xc3]
    }
}
