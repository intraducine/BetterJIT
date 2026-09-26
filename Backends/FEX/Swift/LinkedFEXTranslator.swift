// SPDX-License-Identifier: GPL-3.0-or-later
// Add this file to the host target after linking the generated CFEXWasm package.
import Foundation
import BetterJIT
import BetterJITFEX
import CFEXWasm

public final class LinkedFEXTranslator: FEXTranslator {
    public enum ABI: String { case sysv, win64 }
    private var handle: OpaquePointer?
    private let maximumBytes = 16 * 1024 * 1024
    public init(image: Data, guestBase: UInt64, abi: ABI = .sysv) throws {
        guard !image.isEmpty, image.count <= maximumBytes,
              (guestBase & 0xffffffff) + UInt64(image.count) <= 0x1_0000_0000 else {
            throw RuntimeFault("invalidImage", "Image must fit one FEX guest-address window.")
        }
        handle = image.withUnsafeBytes { bytes in
            fexwasm_create(bytes.bindMemory(to: UInt8.self).baseAddress, image.count, guestBase,
                           "abi=\(abi.rawValue) shared=0 hot=100 depth=128")
        }
        guard handle != nil else { throw RuntimeFault("backend", "Native FEX initialization failed.") }
    }
    private func openHandle() throws -> OpaquePointer {
        guard let handle else { throw RuntimeFault.closed }; return handle
    }
    private func copy(_ bytes: fexwasm_bytes) throws -> Data {
        guard bytes.size >= 0, bytes.size <= maximumBytes + 4, bytes.size == 0 || bytes.data != nil else {
            throw RuntimeFault("backend", "Invalid native FEX result.")
        }
        return bytes.size == 0 ? Data() : Data(bytes: bytes.data, count: bytes.size)
    }
    public func configuration() throws -> Data {
        guard let config = fexwasm_config_json(try openHandle()) else { throw RuntimeFault("backend", "Missing FEX configuration.") }
        return Data(String(cString: config).utf8)
    }
    public func dispatcher() throws -> Data { try copy(fexwasm_dispatcher(openHandle())) }
    public func initialState() throws -> Data { try copy(fexwasm_state(openHandle())) }
    public func unit(at rip: UInt32) throws -> Data { try copy(fexwasm_unit(openHandle(), rip)) }
    public func region(profile: Data) throws -> Data {
        let handle = try openHandle()
        return try profile.withUnsafeBytes { try copy(fexwasm_region(handle, $0.bindMemory(to: UInt8.self).baseAddress, profile.count)) }
    }
    public func close() { if let handle { fexwasm_destroy(handle); self.handle = nil } }
    deinit { close() }
}
