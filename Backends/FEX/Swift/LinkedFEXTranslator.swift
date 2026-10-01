// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJIT
import BetterJITFEX
import CFEXWasm

/// The lock covers native calls AND copying their transient results. No raw
/// pointer escapes a locked operation. close/deinit share that same ownership.
public final class LinkedFEXTranslator: FEXTranslator, @unchecked Sendable {
    public enum ABI: String { case sysv, win64 }
    private let lock = NSLock()
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
    private func withHandle<T>(_ operation: (OpaquePointer) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard let handle else { throw RuntimeFault.closed }
        return try operation(handle)
    }
    private func copy(_ bytes: fexwasm_bytes) throws -> Data {
        guard bytes.size >= 0, bytes.size <= maximumBytes + 4, bytes.size == 0 || bytes.data != nil else {
            throw RuntimeFault("backend", "Invalid native FEX result.")
        }
        return bytes.size == 0 ? Data() : Data(bytes: bytes.data, count: bytes.size)
    }
    public func configuration() throws -> Data {
        try withHandle { handle in
            guard let config = fexwasm_config_json(handle) else { throw RuntimeFault("backend", "Missing FEX configuration.") }
            let length = strnlen(config, 65537)
            guard length <= 65536 else { throw RuntimeFault("backend", "Oversized FEX configuration.") }
            return Data(bytes: config, count: length)
        }
    }
    public func dispatcher() throws -> Data { try withHandle { try copy(fexwasm_dispatcher($0)) } }
    public func initialState() throws -> Data { try withHandle { try copy(fexwasm_state($0)) } }
    public func unit(at rip: UInt32) throws -> Data { try withHandle { try copy(fexwasm_unit($0, rip)) } }
    public func region(profile: Data) throws -> Data {
        try FEXService.validateProfile(profile)
        return try withHandle { handle in
            try profile.withUnsafeBytes { try copy(fexwasm_region(handle, $0.bindMemory(to: UInt8.self).baseAddress, profile.count)) }
        }
    }
    public func close() {
        lock.lock(); defer { lock.unlock() }
        if let handle { fexwasm_destroy(handle); self.handle = nil }
    }
    deinit { close() }
}
