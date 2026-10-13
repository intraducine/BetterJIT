// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import BetterJITLinux
import CFEXWasm

final class LinkedLinuxFEXBackend: LinuxTranslationBackend, @unchecked Sendable {
    private let lock=NSLock()
    private var spaces:[UInt32:OpaquePointer]=[:]
    private let options:String
    private let maximumBytes=32*1024*1024
    private var counts:[String:Int]=[:]

    init(cacheDirectory: URL, extraOptions: String = "") throws {
        try FileManager.default.createDirectory(at:cacheDirectory,withIntermediateDirectories:true)
        let suffix=extraOptions.trimmingCharacters(in:.whitespacesAndNewlines)
        options="linux=1 depth=24 cache=\(cacheDirectory.path)" + (suffix.isEmpty ? "" : " " + suffix)
    }

    private func withTranslator<T>(space:UInt32,_ body:(OpaquePointer)throws->T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        let t:OpaquePointer
        if let have=spaces[space] { t=have }
        else {
            guard let made=fexwasm_create(nil,0,0,options) else {
                throw LinuxRuntimeError.guest("Native Linux FEX translator initialization failed.")
            }
            spaces[space]=made; t=made
        }
        return try body(t)
    }
    private func copy(_ value:fexwasm_bytes) throws -> Data {
        guard value.size >= 0, value.size <= maximumBytes,
              value.size == 0 || value.data != nil else {
            throw LinuxRuntimeError.guest("Native Linux FEX translator returned invalid bytes.")
        }
        return value.size == 0 ? Data() : Data(bytes:value.data,count:value.size)
    }
    func configuration(space:UInt32) throws -> Data {
        try withTranslator(space:space) { t in
            guard let p=fexwasm_config_json(t) else { throw LinuxRuntimeError.guest("Linux FEX config unavailable.") }
            let n=strnlen(p,65537)
            guard n <= 65536 else { throw LinuxRuntimeError.guest("Linux FEX config is oversized.") }
            return Data(bytes:p,count:n)
        }
    }
    func dispatcher(space:UInt32) throws -> Data { try withTranslator(space:space) { try copy(fexwasm_dispatcher($0)) } }
    func initialState(space:UInt32) throws -> Data { try withTranslator(space:space) { try copy(fexwasm_state($0)) } }
    func unit(space:UInt32,rip:UInt32) throws -> Data {
        try withTranslator(space:space) { t in
            counts["unitRequests",default:0] += 1
            let data=try copy(fexwasm_unit(t,rip))
            counts["translationBytes",default:0] += data.count
            return data
        }
    }
    func statistics() -> [String:Int] {
        lock.lock(); defer { lock.unlock() }; return counts
    }
    func region(space:UInt32,profile:Data) throws -> Data {
        guard profile.count <= 1024*1024 else { throw LinuxRuntimeError.guest("Linux FEX region profile is oversized.") }
        return try withTranslator(space:space) { t in
            try profile.withUnsafeBytes { raw in try copy(fexwasm_region(t,raw.bindMemory(to:UInt8.self).baseAddress,profile.count)) }
        }
    }
    func mapCode(space:UInt32,address:UInt64,bytes:Data,abi:UInt32) throws {
        guard bytes.count <= 16*1024*1024 else { throw LinuxRuntimeError.guest("Linux code mapping chunk is oversized.") }
        try withTranslator(space:space) { t in
            counts["codeMappings",default:0] += 1
            bytes.withUnsafeBytes { raw in
                if abi == 0 { fexwasm_map_code(t,address,raw.bindMemory(to:UInt8.self).baseAddress,bytes.count) }
                else { fexwasm_map_code_abi(t,address,raw.bindMemory(to:UInt8.self).baseAddress,bytes.count,abi) }
            }
        }
    }
    func patchCode(space:UInt32,address:UInt64,bytes:Data) throws {
        guard bytes.count <= 16*1024*1024 else { throw LinuxRuntimeError.guest("Linux code patch is oversized.") }
        try withTranslator(space:space) { t in
            bytes.withUnsafeBytes { raw in fexwasm_patch_code(t,address,raw.bindMemory(to:UInt8.self).baseAddress,bytes.count) }
        }
    }
    func unmapCode(space:UInt32,address:UInt64,size:UInt64) throws {
        try withTranslator(space:space) { fexwasm_unmap_code($0,address,size) }
    }
    func drop(space:UInt32) {
        lock.lock(); defer { lock.unlock() }
        if let t=spaces.removeValue(forKey:space) { fexwasm_destroy(t) }
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        for t in spaces.values { fexwasm_destroy(t) }
        spaces.removeAll()
    }
    deinit { close() }
}
